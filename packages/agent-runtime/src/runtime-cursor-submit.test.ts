import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PtyLike } from '@dutydeck/cli-adapters';
import { createCursorAdapter } from '@dutydeck/cli-adapters';
import type { SessionBackend } from '@dutydeck/session-backends';
import type { AgentConfig } from '@dutydeck/shared';
import { createRepositories } from '@dutydeck/storage';
import { PtyCliDriver } from '../../pty-driver/src/driver.js';
import { DutydeckRuntime } from './index.js';
let release: (() => Promise<void>) | undefined;
afterEach(async () => { await release?.(); release = undefined; vi.useRealTimers(); });

it('keeps ordinary Cursor input queued until the real previous driver turn completes, then submits each task once', async () => {
  vi.useFakeTimers();
  const directory = mkdtempSync(join(tmpdir(), 'dd-cursor-queue-'));
  const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' });
  let output!: (data: string) => void; const writes: string[] = [], submits: string[] = []; let draft = '';
  const runtime = new DutydeckRuntime(repos, { probe: () => ({ protocol: 'pty-cli', available: true, pause: false, resume: true }),
    driverFactory: (agent, _protocol, onEvent, onExit, sessionId) => {
      const backend: SessionBackend & Partial<PtyLike> = { kind: 'pty', spawn() {}, resize() {}, kill() {}, interrupt() {}, onExit() {}, onData(cb) { output = cb; },
        write(data) { writes.push(data); }, sendText(data) { writes.push(data); draft += data; }, sendSpecialKeys(...keys) {
          writes.push(...keys); for (const key of keys) if (key === 'C-j') draft += '\n'; else if (key === 'Enter') { submits.push(draft); draft = ''; }
        } };
      return new PtyCliDriver({ agent, adapter: createCursorAdapter(), backend, sessionId, onEvent, onExit });
    } });
  release = async () => { await runtime.shutdown(); repos.close(); rmSync(directory, { recursive: true, force: true }); };
  const agent: AgentConfig = { id: 'cursor', name: 'fixture', command: 'unused', args: [], protocol: 'pty-cli', cwd: directory, env: { HOME: directory },
    permissionMode: 'full-trust', timeout: 60, capabilities: { pause: false, resume: true }, builtin: false };
  await runtime.initialize([agent]); const session = await runtime.start({ agentId: 'cursor' });
  const first = await runtime.dispatch(session.id, 'first task');
  await vi.waitFor(() => expect(submits).toHaveLength(1), { timeout: 20_000 }); expect(submits[0]).toContain('first task');
  const second = await runtime.dispatch(session.id, 'second\nline');
  await vi.advanceTimersByTimeAsync(2000); expect(submits).toHaveLength(1);
  expect(repos.execution.getTaskExecution(second.id)?.task.status).toBe('queued');
  output('\x1b[2J\x1b[Hfirst answer\r\n→ Add a follow-up');
  await vi.waitFor(() => expect(repos.execution.getTaskExecution(first.id)?.currentAttempt?.state).toBe('settled'), { timeout: 10_000 });
  // Cursor currently exposes raw_terminal only. With no normalized final text,
  // the existing Runtime output contract records failed, despite driver idle.
  // This test verifies queue/submission semantics without inventing CLI output.
  expect(repos.execution.getTaskExecution(first.id)?.currentAttempt?.outcome).toBe('failed');
  const firstEvents = await runtime.getEvents(session.id);
  expect(firstEvents.filter(event => event.type === 'completed')).toHaveLength(1);
  expect(firstEvents.some(event => event.type === 'raw_terminal' && String((event.data as { text?: string }).text).includes('first answer'))).toBe(true);
  expect(firstEvents.filter(event => event.type === 'text' && (event.data as { role?: string }).role !== 'user')).toEqual([]);
  await vi.waitFor(() => expect(submits).toHaveLength(2), { timeout: 10_000 }); expect(submits[1]).toBe('second\nline');
  expect(writes.filter(w => w === 'Enter')).toHaveLength(2); expect(submits).not.toContain('');
  output('\x1b[2J\x1b[Hsecond answer\r\n→ Add a follow-up');
  await vi.waitFor(() => expect(repos.execution.getTaskExecution(second.id)?.currentAttempt?.state).toBe('settled'), { timeout: 10_000 });
  expect(repos.execution.getTaskExecution(second.id)?.currentAttempt?.outcome).toBe('failed');
  expect((await runtime.getEvents(session.id)).filter(event => event.type === 'completed')).toHaveLength(2);
});
