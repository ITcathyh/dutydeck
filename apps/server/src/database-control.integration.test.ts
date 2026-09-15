import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { createRepositories } from '@dutydeck/storage';
import { DutydeckRuntime } from '@dutydeck/runtime';
import { startLocalServer } from './service.js';

const directories: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function config() {
  const dir = await mkdtemp(join(tmpdir(), 'dutydeck-control-service-')); directories.push(dir);
  const database = join(dir, 'state.sqlite');
  const seed = createRepositories(database, { newDatabaseAuthority: 'ledger_v1' });
  seed.close();
  const port = await new Promise<number>((resolve, reject) => {
    const server = createServer(); server.on('error', reject);
    server.listen(0, '127.0.0.1', () => { const address = server.address(); if (!address || typeof address === 'string') throw new Error('No port'); server.close(error => error ? reject(error) : resolve(address.port)); });
  });
  return { database, options: { webRoot: dir, env: { ...process.env, HOME: dir, NODE_ENV: 'test', DUTYDECK_DATABASE_URL: database, DUTYDECK_DEFAULT_CWD: dir, DUTYDECK_PORT: String(port), DUTYDECK_HOST: '127.0.0.1', DUTYDECK_AUTH: 'false', DUTYDECK_AGENTS_JSON: '[]', DUTYDECK_DISABLE_LARK_LISTENER: 'true' } } };
}
it('retains database reservation through the full shared service close tail', async () => {
  const { database, options } = await config();
  const service = await startLocalServer(options);
  const shutdown = service.runtime.shutdown.bind(service.runtime);
  let entered!: () => void, release!: () => void;
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(service.runtime, 'shutdown').mockImplementation(async () => { await shutdown(); entered(); await gate; });
  const first = service.close(), second = service.close(); expect(first).toBe(second);
  try {
    await enteredPromise;
    expect(() => createRepositories(database, { mode: 'runtime' })).toThrow('DATABASE_RUNTIME_BUSY');
    const management = createRepositories(database); await management.config.set('close_tail', 'online'); management.close();
  } finally { release(); await first; }
  createRepositories(database, { mode: 'runtime' }).close();
});
it('retains control until failed startup shutdown finishes, then releases all connections', async () => {
  const { database, options } = await config();
  const initialize = vi.spyOn(DutydeckRuntime.prototype, 'initialize').mockRejectedValue(new Error('injected initialization failure'));
  const shutdown = DutydeckRuntime.prototype.shutdown;
  let entered!: () => void, release!: () => void;
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(DutydeckRuntime.prototype, 'shutdown').mockImplementation(async function (this: DutydeckRuntime) { await shutdown.call(this); entered(); await gate; });
  const starting = startLocalServer(options).catch(error => error);
  try { await Promise.race([enteredPromise, starting.then(error => { throw error; })]); expect(() => createRepositories(database, { mode: 'runtime' })).toThrow('DATABASE_RUNTIME_BUSY'); }
  finally { release(); }
  expect(await starting).toMatchObject({ message: 'injected initialization failure' });
  expect(initialize).toHaveBeenCalledTimes(1);
  createRepositories(database, { mode: 'runtime' }).close();
});
