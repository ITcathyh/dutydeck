import { createHash } from 'node:crypto';

// Helpers that need no database. Callers import them from `@dutydeck/storage/helpers` so they do not load drizzle
// and every repository (about half a second per process, paid once per test file).
export { childProcessIdentity, currentProcessIdentity, observeProcess, type ProcessIdentity } from './process-identity.js';
export { checkSqliteDriver, describeSqliteDriverFailure, type SqliteDriverCheck, type SqliteDriverCheckOptions } from './sqlite-preflight.js';
export { createConfigReader } from './config-reader.js';
export { assertConfigWrite } from './config-write.js';
export { configKeyDefinition } from './config-keys.js';
export { assertBotProcessStartup } from './bot-process.js';

export const LEGACY_RETIREMENT_NOTICE = '升级已结束旧会话，历史记录保留；原上下文未自动恢复，请用 /new 新建。';

export { executionTaskId } from '@dutydeck/shared/execution';

export function memoryJobVersionDigest(value: string | undefined): string {
  return value === undefined ? 'absent' : createHash('sha256').update(value).digest('hex');
}

export const scheduleWriterLeaseKey = (channelBotId: string) => `schedule_writer:${channelBotId}`;
