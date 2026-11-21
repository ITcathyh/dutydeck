import type { AsyncLocalStorage } from 'node:async_hooks';
import { RuntimeError, agentCommandApprovalReason, errorMessage, freeTextInputMaxBytes, isAgentCommandAutoApproval, makeId, permissionDisplayText, type AgentDriver, type AgentEvent, type AttemptRef, type NormalizedDriverEvent, type PermissionRequestData, type RepositoryBundle, type Session, type SessionFence, type TaskRecord } from '@dutydeck/shared';
import { testRegexWithTimeout } from '@dutydeck/acp-client';
import type { RuntimeOptions } from '../index.js';
import { RevokedOperation, type RuntimeSessionMutations } from '../ownership.js';
import { isAttemptRef } from './attempt-ref.js';

/** 轮次结束时执行端已自行拒掉、却没发终态事件的审批，补记的拒绝说明。 */
const TURN_ENDED_PERMISSION_REASON = '本轮任务已结束，这次操作没有执行。';
export type PendingPermission = { request: PermissionRequestData; nativeId: string; fence: AttemptRef & SessionFence; generation: number };

interface HumanWaitDependencies {
  repos: Pick<RepositoryBundle, 'sessions' | 'execution' | 'events'>;
  options: Pick<RuntimeOptions, 'log' | 'awaitingAnswer' | 'reviewPermission' | 'sessionEnvironment' | 'resolveRiskPolicy'>;
  drivers: ReadonlyMap<string, AgentDriver>;
  activeTasks: ReadonlyMap<string, TaskRecord>;
  sessionGenerations: ReadonlyMap<string, number>;
  eventScope: AsyncLocalStorage<SessionFence>;
  shuttingDown(): boolean;
  driverEventData(scope: SessionFence, event: NormalizedDriverEvent): NormalizedDriverEvent['data'];
  savePermission: RepositoryBundle['artifacts']['savePermission'];
  emit(id: string, type: 'permission_request', data: PermissionRequestData): Promise<AgentEvent>;
  saveState(session: Session, state: Session['state']): Promise<void>;
  consume(session: Session, event: NormalizedDriverEvent, eventId: string): Promise<void>;
  warnCaught(location: string, sessionId: string, error: unknown): void;
  active(id: string): Promise<{ driver?: AgentDriver }>;
  driverOperation<T>(driver: AgentDriver, operation: () => Promise<T>): Promise<T>;
  touch(id: string): void;
}

export class HumanWaits {
  private readonly oscPermissionWaits = new Set<string>();
  private readonly permissions = new Map<string, PendingPermission>();
  private readonly permissionResolutions = new Map<string, string>();
  private readonly permissionHandledBy = new Map<string, string>();
  /** 正在提交的拒绝说明（已脱敏）；驱动在裁决时同步发出的终态事件据此补上 reason。 */
  private readonly permissionRejectReasons = new Map<string, string>();

  constructor(private readonly mutations: RuntimeSessionMutations, private readonly deps: HumanWaitDependencies) {}

  private permissionKey(sessionId: string, permissionId: string) { return `${sessionId}:${permissionId}`; }

  getDeferredConfirmationId(id: string, taskId: string) { return this.deps.repos.events.getDeferredConfirmationId(id, taskId); }
  hasPermissionRequest(id: string, nativeId: string) { return this.deps.repos.events.hasPermissionRequest(id, nativeId); }
  getLatestPermissionRequest(id: string, taskId: string, nativeId: string) { return this.deps.repos.events.getLatestPermissionRequest(id, taskId, nativeId); }

  awaitingAnswer(id: string) { return !!this.deps.options.awaitingAnswer?.(id); }
  oscWaiting(attemptId: string) { return this.oscPermissionWaits.has(attemptId); }
  clearOscWait(attemptId: string) { this.oscPermissionWaits.delete(attemptId); }

  register(fence: SessionFence & AttemptRef, request: PermissionRequestData, nativeId: string) {
    const entry = { request, nativeId, fence, generation: this.deps.sessionGenerations.get(fence.sessionId) ?? 0 };
    this.mutations.capture(entry);
    this.permissions.set(this.permissionKey(fence.sessionId, request.id), entry);
    return entry;
  }
  annotate(sessionId: string, data: PermissionRequestData) {
    if (['approved', 'rejected'].includes(data.status)) {
      const handledBy = this.permissionHandledBy.get(this.permissionKey(sessionId, data.id));
      if (handledBy) data = { ...data, handledBy };
    }
    const rejectReason = data.status === 'rejected' && !data.reason ? this.permissionRejectReasons.get(this.permissionKey(sessionId, data.id)) : undefined;
    if (rejectReason) data = { ...data, reason: rejectReason };
    return data;
  }
  applyHostDecision(session: Session, scope: SessionFence & AttemptRef, event: NormalizedDriverEvent, data: PermissionRequestData, eventId: string, hostDecision: 'allow' | 'deny') {
    // 不发待审批事件（没有人工审批卡片）；登记后走与人工审批相同的 resolvePermission，由它写入最终的审批记录。
    const key = this.permissionKey(session.id, data.id);
    const entry = this.register(scope, data, String(event.data.id));
    setImmediate(() => void this.resolvePermission(session.id, data.id, hostDecision === 'allow').catch(async error => {
      this.deps.options.log?.warn({ sessionId: session.id, permissionId: data.id, error }, 'Host permission decision could not be applied; asking a person');
      // 宿主的决定没落地而原生审批还挂着：照常发待审批事件交给人处理，不能悄悄等到超时。
      await this.mutations.runCaptured(entry, () => this.deps.eventScope.run(scope, () => this.mutations.write(session.id, async () => {
        if (this.permissions.get(key) !== entry || this.permissionResolutions.has(key) || entry.generation !== (this.deps.sessionGenerations.get(session.id) ?? 0)) return;
        await this.deps.consume(session, event, eventId);
      })));
    }).catch(error => { if (!(error instanceof RevokedOperation)) this.deps.options.log?.warn({ sessionId: session.id, permissionId: data.id, error }, 'Host permission fallback could not be recorded'); }));
  }
  async recordPermission(session: Session, scope: SessionFence & AttemptRef, nativeId: string, data: PermissionRequestData) {
    const key = this.permissionKey(session.id, data.id);
    if ((data.status ?? 'pending') === 'pending') {
      this.register(scope, data, nativeId);
      await this.deps.saveState(session, 'waiting_for_permission');
    } else { this.permissions.delete(key); this.permissionResolutions.delete(key); }
    await this.deps.savePermission(session.id, data).catch(error => this.deps.warnCaught('consume.savePermission', session.id, error));
  }
  async recordProgramStatus(session: Session, scope: SessionFence & AttemptRef, data: NormalizedDriverEvent['data']) {
    if (data.state === 'program_status' && data.programState === 'blocked' && data.kind === 'permission') {
      this.oscPermissionWaits.add(scope.attemptId);
      await this.deps.saveState(session, 'waiting_for_permission');
    } else {
      const wasWaiting = this.oscPermissionWaits.delete(scope.attemptId);
      if ((wasWaiting || data.programState === 'working') && !this.pendingPermissionCount(session.id)) await this.deps.saveState(session, 'thinking');
    }
  }
  takeSessionPermissions(id: string) {
    const stoppedPermissions: PendingPermission[] = [];
    for (const [key, permission] of this.permissions) if (permission.fence.sessionId === id) {
      this.permissions.delete(key); this.permissionResolutions.delete(key); stoppedPermissions.push(permission);
    }
    return stoppedPermissions;
  }
  async reviewHostPermission(session: Session, scope: SessionFence, event: NormalizedDriverEvent) {
    if (!this.deps.options.reviewPermission || event.type !== 'permission_request' || (event.data?.status ?? 'pending') !== 'pending' || !isAttemptRef(scope)) return undefined;
    const request = this.deps.driverEventData(scope, event) as PermissionRequestData;
    const decision = await this.mutations.wait(() => this.deps.options.reviewPermission!(session, request).catch(() => undefined));
    return decision === 'allow' || decision === 'deny' ? decision : undefined;
  }
  pendingPermissionCount(id: string) { return [...this.permissions.values()].filter(permission => permission.fence.sessionId === id && this.mutations.validCaptured(permission)).length; }
  /**
   * 轮次退出（失败、停止、握手失败）时仍登记着的审批：移出内存并补记终态，否则时间线和 permission_requests 会一直停在 pending。
   * 关机时只删内存：保留的 tmux 任务重启后可能重新识别同一审批。
   */
  async dropAttemptPermissions(attemptId: string) {
    const leftover: PendingPermission[] = [];
    for (const [key, permission] of this.permissions) if (permission.fence.attemptId === attemptId) {
      this.permissions.delete(key); this.permissionResolutions.delete(key); leftover.push(permission);
    }
    if (!this.deps.shuttingDown()) await this.closeLeftoverPermissions(leftover);
  }
  /** 把轮次结束后仍登记着的审批补记为拒绝：事件按 `scope` 的 fence 写入，再落到 permission_requests。 */
  private async recordTurnEndedRejection(permission: PendingPermission, scope: AttemptRef & SessionFence | SessionFence, logMessage: string) {
    const { sessionId } = scope;
    const request = { ...permission.request, status: 'rejected' as const, reason: TURN_ENDED_PERMISSION_REASON };
    await this.deps.eventScope.run(scope, () => this.deps.emit(sessionId, 'permission_request', request)).catch(error =>
      this.deps.options.log?.warn({ sessionId, permissionId: request.id, error }, logMessage));
    await this.deps.savePermission(sessionId, request).catch(error => this.deps.warnCaught('recordTurnEndedRejection.savePermission', sessionId, error));
  }
  /** 轮次已经结算或被撤销，审批事件按会话级 fence 写入；不持有已撤销的轮次令牌，也不能在会话写锁内调用。 */
  async closeLeftoverPermissions(leftover: PendingPermission[]) {
    for (const permission of leftover) {
      const { sessionId, runId } = permission.fence;
      await this.mutations.run(undefined, () =>
        this.recordTurnEndedRejection(permission, { sessionId, runId }, 'Permission left by the ended turn could not be recorded'));
    }
  }
  /**
   * 驱动报告本轮结束后仍登记着的审批已不可能再被采纳（ACP 在中断、停止和轮次收尾时自行 reject_once，不发终态事件）。
   * 补记拒绝，审批卡和时间线才会收起；正在提交的人工决议由 resolvePermission 自己收尾。
   */
  async closeTurnPermissions(ref: AttemptRef & SessionFence) {
    for (const [key, permission] of [...this.permissions]) {
      if (permission.fence.attemptId !== ref.attemptId || this.permissionResolutions.has(key)) continue;
      this.permissions.delete(key);
      await this.recordTurnEndedRejection(permission, permission.fence, 'Permission closed by the ended turn could not be recorded');
    }
  }
  async autoApproveAgentCommand(sessionId: string, kind: string, command: string): Promise<boolean> {
    const owner = this.mutations.owners.attempt(sessionId);
    const task = this.deps.activeTasks.get(sessionId);
    if (this.deps.shuttingDown() || !owner || !task || !this.mutations.valid(owner)) return false;
    const session = await this.deps.repos.sessions.get(sessionId);
    if (!session) return false;
    const accepted = this.deps.repos.execution.getAcceptedTask(task.id);
    if (accepted?.input?.version !== 2) return false;
    const permissionMode = accepted.input.executionOptions.permissionMode;
    if (!isAgentCommandAutoApproval({ permissionMode, kind, command, env: this.deps.options.sessionEnvironment?.(session) })) return false;
    // PreToolUse already guards terminal commands. Recheck the live policy here as well,
    // so auto-approval cannot turn a matching high-risk command into an allow.
    try {
      const policy = this.deps.options.resolveRiskPolicy
        ? await this.deps.options.resolveRiskPolicy(sessionId, task.executionContext?.riskPolicy) : task.executionContext?.riskPolicy;
      if (policy?.enabled && !policy.authorized && await testRegexWithTimeout(policy.pattern, command)) return false;
    } catch { return false; }
    if (this.mutations.owners.attempt(sessionId) !== owner || !this.mutations.valid(owner)) return false;
    this.deps.options.log?.info?.({ sessionId, taskId: task.id }, agentCommandApprovalReason);
    return true;
  }

  /**
   * 终端模式 CLI 的权限 hook 交来的请求：本会话有进行中的轮次、驱动也能接时，登记成与 ACP 相同的待审批项，
   * 返回驱动给出的裁决；否则返回 undefined，调用方保留 CLI 的原生确认。
   */
  requestDriverPermission(sessionId: string, request: Omit<PermissionRequestData, 'id' | 'status'>) {
    if (this.deps.shuttingDown() || !this.mutations.owners.attempt(sessionId) || !this.mutations.valid(this.mutations.owners.lifecycle(sessionId))) return undefined;
    return this.deps.drivers.get(sessionId)?.requestPermission?.(request);
  }

  getPendingPermissions(sessionId: string): PermissionRequestData[] {
    if (!this.mutations.valid(this.mutations.owners.lifecycle(sessionId)) || !this.deps.drivers.get(sessionId)?.resolvePermission) return [];
    return [...this.permissions.entries()].filter(([key, pending]) => key.startsWith(sessionId + ':') && this.mutations.validCaptured(pending) && !this.permissionResolutions.has(key)).map(([, value]) => ({ ...value.request }));
  }

  /** annotation.workspaceRule：按工作区规则代为批准时命中的规则，写进最终的审批记录。 */
  async resolvePermission(sessionId: string, permissionId: string, approved: boolean, reason?: string, annotation?: Pick<PermissionRequestData, 'workspaceRule' | 'handledBy'>) {
    return this.mutations.scoped(sessionId, async () => {
    const { driver } = await this.deps.active(sessionId);
    const key = this.permissionKey(sessionId, permissionId);
    const pending = this.permissions.get(key);
    if (!pending) throw new RuntimeError('PERMISSION_NOT_FOUND', 'Permission request is no longer active', 404);
    if (this.permissionResolutions.has(key)) throw new RuntimeError('PERMISSION_RESOLVING', 'Permission decision is already being submitted', 409);
    if (!driver?.resolvePermission) throw new RuntimeError('PERMISSION_EXPIRED', 'The original approval driver is unavailable', 409);
    const claim = makeId('permission_claim'); this.permissionResolutions.set(key, claim);
    try {
      if (!this.mutations.validCaptured(pending) || pending.generation !== (this.deps.sessionGenerations.get(sessionId) ?? 0) || this.permissions.get(key) !== pending) {
        if (this.permissions.get(key) === pending) this.permissions.delete(key);
        throw new RuntimeError('PERMISSION_EXPIRED', 'Permission request is no longer active', 409);
      }
      // 记录里的说明脱敏后保存；交给执行端的仍是用户原文。
      const shownReason = !approved && reason ? permissionDisplayText(reason, [], freeTextInputMaxBytes) : '';
      if (annotation?.handledBy) this.permissionHandledBy.set(key, annotation.handledBy);
      const request = { ...pending.request, ...(annotation?.handledBy ? { handledBy: annotation.handledBy } : {}), status: approved ? 'approved' as const : 'rejected' as const, ...(shownReason ? { reason: shownReason } : {}),
        ...(approved && annotation?.workspaceRule ? { workspaceRule: annotation.workspaceRule } : {}) };
      if (shownReason) this.permissionRejectReasons.set(key, shownReason);
      // Keep the stored request pending while recording the requested decision.
      // A failed driver call must not be represented as an accepted decision.
      const intent = { ...pending.request, resolutionIntent: request.status };
      await this.deps.savePermission(sessionId, intent);
      if (!this.mutations.validCaptured(pending) || this.permissionResolutions.get(key) !== claim || this.permissions.get(key) !== pending || this.deps.drivers.get(sessionId) !== driver || pending.generation !== (this.deps.sessionGenerations.get(sessionId) ?? 0)) {
        throw new RuntimeError('PERMISSION_EXPIRED', 'Permission request is no longer active', 409);
      }
      const resolved = await this.deps.driverOperation(driver, () => !approved && reason ? driver.resolvePermission!(pending.nativeId, false, reason) : driver.resolvePermission!(pending.nativeId, approved));
      if (!resolved || !this.mutations.validCaptured(pending) || this.deps.drivers.get(sessionId) !== driver || pending.generation !== (this.deps.sessionGenerations.get(sessionId) ?? 0)) {
        if (this.permissions.get(key) === pending) this.permissions.delete(key);
        throw new RuntimeError('PERMISSION_EXPIRED', 'Permission request is no longer active', 409);
      }
      // ACPX may synchronously emit its terminal permission update before its
      // resolve promise settles. That event is the canonical audit record.
      if (this.permissions.get(key) !== pending) return request;
      try {
        await this.mutations.write(sessionId, async () => {
          if (this.permissions.get(key) !== pending) return;
          this.mutations.checkCaptured(pending);
          this.permissions.delete(key); this.deps.touch(sessionId);
          await this.deps.eventScope.run(pending.fence, () => this.deps.emit(sessionId, 'permission_request', request));
          await this.deps.savePermission(sessionId, request).catch(error => this.deps.warnCaught('resolvePermission.savePermission', sessionId, error));
        });
      } catch (error) {
        throw new RuntimeError('PERMISSION_ACCEPTED_AUDIT_FAILED', `Permission accepted but audit delivery failed: ${errorMessage(error)}`, 503);
      }
      // Subsequent driver events own the session state; an approval must not overwrite a completed turn.
      return request;
    } finally { this.permissionHandledBy.delete(key); this.permissionRejectReasons.delete(key); if (this.permissionResolutions.get(key) === claim) this.permissionResolutions.delete(key); }
    });
  }
}
