// 提取与整理管线的端到端回归：真实 DutydeckRuntime + SQLite + 真实 LarkMessageCoordinator。
// mock driver 按会话 source 分流：用户会话回普通答案，lark-memory 会话按 prompt 回 facts / actions
// 的 ```json，从而在不起真实 Agent 的前提下跑通「完成轮次 → 记账 → 提取 → 门禁 → 落账本 → 下一轮索引」。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepositories } from '@dutydeck/storage';
import { DutydeckRuntime, type AgentDriver } from '@dutydeck/runtime';
import { RuntimeError, type AgentConfig, type PermissionMode } from '@dutydeck/shared';
import { LarkMessageCoordinator } from './coordinator.js';
import { larkBotsConfigKey, readLarkConfigs, type StoredLarkConfig } from './config.js';
import type { LarkMessageEvent } from './listener.js';
import { larkMemoryScope, LarkMemoryStore } from './memory.js';
import { LarkMemoryProjection } from './memory-view.js';
import { LarkMemoryPipeline } from './memory-pipeline.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const scope = larkMemoryScope('cli_memory', 'oc_group', 'group');

const event = (id: string, text: string, patch: Partial<LarkMessageEvent> = {}): LarkMessageEvent => ({
  messageId: id, chatId: 'oc_group', chatType: 'group', threadId: 'omt_topic', rootId: 'om_root',
  senderOpenId: 'ou_alice', senderType: 'user', messageType: 'text', content: JSON.stringify({ text }),
  mentions: [{ key: '@_user_1', name: 'Dock', openId: 'ou_bot' }], ...patch
});

const jsonBlock = (value: unknown) => `分析完成。\n\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;

/** 记忆会话的回复计划：文本，外加可选的延迟（用来构造超时与单飞场景）。 */
type MemoryReply = { text: string; delayMs?: number };

/** 记忆会话的 start 入参；用例用它断言权限模式与复用次数。 */
type StartInput = { agentId: string; cwd?: string; model?: string; permissionMode?: PermissionMode };

async function harness(options: { timeoutMs?: number; agentModel?: string; userAnswer?: string; startGuard?: (input: StartInput) => void } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'dutydeck-lark-memory-pipeline-'));
  const repos = createRepositories(join(cwd, 'state.db'), { newDatabaseAuthority: 'ledger_v1' });
  const prompts: string[] = [];
  const memoryPrompts: string[] = [];

  // 默认什么都不提取、什么都不整理；每个用例按需覆盖。
  let respond: (prompt: string) => MemoryReply = prompt => ({
    text: prompt.includes('后台提取') ? jsonBlock({ facts: [] }) : jsonBlock({ actions: [{ op: 'noop' }] })
  });

  const runtime = new DutydeckRuntime(repos, {
    probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }),
    driverFactory: (_config, _protocol, emit, _onExit, sessionId) => {
      const driver: AgentDriver = {
        start: async () => {}, resume: async () => {}, stop: async () => {}, interrupt: async () => {},
        send: async prompt => {
          const session = await repos.sessions.get(sessionId);
          if (session?.source === 'lark-memory') {
            memoryPrompts.push(prompt);
            const reply = respond(prompt);
            if (reply.delayMs) await new Promise(resolve => setTimeout(resolve, reply.delayMs));
            emit({ type: 'text', data: { text: reply.text } });
            emit({ type: 'completed', data: { stopReason: 'end_turn' } });
            return;
          }
          prompts.push(prompt);
          emit({ type: 'text', data: { text: options.userAnswer ?? '工作已完成' } });
          emit({ type: 'completed', data: { stopReason: 'end_turn' } });
        }
      };
      return driver;
    }
  });
  const agent: AgentConfig = { id: 'mock', name: 'Mock', command: process.execPath, args: [], protocol: 'acp', cwd, env: {}, permissionMode: 'ask', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false,
    ...(options.agentModel ? { model: options.agentModel } : {}) };
  await runtime.initialize([agent]);

  const config: StoredLarkConfig = { appId: scope.appId, appSecret: 'fake-secret', workspace: cwd, defaultAgentId: 'mock', permissionMode: 'ask', listening: true,
    fullTrustConfirmed: true, preInjectPrompt: '', structuredAskCards: false, groupCardMention: false, groupToolsEnabled: false, groupToolsAllowSend: false, pushIntervalMs: 1_000, hideTraceOnComplete: false,
    allowedUsers: [], allowedEmails: [], allowedBots: [], peerBotsAllowed: false, highRiskAllowedUsers: [], highRiskAllowedEmails: [], highRiskPattern: 'dangerous', riskControlMode: 'off' };
  await repos.config.set(larkBotsConfigKey, JSON.stringify([config]));

  const cards: Array<Record<string, unknown>> = [];
  let nextCard = 0;
  const createCard = async (input: Record<string, unknown>) => { cards.push(input); return { messageId: `om_card_${++nextCard}` }; };
  const service = {
    send: vi.fn(createCard), reply: vi.fn(createCard),
    uploadFile: vi.fn(async () => 'file_1'), replyFile: vi.fn(createCard), sendFile: vi.fn(createCard),
    update: vi.fn(async (input: { messageId: string }) => ({ messageId: input.messageId })),
    addReaction: vi.fn(async (messageId: string, emojiType = 'OK') => ({ messageId, reactionId: `reaction_${messageId}_${emojiType}` })),
    deleteReaction: vi.fn(async () => {}), getUserEmails: vi.fn(async () => [] as string[]),
    listChatMembers: vi.fn(async () => ({ items: [{ memberId: 'ou_alice' }], hasMore: false })),
    listChatMessages: vi.fn(async () => ({ items: [] as unknown[], hasMore: false })),
    getMessage: vi.fn(async (id: string) => ({ messageId: id, chatId: 'oc_group', threadId: 'omt_topic', messageType: 'text', rawContent: JSON.stringify({ text: '引用' }), sender: { type: 'user' }, mentions: [] })),
    getMessageItems: vi.fn(async () => [] as unknown[]),
    downloadMessageResource: vi.fn(async () => ({ data: new Uint8Array(), contentType: 'text/plain' })),
    readDocument: vi.fn(async (url: string) => ({ url, title: '文档', text: '' }))
  };
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  let projection!: LarkMemoryProjection;
  const store = new LarkMemoryStore(repos.config, { onChange: target => projection.write(target) });
  projection = new LarkMemoryProjection(store, join(cwd, 'memory'), log);

  // 只有 interrupt 走替身：超时用例要断言管线确实发了中断，又不能让真实中断与 mock driver 的
  // 延迟回复互相抢同一个任务的终态。
  const memoryInterrupt = vi.fn(async (_id: string, _taskId?: string, _actor?: string) => ({ interrupted: false, reason: 'test_unconfirmed' }));
  // start 也走替身：记录每次入参，并让用例模拟 runtime 拒绝某个权限模式（PTY 类 Agent）。
  const startCalls: StartInput[] = [];
  const pipeline = new LarkMemoryPipeline({
    runtime: {
      start: input => { startCalls.push(input); options.startGuard?.(input); return runtime.start(input); },
      listAgents: () => runtime.listAgents(),
      listSessions: () => runtime.listSessions(),
      dispatch: (id, prompt, mode, agentPrompt) => runtime.dispatch(id, prompt, mode, agentPrompt),
      getTasks: id => runtime.getTasks(id),
      getTaskRecovery: (id, taskId) => runtime.getTaskRecovery(id, taskId),
      cancelQueued: (id, taskId, actor, revision) => runtime.cancelQueued(id, taskId, actor, revision),
      archive: (id, actor) => runtime.archive(id, actor),
      interrupt: memoryInterrupt,
      subscribe: (id, listener) => runtime.subscribe(id, listener)
    },
    controlActorId: 'installation_owner',
    repos: { execution: repos.execution },
    store,
    projection,
    readConfig: async appId => (await readLarkConfigs(repos.config)).find(bot => bot.appId === appId),
    log,
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {})
  });

  const coordinator = new LarkMessageCoordinator(
    runtime, service as any, log, Math.random, 'ou_bot', undefined, repos.channelMappings,
    async () => 'group', undefined, undefined,
    { store: repos.config, memory: { store, projection, command: 'dutydeck', pipeline } }
  );
  await coordinator.initializeWorkflows(config);
  cleanups.push(async () => { coordinator.stop(); await runtime.shutdown(); repos.close(); await rm(cwd, { recursive: true, force: true }); });

  const setConfig = async (patch: Partial<StoredLarkConfig>) => {
    const next = { ...config, ...patch };
    await repos.config.set(larkBotsConfigKey, JSON.stringify([next]));
    return next;
  };
  /**
   * 等管线彻底停下来。
   * drain 会连跑多轮，release 与下一次 claim 之间有空隙，只看一眼可能刚好落在空隙里，
   * 用例就会在 drain 还在飞行时结束，后续写入会打到已经关掉的库上。
   */
  const waitIdle = () => vi.waitFor(async () => {
    expect((await store.getState(scope)).running).toBeUndefined();
    await new Promise(resolve => setTimeout(resolve, 80));
    expect((await store.getState(scope)).running).toBeUndefined();
  }, { timeout: 15_000 });
  const lastCardText = () => JSON.stringify(cards.at(-1) ?? {});
  const waitPrompts = (count: number) => vi.waitFor(() => expect(prompts).toHaveLength(count), { timeout: 15_000 });
  /** 跑 n 个普通任务轮次，逐轮等待 driver 收到 prompt。 */
  const runTurns = async (count: number, current: StoredLarkConfig = config) => {
    for (let index = 0; index < count; index++) {
      const before = prompts.length;
      await coordinator.handle(event(`om_turn_${Date.now()}_${index}`, `第 ${index + 1} 个任务`), current);
      await vi.waitFor(() => expect(prompts.length).toBe(before + 1), { timeout: 15_000 });
    }
  };

  return {
    cwd, repos, runtime, coordinator, store, projection, pipeline, config, cards, prompts, memoryPrompts, log,
    memoryInterrupt, startCalls, lastCardText, waitIdle, waitPrompts, runTurns, setConfig,
    setResponder: (next: (prompt: string) => MemoryReply) => { respond = next; }
  };
}

/** 从整理 prompt 的条目清单里取出「id → source」。 */
const listedEntries = (prompt: string) =>
  [...prompt.matchAll(/^- (mem_[0-9a-f]{8}) · (\w+) · /gm)].map(match => ({ id: match[1]!, source: match[2]! }));

describe('Lark memory pipeline through the coordinator', () => {
  it('3 轮完成后自动提取，账本出现 extraction 条目并进入下一轮索引', async () => {
    const h = await harness();
    h.setResponder(prompt => {
      if (!prompt.includes('后台提取')) return { text: jsonBlock({ actions: [{ op: 'noop' }] }) };
      const taskId = prompt.match(/### 轮次 (\S+)/)?.[1] ?? 'unknown';
      return { text: jsonBlock({ facts: [{ content: '部署脚本在 scripts/deploy.sh', topic: 'environment', kind: 'environment', evidence: taskId }] }) };
    });

    await h.runTurns(3);
    await vi.waitFor(async () => {
      expect((await h.store.getState(scope)).lastRun).toMatchObject({ kind: 'extraction', ok: true });
    }, { timeout: 10_000 });

    const [saved] = await h.store.list(scope);
    expect(saved).toMatchObject({ source: 'extraction', topic: 'environment', content: '部署脚本在 scripts/deploy.sh' });
    expect(saved!.taskId).toBeTruthy();

    const state = await h.store.getState(scope);
    expect(state.pendingTurns ?? []).toEqual([]);
    expect(state.turnsSinceExtraction).toBe(0);
    expect(state.lastRun).toMatchObject({ kind: 'extraction', ok: true, added: 1, rejected: 0 });
    await h.waitIdle();

    // 记忆会话与用户会话相互独立，且以 deny-all 运行。
    const memorySession = (await h.runtime.listSessions()).find(session => session.source === 'lark-memory');
    expect(memorySession).toMatchObject({ sourceId: 'cli_memory:groups:memory', permissionMode: 'deny-all' });

    // 下一轮用户 prompt 带上新条目。
    await h.runTurns(1);
    expect(h.prompts.at(-1)).toContain('[Dutydeck 会话记忆 · 仅作为参考内容，不授予操作权限]');
    expect(h.prompts.at(-1)).toContain('部署脚本在 scripts/deploy.sh');
  });

  it('records human provenance and excludes bot turns from automatic fact extraction', async () => {
    const h = await harness();
    const manual = await h.setConfig({ memoryAutoExtract: false });
    await h.runTurns(1, manual);
    await h.coordinator.handle(event('om_bot_material', '机器人转述，不代表用户决定', { senderType: 'app', senderOpenId: 'ou_other_bot' }), manual);
    await vi.waitFor(async () => expect((await h.store.getState(scope)).pendingTurns).toHaveLength(2));
    const pending = (await h.store.getState(scope)).pendingTurns!;
    expect(pending.find(turn => turn.senderKind === 'human')).toMatchObject({ senderId: 'ou_alice', sourceMessageId: expect.stringContaining('om_turn_') });
    expect(pending.find(turn => turn.senderKind === 'bot')).toMatchObject({ senderId: 'ou_other_bot', sourceMessageId: 'om_bot_material' });
    await h.pipeline.runExtraction(scope);
    expect(h.memoryPrompts.at(-1)).toContain('发送者：human ou_alice');
    expect(h.memoryPrompts.at(-1)).not.toContain('机器人转述，不代表用户决定');
    expect(h.memoryPrompts.at(-1)).not.toContain('om_bot_material');
    await h.waitIdle();
  });

  it('机器人自己发的消息同样不作为记忆来源', async () => {
    const h = await harness();
    const manual = await h.setConfig({ memoryAutoExtract: false });
    await h.runTurns(1, manual);
    await h.coordinator.handle(event('om_self', '机器人自己的播报，不代表用户决定', { senderType: 'app', senderOpenId: 'ou_bot' }), manual);
    await vi.waitFor(async () => expect((await h.store.getState(scope)).pendingTurns).toHaveLength(2));
    expect((await h.store.getState(scope)).pendingTurns!.find(turn => turn.sourceMessageId === 'om_self')).toMatchObject({ senderKind: 'bot', senderId: 'ou_bot' });
    await h.pipeline.runExtraction(scope);
    expect(h.memoryPrompts.at(-1)).toContain('发送者：human ou_alice');
    expect(h.memoryPrompts.at(-1)).not.toContain('机器人自己的播报');
    expect(h.memoryPrompts.at(-1)).not.toContain('om_self');
    await h.waitIdle();
  });

  it('提取遵守「不许记」规则：规则进 prompt，命中的事实不写入；写入的事实挂在证据轮次上', async () => {
    const h = await harness();
    const rule = await h.store.addIgnoreRule(scope, { text: '不要记任何人的薪资' });
    h.setResponder(prompt => {
      if (!prompt.includes('后台提取')) return { text: jsonBlock({ actions: [{ op: 'noop' }] }) };
      const taskId = prompt.match(/### 轮次 (\S+)/)?.[1] ?? 'unknown';
      return { text: jsonBlock({ facts: [
        { content: '张三的薪资是 30k', topic: 'contacts', kind: 'other', evidence: taskId },
        { content: '部署脚本在 scripts/deploy.sh', topic: 'environment', kind: 'environment', evidence: taskId }
      ] }) };
    });
    await h.runTurns(3);
    await vi.waitFor(async () => {
      expect((await h.store.getState(scope)).lastRun).toMatchObject({ kind: 'extraction', ok: true, added: 1, rejected: 1 });
    }, { timeout: 10_000 });
    await h.waitIdle();
    expect(h.memoryPrompts.find(prompt => prompt.includes('后台提取'))).toContain(`- ${rule.id}：不要记任何人的薪资`);
    const saved = await h.store.list(scope);
    expect(saved.map(entry => entry.content)).toEqual(['部署脚本在 scripts/deploy.sh']);
    expect(h.log.warn).toHaveBeenCalledWith(expect.objectContaining({ rejected: [expect.objectContaining({ reason: `命中「不许记」规则 ${rule.id}` })] }), '会话记忆提取有条目未通过门禁');
    // 拒绝原因进日志，被拒的内容本身不进。
    expect(JSON.stringify(h.log.warn.mock.calls)).not.toContain('薪资是 30k');
    // 记下的事实挂在证据轮次上：该轮的结果卡与 Web 任务详情据此列出「新记下」。
    const [chatSession] = (await h.runtime.listSessions()).filter(session => session.source === 'lark');
    const view = await h.store.turn(chatSession!.id, saved[0]!.taskId!);
    expect(view?.written.map(entry => entry.id)).toEqual([saved[0]!.id]);
  });

  it('memoryAutoExtract=false 时不自动触发，但仍然记账', async () => {
    const h = await harness();
    const disabled = await h.setConfig({ memoryAutoExtract: false });
    h.setResponder(() => { throw new Error('不应触发记忆会话'); });

    await h.runTurns(4, disabled);
    await vi.waitFor(async () => expect((await h.store.getState(scope)).turnsSinceExtraction).toBe(4));
    expect(await h.store.list(scope)).toEqual([]);
    expect((await h.store.getState(scope)).lastRun).toBeUndefined();
    expect(h.memoryPrompts).toEqual([]);
  });

  it('8 轮后整理：merge 产生 consolidation 条目并 supersede，用户条目内容不变', async () => {
    const h = await harness();
    let extracted = 0;
    h.setResponder(prompt => {
      if (prompt.includes('后台提取')) {
        const taskId = prompt.match(/### 轮次 (\S+)/)?.[1] ?? 'unknown';
        if (extracted++ > 0) return { text: jsonBlock({ facts: [] }) };
        return { text: jsonBlock({ facts: [
          { content: '后端服务用 Go 写', topic: 'stack', kind: 'environment', evidence: taskId },
          { content: '后端仓库是 Go 项目', topic: 'stack', kind: 'environment', evidence: taskId }
        ] }) };
      }
      const merged = listedEntries(prompt).filter(item => item.source === 'extraction').map(item => item.id);
      if (merged.length < 2) return { text: jsonBlock({ actions: [{ op: 'noop' }] }) };
      return { text: jsonBlock({ actions: [{ op: 'merge', ids: merged, content: '后端是 Go 项目', topic: 'stack' }] }) };
    });

    await h.coordinator.handle(event('om_remember', '/remember 这个群的回复统一用中文'), h.config);
    await vi.waitFor(() => expect(h.lastCardText()).toContain('已记住'));

    await h.runTurns(8);
    await vi.waitFor(async () => {
      expect((await h.store.getState(scope)).lastRun).toMatchObject({ kind: 'consolidation', ok: true });
    }, { timeout: 20_000 });

    const live = await h.store.list(scope);
    const consolidated = live.find(entry => entry.source === 'consolidation');
    expect(consolidated).toMatchObject({ content: '后端是 Go 项目', topic: 'stack' });
    expect(consolidated!.supersedes).toHaveLength(2);
    expect(live.filter(entry => entry.source === 'extraction')).toEqual([]);

    const userEntry = live.find(entry => entry.source === 'user');
    expect(userEntry).toMatchObject({ content: '这个群的回复统一用中文' });

    const state = await h.store.getState(scope);
    expect(state.turnsSinceConsolidation).toBe(0);
    expect(state.lastConsolidationAt).toBeTruthy();
    await h.waitIdle();
  });

  it('门禁拒绝改写用户条目：重试一次仍违规则整轮不写入', async () => {
    const h = await harness();
    h.setResponder(prompt => {
      if (prompt.includes('后台提取')) return { text: jsonBlock({ facts: [] }) };
      const userEntry = listedEntries(prompt).find(item => item.source === 'user')!;
      return { text: jsonBlock({ actions: [{ op: 'update', id: userEntry.id, content: '被 Agent 改写的用户原话', topic: 'general' }] }) };
    });

    await h.coordinator.handle(event('om_remember', '/remember 这个群的回复统一用中文'), h.config);
    await vi.waitFor(() => expect(h.lastCardText()).toContain('已记住'));

    await h.coordinator.handle(event('om_consolidate', '/memory consolidate'), h.config);
    await vi.waitFor(() => expect(h.lastCardText()).toContain('已开始整理'));

    await vi.waitFor(async () => {
      expect((await h.store.getState(scope)).lastRun).toMatchObject({ kind: 'consolidation', ok: false, added: 0, error: 'MEMORY_GATE_REJECTED' });
    }, { timeout: 15_000 });

    const consolidationPrompts = h.memoryPrompts.filter(prompt => prompt.includes('后台整理'));
    expect(consolidationPrompts).toHaveLength(2);
    expect(consolidationPrompts[1]).toContain('违规清单：');

    const live = await h.store.list(scope);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ source: 'user', content: '这个群的回复统一用中文' });
    await h.waitIdle();
  });

  it('/memory consolidate 单飞：运行中的第二次请求回「整理正在进行中」', async () => {
    const h = await harness();
    h.setResponder(prompt => ({
      text: prompt.includes('后台提取') ? jsonBlock({ facts: [] }) : jsonBlock({ actions: [{ op: 'noop' }] }),
      delayMs: 400
    }));

    await h.coordinator.handle(event('om_remember', '/remember 这个群的回复统一用中文'), h.config);
    await vi.waitFor(() => expect(h.lastCardText()).toContain('已记住'));

    await h.coordinator.handle(event('om_consolidate_1', '/memory consolidate'), h.config);
    expect(h.lastCardText()).toContain('已开始整理');

    await h.coordinator.handle(event('om_consolidate_2', '/memory consolidate'), h.config);
    expect(h.lastCardText()).toContain('整理正在进行中');

    await vi.waitFor(async () => {
      expect((await h.store.getState(scope)).lastRun).toMatchObject({ kind: 'consolidation', ok: true });
    }, { timeout: 15_000 });
    expect(h.memoryPrompts.filter(prompt => prompt.includes('后台整理'))).toHaveLength(1);
  });

  it('并发记账不互相覆盖，同一轮次重放也不重复计数', async () => {
    const h = await harness();
    // 关掉自动触发，隔离出纯记账行为：否则第 3 轮会顺手把 pendingTurns 消费掉。
    await h.setConfig({ memoryAutoExtract: false });

    await Promise.all([1, 2, 3].map(index =>
      h.pipeline.onTurnCompleted(scope, { sessionId: 'ses_fake', taskId: `task_concurrent_${index}` })));
    const state = await h.store.getState(scope);
    expect(state.turnsSinceExtraction).toBe(3);
    expect(state.turnsSinceConsolidation).toBe(3);
    expect(state.pendingTurns).toHaveLength(3);

    await h.pipeline.onTurnCompleted(scope, { sessionId: 'ses_fake', taskId: 'task_concurrent_2' });
    expect((await h.store.getState(scope)).turnsSinceExtraction).toBe(3);
  });

  it('并发的整理请求只有一个抢到单飞占位', async () => {
    const h = await harness();
    h.setResponder(() => ({ text: jsonBlock({ actions: [{ op: 'noop' }] }), delayMs: 300 }));
    await h.coordinator.handle(event('om_remember', '/remember 这个群的回复统一用中文'), h.config);
    await vi.waitFor(() => expect(h.lastCardText()).toContain('已记住'));

    const outcomes = await Promise.all([1, 2, 3].map(() => h.pipeline.requestConsolidation(scope)));
    expect(outcomes.filter(outcome => outcome === 'started')).toHaveLength(1);
    expect(outcomes.filter(outcome => outcome === 'running')).toHaveLength(2);

    await vi.waitFor(async () => {
      expect((await h.store.getState(scope)).lastRun).toMatchObject({ kind: 'consolidation', ok: true });
    }, { timeout: 10_000 });
    await h.waitIdle();
    expect(h.memoryPrompts.filter(prompt => prompt.includes('后台整理'))).toHaveLength(1);
  });

  it('整理失败后进入退避，后续轮次不再自动重跑', async () => {
    const h = await harness();
    h.setResponder(prompt => {
      if (prompt.includes('后台提取')) return { text: jsonBlock({ facts: [] }) };
      return { text: '没有 JSON 代码块' };
    });

    await h.coordinator.handle(event('om_remember', '/remember 这个群的回复统一用中文'), h.config);
    await vi.waitFor(() => expect(h.lastCardText()).toContain('已记住'));

    await h.pipeline.runConsolidation(scope);
    expect((await h.store.getState(scope)).lastRun).toMatchObject({ kind: 'consolidation', ok: false, error: 'MEMORY_AGENT_OUTPUT_INVALID' });
    const attempts = h.memoryPrompts.filter(prompt => prompt.includes('后台整理')).length;

    // 计数已经越过阈值，但上一轮刚失败，自动触发要退避。
    await h.store.updateState(scope, { turnsSinceConsolidation: 20 });
    await h.pipeline.onTurnCompleted(scope, { sessionId: 'ses_fake', taskId: 'task_after_failure' });
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(h.memoryPrompts.filter(prompt => prompt.includes('后台整理'))).toHaveLength(attempts);

    // 手动触发不受退避限制。
    await h.coordinator.handle(event('om_consolidate', '/memory consolidate'), h.config);
    expect(h.lastCardText()).toContain('已开始整理');
    await vi.waitFor(() => expect(h.memoryPrompts.filter(prompt => prompt.includes('后台整理')).length).toBeGreaterThan(attempts), { timeout: 10_000 });
  });

  it('换了整理 Agent 之后不再复用旧的记忆会话', async () => {
    const h = await harness();
    await h.runTurns(3);
    await vi.waitFor(async () => {
      expect((await h.store.getState(scope)).lastRun).toMatchObject({ kind: 'extraction', ok: true });
    }, { timeout: 10_000 });
    const before = (await h.runtime.listSessions()).filter(session => session.source === 'lark-memory');
    expect(before).toHaveLength(1);

    const cheaper = await h.setConfig({ memoryModel: 'cheap-model' });
    await h.runTurns(3, cheaper);
    await vi.waitFor(async () => {
      expect((await h.runtime.listSessions()).filter(session => session.source === 'lark-memory')).toHaveLength(2);
    }, { timeout: 10_000 });
    const after = (await h.runtime.listSessions()).filter(session => session.source === 'lark-memory');
    expect(after).toHaveLength(2);
    expect(after.some(session => session.model === 'cheap-model')).toBe(true);
  });

  it('PTY 类 Agent 拒绝 deny-all 时降级成 ask 重试一次', async () => {
    const h = await harness({
      // PTY CLI 只认 ask / full-trust：runtime 对 deny-all 抛 PERMISSION_MODE_UNSUPPORTED。
      startGuard: input => {
        if (input.permissionMode === 'deny-all') {
          throw new RuntimeError('PERMISSION_MODE_UNSUPPORTED', 'PTY Agent only supports ask (approve in the terminal) or explicit full-trust mode', 422);
        }
      }
    });
    h.setResponder(prompt => {
      if (!prompt.includes('后台提取')) return { text: jsonBlock({ actions: [{ op: 'noop' }] }) };
      const taskId = prompt.match(/### 轮次 (\S+)/)?.[1] ?? 'unknown';
      return { text: jsonBlock({ facts: [{ content: '部署脚本在 scripts/deploy.sh', topic: 'environment', kind: 'environment', evidence: taskId }] }) };
    });

    await h.runTurns(3);
    await vi.waitFor(async () => {
      expect((await h.store.getState(scope)).lastRun).toMatchObject({ kind: 'extraction', ok: true, added: 1 });
    }, { timeout: 10_000 });

    expect(h.startCalls.map(call => call.permissionMode)).toEqual(['deny-all', 'ask']);
    const memorySession = (await h.runtime.listSessions()).find(session => session.source === 'lark-memory');
    expect(memorySession).toMatchObject({ permissionMode: 'ask' });

    // 降级后的 ask 会话要能被复用，不能每轮再试一次 deny-all。
    await h.runTurns(3);
    await vi.waitFor(async () => {
      expect((await h.store.getState(scope)).pendingTurns ?? []).toEqual([]);
    }, { timeout: 10_000 });
    expect(h.startCalls).toHaveLength(2);
  });

  it('两种权限模式都起不来时记 MEMORY_AGENT_UNSUPPORTED 并清掉 running', async () => {
    const h = await harness({
      startGuard: () => { throw new RuntimeError('PERMISSION_MODE_UNSUPPORTED', 'Legacy PTY transport cannot enforce a permission posture', 422); }
    });
    await h.coordinator.handle(event('om_remember', '/remember 这个群的回复统一用中文'), h.config);
    await vi.waitFor(() => expect(h.lastCardText()).toContain('已记住'));

    const run = await h.pipeline.runConsolidation(scope);
    expect(run).toMatchObject({ kind: 'consolidation', ok: false, error: 'MEMORY_AGENT_UNSUPPORTED' });
    expect(h.startCalls.map(call => call.permissionMode)).toEqual(['deny-all', 'ask']);

    const state = await h.store.getState(scope);
    expect(state.running).toBeUndefined();
    expect(state.lastFailureAt?.consolidation).toBeTruthy();
  });

  it('提取期间新完成的轮次会接着被消费，计数跟着剩余队列走', async () => {
    const h = await harness();
    h.setResponder(prompt => {
      if (!prompt.includes('后台提取')) return { text: jsonBlock({ actions: [{ op: 'noop' }] }) };
      const taskId = prompt.match(/### 轮次 (\S+)/)?.[1] ?? 'unknown';
      return { text: jsonBlock({ facts: [{ content: `轮次 ${taskId} 的事实`, topic: 'environment', kind: 'environment', evidence: taskId }] }), delayMs: 400 };
    });

    // 先关自动触发，攒够 3 轮后手动跑一次提取，好在它执行期间再塞 3 轮进来。
    const manual = await h.setConfig({ memoryAutoExtract: false });
    await h.runTurns(3, manual);
    const extraction = h.pipeline.runExtraction(scope);
    await h.runTurns(3, manual);
    expect(await extraction).toMatchObject({ kind: 'extraction', ok: true });

    const afterFirst = await h.store.getState(scope);
    expect(afterFirst.pendingTurns).toHaveLength(3);
    expect(afterFirst.turnsSinceExtraction).toBe(3);

    // 打开自动触发后，下一轮完成会把剩下的 3 条也消费掉。
    const auto = await h.setConfig({ memoryAutoExtract: true });
    await h.runTurns(1, auto);
    await vi.waitFor(async () => {
      expect((await h.store.getState(scope)).pendingTurns ?? []).toEqual([]);
    }, { timeout: 15_000 });
    expect(h.memoryPrompts.filter(prompt => prompt.includes('后台提取')).length).toBeGreaterThanOrEqual(2);
  });

  it('drain 在一次触发里连跑：提取运行期间攒下的轮次不必等下一条消息', async () => {
    const h = await harness();
    h.setResponder(prompt => {
      if (!prompt.includes('后台提取')) return { text: jsonBlock({ actions: [{ op: 'noop' }] }) };
      return { text: jsonBlock({ facts: [] }), delayMs: 400 };
    });

    await h.runTurns(3);
    // 第一轮提取还在跑（mock 延迟 400ms），这 3 轮只会记账，不会另起一次运行。
    await h.runTurns(3);
    await vi.waitFor(async () => {
      expect((await h.store.getState(scope)).pendingTurns ?? []).toEqual([]);
    }, { timeout: 15_000 });
    expect(h.memoryPrompts.filter(prompt => prompt.includes('后台提取')).length).toBeGreaterThanOrEqual(2);
    await h.waitIdle();
  });

  it('整理失败后，一次成功的提取不会解除整理的退避', async () => {
    const h = await harness();
    h.setResponder(prompt => {
      if (prompt.includes('后台提取')) {
        const taskId = prompt.match(/### 轮次 (\S+)/)?.[1] ?? 'unknown';
        return { text: jsonBlock({ facts: [{ content: `轮次 ${taskId} 的事实`, topic: 'environment', kind: 'environment', evidence: taskId }] }) };
      }
      return { text: '整理故意不给 JSON 代码块' };
    });

    await h.coordinator.handle(event('om_remember', '/remember 这个群的回复统一用中文'), h.config);
    await vi.waitFor(() => expect(h.lastCardText()).toContain('已记住'));

    await h.pipeline.runConsolidation(scope);
    expect((await h.store.getState(scope)).lastFailureAt?.consolidation).toBeTruthy();

    // 先让提取也失败一次，才能验证「成功时清除的是自己这一类」而不是空断言。
    h.setResponder(() => ({ text: '提取也故意不给 JSON 代码块' }));
    // 必须是真跑过的轮次：没有可读结果的轮次会走「无素材」成功早退，记不上失败。
    await h.runTurns(1);
    await h.pipeline.runExtraction(scope);
    const failed = await h.store.getState(scope);
    expect(failed.lastFailureAt?.extraction).toBeTruthy();
    expect(failed.lastFailureAt?.consolidation).toBeTruthy();

    // 退避会挡住自动提取；用手动入口跑一次成功的提取，验证只清掉提取那一格。
    h.setResponder(prompt => {
      if (prompt.includes('后台提取')) {
        const taskId = prompt.match(/### 轮次 (\S+)/)?.[1] ?? 'unknown';
        return { text: jsonBlock({ facts: [{ content: `轮次 ${taskId} 的事实`, topic: 'environment', kind: 'environment', evidence: taskId }] }) };
      }
      return { text: '整理故意不给 JSON 代码块' };
    });

    // 一次成功的提取会覆盖 lastRun，但不该把整理的失败时间戳一起抹掉。
    await h.runTurns(3);
    await h.pipeline.runExtraction(scope);
    await vi.waitFor(async () => {
      expect((await h.store.getState(scope)).lastRun).toMatchObject({ kind: 'extraction', ok: true });
    }, { timeout: 15_000 });
    const state = await h.store.getState(scope);
    expect(state.lastFailureAt?.consolidation).toBeTruthy();
    expect(state.lastFailureAt?.extraction).toBeUndefined();

    // 计数早已越过整理阈值，但退避仍在，不能再起整理。
    const before = h.memoryPrompts.filter(prompt => prompt.includes('后台整理')).length;
    await h.store.updateState(scope, { turnsSinceConsolidation: 20 });
    await h.runTurns(1);
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(h.memoryPrompts.filter(prompt => prompt.includes('后台整理'))).toHaveLength(before);
  });

  it('机器人不配模型时按 Agent 自身的模型复用会话，改了模型才新建', async () => {
    const h = await harness({ agentModel: 'agent-default-model' });
    h.setResponder(() => ({ text: jsonBlock({ facts: [] }) }));

    await h.runTurns(3);
    await vi.waitFor(async () => {
      expect((await h.store.getState(scope)).lastRun).toMatchObject({ kind: 'extraction', ok: true });
    }, { timeout: 10_000 });
    expect(h.startCalls).toHaveLength(1);

    await h.runTurns(3);
    await vi.waitFor(async () => {
      expect((await h.store.getState(scope)).pendingTurns ?? []).toEqual([]);
    }, { timeout: 10_000 });
    expect(h.startCalls).toHaveLength(1);

    const cheaper = await h.setConfig({ memoryModel: 'cheap-model' });
    await h.runTurns(3, cheaper);
    await vi.waitFor(() => expect(h.startCalls).toHaveLength(2), { timeout: 10_000 });
    expect(h.startCalls.at(-1)).toMatchObject({ model: 'cheap-model' });
  });

  it('整理成功后自己清掉 indexOverBudget，不再每轮重复触发', async () => {
    const h = await harness();
    // 空账本是唯一一条不写派生视图的整理成功路径：这里不显式清标记，它就会卡在 true，
    // 之后每个用户轮次都判定整理到期，drain 还会连跑 3 轮。
    await h.store.updateState(scope, { indexOverBudget: true, turnsSinceConsolidation: 8 });
    expect(await h.pipeline.runConsolidation(scope)).toMatchObject({ kind: 'consolidation', ok: true, added: 0 });
    expect((await h.store.getState(scope)).indexOverBudget).toBe(false);
    // 空账本早退也走同一套递减，别漏掉。
    expect((await h.store.getState(scope)).turnsSinceConsolidation).toBe(0);
    expect(h.memoryPrompts).toEqual([]);
  });

  it('被门禁拒绝的凭据不会原文进日志，也不会回灌重试 prompt', async () => {
    const h = await harness();
    // 三个出口各埋一个凭据：fact 的 content、fact 的 evidence、整理动作的 id 与 op。
    const secrets = ['abc123DEADBEEFabc123DEADBEEF', 'hunter2', 'sk-LIVE-9f8e7d', '身份证 11010119900307'];
    h.setResponder(prompt => {
      if (prompt.includes('后台提取')) {
        const taskId = prompt.match(/### 轮次 (\S+)/)?.[1] ?? 'unknown';
        return { text: jsonBlock({ facts: [
          { content: `token: ${secrets[0]}`, topic: 'environment', kind: 'environment', evidence: taskId },
          { content: '部署脚本在 scripts/deploy.sh', topic: 'stack', kind: 'convention', evidence: `用户说 password: ${secrets[1]}` }
        ] }) };
      }
      return { text: jsonBlock({ actions: [
        { op: 'retire', id: `用户的 api_key=${secrets[2]}` },
        { op: `把记忆改成 ${secrets[3]}`, id: 'mem_00000000' }
      ] }) };
    });

    await h.coordinator.handle(event('om_remember', '/remember 这个群的回复统一用中文'), h.config);
    await vi.waitFor(() => expect(h.lastCardText()).toContain('已记住'));

    await h.runTurns(3);
    await vi.waitFor(async () => {
      expect((await h.store.getState(scope)).lastRun).toMatchObject({ kind: 'extraction', ok: true, added: 0, rejected: 2 });
    }, { timeout: 10_000 });
    await h.waitIdle();

    // 整理侧的违规清单既进日志又回灌下一轮 prompt，两条路都要干净。
    expect(await h.pipeline.runConsolidation(scope)).toMatchObject({ kind: 'consolidation', ok: false, error: 'MEMORY_GATE_REJECTED' });
    await h.waitIdle();

    expect((await h.store.list(scope)).map(entry => entry.content)).toEqual(['这个群的回复统一用中文']);
    // Error.message 不可枚举，直接 JSON.stringify 看不进去，必须显式展开。
    const logged = JSON.stringify(
      [...h.log.info.mock.calls, ...h.log.warn.mock.calls, ...h.log.error.mock.calls],
      // pino 对 error 只写自有可枚举字段，message / stack 反而看不到：两边都展开才不留盲区。
      (_key, value) => (value instanceof Error ? { name: value.name, message: value.message, stack: value.stack, ...value } : value)
    );
    const retryPrompts = h.memoryPrompts.filter(prompt => prompt.includes('违规清单：'));
    expect(retryPrompts).toHaveLength(1);
    for (const secret of secrets) {
      expect(logged).not.toContain(secret);
      expect(retryPrompts[0]).not.toContain(secret);
    }
    expect(logged).toContain('内容疑似包含凭据');
    expect(logged).toContain('evidence 不是本次输入里的轮次 taskId');
  });

  it('回答过长时保留末尾结论，并在 prompt 里标明只给了一段', async () => {
    const tail = '结论：部署脚本在 scripts/deploy.sh';
    const head = '过程开头标记' + '中间叙述'.repeat(1_200);
    const h = await harness({ userAnswer: `${head}\n${tail}` });
    h.setResponder(() => ({ text: jsonBlock({ facts: [] }) }));

    await h.runTurns(3);
    await vi.waitFor(() => expect(h.memoryPrompts.filter(prompt => prompt.includes('后台提取'))).toHaveLength(1), { timeout: 10_000 });
    await h.waitIdle();

    const extraction = h.memoryPrompts.find(prompt => prompt.includes('后台提取'))!;
    expect(extraction).toContain(tail);
    expect(extraction).not.toContain('过程开头标记');
    expect(extraction).toContain('回答（回答较长，仅保留末尾部分）：');
  });

  it('整理期间完成的轮次不被清零抹掉', async () => {
    const h = await harness();
    h.setResponder(() => ({ text: jsonBlock({ actions: [{ op: 'noop' }] }), delayMs: 600 }));
    await h.coordinator.handle(event('om_remember', '/remember 这个群的回复统一用中文'), h.config);
    await vi.waitFor(() => expect(h.lastCardText()).toContain('已记住'));

    // 自动提取会抢同一个单飞占位，这里只考察整理的计数收口。
    const quiet = await h.setConfig({ memoryAutoExtract: false });
    await h.store.updateState(scope, { turnsSinceConsolidation: 8 });
    const consolidation = h.pipeline.runConsolidation(scope);
    await h.runTurns(2, quiet);
    // 记账发生在轮次交付之后，runTurns 返回时未必已落盘；没等到 10 就说明这两轮没落在
    // 整理运行期间，后面的断言会变成空断言（清零实现也能得 2），所以这里必须先卡住。
    await vi.waitFor(async () => {
      expect((await h.store.getState(scope)).turnsSinceConsolidation).toBe(10);
    }, { timeout: 2_000 });
    expect(await consolidation).toMatchObject({ kind: 'consolidation', ok: true });

    // 8 轮被这次整理消化掉，运行期间新完成的 2 轮必须留下。
    expect((await h.store.getState(scope)).turnsSinceConsolidation).toBe(2);
  });

  it('记忆会话超时但中断未确认：保留原任务、报告恢复所需并清掉管线 running', async () => {
    const h = await harness({ timeoutMs: 30 });
    h.setResponder(() => ({ text: jsonBlock({ actions: [{ op: 'noop' }] }), delayMs: 1_500 }));

    await h.coordinator.handle(event('om_remember', '/remember 这个群的回复统一用中文'), h.config);
    await vi.waitFor(() => expect(h.lastCardText()).toContain('已记住'));

    const run = await h.pipeline.runConsolidation(scope);
    expect(run).toMatchObject({ kind: 'consolidation', ok: false, error: 'MEMORY_RECOVERY_REQUIRED' });
    expect(h.memoryInterrupt).toHaveBeenCalledTimes(1);

    const state = await h.store.getState(scope);
    expect(state.running).toBeUndefined();
    expect(state.lastRun).toMatchObject({ ok: false, error: 'MEMORY_RECOVERY_REQUIRED' });
    expect(await h.store.list(scope)).toHaveLength(1);
  });
});

describe('shared group pool through the pipeline', () => {
  const groupB = (id: string, text: string) => event(id, text, { chatId: 'oc_group_b', threadId: undefined, rootId: undefined });
  const cardWith = (cards: Array<Record<string, unknown>>, text: string) => vi.waitFor(() => {
    const card = cards.map(item => JSON.stringify(item)).find(item => item.includes(text));
    expect(card).toBeDefined();
    return card!;
  }, { timeout: 15_000 });

  it('一次提取混有多个群的轮次：逐轮标出来源群，事实记下证据轮次的群', async () => {
    const h = await harness();
    h.setResponder(prompt => {
      if (!prompt.includes('后台提取')) return { text: jsonBlock({ actions: [{ op: 'noop' }] }) };
      const fromB = prompt.match(/### 轮次 (\S+)\n来源群：oc_group_b\n/)?.[1] ?? 'unknown';
      return { text: jsonBlock({ facts: [{ content: 'B 群的值班表在 wiki 首页', topic: 'contacts', kind: 'environment', evidence: fromB }] }) };
    });

    await h.runTurns(2);
    const before = h.prompts.length;
    await h.coordinator.handle(groupB('om_b_turn', 'B 群的任务'), h.config);
    await vi.waitFor(() => expect(h.prompts.length).toBe(before + 1), { timeout: 15_000 });
    await vi.waitFor(async () => {
      expect((await h.store.getState(scope)).lastRun).toMatchObject({ kind: 'extraction', ok: true, added: 1 });
    }, { timeout: 10_000 });
    await h.waitIdle();

    const extraction = h.memoryPrompts.find(prompt => prompt.includes('后台提取'))!;
    expect(extraction.match(/来源群：oc_group\n/g)).toHaveLength(2);
    expect(extraction.match(/来源群：oc_group_b\n/g)).toHaveLength(1);
    const [saved] = await h.store.list(scope);
    expect(saved).toMatchObject({ source: 'extraction', content: 'B 群的值班表在 wiki 首页', chatId: 'oc_group_b' });
    // 两个群共用一个记忆会话与一份状态。
    expect((await h.runtime.listSessions()).filter(session => session.source === 'lark-memory').map(session => session.sourceId)).toEqual(['cli_memory:groups:memory']);
    expect(await h.store.getState(larkMemoryScope('cli_memory', 'oc_group_b', 'group'))).toEqual(await h.store.getState(scope));

    // A 群的下一轮带上 B 群提取的事实，标「其他群」。
    await h.runTurns(1);
    expect(h.prompts.at(-1)).toMatch(/\[mem_[0-9a-f]{8} · 提取 · \d{4}-\d{2}-\d{2} · 其他群\] B 群的值班表在 wiki 首页/);
  });

  it('/memory 回执显示上次运行失败的原因与待提取轮次；私聊只看自己的池', async () => {
    const h = await harness();
    h.setResponder(() => ({ text: '整理故意不给 JSON 代码块' }));
    await h.coordinator.handle(event('om_remember', '/remember 这个群的回复统一用中文'), h.config);
    await cardWith(h.cards, '已保存为群共享记忆');
    const quiet = await h.setConfig({ memoryAutoExtract: false });
    await h.runTurns(2, quiet);
    await vi.waitFor(async () => expect((await h.store.getState(scope)).pendingTurns).toHaveLength(2));
    expect(await h.pipeline.runConsolidation(scope)).toMatchObject({ ok: false, error: 'MEMORY_AGENT_OUTPUT_INVALID' });

    await h.coordinator.handle(groupB('om_status', '/memory'), quiet);
    const receipt = await cardWith(h.cards, '后台提取与整理');
    expect(receipt).toContain('本机器人所在各群共享，共 1 条记忆');
    expect(receipt).toContain('其他群 · 这个群的回复统一用中文');
    expect(receipt).toMatch(/上次运行：整理 · \d{4}-\d{2}-\d{2} \d{2}:\d{2} · 失败 `MEMORY_AGENT_OUTPUT_INVALID`（整理 Agent 的输出格式不对）/);
    expect(receipt).toContain('待提取 2 轮 · 上次成功提取 尚未提取 · 上次整理 尚未整理');

    await h.coordinator.handle(event('om_p2p_status', '/memory', { chatId: 'oc_p2p', chatType: 'p2p', threadId: undefined, rootId: undefined, mentions: [] }), quiet);
    const p2p = await cardWith(h.cards, '本聊天还没有保存的记忆');
    expect(p2p).toContain('上次运行：尚未运行');
    expect(p2p).toContain('待提取 0 轮');
  });
});

describe('stuck memory session after a daemon restart', () => {
  it('归档 reconcile_required 的记忆会话、换新会话继续，旧会话的输出绝不被读取，之后复用新会话', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dutydeck-lark-memory-restart-'));
    cleanups.push(() => rm(cwd, { recursive: true, force: true }));
    const file = join(cwd, 'state.db');
    const agent: AgentConfig = { id: 'mock', name: 'Mock', command: process.execPath, args: [], protocol: 'acp', cwd, env: {}, permissionMode: 'ask', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };
    const config = { appId: scope.appId, appSecret: 'fake-secret', workspace: cwd, defaultAgentId: 'mock', permissionMode: 'ask', listening: true } as StoredLarkConfig;
    const memoryPrompts: string[] = [];
    let beforeRestart = true;
    let poisonId = '';

    const open = async (timeoutMs?: number) => {
      const repos = createRepositories(file, { newDatabaseAuthority: 'ledger_v1' });
      const runtime = new DutydeckRuntime(repos, {
        probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }),
        driverFactory: (_config, _protocol, emit) => {
          let release: (() => void) | undefined;
          const driver: AgentDriver = {
            start: async () => {}, resume: async () => {}, interrupt: async () => {},
            stop: async () => { release?.(); },
            send: async prompt => {
              memoryPrompts.push(prompt);
              if (beforeRestart) {
                // 重启前吐出一段形式合法、会淘汰用户条目的整理结果，但这一轮没有终态：绝不能被读取。
                emit({ type: 'text', data: { text: jsonBlock({ actions: [{ op: 'retire', id: poisonId, reason: '旧会话的输出' }] }) } });
                await new Promise<void>(resolve => { release = resolve; });
                return;
              }
              emit({ type: 'text', data: { text: jsonBlock({ actions: [{ op: 'noop' }] }) } });
              emit({ type: 'completed', data: { stopReason: 'end_turn' } });
            }
          };
          return driver;
        }
      });
      await runtime.initialize([agent]);
      await repos.config.set(larkBotsConfigKey, JSON.stringify([config]));
      const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const store = new LarkMemoryStore(repos.config);
      const projection = new LarkMemoryProjection(store, join(cwd, 'memory'), log);
      const starts: StartInput[] = [];
      const pipeline = new LarkMemoryPipeline({
        runtime: {
          start: input => { starts.push(input); return runtime.start(input); },
          listAgents: () => runtime.listAgents(),
          listSessions: () => runtime.listSessions(),
          dispatch: (id, prompt, mode, agentPrompt) => runtime.dispatch(id, prompt, mode, agentPrompt),
          getTasks: id => runtime.getTasks(id),
          getTaskRecovery: (id, taskId) => runtime.getTaskRecovery(id, taskId),
          cancelQueued: (id, taskId, actor, revision) => runtime.cancelQueued(id, taskId, actor, revision),
          archive: (id, actor) => runtime.archive(id, actor),
          interrupt: (id, taskId, actor) => runtime.interrupt(id, taskId, actor),
          subscribe: (id, listener) => runtime.subscribe(id, listener)
        },
        controlActorId: 'installation_owner',
        repos: { execution: repos.execution },
        store, projection,
        readConfig: async appId => (await readLarkConfigs(repos.config)).find(bot => bot.appId === appId),
        log,
        ...(timeoutMs ? { timeoutMs } : {})
      });
      const close = async () => { await runtime.shutdown(); repos.close(); };
      return { repos, runtime, store, pipeline, log, starts, close };
    };
    const memorySessions = async (runtime: DutydeckRuntime) => (await runtime.listSessions())
      .filter(session => session.source === 'lark-memory' && session.sourceId === 'cli_memory:groups:memory');

    // 第一次 daemon：整理跑到一半 daemon 重启。
    const first = await open(500);
    poisonId = (await first.store.add(scope, { content: '这个群的回复统一用中文', source: 'user', chatId: scope.chatId })).id;
    const stuckRun = first.pipeline.runConsolidation(scope);
    await vi.waitFor(() => expect(memoryPrompts).toHaveLength(1), { timeout: 10_000 });
    const [stuck] = await memorySessions(first.runtime);
    await first.runtime.shutdown();
    await stuckRun.catch(() => undefined);
    first.repos.close();

    // 第二次 daemon：旧会话里的任务成了 reconcile_required。
    beforeRestart = false;
    const second = await open();
    cleanups.push(second.close);
    await vi.waitFor(async () => expect((await second.runtime.getTasks(stuck!.id)).map(task => task.status)).toEqual(['reconcile_required']), { timeout: 10_000 });

    expect(await second.pipeline.runConsolidation(scope)).toMatchObject({ kind: 'consolidation', ok: true });
    const sessions = await memorySessions(second.runtime);
    expect(sessions).toHaveLength(2);
    const old = sessions.find(session => session.id === stuck!.id)!;
    const replacement = sessions.find(session => session.id !== stuck!.id)!;
    // 归档要先停掉原执行：重启后原进程资源未经确认时 runtime 会拒绝（SESSION_RESOURCE_BLOCKED），
    // 旧会话于是留在账本里等人工恢复；不论归档成没成功，都不能再被选中。
    const retired = second.log.warn.mock.calls.find(call => String(call[1]).startsWith('记忆会话有未决任务'));
    expect(retired?.[0]).toMatchObject({ sessionId: old.id });
    expect(retired?.[1]).toBe(old.archivedAt ? '记忆会话有未决任务，已归档并改用新会话' : '记忆会话有未决任务且归档未完成，改用新会话');
    expect(replacement.archivedAt).toBeFalsy();
    // 旧会话的任务账本保留、没有再派发；新会话收到这次整理并正常完成。
    expect((await second.runtime.getTasks(old.id)).map(task => task.status)).toEqual(['reconcile_required']);
    expect((await second.runtime.getTasks(replacement.id)).map(task => task.status)).toEqual(['completed']);
    expect(memoryPrompts).toHaveLength(2);
    // 旧会话里那段「淘汰用户条目」的输出没有被当成结果。
    expect((await second.store.list(scope)).map(entry => entry.id)).toEqual([poisonId]);

    // 下一次运行按 sourceId 选中新会话，不再新建，也不再碰旧会话。
    expect(await second.pipeline.runConsolidation(scope)).toMatchObject({ ok: true });
    expect(second.starts).toHaveLength(1);
    expect((await second.runtime.getTasks(replacement.id)).map(task => task.status)).toEqual(['completed', 'completed']);
    expect((await second.runtime.getTasks(old.id)).map(task => task.status)).toEqual(['reconcile_required']);
    expect(second.log.warn.mock.calls.filter(call => String(call[1]).startsWith('记忆会话有未决任务'))).toHaveLength(1);
  });
});
