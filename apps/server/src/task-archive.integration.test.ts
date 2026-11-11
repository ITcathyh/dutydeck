import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import { DutydeckRuntime } from '@dutydeck/runtime';
import type { AgentConfig, AgentDriver } from '@dutydeck/shared';
import { buildApp } from './app.js';
import { runTaskCli } from './task-cli.js';

it('archives through the CLI and HTTP route, stopping the active turn and cancelling its queue', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'task-archive-'));
  const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' });
  let entered!: () => void, finish!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const pending = new Promise<void>(resolve => { finish = resolve; });
  let stopped = false;
  const send = vi.fn(async () => { entered(); await pending; });
  const runtime = new DutydeckRuntime(repos, { driverIdleTimeoutMs: 0,
    probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }),
    driverFactory: (_config, _protocol, emit): AgentDriver => ({
      start: async () => {}, resume: async () => {}, interrupt: async () => {}, send,
      stop: async () => { stopped = true; emit({ type: 'completed', data: { stopReason: 'cancelled' } }); finish(); },
      isStopped: async () => stopped
    })
  });
  const agent: AgentConfig = { id: 'fixture', name: 'Fixture', command: 'unused', args: [], protocol: 'acp', cwd: directory, env: {}, permissionMode: 'ask', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };
  const app = await buildApp(runtime, { executionPolicy: { authorize: async (_request, _id, _boundary, action) => ({ allowed: true, action, source: 'owner' }) } });
  try {
    await runtime.initialize([agent]);
    const session = await runtime.start({ agentId: agent.id });
    const active = await runtime.dispatch(session.id, 'active', 'queue', 'active', undefined, 'installation_owner');
    await started;
    const queued = await runtime.dispatch(session.id, 'queued', 'queue', 'queued', undefined, 'installation_owner');
    const audit = vi.spyOn(runtime, 'recordClientAudit');
    const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const response = await app.inject({ method: init?.method as 'POST', url: new URL(String(url)).pathname, payload: init?.body as string, headers: init?.headers as Record<string, string> });
      return new Response(response.body, { status: response.statusCode, headers: { 'content-type': 'application/json' } });
    });
    expect(await runTaskCli({ action: 'archive', id: session.id, client: 'rovetap', url: 'http://127.0.0.1:4310', database: '/placeholder.db' }, { fetcher, readToken: () => 'test-token', readState: () => undefined })).toEqual({ archived: true });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(audit).toHaveBeenCalledWith(session.id, 'archive', 'rovetap');
    expect(stopped).toBe(true);
    expect(await runtime.getSession(session.id)).toMatchObject({ state: 'stopped', archivedAt: expect.any(String) });
    const tasks = await runtime.getTasks(session.id);
    expect(tasks.find(t => t.id === active.id)?.status).toBe('reconcile_required');
    expect(repos.execution.getTaskExecution(active.id)?.currentAttempt).toMatchObject({ state: 'settled', outcome: 'unknown', settlement: { kind: 'manual', decision: { actor: { kind: 'installation_owner', id: 'installation_owner' } } } });
    expect(tasks.find(t => t.id === queued.id)?.status).toBe('cancelled');
    expect(send).toHaveBeenCalledTimes(1);
    expect((await app.inject('/api/tasks?recent=true')).json()).toEqual({ tasks: [], archivable: [] });
    await expect(runtime.dispatch(session.id, 'after archive')).rejects.toMatchObject({ code: 'SESSION_ARCHIVED' });
  } finally { finish(); await app.close(); await runtime.shutdown(); repos.close(); await rm(directory, { recursive: true, force: true }); }
});
