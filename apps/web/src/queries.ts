import { queryOptions } from '@tanstack/react-query';
import { agentConfigApi, agentModelSettingsApi, artifactSnapshotsApi, collaborationApi, configurationApi,
  foundationApi, pluginBindingsApi, scheduleApi, terminalSettingsApi, workspaceApprovalRulesApi,
  type Session, type UsageReportQuery } from './api';
import { currentInstance } from './instance';
import { fetchSkillCatalog } from './skill-catalog-api';
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

export const larkConfigQuery = () => queryOptions({
  queryKey: queryKeys.larkConfig(),
  queryFn: api.larkConfig,
  staleTime: 0,
  refetchOnWindowFocus: true
});

export const systemCapabilitiesQuery = () => queryOptions({
  queryKey: queryKeys.systemCapabilities(),
  queryFn: api.systemCapabilities,
  staleTime: 0
});

export const managementGroupsQuery = () => queryOptions({
  queryKey: queryKeys.managementGroups(),
  queryFn: api.managementGroups,
  staleTime: 15_000
});

export const agentsQuery = () => queryOptions({
  queryKey: queryKeys.agents(),
  queryFn: api.agents,
  staleTime: 5 * 60_000
});

export const runSummariesQuery = () => queryOptions({
  queryKey: queryKeys.runSummaries(),
  queryFn: api.runSummaries,
  refetchInterval: 15_000,
  refetchIntervalInBackground: false
});

export const inboxQuery = () => queryOptions({
  queryKey: queryKeys.inbox(),
  queryFn: api.inbox,
  refetchInterval: 15_000,
  refetchIntervalInBackground: false,
  retry: false
});

export const workspaceGroupsQuery = () => queryOptions({
  queryKey: queryKeys.workspaceGroups(),
  queryFn: api.workspaceGroups,
  refetchInterval: 15_000,
  refetchIntervalInBackground: false
});

export const authStatusQuery = () => queryOptions({
  queryKey: queryKeys.authStatus(),
  queryFn: api.authStatus,
  staleTime: Infinity,
  retry: false
});

export const instancesQuery = () => queryOptions({
  queryKey: queryKeys.instances(),
  queryFn: api.instances,
  staleTime: Infinity,
  retry: false
});

export const foundationCapabilitiesQuery = () => queryOptions({
  queryKey: queryKeys.foundationCapabilities(),
  queryFn: foundationApi.capabilities,
  retry: false
});

export const groupMatrixQuery = () => queryOptions({
  queryKey: queryKeys.groupMatrix(),
  queryFn: foundationApi.groupMatrix,
  retry: false
});

export const secretRefsQuery = () => queryOptions({
  queryKey: queryKeys.secretRefs(),
  queryFn: foundationApi.secretRefs,
  retry: false
});

export const scheduleCapabilitiesQuery = () => queryOptions({
  queryKey: queryKeys.scheduleCapabilities(),
  queryFn: scheduleApi.capabilities,
  retry: false
});

export const schedulesQuery = () => queryOptions({
  queryKey: queryKeys.schedules(),
  queryFn: scheduleApi.list,
  retry: false
});

export const projectMemoriesQuery = () => queryOptions({
  queryKey: queryKeys.projectMemories(),
  queryFn: api.projectMemories
});

export const pluginBindingsQuery = () => queryOptions({
  queryKey: queryKeys.pluginBindings(),
  queryFn: pluginBindingsApi.list
});

export const usageSummaryQuery = () => queryOptions({
  queryKey: queryKeys.usageSummary(),
  queryFn: api.usageSummary,
  retry: false,
  refetchInterval: 30_000,
  refetchIntervalInBackground: false
});

export const pluginCommandsQuery = (cwd?: string) => queryOptions({
  queryKey: queryKeys.pluginCommands(cwd),
  queryFn: () => api.pluginCommands(cwd),
  staleTime: 60_000
});

export const larkMemoryStatusQuery = (appId?: string) => queryOptions({
  queryKey: queryKeys.larkMemoryStatus(appId),
  queryFn: () => api.larkMemoryStatus(appId!),
  staleTime: 30_000,
  refetchInterval: query => query.state.data?.groups?.running ? 10_000 : false
});

export const leaderSkillsQuery = (appId: string | undefined, workspace?: string) => queryOptions({
  queryKey: queryKeys.leaderSkills(appId, workspace),
  queryFn: () => api.skills(workspace || undefined, appId!),
  staleTime: 60_000
});

export const botPromptHistoryQuery = (appId: string) => queryOptions({
  queryKey: queryKeys.botPromptHistory(appId),
  queryFn: () => api.botPromptHistory(appId)
});

export const botPromptDiffQuery = (appId: string, a: number, b: number) => queryOptions({
  queryKey: queryKeys.botPromptDiff(appId, a, b),
  queryFn: () => api.botPromptDiff(appId, a, b)
});

export const botPromptShowQuery = (appId: string, revision: number) => queryOptions({
  queryKey: queryKeys.botPromptShow(appId, revision),
  queryFn: () => api.botPromptShow(appId, revision)
});

export const configurationQuery = (sessionId: string, taskId: string, attemptId: string) => queryOptions({
  queryKey: queryKeys.configuration(sessionId, taskId, attemptId),
  queryFn: () => configurationApi.explain(sessionId, taskId || undefined, attemptId || undefined)
});

export const systemDirectoriesQuery = (path: string) => queryOptions({
  queryKey: queryKeys.directories(path),
  queryFn: () => api.systemDirectories(path || undefined),
  staleTime: 10_000
});

export const groupMembersQuery = (appId: string | undefined, chatId: string | undefined) => queryOptions({
  queryKey: queryKeys.groupMembers(appId, chatId),
  queryFn: async () => {
      const members = [];
      let pageToken: string | undefined;
      const seen = new Set<string>();
      do {
        const page = await api.groupMembers(appId!, chatId!, pageToken);
        members.push(...page.members);
        if (!page.hasMore) return { members };
        if (!page.pageToken || seen.has(page.pageToken)) throw new Error('群成员列表未完整返回，请重试。');
        pageToken = page.pageToken; seen.add(pageToken);
      } while (true);
    },
  staleTime: 60_000
});

export const inboxDispositionsQuery = (appId: string, since: string) => queryOptions({
  queryKey: queryKeys.inboxDispositions(appId, since),
  queryFn: () => api.larkInbox(appId, since)
});

export const openPlatformJobQuery = (jobId: string) => queryOptions({
  queryKey: queryKeys.openPlatformJob(jobId),
  queryFn: () => api.larkOpenPlatformSetupJob(jobId),
  refetchInterval: query => ['preparing', 'waiting_for_scan', 'configuring'].includes(query.state.data?.status ?? '') ? 1_000 : false
});

export const projectMemoryBindingQuery = (sessionId: string) => queryOptions({
  queryKey: queryKeys.projectMemoryBinding(sessionId),
  queryFn: () => api.projectMemoryBinding(sessionId)
});

export const planQuery = (sessionId: string, taskId?: string, status?: string) => queryOptions({
  queryKey: queryKeys.plan(sessionId, taskId, status),
  queryFn: () => api.planState(sessionId),
  retry: false
});

export const archivedIntegrationsQuery = (channelBotId: string) => queryOptions({
  queryKey: queryKeys.archivedIntegrations(channelBotId),
  queryFn: () => scheduleApi.archivedIntegrations(channelBotId),
  retry: false
});

export const artifactPreviewQuery = (sessionId: string, snapshotId: string) => queryOptions({
  queryKey: queryKeys.artifactPreview(sessionId, snapshotId),
  queryFn: () => artifactSnapshotsApi.preview(sessionId, snapshotId)
});

export const artifactSnapshotsQuery = (sessionId: string) => queryOptions({
  queryKey: queryKeys.artifactSnapshots(sessionId),
  queryFn: () => artifactSnapshotsApi.list(sessionId)
});

export const workspaceQuery = (sessionId: string) => queryOptions({
  queryKey: queryKeys.workspace(sessionId),
  queryFn: () => api.workspace(sessionId)
});

export const taskAuthorizationsQuery = (sessionId: string, taskIds: string) => queryOptions({
  queryKey: queryKeys.taskAuthorizations(sessionId, taskIds),
  queryFn: () => api.taskAuthorizations(sessionId),
  refetchInterval: 5_000
});

export const turnDiffQuery = (sessionId: string, taskId: string) => queryOptions({
  queryKey: queryKeys.turnDiff(sessionId, taskId),
  queryFn: () => api.turnDiff(sessionId, taskId),
  retry: false
});

export const sessionMemoryQuery = (sessionId: string) => queryOptions({
  queryKey: queryKeys.sessionMemory(sessionId),
  queryFn: () => api.sessionMemory(sessionId),
  refetchInterval: 5_000
});

export const usageReportQuery = (query: UsageReportQuery) => queryOptions({
  queryKey: queryKeys.usageReport(query),
  queryFn: () => api.usageReport(query),
  retry: false,
  placeholderData: previous => previous
});

export const collaborationQuery = (appId: string | undefined, chatId: string | undefined) => queryOptions({
  queryKey: queryKeys.collaboration(appId, chatId),
  queryFn: () => collaborationApi.getOverview(appId!, chatId!),
  retry: false
});

export const turnDiffsQuery = (sessionId: string) => queryOptions({
  queryKey: queryKeys.turnDiffs(sessionId),
  queryFn: () => api.turnDiffs(sessionId),
  refetchInterval: 10_000
});

export const sessionCapabilitiesQuery = (sessionId: string) => queryOptions({
  queryKey: queryKeys.sessionCapabilities(sessionId),
  queryFn: () => api.sessionCapabilities(sessionId)
});

export const sessionUsageQuery = (sessionId: string | undefined, queryKey: ReturnType<typeof queryKeys.sessionUsage | typeof queryKeys.deliveryUsage> = queryKeys.sessionUsage(sessionId)) => queryOptions({
  queryKey,
  queryFn: () => api.sessionUsage(sessionId!),
  retry: false,
  refetchInterval: 15_000,
  refetchIntervalInBackground: false
});

export const agentModelSettingsQuery = (agentId: string, botAppId?: string) => queryOptions({
  queryKey: queryKeys.agentModelSettings(agentId, botAppId),
  queryFn: () => botAppId ? agentModelSettingsApi.get(agentId, botAppId) : agentModelSettingsApi.get(agentId),
  retry: false
});

export const automationHistoryQuery = (sessionId: string, scheduleId: string, offset: number) => queryOptions({
  queryKey: queryKeys.automationHistory(sessionId, scheduleId, offset),
  queryFn: () => api.automationHistory(sessionId, scheduleId, offset),
  retry: false
});

export const automationRunQuery = (sessionId: string, scheduleId: string, occurrenceId: string) => queryOptions({
  queryKey: queryKeys.automationRun(sessionId, scheduleId, occurrenceId),
  queryFn: () => api.automationRun(sessionId, scheduleId, occurrenceId),
  retry: false,
  refetchInterval: query => query.state.error ? false : 10_000
});

export const codexProfileQuery = (agentId: string) => queryOptions({
  queryKey: queryKeys.codexProfile(agentId),
  queryFn: () => agentConfigApi.get(agentId),
  retry: false
});

export const profileModelsQuery = (agentId: string) => queryOptions({
  queryKey: queryKeys.profileModels(agentId),
  queryFn: () => api.agentModels(agentId),
  retry: false
});

export const terminalSettingsQuery = () => queryOptions({
  queryKey: queryKeys.terminalSettings(),
  queryFn: terminalSettingsApi.get,
  retry: false
});

export const pullRequestsQuery = (sessionId: string) => queryOptions({
  queryKey: queryKeys.pullRequests(sessionId),
  queryFn: () => api.pullRequests(sessionId),
  retry: false,
  refetchInterval: query => query.state.error ? false : 10_000
});

export const automationQuery = (sessionId: string) => queryOptions({
  queryKey: queryKeys.automation(sessionId),
  queryFn: () => api.automation(sessionId),
  retry: false,
  refetchInterval: query => query.state.error ? false : 10_000
});

export const ciProvidersQuery = (sessionId: string) => queryOptions({
  queryKey: queryKeys.ciProviders(sessionId),
  queryFn: () => api.ciProviders(sessionId),
  retry: false
});

export const workTemplatesQuery = (sessionId: string) => queryOptions({
  queryKey: queryKeys.workTemplates(sessionId),
  queryFn: () => api.workItems(sessionId),
  retry: false
});

export const unknownTasksQuery = (sessionId: string, pending: string) => queryOptions({
  queryKey: queryKeys.unknownTasks(sessionId, pending),
  queryFn: () => api.unknownTasks(sessionId),
  retry: false
});

export const approvalRulesQuery = () => queryOptions({
  queryKey: queryKeys.approvalRules(),
  queryFn: workspaceApprovalRulesApi.list,
  retry: false
});

export const managedMemoryQuery = (sessionId: string, projectId: string, query: string, isLark: boolean) => queryOptions({
  queryKey: queryKeys.managedMemory(sessionId, projectId, query),
  queryFn: () => isLark ? api.memoryPool(sessionId, query) : api.projectMemory(projectId, query)
});

export const skillsQuery = (active?: Session) => queryOptions({
  queryKey: queryKeys.skills(active?.cwd, active?.sourceId),
  queryFn: () => fetchSkillCatalog(active?.cwd, active?.source === 'lark' || active?.source === 'plugin_trigger' ? active.sourceId?.split(':')[0] : undefined, active?.sourceId?.split(':')[1], active?.workspaceSourceCwd),
  staleTime: 60_000
});

export const sessionQuery = (instance: string | null | undefined, sessionId?: string) => queryOptions({
  queryKey: queryKeys.session(instance, sessionId),
  queryFn: () => api.session(sessionId!),
  retry: false
});

export const automationSchedulesQuery = (sourceId: string | null, search: URLSearchParams) => queryOptions({
  queryKey: queryKeys.automationSchedules(sourceId, search),
  queryFn: () => api.automationSchedules(search, sourceId),
  retry: false,
  refetchInterval: query => query.state.error ? false : 10_000,
  refetchIntervalInBackground: false
});

export const usageTasksQuery = (query: UsageReportQuery, offset: number, limit: number) => queryOptions({
  queryKey: queryKeys.usageTasks(query, offset),
  queryFn: () => api.usageTasks({ ...query, limit, offset }),
  retry: false,
  placeholderData: previous => previous
});
