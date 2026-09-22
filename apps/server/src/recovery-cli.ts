import { readFile } from 'node:fs/promises';
import Database from 'better-sqlite3';
import { networkInterfaces } from 'node:os';
import { isIP } from 'node:net';
import { executionRecoveryDecisionSchema, ptyRetirementRecoverySchema, nativeReplacementRecoverySchema } from '@dutydeck/shared';
import { readDaemonStatus, inspectDaemonState, resolveDaemonDir, type DaemonState } from './daemon/daemon.js';

export type RecoveryOperation = 'inspect' | 'probe' | 'confirm' | 'retire-pty' | 'replace-native';
export interface RecoveryCliOptions { file?: string; runId?: string; url?: string; database?: string }
export class RecoveryCliError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'RecoveryCliError'; }
}
export async function runRecoveryCli(operation: RecoveryOperation, sessionId: string, options: RecoveryCliOptions = {}, dependencies: {
  readState?: () => DaemonState | undefined; fetcher?: typeof fetch; readToken?: (path: string) => string | undefined; localAddresses?: () => string[];
} = {}) {
  const state = dependencies.readState?.() ?? readDaemonStatus(resolveDaemonDir());
  if (options.url && !options.database) throw new RecoveryCliError('RECOVERY_DATABASE_REQUIRED', '--url requires the exact --database for that runtime');
  const address = options.url ?? (state?.ready && inspectDaemonState(state).status === 'verified' ? state.address : undefined);
  if (!address) throw new RecoveryCliError('RECOVERY_DAEMON_UNAVAILABLE', 'The local runtime is not ready');
  const url = new URL(address);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = dependencies.localAddresses?.() ?? Object.values(networkInterfaces()).flatMap(entries => entries?.map(entry => entry.address) ?? []);
  const local = ['127.0.0.1', 'localhost', '::1'].includes(hostname) || Boolean(isIP(hostname) && addresses.includes(hostname));
  if (url.protocol !== 'http:' || !local || url.username || url.password) {
    throw new RecoveryCliError('RECOVERY_LOCAL_RUNTIME_REQUIRED', 'Recovery only connects to a loopback or literal local-interface runtime');
  }
  const database = options.database ?? state?.database;
  if (!database) throw new RecoveryCliError('RECOVERY_DATABASE_REQUIRED', 'The runtime database identity is required');
  const token = (dependencies.readToken ?? (path => {
    const db = new Database(path, { readonly: true, fileMustExist: true });
    try { return (db.prepare('SELECT value FROM configs WHERE key=?').get('auth.accessToken') as { value?: string } | undefined)?.value?.trim(); }
    finally { db.close(); }
  }))(database);
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) };
  let body: unknown;
  if (operation === 'probe') {
    if (!options.runId) throw new RecoveryCliError('RECOVERY_RUN_REQUIRED', 'Inspect first, then supply the exact --run-id');
    body = { runId: options.runId };
  } else if (operation === 'confirm' || operation === 'retire-pty' || operation === 'replace-native') {
    if (!options.file) throw new RecoveryCliError('RECOVERY_DECISION_REQUIRED', '--file must contain the reviewed recovery decision');
    const schema = operation === 'retire-pty' ? ptyRetirementRecoverySchema : operation === 'replace-native' ? nativeReplacementRecoverySchema : executionRecoveryDecisionSchema;
    body = schema.parse(JSON.parse(await readFile(options.file, 'utf8')));
  }
  const endpoint = `/api/sessions/${encodeURIComponent(sessionId)}/recovery${operation === 'inspect' ? '' : `/${operation}`}`;
  const response = await (dependencies.fetcher ?? fetch)(new URL(endpoint, url.origin), { method: operation === 'inspect' ? 'GET' : 'POST', headers,
    ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error' });
  const result = await response.json();
  if (!response.ok) throw new RecoveryCliError(typeof result?.error?.code === 'string' ? result.error.code : 'RECOVERY_REQUEST_FAILED', `Recovery request failed with HTTP ${response.status}`);
  return result;
}
