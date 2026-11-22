import { PluginHost } from '../plugins/host.js';
import { DutydeckRuntime } from '@dutydeck/runtime';
import { parseLarkSourceId, timeLoop } from '@dutydeck/shared';
import { WorkItemService, readWorkItemStatus } from '../work-items.js';
import { createWorkbenchFetch } from '../workbench-fetch.js';
import { SessionAutomationService } from '../session-automation.js';
import { createAutomationIntegration } from '../automation-integration.js';
import { CiWebhookService } from '../ci-webhook.js';
import { PullRequestService } from '../pull-requests.js';
import { CiProviderRegistry } from '../ci-providers.js';
import { wirePlugins } from '../plugins/service-wiring.js';
import { sessionHookContext } from '../plugins/integration.js';
import type { ComposeContext } from './context.js';
import type { LarkGroupManager } from '../lark/group-management.js';

export function composeAutomation({ repos, env, log, lifecycle, channel }: ComposeContext,
  runtime: DutydeckRuntime, groupManager: LarkGroupManager, workbenchHttp: ReturnType<typeof createWorkbenchFetch>,
  pluginHost: PluginHost | undefined, pluginWiring: ReturnType<typeof wirePlugins> | undefined, ports: {
    workItems(): WorkItemService;
    awaitingAnswer(id: string): boolean;
    mandateCards: NonNullable<SessionAutomationService['mandateCards']>;
  }) {
  const { createLarkCardService, readLarkConfig } = channel;
  const loopLog = { warn: (details: Record<string, unknown>, message: string) => log.warn(details, message) };
  const automationIntegration = createAutomationIntegration(repos, runtime, groupManager, { env, client: config => createLarkCardService(env, workbenchHttp.fetch, config), log: { warn: (...args: unknown[]) => log.warn(...args as [unknown, string]) } });
  // CI 平台全部来自插件；没有 CI 插件时注册表为空，/ci 与 Web 提示「未安装 CI 插件」。
  const ciProviders = pluginHost?.ciProviders ?? new CiProviderRegistry();
  // 插件 notify hook 拒绝时不发这条 CI 通知。
  const notifyCi: typeof automationIntegration.notify = pluginWiring?.hooks.has('notify')
    ? async (sessionId, sourceId, notice) => {
      const session = await runtime.getSession(sessionId);
      if (session && !await pluginWiring.hooks.notify(sessionHookContext(session), 'ci_notice', { title: notice.title, text: notice.markdown, failed: notice.failed === true })) return undefined;
      return automationIntegration.notify(sessionId, sourceId, notice);
    }
    : automationIntegration.notify;
  const pullRequests = new PullRequestService({ repositories: repos, runtime, providers: ciProviders, prepareDelivery: automationIntegration.prepareDelivery, notify: notifyCi,
    // 修复轮推送前的验证命令取会话所属机器人的 verificationCommand；非飞书会话、没配的机器人照旧直接推送。
    verificationCommand: async sessionId => {
      const session = await runtime.getSession(sessionId);
      const { appId } = parseLarkSourceId(session?.source === 'lark' ? session.sourceId : undefined);
      return appId ? (await readLarkConfig(repos.config, appId))?.verificationCommand?.trim() || undefined : undefined;
    },
    log: { warn: (...args: unknown[]) => log.warn(...args as [unknown, string]) } });
  const ciWebhook = ciProviders.list().some(({ provider }) => provider.webhook) ? new CiWebhookService({ repositories: repos, runtime, providers: ciProviders, onEvent: (providerId, event) => pullRequests.onWebhookEvent(providerId, event),
    prepareDelivery: automationIntegration.prepareDelivery, notify: notifyCi, log: { warn: (...args: unknown[]) => log.warn(...args as [unknown, string]) } }) : undefined;
  const automation = new SessionAutomationService({ repositories: repos, runtime, ...automationIntegration, ciProviders, pullRequests, ...(ciWebhook ? { ciWebhook } : {}),
    // 工作项服务与提问代理在下方创建；这里只在运行时调用。
    awaitingHuman: sessionId => runtime.getPendingPermissions(sessionId).length > 0 || ports.awaitingAnswer(sessionId),
    workTemplates: {
      list: (sessionId, actorId) => ports.workItems().listTemplates(sessionId, actorId),
      // 定时启动的工作项不归属父会话此刻正在跑的那一轮。
      run: (sessionId, templateId, version, goal, key, actorId, admissionChecks) => ports.workItems().runTemplate(sessionId, templateId, version, goal, key, actorId, undefined, true, admissionChecks),
      // 失败但带待确认修订的工作项还没结束，上一次没结束时不启动新的。
      progress: async id => await ports.workItems().exists(id) ? readWorkItemStatus(repos.config, id) ?? 'unknown' : undefined
    },
    log: { warn: (details, message) => log.warn(details, message) } }, ports.mandateCards);
  lifecycle.register('automation', () => automation.close());
  if (ciWebhook) lifecycle.register('ciWebhook', () => ciWebhook.close());
  lifecycle.register('pullRequests', () => pullRequests.close());
  let timer: NodeJS.Timeout | undefined;
  lifecycle.beforeStop('automation', () => clearInterval(timer));
  const start = () => {
    const tick = () => {
      void timeLoop('automation.tick', loopLog, () => automation.tick()).catch(error => log.warn({ error }, '自动任务轮询失败'));
      if (ciWebhook) void timeLoop('ci-webhook.tick', loopLog, () => ciWebhook.tick()).catch(error => log.warn({ error }, 'CI webhook 续作轮询失败'));
      void timeLoop('pull-requests.tick', loopLog, () => pullRequests.tick()).catch(error => log.warn({ error }, 'PR 跟进轮询失败'));
    };
    // Only the acceptance test that drives a plan through this real timer shortens the interval.
    timer = setInterval(tick, Number(env.DUTYDECK_AUTOMATION_TICK_MS) || 60_000);
    timer.unref();
    tick();
  };
  return { automation, automationIntegration, ciWebhook, pullRequests, start: { automation: start } };
}
