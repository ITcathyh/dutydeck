import { createHash } from 'node:crypto';
import { canonicalExecutionJson, taskExecutionSchemas, taskRequestV1Schema, type TaskRequestV1 } from '@dutydeck/shared';

// Helpers that need no database. Callers import them from `@dutydeck/storage/helpers` so they do not load drizzle
// and every repository (about half a second per process, paid once per test file).
export { childProcessIdentity, currentProcessIdentity, observeProcess, type ProcessIdentity } from './process-identity.js';
export { checkSqliteDriver, describeSqliteDriverFailure, type SqliteDriverCheck, type SqliteDriverCheckOptions } from './sqlite-preflight.js';
export { assertBotProcessStartup } from './bot-process.js';

export const LEGACY_RETIREMENT_NOTICE = '升级已结束旧会话，历史记录保留；原上下文未自动恢复，请用 /new 新建。';

export function executionTaskId(namespace: TaskRequestV1['namespace'], sessionId: string, key: string): string {
  taskRequestV1Schema.shape.namespace.parse(namespace); taskExecutionSchemas.id.parse(sessionId); taskExecutionSchemas.id.parse(key);
  return `task_v1_${createHash('sha256').update(canonicalExecutionJson([namespace, sessionId, key])).digest('hex')}`;
}

export function memoryJobVersionDigest(value: string | undefined): string {
  return value === undefined ? 'absent' : createHash('sha256').update(value).digest('hex');
}

export const scheduleWriterLeaseKey = (channelBotId: string) => `schedule_writer:${channelBotId}`;
