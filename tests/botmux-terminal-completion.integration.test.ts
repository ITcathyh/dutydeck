import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { createCliAdapter, pinnedSessionUuid } from '@dutydeck/cli-adapters';
import { PtyCliDriver } from '@dutydeck/pty-driver';
import { DutydeckRuntime } from '@dutydeck/runtime';
import { createRepositories } from '@dutydeck/storage';
import type { AgentConfig } from '@dutydeck/shared';
import type { SessionBackend } from '@dutydeck/session-backends';

it('settles the real runtime digest only after a late Claude final has been published', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'dd-terminal-digest-'));
  const project = join(cwd, 'projects', realpathSync(cwd).replace(/[^A-Za-z0-9-]/g, '-'));
  mkdirSync(project, { recursive: true });
  const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' });
  const timers: ReturnType<typeof setTimeout>[] = [];
  const runtime = new DutydeckRuntime(repos, {
    probe: () => ({ protocol: 'pty-cli', available: true, pause: false, resume: true }),
    ptyDriverFactory: (agent, _protocol, onEvent, onExit, sessionId) => {
      const transcript = join(project, `${pinnedSessionUuid(sessionId)}.jsonl`); writeFileSync(transcript, '');
      let output!: (data: string) => void;
      const backend: SessionBackend = { kind: 'pty', spawn() {}, write() {}, resize() {}, kill() {}, onExit() {}, onData(cb) { output = cb; } };
      const append = (entry: unknown) => appendFileSync(transcript, JSON.stringify(entry) + '\n');
      const adapter = createCliAdapter('claude-code');
      return new PtyCliDriver({ agent, backend, onEvent, onExit, sessionId, adapter: { ...adapter, prepareInput: undefined,
        writeInput(_backend, prompt) {
          append({ type: 'user', uuid: 'input', timestamp: new Date().toISOString(), message: { role: 'user', content: prompt } });
          append({ type: 'assistant', uuid: 'intermediate', parentUuid: 'input', message: { role: 'assistant', stop_reason: null, content: [{ type: 'text', text: 'intermediate' }] } });
          timers.push(setTimeout(() => output('\x1b[2J\x1b[Hintermediate\r\n✻ Cooked for 1s\r\n❯'), 350));
          // 900ms after screen (400ms after the old 500ms completion).
          // This schedule is independent of send resolving.
          timers.push(setTimeout(() => append({ type: 'assistant', uuid: 'final', parentUuid: 'intermediate', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'actual final' }] } }), 1_250));
        } } });
    },
  });
  const agent: AgentConfig = { id: 'claude-code', name: 'fixture', command: 'unused', args: [], protocol: 'pty-cli', cwd,
    env: { CLAUDE_CONFIG_DIR: cwd }, permissionMode: 'full-trust', timeout: 0, capabilities: { pause: false, resume: true }, builtin: false };
  try {
    await runtime.initialize([agent]); const session = await runtime.start({ agentId: agent.id, cwd });
    const task = await runtime.dispatch(session.id, 'late final');
    await vi.waitFor(async () => expect((await runtime.getTasks(session.id)).find(item => item.id === task.id)?.status).toBe('completed'), { timeout: 6_000 });
    const events = await runtime.getEvents(session.id);
    const relevant = events.filter(event => event.type === 'completed' || (event.type === 'text' && (event.data as { role?: string }).role !== 'user'));
    expect(relevant.map(event => [event.type, (event.data as { text?: string }).text])).toEqual([
      ['text', 'intermediate'], ['text', 'actual final'], ['completed', undefined],
    ]);
    const execution = repos.execution.getTaskExecution(task.id)!;
    expect(execution.attempts[0]?.settlement).toMatchObject({ kind: 'driver_result', outcome: 'completed',
      outputDigest: createHash('sha256').update('intermediateactual final').digest('hex') });
  } finally {
    for (const timer of timers) clearTimeout(timer);
    await runtime.shutdown().catch(() => {}); repos.close(); rmSync(cwd, { recursive: true, force: true });
  }
}, 10_000);
