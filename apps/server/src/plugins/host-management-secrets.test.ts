import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { PluginStore } from './store.js';
import { PluginHost } from './host.js';
import { buildApp } from '../app.js';

it('keeps secret-bearing provider exceptions out of Host diagnostics, logs and binding API', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dutydeck-provider-secrets-'));
  let host: PluginHost | undefined;
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    const source = join(root, 'source'); await mkdir(join(source, '.dutydeck-plugin'), { recursive: true });
    await writeFile(join(source, '.dutydeck-plugin/plugin.json'), JSON.stringify({ name: 'secret-probe', providers: 'index.mjs', userConfig: { token: { description: 'Credential', sensitive: true } } }));
    await writeFile(join(source, 'index.mjs'), "export default api => { throw new Error('authentication failed: ' + api.config.token); }");
    const store = new PluginStore(join(root, 'data')); await store.install(source, { yes: true });
    const canary = 'SYNTHETIC_SECRET_CANARY_59'; await store.setConfig('secret-probe', 'token', Buffer.from(canary));
    const warn = vi.fn(); host = await PluginHost.load({ dataDir: store.dataDir, log: { warn } });
    expect(host.active.some(item => item.entry.name === 'secret-probe')).toBe(false);
    expect(host.diagnostics).toEqual([{ plugin: 'secret-probe', message: expect.stringContaining('PLUGIN_PROVIDER_REGISTRATION_FAILED') }]);
    expect(warn).toHaveBeenCalled(); expect(JSON.stringify(warn.mock.calls)).not.toContain(canary);
    app = await buildApp({} as any, { pluginBindings: { host, authorize: async () => true } });
    const response = await app.inject({ method: 'GET', url: '/api/plugin-bindings' });
    expect(response.statusCode).toBe(200); expect(response.body).not.toContain(canary);
    expect(response.json().diagnostics).toEqual(host.diagnostics);
  } finally { await app?.close(); await host?.dispose(); await rm(root, { recursive: true, force: true }); }
});
