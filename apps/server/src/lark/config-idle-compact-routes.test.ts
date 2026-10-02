import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepositories } from '@dutydeck/storage';
import { buildApp } from '../app.js';
import { larkBotsConfigKey, readLarkConfig } from './config.js';
import { larkSessionConfigKey } from './session-resolver.js';

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean(); });

it('defaults old configs and round-trips idle compaction through HTTP and a reopened SQLite database', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dutydeck-idle-config-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const database = join(directory, 'test.sqlite');
  let repos = createRepositories(database);
  cleanups.push(() => repos.close());
  await repos.config.set(larkBotsConfigKey, JSON.stringify([{ appId: 'cli_idle', appSecret: 'fake', listening: false, permissionMode: 'ask', defaultAgentId: 'codex' }]));
  const fetcher = vi.fn(async () => { throw new Error('Unexpected network'); });
  let app = await buildApp({} as any, { lark: { env: { DUTYDECK_DISABLE_LARK_LISTENER: 'true' }, config: repos.config, fetcher } });
  cleanups.push(() => app.close());
  const current = (await app.inject({ method: 'GET', url: '/api/lark/config' })).json().bots[0];
  expect(current).toMatchObject({ idleCompactEnabled: true, idleCompactHours: 24 });
  const sessionKey = larkSessionConfigKey((await readLarkConfig(repos.config, 'cli_idle'))!);
  const saved = await app.inject({ method: 'PUT', url: '/api/lark/config', payload: {
    originalAppId: 'cli_idle', expectedRevision: current.revision, idleCompactEnabled: false, idleCompactHours: 48
  } });
  expect(saved.statusCode).toBe(200);
  expect(saved.json().bots[0]).toMatchObject({ idleCompactEnabled: false, idleCompactHours: 48 });
  expect(larkSessionConfigKey((await readLarkConfig(repos.config, 'cli_idle'))!)).toBe(sessionKey);
  const conflict = await app.inject({ method: 'PUT', url: '/api/lark/config', payload: {
    originalAppId: 'cli_idle', expectedRevision: current.revision, idleCompactHours: 12
  } });
  expect(conflict.statusCode).toBe(409);
  expect(conflict.json().current).toMatchObject({ idleCompactEnabled: false, idleCompactHours: 48 });
  await app.close();
  repos.close();
  repos = createRepositories(database);
  app = await buildApp({} as any, { lark: { env: { DUTYDECK_DISABLE_LARK_LISTENER: 'true' }, config: repos.config, fetcher } });
  expect((await app.inject({ method: 'GET', url: '/api/lark/config' })).json().bots[0]).toMatchObject({ idleCompactEnabled: false, idleCompactHours: 48 });
  const unrelated = await app.inject({ method: 'PUT', url: '/api/lark/config', payload: { originalAppId: 'cli_idle', preInjectPrompt: 'hello' } });
  expect(unrelated.json().bots[0]).toMatchObject({ idleCompactEnabled: false, idleCompactHours: 48 });
  const enabled = await app.inject({ method: 'PUT', url: '/api/lark/config', payload: { originalAppId: 'cli_idle', idleCompactEnabled: true, idleCompactHours: 1 } });
  expect(enabled.json().bots[0]).toMatchObject({ idleCompactEnabled: true, idleCompactHours: 1 });
  for (const idleCompactHours of [0, -1, 1.5, null, '24']) {
    const invalid = await app.inject({ method: 'PUT', url: '/api/lark/config', payload: { originalAppId: 'cli_idle', idleCompactHours } });
    expect(invalid.statusCode).toBe(400);
  }
  expect((await readLarkConfig(repos.config, 'cli_idle'))!).toMatchObject({ idleCompactEnabled: true, idleCompactHours: 1 });
  expect(fetcher).not.toHaveBeenCalled();
});
