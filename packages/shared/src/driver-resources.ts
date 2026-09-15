import { z } from 'zod';
import type { ChildProcess } from 'node:child_process';
import type { DriverTurnRecovery } from './driver.js';
import type { AcceptedTaskInputV2, ExecutionActor, ExecutionController, JsonValue, ResourceIdentity, ResourceRef, SessionFence, SubmissionReceipt } from './task-execution.js';

const id = z.string().min(1);
export const nativeContextRefSchema = z.object({ resourceId: id, identityId: id, originRunId: id }).strict();
export type NativeContextRef = z.infer<typeof nativeContextRefSchema>;
export const resourceOperationScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('lifecycle') }).strict(),
  z.object({ kind: z.literal('submission'), taskId: id, attemptId: id, submissionId: id }).strict(),
  z.object({ kind: z.literal('cleanup'), resourceIds: z.array(id).min(1) }).strict(),
  z.object({ kind: z.literal('strict-context-restore'), context: nativeContextRefSchema, selectionRevision: z.number().int().positive(), repairConfiguration: z.boolean() }).strict()
]);
export type ResourceOperationScope = z.infer<typeof resourceOperationScopeSchema>;
export const nativeContextExpectedSchema = z.object({
  nativeCreationId: id, sessionKey: id, agent: id, command: z.array(z.string()).min(1), cwd: id, executionDomain: id
}).strict();
export type NativeContextExpected = z.infer<typeof nativeContextExpectedSchema>;
export interface NativeContextIdentity extends NativeContextExpected {
  acpxRecordId: string; backendSessionId: string; agentSessionId?: string;
  defaults: { model?: string; reasoningEffort?: string };
}
export interface NativeContextSelection {
  version: 1; revision: number; runId: string; context: NativeContextRef;
}
export interface NativeContextBinding extends SessionFence {
  proofId: string; context: NativeContextRef; driverInstanceId: string; operationId: string;
  controller: ExecutionController; observedAt: string;
}
export interface NativeContextReplacement {
  decisionId: string; actor: ExecutionActor; resourceId: string; expectedRevision: number;
}

declare const operationPermit: unique symbol;
declare const childPermit: unique symbol;
export interface OperationPermit { readonly [operationPermit]: true }
export interface ChildPermit { readonly [childPermit]: true }
export interface DriverResourceHooks {
  beginOperation(parent?: OperationPermit): OperationPermit;
  beginCleanup(resourceIds?: string[]): OperationPermit;
  beforeCreate(parent: OperationPermit, kind: 'process'): ChildPermit;
  assertCreation(permit: ChildPermit): void;
  /** Retains the original object before persisting its identity. */
  spawned(permit: ChildPermit, child: ChildProcess): void;
  creationFinished(permit: OperationPermit | ChildPermit, result: 'created' | 'not_created' | 'unknown'): void;
}
export interface DriverContext extends SessionFence {
  readonly protocol: 'controlled-v1' | 'local-only';
  readonly driverInstanceId: string;
  readonly executionDomain: string;
  readonly mode: 'create' | 'attach';
  readonly rootOperation: OperationPermit;
  readonly resources: DriverResourceHooks;
  assertSubmission(input: DriverSubmission): void;
  prepareSubmission(input: DriverSubmissionInput): Omit<DriverSubmission, 'operation' | 'onAccepted'>;
  readonly native?: {
    readonly sessionKey: string;
    readonly expected?: NativeContextIdentity;
    reserve(input: NativeContextExpected): { resourceId: string; nativeCreationId: string };
    confirmed(identity: NativeContextIdentity): void;
  };
}
export interface DriverSubmissionInput {
  taskId: string; attemptId: string; submissionId: string; prompt: string;
  executionOptions: AcceptedTaskInputV2['executionOptions'];
}
export interface DriverSubmission extends DriverSubmissionInput {
  inputDigest: string; resourceRefs: ResourceRef[]; recovery?: DriverTurnRecovery;
  nativeContextRef?: NativeContextRef; contextProofId?: string;
  operation: OperationPermit; onAccepted(receipt: SubmissionReceipt): void;
}
export interface DriverResourceCapabilities {
  observe: boolean; originalObjectStop: boolean; identityBoundStop: boolean;
  nativeContextRestore: boolean; activeTurnAttach: boolean; configurationAck: boolean; creationDefaults: boolean;
}
export interface NativeConfigurationRequest { operationId: string; target: { model?: string; reasoningEffort?: string } }
export interface NativeConfigurationProof {
  context: NativeContextRef; driverInstanceId: string; operationId: string;
  target: { model?: string; reasoningEffort?: string }; evidence: JsonValue;
}
