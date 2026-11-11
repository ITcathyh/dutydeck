import type { TaskAuthorization } from '@dutydeck/shared';
import type { WorkspaceApprovalRule } from '@dutydeck/shared';
export type { TaskAuthorization } from '@dutydeck/shared';
import type { ConfigurationExplanation } from '@dutydeck/shared';
import type { ArtifactSnapshot, ArtifactSnapshotReference, ArtifactSnapshotPreview } from '@dutydeck/shared';
import type { HistoryOutline, HistoryOutlineQuery, HistoryTurnSummary } from '@dutydeck/shared';
export type { HistoryOutline, HistoryTurnPlace, HistoryTurnSummary } from '@dutydeck/shared';
import type { AutomationSchedulePage, AutomationRunDetail } from '@dutydeck/shared';
import type { PluginBinding, SavePluginBinding, PluginConfigSchema, PluginBindingScope } from '@dutydeck/shared';
import type { LarkAllowedUser, PublicLarkConfig, PublicLarkConfigCollection, RiskControlMode, SaveLarkConfigInput } from '@dutydeck/shared';
import type { InboxAction, InboxResponse, LarkAppCreationJob, PermissionMode, ScenarioBinding, ScenarioParam, Session as SharedSession, RunSummary as SharedRunSummary, SessionSourceContext, SessionUsageSnapshot } from '@dutydeck/shared';
import type {
  SessionInsightDetailsResponse,
  SessionInsightRefreshResponse,
  SessionInsightCancelResponse,
  SessionInsightEventsQuery,
  SessionInsightEventsResponse,
  SessionInsightSummaryQuery,
  SessionInsightSummaryResponse,
  SessionInsightCompareRequest,
  SessionInsightCompareResponse,
  SessionInsightExportRequest
} from '@dutydeck/shared';
import type { CreateWorkItemInput, ReviseWorkPlanInput, UnknownTaskAction, UnknownTaskFacts, WorkItem, WorkRevisionPreview, WorkTemplate } from '@dutydeck/shared';
import type { WorkspaceMode, WorkspaceResponse, WorkspaceCleanupPreview, WorkspaceCleanupResult, VerificationResponse, VerificationCommandInput, SkillDeliveryMetadata, SessionAutomationList, PublicSessionScheduleOccurrence, CreateSessionScheduleInput, UpdateSessionScheduleInput, SubscribeCiInput, SessionSchedule, CiSubscription, PublicCiProvider, PublicPullRequest, PullRequestAvailability } from '@dutydeck/shared';
import type { WorkspaceOrganization, WorkspaceOrganizationSnapshot } from '@dutydeck/shared';
import type { UsageBackgroundBudget, UsageCap, UsageGroup, UsageReport, UsageReportFilter, UsageTaskPage, UsageTotals } from '@dutydeck/shared';
import type { ArchivedHammerIntegration, ChannelBotGroupPolicy, CreateGroupBindingInput, EffectiveGroupConfig, GroupBinding, PublicAgent, PublicChannelBotFoundation, RemoteChatFact, RoleAssignment, ScheduleBlocker, ScheduleGeneration, SchedulePreview, ScheduleTrigger, ScheduleWatermark, SecretRefMetadata, UpdateChannelBotInput, UpdateGroupBindingInput, UpdateScheduleDefinitionInput } from '@dutydeck/shared';

import { instanceApiUrl } from './instance';

export type { WorkspaceCleanupPreview, WorkspaceCleanupResult };
/** 同机其他 Dutydeck 实例，经主服务转发访问。 */
export type PeerInstance = { id: string; name: string };
export type { WorkspaceOrganization, WorkspaceOrganizationSnapshot };
export type { ScheduleTrigger };
export type { PermissionMode };
export type { InboxAction, InboxItem, InboxItemKind, InboxResponse } from '@dutydeck/shared';
export type { WorkspaceMode };
export type Agent = PublicAgent;
export type AgentModel = { id: string; name: string };
export type AgentModelsResult = { models: AgentModel[]; profiles?: AgentModel[]; defaultModel?: string; reasoningEfforts: AgentModel[]; defaultReasoningEffort?: string; source?: 'acp' | 'cli' | 'agent'; protocol?: 'acp' };
export type SessionCapabilities = { observedAt: string; protocol?: string; structuredApproval: string; terminal: string; turnRecovery: string; verification: string; localFileDelivery: string };
export type SkillReference = { ref?: string; name: string; description: string; path: string; source: 'workspace' | 'user' | 'plugin' };
export type { LarkAllowedUser, RiskControlMode };
/**
 * 旧服务端可能不返回的字段：读取方按各自默认处理（记忆、自动提取、精简过程卡、问答卡、群内 @ 与提醒两档缺省开启，
 * 其余开关缺省关闭；群记忆范围按 shared、执行方式按 single）。
 */
type LarkBotConfigLegacyOptional = 'welcomeEnabled' | 'revision' | 'memoryEnabled' | 'memoryAutoExtract' | 'groupMemoryScope' | 'claudeAutoMemory' | 'botLoopGuard'
  | 'executionMode' | 'workerAgentIds' | 'structuredAskCards' | 'groupCardMention' | 'completionReactionOnly' | 'silentProgress' | 'adhdMode'
  | 'urgentEnabled' | 'notifyMentionAction' | 'notifyMentionDone' | 'pinLongTasks' | 'compactTrace' | 'showAgentName';
export type LarkBotConfig = Omit<PublicLarkConfig, LarkBotConfigLegacyOptional> & Partial<Pick<PublicLarkConfig, LarkBotConfigLegacyOptional>>;
export type LarkConfig = Omit<PublicLarkConfigCollection, 'bots'> & { bots: LarkBotConfig[] };
/** 保存请求体；成员按姓名提交，由服务端解析为 open_id。 */
export type SaveLarkConfigBody = SaveLarkConfigInput & { stage: 'lark' | 'agent'; allowedUserNames?: string[]; highRiskAllowedUserNames?: string[] };

export type LarkMemoryGroupStatus = {
  appId: string;
  pool: string;
  shared: boolean;
  liveEntries: number;
  topics: number;
  pendingTurns: number;
  running?: { kind: 'extraction' | 'consolidation'; sessionId?: string; startedAt: string };
  lastRun?: {
    kind: 'extraction' | 'consolidation';
    at: string;
    ok: boolean;
    added: number;
    superseded: number;
    retired: number;
    retopiced: number;
    rejected: number;
    error?: string;
  };
  lastRunLabel?: string;
  lastExtractionAt?: string;
  lastConsolidationAt?: string;
  lastFailureAt?: { extraction?: string; consolidation?: string };
};

export type LarkMemoryStatusResult = {
  appId: string;
  enabled: boolean;
  /** 当前群记忆范围；旧服务端缺省按 shared 处理。groups 始终是各群共享池（per-group 时不再被读写，数据保留）。 */
  groupMemoryScope?: 'shared' | 'per-group';
  claudeAutoMemory?: 'inherit' | 'off';
  groups: LarkMemoryGroupStatus;
};

export type LarkTurnMemoryEntry = { id: string; content: string; topic: string; source: 'user' | 'agent' | 'extraction' | 'consolidation'; createdAt: string; deletedAt?: string };
/** 一轮任务注入了哪些记忆、新写入了哪些记忆；按任务记录，newest first。 */
export type LarkTurnMemory = { taskId: string; at: string; shared: boolean; perGroup?: boolean; injected: LarkTurnMemoryEntry[]; written: LarkTurnMemoryEntry[] };

export type RoleChange =
  | {
      kind: 'create';
      principalId: string;
      role: 'can_talk' | 'can_operate' | 'admin';
      operateScope: 'none' | 'own_runs' | 'group_runs' | 'bot_runs';
      actionGates: { terminalWrite: boolean; highRisk: boolean; groupToolsSend: boolean };
    }
  | {
      kind: 'update';
      id: string;
      expectedRevision: number;
      patch: {
        state?: 'active' | 'revoked';
        operateScope?: 'none' | 'own_runs' | 'group_runs' | 'bot_runs';
        actionGates?: { terminalWrite: boolean; highRisk: boolean; groupToolsSend: boolean };
      };
    };

export type ManagedGroupBot = {
  appId: string;
  channelBotId?: string;
  binding?: GroupBinding;
  effective?: EffectiveGroupConfig;
  roles: RoleAssignment[];
  membership: 'member' | 'not_member' | 'inaccessible' | 'unknown';
  validity: string;
  checkedAt?: string;
  applied: boolean;
  error?: string;
};

type UsageCoverage = Pick<UsageTotals, 'unpriced' | 'pricedEntries' | 'unknownCostEntries' | 'costCoverage'>;
/** Older instances omit coverage fields; absence means unknown, not zero. */
export type UsageTotalsResponse = Omit<UsageTotals, keyof UsageCoverage> & Partial<UsageCoverage>;
export type UsageGroupResponse = Omit<UsageGroup, keyof UsageCoverage> & Partial<UsageCoverage>;
export type UsageSummaryWindow = { since: string; totals: UsageTotalsResponse; bots: UsageGroupResponse[]; chats: UsageGroupResponse[]; actors: UsageGroupResponse[]; categories: UsageGroupResponse[] };
export type UsageSummary = { month: UsageSummaryWindow; week: UsageSummaryWindow; caps: UsageCap[]; backgroundBudget?: UsageBackgroundBudget };
/** own：本任务自己的执行；subSteps：归到本任务名下的编排子步骤与 Leader 规划。 */
export type SessionUsage = { own: UsageTotalsResponse; subSteps: UsageTotalsResponse; snapshot?: SessionUsageSnapshot };
/** 明细查询：from / to 是 daemon 本地时区的日历日（YYYY-MM-DD）。 */
export type UsageReportQuery = UsageReportFilter & { from?: string; to?: string };
export type { UsageReport, UsageTaskPage };
const usageQuery = (query: UsageReportQuery & { limit?: number; offset?: number }) => new URLSearchParams(Object.entries(query).filter(([, value]) => value !== undefined && value !== '').map(([key, value]) => [key, String(value)])).toString();
export type UsageCapInput = { scope: 'bot'; appId: string; monthlyCostUsd: number } | { scope: 'group'; appId: string; chatId: string; monthlyCostUsd: number };

export type ManagedGroup = {
  key: string;
  chatId: string;
  name: string;
  bots: ManagedGroupBot[];
};

export type GroupMember = {
  principalId: string;
  openId: string;
  name: string;
};

export type GroupMembersResult = {
  members: GroupMember[];
  pageToken?: string;
  hasMore?: boolean;
};

export type SystemDirectoryEntry = {
  name: string;
  path: string;
};

export type SystemDirectoriesResult = {
  path: string;
  parent?: string;
  roots: string[];
  host: string;
  entries: SystemDirectoryEntry[];
};
export type LarkHookDraft = { workspace?: string; defaultAgentId?: string; fallbackAgentId?: string; defaultAgentWeights?: Array<{ agentId: string; weight: number }> };

export type LarkHookStatus = { agentId?: string; supported: boolean; installed: boolean; nativeReady?: boolean; writable: boolean; trustRequired: boolean; hooksPath?: string; reason?: string; trustInstructions?: string };
export type LarkOpenPlatformSetupJob = {
  id: string;
  appId: string;
  status: 'preparing' | 'waiting_for_scan' | 'configuring' | 'completed' | 'failed';
  createdAt: string;
  updatedAt: string;
  qrDataUrl?: string;
  scanConfirmed?: boolean;
  accountName?: string;
  tenantName?: string;
  result?: { status: 'ready'; scopeCount: number; eventCount: number; callbackCount: number; versionId: string; skippedScopes?: string[] };
  slashCommands?: 'configured' | 'skipped_scope' | 'skipped_credentials' | 'failed';
  error?: string;
};
export type { LarkAppCreationJob };
export type MatterDetail = { id: string; title: string; status: 'open' | 'done' | 'cancelled'; sessions: Session[]; schedules: Array<{ id: string; name: string; enabled: boolean }>; originUrl?: string };
export type Session = Omit<SharedSession, 'state'> & { state: string; matter?: import('@dutydeck/shared').MatterSummary; sourceContext?: SessionSourceContext };
export type DockEvent = { taskId?: string; attemptId?: string; id: string; sequence: number; type: string; timestamp: string; data: any; raw?: string };
export type Task = { skillDeliveries?: SkillDeliveryMetadata[]; id: string; sessionId: string; prompt: string; status: string; createdAt: string; updatedAt: string };
/** 结果未知、现在可以由人处理的一轮：已知事实与三行摘要（服务端生成，与飞书提醒卡同一份文字）。 */
export type UnknownTask = UnknownTaskFacts & { target: string; prompt: string; factLines: string[] };
/** 插话结果：injected / startedNewTurn 已送达；moved 表示状态已变化；failed 是否需要核对以 task.status 为准，reconcile_required 不自动重发。 */
export type SteeringOutcome = 'injected' | 'startedNewTurn' | 'moved' | 'promptRequired' | 'unsupported' | 'incompatible' | 'failed';
/** 会话里最近一份计划的状态：planning 正在出计划，pending 等人决定（operable=false 表示要回飞书计划卡处理）。 */
export type PlanState = { state: 'none' | 'planning' | 'pending' | 'approved' | 'needs_changes' | 'cancelled' | 'expired'; taskId?: string; expiresAt?: string; operable?: boolean };
export type PlanAction = 'approve' | 'revise' | 'cancel';
export type SteeringResult = { outcome: SteeringOutcome; error?: string };
export type RunSummary = SharedRunSummary & { taskReport?: import('@dutydeck/shared').TaskReport; /** 最近一次上下文用量；服务端只在已有用量事件时附带。 */ context?: import('@dutydeck/shared').ContextUsage };
export type EventWindowQuery = { before?: number; after?: number; limit?: number; direction?: 'backward' | 'forward' };
export type BrowserAuthState = { authenticated: boolean; required: boolean; password?: boolean };
export type FoundationCapability = { schemaVersion: 1; repositoriesWired: boolean; permissionEvaluatorWired: boolean; secretInspectorWired: boolean; runtimeWired: false; writesEnabled: boolean; readiness: 'repository_unwired' | 'permission_unwired' | 'secret_inspector_unwired' | 'offline_management_ready'; blockers: Array<{ code: string; message: string; action: string }> };
export type PublicSecretRef = SecretRefMetadata & { availability: 'available' | 'missing' | 'unreadable' | 'unchecked' };
export type GroupMatrixCell = {
  externalChatId: string;
  remoteFact?: RemoteChatFact;
  desiredPolicy?: GroupBinding;
  effectiveSummary?: EffectiveGroupConfig;
  permissionSummary: { talkSource: string; canTalkAssignments: number; canOperateAssignments: number; adminAssignments: number; independentGates: { terminalWrite: boolean; highRisk: boolean; groupToolsSend: boolean } };
  severity: 'healthy' | 'info' | 'needs_review' | 'blocked' | 'degraded';
  blockers: Array<{ code: string; action: string }>;
  primaryAction: { id: string; label: string };
};
export type GroupMatrix = { capabilities: FoundationCapability; bots: Array<{ bot: PublicChannelBotFoundation; policy?: ChannelBotGroupPolicy; cells: GroupMatrixCell[] }> };
export type ScheduleCapability = { schemaVersion: 1; repositoriesWired: boolean; permissionEvaluatorWired: boolean; writesEnabled: boolean; executorWired: false; uiEntryReady: boolean; readiness: 'repository_unwired' | 'permission_unwired' | 'offline_management_ready'; blockers: Array<{ code: string; message: string; action: string }> };
export type PublicScheduleDefinition = {
  schemaVersion: 1; id: string; revision: number; channelBotId: string; groupBindingId?: string; name: string; description?: string;
  trigger: ScheduleTrigger; timezone: string; dstPolicy: { gap: 'skip' | 'shift_forward'; overlap: 'first' | 'second' };
  delivery: { mode: 'chat' | 'thread'; continuation: 'same_thread' | 'new_topic' | 'chat_root'; destinationConfigured: boolean; threadRootConfigured: boolean };
  workspaceConfigured: boolean; payloadConfigured: boolean; identityConfigured: boolean; secretRefConfigured: boolean;
  sourceOwnership: 'dutydeck' | 'botmux'; sourceEnabled: boolean; state: 'staged' | 'disabled'; desiredExecutorState: 'disabled'; currentGeneration: number;
  createdAt: string; updatedAt: string;
};
export type ScheduleDetail = { definition: PublicScheduleDefinition; readiness: { executionEligible: false; nextOccurrence?: SchedulePreview; blockers: ScheduleBlocker[] }; currentGeneration?: ScheduleGeneration; watermark?: ScheduleWatermark };
export type ScheduleList = { capabilities: ScheduleCapability; schedules: ScheduleDetail[] };
/** 一轮任务的改动（「查看改动」页），对应服务端 turn-diff.ts。 */
export type TurnDiffSummary = { files: number; additions: number; deletions: number };
export type TurnDiffLine = { kind: 'context' | 'add' | 'del'; oldLine?: number; newLine?: number; text: string };
export type TurnDiffFile = {
  path: string; oldPath?: string; status: 'added' | 'deleted' | 'modified' | 'renamed'; additions: number; deletions: number;
  placeholder?: 'binary' | 'too_large' | 'omitted' | 'folded_lockfile' | 'folded_generated'; hunks: Array<{ header: string; lines: TurnDiffLine[] }>;
};
export type TurnDiff = { sessionId: string; taskId: string; title?: string; finishedAt?: string; summary: TurnDiffSummary; files: TurnDiffFile[]; truncated: boolean; access: 'shared' | 'owner' };
export type TurnDiffCommentInput = { path: string; side: 'old' | 'new'; line: number; body: string };
export const UNAUTHORIZED_EVENT = 'dutydeck:unauthorized';
/**
 * 分享页只读一个会话：页面加载时从 # 片段取出分享 token，之后每个请求都在查询串里带上它。
 * 放查询串而不是请求头，是因为 EventSource 带不了自定义请求头。
 */
let shareToken: string | undefined;
export const hasShareToken = () => Boolean(shareToken || typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('share'));
export const setShareToken = (token: string | undefined) => { shareToken = token; };
export const withShareToken = (url: string) => shareToken ? `${url}${url.includes('?') ? '&' : '?'}share=${encodeURIComponent(shareToken)}` : url;
export class ApiError extends Error {
  constructor(message: string, public readonly code: string, public readonly status: number, public readonly current?: unknown) { super(message); this.name = 'ApiError'; }
}
const json = async <T,>(url: string, init?: RequestInit, instance?: string | null): Promise<T> => { const targetUrl = instance === undefined ? instanceApiUrl(url) : instance === null ? url : `/api/instances/${encodeURIComponent(instance)}${url.slice(4)}`; const response = await fetch(withShareToken(targetUrl), { credentials: 'same-origin', ...init }); const data = await response.json(); if (!response.ok) { if (response.status === 401 && typeof window !== 'undefined') window.dispatchEvent(new Event(UNAUTHORIZED_EVENT)); throw new ApiError(data.error?.message ?? response.statusText, data.error?.code ?? 'REQUEST_FAILED', response.status, data.current); } return data; };
/** JSON 写请求：method + JSON 请求体。 */
const send = <T,>(method: string, url: string, body: unknown) => json<T>(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const botAgentPath = (id: string, appId?: string) => appId
  ? `/api/lark/bots/${encodeURIComponent(appId)}/agents/${encodeURIComponent(id)}`
  : `/api/agents/${encodeURIComponent(id)}`;
const agentModelsUrl = (id: string, model?: string, refresh = false, appId?: string) => {
  const query = new URLSearchParams();
  if (model) query.set('model', model);
  if (refresh) query.set('refresh', '1');
  const suffix = query.toString();
  return `${botAgentPath(id, appId)}/models${suffix ? `?${suffix}` : ''}`;
};
export const eventsUrl = (id: string, query: EventWindowQuery = {}) => {
  const params = new URLSearchParams();
  if (query.before !== undefined) params.set('before', String(query.before));
  if (query.after !== undefined) params.set('after', String(query.after));
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.direction) params.set('direction', query.direction);
  const suffix = params.toString();
  return `/api/sessions/${id}/events${suffix ? `?${suffix}` : ''}`;
};
export const RUN_SUMMARY_ENDPOINT = '/api/sessions/summaries';
export type WorkItemRequest = { stepId: string; sessionId: string; taskId: string; requestId: string; kind: 'permission' | 'question'; text: string };
export interface BotPromptVersion {
  schemaVersion: 1; appId: string; version: number; text: string; sha256: string; savedAt: string;
  source: 'web' | 'cli' | 'agent' | 'backfill' | 'rollback'; savedBy?: string; rollbackFrom?: number;
}
export type BotPromptHistory = { revision: number; unrecordedUsages?: Array<{ taskId: string; label: '未记录版本' }>; versions: Array<Omit<BotPromptVersion, 'text'> & { characters: number; current: boolean }> };

export const api = {
  larkInbox: (appId: string, since: string) => json<Array<{ messageId: string; receivedAt?: string; sender: string; snippet: string; reason?: string; detail: string; mergedInto?: string; decisionId?: string }>>(`/api/lark/inbox?${new URLSearchParams({ appId, since })}`),
  workItemRequests: (sessionId: string, id: string) => json<WorkItemRequest[]>(`/api/sessions/${encodeURIComponent(sessionId)}/work-items/${encodeURIComponent(id)}/requests`, { cache: 'no-store' }),
  respondWorkItemRequest: (sessionId: string, id: string, input: { stepId: string; taskId: string; requestId: string; kind: 'permission' | 'question'; answer: string }) => send<unknown>('POST', `/api/sessions/${encodeURIComponent(sessionId)}/work-items/${encodeURIComponent(id)}/respond`, input),
  workItems: (sessionId: string) => json<{ items: WorkItem[]; templates: WorkTemplate[] }>(`/api/sessions/${encodeURIComponent(sessionId)}/work-items`, { cache: 'no-store' }),
  workItem: (sessionId: string, id: string) => json<WorkItem>(`/api/sessions/${encodeURIComponent(sessionId)}/work-items/${encodeURIComponent(id)}`, { cache: 'no-store' }),
  createWorkItem: (sessionId: string, input: CreateWorkItemInput) => send<WorkItem>('POST', `/api/sessions/${encodeURIComponent(sessionId)}/work-items`, input),
  cancelWorkItem: (sessionId: string, id: string, expectedRevision: number) => send<WorkItem>('POST', `/api/sessions/${encodeURIComponent(sessionId)}/work-items/${encodeURIComponent(id)}/cancel`, { expectedRevision }),
  retryWorkStep: (sessionId: string, id: string, stepId: string, expectedRevision: number) => send<WorkItem>('POST', `/api/sessions/${encodeURIComponent(sessionId)}/work-items/${encodeURIComponent(id)}/retry`, { stepId, expectedRevision }),
  answerWorkStep: (sessionId: string, id: string, stepId: string, answer: string, expectedRevision: number) => send<WorkItem>('POST', `/api/sessions/${encodeURIComponent(sessionId)}/work-items/${encodeURIComponent(id)}/answer`, { stepId, answer, expectedRevision }),
  previewWorkRevision: (sessionId: string, id: string, input: Omit<ReviseWorkPlanInput, 'reason'>) => send<WorkRevisionPreview>('POST', `/api/sessions/${encodeURIComponent(sessionId)}/work-items/${encodeURIComponent(id)}/revise/preview`, input),
  reviseWorkItem: (sessionId: string, id: string, input: ReviseWorkPlanInput) => send<WorkItem>('POST', `/api/sessions/${encodeURIComponent(sessionId)}/work-items/${encodeURIComponent(id)}/revise`, input),
  confirmWorkItem: (sessionId: string, id: string, expectedRevision: number, revisionDigest?: string) => send<WorkItem>('POST', `/api/sessions/${encodeURIComponent(sessionId)}/work-items/${encodeURIComponent(id)}/confirm`, { expectedRevision, ...(revisionDigest ? { revisionDigest } : {}) }),
  discardWorkRevision: (sessionId: string, id: string, expectedRevision: number, revisionDigest?: string) => send<WorkItem>('POST', `/api/sessions/${encodeURIComponent(sessionId)}/work-items/${encodeURIComponent(id)}/revision/discard`, { expectedRevision, ...(revisionDigest ? { revisionDigest } : {}) }),
  saveWorkTemplate: (sessionId: string, id: string, name: string) => send<WorkTemplate>('POST', `/api/sessions/${encodeURIComponent(sessionId)}/work-items/${encodeURIComponent(id)}/template`, { name }),
  runWorkTemplate: (sessionId: string, id: string, input: { version: number; goal: string; idempotencyKey: string }) => send<WorkItem>('POST', `/api/sessions/${encodeURIComponent(sessionId)}/work-templates/${encodeURIComponent(id)}/run`, input),
  automationSchedules: async (params: URLSearchParams, instance?: string | null) => {
    const page = await json<AutomationSchedulePage>(`/api/automation/schedules?${params}`, undefined, instance);
    if (!Array.isArray(page.items) || !page.counts || typeof page.total !== 'number') throw new ApiError('此实例不支持当前计划总览，请升级后重试', 'AUTOMATION_OVERVIEW_UNSUPPORTED', 404);
    return page;
  },
  automationHistory: (sessionId: string, scheduleId: string, offset = 0, limit = 20) => json<{ occurrences: PublicSessionScheduleOccurrence[]; total: number; offset: number; limit: number }>(`/api/sessions/${encodeURIComponent(sessionId)}/automation/schedules/${encodeURIComponent(scheduleId)}/history?offset=${offset}&limit=${limit}`),
  automationRun: (sessionId: string, scheduleId: string, occurrenceId: string) => json<AutomationRunDetail>(`/api/sessions/${encodeURIComponent(sessionId)}/automation/schedules/${encodeURIComponent(scheduleId)}/runs/${encodeURIComponent(occurrenceId)}`),
  automation: (id: string) => json<SessionAutomationList>(`/api/sessions/${id}/automation`),
  createSchedule: (id: string, input: CreateSessionScheduleInput) => send<{ schedule: SessionSchedule }>('POST', `/api/sessions/${id}/automation/schedules`, input),
  updateSchedule: (id: string, scheduleId: string, input: UpdateSessionScheduleInput) => send<{ schedule: SessionSchedule }>('PATCH', `/api/sessions/${id}/automation/schedules/${scheduleId}`, input),
  runSchedule: (id: string, scheduleId: string, input: { expectedRevision: number; idempotencyKey: string }) => send<{ occurrence: PublicSessionScheduleOccurrence }>('POST', `/api/sessions/${id}/automation/schedules/${scheduleId}/run`, input),
  deleteSchedule: (id: string, scheduleId: string, expectedRevision: number) => send<{ schedule: SessionSchedule }>('DELETE', `/api/sessions/${id}/automation/schedules/${scheduleId}`, { expectedRevision }),
  subscribeCi: (id: string, input: SubscribeCiInput) => send<{ subscription: CiSubscription }>('POST', `/api/sessions/${id}/automation/ci`, input),
  ciProviders: (id: string) => json<{ providers: PublicCiProvider[] }>(`/api/sessions/${id}/automation/ci-providers`),
  cancelCi: (id: string, subscriptionId: string, expectedRevision: number) => send<{ subscription: CiSubscription }>('POST', `/api/sessions/${id}/automation/ci/${subscriptionId}/cancel`, { expectedRevision }),
  pullRequests: (id: string) => json<PullRequestAvailability & { items: PublicPullRequest[] }>(`/api/sessions/${id}/pull-requests`),
  preparePullRequest: (id: string, input: { title?: string }) => send<{ pullRequest: PublicPullRequest }>('POST', `/api/sessions/${id}/pull-requests`, input),
  followPullRequest: (id: string, pullRequest: string) => send<{ pullRequest: PublicPullRequest }>('POST', `/api/sessions/${id}/pull-requests/follow`, { pullRequest }),
  confirmPullRequest: (id: string, pullRequestId: string) => json<{ message: string; pullRequest: PublicPullRequest }>(`/api/sessions/${id}/pull-requests/${pullRequestId}/confirm`, { method: 'POST' }),
  forcePushPullRequest: (id: string, pullRequestId: string) => json<{ message: string }>(`/api/sessions/${id}/pull-requests/${pullRequestId}/force-push`, { method: 'POST' }),
  cancelPullRequest: (id: string, pullRequestId: string) => json<{ pullRequest: PublicPullRequest }>(`/api/sessions/${id}/pull-requests/${pullRequestId}/cancel`, { method: 'POST' }),
  sessionCapabilities: (id: string) => json<SessionCapabilities>(`/api/sessions/${id}/capabilities`),
  workspace: (id: string) => json<WorkspaceResponse | null>(`/api/sessions/${id}/workspace`),
  workspaceCleanupPreview: (id: string) => json<WorkspaceCleanupPreview>(`/api/sessions/${encodeURIComponent(id)}/workspace/cleanup`, { cache: 'no-store' }),
  cleanWorkspace: (id: string, fingerprint: string) => send<WorkspaceCleanupResult>('POST', `/api/sessions/${encodeURIComponent(id)}/workspace/cleanup`, { fingerprint }),
  verifications: (id: string) => json<VerificationResponse[]>(`/api/sessions/${id}/verifications`),
  turnDiffs: (id: string) => json<Array<{ taskId: string; summary: TurnDiffSummary; finishedAt?: string }>>(`/api/sessions/${id}/diffs`),
  turnDiff: (id: string, taskId: string) => json<TurnDiff>(`/api/sessions/${id}/tasks/${taskId}/diff`),
  /** 折叠的锁文件、生成物按需读正文。 */
  turnDiffFile: (id: string, taskId: string, path: string) => json<TurnDiffFile>(`/api/sessions/${id}/tasks/${taskId}/diff/file?path=${encodeURIComponent(path)}`),
  submitTurnDiffComments: (id: string, taskId: string, comments: TurnDiffCommentInput[]) => send<{ delivery: 'dispatched' | 'lark_confirmation' }>('POST', `/api/sessions/${id}/tasks/${taskId}/diff/comments`, { comments }),
  verify: (id: string, input: VerificationCommandInput) => send<VerificationResponse>('POST', `/api/sessions/${id}/verifications`, input),
  authStatus: () => json<BrowserAuthState>('/api/auth/status', { cache: 'no-store' }),
  login: (token: string) => send<BrowserAuthState>('POST', '/api/auth/login', { token }),
  passwordLogin: (password: string) => send<BrowserAuthState>('POST', '/api/auth/login', { password }),
  logout: () => json<BrowserAuthState>('/api/auth/logout', { method: 'POST' }),
  instances: () => json<{ instances: PeerInstance[] }>('/api/instances', { cache: 'no-store' }),
  sessionHistory: (id: string, signal?: AbortSignal, query?: HistoryOutlineQuery) => json<HistoryOutline>(`/api/sessions/${encodeURIComponent(id)}/history${query?.tail ? `?tail=${query.tail}` : ''}`, { signal }),
  sessionHistoryTurns: (id: string, from: number, through: number, signal?: AbortSignal) => json<{ turns: HistoryTurnSummary[] }>(`/api/sessions/${encodeURIComponent(id)}/history/turns?from=${from}&through=${through}`, { signal }),
  agents: () => json<Agent[]>('/api/agents'), agentModels: (id: string, model?: string, refresh = false, appId?: string) => json<AgentModelsResult>(agentModelsUrl(id, model, refresh, appId)), sessions: (signal?: AbortSignal) => json<Session[]>('/api/sessions', { signal }), session: (id: string) => json<Session>(`/api/sessions/${encodeURIComponent(id)}`), events: (id: string, query?: EventWindowQuery, signal?: AbortSignal) => json<DockEvent[]>(eventsUrl(id, query), { signal }), tasks: (id: string) => json<Task[]>(`/api/sessions/${id}/tasks`),
  // 跨任务标题的最小只读契约；服务端接入前 UI 仅使用当前已加载 tasks 的真实 prompt，不伪造摘要。
  matter: (id: string) => json<MatterDetail>(`/api/matters/${encodeURIComponent(id)}`),
  runSummaries: () => json<RunSummary[]>(RUN_SUMMARY_ENDPOINT),
  create: (body: { agentId: string; cwd?: string; model?: string; codexProfile?: string; reasoningEffort?: string; permissionMode?: PermissionMode; workspaceMode?: WorkspaceMode }) => send<Session>('POST', '/api/sessions', body),
  /** 先出计划：Agent 只调研出计划（写操作被拦），批准后才执行。 */
  plan: (id: string, prompt: string) => send<{ accepted: true; task: Task; steering?: undefined }>('POST', `/api/sessions/${id}/plan`, { prompt }),
  planState: (id: string) => json<PlanState>(`/api/sessions/${id}/plan`, { cache: 'no-store' }),
  decidePlan: (id: string, taskId: string, action: PlanAction, feedback?: string) => send<{ state: PlanState['state']; task?: Task }>('POST', `/api/sessions/${id}/plan/${taskId}`, { action, ...(feedback ? { feedback } : {}) }),
  send: (id: string, prompt: string, mode: 'queue' | 'interrupt' | 'steer' = 'queue', skillRequests?: string[]) => send<{ accepted: true; task: Task; steering?: SteeringResult }>('POST', `/api/sessions/${id}/send`, { prompt, mode, ...(skillRequests?.length ? { skillRequests } : {}) }),
  setSessionModel: (id: string, model: string) => send<Session>('PATCH', `/api/sessions/${id}/config`, { model }),
  setSessionReasoningEffort: (id: string, reasoningEffort: string) => send<Session>('PATCH', `/api/sessions/${id}/config`, { reasoningEffort }),
  setSessionName: (id: string, name: string | null) => send<Session>('PATCH', `/api/sessions/${encodeURIComponent(id)}/name`, { name }),
  cancelQueued: (id: string, taskId: string) => json<Task>(`/api/sessions/${id}/queue/${taskId}`, { method: 'DELETE' }),
  steerQueued: (id: string, taskId: string) => json<Task>(`/api/sessions/${id}/queue/${taskId}/steer`, { method: 'POST' }),
  injectQueued: (id: string, taskId: string) => json<SteeringResult & { task: Task }>(`/api/sessions/${id}/queue/${taskId}/inject`, { method: 'POST' }),
  botPromptHistory: (appId: string) => json<BotPromptHistory>(`/api/lark/bots/${encodeURIComponent(appId)}/prompt-versions`),
  botPromptShow: (appId: string, version: number) => json<BotPromptVersion>(`/api/lark/bots/${encodeURIComponent(appId)}/prompt-versions/${version}`),
  botPromptDiff: (appId: string, a: number, b: number) => json<{ diff: string }>(`/api/lark/bots/${encodeURIComponent(appId)}/prompt-versions/diff?a=${a}&b=${b}`),
  botPromptRollback: (appId: string, version: number, expectedRevision: number) => send<LarkConfig>('POST', `/api/lark/bots/${encodeURIComponent(appId)}/prompt-versions/${version}/rollback`, { expectedRevision }),
  larkConfig: () => json<LarkConfig>('/api/lark/config'),
  usageReport: (query: UsageReportQuery) => json<UsageReport>(`/api/usage/report?${usageQuery(query)}`, { cache: 'no-store' }),
  usageTasks: (query: UsageReportQuery & { limit: number; offset: number }) => json<UsageTaskPage>(`/api/usage/tasks?${usageQuery(query)}`, { cache: 'no-store' }),
  usageSummary: () => json<UsageSummary>('/api/usage/summary', { cache: 'no-store' }),
  setUsageCap: (body: UsageCapInput) => send<UsageCap>('PUT', '/api/usage/caps', body),
  deleteUsageCap: ({ scope, appId, chatId }: Pick<UsageCap, 'scope' | 'appId' | 'chatId'>) => json<{ deleted: boolean }>(`/api/usage/caps?${new URLSearchParams({ scope, appId, ...(chatId ? { chatId } : {}) })}`, { method: 'DELETE' }),
  sessionUsage: (id: string) => json<SessionUsage>(`/api/sessions/${encodeURIComponent(id)}/usage`),
  startLarkOpenPlatformSetup: (appId: string, forceLogin = false) => send<LarkOpenPlatformSetupJob>('POST', '/api/lark/open-platform/configure', { appId, forceLogin }),
  larkOpenPlatformSetupJob: (jobId: string) => json<LarkOpenPlatformSetupJob>(`/api/lark/open-platform/jobs/${encodeURIComponent(jobId)}`, { cache: 'no-store' }),
  createLarkApp: (input: { requestId: string; name: string; forceLogin?: boolean }) => send<LarkAppCreationJob>('POST', '/api/lark/apps/create', input),
  larkAppCreationJob: (jobId: string) => json<LarkAppCreationJob>(`/api/lark/apps/create/${encodeURIComponent(jobId)}`, { cache: 'no-store' }),
  cancelLarkAppCreation: (jobId: string) => json<LarkAppCreationJob>(`/api/lark/apps/create/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' }),
  retryLarkAppCreation: (jobId: string, forceLogin = false) => send<LarkAppCreationJob>('POST', `/api/lark/apps/create/${encodeURIComponent(jobId)}/retry`, { forceLogin }),
  inspectLarkBot: (body: { appId: string; appSecret: string }) => send<{ appName: string; openId: string; avatarUrl?: string; activateStatus?: number }>('POST', '/api/lark/bot/inspect', body),
  saveLarkConfig: (body: SaveLarkConfigBody) => send<LarkConfig>('PUT', '/api/lark/config', body),
  deleteLarkConfig: (appId: string) => json<LarkConfig>(`/api/lark/config/${encodeURIComponent(appId)}`, { method: 'DELETE' }),
  managementGroups: () => json<{ groups: ManagedGroup[] }>('/api/lark/management/groups', { cache: 'no-store' }),
  syncGroups: (appId: string) => send<{ groups: ManagedGroup[]; error?: string }>('POST', `/api/lark/bots/${encodeURIComponent(appId)}/sync-groups`, {}),
  updateGroupBotBinding: (appId: string, chatId: string, body: { expectedRevision: number; patch: Partial<Pick<GroupBinding, 'agentOverride' | 'workspaceOverride' | 'modelOverride' | 'reasoningOverride' | 'routingOverride' | 'accessOverride' | 'groupToolsOverride' | 'presentationOverride' | 'oncall' | 'state'>>; roleChanges?: RoleChange[] }) => send<ManagedGroupBot>('PUT', `/api/lark/bots/${encodeURIComponent(appId)}/groups/${encodeURIComponent(chatId)}`, body),
  groupMembers: (appId: string, chatId: string, pageToken?: string) => json<GroupMembersResult>(`/api/lark/bots/${encodeURIComponent(appId)}/groups/${encodeURIComponent(chatId)}/members${pageToken ? `?pageToken=${encodeURIComponent(pageToken)}` : ''}`, { cache: 'no-store' }),
  systemDirectories: (path?: string) => json<SystemDirectoriesResult>(`/api/system/directories${path ? `?path=${encodeURIComponent(path)}` : ''}`, { cache: 'no-store' }),
  larkHookStatus: (appId: string, agentId?: string, workspace?: string) => {
    const query = new URLSearchParams({ appId });
    if (agentId) query.set('agentId', agentId);
    if (workspace !== undefined) query.set('workspace', workspace);
    return json<LarkHookStatus>(`/api/lark/hooks/status?${query.toString()}`);
  },
  larkMemoryStatus: (appId: string) => json<LarkMemoryStatusResult>(`/api/lark/bots/${encodeURIComponent(appId)}/memory/status`, { cache: 'no-store' }),
  taskAuthorizations: (sessionId: string) => json<TaskAuthorization[]>(`/api/sessions/${encodeURIComponent(sessionId)}/task-authorizations`),
  unknownTasks: (sessionId: string) => json<UnknownTask[]>(`/api/sessions/${encodeURIComponent(sessionId)}/unknown-tasks`, { cache: 'no-store' }),
  resolveUnknownTask: (sessionId: string, taskId: string, input: { target: string; action: UnknownTaskAction; allowDuplicateEffects?: true }) => send<{ replayed: boolean; status: string; decisionId: string }>('POST', `/api/sessions/${encodeURIComponent(sessionId)}/unknown-tasks/${encodeURIComponent(taskId)}`, input),
  memoryPool: (sessionId: string, q = '') => json<MemoryPoolView>(`/api/sessions/${encodeURIComponent(sessionId)}/memory-pool${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  reviseMemoryPool: (sessionId: string, entryId: string, body: MemoryWrite) => send('PATCH', `/api/sessions/${encodeURIComponent(sessionId)}/memory-pool/${encodeURIComponent(entryId)}`, body),
  removeMemoryPool: (sessionId: string, entryId: string) => json(`/api/sessions/${encodeURIComponent(sessionId)}/memory-pool/${encodeURIComponent(entryId)}`, { method: 'DELETE' }),
  projectMemories: () => json<{ projects: ProjectMemorySummary[] }>('/api/project-memory'),
  createProjectMemory: (name: string) => send<{ project: ProjectMemorySummary }>('POST', '/api/project-memory', { name }),
  projectMemory: (id: string, q = '') => json<MemoryPoolView & ProjectMemorySummary>(`/api/project-memory/${encodeURIComponent(id)}${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  setProjectMemoryEnabled: (id: string, enabled: boolean) => send('PATCH', `/api/project-memory/${encodeURIComponent(id)}`, { enabled }),
  writeProjectMemory: (id: string, body: MemoryWrite, entryId?: string) => send(entryId ? 'PATCH' : 'POST', `/api/project-memory/${encodeURIComponent(id)}/entries${entryId ? `/${encodeURIComponent(entryId)}` : ''}`, body),
  removeProjectMemory: (id: string, entryId: string) => json(`/api/project-memory/${encodeURIComponent(id)}/entries/${encodeURIComponent(entryId)}`, { method: 'DELETE' }),
  projectMemoryBinding: (sessionId: string) => json<{ projectId: string | null }>(`/api/sessions/${encodeURIComponent(sessionId)}/project-memory`),
  bindProjectMemory: (sessionId: string, projectId: string | null) => send('PUT', `/api/sessions/${encodeURIComponent(sessionId)}/project-memory`, { projectId }),
  sessionMemory: (sessionId: string) => json<{ turns: LarkTurnMemory[] }>(`/api/sessions/${encodeURIComponent(sessionId)}/memory`, { cache: 'no-store' }),
  forgetSessionMemory: (sessionId: string, taskId: string, memoryId: string) => json<{ removed: { id: string } }>(`/api/sessions/${encodeURIComponent(sessionId)}/memory/${encodeURIComponent(taskId)}/entries/${encodeURIComponent(memoryId)}`, { method: 'DELETE' }),
  installLarkHook: (appId: string, highRiskPattern: string, expectedRevision?: number, draft?: LarkHookDraft) => send<LarkHookStatus & { configRevision?: number }>('POST', '/api/lark/hooks/install', { appId, highRiskPattern, expectedRevision, ...(draft ? { draft } : {}) }),
  systemCapabilities: () => json<{ platform: string; directoryPicker: boolean; filePicker: boolean }>('/api/system/capabilities'),
  skills: (cwd?: string, botAppId?: string, chatId?: string, pluginWorkspaceRoot?: string) => json<SkillReference[]>(`/api/system/skills?${new URLSearchParams({ ...(cwd ? { cwd } : {}), ...(botAppId ? { botAppId } : {}), ...(chatId ? { chatId } : {}), ...(pluginWorkspaceRoot ? { pluginWorkspaceRoot } : {}) })}`),
  /** 已启用插件提供的斜杠命令；没有插件时服务端不注册这个接口，按空列表处理。 */
  pluginCommands: async (cwd?: string) => {
    try { return (await json<{ commands: Array<{ name: string; description: string }> }>(`/api/plugins/commands${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''}`)).commands; }
    catch { return []; }
  },
  selectDirectory: () => json<{ path: string }>('/api/system/select-directory', { method: 'POST' }),
  selectFile: () => json<{ path: string }>('/api/system/select-file', { method: 'POST' }),
  archive: (id: string) => json<Session>(`/api/sessions/${id}/archive`, { method: 'POST' }),
  workspaceGroups: () => json<WorkspaceOrganizationSnapshot>('/api/workspace-groups'),
  createWorkspaceGroup: (name: string) => send<WorkspaceOrganizationSnapshot>('POST', '/api/workspace-groups', { name }),
  renameWorkspaceGroup: (id: string, name: string) => send<WorkspaceOrganizationSnapshot>('PATCH', `/api/workspace-groups/${encodeURIComponent(id)}`, { name }),
  deleteWorkspaceGroup: (id: string) => json<WorkspaceOrganizationSnapshot>(`/api/workspace-groups/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  assignWorkspaceGroups: (input: { groupId: string | null; sessionIds?: string[]; directories?: string[] }) => send<WorkspaceOrganizationSnapshot>('PUT', '/api/workspace-groups/assignments', input),
  restart: (id: string) => json<Session>(`/api/sessions/${id}/restart`, { method: 'POST' }),
  action: (id: string, action: string) => json(`/api/sessions/${id}/${action}`, { method: 'POST' }),
  permission: (id: string, permissionId: string, approved: boolean, reason?: string) => send('POST', `/api/sessions/${id}/permissions/${permissionId}`, reason ? { approved, reason } : { approved }),
  inbox: () => json<InboxResponse>('/api/inbox', { cache: 'no-store' }),
  /** 待处理条目上的动作：服务端给出原对象现有的接口与带版本的请求体，这里原样调用。 */
  inboxAction: (action: InboxAction) => send<unknown>(action.method ?? 'POST', action.path!, action.body ?? {})
};

export const foundationApi = {
  capabilities: () => json<FoundationCapability>('/api/foundation/capabilities', { cache: 'no-store' }),
  secretRefs: () => json<{ secretRefs: PublicSecretRef[] }>('/api/foundation/secret-refs', { cache: 'no-store' }),
  groupMatrix: () => json<GroupMatrix>('/api/foundation/group-matrix', { cache: 'no-store' }),
  createChannelBot: (input: { id: string; externalAppId: string; displayName: string; brand: 'feishu' | 'lark' }) => send<PublicChannelBotFoundation>('POST', '/api/foundation/channel-bots', input),
  updateChannelBot: (id: string, input: UpdateChannelBotInput) => send<PublicChannelBotFoundation>('PATCH', `/api/foundation/channel-bots/${encodeURIComponent(id)}`, input),
  createGroupBinding: (input: CreateGroupBindingInput) => send<GroupBinding>('POST', '/api/foundation/group-bindings', input),
  updateGroupBinding: (id: string, input: UpdateGroupBindingInput) => send<GroupBinding>('PATCH', `/api/foundation/group-bindings/${encodeURIComponent(id)}`, input)
};

export const scheduleApi = {
  capabilities: () => json<ScheduleCapability>('/api/foundation/schedules/capabilities', { cache: 'no-store' }),
  list: () => json<ScheduleList>('/api/foundation/schedules', { cache: 'no-store' }),
  preview: (id: string, after?: string) => json<{ scheduleId: string; preview?: SchedulePreview; executionEligible: false; blockers: ScheduleBlocker[] }>(`/api/foundation/schedules/${encodeURIComponent(id)}/preview${after ? `?after=${encodeURIComponent(after)}` : ''}`, { cache: 'no-store' }),
  update: (id: string, input: UpdateScheduleDefinitionInput) => send<ScheduleDetail>('PATCH', `/api/foundation/schedules/${encodeURIComponent(id)}`, input),
  archivedIntegrations: (channelBotId: string) => json<{ integrations: ArchivedHammerIntegration[] }>(`/api/foundation/schedules/archived-integrations?channelBotId=${encodeURIComponent(channelBotId)}`, { cache: 'no-store' })
};

// ==================== Collaboration Types & API ====================

export type CollaborationScope = {
  appId: string;
  chatId: string;
};

export type CollaborationParticipation = 'off' | 'observe' | 'selective' | 'eager';

export type CollaborationSettings = {
  scope: CollaborationScope;
  revision: number;
  participation: CollaborationParticipation;
  inheritParticipation: boolean;
  instructions: string;
  notificationsPaused: boolean;
  maxProactivePerHour: number;
  retentionDays: number;
  policyVersion: string;
  updatedAt: string;
};

/** 本 Bot 在群里的分工：接话人和各场景包的绑定（按包 id）。 */
export type CollaborationDuty = {
  scope: CollaborationScope;
  revision: number;
  responder?: { appId: string; name?: string; since: string };
  scenarios?: Record<string, ScenarioBinding>;
  updatedAt: string;
};

/** 群设置页列出的一个场景包：参数声明、本群绑定和能否在 Web 上开启。 */
export type CollaborationScenario = {
  id: string;
  title: string;
  version: string;
  description: string;
  mode: 'direct' | 'model';
  params: Record<string, ScenarioParam>;
  binding?: ScenarioBinding;
  /** direct 包要有在群里确认过的人才能开启。 */
  requiresRequester: boolean;
  /** 绑定的大版本和包不一致，要先在群里重新确认。 */
  versionStale: boolean;
  webDescription?: string;
  enableHint?: string;
  plugin: string;
  builtin: boolean;
};

/** 接话人只能设成本 Bot（self）或清掉（null）。场景包按 id 改开关和参数，params 只给改动的键，null 删掉绑定；确认人和包版本不能在 Web 上改。 */
export type UpdateCollaborationDutyInput = {
  expectedRevision: number;
  responder?: 'self' | null;
  scenarios?: Record<string, { enabled: boolean; params?: Record<string, unknown> } | null>;
};

export type CollaborationObservation = {
  id: string;
  scope: CollaborationScope;
  sequence: number;
  source: string;
  eventId: string;
  occurredAt: string;
  receivedAt: string;
  senderId?: string;
  senderKind: 'human' | 'bot' | 'system';
  threadId?: string;
  messageId?: string;
  text: string;
  refs: string[];
  origin: 'live' | 'history' | 'external';
  missing: string[];
  revision: number;
};

export type CollaborationBootstrap = {
  scope: CollaborationScope;
  status: 'pending' | 'running' | 'complete' | 'partial' | 'failed';
  cursor?: string;
  lastEventAt?: string;
  missing: string[];
  updatedAt: string;
};

export type CollaborationFollowupStep = {
  id: string;
  label: string;
  status: 'open' | 'done';
};

export type CollaborationFollowup = {
  id: string;
  scope: CollaborationScope;
  revision: number;
  goal: string;
  status: 'open' | 'completed' | 'cancelled';
  progress: string;
  steps: CollaborationFollowupStep[];
  ownerId?: string;
  dueAt?: string;
  result?: string;
  sourceRefs: string[];
  taskIds: string[];
  externalRefs: string[];
  fields: Record<string, string>;
  createdBy: string;
  updatedBy: string;
  provenance: 'observed' | 'inferred' | 'confirmed';
  createdAt: string;
  updatedAt: string;
};

export type CollaborationMandate = {
  id: string;
  scope: CollaborationScope;
  revision: number;
  goal: string;
  status: 'active' | 'paused' | 'cancelled' | 'completed';
  requesterId: string;
  sourceRefs: string[];
  followupId?: string;
  scheduleDefinitionId: string;
  mode: 'notify' | 'agent';
  prompt: string;
  condition: 'always' | 'followup_open' | 'no_progress';
  deliveryPaused: boolean;
  catchupPolicy: 'skip' | 'coalesce';
  lastProgressRevision?: number;
  createdAt: string;
  updatedAt: string;
};

export type CollaborationMandateDetail = CollaborationMandate & {
  schedule?: PublicScheduleDefinition;
  nextDueAt?: string;
};

export type CollaborationDecision = {
  id: string;
  scope: CollaborationScope;
  contextRevision: number;
  policyVersion: string;
  action: 'silent' | 'reply' | 'act';
  reason: string;
  evidenceIds: string[];
  status: 'candidate' | 'suppressed' | 'sent' | 'failed';
  response?: string;
  inputSnapshot: Record<string, unknown>;
  createdAt: string;
};

export type CollaborationFeedback = {
  id: string;
  scope: CollaborationScope;
  decisionId: string;
  actorId: string;
  correction: string;
  expectedAction?: 'silent' | 'reply' | 'act';
  createdAt: string;
};

export type CollaborationAction = {
  id: string;
  scope: CollaborationScope;
  revision: number;
  kind: string;
  mandateId?: string;
  mandateRevision?: number;
  scheduleGeneration?: number;
  contextRevision?: number;
  followupRevision?: number;
  requesterId: string;
  inputDigest: string;
  payload: Record<string, unknown>;
  status: 'intent' | 'sending' | 'succeeded' | 'failed' | 'unknown' | 'suppressed';
  receipt?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
};

export type CollaborationActivity = {
  id: string;
  scope: CollaborationScope;
  entityKind: 'followup' | 'mandate' | 'settings';
  entityId: string;
  revision: number;
  actorId: string;
  sourceRefs: string[];
  provenance: 'observed' | 'inferred' | 'confirmed';
  summary: string;
  createdAt: string;
};

export type CollaborationSnapshot = {
  scope: CollaborationScope;
  contextRevision: number;
  settings: CollaborationSettings;
  observations: CollaborationObservation[];
  followups: CollaborationFollowup[];
  mandates: CollaborationMandate[];
  bootstrap?: CollaborationBootstrap;
};

export type CollaborationOverview = {
  snapshot: CollaborationSnapshot;
  followups: CollaborationFollowup[];
  mandates: CollaborationMandateDetail[];
  decisions: CollaborationDecision[];
  actions: CollaborationAction[];
  activities: CollaborationActivity[];
  feedback: CollaborationFeedback[];
  /** 旧版实例不返回。 */
  duty?: CollaborationDuty;
  /** 对本 Bot 适用的场景包；旧版实例不返回。 */
  scenarios?: CollaborationScenario[];
};

export type UpdateCollaborationSettingsInput = {
  expectedRevision: number;
  participation?: CollaborationParticipation;
  inheritParticipation?: boolean;
  instructions?: string;
  notificationsPaused?: boolean;
  maxProactivePerHour?: number;
  retentionDays?: number;
  policyVersion?: string;
};

export type CreateCollaborationFollowupInput = {
  id: string;
  goal: string;
  progress?: string;
  steps?: Array<{ id: string; label: string; status: 'open' | 'done' }>;
  ownerId?: string;
  dueAt?: string;
  sourceRefs?: string[];
  fields?: Record<string, string>;
};

export type UpdateCollaborationFollowupInput = {
  expectedRevision: number;
  goal?: string;
  status?: 'open' | 'completed' | 'cancelled';
  progress?: string;
  steps?: Array<{ id: string; label: string; status: 'open' | 'done' }>;
  ownerId?: string | null;
  dueAt?: string | null;
  result?: string;
  sourceRefs?: string[];
  taskIds?: string[];
  externalRefs?: string[];
  fields?: Record<string, string>;
  provenance?: 'observed' | 'inferred' | 'confirmed';
};

export type CreateCollaborationMandateInput = {
  id: string;
  goal: string;
  followupId?: string;
  mode: 'notify' | 'agent';
  prompt: string;
  condition?: 'always' | 'followup_open' | 'no_progress';
  trigger: ScheduleTrigger;
  timezone: string;
  catchupPolicy?: 'skip' | 'coalesce';
  sourceRefs?: string[];
};

export type UpdateCollaborationMandateInput = {
  expectedRevision: number;
  goal?: string;
  status?: 'active' | 'paused' | 'cancelled' | 'completed';
  prompt?: string;
  deliveryPaused?: boolean;
  trigger?: ScheduleTrigger;
  timezone?: string;
  condition?: 'always' | 'followup_open' | 'no_progress';
  catchupPolicy?: 'skip' | 'coalesce';
};

export type CreateCollaborationFeedbackInput = {
  correction: string;
  expectedAction?: 'silent' | 'reply' | 'act';
};

export type CollaborationReplayInput = {
  decisionIds: string[];
  policyVersion?: string;
};

export type CollaborationReplayResultItem = {
  decisionId: string;
  status: 'passed' | 'failed' | 'missing';
  expected?: string;
  actual?: string;
  reason?: string;
};

export type CollaborationReplayResponse = {
  results: CollaborationReplayResultItem[];
  passed: number;
  failed: number;
  missing: number;
};

export const collaborationApi = {
  getOverview: (appId: string, chatId: string) =>
    json<CollaborationOverview>(
      `/api/lark/groups/${encodeURIComponent(appId)}/${encodeURIComponent(chatId)}/collaboration`,
      { cache: 'no-store' }
    ),
  updateSettings: (appId: string, chatId: string, body: UpdateCollaborationSettingsInput) =>
    send<{ settings: CollaborationSettings }>('PATCH', `/api/lark/groups/${encodeURIComponent(appId)}/${encodeURIComponent(chatId)}/collaboration/settings`, body),
  updateDuty: (appId: string, chatId: string, body: UpdateCollaborationDutyInput) =>
    send<{ duty: CollaborationDuty; announced?: boolean }>('PATCH', `/api/lark/groups/${encodeURIComponent(appId)}/${encodeURIComponent(chatId)}/collaboration/duty`, body),
  createFollowup: (appId: string, chatId: string, body: CreateCollaborationFollowupInput) =>
    send<{ followup: CollaborationFollowup }>('POST', `/api/lark/groups/${encodeURIComponent(appId)}/${encodeURIComponent(chatId)}/collaboration/followups`, body),
  updateFollowup: (appId: string, chatId: string, id: string, body: UpdateCollaborationFollowupInput) =>
    send<{ followup: CollaborationFollowup }>('PATCH', `/api/lark/groups/${encodeURIComponent(appId)}/${encodeURIComponent(chatId)}/collaboration/followups/${encodeURIComponent(id)}`, body),
  createMandate: (appId: string, chatId: string, body: CreateCollaborationMandateInput) =>
    send<{ mandate: CollaborationMandate; schedule?: PublicScheduleDefinition }>('POST', `/api/lark/groups/${encodeURIComponent(appId)}/${encodeURIComponent(chatId)}/collaboration/mandates`, body),
  updateMandate: (appId: string, chatId: string, id: string, body: UpdateCollaborationMandateInput) =>
    send<{ mandate: CollaborationMandate; schedule?: PublicScheduleDefinition }>('PATCH', `/api/lark/groups/${encodeURIComponent(appId)}/${encodeURIComponent(chatId)}/collaboration/mandates/${encodeURIComponent(id)}`, body),
  addFeedback: (appId: string, chatId: string, decisionId: string, body: CreateCollaborationFeedbackInput) =>
    send<{ feedback: CollaborationFeedback }>('POST', `/api/lark/groups/${encodeURIComponent(appId)}/${encodeURIComponent(chatId)}/collaboration/decisions/${encodeURIComponent(decisionId)}/feedback`, body),
  replay: (appId: string, chatId: string, body: CollaborationReplayInput) =>
    send<CollaborationReplayResponse>('POST', `/api/lark/groups/${encodeURIComponent(appId)}/${encodeURIComponent(chatId)}/collaboration/replay`, body),
  bootstrap: (appId: string, chatId: string) =>
    send<{ bootstrap: CollaborationBootstrap }>('POST', `/api/lark/groups/${encodeURIComponent(appId)}/${encodeURIComponent(chatId)}/collaboration/bootstrap`, {})
};

/** 飞书审批卡「本工作区允许此类命令」保存的规则：只能查看和撤销，安装管理员可用。 */
export const workspaceApprovalRulesApi = {
  list: () => json<{ rules: WorkspaceApprovalRule[] }>('/api/workspace-approval-rules', { cache: 'no-store' }),
  remove: (id: string) => json<{ removed: string }>(`/api/workspace-approval-rules/${encodeURIComponent(id)}`, { method: 'DELETE' }),
};

export const terminalSettingsApi = {
  get: () => json<{ terminalBackend: 'tmux' | 'herdr'; scope: 'pty-cli' }>('/api/settings/terminal', { cache: 'no-store' }),
  set: (terminalBackend: 'tmux' | 'herdr') => send<{ terminalBackend: 'tmux' | 'herdr'; scope: 'pty-cli' }>('PUT', '/api/settings/terminal', { terminalBackend }),
};

// ============================================================================
// 会话分析（Session Insight）
//
// 所有请求都经过 instanceApiUrl：远端实例经实例代理转发，实例间不共享缓存。
// 下载报告同样走实例路径并携带原有 cookie；401 仍触发统一未授权事件。
// ============================================================================

export type InsightEventFilters = Pick<SessionInsightEventsQuery, 'kind' | 'tool' | 'result'> & { cursor?: string; limit?: number };
export type InsightSummaryFilters = Partial<Omit<SessionInsightSummaryQuery, 'cursor'>> & { cursor?: string };

/** React Query key 统一工厂：实例、session、snapshot、筛选项全部进 key，实例切换不串缓存。 */
export const insightQueryKeys = {
  details: (instance: string | undefined, sessionId: string, snapshotId?: string | null) =>
    ['insight', instance ?? null, 'details', sessionId, snapshotId ?? null] as const,
  events: (instance: string | undefined, sessionId: string, snapshotId: string, filters: InsightEventFilters) =>
    ['insight', instance ?? null, 'events', sessionId, snapshotId, filters] as const,
  summary: (instance: string | undefined, filters: InsightSummaryFilters) =>
    ['insight', instance ?? null, 'summary', filters] as const,
  compare: (instance: string | undefined, request: SessionInsightCompareRequest | null) =>
    ['insight', instance ?? null, 'compare', request] as const
};

const insightEventsUrl = (sessionId: string, query: { snapshotId: string } & InsightEventFilters) => {
  const params = new URLSearchParams();
  params.set('snapshotId', query.snapshotId);
  params.set('limit', String(query.limit ?? 100));
  if (query.cursor) params.set('cursor', query.cursor);
  if (query.kind) params.set('kind', query.kind);
  if (query.tool) params.set('tool', query.tool);
  if (query.result) params.set('result', query.result);
  return `/api/sessions/${encodeURIComponent(sessionId)}/insight/events?${params.toString()}`;
};

const insightSummaryUrl = (query: InsightSummaryFilters) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    params.set(key, String(value));
  }
  return `/api/insights/summary?${params.toString()}`;
};

const attachmentFilename = (response: Response, fallback: string) => {
  const disposition = response.headers.get('Content-Disposition');
  // 服务端文件名只含安全 ID 与日期；优先取 filename*，再取 filename。
  const encoded = disposition?.match(/filename\*=(?:UTF-8'')?([^;]+)/i)?.[1];
  if (encoded) { try { return decodeURIComponent(encoded.trim()); } catch { /* 落到 filename */ } }
  const plain = disposition?.match(/filename="?([^";]+)"?/i)?.[1];
  return plain?.trim() || fallback;
};

const downloadBlob = async (url: string, body: unknown, fallbackFilename: string): Promise<{ blob: Blob; filename: string }> => {
  const response = await fetch(withShareToken(instanceApiUrl(url)), {
    credentials: 'same-origin',
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    if (response.status === 401 && typeof window !== 'undefined') window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    // 错误响应仍是服务端统一的 JSON 结构，不是文件内容。
    let data: unknown;
    try { data = await response.clone().json(); } catch { data = undefined; }
    const payload = data as { error?: { message?: string; code?: string } } | undefined;
    throw new ApiError(payload?.error?.message ?? response.statusText, payload?.error?.code ?? 'REQUEST_FAILED', response.status, data);
  }
  const blob = await response.blob();
  return { blob, filename: attachmentFilename(response, fallbackFilename) };
};

export const insightApi = {
  details: (sessionId: string, snapshotId?: string | null, signal?: AbortSignal) => {
    const query = snapshotId ? `?snapshotId=${encodeURIComponent(snapshotId)}` : '';
    return json<SessionInsightDetailsResponse>(
      `/api/sessions/${encodeURIComponent(sessionId)}/insight${query}`,
      { cache: 'no-store', signal }
    );
  },
  refresh: (sessionId: string) =>
    send<SessionInsightRefreshResponse>('POST', `/api/sessions/${encodeURIComponent(sessionId)}/insight/refresh`, {}),
  cancel: (sessionId: string, requestId: string) =>
    json<SessionInsightCancelResponse>(
      `/api/sessions/${encodeURIComponent(sessionId)}/insight/refresh/${encodeURIComponent(requestId)}`,
      { method: 'DELETE' }
    ),
  events: (sessionId: string, query: { snapshotId: string } & InsightEventFilters, signal?: AbortSignal) =>
    json<SessionInsightEventsResponse>(insightEventsUrl(sessionId, query), { cache: 'no-store', signal }),
  summary: (query: InsightSummaryFilters, signal?: AbortSignal) =>
    json<SessionInsightSummaryResponse>(insightSummaryUrl(query), { cache: 'no-store', signal }),
  compare: (body: SessionInsightCompareRequest, signal?: AbortSignal) =>
    json<SessionInsightCompareResponse>('/api/insights/compare', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal
    }),
  exportReport: (body: SessionInsightExportRequest) => {
    const fallbackFilename = body.kind === 'session'
      ? `session-insight-${body.sessionId}.${body.format === 'html' ? 'html' : 'md'}`
      : `session-insight-comparison.${body.format === 'html' ? 'html' : 'md'}`;
    return downloadBlob('/api/insights/export', body, fallbackFilename);
  }
};

export type AgentModelSettings = { agentId: string; appId?: string; model: string; baseUrl: string; authMode: 'bearer' | 'api-key'; hasApiKey: boolean; apiKeyAvailable: boolean; appliesTo: 'next_process' };
export type AgentModelSettingsPatch = { model?: string; baseUrl?: string; authMode?: 'bearer' | 'api-key'; apiKey?: string; clearApiKey?: boolean };
export type AgentConfigSettings = { id: string; codexProfile: string };
export const agentConfigApi = {
  get: (id: string) => json<AgentConfigSettings>(`/api/agents/${encodeURIComponent(id)}/config`, { cache: 'no-store' }),
  set: (id: string, codexProfile: string | null) => send<Agent>('PATCH', `/api/agents/${encodeURIComponent(id)}/config`, { codexProfile })
};
const modelSettingsUrl = (id: string, appId?: string) => `${botAgentPath(id, appId)}/model-settings`;
export const agentModelSettingsApi = {
  get: (id: string, appId?: string) => json<AgentModelSettings>(modelSettingsUrl(id, appId), { cache: 'no-store' }),
  set: (id: string, body: AgentModelSettingsPatch, appId?: string) => send<AgentModelSettings>('PUT', modelSettingsUrl(id, appId), body)
};

export const pluginBindingsApi = {
  list: () => json<{ bindings: PluginBinding[]; packages: Array<{ name: string; version?: string; scope: string; apiVersion: number | string; configSchema: PluginConfigSchema; requiredSkills: string[]; legacyGlobal: string[]; capabilities?: string[]; permissions?: { secrets: string[]; network: string[]; filesystem: string[]; effects: string[] }; slots?: Array<{ id: string; slot: string; title: string; description?: string; elements: Array<Record<string, unknown>> }>; service?: { mode: string; status: { status: string } } }>; diagnostics: Array<{ plugin: string; message: string }> }>('/api/plugin-bindings'),
  save: (body: SavePluginBinding) => send<{ binding: PluginBinding }>('PUT', '/api/plugin-bindings', body),
  explain: (body: PluginBindingScope & { plugin: string }) => send<Record<string, unknown>>('POST', '/api/plugin-bindings/explain', body),
  slot: (plugin: string, slot: string) => json<{ plugin: string; slot: string; declarations: Array<{ id: string; slot: string; title: string; description?: string; elements: Array<Record<string, unknown>> }> }>(`/api/plugins/${encodeURIComponent(plugin)}/slots/${encodeURIComponent(slot)}`)
};

export const configurationApi = {
  explain: (sessionId: string, taskId?: string, attemptId?: string) => {
    const query = new URLSearchParams({ ...(taskId ? { taskId } : {}), ...(attemptId ? { attemptId } : {}) });
    return json<ConfigurationExplanation>(`/api/sessions/${encodeURIComponent(sessionId)}/configuration${query.size ? `?${query}` : ''}`);
  }
};
export interface MemoryManagementEntry extends LarkTurnMemoryEntry {
  supersedes?: string[];
  supersededBy?: string;
  origin?: { label: string; sessionId?: string; taskId?: string };
}
export interface MemoryPoolView { scope?: string; entries: MemoryManagementEntry[]; fingerprint: string; historyNotice: string }
export interface MemoryWrite { content: string; topic?: string; expectedFingerprint: string }
export interface ProjectMemorySummary { id: string; name: string; enabled: boolean; count?: number }
export const artifactSnapshotsApi = {
  list: (sessionId: string) => json<{ snapshots: ArtifactSnapshot[] }>(`/api/sessions/${encodeURIComponent(sessionId)}/artifact-snapshots`),
  capture: (sessionId: string, ref: ArtifactSnapshotReference) => send<ArtifactSnapshot>('POST', `/api/sessions/${encodeURIComponent(sessionId)}/artifact-snapshots`, ref),
  preview: (sessionId: string, id: string) => json<ArtifactSnapshotPreview>(`/api/sessions/${encodeURIComponent(sessionId)}/artifact-snapshots/${encodeURIComponent(id)}/preview`),
  download: async (sessionId: string, id: string): Promise<Blob> => {
    const response = await fetch(withShareToken(instanceApiUrl(`/api/sessions/${encodeURIComponent(sessionId)}/artifact-snapshots/${encodeURIComponent(id)}/download`)), { credentials: 'same-origin' });
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { error?: { message?: string; code?: string } };
      throw new ApiError(body.error?.message ?? '快照下载失败', body.error?.code ?? 'REQUEST_FAILED', response.status);
    }
    return response.blob();
  }
};
