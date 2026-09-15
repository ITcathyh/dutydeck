import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepositories } from '@dutydeck/storage';
import type { AgentConfig, AgentDriver, BoundExecutionRepository, NormalizedDriverEvent, ToolCallData } from '@dutydeck/shared';
import { DutydeckRuntime } from './index.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });
const agent: AgentConfig = { id: 'tools', name: 'Tools', command: process.execPath, args: [], env: {}, protocol: 'jsonl', permissionMode: 'ask', timeout: 10, builtin: false, capabilities: { pause: false, resume: true } };
type Emit = (event: NormalizedDriverEvent) => void;
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

async function fixture(send: (emit: Emit, prompt: string) => Promise<void>, inspectBound?: (bound: BoundExecutionRepository) => void) {
  const dir = await mkdtemp(join(tmpdir(), 'dutydeck-tool-correlation-'));
  const path = join(dir, 'state.sqlite');
  const repos = createRepositories(path, { newDatabaseAuthority: 'ledger_v1' });
  if (inspectBound) {
    const bind = repos.execution.bind.bind(repos.execution);
    vi.spyOn(repos.execution, 'bind').mockImplementation(claim => { const bound = bind(claim); inspectBound(bound); return bound; });
  }
  const children: Array<{ child: ChildProcess; exited: Promise<unknown> }> = [];
  const emitters: Emit[] = [];
  const runtime = new DutydeckRuntime(repos, { driverIdleTimeoutMs: 0, driverFactory: (_agent, _protocol, emit) => {
    emitters.push(emit);
    let processEntry: typeof children[number] | undefined;
    const stopped = deferred();
    const driver: AgentDriver = {
      start: async () => {
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
        processEntry = { child, exited: once(child, 'exit') }; children.push(processEntry);
        await once(child, 'spawn');
      },
      send: async input => {
        if (typeof input !== 'string') throw new Error('This fixture uses a local-only driver');
        await Promise.race([send(emit, input), stopped.promise.then(() => { throw new Error('Original process stopped'); })]);
      },
      stop: async () => {
        stopped.resolve();
        if (processEntry && processEntry.child.exitCode === null && processEntry.child.signalCode === null) processEntry.child.kill('SIGTERM');
        await processEntry?.exited;
      },
      isStopped: async () => Boolean(processEntry && (processEntry.child.exitCode !== null || processEntry.child.signalCode !== null)),
      interrupt: async () => {}, resume: async () => {}, resolvePermission: async () => true
    };
    return driver;
  } });
  cleanup.push(async () => {
    await runtime.shutdown();
    await Promise.all(children.map(entry => entry.exited));
    repos.close(); await rm(dir, { recursive: true, force: true });
  });
  await runtime.initialize([{ ...agent, cwd: dir }]);
  const session = await runtime.start({ agentId: agent.id, cwd: dir });
  const artifacts = (): ToolCallData[] => {
    const require = createRequire(new URL('../../storage/package.json', import.meta.url));
    const db: { prepare(sql: string): { all(id: string): Array<{ data: string }> }; close(): void } = new (require('better-sqlite3'))(path, { readonly: true });
    try { return db.prepare('SELECT data FROM tool_calls WHERE session_id=? ORDER BY id').all(session.id).map(row => JSON.parse(row.data) as ToolCallData); }
    finally { db.close(); }
  };
  return { runtime, repos, session, emitters, artifacts };
}

function finish(emit: Emit) {
  emit({ type: 'text', data: { text: 'done' } });
  emit({ type: 'completed', data: { stopReason: 'end_turn' } });
}

describe('Attempt tool correlation', () => {
  it.each(['completed', 'failed'] as const)('persists a self-contained %s result and artifact across an event page', async status => {
    const call = Object.freeze({ id: 'native', name: 'read', input: Object.freeze({ path: '.' }), status: 'running' });
    const result = Object.freeze({ id: 'native', output: 'ok', status });
    const h = await fixture(async emit => {
      emit({ type: 'tool_call', sourceId: 'call', data: call });
      for (let n = 0; n < 205; n++) emit({ type: 'status', data: { index: n } });
      emit({ type: 'tool_result', sourceId: 'result', data: result }); finish(emit);
    });
    const task = await h.runtime.send(h.session.id, 'work');
    expect(task.status).toBe('completed');
    const events = await h.runtime.getEvents(h.session.id);
    const start = events.find(event => event.type === 'tool_call')!;
    const end = events.find(event => event.type === 'tool_result')!;
    const data = end.data as ToolCallData;
    expect(end.attemptId).toBe(start.attemptId); expect(end.taskId).toBe(task.id);
    expect(data).toMatchObject({ id: (start.data as ToolCallData).id, name: 'read', input: { path: '.' }, output: 'ok', status, startedAt: (start.data as ToolCallData).startedAt });
    expect(data.id).not.toBe('native');
    expect(Number.isFinite(Date.parse(data.startedAt))).toBe(true);
    expect(Date.parse(data.completedAt!)).toBeGreaterThanOrEqual(Date.parse(data.startedAt));
    expect(h.artifacts()).toEqual([data]);
    const page = h.repos.execution.getAttemptEvents(end.attemptId!, { afterSequence: end.sequence - 1, limit: 1 });
    expect(page[0]?.data).toEqual(data);
    expect(Object.hasOwn(call, 'startedAt')).toBe(false); expect(Object.hasOwn(result, 'input')).toBe(false);
  });

  it('replays an earlier call without new events, timestamps, artifact writes or state regression', async () => {
    const h = await fixture(async emit => {
      const call: NormalizedDriverEvent = { type: 'tool_call', sourceId: 'call', data: { id: 'native', input: 'first', status: 'running' } };
      emit(call);
      emit({ type: 'tool_result', sourceId: 'result', data: { id: 'native', output: 'final', status: 'completed' } });
      emit(call); finish(emit);
    });
    const save = vi.spyOn(h.repos.artifacts, 'saveToolCall');
    expect((await h.runtime.send(h.session.id, 'work')).status).toBe('completed');
    const tools = (await h.runtime.getEvents(h.session.id)).filter(event => event.type === 'tool_call' || event.type === 'tool_result');
    expect(tools).toHaveLength(2); expect(save).toHaveBeenCalledTimes(2);
    expect(h.artifacts()).toEqual([tools[1]!.data]);
    expect(h.artifacts()[0]).toMatchObject({ input: 'first', output: 'final', status: 'completed' });
  });

  it.each(['input', 'raw', 'type'] as const)('rejects a repeated sourceId with changed %s instead of masking it by enrichment', async field => {
    const h = await fixture(async emit => {
      emit({ type: 'tool_call', sourceId: 'same', data: { id: 'native', input: 'original', status: 'running' }, raw: 'original' });
      emit({ type: field === 'type' ? 'tool_result' : 'tool_call', sourceId: 'same',
        data: { id: 'native', input: field === 'input' ? 'changed' : 'original', status: 'running' }, raw: field === 'raw' ? 'changed' : 'original' });
      finish(emit);
    });
    const task = await h.runtime.send(h.session.id, 'work');
    expect(task.status).toBe('reconcile_required');
    const attempt = h.repos.execution.getTaskExecution(task.id)!.currentAttempt!;
    expect(JSON.stringify(attempt)).toContain('EVENT_IDEMPOTENCY_CONFLICT');
    expect((await h.runtime.getEvents(h.session.id)).filter(event => event.type === 'tool_call' || event.type === 'tool_result')).toHaveLength(1);
    expect(h.artifacts()[0]?.input).toBe('original');
  });

  it('keeps provider timing and explicit null input, and never carries a tool into another Attempt', async () => {
    const h = await fixture(async (emit, prompt) => {
      if (prompt === 'first') {
        emit({ type: 'tool_call', sourceId: 'call', data: { id: 'native', name: 'read', input: 'private-first', status: 'running', startedAt: '2026-01-01T00:00:00.000Z' } });
        emit({ type: 'tool_result', sourceId: 'result', data: { id: 'native', input: null, output: 'first', status: 'completed', completedAt: '2026-01-01T00:00:01.000Z' } });
      } else emit({ type: 'tool_result', sourceId: 'result', data: { id: 'native', output: 'second', status: 'completed' } });
      finish(emit);
    });
    await h.runtime.send(h.session.id, 'first'); await h.runtime.send(h.session.id, 'second');
    const results = (await h.runtime.getEvents(h.session.id)).filter(event => event.type === 'tool_result');
    expect(results).toHaveLength(2); expect(results[0]!.attemptId).not.toBe(results[1]!.attemptId);
    expect(results[0]!.data).toMatchObject({ input: null, startedAt: '2026-01-01T00:00:00.000Z', completedAt: '2026-01-01T00:00:01.000Z' });
    const second = results[1]!.data as ToolCallData;
    expect(Object.hasOwn(second, 'input')).toBe(false); expect(second.name).toBe('tool');
    expect(second.id).not.toBe((results[0]!.data as ToolCallData).id); expect(h.artifacts()).toHaveLength(2);
  });

  it('does not correlate old driver callbacks into a replacement generation', async () => {
    const h = await fixture(async (emit, prompt) => {
      if (prompt === 'second') h.emitters[0]!({ type: 'tool_result', sourceId: 'old', data: { id: 'native', input: 'old-driver', status: 'completed' } });
      emit({ type: 'tool_result', sourceId: 'result', data: { id: 'native', output: prompt, status: 'completed' } }); finish(emit);
    });
    await h.runtime.send(h.session.id, 'first'); await h.runtime.stop(h.session.id);
    await h.runtime.restart(h.session.id);
    expect((await h.runtime.send(h.session.id, 'second')).status).toBe('completed');
    const results = (await h.runtime.getEvents(h.session.id)).filter(event => event.type === 'tool_result');
    expect(results).toHaveLength(2); expect(h.emitters).toHaveLength(2);
    expect(h.artifacts().every(data => !Object.hasOwn(data, 'input'))).toBe(true);
  });

  it('reuses the original enrichment after a committed append loses its return', async () => {
    let failed = false;
    const h = await fixture(async emit => {
      const event: NormalizedDriverEvent = { type: 'tool_result', sourceId: 'result', data: { id: 'native', output: 'ok', status: 'completed' } };
      emit(event); emit(event); finish(emit);
    }, bound => {
      const append = bound.appendEvent.bind(bound);
      vi.spyOn(bound, 'appendEvent').mockImplementation((fence, event) => {
        const saved = append(fence, event);
        if (!failed && event.type === 'tool_result') { failed = true; throw new Error('lost committed append return'); }
        return saved;
      });
    });
    const task = await h.runtime.send(h.session.id, 'work');
    expect(failed).toBe(true); expect(task.status).toBe('reconcile_required');
    const results = (await h.runtime.getEvents(h.session.id)).filter(event => event.type === 'tool_result');
    expect(results).toHaveLength(1); expect(h.artifacts()).toEqual([results[0]!.data]);
    expect(JSON.stringify(h.repos.execution.getTaskExecution(task.id))).not.toContain('EVENT_IDEMPOTENCY_CONFLICT');
  });

  it.each([true, false])('inherits a lost call return only when the call is actually durable (committed=%s)', async committed => {
    let failed = false;
    const call: NormalizedDriverEvent = { type: 'tool_call', sourceId: 'call', data: {
      id: 'native', name: 'read_file', input: { path: '/original' }, status: 'running', startedAt: '2026-01-01T00:00:00.000Z'
    } };
    const h = await fixture(async emit => {
      for (let n = 0; n < 205; n++) emit({ type: 'status', data: { index: n } });
      emit(call);
      emit({ type: 'tool_result', sourceId: 'result', data: { id: 'native', output: 'done', status: 'completed', completedAt: '2026-01-01T00:00:01.000Z' } });
      if (committed) emit(call);
      finish(emit);
    }, bound => {
      const append = bound.appendEvent.bind(bound);
      vi.spyOn(bound, 'appendEvent').mockImplementation((fence, event) => {
        if (!failed && event.type === 'tool_call') {
          failed = true;
          if (committed) append(fence, event);
          throw new Error('call write return lost');
        }
        return append(fence, event);
      });
    });
    const task = await h.runtime.send(h.session.id, 'work');
    expect(failed).toBe(true); expect(task.status).toBe('reconcile_required');
    const events = await h.runtime.getEvents(h.session.id);
    expect(events.filter(event => event.type === 'tool_call')).toHaveLength(committed ? 1 : 0);
    const result = events.find(event => event.type === 'tool_result')!.data as ToolCallData;
    expect(result).toMatchObject({ output: 'done', status: 'completed', completedAt: '2026-01-01T00:00:01.000Z' });
    if (committed) expect(result).toMatchObject({ name: 'read_file', input: { path: '/original' }, startedAt: '2026-01-01T00:00:00.000Z' });
    else { expect(Object.hasOwn(result, 'input')).toBe(false); expect(result.name).toBe('tool'); expect(result.startedAt).not.toBe('2026-01-01T00:00:00.000Z'); }
    expect(h.artifacts()).toEqual([result]);
    expect(h.repos.execution.getTaskExecution(task.id)?.currentAttempt?.settlementId).toBeUndefined();
  });
});
