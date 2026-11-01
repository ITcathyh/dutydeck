import { executeLocalRuntimeRequest, type LocalRuntimeRequestDependencies } from './local-runtime-request.js';
export async function runLarkDisposition(input: { messageId?: string; app?: string; chat?: string; since?: string; database?: string }, dependencies: LocalRuntimeRequestDependencies = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries({ messageId: input.messageId, appId: input.app, chatId: input.chat, since: input.since })) if (value) query.set(key, value);
  return executeLocalRuntimeRequest({ database: input.database, method: 'GET', endpoint: `/api/lark/inbox?${query}`, errorSpec: {
    databaseRequired: 'INBOX_DATABASE_REQUIRED', daemonUnavailable: 'INBOX_DAEMON_UNAVAILABLE', localRuntimeRequired: 'INBOX_LOCAL_REQUIRED', requestFailed: 'INBOX_QUERY_FAILED'
  }, createError: (code, message) => Object.assign(new Error(message), { code }) }, dependencies);
}
