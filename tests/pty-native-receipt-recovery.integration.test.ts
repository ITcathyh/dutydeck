import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRepositories } from '@dutydeck/storage';
import { DutydeckRuntime } from '@dutydeck/runtime';
import { createCliAdapter, pinnedSessionUuid } from '@dutydeck/cli-adapters';
import { PtyCliDriver, createDutydeckPersistentBackend, dutydeckPtySessionName } from '@dutydeck/pty-driver';
import { isTmuxAvailable } from '@dutydeck/session-backends';
import type { AgentConfig } from '@dutydeck/shared';

const tmuxDescribe = await isTmuxAvailable() ? describe : describe.skip;
const directories: string[] = [], sessions: string[] = [];
const handles: ReturnType<typeof open>[] = [];
let tmuxDirectory: string;
const savedTmuxDirectory = process.env.TMUX_TMPDIR;
beforeAll(() => { tmuxDirectory = mkdtempSync(join(tmpdir(), 'dd-receipt-tmux-')); process.env.TMUX_TMPDIR = tmuxDirectory; });
afterAll(() => {
  try { execFileSync('tmux', ['kill-server'], { stdio: 'ignore' }); } catch { /* isolated server gone */ }
  if (savedTmuxDirectory === undefined) delete process.env.TMUX_TMPDIR; else process.env.TMUX_TMPDIR = savedTmuxDirectory;
  rmSync(tmuxDirectory, { recursive: true, force: true });
});
afterEach(async () => {
  for (const handle of handles.splice(0)) { await handle.runtime.shutdown(); handle.repos.close(); }
  for (const name of sessions.splice(0)) { try { execFileSync('tmux', ['kill-session', '-t', name], { stdio: 'ignore' }); } catch { /* gone */ } }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const submitted = (root: string) => existsSync(join(root, 'submissions.jsonl')) ? readFileSync(join(root, 'submissions.jsonl'), 'utf8').trim().split('\n').length : 0;
function open(root: string) {
  const repos = createRepositories(join(root, 'state.db'), { newDatabaseAuthority: 'ledger_v1' });
  const runtime = new DutydeckRuntime(repos, { cleanupIntervalMs: 0, driverIdleTimeoutMs: 0, terminalBackend: async () => 'tmux',
    probe: () => ({ available: true, protocol: 'pty-cli', pause: false, resume: true }),
    ptyDriverFactory: (agent, _protocol, onEvent, onExit, sessionId) => {
      const builtin = createCliAdapter('claude-code');
      expect(builtin.capabilities.nativeInputReceipt).toBe(true);
      const transcript = join(root, 'projects', realpathSync(root).replace(/[^A-Za-z0-9-]/g, '-'), `${pinnedSessionUuid(sessionId)}.jsonl`);
      return new PtyCliDriver({ agent: { ...agent, env: { ...agent.env, receipt_fixture_transcript: transcript } },
        adapter: { ...builtin, buildArgs: () => [], prepareInput: undefined, injectSessionContext: () => '',
          writeInput: (backend, prompt) => backend.write(JSON.stringify(prompt) + '\n'), completionPattern: /FIXTURE_DONE/ },
        backend: createDutydeckPersistentBackend(sessionId), sessionId, onEvent, onExit });
    },
  });
  const handle = { repos, runtime }; handles.push(handle); return handle;
}
async function close(handle: ReturnType<typeof open>) {
  await handle.runtime.shutdown(); handle.repos.close(); handles.splice(handles.indexOf(handle), 1);
}
const config = (root: string): AgentConfig => ({ id: 'claude-code', name: 'receipt fixture', command: process.execPath,
  args: [resolve('tests/fixtures/pty-native-receipt-agent.mjs')], protocol: 'pty-cli', cwd: root,
  env: { CLAUDE_CONFIG_DIR: root, receipt_fixture_root: root }, permissionMode: 'full-trust', timeout: 30,
  capabilities: { pause: false, resume: true }, builtin: false });

tmuxDescribe('native receipt + real persistent PTY + reopened SQLite', () => {
  it('does not retype input or advance queued work after a daemon restart before receipt', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dd-receipt-before-')); directories.push(root);
    const first = open(root); await first.runtime.initialize([config(root)]);
    const session = await first.runtime.start({ agentId: 'claude-code', cwd: root }); sessions.push(dutydeckPtySessionName(session.id));
    await vi.waitFor(() => expect(existsSync(join(root, 'ready'))).toBe(true), { timeout: 5_000 });
    const task = await first.runtime.dispatch(session.id, 'original');
    await vi.waitFor(() => expect(submitted(root)).toBe(1), { timeout: 5_000 });
    const queued = await first.runtime.dispatch(session.id, 'queued');
    await vi.waitFor(async () => expect((await first.runtime.getEvents(session.id)).some(event => (event.data as any).state === 'input_receipt' && (event.data as any).phase === 'pending')).toBe(true));
    expect(first.repos.execution.getTaskExecution(task.id)?.currentAttempt?.submissionState).toBe('intent_recorded');
    const attemptId = first.repos.execution.getTaskExecution(task.id)?.currentAttempt?.attemptId;
    await close(first);
    const second = open(root); await second.runtime.initialize([config(root)]);
    await vi.waitFor(() => expect(second.repos.execution.getTaskExecution(task.id)?.task.status).toBe('reconcile_required'), { timeout: 5_000 });
    expect(second.repos.execution.getTaskExecution(task.id)?.currentAttempt).toMatchObject({ attemptId, submissionState: 'intent_recorded' });
    expect(second.repos.execution.getTaskExecution(queued.id)?.task.status).toBe('queued');
    // Even a late original receipt/final cannot authorize an unstamped turn.
    writeFileSync(join(root, 'receipt'), 'release'); writeFileSync(join(root, 'final'), 'release');
    await new Promise(resolve => setTimeout(resolve, 700));
    expect(submitted(root)).toBe(1); expect(second.repos.execution.getTaskExecution(queued.id)?.task.status).toBe('queued');
    expect((await second.runtime.getEvents(session.id)).filter(event => event.type === 'completed')).toHaveLength(0);
  }, 20_000);

  it('recovers the original accepted turn after receipt and records its final answer exactly once', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dd-receipt-after-')); directories.push(root); writeFileSync(join(root, 'receipt'), 'ready');
    const first = open(root); await first.runtime.initialize([config(root)]);
    const session = await first.runtime.start({ agentId: 'claude-code', cwd: root }); sessions.push(dutydeckPtySessionName(session.id));
    await vi.waitFor(() => expect(existsSync(join(root, 'ready'))).toBe(true), { timeout: 5_000 });
    const task = await first.runtime.dispatch(session.id, 'original');
    await vi.waitFor(async () => expect((await first.runtime.getEvents(session.id)).some(event => (event.data as any).state === 'input_receipt' && (event.data as any).phase === 'confirmed')).toBe(true), { timeout: 5_000 });
    const checkpoint = first.repos.execution.getTaskExecution(task.id)?.currentAttempt?.submission?.recovery;
    expect(checkpoint?.kind).toBe('pty-jsonl-v1');
    expect(checkpoint?.turnId).toEqual(expect.any(String));
    const backend = createDutydeckPersistentBackend(session.id);
    await vi.waitFor(async () => expect(await backend.getDutydeckMetadata('turn_id')).toBe((checkpoint as any)?.turnId), { timeout: 5_000 });
    const attemptId = first.repos.execution.getTaskExecution(task.id)?.currentAttempt?.attemptId;
    await close(first); writeFileSync(join(root, 'final'), 'release');
    const second = open(root); await second.runtime.initialize([config(root)]);
    await vi.waitFor(() => expect(second.repos.execution.getTaskExecution(task.id)?.task.status).toBe('completed'), { timeout: 8_000 });
    expect(second.repos.execution.getTaskExecution(task.id)?.attempts).toHaveLength(1);
    expect(second.repos.execution.getTaskExecution(task.id)?.attempts[0]?.attemptId).toBe(attemptId);
    expect(submitted(root)).toBe(1);
    expect((await second.runtime.getEvents(session.id)).filter(event => event.type === 'text' && (event.data as any).text === 'fixture final answer')).toHaveLength(1);
    expect((await second.runtime.getEvents(session.id)).filter(event => event.type === 'completed')).toHaveLength(1);
  }, 20_000);
});
