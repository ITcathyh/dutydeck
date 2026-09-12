import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GithubActionsClient, resolveGithubHead } from './github-actions.js';

const run = promisify(execFile);
const directories: string[] = [];

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

describe('GitHub Actions boundary', () => {
  it('resolves github.com origin and the full current HEAD from a real repository', async () => {
    const cwd = await repository('https://github.com/Octo-Org/example.git');
    const resolved = await resolveGithubHead(cwd);
    expect(resolved.repository).toEqual({ owner: 'Octo-Org', name: 'example', slug: 'Octo-Org/example' });
    expect(resolved.headSha).toMatch(/^[a-f0-9]{40}$/);
  });

  it('rejects non-GitHub and credential-bearing HTTPS origins', async () => {
    await expect(resolveGithubHead(await repository('https://example.com/org/repo.git'))).rejects.toMatchObject({ code: 'GITHUB_REMOTE_UNSUPPORTED' });
    await expect(resolveGithubHead(await repository('https://token@github.com/org/repo.git'))).rejects.toMatchObject({ code: 'GITHUB_REMOTE_UNSUPPORTED' });
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
      return new Response(JSON.stringify({ workflow_runs: [{
        id: 42, name: 'CI', workflow_id: 7, head_sha: 'a'.repeat(40), status: 'completed', conclusion: 'failure',
        html_url: 'https://github.com/octo/repo/actions/runs/42', created_at: '2026-09-12T00:00:00Z', updated_at: '2026-09-12T00:01:00Z'
      }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const client = new GithubActionsClient({ token, fetch: request as typeof fetch });
    await expect(client.listCompletedRuns({ owner: 'octo', name: 'repo', slug: 'octo/repo' }, 'a'.repeat(40), 'ci.yml')).resolves.toEqual([
      expect.objectContaining({ id: 42, conclusion: 'failure', headSha: 'a'.repeat(40) })
    ]);
  });

  it('uses the server token only after an anonymous private-repository response', async () => {
    const calls: Array<Record<string, string>> = [];
    const request = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      calls.push(init?.headers as Record<string, string>);
      if (calls.length === 1) return new Response('', { status: 404 });
      return new Response(JSON.stringify({ workflow_runs: [] }), { status: 200 });
    });
    const client = new GithubActionsClient({ token: 'private-token', fetch: request as typeof fetch });
    await client.listCompletedRuns({ owner: 'octo', name: 'private', slug: 'octo/private' }, 'c'.repeat(40));
    expect(calls).toHaveLength(2);
    expect(calls[0]?.Authorization).toBeUndefined();
    expect(calls[1]?.Authorization).toBe('Bearer private-token');
  });

  it('can query the complete HEAD run set without a completed-status filter', async () => {
    const request = vi.fn(async (input: string | URL | Request) => {
      expect(new URL(String(input)).searchParams.has('status')).toBe(false);
      return new Response(JSON.stringify({ total_count: 1, workflow_runs: [{
        id: 43, name: 'CI', workflow_id: 7, run_attempt: 2, head_sha: 'd'.repeat(40), status: 'in_progress', conclusion: null,
        html_url: 'https://github.com/octo/repo/actions/runs/43', created_at: '2026-09-12T00:00:00Z', updated_at: '2026-09-12T00:01:00Z'
      }] }), { status: 200 });
    });
    const client = new GithubActionsClient({ fetch: request as typeof fetch });
    await expect(client.listRuns({ owner: 'octo', name: 'repo', slug: 'octo/repo' }, 'd'.repeat(40))).resolves.toEqual([
      expect.objectContaining({ id: 43, status: 'in_progress', runAttempt: 2 })
    ]);
  });

  it('rejects redirects and never includes response bodies in errors', async () => {
    const redirect = new GithubActionsClient({ token: 'do-not-leak', fetch: vi.fn(async () => new Response('', { status: 302, headers: { location: 'https://evil.example/' } })) as typeof fetch });
    await expect(redirect.listCompletedRuns({ owner: 'o', name: 'r', slug: 'o/r' }, 'b'.repeat(40))).rejects.toMatchObject({ code: 'GITHUB_REDIRECT_REJECTED' });
    const denied = new GithubActionsClient({ token: 'do-not-leak', fetch: vi.fn(async () => new Response('body-secret', { status: 403 })) as typeof fetch });
    const error = await denied.listCompletedRuns({ owner: 'o', name: 'r', slug: 'o/r' }, 'b'.repeat(40)).catch(cause => cause as Error);
    expect(error.message).toBe('GitHub API returned HTTP 403');
    expect(JSON.stringify(error)).not.toContain('do-not-leak');
    expect(error.message).not.toContain('body-secret');
  });
});
