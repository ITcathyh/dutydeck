import { terminalBackendSchema } from './terminal-settings.js';
import { executeLocalRuntimeRequest, type LocalRuntimeRequestDependencies } from './local-runtime-request.js';

export class TerminalSettingsCliError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}
export async function runTerminalSettingsCli(value: string | undefined, options: { url?: string; database?: string }, dependencies: LocalRuntimeRequestDependencies = {}) {
  if (value !== undefined && !terminalBackendSchema.safeParse(value).success) throw new TerminalSettingsCliError('INVALID_TERMINAL_BACKEND', 'Terminal backend must be tmux or herdr; only new pty-cli sessions change, ACP stays ACP.');
  let result: unknown;
  try { result = await executeLocalRuntimeRequest({
    ...options, method: value === undefined ? 'GET' : 'PUT', endpoint: '/api/settings/terminal',
    body: value === undefined ? undefined : { terminalBackend: value },
    errorSpec: {
      databaseRequired: 'TERMINAL_SETTINGS_DATABASE_REQUIRED', daemonUnavailable: 'TERMINAL_SETTINGS_DAEMON_UNAVAILABLE',
      localRuntimeRequired: 'TERMINAL_SETTINGS_LOCAL_RUNTIME_REQUIRED', requestFailed: 'TERMINAL_SETTINGS_REQUEST_FAILED',
      localRuntimeRequiredMessage: 'Terminal settings requires a local runtime and its exact database',
      requestFailedMessage: status => `Terminal settings request failed with HTTP ${status}`,
    }, createError: (code, message) => new TerminalSettingsCliError(code, message),
  }, dependencies); } catch (error) {
    if (error instanceof TerminalSettingsCliError && error.code === 'HERDR_UNAVAILABLE') throw new TerminalSettingsCliError(error.code, 'Herdr primary terminals require Linux and an executable Herdr >= 0.9 on the target runtime; no fallback to tmux.');
    throw error;
  }
  const body = result as { terminalBackend?: unknown; scope?: unknown };
  if (!body || !terminalBackendSchema.safeParse(body.terminalBackend).success || body.scope !== 'pty-cli') throw new TerminalSettingsCliError('TERMINAL_SETTINGS_INVALID_RESPONSE', 'Invalid terminal settings response');
  return body;
}
