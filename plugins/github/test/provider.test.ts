import { execFile } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CiProviderRegistry, resolveCiHead } from '../../../apps/server/src/ci-providers.js';
import { createGithubProvider, repositoryFromRemote } from '../provider.mjs';

const run = promisify(execFile);
const directories: string[] = [];
const repo = { owner: 'octo', name: 'repo', slug: 'octo/repo' };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const workflowRun = (overrides: Record<string, unknown> = {}) => ({
  id: 42, name: 'CI', workflow_id: 7, head_sha: 'a'.repeat(40), head_repository: { full_name: 'octo/repo' }, status: 'completed', conclusion: 'failure',
  html_url: 'https://github.com/octo/repo/actions/runs/42', created_at: '2026-09-12T00:00:00Z', updated_at: '2026-09-12T00:01:00Z', ...overrides
});

async function repository(remote = 'git@github.com:octo-org/example.git') {
  const cwd = await mkdtemp(join(tmpdir(), 'dutydeck-ci-git-'));
  directories.push(cwd);
  await run('git', ['init', '-q', cwd]);
  await run('git', ['-C', cwd, 'config', 'user.email', 'test@example.com']);
  await run('git', ['-C', cwd, 'config', 'user.name', 'Test']);
  await run('git', ['-C', cwd, 'commit', '--allow-empty', '-qm', 'initial']);
  await run('git', ['-C', cwd, 'remote', 'add', 'origin', remote]);
  return cwd;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('GitHub provider: repositories and Actions runs', () => {
  it('resolves github.com origin and the full current HEAD from a real repository', async () => {
    const registry = new CiProviderRegistry();
    registry.register('github', createGithubProvider());
    const resolved = await resolveCiHead(await repository('https://github.com/Octo-Org/example.git'), registry);
    expect(resolved.provider.id).toBe('github');
    expect(resolved.repository).toEqual({ owner: 'Octo-Org', name: 'example', slug: 'Octo-Org/example' });
    expect(resolved.headSha).toMatch(/^[a-f0-9]{40}$/);
  });

  it('rejects non-GitHub and credential-bearing HTTPS origins', async () => {
    const registry = new CiProviderRegistry();
    registry.register('github', createGithubProvider());
    await expect(resolveCiHead(await repository('https://example.com/org/repo.git'), registry)).rejects.toMatchObject({ code: 'CI_REMOTE_UNSUPPORTED' });
    await expect(resolveCiHead(await repository('https://token@github.com/org/repo.git'), registry)).rejects.toMatchObject({ code: 'CI_REMOTE_UNSUPPORTED' });
    expect(repositoryFromRemote('git@github.com:octo/repo.git')).toEqual(repo);
    expect(repositoryFromRemote('ssh://git@github.com/octo/repo.git')).toEqual(repo);
    expect(repositoryFromRemote('https://github.com/octo/repo/extra')).toBeUndefined();
  });

  it('queries public repositories anonymously, pins HEAD, caps the page and does not follow redirects', async () => {
    const token = 'server-secret-token';
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.origin).toBe('https://api.github.com');
      expect(url.pathname).toBe('/repos/octo/repo/actions/workflows/ci.yml/runs');
      expect(url.searchParams.get('head_sha')).toBe('a'.repeat(40));
      expect(url.searchParams.get('status')).toBe('completed');
      expect(url.searchParams.get('per_page')).toBe('100');
      expect(init?.redirect).toBe('manual');
      expect((init?.headers as Record<string, string>).Authorization).toBeUndefined();
      expect((init?.headers as Record<string, string>)['X-GitHub-Api-Version']).toBe('2026-03-10');
      return json({ workflow_runs: [workflowRun()] });
    });
    const provider = createGithubProvider({ token, fetch: request as typeof fetch });
    await expect(provider.getPipelineStatus({ repository: repo, sha: 'a'.repeat(40), workflow: 'ci.yml', completedOnly: true })).resolves.toEqual({
      state: 'failed',
      runs: [expect.objectContaining({ id: 42, conclusion: 'failure', result: 'failed', headSha: 'a'.repeat(40), url: 'https://github.com/octo/repo/actions/runs/42' })]
    });
  });

  it('uses the server token only after an anonymous private-repository response', async () => {
    const calls: Array<Record<string, string>> = [];
    const request = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      calls.push(init?.headers as Record<string, string>);
      if (calls.length === 1) return new Response('', { status: 404 });
      return json({ workflow_runs: [] });
    });
    const provider = createGithubProvider({ token: 'private-token', fetch: request as typeof fetch });
    await expect(provider.getPipelineStatus({ repository: { owner: 'octo', name: 'private', slug: 'octo/private' }, sha: 'c'.repeat(40), completedOnly: true })).resolves.toEqual({ state: 'unknown', runs: [] });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.Authorization).toBeUndefined();
    expect(calls[1]?.Authorization).toBe('Bearer private-token');
  });

  it('can query the complete HEAD run set without a completed-status filter and keeps the latest attempt', async () => {
    const request = vi.fn(async (input: string | URL | Request) => {
      expect(new URL(String(input)).searchParams.has('status')).toBe(false);
      return json({ total_count: 2, workflow_runs: [
        workflowRun({ id: 43, head_sha: 'd'.repeat(40), run_attempt: 1, conclusion: 'failure' }),
        workflowRun({ id: 43, head_sha: 'd'.repeat(40), run_attempt: 2, status: 'in_progress', conclusion: null })
      ] });
    });
    const provider = createGithubProvider({ fetch: request as typeof fetch });
    await expect(provider.getPipelineStatus({ repository: repo, sha: 'd'.repeat(40) })).resolves.toEqual({
      state: 'running', runs: [expect.objectContaining({ id: 43, status: 'running', attempt: 2 })]
    });
  });

  it('rejects redirects and never includes response bodies or tokens in errors', async () => {
    const redirect = createGithubProvider({ token: 'do-not-leak', fetch: vi.fn(async () => new Response('', { status: 302, headers: { location: 'https://evil.example/' } })) as typeof fetch });
    await expect(redirect.getPipelineStatus({ repository: { owner: 'o', name: 'r', slug: 'o/r' }, sha: 'b'.repeat(40), completedOnly: true })).rejects.toMatchObject({ code: 'GITHUB_REDIRECT_REJECTED' });
    const denied = createGithubProvider({ token: 'do-not-leak', fetch: vi.fn(async () => new Response('body-secret', { status: 403 })) as typeof fetch });
    const error = await denied.getPipelineStatus({ repository: { owner: 'o', name: 'r', slug: 'o/r' }, sha: 'b'.repeat(40), completedOnly: true }).catch(cause => cause as Error);
    expect(error.message).toBe('GitHub API returned HTTP 403');
    expect(JSON.stringify(error)).not.toContain('do-not-leak');
    expect(error.message).not.toContain('body-secret');
  });

  it('maps conclusions to the host result values and drops runs from other hosts', async () => {
    const provider = createGithubProvider({ fetch: vi.fn(async () => json({ workflow_runs: [
      workflowRun({ id: 1, conclusion: 'timed_out' }),
      workflowRun({ id: 2, conclusion: 'cancelled' }),
      workflowRun({ id: 3, conclusion: 'success', html_url: 'https://evil.example/octo/repo/actions/runs/3' })
    ] })) as typeof fetch });
    const status = await provider.getPipelineStatus({ repository: repo, sha: 'a'.repeat(40) });
    expect(status.runs.map(item => [item.id, item.result])).toEqual([[1, 'failed'], [2, 'cancelled']]);
    expect(status.state).toBe('failed');
  });
});

describe('GitHub provider: failure logs and pull requests', () => {
  it('starts at most ten log downloads concurrently and preserves job order with an individual failure', async () => {
    const releases = new Map<number, (response: Response) => void>();
    const downloads = new Map<number, (response: Response | Error) => void>();
    const completed: number[] = [];
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/runs/42/jobs')) return json({ jobs: Array.from({ length: 12 }, (_, id) => ({ id: id + 1, name: `job-${id + 1}`, conclusion: 'failure' })) });
      if (url.origin === 'https://api.github.com') {
        expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer synthetic-token');
        const id = Number(/\/jobs\/(\d+)\/logs$/.exec(url.pathname)![1]);
        return new Promise<Response>(resolve => releases.set(id, resolve));
      }
      expect(url.origin).toBe('https://logs.example');
      expect(init?.headers).toBeUndefined();
      const id = Number(url.pathname.slice(1));
      return new Promise<Response>((resolve, reject) => downloads.set(id, response => { completed.push(id); if (response instanceof Error) reject(response); else resolve(response); }));
    });
    const provider = createGithubProvider({ token: 'synthetic-token', fetch: request as typeof fetch });
    const pending = provider.getFailureLogs(repo, '42');
    await vi.waitFor(() => expect([...releases.keys()]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
    for (const [id, release] of releases) release(new Response('', { status: 302, headers: { location: `https://logs.example/${id}` } }));
    await vi.waitFor(() => expect(downloads.size).toBe(10));
    for (let id = 10; id >= 1; id--) downloads.get(id)!(id === 4 ? new Error('synthetic download failure') : new Response(`log-${id}`));
    const failures = await pending;
    expect(completed).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    expect(failures).toEqual(Array.from({ length: 10 }, (_, index) => ({ job: `job-${index + 1}`, reason: 'failure', ...(index === 3 ? {} : { log: `log-${index + 1}` }) })));
    expect(request).toHaveBeenCalledTimes(21);
  });

  it('reads failed jobs and follows the log redirect without sending the token to the download host', async () => {
    const seen: Array<{ url: string; auth?: string }> = [];
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      seen.push({ url, auth: (init?.headers as Record<string, string> | undefined)?.Authorization });
      if (url.includes('/actions/runs/42/jobs')) return json({ jobs: [
        { id: 7, name: 'test', conclusion: 'failure', steps: [{ name: 'checkout', conclusion: 'success' }, { name: 'pnpm test', conclusion: 'failure' }] },
        { id: 8, name: 'lint', conclusion: 'success', steps: [] }
      ] });
      if (url.includes('/actions/jobs/7/logs')) return new Response('', { status: 302, headers: { location: 'https://logs.example/job-7.txt' } });
      if (url === 'https://logs.example/job-7.txt') return new Response(`${'x'.repeat(5_000)}\nError: boom`);
      throw new Error(`unexpected ${url}`);
    });
    const provider = createGithubProvider({ token: 'secret-token', fetch: request as typeof fetch });
    const failures = await provider.getFailureLogs(repo, '42');
    expect(failures).toEqual([{ job: 'test', stage: 'pnpm test', reason: 'failure', log: expect.stringMatching(/Error: boom$/) }]);
    expect(failures[0]!.log!.length).toBe(3_000);
    expect(seen.find(item => item.url.startsWith('https://logs.example'))?.auth).toBeUndefined();
    expect(seen.find(item => item.url.includes('/jobs/7/logs'))?.auth).toBe('Bearer secret-token');
  });

  it('creates pull requests, lists review and issue comments and posts comments with the token', async () => {
    const bodies: Array<{ method?: string; url: string; body?: unknown }> = [];
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      bodies.push({ method: init?.method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      expect((init?.headers as Record<string, string>).Authorization ?? 'Bearer t').toBe('Bearer t');
      if (url.endsWith('/pulls') && init?.method === 'POST') return json({ id: 1, node_id: 'PR_1', number: 5, html_url: 'https://github.com/octo/repo/pull/5' }, 201);
      if (url.includes('/pulls/5/comments')) return json([{ id: 11, user: { login: 'alice', type: 'User' }, author_association: 'MEMBER', body: 'rename this', path: 'src/a.ts', line: 3, created_at: '2026-10-01T00:00:02Z' }]);
      if (url.includes('/issues/5/comments') && init?.method === 'GET') return json([
        { id: 12, user: { login: 'bob', type: 'User' }, author_association: 'CONTRIBUTOR', body: 'LGTM', created_at: '2026-10-01T00:00:01Z' },
        { id: 14, user: { login: 'codecov[bot]', type: 'Bot' }, author_association: 'COLLABORATOR', body: 'Coverage 80%', created_at: '2026-10-01T00:00:03Z' }
      ]);
      if (url.includes('/issues/5/comments')) return json({ id: 13, html_url: 'https://github.com/octo/repo/pull/5#issuecomment-13' }, 201);
      throw new Error(`unexpected ${url}`);
    });
    const provider = createGithubProvider({ token: 't', fetch: request as typeof fetch });
    await expect(provider.createPullRequest(repo, { title: 'Fix', head: 'fix', base: 'main' })).resolves.toEqual({ id: 'PR_1', number: 5, url: 'https://github.com/octo/repo/pull/5' });
    expect(bodies[0]).toMatchObject({ method: 'POST', body: { title: 'Fix', head: 'fix', base: 'main', body: '', draft: false } });
    await expect(provider.listReviewComments(repo, 5)).resolves.toEqual([
      { id: 'issue:12', author: 'bob', trusted: false, isBot: false, authorAssociation: 'CONTRIBUTOR', body: 'LGTM', createdAt: '2026-10-01T00:00:01Z' },
      { id: 'review:11', author: 'alice', trusted: true, isBot: false, authorAssociation: 'MEMBER', body: 'rename this', path: 'src/a.ts', line: 3, createdAt: '2026-10-01T00:00:02Z' },
      { id: 'issue:14', author: 'codecov[bot]', trusted: false, isBot: true, authorAssociation: 'COLLABORATOR', body: 'Coverage 80%', createdAt: '2026-10-01T00:00:03Z' }
    ]);
    // 发出的回复 id 和列表里普通评论的 id 同一写法，跟进时才能认出是自己发的。
    await expect(provider.postComment(repo, 5, 'done')).resolves.toEqual({ id: 'issue:13', url: 'https://github.com/octo/repo/pull/5#issuecomment-13' });
    expect(bodies.at(-1)).toMatchObject({ method: 'POST', body: { body: 'done' } });
  });

  it('refuses write calls without a token instead of sending anonymous requests', async () => {
    const request = vi.fn();
    const provider = createGithubProvider({ fetch: request as unknown as typeof fetch });
    await expect(provider.createPullRequest(repo, { title: 'x', head: 'a', base: 'b' })).rejects.toMatchObject({ code: 'GITHUB_TOKEN_REQUIRED' });
    await expect(provider.postComment(repo, 5, 'x')).rejects.toMatchObject({ code: 'GITHUB_TOKEN_REQUIRED' });
    expect(request).not.toHaveBeenCalled();
  });
});

describe('GitHub provider: pull request follow-up', () => {
  it('reads the pull request state: open, merged or closed without merge', async () => {
    const pulls: Record<number, unknown> = {
      1: { number: 1, state: 'open', merged: false, merged_at: null, head: { sha: 'A'.repeat(40) } },
      2: { number: 2, state: 'closed', merged: true, merged_at: '2026-10-01T00:00:00Z', head: { sha: 'b'.repeat(40) } },
      3: { number: 3, state: 'closed', merged: false, merged_at: null }
    };
    const request = vi.fn(async (input: string | URL | Request) => {
      const match = /\/repos\/octo\/repo\/pulls\/(\d+)$/.exec(new URL(String(input)).pathname);
      return match ? json(pulls[Number(match[1])]) : new Response('', { status: 404 });
    });
    const provider = createGithubProvider({ token: 't', fetch: request as typeof fetch });
    await expect(provider.getPullRequest(repo, 1)).resolves.toEqual({ state: 'open', headSha: 'a'.repeat(40) });
    await expect(provider.getPullRequest(repo, 2)).resolves.toEqual({ state: 'merged', headSha: 'b'.repeat(40) });
    await expect(provider.getPullRequest(repo, 3)).resolves.toEqual({ state: 'closed' });
    await expect(provider.getPullRequest(repo, 0)).rejects.toMatchObject({ code: 'GITHUB_PULL_REQUEST_INVALID' });
  });

  it('reads private review comments with the token after an anonymous 404', async () => {
    const auth: Array<string | undefined> = [];
    const request = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const value = (init?.headers as Record<string, string>).Authorization;
      auth.push(value);
      return value ? json([]) : new Response('', { status: 404 });
    });
    const provider = createGithubProvider({ token: 'private-token', fetch: request as typeof fetch });
    await expect(provider.listReviewComments(repo, 5)).resolves.toEqual([]);
    expect(auth.filter(value => value === undefined)).toHaveLength(2);
    expect(auth.filter(value => value === 'Bearer private-token')).toHaveLength(2);
  });

  it('reports a rejected pull request creation without leaking the response body or the token', async () => {
    const provider = createGithubProvider({ token: 'do-not-leak', fetch: vi.fn(async () => new Response('{"message":"A pull request already exists body-secret"}', { status: 422 })) as typeof fetch });
    const error = await provider.createPullRequest(repo, { title: 'x', head: 'dutydeck/x-1', base: 'main' }).catch(cause => cause as Error & { code?: string });
    expect(error).toMatchObject({ code: 'GITHUB_RESPONSE_ERROR', message: 'GitHub API returned HTTP 422' });
    expect(JSON.stringify(error)).not.toContain('do-not-leak');
    expect(error.message).not.toContain('body-secret');
    await expect(provider.postComment(repo, -1, 'x')).rejects.toMatchObject({ code: 'GITHUB_PULL_REQUEST_INVALID' });
  });
});

describe('GitHub provider: webhook', () => {
  const secret = 'hook-secret';
  const signed = (body: unknown, event: string, extra: Record<string, string> = {}) => {
    const rawBody = Buffer.from(JSON.stringify(body));
    return { rawBody, headers: { 'x-github-event': event, 'x-github-delivery': 'd-1', 'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`, ...extra } };
  };
  const pipelineBody = { action: 'completed', repository: { full_name: 'octo/repo' }, sender: { login: 'alice' }, workflow_run: { ...workflowRun(), head_branch: 'feature', pull_requests: [{ number: 5 }] } };

  it('only exposes a webhook when a secret is configured', () => {
    expect(createGithubProvider().webhook).toBeUndefined();
    expect(createGithubProvider({ webhookSecret: secret }).webhook).toBeDefined();
  });

  it('verifies X-Hub-Signature-256 over the raw body', () => {
    const { webhook } = createGithubProvider({ webhookSecret: secret });
    const request = signed(pipelineBody, 'workflow_run');
    expect(webhook!.verify(request)).toEqual({ ok: true });
    expect(webhook!.verify({ ...request, rawBody: Buffer.from(`${request.rawBody} `) })).toMatchObject({ ok: false, statusCode: 401, code: 'WEBHOOK_SIGNATURE_INVALID' });
    expect(webhook!.verify({ ...request, headers: { ...request.headers, 'x-hub-signature-256': undefined } })).toMatchObject({ ok: false, statusCode: 401 });
  });

  it('reports a completed commit once with an aggregate event id, and waits while other runs are still running', async () => {
    let runs = [workflowRun(), workflowRun({ id: 43, status: 'in_progress', conclusion: null })];
    const provider = createGithubProvider({ webhookSecret: secret, fetch: vi.fn(async () => json({ workflow_runs: runs })) as typeof fetch });
    await expect(provider.webhook!.parse(signed(pipelineBody, 'workflow_run'))).resolves.toBeUndefined();
    runs = [workflowRun(), workflowRun({ id: 43, conclusion: 'success' })];
    const first = await provider.webhook!.parse(signed(pipelineBody, 'workflow_run'));
    const second = await provider.webhook!.parse(signed({ ...pipelineBody, workflow_run: { ...pipelineBody.workflow_run, id: 43 } }, 'workflow_run', { 'x-github-delivery': 'd-2' }));
    expect(first).toMatchObject({ kind: 'pipeline', repository: 'octo/repo', branch: 'feature', pullRequest: 5, headSha: 'a'.repeat(40), state: 'failed', runId: '42', operator: 'alice', occurredAt: Date.parse('2026-09-12T00:01:00Z') });
    expect(first!.eventId).toMatch(/^aggregate:[a-f0-9]{64}$/);
    expect(second!.eventId).toBe(first!.eventId);
  });

  it('falls back to the single run conclusion when the run list cannot be read', async () => {
    const provider = createGithubProvider({ webhookSecret: secret, fetch: vi.fn(async () => new Response('', { status: 500 })) as typeof fetch });
    await expect(provider.webhook!.parse(signed(pipelineBody, 'workflow_run'))).resolves.toMatchObject({ state: 'failed', runId: '42', eventId: 'delivery:d-1' });
  });

  it('does not report success when the run list cannot be read, but still reports a failure', async () => {
    const provider = createGithubProvider({ webhookSecret: secret, fetch: vi.fn(async () => new Response('', { status: 500 })) as typeof fetch });
    const succeeded = { ...pipelineBody, workflow_run: { ...pipelineBody.workflow_run, conclusion: 'success' } };
    await expect(provider.webhook!.parse(signed(succeeded, 'workflow_run'))).resolves.toBeUndefined();
    const empty = createGithubProvider({ webhookSecret: secret, fetch: vi.fn(async () => json({ workflow_runs: [] })) as typeof fetch });
    await expect(empty.webhook!.parse(signed(succeeded, 'workflow_run'))).resolves.toBeUndefined();
  });

  it('ignores events and runs whose head repository is a fork', async () => {
    const forkRun = { ...pipelineBody.workflow_run, head_repository: { full_name: 'mallory/repo' } };
    const provider = createGithubProvider({ webhookSecret: secret, fetch: vi.fn(async () => json({ workflow_runs: [workflowRun({ conclusion: 'success' }), workflowRun({ id: 43, head_repository: { full_name: 'mallory/repo' } })] })) as typeof fetch });
    await expect(provider.webhook!.parse(signed({ ...pipelineBody, workflow_run: forkRun }, 'workflow_run'))).resolves.toBeUndefined();
    const fork = { action: 'synchronize', repository: { full_name: 'octo/repo' }, pull_request: { number: 5, head: { ref: 'feature', sha: 'b'.repeat(40), repo: { full_name: 'mallory/repo' } } } };
    await expect(provider.webhook!.parse(signed(fork, 'pull_request'))).resolves.toBeUndefined();
    await expect(provider.webhook!.parse(signed({ ...fork, pull_request: { ...fork.pull_request, head: { ref: 'feature', repo: null } } }, 'pull_request'))).resolves.toBeUndefined();
    // 汇总里也不算 fork 的失败：本仓库的构建全部成功
    await expect(provider.getPipelineStatus({ repository: repo, sha: 'a'.repeat(40) })).resolves.toMatchObject({ state: 'success', runs: [expect.objectContaining({ id: 42 })] });
    await expect(provider.webhook!.parse(signed(pipelineBody, 'workflow_run'))).resolves.toMatchObject({ state: 'success' });
  });

  it('marks event times as advisory so redelivered events are not replay-rejected', async () => {
    const provider = createGithubProvider({ webhookSecret: secret, fetch: vi.fn(async () => json({ workflow_runs: [workflowRun()] })) as typeof fetch });
    await expect(provider.webhook!.parse(signed(pipelineBody, 'workflow_run'))).resolves.toMatchObject({ timeIsAdvisory: true, eventId: expect.stringMatching(/^aggregate:/) });
    const pull = { action: 'opened', repository: { full_name: 'octo/repo' }, pull_request: { number: 5, updated_at: '2026-09-12T00:01:00Z', head: { repo: { full_name: 'octo/repo' } } } };
    await expect(provider.webhook!.parse(signed(pull, 'pull_request'))).resolves.toMatchObject({ timeIsAdvisory: true, eventId: 'delivery:d-1' });
  });

  it('maps pull_request actions and ignores other events', async () => {
    const provider = createGithubProvider({ webhookSecret: secret });
    const pull = (action: string, merged = false) => ({ action, repository: { full_name: 'octo/repo' }, pull_request: { number: 5, merged, head: { ref: 'feature', sha: 'b'.repeat(40), repo: { full_name: 'octo/repo' } }, html_url: 'https://github.com/octo/repo/pull/5' } });
    await expect(provider.webhook!.parse(signed(pull('closed', true), 'pull_request'))).resolves.toMatchObject({ kind: 'pull_request', state: 'merge', pullRequest: 5, branch: 'feature', eventId: 'delivery:d-1' });
    await expect(provider.webhook!.parse(signed(pull('closed'), 'pull_request'))).resolves.toMatchObject({ state: 'close' });
    await expect(provider.webhook!.parse(signed(pull('synchronize'), 'pull_request'))).resolves.toMatchObject({ state: 'update' });
    await expect(provider.webhook!.parse(signed(pull('labeled'), 'pull_request'))).resolves.toBeUndefined();
    await expect(provider.webhook!.parse(signed({ zen: 'hi' }, 'ping'))).resolves.toBeUndefined();
  });

  it('rejects malformed bodies with a 400 error and accepts form-encoded payloads', async () => {
    const provider = createGithubProvider({ webhookSecret: secret });
    await expect(provider.webhook!.parse({ rawBody: Buffer.from('{'), headers: { 'x-github-event': 'pull_request' } })).rejects.toMatchObject({ statusCode: 400 });
    const form = Buffer.from(`payload=${encodeURIComponent(JSON.stringify({ action: 'opened', repository: { full_name: 'octo/repo' }, pull_request: { number: 9, head: { repo: { full_name: 'octo/repo' } } } }))}`);
    await expect(provider.webhook!.parse({ rawBody: form, headers: { 'x-github-event': 'pull_request', 'content-type': 'application/x-www-form-urlencoded' } })).resolves.toMatchObject({ state: 'open', pullRequest: 9 });
  });
});

describe('GitHub provider: pagination and response budgets', () => {
  it('reads every review and issue comment page, including private pages', async () => {
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (!(init?.headers as Record<string, string>).Authorization) return new Response('', { status: 404 });
      const page = Number(url.searchParams.get('page') ?? 1);
      const kind = url.pathname.includes('/pulls/') ? 'review' : 'issue';
      return new Response(JSON.stringify([{ id: page, body: `${kind} ${page}` }]), { headers: page < 3 ? { link: `<${url.origin}${url.pathname}?per_page=100&page=${page + 1}>; rel="next"` } : {} });
    });
    const provider = createGithubProvider({ token: 'private-token', fetch: request as typeof fetch });
    const comments = await provider.listReviewComments(repo, 5);
    expect(comments.map(comment => comment.id).sort()).toEqual(['issue:1', 'issue:2', 'issue:3', 'review:1', 'review:2', 'review:3']);
    expect(request).toHaveBeenCalledTimes(12);
  });

  it.each(['https://evil.example/comments?page=2&per_page=100', 'https://token@api.github.com/repos/octo/repo/pulls/5/comments?page=2&per_page=100', 'https://api.github.com/repos/other/repo/pulls/5/comments?page=2&per_page=100', 'https://api.github.com/repos/octo/repo/pulls/5/comments?page=1&per_page=100'])(
    'rejects unsafe or looping pagination before sending credentials: %s', async next => {
      const request = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => !(init?.headers as Record<string, string>).Authorization
        ? new Response('', { status: 404 }) : new Response('[]', { headers: { link: `<${next}>; rel="next"` } }));
      const provider = createGithubProvider({ token: 'private-token', fetch: request as typeof fetch });
      await expect(provider.listReviewComments(repo, 5)).rejects.toMatchObject({ code: 'GITHUB_PAGINATION_INVALID' });
      expect(request.mock.calls.every(([input]) => { const url = new URL(String(input)); return url.origin === 'https://api.github.com' && !url.username && !url.password && url.pathname.startsWith('/repos/octo/repo/'); })).toBe(true);
      expect(request).toHaveBeenCalledTimes(4);
    });

  it('fails explicitly when comment pagination exhausts the shared page budget', async () => {
    const request = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const page = Number(url.searchParams.get('page') ?? 1);
      return new Response('[]', { headers: { link: `<${url.origin}${url.pathname}?per_page=100&page=${page + 1}>; rel="next"` } });
    });
    const provider = createGithubProvider({ fetch: request as typeof fetch });
    await expect(provider.listReviewComments(repo, 5)).rejects.toMatchObject({ code: 'GITHUB_COMMENT_SET_TOO_LARGE' });
    expect(request).toHaveBeenCalledTimes(100);
  });

  it('fails explicitly when comment pages exhaust their shared byte budget', async () => {
    const request = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const page = Number(url.searchParams.get('page') ?? 1);
      return new Response(JSON.stringify([{ id: page, body: 'x'.repeat(1024 * 1024) }]), { headers: { link: `<${url.origin}${url.pathname}?per_page=100&page=${page + 1}>; rel="next"` } });
    });
    const provider = createGithubProvider({ fetch: request as typeof fetch });
    await expect(provider.listReviewComments(repo, 5)).rejects.toMatchObject({ code: 'GITHUB_COMMENT_SET_TOO_LARGE' });
    expect(request.mock.calls.length).toBeLessThanOrEqual(10);
  });

  const stream = (bytes: number, headers: Record<string, string> = {}) => {
    let sent = 0;
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { if (sent >= bytes) return controller.close(); const chunk = new Uint8Array(Math.min(64 * 1024, bytes - sent)).fill(120); sent += chunk.byteLength; controller.enqueue(chunk); },
      cancel
    }, { highWaterMark: 0 });
    return { response: new Response(body, { headers }), cancel, sent: () => sent };
  };

  it.each([{}, { 'content-length': '1' }])('cancels oversized JSON while reading even with missing or false lengths: %j', async headers => {
    const body = stream(4 * 1024 * 1024, headers);
    const provider = createGithubProvider({ fetch: vi.fn(async () => body.response) as typeof fetch });
    await expect(provider.getPipelineStatus({ repository: repo, sha: 'a'.repeat(40) })).rejects.toMatchObject({ code: 'GITHUB_RESPONSE_TOO_LARGE' });
    expect(body.cancel).toHaveBeenCalledOnce();
    expect(body.sent()).toBeLessThan(4 * 1024 * 1024);
  });

  it.each([{}, { 'content-length': '1' }])('cancels oversized logs while reading even with missing or false lengths: %j', async headers => {
    const body = stream(10 * 1024 * 1024, headers);
    const provider = createGithubProvider({ token: 't', fetch: vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/runs/')) return json({ jobs: [{ id: 7, name: 'test', conclusion: 'failure', steps: [{ name: 'pnpm test', conclusion: 'failure' }] }] });
      if (url.includes('/jobs/')) return new Response('', { status: 302, headers: { location: 'https://logs.example/test' } });
      return body.response;
    }) as typeof fetch });
    await expect(provider.getFailureLogs(repo, '42')).resolves.toEqual([{ job: 'test', stage: 'pnpm test', reason: 'failure' }]);
    expect(body.cancel).toHaveBeenCalledOnce();
    expect(body.sent()).toBeLessThan(10 * 1024 * 1024);
  });

  it('cancels declared oversized JSON and logs before consuming their bodies', async () => {
    const jsonBody = stream(1024, { 'content-length': String(2 * 1024 * 1024 + 1) });
    const jsonProvider = createGithubProvider({ fetch: vi.fn(async () => jsonBody.response) as typeof fetch });
    await expect(jsonProvider.getPipelineStatus({ repository: repo, sha: 'a'.repeat(40) })).rejects.toMatchObject({ code: 'GITHUB_RESPONSE_TOO_LARGE' });
    expect(jsonBody.sent()).toBe(0);
    expect(jsonBody.cancel).toHaveBeenCalledOnce();
    const logBody = stream(1024, { 'content-length': String(8 * 1024 * 1024 + 1) });
    const logProvider = createGithubProvider({ token: 't', fetch: vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/runs/')) return json({ jobs: [{ id: 7, name: 'test', conclusion: 'failure', steps: [{ name: 'pnpm test', conclusion: 'failure' }] }] });
      if (url.includes('/jobs/')) return new Response('', { status: 302, headers: { location: 'https://logs.example/test' } });
      return logBody.response;
    }) as typeof fetch });
    await expect(logProvider.getFailureLogs(repo, '42')).resolves.toEqual([{ job: 'test', stage: 'pnpm test', reason: 'failure' }]);
    expect(logBody.sent()).toBe(0);
    expect(logBody.cancel).toHaveBeenCalledOnce();
  });

  it('decodes UTF-8 across chunk boundaries for JSON and log tails', async () => {
    const chunked = (value: string) => {
      const bytes = new TextEncoder().encode(value);
      return new Response(new ReadableStream<Uint8Array>({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } }));
    };
    const provider = createGithubProvider({ token: 't', fetch: vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/runs/')) return chunked(JSON.stringify({ jobs: [{ id: 7, name: '测试😀', conclusion: 'failure' }] }));
      if (url.includes('/jobs/')) return new Response('', { status: 302, headers: { location: 'https://logs.example/test' } });
      return chunked('错误😀尾部');
    }) as typeof fetch });
    await expect(provider.getFailureLogs(repo, '42')).resolves.toEqual([{ job: '测试😀', reason: 'failure', log: '错误😀尾部' }]);
  });
});
