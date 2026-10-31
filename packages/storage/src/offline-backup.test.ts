import Database from 'better-sqlite3';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { backupSqlite, withOfflineDatabase } from './offline-backup.js';
import { createRepositories } from './index.js';

const sqliteModule = createRequire(import.meta.url).resolve('better-sqlite3');
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const scratch = () => { const directory = mkdtempSync(join(tmpdir(), "dutydeck-o'backup-")); directories.push(directory); return directory; };

describe('withOfflineDatabase', () => {
  const source = () => {
    const path = join(scratch(), 'maintenance.db');
    createRepositories(path).close();
    return path;
  };
  it('commits callback writes, rolls back a thrown callback, and releases maintenance after both', async () => {
    const path = source();
    await withOfflineDatabase(path, async database => { database.prepare('INSERT INTO configs VALUES (?,?)').run('saved', 'yes'); });
    await expect(withOfflineDatabase(path, async database => {
      database.prepare('INSERT INTO configs VALUES (?,?)').run('rollback', 'yes');
      throw new Error('callback failed');
    })).rejects.toThrow('callback failed');
    const repos = createRepositories(path);
    try {
      expect(await repos.config.get('saved')).toBe('yes');
      expect(await repos.config.get('rollback')).toBeUndefined();
      const claim = repos.control.attachRuntime('after-maintenance');
      claim.release();
    } finally { repos.close(); }
  });
  it('refuses a live runtime, another accessor and an independent SQLite writer', async () => {
    const path = source();
    const repos = createRepositories(path);
    const claim = repos.control.attachRuntime('live-runtime');
    let called = false;
    const callback = async () => { called = true; };
    try {
      await expect(withOfflineDatabase(path, callback)).rejects.toThrow('DATABASE_RUNTIME_STILL_ATTACHED');
      claim.release();
      await expect(withOfflineDatabase(path, callback)).rejects.toThrow('DATABASE_UPGRADE_BUSY');
    } finally { repos.close(); }
    const writer = new Database(path);
    writer.exec('BEGIN IMMEDIATE');
    try { await expect(withOfflineDatabase(path, callback)).rejects.toThrow(/locked|busy/i); }
    finally { writer.exec('ROLLBACK'); writer.close(); }
    expect(called).toBe(false);
    await withOfflineDatabase(path, async database => { expect(database.pragma('foreign_keys', { simple: true })).toBe(1); });
  });
});

describe('backupSqlite', () => {
  it('writes a compact private snapshot that keeps committed WAL data and does not block writers', async () => {
    const directory = scratch();
    const source = join(directory, 'source.db');
    const target = join(directory, 'backup.db');
    const writer = new Database(source);
    try {
      writer.pragma('journal_mode=WAL');
      writer.pragma('wal_autocheckpoint=0');
      writer.exec('CREATE TABLE rows (id INTEGER PRIMARY KEY, payload BLOB NOT NULL)');
      const insert = writer.prepare('INSERT INTO rows (payload) VALUES (?)');
      for (let index = 0; index < 400; index++) insert.run(Buffer.alloc(8_000, index % 251));
      writer.exec('DELETE FROM rows WHERE id > 20');
      writer.pragma('wal_checkpoint(TRUNCATE)');
      writer.exec("INSERT INTO rows (payload) VALUES (x'abcd')"); // committed, still only in the WAL
      writeFileSync(target, 'stale previous backup');
      const expected = writer.prepare('SELECT id, hex(payload) AS payload FROM rows ORDER BY id').all();
      const sourceSize = statSync(source).size;

      await backupSqlite(source, target);
      writer.exec("INSERT INTO rows (payload) VALUES (x'ef')"); // source stays writable afterwards

      expect(statSync(target).size).toBeLessThan(sourceSize / 5);
      expect(statSync(target).mode & 0o777).toBe(0o600);
      expect(readdirSync(directory).filter(name => name.endsWith('.tmp'))).toEqual([]);
      const copy = new Database(target, { readonly: true });
      try {
        expect(copy.pragma('integrity_check', { simple: true })).toBe('ok');
        expect(copy.prepare('SELECT id, hex(payload) AS payload FROM rows ORDER BY id').all()).toEqual(expected);
      } finally { copy.close(); }
    } finally { writer.close(); }
  });

  it('takes consistent snapshots while another process keeps writing the source', async () => {
    const directory = scratch();
    const source = join(directory, 'source.db');
    const seed = new Database(source);
    seed.pragma('journal_mode=WAL');
    seed.exec('CREATE TABLE ledger (id INTEGER PRIMARY KEY, a INTEGER NOT NULL, b INTEGER NOT NULL)');
    seed.close();
    const script = join(directory, 'writer.cjs');
    // Each transaction keeps a + b = 0, so any torn snapshot shows a non-zero sum.
    writeFileSync(script, `const Database = require(${JSON.stringify(sqliteModule)});
const db = new Database(process.argv[2]); db.pragma('busy_timeout = 5000');
const write = db.transaction(n => { db.prepare('INSERT INTO ledger (a, b) VALUES (?, ?)').run(n, -n); });
let n = 0; const timer = setInterval(() => { for (let i = 0; i < 20; i++) write(++n); }, 1);
process.stdout.write('ready\\n'); process.on('SIGTERM', () => { clearInterval(timer); db.close(); process.exit(0); });`);
    const child = spawn(process.execPath, [script, source], { stdio: ['ignore', 'pipe', 'inherit'] });
    try {
      await new Promise<void>((resolve, reject) => { child.stdout.once('data', () => resolve()); child.once('exit', code => reject(new Error(`writer exited ${code}`))); });
      for (let round = 0; round < 5; round++) {
        const target = join(directory, `backup-${round}.db`);
        await backupSqlite(source, target);
        const copy = new Database(target, { readonly: true });
        try {
          expect(copy.pragma('integrity_check', { simple: true })).toBe('ok');
          expect(copy.prepare('SELECT COALESCE(SUM(a + b), 0) FROM ledger').pluck().get()).toBe(0);
          if (round === 4) expect(copy.prepare('SELECT COUNT(*) FROM ledger').pluck().get() as number).toBeGreaterThan(0);
        } finally { copy.close(); }
      }
    } finally { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); }
  });

  it('leaves no partial target or temp file when the source cannot be read', async () => {
    const directory = scratch();
    await expect(backupSqlite(join(directory, 'missing.db'), join(directory, 'backup.db'))).rejects.toThrow();
    expect(readdirSync(directory)).toEqual([]);
  });
});
