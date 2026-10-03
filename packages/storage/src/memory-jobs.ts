import type Database from 'better-sqlite3';
import { RuntimeError, type MemoryJob, type MemoryJobRepository, type MemoryJobScope } from '@dutydeck/shared';
import { assertBotProcessApp, assertBotProcessConfigWrite } from './bot-process.js';

export function createMemoryJobSchema(db: Database.Database): void {
  db.exec(`CREATE TABLE memory_jobs (id TEXT PRIMARY KEY, app_id TEXT NOT NULL, pool TEXT NOT NULL, state TEXT NOT NULL, revision INTEGER NOT NULL, json TEXT NOT NULL);
    CREATE UNIQUE INDEX memory_jobs_unsettled ON memory_jobs(app_id,pool) WHERE state NOT IN ('settled','failed');`);
}
export function createMemoryJobRepository(db: Database.Database): MemoryJobRepository {
  const read = (key: string) => (db.prepare('SELECT value FROM configs WHERE key=?').get(key) as { value: string } | undefined)?.value;
  const scopeCheck = (scope: MemoryJobScope) => {
    if (!/^[A-Za-z0-9_-]+$/.test(scope.appId) || !/^[A-Za-z0-9_-]+$/.test(scope.pool)) throw new RuntimeError('MEMORY_SCOPE_INVALID', 'Invalid memory job scope', 400);
    assertBotProcessApp(db, scope.appId);
  };
  const consumed = (scope: MemoryJobScope, taskId: string) => Boolean(db.prepare("SELECT 1 FROM memory_jobs, json_each(memory_jobs.json, '$.receipt.consumedTaskIds') AS consumed WHERE app_id=? AND pool=? AND consumed.value=? LIMIT 1").get(scope.appId, scope.pool, taskId));
  const decode = (row: unknown): MemoryJob | undefined => row ? JSON.parse((row as { json: string }).json) : undefined;
  const get = (scope: MemoryJobScope, id: string) => {
    scopeCheck(scope);
    return decode(db.prepare('SELECT json FROM memory_jobs WHERE id=? AND app_id=? AND pool=?').get(id, scope.appId, scope.pool));
  };
  const save = (job: MemoryJob, expected: number) => {
    scopeCheck(job.scope);
    const original = get(job.scope, job.id);
    if (!original || original.revision !== expected || original.receipt) throw new RuntimeError('MEMORY_JOB_CONFLICT', 'Memory job version changed', 409);
    if (job.kind !== original.kind || job.mode !== original.mode || job.createdAt !== original.createdAt || job.inputDigest !== original.inputDigest || JSON.stringify(job.input) !== JSON.stringify(original.input) || job.sessionId !== original.sessionId || JSON.stringify(job.sessionInput) !== JSON.stringify(original.sessionInput) || JSON.stringify(job.versions) !== JSON.stringify(original.versions)) throw new RuntimeError('MEMORY_JOB_CONFLICT', 'Memory job frozen input changed', 409);
    if (original.requests.some((request, index) => JSON.stringify(request) !== JSON.stringify(job.requests[index])) || job.requests.length > 2 || job.requests.some((request,index) => request.key !== `${job.id}:${index}` || request.sessionId !== job.sessionId)) throw new RuntimeError('MEMORY_JOB_CONFLICT', 'Memory request identity changed', 409);
    const next = { ...job, revision: expected + 1 };
    db.prepare('UPDATE memory_jobs SET state=?,revision=?,json=? WHERE id=? AND revision=?').run(next.state, next.revision, JSON.stringify(next), next.id, expected);
    return next;
  };
  return {
    async enqueuePendingTurn(input) {
      return db.transaction(() => {
        scopeCheck(input.scope);
        const key = `lark.memory.state.${input.scope.appId}.${input.scope.pool}`;
        assertBotProcessConfigWrite(db, key, input.state);
        if (consumed(input.scope, input.taskId)) return 'consumed' as const;
        if (read(key) !== input.expectedState) return 'conflict' as const;
        db.prepare('INSERT INTO configs(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, input.state);
        return 'enqueued' as const;
      }).immediate();
    },
    async hasClaim(scope, token) { scopeCheck(scope); return Boolean(db.prepare("SELECT 1 FROM memory_jobs WHERE app_id=? AND pool=? AND (state NOT IN ('settled','failed') OR json_extract(json, '$.claimToken') = ?) LIMIT 1").get(scope.appId, scope.pool, token ?? null)); },
    async isConsumed(scope, taskId) { scopeCheck(scope); return consumed(scope, taskId); },
    async listUnsettled(appId) { scopeCheck({ appId, pool: 'groups' }); return (db.prepare("SELECT json FROM memory_jobs WHERE app_id=? AND state NOT IN ('settled','failed') ORDER BY rowid").all(appId) as Array<{ json: string }>).map(row => JSON.parse(row.json)); },
    async listScope(scope) { scopeCheck(scope); return (db.prepare('SELECT json FROM memory_jobs WHERE app_id=? AND pool=? ORDER BY rowid').all(scope.appId, scope.pool) as Array<{ json: string }>).map(row => JSON.parse(row.json)); },
    async get(scope, id) { return get(scope, id); },
    async findUnsettled(scope) {
      scopeCheck(scope);
      return decode(db.prepare("SELECT json FROM memory_jobs WHERE app_id=? AND pool=? AND state NOT IN ('settled','failed') LIMIT 1").get(scope.appId, scope.pool));
    },
    async create(job) {
      scopeCheck(job.scope);
      if (!/^memory_[a-f0-9]{64}$/.test(job.id) || job.revision !== 0 || job.state !== 'prepared' || job.receipt) throw new RuntimeError('MEMORY_JOB_INVALID', 'Invalid memory job intention', 400);
      if (job.sessionInput.source !== 'lark-memory' || job.sessionInput.sourceId !== `${job.scope.appId}:${job.scope.pool}:memory` || !['extraction','consolidation'].includes(job.kind) || !['compatible','isolated'].includes(job.mode)) throw new RuntimeError('MEMORY_JOB_INVALID', 'Memory job session outside scope', 400);
      const required = [`lark.memory.${job.scope.appId}.${job.scope.pool}`, `lark.memory.ignore.${job.scope.appId}.${job.scope.pool}`, 'lark.bots', 'lark.credentials'];
      if (required.some(key => !job.versions.some(version => version.key === key))) throw new RuntimeError('MEMORY_JOB_INVALID', 'Missing frozen memory and authorization versions', 400);
      db.prepare('INSERT INTO memory_jobs VALUES (?,?,?,?,?,?)').run(job.id, job.scope.appId, job.scope.pool, job.state, job.revision, JSON.stringify(job));
    },
    async update(job, expectedRevision) {
      return db.transaction(() => {
        const original = get(job.scope, job.id);
        if (original?.receipt && original.state === 'applied' && ['applied','settled'].includes(job.state) && original.revision === expectedRevision) {
          if (job.claimToken !== original.claimToken) {
            const state = JSON.parse(read(`lark.memory.state.${job.scope.appId}.${job.scope.pool}`) ?? '{}');
            if (state.running?.token !== job.claimToken) throw new RuntimeError('MEMORY_CLAIM_LOST', 'Memory pool recovery claim changed', 409);
          }
          const next = { ...original, claimToken: job.claimToken, state: job.state, revision: expectedRevision + 1 };
          db.prepare('UPDATE memory_jobs SET state=?,revision=?,json=? WHERE id=?').run(next.state, next.revision, JSON.stringify(next), next.id);
          return next;
        }
        return save(job, expectedRevision);
      }).immediate();
    },
    async apply(input) {
      return db.transaction(() => {
        const job = get(input.job.scope, input.job.id);
        if (!job) throw new RuntimeError('MEMORY_JOB_CONFLICT', 'Missing memory job', 409);
        if (job.receipt) return job;
        if (job.revision !== input.job.revision || job.claimToken !== input.claimToken || ['failed','settled'].includes(job.state)) throw new RuntimeError('MEMORY_CLAIM_LOST', 'Memory job claim changed', 409);
        const scope = job.scope;
        if (job.versions.some(version => !input.versions.some(check => check.key === version.key && check.value === version.value))) throw new RuntimeError('MEMORY_JOB_CONFLICT', 'Missing frozen input version checks', 409);
        const inputTaskIds = ((job.input as { turns?: Array<{ taskId: string }> })?.turns ?? []).map(turn => turn.taskId);
        if (input.consumedTaskIds.some(id => !inputTaskIds.includes(id))) throw new RuntimeError('MEMORY_JOB_CONFLICT', 'Cannot consume inputs outside frozen job', 409);
        const allowed = new Set([`lark.memory.${scope.appId}.${scope.pool}`, `lark.memory.state.${scope.appId}.${scope.pool}`]);
        const checkKeys = new Set([...allowed, `lark.memory.ignore.${scope.appId}.${scope.pool}`, 'lark.bots', 'lark.credentials']);
        for (const version of input.versions) {
          if (!checkKeys.has(version.key)) throw new RuntimeError('MEMORY_SCOPE_INVALID', 'Memory transaction check outside scope', 403);
          if (read(version.key) !== version.value) throw new RuntimeError('MEMORY_CONCURRENT_CHANGE', 'Memory input or authorization changed', 409);
        }
        for (const write of input.writes) {
          if (!allowed.has(write.key)) throw new RuntimeError('MEMORY_SCOPE_INVALID', 'Memory transaction write outside scope', 403);
          assertBotProcessConfigWrite(db, write.key, write.value);
        }
        const stateKey = `lark.memory.state.${scope.appId}.${scope.pool}`;
        const state = JSON.parse(read(stateKey) ?? '{}');
        if (state.running?.token !== input.claimToken) throw new RuntimeError('MEMORY_CLAIM_LOST', 'Memory pool claim changed', 409);
        for (const write of input.writes) db.prepare('INSERT INTO configs(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(write.key, write.value);
        const next: MemoryJob = { ...job, revision: job.revision + 1, state: 'applied', receipt: { appliedJobId: job.id, consumedTaskIds: input.consumedTaskIds, result: input.result, appliedAt: input.appliedAt } };
        db.prepare('UPDATE memory_jobs SET state=?,revision=?,json=? WHERE id=?').run(next.state, next.revision, JSON.stringify(next), next.id);
        return next;
      }).immediate();
    }
  };
}
