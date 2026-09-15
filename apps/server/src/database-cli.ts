import { statSync } from 'node:fs';
import {
  inspectExecutionDatabase,
  createRepositories,
  type ExecutionDatabaseCounts,
  type ExecutionDatabaseInspection,
  type ExecutionDatabaseStatus
} from '@dutydeck/storage';
import { RuntimeError, type ExecutionBlocker, type RepositoryBundle } from '@dutydeck/shared';
import type { DatabaseExecutionStatusCliOptions, DatabaseUpgradeExecutionCliOptions } from './cli-program.js';

export class DatabaseCliError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'DatabaseCliError';
  }
}

export interface DatabaseExecutionStatusResult {
  database: string;
  status: ExecutionDatabaseStatus;
  authority?: 'legacy' | 'ledger_v1';
  schemaVersion?: number;
  counts?: ExecutionDatabaseCounts;
  control?: ExecutionDatabaseInspection['control'];
  unsupportedReason?: string;
}

export interface DatabaseUpgradeExecutionResult {
  database: string;
  authority: 'legacy' | 'ledger_v1';
  before: {
    status: ExecutionDatabaseStatus;
    authority?: 'legacy' | 'ledger_v1';
    counts: ExecutionDatabaseCounts;
  };
  after: {
    status: ExecutionDatabaseStatus;
    authority?: 'legacy' | 'ledger_v1';
    counts: ExecutionDatabaseCounts;
  };
  blockers: ExecutionBlocker[];
}

function safeError(error: unknown): never {
  if (error instanceof DatabaseCliError) throw error;
  if (error instanceof RuntimeError) throw new DatabaseCliError(error.code, error.message);
  if (error instanceof Error) throw new DatabaseCliError('DATABASE_CLI_ERROR', error.message);
  throw new DatabaseCliError('DATABASE_CLI_ERROR', String(error));
}

/**
 * Read-only status inspection via inspectExecutionDatabase.
 * Does not use createRepositories, secret provider, or general opener.
 */
export async function runDatabaseExecutionStatus(
  options: DatabaseExecutionStatusCliOptions
): Promise<DatabaseExecutionStatusResult> {
  if (!options.database) {
    throw new DatabaseCliError('DATABASE_OPTION_REQUIRED', '--database option is required');
  }

  let inspection: ExecutionDatabaseInspection;
  try {
    inspection = inspectExecutionDatabase(options.database);
  } catch (error) {
    safeError(error);
  }

  return {
    database: options.database,
    status: inspection.status,
    ...(inspection.authority ? { authority: inspection.authority } : {}),
    ...(inspection.schemaVersion !== undefined ? { schemaVersion: inspection.schemaVersion } : {}),
    ...(inspection.counts ? { counts: inspection.counts } : {}),
    ...(inspection.control ? { control: inspection.control } : {}),
    ...(inspection.unsupportedReason ? { unsupportedReason: inspection.unsupportedReason } : {})
  };
}

/**
 * Offline migration of legacy execution database to ledger_v1.
 * Requires explicit existing database file path, acquires exclusive maintenance control,
 * executes execution.upgradeLegacy(), reads back authority/counts/blockers, and closes.
 */
export async function runDatabaseUpgradeExecution(
  options: DatabaseUpgradeExecutionCliOptions
): Promise<DatabaseUpgradeExecutionResult> {
  if (!options.database) {
    throw new DatabaseCliError('DATABASE_OPTION_REQUIRED', '--database option is required');
  }

  const databasePath = options.database;
  let stat;
  try {
    stat = statSync(databasePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new DatabaseCliError('DATABASE_NOT_FOUND', `Database file does not exist: ${databasePath}`);
    }
    safeError(error);
  }

  if (!stat.isFile()) {
    throw new DatabaseCliError('DATABASE_UNSAFE_FILE', `Database path must be a regular file: ${databasePath}`);
  }

  let beforeInspection: ExecutionDatabaseInspection;
  try {
    beforeInspection = inspectExecutionDatabase(databasePath);
  } catch (error) {
    safeError(error);
  }

  if (beforeInspection.status === 'unsupported') {
    throw new DatabaseCliError(
      'DATABASE_UNSUPPORTED',
      `Database schema is unsupported: ${beforeInspection.unsupportedReason ?? 'unknown schema'}`
    );
  }

  let repositories: RepositoryBundle;
  try {
    repositories = createRepositories(databasePath);
  } catch (error) {
    safeError(error);
  }

  try {
    const snapshot = repositories.execution.upgradeLegacy();
    repositories.close();

    return {
      database: databasePath,
      authority: snapshot.after.authority,
      before: {
        status: snapshot.before.authority === 'ledger_v1' ? 'ledger_v1' : 'legacy',
        authority: snapshot.before.authority,
        counts: snapshot.before.counts
      },
      after: {
        status: snapshot.after.authority === 'ledger_v1' ? 'ledger_v1' : 'legacy',
        authority: snapshot.after.authority,
        counts: snapshot.after.counts
      },
      blockers: snapshot.blockers
    };
  } catch (error) {
    try {
      repositories.close();
    } catch {}
    safeError(error);
  }
}
