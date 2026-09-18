import { createHash } from 'node:crypto';
import { z } from 'zod';
import { RuntimeError, canonicalExecutionJson, previewNextSchedule, scheduleDeliverySchema, scheduleTriggerSchema, type CollaborationMandate, type CollaborationRepository, type CollaborationScope, type CollaborationSnapshot, type RepositoryBundle, type ScheduleDefinition } from '@dutydeck/shared';

export type CollaborationRepositories = Pick<RepositoryBundle, 'scheduleDefinitions' | 'scheduleGenerations' | 'scheduleOccurrences' | 'scheduleWatermarks' | 'scheduleLeases'> & { collaboration: CollaborationRepository };
export type CollaborationAuthorization = (scope: CollaborationScope, actorId: string, action: 'read' | 'write' | 'manage' | 'execute' | 'deliver') => Promise<boolean>;
export interface CollaborationServiceOptions {
  repositories: CollaborationRepositories;
  authorize: CollaborationAuthorization;
  resolveScheduleScope(scope: CollaborationScope): Promise<{ channelBotId: string; groupBindingId?: string; identityRef: string; secretRef: string }>;
  validateDelivery?: (scope: CollaborationScope, delivery: ScheduleDefinition['delivery']) => Promise<boolean>;
  now?: () => Date;
}
const text = z.string().trim().min(1);
const createMandateSchema = z.object({
  id: text.max(128), goal: text.max(2000), followupId: text.optional(), mode: z.enum(['notify', 'agent']), prompt: text.max(8000),
  condition: z.enum(['always', 'followup_open', 'no_progress']).default('always'), trigger: scheduleTriggerSchema,
  timezone: text, delivery: scheduleDeliverySchema.optional(), catchupPolicy: z.enum(['skip', 'coalesce']).default('coalesce'), sourceRefs: z.array(text).default([])
}).strict();
const updateMandateSchema = z.object({
  expectedRevision: z.number().int().positive(), goal: text.max(2000).optional(), status: z.enum(['active','paused','cancelled','completed']).optional(),
  prompt: text.max(8000).optional(), deliveryPaused: z.boolean().optional(), trigger: scheduleTriggerSchema.optional(), timezone: text.optional(),
  condition: z.enum(['always','followup_open','no_progress']).optional(), catchupPolicy: z.enum(['skip','coalesce']).optional()
}).strict().refine(value => Object.keys(value).length > 1, 'A change is required');
const bindingSchema = z.object({ kind: z.literal('collaboration'), mandateId: text, mandateRevision: z.number().int().positive(), executionDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(), scope: z.object({ appId: text, chatId: text }).strict() }).strict();
export function scheduleMandateBinding(schedule: ScheduleDefinition) {
  if (schedule.sourceNamespace !== 'collaboration') return undefined;
  try { return bindingSchema.parse(JSON.parse(schedule.payloadRef)); } catch { return undefined; }
}
const executionDigest = (mandate: CollaborationMandate) => {
  const { revision: _revision, deliveryPaused: _deliveryPaused, createdAt: _createdAt, updatedAt: _updatedAt, ...execution } = mandate;
  return createHash('sha256').update(canonicalExecutionJson(JSON.parse(JSON.stringify(execution)))).digest('hex');
};
/** UI delivery toggles retain the pinned execution generation; other changes do not. */
export function scheduleMatchesMandate(schedule: ScheduleDefinition, mandate: CollaborationMandate): boolean {
  const pinned = scheduleMandateBinding(schedule);
  return !!pinned && schedule.id === mandate.scheduleDefinitionId && pinned.mandateId === mandate.id && pinned.scope.appId === mandate.scope.appId && pinned.scope.chatId === mandate.scope.chatId && pinned.mandateRevision <= mandate.revision && (pinned.executionDigest ? pinned.executionDigest === executionDigest(mandate) : pinned.mandateRevision === mandate.revision);
}
/** Hash the complete input before model-context truncation; notification toggles are not new evidence. */
export function collaborationContextSignature(snapshot: CollaborationSnapshot): string {
  const { contextRevision: _contextRevision, settings, mandates, bootstrap, ...context } = snapshot;
  const { notificationsPaused: _notificationsPaused, revision: _settingsRevision, updatedAt: _settingsUpdatedAt, ...semanticSettings } = settings;
  const { updatedAt: _bootstrapUpdatedAt, ...semanticBootstrap } = bootstrap ?? {};
  const semanticMandates = mandates.map(({ deliveryPaused: _deliveryPaused, revision: _revision, updatedAt: _updatedAt, ...mandate }) => mandate);
  return createHash('sha256').update(canonicalExecutionJson(JSON.parse(JSON.stringify({ ...context, settings: semanticSettings, mandates: semanticMandates, ...(bootstrap ? { bootstrap: semanticBootstrap } : {}) })))).digest('hex');
}
const binding = (mandate: Pick<CollaborationMandate, 'id' | 'scope' | 'revision'>, digest?: string) => JSON.stringify({ kind: 'collaboration', mandateId: mandate.id, mandateRevision: mandate.revision, scope: mandate.scope, ...(digest ? { executionDigest: digest } : {}) });
const idFor = (scope: CollaborationScope, id: string) => 'collaboration_schedule_' + createHash('sha256').update(JSON.stringify([scope, id])).digest('hex');
const missing = () => new RuntimeError('COLLABORATION_NOT_FOUND', 'Collaboration record not found', 404);
const conflict = () => new RuntimeError('COLLABORATION_REVISION_CONFLICT', 'The record changed; reload before updating', 409);

export class CollaborationService {
  readonly repositories: CollaborationRepositories;
  private readonly locks = new Map<string, Promise<unknown>>();
  constructor(readonly options: CollaborationServiceOptions) { this.repositories = options.repositories; }
  private now() { return this.options.now?.() ?? new Date(); }
  async require(scope: CollaborationScope, actorId: string, action: Parameters<CollaborationAuthorization>[2]) {
    if (!actorId || !await this.options.authorize(scope, actorId, action)) throw new RuntimeError('COLLABORATION_FORBIDDEN', 'Current actor is not authorized', 403);
  }
  private async serial<T>(id: string, work: () => Promise<T>): Promise<T> {
    const current = (this.locks.get(id) ?? Promise.resolve()).catch(() => {}).then(work);
    this.locks.set(id, current);
    try { return await current; } finally { if (this.locks.get(id) === current) this.locks.delete(id); }
  }
  private async command(scope: CollaborationScope, actorId: string, id: string, kind: string, input: unknown) {
    const digest = createHash('sha256').update(canonicalExecutionJson(input)).digest('hex');
    await this.repositories.collaboration.beginAction({ id: `command_${createHash('sha256').update(JSON.stringify([scope,kind,id])).digest('hex')}`, scope, kind: `command:${kind}`, requesterId: actorId, inputDigest: digest, payload: { input } });
  }
  async get(scope: CollaborationScope, actorId: string) {
    await this.require(scope, actorId, 'read');
    const repo = this.repositories.collaboration;
    const [snapshot, followups, records, decisions, actions, activities, feedback] = await Promise.all([repo.snapshot(scope), repo.listFollowups(scope), repo.listMandates(scope), repo.listDecisions(scope), repo.listActions(scope), repo.listActivities(scope), repo.listFeedback(scope)]);
    const mandates = await Promise.all(records.map(async mandate => ({ ...mandate, schedule: await this.repositories.scheduleDefinitions.get(mandate.scheduleDefinitionId), nextDueAt: (await this.repositories.scheduleWatermarks.get(mandate.scheduleDefinitionId))?.nextDueAt })));
    return { snapshot, followups, mandates, decisions, actions, activities, feedback };
  }
  async updateSettings(scope: CollaborationScope, actorId: string, body: Parameters<CollaborationRepository['updateSettings']>[1]) {
    await this.require(scope, actorId, 'manage');
    return { settings: await this.repositories.collaboration.updateSettings(scope, body, actorId) };
  }
  async createFollowup(scope: CollaborationScope, actorId: string, body: unknown, provenance: 'confirmed' | 'inferred' = 'confirmed') {
    await this.require(scope, actorId, 'write');
    const input = z.object({ id: text.max(128), goal: text.max(2000), progress: z.string().max(8000).default(''), steps: z.array(z.object({ id: text, label: text, status: z.enum(['open','done']) }).strict()).default([]), ownerId: text.optional(), dueAt: z.string().datetime({ offset: true }).optional(), sourceRefs: z.array(text).default([]), fields: z.record(z.string()).default({}) }).strict().parse(body);
    await this.command(scope, actorId, input.id, 'create_followup', { ...input, provenance });
    const existing = await this.repositories.collaboration.getFollowup(scope, input.id);
    if (existing) return { followup: existing };
    const followup = await this.repositories.collaboration.createFollowup({ ...input, id: input.id, scope, status: 'open', taskIds: [], externalRefs: [], createdBy: actorId, updatedBy: actorId, provenance });
    return { followup };
  }
  async updateFollowup(scope: CollaborationScope, actorId: string, id: string, body: Parameters<CollaborationRepository['updateFollowup']>[2]) {
    await this.require(scope, actorId, 'write');
    const existing = await this.repositories.collaboration.getFollowup(scope, id); if (!existing) throw missing();
    if (existing.createdBy !== actorId && existing.ownerId !== actorId) await this.require(scope, actorId, 'manage');
    return { followup: await this.repositories.collaboration.updateFollowup(scope, id, body, actorId) };
  }
  private async followup(scope: CollaborationScope, id?: string) {
    if (!id) return undefined;
    const followup = await this.repositories.collaboration.getFollowup(scope, id); if (!followup) throw missing();
    return followup;
  }
  async createMandate(scope: CollaborationScope, actorId: string, body: unknown) {
    await this.require(scope, actorId, 'write');
    const input = createMandateSchema.parse(body), id = input.id;
    return this.serial(idFor(scope, id), async () => {
      await this.command(scope, actorId, id, 'create_mandate', input);
      const previous = await this.repositories.collaboration.getMandate(scope, id);
      if (previous) {
        if (previous.requesterId !== actorId || previous.goal !== input.goal || previous.prompt !== input.prompt || previous.mode !== input.mode) throw conflict();
        return { mandate: previous, schedule: await this.reconcileMandate(previous) };
      }
      const followup = await this.followup(scope, input.followupId);
      if (input.condition !== 'always' && !followup) throw new RuntimeError('COLLABORATION_CONDITION_INVALID', 'This condition requires a follow-up', 400);
      const refs = await this.options.resolveScheduleScope(scope);
      const scheduleId = idFor(scope, id);
      const delivery = input.delivery ?? { mode: 'chat' as const, chatRef: scope.chatId, continuation: 'chat_root' as const };
      if (delivery.chatRef !== scope.chatId || delivery.rootMessageRef && (!this.options.validateDelivery || !await this.options.validateDelivery(scope, delivery))) throw new RuntimeError('COLLABORATION_DESTINATION_CONFLICT', 'Delivery must remain in the authorized chat', 400);
      const definition = { id: scheduleId, ...refs, name: input.goal.slice(0, 200), trigger: input.trigger, timezone: input.timezone, dstPolicy: { gap: 'skip' as const, overlap: 'first' as const }, delivery, payloadRef: binding({ id, scope, revision: 1 }), sourceOwnership: 'dutydeck' as const, sourceNamespace: 'collaboration', sourceScheduleRef: scheduleId, sourceEnabled: false };
      let schedule = await this.repositories.scheduleDefinitions.get(scheduleId);
      if (!schedule) schedule = await this.repositories.scheduleDefinitions.create(definition);
      else if (schedule.payloadRef !== definition.payloadRef || JSON.stringify(schedule.trigger) !== JSON.stringify(input.trigger) || schedule.timezone !== input.timezone || JSON.stringify(schedule.delivery) !== JSON.stringify(delivery)) throw conflict();
      const mandate = await this.repositories.collaboration.createMandate({ id, scope, goal: input.goal, requesterId: actorId, status: 'active', sourceRefs: input.sourceRefs, followupId: input.followupId, scheduleDefinitionId: schedule.id, mode: input.mode, prompt: input.prompt, condition: input.condition, deliveryPaused: false, catchupPolicy: input.catchupPolicy, ...(followup ? { lastProgressRevision: followup.revision } : {}) });
      return { mandate, schedule: await this.reconcileMandate(mandate) };
    });
  }
  async updateMandate(scope: CollaborationScope, actorId: string, id: string, body: unknown) {
    await this.require(scope, actorId, 'write');
    const input = updateMandateSchema.parse(body);
    return this.serial(idFor(scope, id), async () => {
      const mandate = await this.repositories.collaboration.getMandate(scope, id); if (!mandate) throw missing();
      if (mandate.requesterId !== actorId) await this.require(scope, actorId, 'manage');
      if (mandate.revision !== input.expectedRevision) throw conflict();
      if (['cancelled','completed'].includes(mandate.status)) throw new RuntimeError('COLLABORATION_MANDATE_TERMINAL', 'Create a new delegation after termination', 409);
      if (input.condition && input.condition !== 'always' && !mandate.followupId) throw new RuntimeError('COLLABORATION_CONDITION_INVALID', 'This condition requires a follow-up', 400);
      if (Object.keys(input).every(key => key === 'expectedRevision' || key === 'deliveryPaused')) {
        const schedule = await this.repositories.scheduleDefinitions.get(mandate.scheduleDefinitionId); if (!schedule) throw missing();
        // Old definitions lack the execution digest. Upgrade those through the
        // ordinary fenced path once; new definitions preserve running work.
        if (scheduleMandateBinding(schedule)?.executionDigest && scheduleMatchesMandate(schedule, mandate)) {
          const changed = await this.repositories.collaboration.updateMandate(scope, id, input, actorId);
          return { mandate: changed, schedule };
        }
      }
      // Across processes only one mutation payload may prepare a given revision.
      // Otherwise one request could commit a mandate over another request's trigger.
      await this.command(scope, actorId, `${id}:${input.expectedRevision}`, 'update_mandate', input);
      const old = await this.repositories.scheduleDefinitions.get(mandate.scheduleDefinitionId); if (!old) throw missing();
      // The schedule first becomes non-executable and points to the future mandate revision.
      // A crash after the mandate commit can recover the already-persisted trigger.
      const { trigger: _trigger, timezone: _timezone, expectedRevision, ...patch } = input;
      const followup = (patch.condition ?? mandate.condition) === 'no_progress' ? await this.followup(scope, mandate.followupId) : undefined;
      const changes = { ...patch, goal: patch.goal ?? mandate.goal, ...(followup ? { lastProgressRevision: followup.revision } : {}) };
      const target = { ...mandate, ...changes, revision: mandate.revision + 1 };
      const prepared = await this.repositories.scheduleDefinitions.update(old.id, { expectedRevision: old.revision, state: 'disabled', payloadRef: binding(target, executionDigest(target)), ...(input.trigger ? { trigger: input.trigger } : {}), ...(input.timezone ? { timezone: input.timezone } : {}), ...(input.goal ? { name: input.goal.slice(0, 200) } : {}) });
      const changed = await this.repositories.collaboration.updateMandate(scope, id, { ...changes, expectedRevision }, actorId);
      return { mandate: changed, schedule: await this.reconcileMandate(changed, prepared) };
    });
  }
  async reconcileMandate(mandate: CollaborationMandate, known?: ScheduleDefinition): Promise<ScheduleDefinition | undefined> {
    const schedule = known ?? await this.repositories.scheduleDefinitions.get(mandate.scheduleDefinitionId);
    if (!schedule) return undefined;
    if (!scheduleMatchesMandate(schedule, mandate)) return schedule;
    if (mandate.status !== 'active') return schedule.state === 'disabled' ? schedule : this.repositories.scheduleDefinitions.update(schedule.id, { expectedRevision: schedule.revision, state: 'disabled' });
    if (schedule.state === 'enabled') return schedule;
    await this.require(mandate.scope, mandate.requesterId, 'execute');
    const nextDueAt = previewNextSchedule(schedule, this.now())?.scheduledForUtc;
    return this.repositories.scheduleDefinitions.update(schedule.id, { expectedRevision: schedule.revision, state: 'enabled', payloadRef: binding(mandate, executionDigest(mandate)), nextDueAt: nextDueAt ?? null });
  }
}
