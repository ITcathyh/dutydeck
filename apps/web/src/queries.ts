import type { RefreshState, SessionInsightCompareRequest, WorkAttempt } from '@dutydeck/shared';
import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';
import {
  agentConfigApi, agentModelSettingsApi, api, artifactSnapshotsApi, collaborationApi, configurationApi,
  foundationApi, insightApi, pluginBindingsApi, scheduleApi, terminalSettingsApi, workspaceApprovalRulesApi,
  type HistoryTurnPlace, type HistoryTurnSummary, type InsightEventFilters, type InsightSummaryFilters,
  type LarkAppCreationJob, type Session, type UsageReportQuery
} from './api';
import { HISTORY_TURN_PAGE_SIZE, loadProjectedHistory, loadTurnHistory, mergeReconciledEvents, type EventWindow } from './event-history';
import { loadAgentModels, readCachedAgentModels } from './model-cache';
import { queryKeys, agentModelsQueryKey, insightQueryKeys } from './query-keys';
import { loadSessions } from './sessions-query';
import { fetchSkillCatalog } from './skill-catalog-api';

export { queryKeys, agentModelsQueryKey, insightQueryKeys } from './query-keys';

// Sessions and the workbench

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

export const sessionQuery = (instance: string | null | undefined, sessionId?: string) => queryOptions({
  queryKey: queryKeys.session(instance, sessionId),
  queryFn: () => api.session(sessionId!),
  retry: false
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

export const sessionUsageQuery = (sessionId: string | undefined, view: 'workbench' | 'delivery' = 'workbench') => queryOptions({
  queryKey: view === 'delivery' ? queryKeys.deliveryUsage(sessionId) : queryKeys.sessionUsage(sessionId),
  queryFn: () => api.sessionUsage(sessionId!),
  retry: false,
  refetchInterval: 15_000,
  refetchIntervalInBackground: false
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

export const workspaceQuery = (sessionId: string) => queryOptions({
  queryKey: queryKeys.workspace(sessionId),
  queryFn: () => api.workspace(sessionId)
});

export const agentsQuery = () => queryOptions({
  queryKey: queryKeys.agents(),
  queryFn: api.agents,
  staleTime: 5 * 60_000
});

export const systemCapabilitiesQuery = () => queryOptions({
  queryKey: queryKeys.systemCapabilities(),
  queryFn: api.systemCapabilities,
  staleTime: 0
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

// History, tasks and delivery

export const historyOutlineQuery = (sessionId: string | undefined, tail?: number) => queryOptions({
  queryKey: queryKeys.historyOutline(sessionId, tail),
  queryFn: ({ signal }) => api.sessionHistory(sessionId!, signal, tail ? { tail } : undefined),
  staleTime: 30_000,
  refetchInterval: 10_000
});

export const historyPageQuery = (sessionId: string, places: HistoryTurnPlace[], page: number) => {
  const start = page * HISTORY_TURN_PAGE_SIZE, end = Math.min(places.length, start + HISTORY_TURN_PAGE_SIZE) - 1;
  const from = places[start]![1], through = places[end]![2];
  return queryOptions({
    queryKey: queryKeys.historyPage(sessionId, from, through),
    queryFn: ({ signal }) => api.sessionHistoryTurns(sessionId, from, through, signal),
    staleTime: Infinity
  });
};

export const eventsQuery = (sessionId: string | undefined, tail?: number) => queryOptions({
  queryKey: queryKeys.events(sessionId),
  queryFn: async ({ client, signal }) => {
    const outline = await client.fetchQuery(historyOutlineQuery(sessionId, tail));
    signal.throwIfAborted();
    const next = await loadProjectedHistory(sessionId!, outline, signal);
    const cached = client.getQueryData<EventWindow>(queryKeys.events(sessionId));
    return cached ? { ...mergeReconciledEvents({ ...cached, events: cached.events.filter(event => event.sequence > outline.liveAfter) }, next.events), outline, highWaterMark: next.highWaterMark } : next;
  },
  staleTime: Infinity,
  structuralSharing: false
});

export const historyDetailQuery = (sessionId: string, summary: HistoryTurnSummary | undefined, reading: boolean) => queryOptions({
  queryKey: reading ? queryKeys.historyDetail(sessionId, summary?.firstSequence, summary?.lastSequence) : queryKeys.closedHistoryDetail(),
  queryFn: ({ signal }) => loadTurnHistory(sessionId, summary!, signal),
  enabled: reading,
  // A defined empty result releases the observer’s previous data when the detail closes.
  initialData: reading ? undefined : [],
  staleTime: Infinity,
  // Keep offline details until the last observer can release them online.
  gcTime: reading ? Infinity : 0
});

export const planQuery = (sessionId: string, taskId?: string, status?: string) => queryOptions({
  queryKey: queryKeys.plan(sessionId, taskId, status),
  queryFn: () => api.planState(sessionId),
  retry: false
});

export const unknownTasksQuery = (sessionId: string, pending: string) => queryOptions({
  queryKey: queryKeys.unknownTasks(sessionId, pending),
  queryFn: () => api.unknownTasks(sessionId),
  retry: false
});

export const taskAuthorizationsQuery = (sessionId: string, taskIds: string) => queryOptions({
  queryKey: queryKeys.taskAuthorizations(sessionId, taskIds),
  queryFn: () => api.taskAuthorizations(sessionId),
  refetchInterval: 5_000
});

export const configurationQuery = (sessionId: string, taskId: string, attemptId: string) => queryOptions({
  queryKey: queryKeys.configuration(sessionId, taskId, attemptId),
  queryFn: () => configurationApi.explain(sessionId, taskId || undefined, attemptId || undefined)
});

export const artifactPreviewQuery = (sessionId: string, snapshotId: string) => queryOptions({
  queryKey: queryKeys.artifactPreview(sessionId, snapshotId),
  queryFn: () => artifactSnapshotsApi.preview(sessionId, snapshotId)
});

export const artifactSnapshotsQuery = (sessionId: string) => queryOptions({
  queryKey: queryKeys.artifactSnapshots(sessionId),
  queryFn: () => artifactSnapshotsApi.list(sessionId)
});

export const turnDiffsQuery = (sessionId: string) => queryOptions({
  queryKey: queryKeys.turnDiffs(sessionId),
  queryFn: () => api.turnDiffs(sessionId),
  refetchInterval: 10_000
});

export const turnDiffQuery = (sessionId: string, taskId: string) => queryOptions({
  queryKey: queryKeys.turnDiff(sessionId, taskId),
  queryFn: () => api.turnDiff(sessionId, taskId),
  retry: false
});

export const sessionCapabilitiesQuery = (sessionId: string) => queryOptions({
  queryKey: queryKeys.sessionCapabilities(sessionId),
  queryFn: () => api.sessionCapabilities(sessionId)
});

/** 有验证正在运行时跟进进度的轮询间隔。 */
export const RUNNING_VERIFICATION_POLL_MS = 5_000;

/** 没有运行中的验证时的低频刷新：仓库变了，「代码已变化」最多晚这么久出现。 */
export const IDLE_VERIFICATION_POLL_MS = 60_000;

export const verificationsQuery = (sessionId: string, active: boolean) => queryOptions({
  queryKey: queryKeys.verifications(sessionId),
  queryFn: () => api.verifications(sessionId),
  refetchInterval: current => active || current.state.data?.some(record => record.status === 'running')
    ? RUNNING_VERIFICATION_POLL_MS : IDLE_VERIFICATION_POLL_MS,
  refetchOnWindowFocus: false
});

export const workItemsQuery = (sessionId: string) => queryOptions({
  queryKey: queryKeys.workItems(sessionId),
  queryFn: () => api.workItems(sessionId),
  staleTime: 5_000,
  refetchInterval: 5_000
});

export const workItemRequestsQuery = (sessionId: string, itemId: string | undefined) => queryOptions({
  queryKey: queryKeys.workItemRequests(sessionId, itemId),
  queryFn: () => api.workItemRequests(sessionId, itemId!),
  staleTime: 5_000,
  refetchInterval: 5_000
});

// Agents and settings

export const agentModelsQuery = (agentId?: string, model?: string, appId?: string) => queryOptions({
  queryKey: agentModelsQueryKey(agentId, model, appId),
  queryFn: () => loadAgentModels(agentId!, model, false, appId),
  initialData: () => agentId && !appId ? readCachedAgentModels(agentId, model) : undefined,
  initialDataUpdatedAt: 0,
  refetchOnMount: 'always',
  staleTime: 60_000
});

export const profileModelsQuery = (agentId: string) => queryOptions({
  queryKey: queryKeys.profileModels(agentId),
  queryFn: () => api.agentModels(agentId),
  retry: false
});

export const agentModelSettingsQuery = (agentId: string, botAppId?: string) => queryOptions({
  queryKey: queryKeys.agentModelSettings(agentId, botAppId),
  queryFn: () => botAppId ? agentModelSettingsApi.get(agentId, botAppId) : agentModelSettingsApi.get(agentId),
  retry: false
});

export const codexProfileQuery = (agentId: string) => queryOptions({
  queryKey: queryKeys.codexProfile(agentId),
  queryFn: () => agentConfigApi.get(agentId),
  retry: false
});

export const skillsQuery = (active?: Session) => queryOptions({
  queryKey: queryKeys.skills(active?.cwd, active?.sourceId),
  queryFn: () => fetchSkillCatalog(active?.cwd, active?.source === 'lark' || active?.source === 'plugin_trigger' ? active.sourceId?.split(':')[0] : undefined, active?.sourceId?.split(':')[1], active?.workspaceSourceCwd),
  staleTime: 60_000
});

export const pluginCommandsQuery = (cwd?: string) => queryOptions({
  queryKey: queryKeys.pluginCommands(cwd),
  queryFn: () => api.pluginCommands(cwd),
  staleTime: 60_000
});

export const systemDirectoriesQuery = (path: string) => queryOptions({
  queryKey: queryKeys.directories(path),
  queryFn: () => api.systemDirectories(path || undefined),
  staleTime: 10_000
});

export const terminalSettingsQuery = () => queryOptions({
  queryKey: queryKeys.terminalSettings(),
  queryFn: terminalSettingsApi.get,
  retry: false
});

export const approvalRulesQuery = () => queryOptions({
  queryKey: queryKeys.approvalRules(),
  queryFn: workspaceApprovalRulesApi.list,
  retry: false
});

export const pluginBindingsQuery = () => queryOptions({
  queryKey: queryKeys.pluginBindings(),
  queryFn: pluginBindingsApi.list
});

// Bots, groups and access

export const larkConfigQuery = () => queryOptions({
  queryKey: queryKeys.larkConfig(),
  queryFn: api.larkConfig,
  staleTime: 0,
  refetchOnWindowFocus: true
});

export const managementGroupsQuery = () => queryOptions({
  queryKey: queryKeys.managementGroups(),
  queryFn: api.managementGroups,
  staleTime: 15_000
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

export const collaborationQuery = (appId: string | undefined, chatId: string | undefined) => queryOptions({
  queryKey: queryKeys.collaboration(appId, chatId),
  queryFn: () => collaborationApi.getOverview(appId!, chatId!),
  retry: false
});

export const hookRoutingQuery = (appId: string | undefined, workspace: string | undefined, routingAgentIds: string[]) => queryOptions({
  queryKey: queryKeys.hookRouting(appId, workspace, routingAgentIds),
  queryFn: () => Promise.all(routingAgentIds.map(id => api.larkHookStatus(appId!, id, workspace)))
});

export const hookSummaryQuery = (appId: string | undefined, workspace: string, defaultAgentId: string, fallbackAgentId: string, weightIds: string[], routingAgentIds: string[]) => queryOptions({
  queryKey: queryKeys.hookSummary(appId, workspace, defaultAgentId, fallbackAgentId, weightIds),
  queryFn: async () => {
    const statuses = await Promise.all(routingAgentIds.map(id => api.larkHookStatus(appId!, id, workspace)));
    const failed = statuses.find(status => !status.supported || !status.installed || !status.writable || status.nativeReady === false);
    return failed && routingAgentIds.length > 1 ? { ...failed, reason: `${failed.agentId}: ${failed.reason ?? '尚未配置可写 Hook'}` } : failed ?? statuses[0]!;
  }
});

export const inboxDispositionsQuery = (appId: string, since: string) => queryOptions({
  queryKey: queryKeys.inboxDispositions(appId, since),
  queryFn: () => api.larkInbox(appId, since)
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

export const larkMemoryStatusQuery = (appId?: string) => queryOptions({
  queryKey: queryKeys.larkMemoryStatus(appId),
  queryFn: () => api.larkMemoryStatus(appId!),
  staleTime: 30_000,
  refetchInterval: query => query.state.data?.groups?.running ? 10_000 : false
});

export const appCreationFinished = (job?: LarkAppCreationJob) => Boolean(job && ['completed', 'pending_review', 'failed', 'cancelled'].includes(job.status));

export const appCreationQuery = (requestId?: string) => queryOptions({
  queryKey: queryKeys.appCreation(requestId),
  queryFn: () => api.larkAppCreationJob(requestId!),
  retry: false,
  refetchInterval: query => appCreationFinished(query.state.data) ? false : 1_000
});

export const openPlatformJobQuery = (jobId: string) => queryOptions({
  queryKey: queryKeys.openPlatformJob(jobId),
  queryFn: () => api.larkOpenPlatformSetupJob(jobId),
  refetchInterval: query => ['preparing', 'waiting_for_scan', 'configuring'].includes(query.state.data?.status ?? '') ? 1_000 : false
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

// Memory

export const projectMemoriesQuery = () => queryOptions({
  queryKey: queryKeys.projectMemories(),
  queryFn: api.projectMemories
});

export const projectMemoryBindingQuery = (sessionId: string) => queryOptions({
  queryKey: queryKeys.projectMemoryBinding(sessionId),
  queryFn: () => api.projectMemoryBinding(sessionId)
});

export const managedMemoryQuery = (sessionId: string, projectId: string, query: string, isLark: boolean) => queryOptions({
  queryKey: queryKeys.managedMemory(sessionId, projectId, query),
  queryFn: () => isLark ? api.memoryPool(sessionId, query) : api.projectMemory(projectId, query)
});

export const sessionMemoryQuery = (sessionId: string) => queryOptions({
  queryKey: queryKeys.sessionMemory(sessionId),
  queryFn: () => api.sessionMemory(sessionId),
  refetchInterval: 5_000
});

// Automation

export const automationQuery = (sessionId: string) => queryOptions({
  queryKey: queryKeys.automation(sessionId),
  queryFn: () => api.automation(sessionId),
  retry: false,
  refetchInterval: query => query.state.error ? false : 10_000
});

export const automationSchedulesQuery = (sourceId: string | null, search: URLSearchParams) => queryOptions({
  queryKey: queryKeys.automationSchedules(sourceId, search),
  queryFn: () => api.automationSchedules(search, sourceId),
  retry: false,
  refetchInterval: query => query.state.error ? false : 10_000,
  refetchIntervalInBackground: false
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

export const ciProvidersQuery = (sessionId: string) => queryOptions({
  queryKey: queryKeys.ciProviders(sessionId),
  queryFn: () => api.ciProviders(sessionId),
  retry: false
});

export const pullRequestsQuery = (sessionId: string) => queryOptions({
  queryKey: queryKeys.pullRequests(sessionId),
  queryFn: () => api.pullRequests(sessionId),
  retry: false,
  refetchInterval: query => query.state.error ? false : 10_000
});

export const workTemplatesQuery = (sessionId: string) => queryOptions({
  queryKey: queryKeys.workTemplates(sessionId),
  queryFn: () => api.workItems(sessionId),
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

export const archivedIntegrationsQuery = (channelBotId: string) => queryOptions({
  queryKey: queryKeys.archivedIntegrations(channelBotId),
  queryFn: () => scheduleApi.archivedIntegrations(channelBotId),
  retry: false
});

// Usage and insight

export const usageSummaryQuery = () => queryOptions({
  queryKey: queryKeys.usageSummary(),
  queryFn: api.usageSummary,
  retry: false,
  refetchInterval: 30_000,
  refetchIntervalInBackground: false
});

export const usageReportQuery = (query: UsageReportQuery) => queryOptions({
  queryKey: queryKeys.usageReport(query),
  queryFn: () => api.usageReport(query),
  retry: false,
  placeholderData: previous => previous
});

export const usageTasksQuery = (query: UsageReportQuery, offset: number, limit: number) => queryOptions({
  queryKey: queryKeys.usageTasks(query, offset),
  queryFn: () => api.usageTasks({ ...query, limit, offset }),
  retry: false,
  placeholderData: previous => previous
});

/** 作业是否仍在进行中：只有 queued / running 需要轮询。 */
export const isRefreshInFlight = (state: RefreshState) => state === 'queued' || state === 'running';

export const insightDetailsQuery = (instance: string | undefined, sessionId: string) => queryOptions({
  queryKey: insightQueryKeys.details(instance, sessionId, null),
  queryFn: ({ signal }) => insightApi.details(sessionId, null, signal),
  refetchInterval: query => {
    const state = query.state.data?.status.refreshState;
    return state && isRefreshInFlight(state) ? 2_000 : false;
  }
});

export const insightCompareQuery = (instance: string | undefined, request: SessionInsightCompareRequest) => queryOptions({
  queryKey: insightQueryKeys.compare(instance, request),
  queryFn: ({ signal }) => insightApi.compare(request, signal)
});

export const insightEventsQuery = (instance: string | undefined, sessionId: string, snapshotId: string, filters: InsightEventFilters) => queryOptions({
  queryKey: insightQueryKeys.events(instance, sessionId, snapshotId, filters),
  queryFn: ({ signal }) => insightApi.events(sessionId, { snapshotId, ...filters }, signal)
});

export const insightSummaryQuery = (instance: string | undefined, filters: InsightSummaryFilters) => infiniteQueryOptions({
  queryKey: insightQueryKeys.summary(instance, filters),
  initialPageParam: undefined as string | undefined,
  queryFn: ({ signal, pageParam }) => insightApi.summary({ ...filters, limit: 100, cursor: pageParam }, signal),
  getNextPageParam: lastPage => lastPage.nextCursor ?? undefined
});
