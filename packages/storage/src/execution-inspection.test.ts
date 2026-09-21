import Database from 'better-sqlite3';
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRepositories } from './index.js';
import { inspectExecutionDatabase } from './execution-inspection.js';
import { openDatabaseControl } from './database-control.js';

describe('inspectExecutionDatabase', () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const dir of directories.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  });

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'dutydeck-inspect-test-'));
    directories.push(dir);
    return dir;
  }

  function tempFile(name = 'test.db'): string {
    return join(tempDir(), name);
  }

  it('returns missing for non-existent path without creating files or directories', () => {
    const dir = tempDir();
    const missingDb = join(dir, 'sub', 'missing.db');
    expect(existsSync(missingDb)).toBe(false);
    expect(existsSync(join(dir, 'sub'))).toBe(false);

    const result = inspectExecutionDatabase(missingDb);
    expect(result).toEqual({
      path: missingDb,
      status: 'missing'
    });
    // Verify no file or directory was created
    expect(existsSync(missingDb)).toBe(false);
    expect(existsSync(join(dir, 'sub'))).toBe(false);
  });

  it('detects uninitialized on an empty sqlite database', () => {
    const dbPath = tempFile();
    const db = new Database(dbPath);
    db.close();

    const result = inspectExecutionDatabase(dbPath);
    expect(result.status).toBe('uninitialized');
    expect(result.counts).toEqual({
      tasks: 0,
      attempts: 0,
      resources: 0,
      registeredAccess: 0
    });
  });

  it('detects uninitialized when only control and access tables exist', () => {
    const dbPath = tempFile();
    writeFileSync(dbPath, '');
    const control = openDatabaseControl(dbPath, {});
    try {
      // openDatabaseControl creates dutydeck_control and dutydeck_access
      const result = inspectExecutionDatabase(dbPath);
      expect(result.status).toBe('uninitialized');
      expect(result.control).toBeDefined();
      expect(result.control?.phase).toBe('maintenance');
      expect(result.control?.hasMaintenance).toBe(true);
      expect(result.control?.registeredAccessCount).toBe(1);
      expect(result.counts?.registeredAccess).toBe(1);
      expect(result.counts?.tasks).toBe(0);
    } finally {
      control.close();
    }
  });

  it('detects legacy dutydeck databases and reads schema version and task counts', async () => {
    const dbPath = tempFile();
    const repos = createRepositories(dbPath, { newDatabaseAuthority: 'legacy' });
    try {
      expect(repos.execution.authority()).toBe('legacy');
      await repos.sessions.save({
        id: 'session-1',
        agentId: 'agent-1',
        state: 'idle',
        cwd: '/tmp',
        runId: 'run-1',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
      expect(repos.tasks.create).toBeDefined();
      await repos.tasks.create!({
        id: 'task-1',
        sessionId: 'session-1',
        prompt: 'hello legacy',
        status: 'queued',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
    } finally {
      repos.close();
    }

    const result = inspectExecutionDatabase(dbPath);
    expect(result.status).toBe('legacy');
    expect(result.authority).toBe('legacy');
    expect(result.schemaVersion).toBe(24);
    expect(result.counts?.tasks).toBe(1);
    expect(result.counts?.attempts).toBe(0);
    expect(result.counts?.resources).toBe(0);
  });

  it('detects pre-v18 historical dutydeck database without execution_authority table as legacy', () => {
    const dbPath = tempFile();
    const db = new Database(dbPath);
    // Simulate a v10 legacy database
    db.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations VALUES (1, '2026-01-01'), (10, '2026-01-01');
      CREATE TABLE sessions (id TEXT PRIMARY KEY, agent_id TEXT, state TEXT, cwd TEXT, run_id TEXT, created_at TEXT, updated_at TEXT);
      CREATE TABLE tasks (id TEXT PRIMARY KEY, session_id TEXT, prompt TEXT, status TEXT, created_at TEXT, updated_at TEXT);
      INSERT INTO tasks VALUES ('t-1', 's-1', 'legacy prompt', 'completed', '2026-01-01', '2026-01-01');
    `);
    db.close();

    const result = inspectExecutionDatabase(dbPath);
    expect(result.status).toBe('legacy');
    // The authority marker row has never been persisted on a pre-v18 schema;
    // status is legacy by shape, but we must not invent an authority value.
    expect(result.authority).toBeUndefined();
    expect(result.schemaVersion).toBe(10);
    expect(result.counts?.tasks).toBe(1);
    expect(result.counts?.attempts).toBe(0);
  });

  it('detects ledger_v1 after upgrading legacy database and reflects attempts and resources', async () => {
    const dbPath = tempFile();
    const repos = createRepositories(dbPath, { newDatabaseAuthority: 'legacy' });
    try {
      await repos.sessions.save({
        id: 'session-1',
        agentId: 'agent-1',
        state: 'idle',
        cwd: '/tmp',
        runId: 'run-1',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
      expect(repos.tasks.create).toBeDefined();
      await repos.tasks.create!({
        id: 'task-1',
        sessionId: 'session-1',
        prompt: 'hello upgrade',
        status: 'completed',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
      repos.execution.upgradeLegacy();
      expect(repos.execution.authority()).toBe('ledger_v1');
    } finally {
      repos.close();
    }

    const result = inspectExecutionDatabase(dbPath);
    expect(result.status).toBe('ledger_v1');
    expect(result.authority).toBe('ledger_v1');
    expect(result.schemaVersion).toBe(24);
    expect(result.counts?.tasks).toBe(1);
    expect(result.counts?.attempts).toBe(1);
    expect(result.counts?.resources).toBe(1);
  });

  it('detects v19 bot configuration base tables on a fully migrated database', () => {
    const dbPath = tempFile();
    const repos = createRepositories(dbPath, { newDatabaseAuthority: 'legacy' });
    repos.close();

    const result = inspectExecutionDatabase(dbPath);
    expect(result.status).toBe('legacy');
    expect(result.schemaVersion).toBe(24);

    const db = new Database(dbPath, { readonly: true });
    try {
      const authRow = db.prepare('SELECT id, authority FROM configuration_authority').get() as { id: number; authority: string } | undefined;
      expect(authRow).toEqual({ id: 1, authority: 'legacy' });

      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(r => r.name);
      expect(tables).toContain('configuration_authority');
      expect(tables).toContain('configuration_operations');
      expect(tables).toContain('configuration_changes');
      expect(tables).toContain('configuration_versions');
      expect(tables).toContain('full_trust_confirmations');
    } finally {
      db.close();
    }
  });

  it('detects unsupported on unrelated databases or broken schemas', () => {
    // 1. Unrelated database
    const unrelatedDb = tempFile('unrelated.db');
    const db1 = new Database(unrelatedDb);
    db1.exec('CREATE TABLE blog_posts (id INTEGER PRIMARY KEY, title TEXT);');
    db1.close();

    const r1 = inspectExecutionDatabase(unrelatedDb);
    expect(r1.status).toBe('unsupported');
    expect(r1.unsupportedReason).toBe('NOT_A_DUTYDECK_DATABASE');

    // 1b. User view with reserved control table name must not be classified as uninitialized
    const viewControlDb = tempFile('view-control.db');
    const dbViewControl = new Database(viewControlDb);
    dbViewControl.exec('CREATE VIEW dutydeck_control AS SELECT 1 AS x;');
    dbViewControl.close();

    const rViewControl = inspectExecutionDatabase(viewControlDb);
    expect(rViewControl.status).toBe('unsupported');
    expect(rViewControl.unsupportedReason).toBe('NOT_A_DUTYDECK_DATABASE');

    // 1c. User view with reserved access table name must not be classified as uninitialized
    const viewAccessDb = tempFile('view-access.db');
    const dbViewAccess = new Database(viewAccessDb);
    dbViewAccess.exec('CREATE VIEW dutydeck_access AS SELECT 1 AS x;');
    dbViewAccess.close();

    const rViewAccess = inspectExecutionDatabase(viewAccessDb);
    expect(rViewAccess.status).toBe('unsupported');
    expect(rViewAccess.unsupportedReason).toBe('NOT_A_DUTYDECK_DATABASE');

    // 2. Future unknown migration version
    const futureDb = tempFile('future.db');
    const db2 = new Database(futureDb);
    db2.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations VALUES (999, '2030-01-01');
      CREATE TABLE sessions (id TEXT PRIMARY KEY);
      CREATE TABLE tasks (id TEXT PRIMARY KEY);
    `);
    db2.close();

    const r2 = inspectExecutionDatabase(futureDb);
    expect(r2.status).toBe('unsupported');
    expect(r2.unsupportedReason).toBe('DATABASE_SCHEMA_TOO_NEW');

    // 3. Claims ledger_v1 but missing required ledger tables
    const incompleteLedgerDb = tempFile('incomplete.db');
    const db3 = new Database(incompleteLedgerDb);
    db3.exec(`
      CREATE TABLE execution_authority (id INTEGER PRIMARY KEY, authority TEXT);
      INSERT INTO execution_authority VALUES (1, 'ledger_v1');
      CREATE TABLE sessions (id TEXT PRIMARY KEY, agent_id TEXT, state TEXT, cwd TEXT, run_id TEXT, created_at TEXT, updated_at TEXT);
      CREATE TABLE tasks (id TEXT PRIMARY KEY, session_id TEXT, prompt TEXT, status TEXT, created_at TEXT, updated_at TEXT);
    `);
    db3.close();

    const r3 = inspectExecutionDatabase(incompleteLedgerDb);
    expect(r3.status).toBe('unsupported');
    expect(r3.unsupportedReason).toContain('INCOMPLETE_LEDGER_SCHEMA');
  });

  it('throws clearly on corrupted execution authority record instead of swallowing as missing', () => {
    const dbPath = tempFile('bad-authority.db');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE execution_authority (id INTEGER PRIMARY KEY, authority TEXT);
      INSERT INTO execution_authority VALUES (1, 'invalid_authority_value');
    `);
    db.close();

    expect(() => inspectExecutionDatabase(dbPath)).toThrow('EXECUTION_AUTHORITY_INVALID');
  });

  it('throws clearly on non-sqlite files or directory path', () => {
    // Non-sqlite text file
    const textFile = tempFile('not-sqlite.txt');
    writeFileSync(textFile, 'This is definitely not a SQLite database file.');
    expect(() => inspectExecutionDatabase(textFile)).toThrow();

    // Directory path
    const dir = tempDir();
    expect(() => inspectExecutionDatabase(dir)).toThrow('DATABASE_UNSAFE_FILE');
  });

  it('throws clearly on unreadable file without swallowing as missing', () => {
    if (process.platform === 'win32') return;
    const dbPath = tempFile('unreadable.db');
    writeFileSync(dbPath, 'test content');
    chmodSync(dbPath, 0o000);

    try {
      expect(() => inspectExecutionDatabase(dbPath)).toThrow();
    } finally {
      // restore permission so temp cleanup succeeds
      chmodSync(dbPath, 0o600);
    }
  });

  it('reads uncheckpointed committed WAL transactions without immutable flag', () => {
    const dbPath = tempFile('wal-test.db');
    const repos = createRepositories(dbPath, { newDatabaseAuthority: 'legacy' });
    try {
      const directDb = new Database(dbPath);
      try {
        directDb.pragma('journal_mode = WAL');
        directDb.prepare("INSERT INTO tasks (id, session_id, prompt, status, created_at, updated_at) VALUES ('task-wal', 's-1', 'wal prompt', 'queued', '2026-01-01', '2026-01-01')").run();
        // Ensure WAL file exists and holds committed frame
        expect(existsSync(`${dbPath}-wal`)).toBe(true);
      } finally {
        directDb.close();
      }

      // Read-only inspection should see the committed WAL write
      const inspection = inspectExecutionDatabase(dbPath);
      expect(inspection.counts?.tasks).toBe(1);
    } finally {
      repos.close();
    }
  });

  it('can inspect database while an active runtime holds it', () => {
    const dbPath = tempFile('runtime-active.db');
    const runtimeRepos = createRepositories(dbPath, { mode: 'runtime' });
    const claim = runtimeRepos.control.attachRuntime('runtime-instance-1');
    try {
      // Active runtime is holding the database
      const inspection = inspectExecutionDatabase(dbPath);
      expect(inspection.status).toBe('legacy');
      expect(inspection.control?.hasRuntime).toBe(true);
      expect(inspection.control?.registeredAccessCount).toBeGreaterThanOrEqual(1);

      // Verify reading status did not disrupt the active runtime claim
      expect(() => claim.assertCurrent()).not.toThrow();
    } finally {
      claim.release();
      runtimeRepos.close();
    }
  });

  it('does not mutate schema, marker or access records during inspection', () => {
    const dbPath = tempFile('side-effects.db');
    const repos = createRepositories(dbPath);
    repos.close();

    const db = new Database(dbPath, { readonly: true });
    const beforeSchema = db.prepare("SELECT * FROM main.sqlite_schema ORDER BY name").all();
    const beforeAccess = db.prepare("SELECT * FROM dutydeck_access ORDER BY id").all();
    const beforeControl = db.prepare("SELECT * FROM dutydeck_control WHERE id = 1").get();
    db.close();

    // Perform inspection
    const result = inspectExecutionDatabase(dbPath);
    expect(result.status).toBe('legacy');

    // Verify database state is bit-for-bit identical in schema, access, and control
    const verifyDb = new Database(dbPath, { readonly: true });
    try {
      const afterSchema = verifyDb.prepare("SELECT * FROM main.sqlite_schema ORDER BY name").all();
      const afterAccess = verifyDb.prepare("SELECT * FROM dutydeck_access ORDER BY id").all();
      const afterControl = verifyDb.prepare("SELECT * FROM dutydeck_control WHERE id = 1").get();

      expect(afterSchema).toEqual(beforeSchema);
      expect(afterAccess).toEqual(beforeAccess);
      expect(afterControl).toEqual(beforeControl);
    } finally {
      verifyDb.close();
    }
  });
});
