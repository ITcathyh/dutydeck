import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentGroupToolError } from './agent-tools.js';
import { registerLarkAgentToolRoutes } from './agent-tools-routes.js';

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });

describe('Agent group tool HTTP boundary', () => {
  it('forwards the bearer capability and typed options to the domain service', async () => {
    const service = {
      self: vi.fn(), peers: vi.fn(), members: vi.fn(async () => ({ chatId: 'oc_group', members: [] })),
      messages: vi.fn(async () => ({ chatId: 'oc_group', messages: [] })),
      wait: vi.fn(), send: vi.fn(async () => ({ messageId: 'om_sent' }))
    };
    const app = Fastify(); apps.push(app); await registerLarkAgentToolRoutes(app, service as any);
    const messages = await app.inject({ method: 'GET', url: '/api/lark/agent-tools/messages?after=cursor&limit=7', headers: { authorization: 'Bearer scoped-token' } });
    const members = await app.inject({ method: 'GET', url: '/api/lark/agent-tools/members', headers: { authorization: 'Bearer scoped-token' } });
    const sent = await app.inject({ method: 'POST', url: '/api/lark/agent-tools/send', headers: { authorization: 'Bearer scoped-token' }, payload: { content: 'hello', to: 'cli_peer', replyTo: 'om_parent', inThread: true } });
    expect(messages.statusCode).toBe(200); expect(members.statusCode).toBe(200); expect(sent.statusCode).toBe(200);
    expect(service.members).toHaveBeenCalledWith('scoped-token');
    expect(service.messages).toHaveBeenCalledWith('scoped-token', { after: 'cursor', limit: 7 });
    expect(service.send).toHaveBeenCalledWith('scoped-token', { content: 'hello', to: 'cli_peer', replyTo: 'om_parent', inThread: true });
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
