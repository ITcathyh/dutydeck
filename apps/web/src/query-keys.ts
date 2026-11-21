export const queryKeys = {
  sessions: () => ['sessions'] as const,
  instanceSessions: (instance: string | null) => ['sessions', instance] as const,
  tasks: (sessionId: string | undefined) => ['tasks', sessionId] as const,
  allTasks: () => ['tasks'] as const,
  instanceTasks: (instance: string | null, sessionId: string | undefined) => ['tasks', instance, sessionId] as const,
};
