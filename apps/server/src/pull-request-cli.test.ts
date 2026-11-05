import { describe, expect, it, vi } from 'vitest';
import { createCliProgram } from './cli-program.js';
import { runPullRequestCli } from './pull-request-cli.js';

const target = { url: 'http://127.0.0.1:4310', database: '/tmp/pr-cli.db' };
function fixture() {
  const requests: Array<{ path: string; method: string; body: unknown }> = [];
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    requests.push({ path: new URL(String(url)).pathname, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify({ pullRequest: { id: 'pr_9' } }), { headers: { 'content-type': 'application/json' } });
  });
  return { requests, run: (action: 'list' | 'follow' | 'stop', argument?: string, input: Record<string, string> = { session: 'ses_1' }) => runPullRequestCli(action, argument, { ...target, ...input }, { fetcher, readToken: () => 'owner-token' }) };
}

describe('pr CLI', () => {
  it('认领、查看、停止都走会话的 PR 接口', async () => {
    const f = fixture();
    await f.run('follow', ' https://git.example.com/group/repo/pull/12 ');
    await f.run('list');
    await f.run('stop', 'pr_9');
    await f.run('follow', '12', { session: 'ses_1', instance: 'peer-1' });
    expect(f.requests).toEqual([
      { path: '/api/sessions/ses_1/pull-requests/follow', method: 'POST', body: { pullRequest: 'https://git.example.com/group/repo/pull/12' } },
      { path: '/api/sessions/ses_1/pull-requests', method: 'GET', body: undefined },
      { path: '/api/sessions/ses_1/pull-requests/pr_9/cancel', method: 'POST', body: undefined },
      { path: '/api/instances/peer-1/sessions/ses_1/pull-requests/follow', method: 'POST', body: { pullRequest: '12' } }
    ]);
  });

  it('缺会话或链接时在发请求前报错', async () => {
    const f = fixture();
    await expect(f.run('follow', 'https://x', {})).rejects.toMatchObject({ code: 'PR_ARGUMENT_INVALID' });
    await expect(f.run('follow', ' ')).rejects.toMatchObject({ code: 'PR_ARGUMENT_INVALID' });
    expect(f.requests).toEqual([]);
  });

  it('命令行解析到 handler', async () => {
    const pullRequest = vi.fn();
    const program = createCliProgram('0.0.0', { pullRequest });
    await program.parseAsync(['node', 'dutydeck', 'pr', 'follow', 'https://git.example.com/group/repo/pull/12', '--session', 'ses_1']);
    expect(pullRequest).toHaveBeenCalledWith('follow', 'https://git.example.com/group/repo/pull/12', expect.objectContaining({ session: 'ses_1' }));
  });
});
