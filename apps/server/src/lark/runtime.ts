import type { AgentConfig, AgentEvent, ExecutionActor, ExecutionRecoveryDecision, PermissionMode, PermissionRequestData, Session, TaskRecord, ToolRiskPolicy, UnknownTaskFacts, UnknownTaskResolution, VerificationCommandInput, VerificationResponse, WorkspaceResponse } from '@dutydeck/shared';

export interface LarkSessionControl {
  trackMatterSession?(sessionId: string, input: import('@dutydeck/shared').MatterSessionInput): Promise<void>;
  start(input: { nativeForkSessionId?: string; agentId: string; cwd?: string; model?: string; reasoningEffort?: string; permissionMode?: PermissionMode; workspaceMode?: 'shared' | 'worktree'; source?: string; sourceId?: string }): Promise<Session>;
  resume?(id: string): Promise<Session>;
  /** 空闲时切换会话的模型 / 思考强度 / 名称；与 Web 的 PATCH /api/sessions/:id/config、/name 调同一组方法。 */
  setModel?(id: string, model: string): Promise<Session>;
  setReasoningEffort?(id: string, reasoningEffort: string): Promise<Session>;
  setSessionName?(id: string, name: string | null): Promise<Session>;
  stop?(id: string, actor?: ExecutionActor): Promise<unknown>;
}

export interface LarkExecution {
  send(id: string, prompt: string, agentPrompt?: string, riskPolicy?: ToolRiskPolicy, actorId?: string): Promise<unknown>;
  dispatch?(id: string, prompt: string, mode?: 'queue' | 'interrupt', agentPrompt?: string, riskPolicy?: ToolRiskPolicy, actorId?: string, idempotencyKey?: string, skillRequests?: string[], supplied?: import('@dutydeck/shared').TaskRequestV1, idleCompactHours?: number, promptParts?: import('@dutydeck/shared').PromptPart[], permissionMode?: PermissionMode): Promise<{ id: string; status: string; queuedAhead?: number; replayed?: boolean }>;
  dispatchRequest?: import('@dutydeck/runtime').DutydeckRuntime['dispatchRequest'];
  interrupt(id: string, expectedTaskId?: string, actor?: string): Promise<unknown>;
  cancelQueued?(id: string, taskId: string, actorId?: string): Promise<unknown>;
  /** 把排队中的一轮提到队首（会中断当前正在执行的那一轮）。/queue top 与 /steer 的唯一原语。 */
  steerQueued?(id: string, taskId: string, actorId?: string): Promise<unknown>;
  /** ACP 插话结果包含持久任务状态；reconcile_required 表示投递未知，不能自动重发。 */
  injectQueued?(id: string, taskId: string, actorId?: string, operationId?: string, expectedTarget?: { taskId: string; attemptId?: string }): Promise<{ task: TaskRecord; outcome: string; error?: string; target?: { taskId: string; attemptId: string } }>;
  runVerification?(id: string, input: VerificationCommandInput, actorId?: string): Promise<VerificationResponse>;
  subscribe(sessionId: string, listener: (event: AgentEvent) => void): () => void;
  /** 往会话时间线写一条说明（Web 上能看到），不属于任何一轮的执行输出。 */
  publishSessionEvent?(sessionId: string, type: 'text', data: unknown): Promise<unknown>;
}

export interface LarkPermissionControl {
  getPendingPermissions?(id: string): PermissionRequestData[] | Promise<PermissionRequestData[]>;
  resolvePermission?(id: string, requestId: string, approved: boolean, reason?: string, annotation?: Pick<PermissionRequestData, 'workspaceRule'>): Promise<unknown>;
  getLatestPermissionRequest?(id: string, taskId: string, nativeId: string): Promise<AgentEvent | undefined>;
}

export interface LarkRecovery {
  getTaskRecovery?(id: string, taskId: string): Promise<{ status: string; blockers: Array<{ code: string; external?: boolean }>; activeTaskId?: string; resolvedUnknown?: boolean; verifiedOutput?: { eventId: string; digest: string } }>;
  /**
   * 安装者身份的执行恢复读写，与 `dutydeck recovery` 同一组原语。服务重启切断的一轮自动重投时用：
   * 读原因码、阻塞与资源核对，把旧一轮记为结果未知。
   */
  inspectExecutionRecovery?(id: string, actor: ExecutionActor): Promise<{
    runId: string; blockers: unknown[]; stopBlock: unknown; resourceChecks: ExecutionRecoveryDecision['resourceChecks'];
    tasks: Array<{ taskId: string; attempt?: { attemptId: string; revision: number; state: string; reconcileReason?: { code: string }; createdAt?: string } }>;
  }>;
  confirmExecutionRecovery?(id: string, decision: ExecutionRecoveryDecision, actor: ExecutionActor): Promise<unknown>;
  /** 结果未知任务的已知事实与人工处理（提醒卡上的「重新执行」「标为已完成」「标为失败」）。 */
  inspectUnknownTask?(id: string, taskId: string, target?: string): Promise<UnknownTaskFacts>;
  resolveUnknownTask?(id: string, input: UnknownTaskResolution, actor: ExecutionActor): Promise<{ replayed: boolean; stoppedOriginal?: true; task: TaskRecord }>;
}

export interface LarkQueries {
  getMatter?(sessionId: string): import('@dutydeck/shared').MatterSummary | undefined;
  listAgents?(): Promise<Array<Pick<AgentConfig, 'id' | 'name'> & Partial<AgentConfig>>>;
  listSessions?(): Promise<Session[]>;
  getSession(id: string): Promise<Session | undefined>;
  getAcceptedTaskByKey: import('@dutydeck/runtime').DutydeckRuntime['getAcceptedTaskByKey'];
  getAcceptedTask?: import('@dutydeck/runtime').DutydeckRuntime['getAcceptedTask'];
  getSessionTaskReport?(id: string): Promise<import('@dutydeck/shared').TaskReport | undefined>;
  getTasks?(id: string): Promise<TaskRecord[]>;
  getInboxTasks?(id: string): Promise<Array<Pick<TaskRecord, 'id' | 'sessionId' | 'prompt' | 'status' | 'createdAt' | 'updatedAt'>>>;
  getEvents?(id: string, afterSequence?: number): Promise<AgentEvent[]>;
  /** 某一次执行（attempt）的事件数与活动时间，按 attempt 索引读，不读整段会话历史。 */
  getAttemptActivity?(id: string, attemptId: string): Promise<import('@dutydeck/shared').AttemptActivity>;
  /** 某一次执行（attempt）的工具调用与结果事件，按 attempt 索引读。 */
  getAttemptToolEvents?(id: string, attemptId: string): Promise<AgentEvent[]>;
  getDeferredConfirmationId?(id: string, taskId: string): Promise<string | undefined>;
  getRecentEvents?(id: string, limit: number): Promise<AgentEvent[]>;
  /** 平台验证记录，最新在前，含代码指纹与 stale 判定。 */
  getVerifications?(id: string): Promise<VerificationResponse[]>;
  /** 会话工作区记录；worktree 的基准 commit 用来判断本轮有没有改代码、推断验证命令。 */
  getWorkspace?(id: string): Promise<WorkspaceResponse | undefined>;
  /** 会话目录当前的代码指纹，与验证记录同一套算法；共享目录在轮次前后各取一次，判断这一轮有没有改代码。 */
  getCodeFingerprint?(id: string): Promise<string>;
  /** 服务升级排空中：新任务照常入队，但暂不开始执行。 */
  isQueueHeld?(): boolean;
  /** 当前一轮可能卡住的依据（后面有人排队、长时间没有输出、进程不占 CPU），只用来在卡上提示。 */
  getTurnStall?(id: string): Promise<{ taskId: string; silentMs: number; queued: number; cpu: 'inactive' | 'unknown' } | undefined>;
}

export type LarkRuntimeReliability = {
  getAgentAvailability?(agentId: string): { reason: string; remedy: string; at: string } | undefined;
  checkAgentAvailability?(agentId: string, options?: { force?: boolean }): Promise<{ reason: string; remedy: string; at: string } | undefined>;
  inspectAgentQuiescence?(sessionId: string): 'idle' | 'busy' | 'unknown';
  settleIdleAttempt?(sessionId: string, input: { taskId: string; decisionId: string; outcome: 'unknown' | 'interrupted' | 'failed'; evidenceRefs: string[] },
    actor: { kind: 'installation_owner'; id: 'installation_owner' }): Promise<unknown>;
};

export interface LarkRuntime extends LarkSessionControl, LarkExecution, LarkPermissionControl, LarkRecovery, LarkQueries, LarkRuntimeReliability {}
