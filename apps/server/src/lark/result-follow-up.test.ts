// 结果卡续问行的端到端回归：真实 DutydeckRuntime + SQLite，飞书接口用替身。
//
// 1) 一键续问：点击等同于在原话题回复一条固定文本，进入同一个会话的下一轮；权限与发消息一致，
//    重复点击、回调重投、服务重启后再点，都只提交一轮。
// 2) 重复请求提议定时：同一人、同一聊天、14 天内发过同一句话才给「每天 HH:MM 自动执行」，
//    点击后建出 cron 计划、回报位置是原话题，重复点击不重复建。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRepositories } from '@dutydeck/storage';
import { DutydeckRuntime, type AgentDriver } from '@dutydeck/runtime';
import type { AgentConfig } from '@dutydeck/shared';
import { LarkMessageCoordinator, type PersistedLarkCardTask } from './coordinator.js';
import { larkBotsConfigKey, type StoredLarkConfig } from './config.js';
import type { LarkMessageEvent } from './listener.js';
import { buildLarkCard } from './service.js';
import { larkCardFollowUpPrompt } from './card-actions.js';
import { prepareLarkResult } from './result-delivery.js';
import { SessionAutomationService } from '../session-automation.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const event = (id: string, text: string, patch: Partial<LarkMessageEvent> = {}): LarkMessageEvent => ({
  messageId: id, chatId: 'oc_group', chatType: 'group', threadId: 'omt_topic', rootId: 'om_root',
  senderOpenId: 'ou_alice', senderType: 'user', messageType: 'text', content: JSON.stringify({ text: `@_user_1 ${text}` }),
  mentions: [{ key: '@_user_1', name: 'Dock', openId: 'ou_bot' }], ...patch
});

async function harness(options: { fail?: boolean; automation?: boolean; config?: Partial<StoredLarkConfig> } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'dutydeck-lark-followup-'));
  const repos = createRepositories(join(cwd, 'state.db'), { newDatabaseAuthority: 'ledger_v1' });
  const prompts: string[] = [];
  const runtime = new DutydeckRuntime(repos, {
    probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }),
    driverFactory: (_config, _protocol, emit) => ({
      start: async () => {}, resume: async () => {}, stop: async () => {}, interrupt: async () => {}, isStopped: async () => true,
      send: async prompt => {
        prompts.push(typeof prompt === 'string' ? prompt : JSON.stringify(prompt));
        if (options.fail) emit({ type: 'tool_call', data: { id: 'tool_1', name: 'Bash', input: {}, status: 'running' } });
        else emit({ type: 'text', data: { text: `第 ${prompts.length} 轮结论` } });
        emit({ type: 'completed', data: { stopReason: 'end_turn' } });
      }
    } satisfies AgentDriver)
  });
  const agent: AgentConfig = { id: 'mock', name: 'Mock', command: process.execPath, args: [], protocol: 'acp', cwd, env: {},
    permissionMode: 'ask', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };
  await runtime.initialize([agent]);
  const config: StoredLarkConfig = { appId: 'cli_followup', appSecret: 'fake-secret', name: 'Dock', workspace: cwd, defaultAgentId: 'mock',
    permissionMode: 'ask', listening: true, fullTrustConfirmed: true, preInjectPrompt: '', structuredAskCards: false,
    groupCardMention: false, groupToolsEnabled: false, groupToolsAllowSend: false, pushIntervalMs: 1_000, hideTraceOnComplete: false,
    completionReactionOnly: false, silentProgress: false, urgentEnabled: false, pinLongTasks: false,
    allowedUsers: [], allowedEmails: [], allowedBots: [], peerBotsAllowed: false,
    highRiskAllowedUsers: [], highRiskAllowedEmails: [], highRiskPattern: 'dangerous', riskControlMode: 'off', ...options.config };
  await repos.config.set(larkBotsConfigKey, JSON.stringify([config]));

  let nextMessage = 0;
  const cards = new Map<string, any>();
  const createCard = async (input: any) => { const id = `om_card_${++nextMessage}`; cards.set(id, input); return { messageId: id }; };
  const service = {
    send: vi.fn(createCard), reply: vi.fn(createCard),
    replyText: vi.fn(async (_input: { messageId: string; text: string; replyInThread?: boolean; idempotencyKey?: string }) => ({ messageId: `om_echo_${++nextMessage}` })),
    uploadFile: vi.fn(async () => 'file_1'), replyFile: vi.fn(createCard), sendFile: vi.fn(createCard),
    update: vi.fn(async (input: any) => { cards.set(input.messageId, input); return { messageId: input.messageId }; }),
    addReaction: vi.fn(async (messageId: string, emojiType = 'OK') => ({ messageId, reactionId: `r_${messageId}_${emojiType}` })),
    deleteReaction: vi.fn(async () => {}), getUserEmails: vi.fn(async () => [] as string[]),
    listChatMembers: vi.fn(async () => ({ items: [{ memberId: 'ou_alice' }, { memberId: 'ou_bob' }], hasMore: false })),
    listChatMessages: vi.fn(async () => ({ items: [] as any[], hasMore: false })),
    getMessageItems: vi.fn(async () => [] as any[])
  };
  const automation = options.automation
    ? new SessionAutomationService({ repositories: repos, runtime, authorize: async (_sessionId, actor) => actor === 'ou_alice' || actor === 'ou_bob' })
    : undefined;
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const createCoordinator = () => new LarkMessageCoordinator(runtime, service as any, log, Math.random, 'ou_bot',
    undefined, repos.channelMappings, async () => 'group', undefined, undefined, { store: repos.config, ...(automation ? { automation } : {}) });
  let coordinator = createCoordinator();
  await coordinator.initializeWorkflows(config);
  await coordinator.startReconciliation(config, 60_000);
  cleanups.push(async () => {
    coordinator.stop(); await automation?.close(); await runtime.shutdown(); repos.close();
    await rm(cwd, { recursive: true, force: true });
  });

  const channel = `lark-card:${config.appId}`;
  const persisted = async (taskId: string) => {
    const mapping = await repos.channelMappings.get(channel, taskId);
    return { sessionId: mapping!.sessionId, ...JSON.parse(mapping!.extra!) as PersistedLarkCardTask };
  };
  const result = (taskId: string) => vi.waitFor(async () => {
    const saved = await persisted(taskId);
    expect(saved.final_message_id).toBeTruthy();
    return saved;
  }, { timeout: 10_000 });
  const run = async (input: LarkMessageEvent) => { await coordinator.handle(input, config); return result(input.messageId); };
  const card = (messageId: string) => buildLarkCard(cards.get(messageId));
  const click = (value: unknown, operator: string, saved: { final_message_id?: string; chat_id: string }) =>
    coordinator.handleAction(value, operator, { messageId: saved.final_message_id, chatId: saved.chat_id });
  const restart = async () => {
    coordinator.stop();
    coordinator = createCoordinator();
    await coordinator.initializeWorkflows(config);
    await coordinator.startReconciliation(config, 60_000);
  };
  return { repos, runtime, config, service, cards, prompts, automation, log, persisted, result, run, card, click, restart, get coordinator() { return coordinator; } };
}

const findElement = (node: unknown, id: string): Record<string, any> | undefined => {
  if (Array.isArray(node)) {
    for (const item of node) { const found = findElement(item, id); if (found) return found; }
    return undefined;
  }
  if (!node || typeof node !== 'object') return undefined;
  const record = node as Record<string, any>;
  if (record.element_id === id) return record;
  for (const value of Object.values(record)) { const found = findElement(value, id); if (found) return found; }
  return undefined;
};
const buttonsOf = (node: unknown, out: Record<string, any>[] = []): Record<string, any>[] => {
  if (Array.isArray(node)) node.forEach(item => buttonsOf(item, out));
  else if (node && typeof node === 'object') {
    const record = node as Record<string, any>;
    if (record.tag === 'button') out.push(record);
    Object.values(record).forEach(value => buttonsOf(value, out));
  }
  return out;
};
const followUpLabels = (card: unknown) => buttonsOf(findElement(card, 'result_follow_up_row')).map(button => button.text.content);
const callbackOf = (card: unknown, action: string) => buttonsOf(card)
  .flatMap(button => (button.behaviors ?? []).map((behavior: any) => behavior.value))
  .find(value => value?.action === action);
const clock = (at: number) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);

describe('结果卡一键续问', () => {
  it('已完成的结果卡在正文之后带三个续问按钮；失败卡不带', async () => {
    const h = await harness();
    const saved = await h.run(event('om_1', '查一下登录为什么慢'));
    const card = h.card(saved.final_message_id!);
    expect(followUpLabels(card)).toEqual(['说人话', '给我对外回复', '再详细点']);
    // 续问行在结论之后：结论仍坐在卡片第一行。
    const ids = card.body.elements.map((element: any) => element.element_id);
    expect(ids.indexOf('result_follow_up_row')).toBeGreaterThan(ids.indexOf('final_output'));
    expect(callbackOf(card, 'ask_plain')).toEqual({ action: 'ask_plain', task_id: 'om_1', turn: String(saved.turn) });

    const failed = await harness({ fail: true });
    const failedSaved = await failed.run(event('om_1', '查一下登录为什么慢'));
    expect(failedSaved.state).toBe('failed');
    expect(findElement(failed.card(failedSaved.final_message_id!), 'result_follow_up_row')).toBeUndefined();
  });

  it('超长结果改发附件时，摘要卡同样带续问按钮', async () => {
    const h = await harness();
    const saved = await h.run(event('om_1', '查一下登录为什么慢'));
    const input = { ...saved.final_card_input, elements: [{ tag: 'markdown', element_id: 'final_output', content: '长'.repeat(40_000) }], idempotencyKey: 'long_1' };
    const prepared = await prepareLarkResult(h.service as any, { chatId: 'oc_group', replyMessageId: 'om_1', replyInThread: true }, input as any, h.log, h.repos.config);
    expect(prepared.attachmentMessageId).toBeTruthy();
    const summary = buildLarkCard(prepared.input);
    expect(findElement(summary, 'result_attachment')).toBeTruthy();
    expect(followUpLabels(summary)).toEqual(['说人话', '给我对外回复', '再详细点']);
  });

  it('点击等同于在原话题回复固定文本：进入同一个会话的下一轮', async () => {
    const h = await harness();
    const first = await h.run(event('om_1', '查一下登录为什么慢'));
    // 话题会话由在话题里发言的人共用：别的群成员点也等同于他在话题里回复。
    const value = callbackOf(h.card(first.final_message_id!), 'ask_plain');
    expect(await h.click(value, 'ou_bob', first)).toMatchObject({ type: 'success' });

    expect(h.service.replyText).toHaveBeenCalledTimes(1);
    const echoInput = h.service.replyText.mock.calls[0]![0];
    expect(echoInput).toMatchObject({ messageId: first.final_message_id, replyInThread: true });
    const echoId = (await h.service.replyText.mock.results[0]!.value).messageId as string;

    const followUp = await h.result(echoId);
    expect(followUp.sessionId).toBe(first.sessionId);
    expect(followUp.prompt).toBe(larkCardFollowUpPrompt('ask_plain'));
    expect(followUp.sender_open_id).toBe('ou_bob');
    expect(followUp.scope_id).toBe(first.scope_id);
    expect(h.prompts).toHaveLength(2);
    expect(h.prompts[1]).toContain(larkCardFollowUpPrompt('ask_plain'));
    // 新一轮的卡片回复在代发的那条消息下面，留在原话题里。
    expect(h.service.reply).toHaveBeenCalledWith(expect.objectContaining({ messageId: echoId, replyInThread: true }));
    // 点击不改原结果卡：原卡只在投递时写过一次。
    expect(h.service.update.mock.calls.some(([input]: any[]) => input.messageId === first.final_message_id)).toBe(false);
    // 续问的结果卡还能接着问，但不会被当成重复请求提议定时。
    const next = h.card(followUp.final_message_id!);
    expect(followUpLabels(next)).toEqual(['说人话', '给我对外回复', '再详细点']);
  });

  it('无权限时不提交：白名单外的成员、按发送人隔离的会话里的旁人', async () => {
    const restricted = await harness({ config: { allowedUsers: [{ openId: 'ou_alice', name: 'Alice' }] } });
    const saved = await restricted.run(event('om_1', '查一下登录为什么慢'));
    const value = callbackOf(restricted.card(saved.final_message_id!), 'ask_reply');
    expect(await restricted.click(value, 'ou_bob', saved)).toMatchObject({ type: 'warning', content: expect.stringContaining('白名单') });
    expect(restricted.service.replyText).not.toHaveBeenCalled();
    expect(restricted.prompts).toHaveLength(1);

    // 普通群不在话题里时按发送人隔离会话：旁人在原位置发言会进他自己的会话，续问因此只接发起人本人。
    const legacy = await harness();
    const flat = await legacy.run(event('om_1', '查一下登录为什么慢', { threadId: undefined, rootId: undefined }));
    expect(flat.scope_id).toBe('user:ou_alice');
    const flatValue = callbackOf(legacy.card(flat.final_message_id!), 'ask_reply');
    expect(await legacy.click(flatValue, 'ou_bob', flat)).toMatchObject({ type: 'warning', content: expect.stringContaining('发起人本人') });
    expect(legacy.service.replyText).not.toHaveBeenCalled();
    expect(await legacy.click(flatValue, 'ou_alice', flat)).toMatchObject({ type: 'success' });
    expect(legacy.service.replyText).toHaveBeenCalledWith(expect.not.objectContaining({ replyInThread: true }));
  });

  it('话题里发过 /new 之后，旧结果卡不再接受续问', async () => {
    const h = await harness();
    const saved = await h.run(event('om_1', '查一下登录为什么慢'));
    const value = callbackOf(h.card(saved.final_message_id!), 'ask_detail');
    await h.coordinator.handle(event('om_new', '/new'), h.config);
    await vi.waitFor(async () => expect((await h.runtime.getSession(saved.sessionId))?.state).toBe('stopped'), { timeout: 10_000 });
    expect(await h.click(value, 'ou_alice', saved)).toMatchObject({ type: 'warning', content: expect.stringContaining('会话已结束') });
    expect(h.service.replyText).not.toHaveBeenCalled();
    expect(h.prompts).toHaveLength(1);
  });

  it('重复点击、回调重投与重启后再点，都只提交一轮', async () => {
    const h = await harness();
    const saved = await h.run(event('om_1', '查一下登录为什么慢'));
    const value = callbackOf(h.card(saved.final_message_id!), 'ask_plain');
    const [left, right] = await Promise.all([h.click(value, 'ou_alice', saved), h.click(value, 'ou_alice', saved)]);
    expect([left, right].filter(item => item.type === 'success')).toHaveLength(1);
    expect(await h.click(value, 'ou_alice', saved)).toMatchObject({ type: 'warning', content: expect.stringContaining('已经提交过') });
    const echoId = (await h.service.replyText.mock.results[0]!.value).messageId as string;
    await h.result(echoId);
    // 代发的那条消息已被 handle 认领并受理：重启后的 recoverable 不会再重放它。
    await vi.waitFor(async () => expect(JSON.parse((await h.repos.config.get(`lark.inbox.cli_followup.${echoId}`))!).state).toBe('accepted'), { timeout: 10_000 });

    await h.restart();
    expect(await h.click(value, 'ou_alice', saved)).toMatchObject({ type: 'warning', content: expect.stringContaining('已经提交过') });
    expect(h.service.replyText).toHaveBeenCalledTimes(1);
    expect(h.prompts).toHaveLength(2);
    // 同一张卡上的另一个按钮是另一条追问，照常提交。
    expect(await h.click(callbackOf(h.card(saved.final_message_id!), 'ask_detail'), 'ou_alice', saved)).toMatchObject({ type: 'success' });
    await vi.waitFor(() => expect(h.prompts).toHaveLength(3), { timeout: 10_000 });
  });

  it('上个进程在代发前退出：重启后再点由这次点击接手，只提交一轮', async () => {
    const h = await harness();
    const saved = await h.run(event('om_1', '查一下登录为什么慢'));
    const value = callbackOf(h.card(saved.final_message_id!), 'ask_plain');
    // 第一次点击卡在代发消息上，进程随即退出（dutydeck restart 只等运行中的任务，不等卡片回调）。
    h.service.replyText.mockImplementationOnce(() => new Promise<never>(() => {}));
    void h.click(value, 'ou_alice', saved);
    await vi.waitFor(() => expect(h.service.replyText).toHaveBeenCalledTimes(1));
    await h.restart();

    expect(await h.click(value, 'ou_alice', saved)).toMatchObject({ type: 'success' });
    expect(h.service.replyText).toHaveBeenCalledTimes(2);
    // 重做沿用同一个幂等键：上个进程其实已经发出去的话，飞书不会再发第二条。
    expect(h.service.replyText.mock.calls[1]![0].idempotencyKey).toBe(h.service.replyText.mock.calls[0]![0].idempotencyKey);
    const echoId = (await h.service.replyText.mock.results[1]!.value).messageId as string;
    expect((await h.result(echoId)).prompt).toBe(larkCardFollowUpPrompt('ask_plain'));
    expect(h.prompts).toHaveLength(2);
    expect(await h.click(value, 'ou_alice', saved)).toMatchObject({ type: 'warning', content: expect.stringContaining('已经提交过') });
    expect(h.prompts).toHaveLength(2);
  });

  it('上个进程代发之后退出：接手沿用那条消息；已登记进 inbox 的不再提交', async () => {
    const h = await harness();
    const saved = await h.run(event('om_1', '查一下登录为什么慢'));
    const value = callbackOf(h.card(saved.final_message_id!), 'ask_detail');
    h.service.replyText.mockImplementationOnce(() => new Promise<never>(() => {}));
    void h.click(value, 'ou_alice', saved);
    await vi.waitFor(() => expect(h.service.replyText).toHaveBeenCalledTimes(1));
    await h.restart();
    // 上个进程已代发出 om_echo_sent 并记进认领，还没来得及登记进 inbox 就退出了。
    const [row] = await h.repos.config.list!('lark.result_follow_up.cli_followup.');
    await h.repos.config.set(row!.key, JSON.stringify({ ...JSON.parse(row!.value), message_id: 'om_echo_sent' }));

    expect(await h.click(value, 'ou_alice', saved)).toMatchObject({ type: 'success' });
    expect(h.service.replyText).toHaveBeenCalledTimes(1);
    expect((await h.result('om_echo_sent')).prompt).toBe(larkCardFollowUpPrompt('ask_detail'));
    await vi.waitFor(async () => expect(JSON.parse((await h.repos.config.get('lark.inbox.cli_followup.om_echo_sent'))!).state).toBe('accepted'), { timeout: 10_000 });
    expect(h.prompts).toHaveLength(2);

    // 登记进 inbox 之后、标记完成之前退出：接手时认出这条消息已经登记，不提交第二次。
    const [done] = await h.repos.config.list!('lark.result_follow_up.cli_followup.');
    await h.repos.config.set(done!.key, JSON.stringify({ ...JSON.parse(done!.value), phase: 'claimed', boot: 'previous-boot' }));
    await h.restart();
    expect(await h.click(value, 'ou_alice', saved)).toMatchObject({ type: 'warning', content: expect.stringContaining('已经提交过') });
    expect(h.service.replyText).toHaveBeenCalledTimes(1);
    expect(h.prompts).toHaveLength(2);
  });
});

describe('重复请求时提议每天自动执行', () => {
  it('同一人同一群 14 天内发过同一句话：给出「每天 HH:MM 自动执行」', async () => {
    const h = await harness({ automation: true });
    const first = await h.run(event('om_1', '@Dock  详细总结下今天的聊天内容'));
    expect(followUpLabels(h.card(first.final_message_id!))).toEqual(['说人话', '给我对外回复', '再详细点']);
    const second = await h.run(event('om_2', '详细总结下今天的聊天内容'));
    expect(followUpLabels(h.card(second.final_message_id!)))
      .toEqual(['说人话', '给我对外回复', '再详细点', `每天 ${clock(second.started_at)} 自动执行`]);
  });

  it.each([
    ['不同的人', { senderOpenId: 'ou_bob' }],
    ['不同的群', { chatId: 'oc_other' }]
  ])('%s发过同一句话不算重复', async (_label, patch) => {
    const h = await harness({ automation: true });
    await h.run(event('om_1', '详细总结下今天的聊天内容', patch));
    const second = await h.run(event('om_2', '详细总结下今天的聊天内容'));
    expect(followUpLabels(h.card(second.final_message_id!))).toEqual(['说人话', '给我对外回复', '再详细点']);
  });

  it('超过 14 天的旧请求不算重复', async () => {
    const h = await harness({ automation: true });
    await h.run(event('om_1', '详细总结下今天的聊天内容'));
    const mapping = (await h.repos.channelMappings.get('lark-card:cli_followup', 'om_1'))!;
    const extra = JSON.parse(mapping.extra!) as PersistedLarkCardTask;
    await h.repos.channelMappings.save({ ...mapping, extra: JSON.stringify({ ...extra, started_at: Date.now() - 15 * 24 * 60 * 60 * 1000 }) });
    const second = await h.run(event('om_2', '详细总结下今天的聊天内容'));
    expect(followUpLabels(h.card(second.final_message_id!))).toEqual(['说人话', '给我对外回复', '再详细点']);
  });

  it('话题里已有同样内容的已启用计划时不再提议', async () => {
    const h = await harness({ automation: true });
    const first = await h.run(event('om_1', '详细总结下今天的聊天内容'));
    const existing = await h.automation!.createSchedule(first.sessionId, { name: '已有计划', prompt: '详细总结下今天的聊天内容',
      trigger: { kind: 'cron', expression: '0 18 * * *' }, timezone: 'Asia/Shanghai', dstPolicy: { gap: 'skip', overlap: 'first' }, condition: { kind: 'always' } }, 'ou_alice');
    await h.automation!.updateSchedule(first.sessionId, existing.id, { expectedRevision: existing.revision, enabled: true }, 'ou_alice');
    const second = await h.run(event('om_2', '详细总结下今天的聊天内容'));
    expect(followUpLabels(h.card(second.final_message_id!))).toEqual(['说人话', '给我对外回复', '再详细点']);
  });

  it('点击后建出每天的 cron 计划、回报到原话题，卡上改为「已设为…」，重复点击不重复建', async () => {
    const h = await harness({ automation: true, config: { allowedUsers: [{ openId: 'ou_alice', name: 'Alice' }] } });
    await h.run(event('om_1', '详细总结下今天的聊天内容'));
    const second = await h.run(event('om_2', '详细总结下今天的聊天内容'));
    const time = clock(second.started_at);
    const value = callbackOf(h.card(second.final_message_id!), 'schedule_daily');
    expect(value).toEqual({ action: 'schedule_daily', task_id: 'om_2', turn: String(second.turn) });

    // 权限与 /schedule 相同：白名单外的成员建不了。
    expect(await h.click(value, 'ou_bob', second)).toMatchObject({ type: 'warning' });
    expect((await h.automation!.listBySession(second.sessionId, 'ou_alice')).schedules).toHaveLength(0);

    expect(await h.click(value, 'ou_alice', second)).toMatchObject({ type: 'success', content: `已设为每天 ${time} 自动执行。` });
    const schedules = (await h.automation!.listBySession(second.sessionId, 'ou_alice')).schedules;
    expect(schedules).toHaveLength(1);
    const [hour, minute] = time.split(':').map(Number);
    expect(schedules[0]).toMatchObject({ enabled: true, prompt: '详细总结下今天的聊天内容', timezone: 'Asia/Shanghai',
      trigger: { kind: 'cron', expression: `${minute} ${hour} * * *` } });
    expect(schedules[0]!.nextDueAt).toBeTruthy();
    expect(JSON.parse((await h.repos.config.get(`automation.delivery-target.${schedules[0]!.id}`))!))
      .toEqual({ appId: 'cli_followup', chatId: 'oc_group', replyMessageId: 'om_2', replyInThread: true });

    // 原结果卡在后台重绘：定时按钮变成不可点的「已设为…」，其余按钮原样保留。
    await vi.waitFor(() => expect(followUpLabels(buildLarkCard(h.cards.get(second.final_message_id!))))
      .toEqual(['说人话', '给我对外回复', '再详细点', `已设为每天 ${time} 自动执行`]));
    expect(callbackOf(buildLarkCard(h.cards.get(second.final_message_id!)), 'schedule_daily')).toBeUndefined();
    // 回执（同样在后台发）：计划名、下次执行时间、停用方法。
    const receipt = await vi.waitFor(() => {
      const found = h.service.reply.mock.calls.map(([input]: any[]) => input).find((input: any) => input.taskName === '定时任务');
      expect(found).toBeDefined();
      return found;
    });
    expect(receipt).toMatchObject({ messageId: second.final_message_id, replyInThread: true });
    expect(receipt.markdown).toContain('详细总结下今天的聊天内容');
    expect(receipt.markdown).toContain('下一次：');
    expect(receipt.markdown).toContain(`/schedule disable ${schedules[0]!.id}`);

    expect(await h.click(value, 'ou_alice', second)).toMatchObject({ type: 'success' });
    await h.restart();
    expect(await h.click(value, 'ou_alice', second)).toMatchObject({ type: 'success' });
    expect((await h.automation!.listBySession(second.sessionId, 'ou_alice')).schedules).toHaveLength(1);
    expect(h.prompts).toHaveLength(2);
  });

  it.each([
    ['建计划之前', 'createSchedule'],
    ['计划已建好、启用之前', 'updateSchedule']
  ] as const)('上个进程在%s退出：换人再点接手补完，只有一个启用的计划', async (_label, stuck) => {
    const h = await harness({ automation: true });
    await h.run(event('om_1', '详细总结下今天的聊天内容'));
    const second = await h.run(event('om_2', '详细总结下今天的聊天内容'));
    const time = clock(second.started_at);
    const value = callbackOf(h.card(second.final_message_id!), 'schedule_daily');
    const spy = vi.spyOn(h.automation!, stuck).mockImplementationOnce(() => new Promise<never>(() => {}));
    void h.click(value, 'ou_alice', second);
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    await h.restart();

    // 计划编号按「会话 + 操作人 + 键」算：换一个人接手时，要按登记找回上个进程建的那条补完，而不是另建一条。
    expect(await h.click(value, 'ou_bob', second)).toMatchObject({ type: 'success', content: `已设为每天 ${time} 自动执行。` });
    const schedules = (await h.automation!.listBySession(second.sessionId, 'ou_alice')).schedules;
    expect(schedules).toHaveLength(1);
    expect(schedules[0]).toMatchObject({ enabled: true, prompt: '详细总结下今天的聊天内容' });
    expect(JSON.parse((await h.repos.config.get(`automation.delivery-target.${schedules[0]!.id}`))!))
      .toEqual({ appId: 'cli_followup', chatId: 'oc_group', replyMessageId: 'om_2', replyInThread: true });
    await vi.waitFor(() => expect(followUpLabels(buildLarkCard(h.cards.get(second.final_message_id!))).at(-1)).toBe(`已设为每天 ${time} 自动执行`));
    expect(await h.click(value, 'ou_alice', second)).toMatchObject({ type: 'success' });
    expect((await h.automation!.listBySession(second.sessionId, 'ou_alice')).schedules).toHaveLength(1);
  });

  it('飞书重绘卡住时点击仍立即回 toast，回执不排在重绘后面', async () => {
    const h = await harness({ automation: true });
    await h.run(event('om_1', '详细总结下今天的聊天内容'));
    const second = await h.run(event('om_2', '详细总结下今天的聊天内容'));
    const value = callbackOf(h.card(second.final_message_id!), 'schedule_daily');
    h.service.update.mockImplementation(() => new Promise<never>(() => {}));
    const outcome = await Promise.race([h.click(value, 'ou_alice', second), new Promise(resolve => setTimeout(() => resolve('timeout'), 2_000))]);
    expect(outcome).toMatchObject({ type: 'success' });
    expect((await h.automation!.listBySession(second.sessionId, 'ou_alice')).schedules).toMatchObject([{ enabled: true }]);
    await vi.waitFor(() => expect(h.service.reply.mock.calls.some(([input]: any[]) => input.taskName === '定时任务')).toBe(true));
  });
});
