import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { DutydeckRuntime } from '@dutydeck/runtime';
import { agentConfigSchema } from '@dutydeck/shared';
import { createRepositories } from '@dutydeck/storage';
import { PluginHookBus } from './hooks.js';
import { PluginRuntimeHooks } from './integration.js';

it.each(['normal', 'approval', 'unknown'] as const)('preserves the host callback trace for %s execution', async scenario => {
  const cwd = await mkdtemp(join(tmpdir(), 'host-contract-'));
  const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' });
  const trace: unknown[][] = [];
  const hooks = new PluginRuntimeHooks(new PluginHookBus([{
    kind: 'handler', plugin: 'sample', scope: 'global', timeout: 1_000, event: 'task.completed',
    handler: input => { trace.push([input.event, input.sessionId, input.taskId, input.attemptId]); return {}; }
  }]));
  let release!: () => void;
  const approved = new Promise<void>(resolve => { release = resolve; });
  const runtime = new DutydeckRuntime(repos, {
    admitTask: async (session, request) => { trace.push(['admit', session.id, request.prompt]); },
    authorizeTask: async (session, task, phase) => { trace.push([phase, session.id, task.id]); },
    observeTurn: async (session, id, phase) => { trace.push([phase, session.id, id, repos.execution.getTaskExecution(id)?.task.status]); },
    recordUsage: async (session, attempt, reading) => { trace.push(['usage', session.id, attempt.taskId, attempt.attemptId, reading]); },
    reviewPermission: async (session, request) => { trace.push(['review', session.id, request.title]); return undefined; },
    onTaskSettled: async (session, task) => { trace.push(['settled', session.id, task.id, task.status]); await hooks.taskCompleted(session, task); },
    onVerificationCompleted: (session, result) => { trace.push(['verified', session.id, result.id, result.taskId, result.status]); },
    probe: () => ({ protocol: 'acp', available: true, resume: true, pause: false }),
    driverFactory: (_agent, _protocol, emit) => ({
      start: async () => {}, resume: async () => {}, stop: async () => {}, interrupt: async () => {}, isStopped: async () => true,
      resolvePermission: async () => true,
      send: async () => {
        if (scenario === 'approval') {
          emit({ type: 'permission_request', data: { id: 'p', title: 'Proceed?', status: 'pending' } });
          await approved;
        }
        if (scenario !== 'unknown') {
          emit({ type: 'text', data: { text: 'done' } });
          emit({ type: 'completed', data: { stopReason: 'end_turn' } });
        }
      }
    })
  });
  try {
    execFileSync('git', ['init', '-q', cwd]);
    execFileSync('git', ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-qm', 'initial']);
    await runtime.initialize([agentConfigSchema.parse({ id: 'fixture', name: 'Fixture', command: process.execPath, protocol: 'acp', cwd })]);
    const { id } = await runtime.start({ agentId: 'fixture' });
    const sent = runtime.send(id, 'request');
    if (scenario === 'approval') {
      await vi.waitFor(() => expect(runtime.getPendingPermissions(id)).toHaveLength(1));
      await runtime.resolvePermission(id, runtime.getPendingPermissions(id)[0]!.id, true);
      release();
    }
    const task = await sent;
    const attempt = repos.execution.getTaskExecution(task.id)!.currentAttempt!.attemptId;
    const expected: unknown[][] = [['admit', id, 'request'], ['prepare', id, task.id], ['submit', id, task.id], ['start', id, task.id, 'running']];
    if (scenario === 'approval') expected.push(['review', id, 'Proceed?']);
    if (scenario !== 'unknown') expected.push(['usage', id, task.id, attempt, undefined]);
    expected.push(['end', id, task.id, 'running']);
    if (scenario === 'unknown') expect(task.status).toBe('reconcile_required');
    else {
      expected.push(['settled', id, task.id, 'completed'], ['task.completed', id, task.id, attempt]);
      const result = await runtime.runVerification(id, { command: 'true' });
      expected.push(['verified', id, result.id, task.id, 'passed']);
    }
    expect(trace).toEqual(expected);
  } finally { release(); await runtime.shutdown(); repos.close(); await rm(cwd, { recursive: true, force: true }); }
});
