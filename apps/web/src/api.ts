import type { LarkAppCreationJob, PermissionMode, ScenarioBinding, ScenarioParam, SessionSourceContext, SessionUsageSnapshot } from '@dutydeck/shared';
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
import type { CreateWorkItemInput, UnknownTaskAction, UnknownTaskFacts, WorkItem, WorkTemplate } from '@dutydeck/shared';
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
export type { WorkspaceMode };
export type Agent = PublicAgent;
export type AgentModel = { id: string; name: string };
export type AgentModelsResult = { models: AgentModel[]; defaultModel?: string; reasoningEfforts: AgentModel[]; defaultReasoningEffort?: string; source?: 'acp' | 'cli' | 'agent'; protocol?: 'acp' };
export type SessionCapabilities = { observedAt: string; protocol?: string; structuredApproval: string; terminal: string; turnRecovery: string; verification: string; localFileDelivery: string };
export type SkillReference = { name: string; description: string; path: string; source: 'workspace' | 'user' | 'plugin' };
export type LarkAllowedUser = { openId: string; name: string };
export type RiskControlMode = 'off' | 'guidance' | 'enforced';
export type LarkBotConfig = {
  configured: true;
  appId: string;
  name: string;
  tabLabel: string;
  setupComplete: boolean;
  workspace?: string;
  webBaseUrl?: string;
  /** 配置向导里答了手机打不开 Web 地址；此时没有 webBaseUrl，卡片不显示「查看详情」 */
  webMobileReachable?: false;
  defaultAgentId?: string;
  defaultModel?: string;
  defaultReasoningEffort?: string;
  fullTrustConfirmed: boolean;
  permissionMode?: 'ask' | 'approve-reads' | 'full-trust';
  roleTitle?: string;
  roleScope?: string;
  preInjectPrompt: string;
  listening: boolean;
  activeListening: boolean;
  groupToolsEnabled: boolean;
  groupToolsAllowSend: boolean;
  /** 会话记忆开关，服务端恒返回布尔；旧服务端缺省仅 Tag 模式开启。 */
  memoryEnabled?: boolean;
  /** 后台自动提取与整理开关，服务端恒返回布尔；旧服务端缺省按开启处理。 */
  memoryAutoExtract?: boolean;
  /** 群记忆范围：shared 各群共用一份（默认）；per-group 每个群各自一份。服务端恒返回；旧服务端缺省按 shared 处理。 */
  groupMemoryScope?: 'shared' | 'per-group';
  /** 跑提取与整理的 Agent；空表示沿用机器人默认 Agent。 */
  memoryAgentId?: string;
  /** 跑提取与整理的模型；空表示沿用默认模型。 */
  memoryModel?: string;
  decisionAgentId?: string;
  decisionModel?: string;
  busyTriage?: boolean;
  responseAgentId?: string;
  responseModel?: string;
  /** 执行方式；旧服务端缺省按 single 处理。 */
  executionMode?: 'single' | 'layered';
  /** 分层协作的 Leader Agent。 */
  leaderAgentId?: string;
  /** 分层协作里 Leader 可以指派的 Worker Agent。 */
  workerAgentIds?: string[];
  /** P0-2 结构化问答卡片总开关，服务端恒返回布尔；旧服务端缺省按关闭处理。 */
  structuredAskCards?: boolean;
  /** P0-4 群内卡片 @ 发起人总开关，服务端恒返回布尔；缺省按开启处理。 */
  groupCardMention?: boolean;
  /** `/new --cwd <别名>` 的别名表；没有别名时字段缺席。 */
  workspaceAliases?: Record<string, string>;
  /** 结果卡验证状态依赖的验证命令；未配置时字段缺席，结果卡不提验证。 */
  verificationCommand?: string;
  /** 完成时只贴表情、不发结果卡；旧服务端缺省按关闭处理。 */
  completionReactionOnly?: boolean;
  /** 中间进展静默，只保留最终结果；旧服务端缺省按关闭处理。 */
  silentProgress?: boolean;
  /** ADHD 友好输出；旧服务端缺省按关闭处理。 */
  adhdMode?: boolean;
  /** 卡片长时间无人处理时发加急提醒；服务端恒返回布尔，旧服务端缺省按关闭处理。 */
  urgentEnabled?: boolean;
  /** 触发加急的等待时长；服务端未配置时字段缺席，按模块默认处理。 */
  urgentThresholdMs?: number;
  /** 单个会话每小时的加急上限；服务端未配置时字段缺席，按模块默认处理。 */
  urgentMaxPerHourPerChat?: number;
  /** 「需要你操作」「完成」两档是否 @ 发起人；服务端恒返回布尔，旧服务端缺省按开启处理。 */
  notifyMentionAction?: boolean;
  notifyMentionDone?: boolean;
  /** 免打扰时段 HH:MM-HH:MM；未启用时字段缺席。 */
  notifyQuietHours?: string;
  /** 长任务自动置顶；服务端恒返回布尔，旧服务端缺省按关闭处理。 */
  pinLongTasks?: boolean;
  /** 触发置顶的运行时长；服务端未配置时字段缺席，按模块默认处理。 */
  pinAfterMs?: number;
  pushIntervalMs: number;
  traceLimit?: number;
  hideTraceOnComplete: boolean;
  /** 精简过程卡；旧服务端缺省按开启处理。 */
  compactTrace?: boolean;
  showAgentName?: boolean;
  allowedUsers: LarkAllowedUser[];
  allowedEmails: string[];
  allowedBots: LarkAllowedUser[];
  peerBotsAllowed: boolean;
  highRiskAllowedUsers: LarkAllowedUser[];
  highRiskAllowedEmails: string[];
  highRiskPattern: string;
  riskControlMode: RiskControlMode;
  revision?: number;
  p2pMode?: 'chat' | 'thread';
  idleCompactEnabled?: boolean;
  idleCompactHours?: number;
  groupReplyMode?: 'chat' | 'shared' | 'new-topic' | 'chat-topic';
  mentionPolicy?: 'always' | 'topic' | 'never' | 'ambient';
  defaultGroupParticipation?: 'off' | 'observe' | 'selective' | 'eager';
};
export type LarkConfig = { configured: boolean; bots: LarkBotConfig[]; listeningDisabled: boolean };

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
export type LarkHookStatus = { agentId?: string; supported: boolean; installed: boolean; writable: boolean; trustRequired: boolean; hooksPath?: string; reason?: string; trustInstructions?: string };
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
export type Session = { id: string; agentId: string; state: string; cwd: string; name?: string; model?: string; reasoningEffort?: string; permissionMode?: PermissionMode; source?: string; sourceId?: string; sourceContext?: SessionSourceContext; archivedAt?: string; runId: string; createdAt: string; updatedAt: string; error?: string; systemPrompt?: string; workspaceMode?: WorkspaceMode; workspaceSourceCwd?: string };
export type DockEvent = { taskId?: string; id: string; sequence: number; type: string; timestamp: string; data: any; raw?: string };
export type Task = { skillDeliveries?: SkillDeliveryMetadata[]; id: string; sessionId: string; prompt: string; status: string; createdAt: string; updatedAt: string };
/** 结果未知、现在可以由人处理的一轮：已知事实与三行摘要（服务端生成，与飞书提醒卡同一份文字）。 */
export type UnknownTask = UnknownTaskFacts & { target: string; prompt: string; factLines: string[] };
/** 插话结果：injected / startedNewTurn 已送达；moved 表示状态已变化；failed 是否需要核对以 task.status 为准，reconcile_required 不自动重发。 */
export type SteeringOutcome = 'injected' | 'startedNewTurn' | 'moved' | 'promptRequired' | 'unsupported' | 'incompatible' | 'failed';
/** 会话里最近一份计划的状态：planning 正在出计划，pending 等人决定（operable=false 表示要回飞书计划卡处理）。 */
export type PlanState = { state: 'none' | 'planning' | 'pending' | 'approved' | 'needs_changes' | 'cancelled' | 'expired'; taskId?: string; expiresAt?: string; operable?: boolean };
export type PlanAction = 'approve' | 'revise' | 'cancel';
export type SteeringResult = { outcome: SteeringOutcome; error?: string };
export type RunSummary = { sessionId: string; taskId: string; prompt: string; status: string; queuedCount: number; updatedAt: string };
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
  placeholder?: 'binary' | 'too_large' | 'omitted'; hunks: Array<{ header: string; lines: TurnDiffLine[] }>;
};
export type TurnDiff = { sessionId: string; taskId: string; title?: string; finishedAt?: string; summary: TurnDiffSummary; files: TurnDiffFile[]; truncated: boolean; access: 'shared' | 'owner' };
export type TurnDiffCommentInput = { path: string; side: 'old' | 'new'; line: number; body: string };
export const UNAUTHORIZED_EVENT = 'dutydeck:unauthorized';
/**
 * 分享页只读一个会话：页面加载时从 # 片段取出分享 token，之后每个请求都在查询串里带上它。
 * 放查询串而不是请求头，是因为 EventSource 带不了自定义请求头。
 */
let shareToken: string | undefined;
export const setShareToken = (token: string | undefined) => { shareToken = token; };
export const withShareToken = (url: string) => shareToken ? `${url}${url.includes('?') ? '&' : '?'}share=${encodeURIComponent(shareToken)}` : url;
export class ApiError extends Error {
  constructor(message: string, public readonly code: string, public readonly status: number, public readonly current?: unknown) { super(message); this.name = 'ApiError'; }
}
const json = async <T,>(url: string, init?: RequestInit): Promise<T> => { const response = await fetch(withShareToken(instanceApiUrl(url)), { credentials: 'same-origin', ...init }); const data = await response.json(); if (!response.ok) { if (response.status === 401 && typeof window !== 'undefined') window.dispatchEvent(new Event(UNAUTHORIZED_EVENT)); throw new ApiError(data.error?.message ?? response.statusText, data.error?.code ?? 'REQUEST_FAILED', response.status, data.current); } return data; };
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
export const api = {
  workItemRequests: (sessionId: string, id: string) => json<WorkItemRequest[]>(`/api/sessions/${encodeURIComponent(sessionId)}/work-items/${encodeURIComponent(id)}/requests`, { cache: 'no-store' }),
  respondWorkItemRequest: (sessionId: string, id: string, input: { stepId: string; taskId: string; requestId: string; kind: 'permission' | 'question'; answer: string }) => json<unknown>(`/api/sessions/${encodeURIComponent(sessionId)}/work-items/${encodeURIComponent(id)}/respond`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }),
  workItems: (sessionId: string) => json<{ items: WorkItem[]; templates: WorkTemplate[] }>(`/api/sessions/${encodeURIComponent(sessionId)}/work-items`, { cache: 'no-store' }),
  workItem: (sessionId: string, id: string) => json<WorkItem>(`/api/sessions/${encodeURIComponent(sessionId)}/work-items/${encodeURIComponent(id)}`, { cache: 'no-store' }),
  createWorkItem: (sessionId: string, input: CreateWorkItemInput) => json<WorkItem>(`/api/sessions/${encodeURIComponent(sessionId)}/work-items`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }),
  cancelWorkItem: (sessionId: string, id: string, expectedRevision: number) => json<WorkItem>(`/api/sessions/${encodeURIComponent(sessionId)}/work-items/${encodeURIComponent(id)}/cancel`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision }) }),
  retryWorkStep: (sessionId: string, id: string, stepId: string, expectedRevision: number) => json<WorkItem>(`/api/sessions/${encodeURIComponent(sessionId)}/work-items/${encodeURIComponent(id)}/retry`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ stepId, expectedRevision }) }),
  answerWorkStep: (sessionId: string, id: string, stepId: string, answer: string, expectedRevision: number) => json<WorkItem>(`/api/sessions/${encodeURIComponent(sessionId)}/work-items/${encodeURIComponent(id)}/answer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ stepId, answer, expectedRevision }) }),
  saveWorkTemplate: (sessionId: string, id: string, name: string) => json<WorkTemplate>(`/api/sessions/${encodeURIComponent(sessionId)}/work-items/${encodeURIComponent(id)}/template`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) }),
  runWorkTemplate: (sessionId: string, id: string, input: { version: number; goal: string; idempotencyKey: string }) => json<WorkItem>(`/api/sessions/${encodeURIComponent(sessionId)}/work-templates/${encodeURIComponent(id)}/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }),
  automation: (id: string) => json<SessionAutomationList>(`/api/sessions/${id}/automation`),
  createSchedule: (id: string, input: CreateSessionScheduleInput) => json<{ schedule: SessionSchedule }>(`/api/sessions/${id}/automation/schedules`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }),
  updateSchedule: (id: string, scheduleId: string, input: UpdateSessionScheduleInput) => json<{ schedule: SessionSchedule }>(`/api/sessions/${id}/automation/schedules/${scheduleId}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }),
  runSchedule: (id: string, scheduleId: string, input: { expectedRevision: number; idempotencyKey: string }) => json<{ occurrence: PublicSessionScheduleOccurrence }>(`/api/sessions/${id}/automation/schedules/${scheduleId}/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }),
  deleteSchedule: (id: string, scheduleId: string, expectedRevision: number) => json<{ schedule: SessionSchedule }>(`/api/sessions/${id}/automation/schedules/${scheduleId}`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision }) }),
  subscribeCi: (id: string, input: SubscribeCiInput) => json<{ subscription: CiSubscription }>(`/api/sessions/${id}/automation/ci`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }),
  ciProviders: (id: string) => json<{ providers: PublicCiProvider[] }>(`/api/sessions/${id}/automation/ci-providers`),
  cancelCi: (id: string, subscriptionId: string, expectedRevision: number) => json<{ subscription: CiSubscription }>(`/api/sessions/${id}/automation/ci/${subscriptionId}/cancel`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision }) }),
  pullRequests: (id: string) => json<PullRequestAvailability & { items: PublicPullRequest[] }>(`/api/sessions/${id}/pull-requests`),
  preparePullRequest: (id: string, input: { title?: string }) => json<{ pullRequest: PublicPullRequest }>(`/api/sessions/${id}/pull-requests`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }),
  confirmPullRequest: (id: string, pullRequestId: string) => json<{ message: string; pullRequest: PublicPullRequest }>(`/api/sessions/${id}/pull-requests/${pullRequestId}/confirm`, { method: 'POST' }),
  cancelPullRequest: (id: string, pullRequestId: string) => json<{ pullRequest: PublicPullRequest }>(`/api/sessions/${id}/pull-requests/${pullRequestId}/cancel`, { method: 'POST' }),
  sessionCapabilities: (id: string) => json<SessionCapabilities>(`/api/sessions/${id}/capabilities`),
  workspace: (id: string) => json<WorkspaceResponse | null>(`/api/sessions/${id}/workspace`),
  workspaceCleanupPreview: (id: string) => json<WorkspaceCleanupPreview>(`/api/sessions/${encodeURIComponent(id)}/workspace/cleanup`, { cache: 'no-store' }),
  cleanWorkspace: (id: string, fingerprint: string) => json<WorkspaceCleanupResult>(`/api/sessions/${encodeURIComponent(id)}/workspace/cleanup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fingerprint }) }),
  verifications: (id: string) => json<VerificationResponse[]>(`/api/sessions/${id}/verifications`),
  turnDiffs: (id: string) => json<Array<{ taskId: string; summary: TurnDiffSummary; finishedAt?: string }>>(`/api/sessions/${id}/diffs`),
  turnDiff: (id: string, taskId: string) => json<TurnDiff>(`/api/sessions/${id}/tasks/${taskId}/diff`),
  submitTurnDiffComments: (id: string, taskId: string, comments: TurnDiffCommentInput[]) => json<{ delivery: 'dispatched' | 'lark_confirmation' }>(`/api/sessions/${id}/tasks/${taskId}/diff/comments`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ comments }) }),
  verify: (id: string, input: VerificationCommandInput) => json<VerificationResponse>(`/api/sessions/${id}/verifications`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }),
  authStatus: () => json<BrowserAuthState>('/api/auth/status', { cache: 'no-store' }),
  login: (token: string) => json<BrowserAuthState>('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) }),
  passwordLogin: (password: string) => json<BrowserAuthState>('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) }),
  logout: () => json<BrowserAuthState>('/api/auth/logout', { method: 'POST' }),
  instances: () => json<{ instances: PeerInstance[] }>('/api/instances', { cache: 'no-store' }),
  agents: () => json<Agent[]>('/api/agents'), agentModels: (id: string, model?: string, refresh = false, appId?: string) => json<AgentModelsResult>(agentModelsUrl(id, model, refresh, appId)), sessions: () => json<Session[]>('/api/sessions'), session: (id: string) => json<Session>(`/api/sessions/${encodeURIComponent(id)}`), events: (id: string, query?: EventWindowQuery, signal?: AbortSignal) => json<DockEvent[]>(eventsUrl(id, query), { signal }), tasks: (id: string) => json<Task[]>(`/api/sessions/${id}/tasks`),
  // 跨任务标题的最小只读契约；服务端接入前 UI 仅使用当前已加载 tasks 的真实 prompt，不伪造摘要。
  runSummaries: () => json<RunSummary[]>(RUN_SUMMARY_ENDPOINT),
  create: (body: { agentId: string; cwd?: string; model?: string; reasoningEffort?: string; permissionMode?: PermissionMode; workspaceMode?: WorkspaceMode }) => json<Session>('/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  /** 先出计划：Agent 只调研出计划（写操作被拦），批准后才执行。 */
  plan: (id: string, prompt: string) => json<{ accepted: true; task: Task; steering?: undefined }>(`/api/sessions/${id}/plan`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt }) }),
  planState: (id: string) => json<PlanState>(`/api/sessions/${id}/plan`, { cache: 'no-store' }),
  decidePlan: (id: string, taskId: string, action: PlanAction, feedback?: string) => json<{ state: PlanState['state']; task?: Task }>(`/api/sessions/${id}/plan/${taskId}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...(feedback ? { feedback } : {}) }) }),
  send: (id: string, prompt: string, mode: 'queue' | 'interrupt' | 'steer' = 'queue', skillRequests?: string[]) => json<{ accepted: true; task: Task; steering?: SteeringResult }>(`/api/sessions/${id}/send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt, mode, ...(skillRequests?.length ? { skillRequests } : {}) }) }),
  setSessionModel: (id: string, model: string) => json<Session>(`/api/sessions/${id}/config`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model }) }),
  setSessionReasoningEffort: (id: string, reasoningEffort: string) => json<Session>(`/api/sessions/${id}/config`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reasoningEffort }) }),
  setSessionName: (id: string, name: string | null) => json<Session>(`/api/sessions/${encodeURIComponent(id)}/name`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) }),
  cancelQueued: (id: string, taskId: string) => json<Task>(`/api/sessions/${id}/queue/${taskId}`, { method: 'DELETE' }),
  steerQueued: (id: string, taskId: string) => json<Task>(`/api/sessions/${id}/queue/${taskId}/steer`, { method: 'POST' }),
  injectQueued: (id: string, taskId: string) => json<SteeringResult & { task: Task }>(`/api/sessions/${id}/queue/${taskId}/inject`, { method: 'POST' }),
  larkConfig: () => json<LarkConfig>('/api/lark/config'),
  usageReport: (query: UsageReportQuery) => json<UsageReport>(`/api/usage/report?${usageQuery(query)}`, { cache: 'no-store' }),
  usageTasks: (query: UsageReportQuery & { limit: number; offset: number }) => json<UsageTaskPage>(`/api/usage/tasks?${usageQuery(query)}`, { cache: 'no-store' }),
  usageSummary: () => json<UsageSummary>('/api/usage/summary', { cache: 'no-store' }),
  setUsageCap: (body: UsageCapInput) => json<UsageCap>('/api/usage/caps', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  deleteUsageCap: ({ scope, appId, chatId }: Pick<UsageCap, 'scope' | 'appId' | 'chatId'>) => json<{ deleted: boolean }>(`/api/usage/caps?${new URLSearchParams({ scope, appId, ...(chatId ? { chatId } : {}) })}`, { method: 'DELETE' }),
  sessionUsage: (id: string) => json<SessionUsage>(`/api/sessions/${encodeURIComponent(id)}/usage`),
  startLarkOpenPlatformSetup: (appId: string, forceLogin = false) => json<LarkOpenPlatformSetupJob>('/api/lark/open-platform/configure', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ appId, forceLogin }) }),
  larkOpenPlatformSetupJob: (jobId: string) => json<LarkOpenPlatformSetupJob>(`/api/lark/open-platform/jobs/${encodeURIComponent(jobId)}`, { cache: 'no-store' }),
  createLarkApp: (input: { requestId: string; name: string; forceLogin?: boolean }) => json<LarkAppCreationJob>('/api/lark/apps/create', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }),
  larkAppCreationJob: (jobId: string) => json<LarkAppCreationJob>(`/api/lark/apps/create/${encodeURIComponent(jobId)}`, { cache: 'no-store' }),
  cancelLarkAppCreation: (jobId: string) => json<LarkAppCreationJob>(`/api/lark/apps/create/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' }),
  retryLarkAppCreation: (jobId: string, forceLogin = false) => json<LarkAppCreationJob>(`/api/lark/apps/create/${encodeURIComponent(jobId)}/retry`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ forceLogin }) }),
  inspectLarkBot: (body: { appId: string; appSecret: string }) => json<{ appName: string; openId: string; avatarUrl?: string; activateStatus?: number }>('/api/lark/bot/inspect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  saveLarkConfig: (body: {
    stage: 'lark' | 'agent';
    originalAppId?: string;
    appId?: string;
    appSecret?: string;
    workspace?: string;
    workspaceAliases?: Record<string, string>;
    verificationCommand?: string;
    webBaseUrl?: string;
    webMobileReachable?: boolean;
    defaultAgentId?: string;
    defaultModel?: string;
    defaultReasoningEffort?: string;
    fullTrustConfirmed?: boolean;
    permissionMode?: 'ask' | 'approve-reads' | 'full-trust';
    roleTitle?: string;
    roleScope?: string;
    preInjectPrompt?: string;
    listening?: boolean;
    groupToolsEnabled?: boolean;
    groupToolsAllowSend?: boolean;
    memoryEnabled?: boolean;
    memoryAutoExtract?: boolean;
    groupMemoryScope?: 'shared' | 'per-group';
    memoryAgentId?: string;
    memoryModel?: string;
    decisionAgentId?: string;
    decisionModel?: string;
    busyTriage?: boolean;
    responseAgentId?: string;
    responseModel?: string;
    executionMode?: 'single' | 'layered';
    leaderAgentId?: string;
    workerAgentIds?: string[];
    structuredAskCards?: boolean;
    groupCardMention?: boolean;
    completionReactionOnly?: boolean;
    silentProgress?: boolean;
    adhdMode?: boolean;
    urgentEnabled?: boolean;
    /** null = 清回模块默认（前端清空输入框就送 null）；undefined = 不改这一项。 */
    urgentThresholdMs?: number | null;
    urgentMaxPerHourPerChat?: number | null;
    notifyMentionAction?: boolean;
    notifyMentionDone?: boolean;
    /** 空串 = 关闭免打扰时段；undefined = 不改这一项。 */
    notifyQuietHours?: string;
    pinLongTasks?: boolean;
    pinAfterMs?: number | null;
    pushIntervalMs?: number;
    traceLimit?: number | null;
    /** 精简过程卡；缺省继承当前配置，旧服务端按开启处理。 */
    compactTrace?: boolean;
    showAgentName?: boolean;
    allowedUsers?: LarkAllowedUser[];
    allowedUserNames?: string[];
    allowedEmails?: string[];
    allowedBots?: LarkAllowedUser[];
    allowedBotNames?: string[];
    peerBotsAllowed?: boolean;
    highRiskAllowedUsers?: LarkAllowedUser[];
    highRiskAllowedUserNames?: string[];
    highRiskAllowedEmails?: string[];
    highRiskPattern?: string;
    riskControlMode?: RiskControlMode;
    expectedRevision?: number;
    p2pMode?: 'chat' | 'thread';
    idleCompactEnabled?: boolean;
    idleCompactHours?: number;
    groupReplyMode?: 'chat' | 'shared' | 'new-topic' | 'chat-topic' | null;
    mentionPolicy?: 'always' | 'topic' | 'never' | 'ambient';
    defaultGroupParticipation?: 'off' | 'observe' | 'selective' | 'eager';
  }) => json<LarkConfig>('/api/lark/config', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  deleteLarkConfig: (appId: string) => json<LarkConfig>(`/api/lark/config/${encodeURIComponent(appId)}`, { method: 'DELETE' }),
  managementGroups: () => json<{ groups: ManagedGroup[] }>('/api/lark/management/groups', { cache: 'no-store' }),
  syncGroups: (appId: string) => json<{ groups: ManagedGroup[]; error?: string }>(`/api/lark/bots/${encodeURIComponent(appId)}/sync-groups`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) }),
  updateGroupBotBinding: (appId: string, chatId: string, body: { expectedRevision: number; patch: Partial<Pick<GroupBinding, 'agentOverride' | 'workspaceOverride' | 'modelOverride' | 'reasoningOverride' | 'routingOverride' | 'accessOverride' | 'groupToolsOverride' | 'presentationOverride' | 'oncall' | 'state'>>; roleChanges?: RoleChange[] }) => json<ManagedGroupBot>(`/api/lark/bots/${encodeURIComponent(appId)}/groups/${encodeURIComponent(chatId)}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  groupMembers: (appId: string, chatId: string, pageToken?: string) => json<GroupMembersResult>(`/api/lark/bots/${encodeURIComponent(appId)}/groups/${encodeURIComponent(chatId)}/members${pageToken ? `?pageToken=${encodeURIComponent(pageToken)}` : ''}`, { cache: 'no-store' }),
  systemDirectories: (path?: string) => json<SystemDirectoriesResult>(`/api/system/directories${path ? `?path=${encodeURIComponent(path)}` : ''}`, { cache: 'no-store' }),
  larkHookStatus: (appId: string, agentId?: string) => {
    const query = new URLSearchParams({ appId });
    if (agentId) query.set('agentId', agentId);
    return json<LarkHookStatus>(`/api/lark/hooks/status?${query.toString()}`);
  },
  larkMemoryStatus: (appId: string) => json<LarkMemoryStatusResult>(`/api/lark/bots/${encodeURIComponent(appId)}/memory/status`, { cache: 'no-store' }),
  unknownTasks: (sessionId: string) => json<UnknownTask[]>(`/api/sessions/${encodeURIComponent(sessionId)}/unknown-tasks`, { cache: 'no-store' }),
  resolveUnknownTask: (sessionId: string, taskId: string, input: { target: string; action: UnknownTaskAction; allowDuplicateEffects?: true }) => json<{ replayed: boolean; status: string; decisionId: string }>(`/api/sessions/${encodeURIComponent(sessionId)}/unknown-tasks/${encodeURIComponent(taskId)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }),
  sessionMemory: (sessionId: string) => json<{ turns: LarkTurnMemory[] }>(`/api/sessions/${encodeURIComponent(sessionId)}/memory`, { cache: 'no-store' }),
  forgetSessionMemory: (sessionId: string, taskId: string, memoryId: string) => json<{ removed: { id: string } }>(`/api/sessions/${encodeURIComponent(sessionId)}/memory/${encodeURIComponent(taskId)}/entries/${encodeURIComponent(memoryId)}`, { method: 'DELETE' }),
  installLarkHook: (appId: string, highRiskPattern: string, expectedRevision?: number) => json<LarkHookStatus & { configRevision?: number }>('/api/lark/hooks/install', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ appId, highRiskPattern, expectedRevision }) }),
  systemCapabilities: () => json<{ platform: string; directoryPicker: boolean; filePicker: boolean }>('/api/system/capabilities'),
  skills: (cwd?: string) => json<SkillReference[]>(`/api/system/skills${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''}`),
  /** 已启用插件提供的斜杠命令；没有插件时服务端不注册这个接口，按空列表处理。 */
  pluginCommands: async (cwd?: string) => {
    try { return (await json<{ commands: Array<{ name: string; description: string }> }>(`/api/plugins/commands${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''}`)).commands; }
    catch { return []; }
  },
  selectDirectory: () => json<{ path: string }>('/api/system/select-directory', { method: 'POST' }),
  selectFile: () => json<{ path: string }>('/api/system/select-file', { method: 'POST' }),
  archive: (id: string) => json<Session>(`/api/sessions/${id}/archive`, { method: 'POST' }),
  workspaceGroups: () => json<WorkspaceOrganizationSnapshot>('/api/workspace-groups'),
  createWorkspaceGroup: (name: string) => json<WorkspaceOrganizationSnapshot>('/api/workspace-groups', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) }),
  renameWorkspaceGroup: (id: string, name: string) => json<WorkspaceOrganizationSnapshot>(`/api/workspace-groups/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) }),
  deleteWorkspaceGroup: (id: string) => json<WorkspaceOrganizationSnapshot>(`/api/workspace-groups/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  assignWorkspaceGroups: (input: { groupId: string | null; sessionIds?: string[]; directories?: string[] }) => json<WorkspaceOrganizationSnapshot>('/api/workspace-groups/assignments', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }),
  restart: (id: string) => json<Session>(`/api/sessions/${id}/restart`, { method: 'POST' }),
  action: (id: string, action: string) => json(`/api/sessions/${id}/${action}`, { method: 'POST' }),
  permission: (id: string, permissionId: string, approved: boolean) => json(`/api/sessions/${id}/permissions/${permissionId}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ approved }) })
};

export const foundationApi = {
  capabilities: () => json<FoundationCapability>('/api/foundation/capabilities', { cache: 'no-store' }),
  secretRefs: () => json<{ secretRefs: PublicSecretRef[] }>('/api/foundation/secret-refs', { cache: 'no-store' }),
  groupMatrix: () => json<GroupMatrix>('/api/foundation/group-matrix', { cache: 'no-store' }),
  createChannelBot: (input: { id: string; externalAppId: string; displayName: string; brand: 'feishu' | 'lark' }) => json<PublicChannelBotFoundation>('/api/foundation/channel-bots', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }),
  updateChannelBot: (id: string, input: UpdateChannelBotInput) => json<PublicChannelBotFoundation>(`/api/foundation/channel-bots/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }),
  createGroupBinding: (input: CreateGroupBindingInput) => json<GroupBinding>('/api/foundation/group-bindings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }),
  updateGroupBinding: (id: string, input: UpdateGroupBindingInput) => json<GroupBinding>(`/api/foundation/group-bindings/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })
};

export const scheduleApi = {
  capabilities: () => json<ScheduleCapability>('/api/foundation/schedules/capabilities', { cache: 'no-store' }),
  list: () => json<ScheduleList>('/api/foundation/schedules', { cache: 'no-store' }),
  preview: (id: string, after?: string) => json<{ scheduleId: string; preview?: SchedulePreview; executionEligible: false; blockers: ScheduleBlocker[] }>(`/api/foundation/schedules/${encodeURIComponent(id)}/preview${after ? `?after=${encodeURIComponent(after)}` : ''}`, { cache: 'no-store' }),
  update: (id: string, input: UpdateScheduleDefinitionInput) => json<ScheduleDetail>(`/api/foundation/schedules/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }),
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
    json<{ settings: CollaborationSettings }>(
      `/api/lark/groups/${encodeURIComponent(appId)}/${encodeURIComponent(chatId)}/collaboration/settings`,
      { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    ),
  updateDuty: (appId: string, chatId: string, body: UpdateCollaborationDutyInput) =>
    json<{ duty: CollaborationDuty; announced?: boolean }>(
      `/api/lark/groups/${encodeURIComponent(appId)}/${encodeURIComponent(chatId)}/collaboration/duty`,
      { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    ),
  createFollowup: (appId: string, chatId: string, body: CreateCollaborationFollowupInput) =>
    json<{ followup: CollaborationFollowup }>(
      `/api/lark/groups/${encodeURIComponent(appId)}/${encodeURIComponent(chatId)}/collaboration/followups`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    ),
  updateFollowup: (appId: string, chatId: string, id: string, body: UpdateCollaborationFollowupInput) =>
    json<{ followup: CollaborationFollowup }>(
      `/api/lark/groups/${encodeURIComponent(appId)}/${encodeURIComponent(chatId)}/collaboration/followups/${encodeURIComponent(id)}`,
      { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    ),
  createMandate: (appId: string, chatId: string, body: CreateCollaborationMandateInput) =>
    json<{ mandate: CollaborationMandate; schedule?: PublicScheduleDefinition }>(
      `/api/lark/groups/${encodeURIComponent(appId)}/${encodeURIComponent(chatId)}/collaboration/mandates`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    ),
  updateMandate: (appId: string, chatId: string, id: string, body: UpdateCollaborationMandateInput) =>
    json<{ mandate: CollaborationMandate; schedule?: PublicScheduleDefinition }>(
      `/api/lark/groups/${encodeURIComponent(appId)}/${encodeURIComponent(chatId)}/collaboration/mandates/${encodeURIComponent(id)}`,
      { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    ),
  addFeedback: (appId: string, chatId: string, decisionId: string, body: CreateCollaborationFeedbackInput) =>
    json<{ feedback: CollaborationFeedback }>(
      `/api/lark/groups/${encodeURIComponent(appId)}/${encodeURIComponent(chatId)}/collaboration/decisions/${encodeURIComponent(decisionId)}/feedback`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    ),
  replay: (appId: string, chatId: string, body: CollaborationReplayInput) =>
    json<CollaborationReplayResponse>(
      `/api/lark/groups/${encodeURIComponent(appId)}/${encodeURIComponent(chatId)}/collaboration/replay`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    ),
  bootstrap: (appId: string, chatId: string) =>
    json<{ bootstrap: CollaborationBootstrap }>(
      `/api/lark/groups/${encodeURIComponent(appId)}/${encodeURIComponent(chatId)}/collaboration/bootstrap`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) }
    )
};

export const terminalSettingsApi = {
  get: () => json<{ terminalBackend: 'tmux' | 'herdr'; scope: 'pty-cli' }>('/api/settings/terminal', { cache: 'no-store' }),
  set: (terminalBackend: 'tmux' | 'herdr') => json<{ terminalBackend: 'tmux' | 'herdr'; scope: 'pty-cli' }>('/api/settings/terminal', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ terminalBackend }) }),
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
    json<SessionInsightRefreshResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/insight/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    }),
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
const modelSettingsUrl = (id: string, appId?: string) => `${botAgentPath(id, appId)}/model-settings`;
export const agentModelSettingsApi = {
  get: (id: string, appId?: string) => json<AgentModelSettings>(modelSettingsUrl(id, appId), { cache: 'no-store' }),
  set: (id: string, body: AgentModelSettingsPatch, appId?: string) => json<AgentModelSettings>(modelSettingsUrl(id, appId), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
};
