import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DutydeckRuntime } from '@dutydeck/runtime';
import { createRepositories } from '@dutydeck/storage';
import type { AgentConfig, DriverFactory } from '@dutydeck/shared';
import { buildApp } from './app.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
it('projects real Runtime prefixes, queued successor events, canonical identity and final text fragments', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'history-runtime-'));
  const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' });
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  let sends = 0;
  const driverFactory: DriverFactory = (_agent, _protocol, emit) => ({ start: async () => {}, resume: async () => {}, stop: async () => {}, interrupt: async () => {}, isIdle: () => true, isStopped: async () => true,
    send: async () => {
      sends++;
      if (sends === 1) { entered(); await gate; }
      emit({ type: 'tool_call', data: { id: 'tool', name: 'read', input: { path: '/sample' } } });
      emit({ type: 'tool_result', data: { id: 'tool', status: 'completed', output: 'canonical-large-body'.repeat(50_000), parts: [{ type: 'resource_link', uri: 'file:///sample-result' }] } });
      for (const text of ['final ', 'text ', 'fragments']) emit({ type: 'text', data: { text } });
      emit({ type: 'completed', data: { stopReason: 'end_turn' } });
    } });
  const runtime = new DutydeckRuntime(repos, { driverFactory, cleanupIntervalMs: 0 });
  cleanup.push(async () => { release(); await runtime.shutdown(); repos.close(); await rm(directory, { recursive: true, force: true }); });
  const agent: AgentConfig = { id: 'sample', name: 'Sample', protocol: 'acp', command: process.execPath, args: [], cwd: directory, env: {}, permissionMode: 'ask', timeout: 60, capabilities: { pause: false, resume: true }, builtin: false };
  await runtime.initialize([agent]); const session = await runtime.start({ agentId: agent.id });
  const first = await runtime.dispatch(session.id, 'first instruction', 'queue', 'request-first', undefined, 'installation_owner');
  await started;
  const second = await runtime.dispatch(session.id, 'queued instruction', 'queue', 'request-second', undefined, 'installation_owner');
  release();
  await expect.poll(async () => (await runtime.getTasks(session.id)).every(task => task.status === 'completed')).toBe(true);
  const canonical = await runtime.getEvents(session.id);
  expect(canonical[0]?.type).toBe('status');
  expect(canonical.some(event => event.type === 'task' && (event.data as any).task?.id === second.id && (event.data as any).task.status === 'queued')).toBe(true);
  const outline = await runtime.getHistoryOutline(session.id);
  expect(outline.turns).toHaveLength(2);
  expect(outline.turns.map(turn => turn.taskId)).toEqual([first.id, second.id]);
  expect(outline.turns.every(turn => turn.output.text === 'final text fragments')).toBe(true);
  expect(outline.turns[0]?.firstSequence).toBe(1);
  for (const turn of outline.turns) {
    expect(turn.attemptId).toBe(repos.execution.getTaskExecution(turn.taskId!)?.attempts.at(-1)?.attemptId);
    expect(turn.artifactReferences).toHaveLength(1);
    expect(turn.artifactReferences[0]).toMatchObject({ taskId: turn.taskId, attemptId: turn.attemptId, uri: 'file:///sample-result' });
  }
  const app = await buildApp(runtime); cleanup.push(() => app.close());
  const response = await app.inject({ method: 'GET', url: `/api/sessions/${session.id}/history` });
  expect(response.statusCode).toBe(200); expect(response.json()).toEqual(outline);
  expect(response.body).not.toContain('canonical-large-body');
  const detail = await app.inject({ method: 'GET', url: `/api/sessions/${session.id}/events?after=${outline.turns[0]!.firstSequence - 1}&before=${outline.turns[0]!.lastSequence + 1}&limit=200&direction=forward` });
  expect(detail.body).toContain('canonical-large-body');
  const denied = await buildApp(runtime, { executionPolicy: { authorize: async () => ({ allowed: false, action: 'task.view_result', code: 'forbidden', reason: 'denied', source: 'integration' }) } }); cleanup.push(() => denied.close());
  expect((await denied.inject({ method: 'GET', url: `/api/sessions/${session.id}/history` })).statusCode).toBe(403);
});
