import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentGroupToolError, LarkAgentToolCapabilityRegistry, LarkAgentToolsService } from './agent-tools.js';
import { registerLarkAgentToolRoutes } from './agent-tools-routes.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DutydeckRuntime } from '@dutydeck/runtime';
import { createRepositories } from '@dutydeck/storage';
import { larkBotsConfigKey, readLarkConfig } from './config.js';
import type { LarkMessageEvent } from './listener.js';
import { resolveLarkScopeId, resolveLarkSession } from './session-resolver.js';
import { createLarkCardService } from './service.js';

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });

describe('Agent group tool HTTP boundary', () => {
  it('forwards the bearer capability and typed options to the domain service', async () => {
    const service = {
      self: vi.fn(), peers: vi.fn(), members: vi.fn(async () => ({ chatId: 'oc_group', members: [] })),
      messages: vi.fn(async () => ({ chatId: 'oc_group', messages: [] })),
      wait: vi.fn(), send: vi.fn(async () => ({ messageId: 'om_sent' })), sendFile: vi.fn(async () => ({ messageId: 'om_file' }))
    };
    const app = Fastify(); apps.push(app); await registerLarkAgentToolRoutes(app, service as any);
    const messages = await app.inject({ method: 'GET', url: '/api/lark/agent-tools/messages?after=cursor&limit=7', headers: { authorization: 'Bearer scoped-token' } });
    const members = await app.inject({ method: 'GET', url: '/api/lark/agent-tools/members', headers: { authorization: 'Bearer scoped-token' } });
    const sent = await app.inject({ method: 'POST', url: '/api/lark/agent-tools/send', headers: { authorization: 'Bearer scoped-token' }, payload: { content: 'hello', to: 'cli_peer', replyTo: 'om_parent', inThread: true } });
    const file = await app.inject({ method: 'POST', url: '/api/lark/agent-tools/send-file', headers: { authorization: 'Bearer scoped-token' }, payload: { path: 'report.pdf', image: true, idempotencyKey: 'file-1' } });
    expect(messages.statusCode).toBe(200); expect(members.statusCode).toBe(200); expect(sent.statusCode).toBe(200); expect(file.statusCode).toBe(200);
    expect(service.members).toHaveBeenCalledWith('scoped-token');
    expect(service.messages).toHaveBeenCalledWith('scoped-token', { after: 'cursor', limit: 7 });
    expect(service.send).toHaveBeenCalledWith('scoped-token', { content: 'hello', to: 'cli_peer', replyTo: 'om_parent', inThread: true });
    expect(service.sendFile).toHaveBeenCalledWith('scoped-token', { path: 'report.pdf', image: true, idempotencyKey: 'file-1' });
  });

  it('rule 7: passes through since, until, and query query parameters to messages service', async () => {
    const service = {
      messages: vi.fn(async () => ({ chatId: 'oc_group', messages: [] }))
    };
    const app = Fastify(); apps.push(app); await registerLarkAgentToolRoutes(app, service as any);
    const response = await app.inject({
      method: 'GET',
      url: '/api/lark/agent-tools/messages?since=2026-09-25T10:00:00Z&until=2026-09-25T12:00:00Z&query=test%20query&limit=15',
      headers: { authorization: 'Bearer scoped-token' }
    });
    expect(response.statusCode).toBe(200);
    expect(service.messages).toHaveBeenCalledWith('scoped-token', {
      after: undefined,
      limit: 15,
      since: '2026-09-25T10:00:00Z',
      until: '2026-09-25T12:00:00Z',
      query: 'test query'
    });
  });

  it('passes history and team-search parameters through to the domain service', async () => {
    const service = {
      history: vi.fn(async () => ({ chatId: 'oc_group', tasks: [] })),
      historyTask: vi.fn(async () => { throw new AgentGroupToolError('HISTORY_TASK_NOT_FOUND', '本聊天没有编号为 task_x 的任务。', 404); }),
      teamSearch: vi.fn(async () => ({ query: '部署 方案', matched: 0, sources: [], note: '' }))
    };
    const app = Fastify(); apps.push(app); await registerLarkAgentToolRoutes(app, service as any);
    const headers = { authorization: 'Bearer scoped-token' };
    const listed = await app.inject({ method: 'GET', url: `/api/lark/agent-tools/history?since=2026-09-20T00:00:00Z&until=1790000000&query=${encodeURIComponent('部署 方案')}&limit=5`, headers });
    const shown = await app.inject({ method: 'GET', url: '/api/lark/agent-tools/history/task_x', headers });
    const searched = await app.inject({ method: 'GET', url: `/api/lark/agent-tools/team-search?query=${encodeURIComponent('部署 方案')}`, headers });
    expect(listed.statusCode).toBe(200); expect(searched.statusCode).toBe(200);
    expect(service.history).toHaveBeenCalledWith('scoped-token', { limit: 5, since: '2026-09-20T00:00:00Z', until: '1790000000', query: '部署 方案' });
    expect(service.historyTask).toHaveBeenCalledWith('scoped-token', { taskId: 'task_x' });
    expect(shown.statusCode).toBe(404);
    expect(shown.json()).toEqual({ error: { code: 'HISTORY_TASK_NOT_FOUND', message: '本聊天没有编号为 task_x 的任务。' } });
    expect(service.teamSearch).toHaveBeenCalledWith('scoped-token', { query: '部署 方案' });
  });

  it('rule 2 via HTTP: returns 400 with GROUP_MESSAGES_INVALID_RANGE on invalid range error', async () => {
    const service = {
      messages: vi.fn(async () => {
        throw new AgentGroupToolError('GROUP_MESSAGES_INVALID_RANGE', '--after 不能与 --since/--until/--query 同时使用。', 400);
      })
    };
    const app = Fastify(); apps.push(app); await registerLarkAgentToolRoutes(app, service as any);
    const response = await app.inject({
      method: 'GET',
      url: '/api/lark/agent-tools/messages?after=cursor&since=2026-09-25T10:00:00Z',
      headers: { authorization: 'Bearer scoped-token' }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        code: 'GROUP_MESSAGES_INVALID_RANGE',
        message: '--after 不能与 --since/--until/--query 同时使用。'
      }
    });
  });

  it.each(['reply', 'topic seed', 'new topic', 'native thread'])('resolves %s routing through persisted sessions and the real Lark client', async scenario => {
    const cwd = await mkdtemp(join(tmpdir(), 'dutydeck-thread-tools-'));
    const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' });
    const runtime = new DutydeckRuntime(repos, {
      driverIdleTimeoutMs: 0,
      probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }),
      driverFactory: (_agent, _proto, emit) => ({ start: async () => {}, stop: async () => {}, send: async () => { emit({ type: 'text', data: { text: 'done' } }); emit({ type: 'completed', data: { stopReason: 'end_turn' } }); }, resume: async () => {}, interrupt: async () => {} })
    });
    const capabilities = new LarkAgentToolCapabilityRegistry(repos.sessions, 'http://127.0.0.1:4310');
    const app = Fastify();
    try {
      await runtime.initialize([{ id: 'mock', name: 'Mock', command: process.execPath, args: [], protocol: 'acp', cwd, env: {}, permissionMode: 'ask', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false }]);
      await repos.config.set(larkBotsConfigKey, JSON.stringify([{ appId: 'cli_current', appSecret: 'test-secret', defaultAgentId: 'mock', workspace: cwd, permissionMode: 'ask', groupToolsEnabled: true, groupToolsAllowSend: true, ...(scenario === 'new topic' ? { groupReplyMode: 'new-topic' } : {}) }]));
      const config = (await readLarkConfig(repos.config, 'cli_current'))!;
      const event: LarkMessageEvent = {
        messageId: scenario === 'reply' ? 'om_reply' : 'om_root', chatId: 'oc_group', chatType: 'group', messageType: 'text',
        content: '{"text":"continue"}', mentions: [], senderOpenId: 'ou_user',
        ...(scenario === 'reply' ? { rootId: 'om_root', threadId: 'omt_topic' } : scenario === 'new topic' ? {} : { threadId: 'omt_topic' })
      };
      const scope = await resolveLarkScopeId(event, config, scenario === 'topic seed' ? async () => 'topic' : undefined);
      expect(scope).toBe(scenario === 'native thread' ? 'thread:omt_topic' : 'thread:om_root');
      const resolved = await resolveLarkSession(runtime, { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, { tail: Promise.resolve() }, config, event.chatId, event.chatType, scope, repos.channelMappings);
      const persisted = (await repos.sessions.get(resolved.id))!;
      const token = capabilities.environmentFor(persisted).dutydeck_group_tools_token!;
      const headers = { authorization: `Bearer ${token}` };
      const rawMessage = (id: string) => ({ message_id: id, chat_id: 'oc_group', thread_id: id === 'om_other' ? 'omt_other' : 'omt_topic', msg_type: 'text', create_time: '1000', sender: { id: 'ou_user', sender_type: 'user' }, body: { content: '{"text":"scoped"}' } });
      const requests: URL[] = [];
      const replies: string[] = [];
      const client = createLarkCardService({}, async (input, init) => {
        const url = new URL(String(input));
        requests.push(url);
        let payload;
        if (url.pathname.endsWith('/tenant_access_token/internal/')) payload = { code: 0, tenant_access_token: 'test-token', expire: 7200 };
        else if (url.pathname.endsWith('/messages/om_reply/reply')) {
          replies.push(url.pathname);
          expect(JSON.parse(String(init?.body))).toMatchObject({ reply_in_thread: true });
          payload = { code: 0, data: { message_id: 'om_sent', chat_id: 'oc_group' } };
        } else if (url.pathname.endsWith('/messages')) {
          expect(url.searchParams.get('container_id_type')).toBe('thread');
          expect(url.searchParams.get('container_id')).toBe('omt_topic');
          payload = { code: 0, data: { items: [rawMessage('om_reply')], has_more: false } };
        } else if (/\/messages\/om_(root|reply|other)$/.test(url.pathname)) payload = { code: 0, data: { items: [rawMessage(url.pathname.split('/').at(-1)!)] } };
        else throw new Error(`Unexpected Lark request: ${url.pathname}`);
        return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } });
      }, { appId: config.appId, appSecret: config.appSecret });
      await registerLarkAgentToolRoutes(app, new LarkAgentToolsService(capabilities, repos.config, { clientFactory: () => client }));
      const list = await app.inject({ method: 'GET', url: '/api/lark/agent-tools/messages', headers });
      expect(list.statusCode).toBe(200);
      expect(list.json().messages).toMatchObject([{ messageId: 'om_reply', threadId: 'omt_topic' }]);
      const read = await app.inject({ method: 'GET', url: '/api/lark/agent-tools/message?messageId=om_reply', headers });
      expect(read.statusCode).toBe(200);
      expect(read.json()).toMatchObject({ messageId: 'om_reply', content: 'scoped' });
      const reply = await app.inject({ method: 'POST', url: '/api/lark/agent-tools/send', headers, payload: { content: 'scoped', replyTo: 'om_reply', inThread: true } });
      expect(reply.statusCode).toBe(200);
      expect(reply.json()).toMatchObject({ messageId: 'om_sent' });
      const crossThread = await app.inject({ method: 'POST', url: '/api/lark/agent-tools/send', headers, payload: { content: 'blocked', replyTo: 'om_other', inThread: true } });
      expect(crossThread.statusCode).toBe(403);
      expect(crossThread.json().error.code).toBe('GROUP_REPLY_OUT_OF_SCOPE');
      expect(replies).toEqual(['/open-apis/im/v1/messages/om_reply/reply']);
      expect(requests.some(url => url.pathname.endsWith('/messages/om_root'))).toBe(scenario !== 'native thread');
    } finally {
      await app.close();
      await runtime.shutdown();
      capabilities.close();
      repos.close();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('returns structured authorization instructions without reducing them to HTTP 500', async () => {
    const service = {
      self: vi.fn(async () => { throw new AgentGroupToolError('GROUP_TOOL_AUTHORIZATION_REQUIRED', '请管理员授权', 403, {
        requiredScopes: ['im:message:readonly'], authorizationUrl: 'https://open.larkoffice.com/app/cli_test/auth', instruction: '请管理员开通权限并发布版本'
      }); })
    };
    const app = Fastify(); apps.push(app); await registerLarkAgentToolRoutes(app, service as any);
    const result = await app.inject({ method: 'GET', url: '/api/lark/agent-tools/self', headers: { authorization: 'Bearer scoped-token' } });
    expect(result.statusCode).toBe(403);
    expect(result.json().error).toEqual({
      code: 'GROUP_TOOL_AUTHORIZATION_REQUIRED', message: '请管理员授权', requiredScopes: ['im:message:readonly'],
      authorizationUrl: 'https://open.larkoffice.com/app/cli_test/auth', instruction: '请管理员开通权限并发布版本'
    });
  });
});

it('forwards explicit final and current-turn token unchanged', async () => {
  const send = vi.fn(async () => ({ messageId: 'om_final' }));
  const app = Fastify(); apps.push(app);
  await registerLarkAgentToolRoutes(app, { send } as any);
  const result = await app.inject({ method: 'POST', url: '/api/lark/agent-tools/send',
    headers: { authorization: 'Bearer session-token' }, payload: { content: 'answer', final: true, turn: 'signed-turn' } });
  expect(result.statusCode).toBe(200);
  expect(send).toHaveBeenCalledWith('session-token', { content: 'answer', final: true, turn: 'signed-turn' });
});

it('forwards handoff and reply-agent endpoints with bearer tokens and payload', async () => {
  const handoff = vi.fn(async () => ({ messageId: 'om_handoff' }));
  const replyAgent = vi.fn(async () => ({ messageId: 'om_reply_agent' }));
  const app = Fastify(); apps.push(app);
  await registerLarkAgentToolRoutes(app, { handoff, replyAgent } as any);

  const handoffRes = await app.inject({
    method: 'POST',
    url: '/api/lark/agent-tools/handoff',
    headers: { authorization: 'Bearer session-token' },
    payload: { to: 'Bot B', content: 'brief', turn: 'turn-token' }
  });
  expect(handoffRes.statusCode).toBe(200);
  expect(handoff).toHaveBeenCalledWith('session-token', { to: 'Bot B', content: 'brief', turn: 'turn-token' });

  const replyRes = await app.inject({
    method: 'POST',
    url: '/api/lark/agent-tools/reply-agent',
    headers: { authorization: 'Bearer session-token' },
    payload: { content: 'result', turn: 'turn-token' }
  });
  expect(replyRes.statusCode).toBe(200);
  expect(replyAgent).toHaveBeenCalledWith('session-token', { content: 'result', turn: 'turn-token' });
});
