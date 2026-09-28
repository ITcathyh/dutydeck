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
import { LarkGroupManager } from './group-management.js';
import { larkBotsConfigKey, type StoredLarkConfig } from './config.js';
import type { LarkMessageEvent } from './listener.js';
import { buildRepairConfirmCard } from './repair.js';
import { SessionAutomationService } from '../session-automation.js';

// mock 开放平台发布会话，避免触网
vi.mock('./open-platform-session.js', () => ({ connectLarkOpenPlatformSession: vi.fn() }));
import { connectLarkOpenPlatformSession } from './open-platform-session.js';
const connectMock = vi.mocked(connectLarkOpenPlatformSession);

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const event = (id: string, text: string, patch: Partial<LarkMessageEvent> = {}): LarkMessageEvent => ({
  messageId: id,
  chatId: 'oc_group',
  chatType: 'group',
  threadId: 'omt_topic',
  rootId: 'om_root',
  senderOpenId: 'ou_alice',
  senderType: 'user',
  messageType: 'text',
  content: JSON.stringify({ text }),
  mentions: [{ key: '@_user_1', name: 'Dock', openId: 'ou_bot' }],
  ...patch
});

const repairCallbackValue = (appId = 'cli_test_app') =>
  buildRepairConfirmCard(appId).elements.find(el => el.element_id === 'repair_confirm_run')!.behaviors[0]!.value;

async function testHarness(options: { managedGroup?: boolean; configPatch?: Partial<StoredLarkConfig> } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'dutydeck-l3-test-'));
  const repos = createRepositories(join(cwd, 'state.db'), { newDatabaseAuthority: 'ledger_v1' });
  const runtime = new DutydeckRuntime(repos, {
    probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }),
    driverFactory: () => {
      const driver: AgentDriver = {
        start: async () => {},
        resume: async () => {},
        stop: async () => {},
        interrupt: async () => {},
        send: async () => {},
        resolvePermission: async () => true
      };
      return driver;
    }
  });

  const broker = new RelayAskBroker(
    { publish: async (sessionId: string, input: any) => { await runtime.publishSessionEvent(sessionId, 'text', { text: input.text, relay: input.kind, askId: input.askId }); } },
    createRelayAskStore(repos.config)
  );
  await broker.initialize();

  const agent: AgentConfig = { id: 'mock', name: 'Mock', command: process.execPath, args: [], protocol: 'acp', cwd, env: {}, permissionMode: 'ask', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };
  await runtime.initialize([agent]);

  const config: StoredLarkConfig = {
    appId: 'cli_test_app',
    appSecret: 'fake-secret',
    workspace: cwd,
    defaultAgentId: 'mock',
    permissionMode: 'ask',
    listening: true,
    fullTrustConfirmed: true,
    preInjectPrompt: '',
    structuredAskCards: false,
    groupCardMention: false,
    groupToolsEnabled: false,
    groupToolsAllowSend: false,
    pushIntervalMs: 1_000,
    hideTraceOnComplete: false,
    allowedUsers: [],
    allowedEmails: [],
    allowedBots: [],
    peerBotsAllowed: false,
    highRiskAllowedUsers: [],
    highRiskAllowedEmails: [],
    highRiskPattern: 'dangerous',
    riskControlMode: 'off',
    ...options.configPatch
  };
  await repos.config.set(larkBotsConfigKey, JSON.stringify([config]));

  let nextCard = 0;
  const cards = new Map<string, any>();
  const createCard = async (input: any) => { const id = `om_card_${++nextCard}`; cards.set(id, input); return { messageId: id }; };
  const service = {
    send: vi.fn(createCard),
    reply: vi.fn(createCard),
    uploadFile: vi.fn(async () => `file_${Math.random()}`),
    replyFile: vi.fn(createCard),
    sendFile: vi.fn(createCard),
    update: vi.fn(async (input: any) => { cards.set(input.messageId, input); return { messageId: input.messageId }; }),
    addReaction: vi.fn(async (messageId: string, emojiType = 'OK') => ({ messageId, reactionId: `reaction_${messageId}_${emojiType}` })),
    deleteReaction: vi.fn(async () => {}),
    getUserEmails: vi.fn(async () => ['alice@example.com']),
    listChatMembers: vi.fn(async () => ({ items: [{ memberId: 'ou_alice' }, { memberId: 'ou_bob' }], hasMore: false })),
    listChatMessages: vi.fn(async () => ({ items: [] as any[], hasMore: false })),
    getMessage: vi.fn(async (id: string) => ({ messageId: id, chatId: 'oc_group', threadId: 'omt_topic', messageType: 'text', rawContent: JSON.stringify({ text: 'text' }), sender: { type: 'user' }, mentions: [] })),
    getMessageItems: vi.fn(async () => [] as any[]),
    downloadMessageResource: vi.fn(async () => ({ data: new Uint8Array([65, 66, 67]), contentType: 'text/plain' })),
    readDocument: vi.fn(async (url: string) => ({ url, title: 'doc', text: 'text' }))
  };

  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  let groupManager: LarkGroupManager | undefined;
  if (options.managedGroup) {
    groupManager = new LarkGroupManager(repos, {
      client: () => ({
        getBotInfo: async () => ({ appName: config.appId, openId: 'ou_bot' }),
        checkApplicationIdentity: async () => ({ verified: true, reportedAppId: config.appId, tenantKey: 'synthetic-tenant' }),
        listChats: async () => ({ items: [{ chatId: 'oc_group', name: 'Test Group', chatMode: 'topic' }], hasMore: false }),
        listChatMembers: async () => ({
          items: [
            { memberId: 'ou_alice', openId: 'ou_alice', name: 'Alice', memberType: 'user' },
            { memberId: 'ou_bob', openId: 'ou_bob', name: 'Bob', memberType: 'user' }
          ],
          hasMore: false,
          securityLimited: false
        }),
        getUserEmails: async () => ['alice@example.com']
      }) as any
    });
    await groupManager.sync(config.appId);
    await groupManager.save(config.appId, 'oc_group', { expectedRevision: 0, patch: {} });
  }

  const automation = new SessionAutomationService({
    repositories: repos,
    runtime,
    authorize: async () => true
  });

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
    groupManager,
    { store: repos.config, broker, automation }
  );
  await coordinator.initializeWorkflows(config);
  await coordinator.startReconciliation(config);

  const saveConfig = async (patch: Partial<StoredLarkConfig>) => {
    Object.assign(config, patch);
    await repos.config.set(larkBotsConfigKey, JSON.stringify([config]));
    await coordinator.initializeWorkflows(config);
  };

  const stopAll = async () => {
    coordinator.stop();
    automation.close();
    broker.close();
    await broker.flush();
    await runtime.shutdown();
    repos.close();
    await rm(cwd, { recursive: true, force: true });
  };
  cleanups.push(stopAll);

  return { cwd, repos, runtime, config, service, groupManager, automation, coordinator, saveConfig };
}

describe('F2-14: 没配白名单时禁止执行 /repair', () => {
  it('未配置白名单时，非托管群中 /repair 命令被拒，提示在 Web 上操作', async () => {
    const h = await testHarness({ configPatch: { allowedUsers: [], allowedEmails: [] } });
    await h.coordinator.handle(event('msg_repair_1', '/repair', { senderOpenId: 'ou_alice' }), h.config);
    const reply = h.service.reply.mock.calls.at(-1)![0] as any;
    expect(reply.taskName).toBe('/repair 未执行');
    expect(reply.markdown).toBe('未配置操作白名单时，飞书里不能执行 /repair，请在 Web 上操作。');
    expect(JSON.stringify(reply)).not.toContain('dutydeck_repair');
  });

  it('未配置白名单时，确认卡回调同样被拒，文案提示在 Web 上操作', async () => {
    const h = await testHarness({ configPatch: { allowedUsers: [], allowedEmails: [] } });
    const context = { messageId: 'om_confirm_card', chatId: 'oc_group' };
    const res = await h.coordinator.handleAction(repairCallbackValue(h.config.appId), 'ou_alice', context);
    expect(res).toMatchObject({
      type: 'warning',
      content: '未配置操作白名单时，飞书里不能执行 /repair，请在 Web 上操作。'
    });
  });

  it('配置了白名单且操作人在名单中时，允许执行 /repair 命令并展示确认卡', async () => {
    const h = await testHarness({
      configPatch: {
        allowedUsers: [{ openId: 'ou_alice', name: 'Alice' }]
      }
    });
    await h.coordinator.handle(event('msg_repair_2', '/repair', { senderOpenId: 'ou_alice' }), h.config);
    const reply = h.service.reply.mock.calls.at(-1)![0] as any;
    expect(JSON.stringify(reply)).toContain('dutydeck_repair');
  });

  it('配置了白名单但操作人不在名单中时，/repair 命令和确认卡回调均被拒，提示需要安装管理员权限', async () => {
    const h = await testHarness({
      configPatch: {
        allowedUsers: [{ openId: 'ou_carol', name: 'Carol' }]
      }
    });
    // 命令被拒
    await h.coordinator.handle(event('msg_repair_3', '/repair', { senderOpenId: 'ou_alice' }), h.config);
    const reply = h.service.reply.mock.calls.at(-1)![0] as any;
    expect(reply.taskName).toBe('/repair 未执行');
    expect(reply.markdown).toBe('当前账号不在机器人白名单中，无法执行 /repair。请联系机器人管理员把你加入白名单后重试。');

    // 确认卡回调被拒
    const context = { messageId: 'om_confirm_card', chatId: 'oc_group' };
    const res = await h.coordinator.handleAction(repairCallbackValue(h.config.appId), 'ou_alice', context);
    expect(res).toMatchObject({
      type: 'warning',
      content: '当前账号无权执行 /repair：需要安装管理员权限。'
    });
  });

  it('托管群里被授予 high_risk.execute 权限的人允许执行 /repair', async () => {
    const h = await testHarness({ managedGroup: true });
    // 普通成员 Bob 在托管群无 high_risk 权限被拒（保持原文案）
    await h.coordinator.handle(event('msg_repair_bob', '/repair', { senderOpenId: 'ou_bob' }), h.config);
    const bobReply = h.service.reply.mock.calls.at(-1)![0] as any;
    expect(bobReply.markdown).toBe('当前账号无权执行应用修复：需要安装管理员权限。');

    // 给 Alice 授予 high_risk 权限
    const bot = (await h.groupManager!.groups()).groups[0]!.bots[0]!;
    const aliceMember = (await h.groupManager!.members(h.config.appId, 'oc_group')).members
      .find(member => member.openId === 'ou_alice')!;
    await h.groupManager!.save(h.config.appId, 'oc_group', {
      expectedRevision: bot.binding!.revision,
      patch: {},
      roleChanges: [
        {
          kind: 'create',
          principalId: aliceMember.principalId,
          role: 'can_operate',
          operateScope: 'own_runs',
          actionGates: { terminalWrite: false, highRisk: true, groupToolsSend: false }
        }
      ]
    });
    await h.coordinator.handle(event('msg_repair_alice', '/repair', { senderOpenId: 'ou_alice' }), h.config);
    const aliceReply = h.service.reply.mock.calls.at(-1)![0] as any;
    expect(JSON.stringify(aliceReply)).toContain('dutydeck_repair');
  });
});

describe('F2-5: 定时结果卡「停用此计划」按钮与标题', () => {
  it('点击停用按钮成功停用计划，并返回成功反馈', async () => {
    const h = await testHarness({
      configPatch: {
        allowedUsers: [{ openId: 'ou_alice', name: 'Alice' }]
      }
    });
    // 建立一个 session 和对应的 schedule
    const session = await h.runtime.startSession({
      agentId: 'mock',
      cwd: h.cwd,
      source: 'lark',
      sourceId: `${h.config.appId}:oc_group:group`
    });
    const at = new Date().toISOString();
    const sched = await h.automation.createSchedule(
      session.id,
      {
        name: '夜间构建分析',
        prompt: 'analyze build',
        trigger: { kind: 'interval', everySeconds: 3600, anchorAt: at },
        timezone: 'Asia/Shanghai',
        dstPolicy: { gap: 'skip', overlap: 'first' },
        condition: { kind: 'always' }
      },
      'ou_alice'
    );
    await h.automation.updateSchedule(session.id, sched.id, { expectedRevision: 1, enabled: true }, 'ou_alice');

    // 绑定计划的投递位置
    await h.repos.config.set(`automation.delivery-target.${sched.id}`, JSON.stringify({
      appId: h.config.appId,
      chatId: 'oc_group',
      replyMessageId: 'om_root'
    }));

    // 此时计划已启用
    const listBefore = await h.automation.listBySession(session.id);
    expect(listBefore.schedules.find(s => s.id === sched.id)?.enabled).toBe(true);

    // 触发点击「停用此计划」按钮
    const context = { messageId: 'om_result_card', chatId: 'oc_group' };
    const res = await h.coordinator.handleAction(
      { dutydeck_schedule_disable: sched.id },
      'ou_alice',
      context
    );
    expect(res).toMatchObject({
      type: 'success',
      content: expect.stringContaining('已停用')
    });

    // 校验计划确实已被停用
    const listAfter = await h.automation.listBySession(session.id);
    expect(listAfter.schedules.find(s => s.id === sched.id)?.enabled).toBe(false);
  });

  it('跨会话伪造另一个聊天里的计划 id 时被拒，计划保持启用', async () => {
    const h = await testHarness({
      configPatch: {
        allowedUsers: [{ openId: 'ou_alice', name: 'Alice' }, { openId: 'ou_bob', name: 'Bob' }]
      }
    });
    const session = await h.runtime.startSession({
      agentId: 'mock',
      cwd: h.cwd,
      source: 'lark',
      sourceId: `${h.config.appId}:oc_bob_group:group`
    });
    const at = new Date().toISOString();
    const sched = await h.automation.createSchedule(
      session.id,
      {
        name: 'Bob 的群计划',
        prompt: 'run check',
        trigger: { kind: 'interval', everySeconds: 3600, anchorAt: at },
        timezone: 'Asia/Shanghai',
        dstPolicy: { gap: 'skip', overlap: 'first' },
        condition: { kind: 'always' }
      },
      'ou_bob'
    );
    await h.automation.updateSchedule(session.id, sched.id, { expectedRevision: 1, enabled: true }, 'ou_bob');
    await h.repos.config.set(`automation.delivery-target.${sched.id}`, JSON.stringify({
      appId: h.config.appId,
      chatId: 'oc_bob_group',
      replyMessageId: 'om_bob_root'
    }));

    // Alice 在另一个群 oc_alice_chat 里尝试停用 Bob 的计划
    const forgedContext = { messageId: 'om_alice_card', chatId: 'oc_alice_chat' };
    const res = await h.coordinator.handleAction(
      { dutydeck_schedule_disable: sched.id },
      'ou_alice',
      forgedContext
    );
    expect(res).toMatchObject({
      type: 'warning',
      content: '这张卡不属于这个计划，无法停用。'
    });

    // 校验计划仍然是启用状态
    const listAfter = await h.automation.listBySession(session.id);
    expect(listAfter.schedules.find(s => s.id === sched.id)?.enabled).toBe(true);
  });

  it('没有权限的人点击停用按钮被拒绝', async () => {
    const h = await testHarness({
      configPatch: {
        allowedUsers: [{ openId: 'ou_alice', name: 'Alice' }]
      }
    });
    const session = await h.runtime.startSession({
      agentId: 'mock',
      cwd: h.cwd,
      source: 'lark',
      sourceId: `${h.config.appId}:oc_group:group`
    });
    const at = new Date().toISOString();
    const sched = await h.automation.createSchedule(
      session.id,
      {
        name: '夜间分析',
        prompt: 'analyze build',
        trigger: { kind: 'interval', everySeconds: 3600, anchorAt: at },
        timezone: 'Asia/Shanghai',
        dstPolicy: { gap: 'skip', overlap: 'first' },
        condition: { kind: 'always' }
      },
      'ou_alice'
    );
    await h.repos.config.set(`automation.delivery-target.${sched.id}`, JSON.stringify({
      appId: h.config.appId,
      chatId: 'oc_group',
      replyMessageId: 'om_root'
    }));

    // 未在白名单的 Bob 点击
    const context = { messageId: 'om_result_card', chatId: 'oc_group' };
    const res = await h.coordinator.handleAction(
      { dutydeck_schedule_disable: sched.id },
      'ou_bob',
      context
    );
    expect(res).toMatchObject({
      type: 'warning',
      content: '当前账号没有操作此任务的权限。'
    });
  });

  it('点击不存在的计划按钮返回提示', async () => {
    const h = await testHarness({
      configPatch: {
        allowedUsers: [{ openId: 'ou_alice', name: 'Alice' }]
      }
    });
    const context = { messageId: 'om_result_card', chatId: 'oc_group' };
    const res = await h.coordinator.handleAction(
      { dutydeck_schedule_disable: 'non_existent_schedule' },
      'ou_alice',
      context
    );
    expect(res).toMatchObject({
      type: 'warning',
      content: '当前话题没有此计划'
    });
  });
});
