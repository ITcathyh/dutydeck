import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { runCommand } from './command.js';
import { TmuxBackend, TmuxSessionExistsError, isTmuxAvailable } from './tmux-backend.js';

// Pass-through by default; one case makes the pane-state read fail.
vi.mock('./command.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./command.js')>();
  return { runCommand: vi.fn(actual.runCommand) };
});

// The user's tmux server may set remain-on-exit: an exited CLI then leaves a
// dead pane, and its session, behind. Dutydeck keeps that option untouched.
const tmuxDescribe = (await isTmuxAvailable()) ? describe : describe.skip;

tmuxDescribe('TmuxBackend reaps its own fully dead sessions under remain-on-exit', () => {
  let root: string;
  const tmux = (...args: string[]) => execFileSync('tmux', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const exists = (name: string) => { try { tmux('has-session', '-t', `=${name}`); return true; } catch { return false; } };
  const paneStates = (name: string) => tmux('list-panes', '-s', '-t', name, '-F', '#{pane_dead}').split('\n');
  const spawnOpts = () => ({ cwd: root, cols: 80, rows: 24, env: { HOME: root, PATH: process.env.PATH! } });
  let counter = 0;
  const nextName = () => `dd-remain-${process.pid}-${++counter}`;

  /** A session created by TmuxBackend whose CLI already exited, kept by remain-on-exit. */
  async function deadSession(name: string, ownerId?: string): Promise<void> {
    const backend = new TmuxBackend(name, ownerId === undefined ? {} : { ownerId });
    await backend.spawn('/bin/sh', ['-c', 'exit 0'], spawnOpts());
    backend.disposeCapture();
    await vi.waitFor(() => expect(paneStates(name)).toEqual(['1']), { timeout: 10_000, interval: 50 });
  }

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'dd-tmux-remain-'));
    vi.stubEnv('TMUX_TMPDIR', root);
    vi.stubEnv('TMUX', undefined);
    vi.stubEnv('TMUX_PANE', undefined);
    tmux('new-session', '-d', '-s', 'keepalive', 'sleep 1000');
    tmux('set-option', '-g', 'remain-on-exit', 'on');
  });
  afterEach(() => { vi.mocked(runCommand).mockClear(); });
  afterAll(() => {
    try { tmux('kill-server'); } catch { /* gone */ }
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it('reaps an owned all-dead session, after which a same-name spawn succeeds', async () => {
    const name = nextName();
    await deadSession(name, 'dutydeck:owned');
    expect(await TmuxBackend.reapDeadOwnedSession(name, 'dutydeck:owned')).toBe(true);
    expect(exists(name)).toBe(false);
    expect(tmux('show-options', '-gv', 'remain-on-exit')).toBe('on');
  });

  it('launch() reaps the owned dead session itself instead of failing with duplicate session', async () => {
    const name = nextName();
    await deadSession(name, 'dutydeck:owned');
    const backend = new TmuxBackend(name, { ownerId: 'dutydeck:owned' });
    await backend.spawn('/bin/sleep', ['1000'], spawnOpts());
    try {
      expect(paneStates(name)).toEqual(['0']);
      expect(await TmuxBackend.sessionOwner(name)).toBe('dutydeck:owned');
    } finally { await backend.kill(); }
  });

  it('leaves a dead session with another owner, or no owner marker, alone', async () => {
    const foreign = nextName();
    await deadSession(foreign, 'dutydeck:someone-else');
    expect(await TmuxBackend.reapDeadOwnedSession(foreign, 'dutydeck:owned')).toBe(false);
    expect(exists(foreign)).toBe(true);
    const refused = await new TmuxBackend(foreign, { ownerId: 'dutydeck:owned' }).spawn('/bin/sleep', ['1000'], spawnOpts()).catch(error => error);
    expect(refused).toBeInstanceOf(TmuxSessionExistsError);
    expect(paneStates(foreign)).toEqual(['1']);

    const unmarked = nextName();
    await deadSession(unmarked);
    expect(await TmuxBackend.reapDeadOwnedSession(unmarked, 'dutydeck:owned')).toBe(false);
    expect(exists(unmarked)).toBe(true);
  });

  it('never reaps without an owner id to compare', async () => {
    const name = nextName();
    await deadSession(name, 'dutydeck:owned');
    expect(await TmuxBackend.reapDeadOwnedSession(name, undefined)).toBe(false);
    expect(exists(name)).toBe(true);
  });

  it('keeps a session where one window is dead but another still runs', async () => {
    const name = nextName();
    await deadSession(name, 'dutydeck:owned');
    tmux('new-window', '-t', `=${name}:`, 'sleep 1000');
    expect(paneStates(name).sort()).toEqual(['0', '1']);
    expect(await TmuxBackend.reapDeadOwnedSession(name, 'dutydeck:owned')).toBe(false);
    expect(exists(name)).toBe(true);
  });

  it('keeps the session when the pane states cannot be read', async () => {
    const name = nextName();
    await deadSession(name, 'dutydeck:owned');
    const actual = vi.mocked(runCommand).getMockImplementation()!;
    vi.mocked(runCommand).mockImplementation(async (binary, args, options) => {
      if (args[0] === 'list-panes') throw Object.assign(new Error('tmux list-panes failed'), { status: 1, signal: null, stderr: 'lost server' });
      return actual(binary, args, options);
    });
    try {
      expect(await TmuxBackend.reapDeadOwnedSession(name, 'dutydeck:owned')).toBe(false);
    } finally { vi.mocked(runCommand).mockImplementation(actual); }
    expect(exists(name)).toBe(true);
    expect(vi.mocked(runCommand).mock.calls.some(([, args]) => args[0] === 'kill-session')).toBe(false);
  });
});
