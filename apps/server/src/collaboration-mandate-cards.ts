import { createHash } from 'node:crypto';
import { RuntimeError, describeScheduleTrigger, type CollaborationMandate, type CollaborationScope, type ConfigRepository, type ScheduleDelivery } from '@dutydeck/shared';
import type { CollaborationService } from './collaboration-service.js';
import type { LarkCardService } from './lark/service.js';
import { renderLarkResultTextElements } from './lark/card-renderer.js';

// Agent 通过自然语言创建的定时委托不立即生效：先发确认卡，用户点「确认」才创建。
// 每次定时产出的卡片带暂停/恢复/停止按钮。两类卡片的按钮回调都走 dutydeck_mandate 命名空间。

const confirmKind = 'mandate_confirmation';
const adjustHint = '回复"改成每天 9 点"可调整时间';
type CardClient = Pick<LarkCardService, 'send' | 'reply' | 'update'>;
type Element = Record<string, unknown>;
type DeliveredStatus = 'active' | 'paused' | 'cancelled';

export interface MandateCardOptions {
  service: CollaborationService;
  config: ConfigRepository;
  client(scope: CollaborationScope): Promise<CardClient>;
  /** 发起人以外谁能确认、暂停、停止：管理员或有操作权限的人。 */
  canOperate(scope: CollaborationScope, operatorId: string): Promise<boolean>;
  onChange(scope: CollaborationScope): Promise<void>;
  log?: { warn(details: unknown, message: string): void };
}
export interface MandateCardOrigin { threadRootMessageId?: string }
export interface MandateCardContext { messageId?: string; chatId?: string }
type PendingInput = Awaited<ReturnType<CollaborationService['prepareMandate']>>;

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const oneLine = (text: string, limit: number) => { const flat = text.replace(/\s+/g, ' ').trim(); return flat.length > limit ? `${flat.slice(0, limit)}…` : flat; };
const button = (action: string, label: string, ref: string, type: 'primary' | 'default' | 'text'): Element => ({
  tag: 'button', element_id: `mandate_${action}`, text: { tag: 'plain_text', content: label }, type,
  behaviors: [{ type: 'callback', value: { dutydeck_mandate: action, ref } }]
});
const row = (buttons: Element[]): Element => ({
  tag: 'column_set', element_id: 'mandate_actions', flex_mode: 'flow', horizontal_spacing: '8px', margin: '0px',
  columns: buttons.map(item => ({ tag: 'column', width: 'auto', vertical_align: 'center', elements: [item] }))
});
const note = (content: string): Element => ({ tag: 'markdown', element_id: 'mandate_note', content: `<font color='grey'>${content}</font>`, text_size: 'x-small', margin: '0px' });

/** 确认卡正文：做什么、什么时候、发到哪、到什么时候为止。 */
export function mandateSummary(input: Pick<PendingInput, 'goal' | 'trigger' | 'timezone' | 'delivery' | 'condition'>): Element {
  const where = input.delivery.mode === 'thread' ? '本话题' : '本群';
  const until = input.trigger.kind === 'at' ? '执行一次后结束' : input.condition === 'always' ? '直到你取消' : '直到关联事项完成，或你取消';
  return { tag: 'markdown', element_id: 'mandate_summary', content: [
    `**做什么**：${oneLine(input.goal, 200)}`, `**什么时候**：${describeScheduleTrigger(input.trigger, input.timezone)}`, `**发到哪**：${where}`, `**到什么时候为止**：${until}`
  ].join('\n') };
}

/** 每次定时产出的卡片正文：结果、状态行、按钮、调整提示。停止后不再有按钮和提示。 */
export function deliveredElements(text: string, mandateId: string, status: DeliveredStatus): Element[] {
  const result = renderLarkResultTextElements(text) as Element[];
  if (status === 'cancelled') return [...result, { tag: 'markdown', element_id: 'mandate_state', content: '已停止：这个定时任务不会再执行。' }];
  return [...result,
    ...(status === 'paused' ? [{ tag: 'markdown', element_id: 'mandate_state', content: '已暂停：不会再自动发送，点「恢复」继续。' }] : []),
    row([button(status === 'paused' ? 'resume' : 'pause', status === 'paused' ? '恢复' : '暂停', mandateId, 'text'), button('stop', '停止', mandateId, 'text')]),
    note(adjustHint)];
}
const deliveredState = (status: DeliveredStatus) => ({ state: status === 'cancelled' ? 'interrupted' as const : 'completed' as const,
  ...(status === 'active' ? {} : { statusLabel: status === 'paused' ? '已暂停' : '已停止' }) });

export class MandateCards {
  constructor(private readonly options: MandateCardOptions) {}
  private get repo() { return this.options.service.repositories.collaboration; }
  private cardKey = (scope: CollaborationScope, messageId: string) => `collaboration.mandate-card.${scope.appId}.${messageId}`;
  private warn(error: unknown, message: string) { this.options.log?.warn({ error }, message); }

  /** Agent 创建委托：校验通过后记一条待确认记录并发确认卡，返回给 Agent 的结果说明已发卡、不要追问。 */
  async request(scope: CollaborationScope, requesterId: string, body: unknown, origin: MandateCardOrigin = {}) {
    const input = await this.options.service.prepareMandate(scope, requesterId, body);
    const id = `mandate_confirm_${hash([scope, input.id])}`;
    const { action } = await this.repo.beginAction({ id, scope, kind: confirmKind, requesterId, inputDigest: hash(input), payload: { input, origin } });
    if (action.status === 'succeeded') return { pendingConfirmation: false, status: 'confirmed', message: '用户已确认，委托已创建。' };
    if (action.status !== 'intent' && action.status !== 'sending') return { pendingConfirmation: false, status: action.status === 'suppressed' ? 'cancelled' : 'failed', message: action.status === 'suppressed' ? '用户已取消，没有创建委托。' : `委托没有创建成功：${action.error ?? '请稍后重试'}` };
    const pending = { pendingConfirmation: true, confirmationId: id, message: '已发确认卡，等用户确认后生效。用户点击前不要说已创建，也不要再追问。' };
    if (action.receipt) return pending;
    const card = { taskId: id, taskName: '定时任务确认', state: 'running' as const, statusLabel: '待确认', awaitingHuman: true, readOnly: true,
      elements: [mandateSummary(input), row([button('confirm', '确认', id, 'primary'), button('cancel', '取消', id, 'default')])], idempotencyKey: id.slice(-40) };
    try {
      const client = await this.options.client(scope);
      const sent = origin.threadRootMessageId ? await client.reply({ messageId: origin.threadRootMessageId, replyInThread: true, ...card }) : await client.send({ chatId: scope.chatId, ...card });
      await this.repo.updateAction(scope, id, { expectedRevision: action.revision, status: 'intent', receipt: sent.messageId });
    } catch (error) {
      await this.repo.updateAction(scope, id, { expectedRevision: action.revision, status: 'failed', error: '确认卡发送失败' }).catch(() => undefined);
      throw new RuntimeError('COLLABORATION_CONFIRM_CARD_FAILED', '确认卡发送失败，委托没有创建；请稍后重试。', 502);
    }
    return pending;
  }

  /** 定时产出：发一张带按钮的结果卡，并记下正文，之后暂停/停止时原位重绘。 */
  async deliver(input: { client: CardClient; scope: CollaborationScope; delivery: ScheduleDelivery; mandate: Pick<CollaborationMandate, 'id' | 'goal'>; text: string; idempotencyKey: string }): Promise<string> {
    const card = { cardKind: 'result' as const, taskId: input.mandate.id, taskName: input.mandate.goal, state: 'completed' as const, readOnly: true, retryable: false,
      elements: deliveredElements(input.text, input.mandate.id, 'active'), idempotencyKey: input.idempotencyKey };
    const sent = input.delivery.mode === 'thread' && input.delivery.rootMessageRef
      ? await input.client.reply({ messageId: input.delivery.rootMessageRef, replyInThread: true, ...card })
      : await input.client.send({ chatId: input.scope.chatId, ...card });
    await this.options.config.set(this.cardKey(input.scope, sent.messageId), input.text.slice(0, 20_000)).catch(error => this.warn(error, '定时产出正文未能保存，卡片按钮将无法原位重绘'));
    return sent.messageId;
  }

  /** 卡片按钮回调。返回给用户的提示；失败抛 RuntimeError。 */
  async callback(appId: string, value: Record<string, unknown>, operatorId: string | undefined, context: MandateCardContext): Promise<string> {
    const action = String(value.dutydeck_mandate), ref = typeof value.ref === 'string' ? value.ref : '';
    if (!operatorId || !context.chatId || !context.messageId || !ref) throw new RuntimeError('MANDATE_CARD_INVALID', '这张卡片已失效。', 400);
    const scope = { appId, chatId: context.chatId };
    if (action === 'confirm' || action === 'cancel') return this.decide(scope, action, ref, operatorId, context.messageId);
    if (action === 'pause' || action === 'resume' || action === 'stop') return this.control(scope, action, ref, operatorId, context.messageId);
    throw new RuntimeError('MANDATE_CARD_INVALID', '无法识别这个操作。', 400);
  }
  private async allowed(scope: CollaborationScope, operatorId: string, requesterId: string) {
    if (operatorId !== requesterId && !await this.options.canOperate(scope, operatorId)) throw new RuntimeError('MANDATE_CARD_FORBIDDEN', '只有发起人或有操作权限的人能处理这个定时任务。', 403);
  }
  private async decide(scope: CollaborationScope, action: 'confirm' | 'cancel', ref: string, operatorId: string, messageId: string) {
    let record = await this.repo.getAction(scope, ref);
    if (!record || record.kind !== confirmKind || record.receipt && record.receipt !== messageId) throw new RuntimeError('MANDATE_CARD_STALE', '这张确认卡已失效，请重新发起。', 409);
    await this.allowed(scope, operatorId, record.requesterId);
    const input = record.payload.input as PendingInput;
    const summary = mandateSummary(input);
    const render = (state: 'completed' | 'interrupted' | 'failed', statusLabel: string, detail: string) => this.redraw(scope, messageId, { taskId: ref, taskName: '定时任务确认', state, statusLabel, elements: [summary, { tag: 'markdown', content: detail }] });
    if (record.status === 'succeeded') return '已经确认过了。';
    if (record.status === 'suppressed') return '已经取消了。';
    if (record.status !== 'intent') throw new RuntimeError('MANDATE_CARD_BUSY', record.status === 'sending' ? '正在创建，请稍候。' : '这个委托没有创建成功，请重新发起。', 409);
    if (action === 'cancel') {
      await this.repo.updateAction(scope, ref, { expectedRevision: record.revision, status: 'suppressed' });
      await render('interrupted', '已取消', '已取消，没有创建定时任务。');
      return '已取消。';
    }
    try { record = await this.repo.updateAction(scope, ref, { expectedRevision: record.revision, status: 'sending' }); }
    catch { throw new RuntimeError('MANDATE_CARD_BUSY', '正在处理，请勿重复点击。', 409); }
    try {
      await this.options.service.createMandate(scope, record.requesterId, input);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await this.repo.updateAction(scope, ref, { expectedRevision: record.revision, status: 'failed', error: reason.slice(0, 500) }).catch(() => undefined);
      await render('failed', '创建失败', `创建失败：${oneLine(reason, 200)}`);
      throw error;
    }
    await this.repo.updateAction(scope, ref, { expectedRevision: record.revision, status: 'succeeded' }).catch(error => this.warn(error, '定时任务已创建，确认记录未能收尾'));
    await this.options.onChange(scope).catch(error => this.warn(error, '定时任务已创建，调度唤醒失败'));
    await render('completed', '已确认', '已确认，到点会自动执行；每次产出的消息上可以暂停或停止。');
    return '已确认，定时任务已创建。';
  }
  private async control(scope: CollaborationScope, action: 'pause' | 'resume' | 'stop', mandateId: string, operatorId: string, messageId: string) {
    const mandate = await this.repo.getMandate(scope, mandateId);
    if (!mandate) throw new RuntimeError('MANDATE_CARD_STALE', '这个定时任务已不存在。', 404);
    await this.allowed(scope, operatorId, mandate.requesterId);
    const target = ({ pause: 'paused', resume: 'active', stop: 'cancelled' } as const)[action];
    const terminal = mandate.status === 'cancelled' || mandate.status === 'completed';
    let status: DeliveredStatus = mandate.status === 'paused' ? 'paused' : terminal ? 'cancelled' : 'active', message: string;
    if (terminal) message = '这个定时任务已经停止了。';
    else if (mandate.status === target) message = { pause: '已经是暂停状态。', resume: '已经在运行了。', stop: '' }[action];
    else {
      await this.options.service.updateMandate(scope, mandate.requesterId, mandate.id, { expectedRevision: mandate.revision, status: target });
      status = target === 'paused' ? 'paused' : target === 'cancelled' ? 'cancelled' : 'active';
      message = { pause: '已暂停，之后不会自动发送。', resume: '已恢复。', stop: '已停止，这个定时任务不会再执行。' }[action];
    }
    const text = await this.options.config.get(this.cardKey(scope, messageId));
    await this.redraw(scope, messageId, { cardKind: 'result', taskId: mandate.id, taskName: mandate.goal, retryable: false, ...deliveredState(status),
      elements: deliveredElements(text ?? '（这条产出的正文已不可用）', mandate.id, status) });
    return message;
  }
  private async redraw(scope: CollaborationScope, messageId: string, card: Omit<Parameters<CardClient['update']>[0], 'messageId'>) {
    try { await (await this.options.client(scope)).update({ messageId, readOnly: true, ...card }); }
    catch (error) { this.warn(error, '定时任务卡片原位更新失败'); }
  }
}
