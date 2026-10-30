import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, openSync, renameSync, rmSync } from 'node:fs';
import { canonicalDatabase, openDatabaseControl } from './database-control.js';
import { migrations } from './migrations.js';

export const BACKUP_SCHEMA_VERSION = migrations.at(-1)!.version;

/**
 * Write a compact, transactionally consistent copy (WAL included) of the source.
 * VACUUM INTO skips free pages that page-wise db.backup() would copy, and runs
 * on a read-only connection so live writers are not blocked.
 */
export async function backupSqlite(source: string, target: string): Promise<void> {
  // VACUUM INTO accepts only a missing or empty file; build in a private temp file, then replace.
  const staging = `${target}.${process.pid}.${randomUUID()}.tmp`;
  const db = new Database(source, { readonly: true, fileMustExist: true });
  try {
    closeSync(openSync(staging, 'wx', 0o600));
    db.exec(`VACUUM INTO '${staging.replaceAll("'", "''")}'`);
    chmodSync(staging, 0o600);
    renameSync(staging, target);
  } catch (error) {
    rmSync(staging, { force: true });
    throw error;
  } finally { db.close(); }
}

/** Existing access leases exclude live runtimes; the write lock also excludes raw SQLite writers. */
export async function withOfflineDatabase<T>(filename: string, action: () => Promise<T>): Promise<T> {
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
    writer.exec('BEGIN IMMEDIATE');
    return await action();
  } finally {
    writer.close();
    if (maintenance) control.finishUpgrade();
    control.close();
  }
}
