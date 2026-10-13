// GitHub 的 CI 提供方：Actions 构建状态与失败日志、Pull Request、webhook。接口见 @dutydeck/shared 的 CiProvider。
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const API_ORIGIN = 'https://api.github.com';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_LOG_BYTES = 8 * 1024 * 1024;
const LOG_TAIL_CHARS = 3_000;
const MAX_FAILED_JOBS = 10;
const failureConclusions = new Set(['failure', 'timed_out', 'action_required', 'startup_failure']);
const sha40 = /^[a-f0-9]{40}$/;

export class GithubError extends Error {
  constructor(code, message, statusCode = 502) {
    super(message);
    this.name = 'GithubError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

/** github.com 的 HTTPS 或 SSH 地址解析成 owner/name；其他地址返回 undefined。 */
export function repositoryFromRemote(remote) {
  const trimmed = String(remote ?? '').trim();
  let owner;
  let name;
  const scp = /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i.exec(trimmed);
  if (scp) {
    [, owner, name] = scp;
  } else {
    let parsed;
    try { parsed = new URL(trimmed); } catch { return undefined; }
    if (parsed.hostname.toLowerCase() !== 'github.com' || !['https:', 'ssh:'].includes(parsed.protocol) || parsed.username && parsed.protocol === 'https:') return undefined;
    const parts = parsed.pathname.replace(/^\/+|\/+$/g, '').split('/');
    if (parts.length !== 2) return undefined;
    [owner, name] = parts;
    name = name?.replace(/\.git$/i, '');
  }
  const segment = /^[A-Za-z0-9_.-]+$/;
  if (!owner || !name || !segment.test(owner) || !segment.test(name) || ['.', '..'].includes(owner) || ['.', '..'].includes(name)) return undefined;
  return { owner, name, slug: `${owner}/${name}` };
}

const runResult = conclusion => conclusion === 'success' ? 'success'
  : failureConclusions.has(conclusion) ? 'failed'
  : conclusion === 'cancelled' ? 'cancelled'
  : conclusion === 'skipped' ? 'skipped'
  : conclusion ? 'neutral' : undefined;
const runStatus = status => status === 'completed' ? 'completed' : ['queued', 'waiting', 'requested', 'pending'].includes(status) ? 'queued' : 'running';

/** 汇总状态：有未完成的为 running，全部完成且有失败为 failed，有取消为 cancelled，没有构建为 unknown。 */
export function summarizeRuns(runs) {
  if (!runs.length) return 'unknown';
  if (runs.some(run => run.status !== 'completed')) return 'running';
  if (runs.some(run => run.result === 'failed')) return 'failed';
  if (runs.some(run => run.result === 'cancelled')) return 'cancelled';
  return 'success';
}

const header = (headers, name) => { const value = headers?.[name]; return Array.isArray(value) ? value[0] : value; };
const digestEqual = (left, right) => timingSafeEqual(createHash('sha256').update(left).digest(), createHash('sha256').update(right).digest());
const badRequest = message => Object.assign(new Error(message), { statusCode: 400, code: 'WEBHOOK_BODY_INVALID' });
const time = value => { const parsed = typeof value === 'string' ? Date.parse(value) : NaN; return Number.isFinite(parsed) ? parsed : undefined; };

/**
 * @param {{ token?: string; webhookSecret?: string; fetch?: typeof fetch; requestTimeoutMs?: number }} options
 */
export function createGithubProvider(options = {}) {
  const request = options.fetch ?? globalThis.fetch;
  const timeoutMs = Math.max(1_000, Math.min(30_000, options.requestTimeoutMs ?? 10_000));
  const token = options.token?.trim() || undefined;
  const baseHeaders = { Accept: 'application/vnd.github+json', 'User-Agent': 'DutyDeck', 'X-GitHub-Api-Version': '2026-03-10' };

  const send = async (url, init, authenticated) => {
    const headers = { ...baseHeaders, ...(init.headers ?? {}), ...(authenticated && token ? { Authorization: `Bearer ${token}` } : {}) };
    try {
      return await request(url, { ...init, headers, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      throw new GithubError('GITHUB_REQUEST_FAILED', error instanceof Error && error.name === 'TimeoutError' ? 'GitHub request timed out' : 'GitHub request failed');
    }
  };

  const apiUrl = (path, query = {}) => {
    const url = new URL(`${API_ORIGIN}${path}`);
    if (url.origin !== API_ORIGIN) throw new GithubError('GITHUB_API_HOST_INVALID', 'GitHub API request host is invalid', 500);
    for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, String(value));
    return url;
  };

  const readJson = async response => {
    if (response.status >= 300 && response.status < 400) throw new GithubError('GITHUB_REDIRECT_REJECTED', 'GitHub API redirect was rejected');
    if (!response.ok) throw new GithubError('GITHUB_RESPONSE_ERROR', `GitHub API returned HTTP ${response.status}`, response.status === 401 || response.status === 403 ? 403 : 502);
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new GithubError('GITHUB_RESPONSE_TOO_LARGE', 'GitHub API response exceeded the size limit');
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new GithubError('GITHUB_RESPONSE_TOO_LARGE', 'GitHub API response exceeded the size limit');
    try { return JSON.parse(text); } catch { throw new GithubError('GITHUB_RESPONSE_INVALID', 'GitHub API returned invalid JSON'); }
  };

  /** 读接口先不带令牌（公开仓库够用），401/403/404 时再带令牌重试一次。 */
  const getPublic = async (url) => {
    let response = await send(url, { method: 'GET' }, false);
    if (token && [401, 403, 404].includes(response.status)) {
      await response.body?.cancel();
      response = await send(url, { method: 'GET' }, true);
    }
    return readJson(response);
  };
  const requireToken = () => { if (!token) throw new GithubError('GITHUB_TOKEN_REQUIRED', 'GitHub 插件没有配置 token：dutydeck plugin config github token --value-fd 0', 400); };
  const call = async (method, url, body) => {
    requireToken();
    return readJson(await send(url, { method, ...(body ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } } : {}) }, true));
  };
  const repoPath = repository => `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`;

  async function queryRuns(repository, headSha, workflow, completedOnly) {
    if (!sha40.test(headSha)) throw new GithubError('GITHUB_HEAD_INVALID', 'GitHub query requires a full commit SHA', 400);
    const base = `${repoPath(repository)}/actions`;
    const url = apiUrl(workflow ? `${base}/workflows/${encodeURIComponent(workflow)}/runs` : `${base}/runs`, { head_sha: headSha, status: completedOnly ? 'completed' : undefined, per_page: 100 });
    const payload = await getPublic(url);
    if (!payload || typeof payload !== 'object' || !Array.isArray(payload.workflow_runs)) throw new GithubError('GITHUB_RESPONSE_INVALID', 'GitHub API response did not contain workflow runs');
    if (typeof payload.total_count === 'number' && payload.total_count > 100) throw new GithubError('GITHUB_RUN_SET_TOO_LARGE', 'GitHub returned more than 100 workflow runs for this commit');
    const latest = new Map();
    for (const value of payload.workflow_runs.slice(0, 100)) {
      if (!value || typeof value !== 'object') continue;
      if (!Number.isSafeInteger(value.id) || typeof value.head_sha !== 'string' || value.head_sha.toLowerCase() !== headSha || typeof value.status !== 'string' || completedOnly && value.status !== 'completed') continue;
      if (typeof value.name !== 'string' || !Number.isSafeInteger(value.workflow_id) || typeof value.html_url !== 'string' || typeof value.created_at !== 'string' || typeof value.updated_at !== 'string') continue;
      let htmlUrl;
      try { htmlUrl = new URL(value.html_url); } catch { continue; }
      if (htmlUrl.protocol !== 'https:' || htmlUrl.hostname.toLowerCase() !== 'github.com') continue;
      const conclusion = typeof value.conclusion === 'string' ? value.conclusion : undefined;
      const run = {
        id: value.id, name: value.name, attempt: Number.isSafeInteger(value.run_attempt) ? value.run_attempt : 1, headSha,
        status: runStatus(value.status), ...(runResult(conclusion) ? { result: runResult(conclusion) } : {}), ...(conclusion ? { conclusion } : {}),
        url: htmlUrl.toString()
      };
      if (!latest.has(run.id) || latest.get(run.id).attempt < run.attempt) latest.set(run.id, run);
    }
    return [...latest.values()].sort((left, right) => left.id - right.id);
  }

  async function getPipelineStatus(query) {
    const runs = await queryRuns(query.repository, String(query.sha).toLowerCase(), query.workflow, query.completedOnly === true);
    return { state: summarizeRuns(runs), runs };
  }

  /** 失败 job 的日志：日志接口 302 到临时下载地址，跟一次跳转，下载时不带令牌，只留末尾。 */
  async function jobLogTail(repository, jobId) {
    const response = await send(apiUrl(`${repoPath(repository)}/actions/jobs/${encodeURIComponent(jobId)}/logs`), { method: 'GET' }, true);
    const location = response.status >= 300 && response.status < 400 ? response.headers.get('location') : undefined;
    await response.body?.cancel();
    if (!location) return undefined;
    let target;
    try { target = new URL(location); } catch { return undefined; }
    if (target.protocol !== 'https:') return undefined;
    const download = await request(target, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    if (!download.ok) return undefined;
    const declared = Number(download.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_LOG_BYTES) { await download.body?.cancel(); return undefined; }
    const text = await download.text();
    return text.slice(-LOG_TAIL_CHARS);
  }

  async function getFailureLogs(repository, runId) {
    if (!/^\d+$/.test(String(runId))) throw new GithubError('GITHUB_RUN_INVALID', 'GitHub run id must be numeric', 400);
    const payload = await getPublic(apiUrl(`${repoPath(repository)}/actions/runs/${runId}/jobs`, { filter: 'latest', per_page: 100 }));
    const jobs = Array.isArray(payload?.jobs) ? payload.jobs : [];
    const failed = jobs.filter(job => job && failureConclusions.has(job.conclusion)).slice(0, MAX_FAILED_JOBS);
    const results = [];
    for (const job of failed) {
      const step = Array.isArray(job.steps) ? job.steps.find(item => failureConclusions.has(item?.conclusion)) : undefined;
      const log = token && Number.isSafeInteger(job.id) ? await jobLogTail(repository, job.id).catch(() => undefined) : undefined;
      results.push({
        ...(typeof job.name === 'string' ? { job: job.name } : {}),
        ...(typeof step?.name === 'string' ? { stage: step.name } : {}),
        reason: job.conclusion,
        ...(log ? { log } : {})
      });
    }
    return results;
  }

  async function createPullRequest(repository, input) {
    const value = await call('POST', apiUrl(`${repoPath(repository)}/pulls`), { title: input.title, body: input.body ?? '', head: input.head, base: input.base, draft: input.draft === true });
    if (!Number.isSafeInteger(value?.number) || typeof value.html_url !== 'string') throw new GithubError('GITHUB_RESPONSE_INVALID', 'GitHub did not return the created pull request');
    return { id: String(value.node_id ?? value.id), number: value.number, url: value.html_url };
  }

  const comment = (kind, value) => ({
    id: `${kind}:${value.id}`,
    ...(typeof value.user?.login === 'string' ? { author: value.user.login } : {}),
    body: typeof value.body === 'string' ? value.body : '',
    ...(typeof value.path === 'string' ? { path: value.path } : {}),
    ...(Number.isSafeInteger(value.line) ? { line: value.line } : Number.isSafeInteger(value.original_line) ? { line: value.original_line } : {}),
    ...(typeof value.html_url === 'string' ? { url: value.html_url } : {}),
    ...(typeof value.created_at === 'string' ? { createdAt: value.created_at } : {})
  });

  /** 行内评审意见和普通评论合在一起，按时间排序。 */
  async function listReviewComments(repository, pullRequest) {
    if (!Number.isSafeInteger(pullRequest) || pullRequest <= 0) throw new GithubError('GITHUB_PULL_REQUEST_INVALID', 'Pull request number is invalid', 400);
    const [review, issue] = await Promise.all([
      getPublic(apiUrl(`${repoPath(repository)}/pulls/${pullRequest}/comments`, { per_page: 100 })),
      getPublic(apiUrl(`${repoPath(repository)}/issues/${pullRequest}/comments`, { per_page: 100 }))
    ]);
    const items = [...(Array.isArray(review) ? review.map(value => comment('review', value)) : []), ...(Array.isArray(issue) ? issue.map(value => comment('issue', value)) : [])];
    return items.sort((left, right) => (left.createdAt ?? '').localeCompare(right.createdAt ?? ''));
  }

  async function postComment(repository, pullRequest, body) {
    if (!Number.isSafeInteger(pullRequest) || pullRequest <= 0) throw new GithubError('GITHUB_PULL_REQUEST_INVALID', 'Pull request number is invalid', 400);
    const value = await call('POST', apiUrl(`${repoPath(repository)}/issues/${pullRequest}/comments`), { body });
    return { id: String(value?.id), ...(typeof value?.html_url === 'string' ? { url: value.html_url } : {}) };
  }

  /** X-Hub-Signature-256: sha256=HMAC-SHA256(secret, 原始请求体)。 */
  function verify(webhookRequest) {
    const signature = header(webhookRequest.headers, 'x-hub-signature-256')?.trim().toLowerCase();
    const expected = `sha256=${createHmac('sha256', options.webhookSecret).update(webhookRequest.rawBody).digest('hex')}`;
    if (!signature || !digestEqual(signature, expected)) return { ok: false, statusCode: 401, code: 'WEBHOOK_SIGNATURE_INVALID', message: 'GitHub webhook 签名无效' };
    return { ok: true };
  }

  const bodyOf = webhookRequest => {
    const raw = webhookRequest.rawBody.toString('utf8');
    const type = String(header(webhookRequest.headers, 'content-type') ?? '');
    const text = type.includes('application/x-www-form-urlencoded') ? new URLSearchParams(raw).get('payload') ?? '' : raw;
    try { return JSON.parse(text); } catch { throw badRequest('请求体不是合法 JSON'); }
  };

  /**
   * workflow_run 完成时按这个提交的全部构建汇总：还有没完成的就先不报；全部完成后报 success 或 failed，
   * 同一汇总结果用同一个 eventId，多条 workflow_run 事件只触发一次。查不到汇总时按单条构建的结论报。
   */
  async function parse(webhookRequest) {
    const kind = header(webhookRequest.headers, 'x-github-event');
    const delivery = header(webhookRequest.headers, 'x-github-delivery')?.trim();
    if (kind !== 'workflow_run' && kind !== 'pull_request') return undefined;
    const body = bodyOf(webhookRequest);
    const slug = body?.repository?.full_name;
    if (typeof slug !== 'string') return undefined;
    const operator = typeof body.sender?.login === 'string' ? body.sender.login : undefined;
    if (kind === 'pull_request') {
      const pull = body.pull_request ?? {};
      const action = body.action === 'closed' ? (pull.merged ? 'merge' : 'close')
        : body.action === 'opened' ? 'open' : body.action === 'reopened' ? 'reopen'
        : ['synchronize', 'edited'].includes(body.action) ? 'update' : undefined;
      if (!action) return undefined;
      return {
        kind: 'pull_request', repository: slug, state: action,
        ...(typeof pull.head?.ref === 'string' ? { branch: pull.head.ref } : {}),
        ...(Number.isSafeInteger(pull.number) ? { pullRequest: pull.number } : {}),
        ...(typeof pull.head?.sha === 'string' ? { headSha: pull.head.sha } : {}),
        ...(typeof pull.html_url === 'string' ? { url: pull.html_url } : {}),
        ...(operator ? { operator } : {}),
        ...(delivery ? { eventId: `delivery:${delivery}` } : {}),
        ...(time(pull.updated_at) ? { occurredAt: time(pull.updated_at) } : {})
      };
    }
    const run = body.workflow_run;
    if (body.action !== 'completed' || !run || typeof run.head_sha !== 'string') return undefined;
    const headSha = run.head_sha.toLowerCase();
    const base = {
      kind: 'pipeline', repository: slug, headSha,
      ...(typeof run.head_branch === 'string' ? { branch: run.head_branch } : {}),
      ...(Number.isSafeInteger(run.pull_requests?.[0]?.number) ? { pullRequest: run.pull_requests[0].number } : {}),
      ...(operator ? { operator } : {}),
      ...(time(run.updated_at) ? { occurredAt: time(run.updated_at) } : {})
    };
    const [owner, name] = slug.split('/');
    let runs;
    try { runs = await queryRuns({ owner, name, slug }, headSha, undefined, false); } catch { runs = undefined; }
    if (runs?.length) {
      const state = summarizeRuns(runs);
      if (state !== 'success' && state !== 'failed') return undefined;
      const failed = runs.find(item => item.result === 'failed');
      const shown = failed ?? runs.at(-1);
      const fingerprint = createHash('sha256').update(`${slug}\0${headSha}\0${state}\0${runs.map(item => `${item.id}.${item.attempt}`).join(',')}`).digest('hex');
      return { ...base, state, runId: String(shown.id), url: shown.url, eventId: `aggregate:${fingerprint}` };
    }
    const result = runResult(run.conclusion);
    if (result !== 'success' && result !== 'failed') return undefined;
    return { ...base, state: result, ...(Number.isSafeInteger(run.id) ? { runId: String(run.id) } : {}), ...(typeof run.html_url === 'string' ? { url: run.html_url } : {}), ...(delivery ? { eventId: `delivery:${delivery}` } : {}) };
  }

  return {
    id: 'github',
    displayName: 'GitHub Actions',
    changeRequestLabel: number => `PR #${number}`,
    matchRepository: repositoryFromRemote,
    getPipelineStatus,
    getFailureLogs,
    createPullRequest,
    listReviewComments,
    postComment,
    ...(options.webhookSecret ? { webhook: { verify, parse } } : {})
  };
}
