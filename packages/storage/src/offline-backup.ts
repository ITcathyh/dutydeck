import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, openSync, renameSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { canonicalDatabase, openDatabaseControl } from './database-control.js';
import { migrations } from './migrations.js';

export const BACKUP_SCHEMA_VERSION = migrations.at(-1)!.version;

// Inline so bundled CLIs need no extra worker file. An eval worker resolves modules from the process cwd,
// so the driver path is resolved here, next to this module (or the bundle), and passed in.
// SqliteError is not a genuine Error and would reach the parent thread without its message, so rewrap it.
const VACUUM_WORKER = `const { workerData } = require('node:worker_threads');
const Database = require(workerData.driver);
try {
  const db = new Database(workerData.source, { readonly: true, fileMustExist: true });
  try { db.exec("VACUUM INTO '" + workerData.staging.replaceAll("'", "''") + "'"); } finally { db.close(); }
} catch (error) { throw Object.assign(new Error(error.message), { code: error.code }); }`;

/**
 * Write a compact, transactionally consistent copy (WAL included) of the source.
 * VACUUM INTO skips free pages that page-wise db.backup() would copy, and runs
 * on a read-only connection so live writers are not blocked. It runs in a worker
 * thread: a multi-GB copy must not stall the caller's timers (deploy drain renewal).
 */
export async function backupSqlite(source: string, target: string): Promise<void> {
  // VACUUM INTO accepts only a missing or empty file; build in a private temp file, then replace.
  const staging = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    closeSync(openSync(staging, 'wx', 0o600));
    await new Promise<void>((resolve, reject) => {
      const worker = new Worker(VACUUM_WORKER, { eval: true, workerData: { driver: createRequire(import.meta.url).resolve('better-sqlite3'), source, staging } });
      // Settle only once the thread is gone, so callers never touch the staging file while it may still be open.
      let failure: unknown;
      worker.once('error', error => { failure = error; });
      worker.once('exit', code => {
        if (failure) reject(failure);
        else if (code === 0) resolve();
        else reject(new Error(`SQLite backup worker exited with code ${code}`));
      });
    });
    chmodSync(staging, 0o600);
    renameSync(staging, target);
  } catch (error) {
    rmSync(staging, { force: true });
    throw error;
  }
}

/** Existing access leases exclude live runtimes; the write lock also excludes raw SQLite writers. */
export async function withOfflineDatabase<T>(filename: string, action: (database: Database.Database) => Promise<T>): Promise<T> {
  filename = canonicalDatabase(filename);
  const probe = new Database(filename, { readonly: true, fileMustExist: true });
  try {
    const version = probe.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number };
    if (version.version !== BACKUP_SCHEMA_VERSION) throw new Error('Offline backup requires the current database schema; upgrade separately first');
  } finally { probe.close(); }
  const control = openDatabaseControl(filename, {});
  const writer = new Database(filename, { timeout: 0, fileMustExist: true });
  let maintenance = false;
  try {
    control.beginUpgrade(); maintenance = true;
    writer.pragma('foreign_keys = ON');
    writer.exec('BEGIN IMMEDIATE');
    control.assertMaintenance(writer);
    const result = await action(writer);
    writer.exec('COMMIT');
    return result;
  } catch (error) {
    if (writer.inTransaction) writer.exec('ROLLBACK');
    throw error;
  } finally {
    writer.close();
    if (maintenance) control.finishUpgrade();
    control.close();
  }
}
