import { afterEach, describe, expect, it } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import { DutydeckRuntime, type AgentDriver } from '@dutydeck/runtime';
import type { AgentConfig } from '@dutydeck/shared';
import { buildApp } from './app.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

/** 真实 Runtime + 账本；队列暂停领取，消息留在队列里。请求头 x-source 决定授权来源（默认本机所有者）。 */
async function harness() {
  const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' });
  const prompts: string[] = [];
  const runtime = new DutydeckRuntime(repos, {
    probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }),
    driverFactory: (_config, _protocol, emit) => {
      const driver: AgentDriver = { isIdle: () => true, hasBackgroundWork: () => false, start: async () => {}, resume: async () => {}, stop: async () => {}, isStopped: async () => true, interrupt: async () => {},
        send: async prompt => { prompts.push(typeof prompt === 'string' ? prompt : prompt.prompt); emit({ type: 'text', data: { text: 'done' } }); emit({ type: 'completed', data: { stopReason: 'end_turn' } }); } };
      return driver;
    }
  });
  const config: AgentConfig = { id: 'agent', name: 'Agent', command: 'agent-acp', args: [], protocol: 'acp', cwd: '/tmp', env: {}, permissionMode: 'ask', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };
  await runtime.initialize([config]);
  const app = await buildApp(runtime, { executionPolicy: { authorize: async (request, _id, _boundary, action) =>
    ({ allowed: true, action, code: 'allowed', reason: '', source: (request.headers['x-source'] as 'owner' | 'group_policy' | undefined) ?? 'owner' }) } });
  cleanups.push(async () => { await app.close(); await runtime.shutdown(); repos.close(); });
  const session = await runtime.start({ agentId: config.id });
  const send = async (prompt: string) => (await app.inject({ method: 'POST', url: `/api/sessions/${session.id}/send`, payload: { prompt } })).json().task as { id: string };
  runtime.setQueueHeld(true);
  const queued = await send('queued');
  const status = async (taskId: string) => (await runtime.getTasks(session.id)).find(task => task.id === taskId)?.status;
  expect(await status(queued.id)).toBe('queued');
  return { app, runtime, session, queued, prompts, status };
}

describe('owner session routes with the real execution ledger', () => {
  it('lets the local owner cancel a queued task while other callers keep the named-actor requirement', async () => {
    const h = await harness();
    const url = `/api/sessions/${h.session.id}/queue/${h.queued.id}`;
    const other = await h.app.inject({ method: 'DELETE', url, headers: { 'x-source': 'group_policy' } });
    expect(other.statusCode).toBe(409);
    expect(other.json().error.code).toBe('RECOVERY_DECISION_REQUIRED');
    expect(await h.status(h.queued.id)).toBe('queued');
    const cancelled = await h.app.inject({ method: 'DELETE', url });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).toMatchObject({ id: h.queued.id, status: 'cancelled' });
    expect(await h.status(h.queued.id)).toBe('cancelled');
    expect(h.prompts).toEqual([]);
  });

  it('lets the local owner archive a session that still has queued work', async () => {
    const h = await harness();
    const url = `/api/sessions/${h.session.id}/archive`;
    const other = await h.app.inject({ method: 'POST', url, headers: { 'x-source': 'group_policy' } });
    expect(other.statusCode).toBe(403);
    expect(other.json().error.code).toBe('ACTOR_REQUIRED');
    const archived = await h.app.inject({ method: 'POST', url });
    expect(archived.statusCode).toBe(200);
    expect(archived.json().archivedAt).toEqual(expect.any(String));
    expect(await h.status(h.queued.id)).toBe('cancelled');
    expect(h.prompts).toEqual([]);
  });
});
