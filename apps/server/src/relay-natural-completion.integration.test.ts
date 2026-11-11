import { expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepositories } from '@dutydeck/storage';
import { agentConfigSchema } from '@dutydeck/shared';
import { DutydeckRuntime } from '@dutydeck/runtime';
import { RelayAskBroker, RelayCapabilityRegistry, relayAskId, type RelayAskRecord } from '@dutydeck/relay';
import { createRelayContinuationChecker } from './relay-routes.js';
import { createRelayAskStore } from './relay-ask-store.js';
import { buildApp } from './app.js';

it.each(['broker', 'ask-wait', 'ask'] as const)('checks durable settlement during natural completion microtasks: %s', async boundary => {
  const directory = await mkdtemp(join(tmpdir(), 'dutydeck-relay-completion-'));
  const repos = createRepositories(join(directory, 'state.db'), { newDatabaseAuthority: 'ledger_v1' });
  let entered = () => {}, complete = () => {};
  const agent = agentConfigSchema.parse({ id: 'fixture', name: 'Fixture', command: process.execPath, protocol: 'acp', cwd: directory });
  const runtime = new DutydeckRuntime(repos, { cleanupIntervalMs: 0,
    probe: () => ({ protocol: 'acp', available: true, pause: false, resume: false }),
    driverFactory: (_agent, _protocol, emit) => ({
      start: async () => {}, resume: async () => {}, isStopped: async () => true,
      send: async () => {
        emit({ type: 'text', data: { text: 'waiting' } });
        await new Promise<void>(resolve => {
          complete = () => { emit({ type: 'completed', data: { stopReason: 'end_turn' } }); resolve(); };
          entered();
        });
      },
      interrupt: async () => { complete(); }, stop: async () => { complete(); }
    })
  });
  const store = createRelayAskStore(repos.config);
  const broker = new RelayAskBroker({ publish: async () => {} }, store);
  const capabilities = new RelayCapabilityRegistry({ get: id => runtime.getSession(id) }, 'http://localhost', 'fixture');
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  type Snapshot = { status?: string; owner?: string; result: string };
  const observations: Array<{ outcome: string; last: Snapshot }> = [];
  let snapshots: Snapshot[] = [];
  let terminalOwners = 0;
  let started = () => {};
  const capture = runtime.captureSessionContinuation.bind(runtime);
  vi.spyOn(runtime, 'captureSessionContinuation').mockImplementation(id => {
    const guard = capture(id);
    started();
    return expected => {
      const result = guard(expected);
      if (expected?.taskId) snapshots.push({ result, status: repos.execution.getTaskExecutionState(expected.taskId)?.task.status,
        owner: runtime.getActiveTaskContext(id)?.attemptId });
      return result;
    };
  });
  try {
    await runtime.initialize([agent]);
    const session = await runtime.start({ agentId: agent.id, cwd: directory });
    broker.setContinuationChecker(createRelayContinuationChecker(runtime));
    await broker.initialize();
    app = await buildApp(runtime, { relay: { runtime, broker, capabilities } });
    for (let delay = boundary === 'broker' ? -40 : 0; delay < 100; delay++) {
      const sending = new Promise<void>(resolve => { entered = resolve; });
      await runtime.dispatch(session.id, `probe ${delay}`);
      await sending;
      const owner = runtime.getActiveTaskContext(session.id)!;
      const record: RelayAskRecord = { id: relayAskId(session.id, `q${delay}`), version: 1, mode: 'return-answer',
        requestId: `q${delay}`, sessionId: session.id, question: 'Proceed?', timeoutMs: 60_000, status: 'answered', answer: 'yes', ...owner,
        createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() };
      await store.compareAndSet(undefined, record);
      snapshots = [];
      if (delay < 0) { complete(); for (let step = 0; step < -delay; step++) await Promise.resolve(); }
      const captured = new Promise<void>(resolve => { started = resolve; });
      const checked = boundary === 'broker' ? broker.wait(session.id, record.requestId!).then(value => value.status)
        : app.inject({ method: 'POST', url: `/api/relay/sessions/${session.id}/${boundary}`,
          headers: { authorization: `Bearer ${capabilities.tokenFor(session.id)}` },
          payload: boundary === 'ask' ? { requestId: record.requestId, question: record.question, timeoutMs: record.timeoutMs } : { requestId: record.requestId }
        }).then(response => { expect(response.statusCode).toBe(200); return response.json().status as string; });
      await captured;
      for (let step = 0; step < delay; step++) await Promise.resolve();
      if (delay >= 0) complete();
      const outcome = await checked;
      expect(snapshots.length).toBeGreaterThan(0);
      const last = snapshots.at(-1)!;
      observations.push({ outcome, last });
      terminalOwners += snapshots.filter(value => value.status === 'completed' && value.owner).length;
      if (last.status !== 'running' || last.result !== 'available') expect(outcome).toBe('cancelled');
      expect(await store.get(record.id)).toEqual(record);
      while (runtime.getActiveTaskContext(session.id)) await new Promise<void>(resolve => setImmediate(resolve));
    }
    // The sweep must reach real terminal ledger state, not merely stop calling an old observation hook.
    expect(observations.some(value => value.last.status === 'completed')).toBe(true);
    if (boundary === 'broker') expect(terminalOwners).toBeGreaterThan(0);
    expect(observations.some(value => value.outcome === 'answered')).toBe(true);
    expect(observations.filter(value => value.outcome === 'answered').every(value => value.last.status === 'running' && value.last.result === 'available')).toBe(true);
  } finally {
    complete(); broker.close(); await broker.flush(); await app?.close(); await runtime.shutdown(); repos.close();
    vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
