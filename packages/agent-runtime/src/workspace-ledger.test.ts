import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepositories } from '@dutydeck/storage';
import type { RepositoryBundle } from '@dutydeck/shared';
import { WorkspaceManager } from './workspace.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const path = await mkdtemp(join(tmpdir(), 'runtime-workspace-proof-')); cleanup.push(() => rm(path, { recursive: true, force: true }));
  const repos: RepositoryBundle = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' }); cleanup.push(() => repos.close());
  const manager = new WorkspaceManager(repos.config);
  await manager.prepare('session', path, 'shared');
  return { path, repos, manager };
}
describe('workspace raw record proof', () => {
  it('hashes the exact persisted bytes, including valid whitespace', async () => {
    const { path, repos, manager } = await fixture();
    const raw = await repos.config.get('runtime_workspace:session');
    const pretty = JSON.stringify(JSON.parse(raw!), null, 2);
    await repos.config.set('runtime_workspace:session', pretty);
    const proof = await manager.proof('session', path);
    expect(proof).toEqual({ expectedCwd: path, workspaceRevision: JSON.parse(raw!).revision, workspaceDigest: createHash('sha256').update(pretty).digest('hex') });
    expect(proof.workspaceDigest).not.toBe(createHash('sha256').update(raw!).digest('hex'));
  });
  it('rejects a KV change while real filesystem validation is in flight', async () => {
    const { path, repos, manager } = await fixture();
    const validate = manager.validate.bind(manager);
    vi.spyOn(manager, 'validate').mockImplementationOnce(async record => {
      await validate(record);
      const raw = (await repos.config.get('runtime_workspace:session'))!;
      await repos.config.set('runtime_workspace:session', raw + '\n');
    });
    await expect(manager.proof('session', path)).rejects.toMatchObject({ code: 'WORKSPACE_CONFLICT' });
  });
  it('rejects a ready record for another session before validating its directory', async () => {
    const { path, repos, manager } = await fixture();
    const record = JSON.parse((await repos.config.get('runtime_workspace:session'))!); record.sessionId = 'other';
    await repos.config.set('runtime_workspace:session', JSON.stringify(record));
    const validate = vi.spyOn(manager, 'validate');
    await expect(manager.proof('session', path)).rejects.toMatchObject({ code: 'WORKSPACE_NOT_READY' });
    expect(validate).not.toHaveBeenCalled();
  });
});
