import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import type { Session } from '@dutydeck/shared';
import { larkBotsConfigKey } from './config.js';
import {
  AgentGroupToolError,
  LarkAgentToolCapabilityRegistry,
  LarkAgentToolsService,
  stripLeadingMentions,
  deterministicAgentActionKey,
  type LarkGroupToolClient
} from './agent-tools.js';
import type { ExplicitFinalContext } from './explicit-final.js';
import { LarkServiceError, type LarkChatMessage } from './service.js';
import { createCliProgram } from '../cli-program.js';

const repositories: Array<ReturnType<typeof createRepositories>> = [];
afterEach(() => { for (const repository of repositories.splice(0)) repository.close(); });

const makeSession = (overrides: Partial<Session> = {}): Session => ({
  id: 'ses_a', agentId: 'codex', state: 'idle', cwd: '/tmp', source: 'lark', sourceId: 'cli_a:oc_group:group',
  runId: 'run_1', createdAt: '', updatedAt: '', ...overrides
});

const makeMessage = (
  messageId: string,
  text: string,
  sender: { id: string; type: string; name: string; idType?: string },
  chatId = 'oc_group',
  threadId?: string
): LarkChatMessage => ({
  messageId, chatId, messageType: 'text', createTime: '1000', sender,
  rawContent: JSON.stringify({ text }), mentions: [], deleted: false, updated: false,
  ...(threadId ? { threadId } : {})
});

function fakeClient(botInfo: { appName: string; openId: string }, overrides: Partial<LarkGroupToolClient> = {}): LarkGroupToolClient {
  return {
    getBotInfo: vi.fn(async () => botInfo),
    listChatMembers: vi.fn(async input => {
      const all = [
        { memberId: 'ou_a', appId: 'cli_a', name: 'Bot A', memberType: 'bot' as const, openId: 'ou_a' },
        { memberId: 'ou_b', appId: 'cli_b', name: 'Bot B', memberType: 'bot' as const, openId: 'ou_b' },
        { memberId: 'ou_ext', appId: 'cli_ext', name: 'External Bot', memberType: 'bot' as const, openId: 'ou_ext' },
        { memberId: 'ou_human', name: '张工', memberType: 'user' as const, openId: 'ou_human' }
      ];
      const items = input.memberTypes ? all.filter(m => input.memberTypes!.includes(m.memberType)) : all;
      return { items, hasMore: false, securityLimited: false };
    }),
    listChatMessages: vi.fn(async () => ({ items: [], hasMore: false })),
    getMessage: vi.fn(async (messageId: string) => makeMessage(messageId, 'original task', { id: 'ou_user', type: 'user', name: 'User' })),
    getMessageItems: vi.fn(async (messageId: string) => [makeMessage(messageId, 'original task', { id: 'ou_user', type: 'user', name: 'User' })]),
    sendText: vi.fn(async input => ({ messageId: 'om_sent', chatId: input.chatId })),
    replyText: vi.fn(async input => ({ messageId: 'om_reply_' + Math.random().toString(36).slice(2, 6), chatId: 'oc_group' })),
    ...overrides
  };
}

describe('Agent Handoff & Reply-Agent integration suite', () => {
  it('handles full A-handoff to B and B-reply-agent back to A with real SQLite repository and real app_id sender', async () => {
    const repos = createRepositories(':memory:');
    repositories.push(repos);

    const sessionA = makeSession({ id: 'ses_a', sourceId: 'cli_a:oc_group:group' });
    const sessionB = makeSession({ id: 'ses_b', sourceId: 'cli_b:oc_group:group' });
    await repos.sessions.save(sessionA);
    await repos.sessions.save(sessionB);

    await repos.config.set(larkBotsConfigKey, JSON.stringify([
      { appId: 'cli_a', appSecret: 'secret-a', name: 'Bot A', defaultAgentId: 'codex', groupToolsEnabled: true, groupToolsAllowSend: true },
      { appId: 'cli_b', appSecret: 'secret-b', name: 'Bot B', defaultAgentId: 'claude', groupToolsEnabled: true, groupToolsAllowSend: true }
    ]));

    const capabilities = new LarkAgentToolCapabilityRegistry(repos.sessions, 'http://127.0.0.1:4310');
    const envA = capabilities.environmentFor(sessionA);
    const envB = capabilities.environmentFor(sessionB);
    const tokenA = envA.dutydeck_group_tools_token!;
    const tokenB = envB.dutydeck_group_tools_token!;

    const clientA = fakeClient({ appName: 'Bot A', openId: 'ou_a' });
    const clientB = fakeClient({ appName: 'Bot B', openId: 'ou_b' });

    let taskAState: { taskId: string; attemptId: string } | undefined = { taskId: 'task_1', attemptId: 'att_1' };
    let taskBState: { taskId: string; attemptId: string } | undefined = { taskId: 'task_2', attemptId: 'att_2' };

    const originMessageIdA = 'om_user_prompt';
    let handoffMessageId = '';

    const toolsA = new LarkAgentToolsService(capabilities, repos.config, {
      workbenchTask: sessionId => sessionId === 'ses_a' ? taskAState : undefined,
      finalTaskContext: async (binding, task) => {
        if (binding.sessionId !== 'ses_a' || task.taskId !== 'task_1') return undefined;
        return {
          taskName: 'Task 1',
          scope: {
            app_id: 'cli_a',
            session_id: 'ses_a',
            runtime_task_id: 'task_1',
            attempt_id: task.attemptId,
            origin_message_id: originMessageIdA,
            turn: 1,
            chat_id: 'oc_group',
            chat_type: 'group',
            reply_message_id: originMessageIdA,
            reply_in_thread: true
          }
        };
      },
      clientFactory: config => config.appId === 'cli_a' ? clientA : clientB
    });

    const toolsB = new LarkAgentToolsService(capabilities, repos.config, {
      workbenchTask: sessionId => sessionId === 'ses_b' ? taskBState : undefined,
      finalTaskContext: async (binding, task) => {
        if (binding.sessionId !== 'ses_b' || task.taskId !== 'task_2') return undefined;
        return {
          taskName: 'Task 2',
          scope: {
            app_id: 'cli_b',
            session_id: 'ses_b',
            runtime_task_id: 'task_2',
            attempt_id: task.attemptId,
            origin_message_id: handoffMessageId,
            turn: 1,
            chat_id: 'oc_group',
            chat_type: 'group',
            reply_message_id: handoffMessageId,
            reply_in_thread: true
          }
        };
      },
      clientFactory: config => config.appId === 'cli_b' ? clientB : clientA
    });

    clientA.getMessage = vi.fn(async id => {
      if (id === originMessageIdA) {
        return makeMessage(originMessageIdA, '用户提问：请两位 Agent 配合完成重构', { id: 'ou_user', type: 'user', name: 'User' });
      }
      throw new Error(`Unknown message ${id}`);
    });

    // Step 1: Bot A hands off task to Bot B
    const turnTokenA = capabilities.finalTurnToken('ses_a', 'task_1', 'att_1');
    const handoffResult = await toolsA.handoff(tokenA, {
      to: 'Bot B',
      content: '目标：重构工具单元；工作区：/tmp；验收标准：通过全部测试',
      turn: turnTokenA
    });

    expect(handoffResult).toMatchObject({
      chatId: 'oc_group',
      replyTo: originMessageIdA,
      target: { appId: 'cli_b', name: 'Bot B', openId: 'ou_b' }
    });

    expect(clientA.sendText).not.toHaveBeenCalled(); // 不是群广播
    expect(clientA.replyText).toHaveBeenCalledTimes(1);
    const handoffCall = (clientA.replyText as any).mock.calls[0][0];
    expect(handoffCall.messageId).toBe(originMessageIdA);
    expect(handoffCall.replyInThread).toBe(true);
    expect(handoffCall.text).toContain('<at user_id="ou_b">Bot B</at>'); // 真实 @
    expect(handoffCall.text).toContain('[Agent 交接]'); // 标记
    expect(handoffCall.text).toContain('来自 Bot A (cli_a)'); // 请求方身份
    expect(handoffCall.text).toContain('reply-agent'); // 说明使用 reply-agent
    expect(handoffCall.idempotencyKey).toMatch(/^ah_[a-f0-9]{42}$/);
    expect(handoffCall.idempotencyKey.length).toBeLessThanOrEqual(50);

    const handoffSentMessageId = handoffResult.messageId;

    // Step 2: Bot B replies to Bot A with result
    // 覆盖真 Feishu 消息 sender: { type: 'app', id: 'cli_a', idType: 'app_id' }
    clientB.getMessage = vi.fn(async id => {
      if (id === handoffSentMessageId) {
        return makeMessage(handoffSentMessageId, handoffCall.text, {
          id: 'cli_a',
          type: 'app',
          name: 'Bot A',
          idType: 'app_id'
        });
      }
      throw new Error(`Unknown message ${id}`);
    });

    handoffMessageId = handoffSentMessageId;
    const turnTokenB = capabilities.finalTurnToken('ses_b', 'task_2', 'att_2');
    const replyResult = await toolsB.replyAgent(tokenB, {
      content: '测试全部通过，工作区状态 clean，改动已就绪',
      turn: turnTokenB
    });

    expect(replyResult).toMatchObject({
      chatId: 'oc_group',
      replyTo: handoffSentMessageId,
      target: { appId: 'cli_a', name: 'Bot A', openId: 'ou_a' }
    });

    expect(clientB.sendText).not.toHaveBeenCalled(); // 不是群广播
    expect(clientB.replyText).toHaveBeenCalledTimes(1);
    const replyCall = (clientB.replyText as any).mock.calls[0][0];
    expect(replyCall.messageId).toBe(handoffSentMessageId);
    expect(replyCall.replyInThread).toBe(true);
    expect(replyCall.text).toContain('<at user_id="ou_a">Bot A</at>'); // 真实 @ 发送方
    expect(replyCall.text).toContain('[Agent 结果]'); // 结果标记
    expect(replyCall.text).toContain('收到/谢谢'); // 防礼貌唤醒
    expect(replyCall.idempotencyKey).toMatch(/^ar_[a-f0-9]{42}$/);
    expect(replyCall.idempotencyKey.length).toBeLessThanOrEqual(50);
  });

  it('guarantees stable idempotency key on retry and distinct keys on new attempts', async () => {
    const key1 = deterministicAgentActionKey({
      sessionId: 'ses_1',
      taskId: 'task_1',
      attemptId: 'att_1',
      action: 'handoff',
      targetId: 'ou_target',
      content: 'hello'
    });
    const key1Retry = deterministicAgentActionKey({
      sessionId: 'ses_1',
      taskId: 'task_1',
      attemptId: 'att_1',
      action: 'handoff',
      targetId: 'ou_target',
      content: 'hello'
    });
    expect(key1).toBe(key1Retry);
    expect(key1.length).toBeLessThanOrEqual(50);

    const keyNewAttempt = deterministicAgentActionKey({
      sessionId: 'ses_1',
      taskId: 'task_1',
      attemptId: 'att_2',
      action: 'handoff',
      targetId: 'ou_target',
      content: 'hello'
    });
    expect(keyNewAttempt).not.toBe(key1);

    const replyKey1 = deterministicAgentActionKey({
      sessionId: 'ses_1',
      taskId: 'task_1',
      attemptId: 'att_1',
      action: 'reply-agent',
      targetId: 'ou_target',
      content: 'hello'
    });
    const replyKeyNewAttempt = deterministicAgentActionKey({
      sessionId: 'ses_1',
      taskId: 'task_1',
      attemptId: 'att_2',
      action: 'reply-agent',
      targetId: 'ou_target',
      content: 'hello'
    });
    expect(replyKey1).toMatch(/^ar_/);
    expect(replyKey1).not.toBe(replyKeyNewAttempt);
  });

  it('rejects handoff to human members or to self (including openId-only member mapping)', async () => {
    const repos = createRepositories(':memory:');
    repositories.push(repos);
    const session = makeSession();
    await repos.sessions.save(session);
    await repos.config.set(larkBotsConfigKey, JSON.stringify([
      { appId: 'cli_a', appSecret: 'sec', name: 'Bot A', defaultAgentId: 'codex', groupToolsEnabled: true, groupToolsAllowSend: true },
      { appId: 'cli_b', appSecret: 'sec', name: 'Bot B', defaultAgentId: 'claude', groupToolsEnabled: true, groupToolsAllowSend: true }
    ]));
    const capabilities = new LarkAgentToolCapabilityRegistry(repos.sessions, 'http://127.0.0.1:4310');
    const token = capabilities.environmentFor(session).dutydeck_group_tools_token!;
    const client = fakeClient({ appName: 'Bot A', openId: 'ou_a' });
    const tools = new LarkAgentToolsService(capabilities, repos.config, {
      workbenchTask: () => ({ taskId: 't1', attemptId: 'a1' }),
      finalTaskContext: async () => ({
        taskName: 'Task',
        scope: {
          app_id: 'cli_a', session_id: 'ses_a', runtime_task_id: 't1', attempt_id: 'a1',
          origin_message_id: 'om_orig', turn: 1, chat_id: 'oc_group', chat_type: 'group',
          reply_message_id: 'om_orig', reply_in_thread: true
        }
      }),
      clientFactory: () => client
    });

    const turn = capabilities.finalTurnToken('ses_a', 't1', 'a1');

    // 1. 尝试交接给人类（张工）
    await expect(tools.handoff(token, { to: '张工', content: 'task', turn })).rejects.toMatchObject({
      code: 'HANDOFF_TARGET_HUMAN_FORBIDDEN',
      statusCode: 400
    });
    expect(client.replyText).not.toHaveBeenCalled();

    // 2. 尝试交接给自己（通过 openId）
    await expect(tools.handoff(token, { to: 'ou_a', content: 'task', turn })).rejects.toMatchObject({
      code: 'HANDOFF_TARGET_SELF_FORBIDDEN',
      statusCode: 400
    });
    expect(client.replyText).not.toHaveBeenCalled();

    // 3. 尝试交接给自己（通过 appId）
    await expect(tools.handoff(token, { to: 'cli_a', content: 'task', turn })).rejects.toMatchObject({
      code: 'HANDOFF_TARGET_SELF_FORBIDDEN',
      statusCode: 400
    });
    expect(client.replyText).not.toHaveBeenCalled();

    // 4. 群成员仅有 openId（appId 缺失）被 peersFor 映射为 appId=ou_a，系统精准比对 openId/memberId 识别为自己并零发送拒绝
    client.listChatMembers = vi.fn(async () => ({
      items: [
        { memberId: 'ou_a', name: 'Bot A', memberType: 'bot' as const, openId: 'ou_a' }, // 缺少 appId
        { memberId: 'ou_b', appId: 'cli_b', name: 'Bot B', memberType: 'bot' as const, openId: 'ou_b' }
      ],
      hasMore: false,
      securityLimited: false
    }));
    await expect(tools.handoff(token, { to: 'ou_a', content: 'task', turn })).rejects.toMatchObject({
      code: 'HANDOFF_TARGET_SELF_FORBIDDEN',
      statusCode: 400
    });
    expect(client.replyText).not.toHaveBeenCalled();
    // 即使通过名称定位到该自身 peer，也必须基于 peer.openId 判定为自身并拒绝
    await expect(tools.handoff(token, { to: 'Bot A', content: 'task', turn })).rejects.toMatchObject({
      code: 'HANDOFF_TARGET_SELF_FORBIDDEN',
      statusCode: 400
    });
    expect(client.replyText).not.toHaveBeenCalled();
  });

  it('rejects reply-agent when target is self, origin from user, or sender has ambiguity', async () => {
    const repos = createRepositories(':memory:');
    repositories.push(repos);
    const session = makeSession();
    await repos.sessions.save(session);
    await repos.config.set(larkBotsConfigKey, JSON.stringify([
      { appId: 'cli_a', appSecret: 'sec', name: 'Bot A', defaultAgentId: 'codex', groupToolsEnabled: true, groupToolsAllowSend: true },
      { appId: 'cli_b', appSecret: 'sec', name: 'Bot B', defaultAgentId: 'claude', groupToolsEnabled: true, groupToolsAllowSend: true }
    ]));
    const capabilities = new LarkAgentToolCapabilityRegistry(repos.sessions, 'http://127.0.0.1:4310');
    const token = capabilities.environmentFor(session).dutydeck_group_tools_token!;
    const client = fakeClient({ appName: 'Bot A', openId: 'ou_a' });
    const turn = capabilities.finalTurnToken('ses_a', 't1', 'a1');

    const tools = new LarkAgentToolsService(capabilities, repos.config, {
      workbenchTask: () => ({ taskId: 't1', attemptId: 'a1' }),
      finalTaskContext: async () => ({
        taskName: 'Task',
        scope: {
          app_id: 'cli_a', session_id: 'ses_a', runtime_task_id: 't1', attempt_id: 'a1',
          origin_message_id: 'om_orig', turn: 1, chat_id: 'oc_group', chat_type: 'group',
          reply_message_id: 'om_orig', reply_in_thread: true
        }
      }),
      clientFactory: () => client
    });

    // 1. origin message sender is user
    client.getMessage = vi.fn(async () => makeMessage('om_orig', 'user msg', { id: 'ou_user', type: 'user', name: 'User' }));
    await expect(tools.replyAgent(token, { content: 'res', turn })).rejects.toMatchObject({
      code: 'REPLY_AGENT_ORIGIN_NOT_BOT',
      statusCode: 400
    });
    expect(client.replyText).not.toHaveBeenCalled();

    // 2. origin message sender is self (ou_a / cli_a)
    client.getMessage = vi.fn(async () => makeMessage('om_orig', 'self msg', { id: 'ou_a', type: 'app', name: 'Bot A' }));
    await expect(tools.replyAgent(token, { content: 'res', turn })).rejects.toMatchObject({
      code: 'REPLY_AGENT_TARGET_SELF_FORBIDDEN',
      statusCode: 400
    });
    expect(client.replyText).not.toHaveBeenCalled();

    // 3. origin message sender is unknown bot not in peers
    client.getMessage = vi.fn(async () => makeMessage('om_orig', 'unknown bot msg', { id: 'ou_unknown', type: 'app', name: 'Unknown' }));
    await expect(tools.replyAgent(token, { content: 'res', turn })).rejects.toMatchObject({
      code: 'REPLY_AGENT_SENDER_NOT_IN_PEERS',
      statusCode: 400
    });
    expect(client.replyText).not.toHaveBeenCalled();

    // 4. 同一 sender 解析出多个不同 peer 时报歧义，不盲目选第一项，且零发送
    client.listChatMembers = vi.fn(async () => ({
      items: [
        { memberId: 'ou_amb_1', appId: 'cli_amb_1', name: 'Duplicate Bot', memberType: 'bot' as const, openId: 'ou_shared_id' },
        { memberId: 'ou_amb_2', appId: 'cli_amb_2', name: 'Duplicate Bot 2', memberType: 'bot' as const, openId: 'ou_shared_id' }
      ],
      hasMore: false,
      securityLimited: false
    }));
    client.getMessage = vi.fn(async () => makeMessage('om_orig', 'ambiguous sender', { id: 'ou_shared_id', type: 'app', name: 'Amb' }));
    await expect(tools.replyAgent(token, { content: 'res', turn })).rejects.toMatchObject({
      code: 'GROUP_TARGET_AMBIGUOUS',
      statusCode: 409
    });
    expect(client.replyText).not.toHaveBeenCalled();
  });

  it('rejects without sending when getBotInfo fails, instead of guessing identity', async () => {
    const repos = createRepositories(':memory:');
    repositories.push(repos);
    const session = makeSession();
    await repos.sessions.save(session);
    await repos.config.set(larkBotsConfigKey, JSON.stringify([
      { appId: 'cli_a', appSecret: 'sec', name: 'Bot A', defaultAgentId: 'codex', groupToolsEnabled: true, groupToolsAllowSend: true },
      { appId: 'cli_b', appSecret: 'sec', name: 'Bot B', defaultAgentId: 'claude', groupToolsEnabled: true, groupToolsAllowSend: true }
    ]));
    const capabilities = new LarkAgentToolCapabilityRegistry(repos.sessions, 'http://127.0.0.1:4310');
    const token = capabilities.environmentFor(session).dutydeck_group_tools_token!;
    const client = fakeClient({ appName: 'Bot A', openId: 'ou_a' });
    client.getBotInfo = vi.fn(async () => {
      throw new LarkServiceError('LARK_API_ERROR', '飞书凭证无效', 401, { upstreamCode: 99991663 });
    });
    // origin 必须是真实 bot sender（app_id 形态）的非结果消息，handoff/replyAgent 才能走到 getBotInfo 身份查询
    client.getMessage = vi.fn(async () => makeMessage('om_orig', '[Agent 交接] 请协助', {
      id: 'cli_b', type: 'app', name: 'Bot B', idType: 'app_id'
    }));

    const tools = new LarkAgentToolsService(capabilities, repos.config, {
      workbenchTask: () => ({ taskId: 't1', attemptId: 'a1' }),
      finalTaskContext: async () => ({
        taskName: 'Task',
        scope: {
          app_id: 'cli_a', session_id: 'ses_a', runtime_task_id: 't1', attempt_id: 'a1',
          origin_message_id: 'om_orig', turn: 1, chat_id: 'oc_group', chat_type: 'group',
          reply_message_id: 'om_orig', reply_in_thread: true
        }
      }),
      clientFactory: () => client
    });

    const turn = capabilities.finalTurnToken('ses_a', 't1', 'a1');
    const identityFailure = { code: 'LARK_API_ERROR', statusCode: 401 };

    // handoff 走到 identityFor(getBotInfo) 失败：抛出具体身份查询错误，零发送
    await expect(tools.handoff(token, { to: 'cli_b', content: 'task', turn })).rejects.toMatchObject(identityFailure);
    expect(client.getBotInfo).toHaveBeenCalled();
    expect(client.replyText).not.toHaveBeenCalled();

    // replyAgent 的 origin 是 bot sender，同样走到 identityFor(getBotInfo) 失败而非提前被 ORIGIN_NOT_BOT 拦截
    await expect(tools.replyAgent(token, { content: 'task', turn })).rejects.toMatchObject(identityFailure);
    expect(client.replyText).not.toHaveBeenCalled();
  });

  it('rejects reply-agent when origin message already has [Agent 结果] prefix (anti-loop confirmation)', async () => {
    const repos = createRepositories(':memory:');
    repositories.push(repos);
    const session = makeSession();
    await repos.sessions.save(session);
    await repos.config.set(larkBotsConfigKey, JSON.stringify([
      { appId: 'cli_a', appSecret: 'sec', name: 'Bot A', defaultAgentId: 'codex', groupToolsEnabled: true, groupToolsAllowSend: true },
      { appId: 'cli_b', appSecret: 'sec', name: 'Bot B', defaultAgentId: 'claude', groupToolsEnabled: true, groupToolsAllowSend: true }
    ]));
    const capabilities = new LarkAgentToolCapabilityRegistry(repos.sessions, 'http://127.0.0.1:4310');
    const token = capabilities.environmentFor(session).dutydeck_group_tools_token!;
    const client = fakeClient({ appName: 'Bot A', openId: 'ou_a' });
    const turn = capabilities.finalTurnToken('ses_a', 't1', 'a1');

    const tools = new LarkAgentToolsService(capabilities, repos.config, {
      workbenchTask: () => ({ taskId: 't1', attemptId: 'a1' }),
      finalTaskContext: async () => ({
        taskName: 'Task',
        scope: {
          app_id: 'cli_a', session_id: 'ses_a', runtime_task_id: 't1', attempt_id: 'a1',
          origin_message_id: 'om_orig', turn: 1, chat_id: 'oc_group', chat_type: 'group',
          reply_message_id: 'om_orig', reply_in_thread: true
        }
      }),
      clientFactory: () => client
    });

    // Message text starts with [Agent 结果] after mention
    const msgText = '<at user_id="ou_a">Bot A</at> [Agent 结果]\n任务交付结果已完成';
    client.getMessage = vi.fn(async () => makeMessage('om_orig', msgText, { id: 'ou_b', type: 'app', name: 'Bot B' }));

    await expect(tools.replyAgent(token, { content: 'res', turn })).rejects.toMatchObject({
      code: 'AGENT_REPLY_ALREADY_COMPLETED',
      statusCode: 400
    });
    expect(client.replyText).not.toHaveBeenCalled();
  });

  it('rejects cross-chat, cross-thread, expired turn, missing active task, and missing mapping', async () => {
    const repos = createRepositories(':memory:');
    repositories.push(repos);
    const session = makeSession();
    await repos.sessions.save(session);
    await repos.config.set(larkBotsConfigKey, JSON.stringify([
      { appId: 'cli_a', appSecret: 'sec', name: 'Bot A', defaultAgentId: 'codex', groupToolsEnabled: true, groupToolsAllowSend: true },
      { appId: 'cli_b', appSecret: 'sec', name: 'Bot B', defaultAgentId: 'claude', groupToolsEnabled: true, groupToolsAllowSend: true }
    ]));
    const capabilities = new LarkAgentToolCapabilityRegistry(repos.sessions, 'http://127.0.0.1:4310');
    const token = capabilities.environmentFor(session).dutydeck_group_tools_token!;
    const client = fakeClient({ appName: 'Bot A', openId: 'ou_a' });

    let activeTask: { taskId: string; attemptId: string } | undefined = { taskId: 't1', attemptId: 'a1' };
    let mappingContext: ExplicitFinalContext | undefined = {
      taskName: 'Task',
      scope: {
        app_id: 'cli_a', session_id: 'ses_a', runtime_task_id: 't1', attempt_id: 'a1',
        origin_message_id: 'om_orig', turn: 1, chat_id: 'oc_group', chat_type: 'group',
        reply_message_id: 'om_orig', reply_in_thread: true
      }
    };

    const tools = new LarkAgentToolsService(capabilities, repos.config, {
      workbenchTask: () => activeTask,
      finalTaskContext: async () => mappingContext,
      clientFactory: () => client
    });

    // 1. Expired / wrong turn
    await expect(tools.handoff(token, { to: 'Bot B', content: 'task', turn: 'wrong_token' })).rejects.toMatchObject({
      code: 'FINAL_TURN_EXPIRED',
      statusCode: 403
    });

    const validTurn = capabilities.finalTurnToken('ses_a', 't1', 'a1');

    // 2. Missing active task
    activeTask = undefined;
    await expect(tools.handoff(token, { to: 'Bot B', content: 'task', turn: validTurn })).rejects.toMatchObject({
      code: 'FINAL_NO_ACTIVE_TASK',
      statusCode: 409
    });
    activeTask = { taskId: 't1', attemptId: 'a1' };

    // 3. Missing mapping
    mappingContext = undefined;
    await expect(tools.handoff(token, { to: 'Bot B', content: 'task', turn: validTurn })).rejects.toMatchObject({
      code: 'FINAL_MAPPING_UNAVAILABLE',
      statusCode: 409
    });

    // 4. Cross chat message
    mappingContext = {
      taskName: 'Task',
      scope: {
        app_id: 'cli_a', session_id: 'ses_a', runtime_task_id: 't1', attempt_id: 'a1',
        origin_message_id: 'om_other_chat', turn: 1, chat_id: 'oc_group', chat_type: 'group',
        reply_message_id: 'om_other_chat', reply_in_thread: true
      }
    };
    client.getMessage = vi.fn(async () => makeMessage('om_other_chat', 'other chat', { id: 'ou_b', type: 'app', name: 'Bot B' }, 'oc_different_chat'));
    await expect(tools.handoff(token, { to: 'Bot B', content: 'task', turn: validTurn })).rejects.toMatchObject({
      code: 'GROUP_REPLY_OUT_OF_SCOPE',
      statusCode: 403
    });

    // 5. p2p chat type rejection
    const p2pSession = makeSession({ id: 'ses_p2p', sourceId: 'cli_a:ou_user:p2p' });
    await repos.sessions.save(p2pSession);
    const p2pToken = capabilities.environmentFor(p2pSession).dutydeck_group_tools_token!;
    await expect(tools.handoff(p2pToken, { to: 'Bot B', content: 'task', turn: validTurn })).rejects.toMatchObject({
      code: 'GROUP_TOOL_CHAT_TYPE_INVALID',
      statusCode: 400
    });
  });

  it('guarantees zero transmission if task cancelled, attempt switched, or permission revoked during the final finalTaskContext await (both handoff & replyAgent)', async () => {
    const repos = createRepositories(':memory:');
    repositories.push(repos);
    const session = makeSession();
    await repos.sessions.save(session);
    await repos.config.set(larkBotsConfigKey, JSON.stringify([
      { appId: 'cli_a', appSecret: 'sec', name: 'Bot A', defaultAgentId: 'codex', groupToolsEnabled: true, groupToolsAllowSend: true },
      { appId: 'cli_b', appSecret: 'sec', name: 'Bot B', defaultAgentId: 'claude', groupToolsEnabled: true, groupToolsAllowSend: true }
    ]));
    const capabilities = new LarkAgentToolCapabilityRegistry(repos.sessions, 'http://127.0.0.1:4310');
    const token = capabilities.environmentFor(session).dutydeck_group_tools_token!;

    let activeTask: { taskId: string; attemptId: string } | undefined = { taskId: 't1', attemptId: 'a1' };
    const client = fakeClient({ appName: 'Bot A', openId: 'ou_a' });
    client.getMessage = vi.fn(async () => makeMessage('om_orig', 'orig', { id: 'cli_b', type: 'app', name: 'Bot B' }));

    let finalContextCheckCount = 0;
    const tools = new LarkAgentToolsService(capabilities, repos.config, {
      workbenchTask: () => activeTask,
      finalTaskContext: async () => {
        finalContextCheckCount++;
        // 在第二次（即发送前最后一次）检查 finalTaskContext 时模拟状态突变
        if (finalContextCheckCount >= 2) {
          activeTask = undefined; // 任务被取消/置空
        }
        return {
          taskName: 'Task',
          scope: {
            app_id: 'cli_a', session_id: 'ses_a', runtime_task_id: 't1', attempt_id: 'a1',
            origin_message_id: 'om_orig', turn: 1, chat_id: 'oc_group', chat_type: 'group',
            reply_message_id: 'om_orig', reply_in_thread: true
          }
        };
      },
      clientFactory: () => client
    });

    const turn = capabilities.finalTurnToken('ses_a', 't1', 'a1');

    // 1. handoff: 在最后映射 await 期间任务被取消，零发送
    await expect(tools.handoff(token, { to: 'Bot B', content: 'test', turn })).rejects.toMatchObject({
      code: 'FINAL_TURN_EXPIRED',
      statusCode: 403
    });
    expect(client.replyText).not.toHaveBeenCalled();

    // 2. replyAgent: 在最后映射 await 期间换 attempt，零发送
    finalContextCheckCount = 0;
    activeTask = { taskId: 't1', attemptId: 'a1' };
    const toolsReply = new LarkAgentToolsService(capabilities, repos.config, {
      workbenchTask: () => activeTask,
      finalTaskContext: async () => {
        finalContextCheckCount++;
        if (finalContextCheckCount >= 2) {
          activeTask = { taskId: 't1', attemptId: 'a2' }; // 换轮次
        }
        return {
          taskName: 'Task',
          scope: {
            app_id: 'cli_a', session_id: 'ses_a', runtime_task_id: 't1', attempt_id: 'a1',
            origin_message_id: 'om_orig', turn: 1, chat_id: 'oc_group', chat_type: 'group',
            reply_message_id: 'om_orig', reply_in_thread: true
          }
        };
      },
      clientFactory: () => client
    });

    await expect(toolsReply.replyAgent(token, { content: 'test', turn })).rejects.toMatchObject({
      code: 'FINAL_TURN_EXPIRED',
      statusCode: 403
    });
    expect(client.replyText).not.toHaveBeenCalled();

    // 3. replyAgent: 在最后映射 await 期间撤销发送权限，零发送
    finalContextCheckCount = 0;
    activeTask = { taskId: 't1', attemptId: 'a1' };
    const toolsRevoke = new LarkAgentToolsService(capabilities, repos.config, {
      workbenchTask: () => activeTask,
      finalTaskContext: async () => {
        finalContextCheckCount++;
        if (finalContextCheckCount >= 2) {
          await repos.config.set(larkBotsConfigKey, JSON.stringify([
            { appId: 'cli_a', appSecret: 'sec', name: 'Bot A', defaultAgentId: 'codex', groupToolsEnabled: true, groupToolsAllowSend: false },
            { appId: 'cli_b', appSecret: 'sec', name: 'Bot B', defaultAgentId: 'claude', groupToolsEnabled: true, groupToolsAllowSend: true }
          ]));
        }
        return {
          taskName: 'Task',
          scope: {
            app_id: 'cli_a', session_id: 'ses_a', runtime_task_id: 't1', attempt_id: 'a1',
            origin_message_id: 'om_orig', turn: 1, chat_id: 'oc_group', chat_type: 'group',
            reply_message_id: 'om_orig', reply_in_thread: true
          }
        };
      },
      clientFactory: () => client
    });

    await expect(toolsRevoke.replyAgent(token, { content: 'test', turn })).rejects.toMatchObject({
      code: 'GROUP_TOOL_SEND_DISABLED',
      statusCode: 403
    });
    expect(client.replyText).not.toHaveBeenCalled();
  });

  it('injects turn-bound handoff/reply-agent in promptForSession even before mapping is saved, while runtime rejects until ready', async () => {
    const repos = createRepositories(':memory:');
    repositories.push(repos);
    const session = makeSession();
    await repos.sessions.save(session);
    await repos.config.set(larkBotsConfigKey, JSON.stringify([
      { appId: 'cli_a', appSecret: 'sec', name: 'Bot A', defaultAgentId: 'codex', groupToolsEnabled: true, groupToolsAllowSend: true }
    ]));
    const capabilities = new LarkAgentToolCapabilityRegistry(repos.sessions, 'http://127.0.0.1:4310');

    let activeTask: { taskId: string; attemptId?: string } | undefined = { taskId: 't1', attemptId: 'a1' };
    // 模拟首轮刚启动时，Coordinator 尚未完成 saveCardTask，finalTaskContext 返回 undefined
    let finalContext: ExplicitFinalContext | undefined = undefined;

    const tools = new LarkAgentToolsService(capabilities, repos.config, {
      workbenchTask: () => activeTask,
      finalTaskContext: async () => finalContext
    });

    // 1. 虽然 mapping 尚未落盘（返回 undefined），只要配置了 finalTaskContext provider + group + send + active attempt，Prompt 仍注入正确的本轮 token 命令
    const prompt = await tools.promptForSession(session, 'base prompt');
    const expectedTurn = capabilities.finalTurnToken('ses_a', 't1', 'a1');
    expect(prompt).toContain(`group handoff <目标bot名称/appId/openId> '<交接内容>' --turn ${expectedTurn}`);
    expect(prompt).toContain(`group reply-agent '<交付结果>' --turn ${expectedTurn}`);

    // 2. 此时若模型立即调用 handoff 工具，运行时由于 mapping 尚未就绪明确返回 FINAL_MAPPING_UNAVAILABLE
    const token = capabilities.environmentFor(session).dutydeck_group_tools_token!;
    await expect(tools.handoff(token, { to: 'Bot B', content: 'test', turn: expectedTurn })).rejects.toMatchObject({
      code: 'FINAL_MAPPING_UNAVAILABLE',
      statusCode: 409
    });

    // 3. 只有未配置 finalTaskContext provider 时才不注入带 token 命令
    const toolsWithoutProvider = new LarkAgentToolsService(capabilities, repos.config, {
      workbenchTask: () => activeTask
    });
    const promptWithoutProvider = await toolsWithoutProvider.promptForSession(session, 'base prompt');
    expect(promptWithoutProvider).not.toContain(`group handoff`);
    expect(promptWithoutProvider).not.toContain(`group reply-agent`);

    // 4. p2p session -> Not injected
    const p2pSession = makeSession({ id: 'ses_p2p', sourceId: 'cli_a:ou_user:p2p' });
    const p2pPrompt = await tools.promptForSession(p2pSession, 'base prompt');
    expect(p2pPrompt).not.toContain('group handoff');
    expect(p2pPrompt).not.toContain('group reply-agent');

    // 5. send disabled -> Not injected
    await repos.config.set(larkBotsConfigKey, JSON.stringify([
      { appId: 'cli_a', appSecret: 'sec', name: 'Bot A', defaultAgentId: 'codex', groupToolsEnabled: true, groupToolsAllowSend: false }
    ]));
    const noSendPrompt = await tools.promptForSession(session, 'base prompt');
    expect(noSendPrompt).not.toContain('group handoff');
  });

  it('correctly parses CLI arguments and options for handoff and reply-agent', async () => {
    const handlers = {
      groupHandoff: vi.fn(),
      groupReplyAgent: vi.fn()
    };
    const program = createCliProgram('0.1.0', handlers as any);

    await program.parseAsync(['node', 'dutydeck', 'group', 'handoff', 'cli_peer', 'task content', '--turn', 'turn_token_123']);
    expect(handlers.groupHandoff).toHaveBeenCalledWith('cli_peer', 'task content', { turn: 'turn_token_123' });

    await program.parseAsync(['node', 'dutydeck', 'group', 'reply-agent', 'result content', '--turn', 'turn_token_456']);
    expect(handlers.groupReplyAgent).toHaveBeenCalledWith('result content', { turn: 'turn_token_456' });
  });

  it('strips leading mentions correctly for [Agent 结果] check', () => {
    expect(stripLeadingMentions('<at user_id="ou_1">Bot</at> [Agent 结果] done')).toBe('[Agent 结果] done');
    expect(stripLeadingMentions('<at user_id="ou_1">Bot</at> <at user_id="ou_2">Other</at>  [Agent 结果] done')).toBe('[Agent 结果] done');
    expect(stripLeadingMentions('@Bot [Agent 结果] done')).toBe('[Agent 结果] done');
    expect(stripLeadingMentions('  [Agent 结果] done')).toBe('[Agent 结果] done');
    expect(stripLeadingMentions('普通消息 [Agent 结果]')).toBe('普通消息 [Agent 结果]');
  });

  it('allows handoff and reply-agent when two bots share the same name but have different IDs', async () => {
    const repos = createRepositories(':memory:');
    repositories.push(repos);
    const session = makeSession();
    await repos.sessions.save(session);
    await repos.config.set(larkBotsConfigKey, JSON.stringify([
      { appId: 'cli_a', appSecret: 'sec', name: 'Codex', defaultAgentId: 'codex', groupToolsEnabled: true, groupToolsAllowSend: true },
      { appId: 'cli_b', appSecret: 'sec', name: 'Codex', defaultAgentId: 'claude', groupToolsEnabled: true, groupToolsAllowSend: true }
    ]));
    const capabilities = new LarkAgentToolCapabilityRegistry(repos.sessions, 'http://127.0.0.1:4310');
    const token = capabilities.environmentFor(session).dutydeck_group_tools_token!;
    const client = fakeClient({ appName: 'Codex', openId: 'ou_a' });
    client.listChatMembers = vi.fn(async () => ({
      items: [
        { memberId: 'ou_a', appId: 'cli_a', name: 'Codex', memberType: 'bot' as const, openId: 'ou_a' },
        { memberId: 'ou_b', appId: 'cli_b', name: 'Codex', memberType: 'bot' as const, openId: 'ou_b' }
      ],
      hasMore: false,
      securityLimited: false
    }));

    const tools = new LarkAgentToolsService(capabilities, repos.config, {
      workbenchTask: () => ({ taskId: 't1', attemptId: 'a1' }),
      finalTaskContext: async () => ({
        taskName: 'Task',
        scope: {
          app_id: 'cli_a', session_id: 'ses_a', runtime_task_id: 't1', attempt_id: 'a1',
          origin_message_id: 'om_orig', turn: 1, chat_id: 'oc_group', chat_type: 'group',
          reply_message_id: 'om_orig', reply_in_thread: true
        }
      }),
      clientFactory: () => client
    });

    const turn = capabilities.finalTurnToken('ses_a', 't1', 'a1');

    // 1. handoff: 虽然双方都叫 Codex，但指定 --to cli_b (或 ou_b)，成功交接给对方
    const handoffResult = await tools.handoff(token, { to: 'cli_b', content: 'handoff task', turn });
    expect(handoffResult).toMatchObject({
      target: { appId: 'cli_b', name: 'Codex', openId: 'ou_b' }
    });
    expect(client.replyText).toHaveBeenCalledTimes(1);

    // 2. replyAgent: origin 消息由对方 cli_b 发送，虽然叫同一个名字 Codex，成功回传
    client.getMessage = vi.fn(async () => makeMessage('om_orig', 'task', { id: 'cli_b', type: 'app', name: 'Codex' }));
    const replyResult = await tools.replyAgent(token, { content: 'result', turn });
    expect(replyResult).toMatchObject({
      target: { appId: 'cli_b', name: 'Codex', openId: 'ou_b' }
    });
    expect(client.replyText).toHaveBeenCalledTimes(2);

    // 3. 但向自己交接依然拒绝
    await expect(tools.handoff(token, { to: 'cli_a', content: 'task', turn })).rejects.toMatchObject({
      code: 'HANDOFF_TARGET_SELF_FORBIDDEN',
      statusCode: 400
    });
    await expect(tools.handoff(token, { to: 'ou_a', content: 'task', turn })).rejects.toMatchObject({
      code: 'HANDOFF_TARGET_SELF_FORBIDDEN',
      statusCode: 400
    });
  });
});
