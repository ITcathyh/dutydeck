import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const API_ORIGIN = 'https://api.github.com';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export interface GithubRepository {
  owner: string;
  name: string;
  slug: string;
}

export interface GithubWorkflowRun {
  id: number;
  name: string;
  workflowId: number;
  runAttempt: number;
  headSha: string;
  status: string;
  conclusion?: string;
  htmlUrl: string;
  createdAt: string;
  updatedAt: string;
}

export class GithubActionsError extends Error {
  constructor(public readonly code: string, message: string, public readonly statusCode = 502) {
    super(message);
    this.name = 'GithubActionsError';
  }
}

function repositoryFromRemote(remote: string): GithubRepository {
  const trimmed = remote.trim();
  let owner: string | undefined;
  let name: string | undefined;
  const scp = /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i.exec(trimmed);
  if (scp) {
    [, owner, name] = scp;
  } else {
    let parsed: URL;
    try { parsed = new URL(trimmed); }
    catch { throw new GithubActionsError('GITHUB_REMOTE_UNSUPPORTED', 'Session origin is not a supported GitHub URL', 400); }
    if (parsed.hostname.toLowerCase() !== 'github.com' || !['https:', 'ssh:'].includes(parsed.protocol) || parsed.username && parsed.protocol === 'https:') {
      throw new GithubActionsError('GITHUB_REMOTE_UNSUPPORTED', 'Session origin must use github.com over HTTPS or SSH', 400);
    }
    const parts = parsed.pathname.replace(/^\/+|\/+$/g, '').split('/');
    if (parts.length !== 2) throw new GithubActionsError('GITHUB_REMOTE_UNSUPPORTED', 'Session origin must identify one GitHub repository', 400);
    [owner, name] = parts;
    name = name?.replace(/\.git$/i, '');
  }
  const segment = /^[A-Za-z0-9_.-]+$/;
  if (!owner || !name || !segment.test(owner) || !segment.test(name) || owner === '.' || owner === '..' || name === '.' || name === '..') {
    throw new GithubActionsError('GITHUB_REMOTE_UNSUPPORTED', 'Session origin contains an invalid GitHub repository name', 400);
  }
  return { owner, name, slug: `${owner}/${name}` };
}

export async function resolveGithubHead(cwd: string): Promise<{ repository: GithubRepository; headSha: string }> {
  let remote: string;
  let headSha: string;
  try {
    const [remoteResult, headResult] = await Promise.all([
      run('git', ['-C', cwd, 'remote', 'get-url', 'origin'], { timeout: 5_000, maxBuffer: 64 * 1024 }),
      run('git', ['-C', cwd, 'rev-parse', '--verify', 'HEAD'], { timeout: 5_000, maxBuffer: 64 * 1024 })
    ]);
    remote = remoteResult.stdout.trim();
    headSha = headResult.stdout.trim().toLowerCase();
  } catch {
    throw new GithubActionsError('GITHUB_REPOSITORY_UNAVAILABLE', 'Session workspace must be a Git repository with origin and HEAD', 400);
  }
  if (!/^[a-f0-9]{40}$/.test(headSha)) throw new GithubActionsError('GITHUB_HEAD_INVALID', 'Session HEAD is not a full Git commit SHA', 400);
  return { repository: repositoryFromRemote(remote), headSha };
}

export interface GithubActionsClientOptions {
  token?: string;
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
}

export class GithubActionsClient {
  private readonly request: typeof fetch;
  private readonly requestTimeoutMs: number;

  constructor(private readonly options: GithubActionsClientOptions = {}) {
    this.request = options.fetch ?? globalThis.fetch;
    this.requestTimeoutMs = Math.max(1_000, Math.min(30_000, options.requestTimeoutMs ?? 10_000));
  }

  async listRuns(repository: GithubRepository, headSha: string, workflow?: string): Promise<GithubWorkflowRun[]> {
    return this.queryRuns(repository, headSha, workflow);
  }

  async listCompletedRuns(repository: GithubRepository, headSha: string, workflow?: string): Promise<GithubWorkflowRun[]> {
    return this.queryRuns(repository, headSha, workflow, 'completed');
  }

  private async queryRuns(repository: GithubRepository, headSha: string, workflow?: string, status?: 'completed'): Promise<GithubWorkflowRun[]> {
    if (!/^[a-f0-9]{40}$/.test(headSha)) throw new GithubActionsError('GITHUB_HEAD_INVALID', 'GitHub query requires a full commit SHA', 400);
    const base = `${API_ORIGIN}/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/actions`;
    const endpoint = workflow
      ? `${base}/workflows/${encodeURIComponent(workflow)}/runs`
      : `${base}/runs`;
    const url = new URL(endpoint);
    if (url.origin !== API_ORIGIN) throw new GithubActionsError('GITHUB_API_HOST_INVALID', 'GitHub API request host is invalid', 500);
    url.searchParams.set('head_sha', headSha);
    if (status) url.searchParams.set('status', status);
    url.searchParams.set('per_page', '100');

    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'DutyDeck',
      'X-GitHub-Api-Version': '2026-03-10'
    };
    const send = async (authenticated: boolean) => {
      const requestHeaders = authenticated && this.options.token ? { ...headers, Authorization: `Bearer ${this.options.token}` } : headers;
      try {
        return await this.request(url, {
          method: 'GET', headers: requestHeaders, redirect: 'manual', signal: AbortSignal.timeout(this.requestTimeoutMs)
        });
      } catch (error) {
        throw new GithubActionsError('GITHUB_REQUEST_FAILED', error instanceof Error && error.name === 'TimeoutError' ? 'GitHub request timed out' : 'GitHub request failed');
      }
    };
    let response = await send(false);
    if (this.options.token && [401, 403, 404].includes(response.status)) {
      await response.body?.cancel();
      response = await send(true);
    }
    if (response.status >= 300 && response.status < 400) throw new GithubActionsError('GITHUB_REDIRECT_REJECTED', 'GitHub API redirect was rejected');
    if (!response.ok) throw new GithubActionsError('GITHUB_RESPONSE_ERROR', `GitHub API returned HTTP ${response.status}`, response.status === 401 || response.status === 403 ? 403 : 502);
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) throw new GithubActionsError('GITHUB_RESPONSE_TOO_LARGE', 'GitHub API response exceeded the size limit');
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new GithubActionsError('GITHUB_RESPONSE_TOO_LARGE', 'GitHub API response exceeded the size limit');
    let payload: unknown;
    try { payload = JSON.parse(text); }
    catch { throw new GithubActionsError('GITHUB_RESPONSE_INVALID', 'GitHub API returned invalid JSON'); }
    if (!payload || typeof payload !== 'object' || !Array.isArray((payload as { workflow_runs?: unknown }).workflow_runs)) {
      throw new GithubActionsError('GITHUB_RESPONSE_INVALID', 'GitHub API response did not contain workflow runs');
    }
    const totalCount = (payload as { total_count?: unknown }).total_count;
    if (typeof totalCount === 'number' && totalCount > 100) throw new GithubActionsError('GITHUB_RUN_SET_TOO_LARGE', 'GitHub returned more than 100 workflow runs for this commit');
    const runs: GithubWorkflowRun[] = [];
    for (const item of (payload as { workflow_runs: unknown[] }).workflow_runs.slice(0, 100)) {
      if (!item || typeof item !== 'object') continue;
      const value = item as Record<string, unknown>;
      if (!Number.isSafeInteger(value.id) || typeof value.head_sha !== 'string' || value.head_sha.toLowerCase() !== headSha || typeof value.status !== 'string' || status && value.status !== status) continue;
      if (typeof value.name !== 'string' || !Number.isSafeInteger(value.workflow_id) || typeof value.html_url !== 'string' || typeof value.created_at !== 'string' || typeof value.updated_at !== 'string') continue;
      let htmlUrl: URL;
      try { htmlUrl = new URL(value.html_url); }
      catch { continue; }
      if (htmlUrl.protocol !== 'https:' || htmlUrl.hostname.toLowerCase() !== 'github.com') continue;
      runs.push({
        id: value.id as number,
        name: value.name,
        workflowId: value.workflow_id as number,
        runAttempt: Number.isSafeInteger(value.run_attempt) ? value.run_attempt as number : 1,
        headSha,
        status: value.status,
        ...(typeof value.conclusion === 'string' ? { conclusion: value.conclusion } : {}),
        htmlUrl: htmlUrl.toString(),
        createdAt: value.created_at,
        updatedAt: value.updated_at
      });
    }
    const latest = new Map<number, GithubWorkflowRun>();
    for (const run of runs) if (!latest.has(run.id) || latest.get(run.id)!.runAttempt < run.runAttempt) latest.set(run.id, run);
    return [...latest.values()].sort((left, right) => left.id - right.id);
  }
}
