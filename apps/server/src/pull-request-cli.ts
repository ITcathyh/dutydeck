import { executeLocalRuntimeRequest, type LocalRuntimeRequestDependencies } from './local-runtime-request.js';

export type PullRequestCliAction = 'list' | 'follow' | 'stop';
export interface PullRequestCliInput { session?: string; instance?: string; url?: string; database?: string }
export class PullRequestCliError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'PullRequestCliError'; }
}

/** `dutydeck pr`：查看会话的 PR 跟进、认领已有的 PR、停止跟进。权限与 Web 相同。 */
export async function runPullRequestCli(action: PullRequestCliAction, argument: string | undefined, input: PullRequestCliInput, dependencies: LocalRuntimeRequestDependencies = {}): Promise<unknown> {
  const invalid = (message: string): never => { throw new PullRequestCliError('PR_ARGUMENT_INVALID', message); };
  if (!input.session?.trim()) invalid('--session is required');
  if (input.instance !== undefined && !/^[a-z0-9-]+$/.test(input.instance)) invalid('Instance ids contain only a-z, 0-9 and -');
  if (action !== 'list' && !argument?.trim()) invalid(action === 'follow' ? 'A pull request link or number is required' : 'A pull request record ID is required');
  const base = `/api/sessions/${encodeURIComponent(input.session!)}/pull-requests`;
  const request = (method: string, endpoint: string, body?: unknown) => executeLocalRuntimeRequest({
    url: input.url, database: input.database, method,
    endpoint: input.instance ? endpoint.replace(/^\/api\//, `/api/instances/${input.instance}/`) : endpoint, body,
    errorSpec: { databaseRequired: 'PR_DATABASE_REQUIRED', daemonUnavailable: 'PR_DAEMON_UNAVAILABLE', localRuntimeRequired: 'PR_LOCAL_RUNTIME_REQUIRED', requestFailed: 'PR_REQUEST_FAILED', requestFailedMessage: (status, message) => message ?? `Pull request request failed with HTTP ${status}` },
    createError: (code, message) => new PullRequestCliError(code, message)
  }, dependencies);
  if (action === 'list') return request('GET', base);
  if (action === 'follow') return request('POST', `${base}/follow`, { pullRequest: argument!.trim() });
  return request('POST', `${base}/${encodeURIComponent(argument!.trim())}/cancel`);
}
