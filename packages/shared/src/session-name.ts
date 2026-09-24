import { RuntimeError } from './index.js';

export const SESSION_NAME_MAX_LENGTH = 80;
export const SESSION_NAME_CONFIG_PREFIX = 'session_name:';

export function sessionNameConfigKey(sessionId: string): string {
  return `${SESSION_NAME_CONFIG_PREFIX}${sessionId}`;
}

export function normalizeSessionName(raw: unknown): string | null {
  if (raw === null) {
    return null;
  }
  if (typeof raw !== 'string') {
    throw new RuntimeError('INVALID_SESSION_NAME', 'Session name must be a string or null', 400);
  }
  if (/[\r\n]/.test(raw)) {
    throw new RuntimeError('INVALID_SESSION_NAME', 'Session name cannot contain newlines', 400);
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new RuntimeError('INVALID_SESSION_NAME', 'Session name cannot be empty', 400);
  }
  if (trimmed.length > SESSION_NAME_MAX_LENGTH) {
    throw new RuntimeError('INVALID_SESSION_NAME', `Session name cannot exceed ${SESSION_NAME_MAX_LENGTH} characters`, 400);
  }
  return trimmed;
}
