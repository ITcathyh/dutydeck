import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { BACKUP_SCHEMA_VERSION, withOfflineDatabase } from '@dutydeck/storage';
import { createTaskExecutionRepository } from '../packages/storage/src/task-execution.js';

type Sqlite = Parameters<Parameters<typeof withOfflineDatabase>[1]>[0];
const Database = createRequire(new URL('../packages/storage/package.json', import.meta.url))('better-sqlite3') as new (path: string, options: { readonly: boolean; fileMustExist: boolean }) => Sqlite;
const terminalStates = new Set(['completed', 'failed', 'cancelled', 'interrupted', 'reconcile_required']);
type Candidate = { id: string; sessionId: string; sequence: number; bytes: number };

function checkSchema(database: Sqlite) {
  const version = database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number };
  if (version.version !== BACKUP_SCHEMA_VERSION) throw new Error('Current database schema is required; upgrade separately before pruning');
}

export function previewTerminalPrune(database: Sqlite, before: string) {
  checkSchema(database);
  const execution = createTaskExecutionRepository(database, {} as never);
  const safe = new Map<string, boolean>();
  const references = new Set<string>();
  for (const row of database.prepare("SELECT value FROM configs WHERE key LIKE 'artifact.snapshot.%'").all() as Array<{ value: string }>) {
    const value = JSON.parse(row.value) as { eventId?: string };
    if (value.eventId) references.add(value.eventId);
  }
  for (const row of database.prepare('SELECT json FROM task_attempts').all() as Array<{ json: string }>) {
    const value = JSON.parse(row.json) as { settlement?: { verifiedOutput?: { eventId?: string } } };
    if (value.settlement?.verifiedOutput?.eventId) references.add(value.settlement.verifiedOutput.eventId);
  }
  const maximum = new Map((database.prepare('SELECT session_id,MAX(sequence) AS sequence FROM events GROUP BY session_id').all() as Array<{ session_id: string; sequence: number }>).map(row => [row.session_id, row.sequence]));
  const rows = database.prepare(`SELECT e.id,e.session_id,e.task_id,e.attempt_id,e.sequence,e.timestamp,e.source_key,
    t.id AS owned_task,a.id AS owned_attempt,
    length(CAST(e.data AS BLOB))+COALESCE(length(CAST(e.raw AS BLOB)),0) AS bytes
    FROM events e LEFT JOIN tasks t ON t.id=e.task_id AND t.session_id=e.session_id
      LEFT JOIN task_attempts a ON a.id=e.attempt_id AND a.task_id=e.task_id AND a.session_id=e.session_id
    WHERE e.type='raw_terminal' ORDER BY e.session_id,e.sequence`).all() as Array<{
      id: string; session_id: string; task_id: string | null; attempt_id: string | null; sequence: number;
      timestamp: string; source_key: string | null; owned_task: string | null; owned_attempt: string | null; bytes: number;
    }>;
  const candidates: Candidate[] = [];
  const protectedReasons: Record<string, number> = {};
  let expiredEvents = 0, expiredContentBytes = 0;
  for (const row of rows) {
    const timestamp = Date.parse(row.timestamp);
    if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== row.timestamp || row.timestamp >= before) continue;
    expiredEvents++; expiredContentBytes += row.bytes;
    if (!safe.has(row.session_id)) {
      const session = database.prepare('SELECT state FROM sessions WHERE id=?').get(row.session_id) as { state: string } | undefined;
      const tasks = database.prepare(`SELECT t.status,t.current_attempt_id,a.state FROM tasks t
        LEFT JOIN task_attempts a ON a.id=t.current_attempt_id AND a.task_id=t.id AND a.session_id=t.session_id
        WHERE t.session_id=?`).all(row.session_id) as Array<{ status: string; current_attempt_id: string | null; state: string | null }>;
      let allowed = Boolean(session && ['idle', 'stopped', 'interrupted', 'failed'].includes(session.state) && tasks.length
        && tasks.every(task => terminalStates.has(task.status) && task.current_attempt_id && task.state === 'settled')
        && !database.prepare("SELECT 1 FROM task_attempts WHERE session_id=? AND state!='settled' LIMIT 1").get(row.session_id)
        && !database.prepare("SELECT 1 FROM task_steering_operations WHERE session_id=? AND state IN ('pending','unknown') LIMIT 1").get(row.session_id)
        && !database.prepare("SELECT 1 FROM task_queue_actions WHERE session_id=? AND state IN ('pending','blocked') LIMIT 1").get(row.session_id));
      try { allowed = allowed && execution.getSessionResourceBlockers(row.session_id).length === 0; }
      catch { allowed = false; }
      safe.set(row.session_id, allowed);
    }
    const reason = !safe.get(row.session_id) ? 'unsafe_session'
      : !row.owned_task || !row.owned_attempt ? 'unattributed_event'
      : row.source_key ? 'source_key'
      : references.has(row.id) ? 'referenced_event'
      : row.sequence === maximum.get(row.session_id) ? 'session_high_watermark' : undefined;
    if (reason) protectedReasons[reason] = (protectedReasons[reason] ?? 0) + 1;
    else candidates.push({ id: row.id, sessionId: row.session_id, sequence: row.sequence, bytes: row.bytes });
  }
  return { before, expiredEvents, expiredContentBytes, protectedEvents: expiredEvents - candidates.length,
    protectedReasons, eligibleEvents: candidates.length, eligibleContentBytes: candidates.reduce((sum, row) => sum + row.bytes, 0),
    affectedSessions: new Set(candidates.map(row => row.sessionId)).size, candidates };
}

function cutoff(value: string) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value || parsed > Date.now()) {
    throw new Error('--before must be a past UTC ISO timestamp, including milliseconds, e.g. 2026-10-01T00:00:00.000Z');
  }
  return value;
}

export async function pruneTerminalEvents(options: { database: string; before: string; apply?: boolean; expectCount?: number; expectBytes?: number }) {
  const database = realpathSync(options.database), before = cutoff(options.before);
  const summarize = (plan: ReturnType<typeof previewTerminalPrune>, deletedEvents: number) => {
    const { candidates: _candidates, ...summary } = plan;
    return { database, mode: options.apply ? 'apply' : 'dry-run', ...summary, deletedEvents };
  };
  if (!options.apply) {
    const reader = new Database(database, { readonly: true, fileMustExist: true });
    try { return reader.transaction(() => summarize(previewTerminalPrune(reader, before), 0))(); }
    finally { reader.close(); }
  }
  if (!Number.isSafeInteger(options.expectCount) || options.expectCount! < 0 || !Number.isSafeInteger(options.expectBytes) || options.expectBytes! < 0) {
    throw new Error('--apply requires --expect-count and --expect-bytes from the reviewed dry-run');
  }
  return withOfflineDatabase(database, async writer => {
    const plan = previewTerminalPrune(writer, before);
    if (plan.eligibleEvents && (plan.eligibleEvents !== options.expectCount || plan.eligibleContentBytes !== options.expectBytes)) {
      throw new Error('Prune scope changed; run and review dry-run again');
    }
    const remove = writer.prepare("DELETE FROM events WHERE id=? AND session_id=? AND sequence=? AND type='raw_terminal' AND timestamp<?");
    let deleted = 0;
    for (const row of plan.candidates) deleted += remove.run(row.id, row.sessionId, row.sequence, before).changes;
    if (deleted !== plan.eligibleEvents) throw new Error('Prune count mismatch; transaction rolled back');
    return summarize(plan, deleted);
  });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const { values } = parseArgs({ options: { database: { type: 'string' }, before: { type: 'string' }, apply: { type: 'boolean' },
      'expect-count': { type: 'string' }, 'expect-bytes': { type: 'string' } } });
    if (!values.database || !values.before) throw new Error('Usage: pnpm exec tsx scripts/prune-terminal-events.mts --database /absolute/dutydeck.db --before 2026-10-01T00:00:00.000Z [--apply --expect-count N --expect-bytes N]');
    console.log(JSON.stringify(await pruneTerminalEvents({ database: values.database, before: values.before, apply: values.apply,
      expectCount: values['expect-count'] === undefined ? undefined : Number(values['expect-count']),
      expectBytes: values['expect-bytes'] === undefined ? undefined : Number(values['expect-bytes']) }), null, 2));
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
