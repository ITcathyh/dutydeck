// F2-7 会话连续性：普通群里改在话题里回复时沿用发起人的顶层会话；意外新建会话时首卡说明原因。
// 真实 DutydeckRuntime + SQLite + RelayAskBroker，飞书 service 为内存 mock。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepositories } from '@dutydeck/storage';
import { DutydeckRuntime, type AgentDriver } from '@dutydeck/runtime';
import { RelayAskBroker } from '@dutydeck/relay';
import type { AgentConfig } from '@dutydeck/shared';
import { createRelayAskStore } from '../relay-ask-store.js';
import { LarkMessageCoordinator } from './coordinator.js';
import { LarkGroupManager } from './group-management.js';
import type { LarkGroupParticipation } from './group-participation.js';
import { larkBotsConfigKey, type StoredLarkConfig } from './config.js';
import type { LarkMessageEvent } from './listener.js';
import type { LarkInteraction } from './workflow-interactions.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const ASK = '请先问我';

/** 顶层消息：没有 thread_id / root_id，普通群按发送人分作用域。 */
const top = (id: string, text: string, patch: Partial<LarkMessageEvent> = {}): LarkMessageEvent => ({
  messageId: id, chatId: 'oc_group', chatType: 'group', senderOpenId: 'ou_alice', senderType: 'user',
  messageType: 'text', content: JSON.stringify({ text: `@_user_1 ${text}` }),
  mentions: [{ key: '@_user_1', name: 'Dock', openId: 'ou_bot' }], ...patch
});
/** 在 root 这条消息的话题里回复。 */
const inThread = (id: string, text: string, root: string, patch: Partial<LarkMessageEvent> = {}) =>
  top(id, text, { rootId: root, parentId: root, threadId: `omt_${root}`, ...patch });

async function harness(options: { configPatch?: Partial<StoredLarkConfig>; participation?: LarkGroupParticipation } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'dutydeck-lark-continuity-'));
  const repos = createRepositories(join(cwd, 'state.db'), { newDatabaseAuthority: 'ledger_v1' });
  let broker!: RelayAskBroker;
  const exits = new Map<string, (code: number | null) => void>();
  const send = vi.fn((_sessionId: string, _prompt: string) => {});
  const runtime = new DutydeckRuntime(repos, {
    probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }),
    driverFactory: (_config, _protocol, emit, exit, sessionId) => {
      exits.set(sessionId!, exit);
      const driver: AgentDriver = {
        start: async () => {}, resume: async () => {}, stop: async () => {}, isStopped: async () => true, interrupt: async () => {},
        send: async prompt => {
          send(sessionId!, prompt);
          if (prompt.includes(ASK)) {
            const result = await broker.register({ sessionId: sessionId!, question: '选择哪一种实现？' });
            if (result.status === 'answered') emit({ type: 'text', data: { text: `已收到：${result.answer}` } });
          } else emit({ type: 'text', data: { text: '工作已完成' } });
          emit({ type: 'completed', data: { stopReason: 'end_turn' } });
        },
        resolvePermission: async () => true
      };
      return driver;
    }
  });
  broker = new RelayAskBroker({ publish: async (sessionId, input) => { await runtime.publishSessionEvent(sessionId, 'text', { text: input.text, relay: input.kind, askId: input.askId }); } }, createRelayAskStore(repos.config));
  await broker.initialize();
  const agent: AgentConfig = { id: 'mock', name: 'Mock', command: process.execPath, args: [], protocol: 'acp', cwd, env: {}, permissionMode: 'ask', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };
  await runtime.initialize([agent]);
  const config: StoredLarkConfig = { appId: 'cli_continuity', appSecret: 'fake-secret', workspace: cwd, defaultAgentId: 'mock', permissionMode: 'ask', listening: true,
    fullTrustConfirmed: true, preInjectPrompt: '', structuredAskCards: false, groupCardMention: false, groupToolsEnabled: false, groupToolsAllowSend: false, pushIntervalMs: 1000, hideTraceOnComplete: false,
    allowedUsers: [], allowedEmails: [], allowedBots: [], peerBotsAllowed: false, highRiskAllowedUsers: [], highRiskAllowedEmails: [], highRiskPattern: 'dangerous', riskControlMode: 'off', ...options.configPatch };
  await repos.config.set(larkBotsConfigKey, JSON.stringify([config]));
  let nextCard = 0;
  const createCard = async (_input: any) => ({ messageId: `om_card_${++nextCard}` });
  const service = {
    send: vi.fn(createCard), reply: vi.fn(createCard), replyFile: vi.fn(createCard), sendFile: vi.fn(createCard),
    uploadFile: vi.fn(async () => 'file_1'),
    update: vi.fn(async (input: any) => ({ messageId: input.messageId })),
    addReaction: vi.fn(async (messageId: string) => ({ reactionId: `reaction_${messageId}` })),
    deleteReaction: vi.fn(async () => {}), getUserEmails: vi.fn(async () => []),
    listChatMembers: vi.fn(async () => ({ items: [{ memberId: 'ou_alice' }, { memberId: 'ou_bob' }], hasMore: false })),
    listChatMessages: vi.fn(async () => ({ items: [], hasMore: false })),
    getMessage: vi.fn(async (id: string) => ({ messageId: id, chatId: 'oc_group', messageType: 'text', rawContent: JSON.stringify({ text: '引用材料' }), sender: { type: 'user' }, mentions: [] })),
    getMessageItems: vi.fn(async () => []),
    downloadMessageResource: vi.fn(async () => ({ data: new Uint8Array([65]), contentType: 'text/plain' })),
    readDocument: vi.fn(async (url: string) => ({ url, title: '文档', text: '内容' }))
  };
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  // 没有同步过群、没有绑定：普通群。话题归属与群参与的判定要用到它。
  const groupManager = new LarkGroupManager(repos, { client: () => ({}) as any });
  const coordinators: LarkMessageCoordinator[] = [];
  /** 新建一个 coordinator 等于服务重启：内存里的 group 绑定全部丢失，只剩持久化数据。 */
  const createCoordinator = async () => {
    const coordinator = new LarkMessageCoordinator(runtime, service as any, log, Math.random, 'ou_bot', undefined, repos.channelMappings, async () => 'group', undefined, groupManager, { store: repos.config, broker, participation: options.participation });
    coordinators.push(coordinator);
    await coordinator.initializeWorkflows(config);
    return coordinator;
  };
  const coordinator = await createCoordinator();
  cleanups.push(async () => { for (const item of coordinators) item.stop(); broker.close(); await broker.flush(); await runtime.shutdown(); repos.close(); await rm(cwd, { recursive: true, force: true }); });
  const channel = `lark-card:${config.appId}`;
  const mapping = async (taskId: string) => (await repos.channelMappings.list(channel)).find(item => item.externalId === taskId);
  const delivered = (taskId: string) => vi.waitFor(async () => {
    expect(JSON.parse((await mapping(taskId))?.extra ?? '{}').final_delivery_state).toBe('delivered');
  });
  const sessionOf = async (taskId: string) => (await mapping(taskId))!.sessionId;
  /** 这一轮的首卡：第一次以 process 卡回复这条消息时的正文。 */
  const firstCard = (taskId: string) => service.reply.mock.calls.map(([input]) => input as any)
    .find(input => input.taskId === taskId && input.cardKind === 'process')?.markdown as string | undefined;
  const larkSessions = async () => (await runtime.listSessions()).filter(session => session.source === 'lark');
  const interactions = async () => (await repos.config.list!(`lark.interaction.${config.appId}.`)).map(row => JSON.parse(row.value) as LarkInteraction);
  return { repos, runtime, broker, config, coordinator, createCoordinator, service, send, exits, delivered, sessionOf, firstCard, larkSessions, interactions };
}

describe('普通群：顶层发起、改在话题里续问', () => {
  it('沿用原会话，等待中的提问收到话题里的回答，话题里后续消息（包括别人的）都进这个会话', async () => {
    const h = await harness();
    await h.coordinator.handle(top('om_task', `${ASK}：帮我选 CLI`), h.config);
    await vi.waitFor(async () => expect((await h.interactions()).find(item => item.kind === 'ask')?.cardId).toBeTruthy());
    const ask = (await h.interactions()).find(item => item.kind === 'ask')!;

    await h.coordinator.handle(inThread('om_answer', 'bdev-codex', 'om_task'), h.config);
    expect(h.broker.get(ask.nativeId)).toMatchObject({ status: 'answered', answer: 'bdev-codex' });
    expect(JSON.parse((await h.repos.config.get(`lark.inbox.${h.config.appId}.om_answer`))!)).toMatchObject({ state: 'accepted', workflowRequestId: ask.id });
    await h.delivered('om_task');
    const original = await h.sessionOf('om_task');
    expect(await h.runtime.getTasks(original)).toEqual([expect.objectContaining({ id: ask.taskId, status: 'completed' })]);

    await h.coordinator.handle(inThread('om_follow', '再补充一下兼容旧配置', 'om_task'), h.config);
    await h.delivered('om_follow');
    expect(await h.sessionOf('om_follow')).toBe(original);
    expect(h.send).toHaveBeenLastCalledWith(original, expect.stringContaining('再补充一下兼容旧配置'));
    // 卡片仍回在话题里；沿用旧会话不是新建，没有新会话注记。
    expect(h.service.reply).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'om_follow', cardKind: 'process', messageId: 'om_follow', replyInThread: true }));
    expect(h.firstCard('om_follow')).not.toContain('已开新会话');

    await h.coordinator.handle(inThread('om_bob', '我也补一句', 'om_task', { senderOpenId: 'ou_bob' }), h.config);
    await h.delivered('om_bob');
    expect(await h.sessionOf('om_bob')).toBe(original);
    expect(await h.larkSessions()).toHaveLength(1);
  });

  it('重启后话题里别人的消息仍靠任务卡认回发起人续接过的会话', async () => {
    const h = await harness();
    await h.coordinator.handle(top('om_task', '整理方案'), h.config);
    await h.delivered('om_task');
    await h.coordinator.handle(inThread('om_follow', '继续', 'om_task'), h.config);
    await h.delivered('om_follow');
    const original = await h.sessionOf('om_task');
    expect(await h.sessionOf('om_follow')).toBe(original);

    const restarted = await h.createCoordinator();
    await restarted.handle(inThread('om_bob', '我也补一句', 'om_task', { senderOpenId: 'ou_bob' }), h.config);
    await h.delivered('om_bob');
    expect(await h.sessionOf('om_bob')).toBe(original);
    expect(await h.larkSessions()).toHaveLength(1);
  });

  it('根消息不是本人发起的任务时，话题照旧新建会话', async () => {
    const h = await harness();
    await h.coordinator.handle(top('om_task', '整理方案'), h.config);
    await h.delivered('om_task');
    const original = await h.sessionOf('om_task');

    await h.coordinator.handle(inThread('om_bob', '顺着这个说一下', 'om_task', { senderOpenId: 'ou_bob' }), h.config);
    await h.delivered('om_bob');
    const thread = await h.sessionOf('om_bob');
    expect(thread).not.toBe(original);
    expect((await h.runtime.getSession(thread))?.sourceId).toBe('cli_continuity:oc_group:group:thread:om_task');
    expect(h.firstCard('om_bob')).not.toContain('已开新会话');
    // 话题已经有了自己的会话，发起人随后在话题里说话也进这个话题会话（话题共享）。
    await h.coordinator.handle(inThread('om_alice', '补充', 'om_task'), h.config);
    await h.delivered('om_alice');
    expect(await h.sessionOf('om_alice')).toBe(thread);
  });

  it('查不到根消息对应的任务时，话题照旧新建会话', async () => {
    const h = await harness();
    await h.coordinator.handle(top('om_task', '整理方案'), h.config);
    await h.delivered('om_task');
    const original = await h.sessionOf('om_task');

    await h.coordinator.handle(inThread('om_other_thread', '另一个话题', 'om_plain_message'), h.config);
    await h.delivered('om_other_thread');
    expect(await h.sessionOf('om_other_thread')).not.toBe(original);
    expect((await h.runtime.getSession(await h.sessionOf('om_other_thread')))?.sourceId).toBe('cli_continuity:oc_group:group:thread:om_plain_message');
  });

  it('原会话已结束时话题不续接，按原逻辑新建会话', async () => {
    const h = await harness();
    await h.coordinator.handle(top('om_task', '整理方案'), h.config);
    await h.delivered('om_task');
    const original = await h.sessionOf('om_task');
    h.exits.get(original)!(1);
    await vi.waitFor(async () => expect((await h.runtime.getSession(original))?.state).toBe('failed'));

    await h.coordinator.handle(inThread('om_follow', '继续', 'om_task'), h.config);
    await h.delivered('om_follow');
    expect(await h.sessionOf('om_follow')).not.toBe(original);
  });
});

describe('普通群：续接后的话题按话题共享处理唤醒', () => {
  it("mentionPolicy='topic' 时续接的话题里不 @ 也继续进原会话", async () => {
    const h = await harness({ configPatch: { mentionPolicy: 'topic' } });
    await h.coordinator.handle(top('om_task', '整理方案'), h.config);
    await h.delivered('om_task');
    const original = await h.sessionOf('om_task');
    await h.coordinator.handle(inThread('om_follow', '继续', 'om_task'), h.config);
    await h.delivered('om_follow');

    await h.coordinator.handle(inThread('om_plain', '再补一句', 'om_task', { content: JSON.stringify({ text: '再补一句' }), mentions: [] }), h.config);
    await h.delivered('om_plain');
    expect(await h.sessionOf('om_plain')).toBe(original);
  });

  it("mentionPolicy='topic' 时话题里只 @ 了别人的消息不算在叫原主人", async () => {
    const h = await harness({ configPatch: { mentionPolicy: 'topic' } });
    await h.coordinator.handle(top('om_task', '整理方案'), h.config);
    await h.delivered('om_task');
    await h.coordinator.handle(inThread('om_follow', '继续', 'om_task'), h.config);
    await h.delivered('om_follow');
    const sent = h.send.mock.calls.length;

    // 在 A 的话题里叫 B 一起查：B 接，A 不接也不回卡。
    await h.coordinator.handle(inThread('om_peer', '你也一起查', 'om_task', {
      mentions: [{ key: '@_user_1', name: 'Peer', openId: 'ou_peer_bot' }]
    }), h.config);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(h.send.mock.calls.length).toBe(sent);
    expect(h.service.reply.mock.calls.some(([input]) => (input as any).taskId === 'om_peer')).toBe(false);

    // 同时 @ 了原主人照常接。
    await h.coordinator.handle(inThread('om_both', '你们一起查', 'om_task', {
      content: JSON.stringify({ text: '@_user_1 @_user_2 你们一起查' }),
      mentions: [{ key: '@_user_1', name: 'Dock', openId: 'ou_bot' }, { key: '@_user_2', name: 'Peer', openId: 'ou_peer_bot' }]
    }), h.config);
    await h.delivered('om_both');
  });

  it('群参与开启时，发起人在自己任务的话题里不 @ 也算继续和机器人对话', async () => {
    const handle = vi.fn(async () => ({ enabled: true, instructions: '' }));
    const participation = { handle, mode: async () => 'selective', guardBotTurn: async () => undefined, taskContext: async () => '', instructions: async () => '' } as unknown as LarkGroupParticipation;
    const h = await harness({ participation });
    h.service.getMessage.mockImplementation(async (id: string) => ({ messageId: id, chatId: 'oc_group', messageType: 'text', rawContent: JSON.stringify({ text: '整理方案' }),
      sender: { id: 'ou_alice', idType: 'open_id', type: 'user' }, mentions: [] }) as any);
    await h.coordinator.handle(top('om_task', '整理方案'), h.config);
    await h.delivered('om_task');
    const original = await h.sessionOf('om_task');

    await h.coordinator.handle(inThread('om_plain', '再补一句', 'om_task', { content: JSON.stringify({ text: '再补一句' }), mentions: [] }), h.config);
    await h.delivered('om_plain');
    expect(handle).toHaveBeenLastCalledWith(expect.objectContaining({ messageId: 'om_plain' }), expect.anything(), expect.objectContaining({ explicit: true }));
    expect(await h.sessionOf('om_plain')).toBe(original);
  });
});

describe('意外新建会话的首卡注记', () => {
  it.each([false, true])('旧会话 failed 后新建会话，首卡写明原因（重启：%s）', async restart => {
    const h = await harness();
    await h.coordinator.handle(top('om_task', '整理方案'), h.config);
    await h.delivered('om_task');
    const original = await h.sessionOf('om_task');
    h.exits.get(original)!(1);
    await vi.waitFor(async () => expect((await h.runtime.getSession(original))?.state).toBe('failed'));

    const coordinator = restart ? await h.createCoordinator() : h.coordinator;
    await coordinator.handle(top('om_continue', '继续'), h.config);
    await h.delivered('om_continue');
    expect(await h.sessionOf('om_continue')).not.toBe(original);
    expect(h.firstCard('om_continue')).toContain('已开新会话（原会话已异常结束）。');

    // 注记只在新会话的首卡上出现一次。
    await coordinator.handle(top('om_again', '再继续'), h.config);
    await h.delivered('om_again');
    expect(await h.sessionOf('om_again')).toBe(await h.sessionOf('om_continue'));
    expect(h.firstCard('om_again')).not.toContain('已开新会话');
  });

  it('管理员改了机器人配置后新建会话，首卡写明原因', async () => {
    const h = await harness();
    await h.coordinator.handle(top('om_task', '整理方案'), h.config);
    await h.delivered('om_task');
    const original = await h.sessionOf('om_task');

    // coordinator 每条消息都重读已保存的配置，改配置要写回存储。
    const changed = { ...h.config, defaultModel: 'gpt-new' };
    await h.repos.config.set(larkBotsConfigKey, JSON.stringify([changed]));
    await h.coordinator.handle(top('om_continue', '继续'), changed);
    await h.delivered('om_continue');
    expect((await h.runtime.getSession(original))?.state).toBe('stopped');
    expect(await h.sessionOf('om_continue')).not.toBe(original);
    expect(h.firstCard('om_continue')).toContain('已开新会话（机器人配置已变更）。');
  });

  it.each([
    ['/new', undefined],
    ['/new 下一件事', 'om_new']
  ])('%s 之后新开的会话没有这条注记', async (command, goalTask) => {
    const h = await harness();
    await h.coordinator.handle(top('om_task', '整理方案'), h.config);
    await h.delivered('om_task');
    const original = await h.sessionOf('om_task');

    await h.coordinator.handle(top('om_new', command), h.config);
    let next = goalTask;
    if (!next) {
      await vi.waitFor(() => expect(h.service.reply).toHaveBeenCalledWith(expect.objectContaining({ taskName: '/new 已受理' })));
      await h.coordinator.handle(top('om_next', '下一件事'), h.config);
      next = 'om_next';
    }
    await h.delivered(next);
    expect((await h.runtime.getSession(original))?.state).toBe('stopped');
    expect(await h.sessionOf(next)).not.toBe(original);
    expect(h.firstCard(next)).toBeTruthy();
    expect(h.firstCard(next)).not.toContain('已开新会话');
  });
});
