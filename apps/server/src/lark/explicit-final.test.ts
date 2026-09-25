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
import { buildLarkCard, LarkServiceError } from './service.js';
import { LarkAgentToolCapabilityRegistry, LarkAgentToolsService } from './agent-tools.js';
import { resolveExplicitFinalContext } from './explicit-final.js';

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

async function harness(options: { verificationCommand?: string; verifications?: VerificationResponse[]; fail?: boolean; interrupted?: boolean; reaction?: boolean; text?: string; p2p?: boolean; groupMention?: boolean } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'dutydeck-lark-resultcard-'));
  const repos = createRepositories(join(cwd, 'state.db'), { newDatabaseAuthority: 'ledger_v1' });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const runtime = new DutydeckRuntime(repos, {
    probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }),
    driverFactory: (_config, _protocol, emit) => ({
      start: async () => {}, resume: async () => {}, stop: async () => {}, interrupt: async () => {},
      send: async () => {
        await gate;
        // 收尾活动不是文本时 Runtime 判为失败，失败态才给「重试」按钮。
        if (options.fail) emit({ type: 'tool_call', data: { id: 'tool_1', name: 'Bash', input: {}, status: 'running' } });
        else emit({ type: 'text', data: { text: options.text ?? '完整最终答复' } });
        emit({ type: 'completed', data: { stopReason: options.interrupted ? 'cancelled' : 'end_turn' } });
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
    groupCardMention: options.groupMention ?? false, groupToolsEnabled: true, groupToolsAllowSend: true, pushIntervalMs: 1_000, hideTraceOnComplete: false,
    completionReactionOnly: options.reaction ?? false, silentProgress: false, urgentEnabled: false, pinLongTasks: false,
    allowedUsers: [], allowedEmails: [], allowedBots: [], peerBotsAllowed: false,
    highRiskAllowedUsers: [], highRiskAllowedEmails: [], highRiskPattern: 'dangerous', riskControlMode: 'off',
    ...(options.verificationCommand ? { verificationCommand: options.verificationCommand } : {}) };
  await repos.config.set(larkBotsConfigKey, JSON.stringify([config]));

  let nextCard = 0;
  const cards = new Map<string, any>();
  const providerUuids = new Map<string, string>();
  const createCard = async (input: any) => {
    const previous = input.idempotencyKey ? providerUuids.get(input.idempotencyKey) : undefined;
    if (previous) return { messageId: previous };
    const id = `om_card_${++nextCard}`; cards.set(id, input);
    if (input.idempotencyKey) providerUuids.set(input.idempotencyKey, id);
    return { messageId: id };
  };
  const service = {
    send: vi.fn(createCard), reply: vi.fn(createCard), sendText: vi.fn(createCard), replyText: vi.fn(createCard),
    getBotInfo: vi.fn(async () => ({ appName: 'test', openId: 'ou_bot' })),
    getMessage: vi.fn(async (id: string) => ({ messageId: id, chatId: 'oc_group', threadId: 'omt_topic' })),
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
  cleanups.push(async () => { coordinator.stop(); release(); await runtime.shutdown(); repos.close(); await rm(cwd, { recursive: true, force: true }); });

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
  await coordinator.handle({ ...event('om_origin'), ...(options.p2p ? { chatType: 'p2p' as const, threadId: undefined, rootId: undefined } : {}) }, config);
  const mapping = await vi.waitFor(async () => {
    const [row] = await repos.channelMappings.list(channel);
    expect(row && JSON.parse(row.extra!).runtime_task_id).toBeTruthy();
    return row!;
  });
  const session = (await repos.sessions.get(mapping.sessionId))!;
  const capabilities = new LarkAgentToolCapabilityRegistry(repos.sessions, 'http://localhost', 'fixed-test-secret');
  const token = capabilities.environmentFor(session).dutydeck_group_tools_token!;
  const authorize = vi.fn(async () => {});
  const tools = new LarkAgentToolsService(capabilities, repos.config, {
    authorizeTool: authorize, clientFactory: () => service as any,
    workbenchTask: id => runtime.getActiveTaskContext(id),
    finalTaskContext: async (binding, task) => resolveExplicitFinalContext(await repos.channelMappings.list(channel), binding, task)
  });
  const active = runtime.getActiveTaskContext(session.id)!;
  expect(active.attemptId).toBeTruthy();
  const turn = capabilities.finalTurnToken(session.id, active.taskId, active.attemptId!);
  const sendFinal = (content = options.text ?? '完整最终答复', extra = {}) => tools.send(token, { content, final: true, turn, ...extra });
  return { repos, runtime, config, coordinator, createCoordinator, service, cards, log, channel, persisted, patchPersisted, resultCard, runVerification,
    release, mapping, session, capabilities, tools, token, active, turn, sendFinal, authorize };

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

const resultSends = (h: Awaited<ReturnType<typeof harness>>) => [...h.service.send.mock.calls, ...h.service.reply.mock.calls].map(([input]) => input).filter(input => input.cardKind === 'result');

describe('explicit final: real tools, runtime, coordinator and SQLite', () => {
  it.each(['completion', 'restart', 'unupdatable'] as const)('keeps the group mention once in the rendered result footer after %s', async mode => {
    const h = await harness({ groupMention: true });
    const sent = await h.sendFinal();
    if (mode === 'unupdatable') {
      const update = h.service.update.getMockImplementation()!;
      h.service.update.mockImplementation(async input => {
        if (input.messageId === sent.messageId) throw new LarkServiceError('LARK_API_ERROR', 'unupdatable', 400, { upstreamCode: 230031 });
        return update(input);
      });
    }
    if (mode === 'restart') h.coordinator.stop();
    h.release();
    if (mode === 'restart') {
      await vi.waitFor(async () => expect((await h.runtime.getTasks(h.session.id))[0]?.status).toBe('completed'));
      const restarted = h.createCoordinator();
      try { await restarted.reconcile(h.config); }
      finally { restarted.stop(); }
    }
    const saved = await h.resultCard();
    const card: any = buildLarkCard(h.cards.get(saved.final_message_id!));
    const mention = '<at id=ou_alice></at>';
    expect(JSON.stringify(card).split(mention)).toHaveLength(2);
    expect(card.body.elements.some((item: any) => item.element_id === 'group_mention')).toBe(false);
    const footer = card.body.elements.at(-1);
    expect(footer.tag).toBe('column_set');
    expect(footer.columns[0].elements[0].content).toContain(mention);
    expect(resultSends(h)).toHaveLength(mode === 'unupdatable' ? 2 : 1);
    expect(saved.final_message_id === sent.messageId).toBe(mode !== 'unupdatable');
  });

  it.each([false, true])('delivers one answer and updates the same card with verification but no export button (reaction=%s)', async reaction => {
    const h = await harness({ verificationCommand: 'pnpm test', reaction });
    const sent = await h.sendFinal();
    expect(h.cards.get(sent.messageId)).toMatchObject({ state: 'running', statusLabel: '答复已送达，执行尚未结束' });
    h.release();
    const saved = await h.resultCard();
    expect(saved.final_message_id).toBe(sent.messageId);
    expect(resultSends(h)).toHaveLength(1);
    const card = h.cards.get(sent.messageId);
    expect(card).toMatchObject({ state: 'completed', capabilities: { canVerify: true } });
    expect(card.elements.filter((item: any) => item.element_id === 'final_output')).toEqual([{ tag: 'markdown', element_id: 'final_output', content: '完整最终答复' }]);
    expect(callbackValues(buildLarkCard(card)).some(value => value.action === 'verify')).toBe(true);
    expect(callbackValues(buildLarkCard(card)).some(value => value.dutydeck_export_trace === 'download')).toBe(false);
  });

  it('serializes an in-flight explicit send with completion', async () => {
    const h = await harness();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const reply = h.service.reply.getMockImplementation()!;
    h.service.reply.mockImplementation(async input => { if (input.cardKind === 'result') await gate; return reply(input); });
    const first = h.sendFinal();
    await vi.waitFor(() => expect(resultSends(h)).toHaveLength(1));
    h.release();
    release();
    const a = await first;
    expect((await h.resultCard()).final_message_id).toBe(a.messageId);
    expect(resultSends(h)).toHaveLength(1);
  });

  it('rejects conflicting contents but preserves ordinary progress delivery', async () => {
    const h = await harness();
    const [a, b] = await Promise.all([h.sendFinal(), h.sendFinal()]);
    expect(b.messageId).toBe(a.messageId);
    await expect(h.sendFinal('different answer')).rejects.toMatchObject({ code: 'FINAL_CONTENT_CONFLICT' });
    expect(resultSends(h)).toHaveLength(1);
    const progress = await harness();
    await progress.tools.send(progress.token, { content: 'working' });
    progress.release();
    await progress.resultCard();
    expect(progress.service.sendText).toHaveBeenCalledTimes(1);
    expect(resultSends(progress)).toHaveLength(1);
  });

  it('rejects old task/attempt, other sessions, forged tokens, target overrides, empty answer and turn without final', async () => {
    const h = await harness();
    for (const turn of ['forged', h.capabilities.finalTurnToken(h.session.id, h.active.taskId, 'old-attempt'),
      h.capabilities.finalTurnToken(h.session.id, 'old-task', h.active.attemptId!), h.capabilities.finalTurnToken('other-session', h.active.taskId, h.active.attemptId!)]) {
      await expect(h.sendFinal('answer', { turn })).rejects.toMatchObject({ code: 'FINAL_TURN_EXPIRED' });
    }
    for (const extra of [{ to: 'ou_other' }, { idempotencyKey: 'custom' }, { replyTo: 'om_other' }, { inThread: false }]) {
      await expect(h.sendFinal('answer', extra)).rejects.toMatchObject({ code: 'FINAL_TARGET_MISMATCH' });
    }
    await expect(h.sendFinal(' ')).rejects.toMatchObject({ code: 'INVALID_GROUP_MESSAGE' });
    await expect(h.tools.send(h.token, { content: 'answer', turn: h.turn })).rejects.toMatchObject({ code: 'FINAL_FLAG_REQUIRED' });
    expect(resultSends(h)).toHaveLength(0);
    h.release(); await h.resultCard();
    await expect(h.sendFinal()).rejects.toMatchObject({ code: 'FINAL_NO_ACTIVE_TASK' });
  });

  it('checks permission changes and exact durable targets without guessing from the prompt', async () => {
    const h = await harness();
    h.authorize.mockRejectedValueOnce(Object.assign(new Error('permission revoked'), { code: 'DENIED' }));
    await expect(h.sendFinal()).rejects.toMatchObject({ code: 'DENIED' });
    await h.patchPersisted({ chat_id: 'oc_other' });
    await expect(h.sendFinal()).rejects.toMatchObject({ code: 'FINAL_MAPPING_UNAVAILABLE' });
    await h.patchPersisted({ chat_id: 'oc_group', runtime_task_id: 'old-task' });
    await expect(h.sendFinal()).rejects.toMatchObject({ code: 'FINAL_MAPPING_UNAVAILABLE' });
    expect(resultSends(h)).toHaveLength(0);
  });

  it.each(['reply', 'replyFile'] as const)('never falls back from failed strict %s to the group main conversation', async method => {
    const h = await harness({ text: method === 'replyFile' ? '长正文'.repeat(20000) : 'answer' });
    h.service[method].mockRejectedValueOnce(new Error('provider failure'));
    await expect(h.sendFinal()).rejects.toThrow('provider failure');
    expect(h.service.send).not.toHaveBeenCalled();
    expect(h.service.sendFile).not.toHaveBeenCalled();
    const rows = await h.repos.config.list!('lark.explicit_final.');
    expect(JSON.parse(rows[0]!.value)).toMatchObject({ status: 'failed' });
    h.release();
    await h.resultCard();
    expect(resultSends(h).filter(input => input.state === 'completed')).toHaveLength(1);
  });

  it('does not report success on receipt storage failure and recovers with the original provider UUID', async () => {
    const h = await harness();
    const set = h.repos.config.set.bind(h.repos.config);
    let fail = true;
    vi.spyOn(h.repos.config, 'set').mockImplementation(async (key, value) => {
      if (fail && key.startsWith('lark.explicit_final.') && JSON.parse(value).message_id) { fail = false; throw new Error('disk failed'); }
      return set(key, value);
    });
    await expect(h.sendFinal()).rejects.toThrow('disk failed');
    const firstUuid = resultSends(h)[0]!.idempotencyKey;
    const receipt = await h.sendFinal();
    expect(receipt.messageId).toBeTruthy();
    expect(resultSends(h)).toHaveLength(1);
    expect(JSON.parse((await h.repos.config.list!('lark.explicit_final.'))[0]!.value).provider_uuid).toBe(firstUuid);
    h.release();
    expect((await h.resultCard()).final_message_id).toBe(receipt.messageId);
  });

  it('reconciles after restart and the restored verify action really runs and updates the same receipt', async () => {
    const h = await harness({ verificationCommand: 'pnpm test' });
    const sent = await h.sendFinal();
    h.coordinator.stop(); h.release();
    await vi.waitFor(async () => expect((await h.runtime.getTasks(h.session.id))[0]?.status).toBe('completed'));
    const restarted = h.createCoordinator();
    try {
      // Deliberately no initializeWorkflows: verification must work independently.
      await restarted.reconcile(h.config);
      const saved = await h.persisted();
      expect(saved.final_message_id).toBe(sent.messageId);
      expect(saved.final_card_input).toMatchObject({ capabilities: { canVerify: true } });
      const verify = callbackValues(buildLarkCard(h.cards.get(sent.messageId))).find(value => value.action === 'verify')!;
      expect(verify).toBeTruthy();
      expect(await restarted.handleAction(verify, 'ou_alice', { messageId: sent.messageId, chatId: 'oc_group' })).toMatchObject({ type: 'success' });
      await vi.waitFor(() => expect(h.runVerification).toHaveBeenCalledWith(h.session.id, { command: 'pnpm test' }));
      await vi.waitFor(() => expect(JSON.stringify(h.cards.get(sent.messageId))).toContain('验证通过'));
      await restarted.reconcile(h.config);
      expect(resultSends(h)).toHaveLength(1);
    } finally { restarted.stop(); }
  });

  it('retains one attachment for long answers through completion and restart', async () => {
    const text = '完整长结果🙂'.repeat(8000);
    const h = await harness({ text, verificationCommand: 'pnpm test' });
    const sent = await h.sendFinal();
    h.release();
    const saved = await h.resultCard();
    expect(saved.final_message_id).toBe(sent.messageId);
    expect(saved.final_attachment_message_id).toBe(sent.attachmentMessageId);
    expect(h.service.uploadFile).toHaveBeenCalledTimes(1);
    expect(h.service.replyFile).toHaveBeenCalledTimes(1);
    expect(resultSends(h)).toHaveLength(1);
    expect(h.cards.get(sent.messageId).capabilities.canVerify).toBe(true);
  });

  it('failure after an explicit answer still sends a diagnostic card', async () => {
    const h = await harness({ fail: true });
    const sent = await h.sendFinal(); h.release();
    const saved = await h.resultCard();
    expect(saved.state).toBe('failed');
    expect(saved.final_message_id).not.toBe(sent.messageId);
    expect(resultSends(h)).toHaveLength(2);
  });

  it('p2p keeps the bound chat and updates its original message', async () => {
    const h = await harness({ p2p: true });
    const sent = await h.sendFinal(); h.release();
    expect((await h.resultCard()).final_message_id).toBe(sent.messageId);
    expect(resultSends(h)).toHaveLength(1);
    expect(h.service.send).toHaveBeenCalledWith(expect.objectContaining({ cardKind: 'result', chatId: 'oc_group' }));
  });
});
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


it('preserves an existing acceptance workflow and its callback on the same explicit result', async () => {
  const h = await harness({ verificationCommand: 'pnpm test' });
  const record = await seedResultInteraction(h);
  const sent = await h.sendFinal(); h.release(); await h.resultCard();
  expect(JSON.stringify(buildLarkCard(h.cards.get(sent.messageId)))).toContain('验收通过');
  expect(await h.coordinator.handleAction({ dutydeck_workflow: 'accept', request_id: record.id, generation: record.boot },
    'ou_alice', { messageId: sent.messageId, chatId: 'oc_group' })).toMatchObject({ type: 'success' });
  await vi.waitFor(() => expect(JSON.stringify(h.cards.get(sent.messageId))).toContain('验收：已通过'));
  expect(resultSends(h)).toHaveLength(1);
});

it('moves full content to one attachment if terminal metadata exceeds the initial card budget', async () => {
  const text = 'x'.repeat(22500);
  const h = await harness({ text, verificationCommand: 'echo '.repeat(1200) });
  const sent = await h.sendFinal();
  expect(sent.attachmentMessageId).toBeUndefined();
  expect(h.service.uploadFile).not.toHaveBeenCalled();
  h.release(); const saved = await h.resultCard();
  expect(saved.final_message_id).toBe(sent.messageId);
  expect(saved.final_attachment_message_id).toBeTruthy();
  expect(h.service.uploadFile).toHaveBeenCalledTimes(1);
  expect(h.service.replyFile).toHaveBeenCalledTimes(1);
  expect(Buffer.from((h.service.uploadFile.mock.calls as any)[0][0].data).toString()).toContain(text);
  expect(JSON.stringify(buildLarkCard(h.cards.get(sent.messageId)))).toContain('verification_status');
  expect(resultSends(h)).toHaveLength(1);
});

it.each(['attempt', 'turn', 'target', 'version', 'elements', 'status', 'empty-message'])('does not suppress automatic output for an invalid %s receipt', async field => {
  const h = await harness(); await h.sendFinal();
  const [row] = await h.repos.config.list!('lark.explicit_final.');
  const record = JSON.parse(row!.value);
  if (field === 'attempt') record.scope.attempt_id = 'old-attempt';
  if (field === 'turn') record.scope.turn++;
  if (field === 'target') record.scope.chat_id = 'oc_other';
  if (field === 'version') record.version = 999;
  if (field === 'elements') record.elements = [];
  if (field === 'status') record.status = 'pending';
  if (field === 'empty-message') record.message_id = ' ';
  await h.repos.config.set(row!.key, JSON.stringify(record));
  h.release(); await h.resultCard();
  expect(resultSends(h)).toHaveLength(2);
  expect(resultSends(h)[1]!.state).toBe('completed');
});

it('retries a failed terminal PATCH on restart without sending the answer again', async () => {
  const h = await harness(); const sent = await h.sendFinal();
  const update = h.service.update.getMockImplementation()!;
  h.service.update.mockImplementation(async input => { if (input.messageId === sent.messageId) throw new Error('temporary patch failure'); return update(input); });
  h.release();
  await vi.waitFor(() => expect(h.log.error).toHaveBeenCalledWith(expect.anything(), '交付飞书执行结果失败，等待对账补偿'));
  expect((await h.persisted()).final_delivery_state).toBeUndefined();
  h.coordinator.stop(); h.service.update.mockImplementation(update);
  const restarted = h.createCoordinator();
  try { await restarted.reconcile(h.config); expect((await h.persisted()).final_message_id).toBe(sent.messageId); }
  finally { restarted.stop(); }
  expect(resultSends(h)).toHaveLength(1);
});

it('recovers a provider success whose summary receipt write failed, using the same provider UUID after restart', async () => {
  const h = await harness();
  const compareAndSet = h.repos.config.compareAndSet!.bind(h.repos.config);
  let fail = true;
  vi.spyOn(h.repos.config, 'compareAndSet').mockImplementation(async (key, expected, value) => {
    if (fail && key.startsWith('lark.delivery.final_') && key.endsWith('.summary')) { fail = false; throw new Error('summary disk failure'); }
    return compareAndSet(key, expected, value);
  });
  await expect(h.sendFinal()).rejects.toThrow('summary disk failure');
  const [firstId] = [...h.cards].find(([, input]) => input.cardKind === 'result')!;
  const uuid = resultSends(h)[0]!.idempotencyKey;
  h.coordinator.stop(); h.release();
  await vi.waitFor(async () => expect((await h.runtime.getTasks(h.session.id))[0]?.status).toBe('completed'));
  const restarted = h.createCoordinator();
  try {
    await restarted.reconcile(h.config);
    expect((await h.persisted()).final_message_id).toBe(firstId);
    expect(resultSends(h)).toHaveLength(2);
    expect(resultSends(h).every(input => input.idempotencyKey === uuid)).toBe(true);
    expect([...h.cards.values()].filter(input => input.cardKind === 'result')).toHaveLength(1);
  } finally { restarted.stop(); }
});

it('an interrupted attempt retains a separate diagnostic card', async () => {
  const h = await harness({ interrupted: true }); const sent = await h.sendFinal(); h.release();
  const saved = await h.resultCard();
  expect(saved.state).toBe('interrupted');
  expect(saved.final_message_id).not.toBe(sent.messageId);
  expect(resultSends(h)).toHaveLength(2);
});

it('restart delivers a cancellation diagnostic even if an explicit answer exists', async () => {
  const h = await harness(); const sent = await h.sendFinal(); h.coordinator.stop(); h.release();
  await vi.waitFor(async () => expect((await h.runtime.getTasks(h.session.id))[0]?.status).toBe('completed'));
  const tasks = await h.runtime.getTasks(h.session.id);
  vi.spyOn(h.runtime, 'getTasks').mockResolvedValue(tasks.map(task => ({ ...task, status: 'cancelled' })));
  const restarted = h.createCoordinator();
  try {
    await restarted.reconcile(h.config);
    expect((await h.persisted()).state).toBe('cancelled');
    expect((await h.persisted()).final_message_id).not.toBe(sent.messageId);
    expect(resultSends(h)).toHaveLength(2);
  } finally { restarted.stop(); }
});

it('publishes a domain-separated attempt token in the prompt only', async () => {
  const h = await harness();
  const prompt = await h.tools.promptForSession(h.session, 'request');
  expect(prompt).toContain(`group send '<完整答复>' --final --turn ${h.turn}`);
  expect(h.turn).not.toBe(h.capabilities.workbenchTurnToken(h.session.id, h.active.taskId));
  expect(JSON.stringify(h.capabilities.environmentFor(h.session))).not.toContain(h.turn);
  await h.repos.config.set(larkBotsConfigKey, JSON.stringify([{ ...h.config, groupToolsAllowSend: false }]));
  expect(await h.tools.promptForSession(h.session, 'request')).not.toContain('--final --turn');
});

it('provides only platform controls when the original card is permanently unupdatable', async () => {
  const h = await harness({ verificationCommand: 'pnpm test' }); const sent = await h.sendFinal();
  const update = h.service.update.getMockImplementation()!;
  h.service.update.mockImplementation(async input => {
    if (input.messageId === sent.messageId) throw new LarkServiceError('LARK_API_ERROR', 'unupdatable', 400, { upstreamCode: 230031 });
    return update(input);
  });
  h.release(); const saved = await h.resultCard();
  expect(saved.final_message_id).not.toBe(sent.messageId);
  const status = h.cards.get(saved.final_message_id!);
  expect(JSON.stringify(status.elements)).toContain('正文已交付');
  expect(JSON.stringify(status.elements)).not.toContain('完整最终答复');
  expect(status).toMatchObject({ capabilities: { canVerify: true } });
  expect(resultSends(h)).toHaveLength(2);
});

it.each([
  ['missing-elements', 'completion'], ['bad-json', 'completion'],
  ['missing-elements', 'restart'], ['bad-json', 'restart']
])('recovers a %s summary cache through %s with the original provider UUID', async (damage, recovery) => {
  const h = await harness(); const sent = await h.sendFinal();
  const [row] = await h.repos.config.list!('lark.explicit_final.');
  const record = JSON.parse(row!.value);
  delete record.message_id; delete record.elements; record.status = 'pending';
  await h.repos.config.set(row!.key, JSON.stringify(record));
  const summaryKey = `lark.delivery.${record.provider_uuid}.summary`;
  const damaged = damage === 'bad-json' ? '{broken' : JSON.stringify({ messageId: 'om_fake' });
  await h.repos.config.set(summaryKey, damaged);
  const compareAndSet = vi.spyOn(h.repos.config, 'compareAndSet');
  if (recovery === 'restart') h.coordinator.stop();
  h.release();
  await vi.waitFor(async () => expect((await h.runtime.getTasks(h.session.id))[0]?.status).toBe('completed'));
  if (recovery === 'completion') await h.resultCard();
  h.coordinator.stop();
  for (let restart = 0; restart < 2; restart++) {
    const restarted = h.createCoordinator();
    try {
      await restarted.reconcile(h.config);
      expect((await h.persisted()).final_message_id).toBe(sent.messageId);
      expect(h.cards.get(sent.messageId).state).toBe('completed');
    } finally { restarted.stop(); }
  }
  expect(compareAndSet).toHaveBeenCalledWith(summaryKey, damaged, expect.any(String));
  expect(resultSends(h)).toHaveLength(2);
  expect(resultSends(h).every(input => input.idempotencyKey === record.provider_uuid)).toBe(true);
  expect([...h.cards.values()].filter(input => input.cardKind === 'result')).toHaveLength(1);
  expect(JSON.parse((await h.repos.config.get(summaryKey))!)).toMatchObject({ messageId: sent.messageId,
    elements: [{ tag: 'markdown', element_id: 'final_output', content: '完整最终答复' }] });
  expect(JSON.parse((await h.repos.config.get(row!.key))!)).toMatchObject({ status: 'delivered', message_id: sent.messageId });
});

it.each([['completion', 1], ['restart', 1], ['restart', 2]] as const)(
  'keeps one attachment after %s recovery from %s failed summary attempts', async (recovery, failures) => {
    const h = await harness({ text: 'long answer '.repeat(6000) });
    for (let attempt = 0; attempt < failures; attempt++) {
      h.service.reply.mockRejectedValueOnce(new Error('temporary summary failure'));
      await expect(h.sendFinal()).rejects.toThrow('temporary summary failure');
      expect(h.service.replyFile).toHaveBeenCalledTimes(1);
      const [pending] = await h.repos.config.list!('lark.explicit_final.');
      expect(JSON.parse(pending!.value)).toMatchObject({ status: 'pending' });
    }
    const [row] = await h.repos.config.list!('lark.explicit_final.');
    const record = JSON.parse(row!.value);
    const fileInput = h.service.replyFile.mock.calls[0]![0];
    const fileId = [...h.cards].find(([, input]) => input.fileKey)![0];
    if (recovery === 'restart') h.coordinator.stop();
    h.release();
    await vi.waitFor(async () => expect((await h.runtime.getTasks(h.session.id))[0]?.status).toBe('completed'));
    if (recovery === 'completion') await h.resultCard();
    h.coordinator.stop();
    for (let restart = 0; restart < 2; restart++) {
      const restarted = h.createCoordinator();
      try { await restarted.reconcile(h.config); }
      finally { restarted.stop(); }
    }
    const saved = await h.persisted();
    expect(saved.final_message_id).toBeTruthy();
    expect(saved.final_attachment_message_id).toBe(fileId);
    expect(h.cards.get(saved.final_message_id!).state).toBe('completed');
    expect(h.service.replyFile).toHaveBeenCalledTimes(1);
    expect(h.service.replyFile).toHaveBeenCalledWith(fileInput);
    expect(h.service.uploadFile).toHaveBeenCalledTimes(1);
    expect(resultSends(h)).toHaveLength(failures + 1);
    expect(resultSends(h).every(input => input.idempotencyKey === record.provider_uuid)).toBe(true);
    expect([...h.cards.values()].filter(input => input.cardKind === 'result')).toHaveLength(1);
    expect(JSON.parse((await h.repos.config.get(row!.key))!)).toMatchObject({
      status: 'delivered', provider_uuid: record.provider_uuid, message_id: saved.final_message_id, attachment_message_id: fileId
    });
  }
);
