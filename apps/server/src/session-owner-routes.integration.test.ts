import { afterEach, describe, expect, it } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import { DutydeckRuntime, type AgentDriver } from '@dutydeck/runtime';
import type { AgentConfig } from '@dutydeck/shared';
import { buildApp } from './app.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

/** 真实 Runtime + 账本；队列暂停领取，消息留在队列里。请求头 x-source 决定授权来源（默认本机所有者）。 */
async function harness(skillRequests?: string[], legacy = false) {
  const repos = createRepositories(':memory:', { newDatabaseAuthority: legacy ? 'legacy' : 'ledger_v1' });
  const prompts: string[] = [];
  const runtime = new DutydeckRuntime(repos, {
    prepareTaskPrompt: async (_session, prompt) => ({
      agentPrompt: prompt,
      skillDeliveries: [{ name: 'auto-skill', path: '/skills/auto/SKILL.md', source: 'plugin', digest: 'digest', mode: 'prompt', required: true }]
    }),
    probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }),
    driverFactory: (_config, _protocol, emit) => {
      const driver: AgentDriver = { isIdle: () => true, hasBackgroundWork: () => false, start: async () => {}, resume: async () => {}, stop: async () => {}, isStopped: async () => true, interrupt: async () => {},
        send: async prompt => { prompts.push(typeof prompt === 'string' ? prompt : prompt.prompt); emit({ type: 'text', data: { text: 'done' } }); emit({ type: 'completed', data: { stopReason: 'end_turn' } }); } };
      return driver;
    }
  });
  const config: AgentConfig = { id: 'agent', name: 'Agent', command: 'agent-acp', args: [], protocol: 'acp', cwd: '/tmp', env: {}, permissionMode: 'ask', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };
  const legacySession = { id: 'legacy_session', agentId: config.id, cwd: config.cwd!, runId: 'legacy_run', state: 'idle' as const, protocol: 'acp' as const,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const legacyTask = { id: 'legacy_task', sessionId: legacySession.id, prompt: '旧任务', status: 'queued',
    createdAt: legacySession.createdAt, updatedAt: legacySession.updatedAt,
    executionContext: { agentPrompt: '旧任务', skillDeliveries: [
      { name: 'review', path: '/skills/review/SKILL.md', source: 'workspace' as const, digest: 'digest', mode: 'prompt' as const }
    ] } };
  if (legacy) {
    await repos.sessions.save(legacySession);
    await repos.tasks.create!(legacyTask);
    repos.execution.upgradeLegacy();
  }
  runtime.setQueueHeld(true);
  await runtime.initialize([config]);
  const app = await buildApp(runtime, { executionPolicy: { authorize: async (request, _id, _boundary, action) =>
    ({ allowed: true, action, code: 'allowed', reason: '', source: (request.headers['x-source'] as 'owner' | 'group_policy' | undefined) ?? 'owner' }) } });
  cleanups.push(async () => { await app.close(); await runtime.shutdown(); repos.close(); });
  const session = legacy ? legacySession : await runtime.start({ agentId: config.id });
  const send = async (prompt: string) => (await app.inject({ method: 'POST', url: `/api/sessions/${session.id}/send`, payload: { prompt, skillRequests } })).json().task as { id: string };
  const queued = legacy ? legacyTask : await send('queued');
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

  it('returns the original selected skills from the queue ledger on cancellation', async () => {
    const skillRequests = ['/skills/review/SKILL.md', '/skills/check/SKILL.md'];
    const h = await harness(skillRequests);
    const cancelled = await h.app.inject({ method: 'DELETE', url: `/api/sessions/${h.session.id}/queue/${h.queued.id}` });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).toMatchObject({ id: h.queued.id, status: 'cancelled', skillRequests,
      skillDeliveries: [expect.objectContaining({ name: 'auto-skill', required: true })] });
    expect(h.prompts).toEqual([]);
  });

  it('replays the same queue cancellation with its original Skills after losing the response', async () => {
    const skillRequests = ['/skills/review/SKILL.md'];
    const h = await harness(skillRequests);
    const url = `/api/sessions/${h.session.id}/queue/${h.queued.id}`;
    const headers = { 'x-dutydeck-operation-id': 'Edit_queue:1-'.padEnd(100, 'a') };
    const first = await h.app.inject({ method: 'DELETE', url, headers });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ id: h.queued.id, status: 'cancelled', prompt: 'queued', skillRequests });
    const retry = await h.app.inject({ method: 'DELETE', url, headers });
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toEqual(first.json());
    for (const headers of [undefined, { 'x-dutydeck-operation-id': 'other-operation' }]) {
      const other = await h.app.inject({ method: 'DELETE', url, headers });
      expect(other.statusCode).toBe(409);
      expect(other.json().error.code).toBe('TASK_NOT_QUEUED');
      expect(other.json().skillRequests).toBeUndefined();
    }
    expect(await h.status(h.queued.id)).toBe('cancelled');
    expect(h.prompts).toEqual([]);
  });

  it('rejects malformed queue cancellation operation IDs before cancelling', async () => {
    const h = await harness();
    const url = `/api/sessions/${h.session.id}/queue/${h.queued.id}`;
    for (const value of ['', 'a'.repeat(101), 'a/b', 'a b', 'one,two']) {
      const response = await h.app.inject({ method: 'DELETE', url, headers: { 'x-dutydeck-operation-id': value } });
      expect(response.statusCode).toBe(400);
      expect(await h.status(h.queued.id)).toBe('queued');
    }
  });

  it('keeps cancellation available for migrated Skill tasks that have no original selection', async () => {
    const h = await harness(undefined, true);
    const sessionUrl = `/api/sessions/${h.session.id}`;
    const listed = await h.app.inject({ method: 'GET', url: `${sessionUrl}/tasks` });
    expect(listed.json()).toMatchObject([{ id: h.queued.id, status: 'queued', canEditQueued: false }]);
    const cancelled = await h.app.inject({ method: 'DELETE', url: `${sessionUrl}/queue/${h.queued.id}` });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).toMatchObject({ id: h.queued.id, status: 'cancelled', canEditQueued: false });
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
