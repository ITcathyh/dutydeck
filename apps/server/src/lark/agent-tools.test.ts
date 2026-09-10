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
) {
  const repos = createRepositories(':memory:'); repositories.push(repos);
  const activeSession = session();
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
});
