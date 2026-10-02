import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { AgentConfig, AgentDriver } from '@dutydeck/shared';
import { createRepositories } from '@dutydeck/storage';
import { DutydeckRuntime } from './index.js';

it('defers a persisted idle Herdr constructor failure without blocking instance initialization or unrelated sessions', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'dd-idle-receipt-')), path = join(cwd, 'state.db');
  const terminal: AgentConfig = { id: 'terminal', name: 'terminal', command: '/bin/sh', args: [], cwd, env: {}, protocol: 'pty-cli', permissionMode: 'ask', timeout: 30, capabilities: { pause: false, resume: true }, builtin: false };
  const other: AgentConfig = { ...terminal, id: 'other', protocol: 'jsonl' };
  const mock = (persistent: boolean): AgentDriver => {
    let stopped = false, detached = false;
    return { start: async () => {}, send: async () => {}, resume: async () => {}, interrupt: async () => {},
      stop: async () => { stopped = true; }, isStopped: async () => stopped && !detached,
      prepareForDaemonShutdown: () => { detached = persistent; }, isDetachedForShutdown: () => detached,
      persistentTerminalIdentity: async () => persistent ? { original: 'immutable-physical-fixture' } : undefined };
  };
  let repos = createRepositories(path, { newDatabaseAuthority: 'ledger_v1' });
  let runtime = new DutydeckRuntime(repos, { driverIdleTimeoutMs: 0, terminalBackend: async () => 'herdr', driverFactory: agent => mock(agent.id === terminal.id) });
  try {
    await runtime.initialize([terminal, other]);
    const session = await runtime.start({ agentId: terminal.id });
    expect(JSON.parse((await repos.config.get(`runtime_idle_terminal:${session.id}`))!).identity).toEqual({original:'immutable-physical-fixture'});
    await runtime.shutdown(); repos.close();
    repos = createRepositories(path);
    runtime = new DutydeckRuntime(repos, { driverIdleTimeoutMs: 0, driverFactory: agent => {
      if (agent.id === terminal.id) throw new Error('HERDR_UNAVAILABLE constructor fixture');
      return mock(false);
    } });
    await expect(runtime.initialize([terminal, other])).resolves.toBeUndefined();
    expect((await runtime.getRecentEvents(session.id, 10)).some(event => (event.data as { state?: string }).state === 'terminal_recovery_deferred')).toBe(true);
    await expect(runtime.getTerminalDriver(session.id)).rejects.toMatchObject({ code: 'SESSION_RESOURCE_BLOCKED' });
    const unrelated = await runtime.start({ agentId: other.id });
    expect(unrelated.protocol).toBe('jsonl');
    await repos.config.set('dutydeck.terminal_backend', 'tmux');
    expect(await repos.config.get('dutydeck.terminal_backend')).toBe('tmux');
    await runtime.stop(unrelated.id);
  } finally { await runtime.shutdown(); repos.close(); rmSync(cwd, { recursive: true, force: true }); }
});
