import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepositories } from '@dutydeck/storage';
import { buildApp } from './app.js';
import { TerminalSettings } from './terminal-settings.js';
import { runTerminalSettingsCli } from './terminal-settings-cli.js';
import { createCliProgram } from './cli-program.js';

describe('terminal settings', () => {
  it.skipIf(process.platform !== 'linux').each(['success', 'failure'] as const)('serializes writes while a Herdr check has %s without blocking GET or the event loop', async outcome => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-version-queue-'));
    const repos = createRepositories(':memory:');
    const started = join(directory, 'started'), release = join(directory, 'release');
    await writeFile(join(directory, 'herdr'), `#!${process.execPath}
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(started)}, 'ready');
const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) { clearInterval(timer); ${outcome === 'failure' ? 'process.exit(1);' : "console.log('herdr 0.9.0');"} } }, 10);
`, { mode: 0o755 });
    const settings = new TerminalSettings(repos.config, { PATH: directory });
    const app = await buildApp({} as any, { terminalSettings: settings });
    const save = vi.spyOn(repos.config, 'set');
    const first = settings.set({ terminalBackend: 'herdr' });
    void first.catch(() => {});
    let second: ReturnType<TerminalSettings['set']> | undefined;
    let secondSettled = false;
    try {
      await vi.waitFor(async () => expect(await readFile(started, 'utf8')).toBe('ready'));
      second = settings.set({ terminalBackend: 'tmux' }).finally(() => { secondSettled = true; });
      await expect(settings.set({ terminalBackend: 'tmux', extra: true })).rejects.toThrow();
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      expect(secondSettled).toBe(false);
      expect(save).not.toHaveBeenCalled();
      expect((await app.inject({ method: 'GET', url: '/api/settings/terminal' })).json()).toEqual({ terminalBackend: 'tmux', scope: 'pty-cli' });
      await writeFile(release, 'continue');
      if (outcome === 'success') await expect(first).resolves.toEqual({ terminalBackend: 'herdr', scope: 'pty-cli' });
      else await expect(first).rejects.toMatchObject({ code: 'HERDR_UNAVAILABLE' });
      await expect(second).resolves.toEqual({ terminalBackend: 'tmux', scope: 'pty-cli' });
      expect(save.mock.calls).toEqual((outcome === 'success' ? ['herdr', 'tmux'] : ['tmux']).map(value => ['dutydeck.terminal_backend', value]));
      expect(await settings.current()).toBe('tmux');
    } finally {
      await writeFile(release, 'continue');
      await Promise.allSettled([first, second]);
      await app.close(); repos.close(); await rm(directory, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== 'linux')('keeps the event loop moving while Herdr version validation waits and saves only after success', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-version-'));
    const repos = createRepositories(':memory:');
    const started = join(directory, 'started'), release = join(directory, 'release');
    await writeFile(join(directory, 'herdr'), `#!${process.execPath}
const fs = require('node:fs');
if (process.argv[2] !== '--version' || process.env.HERDR_SESSION || process.env.fixture_value !== 'preserved') process.exit(1);
fs.writeFileSync(${JSON.stringify(started)}, 'ready');
const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) { console.log('herdr 0.9.0'); clearInterval(timer); } }, 10);
`, { mode: 0o755 });
    const settings = new TerminalSettings(repos.config, { PATH: directory, HERDR_SESSION: 'must-be-filtered', fixture_value: 'preserved' });
    let settled = false;
    const pending = settings.set({ terminalBackend: 'herdr' }).finally(() => { settled = true; });
    try {
      await vi.waitFor(async () => expect(await readFile(started, 'utf8')).toBe('ready'));
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      expect(settled).toBe(false);
      expect(await settings.current()).toBe('tmux');
      await writeFile(release, 'continue');
      await expect(pending).resolves.toEqual({ terminalBackend: 'herdr', scope: 'pty-cli' });
    } finally {
      await writeFile(release, 'continue');
      await pending.catch(() => undefined);
      repos.close(); await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(['failure', 'timeout', 'old-version', 'invalid-version'])('preserves settings when the synthetic Herdr version check has %s', async kind => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-version-'));
    const repos = createRepositories(':memory:');
    const script = kind === 'failure' ? 'process.exit(1)' : kind === 'timeout' ? 'setInterval(() => {}, 100)' : `console.log('${kind === 'old-version' ? 'herdr 0.8.0' : 'unexpected'}')`;
    await writeFile(join(directory, 'herdr'), `#!${process.execPath}\n${script}\n`, { mode: 0o755 });
    const settings = new TerminalSettings(repos.config, { PATH: directory });
    try {
      await settings.set({ terminalBackend: 'tmux' });
      const save = vi.spyOn(repos.config, 'set');
      await expect(settings.set({ terminalBackend: 'herdr' })).rejects.toMatchObject({ code: 'HERDR_UNAVAILABLE', message: kind === 'failure' || kind === 'timeout' ? '无法执行 Herdr；不会自动回退到 tmux。' : 'Herdr 主终端需要 Linux 和 Herdr >= 0.9。' });
      expect(save).not.toHaveBeenCalled();
      expect(await settings.current()).toBe('tmux');
    } finally { repos.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it('defaults to tmux, validates strictly, preserves preference on unavailable Herdr, isolates repositories and checks owner writes', async () => {
    const a = createRepositories(':memory:'), b = createRepositories(':memory:');
    const settings = new TerminalSettings(a.config, { PATH: '/nonexistent' });
    const app = await buildApp({} as any, { terminalSettings: settings, sessionNames: { authorize: request => request.headers['x-owner'] === 'true' } });
    try {
      expect((await app.inject({ method: 'GET', url: '/api/settings/terminal' })).json()).toEqual({ terminalBackend: 'tmux', scope: 'pty-cli' });
      expect((await app.inject({ method: 'PUT', url: '/api/settings/terminal', payload: { terminalBackend: 'herdr' } })).statusCode).toBe(403);
      const put = (payload: unknown) => app.inject({ method: 'PUT', url: '/api/settings/terminal', headers: { 'x-owner': 'true' }, payload: payload as any });
      expect((await put({ terminalBackend: 'pty' })).statusCode).toBe(400);
      expect((await put({ terminalBackend: 'tmux', extra: true })).statusCode).toBe(400);
      expect((await put({ terminalBackend: 'herdr' })).json()).toMatchObject({ error: { code: 'HERDR_UNAVAILABLE' } });
      expect(await settings.current()).toBe('tmux');
      await a.config.set('dutydeck.terminal_backend', 'herdr');
      expect(await settings.current()).toBe('herdr');
      expect(await new TerminalSettings(b.config).current()).toBe('tmux');
    } finally { await app.close(); a.close(); b.close(); }
  });
  it('CLI routes get/set to exact runtime and database and rejects invalid values before reading credentials', async () => {
    const readToken = vi.fn(() => 'token'), fetcher = vi.fn(async () => new Response(JSON.stringify({ terminalBackend: 'herdr', scope: 'pty-cli' }), { status: 200 }));
    const options = { url: 'http://127.0.0.1:4402', database: '/tmp/bot.db' };
    await expect(runTerminalSettingsCli('pty', options, { readToken, fetcher })).rejects.toMatchObject({ code: 'INVALID_TERMINAL_BACKEND' });
    expect(readToken).not.toHaveBeenCalled();
    await expect(runTerminalSettingsCli('herdr', { url: options.url }, { readToken, fetcher })).rejects.toMatchObject({ code: 'TERMINAL_SETTINGS_DATABASE_REQUIRED' });
    await runTerminalSettingsCli('herdr', options, { readToken, fetcher });
    expect(readToken).toHaveBeenCalledWith('/tmp/bot.db');
    expect(String(fetcher.mock.calls[0]![0])).toBe('http://127.0.0.1:4402/api/settings/terminal');
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ method: 'PUT', body: JSON.stringify({ terminalBackend: 'herdr' }), redirect: 'error' });
    await runTerminalSettingsCli(undefined, options, { readToken, fetcher });
    expect(fetcher.mock.calls[1]![1]).toMatchObject({ method: 'GET' });
    await expect(runTerminalSettingsCli('herdr', options, { readToken, fetcher: async () => new Response(JSON.stringify({ error: { code: 'HERDR_UNAVAILABLE' } }), { status: 503 }) })).rejects.toMatchObject({ code: 'HERDR_UNAVAILABLE', message: expect.stringContaining('no fallback to tmux') });
    const handler = vi.fn();
    await createCliProgram('test', { terminalBackend: handler }).parseAsync(['node', 'dutydeck', 'settings', 'terminal-backend', 'herdr', '--url', options.url, '--database', options.database]);
    expect(handler).toHaveBeenCalledWith('herdr', options);
  });
});
