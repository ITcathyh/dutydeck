/**
 * Lazy `node:sqlite` loader for the native-store readers (Codex thread index,
 * OpenCode database). Internal: not exported from the package root.
 *
 * Loading is lazy on purpose (a runtime without `node:sqlite` must still run
 * every other CLI), and the first load makes Node emit a one-time
 * `ExperimentalWarning` for SQLite. Under the daemon that warning is a
 * non-JSON stderr line in the service journal on every fresh process, with no
 * action anyone can take. It is the only warning dropped here: the wrapper is
 * installed only for the synchronous `require`, filters on both the warning
 * type and a message naming SQLite, and is restored in `finally`.
 */
import { createRequire } from 'node:module';

export interface NodeSqliteStatement { get(...params: unknown[]): unknown; all(...params: unknown[]): unknown[] }
export interface NodeSqliteDatabase { prepare(sql: string): NodeSqliteStatement; close(): void }
export interface NodeSqliteModule { DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => NodeSqliteDatabase }

const load = createRequire(import.meta.url);

function isSqliteExperimentalWarning(warning: unknown, typeOrOptions: unknown): boolean {
  const type = typeof typeOrOptions === 'string' ? typeOrOptions
    : typeOrOptions && typeof typeOrOptions === 'object' ? (typeOrOptions as { type?: unknown }).type
      : warning instanceof Error ? warning.name : undefined;
  const message = warning instanceof Error ? warning.message : String(warning);
  return type === 'ExperimentalWarning' && message.includes('SQLite');
}

/** `require('node:sqlite')` without its experimental warning. Throws exactly
 *  as the plain require would (callers already treat that as "unavailable"). */
export function requireNodeSqlite(): NodeSqliteModule {
  const original = process.emitWarning;
  process.emitWarning = function emitWarning(this: NodeJS.Process, warning: string | Error, ...rest: unknown[]) {
    if (isSqliteExperimentalWarning(warning, rest[0])) return;
    return (original as (...args: unknown[]) => void).call(this, warning, ...rest);
  } as typeof process.emitWarning;
  try {
    return load('node:sqlite') as NodeSqliteModule;
  } finally {
    process.emitWarning = original;
  }
}
