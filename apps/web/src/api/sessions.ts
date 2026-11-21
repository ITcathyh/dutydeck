import type {
  ArtifactSnapshot,
  ArtifactSnapshotPreview,
  ArtifactSnapshotReference,
  HistoryOutline,
  HistoryOutlineQuery,
  HistoryTurnSummary,
  PermissionMode,
  PlanState,
  RunSummary as SharedRunSummary,
  Session as SharedSession,
  SessionSourceContext,
  SkillDeliveryMetadata,
  TaskAuthorization,
  TurnDiffFile,
  TurnDiffSummary,
  TurnDiffResponse,
  TurnDiffCommentInput,
  UnknownTaskAction,
  UnknownTaskFacts,
  VerificationCommandInput,
  VerificationResponse,
  WorkspaceCleanupPreview,
  WorkspaceCleanupResult,
  WorkspaceMode,
  WorkspaceResponse
} from '@dutydeck/shared';
import { withShareToken, ApiError, json, send } from './client';
import { instanceApiUrl } from '../instance';

export type SessionCapabilities = { observedAt: string; protocol?: string; structuredApproval: string; terminal: string; turnRecovery: string; verification: string; localFileDelivery: string };

export type MatterDetail = { id: string; title: string; status: 'open' | 'done' | 'cancelled'; sessions: Session[]; schedules: Array<{ id: string; name: string; enabled: boolean }>; originUrl?: string };
export type Session = Omit<SharedSession, 'state'> & { state: string; matter?: import('@dutydeck/shared').MatterSummary; sourceContext?: SessionSourceContext };
export type DockEvent = { taskId?: string; attemptId?: string; id: string; sequence: number; type: string; timestamp: string; data: any; raw?: string };
export type Task = { canEditQueued?: false; skillDeliveries?: SkillDeliveryMetadata[]; id: string; sessionId: string; prompt: string; status: string; createdAt: string; updatedAt: string };
/** 结果未知、现在可以由人处理的一轮：已知事实与三行摘要（服务端生成，与飞书提醒卡同一份文字）。 */
export type UnknownTask = UnknownTaskFacts & { target: string; prompt: string; factLines: string[] };
/** 插话结果：injected / startedNewTurn 已送达；moved 表示状态已变化；failed 是否需要核对以 task.status 为准，reconcile_required 不自动重发。 */
export type SteeringOutcome = 'injected' | 'startedNewTurn' | 'moved' | 'promptRequired' | 'unsupported' | 'incompatible' | 'failed';

export type PlanAction = 'approve' | 'revise' | 'cancel';
export type SteeringResult = { outcome: SteeringOutcome; error?: string };
export type RunSummary = SharedRunSummary & { taskReport?: import('@dutydeck/shared').TaskReport; /** 最近一次上下文用量；服务端只在已有用量事件时附带。 */ context?: import('@dutydeck/shared').ContextUsage };
export type EventWindowQuery = { before?: number; after?: number; limit?: number; direction?: 'backward' | 'forward' };

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

export const sessionRequests = {
  sessionCapabilities: (id: string) => json<SessionCapabilities>(`/api/sessions/${id}/capabilities`),
  workspace: (id: string) => json<WorkspaceResponse | null>(`/api/sessions/${id}/workspace`),
  workspaceCleanupPreview: (id: string) => json<WorkspaceCleanupPreview>(`/api/sessions/${encodeURIComponent(id)}/workspace/cleanup`, { cache: 'no-store' }),
  cleanWorkspace: (id: string, fingerprint: string) => send<WorkspaceCleanupResult>('POST', `/api/sessions/${encodeURIComponent(id)}/workspace/cleanup`, { fingerprint }),
  verifications: (id: string) => json<VerificationResponse[]>(`/api/sessions/${id}/verifications`),
  turnDiffs: (id: string) => json<Array<{ taskId: string; summary: TurnDiffSummary; finishedAt?: string }>>(`/api/sessions/${id}/diffs`),
  turnDiff: (id: string, taskId: string) => json<TurnDiffResponse>(`/api/sessions/${id}/tasks/${taskId}/diff`),
  /** 折叠的锁文件、生成物按需读正文。 */
  turnDiffFile: (id: string, taskId: string, path: string) => json<TurnDiffFile>(`/api/sessions/${id}/tasks/${taskId}/diff/file?path=${encodeURIComponent(path)}`),
  submitTurnDiffComments: (id: string, taskId: string, comments: TurnDiffCommentInput[]) => send<{ delivery: 'dispatched' | 'lark_confirmation' }>('POST', `/api/sessions/${id}/tasks/${taskId}/diff/comments`, { comments }),
  verify: (id: string, input: VerificationCommandInput) => send<VerificationResponse>('POST', `/api/sessions/${id}/verifications`, input),
  sessionHistory: (id: string, signal?: AbortSignal, query?: HistoryOutlineQuery) => json<HistoryOutline>(`/api/sessions/${encodeURIComponent(id)}/history${query?.tail ? `?tail=${query.tail}` : ''}`, { signal }),
  sessionHistoryTurns: (id: string, from: number, through: number, signal?: AbortSignal) => json<{ turns: HistoryTurnSummary[] }>(`/api/sessions/${encodeURIComponent(id)}/history/turns?from=${from}&through=${through}`, { signal }),
  sessions: (signal?: AbortSignal) => json<Session[]>('/api/sessions', { signal }),
  session: (id: string) => json<Session>(`/api/sessions/${encodeURIComponent(id)}`),
  events: (id: string, query?: EventWindowQuery, signal?: AbortSignal) => json<DockEvent[]>(eventsUrl(id, query), { signal }),
  tasks: (id: string) => json<Task[]>(`/api/sessions/${id}/tasks`),
  // 跨任务标题的最小只读契约；服务端接入前 UI 仅使用当前已加载 tasks 的真实 prompt，不伪造摘要。
  matter: (id: string) => json<MatterDetail>(`/api/matters/${encodeURIComponent(id)}`),
  runSummaries: () => json<RunSummary[]>(RUN_SUMMARY_ENDPOINT),
  create: (body: { agentId: string; cwd?: string; model?: string; codexProfile?: string; reasoningEffort?: string; permissionMode?: PermissionMode; workspaceMode?: WorkspaceMode }) => send<Session>('POST', '/api/sessions', {
    ...body, ...(body.workspaceMode === 'worktree' ? { fallbackToShared: true } : {})
  }),
  /** 先出计划：Agent 只调研出计划（写操作被拦），批准后才执行。 */
  plan: (id: string, prompt: string) => send<{ accepted: true; task: Task; steering?: undefined }>('POST', `/api/sessions/${id}/plan`, { prompt }),
  planState: (id: string) => json<PlanState>(`/api/sessions/${id}/plan`, { cache: 'no-store' }),
  decidePlan: (id: string, taskId: string, action: PlanAction, feedback?: string) => send<{ state: PlanState['state']; task?: Task }>('POST', `/api/sessions/${id}/plan/${taskId}`, { action, ...(feedback ? { feedback } : {}) }),
  send: (id: string, prompt: string, mode: 'queue' | 'interrupt' | 'steer' = 'queue', skillRequests?: string[], idempotencyKey?: string) => send<{ accepted: true; task: Task; steering?: SteeringResult }>('POST', `/api/sessions/${id}/send`, { prompt, mode, ...(skillRequests?.length ? { skillRequests } : {}), ...(idempotencyKey !== undefined ? { idempotencyKey } : {}) }),
  setSessionModel: (id: string, model: string) => send<Session>('PATCH', `/api/sessions/${id}/config`, { model }),
  setSessionReasoningEffort: (id: string, reasoningEffort: string) => send<Session>('PATCH', `/api/sessions/${id}/config`, { reasoningEffort }),
  setSessionName: (id: string, name: string | null) => send<Session>('PATCH', `/api/sessions/${encodeURIComponent(id)}/name`, { name }),
  cancelQueued: (id: string, taskId: string, operationId: string) => json<Task & { skillRequests?: string[] }>(`/api/sessions/${id}/queue/${taskId}`, { method: 'DELETE', headers: { 'x-dutydeck-operation-id': operationId } }),
  steerQueued: (id: string, taskId: string) => json<Task>(`/api/sessions/${id}/queue/${taskId}/steer`, { method: 'POST' }),
  injectQueued: (id: string, taskId: string) => json<SteeringResult & { task: Task }>(`/api/sessions/${id}/queue/${taskId}/inject`, { method: 'POST' }),
  taskAuthorizations: (sessionId: string) => json<TaskAuthorization[]>(`/api/sessions/${encodeURIComponent(sessionId)}/task-authorizations`),
  unknownTasks: (sessionId: string) => json<UnknownTask[]>(`/api/sessions/${encodeURIComponent(sessionId)}/unknown-tasks`, { cache: 'no-store' }),
  resolveUnknownTask: (sessionId: string, taskId: string, input: { target: string; action: UnknownTaskAction; allowDuplicateEffects?: true }) => send<{ replayed: boolean; status: string; decisionId: string; stoppedOriginal?: true }>('POST', `/api/sessions/${encodeURIComponent(sessionId)}/unknown-tasks/${encodeURIComponent(taskId)}`, input),
  archive: (id: string) => json<Session>(`/api/sessions/${id}/archive`, { method: 'POST' }),
  restart: (id: string) => json<Session>(`/api/sessions/${id}/restart`, { method: 'POST' }),
  action: (id: string, action: string) => json(`/api/sessions/${id}/${action}`, { method: 'POST' }),
  permission: (id: string, permissionId: string, approved: boolean, reason?: string) => send('POST', `/api/sessions/${id}/permissions/${permissionId}`, reason ? { approved, reason } : { approved }),
};
