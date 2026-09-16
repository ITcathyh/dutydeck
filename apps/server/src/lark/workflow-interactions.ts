import { permissionDisplayText } from '@dutydeck/shared';
import { createHash, randomUUID } from 'node:crypto';
import type { AgentEvent, ConfigRepository, PermissionRequestData, PolicyAction } from '@dutydeck/shared';
import type { RelayAskBroker, RelayAskChoice } from '@dutydeck/relay';
import type { LarkMessageEvent, LarkRuntime } from './listener.js';
import { LarkServiceError, buildLarkCard, larkCardSafeLimits } from './service.js';
import type { LarkCardService } from './service.js';
import { safeLarkWebUrl } from './card-actions.js';
import { isGroupChat, renderGroupMention } from './card-mentions.js';
import type { LarkCardElement } from './card-renderer.js';

export interface LarkInteractionContext {
  appId: string;
  sessionId: string;
  taskId: string;
  turn: number;
  event: LarkMessageEvent;
}
export interface LarkInteraction extends LarkInteractionContext {
  id: string;
  boot: string;
  kind: 'ask' | 'permission' | 'result';
  nativeId: string;
  question: string;
  state: 'pending' | 'resolving' | 'answered' | 'approved' | 'rejected' | 'expired' | 'accepted' | 'needs_changes';
  cardId?: string;
  updatedAt: string;
  actorId?: string;
  /** ask 渲染时是否带结构化选项（单选/多选）；缺省为自由文本问答 */
  structured?: boolean;
  /** structured=true 时是否多选；缺省/false 为单选 */
  multiple?: boolean;
}
const prefix = (appId: string) => `lark.interaction.${appId}.`;
const stale = () => new LarkServiceError('LARK_INTERACTION_EXPIRED', '此操作已处理或失效，请查看最新任务状态。', 409);
const button = (record: LarkInteraction, action: string, label: string): LarkCardElement => ({
  tag: 'button', element_id: `workflow_${action}`, text: { tag: 'plain_text', content: label }, type: action === 'approve' ? 'primary' : 'default',
  behaviors: [{ type: 'callback', value: { dutydeck_workflow: action, request_id: record.id, generation: record.boot } }]
});

/** 单选：每个选项一个回调按钮，点按即提交，回调 value 复用 dutydeck_workflow 命名空间。 */
const singleChoiceElements = (record: LarkInteraction, choices: RelayAskChoice[]): LarkCardElement[] =>
  choices.map((choice, index) => ({
    tag: 'button', element_id: `workflow_answer_choice_${index}`, type: 'default',
    text: { tag: 'plain_text', content: choice.label },
    behaviors: [{ type: 'callback', value: {
      dutydeck_workflow: 'answer', request_id: record.id, generation: record.boot,
      answer: choice.value ?? choice.label
    } }]
  }));

/**
 * 多选：JSON 2.0 原生表单（form + multi_select_static + form_action_type:'submit' 按钮）。
 * 提交时按钮 value 仍走 dutydeck_workflow，所选值由平台放在 event.action.form_value.answer（string[]）。
 */
const multipleChoiceForm = (record: LarkInteraction, choices: RelayAskChoice[]): LarkCardElement => ({
  tag: 'form', element_id: 'workflow_answer_form', name: `workflow_ask_${record.id}`,
  direction: 'vertical', vertical_spacing: '8px', margin: '0px',
  elements: [
    { tag: 'multi_select_static', element_id: 'workflow_answer_select', name: 'answer', behaviors: [],
      placeholder: { tag: 'plain_text', content: '选择一个或多个选项' },
      options: choices.map(choice => ({ text: { tag: 'plain_text', content: choice.label }, value: choice.value ?? choice.label })) },
    { tag: 'button', element_id: 'workflow_answer_submit', type: 'primary',
      text: { tag: 'plain_text', content: '提交选择' }, form_action_type: 'submit',
      behaviors: [{ type: 'callback', value: { dutydeck_workflow: 'answer', request_id: record.id, generation: record.boot, multiple: true } }] }
  ]
});

/** 自由文本：JSON 2.0 原生 input（multiline，平台上限 max_length 1000）+ 提交按钮。 */
const freeTextForm = (record: LarkInteraction): LarkCardElement => ({
  tag: 'form', element_id: 'workflow_answer_form', name: `workflow_ask_${record.id}`,
  direction: 'vertical', vertical_spacing: '8px', margin: '0px',
  elements: [
    { tag: 'input', element_id: 'workflow_answer_input', name: 'answer',
      input_type: 'multiline_text', max_length: 1000,
      placeholder: { tag: 'plain_text', content: '输入回答后点提交' } },
    { tag: 'button', element_id: 'workflow_answer_submit', type: 'primary',
      text: { tag: 'plain_text', content: '提交回答' }, form_action_type: 'submit',
      behaviors: [{ type: 'callback', value: { dutydeck_workflow: 'answer', request_id: record.id, generation: record.boot } }] }
  ]
});

/**
 * 组件计数与 service.ts 的 cardComponents 同一口径（带 tag 的对象算 1 个，递归子节点）；
 * 那个函数未导出，这里保留同形实现，改口径时两处一起改。导出供预算测试锁定口径。
 */
export const countCardComponents = (value: unknown): number => {
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + countCardComponents(item), 0);
  if (!value || typeof value !== 'object') return 0;
  const record = value as Record<string, unknown>;
  return (typeof record.tag === 'string' ? 1 : 0)
    + Object.values(record).reduce<number>((sum, item) => sum + countCardComponents(item), 0);
};

/** 给 reply 时才注入的 header/agentName 等固定开销留 1KB 余量，按 24KB/180 做真整卡试算。 */
const structuredCardBudgetHeadroomBytes = 1024;

/** Persisted cards identify a live waiter; history never recreates executable approvals. */
export class LarkWorkflowInteractions {
  readonly boot = randomUUID();
  private closed = false;
  private readonly delivering = new Set<string>();
  private readonly retryAfter = new Map<string, number>();
  constructor(
    private readonly store: ConfigRepository,
    private readonly runtime: LarkRuntime,
    private readonly service: LarkCardService,
    private readonly broker: RelayAskBroker | undefined,
    private readonly authorize: (record: LarkInteraction, actor: string, action: PolicyAction) => Promise<boolean>
  ) {
    if (!store.compareAndSet || !store.list) throw new Error('Lark workflows require persistent CAS and prefix listing');
  }
  private key(record: Pick<LarkInteraction, 'appId' | 'id'>) { return prefix(record.appId) + record.id; }
  async list(appId: string): Promise<LarkInteraction[]> {
    return (await this.store.list!(prefix(appId))).map(row => JSON.parse(row.value));
  }
  async initialize(appId: string) {
    for (const record of await this.list(appId)) {
      if (record.kind !== 'result' && ['pending', 'resolving'].includes(record.state)) {
        // 快照与 move 之间记录可能已被旧协调器的 in-flight 终态处理移走（stop 不拦截
        // detached 续跑）；那种情况下重启收敛的目标已经达成，重读确认后不再重复处理，
        // 绝不能把别人的 resolved 决议倒回 expired。
        let target: LarkInteraction;
        try { target = await this.move(record, 'expired'); }
        catch (error) {
          if (!(error instanceof LarkServiceError) || error.code !== 'LARK_INTERACTION_EXPIRED') throw error;
          const current = await this.store.get(this.key(record));
          if (!current) continue;
          const stored = JSON.parse(current) as LarkInteraction;
          if (!['pending', 'resolving'].includes(stored.state)) continue;
          target = stored;
        }
        await this.renderClosed(target, '原任务已失去确认上下文，此卡已失效。');
      }
    }
  }
  private async renderClosed(record: LarkInteraction, message: string) {
    if (!record.cardId || record.kind === 'result') return;
    await this.service.update({ messageId: record.cardId, taskId: record.id, taskName: record.kind === 'ask' ? 'Agent 提问' : '本次操作确认',
      permissionMode: 'ask', state: record.state === 'expired' ? 'interrupted' : 'completed', statusLabel: record.state === 'expired' ? '已失效' : '已处理',
      readOnly: true, elements: [{ tag: 'div', text: { tag: 'plain_text', content: record.question.slice(0, 6000) } }, { tag: 'markdown', content: message }] }).catch(() => undefined);
  }
  private async renderPendingPermission(record: LarkInteraction) {
    if (!record.cardId) return;
    await this.service.update({ messageId: record.cardId, taskId: record.id, taskName: '确认本次操作', permissionMode: 'ask', state: 'running', statusLabel: '等待审批', awaitingHuman: true, readOnly: true,
      elements: [{ tag: 'div', text: { tag: 'plain_text', content: record.question.slice(0, 6000) } }, { tag: 'markdown', content: '上次提交未送达执行端，请重新批准或拒绝。' }, button(record, 'approve', '允许本次'), button(record, 'reject', '拒绝')] }).catch(() => undefined);
  }
  async expireTask(appId: string, taskId: string) {
    for (const record of await this.list(appId)) {
      if (record.taskId !== taskId || record.kind === 'result' || record.state !== 'pending') continue;
      try { await this.renderClosed(await this.move(record, 'expired'), '本轮任务已结束，此请求不再接受回答或批准。'); }
      catch { /* A concurrently accepted decision owns this request. */ }
    }
  }
  close() { this.closed = true; }
  private async move(record: LarkInteraction, state: LarkInteraction['state'], actorId?: string) {
    const next = { ...record, state, updatedAt: new Date().toISOString(), ...(actorId ? { actorId } : {}) };
    if (!await this.store.compareAndSet!(this.key(record), JSON.stringify(record), JSON.stringify(next))) throw stale();
    return next;
  }
  private interactionId(context: LarkInteractionContext, kind: LarkInteraction['kind'], nativeId: string) {
    return createHash('sha256').update([context.appId, context.sessionId, context.taskId, context.turn, kind, nativeId, kind === 'result' ? '' : this.boot].join('\0')).digest('hex').slice(0, 24);
  }
  private async create(
    context: LarkInteractionContext,
    kind: LarkInteraction['kind'],
    nativeId: string,
    question: string,
    structured?: Pick<LarkInteraction, 'structured' | 'multiple'>
  ) {
    const id = this.interactionId(context, kind, nativeId);
    const record: LarkInteraction = {
      ...context, id, kind, nativeId, question, boot: this.boot, state: 'pending',
      updatedAt: new Date().toISOString(), ...(structured ?? {})
    };
    if (!await this.store.compareAndSet!(this.key(record), undefined, JSON.stringify(record))) {
      const old = await this.store.get(this.key(record));
      if (!old) throw stale();
      return { record: JSON.parse(old) as LarkInteraction, created: false };
    }
    return { record, created: true };
  }
  private async bindCard(record: LarkInteraction, cardId: string) {
    const next = { ...record, cardId };
    if (!await this.store.compareAndSet!(this.key(record), JSON.stringify(record), JSON.stringify(next))) throw stale();
    return next;
  }
  /**
   * options.structuredAskCards：结构化问答卡总开关（来自 config，默认缺省即关闭）。
   * 关闭时使用文本卡并展示可读选项；开启后：带选项的 ask 渲染单选按钮组/多选表单，
   * 无选项的 ask 渲染自由文本 input 表单。低版本客户端仍可引用本卡片直接回复。
   * options.webBaseUrl：仅在传入且为合法 http(s) 地址时透传给结构化 ask 卡，未配置不渲染、无公网兜底。
   * options.groupMention：群 @ 发起人开关（P0-4，默认关闭）。开启且为群聊时在审批/问答卡
   * 最前方插入 @ 发起人元素；关闭时不添加 @ 元素。
   */
  async observe(
    context: LarkInteractionContext,
    event: AgentEvent,
    options: { structuredAskCards?: boolean; webBaseUrl?: string; groupMention?: boolean } = {}
  ) {
    if (this.closed) return;
    const data = event.data as Record<string, any>;
    let kind: 'ask' | 'permission';
    let nativeId: string;
    let question: string;
    let askChoices: RelayAskChoice[] | undefined;
    let askMultiple = false;
    if (event.type === 'text' && data.relay === 'ask' && this.broker) {
      const ask = this.broker.get(String(data.askId));
      if (!ask || ask.status !== 'pending' || ask.sessionId !== context.sessionId) return;
      kind = 'ask'; nativeId = ask.id; question = ask.question;
      askChoices = Array.isArray(ask.choices) ? ask.choices : undefined;
      askMultiple = ask.multiple === true;
    } else if (event.type === 'permission_request' && data.status === 'pending' && this.runtime.resolvePermission && this.runtime.getPendingPermissions) {
      const request = data as PermissionRequestData;
      if (!(await this.runtime.getPendingPermissions(context.sessionId)).some(item => item.id === request.id)) return;
      kind = 'permission'; nativeId = request.id;
      const operation = request.operation;
      question = [permissionDisplayText(request.title) || 'Agent 请求执行受控操作',
        ...(operation?.source === 'acp_tool_call' ? [
          '来源：执行端工具请求',
          ...(operation.cwd ? [`目录：${permissionDisplayText(operation.cwd)}`] : []),
          ...(operation.resource ? [`资源：${permissionDisplayText(operation.resource)}`] : []),
          ...(operation.command ? [`命令（已脱敏）：${permissionDisplayText(operation.command)}`] : [])
        ] : ['执行端未提供详细操作。'])
      ].join('\n');
    } else return;
    const structuredOn = options.structuredAskCards === true && kind === 'ask';
    const structuredChoices = structuredOn && askChoices && askChoices.length > 0 ? askChoices : undefined;
    const created = await this.create(
      context, kind, nativeId, question,
      structuredChoices ? { structured: true, ...(askMultiple ? { multiple: true } : {}) } : undefined
    );
    const record = created.record;
    if (record.state !== 'pending' || record.cardId || this.delivering.has(record.id) || (this.retryAfter.get(record.id) ?? 0) > Date.now()) return;
    this.delivering.add(record.id);
    // P0-4：仅在显式开启且为群聊时于卡首 @ 发起人；默认关闭时该展开为空，卡面零变化。
    const groupMentionTag = options.groupMention === true && isGroupChat(context.event.chatType) && context.event.senderOpenId
      ? renderGroupMention(context.event.senderOpenId)
      : undefined;
    // 提示语元素单独持有引用：结构化选项超预算回落为纯文本卡时，要替换的始终是这一条提示，
    // 不能写死下标——群 @ 开启时它前面还会插入 group_mention，下标会错位覆盖问题正文。
    const hintElement: LarkCardElement = { tag: 'markdown', content: kind === 'ask'
      ? (structuredOn
        ? structuredChoices ? '点选下方选项提交；也可引用本卡片直接回复你的答案。' : '在下方填写答案并点击提交；也可引用本卡片直接回复你的答案。'
        : '请引用本卡片回复你的答案。')
      : '本次选择只处理这一条请求，不改变后续授权方式。' };
    const elements: LarkCardElement[] = [
      ...(groupMentionTag ? [{ tag: 'markdown', element_id: 'group_mention', content: groupMentionTag }] : []),
      { tag: 'div', text: { tag: 'plain_text', content: question.slice(0, 6000) } },
      // 正文只写读者做决定时需要知道的东西：授权范围（permission）、怎么答（ask）。
      // 原先还各带一份完整 slash 指令，`/approve wf_01H…` 里那串请求编号在 permission 卡上
      // 出现两次，正下方就是「批准一次 / 拒绝」两个按钮——对能点按钮的人是三行纯噪声。
      //
      // 编号因此不再出现在任何卡片正文里，按钮失灵时的备用路径改成「引用这张卡 + /approve」：
      // routeWorkflow 组装 requestId 时，没有显式编号就回落到被引用卡片的 id。删掉编号
      // 而不做那个回落，等于把这条备用路径一起删掉——命令会以「请填写请求编号」失败，
      // 而那个编号已经没有任何卡会显示。
      // 命令本身的可发现性由 `/help` 承担（commands.ts:173-175 已列出三条命令及其用法）。
      hintElement,
      ...(kind === 'permission' ? [button(record, 'approve', '允许本次'), button(record, 'reject', '拒绝')] : [])
    ];
    // 结构化问答仅在开关开启且记录本身带选项时渲染；持久记录缺 structured（升级前的卡）
    // 一律走自由文本形态，绝不让新渲染逻辑作用于旧记录。
    let structuredParts: LarkCardElement[] | undefined;
    if (structuredOn && kind === 'ask') {
      if (record.structured && structuredChoices) {
        structuredParts = record.multiple
          ? [multipleChoiceForm(record, structuredChoices)]
          : singleChoiceElements(record, structuredChoices);
      } else if (!record.structured) {
        structuredParts = [freeTextForm(record)];
      }
    }
    const safeWebBaseUrl = structuredOn && kind === 'ask' ? safeLarkWebUrl(options.webBaseUrl) : undefined;
    // 选项来自 agent，渲染前按 24KB/180 预测整卡：超预算的单选/多选回落成普通文本卡，
    // 引用卡片回复仍可用；自由文本表单体积恒定，必然在预算内。
    if (structuredParts && this.withinAskCardBudget([...elements, ...structuredParts], safeWebBaseUrl)) {
      elements.push(...structuredParts);
    } else if (kind === 'ask') {
      hintElement.content = '请引用本卡片回复你的答案。';
      if (askChoices?.length) {
        // Text mode still has to show what the user is choosing. Keep labels
        // as plain text and reserve space for an explicit truncation notice.
        const labels = askChoices.map((choice, index) => `${index + 1}. ${choice.label}`);
        let visible = labels.length;
        let choicesElement: LarkCardElement;
        do {
          const omitted = visible < labels.length ? `\n还有 ${labels.length - visible} 个选项未展示，请引用本卡片说明你的选择。` : '';
          choicesElement = { tag: 'div', text: { tag: 'plain_text', content: `可选项：\n${labels.slice(0, visible).join('\n')}${omitted}` } };
          if (this.withinAskCardBudget([...elements, choicesElement], safeWebBaseUrl)) break;
          visible--;
        } while (visible >= 0);
        if (visible >= 0) elements.push(choicesElement);
        else hintElement.content = '选项过多，当前卡片无法完整展示。请引用本卡片说明你的选择。';
      }
    }
    try {
      if (!await this.live(record)) { await this.move(record, 'expired'); return; }
      const card = await this.service.reply({ messageId: context.event.messageId, ...(context.event.threadId ? { replyInThread: true } : {}),
        state: 'running', statusLabel: kind === 'ask' ? '等待回答' : '等待审批', awaitingHuman: true, readOnly: true,
        taskId: record.id, taskName: kind === 'ask' ? 'Agent 需要你的回答' : '确认本次操作', permissionMode: 'ask', elements,
        ...(safeWebBaseUrl ? { webBaseUrl: safeWebBaseUrl } : {}),
        idempotencyKey: `workflow_${record.id}` });
      await this.bindCard(record, card.messageId);
      this.retryAfter.delete(record.id);
    } catch (error) {
      // The waiter remains valid when delivery fails. A later task heartbeat
      // retries the same provider UUID; one in-flight delivery owns this boot.
      this.retryAfter.set(record.id, Date.now() + 5_000);
      throw error;
    } finally { this.delivering.delete(record.id); }
  }

  /**
   * 预测「信封 + 结构化元素」拼装后的整卡体积，选项过多时由调用方回落成普通文本问答卡。
   * 不能直接 buildLarkCard(elements) 试算：buildLarkCard 超预算时会静默把整卡换成只剩
   * 提示文案的兜底卡，拿兜底卡反算永远「达标」。这里用同入参的空信封卡测得固定开销，
   * arrange 会把未登记 element_id 的结构化元素原样追加进 body，故字节/组件均按增量相加。
   */
  private withinAskCardBudget(elements: LarkCardElement[], webBaseUrl?: string) {
    const envelope = buildLarkCard({
      state: 'running', statusLabel: '等待回答', awaitingHuman: true, readOnly: true,
      taskName: 'Agent 需要你的回答', permissionMode: 'ask',
      ...(webBaseUrl ? { webBaseUrl } : {})
    });
    const projectedBytes = Buffer.byteLength(JSON.stringify(envelope), 'utf8')
      + Buffer.byteLength(JSON.stringify(elements), 'utf8');
    const projectedComponents = countCardComponents(envelope) + countCardComponents(elements);
    return projectedBytes <= larkCardSafeLimits.bytes - structuredCardBudgetHeadroomBytes
      && projectedComponents <= larkCardSafeLimits.components;
  }
  async result(context: LarkInteractionContext, cardId: string) {
    const raw = await this.store.get(prefix(context.appId) + this.interactionId(context, 'result', context.taskId));
    if (!raw) return [];
    let record = JSON.parse(raw) as LarkInteraction;
    if (record.cardId !== cardId) record = await this.bindCard(record, cardId);
    return record.state === 'pending' ? [
      { tag: 'markdown', element_id: 'workflow_result_status', content: '执行已结束。请验收结果；需要修改时，回复此卡片并说明要求。' },
      button(record, 'accept', '验收通过'), button(record, 'changes', '需要修改')
    ] : [{ tag: 'markdown', element_id: 'workflow_result_status', content: record.state === 'accepted' ? '验收：已通过' : '验收：需要修改，回复此卡片说明要求。' }];
  }
  private async live(record: LarkInteraction) {
    if (this.closed || record.boot !== this.boot) return false;
    if (!(await this.runtime.getTasks?.(record.sessionId))?.some(task => task.id === record.taskId && task.status === 'running')) return false;
    return record.kind === 'ask'
      ? this.broker?.get(record.nativeId)?.status === 'pending'
      : (await this.runtime.getPendingPermissions?.(record.sessionId))?.some(item => item.id === record.nativeId) === true;
  }
  async pendingAsks(appId: string) {
    const pending: LarkInteraction[] = [];
    for (const record of await this.list(appId)) {
      if (record.kind === 'ask' && record.state === 'pending' && record.cardId && await this.live(record)) pending.push(record);
    }
    return pending;
  }
  async respond(input: { appId: string; chatId: string; actorId?: string; requestId: string; action: 'answer' | 'approve' | 'reject' | 'accept' | 'changes'; answer?: string; selected?: string[]; cardId?: string; generation?: string; callback?: boolean }) {
    const raw = await this.store.get(prefix(input.appId) + input.requestId);
    if (!raw || !input.actorId) throw stale();
    let record = JSON.parse(raw) as LarkInteraction;
    if (record.event.chatId !== input.chatId || record.appId !== input.appId || !record.cardId) throw stale();
    if (input.callback && (input.cardId !== record.cardId || input.generation !== record.boot)) throw stale();
    const expectedKind = input.action === 'answer' ? 'ask' : ['approve', 'reject'].includes(input.action) ? 'permission' : 'result';
    if (record.kind !== expectedKind || record.state !== 'pending') throw stale();
    const policy: PolicyAction = input.action === 'approve' ? 'high_risk.execute' : 'run.interrupt';
    if (!await this.authorize(record, input.actorId, policy)) throw new LarkServiceError('LARK_INTERACTION_DENIED', '当前账号无权操作此任务。', 403);
    if (record.kind === 'result') {
      record = await this.move(record, input.action === 'accept' ? 'accepted' : 'needs_changes', input.actorId);
      return input.action === 'accept' ? '已记录验收通过。' : '已记录需要修改。请回复结果卡片，说明具体修改要求。';
    }
    if (!await this.live(record)) { await this.move(record, 'expired'); throw stale(); }
    // 结构化卡只接受选项集合内的提交值：单选值来自按钮 value，多选值来自表单 form_value。
    // 校验在 resolving CAS 之前，失败时卡片保持 pending，读者仍可引用卡片回复。
    let answerText = '';
    if (input.action === 'answer') {
      // 严格选项校验只约束卡片回调：按钮/表单的提交值必须是渲染过的选项，防止伪造 value。
      // 引用卡片回复走的是人类自由文本（低版本兜底入口），即使是结构化卡也照常接受。
      if (record.structured && input.callback) {
        const values = (this.broker?.get(record.nativeId)?.choices ?? []).map(choice => choice.value ?? choice.label);
        const invalidChoice = () => new LarkServiceError('LARK_ANSWER_CHOICE_INVALID', '提交的选项已失效，请点选卡片上的最新选项，或引用本卡片直接回复答案。', 400);
        if (record.multiple) {
          const picked = Array.isArray(input.selected)
            ? [...new Set(input.selected.filter((value): value is string => typeof value === 'string'))]
            : [];
          if (!picked.length || picked.some(value => !values.includes(value))) throw invalidChoice();
          answerText = picked.join('、');
        } else {
          answerText = input.answer?.trim() ?? '';
          if (!answerText || !values.includes(answerText)) throw invalidChoice();
        }
      } else {
        answerText = input.answer?.trim() ?? '';
      }
      if (!answerText) throw new LarkServiceError('LARK_ANSWER_EMPTY', '回答不能为空。', 400);
    }
    record = await this.move(record, 'resolving', input.actorId);
    try {
      // The authoritative broker/runtime repeats the single-consumer and liveness check.
      if (input.action === 'answer') await this.broker!.answer(record.nativeId, answerText, { sessionId: record.sessionId });
      else {
        const resolved = await this.runtime.resolvePermission!(record.sessionId, record.nativeId, input.action === 'approve');
        if (resolved === false) throw stale();
      }
    } catch (error) {
      if ((error as { code?: string }).code === 'PERMISSION_ACCEPTED_AUDIT_FAILED') {
        await this.move(record, input.action === 'approve' ? 'approved' : 'rejected').catch(() => undefined);
        return '执行端已接受决策，审计回执暂未完成；请勿重复提交。';
      }
      // Runtime may reject before its driver consumes the decision (for example
      // while persisting intent). A live permission remains safely retryable;
      // do not burn its fixed interaction id. Relay asks have no equivalent
      // recoverable state and retain the expired behavior below.
      const code = (error as { code?: string }).code;
      if (record.kind === 'permission' && !['PERMISSION_NOT_FOUND', 'PERMISSION_EXPIRED', 'LARK_INTERACTION_EXPIRED'].includes(code ?? '') && await this.live(record)) {
        const pending = await this.move(record, 'pending');
        await this.renderPendingPermission(pending);
        throw error;
      }
      await this.move(record, 'expired');
      throw error;
    }
    const state = input.action === 'answer' ? 'answered' : input.action === 'approve' ? 'approved' : 'rejected';
    try { record = await this.move(record, state); }
    catch { return '执行端已接受决策，回执记录暂未更新；请勿重复提交。'; }
    await this.renderClosed(record, input.action === 'answer' ? '回答已送达原任务。' : '执行端已接受本次决策。');
    return input.action === 'answer' ? '回答已送达原任务。' : input.action === 'approve' ? '执行端已接受本次批准。' : '执行端已接受拒绝。';
  }
  async quoted(appId: string, event: LarkMessageEvent) {
    if (!event.parentId) return undefined;
    return (await this.list(appId)).find(record => record.cardId === event.parentId && record.event.chatId === event.chatId);
  }
}
