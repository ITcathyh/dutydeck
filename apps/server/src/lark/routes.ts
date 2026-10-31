import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { createWorkbenchFetch } from '../workbench-fetch.js';
import type { LarkGroupParticipation } from './group-participation.js';
import { LarkAppCreationJobManager } from './app-creation.js';
import { registerLarkAppCreationRoutes } from './app-creation-routes.js';
import type { RelayAskBroker } from '@dutydeck/relay';
import { registerLarkGroupManagementRoutes, type LarkGroupManager } from './group-management.js';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { agentWeightsSchema, validateHighRiskPattern, type AgentRepository, type ChannelMappingRepository, type ConfigRepository, type PolicyAction, type PolicyDecision } from '@dutydeck/shared';
import type { DutydeckRuntime } from '@dutydeck/runtime';
import { createLarkCardService, LarkServiceError, larkConfigurationStatus, type LarkBotConfigInput, type LarkCardService, type LarkSendInput, type LarkUpdateInput } from './service.js';
import { detectUnusableOwnerEntries, type ContactLookup } from './owner-identity.js';
import { defaultHighRiskPattern, deleteLarkConfig, larkExecutionConfirmed, larkMemoryEnabled, publicLarkConfigs, readLarkConfig, readLarkConfigs, resolveRiskControlModeInput, saveLarkConfig, type SaveLarkConfigInput } from './config.js';
import { LarkLongConnectionListenerPool, type LarkListenerPool } from './listener.js';
import { installLarkHook, larkHookStatus } from './security-hooks.js';
import { registerLarkAgentToolRoutes } from './agent-tools-routes.js';
import type { LarkAgentToolsService } from './agent-tools.js';
import { larkMemoryErrorLabel, type LarkMemoryStore } from './memory.js';
import type { LarkMemoryPipeline } from './memory-pipeline.js';
import { OpenPlatformConfigurationJobManager } from './open-platform-jobs.js';
import { isValidLarkAppId, larkSlashCommandDefinitions } from './open-platform-configurator.js';
import type { LoginLinkStore } from '../auth/auth.js';

type LarkSendRequest = LarkSendInput & { bot?: LarkBotConfigInput; botAppId?: string };
type LarkUpdateRequest = LarkUpdateInput & { bot?: LarkBotConfigInput; botAppId?: string };
const hookDraftSchema = z.object({ workspace: z.string().optional(), defaultAgentId: z.string().optional(), fallbackAgentId: z.string().optional(), defaultAgentWeights: agentWeightsSchema.optional() }).strict();
export type LarkHookDraft = z.infer<typeof hookDraftSchema>;
export type SaveLarkConfigRequest = SaveLarkConfigInput & { allowedUserNames?: string[]; allowedBotNames?: string[]; highRiskAllowedUserNames?: string[] };

/** LarkServiceError 按其状态码回给调用方，其他错误原样抛出。 */
const larkError = (reply: FastifyReply, error: unknown) => {
  if (error instanceof LarkServiceError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
  throw error;
};

export interface LarkRoutesOptions {
  scheduleRequests?: import('../agent-schedule-request.js').LarkScheduleRequests;
  clearBotModelSettings?: (appId: string) => Promise<void>;
  renameBotModelSettings?: (oldAppId: string, newAppId: string) => Promise<void>;
  participation?: LarkGroupParticipation;
  usage?: import('../usage-ledger.js').UsageLedger;
  workbench?: import('./workbench.js').LarkWorkbench;
  automation?: import('../session-automation.js').SessionAutomationService;
  relayBroker?: RelayAskBroker;
  groupManager?: LarkGroupManager;
  env?: NodeJS.ProcessEnv;
  service?: LarkCardService;
  config?: ConfigRepository;
  resourceRoot?: string;
  agents?: AgentRepository;
  cardMappings?: ChannelMappingRepository;
  fetcher?: typeof globalThis.fetch;
  listener?: LarkListenerPool;
  runtime?: DutydeckRuntime;
  listeningDisabled?: boolean;
  agentTools?: LarkAgentToolsService;
  appCreationJobs?: Pick<LarkAppCreationJobManager, 'start' | 'get' | 'cancel' | 'retry'>;
  openPlatformJobs?: Pick<OpenPlatformConfigurationJobManager, 'start' | 'get'>;
  memory?: {
    store: LarkMemoryStore;
    pipeline?: LarkMemoryPipeline;
  };
  /** StoredLarkConfig is the isolated legacy path during the compatibility period. */
  executionPolicy?: {
    integrationMode: 'legacy_unmanaged';
    authorize(boundary: 'listener' | 'session' | 'high_risk', action: PolicyAction): Promise<PolicyDecision>;
  };
  /** Web 要求登录时由服务端注入，卡片「查看详情」据此改为私信一次性登录链接。 */
  loginLinks?: LoginLinkStore;
}

export async function registerLarkRoutes(app: FastifyInstance, options: LarkRoutesOptions = {}) {
  const env = options.env ?? process.env;
  const http = createWorkbenchFetch(options.fetcher);
  const fetcher = http.fetch;
  // Abort before Fastify waits for active requests; onClose would be too late.
  app.addHook('preClose', async () => { http.close(); options.service?.close?.(); });
  const openPlatformJobs = options.openPlatformJobs ?? new OpenPlatformConfigurationJobManager({
    syncSlashCommands: async appId => {
      const saved = await readLarkConfig(options.config, appId);
      if (!saved?.appSecret) return 'skipped_credentials';
      await createLarkCardService(env, fetcher, saved)
        .syncSlashCommands(larkSlashCommandDefinitions());
    }
  });
  let service = options.service;
  let serviceKey: string | undefined;
  const listeningDisabled = options.listeningDisabled === true;
  const listener: LarkListenerPool = options.listener ?? new LarkLongConnectionListenerPool(app.log, {
    runtime: options.runtime,
    participation: options.participation,
    usage: options.usage,
    automation: options.automation,
    workbench: options.workbench,
    workflowStore: options.config,
    resourceRoot: options.resourceRoot,
    relayBroker: options.relayBroker,
    cardMappings: options.cardMappings,
    env,
    fetcher,
    executionPolicy: options.executionPolicy,
    groupManager: options.groupManager,
    memory: options.memory,
    loginLinks: options.loginLinks,
    agentCommands: options.agentTools?.commands,
    saveBotConfig: input => saveBotConfig(input),
    scheduleRequests: options.scheduleRequests,
    peerBotAuthorized: (appId, chatId, senderOpenId) => options.agentTools?.isConfiguredPeer(appId, chatId, senderOpenId) ?? Promise.resolve(false)
  });
  let listenerSyncTail: Promise<void> = Promise.resolve();
  const syncListeners = () => {
    // 每次同步时再读当前配置。连不上的机器人由连接池按退避自动重连，直到被下一次同步取代。
    const synced = listenerSyncTail.then(async () => {
      try { await listener.sync(await readLarkConfigs(options.config)); }
      catch (error) { app.log.error({ error }, '飞书消息监听连接失败，已保留监听配置，稍后自动重连'); }
    });
    listenerSyncTail = synced.catch(() => {});
    return synced;
  };
  const storedBot = async (appId?: string) => {
    const stored = await readLarkConfig(options.config, appId);
    return stored ? { appId: stored.appId, appSecret: stored.appSecret, brand: stored.brand, showAgentName: stored.showAgentName } : undefined;
  };
  const resolveService = async (bot?: LarkBotConfigInput, appId?: string) => {
    if (bot) return createLarkCardService(env, fetcher, bot);
    if (appId) {
      const stored = await storedBot(appId);
      if (!stored) throw new LarkServiceError('LARK_BOT_NOT_FOUND', `Unknown Lark bot: ${appId}`, 404);
      return createLarkCardService(env, fetcher, stored);
    }
    if (options.service) return options.service;
    const stored = await storedBot();
    const key = JSON.stringify([stored?.appId ?? env.LARK_APP_ID, stored?.appSecret ?? env.LARK_APP_SECRET, larkConfigurationStatus(env, stored).baseUrl, stored?.showAgentName === true]);
    if (!service || serviceKey !== key) {
      service = createLarkCardService(env, fetcher, stored);
      serviceKey = key;
    }
    return service;
  };

  // 不等长连接握手：服务先开始监听 HTTP，重启/部署的不可用窗口不随机器人数量拉长。
  if (!listeningDisabled) void syncListeners();
  app.addHook('onClose', async () => listener.stop());
  await registerLarkAgentToolRoutes(app, options.agentTools);
  await registerLarkGroupManagementRoutes(app, options.groupManager);
  await registerLarkAppCreationRoutes(app, options.appCreationJobs ?? (options.config
    ? new LarkAppCreationJobManager({ config: options.config, agents: options.agents, fetcher })
    : undefined));

  app.get('/api/lark/status', async () => ({
    ...larkConfigurationStatus(env, await storedBot()),
    configuredBots: (await readLarkConfigs(options.config)).length,
    listening: listener.listening,
    activeAppIds: listener.activeAppIds,
    listeningDisabled,
    policyIntegration: options.executionPolicy?.integrationMode ?? 'legacy_unmanaged',
  }));
  app.get('/api/lark/config', async () => publicLarkConfigs(await readLarkConfigs(options.config), { activeAppIds: listener.activeAppIds, listeningDisabled }));
  app.post<{ Params: { appId: string } }>('/api/lark/bots/:appId/listener/sync', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const configs = await readLarkConfigs(options.config);
    const bot = configs.find(config => config.appId === request.params.appId);
    if (!bot) return reply.code(404).send({ error: { code: 'LARK_BOT_NOT_FOUND', message: '机器人配置不存在' } });
    if (listeningDisabled || !bot.listening || !larkExecutionConfirmed(bot)) {
      return reply.code(409).send({ error: { code: 'LARK_LISTENING_DISABLED', message: '当前服务或机器人配置未允许监听' } });
    }
    await syncListeners();
    if (!listener.activeAppIds.includes(bot.appId)) {
      return reply.code(503).send({ error: { code: 'LARK_LISTENER_START_FAILED', message: '监听连接未成功，已保留机器人配置' } });
    }
    return { appId: bot.appId, listening: true, activeListening: true };
  });
  app.post<{ Body: { appId?: string; forceLogin?: boolean } }>('/api/lark/open-platform/configure', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const appId = request.body?.appId?.trim();
    if (!appId || !isValidLarkAppId(appId)) return reply.code(400).send({ error: { code: 'INVALID_LARK_APP_ID', message: '飞书应用 ID 格式无效，应为 cli_*' } });
    try {
      return reply.code(202).send(openPlatformJobs.start(appId, { forceLogin: request.body?.forceLogin === true }));
    } catch (error) {
      return reply.code(400).send({ error: { code: 'LARK_OPEN_PLATFORM_SETUP_FAILED', message: error instanceof Error ? error.message : String(error) } });
    }
  });
  app.get<{ Params: { jobId: string } }>('/api/lark/open-platform/jobs/:jobId', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const job = openPlatformJobs.get(request.params.jobId);
    return job ?? reply.code(404).send({ error: { code: 'LARK_OPEN_PLATFORM_JOB_NOT_FOUND', message: '飞书自动配置任务不存在或已过期' } });
  });
  app.post<{ Body: { appId?: string; appSecret?: string; brand?: 'feishu' | 'lark' } }>('/api/lark/bot/inspect', async (request, reply) => {
    try {
      const bot = createLarkCardService(env, fetcher, { appId: request.body?.appId, appSecret: request.body?.appSecret, brand: request.body?.brand ?? (await readLarkConfig(options.config, request.body?.appId))?.brand });
      return await bot.getBotInfo();
    } catch (error) {
      return larkError(reply, error);
    }
  });
  app.get<{ Params: { appId: string }; Querystring: { pageToken?: string } }>('/api/lark/bots/:appId/chats', async (request, reply) => {
    try {
      return await (await resolveService(undefined, request.params.appId)).listChats(request.query.pageToken);
    } catch (error) {
      return larkError(reply, error);
    }
  });
  app.get<{ Params: { appId: string } }>('/api/lark/bots/:appId/memory/status', async (request, reply) => {
    try {
      await resolveService(undefined, request.params.appId);
      if (!options.memory?.pipeline) {
        throw new LarkServiceError('MEMORY_STATUS_UNAVAILABLE', 'Memory status unavailable', 503);
      }
      const bot = await readLarkConfig(options.config, request.params.appId);
      const enabled = Boolean(bot && larkMemoryEnabled(bot));
      const groups = await options.memory.pipeline.status({
        appId: request.params.appId,
        chatId: 'groups',
        pool: 'groups'
      });
      const lastRunLabel = groups.lastRun && !groups.lastRun.ok ? larkMemoryErrorLabel(groups.lastRun.error) : undefined;
      const lastRun = groups.lastRun ? {
        ...groups.lastRun,
        ...(groups.lastRun.error && !/^[A-Z][A-Z0-9_]*$/.test(groups.lastRun.error) ? { error: undefined } : {})
      } : undefined;
      return {
        appId: request.params.appId,
        enabled,
        groupMemoryScope: bot?.groupMemoryScope ?? 'shared',
        groups: {
          ...groups,
          ...(lastRun ? { lastRun } : {}),
          ...(lastRunLabel !== undefined ? { lastRunLabel } : {})
        }
      };
    } catch (error) {
      return larkError(reply, error);
    }
  });
  app.get<{ Params: { appId: string; chatId: string }; Querystring: { pageToken?: string } }>('/api/lark/bots/:appId/chats/:chatId/members', async (request, reply) => {
    try {
      return await (await resolveService(undefined, request.params.appId)).listChatMembers({
        chatId: request.params.chatId,
        memberTypes: ['user'],
        pageSize: 100,
        ...(request.query.pageToken ? { pageToken: request.query.pageToken } : {})
      });
    } catch (error) {
      return larkError(reply, error);
    }
  });
  app.get<{ Querystring: { appId?: string; agentId?: string; workspace?: string } }>('/api/lark/hooks/status', async (request, reply) => {
    const config = await readLarkConfig(options.config, request.query.appId);
    if (!config) return reply.code(404).send({ error: { code: 'LARK_BOT_NOT_FOUND', message: 'Unknown Lark bot' } });
    const agentId = request.query.agentId?.trim() || config.defaultAgentId;
    return larkHookStatus(agentId, request.query.workspace === undefined ? config.workspace : request.query.workspace.trim(), agentId ? await options.agents?.get(agentId) : undefined);
  });
  app.post<{ Body: { appId?: string; highRiskPattern?: string; expectedRevision?: number; draft?: LarkHookDraft } }>('/api/lark/hooks/install', async (request, reply) => {
    try {
      const config = await readLarkConfig(options.config, request.body?.appId);
      if (!config) throw new LarkServiceError('LARK_BOT_NOT_FOUND', 'Unknown Lark bot', 404);
      if (request.body?.expectedRevision !== undefined && request.body.expectedRevision !== (config.revision ?? 1)) {
        throw new LarkServiceError('LARK_CONFIG_REVISION_CONFLICT', '此 Bot 已被修改，请比较最新配置后再保存。', 409);
      }
      const pattern = request.body?.highRiskPattern === undefined ? config.highRiskPattern : request.body.highRiskPattern.trim() || defaultHighRiskPattern;
      const patternValidation = validateHighRiskPattern(pattern);
      if (!patternValidation.valid) throw new LarkServiceError('INVALID_HIGH_RISK_PATTERN', patternValidation.error, 400);
      const parsedDraft = hookDraftSchema.safeParse(request.body?.draft === undefined ? {} : request.body.draft);
      if (!parsedDraft.success) throw new LarkServiceError('INVALID_LARK_CONFIG', 'Hook 准备参数无效，请检查工作区和 Agent 分流权重。', 400);
      const draft = parsedDraft.data;
      const workspace = draft.workspace === undefined ? config.workspace : draft.workspace.trim() || undefined;
      if (workspace && !isAbsolute(workspace)) throw new LarkServiceError('INVALID_LARK_CONFIG', '工作区必须是绝对路径。', 400);
      const defaultAgentId = draft.defaultAgentId?.trim() || config.defaultAgentId;
      const fallbackAgentId = draft.fallbackAgentId === undefined ? config.fallbackAgentId : draft.fallbackAgentId.trim();
      if (fallbackAgentId && fallbackAgentId === defaultAgentId) throw new LarkServiceError('INVALID_LARK_CONFIG', '兜底 Agent 不能与默认 Agent 相同。', 400);
      const agentIds = [...new Set([defaultAgentId, ...(fallbackAgentId ? [fallbackAgentId] : []), ...(draft.defaultAgentWeights ?? config.defaultAgentWeights ?? []).map(row => row.agentId)])];
      const agents = await Promise.all(agentIds.map(async agentId => {
        const agent = agentId ? await options.agents?.get(agentId) : undefined;
        if (!agentId || options.agents && !agent) throw new LarkServiceError('INVALID_LARK_CONFIG', `Agent 不存在：${agentId || '未选择'}`, 400);
        return agent;
      }));
      let hook, unreadyHook;
      for (const [index, agentId] of agentIds.entries()) {
        hook = await installLarkHook(agentId, workspace, agents[index]);
        if (hook.nativeReady === false) unreadyHook ??= hook;
      }
      // 草稿准备只写 Hook 文件。保留编辑起点的版本，正常保存仍走 CAS 和强制风控校验。
      if (request.body?.draft !== undefined) return unreadyHook ?? hook;
      if (config.riskControlMode === 'enforced' && unreadyHook) throw new LarkServiceError('RISK_CONTROL_HOOK_NOT_READY', unreadyHook.reason ?? 'Codex Hook 已生成，但尚未通过原生加载与信任检查。请审核后重新检查。', 409);
      const saved = await saveLarkConfig(options.config, options.agents, {
        stage: 'agent',
        originalAppId: config.appId,
        expectedRevision: config.revision ?? 1,
        ...(request.body?.highRiskPattern !== undefined ? { highRiskPattern: request.body.highRiskPattern } : {}),
        riskControlMode: config.riskControlMode === 'enforced' ? 'enforced' : 'guidance'
      });
      if (!listeningDisabled) await syncListeners();
      if (options.runtime) await options.groupManager?.refreshPolicies(options.runtime);
      return { ...hook, configRevision: saved.find(bot => bot.appId === config.appId)!.revision };
    } catch (error) {
      return larkError(reply, error);
    }
  });
  async function saveBotConfig(input: SaveLarkConfigRequest): Promise<Awaited<ReturnType<typeof publicLarkConfigs>>> {
    input = { ...input, originalAppId: input.originalAppId?.trim() };
    const existing = input.originalAppId ? await readLarkConfig(options.config, input.originalAppId) : undefined;
    if (existing && input.expectedRevision !== undefined && input.expectedRevision !== (existing.revision ?? 1)) throw new LarkServiceError('LARK_CONFIG_REVISION_CONFLICT', '此 Bot 已被修改，请比较最新配置后再保存。', 409);
    // Keep identity lookups and the saved inherited values on one revision.
    if (existing && input.expectedRevision === undefined) input = { ...input, expectedRevision: existing.revision ?? 1 };
    const appId = input.appId?.trim() || existing?.appId;
    const appSecret = input.appSecret?.trim() || existing?.appSecret;
    const appChanged = Boolean(existing && appId !== existing.appId);
    const bot = createLarkCardService(env, fetcher, { appId, appSecret, brand: input.brand ?? existing?.brand });
    const resolvedAllowedUsers = input.allowedUserNames === undefined ? undefined : await bot.resolveChatUsersByNames(input.allowedUserNames);
    const resolvedAllowedBots = input.allowedBotNames === undefined ? undefined : await bot.resolveChatUsersByNames(input.allowedBotNames, ['bot']);
    const resolvedHighRiskUsers = input.highRiskAllowedUserNames === undefined ? undefined : await bot.resolveChatUsersByNames(input.highRiskAllowedUserNames);
    const allowedUsers = resolvedAllowedUsers ?? (input.allowedUsers === undefined ? existing?.allowedUsers ?? [] : Array.isArray(input.allowedUsers) ? input.allowedUsers : []);
    const highRiskUsers = resolvedHighRiskUsers ?? (input.highRiskAllowedUsers === undefined ? existing?.highRiskAllowedUsers ?? [] : Array.isArray(input.highRiskAllowedUsers) ? input.highRiskAllowedUsers : []);
    const allowedBots = resolvedAllowedBots ?? (input.allowedBots === undefined ? existing?.allowedBots ?? [] : Array.isArray(input.allowedBots) ? input.allowedBots : []);
    const lookup: ContactLookup = {
      getUser: (id, idType) => bot.getContactUser(id, idType),
      batchGetIdByEmail: email => bot.batchGetIdByEmail(email),
      batchGetIdByMobile: mobile => bot.batchGetIdByMobile(mobile)
    };
    // Both stages can change credentials and allowlists. Validate the final target,
    // including app-scoped entries inherited when switching applications.
    const ownerEntries = resolvedAllowedUsers === undefined && (appChanged || input.allowedUsers !== undefined) ? allowedUsers : [];
    const riskEntries = resolvedHighRiskUsers === undefined && (appChanged || input.highRiskAllowedUsers !== undefined) ? highRiskUsers : [];
    const rawOpenIds = [...new Set([...ownerEntries, ...riskEntries].map(user => String(user?.openId ?? '').trim()).filter(id => id.startsWith('ou_')))];
    if (!existing && ownerEntries.some(user => String(user?.openId ?? '').trim().startsWith('ou_'))) {
      throw new LarkServiceError('LARK_OWNER_OPENID_CROSS_APP', '保存新机器人时不能直接使用 app-scoped open_id，请先在目标应用下通过姓名解析。', 400);
    }
    const unusable = await detectUnusableOwnerEntries(rawOpenIds, lookup);
    if (unusable.length) throw new LarkServiceError('LARK_OWNER_OPENID_CROSS_APP', `以下白名单 open_id 无法通过目标应用校验，不能保存：${unusable.join(', ')}。请在目标应用下重新解析成员。`, 400);
    // Contact user lookup cannot prove a bot's identity. Require target-app
    // name resolution (or an explicit empty list) before moving peer bots.
    if (appChanged && resolvedAllowedBots === undefined && allowedBots.some(user => String(user?.openId ?? '').trim().startsWith('ou_'))) {
      throw new LarkServiceError('LARK_BOT_OPENID_CROSS_APP', '更换应用后，请通过目标应用重新解析允许的机器人，或先清空机器人名单。', 400);
    }
    input = {
      ...input,
      ...(resolvedAllowedUsers !== undefined ? { allowedUsers: resolvedAllowedUsers, allowedEmails: [] } : {}),
      ...(resolvedAllowedBots !== undefined ? { allowedBots: resolvedAllowedBots } : {}),
      ...(resolvedHighRiskUsers !== undefined ? { highRiskAllowedUsers: resolvedHighRiskUsers, highRiskAllowedEmails: [] } : {})
    };
    if (input.stage === 'lark') {
      const info = await bot.getBotInfo();
      const allowedEmails = input.allowedEmails ?? existing?.allowedEmails ?? [];
      if (!allowedUsers.length && allowedEmails.length) await bot.checkIdentityResolution();
      input = { ...input, name: info.appName, listening: input.listening ?? existing?.listening ?? false };
    }
    const riskControlMode = resolveRiskControlModeInput(input, existing?.riskControlMode ?? 'off');
    const highRiskEmails = input.highRiskAllowedEmails ?? existing?.highRiskAllowedEmails ?? [];
    if ((input.stage === 'agent' || appChanged || input.highRiskAllowedEmails !== undefined) && riskControlMode !== 'off' && !highRiskUsers.length && highRiskEmails.length) await bot.checkIdentityResolution();
    const weightsResult = agentWeightsSchema.safeParse(input.defaultAgentWeights === undefined ? existing?.defaultAgentWeights ?? [] : input.defaultAgentWeights);
    if (!weightsResult.success) throw new LarkServiceError('INVALID_LARK_CONFIG', 'Agent weights must contain distinct Agent IDs and finite positive weights.', 400);
    const fallbackAgentId = input.fallbackAgentId === undefined ? existing?.fallbackAgentId : input.fallbackAgentId.trim();
    const requestedRiskControlMode = resolveRiskControlModeInput(input, existing?.riskControlMode ?? 'off');
    if (requestedRiskControlMode === 'enforced') {
      const agentIds = new Set([input.defaultAgentId?.trim() || existing?.defaultAgentId, ...(fallbackAgentId ? [fallbackAgentId] : []), ...weightsResult.data.map(row => row.agentId)]);
      for (const agentId of agentIds) {
        const hook = await larkHookStatus(agentId, input.workspace === undefined ? existing?.workspace : input.workspace.trim() || undefined, agentId ? await options.agents?.get(agentId) : undefined);
        if (!hook.supported || !hook.installed || !hook.writable || hook.nativeReady === false) throw new LarkServiceError('RISK_CONTROL_HOOK_NOT_READY', `${agentId}: ${hook.reason ?? '请先为当前工作区的默认、兜底和分流 Agent 配置拦截 Hook，再保存强制风控设置。'}`, 409);
      }
    }
    const saved = await saveLarkConfig(options.config, options.agents, listeningDisabled ? { ...input, listening: undefined } : input);
    // Bot 改 appId（跨应用复制配置）后，按 appId 作用域的模型服务设置不会自动跟随记录，
    // 显式搬到新 appId，避免新应用静默回退全局网关凭据。
    const renamedFrom = input.originalAppId?.trim();
    const renamedTo = input.appId?.trim();
    if (renamedFrom && renamedTo && renamedTo !== renamedFrom) await options.renameBotModelSettings?.(renamedFrom, renamedTo);
    if (!listeningDisabled) await syncListeners();
    if (options.runtime) await options.groupManager?.refreshPolicies(options.runtime);
    if (!options.service) service = undefined;
    return publicLarkConfigs(saved, { activeAppIds: listener.activeAppIds, listeningDisabled });
  }

  app.put<{ Body: SaveLarkConfigRequest }>('/api/lark/config', async (request, reply) => {
    try {
      return await saveBotConfig(request.body ?? {});
    } catch (error) {
      if (error instanceof LarkServiceError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message }, ...(error.code === 'LARK_CONFIG_REVISION_CONFLICT' ? { current: (await publicLarkConfigs(await readLarkConfigs(options.config))).bots.find(bot => bot.appId === request.body.originalAppId) } : {}) });
      throw error;
    }
  });
  app.delete<{ Params: { appId: string } }>('/api/lark/config/:appId', async (request, reply) => {
    try {
      const saved = await deleteLarkConfig(options.config, request.params.appId);
      await options.clearBotModelSettings?.(request.params.appId);
      if (!listeningDisabled) await syncListeners();
      if (options.runtime) await options.groupManager?.refreshPolicies(options.runtime);
      if (!options.service) service = undefined;
      return publicLarkConfigs(saved, { activeAppIds: listener.activeAppIds, listeningDisabled });
    } catch (error) {
      return larkError(reply, error);
    }
  });
  app.post<{ Body: LarkSendRequest }>('/api/lark/send', async (request, reply) => {
    const { bot, botAppId, ...input } = request.body ?? {};
    try { return await (await resolveService(bot, botAppId)).send(input); }
    catch (error) {
      return larkError(reply, error);
    }
  });
  app.post<{ Body: LarkUpdateRequest }>('/api/lark/update', async (request, reply) => {
    const { bot, botAppId, ...input } = request.body ?? ({} as LarkUpdateRequest);
    try { return await (await resolveService(bot, botAppId)).update(input as LarkUpdateInput); }
    catch (error) {
      return larkError(reply, error);
    }
  });
}
