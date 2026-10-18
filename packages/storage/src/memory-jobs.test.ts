import { afterEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrations, runMigrations, withMigrationTransaction } from './migrations.js';
import { createRepositories } from './index.js';
import type { MemoryJob, RepositoryBundle } from '@dutydeck/shared';
const open: Array<RepositoryBundle | Database.Database> = [];
const directories: string[] = [];
function databasePath() { const dir = mkdtempSync(join(tmpdir(), 'memory-facts-')); directories.push(dir); return join(dir, 'test.sqlite'); }
afterEach(() => { vi.restoreAllMocks(); for (const repos of open.splice(0)) repos.close(); for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const scope = { appId: 'app', pool: 'groups' };
const stateKey = 'lark.memory.state.app.groups';
const entriesKey = 'lark.memory.app.groups';
async function harness(filename = ':memory:') {
  const repos = createRepositories(filename); open.push(repos);
  await repos.config.set(stateKey, JSON.stringify({ v: 1, running: { token: 'claim' }, pendingTurns: [{ taskId: 'old' }, { taskId: 'new' }] }));
  const job: MemoryJob = { id: 'memory_' + 'a'.repeat(64), scope, revision: 0, claimToken: 'claim', kind: 'extraction', mode: 'compatible', input: { turns: [{ taskId: 'old' }] }, inputDigest: 'b'.repeat(64), versions: [{ key: entriesKey }, { key: 'lark.memory.ignore.app.groups' }, { key: 'lark.bots' }, { key: 'lark.credentials' }], sessionId: 'ses_memory_' + 'a'.repeat(64), sessionInput: { agentId: 'agent', source: 'lark-memory', sourceId: 'app:groups:memory' }, requests: [], state: 'prepared', createdAt: '2026-10-03T00:00:00Z' };
  await repos.memoryJobs.create(job);
  const input = { job, claimToken: 'claim', versions: [...job.versions, { key: stateKey, value: await repos.config.get(stateKey) }], writes: [{ key: entriesKey, value: '{"v":1,"entries":[]}' }, { key: stateKey, value: '{"v":1,"appliedJobId":"'+job.id+'","pendingTurns":[{"taskId":"new"}]}' }], consumedTaskIds: ['old'], result: { added: [] }, appliedAt: job.createdAt };
  return { repos, job, input };
}
it('commits memory, pending consumption and a replayable noop receipt together', async () => {
  const { repos, job, input } = await harness();
  const applied = await repos.memoryJobs.apply(input);
  expect(applied.receipt?.consumedTaskIds).toEqual(['old']);
  expect(JSON.parse((await repos.config.get(stateKey))!).pendingTurns).toEqual([{ taskId: 'new' }]);
  await repos.config.set(entriesKey, 'changed-after-commit');
  expect((await repos.memoryJobs.apply(input)).receipt).toEqual(applied.receipt);
  expect(await repos.config.get(entriesKey)).toBe('changed-after-commit');
  await repos.memoryJobs.update({ ...applied, state: 'settled' }, applied.revision);
  expect(await repos.memoryJobs.findUnsettled(scope)).toBeUndefined();
  expect(await repos.memoryJobs.hasClaim(scope,'claim')).toBe(true);
  expect(await repos.memoryJobs.hasClaim(scope,'unrelated-legacy-token')).toBe(false);
  expect((await repos.memoryJobs.listScope(scope))[0].id).toBe(job.id);
});
it.each(['claim', 'memory', 'ignore', 'config'])('rolls back all writes on changed %s', async kind => {
  const { repos, input, job } = await harness();
  if (kind === 'claim') await repos.config.set(stateKey, '{"running":{"token":"other"}}');
  if (kind === 'memory') await repos.config.set(entriesKey, 'new');
  if (kind === 'ignore') await repos.config.set('lark.memory.ignore.app.groups', 'new');
  if (kind === 'config') await repos.config.set('lark.bots', 'new');
  await expect(repos.memoryJobs.apply(input)).rejects.toMatchObject({ code: 'MEMORY_CONCURRENT_CHANGE' });
  expect((await repos.memoryJobs.get(scope, job.id))?.receipt).toBeUndefined();
  expect(await repos.memoryJobs.isConsumed(scope, 'old')).toBe(false);
  if (kind !== 'memory') expect(await repos.config.get(entriesKey)).toBeUndefined();
});
it('rejects missing guards, foreign config writes and unfrozen consumption', async () => {
  const { repos, input } = await harness();
  await expect(repos.memoryJobs.apply({ ...input, versions: [] })).rejects.toMatchObject({ code: 'MEMORY_JOB_CONFLICT' });
  await expect(repos.memoryJobs.apply({ ...input, writes: [{ key: 'lark.memory.other.groups', value: 'bad' }] })).rejects.toMatchObject({ code: 'MEMORY_SCOPE_INVALID' });
  await expect(repos.memoryJobs.apply({ ...input, consumedTaskIds: ['new'] })).rejects.toMatchObject({ code: 'MEMORY_JOB_CONFLICT' });
  expect(await repos.config.get('lark.memory.other.groups')).toBeUndefined();
});
it('enforces immutable inputs and process bot boundaries', async () => {
  const { repos, job } = await harness();
  await expect(repos.memoryJobs.update({ ...job, input: {} }, 0)).rejects.toMatchObject({ code: 'MEMORY_JOB_CONFLICT' });
  await repos.config.set('lark.bots', '[{"appId":"assigned"}]');
  await repos.config.set('dutydeck.bot_process', '{"version":1,"appId":"assigned"}');
  await expect(repos.memoryJobs.listScope(scope)).rejects.toMatchObject({ code: 'BOT_PROCESS_SCOPE' });
  await expect(repos.memoryJobs.create({ ...job, id: 'memory_' + 'c'.repeat(64) })).rejects.toMatchObject({ code: 'BOT_PROCESS_SCOPE' });
});
it('checks committed consumption inside the enqueue transaction, even with an earlier unconsumed read', async () => {
  const { repos,input } = await harness();
  expect(await repos.memoryJobs.isConsumed(scope,'old')).toBe(false);
  const oldState = await repos.config.get(stateKey);
  await repos.memoryJobs.apply(input);
  const committed = await repos.config.get(stateKey);
  expect(await repos.memoryJobs.enqueuePendingTurn({ scope,taskId:'old',expectedState:oldState,state:'{"v":1,"pendingTurns":[{"taskId":"old"}]}' })).toBe('consumed');
  expect(await repos.memoryJobs.enqueuePendingTurn({ scope,taskId:'old',expectedState:committed,state:'{"v":1,"pendingTurns":[{"taskId":"old"}]}' })).toBe('consumed');
  expect(await repos.config.get(stateKey)).toBe(committed);
});
it('preserves concurrent pending state and enforces the bot scope for atomic enqueue', async () => {
  const { repos } = await harness();
  const state = await repos.config.get(stateKey);
  expect(await repos.memoryJobs.enqueuePendingTurn({ scope,taskId:'later',expectedState:'stale',state:'{"v":1,"pendingTurns":[{"taskId":"later"}]}' })).toBe('conflict');
  expect(await repos.config.get(stateKey)).toBe(state);
  const next = JSON.stringify({ ...JSON.parse(state!),pendingTurns:[{ taskId:'old' },{ taskId:'new' },{ taskId:'later' }] });
  expect(await repos.memoryJobs.enqueuePendingTurn({ scope,taskId:'later',expectedState:state,state:next })).toBe('enqueued');
  expect(await repos.config.get(stateKey)).toBe(next);
  await repos.config.set('lark.bots','[{"appId":"assigned"}]');
  await repos.config.set('dutydeck.bot_process','{"version":1,"appId":"assigned"}');
  await expect(repos.memoryJobs.enqueuePendingTurn({ scope,taskId:'blocked',expectedState:next,state:'{}' })).rejects.toMatchObject({ code:'BOT_PROCESS_SCOPE' });
});

it('persists a receipt recovery claim before settling and rejects a stale recovery owner', async () => {
  const { repos,input } = await harness();
  const applied = await repos.memoryJobs.apply(input);
  await repos.config.set(stateKey,'{"v":1,"running":{"token":"recovery"}}');
  await expect(repos.memoryJobs.update({ ...applied,claimToken:'stale' },applied.revision)).rejects.toMatchObject({ code:'MEMORY_CLAIM_LOST' });
  const recovered = await repos.memoryJobs.update({ ...applied,claimToken:'recovery' },applied.revision);
  expect(recovered).toMatchObject({ state:'applied',claimToken:'recovery',receipt:applied.receipt });
  expect((await repos.memoryJobs.get(scope,applied.id))?.claimToken).toBe('recovery');
  await repos.memoryJobs.update({ ...recovered,state:'settled' },recovered.revision);
  expect(await repos.memoryJobs.hasClaim(scope,'recovery')).toBe(true);
  expect(await repos.memoryJobs.hasClaim(scope,'claim')).toBe(false);
});


it('backfills legacy receipts across scopes once and preserves them after reopen', async () => {
  const { job } = await harness();
  const filename = databasePath();
  const db = new Database(filename);
  db.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  withMigrationTransaction(db, () => {
    for (const migration of migrations.filter(item => item.version <= 38)) {
      migration.up(db);
      db.prepare('INSERT INTO schema_migrations VALUES (?,?)').run(migration.version, job.createdAt);
    }
  });
  const cases = [
    { appId: 'app', pool: 'groups', state: 'settled', ids: ['old', 'old', 'settled-only'] },
    { appId: 'app', pool: 'groups', state: 'applied', ids: ['old', 'applied-only'] },
    { appId: 'app', pool: 'personal', state: 'settled', ids: ['personal-only'] },
    { appId: 'other', pool: 'groups', state: 'settled', ids: ['other-only'] },
    { appId: 'app', pool: 'groups', state: 'failed', ids: [] }
  ];
  for (const [index, item] of cases.entries()) {
    const legacy = { ...job, id: `legacy_${index}`, scope: { appId: item.appId, pool: item.pool }, state: item.state,
      ...(item.state === 'failed' ? {} : { receipt: { appliedJobId: `legacy_${index}`, consumedTaskIds: item.ids, result: {}, appliedAt: job.createdAt } }) };
    db.prepare('INSERT INTO memory_jobs VALUES (?,?,?,?,?,?)').run(legacy.id, item.appId, item.pool, item.state, 0, JSON.stringify(legacy));
  }
  const before = db.prepare('SELECT * FROM memory_jobs ORDER BY id').all();
  db.close();
  for (let attempt = 0; attempt < 2; attempt++) {
    const repos = createRepositories(filename);
    try {
      expect(await repos.memoryJobs.isConsumed(scope, 'old')).toBe(true);
      expect(await repos.memoryJobs.isConsumed(scope, 'settled-only')).toBe(true);
      expect(await repos.memoryJobs.isConsumed(scope, 'applied-only')).toBe(true);
      expect(await repos.memoryJobs.isConsumed(scope, 'personal-only')).toBe(false);
      expect(await repos.memoryJobs.isConsumed({ appId: 'app', pool: 'personal' }, 'personal-only')).toBe(true);
      expect(await repos.memoryJobs.isConsumed({ appId: 'other', pool: 'groups' }, 'other-only')).toBe(true);
      expect(await repos.memoryJobs.isConsumed(scope, 'other-only')).toBe(false);
    } finally { repos.close(); }
  }
  const inspect = new Database(filename); open.push(inspect);
  expect(inspect.prepare('SELECT * FROM memory_jobs ORDER BY id').all()).toEqual(before);
  expect(inspect.prepare('SELECT count(*) AS n FROM memory_consumed_tasks').get()).toEqual({ n: 5 });
});

it('rolls back the consumption backfill and migration marker on failure', async () => {
  const db = new Database(':memory:'); open.push(db);
  db.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  withMigrationTransaction(db, () => {
    for (const migration of migrations.filter(item => item.version <= 38)) {
      migration.up(db); db.prepare('INSERT INTO schema_migrations VALUES (?,?)').run(migration.version, '2026-10-18');
    }
  });
  db.prepare('INSERT INTO memory_jobs VALUES (?,?,?,?,?,?)').run('legacy', 'app', 'groups', 'settled', 1, JSON.stringify({ receipt: { consumedTaskIds: ['old'] } }));
  const migration = migrations.find(item => item.version === 39)!;
  expect(migration).toBeDefined();
  const up = migration.up;
  try {
    migration.up = database => { up(database); throw new Error('injected after backfill'); };
    expect(() => runMigrations(db)).toThrow('injected after backfill');
  } finally { migration.up = up; }
  expect(db.prepare("SELECT name FROM sqlite_master WHERE name='memory_consumed_tasks'").get()).toBeUndefined();
  expect(db.prepare('SELECT version FROM schema_migrations WHERE version=39').get()).toBeUndefined();
  runMigrations(db);
  expect(db.prepare('SELECT * FROM memory_consumed_tasks').all()).toEqual([{ app_id: 'app', pool: 'groups', task_id: 'old' }]);
});

it.each(['receipt', 'fact'])('rolls back configs, receipt and consumption when the %s write fails', async target => {
  const filename = databasePath();
  const { repos, input, job } = await harness(filename);
  const db = new Database(filename); open.push(db);
  db.exec(target === 'receipt'
    ? "CREATE TRIGGER reject_apply BEFORE UPDATE ON memory_jobs BEGIN SELECT RAISE(ABORT, 'injected receipt failure'); END"
    : "CREATE TRIGGER reject_apply BEFORE INSERT ON memory_consumed_tasks BEGIN SELECT RAISE(ABORT, 'injected fact failure'); END");
  const state = await repos.config.get(stateKey);
  await expect(repos.memoryJobs.apply(input)).rejects.toThrow('injected');
  expect(await repos.config.get(stateKey)).toBe(state);
  expect(await repos.config.get(entriesKey)).toBeUndefined();
  expect(await repos.memoryJobs.get(scope, job.id)).toEqual(job);
  expect(await repos.memoryJobs.isConsumed(scope, 'old')).toBe(false);
  expect(db.prepare('SELECT count(*) AS n FROM memory_consumed_tasks').get()).toEqual({ n: 0 });
  db.exec('DROP TRIGGER reject_apply');
  const applied = await repos.memoryJobs.apply({ ...input, consumedTaskIds: ['old', 'old'] });
  expect((await repos.memoryJobs.apply(input)).receipt).toEqual(applied.receipt);
  expect(db.prepare('SELECT count(*) AS n FROM memory_consumed_tasks').get()).toEqual({ n: 1 });
  const other = createRepositories(filename); open.push(other);
  expect(await other.memoryJobs.isConsumed(scope, 'old')).toBe(true);
  expect(await other.memoryJobs.enqueuePendingTurn({ scope, taskId: 'old', expectedState: state, state: '{}' })).toBe('consumed');
});

it('uses a scoped task seek for a new turn amid large settled receipt history', async () => {
  const filename = databasePath();
  const { repos, job } = await harness(filename);
  const db = new Database(filename); open.push(db);
  db.transaction(() => {
    const insert = db.prepare('INSERT INTO memory_jobs VALUES (?,?,?,?,?,?)');
    for (let index = 0; index < 10_000; index++) {
      const receipt = { consumedTaskIds: [`task_${index}_a`, `task_${index}_b`, `task_${index}_c`] };
      insert.run(`history_${index}`, scope.appId, scope.pool, 'settled', 1, JSON.stringify({ ...job, state: 'settled', receipt }));
    }
  })();
  // Exercise the real migration backfill on the synthetic historical sample.
  db.exec('DROP TABLE IF EXISTS memory_consumed_tasks; DELETE FROM schema_migrations WHERE version=39');
  runMigrations(db);
  const prepare = vi.spyOn(Database.prototype, 'prepare');
  expect(await repos.memoryJobs.isConsumed(scope, 'new-turn')).toBe(false);
  const query = prepare.mock.calls.map(([sql]) => sql).find(sql => /SELECT 1 FROM memory_/.test(sql))!;
  prepare.mockRestore();
  expect(db.prepare("SELECT count(*) AS n FROM memory_jobs, json_each(memory_jobs.json, '$.receipt.consumedTaskIds')").get()).toEqual({ n: 30_000 });
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${query}`).all(scope.appId, scope.pool, 'new-turn');
  expect(plan).toEqual([expect.objectContaining({ detail: expect.stringMatching(/SEARCH memory_consumed_tasks USING PRIMARY KEY \(app_id=\? AND pool=\? AND task_id=\?\)/) })]);
  expect(query).not.toContain('json_each');
});
