import { describe, expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import { buildApp } from './app.js';
import { TerminalSettings } from './terminal-settings.js';
import { runTerminalSettingsCli } from './terminal-settings-cli.js';
import { createCliProgram } from './cli-program.js';

describe('terminal settings', () => {
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
