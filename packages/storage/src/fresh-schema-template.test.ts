import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createRepositories } from './index.js';
import { FRESH_SCHEMA_TEMPLATE_ENV, captureSchema, migrations, runMigrations } from './migrations.js';

const previous = process.env[FRESH_SCHEMA_TEMPLATE_ENV];
beforeEach(() => { delete process.env[FRESH_SCHEMA_TEMPLATE_ENV]; });
afterEach(() => { if (previous === undefined) delete process.env[FRESH_SCHEMA_TEMPLATE_ENV]; else process.env[FRESH_SCHEMA_TEMPLATE_ENV] = previous; });

// applied_at records when each migration ran, so it differs between any two databases.
const comparable = (db: Database.Database) => {
  const schema = captureSchema(db)!;
  return { ...schema, rows: schema.rows.map(entry => entry.table === 'schema_migrations'
    ? { ...entry, values: entry.values.map(row => row.map((value, index) => entry.columns[index] === 'applied_at' ? typeof value : value)) }
    : entry) };
};
const migrated = (template: boolean) => {
  if (template) process.env[FRESH_SCHEMA_TEMPLATE_ENV] = '1'; else delete process.env[FRESH_SCHEMA_TEMPLATE_ENV];
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
};

it('the test-only fresh schema template reproduces every object and seed row of the real migrations', () => {
  const real = migrated(false), copied = migrated(true), again = migrated(true);
  try {
    expect(captureSchema(real)!.tables.length + captureSchema(real)!.statements.length).toBeGreaterThan(100);
    expect(comparable(copied)).toEqual(comparable(real));
    expect(comparable(again)).toEqual(comparable(real));
    expect(copied.prepare('SELECT version FROM schema_migrations ORDER BY version').pluck().all()).toEqual(migrations.map(migration => migration.version));
    for (const db of [copied, again]) {
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(db.pragma('foreign_key_check')).toEqual([]);
      // A templated database is fully migrated: running the migrations again is a no-op.
      runMigrations(db);
      expect(comparable(db)).toEqual(comparable(real));
    }
  } finally { for (const db of [real, copied, again]) db.close(); }
});

it('the template only replaces migrations on an empty database and keeps file databases openable', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fresh-schema-template-'));
  try {
    process.env[FRESH_SCHEMA_TEMPLATE_ENV] = '1';
    const partial = new Database(':memory:');
    try {
      partial.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL, name TEXT)');
      runMigrations(partial);
      expect(comparable(partial)).toEqual(comparable(migrated(false)));
    } finally { partial.close(); }
    process.env[FRESH_SCHEMA_TEMPLATE_ENV] = '1';
    const file = join(directory, 'state.db');
    for (let open = 0; open < 2; open++) {
      const repos = createRepositories(file, { newDatabaseAuthority: 'ledger_v1' });
      try {
        await repos.config.set('probe', String(open));
        expect(repos.execution.authority()).toBe('ledger_v1');
        expect(await repos.config.get('probe')).toBe(String(open));
      } finally { repos.close(); }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
