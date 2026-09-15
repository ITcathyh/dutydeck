import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { taskExecutionSchemas, type DriverResource, type RuntimeControlClaim } from '@dutydeck/shared';
import { createRepositories } from './index.js';
import * as processIdentity from './process-identity.js';

const fence = { sessionId: 'creation-session', runId: 'creation-run' };
const directories: string[] = [];
const children: Array<{ child: ChildProcess; closed: Promise<void> }> = [];
const opened: Array<{ repositories: ReturnType<typeof createRepositories>; claim?: RuntimeControlClaim; db: Database.Database }> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const entry of opened.splice(0)) { entry.claim?.release(); entry.repositories.close(); entry.db.close(); }
  for (const { child, closed } of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function creator(mode = 'operation') {
  const directory = mkdtempSync(join(tmpdir(), 'dutydeck-resource-creator-')); directories.push(directory);
  const filename = join(directory, 'execution.sqlite');
  const fixture = fileURLToPath(new URL('../tests/fixtures/resource-creator.mts', import.meta.url));
  const child = spawn(process.execPath, ['--conditions=development', '--import', 'tsx', fixture, filename, mode], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  children.push({ child, closed });
  let stderr = '';
  child.stderr?.on('data', data => { stderr += String(data); });
  function message(kind: string): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const onMessage = (value: unknown) => {
        if (value && typeof value === 'object' && 'kind' in value && value.kind === kind) {
          child.off('message', onMessage); child.off('exit', onExit);
          resolve(value as Record<string, unknown>);
        }
      };
      const onExit = () => { child.off('message', onMessage); reject(new Error(`Creator exited before ${kind}: ${stderr}`)); };
      child.on('message', onMessage); child.once('exit', onExit);
    });
  }
  const ready = await message('ready');
  const resource = taskExecutionSchemas.resource.parse(ready.resource);
  return { child, closed, filename, resource,
    async release() { const released = message('released'); child.send('release'); await released; },
    async crash() { child.kill('SIGKILL'); await closed; }
  };
}
function recover(filename: string) {
  const repositories = createRepositories(filename, { mode: 'runtime' });
  const claim = repositories.control.attachRuntime('recovering-controller');
  const db = new Database(filename, { timeout: 0 });
  const entry = { repositories, claim: claim as RuntimeControlClaim | undefined, db }; opened.push(entry);
  return { ...entry, entry, execution: repositories.execution.bind(claim) };
}
function stored(db: Database.Database): string {
  return JSON.stringify(db.prepare('SELECT * FROM driver_resources ORDER BY rowid').all());
}
function rewrite(db: Database.Database, change: (resource: DriverResource) => DriverResource) {
  const row = db.prepare("SELECT json FROM driver_resources WHERE id='factory'").get() as { json: string };
  const resource = change(taskExecutionSchemas.resource.parse(JSON.parse(row.json)));
  db.prepare("UPDATE driver_resources SET revision=?,json=? WHERE id='factory'").run(resource.revision, JSON.stringify(resource));
}

describe('Controlled driver creation closure', () => {
  it('closes an abandoned creation after actual process death and keeps immutable origin through reopen', async () => {
    const original = await creator();
    expect(original.resource.creationProvenance?.creator.pid).toBe(original.child.pid);
    await original.crash();
    const { repositories, execution, db, entry } = recover(original.filename);
    expect(db.prepare('SELECT 1 FROM dutydeck_access WHERE id=?').get(original.resource.controller.accessId)).toBeUndefined();
    const closed = execution.closeAbandonedCreation(fence, 'factory', 1);
    expect(closed).toMatchObject({ stage: 'pending', revision: 2, controller: original.resource.controller, creationProvenance: original.resource.creationProvenance });
    expect(closed.identity).toBeUndefined(); expect(closed.holder).toBeUndefined();
    expect(closed.creationClosure?.evidence).toMatchObject({ state: 'dead', creator: original.resource.creationProvenance?.creator });
    expect(closed.creationClosure?.validator).not.toEqual(closed.controller);
    expect(repositories.execution.getSessionResourceBlockers(fence.sessionId)).toEqual([]);
    const before = stored(db);
    expect(execution.closeAbandonedCreation(fence, 'factory', 1)).toEqual(closed); expect(stored(db)).toBe(before);
    expect(() => execution.beforeCreate(fence, { resourceId: 'late-child', kind: 'process', parentResourceId: 'factory' })).toThrow('RESOURCE_PARENT_CLOSED');
    expect(() => execution.creationFinished(fence, 'factory', 2, 'not_created')).toThrow();
    expect(() => execution.closeAbandonedCreation(fence, 'factory', 2)).toThrow('RESOURCE_REVISION_CONFLICT');
    entry.claim?.release(); entry.claim = undefined; repositories.close(); db.close(); opened.splice(opened.indexOf(entry), 1);
    const reopened = recover(original.filename);
    expect(reopened.execution.closeAbandonedCreation(fence, 'factory', 1)).toEqual(closed);
    expect(reopened.repositories.execution.getSessionResourceBlockers(fence.sessionId)).toEqual([]);
    expect(reopened.execution.replaceSessionRun(fence, 'next-run', []).runId).toBe('next-run');
  });

  it('keeps an unconfirmed child blocking after closing its dead creator operation', async () => {
    const original = await creator('child'); await original.crash();
    const { repositories, execution } = recover(original.filename);
    const beforeChild = repositories.execution.getResources(fence.sessionId).find(resource => resource.resourceId === 'unconfirmed-child');
    execution.closeAbandonedCreation(fence, 'factory', 1);
    expect(repositories.execution.getResources(fence.sessionId).find(resource => resource.resourceId === 'unconfirmed-child')).toEqual(beforeChild);
    expect(repositories.execution.getSessionResourceBlockers(fence.sessionId).map(blocker => blocker.resourceId)).toEqual(['unconfirmed-child']);
    expect(() => execution.beforeControlledOperation(fence, { resourceId: 'replacement', driverInstanceId: 'new-driver' })).toThrow(expect.objectContaining({ code: 'SESSION_RESOURCE_BLOCKED' }));
    expect(() => execution.replaceSessionRun(fence, 'next-run', [])).toThrow();
  });

  it('does not mistake released database access for original process death', async () => {
    const original = await creator(); await original.release();
    const { execution, db } = recover(original.filename); const before = stored(db);
    expect(() => execution.closeAbandonedCreation(fence, 'factory', 1)).toThrow('RESOURCE_CREATOR_NOT_PROVEN_DEAD');
    expect(stored(db)).toBe(before);
    await original.crash(); expect(execution.closeAbandonedCreation(fence, 'factory', 1).creationClosure).toBeDefined();
  });

  it('never adds protocol provenance to legacy or in-memory creation', async () => {
    const original = await creator('legacy'); await original.crash();
    const { execution, db } = recover(original.filename); const before = stored(db);
    expect(() => execution.closeAbandonedCreation(fence, 'factory', 1)).toThrow('RESOURCE_CREATION_PROVENANCE_REQUIRED');
    expect(() => execution.beforeControlledOperation(fence, { resourceId: 'factory', driverInstanceId: 'new-driver' })).toThrow();
    expect(stored(db)).toBe(before);
    const repositories = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' });
    const claim = repositories.control.attachRuntime('memory');
    try {
      const x = repositories.execution.bind(claim); const at = new Date().toISOString();
      x.createSession({ id: fence.sessionId, runId: fence.runId, agentId: 'fixture', cwd: '/', state: 'created', createdAt: at, updatedAt: at });
      expect(x.beforeControlledOperation(fence, { resourceId: 'memory', driverInstanceId: 'memory-driver' }).creationProvenance).toBeUndefined();
      expect(() => x.closeAbandonedCreation(fence, 'memory', 1)).toThrow('RESOURCE_CREATION_PROVENANCE_REQUIRED');
    } finally { claim.release(); repositories.close(); }
  });

  it.each(['revision', 'provenance', 'claim'] as const)('rechecks %s after observing death outside the SQL transaction', async race => {
    const original = await creator(); await original.crash();
    const { execution, repositories, entry, db } = recover(original.filename);
    const observe = processIdentity.observeProcess;
    vi.spyOn(processIdentity, 'observeProcess').mockImplementationOnce(identity => {
      const result = observe(identity); expect(result).toBe('dead');
      // This independent zero-timeout connection would fail if observation held the writer lock.
      db.transaction(() => {
        if (race === 'revision') rewrite(db, resource => ({ ...resource, revision: resource.revision + 1 }));
        else if (race === 'provenance') rewrite(db, resource => {
          if (!resource.creationProvenance) throw new Error('Missing test provenance');
          return { ...resource, creationProvenance: { ...resource.creationProvenance, driverInstanceId: 'changed-driver' } };
        });
      }).immediate();
      if (race === 'claim') { entry.claim?.release(); entry.claim = repositories.control.attachRuntime('replacement'); }
      return result;
    });
    expect(() => execution.closeAbandonedCreation(fence, 'factory', 1)).toThrow(race === 'claim' ? 'DATABASE_RUNTIME_CLAIM_REVOKED' : race === 'revision' ? 'RESOURCE_REVISION_CONFLICT' : 'RESOURCE_CREATION_PROVENANCE_CONFLICT');
    expect(repositories.execution.getResources(fence.sessionId)[0]?.creationClosure).toBeUndefined();
  });

  it('rolls back a failed closure write without releasing the blocker', async () => {
    const original = await creator(); await original.crash();
    const { execution, repositories, db } = recover(original.filename);
    db.exec("CREATE TRIGGER reject_closure BEFORE UPDATE ON driver_resources BEGIN SELECT RAISE(ABORT, 'injected closure failure'); END");
    const before = stored(db);
    expect(() => execution.closeAbandonedCreation(fence, 'factory', 1)).toThrow('injected closure failure'); expect(stored(db)).toBe(before);
    expect(repositories.execution.getSessionResourceBlockers(fence.sessionId)).toHaveLength(1);
    db.exec('DROP TRIGGER reject_closure'); expect(execution.closeAbandonedCreation(fence, 'factory', 1).creationClosure).toBeDefined();
  });

  it('rejects malformed or inconsistent persisted closure rather than dropping unknown fields', async () => {
    const original = await creator(); await original.crash();
    const { execution, repositories, db } = recover(original.filename);
    const closed = execution.closeAbandonedCreation(fence, 'factory', 1);
    if (!closed.creationClosure) throw new Error('Missing test closure');
    for (const changed of [{ ...closed, extra: true }, { ...closed, creationClosure: { ...closed.creationClosure, provenanceDigest: '0'.repeat(64) } }]) {
      db.prepare("UPDATE driver_resources SET json=? WHERE id='factory'").run(JSON.stringify(changed));
      expect(() => repositories.execution.getResources(fence.sessionId)).toThrow();
    }
  });
});
