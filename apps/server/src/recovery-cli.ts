import { readFile } from 'node:fs/promises';
import { executionRecoveryDecisionSchema, steeringRecoveryDecisionSchema, ptyRetirementRecoverySchema, nativeReplacementRecoverySchema } from '@dutydeck/shared';
import { executeLocalRuntimeRequest, type LocalRuntimeRequestDependencies } from './local-runtime-request.js';

export type RecoveryOperation = 'inspect' | 'probe' | 'confirm' | 'steering' | 'retire-pty' | 'replace-native';
export interface RecoveryCliOptions { file?: string; runId?: string; url?: string; database?: string }
export class RecoveryCliError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'RecoveryCliError'; }
}
export async function runRecoveryCli(operation: RecoveryOperation, sessionId: string, options: RecoveryCliOptions = {}, dependencies: LocalRuntimeRequestDependencies = {}) {
  let body: unknown;
  if (operation === 'probe') {
    if (!options.runId) throw new RecoveryCliError('RECOVERY_RUN_REQUIRED', 'Inspect first, then supply the exact --run-id');
    body = { runId: options.runId };
  } else if (operation === 'confirm' || operation === 'steering' || operation === 'retire-pty' || operation === 'replace-native') {
    if (!options.file) throw new RecoveryCliError('RECOVERY_DECISION_REQUIRED', '--file must contain the reviewed recovery decision');
    const schema = operation === 'steering' ? steeringRecoveryDecisionSchema : operation === 'retire-pty' ? ptyRetirementRecoverySchema : operation === 'replace-native' ? nativeReplacementRecoverySchema : executionRecoveryDecisionSchema;
    body = schema.parse(JSON.parse(await readFile(options.file, 'utf8')));
  }
  const endpoint = `/api/sessions/${encodeURIComponent(sessionId)}/recovery${operation === 'inspect' ? '' : `/${operation}`}`;
  const result = await executeLocalRuntimeRequest({
    url: options.url,
    database: options.database,
    method: operation === 'inspect' ? 'GET' : 'POST',
    endpoint,
    body,
    errorSpec: {
      databaseRequired: 'RECOVERY_DATABASE_REQUIRED',
      daemonUnavailable: 'RECOVERY_DAEMON_UNAVAILABLE',
      localRuntimeRequired: 'RECOVERY_LOCAL_RUNTIME_REQUIRED',
      requestFailed: 'RECOVERY_REQUEST_FAILED',
      localRuntimeRequiredMessage: 'Recovery only connects to a loopback or literal local-interface runtime',
      requestFailedMessage: status => `Recovery request failed with HTTP ${status}`
    },
    createError: (code, message) => new RecoveryCliError(code, message)
  }, dependencies);
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new RecoveryCliError('RECOVERY_INVALID_RESPONSE', 'Recovery API returned an invalid response');
  }
  return result;
}
