import { describe, expect, it, vi } from 'vitest';
import { AgentGroupToolCliError, runGroupHandoff, runGroupMembers, runGroupMessages, runGroupReplyAgent, runGroupSend, runGroupSendFile, runGroupTeamSearch, runHistoryList, runHistoryShow } from './agent-tools-cli.js';

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('Agent group tool CLI client', () => {
  it('requires the scoped Dutydeck Lark session capability', () => {
    let caught: AgentGroupToolCliError | undefined;
    try { void runGroupMessages({}, { env: {} }); } catch (error) { caught = error as AgentGroupToolCliError; }
    expect(caught).toMatchObject({ error: { code: 'GROUP_TOOL_CONTEXT_REQUIRED' } });
  });

  it('calls the scoped endpoint without reading or transmitting Lark credentials', async () => {
    const fetcher = vi.fn(async () => response({ chatId: 'oc_group', messages: [] }));
    await runGroupSend('请检查', { to: 'cli_peer', replyTo: 'om_parent', inThread: true, idempotencyKey: 'handoff-1' }, {
      env: {
        dutydeck_group_tools_url: 'http://127.0.0.1:4310/api/lark/agent-tools',
        dutydeck_group_tools_token: 'capability-token',
        LARK_APP_SECRET: 'must-not-leak'
      },
      fetcher: fetcher as typeof fetch
    });
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:4310/api/lark/agent-tools/send', expect.objectContaining({ method: 'POST' }));
    const request = fetcher.mock.calls[0]!;
    expect(new Headers(request[1]?.headers).get('authorization')).toBe('Bearer capability-token');
    expect(JSON.parse(String(request[1]?.body))).toEqual({ content: '请检查', to: 'cli_peer', replyTo: 'om_parent', inThread: true, idempotencyKey: 'handoff-1' });
    expect(JSON.stringify(request)).not.toContain('must-not-leak');
  });

  it('discovers human members through the same scoped capability', async () => {
    const fetcher = vi.fn(async () => response({ chatId: 'oc_group', members: [{ name: '伟哥', openId: 'ou_human' }] }));
    await runGroupMembers({
      env: { dutydeck_group_tools_url: 'http://127.0.0.1:4310/api/lark/agent-tools', dutydeck_group_tools_token: 'capability-token' },
      fetcher: fetcher as typeof fetch
    });
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:4310/api/lark/agent-tools/members', expect.any(Object));
  });

  it('wires send-file through the scoped capability only', async () => {
    const fetcher = vi.fn(async () => response({ messageId: 'om_file' }));
    await runGroupSendFile('report.pdf', { replyTo: 'om_parent', inThread: true, image: true, idempotencyKey: 'file-1' }, { env: { dutydeck_group_tools_url: 'http://127.0.0.1:4310/api/lark/agent-tools', dutydeck_group_tools_token: 'capability-token' }, fetcher: fetcher as typeof fetch });
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:4310/api/lark/agent-tools/send-file', expect.any(Object));
    expect(JSON.parse(String(fetcher.mock.calls[0]![1].body))).toEqual({ path: 'report.pdf', replyTo: 'om_parent', inThread: true, image: true, idempotencyKey: 'file-1' });
  });

  it('preserves actionable authorization details from the broker', async () => {
    const fetcher = vi.fn(async () => response({ error: {
      code: 'GROUP_TOOL_AUTHORIZATION_REQUIRED', message: '需要管理员授权', instruction: '开通权限并发布版本',
      authorizationUrl: 'https://open.larkoffice.com/app/cli_test/auth', requiredScopes: ['im:message:readonly']
    } }, 403));
    await expect(runGroupMessages({}, {
      env: { DUTYDECK_GROUP_TOOLS_URL: 'http://127.0.0.1:4310/api/lark/agent-tools', DUTYDECK_GROUP_TOOLS_TOKEN: 'token' },
      fetcher: fetcher as typeof fetch
    })).rejects.toMatchObject({ error: {
      code: 'GROUP_TOOL_AUTHORIZATION_REQUIRED', instruction: '开通权限并发布版本', requiredScopes: ['im:message:readonly']
    } });
  });

  it('encodes since, until, and query into the messages request URL', async () => {
    const fetcher = vi.fn(async () => response({ chatId: 'oc_group', messages: [] }));
    await runGroupMessages({
      since: '2026-09-25T10:00:00Z',
      until: '2026-09-25T12:00:00Z',
      query: 'bug fix',
      limit: '10'
    }, {
      env: { dutydeck_group_tools_url: 'http://127.0.0.1:4310/api/lark/agent-tools', dutydeck_group_tools_token: 'capability-token' },
      fetcher: fetcher as typeof fetch
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const calledUrl = new URL(fetcher.mock.calls[0]![0] as string);
    expect(calledUrl.pathname).toBe('/api/lark/agent-tools/messages');
    expect(calledUrl.searchParams.get('since')).toBe('2026-09-25T10:00:00Z');
    expect(calledUrl.searchParams.get('until')).toBe('2026-09-25T12:00:00Z');
    expect(calledUrl.searchParams.get('query')).toBe('bug fix');
    expect(calledUrl.searchParams.get('limit')).toBe('10');
  });
});

it('sends history and team-search requests through the scoped capability', async () => {
  const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => response({ ok: true }));
  const options = { env: { dutydeck_group_tools_url: 'http://localhost/api/lark/agent-tools', dutydeck_group_tools_token: 'capability' }, fetcher: fetcher as typeof fetch };
  await runHistoryList({ since: '2026-09-20T00:00:00Z', until: '2026-09-25T00:00:00Z', query: '部署 方案', limit: '5' }, options);
  await runHistoryShow('task/1', options);
  await runGroupTeamSearch('部署 方案', options);
  const [list, show, search] = fetcher.mock.calls.map(call => new URL(call[0]));
  expect(list!.pathname).toBe('/api/lark/agent-tools/history');
  expect(Object.fromEntries(list!.searchParams)).toEqual({ since: '2026-09-20T00:00:00Z', until: '2026-09-25T00:00:00Z', query: '部署 方案', limit: '5' });
  expect(show!.pathname).toBe('/api/lark/agent-tools/history/task%2F1');
  expect(search!.pathname).toBe('/api/lark/agent-tools/team-search');
  expect(search!.searchParams.get('query')).toBe('部署 方案');
  for (const call of fetcher.mock.calls) expect(new Headers(call[1]?.headers).get('authorization')).toBe('Bearer capability');
});

it('transmits final and turn without changing ordinary send fields', async () => {
  const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => response({ messageId: 'om_final' }));
  await runGroupSend('answer', { final: true, turn: 'signed-turn' }, {
    env: { dutydeck_group_tools_url: 'http://localhost/api/lark/agent-tools', dutydeck_group_tools_token: 'capability' },
    fetcher: fetcher as typeof fetch
  });
  expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).toEqual({ content: 'answer', final: true, turn: 'signed-turn' });
});

it('transmits handoff and reply-agent payloads through scoped capability', async () => {
  const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => response({ messageId: 'om_action' }));
  await runGroupHandoff('cli_peer', 'handoff task', { turn: 'signed-turn' }, {
    env: { dutydeck_group_tools_url: 'http://localhost/api/lark/agent-tools', dutydeck_group_tools_token: 'capability' },
    fetcher: fetcher as typeof fetch
  });
  expect(fetcher).toHaveBeenCalledWith('http://localhost/api/lark/agent-tools/handoff', expect.objectContaining({ method: 'POST' }));
  expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).toEqual({ to: 'cli_peer', content: 'handoff task', turn: 'signed-turn' });

  await runGroupReplyAgent('result answer', { turn: 'signed-turn' }, {
    env: { dutydeck_group_tools_url: 'http://localhost/api/lark/agent-tools', dutydeck_group_tools_token: 'capability' },
    fetcher: fetcher as typeof fetch
  });
  expect(fetcher).toHaveBeenCalledWith('http://localhost/api/lark/agent-tools/reply-agent', expect.objectContaining({ method: 'POST' }));
  expect(JSON.parse(String(fetcher.mock.calls[1]![1]?.body))).toEqual({ content: 'result answer', turn: 'signed-turn' });
});
