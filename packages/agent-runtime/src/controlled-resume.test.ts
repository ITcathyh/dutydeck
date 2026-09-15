import { afterEach, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { createRepositories } from '@dutydeck/storage';
import { agentConfigSchema, type DriverSubmission, type OperationPermit, type Session } from '@dutydeck/shared';
import { DutydeckRuntime } from './index.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

async function fixture(protocol: 'jsonl' | 'pipe') {
  const dir = await mkdtemp(join(tmpdir(), 'controlled-resume-'));
  const log = join(dir, 'prompts.jsonl');
  const repos = createRepositories(join(dir, 'state.sqlite'), { newDatabaseAuthority: 'ledger_v1' });
  const runtime = new DutydeckRuntime(repos, { driverIdleTimeoutMs: 0 });
  cleanup.push(async () => { await runtime.shutdown(); repos.close(); await rm(dir, { recursive: true, force: true }); });
  const agent = agentConfigSchema.parse({ id: protocol, name: protocol, protocol, command: process.execPath,
    args: [new URL('../../transports/tests/fixtures/process-resource-agent.mjs', import.meta.url).pathname], cwd: dir,
    env: { PROCESS_RESOURCE_PROMPT_LOG: log }, timeout: 5, permissionMode: 'ask', capabilities: { pause: false, resume: true } });
  await runtime.initialize([agent]);
  const session = await runtime.start({ agentId: agent.id, cwd: dir, model: 'configured-model', reasoningEffort: 'high' });
  const driver = runtime.getDriver(session.id)!;
  const prompts = async (): Promise<string[]> => (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string);
  const child = (): ChildProcess => {
    const entry = Reflect.get(driver, 'current') as { child: ChildProcess } | undefined;
    if (!entry) throw new Error('Expected an actual live child');
    return entry.child;
  };
  return { repos, runtime, session, driver, child, prompts };
}

describe('controlled default-driver resume', () => {
  it.each(['jsonl', 'pipe'] as const)('keeps %s model/effort and the healthy original child without native configuration proof', async protocol => {
    const h = await fixture(protocol); const child = h.child();
    expect((await h.runtime.send(h.session.id, 'first')).status).toBe('completed');
    await expect(h.runtime.resume(h.session.id)).resolves.toMatchObject({ id: h.session.id, model: 'configured-model', reasoningEffort: 'high' });
    expect(h.child()).toBe(child);
    expect((await h.runtime.send(h.session.id, 'second')).status).toBe('completed');
    expect(await h.prompts()).toEqual(['first', 'second']);
    const resources = h.repos.execution.getResources(h.session.id);
    expect(resources.filter(row => row.kind === 'process')).toHaveLength(1);
    expect(resources.filter(row => row.kind === 'operation').every(row => row.stage === 'created')).toBe(true);
  });

  it.each(['jsonl', 'pipe'] as const)('uses a new permit to resume %s after actual child exit, without resending the old Task', async protocol => {
    const h = await fixture(protocol);
    const first = await h.runtime.send(h.session.id, 'first');
    const before = h.repos.execution.getTaskExecution(first.id)!;
    expect(before.task.status).toBe('completed');
    const original = h.child(), exited = once(original, 'exit'); original.kill('SIGKILL'); await exited;
    await expect(h.runtime.resume(h.session.id)).resolves.toMatchObject({ id: h.session.id });
    expect(h.child()).not.toBe(original);
    const after = h.repos.execution.getTaskExecution(first.id)!;
    expect({ task: after.task, currentAttempt: after.currentAttempt, attempts: after.attempts }).toEqual({
      task: before.task, currentAttempt: before.currentAttempt, attempts: before.attempts
    });
    expect(after.blockers).toEqual(h.repos.execution.getSessionResourceBlockers(h.session.id));
    expect((await h.runtime.send(h.session.id, 'second')).status).toBe('completed');
    expect(await h.prompts()).toEqual(['first', 'second']);
    const children = h.repos.execution.getResources(h.session.id).filter(row => row.kind === 'process');
    expect(children).toHaveLength(2);
    expect(new Set(children.map(row => row.parentResourceId)).size).toBe(2);
    expect(children.filter(row => row.observations.at(-1)?.state === 'gone')).toHaveLength(1);
  });

  it('holds the Runtime claim until a revoked resume tail ends and prevents new child birth', async () => {
    const h = await fixture('jsonl');
    expect((await h.runtime.send(h.session.id, 'first')).status).toBe('completed');
    const child = h.child(), exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    const entered = deferred(), release = deferred();
    cleanup.push(async () => { release.resolve(); });
    const resume = h.driver.resume.bind(h.driver);
    let permit: OperationPermit | undefined;
    h.driver.resume = async operation => { permit = operation; entered.resolve(); await release.promise; await resume(operation); };
    const resuming = h.runtime.resume(h.session.id).then<Session | unknown, unknown>(value => value, error => error);
    await entered.promise; expect(permit).toBeDefined();
    let done = false; const shutdown = h.runtime.shutdown().then(() => { done = true; });
    await expect(resuming).resolves.toMatchObject({ code: 'OPERATION_REVOKED' });
    expect(done).toBe(false); expect(() => h.repos.control.attachRuntime('early')).toThrow();
    release.resolve(); await shutdown;
    expect(h.repos.execution.getResources(h.session.id).filter(row => row.kind === 'process')).toHaveLength(1);
    h.repos.control.attachRuntime('after-tail').release();
    expect(await h.prompts()).toEqual(['first']);
  });

  it('rejects altered physical/native/recovery references at real send and accepts a same-scope nested permit once', async () => {
    const h = await fixture('jsonl');
    const send = h.driver.send.bind(h.driver);
    let checked = false;
    h.driver.send = async input => {
      if (typeof input === 'string') throw new Error('Expected a controlled submission');
      expect(input.resourceRefs).toHaveLength(1);
      const mutations: Array<Partial<DriverSubmission>> = [
        { resourceRefs: [] }, { resourceRefs: [{ ...input.resourceRefs[0]!, identityId: 'changed' }] },
        { nativeContextRef: { resourceId: 'native', identityId: 'native', originRunId: 'run' } },
        { contextProofId: 'different' }, { recovery: { kind: 'pty-jsonl-v1', turnId: 'different', transcript: { offset: 1 } } }
      ];
      for (const changed of mutations) await expect(send({ ...input, ...changed })).rejects.toMatchObject({ code: 'SUBMISSION_REFERENCES_CONFLICT' });
      const context = (Reflect.get(h.driver, 'options') as { context: import('@dutydeck/shared').DriverContext }).context;
      const operation = context.resources.beginOperation(input.operation);
      try { await send({ ...input, operation }); }
      finally { context.resources.creationFinished(operation, 'created'); }
      checked = true;
    };
    expect((await h.runtime.send(h.session.id, 'once')).status).toBe('completed');
    expect(checked).toBe(true); expect(await h.prompts()).toEqual(['once']);
  });
});
