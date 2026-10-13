import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.js';
import { PluginCommandRegistry } from './commands.js';
import { PluginTriggerService } from './triggers.js';

const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });

const auth = { mode: 'token' as const, getToken: async () => 'secret-token', localOnly: false };
const plugins = () => ({
  commands: new PluginCommandRegistry([{ name: 'hello', scope: 'workspace:/repo', commands: [{ name: 'greet', template: '向 $ARGUMENTS 打招呼' }] }]),
  triggers: new PluginTriggerService({ lookup: () => undefined, token: () => undefined, deliver: vi.fn() })
});

describe('plugin routes in the app', () => {
  it('exempts trigger POSTs from web auth only when plugins are loaded', async () => {
    const withPlugins = await buildApp({} as never, { auth, plugins: plugins() }); apps.push(withPlugins);
    expect((await withPlugins.inject({ method: 'POST', url: '/api/plugins/hello/triggers/ping', payload: '{}' })).statusCode).toBe(404);
    expect((await withPlugins.inject({ method: 'GET', url: '/api/plugins/commands' })).statusCode).toBe(401);
    expect((await withPlugins.inject({ method: 'GET', url: '/api/plugins/commands', headers: { authorization: 'Bearer secret-token' } })).statusCode).toBe(200);

    const without = await buildApp({} as never, { auth }); apps.push(without);
    expect((await without.inject({ method: 'POST', url: '/api/plugins/hello/triggers/ping', payload: '{}' })).statusCode).toBe(401);
  });

  it('expands plugin commands in web sends for the session workspace and keeps the typed text', async () => {
    const runtime = { getSession: vi.fn(async () => ({ id: 's1', cwd: '/repo/app' })), dispatch: vi.fn(async () => ({ id: 't1', status: 'queued' })) };
    const app = await buildApp(runtime as never, { plugins: plugins() }); apps.push(app);
    expect((await app.inject({ method: 'POST', url: '/api/sessions/s1/send', payload: { prompt: '/greet 小明' } })).statusCode).toBe(202);
    expect(runtime.dispatch).toHaveBeenLastCalledWith('s1', '/greet 小明', 'queue', '向 小明 打招呼', undefined, undefined, undefined, undefined);
    runtime.getSession.mockResolvedValue({ id: 's1', cwd: '/elsewhere' });
    await app.inject({ method: 'POST', url: '/api/sessions/s1/send', payload: { prompt: '/greet 小明' } });
    expect(runtime.dispatch).toHaveBeenLastCalledWith('s1', '/greet 小明', 'queue', '/greet 小明', undefined, undefined, undefined, undefined);
  });
});
