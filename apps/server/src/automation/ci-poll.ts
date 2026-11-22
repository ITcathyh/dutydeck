import type { SessionAutomationService } from '../session-automation.js';
import {
  cancelCiInputSchema,
  canonicalExecutionJson,
  ciSubscriptionSchema,
  ciSubscriptionV2Schema,
  LEGACY_GITHUB_PROVIDER_ID,
  RuntimeError,
  subscribeCiInputSchema,
  type CiProvider,
  type CiRepository,
  type CiRun,
  type CiSubscription,
  type CiSubscriptionV2,
  type PublicCiProvider,
  type PublicCiSubscription,
  type Session,
  type SubscribeCiInput,
  type TaskRequestV1
} from '@dutydeck/shared';
import { ciProviderLabel, CiProviderRegistry, resolveCiHead, type CiHead } from '../ci-providers.js';
import {
  CI_BINDING_GENERATION,
  ciKey,
  ciRequestKey,
  CLAIM_TTL_MS,
  errorMessage,
  freezeAdmission,
  iso,
  isSessionRunnable,
  migrateCi,
  plus,
  publicSubscription,
  resolveAutomationActor
} from './store.js';
import { randomUUID } from 'node:crypto';

export const DEFAULT_POLL_MS = 60_000;
const runStatuses = new Set(['queued', 'running', 'completed']);

function formatCiPrompt(basePrompt: string, providerName: string, repository: string, headSha: string, runs: CiRun[]): string {
  const lines = runs.map(run => `- ${run.name.slice(0, 80)}: ${(run.conclusion ?? run.result ?? 'completed').slice(0, 40)} (run ${run.id}, ${run.url.slice(0, 400)})`);
  return `${basePrompt}\n\n${providerName} completed for ${repository} at ${headSha}:\n${lines.join('\n')}`;
}

/** 提供方返回的构建进提示词之前做一次形状检查：只留这个提交的、字段齐全的构建，同一 id 取最新一次重跑。 */
function normalizeRuns(runs: unknown, headSha: string, completedOnly = false): CiRun[] {
  if (!Array.isArray(runs)) throw new RuntimeError('CI_PROVIDER_RESPONSE_INVALID', 'CI 提供方返回的构建列表格式不正确', 502);
  const latest = new Map<number, CiRun>();
  for (const value of runs.slice(0, 100) as Array<Partial<CiRun>>) {
    if (!value || !Number.isSafeInteger(value.id) || (value.id as number) < 0 || typeof value.name !== 'string' || typeof value.url !== 'string') continue;
    if (typeof value.headSha !== 'string' || value.headSha.toLowerCase() !== headSha || !runStatuses.has(String(value.status))) continue;
    if (completedOnly && value.status !== 'completed') continue;
    const attempt = Number.isSafeInteger(value.attempt) && (value.attempt as number) > 0 ? value.attempt as number : 1;
    const run: CiRun = { id: value.id as number, name: value.name, attempt, headSha, status: value.status as CiRun['status'], url: value.url,
      ...(value.result ? { result: value.result } : {}), ...(typeof value.conclusion === 'string' ? { conclusion: value.conclusion } : {}) };
    if (!latest.has(run.id) || latest.get(run.id)!.attempt < run.attempt) latest.set(run.id, run);
  }
  return [...latest.values()].sort((left, right) => left.id - right.id);
}

export const sameHead = (resolved: CiHead, provider: string, repository: CiRepository, headSha: string) =>
  resolved.provider.id === provider && resolved.repository.slug.toLowerCase() === repository.slug.toLowerCase() && resolved.headSha === headSha;

type Dependencies = Pick<SessionAutomationService['scheduler'],
  'buildRequest' | 'clock' | 'delivery' | 'dispatchAdmitted' | 'options' | 'ownerId' | 'store'>;

export class AutomationCiPoll {
  private readonly providers: CiProviderRegistry;
  private readonly pollIntervalMs: number;

  constructor(private readonly automation: Dependencies) {
    this.pollIntervalMs = Math.max(60_000, Math.min(60 * 60_000, automation.options.pollIntervalMs ?? DEFAULT_POLL_MS));
    this.providers = automation.options.ciProviders ?? new CiProviderRegistry();
  }

  /** 至少装了一个 CI 插件；/ci 据此判断「未安装 CI 插件」。 */
  get ciConfigured() { return this.providers.size > 0; }

  listCiProviders(): PublicCiProvider[] { return this.providers.describe(); }

  private pollingProvider(id: string): CiProvider & Required<Pick<CiProvider, 'getPipelineStatus'>> {
    const provider = this.providers.get(id);
    if (!provider) throw new RuntimeError('CI_PROVIDER_UNAVAILABLE', `CI 插件提供方 ${id} 没有加载`, 409);
    if (typeof provider.getPipelineStatus !== 'function') throw new RuntimeError('CI_PROVIDER_POLLING_UNSUPPORTED', `${provider.displayName} 不支持查询构建状态`, 400);
    return provider as CiProvider & Required<Pick<CiProvider, 'getPipelineStatus'>>;
  }

  async listRuns(providerId: string, repository: CiRepository, headSha: string, workflow?: string, completedOnly = false): Promise<CiRun[]> {
    const status = await this.pollingProvider(providerId).getPipelineStatus({ repository, sha: headSha, ...(workflow ? { workflow } : {}), ...(completedOnly ? { completedOnly } : {}) });
    return normalizeRuns(status?.runs, headSha, completedOnly);
  }

  /** 只在能查询构建状态的提供方里按 origin 匹配。 */
  ciHead(cwd: string, providerId?: string) {
    return resolveCiHead(cwd, this.providers, providerId, provider => typeof provider.getPipelineStatus === 'function');
  }

  async ciCondition(session: Session, input: { kind: 'ci_new_failure'; provider?: string; workflow?: string }) {
    const resolved = await this.ciHead(session.cwd, input.provider);
    const runs = await this.listRuns(resolved.provider.id, resolved.repository, resolved.headSha, input.workflow, true);
    return {
      kind: 'ci_new_failure' as const,
      provider: resolved.provider.id,
      ...(input.workflow ? { workflow: input.workflow } : {}),
      repository: resolved.repository,
      headSha: resolved.headSha,
      observedRunIds: runs.map(run => run.id),
      observedRunAttempts: runs.map(run => ({ id: run.id, attempt: run.attempt }))
    };
  }

  async subscribeCi(sessionId: string, rawInput: SubscribeCiInput, actorId?: string): Promise<PublicCiSubscription> {
    await this.automation.store.requireAuthorized(sessionId, actorId);
    const session = await this.automation.store.requireSession(sessionId);
    if (!isSessionRunnable(session)) throw new RuntimeError('SESSION_NOT_ACTIVE', 'Session is not active', 409);
    const input = subscribeCiInputSchema.parse(rawInput);
    const resolved = await this.ciHead(session.cwd, input.provider);
    const now = this.automation.clock();
    const id = `ci_${randomUUID()}`;
    await this.automation.options.prepareDelivery?.(sessionId, id);
    const record = ciSubscriptionSchema.parse({
      schemaVersion: 1,
      id,
      revision: 1,
      sessionId,
      ...(actorId ? { actorId } : {}),
      provider: resolved.provider.id,
      repository: resolved.repository,
      headSha: resolved.headSha,
      ...(input.workflow ? { workflow: input.workflow } : {}),
      prompt: input.prompt ?? `Review the completed ${resolved.provider.displayName} result and continue the task.`,
      status: 'waiting',
      expiresAt: plus(now, input.ttlSeconds * 1_000),
      nextPollAt: iso(now),
      delivery: { status: this.automation.options.deliver ? 'pending' : 'not_requested', attempts: 0, updatedAt: iso(now) },
      createdAt: iso(now),
      updatedAt: iso(now)
    });
    if (!await this.automation.store.createRecord(ciKey(record.id), record)) throw new RuntimeError('SESSION_AUTOMATION_CONFLICT', 'CI subscription identifier already exists', 409);
    return publicSubscription(record);
  }

  async cancelCi(sessionId: string, id: string, rawInput: { expectedRevision: number }, actorId?: string): Promise<PublicCiSubscription> {
    await this.automation.store.requireAuthorized(sessionId, actorId);
    await this.automation.store.requireSession(sessionId);
    const input = cancelCiInputSchema.parse(rawInput);
    const stored = await this.automation.store.getRecord(ciKey(id), value => ciSubscriptionSchema.parse(value));
    if (!stored || stored.value.sessionId !== sessionId) throw new RuntimeError('SESSION_AUTOMATION_CI_NOT_FOUND', 'CI subscription not found', 404);
    if (stored.value.taskStartedAt) throw new RuntimeError('SESSION_AUTOMATION_CI_ALREADY_STARTED', 'CI continuation has already started', 409);
    if (stored.value.revision !== input.expectedRevision) throw new RuntimeError('SESSION_AUTOMATION_REVISION_CONFLICT', 'CI subscription revision changed', 409);
    if (!['waiting', 'dispatching', 'accepted'].includes(stored.value.status)) return publicSubscription(stored.value);
    const now = iso(this.automation.clock());
    const cancelled = ciSubscriptionSchema.parse({
      ...stored.value,
      revision: stored.value.revision + 1,
      status: 'cancelled',
      nextPollAt: undefined,
      delivery: { status: 'not_requested', attempts: stored.value.delivery.attempts, updatedAt: now },
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      updatedAt: now
    });
    if (!await this.automation.store.replace(ciKey(id), stored.raw, cancelled)) throw new RuntimeError('SESSION_AUTOMATION_REVISION_CONFLICT', 'CI subscription revision changed', 409);
    return publicSubscription(cancelled);
  }

  async claimAndPollCi(stored: { raw: string; value: CiSubscription }) {
    const now = this.automation.clock();
    const base = migrateCi(stored.value);
    if (new Date(base.expiresAt) <= now) {
      const expired = ciSubscriptionV2Schema.parse({ ...base, revision: base.revision + 1, schemaVersion: 2, status: 'expired', nextPollAt: undefined, updatedAt: iso(now) });
      await this.automation.store.replace(ciKey(base.id), stored.raw, expired);
      return;
    }
    if (base.leaseExpiresAt && new Date(base.leaseExpiresAt) > now) return;
    const claimed = await this.claimCiLease(stored.raw, base, now);
    if (!claimed) return;
    await this.pollCi(claimed);
  }

  /** 以 CAS 领取 CI 订阅租约；被他人改过返回 undefined。 */
  private async claimCiLease(raw: string, base: CiSubscriptionV2, now: Date) {
    const claimed = ciSubscriptionV2Schema.parse({ ...base, revision: base.revision + 1, schemaVersion: 2, leaseOwner: this.automation.ownerId, leaseExpiresAt: plus(now, CLAIM_TTL_MS), updatedAt: iso(now) });
    return await this.automation.store.replace(ciKey(base.id), raw, claimed) ? { raw: JSON.stringify(claimed), value: claimed } : undefined;
  }

  private async pollCi(stored: { raw: string; value: CiSubscription }) {
    const current0 = migrateCi(stored.value);
    const providerId = current0.provider ?? LEGACY_GITHUB_PROVIDER_ID;
    let runs: CiRun[];
    try { runs = await this.listRuns(providerId, current0.repository, current0.headSha, current0.workflow); }
    catch (error) {
      await this.returnCiToWaiting(stored, errorMessage(error));
      return;
    }
    if (runs.length === 0 || runs.some(run => run.status !== 'completed')) {
      await this.returnCiToWaiting(stored);
      return;
    }
    const current = await this.automation.store.getRecord(ciKey(current0.id), value => ciSubscriptionSchema.parse(value));
    if (!current) return;
    const currentValue = migrateCi(current.value);
    if (currentValue.status !== 'waiting' || currentValue.leaseOwner !== this.automation.ownerId) return;
    const session = await this.automation.options.runtime.getSession(currentValue.sessionId);
    if (!isSessionRunnable(session)) {
      await this.finishCi(current, 'session_inactive', 'Session is no longer active');
      return;
    }
    let resolved: CiHead;
    try { resolved = await this.ciHead(session!.cwd, providerId); }
    catch (error) { await this.finishCi(current, 'stale_head', errorMessage(error)); return; }
    if (!sameHead(resolved, providerId, currentValue.repository, currentValue.headSha)) {
      await this.finishCi(current, 'stale_head', 'Session repository or HEAD changed while waiting for CI');
      return;
    }
    try { await this.automation.store.requireAuthorized(currentValue.sessionId, currentValue.actorId); }
    catch (error) { await this.finishCi(current, 'revoked', errorMessage(error)); return; }
    // 首次 dispatchPrompt 在收到完成 run 列表后冻结；恢复使用原文本，不再拼接提供方新的返回。
    const dispatchPrompt = formatCiPrompt(currentValue.prompt, ciProviderLabel(this.providers, providerId), currentValue.repository.slug, currentValue.headSha, runs);
    const dispatching = ciSubscriptionV2Schema.parse({
      ...currentValue,
      schemaVersion: 2,
      revision: currentValue.revision + 1,
      status: 'dispatching',
      completedRunIds: runs.map(run => run.id),
      dispatchPrompt,
      nextPollAt: undefined,
      updatedAt: iso(this.automation.clock())
    });
    if (!await this.automation.store.replace(ciKey(currentValue.id), current.raw, dispatching)) return;
    await this.dispatchCi({ raw: JSON.stringify(dispatching), value: dispatching }, session!);
  }

  async recoverDispatchingCi(stored: { raw: string; value: CiSubscription }) {
    const claimed0 = migrateCi(stored.value);
    if (!claimed0.dispatchPrompt) {
      await this.finishCi(stored, 'error', 'Persisted CI continuation prompt is missing');
      return;
    }
    const now = this.automation.clock();
    const expired = new Date(claimed0.expiresAt) <= now;

    // 统一来源恢复前序：先读原 admission/明确 taskId，在任何新 HEAD/材料/当前默认配置前核实际接受事实。
    if (claimed0.admission) {
      const accepted = this.automation.store.execution.getAcceptedTask(claimed0.admission.taskId);
      if (accepted) {
        // 恢复命中已接受事实：完整接受 request 必须与冻结 admission 相等，否则持久 blocked，不借 ID 补映射。
        if (accepted.request && claimed0.admission.request && canonicalExecutionJson(accepted.request) !== canonicalExecutionJson(claimed0.admission.request)) {
          await this.finishCi(stored, 'blocked', 'The accepted task request conflicts with the frozen CI admission');
          return;
        }
        // TTL 只拒绝尚未获得提交授权的工作；已开始的任务即使 accepted 回写丢失也要收尾投递。
        if (expired && !claimed0.taskStartedAt) { await this.finishCi(stored, 'expired', 'CI continuation expired before execution'); return; }
        await this.automation.store.ensureTaskBinding(claimed0.admission.taskId, {
          schemaVersion: 2,
          kind: 'ci',
          sessionId: claimed0.sessionId,
          subscriptionId: claimed0.id,
          taskId: claimed0.admission.taskId,
          taskIdVersion: claimed0.admission.taskIdVersion,
          generation: CI_BINDING_GENERATION
        });
        await this.markCiAccepted(claimed0.id, claimed0.admission.taskId);
        return;
      }
    }

    const claimed = await this.claimCiLease(stored.raw, claimed0, now);
    if (!claimed) return;
    const session = await this.automation.options.runtime.getSession(claimed.value.sessionId);
    if (!isSessionRunnable(session)) { await this.finishCi(claimed, 'session_inactive', 'Session is no longer active'); return; }
    try {
      await this.automation.store.requireAuthorized(claimed.value.sessionId, claimed.value.actorId);
    } catch (error) {
      await this.finishCi(claimed, 'revoked', errorMessage(error));
      return;
    }
    await this.dispatchCi(claimed, session!);
  }

  private async dispatchCi(dispatching: { value: CiSubscriptionV2; raw: string }, session: Session) {
    let record = dispatching.value;
    const prompt = record.dispatchPrompt;
    if (!prompt) throw new RuntimeError('SESSION_AUTOMATION_CI_PROMPT_MISSING', 'Persisted CI continuation prompt is missing', 500);
    const actor = record.actor ?? resolveAutomationActor(session, record.actorId);
    if (!actor) { await this.finishCi({ raw: dispatching.raw, value: record }, 'error', 'CI actor domain cannot be verified'); return; }

    let request: TaskRequestV1;
    let taskId: string;
    let taskIdVersion: 'v1' | 'legacy' = 'v1';

    if (record.admission) {
      // 原样使用已冻结的 request，绝不用新默认值覆盖！
      request = record.admission.request ?? this.automation.buildRequest(session, 'automation', ciRequestKey(record.id), prompt, actor);
      taskId = record.admission.taskId;
      taskIdVersion = record.admission.taskIdVersion;
    } else {
      const candidateRequest = this.automation.buildRequest(session, 'automation', ciRequestKey(record.id), prompt, actor);
      let existingAccepted;
      try {
        existingAccepted = this.automation.store.execution.lookupAccepted(candidateRequest);
      } catch (err) {
        await this.finishCi({ raw: dispatching.raw, value: record }, 'blocked', errorMessage(err));
        return;
      }
      const frozen = freezeAdmission('automation', record.sessionId, candidateRequest, existingAccepted, actor);
      ({ request } = frozen);
      ({ taskId, taskIdVersion } = frozen.admission);
      const withAdmission = ciSubscriptionV2Schema.parse({
        ...record,
        schemaVersion: 2,
        revision: record.revision + 1,
        ...frozen.fields,
        updatedAt: iso(this.automation.clock())
      });
      if (!await this.automation.store.replace(ciKey(record.id), dispatching.raw, withAdmission)) return;
      record = withAdmission;
    }

    const stored: { raw: string; value: CiSubscriptionV2 } = { raw: JSON.stringify(record), value: record };
    const subscriptionId = record.id;
    await this.automation.dispatchAdmitted(request, taskId, {
      schemaVersion: 2,
      kind: 'ci',
      sessionId: record.sessionId,
      subscriptionId,
      taskId,
      taskIdVersion,
      generation: CI_BINDING_GENERATION
    }, {
      accepted: id => this.markCiAccepted(subscriptionId, id),
      conflict: (error, afterDispatch) => afterDispatch
        ? this.finishCi(stored, { status: 'blocked', blockReason: 'admission_conflict', error })
        : this.finishCi(stored, 'blocked', error),
      failed: async error => {
        const latest = await this.automation.store.getRecord(ciKey(subscriptionId), value => ciSubscriptionSchema.parse(value));
        if (latest) await this.finishCi(latest, { status: 'error', error: errorMessage(error) });
      }
    });
  }

  private async returnCiToWaiting(stored: { raw: string; value: CiSubscription }, error?: string) {
    const now = this.automation.clock();
    const base = migrateCi(stored.value);
    const waiting = ciSubscriptionV2Schema.parse({
      ...base,
      schemaVersion: 2,
      revision: base.revision + 1,
      status: 'waiting',
      nextPollAt: plus(now, this.pollIntervalMs),
      ...(error ? { error } : { error: undefined }),
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      updatedAt: iso(now)
    });
    await this.automation.store.replace(ciKey(base.id), stored.raw, waiting);
  }

  async finishCi(stored: { raw: string; value: CiSubscription }, patchOrStatus: CiSubscriptionV2['status'] | Partial<CiSubscriptionV2>, error?: string) {
    const patch: Partial<CiSubscriptionV2> = typeof patchOrStatus === 'string'
      ? { status: patchOrStatus, ...(error ? { error } : {}) }
      : { ...patchOrStatus, ...(error ? { error } : {}) };
    const base = migrateCi(stored.value);
    const status = patch.status ?? base.status;
    const noDelivery = !['waiting', 'dispatching', 'accepted', 'completed'].includes(status);
    const shouldResetDelivery = noDelivery && base.delivery.status !== 'delivered';
    const updated = ciSubscriptionV2Schema.parse({
      ...base,
      ...patch,
      schemaVersion: 2,
      revision: base.revision + 1,
      status,
      nextPollAt: undefined,
      ...(shouldResetDelivery ? { delivery: this.automation.delivery.undelivered(base.delivery) } : {}),
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      updatedAt: iso(this.automation.clock())
    });
    await this.automation.store.replace(ciKey(base.id), stored.raw, updated);
  }

  private async markCiAccepted(id: string, taskId: string) {
    const current = await this.automation.store.getRecord(ciKey(id), value => ciSubscriptionSchema.parse(value));
    if (!current) return;
    const currentValue = migrateCi(current.value);
    if (currentValue.status !== 'dispatching') return;
    // CAS 核原来源身份：冻结 admission 的 taskId 必须与实际接受 Task 一致，不借最新 dispatching 记录绑定不同请求。
    if (currentValue.admission && currentValue.admission.taskId !== taskId) return;
    const accepted = ciSubscriptionV2Schema.parse({ ...currentValue, schemaVersion: 2, revision: currentValue.revision + 1, status: 'accepted', taskId, leaseOwner: undefined, leaseExpiresAt: undefined, updatedAt: iso(this.automation.clock()) });
    await this.automation.store.replace(ciKey(id), current.raw, accepted);
  }
}
