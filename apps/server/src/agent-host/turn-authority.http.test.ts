import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import { RelayCapabilityRegistry } from '@dutydeck/relay';
import { RuntimeError, type Session } from '@dutydeck/shared';
import { LarkAgentToolCapabilityRegistry, LarkAgentToolsService } from '../lark/agent-tools.js';
import { registerLarkAgentToolRoutes, registerLarkAgentToolTurnGuard } from '../lark/agent-tools-routes.js';
import { registerWorkItemTools } from '../work-item-tools.js';
import { registerAgentRequestTools } from '../agent-request-tools.js';
import { registerCollaborationRoutes } from '../collaboration-routes.js';
import { registerLarkMemoryTools } from '../lark/memory-tools.js';
import { registerPluginResultRoutes } from '../plugins/result-routes.js';
import { LarkPluginResultAdapter } from '../lark/plugin-result-delivery.js';
import { PluginResultService } from '../plugins/result-service.js';
import { PluginResultToolRegistry } from '../plugins/result-tools.js';
import { TaskPluginToolIdentity } from '../plugins/tool-identity.js';
import { registerPluginBusinessToolRoutes } from '../plugins/tool-routes.js';

const families = ['self', 'work-items', 'work-items/delegations', 'schedules/stop-self', 'settings',
  'collaboration', 'memory', 'plugin-tools', 'relay'] as const;
type Family = typeof families[number];
const scenarios = ['current', 'no bearer', 'no turn', 'other session', 'old task', 'old attempt', 'finished',
  'automated', 'private tools disabled', 'relay bearer', 'revoked'] as const;
type Scenario = typeof scenarios[number];

function expected(family: Family, scenario: Scenario): [number, string?] {
  const business = family === 'relay';
  if (scenario === 'no bearer' || (scenario === 'relay bearer' && !business)) {
    return [401, business ? 'PLUGIN_TOOL_UNAUTHORIZED' : 'GROUP_TOOL_UNAUTHORIZED'];
  }
  if (['no turn', 'other session', 'old task', 'old attempt', 'finished'].includes(scenario)) {
    return [403, business ? 'PLUGIN_TOOL_TURN_EXPIRED' : 'WORK_ITEM_TURN_EXPIRED'];
  }
  if (scenario === 'automated') {
    if (business) return [403, 'PLUGIN_TOOL_REQUESTER_REQUIRED'];
    if (family === 'plugin-tools') return [403, 'RESULT_REQUESTER_REQUIRED'];
    if (family === 'settings') return [403, 'AGENT_REQUEST_AUTOMATED'];
  }
  if (scenario === 'private tools disabled') {
    if (family === 'plugin-tools') return [403, 'RESULT_PERMISSION_DENIED'];
    if (['self', 'work-items', 'work-items/delegations', 'collaboration'].includes(family)) return [403, 'GROUP_TOOLS_DISABLED'];
  }
  if (scenario === 'revoked') {
    if (family === 'plugin-tools') return [403, 'RESULT_PERMISSION_DENIED'];
    if (['memory', 'self', 'work-items', 'work-items/delegations', 'collaboration'].includes(family)) return [403, 'TEST_POLICY_DENIED'];
  }
  return [200];
}

it.each(scenarios)('preserves tool family HTTP responses for %s', async scenario => {
  const repos = createRepositories(':memory:');
  const app = Fastify();
  const privateChat = scenario === 'private tools disabled';
  const session: Session = { id: 'session', runId: 'run', agentId: 'test', cwd: '/tmp', state: 'thinking', source: 'lark',
    sourceId: privateChat ? 'cli_bot:oc_chat:p2p' : 'cli_bot:oc_chat:group', createdAt: '', updatedAt: '' };
  const other = { ...session, id: 'other' };
  const turns = new LarkAgentToolCapabilityRegistry(repos.sessions, 'https://local.test');
  try {
    await repos.sessions.save(session);
    await repos.sessions.save(other);
    await repos.config.set('lark.bots', JSON.stringify([{ appId: 'cli_bot', appSecret: 'synthetic', listening: true,
      groupToolsEnabled: !privateChat, groupToolsAllowSend: true, memoryEnabled: true }]));
    const active = { taskId: 'task', attemptId: 'attempt', actorId: 'ou_actor' };
    const runtime = { getActiveTaskContext: () => scenario === 'finished' ? undefined : active, getSession: (id: string) => repos.sessions.get(id) };
    const relay = new RelayCapabilityRegistry(repos.sessions, 'https://local.test', 'synthetic-relay');
    const tools = new LarkAgentToolsService(turns, repos.config, {
      workbenchTask: runtime.getActiveTaskContext,
      authorizeTool: async () => { if (scenario === 'revoked') throw new RuntimeError('TEST_POLICY_DENIED', 'revoked', 403); },
      clientFactory: () => ({ getBotInfo: async () => ({ openId: 'ou_bot', appName: 'Bot' }) }) as any
    });
    app.setErrorHandler((error, _req, reply) => reply.code(error.statusCode ?? 500).send({ error: { code: error.code } }));
    registerLarkAgentToolTurnGuard(app, tools);
    await registerLarkAgentToolRoutes(app, tools);
    await registerWorkItemTools(app, { runtime: runtime as any, tools, work: { listBySession: async () => [], listTemplates: async () => [] } as any,
      delegations: { delegate: async () => ({}) } as any });
    vi.spyOn(tools.commands, 'settings').mockResolvedValue({} as any);
    await registerAgentRequestTools(app, { runtime, tools, automatedTask: () => scenario === 'automated',
      automation: { requestScheduleStop: async () => ({}) } as any, prepareDelivery: async () => {}, sendConfirmation: async () => {} });
    await registerCollaborationRoutes(app, { tools, runtime, service: { repositories: repos, get: async () => ({}) } } as any);
    await registerLarkMemoryTools(app, { tools, runtime, store: { list: async () => [] } as any });
    const actor = { kind: 'channel', id: active.actorId, appId: 'cli_bot' };
    vi.spyOn(repos.execution, 'getAcceptedTask').mockReturnValue({ request: { actor, sessionId: session.id, namespace: scenario === 'automated' ? 'schedule' : 'lark', key: 'message' },
      task: { sessionId: session.id, status: 'running', currentAttemptId: active.attemptId } } as any);
    vi.spyOn(repos.execution, 'getAttempt').mockReturnValue({ state: 'running' } as any);
    await repos.channelMappings.save({ id: 'mapping', channel: 'lark-card:cli_bot', externalId: 'om_origin', sessionId: session.id, createdAt: '',
      extra: JSON.stringify({ runtime_task_id: active.taskId, app_id: 'cli_bot', chat_id: 'oc_chat', chat_type: 'group', turn: 1, task_name: 'Test', reply_in_thread: false, reply_message_id: 'om_origin' }) });
    const adapter = new LarkPluginResultAdapter({ capabilities: turns, repositories: repos, runtime,
      authorizePolicy: async () => ({ allowed: scenario !== 'revoked' }), groupManager: { authorize: async () => ({ allowed: true }), resolved: async (c: object) => c } as any,
      client: () => ({ getMessage: async () => ({ messageId: 'om_origin', chatId: 'oc_chat', sender: { type: 'user', id: active.actorId } }) }) as any,
      identity: { redirectUri: async () => 'https://local.test/api/plugin-results/oauth/callback' } as any });
    registerPluginResultRoutes(app, { service: new PluginResultService(repos.pluginResults, new PluginResultToolRegistry(), adapter), viewer: {} as any });
    const identity = new TaskPluginToolIdentity(repos, relay, turns, runtime);
    registerPluginBusinessToolRoutes(app, { service: { list: (token?: string, turn?: string) => identity.resolve(token, turn) } } as any);
    const target = scenario === 'other session' ? other : session;
    const channelToken = turns.environmentFor(target).dutydeck_group_tools_token;
    const turn = turns.finalTurnToken(session.id, scenario === 'old task' ? 'previous' : active.taskId,
      scenario === 'old attempt' ? 'previous' : active.attemptId);
    for (const family of families) {
      const business = family === 'relay';
      const token = business || scenario === 'relay bearer' ? relay.tokenFor(target.id) : channelToken;
      const header = business ? 'x-dutydeck-tool-turn' : family === 'plugin-tools' ? 'x-dutydeck-result-turn' : 'x-dutydeck-work-turn';
      const response = await app.inject({ url: business ? '/api/plugin-tools/list' : '/api/lark/agent-tools/' + family,
        method: family === 'schedules/stop-self' || family === 'work-items/delegations' ? 'POST' : 'GET',
        ...(family === 'work-items/delegations' ? { payload: { goal: 'Review', idempotencyKey: 'key' } } : {}),
        headers: { ...(scenario === 'no bearer' ? {} : { authorization: 'Bearer ' + token }), ...(scenario === 'no turn' ? {} : { [header]: turn }) } });
      const [status, code] = expected(family, scenario);
      expect([response.statusCode, response.json().error?.code], family).toEqual([status, code]);
    }
  } finally { await app.close(); turns.close(); repos.close(); }
});
