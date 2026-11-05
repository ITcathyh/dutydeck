import { PluginCommandQueryService } from './command-query.js';
import { PluginToolGrants } from './tool-grants.js';
import { dirname } from 'node:path';
import { resolveDatabaseUrl } from '@dutydeck/config';
import { installationOwnerTaskActor, type ConfigRepository, type WorkItem, type CiWebhookRepository, type ExecutionRepository, type PublicTaskRecord, type Session } from '@dutydeck/shared';
import type { DutydeckRuntime } from '@dutydeck/runtime';
import { readTaskAttemptResult } from '../task-results.js';
import { setPluginSkillRoots } from '../skill-catalog.js';
import { setLarkPluginCommands } from '../lark/plugin-commands.js';
import { PluginHost } from './host.js';
import { createTriggerDispatcher, PLUGIN_TRIGGER_SOURCE, PluginRuntimeHooks, sessionHookContext, triggerResultText, type TriggerBot } from './integration.js';
import type { PluginRouteOptions } from './routes.js';
import type { ScenarioRegistry } from './scenario-registry.js';
import { PluginTriggerService } from './triggers.js';
import { readWorkItemStatus, type WorkItemService } from '../work-items.js';

const stderrLog = { warn: (data: Record<string, unknown>, message: string) => process.stderr.write(`[dutydeck] ${message} ${JSON.stringify(data)}\n`) };

/**
 * daemon 启动时加载插件。场景注册表总是返回（只有内置包时也一样）；host 只在需要接线时返回
 * （有外部插件、绑定、加载错误，或内置插件带了场景包以外的东西），否则为 undefined，调用方据此完全不接线，任务链路和没有插件时一样。
 */
export async function loadDaemonPlugins(env: NodeJS.ProcessEnv, options: { builtinRoot?: string } = {}): Promise<{ host?: PluginHost; scenarios: ScenarioRegistry }> {
  const host = await PluginHost.load({ dataDir: dirname(resolveDatabaseUrl(env)), database: resolveDatabaseUrl(env), log: stderrLog, ...options });
  try {
    const keepHost = host.needsWiring || host.bindings.list().length > 0 || host.diagnostics.length > 0;
    if (!keepHost) await host.dispose();
    return { scenarios: host.scenarios, ...(keepHost ? { host } : {}) };
  } catch (error) { await host.dispose(); throw error; }
}

/**
 * 只取消首次确认前、还没有任何步骤尝试过的工作项；按读到的修订号取消，期间有人确认则修订号冲突、不取消。
 * 带待确认修订的工作项已经在执行，不属于「未确认」，只能从工作项本身取消。
 */
export async function cancelUnconfirmedWorkItem(work: Pick<WorkItemService, 'get' | 'cancel'>, sessionId: string, workItemId: string): Promise<boolean> {
  try {
    const item = await work.get(sessionId, workItemId, installationOwnerTaskActor);
    if (item.status !== 'awaiting_confirmation' || item.pendingRevision || [...item.steps, ...item.retiredSteps ?? []].some(step => step.attempts.length)) return false;
    return (await work.cancel(sessionId, workItemId, item.revision, installationOwnerTaskActor)).status === 'cancelled';
  } catch { return false; }
}

export interface PluginWiringDeps {
  runtime: () => DutydeckRuntime;
  repositories: { config: ConfigRepository; execution: Pick<ExecutionRepository, 'getTaskExecution' | 'getAttemptEvents' | 'getAcceptedTask'>; ciWebhook: Pick<CiWebhookRepository, 'claimEvent' | 'releaseEvent' | 'bindTask' | 'listTaskBindings' | 'unbindTask'> };
  readBot(appId: string): Promise<(TriggerBot & { appSecret?: string }) | undefined>;
  fallbackAgentId(): string | undefined;
  sendText(bot: TriggerBot & { appSecret?: string }, input: { chatId: string; text: string; idempotencyKey: string }): Promise<unknown>;
  /** 触发器启动工作项模板；daemon 装配完成后才会被调用。 */
  workItems?: () => Pick<WorkItemService, 'runTemplate' | 'get' | 'cancel'>;
  log: { warn(data: Record<string, unknown>, message: string): void };
}

/**
 * 把已加载的插件接到 daemon：skills 根、飞书命令、hook 事件、触发器路由与结果回投。
 * runtimeOptions 只包含有对应 hook 的项，没有插件时整个函数不被调用。
 */
export function wirePlugins(host: PluginHost, deps: PluginWiringDeps) {
  const hooks = new PluginRuntimeHooks(host.hooks, deps.log);
  const disposers = [
    setPluginSkillRoots(context => host.skillEntries(context)),
    setLarkPluginCommands(host.commands, new PluginCommandQueryService(host, new PluginToolGrants(deps.repositories.config), 30_000, hooks))
  ];
  const triggers = new PluginTriggerService({
    lookup: (plugin, id) => host.trigger(plugin, id),
    token: (plugin, id) => host.triggerToken(plugin, id),
    deliver: createTriggerDispatcher({ runtime: { start: input => deps.runtime().start(input), dispatch: (...args) => deps.runtime().dispatch(...args), listSessions: () => deps.runtime().listSessions(), cancelQueued: (...args) => deps.runtime().cancelQueued(...args), getSession: id => deps.runtime().getSession(id) },
      readBot: deps.readBot, fallbackAgentId: deps.fallbackAgentId, ...(deps.workItems ? { work: deps.workItems } : {}) }),
    cancel: async (sessionId, taskId) => {
      try { await deps.runtime().cancelQueued(sessionId, taskId, installationOwnerTaskActor); return true; }
      catch { return false; }
    },
    workStatus: workItemId => readWorkItemStatus(deps.repositories.config, workItemId),
    cancelWork: async (sessionId, workItemId) => deps.workItems ? cancelUnconfirmedWorkItem(deps.workItems(), sessionId, workItemId) : false,
    isSettled: taskId => {
      const status = deps.repositories.execution.getTaskExecution(taskId)?.task.status;
      return !status || ['completed', 'failed', 'interrupted', 'cancelled'].includes(status);
    },
    taskStatus: taskId => {
      const status = deps.repositories.execution.getTaskExecution(taskId)?.task.status;
      if (!status) return 'unknown';
      return status === 'completed' ? 'succeeded' : status === 'failed' ? 'failed' : status === 'cancelled' || status === 'interrupted' ? 'cancelled' : 'running';
    },
    runBindings: deps.repositories.ciWebhook,
    dedupe: { claim: (key, now, expiresAt) => deps.repositories.ciWebhook.claimEvent(key, now, expiresAt), release: (key, expiresAt) => deps.repositories.ciWebhook.releaseEvent(key, expiresAt) }
  });

  const deliverTriggerResult = async (session: Session, task: PublicTaskRecord) => {
    const attempt = deps.repositories.execution.getTaskExecution(task.id)?.attempts.find(item => item.number === 1);
    const read = attempt ? readTaskAttemptResult(deps.repositories, session.id, task.id, attempt.attemptId) : undefined;
    const message = triggerResultText(session, task, read?.status === 'settled' ? read.result.output.text : undefined);
    if (!message) return;
    if (!await hooks.notify({ ...sessionHookContext(session) }, 'trigger_result', { taskId: task.id, status: task.status, text: message.text })) return;
    const bot = await deps.readBot(message.appId);
    if (!bot?.appSecret) throw new Error(`机器人 ${message.appId} 凭证缺失，无法回投触发器结果`);
    await deps.sendText(bot, { chatId: message.chatId, text: message.text, idempotencyKey: message.idempotencyKey });
  };

  const runtimeOptions = {
    ...(hooks.has('permission.request') ? { reviewPermission: (session: Session, request: Parameters<PluginRuntimeHooks['reviewPermission']>[1]) => hooks.reviewPermission(session, request) } : {}),
    onTaskSettled: async (session: Session, task: PublicTaskRecord) => {
      triggers.settled(task.id, task.status === 'completed' ? 'succeeded' : task.status === 'failed' ? 'failed' : task.status === 'cancelled' || task.status === 'interrupted' ? 'cancelled' : 'unknown');
      await hooks.taskCompleted(session, task).catch(error => deps.log.warn({ error: String(error) }, '插件 task.completed hook 失败'));
      if (session.source === PLUGIN_TRIGGER_SOURCE) await deliverTriggerResult(session, task).catch(error => deps.log.warn({ taskId: task.id, error: error instanceof Error ? error.message : String(error) }, '插件触发器结果回投失败'));
    },
    ...(hooks.has('verification.completed') ? { onVerificationCompleted: (session: Session, result: Parameters<PluginRuntimeHooks['verificationCompleted']>[1]) => hooks.verificationCompleted(session, result) } : {})
  };

  const routes: PluginRouteOptions = { commands: host.commands, triggers };
  return { hooks, triggers, runtimeOptions, routes, dispose: async () => { for (const dispose of disposers) dispose(); await host.dispose(); } };
}
