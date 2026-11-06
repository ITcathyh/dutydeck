import { afterEach, expect, it, vi } from 'vitest';

const discover = vi.hoisted(() => vi.fn());
vi.mock('./agent-models.js', async importOriginal => ({ ...await importOriginal<typeof import('./agent-models.js')>(), discoverAgentModels: discover }));
const { buildApp } = await import('./app.js');

const apps: Array<{ close: () => Promise<unknown> }> = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); discover.mockReset(); });

const session = { id: 's1', agentId: 'acp-agent', state: 'idle', cwd: '/repo', model: 'model-a', permissionMode: 'ask', runId: 'r1', createdAt: '', updatedAt: '' };
const agent = { id: 'acp-agent', name: 'ACP', protocol: 'acp', command: 'agent', args: [], env: {}, cwd: '/tmp', permissionMode: 'ask', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };
async function setup() {
  const runtime: any = { getSession: vi.fn(async () => session), listAgents: vi.fn(async () => [agent]),
    setModel: vi.fn(async (_id: string, model: string) => ({ ...session, model })), setReasoningEffort: vi.fn(async (_id: string, reasoningEffort: string) => ({ ...session, reasoningEffort })) };
  const sessionAgentConfig = vi.fn(async (value: typeof agent) => ({ ...value, env: { scoped: '1' } }));
  const app = await buildApp(runtime, { sessionAgentConfig } as any); apps.push(app);
  return { app, runtime, sessionAgentConfig };
}

it('rejects a model or effort the Agent does not offer before touching the runtime', async () => {
  discover.mockResolvedValue({ models: [{ id: 'model-a', name: 'A' }, { id: 'model-b', name: 'B' }], reasoningEfforts: [{ id: 'low', name: 'low' }, { id: 'high', name: 'high' }] });
  const h = await setup();
  const typo = await h.app.inject({ method: 'PATCH', url: '/api/sessions/s1/config', payload: { model: 'model-typo' } });
  expect(typo.statusCode).toBe(422);
  expect(typo.json().error).toMatchObject({ code: 'INVALID_SESSION_CONFIG', message: expect.stringContaining('model-typo') });
  const effort = await h.app.inject({ method: 'PATCH', url: '/api/sessions/s1/config', payload: { reasoningEffort: 'extreme' } });
  expect(effort.statusCode).toBe(422);
  expect(h.runtime.setModel).not.toHaveBeenCalled(); expect(h.runtime.setReasoningEffort).not.toHaveBeenCalled();
  // 探测用会话实际启动的配置：会话级 Agent 设置、当前模型和目录。
  expect(discover).toHaveBeenCalledWith(expect.objectContaining({ env: { scoped: '1' }, model: 'model-a', cwd: '/repo' }), 'model-a');
  expect((await h.app.inject({ method: 'PATCH', url: '/api/sessions/s1/config', payload: { model: 'model-b' } })).json()).toMatchObject({ model: 'model-b' });
  expect((await h.app.inject({ method: 'PATCH', url: '/api/sessions/s1/config', payload: { reasoningEffort: 'high' } })).json()).toMatchObject({ reasoningEffort: 'high' });
});

it('leaves the decision to the runtime when the Agent publishes no options or the probe fails', async () => {
  discover.mockResolvedValueOnce({ models: [], reasoningEfforts: [] }).mockRejectedValueOnce(new Error('probe failed'));
  const h = await setup();
  expect((await h.app.inject({ method: 'PATCH', url: '/api/sessions/s1/config', payload: { model: 'anything' } })).statusCode).toBe(200);
  expect((await h.app.inject({ method: 'PATCH', url: '/api/sessions/s1/config', payload: { model: 'other' } })).statusCode).toBe(200);
  expect(h.runtime.setModel).toHaveBeenCalledTimes(2);
});
