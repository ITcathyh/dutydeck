// 多 bot 互相 @ 的硬门禁回归。
//
// 真实事故形态：两个机器人互相 @，几千条消息把群刷爆，把它们移出群再拉回来还会复发。
// 唤醒判据里的 mentionsBot 分支不受 `!botSender` 约束，访问控制在没配成员名单时又对
// 任何机器人一律放行，群参与判定默认 off——三道闸一道都不封口，所以门禁必须自成一层。
//
// 这里用真实 SQLite 协作仓 + 真实 coordinator 接线，service 与 runtime 为 mock：
// 门禁的三条硬约束（挡下的回合不计用量、门禁记录按小时分桶、被挡下不发群消息）
// 只有在真的读写同一张 decisions 表时才能被锁住。
import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createCollaborationSchema } from '../../../../packages/storage/src/collaboration-migration.js';
import { createCollaborationRepository } from '../../../../packages/storage/src/collaboration.js';
import {
  BOT_LOOP_DEPTH_LIMIT, BOT_LOOP_GATE, BOT_TURN_LIMIT_PER_HOUR, BOT_TURN_RECORD,
  countBotTurnUsage, countDecisionUsage, type CollaborationSnapshot, type ConfigRepository
} from '@dutydeck/shared';
import { LarkGroupParticipation } from './group-participation.js';
import { LarkMessageCoordinator } from './coordinator.js';
import { senderGroupMention } from './card-mentions.js';
import { LarkWorkflowInteractions } from './workflow-interactions.js';
import type { LarkGroupManager } from './group-management.js';
import type { LarkMessageEvent } from './listener.js';
import type { StoredLarkConfig } from './config.js';

const scope = { appId: 'cli_guard', chatId: 'oc_guard' };
const config: StoredLarkConfig = {
  appId: scope.appId, appSecret: 'test', listening: true, defaultAgentId: 'mock', workspace: '/tmp', fullTrustConfirmed: true,
  permissionMode: 'ask', preInjectPrompt: '', groupToolsEnabled: false, groupToolsAllowSend: false, structuredAskCards: false,
  groupCardMention: false, pushIntervalMs: 1000, hideTraceOnComplete: false,
  allowedUsers: [], allowedEmails: [], allowedBots: [], peerBotsAllowed: true,
  highRiskAllowedUsers: [], highRiskAllowedEmails: [], highRiskPattern: 'danger', riskControlMode: 'off'
};

const mentionsDock = [{ key: '@_user_1', name: 'Dock', openId: 'ou_bot' }];
const botMessage = (id: string, patch: Partial<LarkMessageEvent> = {}): LarkMessageEvent => ({
  messageId: id, chatId: scope.chatId, chatType: 'group', messageType: 'text', content: JSON.stringify({ text: '继续处理' }),
  createTime: '1789707600000', senderOpenId: 'ou_peer_bot', senderType: 'app', mentions: mentionsDock, ...patch
});
const humanMessage = (id: string, patch: Partial<LarkMessageEvent> = {}): LarkMessageEvent =>
  botMessage(id, { senderOpenId: 'ou_alice', senderType: 'user', ...patch });

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean(); });

function harness(clock: { now: Date } = { now: new Date('2026-09-18T10:00:00.000Z') }, options: { groupManager?: LarkGroupManager; workflow?: boolean } = {}) {
  const db = new Database(':memory:'); createCollaborationSchema(db);
  const repository = createCollaborationRepository(db);
  const service = {
    listChatMessages: vi.fn(async () => ({ items: [] as any[], hasMore: false })),
    replyText: vi.fn(async () => ({ messageId: 'om_sent' })), sendText: vi.fn(async () => ({ messageId: 'om_sent' })),
    addReaction: vi.fn(async () => ({ reactionId: 'reaction' })), deleteReaction: vi.fn(async () => {}),
    send: vi.fn(async () => ({ messageId: 'om_card' })), reply: vi.fn(async () => ({ messageId: 'om_card' })),
    update: vi.fn(async () => ({ messageId: 'om_card' }))
  };
  const decider = { decide: vi.fn(async (_c: StoredLarkConfig, _s: CollaborationSnapshot) => ({ action: 'silent' as const, reason: '无需回复', evidenceIds: [], updates: [] })), respond: vi.fn() };
  const participation = new LarkGroupParticipation({
    repository,
    decider,
    authorize: vi.fn(async () => true), readConfig: async () => config, serviceFor: () => service as any,
    readGroupDescription: async () => '门禁测试群', listScopes: async () => [scope], debounceMs: 10_000,
    now: () => clock.now
  });
  const session = { id: 's1', protocol: 'acp', state: 'idle', agentId: 'mock', cwd: '/tmp', permissionMode: 'ask', createdAt: '', updatedAt: '' };
  const runtime = {
    start: vi.fn(async () => session), getSession: vi.fn(async () => session), subscribe: vi.fn(() => vi.fn()),
    send: vi.fn(async () => {}), interrupt: vi.fn(async () => {}), resolvePermission: vi.fn(async () => {})
  };
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const peerBotAuthorized = vi.fn(async () => true);
  const records = new Map<string, string>([['lark.bots', JSON.stringify([config])]]);
  const store: ConfigRepository = {
    get: async key => records.get(key), set: async (key, value) => { records.set(key, value); },
    list: async prefix => [...records].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })),
    compareAndSet: async (key, expected, value) => {
      if (records.get(key) !== expected) return false;
      records.set(key, value); return true;
    }
  };
  const coordinator = new LarkMessageCoordinator(runtime as any, service as any, log, Math.random, 'ou_bot',
    peerBotAuthorized, undefined, async () => 'group', undefined, options.groupManager, { participation, ...(options.workflow ? { store } : {}) });
  cleanups.push(async () => { coordinator.stop(); await participation.close(); if (db.open) db.close(); });
  return { repository, participation, coordinator, runtime, service, log, clock, decider, peerBotAuthorized, store };
}

const decisions = (h: ReturnType<typeof harness>) => h.repository.listDecisions(scope, 500);
const gateRecords = async (h: ReturnType<typeof harness>) =>
  (await decisions(h)).filter(item => (item.inputSnapshot as { gate?: string }).gate === BOT_LOOP_GATE);
const turnRecords = async (h: ReturnType<typeof harness>) =>
  (await decisions(h)).filter(item => (item.inputSnapshot as { gate?: string }).gate === BOT_TURN_RECORD);

describe.each(['off', 'observe', 'selective'] as const)('机器人定向交接（participation=%s）', mode => {
  async function configuredHarness() {
    const h = harness();
    await h.repository.updateSettings(scope, { expectedRevision: 0, participation: mode }, 'owner');
    return h;
  }
  const restrictedConfig: StoredLarkConfig = { ...config, groupToolsEnabled: true,
    allowedUsers: [{ openId: 'ou_alice', name: 'Alice' }], riskControlMode: 'enforced' };

  it.each(['peer', 'allowlist'] as const)('允许通过%s授权的机器人@，保留机器人身份与工具风险限制', async authorization => {
    const h = await configuredHarness();
    const current = authorization === 'peer' ? restrictedConfig : { ...restrictedConfig, peerBotsAllowed: false,
      allowedBots: [{ openId: 'ou_peer_bot', name: 'Peer' }] };
    if (authorization === 'allowlist') h.peerBotAuthorized.mockResolvedValue(false);
    await h.coordinator.handle(botMessage('om_peer_request'), current);
    await vi.waitFor(() => expect(h.runtime.send).toHaveBeenCalledOnce());
    await h.participation.flush(scope);
    expect(h.peerBotAuthorized).toHaveBeenCalledWith(scope.chatId, 'ou_peer_bot');
    expect(h.runtime.send.mock.calls[0]).toEqual(expect.arrayContaining([expect.objectContaining({ enabled: true, authorized: false })]));
    expect(h.decider.decide).not.toHaveBeenCalled();
    expect(await turnRecords(h)).toHaveLength(1);
    if (mode !== 'off') {
      const observation = (await h.repository.listObservations(scope)).find(item => item.eventId === 'om_peer_request');
      expect(observation?.senderKind).toBe('bot');
      expect(observation?.refs).not.toContain('dutydeck:explicit');
    }
  });

  it('未@的普通机器人消息不启动执行或只读判定', async () => {
    const h = await configuredHarness();
    await h.coordinator.handle(botMessage('om_bot_chat', { mentions: [] }), { ...restrictedConfig, mentionPolicy: 'never' });
    await h.participation.flush(scope);
    expect(h.runtime.start).not.toHaveBeenCalled();
    expect(h.decider.decide).not.toHaveBeenCalled();
    expect(h.service.addReaction).not.toHaveBeenCalled();
    expect(await turnRecords(h)).toHaveLength(0);
  });

  it.each(['untrusted', 'disabled'] as const)('拒绝%s的peer机器人，不绕过现有访问授权', async reason => {
    const h = await configuredHarness();
    h.peerBotAuthorized.mockResolvedValue(reason !== 'untrusted');
    await h.coordinator.handle(botMessage('om_denied_peer'), { ...restrictedConfig, peerBotsAllowed: reason !== 'disabled' });
    await vi.waitFor(() => expect(h.service.reply).toHaveBeenCalledWith(expect.objectContaining({ taskName: '访问被拒绝' })));
    expect(h.runtime.start).not.toHaveBeenCalled();
    expect(h.decider.decide).not.toHaveBeenCalled();
  });

  it.each(['depth', 'budget'] as const)('定向交接仍受%s循环门禁限制，拦截时不发回执', async gate => {
    const h = await configuredHarness();
    const limit = gate === 'depth' ? BOT_LOOP_DEPTH_LIMIT : BOT_TURN_LIMIT_PER_HOUR;
    for (let index = 0; index < limit; index++) {
      await h.participation.guardBotTurn(botMessage(`om_fill_${index}`, { threadId: gate === 'depth' ? 'omt_same' : `omt_${index}` }), restrictedConfig, { botOpenId: 'ou_bot' });
    }
    await h.coordinator.handle(botMessage('om_blocked', { threadId: gate === 'depth' ? 'omt_same' : 'omt_new' }), restrictedConfig);
    expect(h.runtime.start).not.toHaveBeenCalled();
    expect(h.service.addReaction).not.toHaveBeenCalled();
    expect(h.service.send).not.toHaveBeenCalled(); expect(h.service.reply).not.toHaveBeenCalled();
    expect(h.service.sendText).not.toHaveBeenCalled(); expect(h.service.replyText).not.toHaveBeenCalled();
    expect(await gateRecords(h)).toHaveLength(1);
    expect(await turnRecords(h)).toHaveLength(limit);
  });
});

describe('Tag托管群与引用工作流的机器人边界', () => {
  it.each([true, false])('托管群授权allowed=%s决定能否接入机器人任务', async allowed => {
    const groupManager = {
      resolved: vi.fn(async (current: StoredLarkConfig) => ({ ...current, managedGroup: { bindingId: 'binding', revision: 1 } })),
      authorize: vi.fn(async () => ({ allowed, code: allowed ? 'allowed' : 'talk_required', reason: '测试群授权' })),
      recordRun: vi.fn(async () => {})
    };
    const h = harness(undefined, { groupManager: groupManager as any });
    await h.repository.updateSettings(scope, { expectedRevision: 0, participation: 'selective' }, 'owner');
    await h.coordinator.handle(botMessage('om_managed_peer'), config);
    expect(groupManager.authorize).toHaveBeenCalledWith(scope.appId, scope.chatId, 'ou_peer_bot', 'task.create', undefined, { memberObserved: true });
    if (allowed) {
      await vi.waitFor(() => expect(h.runtime.send).toHaveBeenCalledOnce());
      expect(groupManager.recordRun).toHaveBeenCalled();
      expect(h.service.addReaction).toHaveBeenCalledOnce();
    } else {
      expect(h.runtime.start).not.toHaveBeenCalled(); expect(h.runtime.send).not.toHaveBeenCalled();
      expect(h.service.addReaction).not.toHaveBeenCalled();
      expect(h.service.reply).not.toHaveBeenCalled(); expect(h.service.send).not.toHaveBeenCalled();
      expect(h.service.replyText).not.toHaveBeenCalled(); expect(h.service.sendText).not.toHaveBeenCalled();
    }
    expect(h.decider.decide).not.toHaveBeenCalled();
  });

  it.each([false, true])('无@引用审批仍拒绝机器人操作，depth门禁=%s时不发拒绝回执', async blocked => {
    const h = harness(undefined, { workflow: true });
    await h.repository.updateSettings(scope, { expectedRevision: 0, participation: 'selective' }, 'owner');
    await h.store.set(`lark.interaction.${scope.appId}.permission`, JSON.stringify({
      id: 'permission', appId: scope.appId, sessionId: 's1', taskId: 'task', turn: 1, boot: 'boot',
      kind: 'permission', nativeId: 'native_permission', question: '批准操作？', state: 'pending',
      cardId: 'om_permission', event: humanMessage('om_original'), updatedAt: h.clock.now.toISOString()
    }));
    const respond = vi.spyOn(LarkWorkflowInteractions.prototype, 'respond');
    cleanups.push(() => { respond.mockRestore(); });
    if (blocked) for (let index = 0; index < BOT_LOOP_DEPTH_LIMIT; index++) {
      await h.participation.guardBotTurn(botMessage(`om_fill_${index}`), config, { botOpenId: 'ou_bot' });
    }
    await h.coordinator.handle(botMessage('om_quote', { mentions: [], parentId: 'om_permission', content: '{"text":"/approve"}' }), config);
    expect(respond).not.toHaveBeenCalled(); expect(h.runtime.resolvePermission).not.toHaveBeenCalled();
    expect(h.runtime.start).not.toHaveBeenCalled(); expect(h.runtime.send).not.toHaveBeenCalled();
    expect(h.decider.decide).not.toHaveBeenCalled();
    if (blocked) {
      expect(h.service.addReaction).not.toHaveBeenCalled();
      expect(h.service.reply).not.toHaveBeenCalled(); expect(h.service.send).not.toHaveBeenCalled();
      expect(h.service.replyText).not.toHaveBeenCalled(); expect(h.service.sendText).not.toHaveBeenCalled();
      expect(await gateRecords(h)).toHaveLength(1);
    } else {
      expect(h.service.reply).toHaveBeenCalledWith(expect.objectContaining({ markdown: '任务操作需由人类成员发起。' }));
      expect(await turnRecords(h)).toHaveLength(1);
    }
  });
});

describe('多 bot 互相 @ 的硬门禁', () => {
  it('同一话题内连续机器人往返达到上限后停止响应', async () => {
    const h = harness();
    for (let index = 0; index < BOT_LOOP_DEPTH_LIMIT; index++) {
      expect(await h.participation.guardBotTurn(botMessage(`om_bot_${index}`, { threadId: 'omt_a' }), config, { botOpenId: 'ou_bot' })).toBeUndefined();
    }
    const blocked = await h.participation.guardBotTurn(botMessage('om_bot_over', { threadId: 'omt_a' }), config, { botOpenId: 'ou_bot' });
    expect(blocked).toContain(String(BOT_LOOP_DEPTH_LIMIT));
    // 挡下之后不再累加，后续每条依旧被挡，且不写新的回合记录。
    for (let index = 0; index < 20; index++) {
      expect(await h.participation.guardBotTurn(botMessage(`om_bot_over_${index}`, { threadId: 'omt_a' }), config, { botOpenId: 'ou_bot' })).toBe(blocked);
    }
    expect(await turnRecords(h)).toHaveLength(BOT_LOOP_DEPTH_LIMIT);
    // 门禁留痕按小时分桶：21 条被挡下的消息只留一条记录，
    // 否则几百条门禁记录会把 500 条统计窗口占满，用量从此再也读不准。
    expect(await gateRecords(h)).toHaveLength(1);
  });

  it('同一 tick 并发涌入的机器人消息不会一起读到同一份用量后集体放行', async () => {
    // coordinator.handle 由长连接 fire-and-forget 调起，刷屏事故的形态正是「一批同时到」。
    // 门禁是跨 await 的读-改-写，不按群串行就会在最该生效的场景失效。
    const h = harness();
    const burst = await Promise.all(Array.from({ length: BOT_LOOP_DEPTH_LIMIT + 5 }, (_, index) =>
      h.participation.guardBotTurn(botMessage(`om_burst_${index}`, { threadId: 'omt_a' }), config, { botOpenId: 'ou_bot' })));
    expect(burst.filter(reason => reason === undefined)).toHaveLength(BOT_LOOP_DEPTH_LIMIT);
    expect(await turnRecords(h)).toHaveLength(BOT_LOOP_DEPTH_LIMIT);
  });

  it('并发涌入时每小时预算同样不会被超发', async () => {
    const h = harness();
    const burst = await Promise.all(Array.from({ length: BOT_TURN_LIMIT_PER_HOUR + 5 }, (_, index) =>
      // 每条各一个话题，绕开深度上限，只让预算判定并发。
      h.participation.guardBotTurn(botMessage(`om_burst_${index}`, { threadId: `omt_${index}` }), config, { botOpenId: 'ou_bot' })));
    expect(burst.filter(reason => reason === undefined)).toHaveLength(BOT_TURN_LIMIT_PER_HOUR);
    const since = Date.parse('2026-09-18T10:00:00.000Z') - 3_600_000;
    expect(countBotTurnUsage(await decisions(h), since)).toBe(BOT_TURN_LIMIT_PER_HOUR);
  });

  it('人类触发的回合把连续深度清零，机器人可以重新接话', async () => {
    const h = harness();
    for (let index = 0; index < BOT_LOOP_DEPTH_LIMIT; index++) {
      await h.participation.guardBotTurn(botMessage(`om_bot_${index}`, { threadId: 'omt_a' }), config, { botOpenId: 'ou_bot' });
    }
    expect(await h.participation.guardBotTurn(botMessage('om_bot_over', { threadId: 'omt_a' }), config, { botOpenId: 'ou_bot' })).toBeTruthy();
    expect(await h.participation.guardBotTurn(humanMessage('om_human', { threadId: 'omt_a' }), config, { botOpenId: 'ou_bot' })).toBeUndefined();
    expect(await h.participation.guardBotTurn(botMessage('om_bot_after', { threadId: 'omt_a' }), config, { botOpenId: 'ou_bot' })).toBeUndefined();
  });

  it('换话题绕开深度上限后仍被每小时机器人预算挡住，且预算独立于人类判定用量', async () => {
    const h = harness();
    for (let index = 0; index < BOT_TURN_LIMIT_PER_HOUR; index++) {
      // 每条各用一个话题，连续深度永远是 1，只有预算能拦住。
      expect(await h.participation.guardBotTurn(botMessage(`om_bot_${index}`, { threadId: `omt_${index}` }), config, { botOpenId: 'ou_bot' })).toBeUndefined();
    }
    const blocked = await h.participation.guardBotTurn(botMessage('om_bot_over', { threadId: 'omt_over' }), config, { botOpenId: 'ou_bot' });
    expect(blocked).toContain(`${BOT_TURN_LIMIT_PER_HOUR}`);
    const since = Date.parse('2026-09-18T10:00:00.000Z') - 3_600_000;
    expect(countBotTurnUsage(await decisions(h), since)).toBe(BOT_TURN_LIMIT_PER_HOUR);
    // 机器人回合与门禁记录都不是模型判定，人类的每小时判定预算不能被它们吃掉。
    expect(countDecisionUsage(await decisions(h), since)).toBe(0);
  });

  it('被挡下的回合不计入机器人用量，门禁记录按小时分桶每群每类只留一条', async () => {
    const h = harness();
    for (let index = 0; index < BOT_TURN_LIMIT_PER_HOUR; index++) {
      await h.participation.guardBotTurn(botMessage(`om_bot_${index}`, { threadId: `omt_${index}` }), config, { botOpenId: 'ou_bot' });
    }
    for (let index = 0; index < 20; index++) {
      expect(await h.participation.guardBotTurn(botMessage(`om_blocked_${index}`, { threadId: `omt_b_${index}` }), config, { botOpenId: 'ou_bot' })).toBeTruthy();
    }
    expect(await gateRecords(h)).toHaveLength(1);
    const since = Date.parse('2026-09-18T10:00:00.000Z') - 3_600_000;
    // 关键：闸门记录不能自己涨用量，否则一旦超限就再也降不回来。
    expect(countBotTurnUsage(await decisions(h), since)).toBe(BOT_TURN_LIMIT_PER_HOUR);
    // 下一个小时窗口重新放行。
    h.clock.now = new Date('2026-09-18T11:30:00.000Z');
    expect(await h.participation.guardBotTurn(botMessage('om_next_hour', { threadId: 'omt_next' }), config, { botOpenId: 'ou_bot' })).toBeUndefined();
  });

  it('coordinator 在唤醒前咨询门禁：挡下的机器人消息不派活、不发任何群消息', async () => {
    const h = harness();
    await h.coordinator.handle(botMessage('om_bot_first'), config);
    await vi.waitFor(() => expect(h.runtime.send).toHaveBeenCalledOnce());
    const sent = h.service.send.mock.calls.length + h.service.reply.mock.calls.length
      + h.service.sendText.mock.calls.length + h.service.replyText.mock.calls.length;

    // 把本小时的机器人预算直接用满，下一条机器人消息必然被门禁挡下。
    for (let index = 0; index < BOT_TURN_LIMIT_PER_HOUR; index++) {
      await h.participation.guardBotTurn(botMessage(`om_fill_${index}`, { threadId: `omt_f_${index}` }), config, { botOpenId: 'ou_bot' });
    }
    await h.coordinator.handle(botMessage('om_bot_blocked'), config);
    expect(h.runtime.send).toHaveBeenCalledOnce();
    expect(h.service.send.mock.calls.length + h.service.reply.mock.calls.length
      + h.service.sendText.mock.calls.length + h.service.replyText.mock.calls.length).toBe(sent);
    expect(await gateRecords(h)).toHaveLength(1);
  });

  it('coordinator 不拦人类消息', async () => {
    const h = harness();
    for (let index = 0; index < BOT_TURN_LIMIT_PER_HOUR; index++) {
      await h.participation.guardBotTurn(botMessage(`om_fill_${index}`, { threadId: `omt_f_${index}` }), config, { botOpenId: 'ou_bot' });
    }
    await h.coordinator.handle(humanMessage('om_human'), config);
    await vi.waitFor(() => expect(h.runtime.send).toHaveBeenCalledOnce());
  });
});

describe('结果卡不 @ 回机器人发起人', () => {
  it('机器人发起时不产出 at 串，人类发起时照常', () => {
    expect(senderGroupMention(true, { chatType: 'group', senderOpenId: 'ou_peer_bot', senderType: 'app' })).toBeUndefined();
    expect(senderGroupMention(true, { chatType: 'group', senderOpenId: 'ou_peer_bot', senderType: 'bot' })).toBeUndefined();
    expect(senderGroupMention(true, { chatType: 'group', senderOpenId: 'ou_alice', senderType: 'user' })).toBe('<at id=ou_alice></at>');
    expect(senderGroupMention(false, { chatType: 'group', senderOpenId: 'ou_alice', senderType: 'user' })).toBeUndefined();
    expect(senderGroupMention(true, { chatType: 'p2p', senderOpenId: 'ou_alice', senderType: 'user' })).toBeUndefined();
  });
});

describe('话题深度计数的容量淘汰', () => {
  it('淘汰最久未用而不是最早插入：正在刷屏的话题不会被挤掉、深度归零', async () => {
    const h = harness();
    const depths: Map<string, number> = (h.participation as any).botTurnDepth;

    // 话题 A 先接一轮，拿到它的计数键。
    expect(await h.participation.guardBotTurn(botMessage('om_a_1', { threadId: 'omt_a' }), config, { botOpenId: 'ou_bot' })).toBeUndefined();
    const hotKey = [...depths.keys()].at(-1)!;
    expect(depths.get(hotKey)).toBe(1);

    // 再灌满到容量上限：这些键都比 A 晚插入。
    for (let index = 0; index < 4_999; index++) depths.set(`filler::${index}`, 1);
    expect(depths.size).toBe(5_000);

    // 话题 A 又来一轮：它此刻是最近使用的，但插入位置仍然最早。
    expect(await h.participation.guardBotTurn(botMessage('om_a_2', { threadId: 'omt_a' }), config, { botOpenId: 'ou_bot' })).toBeUndefined();
    expect(depths.get(hotKey)).toBe(2);

    // 新话题把容量顶破，触发一次惰性淘汰：被淘汰的必须是最久未用的 filler::0，
    // 而不是正在刷屏的 A——淘汰 A 会让它的连续深度归零，绕开回路上限。
    expect(await h.participation.guardBotTurn(botMessage('om_b_1', { threadId: 'omt_b' }), config, { botOpenId: 'ou_bot' })).toBeUndefined();
    expect(depths.size).toBe(5_000);
    expect(depths.has('filler::0')).toBe(false);
    expect(depths.get(hotKey)).toBe(2);

    // A 的下一轮因此是第 3 轮，正好用满深度上限；再来一条必须被挡下。
    expect(await h.participation.guardBotTurn(botMessage('om_a_3', { threadId: 'omt_a' }), config, { botOpenId: 'ou_bot' })).toBeUndefined();
    expect(await h.participation.guardBotTurn(botMessage('om_a_4', { threadId: 'omt_a' }), config, { botOpenId: 'ou_bot' }))
      .toContain(String(BOT_LOOP_DEPTH_LIMIT));
  });
});
