import Fastify from 'fastify';
import { expect, it } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import type { Session } from '@dutydeck/shared';
import { loadOrCreateGroupToolsSigningSecret } from './turn-token.js';
import { AgentGroupToolError, LarkAgentToolCapabilityRegistry, LarkAgentToolsService } from '../lark/agent-tools.js';
import { registerLarkAgentToolRoutes, registerLarkAgentToolTurnGuard } from '../lark/agent-tools-routes.js';

it('issues a web capability only with explicit opt-in and requires a channel for Lark operations', async () => {
  const repos = createRepositories(':memory:');
  const app = Fastify();
  const session: Session = { id: 'web', runId: 'run', agentId: 'test', cwd: '/tmp', state: 'thinking', source: 'web', createdAt: '', updatedAt: '' };
  const defaults = new LarkAgentToolCapabilityRegistry(repos.sessions, 'https://local.test');
  const enabled = new LarkAgentToolCapabilityRegistry(repos.sessions, 'https://local.test', 'synthetic', 'dutydeck', { allowUnboundSessions: true });
  try {
    await repos.sessions.save(session);
    expect(JSON.stringify(defaults.environmentFor(session))).toBe('{}');
    const env = enabled.environmentFor(session);
    expect(env.dutydeck_group_tools_token).toBeTruthy();
    const turn = enabled.finalTurnToken(session.id, 'task', 'attempt');
    const active = () => ({ taskId: 'task', attemptId: 'attempt', actorId: 'owner' });
    expect(await enabled.resolveCapabilityTurn(env.dutydeck_group_tools_token, turn, active)).toMatchObject({
      session: { id: session.id }, ...active(), channel: undefined
    });
    const tools = new LarkAgentToolsService(enabled, repos.config, { workbenchTask: active });
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof AgentGroupToolError) return reply.code(error.statusCode).send(error.response());
      throw error;
    });
    registerLarkAgentToolTurnGuard(app, tools);
    await registerLarkAgentToolRoutes(app, tools);
    for (const name of ['send', 'send-file', 'handoff']) {
      const response = await app.inject({ method: 'POST', url: '/api/lark/agent-tools/' + name, payload: { turn },
        headers: { authorization: 'Bearer ' + env.dutydeck_group_tools_token } });
      expect([response.statusCode, response.json().error.code]).toEqual([403, 'CHANNEL_BINDING_REQUIRED']);
    }
  } finally { await app.close(); repos.close(); }
});

it('restores a retained task with its previously issued environment and turn', async () => {
  const repos = createRepositories(':memory:');
  try {
    const session: Session = { id: 'ses_A', runId: 'run', agentId: 'test', cwd: '/tmp', state: 'thinking',
      source: 'lark', sourceId: 'cli_bot:oc_chat:group', createdAt: '', updatedAt: '' };
    await repos.sessions.save(session);
    await repos.config.set('lark.group_tools.signing_secret', 'synthetic-compatibility');
    const authority = new LarkAgentToolCapabilityRegistry(repos.sessions, 'https://local.test/', await loadOrCreateGroupToolsSigningSecret(repos.config));
    const bearer = 'v1.Z2eeeQzYLLbDzRtdR7eZcdDfXQrR-pghGX5LJXsY9i4';
    const turn = 'efA2NjyZ2Hl_Q2EwthVprWXk9pLInq8t5_EXQewo6w0';
    expect(authority.environmentFor(session)).toEqual({
      dutydeck_group_tools_url: 'https://local.test/api/lark/agent-tools',
      dutydeck_group_tools_token: bearer,
      dutydeck_group_tools_command: 'dutydeck'
    });
    const active = { taskId: 'task_B', attemptId: 'attempt_C', actorId: 'ou_actor' };
    expect(await authority.resolveChannelTurn(bearer, turn, () => active)).toMatchObject({
      sessionId: session.id, ...active, channel: { chatId: 'oc_chat' }
    });
  } finally { repos.close(); }
});
