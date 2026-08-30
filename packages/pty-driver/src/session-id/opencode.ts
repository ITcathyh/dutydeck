/**
 * OpenCode native session-id lookup (SQLite).
 *
 * OpenCode 1.17+ keeps every project's sessions in ONE global database at
 * `${XDG_DATA_HOME:-~/.local/share}/opencode/opencode.db`. Its ids look like
 * `ses_<base62>` and are minted by the CLI, so dockmux can never pin one —
 * `opencode -s <dockmuxSessionId>` would exit 1 ("Session not found") and, in
 * a supervised setup, crash-loop. This lookup is therefore not an
 * optimisation: without it OpenCode resume cannot work at all.
 *
 * The V1 schema stores message parts as JSON blobs:
 *   session(id, directory, title, time_created, time_updated, parent_id, …)
 *   message(id, session_id, data JSON)   -- data.role = 'user' | 'assistant'
 *   part(id, message_id, session_id, data JSON, time_created)
 *                                        -- data.type = 'text', data.text = …
 *
 * The marker rides the first user prompt's text, so an `instr(p.data, ?) > 0`
 * scan over user text parts identifies our session. `ORDER BY time_created
 * DESC LIMIT 1` breaks ties among repeated submits of the same marker.
 *
 * RUNTIME NOTE — this uses `node:sqlite` (Node 22+, currently flagged
 * experimental) via a lazy `createRequire`, deliberately NOT a static import:
 *   - a static import would make the whole pty-driver package fail to load on
 *     a runtime without `node:sqlite`, breaking every other CLI;
 *   - `node:sqlite` prints an ExperimentalWarning on first load, which should
 *     only be paid by someone actually resuming an OpenCode session.
 * Any failure (module absent, DB missing, schema drift, locked file) returns
 * undefined and the caller degrades.
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { opencodeDbPath } from '../cli-paths.js';
import { isUsableMarker } from './marker.js';
import type { SessionIdLookup, SessionIdLookupContext } from './types.js';

/** OpenCode's own session-id shape. Guards against returning a stray value
 *  from a drifted schema into a spawn argument. */
const OPENCODE_SESSION_ID_RE = /^ses_[0-9A-Za-z]+$/;

interface StatementLike {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}
interface DatabaseLike {
  prepare(sql: string): StatementLike;
  close(): void;
}

/** Locate the user text part carrying the marker and return its session id.
 *  V1 schema: part JOIN message, role read out of the message JSON blob. */
const MARKER_QUERY =
  'SELECT p.session_id AS sid '
  + 'FROM part p JOIN message m ON m.id = p.message_id '
  + "WHERE json_extract(m.data, '$.role') = 'user' "
  + "  AND json_extract(p.data, '$.type') = 'text' "
  + '  AND instr(p.data, ?) > 0 '
  + 'ORDER BY p.time_created DESC LIMIT 1';

/** Open the OpenCode DB read-only, run `fn`, always close. Returns undefined
 *  on any failure — a missing `node:sqlite` included. */
function withDb<T>(dbPath: string, fn: (db: DatabaseLike) => T | undefined): T | undefined {
  if (!existsSync(dbPath)) return undefined;
  let db: DatabaseLike | undefined;
  try {
    // Lazy require: see the runtime note in the module header.
    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require('node:sqlite') as {
      DatabaseSync: new (path: string, opts?: { readOnly?: boolean }) => DatabaseLike;
    };
    db = new DatabaseSync(dbPath, { readOnly: true });
    return fn(db);
  } catch {
    return undefined;
  } finally {
    if (db) {
      try { db.close(); } catch { /* already closed */ }
    }
  }
}

/**
 * Read the OpenCode session id whose first user prompt carries `marker`.
 * Exported so tests can point at a fixture database.
 */
export function readOpenCodeSessionId(dbPath: string, marker: string): string | undefined {
  return withDb(dbPath, db => {
    const row = db.prepare(MARKER_QUERY).get(marker) as { sid?: unknown } | undefined;
    const sid = row?.sid;
    return typeof sid === 'string' && OPENCODE_SESSION_ID_RE.test(sid) ? sid : undefined;
  });
}

export const opencodeSessionIdLookup: SessionIdLookup = {
  adapterId: 'opencode',

  resolve({ sessionId }: SessionIdLookupContext): string | undefined {
    // No fast path: OpenCode never accepts a caller-supplied id, so the
    // dockmux session id is never also the CLI's.
    if (!isUsableMarker(sessionId)) return undefined;
    return readOpenCodeSessionId(opencodeDbPath(), sessionId);
  },
};
