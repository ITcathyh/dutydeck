import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepositories } from '@dutydeck/storage';
import { DutydeckRuntime, type AgentDriver } from '@dutydeck/runtime';
import type { AgentConfig, PermissionMode } from '@dutydeck/shared';
import { LarkMessageCoordinator } from './coordinator.js';
import { larkBotsConfigKey, type StoredLarkConfig } from './config.js';
import type { LarkMessageEvent } from './listener.js';
import type { LarkInteraction } from './workflow-interactions.js';
import { planApprovedPrompt, planInstructionBlock } from '../plan-mode.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const event = (id: string, text: string, patch: Partial<LarkMessageEvent> = {}): LarkMessageEvent => ({
  messageId: id, chatId: 'oc_group', chatType: 'group', threadId: 'omt_topic', rootId: 'om_root',
  senderOpenId: 'ou_alice', senderType: 'user', messageType: 'text', content: JSON.stringify({ text: `@_user_1 ${text}` }),
  mentions: [{ key: '@_user_1', name: 'Dock', openId: 'ou_bot', mentionedType: 'bot' }], ...patch
});

/** 计划轮、执行轮都经过真实 Runtime 与持久化存储；Agent 驱动记录每一轮实际收到的权限模式和 prompt。 */
async function harness(agentId = 'claude', options: { completionReactionOnly?: boolean; holdFirstTurn?: Promise<void> } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'dutydeck-lark-plan-'));
  const repos = createRepositories(join(cwd, 'state.db'), { newDatabaseAuthority: 'ledger_v1' });
  const turns: Array<{ prompt: string; mode: PermissionMode }> = [];
  const runtime = new DutydeckRuntime(repos, {
    probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }),
    driverFactory: (config, _protocol, emit) => {
      let mode = config.permissionMode;
      const driver: AgentDriver = {
        start: async () => {}, resume: async () => {}, stop: async () => {}, interrupt: async () => {},
        setPermissionMode: next => { mode = next; },
        send: async prompt => {
          turns.push({ prompt, mode });
          if (turns.length === 1) await options.holdFirstTurn;
          emit({ type: 'text', data: { text: mode === 'deny-all' ? `## 计划 ${turns.length}\n1. 修改 src/login.ts 的报错文案\n2. 运行 pnpm test 验证` : '已按计划完成修改。' } });
          emit({ type: 'completed', data: { stopReason: 'end_turn' } });
        }
      };
      return driver;
    }
  });
  const agent: AgentConfig = { id: agentId, name: agentId === 'claude' ? 'Claude Code' : 'Codex', command: agentId === 'claude' ? 'claude-agent-acp' : 'codex-acp', args: [], protocol: 'acp', cwd, env: {}, permissionMode: 'ask', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };
  await runtime.initialize([agent]);
  const config: StoredLarkConfig = { appId: 'cli_plan', appSecret: 'fake-secret', workspace: cwd, defaultAgentId: agentId, permissionMode: 'ask', listening: true,
    fullTrustConfirmed: true, preInjectPrompt: '', structuredAskCards: false, groupCardMention: false, groupToolsEnabled: false, groupToolsAllowSend: false, pushIntervalMs: 1000, hideTraceOnComplete: false,
    compactTrace: false, allowedUsers: [], allowedEmails: [], allowedBots: [], peerBotsAllowed: false, highRiskAllowedUsers: [{ openId: 'ou_carol', name: 'Carol' }], highRiskAllowedEmails: [], highRiskPattern: 'dangerous', riskControlMode: 'off',
    ...(options.completionReactionOnly ? { completionReactionOnly: true } : {}) };
  await repos.config.set(larkBotsConfigKey, JSON.stringify([config]));
  let nextCard = 0;
  const cards = new Map<string, any>();
  const createCard = async (input: any) => { const id = `om_card_${++nextCard}`; cards.set(id, input); return { messageId: id }; };
  const service = {
    send: vi.fn(createCard), reply: vi.fn(createCard), replyFile: vi.fn(createCard), sendFile: vi.fn(createCard), uploadFile: vi.fn(async () => 'file_1'),
    update: vi.fn(async (input: any) => { cards.set(input.messageId, input); return { messageId: input.messageId }; }),
    addReaction: vi.fn(async (messageId: string) => ({ reactionId: `reaction_${messageId}` })), deleteReaction: vi.fn(async () => {}), getUserEmails: vi.fn(async () => []),
    listChatMembers: vi.fn(async () => ({ items: [{ memberId: 'ou_alice' }, { memberId: 'ou_bob' }], hasMore: false })),
    listChatMessages: vi.fn(async () => ({ items: [], hasMore: false })),
    getMessage: vi.fn(async (id: string) => ({ messageId: id, chatId: 'oc_group', threadId: 'omt_topic', messageType: 'text', rawContent: JSON.stringify({ text: '' }), sender: { type: 'user' }, mentions: [] })),
    getMessageItems: vi.fn(async () => [])
  };
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const createCoordinator = () => new LarkMessageCoordinator(runtime, service as any, log, Math.random, 'ou_bot', undefined, repos.channelMappings, async () => 'group', undefined, undefined, { store: repos.config });
  let current = createCoordinator();
  const coordinator = current;
  await coordinator.initializeWorkflows(config);
  await coordinator.startReconciliation(config);
  cleanups.push(async () => { current.stop(); await runtime.shutdown(); repos.close(); await rm(cwd, { recursive: true, force: true }); });
  /** 进程重启：旧协调器停下，新协调器只凭持久化记录恢复并对账。 */
  const restart = async () => {
    current.stop();
    current = createCoordinator();
    await current.initializeWorkflows(config);
    await current.startReconciliation(config);
    return current;
  };
  const plans = async () => (await repos.config.list!(`lark.interaction.${config.appId}.`)).map(row => JSON.parse(row.value) as LarkInteraction).filter(item => item.kind === 'plan');
  const tasks = async () => (await Promise.all((await runtime.listSessions()).map(session => runtime.getTasks(session.id)))).flat();
  const settled = (count: number) => vi.waitFor(async () => {
    const all = await tasks();
    expect(all.filter(task => task.status === 'completed')).toHaveLength(count);
  }, { timeout: 10_000 });
  /** 待处理、已绑定卡片的那张计划卡（同一时刻最多一张）。 */
  const planCard = async () => {
    let record!: LarkInteraction;
    await vi.waitFor(async () => {
      record = (await plans()).find(item => item.state === 'pending' && item.cardId)!;
      expect(record).toBeTruthy();
    }, { timeout: 10_000 });
    return { record, card: cards.get(record.cardId!) };
  };
  const click = (record: LarkInteraction, action: string, actor = 'ou_alice', extra: Record<string, unknown> = {}) =>
    current.handleAction({ dutydeck_workflow: action, request_id: record.id, generation: record.boot, ...extra }, actor, { messageId: record.cardId, chatId: 'oc_group' });
  return { repos, runtime, config, coordinator, service, cards, turns, plans, tasks, settled, planCard, click, restart };
}

const elementIds = (card: any) => (card.elements as any[]).flatMap(element => [element.element_id, ...(element.elements ?? []).map((child: any) => child.element_id)]);

describe('/plan in Feishu', () => {
  it('runs the plan turn with writes denied, sends a plan card and executes once after approval', async () => {
    const h = await harness();
    await h.coordinator.handle(event('om_plan', '/plan 把登录页的报错改成中文'), h.config);
    await h.settled(1);
    expect(h.turns[0]!.mode).toBe('deny-all');
    expect(h.turns[0]!.prompt).toContain(planInstructionBlock);
    expect(h.turns[0]!.prompt).toContain('把登录页的报错改成中文');
    expect(h.turns[0]!.prompt).not.toContain('/plan');
    const { record, card } = await h.planCard();
    expect(record).toMatchObject({ state: 'pending', question: expect.stringContaining('修改 src/login.ts') });
    expect(Date.parse(record.expiresAt!) - Date.parse(record.updatedAt)).toBeGreaterThan(23 * 3_600_000);
    expect(card.taskName).toBe('计划：把登录页的报错改成中文');
    expect(elementIds(card)).toEqual(expect.arrayContaining(['final_output', 'workflow_plan_status', 'workflow_plan_approve', 'workflow_plan_cancel', 'workflow_plan_form', 'workflow_plan_revise']));

    // 不是发起人的群成员不能批准；发起人 Alice 不在高风险审批名单里也能批准。
    expect(await h.click(record, 'plan_approve', 'ou_bob')).toMatchObject({ type: 'error', content: '当前账号无权操作此任务。' });
    expect((await h.plans())[0]!.state).toBe('pending');

    expect(await h.click(record, 'plan_approve')).toMatchObject({ type: 'success', content: expect.stringContaining('已批准') });
    await h.settled(2);
    expect(h.turns[1]).toMatchObject({ mode: 'ask', prompt: expect.stringContaining(planApprovedPrompt) });
    expect(h.turns[1]!.prompt).not.toContain(planInstructionBlock);
    expect((await h.plans())[0]).toMatchObject({ state: 'approved', actorId: 'ou_alice', decision: 'approve' });
    await vi.waitFor(() => expect(h.cards.get(record.cardId!)).toMatchObject({ statusLabel: '已批准', readOnly: true }), { timeout: 2_000 });
    expect(await h.runtime.listSessions()).toHaveLength(1);

    // 重复点击只生效一次。
    expect(await h.click(record, 'plan_approve')).toMatchObject({ type: 'error' });
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(h.turns).toHaveLength(2);
  });

  it('re-plans with the revision and runs nothing after cancel', async () => {
    const h = await harness();
    await h.coordinator.handle(event('om_plan', '/plan 把登录页的报错改成中文'), h.config);
    await h.settled(1);
    const first = await h.planCard();
    expect(await h.click(first.record, 'plan_revise', 'ou_alice', { form_value: { answer: '' } })).toMatchObject({ type: 'error', content: '请先写下修改意见再提交。' });
    expect(await h.click(first.record, 'plan_revise', 'ou_alice', { form_value: { answer: '只改中文文案，不动样式' } })).toMatchObject({ type: 'success' });
    await h.settled(2);
    expect(h.turns[1]).toMatchObject({ mode: 'deny-all', prompt: expect.stringContaining('只改中文文案，不动样式') });
    expect(h.turns[1]!.prompt).toContain(planInstructionBlock);
    expect((await h.plans()).find(item => item.id === first.record.id)).toMatchObject({ state: 'needs_changes', feedback: '只改中文文案，不动样式' });

    const second = await h.planCard();
    expect(second.record.id).not.toBe(first.record.id);
    // 引用计划卡回复「取消」与点按钮同一路径。
    await h.coordinator.handle(event('om_cancel_reply', '取消', { parentId: second.record.cardId, mentions: [], content: JSON.stringify({ text: '取消' }) }), h.config);
    await vi.waitFor(async () => expect((await h.plans()).find(item => item.id === second.record.id)?.state).toBe('rejected'));
    expect(h.cards.get(second.record.cardId!)).toMatchObject({ statusLabel: '已取消' });
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(h.turns).toHaveLength(2);
    expect(await h.click(second.record, 'plan_approve')).toMatchObject({ type: 'error' });
    expect(h.turns).toHaveLength(2);
  });

  it('expires a plan card when the session moved on, reminds once and times out after 24 hours', async () => {
    const h = await harness();
    await h.coordinator.handle(event('om_plan', '/plan 整理依赖'), h.config);
    await h.settled(1);
    const { record } = await h.planCard();
    const key = `lark.interaction.${h.config.appId}.${record.id}`;
    // 已等 31 分钟：对账提醒一次。
    const waited = { ...record, expiresAt: new Date(Date.now() + 24 * 3_600_000 - 31 * 60_000).toISOString() };
    await h.repos.config.set(key, JSON.stringify(waited));
    await h.coordinator.reconcile(h.config);
    await h.coordinator.reconcile(h.config);
    const reminders = h.service.reply.mock.calls.filter(([input]) => input.taskName === '审批提醒');
    expect(reminders).toHaveLength(1);
    expect(JSON.stringify(reminders[0]![0].elements)).toContain('这份计划已等待 30 分钟');
    // 超过 24 小时：点击按超时收尾，不执行。
    const current = JSON.parse((await h.repos.config.get(key))!);
    await h.repos.config.set(key, JSON.stringify({ ...current, expiresAt: new Date(Date.now() - 1_000).toISOString() }));
    expect(await h.click(record, 'plan_approve')).toMatchObject({ type: 'error', content: expect.stringContaining('24 小时') });
    expect((await h.plans())[0]).toMatchObject({ state: 'expired', timedOutAt: expect.any(String) });
    expect(h.turns).toHaveLength(1);
  });

  it('does not approve a plan once a newer task ran in the session', async () => {
    const h = await harness();
    await h.coordinator.handle(event('om_plan', '/plan 整理依赖'), h.config);
    await h.settled(1);
    const { record } = await h.planCard();
    await h.coordinator.handle(event('om_other', '先看一下 README', { parentId: 'om_unrelated' }), h.config);
    await h.settled(2);
    expect(await h.click(record, 'plan_approve')).toMatchObject({ type: 'error', content: expect.stringContaining('更新的任务') });
    expect((await h.plans())[0]!.state).toBe('expired');
    expect(h.turns).toHaveLength(2);
  });

  // 计划轮跑完、结果卡发出前进程退出：重启补发必须送达计划正文和可用的批准按钮，开了「完成时只贴表情」也一样。
  it.each([false, true])('delivers the plan card with approval after a restart before the result was sent (completionReactionOnly: %s)', async completionReactionOnly => {
    let finishPlan!: () => void;
    const h = await harness('claude', { completionReactionOnly, holdFirstTurn: new Promise<void>(resolve => { finishPlan = resolve; }) });
    await h.coordinator.handle(event('om_plan', '/plan 把登录页的报错改成中文'), h.config);
    await vi.waitFor(() => expect(h.turns).toHaveLength(1), { timeout: 10_000 });
    h.coordinator.stop();
    finishPlan();
    await h.settled(1);
    expect([...h.cards.values()].some(card => card.cardKind === 'result')).toBe(false);
    expect(await h.plans()).toEqual([]);

    const restored = await h.restart();
    const { record, card } = await h.planCard();
    expect(record).toMatchObject({ state: 'pending', question: expect.stringContaining('修改 src/login.ts') });
    expect(card).toMatchObject({ cardKind: 'result', state: 'completed' });
    expect(elementIds(card)).toEqual(expect.arrayContaining(['final_output', 'workflow_plan_status', 'workflow_plan_approve', 'workflow_plan_cancel']));
    const [mapping] = await h.repos.channelMappings.list(`lark-card:${h.config.appId}`);
    expect(JSON.parse(mapping!.extra!)).toMatchObject({ final_delivery_state: 'delivered', final_message_id: record.cardId });

    // 对账再跑不重复发卡，也不另建计划。
    await restored.reconcile(h.config);
    expect([...h.cards.values()].filter(item => item.cardKind === 'result')).toHaveLength(1);
    expect(await h.plans()).toHaveLength(1);

    // 补发的批准按钮仍只认发起人，批准后执行一次。
    expect(await h.click(record, 'plan_approve', 'ou_bob')).toMatchObject({ type: 'error', content: '当前账号无权操作此任务。' });
    expect(await h.click(record, 'plan_approve')).toMatchObject({ type: 'success', content: expect.stringContaining('已批准') });
    await h.settled(2);
    expect(h.turns[1]).toMatchObject({ mode: 'ask', prompt: expect.stringContaining(planApprovedPrompt) });
    expect(await h.click(record, 'plan_approve')).toMatchObject({ type: 'error' });
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(h.turns).toHaveLength(2);
  });

  it('does not create plan actions when restart recovery delivers an ordinary turn', async () => {
    let finishTurn!: () => void;
    const h = await harness('claude', { holdFirstTurn: new Promise<void>(resolve => { finishTurn = resolve; }) });
    await h.coordinator.handle(event('om_plain', '把登录页的报错改成中文'), h.config);
    await vi.waitFor(() => expect(h.turns).toHaveLength(1), { timeout: 10_000 });
    h.coordinator.stop();
    finishTurn();
    await h.settled(1);
    await h.restart();
    await vi.waitFor(() => expect([...h.cards.values()].filter(card => card.cardKind === 'result')).toHaveLength(1), { timeout: 10_000 });
    const card = [...h.cards.values()].find(item => item.cardKind === 'result');
    expect(elementIds(card)).toContain('final_output');
    expect(elementIds(card).filter((id: string | undefined) => id?.startsWith('workflow_plan_'))).toEqual([]);
    expect(await h.plans()).toEqual([]);
  });

  it('refuses /plan on an Agent that cannot block writes instead of running it', async () => {
    const h = await harness('codex');
    await h.coordinator.handle(event('om_plan', '/plan 把登录页的报错改成中文'), h.config);
    await vi.waitFor(() => expect([...h.cards.values()].some(card => card.taskName === '无法先出计划')).toBe(true));
    const card = [...h.cards.values()].find(item => item.taskName === '无法先出计划');
    expect(card).toMatchObject({ state: 'failed', markdown: expect.stringContaining('不支持先出计划') });
    expect(h.turns).toEqual([]);
    expect(await h.tasks()).toEqual([]);
  });

  it('shows usage for an empty /plan and lists /plan in /help', async () => {
    const h = await harness();
    await h.coordinator.handle(event('om_plan_empty', '/plan'), h.config);
    await vi.waitFor(() => expect([...h.cards.values()].some(card => card.taskName === '/plan 未执行')).toBe(true));
    await h.coordinator.handle(event('om_help', '/help 2'), h.config);
    await vi.waitFor(() => expect([...h.cards.values()].some(card => JSON.stringify(card).includes('/plan <任务>'))).toBe(true));
    expect(h.turns).toEqual([]);
  });
});
