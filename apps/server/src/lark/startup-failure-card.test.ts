import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepositories } from '@dutydeck/storage';
import { RuntimeError, type Session } from '@dutydeck/shared';
import { LarkMessageCoordinator } from './coordinator.js';
import { larkBotsConfigKey, type StoredLarkConfig } from './config.js';
import { buildLarkCard } from './service.js';
import type { LarkMessageEvent } from './listener.js';

const components = (value: any): any[] => {
  if (Array.isArray(value)) return value.flatMap(components);
  if (!value || typeof value !== 'object') return [];
  return [...(typeof value.tag === 'string' ? [value] : []), ...Object.values(value).flatMap(components)];
};

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

function cardService() {
  let card = 0;
  const create = async () => ({ messageId: `om_card_${++card}` });
  return {
    addReaction: vi.fn(async () => ({ reactionId: 'reaction-1' })),
    deleteReaction: vi.fn(async () => {}),
    send: vi.fn(create),
    reply: vi.fn(create),
    update: vi.fn(async (input: any) => ({ messageId: input.messageId })),
    getUserEmails: vi.fn(async () => []),
    listChatMembers: vi.fn(async () => ({ items: [{ memberId: 'ou_alice' }], hasMore: false })),
    listChatMessages: vi.fn(async () => ({ items: [], hasMore: false })),
    getMessage: vi.fn(async (id: string) => ({
      messageId: id, chatId: 'ou_alice', messageType: 'text', rawContent: JSON.stringify({ text: 'quoted' }),
      sender: { type: 'user' }, mentions: []
    })),
    getMessageItems: vi.fn(async () => [])
  };
}

const silentLog = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

const groupMessage = (id: string, text: string): LarkMessageEvent => ({
  messageId: id,
  chatId: 'oc_test_group',
  chatType: 'group',
  threadId: 'omt_topic',
  rootId: 'om_root',
  senderOpenId: 'ou_alice',
  senderType: 'user',
  messageType: 'text',
  content: JSON.stringify({ text }),
  mentions: [{ key: '@_user_1', name: 'Bot', openId: 'ou_bot' }]
});

async function harness(options: {
  startError?: Error;
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dutydeck-startup-failure-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));

  const config: StoredLarkConfig = {
    appId: 'cli_test',
    appSecret: 'secret_test',
    name: 'TestBot',
    defaultAgentId: 'codex',
    workspace: directory,
    fullTrustConfirmed: true,
    riskControlMode: 'off'
  };

  const repos = createRepositories(join(directory, 'state.db'));
  cleanups.push(() => repos.close());
  await repos.config.set(larkBotsConfigKey, JSON.stringify([config]));

  const sessions: Session[] = [];
  const runtime = {
    start: vi.fn(async () => {
      if (options.startError) throw options.startError;
      const session: Session = {
        id: 'ses_1',
        agentId: 'codex',
        state: 'idle',
        cwd: directory,
        permissionMode: 'full-trust',
        protocol: 'pty-cli',
        source: 'lark',
        sourceId: 'cli_test:oc_test_group:thread:om_root',
        runId: 'run_1',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      sessions.push(session);
      return session;
    }),
    listAgents: vi.fn(async () => [{ id: 'codex', name: 'Codex' }]),
    listSessions: vi.fn(async () => sessions),
    getSession: vi.fn(async (id: string) => sessions.find(s => s.id === id)),
    stop: vi.fn(async () => {}),
    send: vi.fn(async () => {}),
    interrupt: vi.fn(async () => {}),
    cancelQueued: vi.fn(async () => {}),
    getTasks: vi.fn(async () => []),
    subscribe: vi.fn(() => vi.fn())
  };

  const service = cardService();
  const coordinator = new LarkMessageCoordinator(
    runtime as any,
    service as any,
    silentLog(),
    Math.random,
    'ou_bot'
  );

  return { config, runtime, service, coordinator };
}

describe('F1-5: 启动失败卡展示与重试按钮', () => {
  it('失败卡的重试按钮 value 里 turn 是当前轮次', async () => {
    const error = new Error('daemon timeout connecting to agent process');
    const h = await harness({ startError: error });

    await h.coordinator.handle(groupMessage('om_msg_1', '启动任务'), h.config);
    await vi.waitFor(() => expect(h.service.reply).toHaveBeenCalledOnce());

    const replyInput = h.service.reply.mock.calls[0]![0];
    expect(replyInput.state).toBe('failed');
    expect(replyInput.turn).toBe(1);

    const card = buildLarkCard(replyInput);
    const retryButton = components(card).find(el => el.tag === 'button' && el.element_id === 'retry');
    expect(retryButton).toBeDefined();

    const callbackBehavior = retryButton.behaviors.find((b: any) => b.type === 'callback');
    expect(callbackBehavior).toBeDefined();
    expect(callbackBehavior.value).toMatchObject({
      action: 'retry',
      turn: '1'
    });
  });

  it('重试后再失败时，失败卡的重试按钮 value 里 turn 递增为当前轮次', async () => {
    const error = new Error('daemon timeout');
    const h = await harness({ startError: error });

    await h.coordinator.handle(groupMessage('om_msg_retry', '启动任务'), h.config);
    await vi.waitFor(() => expect(h.service.reply).toHaveBeenCalledOnce());

    const replyInput1 = h.service.reply.mock.calls[0]![0];
    expect(replyInput1.turn).toBe(1);

    // 触发重试按钮点击
    await h.coordinator.handleAction(
      { action: 'retry', task_id: replyInput1.taskId, turn: '1' },
      'ou_alice',
      { messageId: 'om_card_1', chatId: 'oc_test_group' }
    );

    await vi.waitFor(() => expect(h.service.reply).toHaveBeenCalledTimes(2));
    const replyInput2 = h.service.reply.mock.calls[1]![0];
    expect(replyInput2.state).toBe('failed');
    expect(replyInput2.turn).toBe(2);

    const card = buildLarkCard(replyInput2);
    const retryButton = components(card).find(el => el.tag === 'button' && el.element_id === 'retry');
    expect(retryButton).toBeDefined();

    const callbackBehavior = retryButton.behaviors.find((b: any) => b.type === 'callback');
    expect(callbackBehavior.value).toMatchObject({
      action: 'retry',
      turn: '2'
    });
  });

  it('AGENT_NOT_FOUND 显示中文原因，不包含重试按钮', async () => {
    const error = new RuntimeError('AGENT_NOT_FOUND', 'Unknown agent: nonexistent_agent', 404);
    const h = await harness({ startError: error });

    await h.coordinator.handle(groupMessage('om_msg_2', '启动任务'), h.config);
    await vi.waitFor(() => expect(h.service.reply).toHaveBeenCalledOnce());

    const replyInput = h.service.reply.mock.calls[0]![0];
    expect(replyInput.state).toBe('failed');
    expect(replyInput.retryable).toBe(false);
    expect(replyInput.markdown).toContain('配置的 Agent 不存在');
    expect(replyInput.markdown).toContain('请联系部署者在 Web 上修改配置');
    // 不 @ 任何人
    expect(replyInput.markdown).not.toContain('<at');

    const card = buildLarkCard(replyInput);
    const retryButton = components(card).find(el => el.tag === 'button' && el.element_id === 'retry');
    expect(retryButton).toBeUndefined();
  });

  it('WORKSPACE_NOT_FOUND / WORKSPACE_UNAVAILABLE / DRIVER_CONFIGURATION_UNKNOWN 也显示中文原因且不含重试按钮', async () => {
    for (const [code, expectedReason] of [
      ['WORKSPACE_NOT_FOUND', '工作目录不可用'],
      ['WORKSPACE_UNAVAILABLE', '工作目录不可用'],
      ['DRIVER_CONFIGURATION_UNKNOWN', 'Agent 启动配置无法识别']
    ] as const) {
      const error = new RuntimeError(code, `Failure code ${code}`, 409);
      const h = await harness({ startError: error });

      await h.coordinator.handle(groupMessage(`om_${code}`, '启动任务'), h.config);
      await vi.waitFor(() => expect(h.service.reply).toHaveBeenCalledOnce());

      const replyInput = h.service.reply.mock.calls[0]![0];
      expect(replyInput.state).toBe('failed');
      expect(replyInput.retryable).toBe(false);
      expect(replyInput.markdown).toContain(expectedReason);
      expect(replyInput.markdown).toContain('请联系部署者在 Web 上修改配置');

      const card = buildLarkCard(replyInput);
      const retryButton = components(card).find(el => el.tag === 'button' && el.element_id === 'retry');
      expect(retryButton).toBeUndefined();
    }
  });

  it('未知错误的原文经过脱敏、包含错误详情并保留重试按钮', async () => {
    const error = new Error('failed connecting: Authorization: Bearer secret_super_sensitive_token_12345 --api-key secret_api_key_xyz');
    const h = await harness({ startError: error });

    await h.coordinator.handle(groupMessage('om_msg_sensitive', '启动任务'), h.config);
    await vi.waitFor(() => expect(h.service.reply).toHaveBeenCalledOnce());

    const replyInput = h.service.reply.mock.calls[0]![0];
    expect(replyInput.state).toBe('failed');
    expect(replyInput.retryable).not.toBe(false);
    expect(replyInput.markdown).toContain('Agent 启动失败');
    expect(replyInput.markdown).toContain('错误详情：');
    // 原文敏感信息必须被脱敏
    expect(replyInput.markdown).not.toContain('secret_super_sensitive_token_12345');
    expect(replyInput.markdown).not.toContain('secret_api_key_xyz');
    expect(replyInput.markdown).toContain('[REDACTED]');

    const card = buildLarkCard(replyInput);
    const retryButton = components(card).find(el => el.tag === 'button' && el.element_id === 'retry');
    expect(retryButton).toBeDefined();
    const callbackBehavior = retryButton.behaviors.find((b: any) => b.type === 'callback');
    expect(callbackBehavior.value).toMatchObject({
      action: 'retry',
      turn: '1'
    });
  });
});
