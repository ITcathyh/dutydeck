import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { lazyBundleForTest } from './support/bundle-for-test.js';
import { fileURLToPath } from 'node:url';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn), spawnSync: vi.fn(actual.spawnSync) };
});

const cli = lazyBundleForTest('legacy-e2e-harness', fileURLToPath(new URL('../apps/server/src/cli.ts', import.meta.url)));
afterAll(() => cli.cleanup());
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

it('starts the legacy harness in private HOME, tmux and service scope without migrating caller configuration', async () => {
  const { createDataDir, startServer } = await import('../scripts/e2e-harness.mjs');
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  const entry = await cli.path();
  // Substitute only the build artifact with the same checkout's bundled CLI; retain the helper's actual argv and env.
  vi.mocked(spawn).mockImplementation((command, args, options) => actual.spawn(command, [entry, ...args!.slice(1)], options!));
  const outer = mkdtempSync(join(tmpdir(), 'dutydeck-harness-caller-'));
  const home = join(outer, 'home');
  const legacy = join(home, '.dockmux');
  mkdirSync(legacy, { recursive: true });
  writeFileSync(join(legacy, 'fixture-marker'), 'caller-owned fixture');
  const env = {
    HOME: home, TMUX_TMPDIR: join(outer, 'tmux'), XDG_CONFIG_HOME: join(outer, 'config'), XDG_RUNTIME_DIR: outer,
    DUTYDECK_DAEMON_DIR: join(home, '.dutydeck/daemon'), DUTYDECK_DATABASE_URL: join(outer, 'caller.db'),
    DUTYDECK_BOT_APP_ID: 'cli_caller', DUTYDECK_INSTANCES_JSON: 'invalid', DUTYDECK_SUPERVISOR: 'systemd',
    DUTYDECK_SYSTEMD_UNIT: 'caller.service', DOCKMUX_INSTANCES_JSON: 'invalid-legacy', DUTYDECK_DAEMON_RESTART_PARENT_PID: '123',
    HERDR_SOCKET_PATH: join(outer, 'herdr.sock'), TMUX: 'caller-tmux', TMUX_PANE: '%999'
  };
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  const cleanup: Array<() => unknown> = [];
  const onCleanup = (_label: string, fn: () => unknown) => cleanup.push(fn);
  const callerSocket = join(outer, 'caller.sock');
  try {
    expect(actual.spawnSync('tmux', ['-S', callerSocket, 'new-session', '-d', '-s', 'caller', 'sleep 120'], { env: { ...process.env, TMUX: '' } }).status).toBe(0);
    const dirs = createDataDir({ onCleanup, prefix: 'dutydeck-harness-private-' });
    const portProbe = createServer();
    await new Promise<void>(resolve => portProbe.listen(0, '127.0.0.1', resolve));
    const port = (portProbe.address() as { port: number }).port;
    await new Promise<void>(resolve => portProbe.close(() => resolve()));
    const server = startServer({ port, dirs, agentsJson: [], onCleanup });
    const options = vi.mocked(spawn).mock.calls.at(-1)![2]!;
    const childEnv = options.env!;
    expect(childEnv.HOME).toBe(join(dirs.dataDir, 'home'));
    expect(childEnv.TMUX_TMPDIR).toBe(join(dirs.dataDir, 'tmux-tmp'));
    expect(childEnv.DUTYDECK_DAEMON_DIR).toBe(join(dirs.dataDir, 'home/.dutydeck/daemon'));
    expect(childEnv.DUTYDECK_DATABASE_URL).toBe(join(dirs.dataDir, 'dutydeck.db'));
    for (const key of ['DUTYDECK_BOT_APP_ID', 'DUTYDECK_INSTANCES_JSON', 'DUTYDECK_SUPERVISOR', 'DUTYDECK_SYSTEMD_UNIT', 'DOCKMUX_INSTANCES_JSON', 'DUTYDECK_DAEMON_RESTART_PARENT_PID', 'HERDR_SOCKET_PATH', 'TMUX', 'TMUX_PANE']) expect(childEnv[key], key).toBeUndefined();
    await server.waitUntilReady({ base: `http://127.0.0.1:${port}` });
    expect(readFileSync(join(legacy, 'fixture-marker'), 'utf8')).toBe('caller-owned fixture');
    expect(existsSync(join(home, '.dutydeck'))).toBe(false);
    expect(existsSync(join(dirs.dataDir, 'dutydeck.db'))).toBe(true);
    expect(existsSync(join(outer, 'caller.db'))).toBe(false);
    const privateSocket = join(dirs.dataDir, 'tmux-tmp', `tmux-${process.getuid!()}`, 'default');
    expect(actual.spawnSync('tmux', ['-S', privateSocket, 'new-session', '-d', '-s', 'fixture', 'sleep 120'], { env: childEnv }).status).toBe(0);
    for (const fn of cleanup.splice(0).reverse()) await fn();
    expect(actual.spawnSync('tmux', ['-S', privateSocket, 'has-session', '-t', 'fixture']).status).not.toBe(0);
    expect(actual.spawnSync('tmux', ['-S', callerSocket, 'has-session', '-t', 'caller']).status).toBe(0);
    const { spawnSync } = await import('node:child_process');
    const tmuxCleanup = vi.mocked(spawnSync).mock.calls.find(([command]) => command === 'tmux');
    expect(tmuxCleanup?.[1]).toEqual(['-S', join(dirs.dataDir, 'tmux-tmp', `tmux-${process.getuid!()}`, 'default'), 'kill-server']);
    expect(existsSync(dirs.dataDir)).toBe(false);
    expect(readFileSync(join(legacy, 'fixture-marker'), 'utf8')).toBe('caller-owned fixture');
  } finally {
    for (const fn of cleanup.reverse()) await fn();
    actual.spawnSync('tmux', ['-S', callerSocket, 'kill-server'], { stdio: 'ignore' });
    rmSync(outer, { recursive: true, force: true });
  }
}, 45_000);
