import { createHash } from 'node:crypto';
import { RuntimeError, installationOwnerTaskActor, type RepositoryBundle } from '@dutydeck/shared';
import type { DutydeckRuntime } from '@dutydeck/runtime';
import { larkExecutionConfirmed, readLarkConfig, type StoredLarkConfig } from './lark/config.js';
import type { LarkGroupManager } from './lark/group-management.js';
import { createLarkCardService, type LarkCardService } from './lark/service.js';
import type { PersistedLarkCardTask } from './lark/coordinator.js';
import { renderLarkCardElements } from './lark/card-renderer.js';
import { sendLarkResult } from './lark/result-delivery.js';

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

  const deliver = async (sessionId: string, taskId: string, occurrenceId: string, sourceId: string) => {
    const session = await runtime.getSession(sessionId);
    if (!session) throw new RuntimeError('AUTOMATION_SESSION_MISSING', '自动任务的会话不存在', 404);
    if (session.source !== 'lark') return;
    const task = await repos.tasks.get?.(taskId);
    if (!task || task.sessionId !== sessionId || ['running', 'queued'].includes(task.status)) throw new RuntimeError('AUTOMATION_RESULT_NOT_READY', '自动任务结果尚未就绪', 409);
    if (!await authorize(sessionId, task.executionContext?.actorId)) throw new RuntimeError('AUTOMATION_DELIVERY_REVOKED', '自动任务的交付权限已撤销', 403);
    const [appId, chatId] = session.sourceId?.split(':') ?? [];
    const config = await readLarkConfig(repos.config, appId);
    if (!config || !appId || !chatId) throw new RuntimeError('AUTOMATION_DESTINATION_MISSING', '原机器人或会话已不可用', 409);
    const target = JSON.parse(await repos.config.get(`automation.delivery-target.${sourceId}`) ?? 'null') as { appId: string; chatId: string; replyMessageId: string; replyInThread: boolean } | null;
    if (!target || target.appId !== appId || target.chatId !== chatId) throw new RuntimeError('AUTOMATION_DESTINATION_MISSING', '自动任务缺少接收时保存的回报位置', 409);
    const events = await runtime.getEvents(sessionId);
    const start = events.findIndex(event => event.type === 'text' && (event.data as Record<string, unknown> | undefined)?.role === 'user' && (event.data as Record<string, unknown> | undefined)?.taskId === taskId);
    if (start < 0) throw new RuntimeError('AUTOMATION_RESULT_BOUNDARY_MISSING', '无法确认本轮结果的起点', 409);
    const next = events.findIndex((event, index) => index > start && event.type === 'text' && (event.data as Record<string, unknown> | undefined)?.role === 'user');
    const elements = renderLarkCardElements(events.slice(start, next < 0 ? undefined : next), config, true, false, undefined, 'result');
    const idempotencyKey = `auto_${createHash('sha256').update(occurrenceId).digest('hex').slice(0, 40)}`;
    await sendLarkResult(client(config), target, { state: task.status === 'completed' ? 'completed' : ['interrupted', 'cancelled'].includes(task.status) ? 'interrupted' : 'failed', readOnly: true, retryable: false,
      taskName: '自动续作结果', taskId, sessionId, workspace: session.cwd, webBaseUrl: config.webBaseUrl,
      elements, idempotencyKey }, options.log);
  };
  return { authorize, prepareDelivery, deliver };
}
