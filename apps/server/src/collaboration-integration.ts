import { CollaborationDelivery } from './collaboration-delivery.js';
import { createHash } from 'node:crypto';
import { canonicalExecutionJson, installationOwnerTaskActor, RuntimeError, type CollaborationScope, type CollaborationSettings, type UpdateCollaborationSettingsInput, type PolicyAction, type RepositoryBundle, type ToolRiskPolicy } from '@dutydeck/shared';
import type { DutydeckRuntime } from '@dutydeck/runtime';
import { CollaborationService, type CollaborationAuthorization } from './collaboration-service.js';
import { ScheduleExecutor } from './schedule-executor.js';
import { CollaborationBackground } from './collaboration-background.js';
import { CollaborationExtensions } from './collaboration-extensions.js';
import { CollaborationEvaluation } from './collaboration-evaluation.js';
import { LarkGroupParticipation } from './lark/group-participation.js';
import { ReadonlyParticipationDecider } from './lark/readonly-decider.js';
import { larkExecutionConfirmed, readLarkConfig, type StoredLarkConfig } from './lark/config.js';
import type { LarkGroupManager } from './lark/group-management.js';
import { createLarkCardService, type LarkCardService } from './lark/service.js';

export interface CollaborationIntegrationOptions {
  repositories: RepositoryBundle;
  runtime: DutydeckRuntime;
  groups: LarkGroupManager;
  workspaceRoot: string;
  client?: (config: StoredLarkConfig) => LarkCardService;
  configureExtensions?: (extensions: CollaborationExtensions) => void;
  log?: { warn(details: unknown, message: string): void };
  listeningDisabled?: boolean;
  readMemory?(scope: CollaborationScope): Promise<string>;
}
export function createCollaborationIntegration(options: CollaborationIntegrationOptions) {
  const { repositories: stored, runtime, groups } = options;
  // Keep the saved group override distinct from the effective Bot default. All collaboration
  // consumers (including snapshots, bootstrap and management) use the same resolution.
  const effectiveSettings = async (settings: CollaborationSettings): Promise<CollaborationSettings> => settings.inheritParticipation
    ? { ...settings, participation: (await readLarkConfig(stored.config, settings.scope.appId))?.defaultGroupParticipation ?? 'off' }
    : settings;
  const repos: RepositoryBundle = { ...stored, collaboration: {
    ...stored.collaboration,
    getSettings: async scope => effectiveSettings(await stored.collaboration.getSettings(scope)),
    updateSettings: async (scope, patch, actor) => effectiveSettings(await stored.collaboration.updateSettings(scope, patch, actor)),
    snapshot: async (scope, limit) => {
      const snapshot = await stored.collaboration.snapshot(scope, limit);
      return { ...snapshot, settings: await effectiveSettings(snapshot.settings) };
    }
  } };
  const client = options.client ?? ((config: StoredLarkConfig) => createLarkCardService(process.env, globalThis.fetch, config));
  const known = async (scope: CollaborationScope) => {
    await groups.ensureParticipationGroup(scope.appId, scope.chatId);
    const config = await readLarkConfig(repos.config, scope.appId);
    const owner = await groups.owner(scope.appId);
    const binding = owner && await repos.groupBindings.getByNaturalKey(owner.channelBotId, scope.chatId);
    if (!config || !owner || !binding) throw new RuntimeError('COLLABORATION_GROUP_REQUIRED', '请先同步并配置此群。', 403);
    return { config, owner, binding };
  };
  const live = async (scope: CollaborationScope) => {
    const result = await known(scope);
    if (options.listeningDisabled || !result.config.listening || !larkExecutionConfirmed(result.config) || !result.owner.activeGroups.includes(result.binding.id) || result.binding.state !== 'staged') throw new RuntimeError('COLLABORATION_GROUP_INACTIVE', '此群的 Agent 接入当前不可用。', 403);
    return { ...result, config: await groups.resolved(result.config, scope.chatId) };
  };
  const policy = async (scope: CollaborationScope, actorId: string, action: PolicyAction) => {
    const owner = actorId === installationOwnerTaskActor;
    const result = await groups.authorize(scope.appId, scope.chatId, owner ? undefined : actorId, action, undefined, { installationOwner: owner });
    return result?.allowed === true;
  };
  const authorize: CollaborationAuthorization = async (scope, actorId, action) => {
    try {
      await known(scope);
      // Local management identity is resolved by the existing server auth boundary.
      if (actorId === installationOwnerTaskActor && ['read', 'write', 'manage'].includes(action)) return true;
      if (action === 'manage') return false;
      await live(scope);
      return policy(scope, actorId, action === 'read' ? 'group_tools.read' : action === 'deliver' ? 'group_tools.send' : 'task.create');
    } catch { return false; }
  };
  const scopeGrant = async (scope: CollaborationScope, action: 'observe' | 'deliver') => {
    try {
      const settings = await repos.collaboration.getSettings(scope);
      if (settings.participation === 'off' || (action === 'deliver' && settings.notificationsPaused)) return false;
      await live(scope);
      // The owner enabled participation either for this group or in the Bot defaults.
      return policy(scope, installationOwnerTaskActor, action === 'observe' ? 'group_tools.read' : 'group_tools.send');
    } catch { return false; }
  };
  const readConfig = async (appId: string, chatId?: string) => {
    const config = await readLarkConfig(repos.config, appId);
    if (!config || !chatId) return config;
    return groups.resolved(config, chatId);
  };
  const decider = new ReadonlyParticipationDecider({ runtime, repos: { execution: repos.execution }, workspaceRoot: options.workspaceRoot });
  const deliveries = new CollaborationDelivery(repos.collaboration);
  const participation = new LarkGroupParticipation({
    withDelivery: (scope, actionId, send) => deliveries.run(scope, actionId, send),
    repository: repos.collaboration, decider, readConfig, serviceFor: client, readMemory: options.readMemory,
    authorize: async (scope, actorId, action, followup) => {
      if (action === 'observe' || action === 'deliver') return scopeGrant(scope, action);
      if (!actorId || !followup || !await authorize(scope, actorId, 'write')) return false;
      return followup.createdBy === actorId || followup.ownerId === actorId || await authorize(scope, actorId, 'manage');
    },
    listScopes: async appId => {
      const config = await readLarkConfig(repos.config, appId);
      if (config?.listening && config.defaultGroupParticipation && config.defaultGroupParticipation !== 'off' && larkExecutionConfirmed(config)) {
        await groups.sync(appId);
      }
      const owner = await groups.owner(appId);
      if (!owner) return [];
      const bindings = await repos.groupBindings.listByChannelBot(owner.channelBotId);
      const discovered = config?.defaultGroupParticipation && config.defaultGroupParticipation !== 'off'
        ? await repos.remoteChatFacts.listByChannelBot(owner.channelBotId, 500) : [];
      return [...new Set([...bindings.map(binding => binding.externalChatId), ...discovered.filter(fact => fact.membershipState === 'member').map(fact => fact.externalChatId)])].map(chatId => ({ appId, chatId }));
    },
    readGroupDescription: async (scope, config) => {
      const metadata = await client(config).getChatPreflightInfo(scope.chatId);
      if (!metadata.name && !metadata.description) throw new Error('群名称与说明不可见。');
      return [metadata.name, metadata.description].filter(Boolean).join('\n');
    }
  });
  const service = new CollaborationService({ repositories: repos, authorize,
    resolveScheduleScope: async scope => {
      const { owner, binding } = await live(scope);
      const identity = await repos.remoteIdentityFacts.getCurrentByChannelBot(owner.channelBotId);
      if (!identity?.appIdMatch || identity.credentialRefId !== owner.credentialRefId) throw new RuntimeError('COLLABORATION_IDENTITY_REQUIRED', '群身份验证已过期，请重新同步群聊。', 403);
      return { channelBotId: owner.channelBotId, groupBindingId: binding.id, identityRef: identity.id, secretRef: owner.credentialRefId };
    },
    validateDelivery: async (scope, delivery) => {
      if (delivery.chatRef !== scope.chatId) return false;
      if (!delivery.rootMessageRef) return true;
      try { const { config } = await live(scope); return (await client(config).getMessage(delivery.rootMessageRef)).chatId === scope.chatId; }
      catch { return false; }
    }
  });
  const background = new CollaborationBackground({ repositories: repos, runtime, authorize, resolveConfig: async scope => (await live(scope)).config });
  const riskPolicy = async (sessionId: string, _fallback?: ToolRiskPolicy): Promise<{ policy?: ToolRiskPolicy } | undefined> => {
    const session = await runtime.getSession(sessionId);
    const [appId, chatId, kind, origin] = session?.sourceId?.split(':') ?? [];
    if (session?.source !== 'lark' || kind !== 'group' || origin !== 'collaboration' || !appId || !chatId) return;
    try {
      const context = await background.authorizeTool(sessionId, 'group_tools.read');
      if (!context) throw new Error('后台任务身份缺失。');
      const scope = { appId, chatId }, { config } = await live(scope);
      if (config.riskControlMode !== 'enforced') return { policy: undefined };
      const owner = context.actorId === installationOwnerTaskActor;
      const emails = !owner && config.highRiskAllowedEmails.length ? await client(config).getUserEmails(context.actorId) : [];
      const allowedByBot = owner || !config.highRiskAllowedUsers.length && !config.highRiskAllowedEmails.length
        || config.highRiskAllowedUsers.some(user => user.openId === context.actorId)
        || emails.some(email => config.highRiskAllowedEmails.includes(email));
      return { policy: { enabled: true, authorized: allowedByBot && await policy(scope, context.actorId, 'high_risk.execute'), pattern: config.highRiskPattern, reason: '委托发起人没有此高风险操作授权。' } };
    } catch {
      return { policy: { enabled: true, authorized: false, pattern: '.*', reason: '后台委托已变更或失去授权。' } };
    }
  };
  const scheduler = new ScheduleExecutor({ repositories: repos, service, authorize,
    executeAgent: input => background.execute(input), cancelAgent: input => background.cancel(input),
    deliver: async input => {
      const { config } = await live(input.scope);
      const delivery = input.schedule.delivery;
      if (!await service.options.validateDelivery!(input.scope, delivery)) throw new RuntimeError('COLLABORATION_DESTINATION_CONFLICT', '当前结果投递位置不属于授权群。', 403);
      return deliveries.run(input.scope, input.actionId, async () => {
      await input.assertCurrent();
      const idempotencyKey = createHash('sha256').update(input.actionId).digest('hex').slice(0, 32);
      const result = delivery.mode === 'thread' && delivery.rootMessageRef
        ? await client(config).replyText({ messageId: delivery.rootMessageRef, replyInThread: true, text: input.text, idempotencyKey })
        : await client(config).sendText({ chatId: input.scope.chatId, text: input.text, idempotencyKey });
      return { receipt: result.messageId };
      });
    }
  });
  const extensions = new CollaborationExtensions({ repository: repos.collaboration,
    authorize: (scope, actorId, action) => authorize(scope, actorId, action === 'query' ? 'read' : action === 'action' ? 'execute' : 'write'),
    onObservation: async snapshot => { await scheduler.tick(); }
  });
  options.configureExtensions?.(extensions);
  const policyKey = (scope: CollaborationScope, version: string) => `collaboration.policy.${createHash('sha256').update(canonicalExecutionJson([scope, version])).digest('hex')}`;
  const prepareSettings = async (scope: CollaborationScope, patch: UpdateCollaborationSettingsInput) => {
    const current = await repos.collaboration.getSettings(scope);
    if (current.revision !== patch.expectedRevision) throw new RuntimeError('COLLABORATION_REVISION_CONFLICT', '群设置已变化，请重新加载。', 409);
    const instructions = patch.instructions ?? current.instructions;
    const version = patch.policyVersion ?? (instructions !== current.instructions ? `revision-${current.revision + 1}` : current.policyVersion);
    const key = policyKey(scope, version), value = canonicalExecutionJson({ version, instructions });
    const existing = await repos.config.get(key);
    if (existing !== undefined && existing !== value) throw new RuntimeError('COLLABORATION_POLICY_VERSION_CONFLICT', '同一策略版本不能对应不同指令，请使用新版本。', 409);
    if (existing === undefined && !await repos.config.compareAndSet?.(key, undefined, value) && await repos.config.get(key) !== value) throw new RuntimeError('COLLABORATION_POLICY_VERSION_CONFLICT', '策略版本已被其他修改占用。', 409);
    return { ...patch, policyVersion: version };
  };
  const evaluation = new CollaborationEvaluation({ repository: repos.collaboration,
    evaluate: async (snapshot, version) => {
      const config = await readConfig(snapshot.scope.appId, snapshot.scope.chatId);
      if (!config) throw new RuntimeError('COLLABORATION_REPLAY_UNAVAILABLE', '原 Agent 配置已不可用。', 409);
      let instructions = snapshot.settings.instructions;
      if (version !== snapshot.settings.policyVersion) {
        const saved = await repos.config.get(policyKey(snapshot.scope, version));
        if (!saved) throw new RuntimeError('COLLABORATION_POLICY_MISSING', '没有此版本的完整策略快照。', 409);
        instructions = (JSON.parse(saved) as { instructions: string }).instructions;
      }
      return decider.resolve(config, { ...snapshot, settings: { ...snapshot.settings, policyVersion: version, instructions } });
    }
  });
  return { service, scheduler, background, participation, extensions, evaluation, authorize, prepareSettings, riskPolicy,
    onChange: async (scope: CollaborationScope) => {
      void participation.bootstrap(scope).catch(error => options.log?.warn({ error }, '群上下文初始化未完成'));
      await scheduler.tick();
    },
    async prune() {
      for (const bot of await repos.channelBots.list()) {
        const owner = await groups.owner(bot.externalAppId); if (!owner) continue;
        for (const binding of await repos.groupBindings.listByChannelBot(owner.channelBotId)) {
          const scope = { appId: bot.externalAppId, chatId: binding.externalChatId };
          const settings = await repos.collaboration.getSettings(scope);
          await repos.collaboration.pruneObservations(new Date(Date.now() - settings.retentionDays * 86_400_000).toISOString(), scope);
        }
      }
    },
    async close() {
      const settled = await Promise.allSettled([scheduler.close(), participation.close()]);
      const errors = settled.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason);
      if (errors.length) throw new AggregateError(errors, 'Collaboration shutdown failed');
    }
  };
}
