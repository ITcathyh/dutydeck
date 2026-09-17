import { LarkAppCreationJobManager } from './app-creation.js';
import { registerLarkAppCreationRoutes } from './app-creation-routes.js';
import type { RelayAskBroker } from '@dutydeck/relay';
import { registerLarkGroupManagementRoutes, type LarkGroupManager } from './group-management.js';
import type { FastifyInstance } from 'fastify';
import { validateHighRiskPattern, type AgentRepository, type ChannelMappingRepository, type ConfigRepository, type PolicyAction, type PolicyDecision } from '@dutydeck/shared';
import type { DutydeckRuntime } from '@dutydeck/runtime';
import { createLarkCardService, LarkServiceError, larkConfigurationStatus, type LarkBotConfigInput, type LarkCardService, type LarkSendInput, type LarkUpdateInput } from './service.js';
import { detectUnusableOwnerEntries, normalizeOwnerEntries, type ContactLookup } from './owner-identity.js';
import { defaultHighRiskPattern, deleteLarkConfig, publicLarkConfigs, readLarkConfig, readLarkConfigs, resolveRiskControlModeInput, saveLarkConfig, type SaveLarkConfigInput } from './config.js';
import { LarkLongConnectionListenerPool, type LarkListenerPool } from './listener.js';
import { installLarkHook, larkHookStatus } from './security-hooks.js';
import { registerLarkAgentToolRoutes } from './agent-tools-routes.js';
import type { LarkAgentToolsService } from './agent-tools.js';
import type { LarkMemoryStore } from './memory.js';
import type { LarkMemoryProjection } from './memory-view.js';
import {
  openPlatformConfigurationJobs,
  type OpenPlatformConfigurationJobManager,
} from './open-platform-jobs.js';
import { isValidLarkAppId } from './open-platform-configurator.js';

type LarkSendRequest = LarkSendInput & { bot?: LarkBotConfigInput; botAppId?: string };
type LarkUpdateRequest = LarkUpdateInput & { bot?: LarkBotConfigInput; botAppId?: string };
type SaveLarkConfigRequest = SaveLarkConfigInput & { allowedUserNames?: string[]; allowedBotNames?: string[]; highRiskAllowedUserNames?: string[] };

export interface LarkRoutesOptions {
  workbench?: import('./workbench.js').LarkWorkbench;
  automation?: import('../session-automation.js').SessionAutomationService;
  relayBroker?: RelayAskBroker;
  groupManager?: LarkGroupManager;
  env?: NodeJS.ProcessEnv;
  service?: LarkCardService;
  config?: ConfigRepository;
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
    projection: LarkMemoryProjection;
    command?: string;
  };
  /** StoredLarkConfig is the isolated legacy path during the compatibility period. */
  executionPolicy?: {
    integrationMode: 'legacy_unmanaged';
    authorize(boundary: 'listener' | 'session' | 'high_risk', action: PolicyAction): Promise<PolicyDecision>;
  };
}

export async function registerLarkRoutes(app: FastifyInstance, options: LarkRoutesOptions = {}) {
  const env = options.env ?? process.env;
  const fetcher = options.fetcher ?? globalThis.fetch;
  const openPlatformJobs = options.openPlatformJobs ?? openPlatformConfigurationJobs;
  let service = options.service;
  const listeningDisabled = options.listeningDisabled === true;
  const listener = options.listener ?? new LarkLongConnectionListenerPool(app.log, {
    runtime: options.runtime,
    automation: options.automation,
    workbench: options.workbench,
    workflowStore: options.config,
    relayBroker: options.relayBroker,
    cardMappings: options.cardMappings,
    env,
    fetcher,
    executionPolicy: options.executionPolicy,
    groupManager: options.groupManager,
    memory: options.memory,
    peerBotAuthorized: (appId, chatId, senderOpenId) => options.agentTools?.isConfiguredPeer(appId, chatId, senderOpenId) ?? Promise.resolve(false)
  });
  const syncListeners = async (configs: Awaited<ReturnType<typeof readLarkConfigs>>) => {
    try { await listener.sync(configs); }
    catch (firstError) {
      app.log.warn({ error: firstError }, '飞书消息监听首次连接失败，正在自动重试');
      try { await listener.sync(configs); }
      catch (error) { app.log.error({ error }, '飞书消息监听连接失败，已保留监听配置'); }
    }
  };
  const storedBot = async (appId?: string) => {
    const stored = await readLarkConfig(options.config, appId);
    return stored ? { appId: stored.appId, appSecret: stored.appSecret } : undefined;
  };
  const resolveService = async (bot?: LarkBotConfigInput, appId?: string) => {
    if (bot) return createLarkCardService(env, fetcher, bot);
    if (appId) {
      const stored = await storedBot(appId);
      if (!stored) throw new LarkServiceError('LARK_BOT_NOT_FOUND', `Unknown Lark bot: ${appId}`, 404);
      return createLarkCardService(env, fetcher, stored);
    }
    if (service) return service;
    service = createLarkCardService(env, fetcher, await storedBot(appId));
    return service;
  };

  const initialConfigs = await readLarkConfigs(options.config);
  if (!listeningDisabled) await syncListeners(initialConfigs);
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
  app.post<{ Body: { appId?: string; appSecret?: string } }>('/api/lark/bot/inspect', async (request, reply) => {
    try {
      const bot = createLarkCardService(env, fetcher, { appId: request.body?.appId, appSecret: request.body?.appSecret });
      return await bot.getBotInfo();
    } catch (error) {
      if (error instanceof LarkServiceError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
      throw error;
    }
  });
  app.get<{ Params: { appId: string }; Querystring: { pageToken?: string } }>('/api/lark/bots/:appId/chats', async (request, reply) => {
    try {
      return await (await resolveService(undefined, request.params.appId)).listChats(request.query.pageToken);
    } catch (error) {
      if (error instanceof LarkServiceError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
      throw error;
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
      if (error instanceof LarkServiceError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
      throw error;
    }
  });
  app.get<{ Querystring: { appId?: string; agentId?: string } }>('/api/lark/hooks/status', async (request, reply) => {
    const config = await readLarkConfig(options.config, request.query.appId);
    if (!config) return reply.code(404).send({ error: { code: 'LARK_BOT_NOT_FOUND', message: 'Unknown Lark bot' } });
    return larkHookStatus(request.query.agentId?.trim() || config.defaultAgentId, config.workspace);
  });
  app.post<{ Body: { appId?: string; highRiskPattern?: string } }>('/api/lark/hooks/install', async (request, reply) => {
    try {
      const config = await readLarkConfig(options.config, request.body?.appId);
      if (!config) throw new LarkServiceError('LARK_BOT_NOT_FOUND', 'Unknown Lark bot', 404);
      const pattern = request.body?.highRiskPattern === undefined ? config.highRiskPattern : request.body.highRiskPattern.trim() || defaultHighRiskPattern;
      const patternValidation = validateHighRiskPattern(pattern);
      if (!patternValidation.valid) throw new LarkServiceError('INVALID_HIGH_RISK_PATTERN', patternValidation.error, 400);
      const hook = await installLarkHook(config.defaultAgentId, config.workspace);
      const saved = await saveLarkConfig(options.config, options.agents, {
        stage: 'agent',
        originalAppId: config.appId,
        ...(request.body?.highRiskPattern !== undefined ? { highRiskPattern: request.body.highRiskPattern } : {}),
        riskControlMode: 'guidance'
      });
      if (!listeningDisabled) await syncListeners(saved);
      if (options.runtime) await options.groupManager?.refreshPolicies(options.runtime);
      return hook;
    } catch (error) {
      if (error instanceof LarkServiceError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
      throw error;
    }
  });
  app.put<{ Body: SaveLarkConfigRequest }>('/api/lark/config', async (request, reply) => {
    try {
      let input = request.body ?? {};
      if (input.stage === 'lark') {
        const existing = input.originalAppId ? await readLarkConfig(options.config, input.originalAppId) : undefined;
        const appId = input.appId?.trim() || existing?.appId;
        const appSecret = input.appSecret?.trim() || existing?.appSecret;
        const bot = createLarkCardService(env, fetcher, { appId, appSecret });
        const info = await bot.getBotInfo();
        const resolvedAllowedUsers = input.allowedUserNames === undefined ? undefined : await bot.resolveChatUsersByNames(input.allowedUserNames);
        const resolvedAllowedBots = input.allowedBotNames === undefined ? undefined : await bot.resolveChatUsersByNames(input.allowedBotNames, ['bot']);
        let allowedUsers = resolvedAllowedUsers ?? input.allowedUsers ?? existing?.allowedUsers ?? [];
        const allowedEmails = input.allowedEmails ?? existing?.allowedEmails ?? [];
        // Owner-identity 边界：未走姓名解析（resolvedAllowedUsers === undefined）时，
        // input.allowedUsers 是调用方直接写入的原始 open_id——典型场景是把 A 应用的
        // 配置复制到 B 应用。ou_ 是 app-scoped，跨应用复制会让 owner 被锁死，必须先
        // 通过目标 app 校验再落库。姓名解析路径本身已用目标 app 解析，不受影响。
        if (resolvedAllowedUsers === undefined && Array.isArray(input.allowedUsers)
          && input.allowedUsers.some(user => String(user?.openId ?? '').trim().startsWith('ou_'))) {
          const rawOpenIdEntries = [...new Set(input.allowedUsers
            .map(user => String(user?.openId ?? '').trim())
            .filter(openId => openId.startsWith('ou_')))];
          const lookup: ContactLookup = {
            getUser: (id, idType) => bot.getContactUser(id, idType),
            batchGetIdByEmail: email => bot.batchGetIdByEmail(email),
            batchGetIdByMobile: mobile => bot.batchGetIdByMobile(mobile)
          };
          // 新建 bot：没有来源 app 可转换，ou_ 一律拒绝（对齐 botmux「No open_id can
          // belong to an app that does not exist yet」）。
          if (!existing) {
            throw new LarkServiceError('LARK_OWNER_OPENID_CROSS_APP',
              `保存新机器人时不能直接使用 app-scoped open_id（${rawOpenIdEntries.join(', ')}）：open_id 只对签发它的应用有效，新应用还不存在、无法归属任何 open_id。请改用完整邮箱、手机号或 on_ union_id，或先在目标应用下通过姓名解析。`,
              400);
          }
          // 已存在 bot：通过目标 app 校验。明确不可用（跨 app open_id / 目标 app
          // 无效 id / code:0 无 user）→ 拒绝；网络/scope 错误 → inconclusive 放行。
          const unusable = await detectUnusableOwnerEntries(rawOpenIdEntries, lookup);
          if (unusable.length > 0) {
            throw new LarkServiceError('LARK_OWNER_OPENID_CROSS_APP',
              `以下白名单 open_id 无法通过目标应用校验，不能保存：${unusable.join(', ')}。open_id 只对签发它的应用有效，跨应用复制会导致 owner 被锁死。请改用完整邮箱、手机号或 on_ union_id，或先在目标应用下通过姓名解析。`,
              400);
          }
          // 归一化：能解析成 union_id 的 ou_ 在 botmux 里会替换为 on_ 落库。dutydeck
          // 的 allowedUsers 只存 ou_（config.ts 归一化丢弃非 ou_ 条目，运行时按
          // open_id 匹配），且这些 ou_ 已通过目标 app 校验、就是该 app 自己的
          // open_id，故仍以 ou_ 形态保存；on_ 形态待 schema 支持 union_id 白名单后
          // 再启用。inconclusive 的条目保留原值。
          const normalizedEntries = await normalizeOwnerEntries(rawOpenIdEntries, lookup);
          const normalizedByOpenId = new Map(rawOpenIdEntries.map((entry, index) => [entry, normalizedEntries[index] ?? entry]));
          allowedUsers = allowedUsers.map(user => {
            const openId = String(user?.openId ?? '').trim();
            const normalized = normalizedByOpenId.get(openId);
            return normalized && normalized.startsWith('ou_') ? { ...user, openId: normalized } : user;
          });
          input = { ...input, allowedUsers };
        }
        if (!allowedUsers.length && allowedEmails.length) await bot.checkIdentityResolution();
        input = {
          ...input,
          ...(resolvedAllowedUsers !== undefined ? { allowedUsers: resolvedAllowedUsers, allowedEmails: [] } : {}),
          ...(resolvedAllowedBots !== undefined ? { allowedBots: resolvedAllowedBots } : {}),
          name: info.appName,
          listening: input.listening ?? existing?.listening ?? false
        };
      }
      if (input.stage === 'agent') {
        const existing = input.originalAppId ? await readLarkConfig(options.config, input.originalAppId) : undefined;
        const resolvedHighRiskAllowedUsers = input.highRiskAllowedUserNames === undefined || !existing ? undefined : await createLarkCardService(env, fetcher, { appId: existing.appId, appSecret: existing.appSecret }).resolveChatUsersByNames(input.highRiskAllowedUserNames);
        const highRiskAllowedUsers = resolvedHighRiskAllowedUsers ?? input.highRiskAllowedUsers ?? existing?.highRiskAllowedUsers ?? [];
        const highRiskAllowedEmails = input.highRiskAllowedEmails ?? existing?.highRiskAllowedEmails ?? [];
        const riskControlMode = resolveRiskControlModeInput(input, existing?.riskControlMode ?? 'off');
        if (riskControlMode !== 'off' && !highRiskAllowedUsers.length && highRiskAllowedEmails.length && existing) {
          await createLarkCardService(env, fetcher, { appId: existing.appId, appSecret: existing.appSecret }).checkIdentityResolution();
        }
        if (resolvedHighRiskAllowedUsers !== undefined) input = { ...input, highRiskAllowedUsers: resolvedHighRiskAllowedUsers, highRiskAllowedEmails: [] };
      }
      const existing = input.originalAppId ? await readLarkConfig(options.config, input.originalAppId) : undefined;
      const requestedRiskControlMode = resolveRiskControlModeInput(input, existing?.riskControlMode ?? 'off');
      if (requestedRiskControlMode === 'enforced') {
        const hook = await larkHookStatus(input.defaultAgentId ?? existing?.defaultAgentId, input.workspace ?? existing?.workspace);
        if (!hook.supported || !hook.installed || !hook.writable) throw new LarkServiceError('RISK_CONTROL_HOOK_NOT_READY', hook.reason ?? 'Install the selected Agent hook before enabling enforced risk control', 409);
      }
      const saved = await saveLarkConfig(options.config, options.agents, listeningDisabled ? { ...input, listening: undefined } : input);
      if (!listeningDisabled) await syncListeners(saved);
      if (options.runtime) await options.groupManager?.refreshPolicies(options.runtime);
      if (!options.service) service = undefined;
      return publicLarkConfigs(saved, { activeAppIds: listener.activeAppIds, listeningDisabled });
    } catch (error) {
      if (error instanceof LarkServiceError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message }, ...(error.statusCode === 409 ? { current: (await publicLarkConfigs(await readLarkConfigs(options.config))).bots.find(bot => bot.appId === request.body.originalAppId) } : {}) });
      throw error;
    }
  });
  app.delete<{ Params: { appId: string } }>('/api/lark/config/:appId', async (request, reply) => {
    try {
      const saved = await deleteLarkConfig(options.config, request.params.appId);
      if (!listeningDisabled) await syncListeners(saved);
      if (options.runtime) await options.groupManager?.refreshPolicies(options.runtime);
      if (!options.service) service = undefined;
      return publicLarkConfigs(saved, { activeAppIds: listener.activeAppIds, listeningDisabled });
    } catch (error) {
      if (error instanceof LarkServiceError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
      throw error;
    }
  });
  app.post<{ Body: LarkSendRequest }>('/api/lark/send', async (request, reply) => {
    const { bot, botAppId, ...input } = request.body ?? {};
    try { return await (await resolveService(bot, botAppId)).send(input); }
    catch (error) {
      if (error instanceof LarkServiceError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
      throw error;
    }
  });
  app.post<{ Body: LarkUpdateRequest }>('/api/lark/update', async (request, reply) => {
    const { bot, botAppId, ...input } = request.body ?? ({} as LarkUpdateRequest);
    try { return await (await resolveService(bot, botAppId)).update(input as LarkUpdateInput); }
    catch (error) {
      if (error instanceof LarkServiceError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
      throw error;
    }
  });
}
