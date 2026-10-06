// 群级变更的确认卡：机器人先回一张「把本群改成…」的卡，有权限的人点「确认」才真正改。
//
// 确认单存成一条 collaboration action（kind = confirm.<种类>）：状态 intent 是待确认，receipt 是卡片消息 id；
// 点确认时先用 revision 把它抢到 sending，再执行，所以同一张卡只会生效一次。回调里只认确认单编号，
// 改什么、谁发起的、发到哪张卡，都以存档为准。
//
// 复用方式：按种类注册一个 handler（谁能确认、确认后做什么），再用 request 发卡。

import { createHash } from 'node:crypto';
import type { CollaborationAction, CollaborationRepository, CollaborationScope } from '@dutydeck/shared';
import { buildLarkConfirmElements, parseLarkConfirmValue } from './card-actions.js';
import type { StoredLarkConfig } from './config.js';
import type { LarkCardService } from './service.js';

export interface LarkConfirmRequest {
  /** 确认单种类，决定由哪个 handler 处理，例如 participation_level。 */
  kind: string;
  scope: CollaborationScope;
  /** 发起人 open_id。 */
  requesterId: string;
  /** 卡片回复到哪条消息下；同一条消息同一种类只发一张卡。 */
  replyTo: { messageId: string; threadId?: string };
  title: string;
  /** 一句话：改成什么、会有什么变化。 */
  summary: string;
  /** 确认后交给 handler.apply 的内容。 */
  payload: Record<string, string | number | boolean>;
}
export interface LarkConfirmRecord extends LarkConfirmRequest { id: string; expiresAt: string; cardMessageId?: string }
export interface LarkConfirmHandler {
  /** 操作人能否确认；不能时返回给操作人看的原因。 */
  authorize(record: LarkConfirmRecord, operatorOpenId: string): Promise<true | string>;
  /** 执行变更，返回写回卡片的一句结果。 */
  apply(record: LarkConfirmRecord, operatorOpenId: string): Promise<string>;
}
export interface LarkConfirmCardsOptions {
  repository: CollaborationRepository;
  readConfig(appId: string, chatId?: string): Promise<StoredLarkConfig | undefined>;
  serviceFor(config: StoredLarkConfig): Pick<LarkCardService, 'reply' | 'update'>;
  now?: () => Date;
  /** 确认单有效期，默认 24 小时。 */
  ttlMs?: number;
  log?: { warn(details: unknown, message: string): void };
}
type Toast = { type: 'success' | 'info' | 'warning' | 'error'; content: string };
const actionKind = (kind: string) => `confirm.${kind}`;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export class LarkConfirmCards {
  private readonly handlers = new Map<string, LarkConfirmHandler>();
  constructor(private readonly options: LarkConfirmCardsOptions) {}
  private now() { return this.options.now?.() ?? new Date(); }

  register(kind: string, handler: LarkConfirmHandler) {
    this.handlers.set(kind, handler);
  }

  /** 发确认卡；同一条消息重复投递时返回已有的确认单，不再发第二张。发卡失败返回 undefined。 */
  async request(input: LarkConfirmRequest): Promise<LarkConfirmRecord | undefined> {
    if (!this.handlers.has(input.kind)) throw new Error(`Unknown confirmation kind: ${input.kind}`);
    const repo = this.options.repository;
    const id = `confirm_${digest([input.kind, input.scope, input.replyTo.messageId])}`;
    const expiresAt = new Date(this.now().getTime() + (this.options.ttlMs ?? 24 * 3_600_000)).toISOString();
    const begun = await repo.beginAction({ id, scope: input.scope, kind: actionKind(input.kind), requesterId: input.requesterId, inputDigest: digest([input.kind, input.payload]),
      payload: { kind: input.kind, title: input.title, summary: input.summary, payload: input.payload, replyTo: input.replyTo, expiresAt } });
    if (!begun.created) return recordOf(begun.action);
    try {
      const config = await this.options.readConfig(input.scope.appId, input.scope.chatId);
      if (!config?.listening) throw new Error('机器人未在监听');
      const card = await this.options.serviceFor(config).reply({ messageId: input.replyTo.messageId, replyInThread: Boolean(input.replyTo.threadId),
        state: 'completed', readOnly: true, retryable: false, taskName: input.title, statusLabel: '待确认', awaitingHuman: true,
        elements: buildLarkConfirmElements({ confirmId: id, chatId: input.scope.chatId, body: input.summary, pending: true }), idempotencyKey: id.slice(0, 50) });
      const saved = await repo.updateAction(input.scope, id, { expectedRevision: begun.action.revision, status: 'intent', receipt: card.messageId });
      return recordOf(saved);
    } catch (error) {
      this.options.log?.warn({ error, scope: input.scope, kind: input.kind }, '发送确认卡失败');
      await repo.updateAction(input.scope, id, { expectedRevision: begun.action.revision, status: 'failed', error: error instanceof Error ? error.message.slice(0, 1000) : '发送确认卡失败' }).catch(() => undefined);
      return undefined;
    }
  }

  /** 卡片按钮回调。不是确认卡的回调返回 undefined，由调用方继续分发。 */
  async handle(appId: string, value: unknown, operatorOpenId: string | undefined, context: { messageId?: string; chatId?: string } = {}): Promise<Toast | undefined> {
    const parsed = parseLarkConfirmValue(value);
    if (!parsed) return undefined;
    const scope = { appId, chatId: parsed.chatId };
    if (context.chatId && context.chatId !== parsed.chatId) return { type: 'warning', content: '这张确认卡已失效。' };
    const repo = this.options.repository;
    const action = await repo.getAction(scope, parsed.confirmId).catch(() => undefined);
    const record = action && recordOf(action);
    const handler = record && this.handlers.get(record.kind);
    if (!action || !record || !handler || !action.kind.startsWith('confirm.') || context.messageId && record.cardMessageId && context.messageId !== record.cardMessageId) {
      return { type: 'warning', content: '这张确认卡已失效。' };
    }
    if (action.status !== 'intent') return { type: 'info', content: '这张卡已经处理过了。' };
    if (!operatorOpenId) return { type: 'warning', content: '无法确认你的身份，请稍后重试。' };
    if (Date.parse(record.expiresAt) <= this.now().getTime()) {
      await this.finish(action, record, 'suppressed', '已过期', `${record.summary}\n\n这张卡已过期，没有改动。需要的话请重新说一次。`);
      return { type: 'warning', content: '这张确认卡已过期，没有改动。' };
    }
    if (parsed.decision === 'cancel') {
      // 取消不改任何东西，但只让发起人或有确认权限的人点，避免别人把待办的确认单撤掉。
      if (operatorOpenId !== record.requesterId && await handler.authorize(record, operatorOpenId) !== true) return { type: 'warning', content: '只有发起人或有权限的人能取消。' };
      const done = await this.finish(action, record, 'suppressed', '已取消', `${record.summary}\n\n已取消，没有改动。`);
      return done ? { type: 'info', content: '已取消，没有改动。' } : { type: 'info', content: '这张卡已经处理过了。' };
    }
    const allowed = await handler.authorize(record, operatorOpenId).catch(() => '暂时无法确认你的权限，请稍后重试。');
    if (allowed !== true) return { type: 'warning', content: allowed };
    let claimed: CollaborationAction;
    try { claimed = await repo.updateAction(scope, action.id, { expectedRevision: action.revision, status: 'sending' }); }
    catch { return { type: 'info', content: '这张卡已经处理过了。' }; }
    try {
      const result = await handler.apply(record, operatorOpenId);
      await this.finish(claimed, record, 'succeeded', '已确认', result);
      return { type: 'success', content: result };
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 500) : '未知错误';
      await this.finish(claimed, record, 'failed', '没有改成', `${record.summary}\n\n没有改成：${message}`, message);
      return { type: 'error', content: `没有改成：${message}` };
    }
  }

  private async finish(action: CollaborationAction, record: LarkConfirmRecord, status: 'succeeded' | 'failed' | 'suppressed', label: string, body: string, error?: string): Promise<boolean> {
    try { await this.options.repository.updateAction(record.scope, action.id, { expectedRevision: action.revision, status, ...(error ? { error } : {}) }); }
    catch { return false; }
    if (!record.cardMessageId) return true;
    try {
      const config = await this.options.readConfig(record.scope.appId, record.scope.chatId);
      if (config) await this.options.serviceFor(config).update({ messageId: record.cardMessageId, state: status === 'failed' ? 'failed' : 'completed', readOnly: true, retryable: false,
        taskName: record.title, statusLabel: label, elements: buildLarkConfirmElements({ confirmId: record.id, chatId: record.scope.chatId, body, pending: false }) });
    } catch (updateError) {
      // 卡片没刷新不影响结果，结果已经写进确认单；按钮再点会提示已处理。
      this.options.log?.warn({ error: updateError, scope: record.scope, confirmId: record.id }, '刷新确认卡失败');
    }
    return true;
  }
}

function recordOf(action: CollaborationAction): LarkConfirmRecord {
  const payload = action.payload as { kind?: string; title?: string; summary?: string; payload?: Record<string, string | number | boolean>; replyTo?: { messageId: string; threadId?: string }; expiresAt?: string };
  return { id: action.id, kind: payload.kind ?? action.kind.slice('confirm.'.length), scope: action.scope, requesterId: action.requesterId,
    replyTo: payload.replyTo ?? { messageId: '' }, title: payload.title ?? '确认', summary: payload.summary ?? '', payload: payload.payload ?? {},
    expiresAt: payload.expiresAt ?? new Date(0).toISOString(), ...(action.receipt ? { cardMessageId: action.receipt } : {}) };
}
