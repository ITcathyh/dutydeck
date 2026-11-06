import { expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRepositories } from '@dutydeck/storage';
import type { AgentConfig } from '@dutydeck/shared';
import { DutydeckRuntime } from './index.js';

const installationOwner = { kind: 'installation_owner', id: 'installation_owner' } as const;
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// Real AcpxAdapter (default factory, persisted session key = session id) against an Agent that never answers cancel.
it('ends a stuck ACP Agent after a timed-out turn so its result-unknown task can be resolved and the queue resumes on the same native session', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dd-acp-stuck-'));
  await writeFile(join(cwd, 'release'), 'release');
  const calls = async () => (await readFile(join(cwd, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const agent: AgentConfig = { id: 'stuck', name: 'Stuck', command: process.execPath, args: [resolve('tests/fixtures/acp-lifecycle-agent.mjs')], protocol: 'acp', cwd,
    env: { lifecycle_directory: cwd, lifecycle_cancel_gate: '1' }, permissionMode: 'full-trust', timeout: 2, capabilities: { pause: false, resume: true }, builtin: false };
  const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' });
  const runtime = new DutydeckRuntime(repos, { cleanupIntervalMs: 0 });
  try {
    await runtime.initialize([agent]);
    const session = await runtime.start({ agentId: agent.id, cwd });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const first = runtime.send(session.id, 'wait');
    await expect.poll(async () => (await calls()).some(call => call.method === 'session/prompt')).toBe(true);
    const stuck = (await calls()).find(call => call.method === 'spawn')!.pid as number;
    await vi.advanceTimersByTimeAsync(2_100);
    await expect.poll(async () => (await calls()).some(call => call.method === 'session/cancel')).toBe(true);
    await vi.advanceTimersByTimeAsync(2_100);
    const unknown = await first;
    expect(unknown.status).toBe('reconcile_required');
    // The unknown-result rule holds the next message in the queue; it is not sent to the stuck Agent.
    const next = runtime.send(session.id, 'next');
    let settled = false; void next.then(() => { settled = true; }, () => { settled = true; });
    const facts = await runtime.inspectUnknownTask(session.id, unknown.id);
    const resolution = { taskId: unknown.id, target: facts.target!, decisionId: 'decision-stuck-failed', action: 'failed' as const, evidenceRefs: ['manual_resolution'] };
    // While the Agent hangs on cancel, nobody can resolve the task without stopping the session.
    await expect(runtime.resolveUnknownTask(session.id, resolution, installationOwner)).rejects.toMatchObject({ code: 'RECOVERY_EXECUTION_ACTIVE' });
    await vi.advanceTimersByTimeAsync(60_000);
    vi.useRealTimers();
    await expect.poll(() => alive(stuck), { timeout: 10_000 }).toBe(false);
    await expect.poll(() => runtime.resolveUnknownTask(session.id, resolution, installationOwner).then(() => true, () => false), { timeout: 10_000 }).toBe(true);
    expect((await next).status).toBe('completed');
    expect(settled).toBe(true);
    const after = await calls();
    expect(after.filter(call => call.method === 'spawn')).toHaveLength(2);
    expect(after.filter(call => call.method === 'session/new')).toHaveLength(1);
    expect(after.filter(call => call.method === 'session/load')).toHaveLength(1);
    expect(after.filter(call => call.method === 'session/prompt')).toHaveLength(2);
    const reply = (await runtime.getEvents(session.id)).filter(event => event.type === 'text' && event.data.role !== 'user').at(-1);
    expect(reply?.data.text).toBe('lifecycle-native-session');
  } finally {
    vi.useRealTimers();
    await writeFile(join(cwd, 'release_cancel'), 'release');
    await runtime.shutdown(); repos.close();
    await rm(cwd, { recursive: true, force: true });
  }
}, 60_000);
