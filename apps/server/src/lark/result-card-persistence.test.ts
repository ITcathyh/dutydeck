// 结果卡持久化与验收刷新的两条回归。
//
// 1) saveCardTask 此前是整体覆写。重启后重建出来的任务只带回字段子集，于是「重启 → 点
//    运行验证」这一步会把附件绑定、验收状态与冻结标记一起抹掉：✅ 再也打不到那条文件
//    消息上，对账开始反复重绘已终态的卡。
// 2) 验收刷新时 service.update 不传 capabilities，回落默认能力表后只读卡上 0 个按钮，
//    但 elements 里「可点『运行验证』执行。」这句是渲染时写死进 markdown 的，于是按钮
//    没了、文字还在指路。文案与按钮必须同源。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRepositories } from '@dutydeck/storage';
import { DutydeckRuntime, type AgentDriver } from '@dutydeck/runtime';
import type { AgentConfig, VerificationResponse } from '@dutydeck/shared';
import { LarkMessageCoordinator, type PersistedLarkCardTask } from './coordinator.js';
import { larkBotsConfigKey, type StoredLarkConfig } from './config.js';
import type { LarkMessageEvent } from './listener.js';
import type { LarkInteraction } from './workflow-interactions.js';
import { buildLarkCard } from './service.js';
import { LARK_VERIFICATION_ELEMENT_ID } from './card-renderer.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const event = (id: string, text = '改一下登录逻辑'): LarkMessageEvent => ({
  messageId: id, chatId: 'oc_group', chatType: 'group', threadId: 'omt_topic', rootId: 'om_root',
  senderOpenId: 'ou_alice', senderType: 'user', messageType: 'text', content: JSON.stringify({ text }),
  mentions: [{ key: '@_user_1', name: 'Dock', openId: 'ou_bot' }]
});

const verificationRecord = (patch: Partial<VerificationResponse> = {}): VerificationResponse => ({
  schemaVersion: 1, revision: 1, id: 'v1', sessionId: 's1', command: 'pnpm test', cwd: '/tmp',
  status: 'passed', startedAt: '2026-09-18T10:00:00.000Z', completedAt: '2026-09-18T10:03:00.000Z',
  exitCode: 0, output: 'ok', outputTruncated: false,
  beforeFingerprint: 'abcdef1234567890', afterFingerprint: 'abcdef1234567890', stale: false, ...patch
});

async function harness(options: { verificationCommand?: string; verifications?: VerificationResponse[]; fail?: boolean } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'dutydeck-lark-resultcard-'));
  const repos = createRepositories(join(cwd, 'state.db'), { newDatabaseAuthority: 'ledger_v1' });
  const runtime = new DutydeckRuntime(repos, {
    probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }),
    driverFactory: (_config, _protocol, emit) => ({
      start: async () => {}, resume: async () => {}, stop: async () => {}, interrupt: async () => {},
      send: async () => {
        // 收尾活动不是文本时 Runtime 判为失败，失败态才给「重试」按钮。
        if (options.fail) emit({ type: 'tool_call', data: { id: 'tool_1', name: 'Bash', input: {}, status: 'running' } });
        else emit({ type: 'text', data: { text: '登录逻辑已改好' } });
        emit({ type: 'completed', data: { stopReason: 'end_turn' } });
      }
    } satisfies AgentDriver)
  });
  const agent: AgentConfig = { id: 'mock', name: 'Mock', command: process.execPath, args: [], protocol: 'acp', cwd, env: {},
    permissionMode: 'ask', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };
  await runtime.initialize([agent]);
  let stored = options.verifications ?? [];
  const runVerification = vi.fn(async (_id: string, input: { command: string }) => {
    const result = verificationRecord({ command: input.command, id: `v_${stored.length + 1}` });
    stored = [result, ...stored];
    return result;
  });
  (runtime as any).getVerifications = vi.fn(async () => stored);
  (runtime as any).runVerification = runVerification;

  const config: StoredLarkConfig = { appId: 'cli_resultcard', appSecret: 'fake-secret', workspace: cwd, defaultAgentId: 'mock',
    permissionMode: 'ask', listening: true, fullTrustConfirmed: true, preInjectPrompt: '', structuredAskCards: false,
    groupCardMention: false, groupToolsEnabled: false, groupToolsAllowSend: false, pushIntervalMs: 1_000, hideTraceOnComplete: false,
    completionReactionOnly: false, silentProgress: false, urgentEnabled: false, pinLongTasks: false,
    allowedUsers: [], allowedEmails: [], allowedBots: [], peerBotsAllowed: false,
    highRiskAllowedUsers: [], highRiskAllowedEmails: [], highRiskPattern: 'dangerous', riskControlMode: 'off',
    ...(options.verificationCommand ? { verificationCommand: options.verificationCommand } : {}) };
  await repos.config.set(larkBotsConfigKey, JSON.stringify([config]));

  let nextCard = 0;
  const cards = new Map<string, any>();
  const createCard = async (input: any) => { const id = `om_card_${++nextCard}`; cards.set(id, input); return { messageId: id }; };
  const service = {
    send: vi.fn(createCard), reply: vi.fn(createCard),
    uploadFile: vi.fn(async () => 'file_1'), replyFile: vi.fn(createCard), sendFile: vi.fn(createCard),
    update: vi.fn(async (input: any) => { cards.set(input.messageId, input); return { messageId: input.messageId }; }),
    addReaction: vi.fn(async (messageId: string, emojiType = 'OK') => ({ messageId, reactionId: `r_${messageId}_${emojiType}` })),
    deleteReaction: vi.fn(async () => {}), getUserEmails: vi.fn(async () => [] as string[]),
    listChatMembers: vi.fn(async () => ({ items: [{ memberId: 'ou_alice' }], hasMore: false })),
    listChatMessages: vi.fn(async () => ({ items: [] as any[], hasMore: false })),
    getMessageItems: vi.fn(async () => [] as any[]),
    pin: vi.fn(async (messageId: string) => ({ messageId })), unpin: vi.fn(async () => {}),
    urgentApp: vi.fn(async () => ({ invalidUserIdList: [] as string[] })),
    callOpenApi: vi.fn(async () => ({ code: 0, data: {} }))
  };
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const createCoordinator = () => new LarkMessageCoordinator(runtime, service as any, log, Math.random, 'ou_bot',
    undefined, repos.channelMappings, async () => 'group', undefined, undefined, { store: repos.config });
  const coordinator = createCoordinator();
  await coordinator.initializeWorkflows(config);
  cleanups.push(async () => { coordinator.stop(); await runtime.shutdown(); repos.close(); await rm(cwd, { recursive: true, force: true }); });

  const channel = `lark-card:${config.appId}`;
  const persisted = async (): Promise<PersistedLarkCardTask> => {
    const [mapping] = await repos.channelMappings.list(channel);
    return JSON.parse(mapping!.extra!);
  };
  const patchPersisted = async (patch: Partial<PersistedLarkCardTask>) => {
    const [mapping] = await repos.channelMappings.list(channel);
    await repos.channelMappings.save({ ...mapping!, extra: JSON.stringify({ ...JSON.parse(mapping!.extra!), ...patch }) });
  };
  const resultCard = () => vi.waitFor(async () => {
    const saved = await persisted();
    expect(saved.final_message_id).toBeTruthy();
    return saved;
  }, { timeout: 10_000 });
  return { repos, runtime, config, coordinator, createCoordinator, service, cards, log, channel, persisted, patchPersisted, resultCard, runVerification };
}

const callbackValues = (node: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] => {
  if (Array.isArray(node)) node.forEach(item => callbackValues(item, out));
  else if (node && typeof node === 'object') {
    const item = node as Record<string, any>;
    for (const behavior of item.behaviors ?? []) if (behavior?.type === 'callback' && behavior.value) out.push(behavior.value);
    Object.values(item).forEach(value => { if (value && typeof value === 'object') callbackValues(value, out); });
  }
  return out;
};

/** 线上遗留的验收记录：现版本不再新建，但已经发出去的卡片必须继续可验收。 */
async function seedResultInteraction(h: Awaited<ReturnType<typeof harness>>) {
  const [mapping] = await h.repos.channelMappings.list(h.channel);
  const saved = JSON.parse(mapping!.extra!) as PersistedLarkCardTask;
  const id = createHash('sha256')
    .update([h.config.appId, mapping!.sessionId, saved.runtime_task_id, saved.turn, 'result', saved.runtime_task_id, ''].join('\0'))
    .digest('hex').slice(0, 24);
  const record: LarkInteraction = {
    appId: h.config.appId, sessionId: mapping!.sessionId, taskId: saved.runtime_task_id!, turn: saved.turn!,
    event: { ...event(mapping!.externalId, saved.prompt), chatId: saved.chat_id, chatType: saved.chat_type ?? 'group', mentions: [] },
    id, boot: 'legacy_boot', kind: 'result', nativeId: saved.runtime_task_id!, question: '结果验收',
    state: 'pending', cardId: saved.final_message_id, updatedAt: new Date().toISOString()
  };
  await h.repos.config.set(`lark.interaction.${h.config.appId}.${id}`, JSON.stringify(record));
  return record;
}

describe('saveCardTask 的合并语义', () => {
  it('重启后点运行验证，附件绑定、验收状态与冻结标记都不丢', async () => {
    const h = await harness({ verificationCommand: 'pnpm test' });
    await h.coordinator.handle(event('om_1'), h.config);
    const saved = await h.resultCard();
    expect(saved.progress_frozen).toBe(true);
    expect(saved.last_successful_elements?.length).toBeGreaterThan(0);

    // 超长结果转附件交付、以及上一轮验收留下的状态：两者都只存在于持久化记录里，
    // 重启后重建出来的 LarkTask 一个都带不回来。
    await h.patchPersisted({ final_attachment_message_id: 'om_file', result_feedback_state: 'accepted' });
    const before = await h.persisted();
    const verify = callbackValues(buildLarkCard(h.cards.get(before.final_message_id!)))
      .find(value => value.action === 'verify')!;
    expect(verify).toBeTruthy();

    h.coordinator.stop();
    const restarted = h.createCoordinator();
    try {
      await restarted.initializeWorkflows(h.config);
      expect(await restarted.handleAction(verify, 'ou_alice', { messageId: before.final_message_id, chatId: 'oc_group' }))
        .toMatchObject({ type: 'success' });
      await vi.waitFor(() => expect(h.runVerification).toHaveBeenCalled(), { timeout: 10_000 });
      await vi.waitFor(async () => {
        const after = await h.persisted();
        expect(JSON.stringify(after.final_elements)).toContain('已验证');
      }, { timeout: 10_000 });
    } finally { restarted.stop(); }

    const after = await h.persisted();
    // 验证跑完只该换掉验证状态行，不该顺手抹掉这四个字段。
    expect(after.final_attachment_message_id).toBe('om_file');
    expect(after.result_feedback_state).toBe('accepted');
    expect(after.progress_frozen).toBe(true);
    expect(after.last_successful_elements).toEqual(before.last_successful_elements);
  });

  it('推进到新一轮时不合并：上一轮的卡片归属与终态一律清掉', async () => {
    const h = await harness({ fail: true });
    await h.coordinator.handle(event('om_1'), h.config);
    const first = await h.resultCard();
    expect(first.state).toBe('failed');
    expect(first.progress_frozen).toBe(true);

    expect(await h.coordinator.handleAction({ action: 'retry', task_id: 'om_1', turn: String(first.turn) }, 'ou_alice',
      { messageId: first.card_message_id, chatId: 'oc_group' })).toMatchObject({ type: 'success' });
    await vi.waitFor(async () => expect((await h.persisted()).turn).toBe(first.turn! + 1), { timeout: 10_000 });
    const second = await h.persisted();
    expect(second.card_message_id).not.toBe(first.card_message_id);
    expect(second.final_message_id).not.toBe(first.final_message_id);
  });
});

describe('验收刷新后文案与按钮同源', () => {
  it('验收通过后按钮与「可点运行验证」文案同生同灭，不会按钮没了文字还在指路', async () => {
    const h = await harness({ verificationCommand: 'pnpm test' });
    await h.coordinator.handle(event('om_1'), h.config);
    const saved = await h.resultCard();
    const finalId = saved.final_message_id!;
    // 交付时两者一致：有按钮，文案也写着可以点。
    const delivered = buildLarkCard(h.cards.get(finalId));
    expect(JSON.stringify(delivered)).toContain('运行验证');

    const record = await seedResultInteraction(h);
    expect(await h.coordinator.handleAction({ dutydeck_workflow: 'accept', request_id: record.id, generation: record.boot },
      'ou_alice', { messageId: finalId, chatId: 'oc_group' })).toMatchObject({ type: 'success' });

    await vi.waitFor(() => {
      const patched = h.service.update.mock.calls.map(([input]: any[]) => input)
        .filter(input => input.messageId === finalId && JSON.stringify(input.elements).includes('验收：已通过'));
      expect(patched.length).toBeGreaterThan(0);
      return patched.at(-1)!;
    }, { timeout: 10_000 });

    const refreshed = h.cards.get(finalId);
    const card = buildLarkCard(refreshed);
    const hasButton = callbackValues(card).some(value => value.action === 'verify');
    const verificationLine = (refreshed.elements as any[]).find(item => item.element_id === LARK_VERIFICATION_ELEMENT_ID);
    const promisesButton = String(verificationLine?.content ?? '').includes('运行验证');
    expect(promisesButton).toBe(hasButton);
    // 这张卡确实还能验证（记录未验证），所以两者应当同时为真——同源之外还要不掉能力。
    expect(hasButton).toBe(true);
  });

  it('已有记录能证明当前代码时，验收刷新后按钮与文案同时消失', async () => {
    const h = await harness({ verificationCommand: 'pnpm test', verifications: [verificationRecord()] });
    await h.coordinator.handle(event('om_1'), h.config);
    const saved = await h.resultCard();
    const finalId = saved.final_message_id!;

    const record = await seedResultInteraction(h);
    expect(await h.coordinator.handleAction({ dutydeck_workflow: 'accept', request_id: record.id, generation: record.boot },
      'ou_alice', { messageId: finalId, chatId: 'oc_group' })).toMatchObject({ type: 'success' });
    await vi.waitFor(() => expect(JSON.stringify(h.cards.get(finalId).elements)).toContain('验收：已通过'), { timeout: 10_000 });

    const refreshed = h.cards.get(finalId);
    expect(callbackValues(buildLarkCard(refreshed)).some(value => value.action === 'verify')).toBe(false);
    const verificationLine = (refreshed.elements as any[]).find(item => item.element_id === LARK_VERIFICATION_ELEMENT_ID);
    expect(String(verificationLine?.content ?? '')).toContain('已验证');
    expect(String(verificationLine?.content ?? '')).not.toContain('运行验证');
  });
});

describe('卡片映射的并发写', () => {
  it('对账在读改写之间插了一次 compareAndSetExtra，它写的字段不会被覆盖掉', async () => {
    const h = await harness();
    await h.coordinator.handle(event('om_1'), h.config);
    await h.resultCard();

    const [mapping] = await h.repos.channelMappings.list(h.channel);
    // 模拟对账：在协调器读到旧值之后、写回之前，抢先写进一个只有它知道的字段。
    let injected = false;
    const realGet = h.repos.channelMappings.get.bind(h.repos.channelMappings);
    h.repos.channelMappings.get = async (channel: string, externalId: string) => {
      const row = await realGet(channel, externalId);
      if (!injected && row?.extra) {
        injected = true;
        await h.repos.channelMappings.compareAndSetExtra(row.id, row.extra,
          JSON.stringify({ ...JSON.parse(row.extra), recovery_status_key: 'from_reconciler' }));
      }
      return row;
    };
    try {
      await (h.coordinator as any).persistCardTask(
        (h.coordinator as any).restoredCardTask(h.config, mapping!, JSON.parse(mapping!.extra!)), 'completed');
    } finally { h.repos.channelMappings.get = realGet; }

    expect(injected).toBe(true);
    const after = await h.persisted();
    expect(after.recovery_status_key).toBe('from_reconciler');
    expect(after.final_message_id).toBe((JSON.parse(mapping!.extra!) as PersistedLarkCardTask).final_message_id);
  });
});
