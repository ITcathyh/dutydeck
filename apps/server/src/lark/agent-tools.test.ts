import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import type { Session } from '@dutydeck/shared';
import { larkBotsConfigKey } from './config.js';
import {
  AgentGroupToolError,
  LarkAgentToolCapabilityRegistry,
  LarkAgentToolsService,
  dutydeckGroupToolsCommand,
  larkAgentSessionBinding,
  loadOrCreateGroupToolsSigningSecret,
  type LarkAgentToolsOptions,
  type LarkGroupToolClient
} from './agent-tools.js';
import { LarkServiceError, type LarkChatMessage } from './service.js';

const repositories: Array<ReturnType<typeof createRepositories>> = [];
afterEach(() => { for (const repository of repositories.splice(0)) repository.close(); });

const session = (overrides: Partial<Session> = {}): Session => ({
  id: 'ses_lark', agentId: 'codex', state: 'idle', cwd: '/tmp', source: 'lark', sourceId: 'cli_current:oc_group:group',
  runId: 'run_1', createdAt: '', updatedAt: '', ...overrides
});

const message = (messageId: string, createTime: string, text: string): LarkChatMessage => ({
  messageId, chatId: 'oc_group', messageType: 'text', createTime, sender: { id: 'ou_sender', type: 'app', name: 'Peer' },
  rawContent: JSON.stringify({ text }), mentions: [], deleted: false, updated: false
});

function fakeClient(overrides: Partial<LarkGroupToolClient> = {}): LarkGroupToolClient {
  return {
    getBotInfo: vi.fn(async () => ({ appName: 'Current Bot', openId: 'ou_current' })),
    listChatMembers: vi.fn(async () => ({ items: [], hasMore: false, securityLimited: false })),
    listChatMessages: vi.fn(async () => ({ items: [], hasMore: false })),
    getMessage: vi.fn(async messageId => message(messageId, '1000', 'original')),
    getMessageItems: vi.fn(async messageId => [message(messageId, '1000', 'original')]),
    sendText: vi.fn(async input => ({ messageId: 'om_sent', chatId: input.chatId })),
    replyText: vi.fn(async () => ({ messageId: 'om_reply', chatId: 'oc_group' })),
    ...overrides
  };
}

async function setup(
  clients: Record<string, LarkGroupToolClient>,
  groupToolsCommand?: string,
  executionPolicy?: LarkAgentToolsOptions['executionPolicy'],
  chatId = 'oc_group',
  sessionId = 'ses_lark',
) {
  const repos = createRepositories(':memory:'); repositories.push(repos);
  const activeSession = session({ id: sessionId, sourceId: `cli_current:${chatId}:group` });
  await repos.sessions.save(activeSession);
  await repos.config.set(larkBotsConfigKey, JSON.stringify([
    { appId: 'cli_current', appSecret: 'secret-current', name: 'Current Bot', defaultAgentId: 'codex', groupToolsEnabled: true, groupToolsAllowSend: true, memoryEnabled: true },
    { appId: 'cli_peer', appSecret: 'secret-peer', name: 'Peer Bot', defaultAgentId: 'claude', groupToolsEnabled: true, groupToolsAllowSend: true, memoryEnabled: true },
    { appId: 'cli_disabled', appSecret: 'secret-disabled', name: 'Disabled Bot', defaultAgentId: 'gemini', groupToolsEnabled: false, memoryEnabled: true }
  ]));
  const capabilities = new LarkAgentToolCapabilityRegistry(repos.sessions, 'http://127.0.0.1:4310', undefined, groupToolsCommand);
  const environment = capabilities.environmentFor(activeSession);
  const tools = new LarkAgentToolsService(capabilities, repos.config, {
    pollIntervalMs: 50,
    ...(groupToolsCommand ? { groupToolsCommand } : {}),
    ...(executionPolicy ? { executionPolicy } : {}),
    clientFactory: config => clients[config.appId] ?? fakeClient()
  });
  return { repos, activeSession, capabilities, tools, token: environment.dutydeck_group_tools_token! };
}

describe('Agent group collaboration domain service', () => {
  it.each(['dutydeck', '/x/dutydeck', "'/usr/bin/node' '/app/cli.js'"])(
    'injects the same command prefix as the session prompt: %s', async command => {
      const f = await setup({ cli_current: fakeClient() }, command);
      const env = f.capabilities.environmentFor(f.activeSession);
      expect(env.dutydeck_group_tools_command).toBe(command);
      expect(env.dutydeck_group_tools_token).toBe(f.token);
      expect(Object.keys(env).every(key => /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(key))).toBe(true);
      if (command !== 'dutydeck') expect(await f.tools.promptForSession(f.activeSession, 'test')).toContain(`本会话的 dutydeck 命令是 ${command}`);
      expect(f.capabilities.environmentFor(session({ source: 'web', sourceId: undefined }))).toEqual({});
    });

  it('refreshes final and work tokens and keeps independent capability gates on every prompt', async () => {
    const f = await setup({ cli_current: fakeClient() });
    const active = { taskId: 'task-one', attemptId: 'attempt-one', actorId: 'ou_actor' };
    let work = true, collaboration = true, memory = true;
    const live = vi.fn(async () => {});
    const tools = new LarkAgentToolsService(f.capabilities, f.repos.config, {
      workbenchTask: () => active, finalTaskContext: async () => undefined,
      authorizeTool: live,
      previewTool: async (_id, action) => { if (action === 'memory' && !memory) throw new Error('revoked'); },
      previewWork: async () => work, previewCollaboration: async () => collaboration
    });
    const first = await tools.promptForSession(f.activeSession, 'one');
    const final1 = f.capabilities.finalTurnToken(f.activeSession.id, active.taskId, active.attemptId);
    const work1 = f.capabilities.workbenchTurnToken(f.activeSession.id, active.taskId, active.attemptId);
    // 同一个尝试凭证只放在本轮命令前缀中。
    expect(first).toContain(final1); expect(first).toContain(work1);
    expect(first).toContain("group send '<完整答复>' --final"); expect(first).toContain('dutydeck agent work');
    expect(first).toContain('[Dutydeck 目标编排]'); expect(first).toContain('[群内持续协作]');
    active.taskId = 'task-two'; active.attemptId = 'attempt-two'; collaboration = false;
    const second = await tools.promptForSession(f.activeSession, 'two');
    expect(second).not.toContain(final1); expect(second).not.toContain(work1);
    expect(second).toContain(f.capabilities.finalTurnToken(f.activeSession.id, active.taskId, active.attemptId));
    expect(second).toContain('[Dutydeck 目标编排]'); expect(second).not.toContain('[群内持续协作]');
    work = false; collaboration = true; memory = false;
    const third = await tools.promptForSession(f.activeSession, 'three');
    expect(third).not.toContain('[Dutydeck 目标编排]'); expect(third).toContain('[群内持续协作]');
    expect(third).not.toContain('[Dutydeck 会话记忆工具]'); expect(third).toContain('发送独立消息/文件');
    expect(third).toContain('交付文件用 send-file'); expect(third).toContain('--reply-to <om_* message_id> --in-thread');
    expect(live).not.toHaveBeenCalled();
  });

  it('checks the unified group-tools execution edge before reading or sending', async () => {
    const current = fakeClient();
    const authorize = vi.fn(async (_boundary: 'group_tools', action: any) => ({
      allowed: false, action, code: 'channel_bot_disabled', reason: 'staged bot', source: 'integration' as const
    }));
    const { tools, token } = await setup({ cli_current: current }, undefined, {
      integrationMode: 'legacy_unmanaged',
      authorize,
    });
    const prompt = await tools.promptForSession(session(), 'q');
    expect(prompt).not.toContain('[Dutydeck 飞书会话工具]');
    expect(prompt).toContain('[Dutydeck 会话记忆工具]');
    authorize.mockClear();
    await expect(tools.messages(token)).rejects.toMatchObject({
      code: 'channel_bot_disabled', statusCode: 403, details: { boundary: 'group_tools', integrationMode: 'legacy_unmanaged' }
    });
    expect(authorize).toHaveBeenCalledWith('group_tools', 'group_tools.read');
    expect(current.listChatMessages).not.toHaveBeenCalled();
  });

  it('builds a command bound to the current TypeScript or built entrypoint', () => {
    expect(dutydeckGroupToolsCommand('/workspace/apps/server/src/cli.ts', '/usr/bin/node', 'file:///workspace/node_modules/tsx/loader.mjs')).toBe("'/usr/bin/node' --import 'file:///workspace/node_modules/tsx/loader.mjs' '/workspace/apps/server/src/cli.ts'");
    expect(dutydeckGroupToolsCommand('/workspace/apps/server/dist/cli.js', '/usr/bin/node')).toBe("'/usr/bin/node' '/workspace/apps/server/dist/cli.js'");
  });

  it('binds capabilities to one persisted Lark session and never injects bot credentials', async () => {
    const current = fakeClient();
    const { repos, activeSession, capabilities, tools, token } = await setup({ cli_current: current });
    expect(larkAgentSessionBinding(activeSession)).toEqual({ sessionId: 'ses_lark', appId: 'cli_current', chatId: 'oc_group', chatType: 'group' });
    expect(larkAgentSessionBinding(session({ sourceId: 'cli_current:oc_p2p:p2p' }))).toMatchObject({ chatId: 'oc_p2p', chatType: 'p2p' });
    expect(larkAgentSessionBinding(session({ sourceId: 'cli_current:ou_legacy:p2p' }))).toMatchObject({ chatId: 'ou_legacy', chatType: 'p2p' });
    expect(capabilities.environmentFor(activeSession)).toEqual({
      dutydeck_group_tools_url: 'http://127.0.0.1:4310/api/lark/agent-tools',
      dutydeck_group_tools_token: token,
      dutydeck_group_tools_command: 'dutydeck'
    });
    expect(JSON.stringify(capabilities.environmentFor(activeSession))).not.toContain('secret-current');
    await expect(tools.self('wrong-token')).rejects.toMatchObject({ code: 'GROUP_TOOL_UNAUTHORIZED', statusCode: 401 });
    expect(await tools.self(token)).toMatchObject({ chatId: 'oc_group', bot: { appId: 'cli_current', openId: 'ou_current' }, policy: { canSend: true } });
    expect((await tools.messages(token)).cursor).toBeTruthy();
    await expect(tools.wait(token)).rejects.toMatchObject({ code: 'GROUP_WAIT_CURSOR_REQUIRED', statusCode: 400 });
    await repos.config.set(larkBotsConfigKey, JSON.stringify([{ appId: 'cli_current', appSecret: 'secret-current', defaultAgentId: 'codex', groupToolsEnabled: true, groupToolsAllowSend: false }]));
    await expect(tools.send(token, { content: 'blocked' })).rejects.toMatchObject({ code: 'GROUP_TOOL_SEND_DISABLED', statusCode: 403 });
    expect(current.sendText).not.toHaveBeenCalled();
    await repos.sessions.save({ ...activeSession, state: 'stopped' });
    await expect(tools.self(token)).rejects.toMatchObject({ code: 'GROUP_TOOL_SESSION_EXPIRED', statusCode: 401 });
  });

  it('distinguishes a thread root message from a native thread ID in session bindings', () => {
    expect(larkAgentSessionBinding(session({ sourceId: 'cli_current:oc_group:group:thread:om_root' }))).toEqual({ sessionId: 'ses_lark', appId: 'cli_current', chatId: 'oc_group', chatType: 'group', threadRootMessageId: 'om_root' });
    expect(larkAgentSessionBinding(session({ sourceId: 'cli_current:oc_group:group:thread:omt_topic' }))).toEqual({ sessionId: 'ses_lark', appId: 'cli_current', chatId: 'oc_group', chatType: 'group', threadId: 'omt_topic' });
  });

  it.each(['om_root', 'omt_topic'])('keeps reads and replies within the thread bound by %s', async scope => {
    const current = fakeClient({
      getMessage: vi.fn(async id => ({ ...message(id, '1000', 'scoped'), threadId: id === 'om_other' ? 'omt_other' : 'omt_topic' }))
    });
    const { repos, activeSession, tools, token } = await setup({ cli_current: current });
    await repos.sessions.save({ ...activeSession, sourceId: `cli_current:oc_group:group:thread:${scope}` });
    const initial = await tools.messages(token);
    await tools.wait(token, { after: initial.cursor, timeoutMs: 0 });
    expect(current.listChatMessages).toHaveBeenCalledWith({ threadId: 'omt_topic', order: 'desc', pageSize: 20 });
    expect(current.listChatMessages).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'omt_topic', order: 'asc' }));
    if (scope === 'omt_topic') expect(current.getMessage).not.toHaveBeenCalled();
    await expect(tools.message(token, { messageId: 'om_reply' })).resolves.toMatchObject({ messageId: 'om_reply', threadId: 'omt_topic' });
    await expect(tools.message(token, { messageId: 'om_other' })).rejects.toMatchObject({ code: 'GROUP_MESSAGE_OUT_OF_SCOPE' });
    await expect(tools.send(token, { content: 'blocked', replyTo: 'om_other', inThread: true })).rejects.toMatchObject({ code: 'GROUP_REPLY_OUT_OF_SCOPE' });
    await expect(tools.sendFile(token, { path: 'report.txt', replyTo: 'om_other', inThread: true })).rejects.toMatchObject({ code: 'GROUP_MESSAGE_OUT_OF_SCOPE' });
    expect(current.replyText).not.toHaveBeenCalled();
    await tools.send(token, { content: 'scoped', replyTo: 'om_reply', inThread: true, idempotencyKey: 'thread-reply' });
    expect(current.replyText).toHaveBeenCalledWith({ messageId: 'om_reply', text: 'scoped', replyInThread: true, idempotencyKey: 'thread-reply' });
  });

  it.each([undefined, 'om_not_a_thread'])('does not broaden reads when a root has no native thread ID (%s)', async threadId => {
    const current = fakeClient({ getMessage: vi.fn(async id => ({ ...message(id, '1000', 'root'), threadId })) });
    const { repos, activeSession, tools, token } = await setup({ cli_current: current });
    await repos.sessions.save({ ...activeSession, sourceId: 'cli_current:oc_group:group:thread:om_root' });
    await expect(tools.messages(token)).rejects.toMatchObject({ code: 'GROUP_THREAD_UNAVAILABLE', statusCode: 409 });
    await expect(tools.message(token, { messageId: 'om_other' })).rejects.toMatchObject({ code: 'GROUP_THREAD_UNAVAILABLE' });
    expect(current.listChatMessages).not.toHaveBeenCalled();
    await expect(tools.self(token)).resolves.toMatchObject({ chatId: 'oc_group' });
    await expect(tools.message(token, { messageId: 'om_root' })).resolves.toMatchObject({ messageId: 'om_root' });
    await tools.send(token, { content: 'start the topic', replyTo: 'om_root', inThread: true });
    expect(current.replyText).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'om_root', replyInThread: true }));
    vi.mocked(current.getMessage).mockImplementation(async id => ({ ...message(id, '1000', 'root'), threadId: 'omt_created' }));
    await tools.messages(token);
    expect(current.listChatMessages).toHaveBeenCalledWith({ threadId: 'omt_created', order: 'desc', pageSize: 20 });
  });

  it('rejects a root lookup belonging to a different chat', async () => {
    const current = fakeClient({ getMessage: vi.fn(async id => ({ ...message(id, '1000', 'other'), chatId: 'oc_other', threadId: 'omt_other' })) });
    const { repos, activeSession, tools, token } = await setup({ cli_current: current });
    await repos.sessions.save({ ...activeSession, sourceId: 'cli_current:oc_group:group:thread:om_root' });
    await expect(tools.messages(token)).rejects.toMatchObject({ code: 'GROUP_MESSAGE_OUT_OF_SCOPE', statusCode: 403 });
    expect(current.listChatMessages).not.toHaveBeenCalled();
    await expect(tools.send(token, { content: 'blocked', replyTo: 'om_root', inThread: true })).rejects.toMatchObject({ code: 'GROUP_REPLY_OUT_OF_SCOPE' });
    expect(current.replyText).not.toHaveBeenCalled();
  });

  it('reports root lookup failures without falling back to group history', async () => {
    const current = fakeClient({ getMessage: vi.fn(async () => { throw new LarkServiceError('LARK_MESSAGE_NOT_FOUND', 'Root was deleted', 404); }) });
    const { repos, activeSession, tools, token } = await setup({ cli_current: current });
    await repos.sessions.save({ ...activeSession, sourceId: 'cli_current:oc_group:group:thread:om_root' });
    await expect(tools.messages(token)).rejects.toMatchObject({ code: 'GROUP_TOOL_LARK_ERROR', statusCode: 404 });
    expect(current.listChatMessages).not.toHaveBeenCalled();
  });

  it('keeps the same scoped token across service restarts with a persisted signing secret', async () => {
    const repos = createRepositories(':memory:'); repositories.push(repos);
    const activeSession = session();
    await repos.sessions.save(activeSession);
    const signingSecret = await loadOrCreateGroupToolsSigningSecret(repos.config);
    expect(await loadOrCreateGroupToolsSigningSecret(repos.config)).toBe(signingSecret);
    const first = new LarkAgentToolCapabilityRegistry(repos.sessions, 'http://127.0.0.1:4310', signingSecret);
    const firstToken = first.environmentFor(activeSession).dutydeck_group_tools_token;
    first.close();
    const second = new LarkAgentToolCapabilityRegistry(repos.sessions, 'http://127.0.0.1:4310', signingSecret);
    const secondToken = second.environmentFor(activeSession).dutydeck_group_tools_token;
    expect(firstToken).toMatch(/^v1\./);
    expect(secondToken).toBe(firstToken);
    await expect(second.resolve(secondToken)).resolves.toMatchObject({ sessionId: activeSession.id, chatId: 'oc_group' });
  });

  it('lists all bots in the group and marks only locally managed ones with agentId', async () => {
    const current = fakeClient({
      listChatMembers: vi.fn(async () => ({
        items: [
          { memberId: 'ou_peer', openId: 'ou_peer', memberType: 'bot', name: 'Peer Bot', appId: 'cli_peer' },
          { memberId: 'ou_unconfigured', openId: 'ou_unconfigured', memberType: 'bot', name: 'Other Bot', appId: 'cli_other' },
          { memberId: 'ou_disabled', openId: 'ou_disabled', memberType: 'bot', name: 'Disabled Bot', appId: 'cli_disabled' }
        ],
        hasMore: false, securityLimited: false
      }))
    });
    const peer = fakeClient({ getBotInfo: vi.fn(async () => ({ appName: 'Peer Bot', openId: 'ou_peer' })) });
    const disabled = fakeClient({ getBotInfo: vi.fn(async () => ({ appName: 'Disabled Bot', openId: 'ou_disabled' })) });
    const { tools, token } = await setup({ cli_current: current, cli_peer: peer, cli_disabled: disabled });
    await expect(tools.peers(token)).resolves.toEqual({
      chatId: 'oc_group', securityLimited: false,
      peers: [
        { appId: 'cli_peer', name: 'Peer Bot', agentId: 'claude', memberId: 'ou_peer', openId: 'ou_peer' },
        { appId: 'cli_other', name: 'Other Bot', memberId: 'ou_unconfigured', openId: 'ou_unconfigured' },
        { appId: 'cli_disabled', name: 'Disabled Bot', memberId: 'ou_disabled', openId: 'ou_disabled' }
      ]
    });
    expect(peer.getBotInfo).not.toHaveBeenCalled();
    await expect(tools.isConfiguredPeer('cli_current', 'oc_group', 'ou_peer')).resolves.toBe(true);
    await expect(tools.isConfiguredPeer('cli_current', 'oc_group', 'ou_unconfigured')).resolves.toBe(false);
    await expect(tools.isConfiguredPeer('cli_current', 'oc_group', 'ou_disabled')).resolves.toBe(false);
  });

  it('injects group context for every dispatch path while leaving p2p sessions unchanged', async () => {
    const { tools } = await setup({ cli_current: fakeClient() }, "'/usr/bin/node' '/app/cli.js'");
    const prompt = await tools.promptForSession(session(), '继续处理');
    // 完整绑定命令只出现一次，其余入口用 dutydeck 简写；交付方式也只说一次。
    expect(prompt).toContain("本会话的 dutydeck 命令是 '/usr/bin/node' '/app/cli.js'，下文的 dutydeck 都指它");
    expect(prompt.split("'/usr/bin/node' '/app/cli.js'")).toHaveLength(2);
    expect(prompt).toContain('group messages/message');
    expect(prompt).toContain('先看 dutydeck agent --help');
    expect(prompt).toContain('本轮没有任务尝试凭证，不能执行 Agent 操作。');
    expect(prompt).not.toContain('本轮的操作都在');
    expect(prompt).toContain('group peers/members');
    expect(prompt.split('本轮最终答复直接输出')).toHaveLength(2);
    await expect(tools.promptForSession(session({ sourceId: 'cli_current:oc_p2p:p2p' }), '继续处理')).resolves.toContain('group send/send-file');
  });

  it.each(['deny-all', 'approve-reads', 'full-trust'] as const)('advertises background tools only with an explicit tool policy: %s', async permissionMode => {
    const { tools } = await setup({ cli_current: fakeClient() });
    const prompt = await tools.promptForSession(session({ sourceId: 'cli_current:oc_group:group:collaboration:mandate', permissionMode }), '冻结材料');
    if (permissionMode === 'deny-all') expect(prompt).toBe('冻结材料');
    else {
      expect(prompt).toContain('先看 dutydeck agent --help');
      expect(prompt).toContain('group messages/message');
      expect(prompt).toContain('后台调度器负责投递');
      expect(prompt).not.toContain('group send/send-file');
    }
    const interactive = await tools.promptForSession(session({ permissionMode }), '普通任务');
    expect(interactive).toContain('group messages/message');
  });

  it('teaches memory tools to every Lark session, even when group collaboration is off', async () => {
    const { tools, repos } = await setup({ cli_current: fakeClient() }, "'/usr/bin/node' '/app/cli.js'");
    const enabled = await tools.promptForSession(session(), '继续处理');
    expect(enabled.indexOf('[Dutydeck 会话记忆工具]')).toBeGreaterThanOrEqual(0);
    expect(enabled.indexOf('[Dutydeck 会话记忆工具]')).toBeLessThan(enabled.indexOf('[Dutydeck 飞书会话工具]'));
    expect(enabled).toContain('dutydeck agent memory search/show/list');
    expect(enabled).toContain('memory add/remove');
    expect(enabled.endsWith('继续处理')).toBe(true);
    const disabled = await tools.promptForSession(session({ sourceId: 'cli_disabled:oc_p2p:p2p' }), '继续处理');
    expect(disabled).toContain("本会话的 dutydeck 命令是 '/usr/bin/node' '/app/cli.js'");
    expect(disabled).toContain('dutydeck agent memory search/show/list');
    expect(disabled).not.toContain('[Dutydeck 飞书会话工具]');
    expect(disabled).not.toContain('[Dutydeck 目标编排]');
    await expect(tools.promptForSession(session({ source: 'web', sourceId: undefined }), '继续处理')).resolves.toBe('继续处理');

    // memoryEnabled 为 false 时不拼提示
    await repos.config.set(larkBotsConfigKey, JSON.stringify([
      { appId: 'cli_current', appSecret: 'secret-current', name: 'Current Bot', defaultAgentId: 'codex', groupToolsEnabled: true, groupToolsAllowSend: true, memoryEnabled: false }
    ]));
    const memoryOff = await tools.promptForSession(session(), '继续处理');
    expect(memoryOff).not.toContain('[Dutydeck 会话记忆工具]');
    expect(memoryOff).toContain('[Dutydeck 飞书会话工具]');
  });

  it('injects capability limits and management hints according to group tools and chat type (F1-1)', async () => {
    const { tools } = await setup({ cli_current: fakeClient() });

    // 1. 群工具关闭时，prompt 包含定时说明和管理说明
    const promptDisabledGroup = await tools.promptForSession(session({ sourceId: 'cli_disabled:oc_group:group' }), '用户指令');
    expect(promptDisabledGroup).toContain('[Dutydeck 能力限制与操作指引]');
    expect(promptDisabledGroup).toContain('定时任务用 /schedule');
    expect(promptDisabledGroup).toContain('不要用 crontab、后台 sleep 或循环脚本代替');
    expect(promptDisabledGroup).toContain('切换 agent、模型或工作目录用 /new');
    expect(promptDisabledGroup).toContain('/tasks');
    expect(promptDisabledGroup).toContain('停止当前任务点进度卡上的“中断”');
    expect(promptDisabledGroup).toContain('重新开始用 /new');
    expect(promptDisabledGroup).toContain('不要说“已完成”或“已设置”');

    // 2. 仅群工具开启不足以提供定时委托：缺少当前 actor 与独立协作授权
    const promptEnabledGroup = await tools.promptForSession(session({ sourceId: 'cli_current:oc_group:group' }), '用户指令');
    expect(promptEnabledGroup).toContain('[Dutydeck 能力限制与操作指引]');
    expect(promptEnabledGroup).toContain('定时任务');
    expect(promptEnabledGroup).toContain('/schedule');
    expect(promptEnabledGroup).toContain('切换 agent、模型或工作目录用 /new');
    expect(promptEnabledGroup).toContain('/tasks');
    expect(promptEnabledGroup).toContain('停止当前任务点进度卡上的“中断”');
    expect(promptEnabledGroup).toContain('重新开始用 /new');

    // 3. 私聊时，含定时说明
    const promptP2P = await tools.promptForSession(session({ sourceId: 'cli_current:oc_p2p:p2p' }), '用户指令');
    expect(promptP2P).toContain('[Dutydeck 能力限制与操作指引]');
    expect(promptP2P).toContain('定时任务用 /schedule');
    expect(promptP2P).toContain('切换 agent、模型或工作目录用 /new');
  });

  it('lets the Agent set up a schedule for the requester instead of telling them to send /schedule', async () => {
    const f = await setup({ cli_current: fakeClient() });
    const active = { taskId: 'task-one', attemptId: 'attempt-one', actorId: 'ou_actor' };
    let collaboration = false;
    const tools = new LarkAgentToolsService(f.capabilities, f.repos.config, {
      scheduleRequests: true, workbenchTask: () => active, previewWork: async () => false, previewCollaboration: async () => collaboration,
      automatedTask: taskId => taskId === 'task-scheduled'
    });
    const prompt = await tools.promptForSession(f.activeSession, '这个群聊有结论了私发我');
    expect(prompt).toContain('schedule create 加 --every <分钟数>');
    expect(prompt).toContain('循环任务默认每次在新会话里执行');
    expect(prompt).toContain('加 --mode session');
    expect(prompt).toContain('需要试跑就在本轮直接执行一次，不要建“测试任务”');
    expect(prompt).toContain(f.capabilities.workbenchTurnToken(f.activeSession.id, 'task-one', 'attempt-one'));
    expect(prompt).toContain('用户点「启用」才开始');
    expect(prompt).not.toContain('定时任务用 /schedule');
    expect(prompt).toContain('切换 agent、模型或工作目录用 /new');
    // 能做群内持续协作时走定时委托，不再给第二种做法。
    collaboration = true;
    const delegated = await tools.promptForSession(f.activeSession, 'x');
    expect(delegated).toContain('[群内持续协作]');
    expect(delegated).not.toContain('schedule create');
    // 定时任务到点执行的那一轮不给入口，免得每次到点又建一个。
    collaboration = false; active.taskId = 'task-scheduled';
    expect(await tools.promptForSession(f.activeSession, 'x')).not.toContain('schedule create');
    active.taskId = 'task-one';
    // 没有这一轮的发起人时建不了计划，仍按原说法提示。
    const idle = new LarkAgentToolsService(f.capabilities, f.repos.config, { scheduleRequests: true });
    expect(await idle.promptForSession(f.activeSession, 'x')).toContain('定时任务用 /schedule');
    await expect(tools.requestContext(f.token)).resolves.toMatchObject({ sessionId: f.activeSession.id, appId: 'cli_current', chatId: 'oc_group' });
    await expect(tools.requestContext('v1.forged')).rejects.toMatchObject({ code: 'GROUP_TOOL_UNAUTHORIZED' });
  });

  it('lets the Agent run chat commands for the requester once the bot\'s listener has registered them', async () => {
    const f = await setup({ cli_current: fakeClient() });
    const active = { taskId: 'task-one', attemptId: 'attempt-one', actorId: 'ou_actor' };
    const tools = new LarkAgentToolsService(f.capabilities, f.repos.config, {
      workbenchTask: () => active, previewWork: async () => false, previewCollaboration: async () => false, automatedTask: taskId => taskId === 'task-scheduled'
    });
    // 监听没在运行就没有入口，仍按原说法提示。
    expect(await tools.promptForSession(f.activeSession, 'x')).toContain('切换 agent、模型或工作目录用 /new');
    tools.commands.set('cli_current', async () => ({}));
    const prompt = await tools.promptForSession(f.activeSession, '换 codex 重新做');
    expect(prompt).toContain("session new --agent <Agent编号> --task '<完整任务>'");
    expect(prompt).toContain('status、agents、tasks、queue、schedules、ci');
    expect(prompt).toContain(f.capabilities.workbenchTurnToken(f.activeSession.id, 'task-one', 'attempt-one'));
    expect(prompt).toContain('不要让用户自己发命令');
    // 必须留在提示词里的规则：确认卡只回一句、用户专属操作。
    expect(prompt).toContain('返回 confirmationDelivery:failed 时，按 message 说明计划已保存但发卡失败，并给用户恢复办法');
    expect(prompt).toContain('其他 pendingConfirmation:true 表示已发确认卡：只回一句已发确认卡');
    expect(prompt).toContain('停止当前任务、批准工具调用、回答你的提问只能由用户做');
    expect(prompt).not.toContain('切换 agent、模型或工作目录用 /new');
    // 定时任务到点执行的那一轮不给入口。
    active.taskId = 'task-scheduled';
    expect(await tools.promptForSession(f.activeSession, 'x')).not.toContain('Dutydeck 操作由你代办');
  });

  it('puts everything into one short block: entry, one line per capability this turn, the rules to keep, one immutable attempt credential', async () => {
    const f = await setup({ cli_current: fakeClient() });
    const active = { taskId: 'task-one', attemptId: 'attempt-one', actorId: 'ou_actor' };
    const tools = new LarkAgentToolsService(f.capabilities, f.repos.config, {
      groupToolsCommand: "'/usr/bin/node' '/app/cli.js'", scheduleRequests: true,
      workbenchTask: () => active, finalTaskContext: async () => undefined, previewWork: async () => true, previewCollaboration: async () => false
    });
    tools.commands.set('cli_current', async () => ({}));
    const prompt = await tools.promptForSession(f.activeSession, '用户指令');
    const [block, rest] = prompt.split('\n\n用户指令');
    expect(rest).toBe('');
    // 一个块：入口在最前，命令前缀是绝对路径且只出现一次。
    expect(block.startsWith("[Dutydeck 命令] 本轮完整 Agent 命令前缀是 '/usr/bin/node' '/app/cli.js'")).toBe(true);
    expect(block.split("'/usr/bin/node' '/app/cli.js'")).toHaveLength(2);
    expect(block).toContain('先看 dutydeck agent --help');
    // 本轮能力每项一行。
    const capabilities = block.slice(block.indexOf('本轮可用（都在 dutydeck agent 下）：'), block.indexOf('规则：')).trim().split('\n').slice(1);
    expect(capabilities.every(line => line.startsWith('- '))).toBe(true);
    for (const text of ['memory search/show/list', 'group messages/message', 'group peers/members/bots', 'group send/send-file', "--final", 'group handoff', 'dutydeck agent work', 'schedule create', 'session new --agent']) {
      expect(capabilities.filter(line => line.includes(text))).toHaveLength(1);
    }
    // 保留的规则。
    const rules = block.slice(block.indexOf('规则：')).split('\n').slice(1);
    expect(rules).toEqual([expect.stringContaining('群里发消息'), expect.stringContaining('GROUP_TOOL_AUTHORIZATION_REQUIRED'), expect.stringContaining('pendingConfirmation:true'), expect.stringContaining('只能由用户做')]);
    expect(block).toContain('本轮最终答复直接输出');
    // 会话凭证留在进程环境中，提示只携带不可变尝试凭证，也不出现旧入口。
    expect(block).not.toContain(f.token);
    expect(block).not.toContain('dutydeck_group_tools_token');
    const turn = f.capabilities.finalTurnToken(f.activeSession.id, 'task-one', 'attempt-one');
    expect(block.split(turn)).toHaveLength(2);
    expect(block).toContain(`agent --turn ${turn}`);
    for (const legacy of ['dutydeck command', 'schedule request', 'dutydeck group ', 'dutydeck memory ', 'dutydeck work ']) expect(block).not.toContain(legacy);
  });

  it('uses opaque cursors for incremental reads and mentions a discovered target when sending', async () => {
    const first = message('om_1', '1000', 'one'); const second = message('om_2', '2000', 'two'); const third = message('om_3', '3000', 'three');
    const current = fakeClient({
      listChatMembers: vi.fn(async input => ({ items: input.memberTypes?.includes('bot') ? [{ memberId: 'ou_peer', openId: 'ou_peer', memberType: 'bot' as const, name: 'Peer Bot' }] : [], hasMore: false, securityLimited: false })),
      listChatMessages: vi.fn(async input => ({ items: input.order === 'desc' ? [second, first] : [first, second, third], hasMore: false }))
    });
    const peer = fakeClient({ getBotInfo: vi.fn(async () => ({ appName: 'Peer Bot', openId: 'ou_peer' })) });
    const { tools, token } = await setup({ cli_current: current, cli_peer: peer });
    const initial = await tools.messages(token, { limit: 2 });
    expect(initial.messages.map(item => item.content)).toEqual(['one', 'two']);
    expect(initial.cursor).toBeTruthy();
    const next = await tools.messages(token, { after: initial.cursor, limit: 10 });
    expect(next.messages.map(item => item.messageId)).toEqual(['om_3']);
    await expect(tools.send(token, { content: '请检查', to: 'cli_peer', idempotencyKey: 'handoff-1' })).resolves.toEqual({ messageId: 'om_sent', chatId: 'oc_group' });
    expect(current.sendText).toHaveBeenCalledWith({
      chatId: 'oc_group', text: '<at user_id="ou_peer">Peer Bot</at> 请检查', idempotencyKey: 'handoff-1'
    });
  });

  it('redacts credentials in text the Agent sends to the group', async () => {
    const current = fakeClient();
    const { tools, token } = await setup({ cli_current: current });
    await tools.send(token, { content: '配置里是 ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789' });
    expect(current.sendText).toHaveBeenCalledWith(expect.objectContaining({ text: '配置里是 [REDACTED]' }));
  });

  it('discovers and mentions a human member in the scoped group', async () => {
    const current = fakeClient({
      listChatMembers: vi.fn(async input => ({
        items: input.memberTypes?.includes('user')
          ? [{ memberId: 'ou_human', openId: 'ou_human', memberType: 'user' as const, name: '伟哥' }]
          : [],
        hasMore: false, securityLimited: false
      }))
    });
    const { tools, token } = await setup({ cli_current: current });
    await expect(tools.members(token)).resolves.toEqual({
      chatId: 'oc_group', securityLimited: false,
      members: [{ name: '伟哥', memberId: 'ou_human', openId: 'ou_human' }]
    });
    await expect(tools.send(token, { content: '请改用 dutydeck', to: '伟哥' })).resolves.toEqual({ messageId: 'om_sent', chatId: 'oc_group' });
    expect(current.sendText).toHaveBeenCalledWith(expect.objectContaining({
      chatId: 'oc_group', text: '<at user_id="ou_human">伟哥</at> 请改用 dutydeck'
    }));
  });

  it('rejects cross-group replies and converts missing scopes into explicit admin instructions', async () => {
    const crossGroup = fakeClient({ getMessage: vi.fn(async () => ({ ...message('om_other', '1000', 'other'), chatId: 'oc_other' })) });
    const first = await setup({ cli_current: crossGroup });
    await expect(first.tools.send(first.token, { content: 'reply', replyTo: 'om_other' })).rejects.toMatchObject({ code: 'GROUP_REPLY_OUT_OF_SCOPE', statusCode: 403 });
    expect(crossGroup.replyText).not.toHaveBeenCalled();

    const denied = fakeClient({
      listChatMembers: vi.fn(async () => { throw new LarkServiceError('LARK_OPENAPI_ERROR', 'Access denied', 502, { upstreamCode: 99991672, consoleUrl: 'https://open.larkoffice.com/app/cli_current/auth' }); })
    });
    const second = await setup({ cli_current: denied });
    let caught: AgentGroupToolError | undefined;
    try { await second.tools.peers(second.token); } catch (error) { caught = error as AgentGroupToolError; }
    expect(caught).toMatchObject({ code: 'GROUP_TOOL_AUTHORIZATION_REQUIRED', statusCode: 403 });
    expect(caught?.response().error).toMatchObject({
      requiredScopes: ['im:chat.members:read'], authorizationUrl: 'https://open.larkoffice.com/app/cli_current/auth',
      instruction: expect.stringContaining('不要向用户索要 App Secret')
    });
  });

  it('can deliberately reply inside a topic or start an independent group message', async () => {
    const current = fakeClient();
    const { tools, token } = await setup({ cli_current: current });
    await expect(tools.send(token, { content: '话题内结论', replyTo: 'om_topic_root', inThread: true, idempotencyKey: 'thread-1' })).resolves.toEqual({ messageId: 'om_reply', chatId: 'oc_group' });
    expect(current.replyText).toHaveBeenCalledWith({
      messageId: 'om_topic_root', text: '话题内结论', replyInThread: true, idempotencyKey: 'thread-1'
    });
    await expect(tools.send(token, { content: '独立公告', idempotencyKey: 'new-1' })).resolves.toEqual({ messageId: 'om_sent', chatId: 'oc_group' });
    expect(current.sendText).toHaveBeenCalledWith({ chatId: 'oc_group', text: '独立公告', idempotencyKey: 'new-1' });
    await expect(tools.send(token, { content: '缺少目标', inThread: true })).rejects.toMatchObject({ code: 'GROUP_THREAD_REPLY_TARGET_REQUIRED' });
    await expect(tools.send(token, { content: '错误目标', replyTo: 'omt_topic', inThread: true })).rejects.toMatchObject({ code: 'INVALID_GROUP_REPLY_TARGET' });
    expect(current.getMessage).not.toHaveBeenCalledWith('omt_topic');
  });

  it('derives a deterministic uuid from chat, target and content when no idempotency key is given', async () => {
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    const current = fakeClient({
      listChatMembers: vi.fn(async input => ({
        items: input.memberTypes?.includes('user')
          ? [
              { memberId: 'ou_human', openId: 'ou_human', memberType: 'user' as const, name: '伟哥' },
              { memberId: 'ou_other', openId: 'ou_other', memberType: 'user' as const, name: '阿强' }
            ]
          : [],
        hasMore: false, securityLimited: false
      }))
    });
    const { tools, token } = await setup({ cli_current: current });
    const sendKey = (index: number) => vi.mocked(current.sendText).mock.calls[index]![0].idempotencyKey!;
    const replyKey = (index: number) => vi.mocked(current.replyText).mock.calls[index]![0].idempotencyKey!;

    // 无 key 时同群同内容重试派生同一 UUID，且为合法 UUID 形态、不超过 50 字符。
    await tools.send(token, { content: '发布窗口已开启' });
    await tools.send(token, { content: '发布窗口已开启' });
    expect(sendKey(0)).toBe(sendKey(1));
    expect(sendKey(0)).toMatch(uuidPattern);
    expect(sendKey(0)).toHaveLength(36);
    expect(sendKey(0).length).toBeLessThanOrEqual(50);
    expect(sendKey(0)).not.toContain('dutydeck-');

    // 内容首尾空白归一化不会绕过合并；内容不同一定不同值。
    await tools.send(token, { content: '  发布窗口已开启  ' });
    expect(sendKey(2)).toBe(sendKey(0));
    await tools.send(token, { content: '发布窗口已关闭' });
    expect(sendKey(3)).not.toBe(sendKey(0));

    // --to 目标参与指纹：trim 归一化后同目标同值，不同目标不同值。
    await tools.send(token, { content: '请处理', to: ' 伟哥 ' });
    await tools.send(token, { content: '请处理', to: '伟哥' });
    expect(sendKey(4)).toBe(sendKey(5));
    await tools.send(token, { content: '请处理', to: '阿强' });
    expect(sendKey(6)).not.toBe(sendKey(4));

    // 回复目标与话题形态参与指纹：同目标同值，换回复消息或换话题形态不同值。
    await tools.send(token, { content: '收到', replyTo: 'om_root', inThread: true });
    await tools.send(token, { content: '收到', replyTo: 'om_root', inThread: true });
    expect(replyKey(0)).toBe(replyKey(1));
    await tools.send(token, { content: '收到', replyTo: 'om_other', inThread: true });
    expect(replyKey(2)).not.toBe(replyKey(0));
    await tools.send(token, { content: '收到', replyTo: 'om_root' });
    expect(replyKey(3)).not.toBe(replyKey(0));

    // 显式 key trim 后原样优先，不改写为派生 UUID。
    await tools.send(token, { content: '发布窗口已开启', idempotencyKey: '  agent-supplied-key  ' });
    expect(sendKey(7)).toBe('agent-supplied-key');
    expect(sendKey(7)).not.toMatch(uuidPattern);

    // 超长内容仍稳定且 UUID 长度不受内容长度影响。
    const longContent = '很长'.repeat(5_000);
    await tools.send(token, { content: longContent });
    await tools.send(token, { content: longContent });
    expect(sendKey(8)).toBe(sendKey(9));
    expect(sendKey(8)).toMatch(uuidPattern);
    expect(sendKey(8).length).toBeLessThanOrEqual(50);

    // 不同群即使会话与内容相同也不复用 UUID。
    const other = fakeClient();
    const otherSetup = await setup({ cli_current: other }, undefined, undefined, 'oc_other');
    await otherSetup.tools.send(otherSetup.token, { content: '发布窗口已开启' });
    expect(vi.mocked(other.sendText).mock.calls[0]![0].idempotencyKey).not.toBe(sendKey(0));

    // 同群不同会话即使内容完全相同也不复用 UUID，避免两条独立回复被平台折叠。
    const otherSession = fakeClient();
    const sessionSetup = await setup({ cli_current: otherSession }, undefined, undefined, 'oc_group', 'ses_other');
    await sessionSetup.tools.send(sessionSetup.token, { content: '发布窗口已开启' });
    expect(vi.mocked(otherSession.sendText).mock.calls[0]![0].idempotencyKey).not.toBe(sendKey(0));
  });

  describe('group messages with time window and query filtering', () => {
    it('rule 2: rejects conflicting after with since/until, invalid date formats, and since > until with GROUP_MESSAGES_INVALID_RANGE (400)', async () => {
      const current = fakeClient();
      const { tools, token } = await setup({ cli_current: current });

      // after 不能与 since/until/query 同时使用
      await expect(tools.messages(token, { after: 'cursor', since: '2026-09-25T10:00:00Z' })).rejects.toMatchObject({
        code: 'GROUP_MESSAGES_INVALID_RANGE',
        message: expect.stringContaining('--after 不能与 --since/--until/--query 同时使用'),
        statusCode: 400
      });
      await expect(tools.messages(token, { after: 'cursor', until: '1727251200' })).rejects.toMatchObject({
        code: 'GROUP_MESSAGES_INVALID_RANGE',
        message: expect.stringContaining('--after 不能与 --since/--until/--query 同时使用'),
        statusCode: 400
      });
      await expect(tools.messages(token, { after: 'cursor', query: 'some query' })).rejects.toMatchObject({
        code: 'GROUP_MESSAGES_INVALID_RANGE',
        message: expect.stringContaining('--after 不能与 --since/--until/--query 同时使用'),
        statusCode: 400
      });

      // 时间无法解析
      await expect(tools.messages(token, { since: 'not-a-valid-date' })).rejects.toMatchObject({
        code: 'GROUP_MESSAGES_INVALID_RANGE',
        statusCode: 400
      });
      await expect(tools.messages(token, { until: 'invalid-time' })).rejects.toMatchObject({
        code: 'GROUP_MESSAGES_INVALID_RANGE',
        statusCode: 400
      });

      // since > until
      await expect(tools.messages(token, {
        since: '2026-09-25T12:00:00Z',
        until: '2026-09-25T10:00:00Z'
      })).rejects.toMatchObject({
        code: 'GROUP_MESSAGES_INVALID_RANGE',
        statusCode: 400
      });
      await expect(tools.messages(token, {
        since: '1727252000',
        until: '1727251000'
      })).rejects.toMatchObject({
        code: 'GROUP_MESSAGES_INVALID_RANGE',
        statusCode: 400
      });

      expect(current.listChatMessages).not.toHaveBeenCalled();
    });

    it('rule 3: preserves default behavior without since/until/query (single request, ascending sort, exact shape)', async () => {
      const msg1 = message('om_1', '1000', 'first');
      const msg2 = message('om_2', '2000', 'second');
      const current = fakeClient({
        listChatMessages: vi.fn(async () => ({ items: [msg2, msg1], hasMore: false }))
      });
      const { tools, token } = await setup({ cli_current: current });

      const result = await tools.messages(token, { limit: 5 });

      expect(current.listChatMessages).toHaveBeenCalledTimes(1);
      expect(current.listChatMessages).toHaveBeenCalledWith({
        chatId: 'oc_group',
        order: 'desc',
        pageSize: 5
      });
      // 升序排列
      expect(result.messages.map(m => m.messageId)).toEqual(['om_1', 'om_2']);
      expect(result.cursor).toBeTruthy();
      // 返回结构完全一致，无 scanned 或 truncated 字段
      expect('scanned' in result).toBe(false);
      expect('truncated' in result).toBe(false);
      expect(result).toEqual({
        chatId: 'oc_group',
        messages: expect.any(Array),
        cursor: expect.any(String)
      });
    });

    it('rule 4: queries within time window using startTime/endTime in seconds, paginates newest-first up to limit, sorts asc', async () => {
      const sinceIso = '2026-09-25T10:00:00Z';
      const untilIso = '2026-09-25T11:00:00Z';
      const expectedStart = Math.floor(Date.parse(sinceIso) / 1000);
      const expectedEnd = Math.floor(Date.parse(untilIso) / 1000);

      // 第一页返回 30 条消息（按新到旧）
      const page1 = Array.from({ length: 30 }, (_, i) =>
        message(`om_p1_${30 - i}`, String(1790334000_000 - i * 1000), `msg p1 ${30 - i}`)
      );
      // 第二页返回 30 条更早的消息
      const page2 = Array.from({ length: 30 }, (_, i) =>
        message(`om_p2_${30 - i}`, String(1790334000_000 - (30 + i) * 1000), `msg p2 ${30 - i}`)
      );

      const current = fakeClient({
        listChatMessages: vi.fn(async input => {
          if (!input.pageToken) return { items: page1, hasMore: true, pageToken: 'token_page_2' };
          return { items: page2, hasMore: false };
        })
      });
      const { tools, token } = await setup({ cli_current: current });

      // 请求 limit = 50，第一页 30 条不足 50，分页拉取第二页的前 20 条，共 50 条
      const result = await tools.messages(token, {
        since: sinceIso,
        until: untilIso,
        limit: 50
      });

      expect(current.listChatMessages).toHaveBeenCalledTimes(2);
      expect(current.listChatMessages).toHaveBeenNthCalledWith(1, {
        chatId: 'oc_group',
        order: 'desc',
        pageSize: 50,
        startTime: expectedStart,
        endTime: expectedEnd
      });
      expect(current.listChatMessages).toHaveBeenNthCalledWith(2, {
        chatId: 'oc_group',
        order: 'desc',
        pageSize: 50,
        startTime: expectedStart,
        endTime: expectedEnd,
        pageToken: 'token_page_2'
      });

      expect(result.messages).toHaveLength(50);
      // 返回前按时间升序排序
      for (let i = 1; i < result.messages.length; i++) {
        expect(Number(result.messages[i]!.createTime)).toBeGreaterThanOrEqual(Number(result.messages[i - 1]!.createTime));
      }
      // cursor 取最新的一条
      const latestMessage = result.messages.at(-1)!;
      expect(result.cursor).toBeTruthy();
      // 没有 query 时不带 scanned 和 truncated
      expect('scanned' in result).toBe(false);
      expect('truncated' in result).toBe(false);
    });

    it('rule 5: filters messages by query with multiple whitespace-separated case-insensitive terms and tracks scanned/truncated', async () => {
      // 消息正文包含全部词才算命中，大小写不敏感
      const msg1 = message('om_1', '1000', 'Dutydeck release note v1');
      const msg2 = message('om_2', '2000', 'Dutydeck only');
      const msg3 = message('om_3', '3000', 'Release Note without brand');
      const msg4 = message('om_4', '4000', 'dutydeck RELEASE NOTE hotfix');

      const current = fakeClient({
        listChatMessages: vi.fn(async () => ({ items: [msg4, msg3, msg2, msg1], hasMore: false }))
      });
      const { tools, token } = await setup({ cli_current: current });

      const result = await tools.messages(token, { query: 'dutydeck  note', limit: 10 });
      // 命中 msg1 和 msg4（正文包含 'dutydeck' 和 'note'，忽略大小写）
      expect(result.messages.map(m => m.messageId)).toEqual(['om_1', 'om_4']);
      expect(result.scanned).toBe(4);
      expect(result.truncated).toBeUndefined();
    });

    it('rule 5 positive: marks truncated=true when 10-page scan limit is exhausted, 10th page hasMore=true, and matched items < limit', async () => {
      // 模拟 10 页，每页 50 条消息（共 500 条），第 10 页 hasMore 为 true，但没有任何一条命中 query
      let callCount = 0;
      const current = fakeClient({
        listChatMessages: vi.fn(async () => {
          callCount++;
          const items = Array.from({ length: 50 }, (_, i) =>
            message(`om_page_${callCount}_${i}`, String(callCount * 1000 + i), 'unmatched content')
          );
          return { items, hasMore: true, pageToken: `token_${callCount + 1}` };
        })
      });
      const { tools, token } = await setup({ cli_current: current });

      const result = await tools.messages(token, { query: 'target_keyword', limit: 20 });
      expect(callCount).toBe(10);
      expect(result.scanned).toBe(500);
      expect(result.messages).toHaveLength(0);
      expect(result.truncated).toBe(true);
    });

    it('rule 5 negative: does NOT mark truncated when 10-page limit is reached but 10th page hasMore=false (exhausted messages)', async () => {
      // 模拟 10 页，每页 50 条消息（共 500 条），第 10 页正好是最后一页（hasMore: false）
      let callCount = 0;
      const current = fakeClient({
        listChatMessages: vi.fn(async () => {
          callCount++;
          const items = Array.from({ length: 50 }, (_, i) =>
            message(`om_page_${callCount}_${i}`, String(callCount * 1000 + i), 'unmatched content')
          );
          // 前 9 页 hasMore: true，第 10 页 hasMore: false
          const hasMore = callCount < 10;
          return { items, hasMore, ...(hasMore ? { pageToken: `token_${callCount + 1}` } : {}) };
        })
      });
      const { tools, token } = await setup({ cli_current: current });

      const result = await tools.messages(token, { query: 'target_keyword', limit: 20 });
      expect(callCount).toBe(10);
      expect(result.scanned).toBe(500);
      expect(result.messages).toHaveLength(0);
      expect(result.truncated).toBeUndefined();
      expect('truncated' in result).toBe(false);
    });
  });
});
