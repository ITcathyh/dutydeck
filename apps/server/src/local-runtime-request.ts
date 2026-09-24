import Database from 'better-sqlite3';
import { networkInterfaces } from 'node:os';
import { isIP } from 'node:net';
import { readDaemonStatus, inspectDaemonState, resolveDaemonDir, type DaemonState } from './daemon/daemon.js';

export interface LocalRuntimeRequestDependencies {
  readState?: () => DaemonState | undefined;
  fetcher?: typeof fetch;
  readToken?: (path: string) => string | undefined;
  localAddresses?: () => string[];
}

export interface LocalRuntimeErrorSpec {
  databaseRequired: string;
  daemonUnavailable: string;
  localRuntimeRequired: string;
  requestFailed: string;
  localRuntimeRequiredMessage?: string;
  requestFailedMessage?: (status: number) => string;
}

export interface LocalRuntimeRequestOptions {
  url?: string;
  database?: string;
  method: string;
  endpoint: string;
  body?: unknown;
  errorSpec: LocalRuntimeErrorSpec;
  createError: (code: string, message: string) => Error;
}

export async function executeLocalRuntimeRequest(
  options: LocalRuntimeRequestOptions,
  dependencies: LocalRuntimeRequestDependencies = {}
): Promise<unknown> {
  const { url: inputUrl, database: inputDatabase, method, endpoint, body, errorSpec, createError } = options;

  const state = dependencies.readState?.() ?? readDaemonStatus(resolveDaemonDir());
  if (inputUrl && !inputDatabase) {
    throw createError(errorSpec.databaseRequired, '--url requires the exact --database for that runtime');
  }
  const address = inputUrl ?? (state?.ready && inspectDaemonState(state).status === 'verified' ? state.address : undefined);
  if (!address) {
    throw createError(errorSpec.daemonUnavailable, 'The local runtime is not ready');
  }
  const url = new URL(address);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = dependencies.localAddresses?.() ?? Object.values(networkInterfaces()).flatMap(entries => entries?.map(entry => entry.address) ?? []);
  const local = ['127.0.0.1', 'localhost', '::1'].includes(hostname) || Boolean(isIP(hostname) && addresses.includes(hostname));
  if (url.protocol !== 'http:' || !local || url.username || url.password) {
    throw createError(
      errorSpec.localRuntimeRequired,
      errorSpec.localRuntimeRequiredMessage ?? 'CLI only connects to a loopback or literal local-interface runtime'
    );
  }
  const database = inputDatabase ?? state?.database;
  if (!database) {
    throw createError(errorSpec.databaseRequired, 'The runtime database identity is required');
  }

  const token = (dependencies.readToken ?? (path => {
    const db = new Database(path, { readonly: true, fileMustExist: true });
    try {
      return (db.prepare('SELECT value FROM configs WHERE key=?').get('auth.accessToken') as { value?: string } | undefined)?.value?.trim();
    } finally {
      db.close();
    }
  }))(database);

  const headers: Record<string, string> = {
    ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    ...(token ? { authorization: `Bearer ${token}` } : {})
  };
  const signal = AbortSignal.timeout(15_000);
  const response = await (dependencies.fetcher ?? fetch)(new URL(endpoint, url.origin), {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    redirect: 'error',
    signal
  });

  let result: any;
  try {
    result = await response.json();
  } catch {
    result = null;
  }

  if (!response.ok) {
    const code = typeof result?.error?.code === 'string' ? result.error.code : errorSpec.requestFailed;
    const message = errorSpec.requestFailedMessage
      ? errorSpec.requestFailedMessage(response.status)
      : `Request failed with HTTP ${response.status}`;
    throw createError(code, message);
  }

  return result;
}
