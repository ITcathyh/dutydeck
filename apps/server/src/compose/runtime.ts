import { MattersService } from '../matters.js';
import { ProjectMemoryService } from '../project-memory.js';
import { prepareBoundTaskPrompt } from '../plugins/bound-skills.js';
import { PluginHost } from '../plugins/host.js';
import { AgentModelSettings } from '../agent-model-settings.js';
import { HerdrBackend } from '@dutydeck/session-backends';
import { TerminalSettings, primaryHerdrBinary } from '../terminal-settings.js';
import { HerdrSessions } from '../herdr.js';
import { createCollaborationIntegration } from '../collaboration-integration.js';
import { isAutomatedRequest } from '../agent-request-tools.js';
import { WorkspaceApprovals } from '../workspace-approvals.js';
import { LeaderDelegationService } from '../leader-delegation.js';
import { createAcceptPrompt, DutydeckRuntime, RuntimeEventBus } from '@dutydeck/runtime';
import { childProcessIdentity, observeProcess } from '@dutydeck/storage';
import { defaultDriverProviders } from '../driver-providers.js';
import { channelExecutionAppId, dutydeckSessionKinds, renderSessionNotice, backgroundKindFor, COLLABORATION_LIST_LIMIT, RuntimeError, type Session } from '@dutydeck/shared';
import { dirname, join } from 'node:path';
import { WorkItemService } from '../work-items.js';
import { createWorkbenchFetch } from '../workbench-fetch.js';
import { capturedRiskPolicy, workItemRiskPolicy } from '../work-item-policy.js';
import { SessionAutomationService } from '../session-automation.js';
import { CiWebhookService } from '../ci-webhook.js';
import { PullRequestService } from '../pull-requests.js';
import { prepareSkillPrompt, type PrepareSkillPromptResult } from '../skill-delivery.js';
import { readTokenEfficiencyPolicy } from '../token-efficiency.js';
import { createSessionPrompt } from '../prompt/session.js';
import { isFrozenCollaborationSession, promptTemplateVersion } from '../prompt-context.js';
import { TurnAuthority } from '../agent-host/turn-authority.js';
import { createTurnDiffObserver } from '../turn-diff.js';
import { createPtyCliProvider } from '@dutydeck/pty-driver';
import { RelayCapabilityRegistry } from '@dutydeck/relay';
import { parseUsageBackgroundLimits, parseUsagePricing, UsageLedger, withExtraPricing } from '../usage-ledger.js';
import { wirePlugins } from '../plugins/service-wiring.js';
import type { ComposeContext } from './context.js';
import type { LarkGroupManager } from '../lark/group-management.js';
import type { LarkAgentToolsService } from '../lark/agent-tools.js';

/** A first terminal may exit with a partial draft before Claude creates its transcript. */
export function claudeResumeSource(repos: ComposeContext['repos'], sessionId: string) {
  const history = repos.insight.listSources(sessionId).filter(source => source.client === 'claude');
  const latest = history.filter(source => source.proofKind === 'launch_observed' && source.identityProof?.startsWith('pty-claude-process-v1:')).at(-1);
  if (latest?.identityProof !== 'pty-claude-process-v1:pending' || history.some(source =>
    source.proofKind !== 'launch_observed' || source.launchKind !== 'created' || source.cwd !== latest.cwd || source.dataRoot !== latest.dataRoot || source.nativeSessionId || source.verifiedPath
    || source.identityProof && source.identityProof !== latest.identityProof)) return latest;

  const retired = repos.execution.getResources(sessionId).filter(resource => resource.kind === 'local_only' && resource.observations.at(-1)?.state === 'gone');
  if (!history.every(source => retired.some(resource => resource.resourceId === source.driverInstanceId && resource.runId === source.activeRunId))) return latest;
  const empty = repos.execution.getSessionExecutions(sessionId).every(({ task, attempts, steering }) =>
    task.digestVersion === 'v1' && !steering && attempts.every(attempt => attempt.submissionState === 'not_submitted'
      || attempt.settlement?.kind === 'not_submitted'
      || attempt.submissionState === 'intent_recorded' && attempt.reconcileReason?.code === 'DRIVER_INPUT_UNCONFIRMED'
        // Lark's quiet-turn recovery settles these as interrupted and promises the next message continues.
        && attempt.settlement?.kind === 'manual' && (attempt.settlement.decision.action === 'retry' || attempt.settlement.outcome === 'failed' || attempt.settlement.outcome === 'interrupted')));
  return empty ? { ...latest, emptyInitialLaunch: true as const } : latest;
}

export function composeDrivers({ config, repos, env, log }: ComposeContext, herdr: HerdrSessions) {
  const primaryHerdrBackend = (sessionId: string) => new HerdrBackend(herdr.nameFor(`primary:${sessionId}`), {
    binary: primaryHerdrBinary(env), stateFile: join(dirname(config.databaseUrl), 'terminal-sessions', `${herdr.nameFor(`primary:${sessionId}`)}.json`),
    ownerId: `dutydeck:${sessionId}`, processProbe: { identify: childProcessIdentity, observe: observeProcess }, env, log,
  });
  const terminalSettings = new TerminalSettings(repos.config, env);
  const ptyProvider = createPtyCliProvider({
    herdrBackend: primaryHerdrBackend,
    claudeResumeSource: sessionId => claudeResumeSource(repos, sessionId),
  });
  return { terminalSettings, ptyProvider };
}

interface RuntimeDependencies {
  drivers: ReturnType<typeof composeDrivers>;
  pluginHost?: PluginHost;
  pluginWiring?: ReturnType<typeof wirePlugins>;
  groupManager: LarkGroupManager;
  workbenchHttp: ReturnType<typeof createWorkbenchFetch>;
  capabilities: TurnAuthority;
  relayCapabilities: RelayCapabilityRegistry;
  herdr: HerdrSessions;
  agentTools: LarkAgentToolsService;
  agentModelSettings: AgentModelSettings;
  isAutomatedTask: (id: string) => boolean;
}

// The runtime calls these ports during recovery or a turn, after their owning
// services have been constructed with this runtime.
interface RuntimePorts {
  workItems(): WorkItemService;
  delegations(): LeaderDelegationService;
  collaboration(): ReturnType<typeof createCollaborationIntegration>;
  schedules(): { automation: SessionAutomationService; ciWebhook?: CiWebhookService; pullRequests: PullRequestService };
  awaitingAnswer(id: string): boolean;
}

export function composeRuntime({ config, repos, env, log, options, channel, lifecycle }: ComposeContext,
  deps: RuntimeDependencies, ports: RuntimePorts) {
  const { pluginHost, pluginWiring, groupManager, workbenchHttp, capabilities, relayCapabilities, herdr,
    agentTools, agentModelSettings, isAutomatedTask, drivers: { terminalSettings, ptyProvider } } = deps;
  const { readLarkConfigs, readLarkConfig, createLarkCardService, withClaudeAutoMemoryMarker, deliverLarkSessionNotice } = channel;
  // 用量账本：runtime 每轮交来读数、派发新任务前查月度上限。子步骤的根任务取自下方的工作项与 Leader 委托。
  const usageLedger = new UsageLedger({
    repositories: repos,
    pricing: withExtraPricing(parseUsagePricing(env.DUTYDECK_USAGE_PRICING_JSON), env.DUTYDECK_USAGE_PRICING_EXTRA_JSON),
    backgroundLimits: parseUsageBackgroundLimits(env.DUTYDECK_USAGE_BACKGROUND_LIMITS_JSON),
    parentOf: async session => {
      const binding = session.source === 'work_item' ? await ports.workItems().parentForSession(session.id) : await ports.delegations().parentForSession(session.id);
      return binding ? { parentSessionId: binding.parentSessionId, ...(binding.parentTaskId ? { parentTaskId: binding.parentTaskId } : {}) } : undefined;
    },
    isProactive: async (appId, chatId, messageId) => (await repos.collaboration.listActions({ appId, chatId }, COLLABORATION_LIST_LIMIT))
      .some(action => action.kind === 'participation.dispatch' && action.payload.messageId === messageId),
    notify: async (target, text, idempotencyKey) => {
      const bot = (await readLarkConfigs(repos.config)).find(entry => entry.appId === target.appId);
      if (!bot?.appSecret) throw new Error('机器人凭证缺失，无法发送用量提醒');
      await createLarkCardService(env, workbenchHttp.fetch, bot).sendText({ chatId: target.chatId, text, idempotencyKey });
    },
    log: { warn: (details, message) => log.warn(details, message) }
  });
  const projectMemory = new ProjectMemoryService(repos.config, async id => {
    const session = await repos.sessions.get(id);
    if (!session) throw new RuntimeError('SESSION_NOT_FOUND', '会话不存在。', 404);
    return session;
  });
  const matters = new MattersService(repos);
  // 只认飞书用户亲自发起的轮次：定时、自动化、CI/PR 触发的不按工作区规则放行。
  const workspaceApprovals = repos.workspaceApprovalRules ? new WorkspaceApprovals({
    rules: repos.workspaceApprovalRules,
    getSession: id => repos.sessions.get(id),
    humanRequester: taskId => {
      const request = repos.execution.getAcceptedTask(taskId)?.request;
      return request && !isAutomatedRequest(request) && request.actor.kind === 'channel' ? request.actor.id : undefined;
    }
  }) : undefined;
  // claudeAutoMemory 的会话标记要读机器人配置（异步），所以放在这里而不是同步的 sessionEnvironment。
  const sessionAgentConfig = async (agent: import('@dutydeck/shared').AgentConfig, session: Session) => withClaudeAutoMemoryMarker(
    await agentModelSettings.resolveForSession(agent, session, async id => await ports.workItems().parentForSession(id) ?? await ports.delegations().parentForSession(id)),
    session, appId => readLarkConfig(repos.config, appId, { readOnly: true }));
  const events = new RuntimeEventBus();
  const observeTurn = createTurnDiffObserver(repos.config, { log: { warn: (details, message) => log.warn(details, message) } });
  events.subscribe('host', event => {
    switch (event.type) {
      case 'matter.session': return matters.session(event.sessionId, event.input);
      case 'task.accepted': return matters.accepted(event.session, event.task);
      case 'turn.started': return observeTurn(event.session, event.taskId, 'start');
      case 'usage.reading': return usageLedger.record(event.session, event.attempt, event.reading);
      case 'notice': return deliverLarkSessionNotice(repos, bot => createLarkCardService(env, workbenchHttp.fetch, bot), event.session, event.notice, log);
    }
  });
  if (pluginWiring) events.subscribe('plugin', pluginWiring.onRuntimeEvent);
  const runtime: DutydeckRuntime = new DutydeckRuntime(repos, {
    providers: defaultDriverProviders(ptyProvider),
    events, beforeSettlement: (session, taskId) => observeTurn(session, taskId, 'end'),
    matterSummary: id => matters.summary(id),
    sessionKinds: dutydeckSessionKinds, renderNotice: renderSessionNotice,
    launchContext: {
      configureAgent: sessionAgentConfig, acpxCommand: config.acpxCommand,
      terminalBackend: () => terminalSettings.current(),
      environment: session => backgroundKindFor(session.source)?.injectHost === false ? {} : ({ ...capabilities.environmentFor(session), ...relayCapabilities.environmentFor(session.id), ...herdr.environmentFor(session.id),
        ...(session.protocol === 'pty-cli' && isFrozenCollaborationSession(session) ? { dutydeck_frozen_materials: 'true' } : {}) }),
    },
    executionPolicy: {
      channelAppId: channelExecutionAppId,
      admit: async (session, request) => {
        await usageLedger.admit(session, request);
        await pluginWiring?.hooks.taskReceived(session, request);
      },
      reviewPermission: pluginWiring?.reviewPermission,
      authorize: async request => {
        if (request.phase === 'start') {
          const { sessionId, actorId } = request;
          if (await ports.schedules().automation.authorizeExecutionSession(sessionId, actorId)) return;
          if (await ports.collaboration().background.authorizeExecution(sessionId, actorId)) return;
          // work item 授权先行判断并自行短路；其余会话把 prepareTurn 返回的可选本地提交
          // 交回 Runtime，由其短写序列在归属校验后执行（prepare 不写运行身份）。
          if (await ports.workItems().authorizeExecution(sessionId, actorId)) return;
          return groupManager.prepareTurn(sessionId, actorId);
        }
        if (request.phase === 'control') {
          const { sessionId, actor } = request;
          if (await ports.workItems().authorizeControl(sessionId, actor)) return;
          if (await ports.collaboration().background.authorizeControl(sessionId, actor)) return;
          if (actor.kind !== 'installation_owner' && actor.kind !== 'unspecified') await groupManager.prepareTurn(sessionId, actor.id);
          return;
        }
        const { session, task, phase } = request;
        await ports.collaboration().background.authorizeTask(session, task);
        await ports.schedules().automation.authorizeTask(task, phase);
        await ports.schedules().ciWebhook?.authorizeTask(task, phase);
        await ports.schedules().pullRequests.authorizeTask(task, phase);
        await ports.workItems().authorizeTask(session, task, phase);
      },
      riskPolicy: async (sessionId, fallback) => {
        const scheduleSource = await ports.schedules().automation.sourceSessionId(sessionId);
        if (scheduleSource) return groupManager.riskPolicy(scheduleSource, fallback);
        const background = await ports.collaboration().riskPolicy(sessionId, fallback);
        if (background) return background.policy;
        const binding = await ports.workItems().parentForSession(sessionId) ?? await ports.delegations().parentForSession(sessionId);
        if (binding) return workItemRiskPolicy(repos, groupManager, binding.parentSessionId, binding.actorId, fallback, env, workbenchHttp.fetch, capturedRiskPolicy(repos, binding.parentTaskId));
        const active = runtime.getActiveTaskContext(sessionId);
        if (!active?.attemptId) return groupManager.riskPolicy(sessionId, fallback);
        const session = await repos.sessions.get(sessionId);
        if (session?.source !== 'lark') return groupManager.riskPolicy(sessionId, fallback);
        const host = capabilities.environmentFor(session);
        return groupManager.riskPolicy(sessionId, fallback, { ...active, token: capabilities.finalTurnToken(sessionId, active.taskId, active.attemptId),
          command: host.dutydeck_group_tools_command!, url: host.dutydeck_group_tools_url! });
      },
    },
    promptAssembler: {
      atAccept: createAcceptPrompt(async session => {
        const parent = await ports.workItems().parentForSession(session.id) ?? await ports.delegations().parentForSession(session.id);
        if (parent?.parentTaskId) {
          const task = repos.execution.getAcceptedTask(parent.parentTaskId)?.task;
          return { version: task?.executionContext?.promptPolicyVersion ?? 'legacy-v1' };
        }
        const policy = await readTokenEfficiencyPolicy(repos.config);
        return { version: promptTemplateVersion(policy.mode), ...(policy.diagnosticReason ? { diagnosticReason: policy.diagnosticReason } : {}) };
      }, async (session, prompt, skills, context) => {
        if (backgroundKindFor(session.source)?.injectHost === false) {
          const prepared: PrepareSkillPromptResult = { agentPrompt: prompt, skillDeliveries: [], ...(context?.promptParts ? { promptParts: context.promptParts } : {}) };
          return pluginWiring ? pluginWiring.hooks.beforeRun(session, prepared, context?.promptPolicyVersion) : prepared;
        }
        return pluginWiring ? prepareBoundTaskPrompt(pluginHost!, pluginWiring.hooks, session, prompt, skills, context)
          : prepareSkillPrompt(session.cwd, prompt, skills, context);
      }),
      atExecute: createSessionPrompt({
        channelTools: (session, active) => agentTools.toolPromptContributor(session, { active }),
        plugins: pluginHost, tokens: capabilities, isAutomatedTask, command: options.groupToolsCommand ?? 'dutydeck',
        projectMemory, scheduleResult: session => ports.schedules().automation.resultContext(session), herdr
      }),
    },
    driverIdleTimeoutMs: config.driverIdleTimeoutMs,
    driverIdleCpuAction: config.driverIdleCpuAction,
    cleanupIntervalMs: config.cleanupIntervalMs,
    awaitingAnswer: ports.awaitingAnswer,
    log: { warn: (...args: unknown[]) => log.warn(...args as [unknown, string]), info: (data, message) => log.info(data, message) }
  });
  lifecycle.register('runtime', () => runtime.shutdown());
  return { runtime, sessionAgentConfig, usageLedger, workspaceApprovals, projectMemory };
}
