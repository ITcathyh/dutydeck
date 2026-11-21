import { z } from 'zod';
import { ptyRetirementRecoverySchema } from './execution-recovery.js';
import { executionActorSchema, executionJsonSchema, taskExecutionOptionsSchema, taskExecutionSchemas } from './task-execution.js';
import { verificationStatuses } from './verification.js';
import { workspaceModes, workspacePreparationStates } from './workspace.js';

// CAS compares the stored JSON byte for byte. Zod's output may reorder object properties.
function readRecord<Value extends z.ZodTypeAny>(schema: Value, raw: string): z.output<Value> {
  const record = JSON.parse(raw);
  schema.parse(record);
  return record;
}

function single<Value extends z.ZodTypeAny>(prefix: string, value: Value) {
  return {
    prefix, value, read: (raw: string) => readRecord(value, raw),
    key: (id: string) => prefix + id,
    parse: (key: string) => key.startsWith(prefix) && key.length > prefix.length ? key.slice(prefix.length) : undefined
  };
}

function pair<Value extends z.ZodTypeAny>(prefix: string, value: Value) {
  return {
    prefix, value, read: (raw: string) => readRecord(value, raw),
    key: (first: string, second: string) => prefix + first + ':' + second,
    parse(key: string, knownFirst?: string): [string, string] | undefined {
      if (!key.startsWith(prefix)) return;
      // Existing keys do not escape colons. Use the known scope when either component contains one.
      if (knownFirst !== undefined && !key.startsWith(prefix + knownFirst + ':')) return;
      const split = knownFirst === undefined ? key.indexOf(':', prefix.length) : prefix.length + knownFirst.length;
      if (knownFirst === undefined && key.indexOf(':', split + 1) >= 0) return;
      if (split > prefix.length && split < key.length - 1) return [key.slice(prefix.length, split), key.slice(split + 1)];
    }
  };
}

const verification = pair('runtime_verification:', z.object({
  schemaVersion: z.literal(1), revision: z.number(), id: z.string(), sessionId: z.string(),
  command: z.string(), cwd: z.string(), status: z.enum(verificationStatuses),
  startedAt: z.string(), output: z.string(), outputTruncated: z.boolean(),
  taskId: z.string().optional(), actorId: z.string().optional(), completedAt: z.string().optional(),
  exitCode: z.number().optional(), beforeFingerprint: z.string().optional(), afterFingerprint: z.string().optional(),
  error: z.string().optional(), processStage: z.enum(['awaiting_process', 'command_started']).optional(),
  processIdentity: z.object({ platform: z.literal('linux'), pid: z.number(), processGroupId: z.number(),
    startTimeTicks: z.string(), marker: z.string() }).passthrough().optional()
}).passthrough());
const nativeContext = single('runtime_native_context:', taskExecutionSchemas.nativeSelectionSchema);
const directory = z.object({ path: z.string(), device: z.number(), inode: z.number() });

export const runtimeStateKeys = {
  driverStopBlock: single('runtime_driver_stop_block:', z.object({
    sessionId: z.string(), reason: z.string(), runId: z.string().optional()
  }).passthrough()),
  driverConfiguration: single('runtime_driver_configuration:', z.object({
    version: z.literal(1), sessionId: z.string(), operationId: z.string(), driverIdentity: z.string(),
    state: z.enum(['pending', 'unknown']), target: taskExecutionOptionsSchema
  }).passthrough()),
  workspace: single('runtime_workspace:', z.object({
    schemaVersion: z.literal(1), revision: z.number(), sessionId: z.string(), mode: z.enum(workspaceModes),
    sourceCwd: z.string(), cwd: z.string(), state: z.enum(workspacePreparationStates),
    createdAt: z.string(), updatedAt: z.string(), repoRoot: z.string().optional(), gitCommonDir: z.string().optional(),
    relativeCwd: z.string().optional(), baselineCommit: z.string().optional(), branch: z.string().optional(),
    error: z.string().optional(), cleanedAt: z.string().optional(), cleanupError: z.string().optional()
  }).passthrough()),
  verification: {
    ...verification,
    sessionPrefix: (id: string) => verification.key(id, ''),
    sessionUpperBound: (id: string) => verification.prefix + id + ';'
  },
  idleTerminal: single('runtime_idle_terminal:', z.object({
    runId: z.string(), resourceId: z.string(), identityId: z.string(), options: taskExecutionOptionsSchema, identity: executionJsonSchema
  }).passthrough()),
  ptyRetirement: pair('runtime_pty_retirement:', z.object({
    input: ptyRetirementRecoverySchema, actor: executionActorSchema, identity: executionJsonSchema, snapshot: executionJsonSchema, absent: z.literal(true).optional()
  }).passthrough()),
  executionWorkspace: single('runtime_execution_workspace:', z.union([
    z.object({ version: z.literal(1), key: z.string(), cwd: directory, resource: directory }),
    z.object({ version: z.literal(1), unverifiable: z.literal(true) })
  ])),
  nativeContext: {
    ...nativeContext,
    revisionKey: (id: string) => nativeContext.key(id) + ':revision',
    parse(key: string) {
      const suffix = nativeContext.parse(key);
      if (!suffix) return;
      return suffix.endsWith(':revision')
        ? { sessionId: suffix.slice(0, -':revision'.length), revision: true }
        : { sessionId: suffix, revision: false };
    }
  },
  notice: { ...pair('runtime_notice:', z.string()), read: (raw: string) => raw },
  legacyRetirement: single('legacy_retirement:', taskExecutionSchemas.legacyRetirementReceiptSchema)
} as const;
