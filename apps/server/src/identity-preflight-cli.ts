import { createRepositories } from '@dockmux/storage';
import { getAuthToken } from './auth/auth.js';
import { readDaemonStatus, resolveDaemonDir, type DaemonState } from './daemon/daemon.js';

export interface IdentityPreflightCliOptions { groupBinding?: string[] }

export class IdentityPreflightCliError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'IdentityPreflightCliError';
  }
}

export interface IdentityPreflightCliDependencies {
  readState?: () => DaemonState | undefined;
  fetcher?: typeof globalThis.fetch;
  getAccessToken?: (database: string) => Promise<string | null>;
}

const record = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
const optional = <T>(condition: boolean, key: string, value: T) => condition ? { [key]: value } : {};

function projectIdentity(value: unknown) {
  const item = record(value);
  if (!item.id || !item.channelBotId || !item.botIdentityRef || !item.checkedAt || !item.expiresAt || !item.validity) return undefined;
  return {
    schemaVersion: item.schemaVersion,
    id: item.id,
    revision: item.revision,
    channelBotId: item.channelBotId,
    botIdentityRef: item.botIdentityRef,
    ...optional(typeof item.tenantRef === 'string', 'tenantRef', item.tenantRef),
    appIdMatch: item.appIdMatch === true,
    checkedAt: item.checkedAt,
    expiresAt: item.expiresAt,
    ...optional(typeof item.errorCode === 'string', 'errorCode', item.errorCode),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    validity: item.validity,
  };
}

function projectChat(value: unknown) {
  const item = record(value);
  if (!item.id || !item.channelBotId || !item.membershipState || !item.chatType || !item.observedAt || !item.expiresAt || !item.validity) return undefined;
  return {
    schemaVersion: item.schemaVersion,
    id: item.id,
    revision: item.revision,
    channelBotId: item.channelBotId,
    membershipState: item.membershipState,
    chatType: item.chatType,
    observedAt: item.observedAt,
    ...optional(typeof item.lastSuccessAt === 'string', 'lastSuccessAt', item.lastSuccessAt),
    ...optional(typeof item.errorCode === 'string', 'errorCode', item.errorCode),
    ...optional(Number.isInteger(item.identityRevision), 'identityRevision', item.identityRevision),
    ...optional(Number.isInteger(item.credentialRevision), 'credentialRevision', item.credentialRevision),
    expiresAt: item.expiresAt,
    ...optional(typeof item.invalidatedAt === 'string', 'invalidatedAt', item.invalidatedAt),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    validity: item.validity,
  };
}

/** Second allowlist at the CLI boundary; arbitrary API fields never reach stdout. */
export function projectIdentityPreflightCliResult(value: unknown) {
  const item = record(value);
  if (item.schemaVersion !== 1 || typeof item.channelBotId !== 'string' || (item.status !== 'passed' && item.status !== 'blocked')) {
    throw new IdentityPreflightCliError('IDENTITY_PREFLIGHT_RESPONSE_INVALID', 'Dockmux returned an invalid identity preflight response');
  }
  const identityFact = projectIdentity(item.identityFact);
  const chatFacts = Array.isArray(item.chatFacts) ? item.chatFacts.flatMap(value => {
    const entry = record(value);
    const fact = projectChat(entry.fact);
    return typeof entry.groupBindingId === 'string' && fact ? [{ groupBindingId: entry.groupBindingId, fact }] : [];
  }) : [];
  return {
    action: 'identity_preflight' as const,
    schemaVersion: 1 as const,
    channelBotId: item.channelBotId,
    status: item.status as 'passed' | 'blocked',
    ...(identityFact ? { identityFact } : {}),
    chatFacts,
    blockerCodes: Array.isArray(item.blockerCodes) ? item.blockerCodes.filter((code: unknown): code is string => typeof code === 'string' && /^[A-Z0-9_]+$/.test(code)) : [],
    ...optional(typeof item.checkedAt === 'string', 'checkedAt', item.checkedAt),
    ...optional(typeof item.expiresAt === 'string', 'expiresAt', item.expiresAt),
    appMatch: item.appMatch === true,
    tenantAppMatch: item.tenantAppMatch === true,
    activationChanged: false as const,
    listenerReadiness: 'blocked' as const,
    remainingBlockers: ['listener_lease', 'activation_unavailable'] as const,
  };
}

function loopbackAddress(raw: string): string {
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new IdentityPreflightCliError('IDENTITY_PREFLIGHT_DAEMON_ADDRESS_INVALID', 'The Dockmux daemon address is invalid'); }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(hostname)) {
    throw new IdentityPreflightCliError('IDENTITY_PREFLIGHT_DAEMON_ADDRESS_INVALID', 'Identity preflight CLI only connects to the locally recorded Dockmux daemon');
  }
  return url.origin;
}

async function defaultAccessToken(database: string): Promise<string | null> {
  const repositories = createRepositories(database);
  try { return await getAuthToken(repositories.config); }
  finally { repositories.close(); }
}

export async function runIdentityPreflightCli(
  channelBotId: string,
  options: IdentityPreflightCliOptions = {},
  dependencies: IdentityPreflightCliDependencies = {},
) {
  if (!channelBotId.trim()) throw new IdentityPreflightCliError('IDENTITY_PREFLIGHT_CHANNEL_BOT_REQUIRED', 'ChannelBot ID is required');
  const state = dependencies.readState?.() ?? readDaemonStatus(resolveDaemonDir());
  if (!state?.ready || !state.address) throw new IdentityPreflightCliError('IDENTITY_PREFLIGHT_DAEMON_UNAVAILABLE', 'The Dockmux daemon is not ready');
  const base = loopbackAddress(state.address);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (state.authEnabled !== false) {
    if (!state.database) throw new IdentityPreflightCliError('IDENTITY_PREFLIGHT_AUTH_UNAVAILABLE', 'The authenticated daemon did not publish its database identity');
    const token = await (dependencies.getAccessToken ?? defaultAccessToken)(state.database);
    if (!token) throw new IdentityPreflightCliError('IDENTITY_PREFLIGHT_AUTH_UNAVAILABLE', 'The authenticated daemon access token is unavailable');
    headers.authorization = `Bearer ${token}`;
  }
  const response = await (dependencies.fetcher ?? globalThis.fetch)(`${base}/api/foundation/channel-bots/${encodeURIComponent(channelBotId)}/identity-preflight`, {
    method: 'POST',
    headers,
    body: JSON.stringify(options.groupBinding?.length ? { groupBindingIds: options.groupBinding } : {}),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code = record(record(payload).error).code;
    throw new IdentityPreflightCliError(typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? code : 'IDENTITY_PREFLIGHT_REQUEST_FAILED', `Identity preflight request failed with HTTP ${response.status}`);
  }
  return projectIdentityPreflightCliResult(payload);
}
