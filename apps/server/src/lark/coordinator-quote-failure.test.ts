import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRepositories } from '@dutydeck/storage';
import { DutydeckRuntime, type AgentDriver } from '@dutydeck/runtime';
import { RelayAskBroker } from '@dutydeck/relay';
import type { AgentConfig } from '@dutydeck/shared';
import { createRelayAskStore } from '../relay-ask-store.js';
import { LarkMessageCoordinator } from './coordinator.js';
import { larkBotsConfigKey, type StoredLarkConfig } from './config.js';
import type { LarkMessageEvent } from './listener.js';

vi.mock('./open-platform-session.js', () => ({ connectLarkOpenPlatformSession: vi.fn() }));

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const event = (id: string, text: string, patch: Partial<LarkMessageEvent> = {}): LarkMessageEvent => ({
  messageId: id, chatId: 'oc_group', chatType: 'group', threadId: 'omt_topic', rootId: 'om_root',
  senderOpenId: 'ou_alice', senderType: 'user', messageType: 'text', content: JSON.stringify({ text }),
  mentions: [{ key: '@_user_1', name: 'Dock', openId: 'ou_bot' }], ...patch
});

describe('coordinator quote failure card notes', () => {
  it('includes quoteFailureNote in initial card markdown and reports read failure in agentPrompt when getMessage throws', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dutydeck-quote-note-'));
    const repos = createRepositories(join(cwd, 'state.db'), { newDatabaseAuthority: 'ledger_v1' });

    let receivedAgentPrompt = '';
    const runtime = new DutydeckRuntime(repos, {
      probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }),
      driverFactory: (_config, _protocol, emit) => {
        const driver: AgentDriver = {
          start: async () => {},
          resume: async () => {},
          stop: async () => {},
          interrupt: async () => {},
          send: async (prompt: any) => {
            receivedAgentPrompt = typeof prompt === 'string' ? prompt : prompt.prompt;
            emit({ type: 'text', data: { text: '完成' } });
            emit({ type: 'completed', data: { stopReason: 'end_turn' } });
          }
        };
        return driver;
      }
    });

    const broker = new RelayAskBroker(
      { publish: async () => {} },
      createRelayAskStore(repos.config)
    );
    await broker.initialize();

    const agent: AgentConfig = {
      id: 'mock', name: 'Mock', command: process.execPath, args: [],
      protocol: 'acp', cwd, env: {}, permissionMode: 'ask', timeout: 10,
      capabilities: { pause: false, resume: true }, builtin: false
    };
    await runtime.initialize([agent]);

    const config: StoredLarkConfig = {
      appId: 'cli_quote_test', appSecret: 'fake-secret', workspace: cwd,
      defaultAgentId: 'mock', permissionMode: 'full-trust', listening: true,
      fullTrustConfirmed: true, preInjectPrompt: '', structuredAskCards: false,
      groupCardMention: false, groupToolsEnabled: false, groupToolsAllowSend: false,
      pushIntervalMs: 1_000, hideTraceOnComplete: false, allowedUsers: [],
      allowedEmails: [], allowedBots: [], peerBotsAllowed: false,
      highRiskAllowedUsers: [{ openId: 'ou_alice', name: 'Alice' }],
      highRiskAllowedEmails: [], highRiskPattern: 'dangerous', riskControlMode: 'off'
    };
    await repos.config.set(larkBotsConfigKey, JSON.stringify([config]));

    let nextCard = 0;
    const cards = new Map<string, any>();
    const createCard = async (input: any) => {
      const id = `om_card_${++nextCard}`;
      cards.set(id, input);
      return { messageId: id };
    };

    const service = {
      send: vi.fn(createCard),
      reply: vi.fn(createCard),
      uploadFile: vi.fn(async () => 'file_mock'),
      replyFile: vi.fn(createCard),
      sendFile: vi.fn(createCard),
      update: vi.fn(async (input: any) => {
        cards.set(input.messageId, input);
        return { messageId: input.messageId };
      }),
      addReaction: vi.fn(async (messageId: string) => ({ messageId, reactionId: 'reaction_1' })),
      deleteReaction: vi.fn(async () => {}),
      getUserEmails: vi.fn(async () => []),
      listChatMembers: vi.fn(async () => ({ items: [], hasMore: false })),
      listChatMessages: vi.fn(async () => ({ items: [], hasMore: false })),
      getMessage: vi.fn(async () => {
        throw new Error('消息读取超时');
      }),
      getMessageItems: vi.fn(async () => []),
      downloadMessageResource: vi.fn(async () => ({ data: new Uint8Array(), contentType: 'text/plain' })),
      readDocument: vi.fn(async (url: string) => ({ url, title: '文档', text: '文档正文' }))
    };

    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const coordinator = new LarkMessageCoordinator(
      runtime,
      service as any,
      log,
      Math.random,
      'ou_bot',
      undefined,
      repos.channelMappings,
      async () => 'group',
      undefined,
      undefined,
      { store: repos.config, broker }
    );
    await coordinator.initializeWorkflows(config);
    await coordinator.startReconciliation(config);

    cleanups.push(async () => {
      coordinator.stop();
      broker.close();
      await broker.flush();
      await runtime.shutdown();
      repos.close();
      await rm(cwd, { recursive: true, force: true });
    });

    const taskEvent = event('om_req_1', '请帮我看一下这个问题', { parentId: 'om_quote_target' });
    await coordinator.handle(taskEvent, config);

    // 等待第一张卡发出
    await vi.waitFor(() => expect(service.reply).toHaveBeenCalled());

    const firstReplyCall = service.reply.mock.calls[0][0];
    // 首卡 markdown 应包含 quoteFailureNote
    expect(firstReplyCall.markdown).toContain('引用的消息没有读到（读取超时），Agent 回答时看不到它。');
    // Agent 收到的 prompt 中应包含读取失败的材料说明
    await vi.waitFor(() => expect(receivedAgentPrompt).toContain('读取失败，正文未注入：消息读取超时'));
  });
});
