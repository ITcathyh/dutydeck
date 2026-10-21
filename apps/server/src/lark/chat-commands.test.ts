// 聊天内指挥命令的协调器级回归：/agents、/queue、/steer、/grant、/revoke，
// 以及 /status 的执行身份说明与 /tasks 行内 Agent。
//
// 与 coordinator-ux-p0.test.ts 同样接真实 DutydeckRuntime + SQLite + 真实 LarkGroupManager，
// 只把飞书网络层换成内存桩：这几条命令的价值全在「真的改了运行时/群绑定」，
// 只 mock runtime 的测试证明不了任何事。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir, userInfo } from 'node:os';
import { createRepositories } from '@dutydeck/storage';
import { buildSessionMarker, claudeProjectDir } from '@dutydeck/pty-driver';
import { pinnedSessionUuid } from '@dutydeck/cli-adapters';
import { DutydeckRuntime, type AgentDriver } from '@dutydeck/runtime';
import { RuntimeError, type AgentConfig } from '@dutydeck/shared';
import { LarkMessageCoordinator } from './coordinator.js';
import { LarkGroupManager } from './group-management.js';
import { larkBotsConfigKey, type StoredLarkConfig } from './config.js';
import type { LarkMessageEvent } from './listener.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const event = (id: string, text: string, patch: Partial<LarkMessageEvent> = {}): LarkMessageEvent => ({
  messageId: id, chatId: 'oc_group', chatType: 'group', threadId: 'omt_topic', rootId: 'om_root',
  senderOpenId: 'ou_alice', senderType: 'user', messageType: 'text', content: JSON.stringify({ text }),
  mentions: [{ key: '@_user_1', name: 'Dock', openId: 'ou_bot' }], ...patch
});

/** `/grant @Bob` 形态的事件：机器人提及之外再带一个真实群成员提及。 */
const mentioning = (id: string, text: string, member: { openId?: string; name: string }, senderOpenId = 'ou_bob'): LarkMessageEvent =>
  event(id, text, { senderOpenId, mentions: [
    { key: '@_user_1', name: 'Dock', openId: 'ou_bot' },
    { key: '@_user_2', name: member.name, ...(member.openId ? { openId: member.openId } : {}), mentionedType: 'user' }
  ] });

async function harness(options: { native?: boolean; answer?: boolean; managedGroup?: boolean; configPatch?: Partial<StoredLarkConfig>; steer?: AgentDriver['steer']; hold?: (prompt: string) => Promise<void> | undefined; reportIdle?: boolean } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'dutydeck-lark-commands-'));
  const repos = createRepositories(join(cwd, 'state.db'), { newDatabaseAuthority: 'ledger_v1' });
  let release: (() => void) | undefined;
  const gate = new Promise<void>(done => { release = done; });
  const prompts: string[] = [];
  const forks: Array<string | undefined> = [];
  const runtime = new DutydeckRuntime(repos, {
    probe: () => ({ protocol: options.native ? 'pty-cli' : 'acp', available: true, pause: false, resume: true }),
    driverFactory: (_config, _protocol, emit, _exit, _id, context) => {
      forks.push(context.nativeForkSessionId);
      let cancelled = false, sending = false;
      const cancel = () => { cancelled = true; emit({ type: 'completed', data: { stopReason: 'cancelled' } }); };
      const driver: AgentDriver = {
        start: async () => {}, resume: async () => {},
        isStopped: async () => true,
        stop: async () => cancel(), interrupt: async () => cancel(),
        send: async prompt => {
          prompts.push(prompt);
          cancelled = false;
          sending = true;
          try {
            // 第一轮一直挂着，后续消息才会真的排队；释放闸门后所有轮次立刻收口。
            await gate;
            await options.hold?.(prompt);
            if (cancelled) return;
            if (options.answer) emit({ type: 'text', data: { text: '已完成原任务' } });
            emit({ type: 'completed', data: { stopReason: 'end_turn' } });
          } finally { sending = false; }
        },
        ...(options.steer ? { steer: options.steer } : {}),
        // 与真实 ACP 驱动一样报告自己是否空闲：结果未知的一轮要等驱动空闲才能人工处理。
        ...(options.reportIdle ? { isIdle: () => !sending } : {})
      };
      return driver;
    }
  });
  const agents: AgentConfig[] = [
    { id: 'mock', name: 'Mock Agent', command: process.execPath, args: [], protocol: 'acp', cwd, env: {}, permissionMode: 'ask', timeout: 10, version: '1.2.3', capabilities: { pause: false, resume: true }, builtin: false },
    { id: 'spare', name: 'Spare Agent', command: process.execPath, args: [], protocol: 'acp', cwd, env: {}, permissionMode: 'ask', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false }
  ];
  if (options.native) Object.assign(agents[0]!, { protocol: 'pty-cli', adapterId: 'claude-code', env: { CLAUDE_CONFIG_DIR: join(cwd, 'claude-fixture') }, permissionMode: 'full-trust' });
  await runtime.initialize(agents);
  const steerQueued = vi.fn();
  const realSteer = runtime.steerQueued.bind(runtime);
  runtime.steerQueued = (async (id: string, taskId: string, actorId?: string) => {
    steerQueued(id, taskId, actorId);
    return realSteer(id, taskId, actorId);
  }) as typeof runtime.steerQueued;

  const config: StoredLarkConfig = { appId: 'cli_cmd', appSecret: 'fake-secret', workspace: cwd, defaultAgentId: 'mock', permissionMode: 'ask', listening: true,
    fullTrustConfirmed: true, preInjectPrompt: '', structuredAskCards: false, groupCardMention: false, groupToolsEnabled: false, groupToolsAllowSend: false,
    pushIntervalMs: 1_000, hideTraceOnComplete: false, allowedUsers: [], allowedEmails: [], allowedBots: [], peerBotsAllowed: false,
    highRiskAllowedUsers: [], highRiskAllowedEmails: [], highRiskPattern: 'dangerous', riskControlMode: 'off', ...options.configPatch };
  await repos.config.set(larkBotsConfigKey, JSON.stringify([config]));

  let nextCard = 0;
  const cards: any[] = [];
  const createCard = async (input: any) => { cards.push(input); return { messageId: `om_card_${++nextCard}` }; };
  const service = {
    send: vi.fn(createCard), reply: vi.fn(createCard),
    sendText: vi.fn(createCard), getMessageLink: vi.fn(async (id: string) => `https://example.test/message/${id}`),
    uploadFile: vi.fn(async () => 'file_x'), replyFile: vi.fn(createCard), sendFile: vi.fn(createCard),
    update: vi.fn(async (input: any) => { cards.push(input); return { messageId: input.messageId }; }),
    addReaction: vi.fn(async (messageId: string) => ({ messageId, reactionId: `reaction_${messageId}` })),
    deleteReaction: vi.fn(async () => {}), getUserEmails: vi.fn(async () => [] as string[]),
    listChatMembers: vi.fn(async () => ({ items: [{ memberId: 'ou_alice' }, { memberId: 'ou_bob' }], hasMore: false })),
    listChatMessages: vi.fn(async () => ({ items: [] as any[], hasMore: false })),
    getMessage: vi.fn(async (id: string) => ({ messageId: id, chatId: 'oc_group', messageType: 'text', rawContent: '{"text":""}', sender: { type: 'user' }, mentions: [] })),
    getMessageItems: vi.fn(async () => [] as any[]),
    downloadMessageResource: vi.fn(async () => ({ data: new Uint8Array(), contentType: 'text/plain' })),
    readDocument: vi.fn(async (url: string) => ({ url, title: '', text: '' }))
  };
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  let groupManager: LarkGroupManager | undefined;
  if (options.managedGroup) {
    groupManager = new LarkGroupManager(repos, { client: () => ({
      getBotInfo: async () => ({ appName: config.appId, openId: 'ou_bot' }),
      checkApplicationIdentity: async () => ({ verified: true, reportedAppId: config.appId, tenantKey: 'synthetic-tenant' }),
      listChats: async () => ({ items: [{ chatId: 'oc_group', name: '指挥群', chatMode: 'topic' }], hasMore: false }),
      listChatMembers: async () => ({ items: [
        { memberId: 'ou_alice', openId: 'ou_alice', name: 'Alice', memberType: 'user' },
        { memberId: 'ou_bob', openId: 'ou_bob', name: 'Bob', memberType: 'user' }
      ], hasMore: false, securityLimited: false }),
      getUserEmails: async () => []
    }) as any });
    await groupManager.sync(config.appId);
    await groupManager.save(config.appId, 'oc_group', { expectedRevision: 0, patch: {} });
  }
  const createCoordinator = () => new LarkMessageCoordinator(runtime, service as any, log, Math.random, 'ou_bot', undefined, repos.channelMappings, async () => 'group', undefined, groupManager, { store: repos.config });
  const coordinator = createCoordinator();
  await coordinator.initializeWorkflows(config);
  cleanups.push(async () => { coordinator.stop(); release?.(); await runtime.shutdown(); repos.close(); await rm(cwd, { recursive: true, force: true }); });

  /** 命令回执卡（只读卡片，taskName 是命令自己的标题）。 */
  const receipts = () => cards.filter(card => card.readOnly === true);
  const lastReceipt = () => receipts().at(-1);
  /** 指定标题的那张回执卡（任务终态卡也是只读卡，按标题取才不会拿错）。 */
  const receiptNamed = (taskName: string) => receipts().filter(card => card.taskName === taskName).at(-1);
  const markdownOf = (card: any) => String(card?.markdown ?? '') + JSON.stringify(card?.elements ?? []);
  /** 发给某条指令的结果未知提醒卡（带「重新执行」「标为已完成」「标为失败」的那张）。 */
  const unknownNotices = (taskId: string) => [...service.reply.mock.calls, ...service.send.mock.calls].map(([input]) => input as any)
    .filter(input => input.taskId === taskId && JSON.stringify(input.elements ?? []).includes('unknown_task_notice'));
  /** 给本群下一条指令并等它进入队列（runtime 已经登记了这条任务）。 */
  const dispatch = async (id: string, text: string, senderOpenId = 'ou_alice') => {
    await coordinator.handle(event(id, text, { senderOpenId }), config);
    await vi.waitFor(async () => {
      const [session] = await runtime.listSessions();
      expect((await runtime.getTasks(session!.id)).some(task => task.prompt.includes(text))).toBe(true);
    });
  };
  const sessionId = async () => (await runtime.listSessions())[0]!.id;
  /** 等某条指令真的开跑：只等它出现在队列里的用例，会在「谁在执行」上偶发竞态。 */
  const waitRunning = async (text: string) => vi.waitFor(async () =>
    expect((await runtime.getTasks(await sessionId())).some(task => task.prompt.includes(text) && task.status === 'running')).toBe(true));
  return { forks, agents, repos, runtime, config, coordinator, createCoordinator, service, cards, log, groupManager, steerQueued, prompts,
    receipts, lastReceipt, receiptNamed, markdownOf, unknownNotices, dispatch, sessionId, waitRunning, cwd, release: () => release?.() };
}

describe('/agents 列出本机可用 Agent', () => {
  it('列出 id、显示名、可探测到的版本，并标出本机器人当前默认', async () => {
    const h = await harness();
    await h.coordinator.handle(event('om_agents', '/agents'), h.config);
    const text = h.markdownOf(h.lastReceipt());
    expect(text).toContain('Mock Agent');
    expect(text).toContain('mock');
    expect(text).toContain('1.2.3');
    expect(text).toContain('Spare Agent');
    // 探测不到版本时如实说明，不编一个版本号。
    expect(text).toContain('版本未探测到');
    expect(text).toMatch(/Mock Agent[\s\S]*当前默认/);
    expect(text).not.toMatch(/Spare Agent[^\n]*当前默认/);
  });
});

describe('/status 写明以谁的身份执行', () => {
  it('回执里出现部署这台服务的系统账号与它带来的访问面', async () => {
    const h = await harness();
    await h.dispatch('om_task', '第一件事');
    await h.coordinator.handle(event('om_status', '/status'), h.config);
    const text = h.markdownOf(h.lastReceipt());
    expect(text).toContain('执行身份');
    expect(text).toContain(userInfo().username);
    expect(text).toContain('凭据');
  });
});

describe('/queue 查看与操作待执行指令', () => {
  it('列出排队项，按编号取消，按编号提到队首', async () => {
    const h = await harness();
    await h.dispatch('om_1', '第一件事');
    await h.dispatch('om_2', '第二件事');
    // 换一个发起人：同一人紧接着连发的两条会并成一条排队，这里要的是两条独立的排队项。
    await h.dispatch('om_3', '第三件事', 'ou_bob');
    const session = await h.sessionId();
    await vi.waitFor(async () => expect((await h.runtime.getTasks(session)).filter(task => task.status === 'queued')).toHaveLength(2));

    await h.coordinator.handle(event('om_q1', '/queue'), h.config);
    const listed = h.markdownOf(h.lastReceipt());
    expect(listed).toContain('排队 2 条');
    expect(listed).toContain('第二件事');
    expect(listed).toContain('第三件事');

    await h.coordinator.handle(event('om_q2', '/queue top 2'), h.config);
    const queuedIds = (await h.runtime.getTasks(session)).filter(task => task.status === 'queued').map(task => task.id);
    expect(h.steerQueued).toHaveBeenCalledWith(session, queuedIds[1], 'ou_alice');

    await h.coordinator.handle(event('om_q3', '/queue cancel 1'), h.config);
    await vi.waitFor(async () => expect((await h.runtime.getTasks(session)).find(task => task.id === queuedIds[0])?.status).toBe('cancelled'));

    await h.coordinator.handle(event('om_q4', '/queue cancel 9'), h.config);
    expect(h.receiptNamed('/queue 未执行')).toMatchObject({ state: 'failed' });
    expect(h.markdownOf(h.receiptNamed('/queue 未执行'))).toContain('编号');
  });

  it('回执回显排队原文时转义 <at>，不让排队内容在卡面变成真的 @', async () => {
    const h = await harness();
    await h.dispatch('om_1', '第一件事');
    await h.dispatch('om_2', '叫上 <at user_id="ou_alice"></at> 一起');
    await h.coordinator.handle(event('om_q', '/queue cancel 1'), h.config);
    const text = h.markdownOf(h.receiptNamed('已取消排队指令'));
    expect(text).toContain('&lt;at');
    expect(text).not.toContain('<at');
  });

  it('用法写错时给出用法而不是猜一个编号', async () => {
    const h = await harness();
    await h.dispatch('om_1', '第一件事');
    await h.coordinator.handle(event('om_q', '/queue drop 1'), h.config);
    expect(h.receiptNamed('/queue 执行失败')).toMatchObject({ state: 'failed' });
    expect(h.markdownOf(h.receiptNamed('/queue 执行失败'))).toContain('/queue cancel');
  });
});

describe('/steer 插话降级为队首', () => {
  it('如实说明当前 Agent 不支持插话，并真的把这条提到队首', async () => {
    const h = await harness();
    await h.dispatch('om_1', '第一件事');
    await h.coordinator.handle(event('om_steer', '/steer 改成另一个方向'), h.config);
    const session = await h.sessionId();
    await vi.waitFor(() => expect(h.steerQueued).toHaveBeenCalledTimes(1));
    const steered = (await h.runtime.getTasks(session)).find(task => task.prompt.includes('改成另一个方向'));
    expect(steered).toBeDefined();
    expect(h.steerQueued).toHaveBeenCalledWith(session, steered!.id, 'ou_alice');
    // 卡面必须说清这不是真正的插话。
    await vi.waitFor(() => expect(h.cards.map(card => h.markdownOf(card)).join('\n')).toContain('不支持插话'));
    // 派进 runtime 的是内容本身，命令名不会被带进去。
    expect(steered!.prompt).toContain('改成另一个方向');
    expect(steered!.prompt).not.toContain('/steer');
  });

  it('没有别人可插队时也把限制说清楚，不让用户以为真的插了话', async () => {
    const h = await harness();
    await h.coordinator.handle(event('om_steer', '/steer 直接开始'), h.config);
    // 走的必须是「没有排在别人后面」这条分支，而不是笼统一句「不支持插话」。
    await vi.waitFor(() => expect(h.cards.map(card => h.markdownOf(card)).join('\n')).toContain('没有别的任务排在前面'));
    expect(h.steerQueued).not.toHaveBeenCalled();
  });

  it('正在跑的是他人的任务时拒绝插队，不借 /steer 绕开 /cancel 的中断门', async () => {
    const h = await harness({ managedGroup: true });
    await h.dispatch('om_1', '第一件事');
    await h.waitRunning('第一件事');
    await h.coordinator.handle(event('om_steer', '/steer 换个方向', { senderOpenId: 'ou_bob' }), h.config);
    expect(h.receiptNamed('/steer 未执行')).toMatchObject({ state: 'failed' });
    expect(h.markdownOf(h.receiptNamed('/steer 未执行'))).toContain('中断');
    expect(h.steerQueued).not.toHaveBeenCalled();
    // 同一道门也要挡住 /queue top：Bob 提升的是**他自己**那条排队指令（queue.promote 必然通过），
    // 拦住他的只能是「提到队首会中断 Alice 正在跑的那一轮」这道 run.interrupt 门。
    await h.dispatch('om_2', '第二件事', 'ou_bob');
    await h.coordinator.handle(event('om_q', '/queue top 1', { senderOpenId: 'ou_bob' }), h.config);
    expect(h.markdownOf(h.receiptNamed('/queue 未执行'))).toContain('中断当前正在执行的那一轮');
    expect(h.steerQueued).not.toHaveBeenCalled();
  });

  it('没带内容时只给用法，不派发空任务', async () => {
    const h = await harness();
    await h.coordinator.handle(event('om_steer', '/steer'), h.config);
    expect(h.lastReceipt()).toMatchObject({ state: 'failed' });
    expect(h.markdownOf(h.lastReceipt())).toContain('/steer <内容>');
    expect(await h.runtime.listSessions()).toHaveLength(0);
  });
});

describe('Agent 支持插话时送进正在执行的这一轮', () => {
  it('/steer 送达后不提到队首，也不另起一轮', async () => {
    const steer = vi.fn(async (_prompt: string) => 'injected' as const);
    const h = await harness({ steer });
    await h.dispatch('om_1', '第一件事');
    // 插话要等第一轮真的交给 Agent；只看任务状态 running 时它可能还在准备。
    await vi.waitFor(() => expect(h.prompts).toHaveLength(1));
    await h.coordinator.handle(event('om_steer', '/steer 改成另一个方向'), h.config);
    await vi.waitFor(() => expect(steer).toHaveBeenCalledTimes(1));
    expect(steer.mock.calls[0]![0]).toContain('改成另一个方向');
    const session = await h.sessionId();
    await vi.waitFor(async () => expect((await h.runtime.getTasks(session)).find(task => task.prompt.includes('改成另一个方向'))?.status).toBe('completed'));
    await vi.waitFor(() => expect(h.cards.map(card => h.markdownOf(card)).join('\n')).toContain('已把这条内容送进正在执行的这一轮'));
    expect(h.steerQueued).not.toHaveBeenCalled();
    expect(h.prompts).toHaveLength(1);
  });

  it('插话送达的那条不自动验证：它没有自己的一轮，验证留给正在执行的那一轮', async () => {
    let cwd = '';
    // 插话期间正在执行的那一轮改了代码。
    const steer = vi.fn(async (_prompt: string) => { writeFileSync(join(cwd, 'steered.txt'), 'changed\n'); return 'injected' as const; });
    const h = await harness({ steer, configPatch: { verificationCommand: 'true' } });
    cwd = h.cwd;
    const git = (...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
    git('init', '-q');
    // 状态库一直在写，排除在代码指纹之外：本轮前后只有 steered.txt 这一处改动。
    writeFileSync(join(cwd, '.gitignore'), 'state.db*\n');
    writeFileSync(join(cwd, 'README.md'), 'baseline\n');
    git('add', '.gitignore', 'README.md');
    git('-c', 'user.email=test@example.com', '-c', 'user.name=Dutydeck Test', 'commit', '-qm', 'baseline');
    await h.dispatch('om_1', '第一件事');
    await vi.waitFor(() => expect(h.prompts).toHaveLength(1));
    await h.coordinator.handle(event('om_steer', '/steer 改成另一个方向'), h.config);
    await vi.waitFor(() => expect(steer).toHaveBeenCalledTimes(1));
    const saved = await vi.waitFor(async () => {
      const mapping = await h.repos.channelMappings.get(`lark-card:${h.config.appId}`, 'om_steer');
      const extra = JSON.parse(mapping?.extra ?? '{}');
      expect(extra.final_message_id).toBeTruthy();
      return extra;
    });
    expect(saved.verification_auto).toBeUndefined();
  });

  it('/queue steer 按编号把排队指令送进这一轮', async () => {
    const steer = vi.fn(async (_prompt: string) => 'injected' as const);
    const h = await harness({ steer });
    await h.dispatch('om_1', '第一件事');
    await vi.waitFor(() => expect(h.prompts).toHaveLength(1));
    await h.dispatch('om_2', '第二件事');
    await h.coordinator.handle(event('om_q', '/queue steer 1'), h.config);
    expect(h.receiptNamed('已插话')).toBeDefined();
    expect(steer.mock.calls[0]![0]).toContain('第二件事');
    expect((await h.runtime.getTasks(await h.sessionId())).find(task => task.prompt.includes('第二件事'))?.status).toBe('completed');
    expect(h.steerQueued).not.toHaveBeenCalled();
  });

  it('重启后补发的终态卡按账本写插话结果，而不是「结果不完整」', async () => {
    const steer = vi.fn(async (_prompt: string) => 'injected' as const);
    const h = await harness({ steer });
    await h.dispatch('om_1', '第一件事');
    await vi.waitFor(() => expect(h.prompts).toHaveLength(1));
    await h.dispatch('om_2', '第二件事');
    const session = await h.sessionId();
    const second = (await h.runtime.getTasks(session)).find(task => task.prompt.includes('第二件事'))!;
    // 插话在飞书这一侧停机期间送达（例如 Web 上插话后服务重启），内存里没有任何插话标记。
    h.coordinator.stop();
    await h.runtime.injectQueued(session, second.id, 'ou_alice');
    const restored = h.createCoordinator();
    try {
      await restored.initializeWorkflows(h.config);
      await restored.reconcile(h.config);
      const result = h.cards.filter(card => card.cardKind === 'result' && card.taskId === 'om_2').at(-1);
      expect(h.markdownOf(result)).toContain('已把这条内容送进正在执行的这一轮');
      expect(h.markdownOf(result)).not.toContain('结果不完整');
    } finally { restored.stop(); }
  });

  it('/steer 派发后、插话前这条已经开跑时，回执写它已经开始执行', async () => {
    let releaseSteered!: () => void;
    const steered = new Promise<void>(done => { releaseSteered = done; });
    const steer = vi.fn(async (_prompt: string) => 'injected' as const);
    const h = await harness({ steer, hold: prompt => prompt.includes('改成另一个方向') ? steered : undefined });
    cleanups.push(() => releaseSteered());
    await h.dispatch('om_1', '第一件事');
    await vi.waitFor(() => expect(h.prompts).toHaveLength(1));
    const realInject = h.runtime.injectQueued.bind(h.runtime);
    h.runtime.injectQueued = (async (id: string, taskId: string, actorId?: string) => {
      // 派发与插话之间第一轮结束，这条自己开跑了。
      h.release();
      await vi.waitFor(async () => expect((await h.runtime.getTasks(id)).find(task => task.id === taskId)?.status).toBe('running'));
      return realInject(id, taskId, actorId);
    }) as typeof h.runtime.injectQueued;
    await h.coordinator.handle(event('om_steer', '/steer 改成另一个方向'), h.config);
    await vi.waitFor(() => expect(h.cards.map(card => h.markdownOf(card)).join('\n')).toContain('已经开始执行'), { timeout: 5_000 });
    expect(h.cards.map(card => h.markdownOf(card)).join('\n')).not.toContain('提升队首也失败了');
    expect(steer).not.toHaveBeenCalled();
    expect(h.steerQueued).not.toHaveBeenCalled();
  });

  it.each(['result', 'exception', 'moved'] as const)('/steer 投递结果未知时保留恢复状态，不降级为提升队首（%s）', async mode => {
    const steer = vi.fn(async () => { throw new Error('acknowledgement lost after delivery'); });
    const h = await harness({ steer, reportIdle: true });
    await h.dispatch('om_1', '第一件事');
    await vi.waitFor(() => expect(h.prompts).toHaveLength(1));
    if (mode !== 'result') {
      const inject = h.runtime.injectQueued.bind(h.runtime);
      vi.spyOn(h.runtime, 'injectQueued').mockImplementation(async (...args) => {
        await inject(...args);
        throw mode === 'moved' ? new RuntimeError('QUEUED_TASK_NOT_FOUND', 'Queued task is missing', 404) : new Error('response projection failed');
      });
    }
    await h.coordinator.handle(event('om_unknown', '/steer 改成另一个方向'), h.config);
    const id = await h.sessionId();
    await vi.waitFor(async () => expect((await h.runtime.getTasks(id)).find(task => task.prompt.includes('改成另一个方向'))?.status).toBe('reconcile_required'));
    expect(h.steerQueued).not.toHaveBeenCalled();
    const note = await vi.waitFor(() => { const card = h.cards.filter(card => card.taskId === 'om_unknown').at(-1); expect(h.markdownOf(card)).toContain('投递结果未知'); return h.markdownOf(card); });
    expect(note).toContain('请在随后发出的「结果未知」提醒卡上选择重新执行、标为已完成或标为失败');
    expect(note).not.toContain('已把这条内容提到队首');
    expect(note).not.toContain('这条内容按正常顺序排队');
    // 回执里说的提醒卡由周期对账发到这条指令所在的话题，且只发一张。
    await h.coordinator.startReconciliation(h.config, 50);
    await vi.waitFor(() => expect(h.unknownNotices('om_unknown')).toHaveLength(1));
    h.release();
    // 夹具没有助手文本，原轮结束时标为 failed；未知插话仍不能随后自行执行。
    await vi.waitFor(async () => expect((await h.runtime.getTasks(id)).find(task => task.prompt.includes('第一件事'))?.status).toBe('failed'));
    expect(steer).toHaveBeenCalledTimes(1); expect(h.prompts).toHaveLength(1);
    // 在提醒卡上标为已完成：插话按已送达结算，不重发；再对账也不补发第二张提醒卡。
    const notice = h.unknownNotices('om_unknown')[0];
    const noticeId = (await h.service.reply.mock.results[h.service.reply.mock.calls.findIndex(([input]) => input === notice)]!.value).messageId;
    const value = { action: 'resolve_completed', task_id: 'om_unknown', turn: String(notice.turn), target: notice.capabilities.unknownTaskTarget };
    expect(await h.coordinator.handleAction(value, 'ou_alice', { messageId: noticeId, chatId: 'oc_group' })).toMatchObject({ type: 'success' });
    expect((await h.runtime.getTasks(id)).find(task => task.prompt.includes('改成另一个方向'))?.status).toBe('completed');
    await h.coordinator.reconcile(h.config);
    expect(h.unknownNotices('om_unknown')).toHaveLength(1);
    expect(h.prompts).toHaveLength(1);
  });

  it('/steer 回执丢失但持久任务已完成时不重新提升队列', async () => {
    const h = await harness({ steer: async () => 'injected' });
    await h.dispatch('om_1', '第一件事');
    await vi.waitFor(() => expect(h.prompts).toHaveLength(1));
    const inject = h.runtime.injectQueued.bind(h.runtime);
    vi.spyOn(h.runtime, 'injectQueued').mockImplementation(async (...args) => { await inject(...args); throw new Error('response projection failed'); });
    await h.coordinator.handle(event('om_committed', '/steer 已送达但回执丢失'), h.config);
    await vi.waitFor(async () => expect((await h.runtime.getTasks(await h.sessionId())).find(task => task.prompt.includes('已送达但回执丢失'))?.status).toBe('completed'));
    expect(h.steerQueued).not.toHaveBeenCalled();
    const note = await vi.waitFor(() => { const card = h.cards.filter(card => card.taskId === 'om_committed').at(-1); expect(h.markdownOf(card)).toContain('已把这条内容送进正在执行的这一轮'); return h.markdownOf(card); });
    expect(note).not.toContain('已把这条内容提到队首'); expect(note).not.toContain('这条内容按正常顺序排队');
    expect(h.prompts).toHaveLength(1);
  });

  it('/queue steer 投递结果未知时要求核对，不提示继续排队或提升', async () => {
    const steer = vi.fn(async () => { throw new Error('acknowledgement lost after delivery'); });
    const h = await harness({ steer, reportIdle: true });
    await h.dispatch('om_1', '第一件事');
    await vi.waitFor(() => expect(h.prompts).toHaveLength(1));
    await h.dispatch('om_2', '第二件事');
    await h.coordinator.handle(event('om_q_unknown', '/queue steer 1'), h.config);
    const receipt = h.receiptNamed('/queue 插话结果未知');
    expect(h.markdownOf(receipt)).toContain('可能已送达');
    expect(h.markdownOf(receipt)).toContain('请在随后发出的「结果未知」提醒卡上选择重新执行、标为已完成或标为失败');
    expect(h.markdownOf(receipt)).not.toContain('仍在排队');
    expect(h.markdownOf(receipt)).not.toContain('/queue top');
    const second = (await h.runtime.getTasks(await h.sessionId())).find(task => task.prompt.includes('第二件事'))!;
    expect(second.status).toBe('reconcile_required');
    expect(h.steerQueued).not.toHaveBeenCalled(); expect(steer).toHaveBeenCalledTimes(1);
    await h.coordinator.startReconciliation(h.config, 50);
    await vi.waitFor(() => expect(h.unknownNotices('om_2')).toHaveLength(1));
  });

  it('/queue steer 在 Agent 不支持插话时如实说明，这条仍在排队', async () => {
    const h = await harness();
    await h.dispatch('om_1', '第一件事');
    await vi.waitFor(() => expect(h.prompts).toHaveLength(1));
    await h.dispatch('om_2', '第二件事');
    await h.coordinator.handle(event('om_q', '/queue steer 1'), h.config);
    expect(h.receiptNamed('/queue 未插话')).toMatchObject({ state: 'failed' });
    expect(h.markdownOf(h.receiptNamed('/queue 未插话'))).toContain('不支持插话');
    expect((await h.runtime.getTasks(await h.sessionId())).find(task => task.prompt.includes('第二件事'))?.status).toBe('queued');
  });
});

describe('/tasks 行内带上 Agent 与工作区', () => {
  it('任务行显示 Agent 显示名', async () => {
    const h = await harness();
    await h.dispatch('om_1', '第一件事');
    await h.coordinator.handle(event('om_tasks', '/tasks'), h.config);
    await vi.waitFor(() => expect(h.cards.map(card => h.markdownOf(card)).join('\n')).toContain('Mock Agent'));
  });
});

describe('/grant 与 /revoke 在聊天里开通对话权限', () => {
  const grantRole = async (h: Awaited<ReturnType<typeof harness>>) => {
    // 本部署形态下 admin 角色只能在 Web 授予；高风险授权是聊天里唯一能改群授权的身份。
    const bob = (await h.groupManager!.members('cli_cmd', 'oc_group')).members.find(member => member.openId === 'ou_bob')!;
    const current = (await h.groupManager!.groupAccess('cli_cmd', 'oc_group'))!;
    await h.groupManager!.save('cli_cmd', 'oc_group', { expectedRevision: current.revision, patch: {}, roleChanges: [
      { kind: 'create', principalId: bob.principalId, role: 'can_operate', operateScope: 'group_runs', actionGates: { terminalWrite: false, highRisk: true, groupToolsSend: false } }
    ] });
  };

  it('没有授权的成员改不动本群授权，且回执说清需要什么', async () => {
    const h = await harness({ managedGroup: true });
    await h.coordinator.handle(event('om_grant', '/grant'), h.config);
    expect(h.lastReceipt()).toMatchObject({ state: 'failed' });
    expect(h.markdownOf(h.lastReceipt())).toContain('权限');
    expect((await h.groupManager!.groupAccess('cli_cmd', 'oc_group'))!.override.mode).toBe('inherit');
  });

  it('有权限的成员用 /grant 放开全员、用 /revoke 收回', async () => {
    const h = await harness({ managedGroup: true });
    await grantRole(h);
    await h.coordinator.handle(event('om_grant', '/grant', { senderOpenId: 'ou_bob' }), h.config);
    expect(h.lastReceipt()).toMatchObject({ state: 'completed' });
    expect((await h.groupManager!.groupAccess('cli_cmd', 'oc_group'))!.override.mode).toBe('all_chat_members');

    await h.coordinator.handle(event('om_revoke', '/revoke', { senderOpenId: 'ou_bob' }), h.config);
    expect((await h.groupManager!.groupAccess('cli_cmd', 'oc_group'))!.override.mode).toBe('owner_only');
  });

  it("话题内免 @ 时，在接过的话题里不 @ 机器人发 /grant @成员 也生效（@ 是命令参数，不是在叫别人）", async () => {
    const h = await harness({ managedGroup: true, configPatch: { mentionPolicy: 'topic' } });
    await grantRole(h);
    await h.dispatch('om_task', '整理方案', 'ou_bob');
    await h.coordinator.handle(event('om_grant', '/grant @Alice', { senderOpenId: 'ou_bob',
      mentions: [{ key: '@_user_2', name: 'Alice', openId: 'ou_alice', mentionedType: 'user' }] }), h.config);
    expect((await h.groupManager!.groupAccess('cli_cmd', 'oc_group'))!.override.mode).toBe('allowlist');
  });

  it('/grant @成员 按 open_id 解析进名单，/revoke @成员 反向移出', async () => {
    const h = await harness({ managedGroup: true });
    await grantRole(h);
    await h.coordinator.handle(mentioning('om_grant', '/grant @Alice', { openId: 'ou_alice', name: 'Alice' }), h.config);
    const granted = (await h.groupManager!.groupAccess('cli_cmd', 'oc_group'))!;
    expect(granted.override.mode).toBe('allowlist');
    expect(granted.override.principalIds).toHaveLength(1);
    // 从「继承机器人默认」切成群名单会让原先按默认放行的人失效，回执必须说出来。
    const receipt = h.markdownOf(h.receiptNamed('/grant 已生效'));
    expect(receipt).toContain('继承机器人默认授权');
    expect(receipt).toContain('不再自动可用');
    // 群 access 不是「谁能用」的唯一口径：Web 上单独授予的角色不受影响，回执不能说成排他。
    expect(receipt).toContain('单独授予过角色');

    await h.coordinator.handle(mentioning('om_revoke', '/revoke @Alice', { openId: 'ou_alice', name: 'Alice' }), h.config);
    const revoked = (await h.groupManager!.groupAccess('cli_cmd', 'oc_group'))!;
    expect(revoked.override.mode).toBe('owner_only');
    expect(revoked.override.principalIds).toEqual([]);
  });

  it('本群还没有自己的名单时，/revoke @成员 说清没得移除，而不是顺手整体收回', async () => {
    const h = await harness({ managedGroup: true });
    await grantRole(h);
    await h.coordinator.handle(mentioning('om_revoke', '/revoke @Alice', { openId: 'ou_alice', name: 'Alice' }), h.config);
    expect(h.lastReceipt()).toMatchObject({ state: 'failed' });
    expect(h.markdownOf(h.lastReceipt())).toContain('名单');
    expect((await h.groupManager!.groupAccess('cli_cmd', 'oc_group'))!.override.mode).toBe('inherit');
  });

  it('成员解析不到就拒绝，绝不静默跳过', async () => {
    const h = await harness({ managedGroup: true });
    await grantRole(h);
    await h.coordinator.handle(mentioning('om_grant', '/grant @Carol', { openId: 'ou_carol', name: 'Carol' }), h.config);
    expect(h.lastReceipt()).toMatchObject({ state: 'failed' });
    expect(h.markdownOf(h.lastReceipt())).toContain('Carol');
    expect((await h.groupManager!.groupAccess('cli_cmd', 'oc_group'))!.override.mode).toBe('inherit');

    // 纯文字的名字不是提及，同样拒绝而不是当成「放开全员」。
    await h.coordinator.handle(event('om_grant_text', '/grant 张三', { senderOpenId: 'ou_bob' }), h.config);
    expect(h.lastReceipt()).toMatchObject({ state: 'failed' });
    expect((await h.groupManager!.groupAccess('cli_cmd', 'oc_group'))!.override.mode).toBe('inherit');
  });

  it('群没有同步群配置时如实拒绝，而不是替用户新建一份', async () => {
    const h = await harness();
    await h.coordinator.handle(event('om_grant', '/grant'), h.config);
    // 没有 groupManager 时命令本身停用；回执必须说明原因而不是假装成功。
    expect(h.lastReceipt()).toMatchObject({ state: 'failed' });
    expect(h.markdownOf(h.lastReceipt())).toContain('群');
  });
});


describe('恢复已关闭会话与并行分身', () => {
  it('只列出同 scope 的已关闭非归档非空会话，默认恢复最近关闭的一条', async () => {
    const h = await harness({ answer: true }); h.release();
    await h.dispatch('om_old', '原始任务');
    const old = await h.sessionId();
    await vi.waitFor(async () => expect((await h.runtime.getTasks(old))[0]?.status).toBe('completed'));
    await h.coordinator.handle(event('om_new', '/new'), h.config);
    await h.coordinator.handle(event('om_second', '第二个任务'), h.config);
    let second = '';
    await vi.waitFor(async () => { second = (await h.runtime.listSessions()).find(s => s.id !== old)!.id; expect((await h.runtime.getTasks(second))[0]?.status).toBe('completed'); });
    await h.coordinator.handle(event('om_new2', '/new'), h.config);
    // A later metadata update is not a later closure.
    await h.repos.sessions.save({ ...(await h.runtime.getSession(old))!, updatedAt: '2099-01-01T00:00:00.000Z' });
    const other = await h.runtime.start({ agentId: 'mock', source: 'lark', sourceId: `${h.config.appId}:oc_other:group:thread:om_root`, permissionMode: 'ask' });
    await h.runtime.send(other.id, '跨聊天的任务不该出现', undefined, undefined, 'ou_alice');
    await h.runtime.stop(other.id);
    const otherThread = await h.runtime.start({ agentId: 'mock', source: 'lark', sourceId: `${h.config.appId}:oc_group:group:thread:om_other_root`, permissionMode: 'ask' });
    await h.runtime.send(otherThread.id, '同聊天其他话题的任务不该出现', undefined, undefined, 'ou_alice');
    await h.runtime.stop(otherThread.id);
    const empty = await h.runtime.start({ agentId: 'mock', source: 'lark', sourceId: `${h.config.appId}:oc_group:group:thread:om_root`, permissionMode: 'ask' });
    await h.runtime.stop(empty.id);
    await h.coordinator.handle(event('om_wrong', `/resume ${other.id}`), h.config);
    expect(h.markdownOf(h.lastReceipt())).toContain('没有这个可见的已关闭会话');
    await h.coordinator.handle(event('om_wrong_thread', `/resume ${otherThread.id}`), h.config);
    expect(h.markdownOf(h.lastReceipt())).toContain('没有这个可见的已关闭会话');
    await h.coordinator.handle(event('om_list', '/resume list'), h.config);
    const list = h.markdownOf(h.lastReceipt());
    expect(list).toContain('原始任务'); expect(list).toContain('第二个任务'); expect(list).not.toContain(other.id); expect(list).not.toContain(otherThread.id); expect(list).not.toContain(empty.id); expect(list).not.toContain('2099-01-01'); expect(list.indexOf(second)).toBeLessThan(list.indexOf(old));
    await h.coordinator.handle(event('om_resume', '/resume'), h.config);
    expect(h.markdownOf(h.lastReceipt())).toContain(`已恢复会话 \`${second}\``);
    expect((await h.runtime.getSession(second))?.state).toBe('idle');
    const rebuilt = h.createCoordinator(); await rebuilt.initializeWorkflows(h.config);
    await rebuilt.handle(event('om_after', '恢复后的任务'), h.config);
    await vi.waitFor(async () => expect((await h.runtime.getTasks(second)).some(t => t.prompt.includes('恢复后的任务'))).toBe(true));
    rebuilt.stop();
  });

  it('all_chat_members 只能列出和恢复自己有 run.resume 权限的会话', async () => {
    const h = await harness({ managedGroup: true, answer: true }); h.release();
    const access = (await h.groupManager!.groupAccess(h.config.appId, 'oc_group'))!;
    await h.groupManager!.save(h.config.appId, 'oc_group', { expectedRevision: access.revision, patch: { accessOverride: { mode: 'all_chat_members', principalIds: [] } } });
    await h.dispatch('om_old', 'Alice 的旧任务');
    const old = await h.sessionId();
    await vi.waitFor(async () => expect((await h.runtime.getTasks(old))[0]?.status).toBe('completed'));
    await h.coordinator.handle(event('om_new', '/new'), h.config);
    await h.coordinator.handle(event('om_bob_list', '/resume list', { senderOpenId: 'ou_bob' }), h.config);
    expect(h.markdownOf(h.lastReceipt())).not.toContain(old);
    await h.coordinator.handle(event('om_bob_resume', `/resume ${old}`, { senderOpenId: 'ou_bob' }), h.config);
    expect((await h.runtime.getSession(old))?.state).toBe('stopped');
    await h.coordinator.handle(event('om_alice_resume', `/resume ${old}`), h.config);
    expect((await h.runtime.getSession(old))?.state).toBe('idle');
  });

  it('无法核实原请求人时不列出或恢复已关闭会话', async () => {
    const h = await harness({ answer: true }); h.release();
    const old = await h.runtime.start({ agentId: 'mock', source: 'lark', sourceId: `${h.config.appId}:oc_group:group:thread:om_root`, permissionMode: 'ask' });
    await h.runtime.send(old.id, '没有飞书来源映射的旧任务', undefined, undefined, 'ou_alice');
    await h.runtime.stop(old.id);
    await h.coordinator.handle(event('om_list', '/resume list'), h.config);
    expect(h.markdownOf(h.lastReceipt())).not.toContain(old.id);
    await h.coordinator.handle(event('om_resume', `/resume ${old.id}`), h.config);
    expect((await h.runtime.getSession(old.id))?.state).toBe('stopped');
  });

  it('不支持恢复时保留当前会话并明确提示交接', async () => {
    const h = await harness({ answer: true }); h.release(); await h.dispatch('om_old', '旧任务');
    const id = await h.sessionId();
    await vi.waitFor(async () => expect((await h.runtime.getTasks(id))[0]?.status).toBe('completed'));
    await h.coordinator.handle(event('om_new', '/new'), h.config);
    const listAgents = h.runtime.listAgents.bind(h.runtime);
    h.runtime.listAgents = async () => (await listAgents()).map(a => ({ ...a, capabilities: { pause: false, resume: false } }));
    await h.coordinator.handle(event('om_resume', '/resume'), h.config);
    expect(h.markdownOf(h.lastReceipt())).toContain('不支持恢复');
    expect(h.markdownOf(h.lastReceipt())).toContain('/new --handoff');
    expect((await h.runtime.getSession(id))?.state).toBe('stopped');
  });

  it('ACP 分身用交接，保留原会话正在执行的任务和排队内容', async () => {
    const h = await harness();
    await h.dispatch('om_task', '第一条任务'); await h.waitRunning('第一条任务');
    await h.dispatch('om_queue', '排队任务');
    const id = await h.sessionId(); const before = await h.runtime.getTasks(id); const source = await h.runtime.getSession(id);
    h.config.defaultAgentWeights = [{ agentId: 'spare', weight: 100 }];
    await h.coordinator.handle(event('om_fork', '/fork 检查另一种实现'), h.config);
    expect(h.markdownOf(h.lastReceipt())).toContain('已在新话题开分身');
    // 原会话还在执行，updatedAt 会随事件变化；其余字段（状态、绑定、配置）必须不变。
    expect({ ...(await h.runtime.getSession(id)), updatedAt: undefined }).toEqual({ ...source, updatedAt: undefined });
    expect((await h.runtime.getTasks(id)).map(task => ({ ...task, updatedAt: undefined }))).toEqual(before.map(task => ({ ...task, updatedAt: undefined })));
    await vi.waitFor(async () => expect(await h.runtime.listSessions()).toHaveLength(2));
    const child = (await h.runtime.listSessions()).find(s => s.id !== id)!;
    expect(child.sourceId).toContain(':thread:om_card_');
    expect(child.agentId).toBe(source!.agentId);
    await vi.waitFor(async () => expect((await h.runtime.getTasks(child.id))[0]?.status).toBe('running'));
    await vi.waitFor(() => expect(h.prompts).toEqual(expect.arrayContaining([expect.stringContaining('会话交接')])));
    expect(h.service.sendText.mock.calls[0]![0].text).toContain('最近结果');
  });

  it('Claude 有落盘上下文时传递原生分身 ID，并默认独立 worktree', async () => {
    const h = await harness({ native: true, configPatch: { permissionMode: 'full-trust' } });
    execFileSync('git', ['init', '-q', h.cwd]);
    execFileSync('git', ['-C', h.cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '--allow-empty', '-qm', 'initial']);
    await h.dispatch('om_task', '源任务'); await h.waitRunning('源任务');
    const id = await h.sessionId();
    const nativeId = pinnedSessionUuid(id);
    const dir = claudeProjectDir(h.cwd, h.agents[0]!.env); await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${nativeId}.jsonl`), JSON.stringify({ type: 'user', sessionId: nativeId, message: { role: 'user', content: buildSessionMarker(id) } }) + '\n');
    await h.coordinator.handle(event('om_fork', '/fork 并行任务'), h.config);
    await vi.waitFor(() => expect(h.forks).toContain(nativeId));
    const child = (await h.runtime.listSessions()).find(s => s.id !== id)!;
    expect(child.workspaceMode).toBe('worktree'); expect(child.cwd).not.toBe(h.cwd);
    expect(h.service.sendText.mock.calls[0]![0].text).toContain('不含原会话未提交的改动');
    expect((await h.runtime.getTasks(id))[0]?.status).toBe('running');
  });

  it.each([false, true])('机器人收紧为 ask 后分身使用当前权限，native=%s', async native => {
    const h = await harness({ native, configPatch: { permissionMode: 'full-trust' } });
    await h.dispatch('om_permission_source', '源任务'); await h.waitRunning('源任务');
    await vi.waitFor(() => expect(h.prompts).toHaveLength(1));
    const id = await h.sessionId();
    if (native) {
      const nativeId = pinnedSessionUuid(id);
      const dir = claudeProjectDir(h.cwd, h.agents[0]!.env); await mkdir(dir, { recursive: true });
      await writeFile(join(dir, `${nativeId}.jsonl`), JSON.stringify({ type: 'user', sessionId: nativeId, message: { role: 'user', content: buildSessionMarker(id) } }) + '\n');
    }
    h.config.permissionMode = 'ask';
    await h.repos.config.set(larkBotsConfigKey, JSON.stringify([h.config]));
    const before = await h.runtime.getTasks(id);
    await h.coordinator.handle(event('om_permission_fork', '/fork 按当前权限检查'), h.config);
    const child = (await h.runtime.listSessions()).find(s => s.id !== id)!;
    expect(child.permissionMode).toBe('ask');
    expect((await h.runtime.getSession(id))?.permissionMode).toBe('full-trust');
    expect((await h.runtime.getTasks(id)).map(task => ({ ...task, updatedAt: undefined }))).toEqual(before.map(task => ({ ...task, updatedAt: undefined })));
    expect(h.forks.filter(Boolean)).toEqual(native ? [pinnedSessionUuid(id)] : []);
    const binding = await h.repos.channelMappings.get(`lark-launch:${h.config.appId}`, child.sourceId!);
    expect(JSON.parse(binding!.extra!)).not.toHaveProperty('permissionMode');
  });

  it('权限收紧后拒绝恢复旧权限，当前会话和队列不受影响', async () => {
    const h = await harness({ answer: true, configPatch: { permissionMode: 'full-trust' } }); h.release();
    await h.dispatch('om_old', '旧任务'); const old = await h.sessionId();
    await vi.waitFor(async () => expect((await h.runtime.getTasks(old))[0]?.status).toBe('completed'));
    await h.coordinator.handle(event('om_new', '/new'), h.config);
    h.config.permissionMode = 'approve-reads';
    await h.repos.config.set(larkBotsConfigKey, JSON.stringify([h.config]));
    await h.coordinator.handle(event('om_current', '当前任务'), h.config);
    let current = '';
    await vi.waitFor(async () => { current = (await h.runtime.listSessions()).find(s => s.id !== old)!.id; expect((await h.runtime.getTasks(current))[0]?.status).toBe('completed'); });
    const before = await h.runtime.getSession(current);
    await h.coordinator.handle(event('om_resume', `/resume ${old}`), h.config);
    expect(h.markdownOf(h.lastReceipt())).toContain('不能恢复旧权限');
    expect(await h.runtime.getSession(current)).toEqual(before);
  });

  it('换 Agent 时用交接，不继承原 Agent 的模型；私聊 thread 模式建立独立 scope', async () => {
    const h = await harness({ native: true, configPatch: { permissionMode: 'full-trust', defaultModel: 'claude-source-model', p2pMode: 'thread' } });
    await h.coordinator.handle(event('om_dm', '源任务', { chatType: 'p2p', threadId: undefined, rootId: undefined }), h.config);
    let source = '';
    await vi.waitFor(async () => { source = (await h.runtime.listSessions())[0]!.id; expect((await h.runtime.getTasks(source))[0]?.status).toBe('running'); });
    await h.coordinator.handle(event('om_fork', '/fork --agent spare -- 并行检查', { chatType: 'p2p', threadId: 'omt_dm', rootId: 'om_dm' }), h.config);
    await vi.waitFor(async () => expect((await h.runtime.listSessions()).filter(s => s.agentId === 'spare')).toHaveLength(1));
    const child = (await h.runtime.listSessions()).find(s => s.agentId === 'spare')!;
    expect(child.model).toBeFalsy(); expect(child.reasoningEffort).toBeFalsy();
    expect(child.sourceId).toContain(':p2p:thread:om_card_');
    expect(h.forks.every(id => id === undefined)).toBe(true);
    expect(h.service.sendText.mock.calls[0]![0].text).toContain('交接');
  });

  it('未提交过的 git 仓库无法创建分身 worktree 时，不回成功且不影响源会话', async () => {
    const h = await harness();
    execFileSync('git', ['init', '-q', h.cwd]);
    await h.dispatch('om_task', '原任务继续'); await h.waitRunning('原任务继续');
    await vi.waitFor(() => expect(h.prompts).toHaveLength(1));
    const id = await h.sessionId(), source = await h.runtime.getSession(id), tasks = await h.runtime.getTasks(id);
    await h.coordinator.handle(event('om_fork', '/fork 并行检查'), h.config);
    expect(h.markdownOf(h.lastReceipt())).toContain('新话题已创建，但分身未启动');
    expect(h.markdownOf(h.lastReceipt())).toContain('https://example.test/message/');
    expect({ ...(await h.runtime.getSession(id)), updatedAt: undefined }).toEqual({ ...source, updatedAt: undefined });
    expect((await h.runtime.getTasks(id)).map(task => ({ ...task, updatedAt: undefined }))).toEqual(tasks.map(task => ({ ...task, updatedAt: undefined })));
    const child = (await h.runtime.listSessions()).find(s => s.id !== id)!;
    expect(child.state).toBe('failed'); expect(await h.runtime.getTasks(child.id)).toHaveLength(0);
  });

  it('整段私聊和非原请求人的分身请求明确拒绝', async () => {
    const h = await harness();
    await h.coordinator.handle(event('om_p2p', '/fork 任务', { chatType: 'p2p', threadId: undefined, rootId: undefined }), h.config);
    expect(h.markdownOf(h.lastReceipt())).toContain('每条消息一个话题');
    await h.dispatch('om_task', '源任务'); await h.waitRunning('源任务');
    await h.coordinator.handle(event('om_fork', '/fork 任务', { senderOpenId: 'ou_bob' }), h.config);
    expect(h.markdownOf(h.lastReceipt())).toContain('第一条任务发起人');
    expect(h.service.sendText).not.toHaveBeenCalled();
  });
});
