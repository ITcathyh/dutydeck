import { randomUUID } from 'node:crypto';
import { RuntimeError, serialByKey, type ConfigRepository, type ChannelMappingRepository } from '@dutydeck/shared';
import { executionTaskId } from '@dutydeck/shared/execution';
import { hasRiskDenial, secretGuardFinding } from '@dutydeck/shared/secret-guard';
import { testRegexWithTimeout } from '@dutydeck/acp-client/regex-timeout';
import { allowedHighRiskActor, defaultHighRiskPattern } from '../policy/high-risk.js';
import type { LarkRiskRequest } from './agent-command.js';
import type { StoredLarkConfig } from './config.js';
import type { CoordinatorState } from './coordinator-state.js';
import type { ButtonSource } from './handlers/button-context.js';
import type { LarkRuntime } from './runtime.js';
import type { LarkMessageEvent } from './listener.js';
import { larkCardDateTime } from './card-status.js';
import { redactTraceText } from './secret-redaction.js';
import { clipCardField, escapeCardInline, textFence } from './card-elements.js';
import { larkMessageAnchor } from './message-anchor.js';
import { findLarkThreadContinuation, findPersistedLarkSession } from './session-resolver.js';

const maxRejectionNoticeAttempts = 5;

type Status = 'pending' | 'approved' | 'rejected' | 'expired' | 'ended' | 'started' | 'undeliverable';
interface Recipient { openId: string; name: string; uuid: string; cardId?: string; attempted?: boolean; rendered?: string }
export interface RiskApproval extends Omit<LarkRiskRequest, 'turnToken'> {
  appId: string; scopeId: string; event: LarkMessageEvent; requester: string; chat: string; link: string;
  status: Status; createdAt: number; expiresAt: number; recipients: Recipient[]; continuationTaskId: string;
  runId?: string; startedAttempt?: string;
  rejectionNoticeFailures?: number; rejectionNoticeAbandoned?: boolean;
  decision?: { actor: string; name: string; at: number; approved: boolean }; waiting?: boolean; notified?: boolean;
}
export const riskApprovalKey = (appId: string, taskId: string) => `lark.risk-approval.${appId}.${taskId}`;
export const riskMessageId = (id: string) => 'risk_approval_' + id;
export function readRiskApproval(store: ConfigRepository, appId: string, taskId: string) {
  return store.get(riskApprovalKey(appId, taskId)).then(raw => raw ? JSON.parse(raw) as RiskApproval : undefined);
}
export const riskContinuationText = (r: RiskApproval) => `管理员 ${r.decision!.name} 已批准本次请求中的高危操作（${r.summary}）。继续完成原请求；本轮的高危命令已放行。`;
export async function riskOriginalSession(r: RiskApproval, config: StoredLarkConfig, runtime: Pick<LarkRuntime, 'listSessions' | 'listAgents'>, mappings: ChannelMappingRepository) {
  const current = await findPersistedLarkSession(runtime, config, r.event.chatId, r.event.chatType, r.scopeId, mappings)
    ?? await findLarkThreadContinuation(runtime, config, r.event, r.scopeId, mappings);
  return current?.id === r.sessionId && current.runId === r.runId && !current.archivedAt && !['stopped', 'failed'].includes(current.state);
}
const unavailable = () => new RuntimeError('RISK_APPROVER_UNREACHABLE', '没有可送达的管理员', 409);
function label(r: RiskApproval) {
  switch (r.status) {
    case 'approved': case 'started': return `已批准 · ${r.decision!.name} · ${larkCardDateTime(r.decision!.at)}`;
    case 'rejected': return `已拒绝 · ${r.decision!.name}`;
    case 'expired': return '已过期，请重新发起';
    case 'ended': return '原会话已结束，请重新发起';
    default: return '高危操作待批准';
  }
}
function card(r: RiskApproval) {
  const plain = (content: string) => ({ tag: 'div', text: { tag: 'plain_text', content } });
  const elements: Record<string, unknown>[] = [];
  if (r.status === 'pending') {
    elements.push(plain('发起人：' + r.requester), plain('群：' + r.chat),
      { tag: 'markdown', content: `[原消息](${r.link})` }, plain('要做：' + r.summary),
      { tag: 'markdown', content: '命令：\n\n' + textFence(clipCardField(r.command, 600)) },
      plain('有效至：' + larkCardDateTime(r.expiresAt)));
    for (const [value, text] of [['approve', '批准本次'], ['reject', '拒绝']]) elements.push({ tag: 'button',
      type: value === 'approve' ? 'primary' : 'default', text: { tag: 'plain_text', content: text },
      behaviors: [{ type: 'callback', value: { risk_request: r.taskId, decision: value } }] });
  } else if (r.status === 'approved' && r.waiting) elements.push(plain('等会话里的后台任务结束后继续'));
  return { schema: '2.0', config: { update_multi: true }, header: { title: { tag: 'plain_text', content: label(r) } }, body: { elements } };
}

export class LarkRiskApprovals {
  private readonly locks = new Map<string, Promise<unknown>>();
  constructor(private readonly host: CoordinatorState, private readonly resume: (r: RiskApproval, config: StoredLarkConfig) => Promise<void>) {}
  private get store() { return this.host.workflowOptions.store; }
  private async save(record: RiskApproval, old: string | undefined) {
    const next = JSON.stringify(record);
    if (!await this.store.compareAndSet!(riskApprovalKey(record.appId, record.taskId), old, next)) throw new RuntimeError('RISK_APPROVAL_CHANGED', '审批记录已更新，请刷新。', 409);
    return next;
  }
  private async authorized(config: StoredLarkConfig, event: LarkMessageEvent, sessionId: string, id: string) {
    if (!config.highRiskAllowedUsers.length && !config.highRiskAllowedEmails.length) return false;
    if (!await allowedHighRiskActor(config, id, actor => this.host.service.getUserEmails(actor), this.host.log, 'throw')) return false;
    if (event.chatType !== 'group') return true;
    const group = await this.host.groupManager?.authorize(config.appId, event.chatId, id, 'high_risk.execute', sessionId, { taskRequesterOpenId: event.senderOpenId });
    return group?.allowed ?? !config.managedGroup;
  }
  async request({ turnToken, ...input }: LarkRiskRequest, config: StoredLarkConfig, event: LarkMessageEvent, scopeId: string) {
    const { sessionId, taskId, actorId, command } = input;
    const session = await this.host.runtime.getSession(sessionId);
    if (session?.source !== 'lark' || event.senderOpenId !== actorId || event.senderType !== 'user' || config.riskControlMode !== 'enforced')
      throw new RuntimeError('RISK_APPROVAL_UNAVAILABLE', '只有启用强制风控的飞书用户请求可以申请。', 403);
    if (!config.highRiskAllowedUsers.length && !config.highRiskAllowedEmails.length) throw unavailable();
    if (await this.authorized(config, event, sessionId, actorId)) throw new RuntimeError('RISK_ALREADY_ALLOWED', '发起人已有高危操作权限。', 409);
    if (redactTraceText(command) !== command || redactTraceText(input.summary) !== input.summary) throw new RuntimeError('RISK_REQUEST_INELIGIBLE', '申请内容含有凭据信息。', 403);
    if (!hasRiskDenial(session.cwd, sessionId, turnToken, command) || secretGuardFinding({ tool_name: 'Bash', tool_input: { command }, cwd: session.cwd })
      || !await testRegexWithTimeout(config.highRiskPattern || defaultHighRiskPattern, command)) throw new RuntimeError('RISK_REQUEST_INELIGIBLE', '只可申请被高危正则拦截的命令。', 403);
    return serialByKey(this.locks, taskId, async () => {
      let r = await readRiskApproval(this.store, config.appId, taskId);
      if (!r) {
        const names = new Map(config.highRiskAllowedUsers.map(user => [user.openId, user.name || user.openId]));
        for (const email of config.highRiskAllowedEmails) {
          const id = await this.host.service.batchGetIdByEmail(email).catch(() => undefined);
          if (id && !names.has(id)) names.set(id, (await this.host.service.getContactUser(id, 'open_id').catch(() => undefined))?.name || email);
        }
        if (!names.size) throw unavailable();
        const messageId = riskMessageId(taskId);
        const createdAt = Date.now();
        r = { ...input, appId: config.appId, runId: session.runId, event, scopeId, createdAt, expiresAt: createdAt + 86400000, status: 'pending',
          continuationTaskId: executionTaskId('runtime', sessionId, `lark:${config.appId}:${messageId}:1`),
          requester: (await this.host.service.getContactUser(actorId, 'open_id').catch(() => undefined))?.name || actorId,
          chat: event.chatType === 'group' ? (await this.host.service.getChatPreflightInfo(event.chatId).catch(() => undefined))?.name || event.chatId : '私聊',
          link: await this.host.service.getMessageLink(larkMessageAnchor(event)),
          recipients: Array.from(names, ([openId,name]) => ({ openId, name, uuid: randomUUID() })) };
        await this.save(r, undefined);
        this.host.log.info({ appId: r.appId, sessionId, taskId, actorId, createdAt, summary: r.summary, command }, '已登记高危操作审批申请');
      }
      if (r.status === 'pending') await this.deliver(r, config);
      if (r.status === 'undeliverable') throw unavailable();
      if (r.status !== 'pending') throw new RuntimeError('RISK_APPROVAL_DECIDED', label(r), 409);
      return { pendingApproval: true, approvalId: taskId, approvers: r.recipients.filter(user => user.cardId).map(user => user.name) };
    });
  }
  private async deliver(r: RiskApproval, config: StoredLarkConfig) {
    let old = JSON.stringify(r);
    for (const recipient of r.recipients.filter(user => !user.attempted)) {
      try {
        if (await this.authorized(config, r.event, r.sessionId, recipient.openId)) {
          const response = await this.host.service.callOpenApi('/open-apis/im/v1/messages?receive_id_type=open_id', {
            method: 'POST', body: { receive_id: recipient.openId, msg_type: 'interactive', content: JSON.stringify(card(r)), uuid: recipient.uuid } });
          if (response.data?.message_id) { recipient.cardId = response.data.message_id; recipient.rendered = r.status; }
        }
      } catch (error) { this.host.log.warn({ error, taskId: r.taskId, openId: recipient.openId }, '管理员审批卡私聊发送失败'); }
      recipient.attempted = true;
      old = await this.save(r, old);
    }
    if (!r.recipients.some(user => user.cardId)) { r.status = 'undeliverable'; await this.save(r, old); }
  }
  private async validSession(r: RiskApproval, config: StoredLarkConfig) {
    const effective = this.host.groupManager?.resolved && r.event.chatType === 'group'
      ? await this.host.groupManager.resolved(config, r.event.chatId, true) : config;
    return riskOriginalSession(r, effective, this.host.runtime, this.host.cardMappings);
  }
  async decide(config: StoredLarkConfig, id: string, decision: unknown, operator?: string, source?: ButtonSource) {
    return serialByKey(this.locks, id, async () => {
      const r = await readRiskApproval(this.store, config.appId, id);
      if (!r || !operator || !['approve','reject'].includes(String(decision))
        || !r.recipients.some(user => user.openId === operator && user.cardId && user.cardId === source?.messageId)
        || !await this.authorized(config, r.event, r.sessionId, operator)) return { type: 'warning', content: '你没有批准高危操作的权限' };
      if (r.status === 'pending') {
        const old = JSON.stringify(r);
        const name = r.recipients.find(user => user.openId === operator)!.name;
        const current = await this.validSession(r, config);
        if (Date.now() >= r.expiresAt) r.status = 'expired';
        else if (!current) r.status = 'ended';
        else {
          r.decision = { actor: operator, name, at: Date.now(), approved: decision === 'approve' };
          r.status = r.decision.approved ? 'approved' : 'rejected';
        }
        await this.save(r, old);
        this.host.log.info({ appId: r.appId, taskId: id, result: r.status, operator, at: r.decision?.at, summary: r.summary, command: r.command }, '高危审批决定已保存');
      }
      await this.advance(r, config);
      return { type: 'info', content: label(r) };
    });
  }
  private async advance(r: RiskApproval, config: StoredLarkConfig) {
    if (this.host.stopped) return;
    let old = JSON.stringify(r);
    let ready = false;
    if (r.status === 'approved' || r.status === 'pending') {
      const task = this.host.runtime.getAcceptedTask?.(r.continuationTaskId)?.task;
      if (r.status === 'pending' && r.recipients.every(user => user.attempted && !user.cardId)) r.status = 'undeliverable';
      else if (Date.now() >= r.expiresAt) r.status = 'expired';
      else if (!await this.validSession(r, config)) r.status = 'ended';
      else if (r.status === 'approved') {
        const awaitingStart = !task || task.status === 'queued';
        const available = awaitingStart && config.riskControlMode === 'enforced'
          && await this.host.runtime.riskContinuationReady?.(r.sessionId, { queued: task?.status === 'queued', expiresAt: r.expiresAt }) === true;
        r.waiting = awaitingStart && !available;
        ready = available && !task;
      } else if (r.recipients.some(user => !user.attempted)) { await this.deliver(r, config); old = JSON.stringify(r); }
      if (old !== JSON.stringify(r)) old = await this.save(r, old);
      if (task?.status === 'queued' && (r.status === 'ended' || r.status === 'expired')) await this.host.runtime.cancelQueued(r.sessionId, task.id, r.actorId);
    }
    if (r.status === 'rejected' && !r.notified && !r.rejectionNoticeAbandoned) {
      try {
        await this.host.service.replyText({ messageId: larkMessageAnchor(r.event), replyInThread: Boolean(r.event.threadId),
          text: `<at user_id="${r.actorId}"></at> 管理员拒绝了本次高危操作：${escapeCardInline(r.summary)}`, idempotencyKey: `risk-rejected-${r.taskId}` });
        r.notified = true;
      } catch (error) {
        r.rejectionNoticeFailures = (r.rejectionNoticeFailures ?? 0) + 1;
        r.rejectionNoticeAbandoned = r.rejectionNoticeFailures >= maxRejectionNoticeAttempts;
        this.host.log.warn({ error, taskId: r.taskId, attempts: r.rejectionNoticeFailures },
          r.rejectionNoticeAbandoned ? '高危操作拒绝通知已放弃' : '高危操作拒绝通知待重试');
      }
      old = await this.save(r, old);
    }
    const rendered = r.status + (r.waiting && r.status === 'approved' ? ':waiting' : '');
    for (const user of r.recipients) {
      if (!user.cardId || user.rendered === rendered) continue;
      try {
        await this.host.service.callOpenApi('/open-apis/im/v1/messages/' + encodeURIComponent(user.cardId), { method: 'PATCH', body: { content: JSON.stringify(card(r)) } });
      } catch (error) { this.host.log.warn({ error, taskId: r.taskId }, '管理员审批卡更新待重试'); continue; }
      user.rendered = rendered; old = await this.save(r, old);
    }
    if (ready && Date.now() < r.expiresAt && await this.host.runtime.riskContinuationReady?.(r.sessionId, { queued: false, expiresAt: r.expiresAt }) === true) await this.resume(r, config);
    return ['pending','approved'].includes(r.status) || (r.status === 'rejected' && !r.notified && !r.rejectionNoticeAbandoned)
      || r.recipients.some(user => user.cardId && user.rendered !== rendered);
  }
  async reconcile(config: StoredLarkConfig) {
    let pending = 0;
    if (!this.store.list) return 0;
    for (const { key, value } of await this.store.list(riskApprovalKey(config.appId, ''))) {
      try {
        const row = JSON.parse(value) as RiskApproval;
        if (row.status === 'undeliverable' || !['pending','approved'].includes(row.status) && row.recipients.every(user => !user.cardId || user.rendered === row.status)
          && (row.status !== 'rejected' || row.notified || row.rejectionNoticeAbandoned)) continue;
        if (await serialByKey(this.locks, row.taskId, async () => {
          const r = await readRiskApproval(this.store, config.appId, row.taskId);
          return r && this.advance(r, config);
        })) pending++;
      } catch (error) {
        this.host.log.warn({ error, key, appId: config.appId }, '单条高危审批记录对账失败');
        pending++;
      }
    }
    return pending;
  }
}
