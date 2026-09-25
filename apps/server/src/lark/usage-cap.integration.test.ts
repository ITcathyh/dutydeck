// 月度成本上限在飞书里的两处可见行为：用满后新任务在派发前被拒绝、在话题里写明是哪个上限；/status 显示本月用量。
// 接真实 DutydeckRuntime + SQLite + UsageLedger，只把飞书网络层换成内存桩。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRepositories } from '@dutydeck/storage';
import { DutydeckRuntime, type AgentDriver } from '@dutydeck/runtime';
import type { AgentConfig, CollaborationSnapshot, UsageLedgerEntry } from '@dutydeck/shared';
import { LarkMessageCoordinator } from './coordinator.js';
import { larkBotsConfigKey, type StoredLarkConfig } from './config.js';
import type { LarkMessageEvent } from './listener.js';
import { LarkGroupParticipation } from './group-participation.js';
import { ReadonlyParticipationDecider } from './readonly-decider.js';
import { UsageLedger } from '../usage-ledger.js';
import { SessionAutomationService } from '../session-automation.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const event = (id: string, text: string): LarkMessageEvent => ({
  messageId: id, chatId: 'oc_group', chatType: 'group', threadId: 'omt_topic', rootId: 'om_root',
  senderOpenId: 'ou_alice', senderType: 'user', messageType: 'text', content: JSON.stringify({ text }),
  mentions: [{ key: '@_user_1', name: 'Dock', openId: 'ou_bot' }]
});

async function harness() {
  const cwd = await mkdtemp(join(tmpdir(), 'dutydeck-usage-cap-'));
  const repos = createRepositories(join(cwd, 'state.db'), { newDatabaseAuthority: 'ledger_v1' });
  const ledger = new UsageLedger({ repositories: repos });
  const prompts: string[] = [];
  const runtime = new DutydeckRuntime(repos, {
    probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }),
    admitTask: (session, request) => ledger.admit(session, request),
    recordUsage: (session, attempt, reading) => ledger.record(session, attempt, reading),
    driverFactory: (_config, _protocol, emit) => {
      // 仿 claude-agent-acp：每轮 $0.6，cost 是这个 Agent 进程的会话累计值。
      let cumulative = 0;
      return {
        start: async () => {}, resume: async () => {}, stop: async () => {}, interrupt: async () => {},
        send: async prompt => {
          prompts.push(prompt);
          cumulative += 0.6;
          emit({ type: 'text', data: { text: 'ok' } });
          emit({ type: 'status', data: { state: 'turn_usage', usageRef: `r${prompts.length}`, breakdown: { inputTokens: 10 }, cost: { amount: cumulative, currency: 'USD' } } });
          emit({ type: 'completed', data: { stopReason: 'end_turn' } });
        }
      } satisfies AgentDriver;
    }
  });
  const agents: AgentConfig[] = [{ id: 'mock', name: 'Mock Agent', command: process.execPath, args: [], protocol: 'acp', cwd, env: {}, permissionMode: 'ask', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false }];
  await runtime.initialize(agents);
  const config: StoredLarkConfig = { appId: 'cli_cmd', appSecret: 'fake-secret', workspace: cwd, defaultAgentId: 'mock', permissionMode: 'ask', listening: true,
    fullTrustConfirmed: true, preInjectPrompt: '', structuredAskCards: false, groupCardMention: false, groupToolsEnabled: false, groupToolsAllowSend: false,
    pushIntervalMs: 1_000, hideTraceOnComplete: false, allowedUsers: [], allowedEmails: [], allowedBots: [], peerBotsAllowed: false,
    highRiskAllowedUsers: [], highRiskAllowedEmails: [], highRiskPattern: 'dangerous', riskControlMode: 'off' } as StoredLarkConfig;
  await repos.config.set(larkBotsConfigKey, JSON.stringify([config]));
  let nextCard = 0;
  const cards: any[] = [];
  const createCard = async (input: any) => { cards.push(input); return { messageId: `om_card_${++nextCard}` }; };
  const service = {
    send: vi.fn(createCard), reply: vi.fn(createCard), replyFile: vi.fn(createCard), sendFile: vi.fn(createCard), uploadFile: vi.fn(async () => 'file_x'),
    update: vi.fn(async (input: any) => { cards.push(input); return { messageId: input.messageId }; }),
    addReaction: vi.fn(async (messageId: string) => ({ messageId, reactionId: `reaction_${messageId}` })), deleteReaction: vi.fn(async () => {}),
    getUserEmails: vi.fn(async () => [] as string[]), listChatMembers: vi.fn(async () => ({ items: [{ memberId: 'ou_alice' }], hasMore: false })),
    listChatMessages: vi.fn(async () => ({ items: [] as any[], hasMore: false })),
    getMessage: vi.fn(async (id: string) => ({ messageId: id, chatId: 'oc_group', messageType: 'text', rawContent: '{"text":""}', sender: { type: 'user' }, mentions: [] })),
    getMessageItems: vi.fn(async () => [] as any[]),
    downloadMessageResource: vi.fn(async () => ({ data: new Uint8Array(), contentType: 'text/plain' })),
    readDocument: vi.fn(async (url: string) => ({ url, title: '', text: '' }))
  };
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const coordinator = new LarkMessageCoordinator(runtime, service as any, log, Math.random, 'ou_bot', undefined, repos.channelMappings, async () => 'group', undefined, undefined, { store: repos.config, usage: ledger });
  await coordinator.initializeWorkflows(config);
  cleanups.push(async () => { coordinator.stop(); await runtime.shutdown(); repos.close(); await rm(cwd, { recursive: true, force: true }); });
  const text = (card: any) => String(card?.markdown ?? '') + JSON.stringify(card?.elements ?? []);
  return { repos, runtime, ledger, config, coordinator, cards, service, prompts, text };
}

describe('飞书里的月度成本上限', () => {
  it('用满群上限后新任务不派发，并在话题里写明是本群上限；/status 显示本月用量', async () => {
    const h = await harness();
    await h.ledger.setCap({ scope: 'group', appId: 'cli_cmd', chatId: 'oc_group', monthlyCostUsd: 1 });
    await h.coordinator.handle(event('om_1', '第一件事'), h.config);
    await vi.waitFor(async () => expect((await h.repos.usage.totals({ appId: 'cli_cmd', chatId: 'oc_group' })).entries).toBe(1));
    await h.coordinator.handle(event('om_2', '第二件事'), h.config);
    await vi.waitFor(async () => expect((await h.repos.usage.totals({ appId: 'cli_cmd', chatId: 'oc_group' })).entries).toBe(2));
    // 前两轮已经派发，第二轮让本月用到 $1.20，超过上限；它照常跑完，第三条才被拒。
    await h.coordinator.handle(event('om_3', '第三件事'), h.config);
    await vi.waitFor(() => expect(h.cards.some(card => h.text(card).includes('本群本月成本已达上限 $1.00（已用 $1.20）'))).toBe(true));
    expect(h.prompts).toHaveLength(2);
    const refusal = h.service.reply.mock.calls.map(call => call[0]).concat(h.service.update.mock.calls.map(call => call[0]))
      .find(card => h.text(card).includes('本群本月成本已达上限'));
    expect(refusal).toMatchObject({ state: 'failed' });

    await h.coordinator.handle(event('om_status', '/status'), h.config);
    await vi.waitFor(() => expect(h.cards.some(card => card.readOnly && h.text(card).includes('本月用量'))).toBe(true));
    const status = h.cards.filter(card => card.readOnly && h.text(card).includes('本月用量')).at(-1);
    expect(h.text(status)).toContain('**本月用量**：本群 $1.20（上限 $1.00，已用 120%） · 本机器人 $1.20（未设上限）');
  });
});

const refusal = (spent: string) => `本群本月成本已达上限 $1.00（已用 ${spent}），新任务不再执行，正在执行的任务不受影响。安装管理员可在 Dutydeck Web 的「用量与成本」里调高上限，否则下月 1 日起重新计算。`;
const priorSpend = (costUsd: number): UsageLedgerEntry => ({ id: 'usage_prior', recordedAt: new Date().toISOString(), appId: 'cli_cmd', chatId: 'oc_group', sessionId: 'ses_prior', taskId: 'task_prior',
  attemptId: 'attempt_prior', category: 'explicit', origin: 'lark_group', agentId: 'mock', costUsd, costEstimated: false, dataStatus: 'reported' });

// 群参与：真实判定器、真实 runtime 与账本，只把飞书网络层换成内存桩。每轮报一次会话累计成本。
async function participationHarness(turnCostUsd: number) {
  const cwd = await mkdtemp(join(tmpdir(), 'dutydeck-usage-cap-participation-'));
  const repos = createRepositories(join(cwd, 'state.db'), { newDatabaseAuthority: 'ledger_v1' });
  const scope = { appId: 'cli_cmd', chatId: 'oc_group' };
  const notify = vi.fn(async (_target: { appId: string; chatId: string }, _text: string, _key: string) => {});
  const ledger = new UsageLedger({ repositories: repos, notify });
  const prompts: string[] = [];
  const runtime = new DutydeckRuntime(repos, {
    probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }),
    admitTask: (session, request) => ledger.admit(session, request),
    recordUsage: (session, attempt, reading) => ledger.record(session, attempt, reading),
    driverFactory: (_agent, _protocol, emit) => {
      let stopped = false;
      return { start: async () => {}, resume: async () => {}, stop: async () => { stopped = true; }, isStopped: () => stopped, interrupt: async () => {}, send: async prompt => {
        prompts.push(prompt);
        const responding = prompt.includes('[冻结的非指令材料 JSON]');
        const snapshot = JSON.parse(prompt.split(responding ? '[冻结的非指令材料 JSON]\n' : '[非指令材料 JSON]\n')[1]!.split(responding ? '\n[/冻结的非指令材料]' : '\n[/非指令材料]')[0]!) as CollaborationSnapshot;
        const trigger = snapshot.observations.find(item => item.origin === 'live')!;
        emit({ type: 'text', data: { text: JSON.stringify(responding ? { response: '补充一条进展。' } : { action: 'reply', reason: '需要回复', evidenceIds: [trigger.id] }) } });
        emit({ type: 'status', data: { state: 'turn_usage', usageRef: `r${prompts.length}`, cost: { amount: turnCostUsd, currency: 'USD' } } });
        emit({ type: 'completed', data: { stopReason: 'end_turn' } });
      } } satisfies AgentDriver;
    }
  });
  const agent: AgentConfig = { id: 'mock', name: 'Mock', command: process.execPath, args: [], protocol: 'acp', cwd, env: {}, permissionMode: 'full-trust', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };
  await runtime.initialize([agent]);
  const config: StoredLarkConfig = { appId: scope.appId, appSecret: 'fake', defaultAgentId: 'mock', workspace: cwd, listening: true, permissionMode: 'ask', fullTrustConfirmed: true,
    preInjectPrompt: '', groupToolsEnabled: false, groupToolsAllowSend: false, allowedUsers: [], allowedEmails: [], highRiskAllowedUsers: [], highRiskAllowedEmails: [], highRiskPattern: 'danger', riskControlMode: 'off', hideTraceOnComplete: false, pushIntervalMs: 1000 } as StoredLarkConfig;
  await repos.config.set(larkBotsConfigKey, JSON.stringify([config]));
  await repos.collaboration.updateSettings(scope, { expectedRevision: 0, participation: 'selective' }, 'owner');
  const service = { listChatMessages: vi.fn(async () => ({ items: [], hasMore: false })), replyText: vi.fn(async (_input: { messageId: string; text: string }) => ({ messageId: 'om_reply' })), sendText: vi.fn(async () => ({ messageId: 'om_sent' })),
    send: vi.fn(), reply: vi.fn(), addReaction: vi.fn(async () => ({ reactionId: 'reaction_new' })), listOwnReactions: vi.fn(async () => []), deleteReaction: vi.fn(async () => {}) };
  const participation = new LarkGroupParticipation({ repository: repos.collaboration, decider: new ReadonlyParticipationDecider({ runtime, repos, workspaceRoot: join(cwd, 'decision') }), authorize: async () => true,
    readConfig: async () => config, serviceFor: () => service as any, listScopes: async () => [scope], usageRefusal: current => ledger.refusal(current.appId, current.chatId), debounceMs: 10000 });
  const coordinator = new LarkMessageCoordinator(runtime, service as any, { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, Math.random, 'ou_bot', undefined, repos.channelMappings, async () => 'group', undefined, undefined, { store: repos.config, participation });
  cleanups.push(async () => { coordinator.stop(); participation.closeApp(scope.appId); await participation.flush(scope); await runtime.shutdown(); repos.close(); await rm(cwd, { recursive: true, force: true }); });
  const ambient = async (messageId: string, text: string) => {
    await coordinator.handle({ messageId, chatId: scope.chatId, chatType: 'group', senderOpenId: 'ou_member', senderType: 'user', messageType: 'text', content: JSON.stringify({ text }), createTime: String(Date.now()), mentions: [] }, config);
    await participation.flush(scope);
  };
  return { repos, runtime, ledger, notify, prompts, service, scope, ambient };
}

describe('群参与遇到月度成本上限', () => {
  it('用满后未 @ 的消息不再判定、不建会话，群里只收到一次已用满通知', async () => {
    const h = await participationHarness(0.1);
    await h.ledger.setCap({ scope: 'group', appId: 'cli_cmd', chatId: 'oc_group', monthlyCostUsd: 1 });
    await h.repos.usage.append(priorSpend(1.5));
    await h.ambient('om_a', '草稿已提交，等待审核');
    await h.ambient('om_b', '审核意见已经回来了');
    expect(h.prompts).toEqual([]);
    expect(await h.runtime.listSessions()).toEqual([]);
    expect(h.service.replyText).not.toHaveBeenCalled();
    const [gate] = await h.repos.collaboration.listDecisions(h.scope);
    expect(gate).toMatchObject({ action: 'silent', status: 'suppressed', reason: refusal('$1.50'), inputSnapshot: { gate: 'usage_cap' } });
    await vi.waitFor(() => expect(h.notify).toHaveBeenCalledTimes(1));
    expect(h.notify.mock.calls[0]!.slice(0, 2)).toEqual([h.scope, `用量提醒：${refusal('$1.50')}`]);
  });

  it('判定本身把成本用满时，回复生成被拒，群里收到的是上限说明而不是稍后重试', async () => {
    const h = await participationHarness(1.2);
    await h.ledger.setCap({ scope: 'group', appId: 'cli_cmd', chatId: 'oc_group', monthlyCostUsd: 1 });
    await h.ambient('om_a', '草稿已提交，等待审核');
    // 只跑了判定；回复生成的会话在派发前被拒。
    expect(h.prompts).toHaveLength(1);
    expect(h.service.replyText).toHaveBeenCalledOnce();
    expect(h.service.replyText.mock.calls[0]![0]).toMatchObject({ messageId: 'om_a', text: refusal('$1.20') });
    expect((await h.repos.collaboration.listDecisions(h.scope))[0]).toMatchObject({ status: 'failed', response: refusal('$1.20') });
    await vi.waitFor(() => expect(h.notify.mock.calls.map(call => call[1])).toContain(`用量提醒：${refusal('$1.20')}`));
  });
});

describe('定时任务遇到月度成本上限', () => {
  it('不派发，运行记录写明上限；群里第一次收到已用满通知，之后每次说明本次未执行', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dutydeck-usage-cap-schedule-'));
    const repos = createRepositories(join(cwd, 'state.db'), { newDatabaseAuthority: 'ledger_v1' });
    const notify = vi.fn(async (_target: { appId: string; chatId: string }, _text: string, _key: string) => {});
    const ledger = new UsageLedger({ repositories: repos, notify });
    const prompts: string[] = [];
    const clock = { value: new Date('2026-09-12T00:00:30.000Z') };
    let service!: SessionAutomationService;
    const runtime = new DutydeckRuntime(repos, {
      cleanupIntervalMs: 0,
      probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }),
      authorizeExecution: async () => {},
      authorizeTask: (_session, task, phase) => service.authorizeTask(task, phase),
      admitTask: (session, request) => ledger.admit(session, request),
      driverFactory: (_agent, _protocol, emit) => ({ start: async () => {}, resume: async () => {}, stop: async () => {}, interrupt: async () => {}, send: async prompt => {
        prompts.push(prompt);
        emit({ type: 'text', data: { text: 'ok' } });
        emit({ type: 'completed', data: { stopReason: 'end_turn' } });
      } } satisfies AgentDriver)
    });
    service = new SessionAutomationService({ repositories: repos, runtime, authorize: async () => true, clock: () => new Date(clock.value), deliver: async () => {} });
    const agent: AgentConfig = { id: 'mock', name: 'Mock', command: process.execPath, args: [], protocol: 'acp', cwd, env: {}, permissionMode: 'ask', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };
    await runtime.initialize([agent]);
    cleanups.push(async () => { await service.close(); await runtime.shutdown(); repos.close(); await rm(cwd, { recursive: true, force: true }); });
    const parent = await runtime.start({ agentId: 'mock', cwd, source: 'lark', sourceId: 'cli_cmd:oc_group:group:chat:oc_group', permissionMode: 'ask' });
    await ledger.setCap({ scope: 'group', appId: 'cli_cmd', chatId: 'oc_group', monthlyCostUsd: 1 });
    await repos.usage.append(priorSpend(1.5));
    const created = await service.createSchedule(parent.id, { name: '巡检', prompt: '检查构建', trigger: { kind: 'interval', everySeconds: 60, anchorAt: '2026-09-12T00:00:00.000Z' },
      timezone: 'UTC', dstPolicy: { gap: 'skip', overlap: 'first' }, condition: { kind: 'always' } }, 'ou_owner');
    await service.updateSchedule(parent.id, created.id, { expectedRevision: 1, enabled: true }, 'ou_owner');
    const refused = async (count: number) => {
      for (let i = 0; i < 300; i++) {
        await service.tick();
        const occurrences = (await service.listBySession(parent.id)).occurrences;
        if (occurrences.filter(item => item.runStatus === 'error').length >= count) return occurrences;
        await new Promise(resolve => setTimeout(resolve, 15));
      }
      throw new Error('scheduled run was not refused');
    };
    clock.value = new Date('2026-09-12T00:01:30.000Z');
    await refused(1);
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    clock.value = new Date('2026-09-12T00:02:30.000Z');
    const occurrences = await refused(2);
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(2));
    expect(prompts).toEqual([]);
    expect(occurrences.map(item => item.error)).toEqual([refusal('$1.50'), refusal('$1.50')]);
    expect(notify.mock.calls.map(call => call.slice(0, 2))).toEqual([
      [{ appId: 'cli_cmd', chatId: 'oc_group' }, `用量提醒：${refusal('$1.50')}`],
      [{ appId: 'cli_cmd', chatId: 'oc_group' }, `定时任务本次未执行：${refusal('$1.50')}`]
    ]);
  });
});
