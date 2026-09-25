import { z } from 'zod';
import type { AgentEvent, EventWindowOptions, Session, TaskExecutionContext, TaskRecord } from './index.js';
import type { RuntimeControlClaim } from './database-control.js';
import type { DriverTurnRecovery } from './driver.js';
import { nativeContextExpectedSchema, nativeContextRefSchema, resourceOperationScopeSchema, type ResourceOperationScope, type NativeContextExpected, type NativeContextIdentity, type NativeContextRef, type NativeContextSelection, type NativeContextBinding, type NativeContextReplacement } from './driver-resources.js';

export const taskStatuses = ['queued', 'running', 'reconcile_required', 'completed', 'failed', 'interrupted', 'cancelled'] as const;
export type TaskStatus = typeof taskStatuses[number];
export const attemptStates = ['preparing', 'active', 'suspended', 'reconcile_required', 'legacy_unresolved', 'settled'] as const;
export type AttemptState = typeof attemptStates[number];
export type SubmissionState = 'not_submitted' | 'intent_recorded' | 'acknowledged' | 'legacy_unknown';
export type AttemptOutcome = 'completed' | 'failed' | 'interrupted' | 'cancelled' | 'unknown';
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
/** Reject lossy JSON coercion, accessors, cycles, sparse arrays and non-plain objects. */
export function canonicalExecutionJson(value: unknown): string {
  const seen = new Set<object>();
  const visit = (item: unknown): string => {
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return JSON.stringify(item);
    if (typeof item === 'number' && Number.isFinite(item)) return JSON.stringify(item);
    if (!item || typeof item !== 'object' || seen.has(item)) throw new Error('EXECUTION_INVALID_JSON');
    seen.add(item);
    try {
      if (Array.isArray(item)) {
        if (Object.getPrototypeOf(item) !== Array.prototype || Reflect.ownKeys(item).length !== item.length + 1) throw new Error('EXECUTION_INVALID_JSON');
        const values: string[] = [];
        for (let index = 0; index < item.length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
          if (!descriptor || !('value' in descriptor)) throw new Error('EXECUTION_INVALID_JSON');
          values.push(visit(descriptor.value));
        }
        return '[' + values.join(',') + ']';
      }
      if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new Error('EXECUTION_INVALID_JSON');
      if (Object.getOwnPropertySymbols(item).length) throw new Error('EXECUTION_INVALID_JSON');
      if (Object.getOwnPropertyNames(item).length !== Object.keys(item).length) throw new Error('EXECUTION_INVALID_JSON');
      const fields = Object.keys(item).sort().map(key => {
        const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
        if (!('value' in descriptor)) throw new Error('EXECUTION_INVALID_JSON');
        return `${JSON.stringify(key)}:${visit(descriptor.value)}`;
      });
      return '{' + fields.join(',') + '}';
    } finally { seen.delete(item); }
  };
  return visit(value);
}
export const executionJsonSchema = z.custom<JsonValue>(value => { try { canonicalExecutionJson(value); return true; } catch { return false; } });
const id = z.string().min(1).max(1024);
export const executionDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const executionActorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('installation_owner'), id: z.literal('installation_owner') }).strict(),
  z.object({ kind: z.literal('channel'), id, appId: id }).strict(),
  z.object({ kind: z.literal('unspecified') }).strict()
]);
export type ExecutionActor = z.infer<typeof executionActorSchema>;
export const taskRequestV1Schema = z.object({
  version: z.literal(1), namespace: z.enum(['runtime', 'lark', 'work_item', 'automation', 'schedule']), key: id, sessionId: id,
  actor: executionActorSchema, prompt: z.string(), mode: z.enum(['queue', 'interrupt']), skills: z.array(id),
  options: z.object({ model: id.optional(), reasoningEffort: id.optional(), permissionMode: z.enum(['ask', 'approve-reads', 'deny-all', 'full-trust']).optional() }).strict(),
  sources: z.array(z.object({ kind: id, id, version: id.optional(), digest: id.optional() }).strict()), sourcePayload: executionJsonSchema
}).strict();
export type TaskRequestV1 = z.infer<typeof taskRequestV1Schema>;
export interface AcceptedTaskInputV1 {
  version: 1; prompt: string; executionContext: TaskExecutionContext;
  contentSources: Array<{ kind: string; id: string; version?: string; digest: string }>;
  digest: string;
}
const recoverySchema = z.object({ kind: z.literal('pty-jsonl-v1'), turnId: id, transcript: z.object({ path: id.optional(), offset: z.number().int().nonnegative() }).strict() }).strict();
export const acceptedTaskInputV1Schema = z.object({
  version: z.literal(1), prompt: z.string(),
  executionContext: z.object({ actorId: id.optional(), agentPrompt: z.string(),
    skillDeliveries: z.array(z.object({ name: id, path: id, source: z.enum(['workspace', 'user']), digest: id, mode: z.literal('prompt') }).strict()).optional(),
    riskPolicy: z.object({ enabled: z.boolean(), authorized: z.boolean(), pattern: z.string(), actorEmail: z.string().optional(), reason: z.string().optional() }).strict().optional(),
    recovery: recoverySchema.optional()
  }).strict(),
  contentSources: z.array(z.object({ kind: id, id, version: id.optional(), digest: executionDigestSchema }).strict()), digest: executionDigestSchema
}).strict();
export const taskExecutionOptionsSchema = z.object({
  model: id.optional(), reasoningEffort: id.optional(),
  permissionMode: z.enum(['ask', 'approve-reads', 'deny-all', 'full-trust'])
}).strict();
export type TaskExecutionOptions = z.infer<typeof taskExecutionOptionsSchema>;
export interface AcceptedTaskInputV2 extends Omit<AcceptedTaskInputV1, 'version'> {
  version: 2;
  executionOptions: TaskExecutionOptions;
}
export type AcceptedTaskInput = AcceptedTaskInputV1 | AcceptedTaskInputV2;
export const acceptedTaskInputV2Schema = acceptedTaskInputV1Schema.extend({ version: z.literal(2), executionOptions: taskExecutionOptionsSchema });
export const acceptedTaskInputSchema = z.discriminatedUnion('version', [acceptedTaskInputV1Schema, acceptedTaskInputV2Schema]);
export const taskAdmissionV1Schema = executionJsonSchema.pipe(z.discriminatedUnion('kind', [
  z.object({ version: z.literal(1), kind: z.literal('canonical'), taskIdVersion: z.literal('v1'), taskId: id, request: taskRequestV1Schema }).strict(),
  z.object({ version: z.literal(1), kind: z.literal('legacy_partial'), taskIdVersion: z.enum(['legacy', 'v1']), taskId: id, request: taskRequestV1Schema.optional() }).strict()
]));
export type TaskAdmissionV1 = z.infer<typeof taskAdmissionV1Schema>;
export const attemptResultV1Schema = executionJsonSchema.pipe(z.object({
  version: z.literal(1), taskId: id, attemptId: id, settlementId: id, throughSequence: z.number().int().positive().safe(),
  outcome: z.enum(['completed', 'failed', 'interrupted', 'cancelled']),
  output: z.object({ text: z.string(), digest: executionDigestSchema }).strict()
}).strict());
export type AttemptResultV1 = z.infer<typeof attemptResultV1Schema>;
export interface AttemptRef { taskId: string; attemptId: string }
export interface SessionFence { sessionId: string; runId: string }
export interface AttemptFence extends SessionFence, AttemptRef { expectedRevision: number }
export interface ExecutionController { accessId: string; instanceId: string; generation: number }
export interface ResourceRef { resourceId: string; identityId: string }
export interface ResourceCheckRef { resourceId: string; expectedRevision: number; observationId: string }
export interface SubmissionIntent {
  submissionId: string; inputDigest: string; resourceRefs: ResourceRef[];
  recovery?: DriverTurnRecovery; authorizationRefs: string[];
  nativeContextRef?: NativeContextRef; contextProofId?: string; driverInstanceId?: string;
}
export interface SubmissionReceipt { submissionId: string; kind: 'provider_accepted'; provider: string; receiptRef: string; digest: string }
export interface RecoveryDecisionInput {
  decisionId: string; actor: ExecutionActor; action: 'cancel' | 'confirm_result' | 'retry';
  evidenceRefs: string[]; resourceChecks: ResourceCheckRef[]; allowDuplicateEffects?: boolean;
}
export type SettlementEvidence =
  | { kind: 'driver_result'; submissionId: string; outcome: 'completed' | 'failed' | 'interrupted'; outputDigest: string; stopReason: string; complete: true }
  | { kind: 'not_submitted'; outcome: 'failed' | 'cancelled'; reason: string }
  | { kind: 'manual'; outcome: AttemptOutcome; decision: RecoveryDecisionInput; verifiedOutput?: { eventId: string; digest: string } };
export interface ReconcileReason { reasonId: string; code: string; evidenceRefs: string[] }
export type RecoveryEvidence =
  | { kind: 'unsubmitted_preparation'; decisionId: string; safeResources: ResourceCheckRef[] }
  | { kind: 'original_turn'; decisionId: string; submissionId: string; recovery: DriverTurnRecovery; resources: ResourceCheckRef[]; attached: boolean };
export interface TaskAttempt extends AttemptRef, SessionFence {
  number: number; revision: number; state: AttemptState; submissionState: SubmissionState;
  controller: ExecutionController; recoveryControllers: Array<{ controller: ExecutionController; evidence: RecoveryEvidence }>;
  submissionController?: ExecutionController; submission?: SubmissionIntent; receipt?: SubmissionReceipt;
  settlementId?: string; outcome?: AttemptOutcome; settlement?: SettlementEvidence; reconcileReason?: ReconcileReason;
  legacy?: JsonValue; createdAt: string; updatedAt: string;
}
export interface ExecutionTask extends Omit<TaskRecord, 'status' | 'revision' | 'digestVersion'> {
  status: TaskStatus; revision: number; digestVersion: 'v1' | 'legacy_unverifiable'; currentAttemptId?: string;
}
export interface ExecutionBlocker { code: string; sessionId: string; taskId?: string; resourceId?: string; detail?: string }
export interface AcceptedTask { task: ExecutionTask; input?: AcceptedTaskInput; request?: TaskRequestV1; requestDigest?: string; replayValidation: 'complete' | 'legacy_partial' }
export interface CommitResult {
  task?: ExecutionTask; attempt?: TaskAttempt; session: Session; events: AgentEvent[]; replayed: boolean; blockers: ExecutionBlocker[];
  accepted?: AcceptedTask;
}
export interface QueueOperationInput { operationId: string; actor: ExecutionActor; interrupt: boolean }
/** A queued Task delivered through `_session/steering` into a submitted Attempt instead of its own turn. */
export interface SteeringDeliveryInput { operationId: string; actor: ExecutionActor; target: AttemptRef; outcome: 'injected' | 'startedNewTurn' }
/** Only interactive Tasks can be steered: work-item, automation and schedule consumers settle through the Task's own Attempt. */
export const steerableTaskNamespace: TaskRequestV1['namespace'] = 'runtime';
export interface QueueAction extends SessionFence {
  operationId: string; source: 'accept' | 'promote' | 'interrupt'; taskId: string; actor: ExecutionActor; interrupt: boolean; target?: AttemptRef & { runId: string };
  revision: number; state: 'pending' | 'applied' | 'blocked' | 'obsolete'; evidence?: QueueActionEvidence;
}
export interface QueueActionEvidence { evidenceId: string; state: 'applied' | 'blocked' | 'obsolete'; reason: string; resourceChecks: ResourceCheckRef[] }
export type PhysicalResourceKind = 'process' | 'process_group' | 'tmux' | 'remote' | 'local_only' | 'legacy';
export interface ResourceIdentity { identityId: string; kind: PhysicalResourceKind; locator: JsonValue }
export interface ResourceObservation { observationId: string; state: 'live' | 'gone' | 'unknown'; identityId?: string; evidenceRef: string; observedAt: string }
export interface ResourceCreatorIdentity {
  host: string; boot: string; namespace: string; pid: number; start: string;
}
export interface ResourceCreationProvenance {
  protocol: 'dutydeck_driver_resources_v1'; databaseEntity: string;
  controller: ExecutionController; creator: ResourceCreatorIdentity; driverInstanceId: string;
}
export interface ResourceCreationClosure {
  closureId: string; provenanceDigest: string; expectedRevision: number;
  validator: ExecutionController;
  evidence: { version: 1; state: 'dead'; creator: ResourceCreatorIdentity; observer: ResourceCreatorIdentity; observedAt: string };
}
export interface DriverResource extends SessionFence {
  resourceId: string; parentResourceId?: string; kind: 'operation' | PhysicalResourceKind; revision: number;
  controller: ExecutionController; holder?: ExecutionController; stage: 'pending' | 'created' | 'not_created' | 'unknown';
  identity?: ResourceIdentity; observations: ResourceObservation[]; createdAt: string;
  creationProvenance?: ResourceCreationProvenance; creationClosure?: ResourceCreationClosure;
  driverInstanceId?: string; operationScope?: ResourceOperationScope;
  purpose?: 'acp_native_context'; nativeExpected?: NativeContextExpected;
  nativeBindings?: NativeContextBinding[]; nativeReplacement?: NativeContextReplacement;
}
export type SessionExecutionPatch = Partial<Pick<Session, 'state' | 'archivedAt'>> & { error?: string | null };
export interface SessionWorkspaceProof { expectedCwd: string; workspaceRevision: number; workspaceDigest: string }
export type SessionStatePatch = Pick<Session, 'state'> & { error?: string | null };
export interface ExecutionEventInput { id: string; type: AgentEvent['type']; data: JsonValue; sourceId?: string; timestamp?: string; raw?: string }
export interface TaskExecutionProjection { task: ExecutionTask; currentAttempt?: TaskAttempt; attempts: TaskAttempt[]; blockers: ExecutionBlocker[] }
export interface BoundExecutionRepository {
  lookupAccepted(request: TaskRequestV1): AcceptedTask | undefined;
  acceptTask(f: SessionFence, request: TaskRequestV1, input: AcceptedTaskInputV2, position: 'front' | 'back'): CommitResult;
  claimNext(f: SessionFence): CommitResult | undefined;
  promoteQueued(f: SessionFence, taskId: string, expectedTaskRevision: number, operation: QueueOperationInput): CommitResult;
  deliverQueuedBySteering(f: SessionFence, taskId: string, expectedTaskRevision: number, input: SteeringDeliveryInput): CommitResult;
  getPendingQueueActions(f: SessionFence): QueueAction[];
  settleQueueAction(f: SessionFence, operationId: string, expectedRevision: number, evidence: QueueActionEvidence): QueueAction;
  markSubmissionPending(f: AttemptFence, input: SubmissionIntent): CommitResult;
  markSubmitted(f: AttemptFence, receipt: SubmissionReceipt): CommitResult;
  settleAttempt(f: AttemptFence, settlementId: string, evidence: SettlementEvidence): CommitResult;
  confirmAttemptRecovery(f: AttemptFence, settlementId: string, evidence: Extract<SettlementEvidence, { kind: 'manual' }>, verifiedOutputText?: string): CommitResult;
  suspendUnsubmitted(f: AttemptFence): CommitResult;
  cancelQueued(f: SessionFence, taskId: string, expectedTaskRevision: number, decision: RecoveryDecisionInput): CommitResult;
  markReconcileRequired(f: AttemptFence, reason: ReconcileReason): CommitResult;
  markOrphanedAttempt(f: AttemptFence, reason: ReconcileReason): CommitResult;
  recoverAttempt(f: AttemptFence, evidence: RecoveryEvidence): CommitResult;
  retryAttempt(f: AttemptFence, decision: RecoveryDecisionInput, safeResources: ResourceCheckRef[]): CommitResult;
  appendEvent(f: SessionFence | AttemptFence, event: ExecutionEventInput): AgentEvent;
  patchSession(f: SessionFence, patch: SessionExecutionPatch): Session;
  finalizeSessionWorkspace(f: SessionFence, proof: SessionWorkspaceProof): Session;
  recordInterruptIntent(f: AttemptFence, input: { operationId: string; actor: ExecutionActor }): CommitResult & { action: QueueAction };
  patchSessionState(f: SessionFence | AttemptFence, operationId: string, patch: SessionStatePatch): CommitResult;
  createSession(session: Session): Session;
  replaceSessionRun(f: SessionFence, newRunId: string, safeResources: ResourceCheckRef[]): Session;
  beforeCreate(f: SessionFence, input: { resourceId: string; kind: DriverResource['kind']; parentResourceId?: string }): DriverResource;
  /** Reserved for Runtime's controlled driver protocol; never exposed to drivers or legacy bridges. */
  beforeControlledOperation(f: SessionFence, input: { resourceId: string; driverInstanceId: string; parentResourceId?: string; scope?: ResourceOperationScope }): DriverResource;
  reserveNativeContext(f: SessionFence, input: { resourceId: string; parentResourceId: string; expected: NativeContextExpected }): DriverResource;
  confirmRecoveredNativeContext(f: SessionFence, resourceId: string, expectedRevision: number, identity: NativeContextIdentity): NativeContextSelection;
  assertDriverSubmission(f: SessionFence, input: {taskId:string;attemptId:string;submissionId:string;driverInstanceId:string;inputDigest:string}): void;
  authorizeNativeContextControl(f: SessionFence, actor: ExecutionActor): void;
  probePhysicalResource(f: SessionFence, resourceId: string, expectedRevision: number): DriverResource;
  clearVerifiedStopBlock(f: SessionFence, expectedValue: string): boolean;
  confirmNativeContext(f: SessionFence, resourceId: string, expectedRevision: number, identity: NativeContextIdentity): NativeContextSelection;
  confirmNativeContextRestore(f: SessionFence, input: { operationId: string; context: NativeContextRef; expectedRevision: number; selectionRevision: number; proofId: string; identity: NativeContextIdentity }): NativeContextBinding;
  replaceNativeContext(f: SessionFence, decision: NativeContextReplacement): void;
  closeAbandonedCreation(f: SessionFence, resourceId: string, expectedRevision: number): DriverResource;
  spawned(f: SessionFence, resourceId: string, expectedRevision: number, identity: ResourceIdentity): DriverResource;
  creationFinished(f: SessionFence, resourceId: string, expectedRevision: number, result: 'created' | 'not_created' | 'unknown'): DriverResource;
  observed(f: SessionFence, resourceId: string, expectedRevision: number, observation: ResourceObservation): DriverResource;
}
export interface ExecutionUpgradeCounts {
  tasks: number;
  attempts: number;
  resources: number;
  registeredAccess: number;
}
export interface ExecutionUpgradeSnapshot {
  before: {
    authority: 'legacy' | 'ledger_v1';
    counts: ExecutionUpgradeCounts;
  };
  after: {
    authority: 'legacy' | 'ledger_v1';
    counts: ExecutionUpgradeCounts;
  };
  blockers: ExecutionBlocker[];
  legacy: { unresolvedSessions: number; retiredSessions: number; evidenceIncomplete: number };
}
export type LegacyRetirementEvidence =
  | {
      kind: 'pty_tmux_absent'; socketPath: string; targetName: string; owner: string;
      outcome: 'already_missing' | 'stopped_owned'; targetId?: string;
      paneProcesses: ResourceCreatorIdentity[];
    }
  | {
      kind: 'acp_recorded_agent_pid_absent'; recordPath: string; acpxRecordId: string;
      pid: number; agentStartedAt: string;
    };
export interface LegacyRetirementReceipt extends SessionFence {
  version: 1; receiptId: string; databaseEntity: string; snapshotDigest: string;
  protocol: 'pty-cli' | 'acp'; verifiedAt: string; archivedAt: string;
  verifier: { hostname: string; uid: number; process: ResourceCreatorIdentity };
  evidence: LegacyRetirementEvidence;
}
export interface LegacyRetirementCandidate extends SessionFence {
  databaseEntity: string; snapshotDigest: string; agentId: string; cwd: string;
  protocol?: Session['protocol']; state: Session['state']; archivedAt?: string;
  receipt?: LegacyRetirementReceipt; blockers: ExecutionBlocker[];
}
export interface LegacyRetirementResult {
  session: Session; receipt: LegacyRetirementReceipt; replayed: boolean;
}
export interface LegacyRetirementMaintenance {
  listCandidates(): LegacyRetirementCandidate[];
  retireSession(receipt: LegacyRetirementReceipt): LegacyRetirementResult;
  close(): void;
}
export interface ExecutionRepository {
  authority(): 'legacy' | 'ledger_v1';
  upgradeLegacy(): ExecutionUpgradeSnapshot;
  beginLegacyRetirement(): LegacyRetirementMaintenance;
  bind(claim: RuntimeControlClaim): BoundExecutionRepository;
  lookupAccepted(request: TaskRequestV1): AcceptedTask | undefined;
  getAcceptedTask(taskId: string): AcceptedTask | undefined;
  getTaskExecution(taskId: string): TaskExecutionProjection | undefined;
  getAttemptEvents(attemptId: string, window?: EventWindowOptions): AgentEvent[];
  getSessionResourceBlockers(sessionId: string): ExecutionBlocker[];
  getResources(sessionId: string): DriverResource[];
  getNativeContext(sessionId: string): { selection: NativeContextSelection; resource: DriverResource } | undefined;
}

const resourceChecksSchema = z.array(z.object({ resourceId: id, expectedRevision: z.number().int().positive().safe(), observationId: id }).strict());
const decisionSchema = z.object({ decisionId: id, actor: executionActorSchema, action: z.enum(['cancel', 'confirm_result', 'retry']), evidenceRefs: z.array(id).min(1), resourceChecks: resourceChecksSchema, allowDuplicateEffects: z.boolean().optional() }).strict();
const physicalKinds = ['process', 'process_group', 'tmux', 'remote', 'local_only', 'legacy'] as const;
const fenceSchema = z.object({ sessionId: id, runId: id }).strict();
const controllerSchema = z.object({ accessId: id, instanceId: id, generation: z.number().int().nonnegative().safe() }).strict();
const activeControllerSchema = controllerSchema.extend({ generation: z.number().int().positive().safe() });
const creatorIdentitySchema = z.object({ host: id, boot: id, namespace: id, pid: z.number().int().positive().safe(), start: id }).strict();
const creationProvenanceSchema = z.object({
  protocol: z.literal('dutydeck_driver_resources_v1'), databaseEntity: id,
  controller: activeControllerSchema, creator: creatorIdentitySchema, driverInstanceId: id
}).strict();
const nativeIdentitySchema = nativeContextExpectedSchema.extend({ acpxRecordId: id, backendSessionId: id, agentSessionId: id.optional(), defaults: z.object({model:id.optional(),reasoningEffort:id.optional()}).strict() }).strict();
const nativeSelectionSchema = z.object({version:z.literal(1),revision:z.number().int().positive().safe(),runId:id,context:nativeContextRefSchema}).strict();
const nativeBindingSchema = fenceSchema.extend({proofId:id,context:nativeContextRefSchema,driverInstanceId:id,operationId:id,controller:activeControllerSchema,observedAt:z.string().datetime()}).strict();
const nativeReplacementSchema = z.object({decisionId:id,actor:executionActorSchema,resourceId:id,expectedRevision:z.number().int().positive().safe()}).strict();
const creationClosureSchema = z.object({
  closureId: id, provenanceDigest: executionDigestSchema, expectedRevision: z.number().int().positive().safe(), validator: activeControllerSchema,
  evidence: z.object({ version: z.literal(1), state: z.literal('dead'), creator: creatorIdentitySchema, observer: creatorIdentitySchema, observedAt: z.string().datetime() }).strict()
}).strict();
const legacyRetirementEvidenceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('pty_tmux_absent'), socketPath: id, targetName: id, owner: id,
    outcome: z.enum(['already_missing', 'stopped_owned']), targetId: id.optional(),
    paneProcesses: z.array(creatorIdentitySchema)
  }).strict(),
  z.object({
    kind: z.literal('acp_recorded_agent_pid_absent'), recordPath: id, acpxRecordId: id,
    pid: z.number().int().positive().safe(), agentStartedAt: z.string().datetime()
  }).strict()
]);
const legacyRetirementReceiptSchema = fenceSchema.extend({
  version: z.literal(1), receiptId: id, databaseEntity: id, snapshotDigest: executionDigestSchema,
  protocol: z.enum(['pty-cli', 'acp']), verifiedAt: z.string().datetime(), archivedAt: z.string().datetime(),
  verifier: z.object({
    hostname: id, uid: z.number().int().nonnegative().safe(), process: creatorIdentitySchema
  }).strict(),
  evidence: legacyRetirementEvidenceSchema
}).strict();
export const taskExecutionSchemas = {
  nativeRestore: z.object({operationId:id,context:nativeContextRefSchema,expectedRevision:z.number().int().positive().safe(),selectionRevision:z.number().int().positive().safe(),proofId:id,identity:nativeIdentitySchema}).strict(),
  driverSubmission: z.object({taskId:id,attemptId:id,submissionId:id,driverInstanceId:id,inputDigest:executionDigestSchema}).strict(),
  creatorIdentitySchema, legacyRetirementReceiptSchema, nativeReserve: z.object({resourceId:id,parentResourceId:id,expected:nativeContextExpectedSchema}).strict(),
  nativeIdentitySchema, nativeSelectionSchema, nativeBindingSchema, nativeReplacementSchema, nativeContextExpectedSchema, nativeContextRefSchema,
  id, revision: z.number().int().positive().safe(), fenceSchema,
  attemptFenceSchema: fenceSchema.extend({ taskId: id, attemptId: id, expectedRevision: z.number().int().positive().safe() }),
  checksSchema: resourceChecksSchema, decisionSchema,
  identitySchema: z.object({ identityId: id, kind: z.enum(physicalKinds), locator: executionJsonSchema }).strict(),
  observationSchema: z.object({ observationId: id, state: z.enum(['live', 'gone', 'unknown']), identityId: id.optional(), evidenceRef: id, observedAt: z.string().datetime() }).strict(),
  intentSchema: z.object({ submissionId: id, inputDigest: executionDigestSchema, resourceRefs: z.array(z.object({ resourceId: id, identityId: id }).strict()), recovery: recoverySchema.optional(), authorizationRefs: z.array(id), nativeContextRef:nativeContextRefSchema.optional(),contextProofId:id.optional(),driverInstanceId:id.optional() }).strict(),
  sessionSchema: z.object({ id, agentId: id, state: z.enum(['created','starting','idle','thinking','running_tool','waiting_for_permission','interrupting','interrupted','completed','failed','stopped']), cwd: id, runId: id, createdAt: z.string().datetime(), updatedAt: z.string().datetime(), model: z.string().optional(), reasoningEffort: z.string().optional(), systemPrompt: z.string().optional(), permissionMode: z.enum(['ask','approve-reads','deny-all','full-trust']).optional(), source: id.optional(), sourceId: id.optional(), archivedAt: z.string().optional(), protocol: z.enum(['acp','jsonl','pipe','pty','pty-cli']).optional(), error: z.string().optional(), workspaceMode: z.enum(['shared','worktree']).optional(), workspaceSourceCwd: id.optional() }).strict(),
  driverResult: z.object({ kind:z.literal('driver_result'), submissionId:id, outcome:z.enum(['completed','failed','interrupted']), outputDigest:executionDigestSchema, stopReason:id, complete:z.literal(true) }).strict(),
  notSubmitted: z.object({ kind:z.literal('not_submitted'), outcome:z.enum(['failed','cancelled']), reason:id }).strict(),
  manual: z.object({ kind:z.literal('manual'), outcome:z.enum(['completed','failed','interrupted','cancelled','unknown']), decision:decisionSchema, verifiedOutput:z.object({eventId:id,digest:executionDigestSchema}).strict().optional() }).strict(),
  position: z.enum(['front','back']),
  queueOperation: z.object({ operationId:id, actor:executionActorSchema, interrupt:z.boolean() }).strict(),
  steeringDelivery: z.object({ operationId:id, actor:executionActorSchema, target:z.object({ taskId:id, attemptId:id }).strict(), outcome:z.enum(['injected','startedNewTurn']) }).strict(),
  queueEvidence: z.object({ evidenceId:id, state:z.enum(['applied','blocked','obsolete']), reason:id, resourceChecks:resourceChecksSchema }).strict(),
  receipt: z.object({ submissionId:id, kind:z.literal('provider_accepted'), provider:id, receiptRef:id, digest:executionDigestSchema }).strict(),
  reconcile: z.object({ reasonId:id, code:id, evidenceRefs:z.array(id) }).strict(),
  recovery: z.discriminatedUnion('kind',[
    z.object({kind:z.literal('unsubmitted_preparation'),decisionId:id,safeResources:resourceChecksSchema}).strict(),
    z.object({kind:z.literal('original_turn'),decisionId:id,submissionId:id,recovery:recoverySchema,resources:resourceChecksSchema,attached:z.boolean()}).strict()
  ]),
  event: z.object({id,type:z.enum(['text','thinking','tool_call','tool_result','permission_request','status','error','completed','task','raw_terminal']),data:executionJsonSchema,sourceId:id.optional(),timestamp:z.string().datetime().optional(),raw:z.string().optional()}).strict(),
  sessionPatch: z.object({state:z.enum(['created','starting','idle','thinking','running_tool','waiting_for_permission','interrupting','interrupted','completed','failed','stopped']).optional(),error:z.string().nullable().optional(),archivedAt:z.string().datetime().optional()}).strict(),
  workspaceProof: z.object({expectedCwd:id,workspaceRevision:z.number().int().positive().safe(),workspaceDigest:executionDigestSchema}).strict(),
  workspaceProjection: z.object({schemaVersion:z.literal(1),sessionId:id,revision:z.number().int().positive().safe(),state:z.literal('ready'),cwd:id}),
  interruptIntent: z.object({operationId:id,actor:executionActorSchema}).strict(),
  statePatch: z.object({state:z.enum(['created','starting','idle','thinking','running_tool','waiting_for_permission','interrupting','interrupted','completed','failed','stopped']),error:z.string().nullable().optional()}).strict(),
  beforeCreate: z.object({resourceId:id,kind:z.enum(['operation',...physicalKinds]),parentResourceId:id.optional()}).strict(),
  controlledOperation: z.object({resourceId:id,driverInstanceId:id,parentResourceId:id.optional(),scope:resourceOperationScopeSchema.optional()}).strict(),
  creationProvenance: creationProvenanceSchema,
  resource: fenceSchema.extend({
    resourceId: id, parentResourceId: id.optional(), kind: z.enum(['operation', ...physicalKinds]), revision: z.number().int().positive().safe(),
    controller: controllerSchema, holder: controllerSchema.optional(), stage: z.enum(['pending', 'created', 'not_created', 'unknown']),
    identity: z.object({ identityId: id, kind: z.enum(physicalKinds), locator: executionJsonSchema }).strict().optional(),
    observations: z.array(z.object({ observationId: id, state: z.enum(['live', 'gone', 'unknown']), identityId: id.optional(), evidenceRef: id, observedAt: z.string().datetime() }).strict()),
    createdAt: z.string().datetime(), driverInstanceId:id.optional(),operationScope:resourceOperationScopeSchema.optional(),purpose:z.literal('acp_native_context').optional(),nativeExpected:nativeContextExpectedSchema.optional(),nativeBindings:z.array(nativeBindingSchema).optional(),nativeReplacement:nativeReplacementSchema.optional(), creationProvenance: creationProvenanceSchema.optional(), creationClosure: creationClosureSchema.optional()
  }).strict(),
  finish: z.enum(['created','not_created','unknown'])
};
