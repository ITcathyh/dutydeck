import Database from 'better-sqlite3';
import { chmodSync } from 'node:fs';
import { canonicalDatabase, openDatabaseControl } from './database-control.js';
import { migrations } from './migrations.js';

export const BACKUP_SCHEMA_VERSION = migrations.at(-1)!.version;

/** Pin the committed WAL snapshot so continuous writers cannot restart backup. */
export async function backupSqlite(source: string, target: string): Promise<void> {
  const db = new Database(source, { readonly: true, fileMustExist: true });
  try {
    db.exec('BEGIN');
    db.prepare('SELECT rootpage FROM main.sqlite_schema LIMIT 1').get();
    await db.backup(target);
  } finally { db.close(); }
  chmodSync(target, 0o600);
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
