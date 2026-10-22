import { AGENT_LOGIN_REQUIRED, type AgentEvent } from '@dutydeck/shared';

const unavailableCodes = new Set([
  AGENT_LOGIN_REQUIRED, 'AGENT_NOT_FOUND', 'LARK_AGENT_NOT_FOUND', 'AGENT_UNAVAILABLE', 'DRIVER_UNAVAILABLE', 'START_FAILED',
  'claude_api_authentication_failed', 'claude_api_oauth_org_not_allowed', 'claude_api_account_on_hold',
  'claude_api_verification_required', 'claude_api_cloud_credential_error', 'claude_api_rate_limit', 'claude_api_billing_error',
  'claude_api_overloaded', 'claude_api_server_error', 'usage_limit_exceeded', 'rate_limit', 'codex_capacity'
]);

/** Only provider/startup failures qualify; ordinary task errors and refusals do not. */
export function larkAgentUnavailableReason(failure: unknown): string | undefined {
  if (!failure || typeof failure !== 'object') return undefined;
  const value = failure as { code?: unknown; detailCode?: unknown; message?: unknown; retryable?: unknown };
  if (unavailableCodes.has(String(value.code)) || value.code === 'claude_api_unknown' && value.retryable === true || value.code === 'ACP_PROVIDER_TERMINAL_ERROR'
    && /^(?:access|auth|usage_limit_exceeded|rate_limit|codex_capacity|server_error|overloaded)(?:$|[:_])/i.test(String(value.detailCode))) {
    return typeof value.message === 'string' ? value.message : String(value.code);
  }
  return undefined;
}

/** Monotonic for the whole turn, including activity that leaves the bounded event buffer. */
export const larkFallbackHasActivity = (event: AgentEvent) => (event.type === 'status'
  && (event.data as { programState?: string; kind?: string })?.programState === 'blocked' && (event.data as { kind?: string }).kind === 'permission') || !['status', 'task', 'error', 'usage', 'commands', 'completed', 'raw_terminal'].includes(event.type)
  && !(event.type === 'text' && (event.data as { role?: string })?.role === 'user');
