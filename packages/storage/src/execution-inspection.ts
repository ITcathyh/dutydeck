import Database from 'better-sqlite3';
import { statSync } from 'node:fs';
import { RuntimeError } from '@dutydeck/shared';

export type ExecutionDatabaseStatus =
  | 'missing'
  | 'uninitialized'
  | 'legacy'
  | 'ledger_v1'
  | 'unsupported';

export interface ExecutionDatabaseCounts {
  tasks: number;
  attempts: number;
  resources: number;
  registeredAccess: number;
}

export interface ExecutionDatabaseControlInfo {
  phase: string;
  hasRuntime: boolean;
  hasMaintenance: boolean;
  registeredAccessCount: number;
}

export interface ExecutionDatabaseInspection {
  path: string;
  status: ExecutionDatabaseStatus;
  authority?: 'legacy' | 'ledger_v1';
  schemaVersion?: number;
  counts?: ExecutionDatabaseCounts;
  control?: ExecutionDatabaseControlInfo;
  unsupportedReason?: string;
}

const KNOWN_MAX_MIGRATION = 19;
const REQUIRED_LEDGER_TABLES = [
  'tasks',
  'sessions',
  'events',
  'task_requests',
  'task_attempts',
  'task_queue_actions',
  'driver_resources',
  'recovery_decisions',
  'task_execution_commands'
] as const;

/**
 * Synchronous read-only inspection of execution database schema and authority.
 * Uses readonly+fileMustExist mode without immutable flag so committed WAL frames are visible.
 * Executes within a single read transaction and never writes, migrates, or creates files.
 */
export function inspectExecutionDatabase(path: string): ExecutionDatabaseInspection {
  let stat;
  try {
    stat = statSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return {
        path,
        status: 'missing'
      };
    }
    throw error;
  }

  if (!stat.isFile()) {
    throw new RuntimeError('DATABASE_UNSAFE_FILE', `DATABASE_UNSAFE_FILE: Database path must be a regular file: ${path}`, 400);
  }

  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const inspect = db.transaction((): ExecutionDatabaseInspection => {
      // Find all user schema objects, strictly excluding sqlite_* and the two control opener tables.
      const userObjects = db.prepare(
        "SELECT name, type FROM main.sqlite_schema WHERE name NOT GLOB 'sqlite_*' AND NOT (type = 'table' AND name IN ('dutydeck_control', 'dutydeck_access'))"
      ).all() as Array<{ name: string; type: string }>;

      const controlExists = Boolean(
        db.prepare("SELECT 1 FROM main.sqlite_schema WHERE type = 'table' AND name = 'dutydeck_control'").get()
      );
      const accessExists = Boolean(
        db.prepare("SELECT 1 FROM main.sqlite_schema WHERE type = 'table' AND name = 'dutydeck_access'").get()
      );
      const registeredAccess = accessExists
        ? (db.prepare('SELECT COUNT(*) AS count FROM dutydeck_access').get() as { count: number }).count
        : 0;

      let controlInfo: ExecutionDatabaseControlInfo | undefined;
      if (controlExists) {
        const row = db.prepare('SELECT phase, runtime, maintenance FROM dutydeck_control WHERE id = 1').get() as
          | { phase: string; runtime: string | null; maintenance: string | null }
          | undefined;
        if (row) {
          controlInfo = {
            phase: row.phase,
            hasRuntime: row.runtime !== null,
            hasMaintenance: row.maintenance !== null,
            registeredAccessCount: registeredAccess
          };
        }
      }

      // If no user tables, views, triggers or indices exist, it is uninitialized.
      if (userObjects.length === 0) {
        return {
          path,
          status: 'uninitialized',
          counts: {
            tasks: 0,
            attempts: 0,
            resources: 0,
            registeredAccess
          },
          ...(controlInfo ? { control: controlInfo } : {})
        };
      }

      const tableRows = db.prepare(
        "SELECT name FROM main.sqlite_schema WHERE type = 'table' AND name NOT GLOB 'sqlite_*'"
      ).all() as Array<{ name: string }>;
      const tables = new Set(tableRows.map(row => row.name));

      // Validate execution authority table if present.
      let authority: 'legacy' | 'ledger_v1' | undefined;
      if (tables.has('execution_authority')) {
        const rows = db.prepare('SELECT id, authority FROM execution_authority').all() as Array<{ id: number; authority: string }>;
        if (rows.length !== 1 || rows[0]?.id !== 1 || (rows[0]?.authority !== 'legacy' && rows[0]?.authority !== 'ledger_v1')) {
          throw new RuntimeError('EXECUTION_AUTHORITY_INVALID', `EXECUTION_AUTHORITY_INVALID: Invalid execution authority in database: ${JSON.stringify(rows)}`, 500);
        }
        authority = rows[0]!.authority as 'legacy' | 'ledger_v1';
      }

      // Read max schema version safely if schema_migrations exists.
      let schemaVersion: number | undefined;
      if (tables.has('schema_migrations')) {
        const row = db.prepare('SELECT COALESCE(MAX(version), 0) AS max_version FROM schema_migrations').get() as
          | { max_version: number }
          | undefined;
        schemaVersion = row?.max_version ?? 0;

        const applied = (db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>).map(r => r.version);
        if (applied.some(version => version > KNOWN_MAX_MIGRATION || version < 1)) {
          return {
            path,
            status: 'unsupported',
            ...(authority ? { authority } : {}),
            schemaVersion,
            counts: {
              tasks: tables.has('tasks') ? (db.prepare('SELECT COUNT(*) AS count FROM tasks').get() as { count: number }).count : 0,
              attempts: tables.has('task_attempts') ? (db.prepare('SELECT COUNT(*) AS count FROM task_attempts').get() as { count: number }).count : 0,
              resources: tables.has('driver_resources') ? (db.prepare('SELECT COUNT(*) AS count FROM driver_resources').get() as { count: number }).count : 0,
              registeredAccess
            },
            ...(controlInfo ? { control: controlInfo } : {}),
            unsupportedReason: 'DATABASE_SCHEMA_TOO_NEW'
          };
        }
      }

      // Basic Dutydeck database tables must include sessions and tasks.
      if (!tables.has('sessions') || !tables.has('tasks')) {
        return {
          path,
          status: 'unsupported',
          ...(authority ? { authority } : {}),
          ...(schemaVersion !== undefined ? { schemaVersion } : {}),
          counts: {
            tasks: tables.has('tasks') ? (db.prepare('SELECT COUNT(*) AS count FROM tasks').get() as { count: number }).count : 0,
            attempts: tables.has('task_attempts') ? (db.prepare('SELECT COUNT(*) AS count FROM task_attempts').get() as { count: number }).count : 0,
            resources: tables.has('driver_resources') ? (db.prepare('SELECT COUNT(*) AS count FROM driver_resources').get() as { count: number }).count : 0,
            registeredAccess
          },
          ...(controlInfo ? { control: controlInfo } : {}),
          unsupportedReason: 'NOT_A_DUTYDECK_DATABASE'
        };
      }

      const tasksCount = (db.prepare('SELECT COUNT(*) AS count FROM tasks').get() as { count: number }).count;
      const attemptsCount = tables.has('task_attempts')
        ? (db.prepare('SELECT COUNT(*) AS count FROM task_attempts').get() as { count: number }).count
        : 0;
      const resourcesCount = tables.has('driver_resources')
        ? (db.prepare('SELECT COUNT(*) AS count FROM driver_resources').get() as { count: number }).count
        : 0;

      const counts: ExecutionDatabaseCounts = {
        tasks: tasksCount,
        attempts: attemptsCount,
        resources: resourcesCount,
        registeredAccess
      };

      if (authority === 'ledger_v1') {
        const missingLedgerTables = REQUIRED_LEDGER_TABLES.filter(name => !tables.has(name));
        const tasksColumns = (db.pragma('table_info(tasks)') as Array<{ name: string }>).map(col => col.name);
        const hasCurrentAttemptId = tasksColumns.includes('current_attempt_id');

        if (missingLedgerTables.length > 0 || !hasCurrentAttemptId) {
          return {
            path,
            status: 'unsupported',
            authority,
            schemaVersion,
            counts,
            ...(controlInfo ? { control: controlInfo } : {}),
            unsupportedReason: `INCOMPLETE_LEDGER_SCHEMA: missing ${[...missingLedgerTables, ...(!hasCurrentAttemptId ? ['tasks.current_attempt_id'] : [])].join(', ')}`
          };
        }

        return {
          path,
          status: 'ledger_v1',
          authority: 'ledger_v1',
          schemaVersion,
          counts,
          ...(controlInfo ? { control: controlInfo } : {})
        };
      }

      // Historical Dutydeck database. Only report authority when the marker row
      // actually exists; a pre-v18 schema without execution_authority is still
      // legacy by shape, but the authority value itself has never been persisted.
      return {
        path,
        status: 'legacy',
        ...(authority ? { authority } : {}),
        schemaVersion,
        counts,
        ...(controlInfo ? { control: controlInfo } : {})
      };
    });
    return inspect();
  } finally {
    db.close();
  }
}
