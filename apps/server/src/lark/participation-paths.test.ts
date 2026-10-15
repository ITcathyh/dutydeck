// 判定路径的回归门禁：用 stub 判定器（不调真模型）锁住当前行为。
// 1. 模型判定期间群里来了新消息（同话题、跨话题、机器人消息），判定结果作废：current() 要求整个群的 contextRevision 不变。
// 2. 规则层的机器人计数排除本群订阅的告警来源。
// 3. 没接话时「为什么没回」和 /status 说明原因和怎么配。
import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createCollaborationSchema } from '../../../../packages/storage/src/collaboration-migration.js';
import { createCollaborationRepository } from '../../../../packages/storage/src/collaboration.js';
import { addCollaborationScenarios, allowEagerParticipation } from '../../../../packages/storage/src/migrations.js';
import { deciderMetaOf, type CollaborationDecision, type CollaborationSnapshot } from '@dutydeck/shared';
import { LarkGroupParticipation, type GroupParticipationOptions } from './group-participation.js';
import type { LarkMessageEvent } from './listener.js';
import type { StoredLarkConfig } from './config.js';
import type { ParticipationResult } from './readonly-decider.js';
import { builtinScenarioRegistry } from '../plugins/builtin-scenarios.test-helpers.js';

const scope = { appId: 'cli_test', chatId: 'oc_test' };
const config: StoredLarkConfig = { appId: scope.appId, appSecret: 'test', listening: true, defaultAgentId: 'mock', workspace: '/tmp', fullTrustConfirmed: true,
  permissionMode: 'ask', preInjectPrompt: '', memoryEnabled: false, groupToolsEnabled: false, groupToolsAllowSend: false, pushIntervalMs: 1000, hideTraceOnComplete: false,
  allowedUsers: [], allowedEmails: [], highRiskAllowedUsers: [], highRiskAllowedEmails: [], highRiskPattern: 'danger', riskControlMode: 'off' };
const message = (id: string, text: string, patch: Partial<LarkMessageEvent> = {}): LarkMessageEvent => ({ messageId: id, chatId: scope.chatId, chatType: 'group', messageType: 'text',
  content: JSON.stringify({ text }), createTime: '1789707600000', senderOpenId: 'ou_a', senderType: 'user', mentions: [], ...patch });
const atBot = (id: string, text: string) => message(id, `@_user_1 ${text}`, { mentions: [{ key: '@_user_1', name: 'Bot', openId: 'ou_bot' }] });
const silent: ParticipationResult = { action: 'silent', reason: '不是在叫我', evidenceIds: [], updates: [] };

type Bot = { name: string; appId: string };
const self: Bot = { name: 'Bot', appId: scope.appId };
const flash: Bot = { name: 'bdev-flash', appId: 'cli_flash' };
const alarmBot: Bot = { name: '监控', appId: 'cli_alarm' };
const members = (humans: number, bots: Bot[]) => vi.fn(async () => ({ items: [
  ...Array.from({ length: humans }, (_, i) => ({ memberId: `ou_${i}`, memberType: 'user' as const, name: `用户${i}` })),
  ...bots.map(bot => ({ memberId: bot.appId, memberType: 'bot' as const, name: bot.name, appId: bot.appId }))], hasMore: false, securityLimited: false }));

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean(); });

async function harness(extra: Partial<GroupParticipationOptions> = {}) {
  const db = new Database(':memory:'); createCollaborationSchema(db); allowEagerParticipation(db); addCollaborationScenarios(db);
  const repository = createCollaborationRepository(db);
  await repository.updateSettings(scope, { expectedRevision: 0, participation: 'selective' }, 'owner');
  const service = { listChatMessages: vi.fn(async () => ({ items: [] as any[], hasMore: false })), replyText: vi.fn(async () => ({ messageId: 'om_sent' })),
    sendText: vi.fn(async () => ({ messageId: 'om_sent' })), listOwnReactions: vi.fn(async () => []), addReaction: vi.fn(async () => ({ reactionId: 'reaction' })),
    deleteReaction: vi.fn(async () => {}), reply: vi.fn(async () => ({ messageId: 'om_card' })), update: vi.fn(async () => ({ messageId: 'om_card' })) } as Record<string, any>;
  const decide = vi.fn(async (_config: StoredLarkConfig, _snapshot: CollaborationSnapshot, _triggerId?: string, _facts?: Record<string, unknown>): Promise<ParticipationResult> => silent);
  const respond = vi.fn(async () => '回复');
  const dispatch = vi.fn(async () => {});
  const participation = new LarkGroupParticipation({ repository, decider: { decide, respond }, authorize: async () => true, readConfig: async () => config,
    serviceFor: () => service as any, listScopes: async () => [scope], canOperate: async () => true, debounceMs: 10_000, ...extra });
  participation.setDispatcher(scope.appId, dispatch);
  cleanups.push(async () => { await participation.close(); db.close(); });
  /** 没 @ 本机器人的消息进群参与；explicit 表示 @ 了本机器人。 */
  const handle = (event: LarkMessageEvent, explicit = false) => participation.handle(event, config, { explicit, addressed: explicit, botOpenId: 'ou_bot' });
  const decisionOf = async (messageId: string) => (await repository.listDecisions(scope)).find(item => deciderMetaOf(item)?.trigger?.messageId === messageId);
  return { repository, service, decide, respond, dispatch, participation, handle, decisionOf };
}
const ruleOf = (decision?: CollaborationDecision) => deciderMetaOf(decision ?? { inputSnapshot: {} })?.rule;

describe('模型判定期间群里来了新消息，判定作废', () => {
  it.each([
    ['同一话题的真人消息', 'reply', message('om_2', '我也遇到了', { threadId: 'omt_1', rootId: 'om_root' })],
    ['另一个话题的真人消息', 'reply', message('om_2', '周五下午有空吗', { threadId: 'omt_2', rootId: 'om_root_2' })],
    ['顶层的真人消息', 'act', message('om_2', '周五下午有空吗')],
    ['别的机器人的消息', 'reply', message('om_2', '发布单 #123 已完成', { senderType: 'app', senderOpenId: 'ou_other_bot' })]
  ] as const)('%s：已判为 %s 的结果记为 suppressed，不回复、不转执行', async (_name, action, next) => {
    const h = await harness();
    let release!: () => void;
    const model = new Promise<void>(resolve => { release = resolve; });
    h.decide.mockImplementationOnce(async (_config, _snapshot, triggerId) => { await model; return { action, reason: '在问我', evidenceIds: [triggerId!], updates: [] }; });
    await h.handle(message('om_1', '这个报错怎么处理', { threadId: 'omt_1', rootId: 'om_root' }));
    const flushing = h.participation.flush(scope);
    await vi.waitFor(() => expect(h.decide).toHaveBeenCalledOnce());
    await h.handle(next);
    release(); await flushing;
    expect(await h.decisionOf('om_1')).toMatchObject({ action, status: 'suppressed' });
    expect(h.respond).not.toHaveBeenCalled();
    expect(h.service.replyText).not.toHaveBeenCalled();
    expect(h.service.addReaction).not.toHaveBeenCalled();
    expect(h.dispatch).not.toHaveBeenCalled();
    // 新的真人消息接着判定；机器人消息只作材料，不判定。
    const human = next.senderType === 'user';
    expect(h.decide).toHaveBeenCalledTimes(human ? 2 : 1);
    if (human) expect(h.decide.mock.calls[1]![1].observations.find(item => item.id === h.decide.mock.calls[1]![2])).toMatchObject({ messageId: 'om_2' });
  });

  it('判定期间没有新消息时照常回复', async () => {
    const h = await harness();
    h.decide.mockImplementationOnce(async (_config, _snapshot, triggerId) => ({ action: 'reply', reason: '在问我', evidenceIds: [triggerId!], updates: [] }));
    await h.handle(message('om_1', '这个报错怎么处理'));
    await h.participation.flush(scope);
    expect(await h.decisionOf('om_1')).toMatchObject({ action: 'reply', status: 'sent' });
    expect(h.service.replyText).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'om_1', text: '回复' }));
  });
});

describe('叫群里另一个机器人的名字', () => {
  it('多机器人群里真人不 @、开头叫别的机器人：按群成员名单认出 callsOther，规则判 calls_other，不调模型', async () => {
    const h = await harness();
    Object.assign(h.service, { listChatMembers: members(3, [flash, self]) });
    await h.handle(message('om_1', 'flash 帮我看下'));
    await h.participation.flush(scope);
    const decision = await h.decisionOf('om_1');
    expect(decision).toMatchObject({ action: 'silent' });
    expect(ruleOf(decision)).toBe('calls_other');
    expect(deciderMetaOf(decision!)?.facts).toMatchObject({ callsOther: true, bots: 2 });
    expect(h.decide).not.toHaveBeenCalled();
  });
});

describe('机器人计数排除本群订阅的告警来源', () => {
  const subscribe = (h: Awaited<ReturnType<typeof harness>>, enabled: boolean) => h.repository.updateDuty(scope, { expectedRevision: 0,
    scenarios: { alarm: { enabled, params: { sources: [{ appId: alarmBot.appId, name: alarmBot.name }], levels: ['P0'], dedupeHours: 6, maxPerHour: 3 }, requesterId: 'ou_admin', packVersion: '1.0.0' } } }, 'ou_admin');
  it.each([
    ['没订阅：告警机器人算第二个机器人，不接', [alarmBot, self], undefined, 2],
    ['订阅了：告警机器人不算，交给模型', [alarmBot, self], true, 1],
    ['订阅后关掉初筛：来源仍不算（当前行为），交给模型', [alarmBot, self], false, 1],
    ['订阅了，但还有一个别的机器人：不接', [alarmBot, flash, self], true, 2]
  ] as const)('%s', async (_name, bots, enabled, talking) => {
    const h = await harness({ scenarios: await builtinScenarioRegistry() });
    Object.assign(h.service, { listChatMembers: members(3, [...bots]) });
    if (enabled !== undefined) await subscribe(h, enabled);
    await h.handle(message('om_1', '今天的发布单在哪看'));
    await h.participation.flush(scope);
    const decision = await h.decisionOf('om_1');
    expect(deciderMetaOf(decision!)?.facts).toMatchObject({ humans: 3, bots: talking });
    const status = await h.participation.describe(scope);
    if (talking > 1) {
      expect(h.decide).not.toHaveBeenCalled();
      expect(ruleOf(decision)).toBe('no_responder');
      expect(status).toContain(`**接话人**：未指定。本群有 ${talking} 个机器人，没 @ 的消息我先不接`);
    } else {
      expect(h.decide).toHaveBeenCalledExactlyOnceWith(config, expect.anything(), expect.any(String), { humans: 3, bots: 1 });
      expect(deciderMetaOf(decision!)?.kind).toBe('model');
      expect(status).not.toContain('**接话人**');
    }
  });
});

describe('本机器人是接话人', () => {
  it('多机器人群里规则拿不准时交给模型，接话人事实随群成员数一起进判定；/status 说没 @ 的消息由我接', async () => {
    const h = await harness();
    Object.assign(h.service, { listChatMembers: members(3, [flash, self]) });
    await h.repository.updateDuty(scope, { expectedRevision: 0, responder: { appId: scope.appId, name: 'Bot', since: '2026-10-15T00:00:00.000Z' } }, 'owner');
    await h.handle(message('om_1', '有人知道今天的发布单在哪看吗'));
    await h.participation.flush(scope);
    expect(h.decide).toHaveBeenCalledExactlyOnceWith(config, expect.anything(), expect.any(String), { humans: 3, bots: 2, responder: 'self' });
    expect(await h.participation.describe(scope)).toContain('**接话人**：我，本群没 @ 机器人的消息由我接');
  });
});

describe('没接话时说明原因和怎么配', () => {
  const scopeHint = '也可以在 Dutydeck Web「机器人管理」的「负责范围」里写清我负责的事，范围内没 @ 的消息我会判断后接。';
  const why = async (h: Awaited<ReturnType<typeof harness>>) => {
    await h.handle(atBot('om_why', '刚才为什么没回'), true);
    return String((h.service.replyText.mock.calls.at(-1) as unknown as [{ text: string }])[0].text);
  };

  it('多机器人群没指定接话人：说明可以指定接话人，也可以配负责范围', async () => {
    const h = await harness();
    Object.assign(h.service, { listChatMembers: members(3, [flash, self]) });
    await h.handle(message('om_1', '今天的发布单在哪看')); await h.participation.flush(scope);
    expect(ruleOf(await h.decisionOf('om_1'))).toBe('no_responder');
    expect(await why(h)).toContain('那条「今天的发布单在哪看」我没接：本群有多个机器人、还没指定接话人，没 @ 的消息我先不接。'
      + `要我接，@我 说「你负责接话」，或在 Dutydeck Web 的群设置里指定接话人；${scopeHint}`);
  });

  it('接话人是别的机器人：说明怎么改由我接', async () => {
    const h = await harness();
    Object.assign(h.service, { listChatMembers: members(3, [flash, self]) });
    await h.repository.updateDuty(scope, { expectedRevision: 0, responder: { appId: flash.appId, name: flash.name, since: '2026-10-15T00:00:00.000Z' } }, 'owner');
    await h.handle(message('om_1', '今天的发布单在哪看')); await h.participation.flush(scope);
    expect(ruleOf(await h.decisionOf('om_1'))).toBe('not_responder');
    expect(await why(h)).toContain(`我没接：本群指定了别的机器人接没 @ 的消息，我只接 @ 和自己接手的话题。要改由我接，@我 说「你负责接话」；${scopeHint}`);
  });

  it('别的机器人开的话题：说明在话题里 @ 我', async () => {
    const h = await harness();
    Object.assign(h.service, { listChatMembers: members(3, [flash, self]), getMessage: vi.fn(async (id: string) => ({ messageId: id, chatId: scope.chatId, messageType: 'text',
      createTime: '1789707600000', rawContent: '{}', sender: { id: flash.appId, idType: 'app_id', type: 'app' }, mentions: [], deleted: false, updated: false })) });
    await h.handle(message('om_1', '这个要紧吗', { threadId: 'omt_flash', rootId: 'om_flash_root' })); await h.participation.flush(scope);
    expect(ruleOf(await h.decisionOf('om_1'))).toBe('topic_of_other');
    expect(await why(h)).toContain('我没接：那个话题是发给别人或别的机器人的。要我接这个话题，在话题里 @我；我接手后，话题里的追问不用再 @。');
  });

  it('/status：按需档没配负责范围时说明配置入口；积极档不提示；配了时显示负责范围', async () => {
    const h = await harness();
    expect(await h.participation.describe(scope)).toContain('**负责范围**：未配置。配置后，没 @ 我的消息里属于范围内的事我会判断后接；在 Dutydeck Web「机器人管理」的「负责范围」里填写');
    await h.repository.updateSettings(scope, { expectedRevision: 1, participation: 'eager' }, 'owner');
    expect(await h.participation.describe(scope)).not.toContain('**负责范围**');
    const scoped = await harness({ readConfig: async () => ({ ...config, roleScope: '报警和告警排查' }) });
    const status = await scoped.participation.describe(scope);
    expect(status).toContain('**角色**：负责：报警和告警排查');
    expect(status).not.toContain('**负责范围**');
  });
});
