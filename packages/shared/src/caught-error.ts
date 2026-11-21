import { redactCredentialText } from './credential-redaction.js';
import { errorMessage } from './records.js';

export interface DiagnosticLog {
  warn(data: Record<string, unknown>, message: string): void;
  info?(data: Record<string, unknown>, message: string): void;
}

const warned = new Set<string>();
const MAX_WARNED_CATCHES = 1000;

export function warnCaught(log: DiagnosticLog | undefined, component: string, location: string, sessionId: string | undefined, error: unknown) {
  if (!log || warned.size >= MAX_WARNED_CATCHES) return;
  const key = JSON.stringify([component, location, sessionId]);
  if (warned.has(key)) return;
  warned.add(key);
  try {
    log.warn({ component, location, sessionId, error: redactCredentialText(errorMessage(error)) }, 'Operation failed');
  } catch { /* best-effort: logging cannot change the original fallback. */ }
}
