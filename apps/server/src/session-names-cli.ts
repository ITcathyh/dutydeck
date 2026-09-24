import { normalizeSessionName, RuntimeError, type Session } from '@dutydeck/shared';
import { executeLocalRuntimeRequest, type LocalRuntimeRequestDependencies } from './local-runtime-request.js';

export type SessionNamesAction = 'list' | 'rename' | 'reset-name';

export interface SessionNamesCliInput {
  action: SessionNamesAction;
  sessionId?: string;
  name?: string;
  url?: string;
  database?: string;
  json?: boolean;
}

export type SessionNamesCliDependencies = LocalRuntimeRequestDependencies;

export class SessionNamesCliError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'SessionNamesCliError';
  }
}

function isValidSession(result: unknown): result is Session {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
  const obj = result as Record<string, unknown>;
  return typeof obj.id === 'string'
    && typeof obj.agentId === 'string'
    && typeof obj.state === 'string'
    && typeof obj.cwd === 'string'
    && typeof obj.runId === 'string'
    && typeof obj.createdAt === 'string'
    && typeof obj.updatedAt === 'string';
}

export async function runSessionNamesCli(
  input: SessionNamesCliInput,
  dependencies: SessionNamesCliDependencies = {}
): Promise<Session | Session[]> {
  const action = input.action;

  // 1. 参数校验（必须在 readState/readToken/fetch 前拒绝）
  let method: string;
  let endpoint: string;
  let body: unknown;

  if (action === 'list') {
    method = 'GET';
    endpoint = '/api/sessions';
  } else if (action === 'rename') {
    const sessionId = input.sessionId?.trim();
    if (!sessionId) {
      throw new SessionNamesCliError('SESSION_NAMES_ID_REQUIRED', 'Session ID is required');
    }
    if (typeof input.name !== 'string') {
      throw new SessionNamesCliError('SESSION_NAMES_NAME_REQUIRED', 'Session name is required');
    }
    let normalizedName: string | null;
    try {
      normalizedName = normalizeSessionName(input.name);
    } catch (error) {
      if (error instanceof RuntimeError) {
        throw new SessionNamesCliError(error.code, error.message);
      }
      throw error;
    }
    if (normalizedName === null) {
      throw new SessionNamesCliError('SESSION_NAMES_NAME_REQUIRED', 'Session name is required');
    }
    method = 'PATCH';
    endpoint = `/api/sessions/${encodeURIComponent(sessionId)}/name`;
    body = { name: normalizedName };
  } else if (action === 'reset-name') {
    const sessionId = input.sessionId?.trim();
    if (!sessionId) {
      throw new SessionNamesCliError('SESSION_NAMES_ID_REQUIRED', 'Session ID is required');
    }
    method = 'PATCH';
    endpoint = `/api/sessions/${encodeURIComponent(sessionId)}/name`;
    body = { name: null };
  } else {
    throw new SessionNamesCliError('SESSION_NAMES_UNKNOWN_ACTION', `Unknown session action: ${String(action)}`);
  }

  // 2. 本机安全请求调用
  const result = await executeLocalRuntimeRequest({
    url: input.url,
    database: input.database,
    method,
    endpoint,
    body,
    errorSpec: {
      databaseRequired: 'SESSION_NAMES_DATABASE_REQUIRED',
      daemonUnavailable: 'SESSION_NAMES_DAEMON_UNAVAILABLE',
      localRuntimeRequired: 'SESSION_NAMES_LOCAL_RUNTIME_REQUIRED',
      requestFailed: 'SESSION_NAMES_REQUEST_FAILED',
      localRuntimeRequiredMessage: 'Session names only connects to a loopback or literal local-interface runtime',
      requestFailedMessage: status => `Session request failed with HTTP ${status}`
    },
    createError: (code, message) => new SessionNamesCliError(code, message)
  }, dependencies);

  // 3. 响应形状校验（避免 200 HTML 或错误 JSON 误报成功）
  if (action === 'list') {
    if (!Array.isArray(result) || !result.every(isValidSession)) {
      throw new SessionNamesCliError('SESSION_NAMES_INVALID_RESPONSE', 'Session API returned an invalid session list');
    }
    return result;
  }

  if (!isValidSession(result)) {
    throw new SessionNamesCliError('SESSION_NAMES_INVALID_RESPONSE', 'Session API returned an invalid session');
  }

  return result;
}
