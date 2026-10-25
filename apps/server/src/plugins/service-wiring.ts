import { dirname } from 'node:path';
import { resolveDatabaseUrl } from '@dutydeck/config';
import { installationOwnerTaskActor, type CiWebhookRepository, type ExecutionRepository, type PublicTaskRecord, type Session } from '@dutydeck/shared';
import type { DutydeckRuntime } from '@dutydeck/runtime';
import { readTaskAttemptResult } from '../task-results.js';
import { setPluginSkillRoots } from '../skill-catalog.js';
import { setLarkPluginCommands } from '../lark/plugin-commands.js';
import { PluginHost } from './host.js';
import { createTriggerDispatcher, PLUGIN_TRIGGER_SOURCE, PluginRuntimeHooks, sessionHookContext, triggerResultText, type TriggerBot } from './integration.js';
import type { PluginRouteOptions } from './routes.js';
import type { ScenarioRegistry } from './scenario-registry.js';
import { PluginTriggerService } from './triggers.js';

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

export interface PluginWiringDeps {
  runtime: () => DutydeckRuntime;
  repositories: { execution: Pick<ExecutionRepository, 'getTaskExecution' | 'getAttemptEvents' | 'getAcceptedTask'>; ciWebhook: Pick<CiWebhookRepository, 'claimEvent' | 'releaseEvent'> };
  readBot(appId: string): Promise<(TriggerBot & { appSecret?: string }) | undefined>;
  fallbackAgentId(): string | undefined;
  sendText(bot: TriggerBot & { appSecret?: string }, input: { chatId: string; text: string; idempotencyKey: string }): Promise<unknown>;
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
    setLarkPluginCommands(host.commands)
  ];
  const triggers = new PluginTriggerService({
    lookup: (plugin, id) => host.trigger(plugin, id),
    token: (plugin, id) => host.triggerToken(plugin, id),
    deliver: createTriggerDispatcher({ runtime: { start: input => deps.runtime().start(input), dispatch: (...args) => deps.runtime().dispatch(...args), listSessions: () => deps.runtime().listSessions(), cancelQueued: (...args) => deps.runtime().cancelQueued(...args) },
      readBot: deps.readBot, fallbackAgentId: deps.fallbackAgentId }),
    cancel: async (sessionId, taskId) => {
      try { await deps.runtime().cancelQueued(sessionId, taskId, installationOwnerTaskActor); return true; }
      catch { return false; }
    },
    isSettled: taskId => {
      const status = deps.repositories.execution.getTaskExecution(taskId)?.task.status;
      return !status || ['completed', 'failed', 'interrupted', 'cancelled'].includes(status);
    },
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
