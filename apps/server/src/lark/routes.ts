import type { FastifyInstance } from 'fastify';
import { validateHighRiskPattern, type AgentRepository, type ChannelMappingRepository, type ConfigRepository } from '@dockmux/shared';
import type { DockmuxRuntime } from '@dockmux/runtime';
import { createLarkCardService, LarkServiceError, larkConfigurationStatus, type LarkBotConfigInput, type LarkCardService, type LarkSendInput, type LarkUpdateInput } from './service.js';
import { defaultHighRiskPattern, deleteLarkConfig, publicLarkConfigs, readLarkConfig, readLarkConfigs, saveLarkConfig, type SaveLarkConfigInput } from './config.js';
import { LarkLongConnectionListenerPool, type LarkListenerPool } from './listener.js';
import { installLarkHook, larkHookStatus } from './security-hooks.js';
import { registerLarkAgentToolRoutes } from './agent-tools-routes.js';
import type { LarkAgentToolsService } from './agent-tools.js';

type LarkSendRequest = LarkSendInput & { bot?: LarkBotConfigInput; botAppId?: string };
type LarkUpdateRequest = LarkUpdateInput & { bot?: LarkBotConfigInput; botAppId?: string };
type SaveLarkConfigRequest = SaveLarkConfigInput & { allowedUserNames?: string[]; allowedBotNames?: string[]; highRiskAllowedUserNames?: string[] };

export interface LarkRoutesOptions {
  env?: NodeJS.ProcessEnv;
  service?: LarkCardService;
  config?: ConfigRepository;
  agents?: AgentRepository;
  cardMappings?: ChannelMappingRepository;
  fetcher?: typeof globalThis.fetch;
  listener?: LarkListenerPool;
  runtime?: DockmuxRuntime;
  listeningDisabled?: boolean;
  agentTools?: LarkAgentToolsService;
}

export async function registerLarkRoutes(app: FastifyInstance, options: LarkRoutesOptions = {}) {
  const env = options.env ?? process.env;
  const fetcher = options.fetcher ?? globalThis.fetch;
  let service = options.service;
  const listeningDisabled = options.listeningDisabled === true;
  const listener = options.listener ?? new LarkLongConnectionListenerPool(app.log, {
    runtime: options.runtime,
    cardMappings: options.cardMappings,
    env,
    fetcher,
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

  app.get('/api/lark/status', async () => ({ ...larkConfigurationStatus(env, await storedBot()), configuredBots: (await readLarkConfigs(options.config)).length, listening: listener.listening, activeAppIds: listener.activeAppIds, listeningDisabled }));
  app.get('/api/lark/config', async () => publicLarkConfigs(await readLarkConfigs(options.config), { activeAppIds: listener.activeAppIds, listeningDisabled }));
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
  app.get<{ Querystring: { appId?: string } }>('/api/lark/hooks/status', async (request, reply) => {
    const config = await readLarkConfig(options.config, request.query.appId);
    if (!config) return reply.code(404).send({ error: { code: 'LARK_BOT_NOT_FOUND', message: 'Unknown Lark bot' } });
    return larkHookStatus(config.defaultAgentId, config.workspace);
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
        gateEnabled: true,
        hardGateEnabled: false,
        hookTrustConfirmed: true
      });
      if (!listeningDisabled) await syncListeners(saved);
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
        const allowedUsers = resolvedAllowedUsers ?? input.allowedUsers ?? existing?.allowedUsers ?? [];
        const allowedEmails = input.allowedEmails ?? existing?.allowedEmails ?? [];
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
        const gateEnabled = input.gateEnabled ?? existing?.gateEnabled ?? false;
        if (gateEnabled && !highRiskAllowedUsers.length && highRiskAllowedEmails.length && existing) {
          await createLarkCardService(env, fetcher, { appId: existing.appId, appSecret: existing.appSecret }).checkIdentityResolution();
        }
        if (resolvedHighRiskAllowedUsers !== undefined) input = { ...input, highRiskAllowedUsers: resolvedHighRiskAllowedUsers, highRiskAllowedEmails: [] };
      }
      if (input.hardGateEnabled === true) {
        const existing = input.originalAppId ? await readLarkConfig(options.config, input.originalAppId) : undefined;
        const hook = await larkHookStatus(input.defaultAgentId ?? existing?.defaultAgentId, input.workspace ?? existing?.workspace);
        if (!hook.supported || !hook.installed || !hook.writable) throw new LarkServiceError('HARD_GATE_NOT_READY', hook.reason ?? 'Install the selected Agent hook before enabling the hard gate', 409);
      }
      const saved = await saveLarkConfig(options.config, options.agents, listeningDisabled ? { ...input, listening: undefined } : input);
      if (!listeningDisabled) await syncListeners(saved);
      if (!options.service) service = undefined;
      return publicLarkConfigs(saved, { activeAppIds: listener.activeAppIds, listeningDisabled });
    } catch (error) {
      if (error instanceof LarkServiceError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
      throw error;
    }
  });
  app.delete<{ Params: { appId: string } }>('/api/lark/config/:appId', async (request, reply) => {
    try {
      const saved = await deleteLarkConfig(options.config, request.params.appId);
      if (!listeningDisabled) await syncListeners(saved);
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
