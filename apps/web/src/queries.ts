import { queryOptions } from '@tanstack/react-query';
import { api } from './api';
import { queryKeys } from './query-keys';
import { loadSessions } from './sessions-query';
import type { WorkAttempt } from '@dutydeck/shared';

export { queryKeys } from './query-keys';

const sessionListRefresh = { retry: false, refetchInterval: 15_000, refetchIntervalInBackground: false };

export const sessionsQuery = () => queryOptions({
  queryKey: queryKeys.sessions(),
  queryFn: ({ client, signal }) => loadSessions(client, signal),
  ...sessionListRefresh
});

export const sharedSessionsQuery = (sessionId: string) => queryOptions({
  queryKey: queryKeys.sessions(),
  queryFn: async () => [await api.session(sessionId)],
  ...sessionListRefresh
});

export const instanceSessionsQuery = (instance: string | null) => queryOptions({
  queryKey: queryKeys.instanceSessions(instance),
  queryFn: ({ signal }) => api.sessions(signal),
  ...sessionListRefresh
});

export const finishedTaskStatuses = ['completed', 'failed', 'interrupted', 'cancelled'];

export const tasksQuery = (sessionId: string | undefined, { attempts, instance }: { attempts?: WorkAttempt[]; instance?: string | null } = {}) => queryOptions({
  queryKey: instance === undefined ? queryKeys.tasks(sessionId) : queryKeys.instanceTasks(instance, sessionId),
  queryFn: () => api.tasks(sessionId!),
  retry: false,
  refetchInterval: query => {
    if (query.state.status === 'error') return false;
    return attempts?.some(attempt => attempt.sessionId === sessionId && finishedTaskStatuses.includes(attempt.status)
      && !finishedTaskStatuses.includes(query.state.data?.find(task => task.id === attempt.taskId)?.status ?? '')) ? 5_000 : false;
  }
});
