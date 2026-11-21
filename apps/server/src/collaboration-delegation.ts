import { digest } from '@dutydeck/runtime/digest';
import { canonicalExecutionJson, RuntimeError, type CollaborationAction, type CollaborationMandate, type CollaborationSnapshot, type ScheduleDefinition, type ScheduleLease } from '@dutydeck/shared';
import { scheduleWriterLeaseKey } from '@dutydeck/storage/helpers';
import { scheduleMatchesMandate, type CollaborationAuthorization, type CollaborationRepositories } from './collaboration-service.js';

export const delegationRevoked = () => new RuntimeError('COLLABORATION_EXECUTION_REVOKED', '该后台委托已变更、暂停或失去授权。', 403);
export const delegationStale = () => new RuntimeError('COLLABORATION_EXECUTION_STALE', 'Delegation, context or authorization changed', 409);
export const leaseLost = () => new RuntimeError('SCHEDULE_LEASE_CONFLICT', 'Schedule writer lease expired or was replaced', 409);
export const bootstrapSignature = (snapshot: CollaborationSnapshot) => digest({ status: snapshot.bootstrap?.status ?? null, missing: snapshot.bootstrap?.missing ?? [] });

export async function assertCollaborationWriter(repos: CollaborationRepositories, schedule: ScheduleDefinition, lease: ScheduleLease, holderId: string, now: () => Date) {
  const writer = await repos.scheduleLeases.getByKey(lease.leaseKey);
  if (lease.leaseKey !== scheduleWriterLeaseKey(schedule.channelBotId) || writer?.state !== 'held' || writer.holderId !== holderId
    || writer.fenceToken !== lease.fenceToken || !writer.expiresAt || writer.expiresAt <= now().toISOString()) throw leaseLost();
}

type DelegationCheck = { phase: 'runtime'; record: CollaborationAction } | {
  phase: 'execute' | 'deliver'; mandate: CollaborationMandate; schedule: ScheduleDefinition; snapshot: CollaborationSnapshot;
  lease: ScheduleLease; holderId: string; now(): Date; closed(): boolean; coverageSignature?: string;
};

function validGeneration(definition: ScheduleDefinition | undefined, mandate: CollaborationMandate, generation: number | undefined) {
  return definition?.state === 'enabled' && definition.currentGeneration === generation && scheduleMatchesMandate(definition, mandate);
}

function executionSettings({ notificationsPaused, revision, updatedAt, ...settings }: CollaborationSnapshot['settings']) {
  return settings;
}

/** Runtime authorizes the admitted task at prepare and submit. The scheduler owns the writer lease. */
export async function assertCollaborationDelegation(repos: CollaborationRepositories, authorize: CollaborationAuthorization | undefined, check: DelegationCheck): Promise<void> {
  let mandate: CollaborationMandate;
  let assertWriter: (() => Promise<void>) | undefined;
  if (check.phase === 'runtime') {
    const { record } = check;
    if (record.status === 'suppressed') throw delegationRevoked();
    const current = record.mandateId && await repos.collaboration.getMandate(record.scope, record.mandateId);
    if (!current || current.status !== 'active' || current.requesterId !== record.requesterId) throw delegationRevoked();
    const definition = await repos.scheduleDefinitions.get(current.scheduleDefinitionId);
    if (!validGeneration(definition, current, record.scheduleGeneration)) throw delegationRevoked();
    mandate = current;
  } else {
    const { schedule, snapshot, mandate: frozen } = check;
    assertWriter = () => assertCollaborationWriter(repos, schedule, check.lease, check.holderId, check.now);
    await assertWriter();
    if (check.closed()) throw delegationStale();
    const [current, definition, latest] = await Promise.all([
      repos.collaboration.getMandate(frozen.scope, frozen.id), repos.scheduleDefinitions.get(schedule.id), repos.collaboration.snapshot(frozen.scope)
    ]);
    const readiness = definition && await repos.scheduleDefinitions.readiness(definition.id, check.now().toISOString());
    await assertWriter();
    if (!readiness?.executionEligible || !current || current.status !== 'active' || !scheduleMatchesMandate(schedule, frozen)
      || !validGeneration(definition, current, schedule.currentGeneration) || definition?.delivery.chatRef !== current.scope.chatId) throw delegationStale();
    if (canonicalExecutionJson(executionSettings(latest.settings)) !== canonicalExecutionJson(executionSettings(snapshot.settings))) throw delegationStale();
    // Appended messages do not revoke the frozen result. Changed coverage or paused delivery does.
    if (check.phase === 'deliver' && (current.deliveryPaused || latest.settings.notificationsPaused
      || bootstrapSignature(latest) !== (check.coverageSignature ?? bootstrapSignature(snapshot)))) throw delegationStale();
    mandate = current;
  }

  const frozen = check.phase === 'runtime' ? check.record : check.mandate;
  const allowed = await authorize?.(frozen.scope, frozen.requesterId, check.phase === 'deliver' ? 'deliver' : 'execute');
  if (assertWriter) await assertWriter();
  const invalid = check.phase === 'runtime' ? delegationRevoked : delegationStale;
  if (!allowed) throw invalid();
  const followup = mandate.followupId ? await repos.collaboration.getFollowup(mandate.scope, mandate.followupId) : undefined;
  if (assertWriter) await assertWriter();
  if (check.phase === 'runtime') {
    const { record } = check;
    if (mandate.followupId && (!followup || (record.followupRevision !== undefined && record.followupRevision !== followup.revision)
      || (mandate.condition !== 'always' && followup.status !== 'open'))) throw invalid();
    const latest = await repos.collaboration.getAction(record.scope, record.id);
    if (!latest || latest.status === 'suppressed') throw invalid();
  } else {
    if (mandate.condition !== 'always' && followup?.status !== 'open') throw invalid();
    if (check.phase === 'deliver' && mandate.followupId && followup?.revision !== check.snapshot.followups.find(item => item.id === mandate.followupId)?.revision) throw invalid();
    if (mandate.condition === 'no_progress' && followup?.revision !== mandate.lastProgressRevision) throw invalid();
    if (check.closed()) throw invalid();
  }
}
