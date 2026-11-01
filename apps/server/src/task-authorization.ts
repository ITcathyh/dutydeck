import { taskAuthorizationSchema, type ConfigRepository, type TaskAuthorization, type TaskRequestV1 } from '@dutydeck/shared';

export const taskAuthorizationKey = (taskId: string) => `task_authorization/${taskId}`;
/** First acceptance owns the evidence; idempotent replays never replace it. Host only. */
export async function recordTaskAuthorization(store: ConfigRepository, input: TaskAuthorization): Promise<void> {
  const record = taskAuthorizationSchema.parse(input);
  const key = taskAuthorizationKey(record.taskId);
  if (!store.compareAndSet) throw new Error('Task authorization requires persistent CAS');
  await store.compareAndSet(key, undefined, JSON.stringify(record));
}
export async function readTaskAuthorization(store: ConfigRepository | undefined, taskId: string, sessionId: string): Promise<TaskAuthorization | undefined> {
  const raw = await store?.get(taskAuthorizationKey(taskId));
  if (!raw) return undefined;
  const record = taskAuthorizationSchema.parse(JSON.parse(raw));
  return record.taskId === taskId && record.sessionId === sessionId ? record : undefined;
}

/** Scheduled/CI requests retain the already frozen channel actor. */
export async function recordAutomationAuthorization(store: ConfigRepository, request: TaskRequestV1, taskId: string): Promise<void> {
  if (request.actor.kind !== 'channel' || request.namespace !== 'schedule' && request.namespace !== 'automation') return;
  await recordTaskAuthorization(store, { schemaVersion: 1, taskId, sessionId: request.sessionId,
    strength: 'explicit', via: request.namespace, actorOpenId: request.actor.id, recordedAt: new Date().toISOString() });
}
