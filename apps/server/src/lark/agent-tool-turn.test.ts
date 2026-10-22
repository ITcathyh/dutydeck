import Fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import { buildApp } from '../app.js';
import type { Session } from '@dutydeck/shared';
import { AgentGroupToolError, LarkAgentToolCapabilityRegistry, LarkAgentToolsService } from './agent-tools.js';
import { registerLarkAgentToolRoutes, registerLarkAgentToolTurnGuard } from './agent-tools-routes.js';
import { registerLarkMemoryTools } from './memory-tools.js';
import { LarkMemoryStore } from './memory.js';
import { larkBotsConfigKey } from './config.js';

const close: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of close.splice(0)) await cleanup(); });

async function fixture() {
  const repositories = createRepositories(':memory:');
  const session: Session = { id: 'session', runId: 'run', agentId: 'agent', state: 'thinking', source: 'lark', sourceId: 'cli_bot:oc_group:group', cwd: '/tmp', createdAt: '', updatedAt: '' };
  await repositories.sessions.save(session);
  await repositories.config.set(larkBotsConfigKey, JSON.stringify([{ appId: 'cli_bot', appSecret: 'synthetic', groupToolsEnabled: true, groupToolsAllowSend: true, memoryEnabled: true }]));
  let active: { taskId: string; attemptId: string; actorId: string } | undefined = { taskId: 'old-task', attemptId: 'old-attempt', actorId: 'ou_old' };
  const capabilities = new LarkAgentToolCapabilityRegistry(repositories.sessions, 'http://localhost');
  const authorizeTool = vi.fn(async (_sessionId: string, _action: string) => {});
  const authorize = vi.fn(async () => ({ allowed: true }));
  const listChatMessages = vi.fn(async () => ({ items: [], hasMore: false }));
  const sendText = vi.fn(async () => ({ messageId: 'om_sent', chatId: 'oc_group' }));
  const getMessage = vi.fn(async (messageId: string) => ({ messageId, chatId: 'oc_group', threadId: 'omt_thread' }));
  const replyText = vi.fn(async () => ({ messageId: 'om_reply', chatId: 'oc_group' }));
  const tools = new LarkAgentToolsService(capabilities, repositories.config, {
    workbenchTask: () => active, authorizeTool,
    groupManager: { authorize, resolved: async (config: unknown) => config } as any,
    clientFactory: () => ({ listChatMessages, sendText, getMessage, replyText }) as any
  });
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AgentGroupToolError) return reply.code(error.statusCode).send(error.response());
    return reply.code(500).send({ error: { message: error.message } });
  });
  registerLarkAgentToolTurnGuard(app, tools);
  await registerLarkAgentToolRoutes(app, tools);
  const store = new LarkMemoryStore(repositories.config);
  await registerLarkMemoryTools(app, { tools, store, runtime: { getActiveTaskContext: () => active } });
  app.get('/api/public', async () => ({ public: true }));
  app.get('/api/lark/agent-tools-extra', async () => ({ public: true }));
  app.get('/api/lark/agent-tools/plugin-tools', async () => ({ tools: [] }));
  close.push(async () => { await app.close(); capabilities.close(); repositories.close(); });
  const token = capabilities.environmentFor(session).dutydeck_group_tools_token;
  const turn = () => capabilities.finalTurnToken(session.id, active!.taskId, active!.attemptId);
  const request = (method: 'GET' | 'POST', path: string, presented = turn(), payload?: object) => app.inject({
    method, url: `/api/lark/agent-tools/${path}`, headers: { authorization: `Bearer ${token}`, ...(presented ? { 'x-dutydeck-work-turn': presented } : {}) }, ...(payload ? { payload } : {})
  });
  return { app, tools, store, token, turn, request, authorizeTool, authorize, listChatMessages, sendText, getMessage, replyText, setActive: (value: typeof active) => { active = value; } };
}

it('rejects late omitted, old-task and old-attempt calls before reads, sends, or memory attribution', async () => {
  const f = await fixture();
  const firstTurn = f.turn();
  expect((await f.request('GET', 'messages')).statusCode).toBe(200);
  expect(f.authorize).toHaveBeenLastCalledWith('cli_bot', 'oc_group', 'ou_old', 'group_tools.read', 'session', { installationOwner: false, taskRequesterOpenId: 'ou_old' });
  f.setActive({ taskId: 'new-task', attemptId: 'new-attempt', actorId: 'ou_new' });
  for (const presented of ['', firstTurn]) {
    for (const [method, path, payload] of [['GET', 'messages'], ['POST', 'send', { content: 'late' }], ['POST', 'memory', { content: 'late task note' }]] as const) {
      const denied = await f.request(method, path, presented, payload);
      expect(denied.statusCode).toBe(403);
      expect(denied.json().error.code).toBe('WORK_ITEM_TURN_EXPIRED');
    }
  }
  expect(f.listChatMessages).toHaveBeenCalledOnce();
  expect(f.sendText).not.toHaveBeenCalled();
  const memory = await f.request('POST', 'memory', f.turn(), { content: 'User requested current note' });
  expect(memory.statusCode).toBe(200);
  expect(memory.json().entry).toMatchObject({ taskId: 'new-task', createdBy: 'ou_new' });
  const previousAttempt = f.turn();
  f.setActive({ taskId: 'new-task', attemptId: 'retry-attempt', actorId: 'ou_new' });
  expect((await f.request('GET', 'memory', previousAttempt)).statusCode).toBe(403);
  expect((await f.request('POST', 'send', f.turn(), { content: 'current' })).statusCode).toBe(200);
  expect(f.sendText).toHaveBeenCalledOnce();
  f.setActive(undefined);
  expect((await f.request('GET', 'messages', previousAttempt)).statusCode).toBe(403);
  expect((await f.app.inject({ url: '/api/public' })).json()).toEqual({ public: true });
  expect((await f.app.inject({ url: '/api/lark/agent-tools-extra' })).json()).toEqual({ public: true });
});

it.each(['messages', 'memory'])('does not rebind an in-flight %s call across an authorization await', async path => {
  const f = await fixture();
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  f.authorizeTool.mockImplementationOnce(async () => { await pending; });
  const request = f.request(path === 'memory' ? 'POST' : 'GET', path, f.turn(), path === 'memory' ? { content: 'old note' } : undefined);
  await vi.waitFor(() => expect(f.authorizeTool).toHaveBeenCalledOnce());
  f.setActive({ taskId: 'new-task', attemptId: 'new-attempt', actorId: 'ou_new' });
  release();
  const denied = await request;
  expect(denied.statusCode).toBe(403);
  expect(f.listChatMessages).not.toHaveBeenCalled();
  expect((await f.request('GET', 'memory')).json().entries).toEqual([]);
  if (path === 'messages') expect(f.authorize).toHaveBeenCalledWith('cli_bot', 'oc_group', 'ou_old', 'group_tools.read', 'session', { installationOwner: false, taskRequesterOpenId: 'ou_old' });
});

it('keeps the existing plugin result header usable while rejecting missing or stale attempts', async () => {
  const f = await fixture();
  const invoke = (turn: string) => f.app.inject({ url: '/api/lark/agent-tools/plugin-tools', headers: { authorization: `Bearer ${f.token}`, 'x-dutydeck-result-turn': turn } });
  expect((await invoke(f.turn())).statusCode).toBe(200);
  expect((await invoke('stale')).statusCode).toBe(403);
});

it('rechecks the attempt immediately before sending after asynchronous reply target validation', async () => {
  const f = await fixture();
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const validate = vi.spyOn(f.tools as any, 'assertMessageScope').mockImplementationOnce(async () => { await pending; });
  const request = f.request('POST', 'send', f.turn(), { content: 'old reply', replyTo: 'om_origin', inThread: true });
  await vi.waitFor(() => expect(validate).toHaveBeenCalledOnce());
  f.setActive({ taskId: 'new-task', attemptId: 'new-attempt', actorId: 'ou_new' });
  release();
  expect((await request).statusCode).toBe(403);
  expect(f.replyText).not.toHaveBeenCalled();
});

it('production app wiring guards memory registered before Lark routes and leaves public APIs available', async () => {
  const f = await fixture();
  const app = await buildApp({ listAgents: async () => [] } as any, { lark: { agentTools: f.tools, listeningDisabled: true }, memoryTools: { tools: f.tools, store: f.store } });
  close.push(() => app.close());
  const request = (path: string, turn?: string) => app.inject({ url: `/api/lark/agent-tools/${path}`, headers: { authorization: `Bearer ${f.token}`, ...(turn ? { 'x-dutydeck-work-turn': turn } : {}) } });
  expect((await request('messages')).statusCode).toBe(403);
  expect((await request('memory')).statusCode).toBe(403);
  expect((await request('messages', f.turn())).statusCode).toBe(200);
  expect((await request('memory', f.turn())).statusCode).toBe(200);
  expect((await app.inject({ url: '/api/agents' })).statusCode).toBe(200);
});
