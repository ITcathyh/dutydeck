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
    { appId: 'cli_current', appSecret: 'secret-current', name: 'Current Bot', defaultAgentId: 'codex', groupToolsEnabled: true, groupToolsAllowSend: true },
    { appId: 'cli_peer', appSecret: 'secret-peer', name: 'Peer Bot', defaultAgentId: 'claude', groupToolsEnabled: true, groupToolsAllowSend: true },
    { appId: 'cli_disabled', appSecret: 'secret-disabled', name: 'Disabled Bot', defaultAgentId: 'gemini', groupToolsEnabled: false }
  ]));
  const capabilities = new LarkAgentToolCapabilityRegistry(repos.sessions, 'http://127.0.0.1:4310');
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
  it('checks the unified group-tools execution edge before reading or sending', async () => {
    const current = fakeClient();
    const authorize = vi.fn(async (_boundary: 'group_tools', action: any) => ({
      allowed: false, action, code: 'channel_bot_disabled', reason: 'staged bot', source: 'integration' as const
    }));
    const { tools, token } = await setup({ cli_current: current }, undefined, {
      integrationMode: 'legacy_unmanaged',
      authorize,
    });
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
      dutydeck_group_tools_token: token
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
    expect(prompt).toContain("'/usr/bin/node' '/app/cli.js' group peers");
    expect(prompt).toContain("group send '我已定位问题' --reply-to om_xxx --in-thread");
    expect(prompt).toContain("group send '发布窗口已开启'");
    await expect(tools.promptForSession(session({ sourceId: 'cli_current:oc_p2p:p2p' }), '继续处理')).resolves.toContain('group send-file');
  });

  it('teaches memory tools to every Lark session, even when group collaboration is off', async () => {
    const { tools } = await setup({ cli_current: fakeClient() }, "'/usr/bin/node' '/app/cli.js'");
    const enabled = await tools.promptForSession(session(), '继续处理');
    expect(enabled.indexOf('[Dutydeck 会话记忆工具]')).toBeGreaterThanOrEqual(0);
    expect(enabled.indexOf('[Dutydeck 会话记忆工具]')).toBeLessThan(enabled.indexOf('[Dutydeck 飞书会话工具]'));
    expect(enabled).toContain("'/usr/bin/node' '/app/cli.js' memory add");
    expect(enabled.endsWith('继续处理')).toBe(true);
    const disabled = await tools.promptForSession(session({ sourceId: 'cli_disabled:oc_p2p:p2p' }), '继续处理');
    expect(disabled).toContain("'/usr/bin/node' '/app/cli.js' memory list");
    expect(disabled).not.toContain('group send');
    expect(disabled).not.toContain('[Dutydeck 目标编排]');
    await expect(tools.promptForSession(session({ source: 'web', sourceId: undefined }), '继续处理')).resolves.toBe('继续处理');
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
});
