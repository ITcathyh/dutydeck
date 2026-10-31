import type { LarkScheduleMessageOrigin } from './agent-schedule-request.js';
import { createHash } from 'node:crypto';
import {
  RuntimeError,
  canonicalExecutionJson,
  ciSubscriptionV2Schema,
  installationOwnerTaskActor,
  parseLarkSourceId,
  sessionScheduleOccurrenceV2Schema,
  type AttemptResultV1,
  type ExecutionActor,
  type PublicSessionSchedule,
  type RepositoryBundle,
  type SessionSchedule
} from '@dutydeck/shared';
import type { DutydeckRuntime } from '@dutydeck/runtime';
import { larkExecutionConfirmed, readLarkConfig, type StoredLarkConfig } from './lark/config.js';
import type { LarkGroupManager } from './lark/group-management.js';
import { createLarkCardService, type LarkCardService } from './lark/service.js';
import type { PersistedLarkCardTask } from './lark/coordinator.js';
import { renderLarkResultTextElements } from './lark/card-renderer.js';
import { sendLarkResult, readConfirmedLarkResult } from './lark/result-delivery.js';
import { scheduleRequestCard } from './lark/schedule-command.js';
import { readTaskAttemptResult } from './task-results.js';
import type { CiNotice } from './ci-webhook.js';
import { SessionAutomationService, type AutomationDeliveryContext } from './session-automation.js';

export function createAutomationIntegration(repos: RepositoryBundle, runtime: DutydeckRuntime, groups: LarkGroupManager, options: {
  env?: NodeJS.ProcessEnv;
  /** Return a dedicated client per call; delivery cancellation closes its client. */
  client?: (config: StoredLarkConfig) => LarkCardService;
  log: { warn: (...args: any[]) => void };
}) {
  const client = (config: StoredLarkConfig) => options.client?.(config) ?? createLarkCardService(options.env ?? process.env, globalThis.fetch, config);
  const authorize = async (sessionId: string, actorId?: string, context?: AutomationDeliveryContext, readOnly = false) => {
    context?.signal.throwIfAborted();
    const session = await runtime.getSession(sessionId);
    if (!session || !actorId) return false;
    if (session.source !== 'lark') return session.source !== 'foundation_group_binding' && session.source !== 'schedule' && actorId === installationOwnerTaskActor;
    const { appId, chatId, chatType } = parseLarkSourceId(session.sourceId);
    if (!appId || !chatId) return false;
    const config = await readLarkConfig(repos.config, appId, { readOnly });
    if (!config || !config.listening || !larkExecutionConfirmed(config)) return false;
    const owner = actorId === installationOwnerTaskActor;
    // Unlike beginTurn, this checks the captured actor without switching the
    // identity used by a turn that may already be running in this session.
    if (chatType === 'group') {
      const decision = await groups.authorize(appId, chatId, owner ? undefined : actorId, 'turn.append', sessionId, { installationOwner: owner, readOnly });
      if (decision) return decision.allowed;
    }
    if (owner) return true;
    if (!(config.allowedUsers?.length || config.allowedEmails?.length)) return true;
    if (config.allowedUsers?.some(user => user.openId === actorId) || config.allowedBots?.some(bot => bot.openId === actorId)) return true;
    if (!config.allowedEmails?.length || readOnly) return false;
    context?.signal.throwIfAborted();
    const directory = client(config);
    const abort = () => directory.close?.();
    context?.signal.addEventListener('abort', abort, { once: true });
    try { return (await directory.getUserEmails(actorId)).some(email => config.allowedEmails.includes(email)); }
    catch { return false; }
    finally { context?.signal.removeEventListener('abort', abort); }
  };

  const prepareDelivery = async (sessionId: string, automationId: string) => {
    const session = await runtime.getSession(sessionId);
    if (!session) throw new RuntimeError('AUTOMATION_SESSION_MISSING', '自动任务的会话不存在', 404);
    if (session.source !== 'lark') return;
    const { appId, chatId } = parseLarkSourceId(session.sourceId);
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

  /** Agent 代建计划的回报位置：这一轮请求的那条消息，和用户在那里发 /schedule 一样。找不到这一轮的卡片时交给 prepareDelivery 按会话最近的卡片推断。 */
  const prepareTaskDelivery = async (sessionId: string, taskId: string, automationId: string) => {
    const session = await runtime.getSession(sessionId);
    if (session?.source !== 'lark' || !repos.config.compareAndSet) return;
    const { appId, chatId } = parseLarkSourceId(session.sourceId);
    for (const mapping of await repos.channelMappings.list(`lark-card:${appId}`)) {
      if (mapping.sessionId !== sessionId) continue;
      let saved: PersistedLarkCardTask;
      try { saved = JSON.parse(mapping.extra ?? 'null'); } catch { continue; }
      // 私聊的卡片记录不写 reply_message_id，记录的 externalId 就是这条请求消息。
      const replyMessageId = saved?.reply_message_id ?? mapping.externalId;
      if (saved?.runtime_task_id !== taskId || saved.chat_id !== chatId || !replyMessageId.startsWith('om_')) continue;
      await repos.config.compareAndSet(`automation.delivery-target.${automationId}`, undefined, JSON.stringify({ appId, chatId, replyMessageId, replyInThread: saved.reply_in_thread === true }));
      return;
    }
  };

  /** 忙时消息没有自己的执行轮次，回报锚由已授权的宿主入站事件显式提供。 */
  const prepareMessageDelivery = async (sessionId: string, origin: LarkScheduleMessageOrigin, automationId: string) => {
    const session = await runtime.getSession(sessionId);
    const { appId, chatId } = parseLarkSourceId(session?.sourceId);
    if (session?.source !== 'lark' || appId !== origin.appId || chatId !== origin.chatId || !origin.messageId.startsWith('om_') || !repos.config.compareAndSet) {
      throw new RuntimeError('AUTOMATION_DESTINATION_MISSING', '无法确认当前消息的回报位置', 409);
    }
    const key = `automation.delivery-target.${automationId}`;
    const target = JSON.stringify({ appId, chatId, replyMessageId: origin.messageId, replyInThread: origin.replyInThread });
    if (!await repos.config.compareAndSet(key, undefined, target) && await repos.config.get(key) !== target) {
      throw new RuntimeError('AUTOMATION_DESTINATION_CHANGED', '自动任务的回报位置已变化', 409);
    }
  };

  /** Agent 代建计划的确认卡：发到计划冻结的回报位置，同一计划只发一张；点「启用」「停用」后由卡片回调原位重绘。 */
  const sendScheduleRequest = async (schedule: PublicSessionSchedule, notice?: string, requestId?: string) => {
    const session = await runtime.getSession(schedule.sessionId);
    if (!session || session.source !== 'lark') throw new RuntimeError('AUTOMATION_DESTINATION_MISSING', '只能在飞书会话里代设定时任务', 409);
    const { appId, chatId } = parseLarkSourceId(session.sourceId);
    const target = JSON.parse(await repos.config.get(`automation.delivery-target.${schedule.id}`) ?? 'null') as { appId: string; chatId: string; replyMessageId: string; replyInThread: boolean } | null;
    const config = appId ? await readLarkConfig(repos.config, appId) : undefined;
    if (!target || !config || target.appId !== appId || target.chatId !== chatId) throw new RuntimeError('AUTOMATION_DESTINATION_MISSING', '自动任务缺少接收时保存的回报位置', 409);
    const card = scheduleRequestCard(schedule, target.replyInThread);
    await sendLarkResult(client(config), target, {
      ...card, ...(notice ? { elements: [{ tag: 'markdown', content: notice }, ...card.elements] } : {}),
      sessionId: schedule.sessionId,
      workspace: session.cwd,
      webBaseUrl: config.webBaseUrl,
      // 同一计划只发一张；更新同名计划后按新修订再发一张，否则会被首张卡的幂等键吞掉。带请求编号时为该请求补发一张。
      idempotencyKey: `schedule_request_${createHash('sha256').update(`${schedule.revision > 1 ? `${schedule.id}:${schedule.revision}` : schedule.id}${requestId ? `:${requestId}` : ''}`).digest('hex').slice(0, 40)}`
    }, options.log, repos.config);
  };

  const deliver = async (sessionId: string, result: AttemptResultV1, occurrenceId: string, sourceId: string, context?: AutomationDeliveryContext) => {
    const session = await runtime.getSession(sessionId);
    if (!session) throw new RuntimeError('AUTOMATION_SESSION_MISSING', '自动任务的会话不存在', 404);
    if (session.source !== 'lark') return;

    // 1. 从实际 occurrence (Schedule) 或 subscription (CI) 读取冻结来源记录。
    //    deliver 只在 refresh 冻结原 admission 的已验证 result 后触发，来源必为含 admission/result 的 V2 记录；
    //    已 delivered 历史早退。Schedule 传 (occurrenceId, scheduleId)；CI 传 (subscriptionId, subscriptionId)。
    let frozenTaskId: string;
    let frozenAttemptId: string;
    let frozenActor: ExecutionActor;
    let frozenResult: AttemptResultV1;
    let frozenRequestKey: string;
    let executionSessionId = sessionId;
    let frozenRequest: import('@dutydeck/shared').TaskRequestV1;

    const occRaw = await repos.config.get(`session_automation/occurrence/${occurrenceId}`);
    if (occRaw && occurrenceId !== sourceId) {
      const record = sessionScheduleOccurrenceV2Schema.parse(JSON.parse(occRaw));
      if (record.delivery.status === 'delivered') return;
      if (record.sessionId !== sessionId) throw new RuntimeError('AUTOMATION_RESULT_NOT_READY', 'Schedule 来源会话不匹配', 409);
      if (record.scheduleId !== sourceId) throw new RuntimeError('AUTOMATION_RESULT_NOT_READY', 'Schedule 来源标识不匹配', 409);
      if (!record.admission || !record.actor || !record.admission.request || !record.runtimeAttemptId || !record.result) {
        throw new RuntimeError('AUTOMATION_RESULT_NOT_READY', 'Schedule 来源缺少冻结 admission/actor/request/result', 409);
      }
      executionSessionId = record.executionSessionId ?? sessionId;
      frozenTaskId = record.admission.taskId;
      frozenAttemptId = record.runtimeAttemptId;
      frozenActor = record.actor;
      frozenResult = record.result;
      frozenRequestKey = record.admission.request.key;
      frozenRequest = record.admission.request;
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
      frozenRequest = record.admission.request;
    }

    // 请求 key 必须与来源冻结一致：Schedule/CI 各自固定 namespace+key。
    const expectedNamespace = occurrenceId !== sourceId ? 'schedule' : 'automation';
    const expectedKey = occurrenceId !== sourceId ? `session-automation:schedule:${occurrenceId}` : `session-automation:ci:${sourceId}`;
    if (frozenRequestKey !== expectedKey) throw new RuntimeError('AUTOMATION_RESULT_NOT_READY', '来源请求 key 与冻结 admission 不匹配', 409);

    if (frozenTaskId !== result.taskId) {
      throw new RuntimeError('AUTOMATION_RESULT_NOT_READY', '任务 ID 与来源记录不匹配', 409);
    }
    if (frozenResult.attemptId !== result.attemptId) {
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
    if (accepted.task.sessionId !== executionSessionId || accepted.task.id !== result.taskId) {
      throw new RuntimeError('AUTOMATION_RESULT_NOT_READY', '真实任务归属与当前会话不匹配', 409);
    }
    if (canonicalExecutionJson(accepted.request) !== canonicalExecutionJson(frozenRequest)) throw new RuntimeError('AUTOMATION_RESULT_NOT_READY', '真实接受请求与冻结来源不匹配', 409);
    if (accepted.request.namespace !== expectedNamespace || accepted.request.key !== expectedKey) {
      throw new RuntimeError('AUTOMATION_RESULT_NOT_READY', '真实已接受请求 key 与来源期望不匹配', 409);
    }
    if (canonicalExecutionJson(accepted.request.actor) !== canonicalExecutionJson(frozenActor)) {
      throw new RuntimeError('AUTOMATION_RESULT_NOT_READY', '来源 actor 与真实接受 actor 不匹配', 409);
    }

    // 3. 从冻结 number=1 admission 验证安全自动后继及其结算、throughSequence/全文/digest
    let read;
    try {
      read = readTaskAttemptResult({ execution: repos.execution }, executionSessionId, result.taskId, frozenAttemptId);
    } catch (cause) {
      throw new RuntimeError('AUTOMATION_RESULT_NOT_READY', `结果验证失败: ${cause instanceof Error ? cause.message : String(cause)}`, 409);
    }
    if (read.status !== 'settled') {
      throw new RuntimeError('AUTOMATION_RESULT_NOT_READY', '自动任务结果尚未权威结算或处于阻塞状态', 409);
    }
    const verifiedResult = read.result;
    if (
      verifiedResult.attemptId !== result.attemptId ||
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
    const { appId, chatId } = parseLarkSourceId(session.sourceId);
    if (actualActor.kind === 'channel') {
      if (actualActor.appId !== appId) throw new RuntimeError('AUTOMATION_DELIVERY_REVOKED', '原任务 App 域与 Session 不一致', 403);
    }
    const actorId = actualActor.kind === 'installation_owner'
      ? installationOwnerTaskActor
      : actualActor.kind === 'channel'
        ? actualActor.id
        : undefined;
    if (!await authorize(sessionId, actorId, context)) {
      throw new RuntimeError('AUTOMATION_DELIVERY_REVOKED', '自动任务的交付权限已撤销', 403);
    }

    const config = await readLarkConfig(repos.config, appId);
    if (!config || !appId || !chatId) throw new RuntimeError('AUTOMATION_DESTINATION_MISSING', '原机器人或会话已不可用', 409);

    // 5. 话题目标必须是该来源已冻结的目标
    const target = JSON.parse(await repos.config.get(`automation.delivery-target.${sourceId}`) ?? 'null') as { appId: string; chatId: string; replyMessageId: string; replyInThread: boolean } | null;
    if (!target || target.appId !== appId || target.chatId !== chatId) throw new RuntimeError('AUTOMATION_DESTINATION_MISSING', '自动任务缺少接收时保存的回报位置', 409);

    // 6. 渲染与发送
    const isSchedule = Boolean(occRaw && occurrenceId !== sourceId);
    let taskName = '自动续作结果';
    if (isSchedule) {
      const schedule = await SessionAutomationService.getSchedule(repos.config, sourceId);
      if (schedule?.name?.trim()) {
        taskName = schedule.name.trim();
      }
    }
    const elements = renderLarkResultTextElements(verifiedResult.output.text);
    if (isSchedule) {
      elements.push({
        tag: 'button',
        element_id: 'disable_schedule',
        text: { tag: 'plain_text', content: '停用此计划' },
        type: 'text',
        behaviors: [{ type: 'callback', value: { dutydeck_schedule_disable: sourceId } }],
        margin: '0px'
      });
    }
    const idempotencyKey = `auto_${createHash('sha256').update(occurrenceId).digest('hex').slice(0, 40)}`;
    const sender = client(config);
    const abort = () => sender.close?.();
    context?.signal.addEventListener('abort', abort, { once: true });
    const beforeSend = async () => {
      context?.signal.throwIfAborted();
      await context?.assertCurrent();
      if (!await authorize(sessionId, actorId, context)) throw new RuntimeError('AUTOMATION_DELIVERY_REVOKED', '自动任务的交付权限已撤销', 403);
      await context?.assertCurrent();
      context?.signal.throwIfAborted();
    };
    try {
      await beforeSend();
      await sendLarkResult(sender, target, {
        state: verifiedResult.outcome === 'completed' ? 'completed' : ['interrupted', 'cancelled'].includes(verifiedResult.outcome) ? 'interrupted' : 'failed',
        readOnly: true,
        retryable: false,
        taskName,
        taskId: verifiedResult.taskId,
        sessionId,
        workspace: session.cwd,
        webBaseUrl: config.webBaseUrl,
        elements,
        idempotencyKey
      }, options.log, repos.config, beforeSend);
    } finally { context?.signal.removeEventListener('abort', abort); }
  };
  /** 计划的冻结回报位置；非飞书会话没有回报位置，返回 undefined。 */
  const scheduleNoticeTarget = async (schedule: SessionSchedule, missing: string) => {
    const session = await runtime.getSession(schedule.sessionId);
    if (!session) throw new RuntimeError('AUTOMATION_SESSION_MISSING', '自动任务的会话不存在', 404);
    if (session.source !== 'lark') return;
    const { appId, chatId } = parseLarkSourceId(session.sourceId);
    const target = JSON.parse(await repos.config.get(`automation.delivery-target.${schedule.id}`) ?? 'null') as { appId: string; chatId: string; replyMessageId: string; replyInThread: boolean } | null;
    const config = appId ? await readLarkConfig(repos.config, appId) : undefined;
    if (!target || !config || target.appId !== appId || target.chatId !== chatId) throw new RuntimeError('AUTOMATION_DESTINATION_MISSING', missing, 409);
    return { session, config, target };
  };
  const disabledNotice = async (schedule: SessionSchedule) => {
    const destination = await scheduleNoticeTarget(schedule, '停用告知缺少冻结回报位置');
    if (!destination) return;
    const { session, config, target } = destination;
    const name = schedule.disableNotification?.name ?? schedule.name;
    return { config, target, input: {
      state: 'failed' as const, readOnly: true, retryable: false, taskName: name,
      taskId: schedule.id, sessionId: schedule.sessionId, workspace: session.cwd, webBaseUrl: config.webBaseUrl,
      elements: [{ tag: 'markdown', element_id: 'schedule_disabled_notice', content: `定时计划『${name}』已停用：${schedule.disabledReason ?? 'Session is no longer active'}` }],
      idempotencyKey: `schedule_disabled_${createHash('sha256').update(`${schedule.id}_${schedule.disabledAt ?? schedule.generation}`).digest('hex').slice(0, 40)}`
    } };
  };
  const onScheduleDisabled = async (schedule: SessionSchedule, _reason: string, beforeSend?: () => Promise<void>) => {
    const notice = await disabledNotice(schedule);
    if (!notice) return 'not_requested' as const;
    const guard = async () => {
      if (!await authorize(schedule.sessionId, schedule.actorId)) throw new RuntimeError('AUTOMATION_DELIVERY_REVOKED', '停用告知的交付权限已撤销', 403);
      await beforeSend?.();
    };
    await sendLarkResult(client(notice.config), { ...notice.target, allowReplyFallback: false }, notice.input, options.log, repos.config, guard);
  };
  /** 某次触发超过一个周期还没开始或没结束：在计划的原话题提醒一次，说明卡点。 */
  const onScheduleOverdue = async (schedule: SessionSchedule, notice: { occurrenceId: string; scheduledForUtc: string; reason: string }) => {
    const destination = await scheduleNoticeTarget(schedule, '逾期提醒缺少冻结回报位置');
    if (!destination) return 'not_requested' as const;
    const { session, config, target } = destination;
    if (!await authorize(schedule.sessionId, schedule.actorId)) throw new RuntimeError('AUTOMATION_DELIVERY_REVOKED', '逾期提醒的交付权限已撤销', 403);
    const scheduledAt = new Date(notice.scheduledForUtc).toLocaleString('zh-CN', { timeZone: schedule.timezone, hour12: false });
    await sendLarkResult(client(config), { ...target, allowReplyFallback: false }, {
      state: 'failed', readOnly: true, retryable: false, taskName: schedule.name,
      taskId: schedule.id, sessionId: schedule.sessionId, workspace: session.cwd, webBaseUrl: config.webBaseUrl,
      elements: [{ tag: 'markdown', element_id: 'schedule_overdue_notice', content: `定时计划『${schedule.name}』${scheduledAt} 的那次触发超过一个周期还没结束：${notice.reason}。\n\n它结束或被处理之前，这个计划不会再生成新的触发。` }],
      idempotencyKey: `schedule_overdue_${createHash('sha256').update(notice.occurrenceId).digest('hex').slice(0, 40)}`
    }, options.log, repos.config);
  };
  const reconcileDisabledNotification = async (schedule: SessionSchedule) => {
    const notice = await disabledNotice(schedule);
    if (!notice) return true;
    return Boolean(await readConfirmedLarkResult(client(notice.config), notice.target, notice.input, options.log, repos.config));
  };
  /** CI webhook 通知：发到订阅时冻结的回报位置，非飞书会话不发；返回卡片消息 ID，按钮回调据此核对来源。 */
  const notify = async (sessionId: string, sourceId: string, notice: CiNotice) => {
    const session = await runtime.getSession(sessionId);
    if (!session || session.source !== 'lark') return undefined;
    const { appId, chatId } = parseLarkSourceId(session.sourceId);
    const target = JSON.parse(await repos.config.get(`automation.delivery-target.${sourceId}`) ?? 'null') as { appId: string; chatId: string; replyMessageId: string; replyInThread: boolean } | null;
    const config = appId ? await readLarkConfig(repos.config, appId) : undefined;
    if (!target || !config || target.appId !== appId || target.chatId !== chatId) throw new RuntimeError('AUTOMATION_DESTINATION_MISSING', '自动任务缺少接收时保存的回报位置', 409);
    const elements: Array<Record<string, unknown>> = [
      { tag: 'markdown', element_id: 'ci_notice', content: notice.markdown },
      ...(notice.output ? renderLarkResultTextElements(notice.output) : []),
      ...(notice.action ? [{ tag: 'button', element_id: 'ci_fix', text: { tag: 'plain_text', content: notice.action.label }, type: 'primary',
        behaviors: [{ type: 'callback', value: notice.action.value }], margin: '0px' }] : []),
      ...(notice.actions ?? []).map((action, index) => ({ tag: 'button', element_id: `notice_action_${index}`, text: { tag: 'plain_text', content: action.label }, type: action.type ?? 'primary',
        behaviors: [{ type: 'callback', value: action.value }], margin: '0px' }))
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
  return { authorize, previewAuthorize: (sessionId: string, actorId?: string) => authorize(sessionId, actorId, undefined, true), prepareDelivery, prepareTaskDelivery, prepareMessageDelivery, sendScheduleRequest, deliver, notify, onScheduleDisabled, onScheduleOverdue, reconcileDisabledNotification };
}
