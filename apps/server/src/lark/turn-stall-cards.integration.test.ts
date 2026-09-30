// 「可能卡住」提示在飞书卡上的呈现：真实 DutydeckRuntime + SQLite，驱动是一轮永远不结束的假驱动，
// 它的进程号指向一个空闲的真实子进程，CPU 判定走真实的 /proc 读取。
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import { DutydeckRuntime, type AgentDriver } from '@dutydeck/runtime';
import type { AgentConfig, NormalizedDriverEvent } from '@dutydeck/shared';
import { LarkMessageCoordinator, type PersistedLarkCardTask } from './coordinator.js';
import { larkBotsConfigKey, type StoredLarkConfig } from './config.js';
import { buildLarkCard } from './service.js';
import type { LarkMessageEvent } from './listener.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });

const event = (id: string, text: string): LarkMessageEvent => ({
  messageId: id, chatId: 'oc_group', chatType: 'group', threadId: 'omt_topic', rootId: 'om_root',
  senderOpenId: 'ou_alice', senderType: 'user', messageType: 'text', content: JSON.stringify({ text }),
  mentions: [{ key: '@_user_1', name: 'Dock', openId: 'ou_bot' }]
});
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function harness() {
  const cwd = await mkdtemp(join(tmpdir(), 'dutydeck-lark-turn-stall-'));
  const repos = createRepositories(join(cwd, 'state.db'), { newDatabaseAuthority: 'ledger_v1' });
  const idle = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const prompts: string[] = [];
  const interrupt = vi.fn();
  let emit!: (event: NormalizedDriverEvent) => void;
  const runtime = new DutydeckRuntime(repos, {
    probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }),
    driverFactory: (_config, _protocol, onEvent) => {
      emit = onEvent;
      let finish: (() => void) | undefined;
      let stopped = false;
      const end = () => { finish?.(); finish = undefined; };
      const driver: AgentDriver = {
        start: async () => {}, resume: async () => {},
        stop: async () => { stopped = true; end(); }, isStopped: async () => stopped,
        interrupt: async () => { interrupt(); end(); },
        send: async prompt => {
          prompts.push(prompt);
          await new Promise<void>(done => { finish = done; });
          onEvent({ type: 'completed', data: { stopReason: 'cancelled' } });
        },
        processIds: () => [idle.pid!]
      };
      return driver;
    }
  });
  const agent: AgentConfig = { id: 'mock', name: 'Mock Agent', command: process.execPath, args: [], protocol: 'acp', cwd, env: {}, permissionMode: 'ask', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };
  await runtime.initialize([agent]);
  const config: StoredLarkConfig = { appId: 'cli_stall', appSecret: 'fake-secret', workspace: cwd, defaultAgentId: 'mock', permissionMode: 'ask', listening: true,
    fullTrustConfirmed: true, preInjectPrompt: '', structuredAskCards: false, groupCardMention: false, groupToolsEnabled: false, groupToolsAllowSend: false,
    pushIntervalMs: 500, hideTraceOnComplete: false, allowedUsers: [], allowedEmails: [], allowedBots: [], peerBotsAllowed: false,
    highRiskAllowedUsers: [], highRiskAllowedEmails: [], highRiskPattern: 'dangerous', riskControlMode: 'off' };
  await repos.config.set(larkBotsConfigKey, JSON.stringify([config]));
  let nextCard = 0;
  const cards: any[] = [];
  const createCard = async (input: any) => { cards.push(input); return { messageId: `om_card_${++nextCard}` }; };
  const service = {
    send: vi.fn(createCard), reply: vi.fn(createCard),
    update: vi.fn(async (input: any) => { cards.push(input); return { messageId: input.messageId }; }),
    addReaction: vi.fn(async (messageId: string) => ({ messageId, reactionId: `reaction_${messageId}` })),
    deleteReaction: vi.fn(async () => {}), getUserEmails: vi.fn(async () => [] as string[]),
    listChatMembers: vi.fn(async () => ({ items: [{ memberId: 'ou_alice' }], hasMore: false })),
    listChatMessages: vi.fn(async () => ({ items: [] as any[], hasMore: false })),
    getMessage: vi.fn(async (id: string) => ({ messageId: id, chatId: 'oc_group', messageType: 'text', rawContent: '{"text":""}', sender: { type: 'user' }, mentions: [] })),
    getMessageItems: vi.fn(async () => [] as any[])
  };
  const coordinator = new LarkMessageCoordinator(runtime, service as any, { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, Math.random, 'ou_bot', undefined, repos.channelMappings,
    async () => 'group', undefined, undefined, { store: repos.config });
  await coordinator.initializeWorkflows(config);
  cleanups.push(async () => { coordinator.stop(); await runtime.shutdown(); repos.close(); idle.kill('SIGKILL'); await rm(cwd, { recursive: true, force: true }); });
  // 墙钟整体前移，其余照常流逝：静默时长与 CPU 采样窗口都按它算。
  const realNow = Date.now.bind(Date);
  let offset = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);

  const markdownOf = (card: any) => String(card?.markdown ?? '') + JSON.stringify(card?.elements ?? []);
  const latestCard = (taskId: string) => cards.filter(card => card.taskId === taskId).at(-1);
  const buttonsOf = (card: any) => {
    const labels: string[] = [];
    const walk = (node: any) => {
      if (Array.isArray(node)) node.forEach(walk);
      else if (node && typeof node === 'object') {
        if (node.tag === 'button' && node.behaviors?.some((behavior: any) => behavior.type === 'callback' && behavior.value?.action)) labels.push(node.text?.content);
        Object.values(node).forEach(walk);
      }
    };
    walk(buildLarkCard(card));
    return labels;
  };
  const waitLatest = (taskId: string, check: (card: any) => void) => vi.waitFor(() => { const card = latestCard(taskId); check(card); return card; }, { timeout: 6_000, interval: 50 });
  const dispatch = async (id: string, text: string) => {
    await coordinator.handle(event(id, text), config);
    await vi.waitFor(async () => {
      const [session] = await runtime.listSessions();
      expect((await runtime.getTasks(session!.id)).some(task => task.prompt.includes(text))).toBe(true);
    });
  };
  const runtimeTask = async (text: string) => {
    for (const session of await runtime.listSessions()) {
      const found = (await runtime.getTasks(session.id)).find(task => task.prompt.includes(text));
      if (found) return found;
    }
  };
  /** 静默超过阈值：第一帧心跳只取 CPU 对照样本，再前移一个采样窗口后才下结论。 */
  const goSilent = async () => {
    offset += 4 * 60_000;
    await pause(1_200);
    offset += 15_000;
  };
  const cardMessageId = async (id: string) => (JSON.parse((await repos.channelMappings.get(`lark-card:${config.appId}`, id))!.extra!) as PersistedLarkCardTask).card_message_id!;
  return { coordinator, cards, prompts, interrupt, emit: (value: NormalizedDriverEvent) => emit(value), markdownOf, latestCard, buttonsOf, waitLatest, dispatch, runtimeTask, goSilent, cardMessageId };
}

describe.runIf(existsSync('/proc/self/stat'))('飞书卡上的「可能卡住」提示', () => {
  it('执行卡与排队卡都标出可能卡住并给出中断与新会话入口，不自动中断；有了新输出就撤掉', async () => {
    const h = await harness();
    await h.dispatch('om_1', '第一件事');
    await vi.waitFor(() => expect(h.prompts).toHaveLength(1));
    await h.dispatch('om_2', '第二件事');
    await h.waitLatest('om_2', card => expect(h.markdownOf(card)).toContain('不会传给它'));
    await h.goSilent();

    const running = await h.waitLatest('om_1', card => expect(card.statusLabel).toBe('可能卡住'));
    expect(h.markdownOf(running)).toContain('后面还有 1 条请求在排队');
    expect(h.buttonsOf(running)).toContain('中断');
    const queued = await h.waitLatest('om_2', card => expect(card.statusLabel).toBe('可能卡住'));
    expect(h.markdownOf(queued)).toContain('可能卡住了');
    expect(h.buttonsOf(queued)).toEqual(['取消', '中断当前这一轮，先做这条', '刷新', '在新会话中执行']);
    expect(h.interrupt).not.toHaveBeenCalled();
    expect((await h.runtimeTask('第一件事'))?.status).toBe('running');

    // 终端屏幕又动了：两张卡在下一帧撤掉提示，排队卡回到普通说明。
    h.emit({ type: 'raw_terminal', data: { text: 'still working' } });
    await h.waitLatest('om_1', card => { expect(card.statusLabel).toBeUndefined(); expect(h.markdownOf(card)).not.toContain('可能卡住'); });
    const restored = await h.waitLatest('om_2', card => expect(card.statusLabel).toBe('排队中'));
    expect(h.markdownOf(restored)).toContain('不会传给它');
    expect(h.buttonsOf(restored)).not.toContain('在新会话中执行');
    expect(h.interrupt).not.toHaveBeenCalled();
  }, 30_000);

  it('卡住时点排队卡的「在新会话中执行」被受理，原来那一轮不被中断', async () => {
    const h = await harness();
    await h.dispatch('om_1', '第一件事');
    await vi.waitFor(() => expect(h.prompts).toHaveLength(1));
    await h.dispatch('om_2', '第二件事');
    await h.waitLatest('om_2', card => expect(h.markdownOf(card)).toContain('不会传给它'));
    await h.goSilent();
    await h.waitLatest('om_2', card => expect(h.buttonsOf(card)).toContain('在新会话中执行'));
    expect(await h.coordinator.handleAction({ action: 'run_in_new_session', task_id: 'om_2', turn: '1' }, 'ou_alice', { messageId: await h.cardMessageId('om_2'), chatId: 'oc_group' }))
      .toMatchObject({ type: 'success' });
    await vi.waitFor(() => expect(h.prompts.at(-1)).toContain('第二件事'));
    expect(h.interrupt).not.toHaveBeenCalled();
    expect((await h.runtimeTask('第一件事'))?.status).toBe('running');
  }, 30_000);

  it('后面没有排队时不提示', async () => {
    const h = await harness();
    await h.dispatch('om_1', '第一件事');
    await vi.waitFor(() => expect(h.prompts).toHaveLength(1));
    await h.goSilent();
    await pause(2_000);
    expect(h.cards.filter(card => card.taskId === 'om_1').some(card => card.statusLabel === '可能卡住' || h.markdownOf(card).includes('可能卡住'))).toBe(false);
  }, 30_000);
});
