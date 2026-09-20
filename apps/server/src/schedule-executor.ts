import { boundCollaborationSnapshot } from './collaboration-context.js';
import { createHash, randomUUID } from 'node:crypto';
import { canonicalExecutionJson, previewNextSchedule, RuntimeError, type CollaborationAction, type CollaborationMandate, type CollaborationScope, type CollaborationSnapshot, type ScheduleDefinition, type ScheduleExecutionFence, type ScheduleLease, type ScheduleOccurrence } from '@dutydeck/shared';
import { scheduleWriterLeaseKey } from '@dutydeck/storage';
import { CollaborationService, collaborationContextSignature, scheduleMatchesMandate, type CollaborationAuthorization, type CollaborationRepositories } from './collaboration-service.js';

export interface ScheduleExecutionInput {
  scope: CollaborationScope; actorId: string; mandate: CollaborationMandate; schedule: ScheduleDefinition;
  occurrence: ScheduleOccurrence; snapshot: CollaborationSnapshot; actionId: string; action: CollaborationAction;
  /** Recheck immediately before provider dispatch/send, including after queued preparation. */
  assertCurrent(): Promise<void>;
}
export type ScheduleAgentResult = { status: 'pending' | 'completed' | 'failed' | 'unknown'; text?: string; receipt?: string; error?: string };
export interface ScheduleExecutorOptions {
  repositories: CollaborationRepositories;
  service: CollaborationService;
  authorize: CollaborationAuthorization;
  /** resume=true must inspect the same durable task; never start a replacement task. */
  executeAgent?: (input: ScheduleExecutionInput & { resume: boolean }) => Promise<ScheduleAgentResult>;
  cancelAgent?: (input: ScheduleExecutionInput) => Promise<void>;
  deliver: (input: ScheduleExecutionInput & { text: string }) => Promise<{ receipt: string }>;
  reconcile?: (input: ScheduleExecutionInput) => Promise<{ status: 'succeeded' | 'failed' | 'unknown'; receipt?: string; error?: string }>;
  now?: () => Date;
  holderId?: string;
}
const hash = (value: unknown) => createHash('sha256').update(canonicalExecutionJson(value)).digest('hex');
const bootstrapSignature = (snapshot: CollaborationSnapshot) => hash({ status: snapshot.bootstrap?.status ?? null, missing: snapshot.bootstrap?.missing ?? [] });
const actionId = (occurrence: ScheduleOccurrence, kind: string) => `collaboration_${kind}_${occurrence.idempotencyKey}`;
const terminal = (state: string) => ['settled','failed','suppressed'].includes(state);
const stale = () => new RuntimeError('COLLABORATION_EXECUTION_STALE', 'Delegation, context or authorization changed', 409);
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export class ScheduleExecutor {
  private closed = false;
  private running?: Promise<void>;
  private lastScheduleId?: string;
  private readonly lastOccurrenceIds = new Map<string, string>();
  readonly holderId: string;
  constructor(readonly options: ScheduleExecutorOptions) { this.holderId = options.holderId ?? randomUUID(); }
  private get repos() { return this.options.repositories; }
  private now() { return this.options.now?.() ?? new Date(); }
  tick(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (!this.running) {
      const current = this.run(); this.running = current;
      void current.finally(() => { if (this.running === current) this.running = undefined; }).catch(() => {});
    }
    return this.running;
  }
  close(): Promise<void> { this.closed = true; return this.running ?? Promise.resolve(); }
  private async lease(schedule: ScheduleDefinition): Promise<ScheduleLease | undefined> {
    if (!schedule.identityRef || !schedule.secretRef) return undefined;
    const leaseKey = scheduleWriterLeaseKey(schedule.channelBotId), now = this.now().toISOString();
    let lease = await this.repos.scheduleLeases.getByKey(leaseKey);
    if (lease?.state === 'held' && lease.expiresAt! > now) {
      if (lease.holderId !== this.holderId) return undefined;
      return this.repos.scheduleLeases.renew(leaseKey, { expectedRevision: lease.revision, expectedGeneration: lease.generation, expectedFenceToken: lease.fenceToken, holderId: this.holderId, now, ttlMs: 60_000 });
    }
    if (lease?.state === 'held') lease = await this.repos.scheduleLeases.fence(leaseKey, { expectedRevision: lease.revision, expectedGeneration: lease.generation, expectedFenceToken: lease.fenceToken, now });
    return this.repos.scheduleLeases.acquire({ id: lease?.id ?? `collaboration_lease_${hash(leaseKey)}`, leaseKey, expectedRevision: lease?.revision ?? 0, expectedGeneration: lease?.generation ?? 0, holderId: this.holderId, holderIdentityRef: schedule.identityRef, secretRef: schedule.secretRef, scheduleSetHash: hash(schedule.channelBotId), now, ttlMs: 60_000 });
  }
  private fence(lease: ScheduleLease): ScheduleExecutionFence { return { leaseKey: lease.leaseKey, holderId: this.holderId, fenceToken: lease.fenceToken, now: this.now().toISOString() }; }
  private async advance(occurrence: ScheduleOccurrence, state: ScheduleOccurrence['state'], lease: ScheduleLease, error?: string) {
    return this.repos.scheduleOccurrences.advance(occurrence.id, occurrence.revision, state, this.fence(lease), error);
  }
  private async valid(mandate: CollaborationMandate, schedule: ScheduleDefinition, snapshot: CollaborationSnapshot, lease: ScheduleLease, phase: 'execute' | 'deliver', coverageSignature?: string) {
    if (this.closed) throw stale();
    const [current, definition, writer, latest] = await Promise.all([this.repos.collaboration.getMandate(mandate.scope, mandate.id), this.repos.scheduleDefinitions.get(schedule.id), this.repos.scheduleLeases.getByKey(lease.leaseKey), this.repos.collaboration.snapshot(mandate.scope)]);
    const readiness = definition && await this.repos.scheduleDefinitions.readiness(definition.id, this.now().toISOString());
    if (!readiness?.executionEligible || !current || current.status !== 'active' || !scheduleMatchesMandate(schedule, mandate) || !definition || !scheduleMatchesMandate(definition, current) || definition.state !== 'enabled' || definition.currentGeneration !== schedule.currentGeneration || definition.delivery.chatRef !== current.scope.chatId || !writer || writer.state !== 'held' || writer.holderId !== this.holderId || writer.fenceToken !== lease.fenceToken || !writer.expiresAt || writer.expiresAt <= this.now().toISOString()) throw stale();
    const executionSettings = ({ notificationsPaused: _paused, revision: _revision, updatedAt: _updatedAt, ...settings }: CollaborationSnapshot['settings']) => settings;
    if (canonicalExecutionJson(executionSettings(latest.settings)) !== canonicalExecutionJson(executionSettings(snapshot.settings))) throw stale();
    if (phase === 'deliver') {
      if (current.deliveryPaused || latest.settings.notificationsPaused) throw stale();
      // Scheduled work uses its frozen material; appended chat and history cursors do not revoke it.
      // Coverage changes still invalidate the result, as do the live plan/permission/follow-up checks.
      if (bootstrapSignature(latest) !== (coverageSignature ?? bootstrapSignature(snapshot))) throw stale();
    }
    if (!await this.options.authorize(mandate.scope, mandate.requesterId, phase)) throw stale();
    const followup = current.followupId ? await this.repos.collaboration.getFollowup(current.scope, current.followupId) : undefined;
    if (current.condition !== 'always' && (!followup || followup.status !== 'open')) throw stale();
    if (phase === 'deliver' && current.followupId && followup?.revision !== snapshot.followups.find(item => item.id === current.followupId)?.revision) throw stale();
    if (current.condition === 'no_progress' && followup?.revision !== current.lastProgressRevision) throw stale();
    if (this.closed) throw stale();
  }
  private async begin(mandate: CollaborationMandate, schedule: ScheduleDefinition, occurrence: ScheduleOccurrence, snapshot: CollaborationSnapshot, kind: string, payload: Record<string, unknown>, contextSignature = collaborationContextSignature(snapshot), coverageSignature = bootstrapSignature(snapshot)) {
    payload = JSON.parse(JSON.stringify({ ...payload, contextSignature, coverageSignature })) as Record<string, unknown>;
    return this.repos.collaboration.beginAction({ id: actionId(occurrence, kind), scope: mandate.scope, kind: `schedule_${kind}`, mandateId: mandate.id, mandateRevision: mandate.revision, scheduleGeneration: schedule.currentGeneration, contextRevision: snapshot.contextRevision, ...(mandate.followupId ? { followupRevision: snapshot.followups.find(item => item.id === mandate.followupId)?.revision } : {}), requesterId: mandate.requesterId, inputDigest: hash(payload), payload });
  }
  private input(mandate: CollaborationMandate, schedule: ScheduleDefinition, occurrence: ScheduleOccurrence, snapshot: CollaborationSnapshot, lease: ScheduleLease, action: CollaborationAction, phase: 'execute' | 'deliver'): ScheduleExecutionInput {
    return { scope: mandate.scope, actorId: mandate.requesterId, mandate, schedule, occurrence, snapshot, actionId: action.id, action, assertCurrent: () => this.valid(mandate, schedule, snapshot, lease, phase, typeof action.payload.coverageSignature === 'string' ? action.payload.coverageSignature : undefined) };
  }
  private async actionState(action: CollaborationAction, status: CollaborationAction['status'], receipt?: string, error?: string) {
    return this.repos.collaboration.updateAction(action.scope, action.id, { expectedRevision: action.revision, status, ...(receipt !== undefined ? { receipt } : {}), ...(error !== undefined ? { error } : {}) });
  }
  private async run() {
    let processed = 0;
    const mandates = await this.repos.collaboration.listMandates();
    const start = mandates.findIndex(mandate => mandate.scheduleDefinitionId === this.lastScheduleId) + 1;
    // The budget limits work per tick, not which delegations may ever run.
    // Continue after the last visited entry so unresolved work cannot monopolize it.
    for (const mandate of [...mandates.slice(start), ...mandates.slice(0, start)]) {
      if (this.closed || processed >= 20) break;
      this.lastScheduleId = mandate.scheduleDefinitionId;
      try {
        let schedule = await this.repos.scheduleDefinitions.get(mandate.scheduleDefinitionId);
        if (!schedule || schedule.sourceNamespace !== 'collaboration') continue;
        const lease = await this.lease(schedule); if (!lease) continue;
        const pending = await this.repos.scheduleOccurrences.listUnsettled(schedule.id);
        const pendingStart = pending.findIndex(occurrence => occurrence.id === this.lastOccurrenceIds.get(mandate.scheduleDefinitionId)) + 1;
        if (!pending.length) this.lastOccurrenceIds.delete(schedule.id);
        for (const occurrence of [...pending.slice(pendingStart), ...pending.slice(0, pendingStart)]) {
          if (processed >= 20 || this.closed) break;
          this.lastOccurrenceIds.set(schedule.id, occurrence.id);
          processed++;
          await this.process(mandate, schedule, occurrence, lease);
        }
        if (this.closed) break;
        // Progress restarts interval waits; calendar triggers keep their agreed time.
        // A new mandate generation fences old pending Agents before the next check.
        const followup = mandate.condition === 'no_progress' && mandate.followupId ? await this.repos.collaboration.getFollowup(mandate.scope, mandate.followupId) : undefined;
        if (mandate.status === 'active' && followup?.status === 'open' && followup.revision !== mandate.lastProgressRevision) {
          await this.options.service.updateMandate(mandate.scope, mandate.requesterId, mandate.id, { expectedRevision: mandate.revision, condition: 'no_progress', ...(schedule.trigger.kind === 'interval' ? { trigger: { ...schedule.trigger, anchorAt: followup.updatedAt } } : {}) });
          continue;
        }
        schedule = await this.options.service.reconcileMandate(mandate) ?? schedule;
        if (mandate.status !== 'active' || schedule.state !== 'enabled' || !scheduleMatchesMandate(schedule, mandate) || (await this.repos.scheduleOccurrences.listUnsettled(schedule.id)).length || processed >= 20) continue;
        const watermark = await this.repos.scheduleWatermarks.get(schedule.id), due = watermark?.nextDueAt;
        if (!due || due > this.now().toISOString()) continue;
        const nextDue = previewNextSchedule(schedule, this.now())?.scheduledForUtc;
        const { occurrence } = await this.repos.scheduleOccurrences.recordPlanned(schedule.id, due, nextDue, schedule.currentGeneration);
        processed++;
        if (mandate.catchupPolicy === 'skip' && this.now().getTime() - Date.parse(due) > 60_000) await this.advance(occurrence, 'suppressed', lease, 'Missed occurrence skipped by delegation policy');
        else await this.process(mandate, schedule, occurrence, lease);
      } catch (error) {
        // A failed scope cannot block other groups. Persisted occurrences/actions remain recoverable.
        if (!(error instanceof RuntimeError && ['SCHEDULE_REVISION_CONFLICT','SCHEDULE_GENERATION_STALE','SCHEDULE_LEASE_CONFLICT','SCHEDULE_SECRET_REF_INVALID','COLLABORATION_REVISION_CONFLICT','COLLABORATION_FORBIDDEN'].includes(error.code))) throw error;
      }
    }
  }
  private async process(mandate: CollaborationMandate, schedule: ScheduleDefinition, initial: ScheduleOccurrence, lease: ScheduleLease) {
    let occurrence = initial;
    if (terminal(occurrence.state)) return;
    const fullSnapshot = await this.repos.collaboration.snapshot(mandate.scope);
    const contextSignature = collaborationContextSignature(fullSnapshot);
    const coverageSignature = bootstrapSignature(fullSnapshot);
    const snapshot = boundCollaborationSnapshot(fullSnapshot, mandate.followupId);
    const agentId = actionId(occurrence, 'agent'), deliveryId = actionId(occurrence, 'delivery');
    let agent = await this.repos.collaboration.getAction(mandate.scope, agentId);
    let delivery = await this.repos.collaboration.getAction(mandate.scope, deliveryId);
    // A provider result is a historical fact even when the plan was subsequently cancelled.
    if (delivery?.status === 'succeeded') { await this.advance(occurrence, 'settled', lease); return; }
    if (delivery && ['sending','unknown'].includes(delivery.status)) {
      if (delivery.status === 'sending') delivery = await this.actionState(delivery, 'unknown', undefined, 'Previous delivery has no durable receipt');
      if (occurrence.state !== 'unknown') occurrence = await this.advance(occurrence, 'unknown', lease);
      const result = await this.options.reconcile?.(this.input(mandate, schedule, occurrence, snapshot, lease, delivery, 'deliver'));
      if (result && result.status !== 'unknown') {
        await this.actionState(delivery, result.status, result.receipt, result.error);
        await this.advance(occurrence, result.status === 'succeeded' ? 'settled' : 'failed', lease, result.error);
      }
      return;
    }
    try {
      if (occurrence.generation !== schedule.currentGeneration) throw stale();
      await this.valid(mandate, schedule, (agent?.payload.snapshot as CollaborationSnapshot | undefined) ?? snapshot, lease, 'execute');
    } catch {
      if (agent && ['sending','unknown'].includes(agent.status)) {
        if (!this.options.cancelAgent) return;
        await this.options.cancelAgent(this.input(mandate, schedule, occurrence, snapshot, lease, agent, 'execute'));
        await this.actionState(agent, 'suppressed', undefined, 'Delegation invalidated');
      }
      if (delivery?.status === 'intent') await this.actionState(delivery, 'suppressed', undefined, 'Delegation invalidated');
      await this.advance(occurrence, 'suppressed', lease, 'Delegation, progress, pause or authorization changed');
      return;
    }
    if (occurrence.state === 'planned' || occurrence.state === 'claimed') occurrence = await this.advance(occurrence, 'claimed', lease);
    if (occurrence.state === 'claimed') occurrence = await this.advance(occurrence, 'running', lease);
    let content = mandate.prompt;
    if (mandate.mode === 'agent') {
      if (!this.options.executeAgent) { await this.advance(occurrence, 'failed', lease, 'Agent execution integration is unavailable'); return; }
      if (!agent) agent = (await this.begin(mandate, schedule, occurrence, snapshot, 'agent', { prompt: mandate.prompt, snapshot }, contextSignature, coverageSignature)).action;

      if (agent.status === 'failed' || agent.status === 'suppressed') { await this.advance(occurrence, agent.status === 'failed' ? 'failed' : 'suppressed', lease, agent.error); return; }
      if (agent.status !== 'succeeded') {
        const resume = agent.status === 'sending' || agent.status === 'unknown';
        if (!resume) agent = await this.actionState(agent, 'sending');
        let result: ScheduleAgentResult;
        if (this.closed) {
          if (!resume) { await this.actionState(agent, 'suppressed', undefined, 'Executor closed before Agent dispatch'); await this.advance(occurrence, 'suppressed', lease); }
          return;
        }
        try { result = await this.options.executeAgent({ ...this.input(mandate, schedule, occurrence, agent.payload.snapshot as CollaborationSnapshot, lease, agent, 'execute'), resume }); }
        catch (error) { result = { status: 'unknown', error: message(error) }; }
        if (result.status === 'pending') {
          if (occurrence.state === 'unknown') await this.advance(occurrence, 'running', lease);
          return;
        }
        if (result.status !== 'completed' || typeof result.text !== 'string') {
          const status = result.status === 'failed' ? 'failed' : 'unknown';
          await this.actionState(agent, status, result.receipt, result.error ?? 'Agent result is not proven');
          // Poll the original task without manufacturing new execution progress for an unchanged unknown result.
          if (occurrence.state !== status) await this.advance(occurrence, status, lease, result.error);
          return;
        }
        if (!delivery) delivery = (await this.begin(mandate, schedule, occurrence, agent.payload.snapshot as CollaborationSnapshot, 'delivery', { text: result.text, delivery: schedule.delivery, snapshot: agent.payload.snapshot }, typeof agent.payload.contextSignature === 'string' ? agent.payload.contextSignature : undefined, typeof agent.payload.coverageSignature === 'string' ? agent.payload.coverageSignature : undefined)).action;
        agent = await this.actionState(agent, 'succeeded', result.receipt ?? 'completed');
      }
      if (!delivery) { await this.advance(occurrence, 'unknown', lease, 'Completed agent result has no persisted delivery content'); return; }
      content = delivery.payload.text as string;
    }
    if (!delivery) delivery = (await this.begin(mandate, schedule, occurrence, snapshot, 'delivery', { text: content, delivery: schedule.delivery, snapshot }, contextSignature, coverageSignature)).action;
    if (delivery.status === 'failed' || delivery.status === 'suppressed') { await this.advance(occurrence, delivery.status === 'failed' ? 'failed' : 'suppressed', lease, delivery.error); return; }
    if (occurrence.state === 'unknown') occurrence = await this.advance(occurrence, 'running', lease);
    const originalSnapshot = delivery.payload.snapshot as CollaborationSnapshot;
    const input = this.input(mandate, schedule, occurrence, originalSnapshot, lease, delivery, 'deliver');
    try {
      await input.assertCurrent();
      const recent = await this.repos.collaboration.listActions(mandate.scope, 500);
      const since = this.now().getTime() - 3_600_000;
      const count = recent.filter(action => action.id !== delivery!.id && action.kind === 'schedule_delivery' && ['sending','succeeded','unknown'].includes(action.status) && Date.parse(action.updatedAt) >= since).length;
      if (count >= originalSnapshot.settings.maxProactivePerHour) throw new RuntimeError('COLLABORATION_BUDGET_EXHAUSTED', 'Group notification budget exhausted', 409);
    } catch (error) {
      await this.actionState(delivery, 'suppressed', undefined, message(error));
      await this.advance(occurrence, 'suppressed', lease, message(error)); return;
    }
    delivery = await this.actionState(delivery, 'sending');
    try {
      if (this.closed) throw stale();
      const result = await this.options.deliver({ ...input, action: delivery, text: delivery.payload.text as string });
      await this.actionState(delivery, 'succeeded', result.receipt);
      await this.advance(occurrence, 'settled', lease);
    } catch (error) {
      const state = error instanceof RuntimeError && ['COLLABORATION_DELIVERY_SUPPRESSED', 'COLLABORATION_EXECUTION_STALE', 'COLLABORATION_BUDGET_EXHAUSTED'].includes(error.code) ? 'suppressed' : 'unknown';
      const current = await this.repos.collaboration.getAction(mandate.scope, delivery.id);
      if (current?.status === 'sending') await this.actionState(current, state, undefined, message(error));
      const currentOccurrence = await this.repos.scheduleOccurrences.get(occurrence.id);
      if (currentOccurrence?.state === 'running') await this.advance(currentOccurrence, state, lease, message(error));
    }
  }
}
