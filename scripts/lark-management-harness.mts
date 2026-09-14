import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRepositories } from '@dutydeck/storage';
import { DutydeckRuntime } from '@dutydeck/runtime';
import { agentConfigSchema } from '@dutydeck/shared';
import { buildApp } from '../apps/server/src/app.js';
import { LarkGroupManager } from '../apps/server/src/lark/group-management.js';
import { readLarkConfig, saveLarkConfig } from '../apps/server/src/lark/config.js';
import { LarkMessageCoordinator, type LarkMessageEvent } from '../apps/server/src/lark/listener.js';

export interface LarkManagementDelivery {
  appId: string;
  operation: string;
  input: any;
  messageId: string;
  cached?: boolean;
}

export interface SyntheticTransportState {
  deliveries: LarkManagementDelivery[];
  idempotencyCache: Map<string, { messageId: string; chatId?: string }>;
  cardSequence: number;
}

export function createSyntheticTransportState(): SyntheticTransportState {
  return {
    deliveries: [],
    idempotencyCache: new Map(),
    cardSequence: 0,
  };
}

export async function createLarkManagementHarness(
  webRoot?: string,
  existingDirectory?: string,
  transportState: SyntheticTransportState = createSyntheticTransportState()
) {
  let directory: string | undefined = existingDirectory;
  let repositories: ReturnType<typeof createRepositories> | undefined;
  let runtime: DutydeckRuntime | undefined;
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  const coordinators = new Map<string, LarkMessageCoordinator>();

  try {
    directory = existingDirectory ?? await mkdtemp(join(tmpdir(), 'dutydeck-dashboard-e2e-'));
    const workspacesRoot = join(directory, 'workspaces-root');
    await mkdir(workspacesRoot, { recursive: true });
    const workspaces = [join(directory, 'project'), join(directory, 'review')];
    for (const workspace of workspaces) await mkdir(workspace, { recursive: true });
    const record = join(directory, 'cli-observations.jsonl');
    const database = join(directory, 'state.sqlite');

    repositories = createRepositories(database);
    const agents = ['agent_one', 'agent_two'].map((id, i) => agentConfigSchema.parse({
      id,
      name: i ? '评审 Agent' : '开发 Agent',
      command: process.execPath,
      args: [resolve('tests/fixtures/group-management-agent.mjs'), '--record', record, '--agent', id],
      protocol: 'acp',
      cwd: workspaces[i],
      timeout: 30,
      model: 'model-default'
    }));

    const manager: LarkGroupManager = new LarkGroupManager(repositories, {
      client: config => client(config.appId),
      onPolicyChanged: (): Promise<void> => manager.refreshPolicies(runtime!)
    });

    runtime = new DutydeckRuntime(repositories, {
      workspaceRoot: workspacesRoot,
      authorizeExecution: (sessionId, actorId) => manager.beginTurn(sessionId, actorId),
      resolveRiskPolicy: (sessionId, fallback) => manager.riskPolicy(sessionId, fallback)
    });

    for (const agent of agents) await repositories.agents.save(agent);
    for (const [index, appId] of ['cli_one', 'cli_two'].entries()) {
      if (!await readLarkConfig(repositories.config, appId)) {
        await saveLarkConfig(repositories.config, repositories.agents, {
          appId,
          appSecret: `synthetic_${appId}`,
          name: index ? '评审助手' : '开发助手',
          defaultAgentId: agents[index]!.id,
          workspace: workspaces[index],
          fullTrustConfirmed: true,
          defaultModel: 'model-default',
          groupReplyMode: 'new-topic',
          mentionPolicy: 'topic',
          groupToolsEnabled: true,
          groupToolsAllowSend: true
        });
      }
    }

    const failures: unknown[] = [];
    const memberIds = new Set(['ou_alice', 'ou_bob']);

    const client = (appId: string): any => {
      const deliver = (operation: string) => async (input: any) => {
        const cacheKey = input.idempotencyKey ? `${appId}:${input.idempotencyKey}` : undefined;
        if (cacheKey && transportState.idempotencyCache.has(cacheKey)) {
          const cached = transportState.idempotencyCache.get(cacheKey)!;
          const entry: LarkManagementDelivery = { appId, operation, input, messageId: cached.messageId, cached: true };
          transportState.deliveries.push(entry);
          return cached;
        }
        const messageId = operation === 'update'
          ? (input.messageId ?? `om_card_${++transportState.cardSequence}_${randomUUID().slice(0, 8)}`)
          : `om_card_${++transportState.cardSequence}_${randomUUID().slice(0, 8)}`;
        const result = { messageId, chatId: input.chatId };
        if (cacheKey) {
          transportState.idempotencyCache.set(cacheKey, result);
        }
        const entry: LarkManagementDelivery = { appId, operation, input, messageId, cached: false };
        transportState.deliveries.push(entry);
        return result;
      };
      return {
        getBotInfo: async () => ({ appName: appId, openId: `ou_bot_${appId}` }),
        getBotOpenId: async () => `ou_bot_${appId}`,
        checkApplicationIdentity: async () => ({ verified: true, reportedAppId: appId, tenantKey: 'acceptance-tenant' }),
        listChats: async () => ({ items: [{ chatId: 'oc_project', name: '项目群', external: false }, { chatId: 'oc_oncall', name: '值班群', external: false }], hasMore: false }),
        listChatMembers: async () => ({ items: [...memberIds].map(openId => ({ memberId: openId, openId, memberType: 'user', name: openId === 'ou_alice' ? 'Alice' : 'Bob' })), hasMore: false, securityLimited: false }),
        getUserEmails: async () => [], listChatMessages: async () => ({ items: [], hasMore: false }),
        addReaction: async () => ({ reactionId: 'reaction' }), deleteReaction: async () => {},
        send: deliver('send'), reply: deliver('reply'), update: deliver('update'),
        sendFile: deliver('sendFile'), replyFile: deliver('replyFile'), uploadFile: async () => 'file_synthetic_key'
      };
    };

    await runtime.initialize(agents);
    const log = { info() {}, warn(details: unknown) { failures.push(details); }, error(details: unknown) { failures.push(details); } };
    for (const appId of ['cli_one', 'cli_two']) {
      coordinators.set(appId, new LarkMessageCoordinator(runtime, client(appId), log, Math.random, `ou_bot_${appId}`, undefined, repositories.channelMappings, async () => 'group', undefined, manager));
    }

    app = await buildApp(runtime, {
      webRoot,
      system: { directoryRoots: async () => workspaces },
      auth: { mode: 'local', localOnly: true, getToken: async () => null },
      lark: { config: repositories.config, agents: repositories.agents, runtime, groupManager: manager, listeningDisabled: true },
      executionPolicy: { authorize: async (_request, sessionId, _boundary, action) => await manager.authorizeSession(sessionId, action, true) ?? { allowed: true, action, code: 'local_owner', reason: 'Synthetic acceptance owner', source: 'owner' } }
    });

    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('Missing acceptance server address');
    const base = `http://127.0.0.1:${address.port}`;
    const observations = async (): Promise<any[]> => (await readFile(record, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));

    return {
      directory,
      database,
      base,
      app,
      runtime,
      manager,
      repositories,
      workspaces,
      deliveries: transportState.deliveries,
      failures,
      memberIds,
      observations,
      syntheticClient: (appId: string) => client(appId),
      configureAcpRiskFixture: () => saveLarkConfig(repositories!.config, repositories!.agents, { originalAppId: 'cli_one', riskControlMode: 'enforced', highRiskPattern: 'Edit' }),
      releasePermission: () => writeFile(`${record}.release`, 'release'),
      permissions: async (): Promise<any[]> => (await readFile(`${record}.permissions`, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)),
      async ingress(appId: string, overrides: Partial<LarkMessageEvent> = {}) {
        const event: LarkMessageEvent = { messageId: `om_ingress_${Date.now()}_${randomUUID().slice(0, 8)}`, chatId: 'oc_project', chatType: 'group', messageType: 'text', content: '{"text":"执行验收任务"}', senderOpenId: 'ou_alice', senderType: 'user', mentions: [{ key: '@bot', name: 'Bot', openId: `ou_bot_${appId}`, mentionedType: 'bot' }], ...overrides };
        await coordinators.get(appId)!.handle(event, (await readLarkConfig(repositories!.config, appId))!);
        return event;
      },
      async close(keep = false) {
        for (const coordinator of coordinators.values()) coordinator.stop();
        if (app) await app.close().catch(() => {});
        if (runtime) await runtime.shutdown().catch(() => {});
        if (repositories) { try { repositories.close(); } catch {} }
        if (!keep && directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
      }
    };
  } catch (error) {
    // Clean up all resources created so far on internal failure
    for (const coordinator of coordinators.values()) coordinator.stop();
    if (app) await app.close().catch(() => {});
    if (runtime) await runtime.shutdown().catch(() => {});
    if (repositories) { try { repositories.close(); } catch {} }
    if (!existingDirectory && directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}
