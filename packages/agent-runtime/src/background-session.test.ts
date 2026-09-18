import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentConfigSchema } from '@dutydeck/shared';
import { createRepositories } from '@dutydeck/storage';
import { DutydeckRuntime } from './index.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
it('admits one stable background session, checks immutable scope and never restarts terminal history', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'collaboration-background-'));
  const repos = createRepositories(join(directory, 'state.db'), { newDatabaseAuthority: 'ledger_v1' });
  const start = vi.fn(async () => {}), stop = vi.fn(async () => {}), authorize = vi.fn(async () => {});
  const runtime = new DutydeckRuntime(repos, {
    workspaceRoot: join(directory, 'workspaces'), cleanupIntervalMs: 0,
    probe: (() => ({ available: true, protocol: 'acp', acp: true })) as any,
    driverFactory: () => ({ start, stop, isStopped: async () => true, send: async () => {}, interrupt: async () => {} })
  });
  cleanups.push(async () => { await runtime.shutdown(); repos.close(); await rm(directory, { recursive: true, force: true }); });
  await runtime.initialize([agentConfigSchema.parse({ id: 'agent', name: 'Agent', command: 'fake', protocol: 'acp', cwd: directory, permissionMode: 'ask' })]);
  const id = 'ses_collab_' + 'a'.repeat(64);
  const input = { agentId: 'agent', cwd: directory, source: 'lark', sourceId: 'app:chat:group:collaboration:mandate', permissionMode: 'ask' as const };
  const first = await runtime.startBackgroundSession(input, id, authorize);
  expect((await runtime.startBackgroundSession(input, id, authorize)).id).toBe(first.id);
  expect(start).toHaveBeenCalledTimes(1);
  for (const patch of [{ sourceId: 'app:other:group:collaboration:mandate' }, { permissionMode: 'full-trust' as const }, { model: 'changed' }, { cwd: '/other' }]) {
    await expect(runtime.startBackgroundSession({ ...input, ...patch }, id, authorize)).rejects.toMatchObject({ code: 'BACKGROUND_SESSION_CONFLICT' });
  }
  await runtime.stop(id, { kind: 'channel', appId: 'app', id: 'requester' });
  expect((await runtime.startBackgroundSession(input, id, authorize)).state).toBe('stopped');
  expect(start).toHaveBeenCalledTimes(1);
  await expect(runtime.startBackgroundSession(input, 'ses_collab_' + 'b'.repeat(64), async () => { throw new Error('revoked'); })).rejects.toThrow('revoked');
  expect(await repos.sessions.get('ses_collab_' + 'b'.repeat(64))).toBeUndefined();
});
