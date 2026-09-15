import { createHash } from 'node:crypto';
import { createWorkbenchFetch } from '../workbench-fetch.js';
import { RuntimeError, type AcceptedTask, type RepositoryBundle, type WorkItem, type WorkPlan } from '@dutydeck/shared';
import type { DutydeckRuntime } from '@dutydeck/runtime';
import type { WorkItemService } from '../work-items.js';
import type { WorkItemInteractions, WorkItemRequest } from '../work-item-interactions.js';
import { readLarkConfig, type StoredLarkConfig } from './config.js';
import { createLarkCardService, type LarkCardService } from './service.js';
import { patchLarkCard, sendLarkResult } from './result-delivery.js';
import type { LarkMessageEvent } from './listener.js';
import type { PersistedLarkCardTask } from './coordinator.js';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const originKey = (sessionId: string, key: string) => `workbench.origin.${digest(`${sessionId}\0${key}`)}`;
interface Target { appId: string; chatId: string; replyMessageId: string; replyInThread: boolean }
const labels: Record<string, string> = { pending: '待执行', running: '执行中', waiting: '待你补充', completed: '已完成', failed: '执行失败', blocked: '需要处理', cancelling: '正在停止', cancelled: '已取消', skipped: '已跳过' };

// 只有这些焦点态允许触发新消息；running/pending 等正常流转只允许 PATCH。
// completed 不在此列：目标完成卡走独立的 deliver 通道，notify 对 completed 直接跳过。
const focusStatuses = new Set(['waiting', 'blocked', 'failed']);
const focusOf = (status: string) => focusStatuses.has(status) ? status : '';

/**
 * N2 缺陷守卫：亮屏指纹只包含焦点态（waiting/blocked/failed）与待决请求身份，
 * 不含 running/completed 等正常流转状态与错误全文。running→completed、错误文案变化
 * 都必须得到同一指纹，从而只 PATCH 不推新卡；进入 waiting / 新待决请求才换新指纹。
 */
export function workNoticeFingerprint(item: WorkItem, requests: WorkItemRequest[] = []) {
  return digest(JSON.stringify([
    focusOf(item.status),
    item.steps.map(step => [step.id, focusOf(step.status)]),
    requests.map(request => [request.stepId, request.requestId, request.kind])
  ]));
}

function workHasFocus(item: WorkItem, requests: WorkItemRequest[]) {
  return focusStatuses.has(item.status)
    || item.steps.some(step => focusStatuses.has(step.status))
    || requests.length > 0;
}

export interface WorkItemElementOptions {
  /** agentId → 显示名（来自 runtime.listAgents）；缺失或与 id 相同则只显示 agentId。 */
  agentNames?: Record<string, string>;
}

export function researchWorkPlan(agents: string[]): WorkPlan {
  if (!agents.length) throw new RuntimeError('WORK_ITEM_NO_AGENT', '请先配置一个 Agent', 409);
  return {
    title: '研究与交叉核查', outputStepId: 'report', steps: [
      { id: 'research', title: '调研事实与可行方案', kind: 'agent', agentId: agents[0], instruction: '围绕目标独立研究，列出方案、证据与来源。只阅读和分析，明确未验证的事实；最终回答须包含完整研究结果。', dependsOn: [], workspaceMode: 'shared' },
      { id: 'challenge', title: '独立核查与风险分析', kind: 'agent', agentId: agents[1] ?? agents[0], instruction: '独立核查目标中的假设，研究替代方案、风险与反例。只阅读和分析，提供可核查来源，最终回答须包含完整结果。', dependsOn: [], workspaceMode: 'shared' },
      { id: 'report', title: '比较证据并交付报告', kind: 'agent', agentId: agents[2] ?? agents[0], instruction: '综合两个独立步骤的成果，解释分歧，给出有证据的结论和可执行建议。保留来源和验证限制，输出完整报告。若目标要求写入指定文档，仅在有相应工具与授权时写入并返回链接；写入失败需明确说明。', dependsOn: ['research', 'challenge'], workspaceMode: 'shared' }
    ]
  };
}

export function workItemElements(item: WorkItem, requests: WorkItemRequest[] = [], options: WorkItemElementOptions = {}) {
  const action = (operation: string, label: string, extra = {}) => ({
    tag: 'button', text: { tag: 'plain_text', content: label }, type: operation === 'show' ? 'primary' : 'default',
    behaviors: [{ type: 'callback', value: { dutydeck_work_item: operation, work_id: item.id, parent_session_id: item.parentSessionId, revision: item.revision, ...extra } }]
  });
  // S5：卡面显示 agent 名称而不是裸 agentId；名称与 id 不同时把 id 留作灰色副文案，便于排查。
  const agentLine = (agentId?: string) => {
    if (!agentId) return '';
    const name = options.agentNames?.[agentId]?.trim();
    return name && name !== agentId ? ` · ${name}（${agentId}）` : ` · ${agentId}`;
  };
  // JSON 2.0 表单：输入框 + 提交按钮，路由字段在按钮 value 里，回答文本经 event.action.form_value 落回
  // （listener 侧合入接线见集成清单）；卡片同时保留文字命令兜底，未接线时命令仍可用。
  const answerForm = (name: string, placeholder: string, submitLabel: string, value: Record<string, unknown>) => ({
    tag: 'form', name, direction: 'vertical', vertical_spacing: '8px', margin: '4px 0px', elements: [
      { tag: 'input', name: 'answer', required: true, width: 'fill', placeholder: { tag: 'plain_text', content: placeholder } },
      { tag: 'button', name: `${name}_submit`, type: 'primary', text: { tag: 'plain_text', content: submitLabel },
        form_action_type: 'submit', behaviors: [{ type: 'callback', value }] }
    ]
  });
  const elements: Array<Record<string, any>> = [
    { tag: 'markdown', content: `**${labels[item.status] ?? item.status} · ${item.title}**\n\n${item.goal.slice(0, 2000)}` }
  ];
  for (const step of item.steps) {
    const definition = item.plan.steps.find(value => value.id === step.id)!;
    const attempt = step.attempts.at(-1);
    elements.push({ tag: 'markdown', content: `**${labels[step.status]} · ${definition.title}**${agentLine(definition.agentId)}\n${attempt?.error?.slice(0, 1200) ?? ''}${step.status === 'waiting' ? `\n${definition.instruction}\n\n回复：\`/work answer ${item.id} ${step.id} 你的回答\`` : ''}` });
    if (step.status === 'running') elements.push({ tag: 'markdown', content: `如 CLI 等待终端确认：\`/work terminal ${item.id} ${step.id}\`` });
    if (step.status === 'waiting') elements.push(
      answerForm(`work_answer_${item.id}_${step.id}`, '输入回答内容', `提交回答：${definition.title}`,
        { dutydeck_work_item: 'answer', work_id: item.id, parent_session_id: item.parentSessionId, revision: item.revision, step_id: step.id }),
      action('retry', `重试：${definition.title}`, { step_id: step.id }));
    if (step.status === 'failed' && item.status === 'failed') elements.push(action('retry', `重试：${definition.title}`, { step_id: step.id }));
  }
  for (const request of requests) {
    elements.push({ tag: 'markdown', content: `**${request.kind === 'permission' ? '工具授权' : 'Agent 提问'} · ${request.stepId}**\n${request.text.slice(0, 4000)}` });
    const extra = { step_id: request.stepId, request_id: request.requestId, task_id: request.taskId, request_kind: request.kind };
    if (request.kind === 'permission') elements.push(action('respond', '批准本次调用', { ...extra, answer: 'approve' }), action('respond', '拒绝本次调用', { ...extra, answer: 'reject' }));
    else {
      elements.push({ tag: 'markdown', content: `回复：\`/work respond ${item.id} ${request.stepId} ${request.requestId} 你的回答\`` });
      elements.push(answerForm(`work_respond_${item.id}_${request.stepId}_${request.requestId}`, '输入回答内容', '提交回答',
        { dutydeck_work_item: 'respond', work_id: item.id, parent_session_id: item.parentSessionId, revision: item.revision, ...extra }));
    }
  }
  if (item.error) elements.push({ tag: 'markdown', content: item.error.slice(0, 2000) });
  if (item.output) elements.push({ tag: 'markdown', element_id: 'final_output', content: item.output.text });
  elements.push(action('show', '刷新目标'));
  if (['running', 'waiting', 'failed', 'blocked'].includes(item.status)) elements.push(action('cancel', '停止全部步骤'));
  return elements;
}

export class LarkWorkbench {
  private readonly http = createWorkbenchFetch();
  private closed = false;
  close() { this.closed = true; this.http.close(); }
  private assertOpen() { if (this.closed) throw new RuntimeError('WORKBENCH_CLOSED', '工作台已关闭', 503); }

  constructor(private readonly repos: RepositoryBundle, private readonly runtime: DutydeckRuntime,
    private readonly work: () => WorkItemService, private readonly interactions: () => WorkItemInteractions,
    private readonly authorize: (sessionId: string, actorId?: string) => Promise<boolean>,
    private readonly options: { env?: NodeJS.ProcessEnv; authorizeAgent?: (sessionId: string, actorId: string, agentId: string) => Promise<boolean>; client?: (config: StoredLarkConfig) => LarkCardService; log: { warn: (...args: any[]) => void } }) {}

  private client(config: StoredLarkConfig) { this.assertOpen(); return this.options.client?.(config) ?? createLarkCardService(this.options.env ?? process.env, this.http.fetch, config); }

  async recordOrigin(sessionId: string, key: string, event: LarkMessageEvent, config: StoredLarkConfig) {
    const target: Target = { appId: config.appId, chatId: event.chatId, replyMessageId: event.messageId, replyInThread: event.chatType === 'group' };
    const savedKey = originKey(sessionId, key);
    const encoded = JSON.stringify(target);
    if (!this.repos.config.compareAndSet) throw new RuntimeError('WORK_ITEM_STORAGE_REQUIRED', '目标需要支持原子写入的存储', 503);
    const old = await this.repos.config.get(savedKey);
    if (old && old !== encoded) throw new RuntimeError('WORK_ITEM_ORIGIN_CONFLICT', '此请求已关联另一条消息', 409);
    if (!old && !await this.repos.config.compareAndSet(savedKey, undefined, encoded)) {
      if (await this.repos.config.get(savedKey) !== encoded) throw new RuntimeError('WORK_ITEM_ORIGIN_CONFLICT', '此请求已关联另一条消息', 409);
    }
  }

  async prepareDelivery(sessionId: string, workId: string, key: string) {
    const session = await this.runtime.getSession(sessionId);
    if (session?.source !== 'lark') return;
    const [appId, chatId] = session.sourceId?.split(':') ?? [];
    const storedKey = `workbench.target.${workId}`;
    if (await this.repos.config.get(storedKey)) return;
    let target: Target | undefined = JSON.parse(await this.repos.config.get(originKey(sessionId, key)) ?? 'null') ?? undefined;
    if (!target) {
      const active = this.runtime.getActiveTaskContext(sessionId);
      const taskId = active?.taskId;
      const cards = (await this.repos.channelMappings.list(`lark-card:${appId}`)).filter(value => value.sessionId === sessionId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      for (const card of cards) {
        let saved: PersistedLarkCardTask;
        try { saved = JSON.parse(card.extra ?? 'null'); } catch { continue; }
        if (!saved || saved.app_id !== appId || saved.chat_id !== chatId || !saved.reply_message_id) continue;
        if (saved.scope_id && session.sourceId && !session.sourceId.endsWith(`:${saved.scope_id}`) && session.sourceId !== `${appId}:${chatId}:${saved.scope_id}`) continue;
        if (taskId) {
          if (saved.runtime_task_id) {
            if (saved.runtime_task_id !== taskId) continue;
          } else {
            let accepted: AcceptedTask | undefined;
            try {
              accepted = this.repos.execution.getAcceptedTask(taskId);
            } catch {
              continue;
            }
            const req = accepted?.request;
            if (!req) continue;
            if (req.sessionId !== sessionId) continue;
            if (req.namespace !== 'runtime') continue;
            if (req.key !== `lark:${appId}:${card.externalId}:${saved.turn}`) continue;
            if (req.actor.kind !== 'channel' || req.actor.appId !== appId || (saved.sender_open_id && req.actor.id !== saved.sender_open_id)) continue;
          }
        }
        target = { appId: appId!, chatId: chatId!, replyMessageId: saved.reply_message_id, replyInThread: saved.reply_in_thread === true };
        break;
      }
    }
    if (!target && !this.runtime.getActiveTaskContext(sessionId)) {
      const previous = (await this.repos.channelMappings.list(`lark-work-card:${appId}`)).filter(card => card.sessionId === sessionId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      for (const card of previous) {
        let workId: string | undefined;
        try { workId = JSON.parse(card.extra ?? 'null')?.workId; } catch { continue; }
        if (!workId) continue;
        const saved = await this.repos.config.get(`workbench.target.${workId}`);
        if (saved) { target = JSON.parse(saved) as Target; break; }
      }
    }
    if (!target || target.appId !== appId || target.chatId !== chatId || !this.repos.config.compareAndSet) throw new RuntimeError('WORK_ITEM_ORIGIN_MISSING', '无法确认原话题的交付位置，请从飞书发起目标', 409);
    await this.repos.config.compareAndSet(storedKey, undefined, JSON.stringify(target));
  }

  private async agentNames() {
    const agents = await this.runtime.listAgents();
    return Object.fromEntries(agents.map(agent => [agent.id, agent.name]).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && Boolean(entry[1].trim())));
  }

  private cardState(item: WorkItem) {
    return item.status === 'completed' ? 'completed' as const
      : ['failed', 'blocked'].includes(item.status) ? 'failed' as const
      : item.status === 'cancelled' ? 'interrupted' as const
      : 'running' as const;
  }

  private async cardInput(item: WorkItem, config: StoredLarkConfig, requests: WorkItemRequest[]) {
    return {
      state: this.cardState(item),
      readOnly: true, retryable: false, taskId: item.id, taskName: item.title, sessionId: item.parentSessionId,
      // S7：有配置就透传 Web 出口，未配置时 buildLarkCard 不渲染，不做公网兜底。
      webBaseUrl: config.webBaseUrl, elements: workItemElements(item, requests, { agentNames: await this.agentNames() })
    };
  }

  private workMappingId(appId: string, messageId: string) { return `workcard_${digest(`${appId}\0${messageId}`)}`; }

  private async saveWorkMapping(appId: string, messageId: string, item: WorkItem, chatId: string) {
    // extra 同步存 messageId：回调虽然能用 context.messageId 反查，重启对账与 PATCH 回退需要它自描述。
    await this.repos.channelMappings.save({ id: this.workMappingId(appId, messageId), channel: `lark-work-card:${appId}`, externalId: messageId,
      sessionId: item.parentSessionId, createdAt: new Date().toISOString(), extra: JSON.stringify({ workId: item.id, chatId, revision: item.revision, messageId }) });
  }

  private async send(item: WorkItem, target: Target, config: StoredLarkConfig, key: string, requests: WorkItemRequest[] = []) {
    const result = await sendLarkResult(this.client(config), target, { ...(await this.cardInput(item, config, requests)), idempotencyKey: key }, this.options.log);
    this.assertOpen();
    await this.saveWorkMapping(config.appId, result.messageId, item, target.chatId);
  }

  /** PATCH 指定消息整卡覆盖；不可 PATCH（超长结果/平台失败）时返回 false 交调用方回退发新卡。 */
  private async patchWorkCard(item: WorkItem, chatId: string, config: StoredLarkConfig, messageId: string, requests: WorkItemRequest[]) {
    const patched = await patchLarkCard(this.client(config), { messageId }, await this.cardInput(item, config, requests), this.options.log);
    if (!patched) return false;
    this.assertOpen();
    await this.saveWorkMapping(config.appId, patched.messageId, item, chatId);
    return true;
  }

  /** 找到该目标最近一张工作台卡并原位 PATCH；没有可覆盖的卡时静默跳过。 */
  private async patchLatestCard(item: WorkItem, config: StoredLarkConfig, requests: WorkItemRequest[]) {
    const cards = (await this.repos.channelMappings.list(`lark-work-card:${config.appId}`))
      .filter(card => card.sessionId === item.parentSessionId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    for (const card of cards) {
      let saved: { workId?: string; chatId?: string } | null;
      try { saved = JSON.parse(card.extra ?? 'null'); } catch { continue; }
      if (saved?.workId !== item.id) continue;
      await this.patchWorkCard(item, saved.chatId ?? card.externalId, config, card.externalId, requests);
      return;
    }
  }

  async deliver(item: WorkItem) {
    const encoded = await this.repos.config.get(`workbench.target.${item.id}`);
    if (!encoded) {
      if ((await this.runtime.getSession(item.parentSessionId))?.source === 'lark') throw new RuntimeError('WORK_ITEM_ORIGIN_MISSING', '目标的交付位置不可用', 409);
      return;
    }
    const target = JSON.parse(encoded) as Target;
    const config = await readLarkConfig(this.repos.config, target.appId);
    if (!config) throw new RuntimeError('WORK_ITEM_BOT_MISSING', '原机器人配置已不可用', 409);
    await this.send(item, target, config, `work_${digest(`${item.id}\0${item.output?.digest}`).slice(0, 40)}`);
  }

  async notify(item: WorkItem, actorId: string) {
    this.assertOpen();
    if (!await this.authorize(item.parentSessionId, actorId)) return;
    this.assertOpen();
    const current = await this.work().get(item.parentSessionId, item.id, actorId);
    this.assertOpen();
    if (['cancelling', 'cancelled', 'completed'].includes(current.status)) return;
    const requests = await this.interactions().list(item.parentSessionId, item.id, actorId);
    this.assertOpen();
    if (item.status === 'running' && !item.steps.some(step => step.status === 'waiting') && !requests.length) return;
    const encoded = await this.repos.config.get(`workbench.target.${item.id}`);
    if (!encoded) return;
    const target = JSON.parse(encoded) as Target;
    const config = await readLarkConfig(this.repos.config, target.appId);
    if (!config) return;
    const fingerprint = workNoticeFingerprint(current, requests);
    const key = `workbench.notice.${current.id}.${fingerprint}`;
    if (await this.repos.config.get(key)) {
      // N2：同一焦点剧集内（含 running→completed、错误文案变化）只原位 PATCH，不推新消息。
      await this.patchLatestCard(current, config, requests)
        .catch(error => this.options.log.warn({ error, workId: current.id }, '目标卡片 PATCH 失败'));
      return;
    }
    if (workHasFocus(current, requests)) {
      // 进入 waiting/blocked/failed 或出现新待决请求才允许亮屏。
      await this.send(current, target, config, `work_${digest(key).slice(0, 40)}`, requests);
      this.assertOpen();
      await this.repos.config.set(key, 'sent');
    } else {
      // 离开焦点（如 waiting 已被回答）：只 PATCH 不亮屏，同时登记剧集键避免后续重复判断。
      await this.patchLatestCard(current, config, requests)
        .catch(error => this.options.log.warn({ error, workId: current.id }, '目标卡片 PATCH 失败'));
      await this.repos.config.set(key, 'patched');
    }
  }

  async command(sessionId: string, argsText: string, event: LarkMessageEvent, config: StoredLarkConfig) {
    const actorId = event.senderOpenId;
    if (!actorId || !await this.authorize(sessionId, actorId)) throw new RuntimeError('WORK_ITEM_FORBIDDEN', '当前账号无权操作此目标', 403);
    const [action, id, ...rest] = argsText.trim().split(/\s+/).filter(Boolean);
    const target: Target = { appId: config.appId, chatId: event.chatId, replyMessageId: event.messageId, replyInThread: event.chatType === 'group' };
    let item: WorkItem | undefined;
    let text: string | undefined;
    if (action === 'research') {
      const goal = argsText.replace(/^research\s*/i, '').trim();
      if (!goal) throw new RuntimeError('WORK_ITEM_GOAL_REQUIRED', '用法：/work research 研究目标', 400);
      const agents = await this.runtime.listAgents();
      const allowed = (await Promise.all(agents.map(async agent => !this.options.authorizeAgent || await this.options.authorizeAgent(sessionId, actorId, agent.id) ? agent.id : undefined))).filter((id): id is string => Boolean(id));
      const selected = [...(config.defaultAgentId && allowed.includes(config.defaultAgentId) ? [config.defaultAgentId] : []), ...allowed.filter(id => id !== config.defaultAgentId)];
      await this.recordOrigin(sessionId, event.messageId, event, config);
      item = await this.work().create(sessionId, { goal, plan: researchWorkPlan(selected), idempotencyKey: event.messageId }, actorId);
    } else if (action === 'run' && id && rest.length >= 2) {
      const version = Number(rest[0]);
      if (!Number.isInteger(version) || version < 1) throw new RuntimeError('WORK_ITEM_TEMPLATE_VERSION', '请指定流程版本号', 400);
      await this.recordOrigin(sessionId, event.messageId, event, config);
      item = await this.work().runTemplate(sessionId, id, version, rest.slice(1).join(' '), event.messageId, actorId);
    } else if (action === 'templates') {
      const templates = await this.work().listTemplates(sessionId, actorId);
      text = templates.map(value => `**${value.name} · v${value.version}**\n\`/work run ${value.id} ${value.version} 新目标\``).join('\n\n') || '尚无流程。完成一个目标后，可用 /work save 目标编号 流程名称 保存。';
    } else if (id && ['terminal', 'input', 'key'].includes(action!)) {
      if (action === 'terminal') {
        const view = await this.interactions().terminal(sessionId, id, rest[0] ?? '', actorId);
        text = `**步骤终端 · ${view.stepId}**\n\n${view.screen.replace(/`/g, 'ˋ')}\n\n发送一行文字：\n\`/work input ${id} ${view.stepId} ${view.taskId} 你的回答\`\n\n发送按键：\n\`/work key ${id} ${view.stepId} ${view.taskId} enter\`\n支持 enter / up / down / left / right / tab / escape / ctrl_c。`;
      } else {
        await this.interactions().terminalInput(sessionId, id, { stepId: rest[0], taskId: rest[1], ...(action === 'input' ? { text: rest.slice(2).join(' ') } : { key: rest[2] }) }, actorId);
        text = `已向当前步骤发送${action === 'input' ? '文字' : '按键'}。\n\n\`/work terminal ${id} ${rest[0]}\``;
      }
    } else if (id && ['show', 'cancel', 'retry', 'answer', 'save', 'requests', 'respond'].includes(action!)) {
      item = await this.work().get(sessionId, id, actorId);
      if (action === 'cancel') item = await this.work().cancel(sessionId, id, item.revision, actorId);
      if (action === 'retry') item = await this.work().retryStep(sessionId, id, rest[0] ?? '', item.revision, actorId);
      if (action === 'answer') item = await this.work().answer(sessionId, id, rest[0] ?? '', rest.slice(1).join(' '), item.revision, actorId);
      if (action === 'save') {
        const template = await this.work().saveTemplate(sessionId, id, rest.join(' '), actorId);
        text = `已保存「${template.name}」v${template.version}。\n\n\`/work run ${template.id} ${template.version} 新目标\``;
      }
      if (action === 'respond') {
        const request = (await this.interactions().list(sessionId, id, actorId)).find(request => request.stepId === rest[0] && request.requestId === rest[1]);
        if (!request) throw new RuntimeError('WORK_ITEM_REQUEST_EXPIRED', '原问题已结束或不存在', 409);
        await this.interactions().respond(sessionId, id, { stepId: request.stepId, taskId: request.taskId, requestId: request.requestId, kind: request.kind, answer: rest.slice(2).join(' ') }, actorId);
        item = await this.work().get(sessionId, id, actorId);
      }
    } else if (!action) {
      const items = await this.work().listBySession(sessionId, actorId);
      text = '**Dutydeck 工作台**\n\n直接描述目标，让 Dutydeck 安排步骤、选择 Agent 并交付成果。\n\n' + (items.slice(0, 8).map(value => `**${labels[value.status]} · ${value.title}**\n\`/work show ${value.id}\``).join('\n\n') || '此话题暂无目标。') + '\n\n快速开始：`/work research 研究目标`\n常用流程：`/work templates`\n定时与 CI：`/schedule`、`/ci`';
    } else throw new RuntimeError('WORK_ITEM_COMMAND_INVALID', '用法：/work；/work research 目标；/work show 编号；/work templates；/work run 流程编号 版本 目标；/work save 目标编号 名称；/work answer 目标编号 步骤编号 回答', 400);
    if (text) {
      await sendLarkResult(this.client(config), target, { state: 'completed', readOnly: true, retryable: false, taskId: event.messageId, taskName: 'Dutydeck 工作台',
        elements: [{ tag: 'markdown', element_id: 'final_output', content: text }], idempotencyKey: `work_${digest(event.messageId).slice(0, 40)}` }, this.options.log);
    } else if (item) await this.send(item, target, config, `work_${digest(event.messageId).slice(0, 40)}`, await this.interactions().list(sessionId, item.id, actorId));
  }

  async callback(value: Record<string, any>, actorId: string | undefined, context: { messageId?: string; chatId?: string }, config: StoredLarkConfig) {
    if (!actorId || !context.messageId || !context.chatId) throw new RuntimeError('WORK_ITEM_CALLBACK_INVALID', '卡片身份不完整', 403);
    const mapping = await this.repos.channelMappings.get(`lark-work-card:${config.appId}`, context.messageId);
    const saved = mapping?.extra ? JSON.parse(mapping.extra) : undefined;
    // chat/work/session 不一致是伪造或串话题，硬失败；revision 不一致只是卡片过期，走刷新不拦操作判定。
    if (!mapping || !saved || saved.chatId !== context.chatId || saved.workId !== value.work_id || mapping.sessionId !== value.parent_session_id)
      throw new RuntimeError('WORK_ITEM_CALLBACK_INVALID', '卡片已过期或不属于此话题', 409);
    if (!await this.authorize(mapping.sessionId, actorId)) throw new RuntimeError('WORK_ITEM_FORBIDDEN', '当前账号无权操作此目标', 403);
    const item = await this.work().get(mapping.sessionId, saved.workId, actorId);
    const operation = value.dutydeck_work_item;
    const stale = saved.revision !== value.revision;
    let toast = '目标状态已更新';
    if (stale) {
      // revision CAS 失败：别人已经推进过目标，本次点击不再落操作，直接把最新状态发回话题。
      toast = '目标状态已变化，已刷新最新卡片';
    } else if (operation === 'cancel') {
      await this.work().cancel(mapping.sessionId, item.id, Number(value.revision), actorId);
    } else if (operation === 'retry') {
      await this.work().retryStep(mapping.sessionId, item.id, String(value.step_id), Number(value.revision), actorId);
    } else if (operation === 'answer') {
      // 自由文本来自 JSON 2.0 表单的 form_value（listener 合入接线见集成清单）；未合入时 fail-closed。
      const answer = this.formAnswer(value);
      if (!answer) throw new RuntimeError('WORK_ITEM_ANSWER_REQUIRED', '请填写回答内容，或引用本卡片用 /work answer 文字命令回复', 400);
      await this.work().answer(mapping.sessionId, item.id, String(value.step_id), answer, Number(value.revision), actorId);
    } else if (operation === 'respond') {
      const answer = value.request_kind === 'permission' ? String(value.answer ?? '') : this.formAnswer(value);
      await this.interactions().respond(mapping.sessionId, item.id, { stepId: value.step_id, taskId: value.task_id, requestId: value.request_id, kind: value.request_kind, answer }, actorId);
    } else if (operation !== 'show') {
      throw new RuntimeError('WORK_ITEM_CALLBACK_INVALID', '无法识别目标操作', 400);
    }
    const updated = await this.work().get(mapping.sessionId, item.id, actorId);
    const requests = await this.interactions().list(mapping.sessionId, item.id, actorId);
    const target: Target = { appId: config.appId, chatId: context.chatId, replyMessageId: context.messageId, replyInThread: true };
    const fallbackKey = `work_${digest(`${context.messageId}\0${updated.revision}\0${JSON.stringify(value)}`).slice(0, 40)}`;
    // 先让回调在 3 秒 SLA 内回 toast；PATCH 与回退新发在后台完成，失败只告警不改变 toast 语义。
    void (async () => {
      if (!stale && await this.patchWorkCard(updated, context.chatId!, config, context.messageId!, requests)) return;
      await this.send(updated, target, config, fallbackKey, requests);
    })().catch(error => this.options.log.warn({ error, workId: updated.id }, '目标卡片刷新失败'));
    return toast;
  }

  private formAnswer(value: Record<string, any>) {
    const answer = value.form_value?.answer ?? value.answer;
    return typeof answer === 'string' ? answer.trim() : '';
  }
}
