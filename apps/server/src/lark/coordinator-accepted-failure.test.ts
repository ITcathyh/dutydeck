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
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const event = (id: string, text: string): LarkMessageEvent => ({
  messageId: id, chatId: 'oc_group', chatType: 'group', threadId: 'omt_topic', rootId: 'om_root',
  senderOpenId: 'ou_alice', senderType: 'user', messageType: 'text', content: JSON.stringify({ text }),
  mentions: [{ key: '@_user_1', name: 'Dock', openId: 'ou_bot' }]
});

async function harness() {
  const cwd = await mkdtemp(join(tmpdir(), 'dutydeck-accepted-failure-'));
  const repos = createRepositories(join(cwd, 'state.db'), { newDatabaseAuthority: 'ledger_v1' });
  let sends = 0;
  const runtime = new DutydeckRuntime(repos, {
    probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }),
    driverFactory: (_config, _protocol, emit) => {
      const driver: AgentDriver = {
        start: async () => {}, resume: async () => {}, stop: async () => {}, interrupt: async () => {},
        send: async () => {
          sends++;
          await new Promise(resolve => setTimeout(resolve, 300));
          emit({ type: 'text', data: { text: '完成' } });
          emit({ type: 'completed', data: { stopReason: 'end_turn' } });
        }
      };
      return driver;
    }
  });
  const broker = new RelayAskBroker({ publish: async () => {} }, createRelayAskStore(repos.config));
  await broker.initialize();
  const agent: AgentConfig = {
    id: 'mock', name: 'Mock', command: process.execPath, args: [], protocol: 'acp', cwd, env: {},
    permissionMode: 'ask', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false
  };
  await runtime.initialize([agent]);
  const config: StoredLarkConfig = {
    appId: 'cli_accepted_failure', appSecret: 'fake-secret', workspace: cwd,
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
  const cardStates: string[] = [];
  const createCard = async (input: any) => {
    cardStates.push(`${input.state}|${input.cardKind}|${input.capabilities?.canRetry === true}`);
    return { messageId: `om_card_${++nextCard}` };
  };
  const service = {
    send: vi.fn(createCard), reply: vi.fn(createCard), replyText: vi.fn(createCard),
    uploadFile: vi.fn(async () => 'file_mock'), replyFile: vi.fn(createCard), sendFile: vi.fn(createCard),
    update: vi.fn(async (input: any) => {
      cardStates.push(`${input.state}|${input.cardKind}|${input.capabilities?.canRetry === true}`);
      return { messageId: input.messageId };
    }),
    addReaction: vi.fn(async (messageId: string) => ({ messageId, reactionId: 'reaction_1' })),
    deleteReaction: vi.fn(async () => {}),
    getUserEmails: vi.fn(async () => []),
    listChatMembers: vi.fn(async () => ({ items: [], hasMore: false })),
    listChatMessages: vi.fn(async () => ({ items: [], hasMore: false })),
    getMessage: vi.fn(async () => undefined),
    getMessageItems: vi.fn(async () => []),
    downloadMessageResource: vi.fn(async () => ({ data: new Uint8Array(), contentType: 'text/plain' })),
    readDocument: vi.fn(async (url: string) => ({ url, title: '文档', text: '文档正文' }))
  };
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const coordinator = new LarkMessageCoordinator(runtime, service as any, log, Math.random, 'ou_bot', undefined,
    repos.channelMappings, async () => 'group', undefined, undefined, { store: repos.config, broker });
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
  return { runtime, coordinator, config, cardStates, sends: () => sends };
}

describe('runtime 已接收后的步骤失败', () => {
  it('读恢复信息失败不判失败、不给重试，Agent 只执行一次且结果照常送达', async () => {
    const h = await harness();
    const original = h.runtime.getTaskRecovery.bind(h.runtime);
    let calls = 0;
    h.runtime.getTaskRecovery = (async (...args: Parameters<typeof original>) => {
      if (++calls === 1) throw new Error('SQLITE_BUSY: database is locked');
      return original(...args);
    }) as typeof original;

    await h.coordinator.handle(event('om_req_1', '请帮我看一下这个问题'), h.config);
    await vi.waitFor(() => expect(h.cardStates.some(state => state.startsWith('completed|result|'))).toBe(true), { timeout: 5_000 });

    expect(calls).toBeGreaterThan(0);
    expect(h.sends()).toBe(1);
    expect(h.cardStates.filter(state => state.startsWith('failed|'))).toEqual([]);
    expect(h.cardStates.filter(state => /^(failed|interrupted|cancelled)\|.*\|true$/.test(state))).toEqual([]);
    const runtimeTasks = (await h.runtime.getTasks((h.coordinator as any).tasks.get('om_req_1').sessionId)).map(task => task.status);
    expect(runtimeTasks).toEqual(['completed']);
  });

  it('卡片状态为失败但 runtime 里这一轮已执行完时，重试被拒绝，不再执行第二次', async () => {
    const h = await harness();
    await h.coordinator.handle(event('om_req_2', '请帮我看一下这个问题'), h.config);
    await vi.waitFor(() => expect(h.cardStates.some(state => state.startsWith('completed|result|'))).toBe(true), { timeout: 5_000 });
    const task = (h.coordinator as any).tasks.get('om_req_2');
    expect(task.runtimeTaskId).toBeTruthy();
    // 模拟卡片侧误判成失败（例如旧版本已发出的失败卡）。
    task.state = 'failed';
    const result = await h.coordinator.handleAction({ action: 'retry', task_id: 'om_req_2', turn: String(task.turn) }, 'ou_alice');
    expect(result).toMatchObject({ type: 'warning' });
    await new Promise(resolve => setTimeout(resolve, 600));
    expect(h.sends()).toBe(1);
  });
});
