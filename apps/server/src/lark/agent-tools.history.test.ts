import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import type { CollaborationObservation, CollaborationTeamContext, Session, TaskRecord } from '@dutydeck/shared';
import { larkBotsConfigKey } from './config.js';
import { AgentGroupToolError, LarkAgentToolCapabilityRegistry, LarkAgentToolsService, larkGroupToolsPrompt, type LarkAgentToolsOptions } from './agent-tools.js';
import { LarkTeamContextReader } from './team-context.js';

const repositories: Array<ReturnType<typeof createRepositories>> = [];
afterEach(() => { for (const repository of repositories.splice(0)) repository.close(); });

const session = (id: string, sourceId: string, overrides: Partial<Session> = {}): Session => ({
  id, agentId: 'codex', state: 'idle', cwd: '/tmp', source: 'lark', sourceId, runId: `run_${id}`, createdAt: '', updatedAt: '', ...overrides
});
const task = (id: string, sessionId: string, createdAt: string, prompt: string, actorId?: string): TaskRecord => ({
  id, sessionId, prompt, status: 'completed', createdAt, updatedAt: createdAt,
  executionContext: { agentPrompt: `[注入的群上下文 INJECTED_CONTEXT]\n${prompt}`, ...(actorId ? { actorId } : {}) }
});

async function setup(options: Partial<LarkAgentToolsOptions> = {}, tokenSession = 'ses_own') {
  const repos = createRepositories(':memory:'); repositories.push(repos);
  const sessions = [
    session('ses_own', 'cli_current:oc_group:group:user:ou_alice'),
    session('ses_thread', 'cli_current:oc_group:group:thread:om_root', { state: 'stopped', archivedAt: '2026-09-23T00:00:00.000Z' }),
    session('ses_other_chat', 'cli_current:oc_other:group:user:ou_alice'),
    session('ses_other_app', 'cli_peer:oc_group:group:user:ou_alice'),
    session('ses_background', 'cli_current:oc_group:group:collaboration:man_1'),
    session('ses_memory', 'cli_current:oc_group:memory', { source: 'lark-memory' }),
    session('ses_p2p', 'cli_current:oc_p2p:p2p')
  ];
  for (const item of sessions) await repos.sessions.save(item);
  const tasks = [
    task('task_deploy', 'ses_own', '2026-09-20T02:00:00.000Z', '部署方案讨论：蓝绿还是滚动', 'ou_alice'),
    task('task_release', 'ses_thread', '2026-09-22T02:00:00.000Z', 'Release CHECKLIST review'),
    task('task_other_chat', 'ses_other_chat', '2026-09-23T02:00:00.000Z', '部署方案 其他群'),
    task('task_other_app', 'ses_other_app', '2026-09-23T03:00:00.000Z', '部署方案 其他机器人'),
    task('task_background', 'ses_background', '2026-09-23T04:00:00.000Z', '部署方案 后台委托'),
    task('task_memory', 'ses_memory', '2026-09-23T05:00:00.000Z', '部署方案 记忆提取'),
    task('task_p2p', 'ses_p2p', '2026-09-23T06:00:00.000Z', '私聊里的部署方案'),
    task('task_current', 'ses_own', '2026-09-25T02:00:00.000Z', '上次的部署方案结论是什么', 'ou_alice')
  ];
  for (const item of tasks) await repos.tasks.save(item);
  await repos.config.set(larkBotsConfigKey, JSON.stringify([
    { appId: 'cli_current', appSecret: 'secret-current', name: 'Current Bot', defaultAgentId: 'codex', groupToolsEnabled: true, groupToolsAllowSend: false }
  ]));
  const capabilities = new LarkAgentToolCapabilityRegistry(repos.sessions, 'http://127.0.0.1:4310');
  const token = capabilities.environmentFor(sessions.find(item => item.id === tokenSession)!).dutydeck_group_tools_token!;
  const tools = new LarkAgentToolsService(capabilities, repos.config, {
    history: repos, workbenchTask: id => id === 'ses_own' ? { taskId: 'task_current', attemptId: 'att_current' } : undefined, ...options
  });
  return { repos, tools, token };
}

it('tells the Agent when to use history and team-search', () => {
  const prompt = larkGroupToolsPrompt(false, 'dd');
  expect(prompt).toContain("dd history list [--since <时间>] [--until <时间>] [--query '<关键词>'] [--limit 20]");
  expect(prompt).toContain('dd history show <taskId>');
  expect(prompt).toContain("dd group team-search '<关键词>'");
  expect(prompt).toMatch(/以前、上次、之前讨论过的结论时，先用 history list --query/);
  expect(prompt).toMatch(/其他群、别的群的信息时，用 group team-search.*仅开启了群参与的群可用/);
});

describe('history list/show', () => {
  it('lists only foreground tasks of the same bot and chat, newest first, with the visible request', async () => {
    const { tools, token } = await setup();
    const result = await tools.history(token);
    expect(result.chatId).toBe('oc_group');
    expect(result.tasks.map(item => item.taskId)).toEqual(['task_release', 'task_deploy']);
    expect(result.tasks[1]).toEqual({ taskId: 'task_deploy', createdAt: '2026-09-20T02:00:00.000Z', status: 'completed', actorId: 'ou_alice', request: '部署方案讨论：蓝绿还是滚动' });
    expect(JSON.stringify(result)).not.toContain('INJECTED_CONTEXT');
  });

  it('matches every keyword case-insensitively and reports how many tasks were scanned', async () => {
    const { tools, token } = await setup();
    expect((await tools.history(token, { query: 'release checklist' })).tasks.map(item => item.taskId)).toEqual(['task_release']);
    expect((await tools.history(token, { query: '部署方案 蓝绿' }))).toMatchObject({ tasks: [{ taskId: 'task_deploy' }], scanned: 2 });
    expect((await tools.history(token, { query: '部署方案 不存在' })).tasks).toEqual([]);
    // 注入的 agentPrompt 不参与匹配。
    expect((await tools.history(token, { query: 'INJECTED_CONTEXT' })).tasks).toEqual([]);
  });

  it('applies the same time parsing as group messages and validates range and limit', async () => {
    const { tools, token } = await setup();
    expect((await tools.history(token, { since: '2026-09-21T00:00:00Z' })).tasks.map(item => item.taskId)).toEqual(['task_release']);
    expect((await tools.history(token, { until: String(Date.parse('2026-09-21T00:00:00Z') / 1000) })).tasks.map(item => item.taskId)).toEqual(['task_deploy']);
    expect((await tools.history(token, { limit: 1 })).tasks.map(item => item.taskId)).toEqual(['task_release']);
    await expect(tools.history(token, { since: 'not a time' })).rejects.toMatchObject({ code: 'HISTORY_INVALID_RANGE', statusCode: 400 });
    await expect(tools.history(token, { since: '2026-09-22T00:00:00Z', until: '2026-09-21T00:00:00Z' })).rejects.toMatchObject({ code: 'HISTORY_INVALID_RANGE', statusCode: 400 });
    await expect(tools.history(token, { limit: 51 })).rejects.toMatchObject({ code: 'INVALID_GROUP_MESSAGE_LIMIT', statusCode: 400 });
  });

  it('clips list previews to 200 characters', async () => {
    const { repos, tools, token } = await setup();
    await repos.tasks.save(task('task_long', 'ses_own', '2026-09-24T02:00:00.000Z', `长请求${'很'.repeat(400)}`));
    const [latest] = (await tools.history(token)).tasks;
    expect(latest).toMatchObject({ taskId: 'task_long' });
    expect(latest!.request).toHaveLength(200);
    expect(latest!.request.endsWith('…')).toBe(true);
  });

  it('shows a task of this chat and returns 404 for tasks outside it', async () => {
    const { tools, token } = await setup();
    expect(await tools.historyTask(token, { taskId: 'task_release' })).toEqual({
      chatId: 'oc_group', taskId: 'task_release', createdAt: '2026-09-22T02:00:00.000Z', status: 'completed', request: 'Release CHECKLIST review'
    });
    for (const taskId of ['task_other_chat', 'task_other_app', 'task_background', 'task_memory', 'task_p2p', 'task_missing']) {
      await expect(tools.historyTask(token, { taskId })).rejects.toMatchObject({ code: 'HISTORY_TASK_NOT_FOUND', statusCode: 404 });
    }
    await expect(tools.historyTask(token, { taskId: ' ' })).rejects.toMatchObject({ code: 'HISTORY_TASK_ID_REQUIRED', statusCode: 400 });
  });

  it('keeps a private chat to its own tasks', async () => {
    const { tools, token } = await setup({}, 'ses_p2p');
    expect((await tools.history(token)).tasks.map(item => item.taskId)).toEqual(['task_p2p']);
    await expect(tools.historyTask(token, { taskId: 'task_deploy' })).rejects.toMatchObject({ code: 'HISTORY_TASK_NOT_FOUND', statusCode: 404 });
  });
});

const origin = { appId: 'cli_current', chatId: 'oc_group' }, todo = { appId: 'cli_current', chatId: 'oc_todo' }, secret = { appId: 'cli_current', chatId: 'oc_secret' };
const at = '2026-09-21T03:00:00.000Z';
const observation = (id: string, text: string, overrides: Partial<CollaborationObservation> = {}): CollaborationObservation => ({
  id, scope: todo, source: 'lark.message', eventId: id, sequence: 1, revision: 1, occurredAt: at, receivedAt: at,
  senderId: 'ou_person', senderKind: 'human', messageId: id, text, refs: [id], origin: 'history', missing: [], ...overrides
});
const teamContext = (observations: CollaborationObservation[]): CollaborationTeamContext => ({
  query: '部署方案', searchedAt: at, observations, sources: [
    { scope: todo, name: '个人待办', status: 'partial', missing: ['recent_history_partial'] },
    { scope: secret, name: '秘密群', status: 'unavailable', missing: ['context_read_denied'] }
  ]
});

async function teamSetup(context: CollaborationTeamContext, overrides: { available?: boolean; allowed?: boolean; tokenSession?: string } = {}) {
  const scorer = new LarkTeamContextReader({} as ConstructorParameters<typeof LarkTeamContextReader>[0]);
  const reader = { read: vi.fn(async () => context), authorize: vi.fn(async () => overrides.allowed ?? true), scorer: (query: string) => scorer.scorer(query) };
  const available = vi.fn(async () => overrides.available ?? true);
  const fixture = await setup({ teamSearch: () => ({ reader, available }) }, overrides.tokenSession);
  return { ...fixture, reader, available };
}

describe('group team-search', () => {
  it('is unavailable when this group has participation off, without reading other groups', async () => {
    const f = await teamSetup(teamContext([observation('om_hit', '部署方案已确认')]), { available: false });
    await expect(f.tools.teamSearch(f.token, { query: '部署方案' })).rejects.toMatchObject({ code: 'GROUP_TEAM_SEARCH_UNAVAILABLE', statusCode: 403 });
    expect(f.available).toHaveBeenCalledWith(origin);
    expect(f.reader.read).not.toHaveBeenCalled();
  });

  it('is unavailable in private chats and when the integration is not ready', async () => {
    const f = await teamSetup(teamContext([]), { tokenSession: 'ses_p2p' });
    await expect(f.tools.teamSearch(f.token, { query: '部署方案' })).rejects.toMatchObject({ code: 'GROUP_TEAM_SEARCH_UNAVAILABLE' });
    expect(f.available).not.toHaveBeenCalled();
    const bare = await setup({ teamSearch: () => undefined });
    await expect(bare.tools.teamSearch(bare.token, { query: '部署方案' })).rejects.toMatchObject({ code: 'GROUP_TEAM_SEARCH_UNAVAILABLE' });
    await expect(bare.tools.teamSearch(bare.token, { query: ' ' })).rejects.toMatchObject({ code: 'GROUP_TEAM_SEARCH_QUERY_REQUIRED', statusCode: 400 });
  });

  it('returns no content from other groups when the authorization recheck fails', async () => {
    const f = await teamSetup(teamContext([observation('om_hit', '部署方案已确认')]), { allowed: false });
    const error = await f.tools.teamSearch(f.token, { query: '部署方案' }).catch(caught => caught as AgentGroupToolError);
    expect(error).toMatchObject({ code: 'GROUP_TEAM_SEARCH_DENIED', statusCode: 403 });
    expect(f.reader.authorize).toHaveBeenCalledWith(origin, expect.objectContaining({ query: '部署方案' }));
    const body = JSON.stringify((error as AgentGroupToolError).response());
    for (const leaked of ['部署方案已确认', '个人待办', '秘密群', 'oc_todo']) expect(body).not.toContain(leaked);
  });

  it.each([
    ['participation is turned off', 'GROUP_TEAM_SEARCH_UNAVAILABLE', 403, async (f: Awaited<ReturnType<typeof teamSetup>>) => { f.available.mockResolvedValue(false); }],
    ['group tools are disabled', 'GROUP_TOOLS_DISABLED', 403, async (f: Awaited<ReturnType<typeof teamSetup>>) => {
      await f.repos.config.set(larkBotsConfigKey, JSON.stringify([{ appId: 'cli_current', appSecret: 'secret-current', defaultAgentId: 'codex', groupToolsEnabled: false }]));
    }],
    ['the session is stopped', 'GROUP_TOOL_SESSION_EXPIRED', 401, async (f: Awaited<ReturnType<typeof teamSetup>>) => {
      await f.repos.sessions.save({ ...(await f.repos.sessions.get('ses_own'))!, state: 'stopped' });
    }]
  ] as const)('discards the material when %s during the read', async (_label, code, statusCode, change) => {
    const f = await teamSetup(teamContext([observation('om_hit', '部署方案已确认')]));
    f.reader.read.mockImplementationOnce(async () => { await change(f); return teamContext([observation('om_hit', '部署方案已确认')]); });
    const error = await f.tools.teamSearch(f.token, { query: '部署方案' }).then(() => undefined, (caught: AgentGroupToolError) => caught);
    expect(error).toMatchObject({ code, statusCode });
    expect(f.reader.authorize).toHaveBeenCalled();
    const body = JSON.stringify(error!.response());
    for (const leaked of ['部署方案已确认', '个人待办', '秘密群', 'oc_todo']) expect(body).not.toContain(leaked);
  });

  it('returns only entries with lexical overlap, grouped by source with status and missing', async () => {
    const followup = JSON.stringify({ goal: '部署上线', status: 'open', progress: '等待审批', steps: [] });
    const f = await teamSetup(teamContext([
      observation('om_hit', '部署方案\n已确认'),
      observation('om_miss', '今天午饭吃什么'),
      observation('fu_1', followup, { source: 'lark.team.followup', senderKind: 'system', senderId: undefined, messageId: undefined, origin: 'external' })
    ]));
    const result = await f.tools.teamSearch(f.token, { query: '部署方案' });
    expect(f.reader.read).toHaveBeenCalledWith(origin, '部署方案');
    expect(result).toMatchObject({ query: '部署方案', matched: 2, sources: [
      { name: '个人待办', chatId: 'oc_todo', status: 'partial', missing: ['recent_history_partial'],
        entries: ['[09-21 11:00] ou_person(human): 部署方案 已确认', '[09-21 11:00] 事项: [open] 部署上线；进展：等待审批'] },
      { name: '秘密群', chatId: 'oc_secret', status: 'unavailable', missing: ['context_read_denied'], entries: [] }
    ] });
    expect(result.truncated).toBeUndefined();
    expect(result.note).toContain('未能读取的来源：秘密群（context_read_denied）');
  });

  it('caps the result at 30 entries, 300 characters per body and 8000 characters in total', async () => {
    const f = await teamSetup(teamContext(Array.from({ length: 40 }, (_, i) => observation(`om_${i}`, `部署方案${'细'.repeat(500)}`))));
    const result = await f.tools.teamSearch(f.token, { query: '部署方案' });
    const entries = result.sources.flatMap(source => source.entries);
    expect(result).toMatchObject({ matched: 40, truncated: true });
    expect(entries.length).toBeLessThanOrEqual(30);
    expect(entries.reduce((total, line) => total + line.length, 0)).toBeLessThanOrEqual(8000);
    for (const line of entries) expect(line.slice(line.indexOf(': ') + 2)).toHaveLength(300);
  });

  it('names read and unread sources when nothing matches instead of implying absence', async () => {
    const f = await teamSetup(teamContext([observation('om_miss', '今天午饭吃什么')]));
    const result = await f.tools.teamSearch(f.token, { query: '部署方案' });
    expect(result.matched).toBe(0);
    expect(result.sources.flatMap(source => source.entries)).toEqual([]);
    expect(result.note).toContain('已读来源：个人待办');
    expect(result.note).toContain('未能读取的来源：秘密群（context_read_denied）');
    expect(result.note).toContain('未命中不代表');
  });
});
