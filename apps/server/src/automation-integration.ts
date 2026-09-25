import { createHash } from 'node:crypto';
import {
  RuntimeError,
  canonicalExecutionJson,
  ciSubscriptionV2Schema,
  installationOwnerTaskActor,
  sessionScheduleOccurrenceV2Schema,
  type AttemptResultV1,
  type ExecutionActor,
  type RepositoryBundle
} from '@dutydeck/shared';
import type { DutydeckRuntime } from '@dutydeck/runtime';
import { larkExecutionConfirmed, readLarkConfig, type StoredLarkConfig } from './lark/config.js';
import type { LarkGroupManager } from './lark/group-management.js';
import { createLarkCardService, type LarkCardService } from './lark/service.js';
import type { PersistedLarkCardTask } from './lark/coordinator.js';
import { renderLarkResultTextElements } from './lark/card-renderer.js';
import { sendLarkResult } from './lark/result-delivery.js';
import { readAttemptResult } from './task-results.js';
import type { CodebaseCiNotice } from './codebase-ci.js';

export function createAutomationIntegration(repos: RepositoryBundle, runtime: DutydeckRuntime, groups: LarkGroupManager, options: {
  env?: NodeJS.ProcessEnv;
  client?: (config: StoredLarkConfig) => LarkCardService;
  log: { warn: (...args: any[]) => void };
}) {
  const client = (config: StoredLarkConfig) => options.client?.(config) ?? createLarkCardService(options.env ?? process.env, globalThis.fetch, config);
  const authorize = async (sessionId: string, actorId?: string) => {
    const session = await runtime.getSession(sessionId);
    if (!session || !actorId) return false;
    if (session.source !== 'lark') return session.source !== 'foundation_group_binding' && actorId === installationOwnerTaskActor;
    const [appId, chatId, chatType] = session.sourceId?.split(':') ?? [];
    if (!appId || !chatId) return false;
    const config = await readLarkConfig(repos.config, appId);
    if (!config || !config.listening || !larkExecutionConfirmed(config)) return false;
    const owner = actorId === installationOwnerTaskActor;
    // Unlike beginTurn, this checks the captured actor without switching the
    // identity used by a turn that may already be running in this session.
    if (chatType === 'group') {
      const decision = await groups.authorize(appId, chatId, owner ? undefined : actorId, 'turn.append', sessionId, { installationOwner: owner });
      if (decision) return decision.allowed;
    }
    if (owner) return true;
    if (!(config.allowedUsers?.length || config.allowedEmails?.length)) return true;
    if (config.allowedUsers?.some(user => user.openId === actorId) || config.allowedBots?.some(bot => bot.openId === actorId)) return true;
    if (!config.allowedEmails?.length) return false;
    try { return (await client(config).getUserEmails(actorId)).some(email => config.allowedEmails.includes(email)); }
    catch { return false; }
  };

  const prepareDelivery = async (sessionId: string, automationId: string) => {
    const session = await runtime.getSession(sessionId);
    if (!session) throw new RuntimeError('AUTOMATION_SESSION_MISSING', '自动任务的会话不存在', 404);
    if (session.source !== 'lark') return;
    const [appId, chatId] = session.sourceId?.split(':') ?? [];
    if (!appId || !chatId) throw new RuntimeError('AUTOMATION_DESTINATION_MISSING', '无法确认原会话', 409);
    const key = `automation.delivery-target.${automationId}`;
    type Target = { appId: string; chatId: string; replyMessageId: string; replyInThread: boolean };
    let target: Target | undefined = JSON.parse(await repos.config.get(key) ?? 'null');
    if (!target) {
      const mappings = (await repos.channelMappings.list(`lark-card:${appId}`)).filter(mapping => mapping.sessionId === sessionId)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
      for (const mapping of mappings) {
        let saved: PersistedLarkCardTask;
        try { saved = JSON.parse(mapping.extra ?? 'null'); } catch { continue; }
        if (saved?.app_id !== appId || saved.chat_id !== chatId || !saved.reply_message_id?.startsWith('om_')) continue;
        target = { appId, chatId, replyMessageId: saved.reply_message_id, replyInThread: saved.reply_in_thread === true };
        break;
      }
      if (!target || !repos.config.compareAndSet) throw new RuntimeError('AUTOMATION_DESTINATION_MISSING', '无法确认原话题的结果回报位置', 409);
      if (!await repos.config.compareAndSet(key, undefined, JSON.stringify(target))) target = JSON.parse((await repos.config.get(key))!);
    }
    if (!target || target.appId !== appId || target.chatId !== chatId) throw new RuntimeError('AUTOMATION_DESTINATION_CHANGED', '自动任务的回报位置已变化', 409);
  };

  const deliver = async (sessionId: string, result: AttemptResultV1, occurrenceId: string, sourceId: string) => {
    const session = await runtime.getSession(sessionId);
    if (!session) throw new RuntimeError('AUTOMATION_SESSION_MISSING', '自动任务的会话不存在', 404);
    if (session.source !== 'lark') return;

    // 1. 从实际 occurrence (Schedule) 或 subscription (CI) 读取冻结来源记录。
    //    deliver 只在 refresh 冻结 number=1 result 后触发，来源必为含 admission/result 的 V2 记录；
    //    已 delivered 历史早退。Schedule 传 (occurrenceId, scheduleId)；CI 传 (subscriptionId, subscriptionId)。
    let frozenTaskId: string;
    let frozenAttemptId: string;
    let frozenActor: ExecutionActor;
    let frozenResult: AttemptResultV1;
    let frozenRequestKey: string;

    const occRaw = await repos.config.get(`session_automation/occurrence/${occurrenceId}`);
    if (occRaw && occurrenceId !== sourceId) {
      const record = sessionScheduleOccurrenceV2Schema.parse(JSON.parse(occRaw));
      if (record.delivery.status === 'delivered') return;
      if (record.sessionId !== sessionId) throw new RuntimeError('AUTOMATION_RESULT_NOT_READY', 'Schedule 来源会话不匹配', 409);
      if (record.scheduleId !== sourceId) throw new RuntimeError('AUTOMATION_RESULT_NOT_READY', 'Schedule 来源标识不匹配', 409);
      if (!record.admission || !record.actor || !record.admission.request || !record.runtimeAttemptId || !record.result) {
        throw new RuntimeError('AUTOMATION_RESULT_NOT_READY', 'Schedule 来源缺少冻结 admission/actor/request/result', 409);
      }
      frozenTaskId = record.admission.taskId;
      frozenAttemptId = record.runtimeAttemptId;
      frozenActor = record.actor;
      frozenResult = record.result;
      frozenRequestKey = record.admission.request.key;
    } else {
      const ciRaw = await repos.config.get(`session_automation/ci/${sourceId}`);
      if (!ciRaw) throw new RuntimeError('AUTOMATION_RESULT_NOT_READY', '自动任务来源记录不存在', 409);
      const record = ciSubscriptionV2Schema.parse(JSON.parse(ciRaw));
      if (record.delivery.status === 'delivered') return;
      if (record.sessionId !== sessionId) throw new RuntimeError('AUTOMATION_RESULT_NOT_READY', 'CI 来源会话不匹配', 409);
      if (record.id !== occurrenceId || record.id !== sourceId) throw new RuntimeError('AUTOMATION_RESULT_NOT_READY', 'CI 来源标识不匹配', 409);
      if (!record.admission || !record.actor || !record.admission.request || !record.runtimeAttemptId || !record.result) {
        throw new RuntimeError('AUTOMATION_RESULT_NOT_READY', 'CI 来源缺少冻结 admission/actor/request/result', 409);
      }
      frozenTaskId = record.admission.taskId;
      frozenAttemptId = record.runtimeAttemptId;
      frozenActor = record.actor;
      frozenResult = record.result;
      frozenRequestKey = record.admission.request.key;
    }

    // 请求 key 必须与来源冻结一致：Schedule/CI 各自固定 namespace+key。
    const expectedNamespace = occurrenceId !== sourceId ? 'schedule' : 'automation';
    const expectedKey = occurrenceId !== sourceId ? `session-automation:schedule:${occurrenceId}` : `session-automation:ci:${sourceId}`;
    if (frozenRequestKey !== expectedKey) throw new RuntimeError('AUTOMATION_RESULT_NOT_READY', '来源请求 key 与冻结 admission 不匹配', 409);

    if (frozenTaskId !== result.taskId) {
      throw new RuntimeError('AUTOMATION_RESULT_NOT_READY', '任务 ID 与来源记录不匹配', 409);
    }
    if (frozenAttemptId !== result.attemptId) {
      throw new RuntimeError('AUTOMATION_RESULT_NOT_READY', 'Attempt ID 与来源记录不匹配', 409);
    }
    if (
      frozenResult.throughSequence !== result.throughSequence ||
      frozenResult.settlementId !== result.settlementId ||
      frozenResult.outcome !== result.outcome ||
      frozenResult.output.digest !== result.output.digest ||
      frozenResult.output.text !== result.output.text
    ) {
      throw new RuntimeError('AUTOMATION_RESULT_NOT_READY', '传入结果与来源冻结快照不匹配', 409);
    }

    // 2. 闭合核验真实 AcceptedTask：
    const accepted = repos.execution.getAcceptedTask(result.taskId);
    if (!accepted || !accepted.request) {
      throw new RuntimeError('AUTOMATION_RESULT_NOT_READY', '真实已接受任务不存在或缺少请求事实', 409);
    }
    if (accepted.task.sessionId !== sessionId || accepted.task.id !== result.taskId) {
      throw new RuntimeError('AUTOMATION_RESULT_NOT_READY', '真实任务归属与当前会话不匹配', 409);
    }
    if (accepted.request.namespace !== expectedNamespace || accepted.request.key !== expectedKey) {
      throw new RuntimeError('AUTOMATION_RESULT_NOT_READY', '真实已接受请求 key 与来源期望不匹配', 409);
    }
    if (canonicalExecutionJson(accepted.request.actor) !== canonicalExecutionJson(frozenActor)) {
      throw new RuntimeError('AUTOMATION_RESULT_NOT_READY', '来源 actor 与真实接受 actor 不匹配', 409);
    }

    // 3. 复用唯一 readAttemptResult 验证原 number=1 结算、throughSequence/全文/digest
    let read;
    try {
      read = readAttemptResult({ execution: repos.execution }, sessionId, result.taskId, result.attemptId);
    } catch (cause) {
      throw new RuntimeError('AUTOMATION_RESULT_NOT_READY', `结果验证失败: ${cause instanceof Error ? cause.message : String(cause)}`, 409);
    }
    if (read.status !== 'settled') {
      throw new RuntimeError('AUTOMATION_RESULT_NOT_READY', '自动任务结果尚未权威结算或处于阻塞状态', 409);
    }
    const verifiedResult = read.result;
    if (
      verifiedResult.throughSequence !== result.throughSequence ||
      verifiedResult.settlementId !== result.settlementId ||
      verifiedResult.outcome !== result.outcome ||
      verifiedResult.output.digest !== result.output.digest ||
      verifiedResult.output.text !== result.output.text
    ) {
      throw new RuntimeError('AUTOMATION_RESULT_NOT_READY', '结果快照与权威 Attempt 事件流及摘要不符', 409);
    }

    // 4. 校验原 App / chat 目标与权限（以真实核实后的 actor 为准）
    const actualActor = accepted.request.actor;
    const [appId, chatId] = session.sourceId?.split(':') ?? [];
    if (actualActor.kind === 'channel') {
      if (actualActor.appId !== appId) throw new RuntimeError('AUTOMATION_DELIVERY_REVOKED', '原任务 App 域与 Session 不一致', 403);
    }
    const actorId = actualActor.kind === 'installation_owner'
      ? installationOwnerTaskActor
      : actualActor.kind === 'channel'
        ? actualActor.id
        : undefined;
    if (!await authorize(sessionId, actorId)) {
      throw new RuntimeError('AUTOMATION_DELIVERY_REVOKED', '自动任务的交付权限已撤销', 403);
    }

    const config = await readLarkConfig(repos.config, appId);
    if (!config || !appId || !chatId) throw new RuntimeError('AUTOMATION_DESTINATION_MISSING', '原机器人或会话已不可用', 409);

    // 5. 话题目标必须是该来源已冻结的目标
    const target = JSON.parse(await repos.config.get(`automation.delivery-target.${sourceId}`) ?? 'null') as { appId: string; chatId: string; replyMessageId: string; replyInThread: boolean } | null;
    if (!target || target.appId !== appId || target.chatId !== chatId) throw new RuntimeError('AUTOMATION_DESTINATION_MISSING', '自动任务缺少接收时保存的回报位置', 409);

    // 6. 渲染与发送
    const elements = renderLarkResultTextElements(verifiedResult.output.text);
    const idempotencyKey = `auto_${createHash('sha256').update(occurrenceId).digest('hex').slice(0, 40)}`;
    await sendLarkResult(client(config), target, {
      state: verifiedResult.outcome === 'completed' ? 'completed' : ['interrupted', 'cancelled'].includes(verifiedResult.outcome) ? 'interrupted' : 'failed',
      readOnly: true,
      retryable: false,
      taskName: '自动续作结果',
      taskId: verifiedResult.taskId,
      sessionId,
      workspace: session.cwd,
      webBaseUrl: config.webBaseUrl,
      elements,
      idempotencyKey
    }, options.log);
  };
  /** CI webhook 通知：发到订阅时冻结的回报位置，非飞书会话不发；返回卡片消息 ID，按钮回调据此核对来源。 */
  const notify = async (sessionId: string, sourceId: string, notice: CodebaseCiNotice) => {
    const session = await runtime.getSession(sessionId);
    if (!session || session.source !== 'lark') return undefined;
    const [appId, chatId] = session.sourceId?.split(':') ?? [];
    const target = JSON.parse(await repos.config.get(`automation.delivery-target.${sourceId}`) ?? 'null') as { appId: string; chatId: string; replyMessageId: string; replyInThread: boolean } | null;
    const config = appId ? await readLarkConfig(repos.config, appId) : undefined;
    if (!target || !config || target.appId !== appId || target.chatId !== chatId) throw new RuntimeError('AUTOMATION_DESTINATION_MISSING', '自动任务缺少接收时保存的回报位置', 409);
    const elements: Array<Record<string, unknown>> = [
      { tag: 'markdown', element_id: 'ci_notice', content: notice.markdown },
      ...(notice.output ? renderLarkResultTextElements(notice.output) : []),
      ...(notice.action ? [{ tag: 'button', element_id: 'ci_fix', text: { tag: 'plain_text', content: notice.action.label }, type: 'primary',
        behaviors: [{ type: 'callback', value: notice.action.value }], margin: '0px' }] : [])
    ];
    const sent = await sendLarkResult(client(config), target, {
      state: notice.failed ? 'failed' : 'completed',
      readOnly: true,
      retryable: false,
      taskName: notice.title,
      taskId: sourceId,
      sessionId,
      workspace: session.cwd,
      webBaseUrl: config.webBaseUrl,
      elements,
      idempotencyKey: `ci_${createHash('sha256').update(notice.key).digest('hex').slice(0, 40)}`
    }, options.log, repos.config);
    return sent.messageId;
  };
  return { authorize, prepareDelivery, deliver, notify };
}
