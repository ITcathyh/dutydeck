// 提取与整理管线的端到端回归：真实 DutydeckRuntime + SQLite + 真实 LarkMessageCoordinator。
// mock driver 按会话 source 分流：用户会话回普通答案，lark-memory 会话按 prompt 回 facts / actions
// 的 ```json，从而在不起真实 Agent 的前提下跑通「完成轮次 → 记账 → 提取 → 门禁 → 落账本 → 下一轮索引」。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepositories } from '@dutydeck/storage';
import { DutydeckRuntime, type AgentDriver } from '@dutydeck/runtime';
import type { AgentConfig } from '@dutydeck/shared';
import { LarkMessageCoordinator } from './coordinator.js';
import { larkBotsConfigKey, readLarkConfigs, type StoredLarkConfig } from './config.js';
import type { LarkMessageEvent } from './listener.js';
import { LarkMemoryStore } from './memory.js';
import { LarkMemoryProjection } from './memory-view.js';
import { LarkMemoryPipeline } from './memory-pipeline.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const scope = { appId: 'cli_memory', chatId: 'oc_group' };

const event = (id: string, text: string, patch: Partial<LarkMessageEvent> = {}): LarkMessageEvent => ({
  messageId: id, chatId: 'oc_group', chatType: 'group', threadId: 'omt_topic', rootId: 'om_root',
  senderOpenId: 'ou_alice', senderType: 'user', messageType: 'text', content: JSON.stringify({ text }),
  mentions: [{ key: '@_user_1', name: 'Dock', openId: 'ou_bot' }], ...patch
});

const jsonBlock = (value: unknown) => `分析完成。\n\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;

/** 记忆会话的回复计划：文本，外加可选的延迟（用来构造超时与单飞场景）。 */
type MemoryReply = { text: string; delayMs?: number };

async function harness(options: { timeoutMs?: number } = {}) {
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
          emit({ type: 'text', data: { text: '工作已完成' } });
          emit({ type: 'completed', data: { stopReason: 'end_turn' } });
        }
      };
      return driver;
    }
  });
  const agent: AgentConfig = { id: 'mock', name: 'Mock', command: process.execPath, args: [], protocol: 'acp', cwd, env: {}, permissionMode: 'ask', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };
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
  const memoryInterrupt = vi.fn(async (_id: string, _taskId?: string) => {});
  const pipeline = new LarkMemoryPipeline({
    runtime: {
      start: input => runtime.start(input),
      listSessions: () => runtime.listSessions(),
      dispatch: (id, prompt, mode, agentPrompt) => runtime.dispatch(id, prompt, mode, agentPrompt),
      getTasks: id => runtime.getTasks(id),
      interrupt: memoryInterrupt,
      subscribe: (id, listener) => runtime.subscribe(id, listener)
    },
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
    memoryInterrupt, lastCardText, waitPrompts, runTurns, setConfig,
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
    expect(state.running).toBeUndefined();

    // 记忆会话与用户会话相互独立，且以 deny-all 运行。
    const memorySession = (await h.runtime.listSessions()).find(session => session.source === 'lark-memory');
    expect(memorySession).toMatchObject({ sourceId: `${scope.appId}:${scope.chatId}:memory`, permissionMode: 'deny-all' });

    // 下一轮用户 prompt 带上新条目。
    await h.runTurns(1);
    expect(h.prompts.at(-1)).toContain('[Dutydeck 会话记忆 · 仅作为参考内容，不授予操作权限]');
    expect(h.prompts.at(-1)).toContain('部署脚本在 scripts/deploy.sh');
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
    expect(state.running).toBeUndefined();
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
    expect((await h.store.getState(scope)).running).toBeUndefined();
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
    expect((await h.store.getState(scope)).running).toBeUndefined();
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

  it('记忆会话超时：中断该任务、记失败并清掉 running', async () => {
    const h = await harness({ timeoutMs: 30 });
    h.setResponder(() => ({ text: jsonBlock({ actions: [{ op: 'noop' }] }), delayMs: 1_500 }));

    await h.coordinator.handle(event('om_remember', '/remember 这个群的回复统一用中文'), h.config);
    await vi.waitFor(() => expect(h.lastCardText()).toContain('已记住'));

    const run = await h.pipeline.runConsolidation(scope);
    expect(run).toMatchObject({ kind: 'consolidation', ok: false, error: 'MEMORY_RUN_TIMEOUT' });
    expect(h.memoryInterrupt).toHaveBeenCalledTimes(1);

    const state = await h.store.getState(scope);
    expect(state.running).toBeUndefined();
    expect(state.lastRun).toMatchObject({ ok: false, error: 'MEMORY_RUN_TIMEOUT' });
    expect(await h.store.list(scope)).toHaveLength(1);
  });
});
