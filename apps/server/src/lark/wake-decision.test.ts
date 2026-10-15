import { describe, expect, it } from 'vitest';
import { decideWake, isExplicitWake, wakeSignals, type WakeFacts, type WakeMentionPolicy } from './wake-decision.js';

const base: WakeFacts = { chatType: 'group', botSender: false, mentionsBot: false, hasMentions: false, quotedWorkflow: false, adopted: false, recovering: false,
  recognizedCommand: false, mentionPolicy: 'always', ownedTopic: false, triage: false, pendingAskContinuation: false, requestContinuation: false };
type Participation = { enabled: boolean; handled?: boolean } | undefined;
const on: Participation = { enabled: true };
const off: Participation = { enabled: false };

describe('唤醒判定：各分支组合', () => {
  it.each<[string, Partial<WakeFacts>, Participation, ReturnType<typeof decideWake>]>([
    ['私聊', { chatType: 'p2p' }, undefined, { wake: true, reason: 'p2p', guardBotTurn: false }],
    ['群里 @ 我', { mentionsBot: true, hasMentions: true }, undefined, { wake: true, reason: 'mention', guardBotTurn: true }],
    ['群里 @ 我，群参与开着', { mentionsBot: true, hasMentions: true }, on, { wake: true, reason: 'mention', guardBotTurn: true }],
    ['机器人 @ 我，群参与开着：仍唤醒，过回合门禁', { botSender: true, mentionsBot: true, hasMentions: true }, on, { wake: true, reason: 'mention', guardBotTurn: true }],
    ['机器人引用工作流', { botSender: true, quotedWorkflow: true }, undefined, { wake: true, reason: 'quoted_workflow', guardBotTurn: true }],
    ['机器人不 @，免 @ 档', { botSender: true, mentionPolicy: 'never' }, undefined, { wake: false, reason: 'not_addressed' }],
    ['话题内免 @ 档，接手的话题', { mentionPolicy: 'topic', ownedTopic: true }, undefined, { wake: true, reason: 'continued_topic', guardBotTurn: true }],
    ['话题内免 @ 档，接手的话题，群参与开着：让给群参与', { mentionPolicy: 'topic', ownedTopic: true }, on, { wake: false, reason: 'participation_observes' }],
    ['话题内免 @ 档，没接手的话题', { mentionPolicy: 'topic' }, undefined, { wake: false, reason: 'not_addressed' }],
    ['免 @ 档', { mentionPolicy: 'never' }, undefined, { wake: true, reason: 'never_policy', guardBotTurn: true }],
    ['免 @ 档，群参与开着：让给群参与', { mentionPolicy: 'never' }, on, { wake: false, reason: 'participation_observes' }],
    ['ambient 档，没指名任何人', { mentionPolicy: 'ambient' }, undefined, { wake: true, reason: 'ambient_open', guardBotTurn: true }],
    ['ambient 档，@ 了别人', { mentionPolicy: 'ambient', hasMentions: true }, undefined, { wake: false, reason: 'not_addressed' }],
    ['每次 @ 档，没 @', {}, undefined, { wake: false, reason: 'not_addressed' }],
    ['每次 @ 档，没 @，群参与关着', {}, off, { wake: false, reason: 'not_addressed' }],
    ['每次 @ 档，没 @，群参与开着', {}, on, { wake: false, reason: 'participation_observes' }],
    ['群参与判 act 后受理', { adopted: true }, on, { wake: true, reason: 'adopted', guardBotTurn: true }],
    ['告警初筛受理：不过回合门禁', { adopted: true, triage: true }, undefined, { wake: true, reason: 'adopted', guardBotTurn: false }],
    ['回复仍在等待的提问', { pendingAskContinuation: true }, on, { wake: true, reason: 'pending_ask', guardBotTurn: true }],
    ['回复仍在等待的提问，没接群参与', { pendingAskContinuation: true }, undefined, { wake: true, reason: 'pending_ask', guardBotTurn: true }],
    ['续说自己的请求，群参与开着', { requestContinuation: true }, on, { wake: true, reason: 'request_continuation', guardBotTurn: true }],
    ['续说自己的请求，群参与关着', { requestContinuation: true }, off, { wake: false, reason: 'not_addressed' }],
    ['群参与已直接回应（改档、为什么没回）', { mentionsBot: true, hasMentions: true }, { enabled: true, handled: true }, { wake: false, reason: 'participation_handled' }],
    ['@ 我的已识别命令，群参与开着', { mentionsBot: true, hasMentions: true, recognizedCommand: true }, on, { wake: true, reason: 'mention', guardBotTurn: true }],
    ['没 @ 的已识别命令，每次 @ 档', { recognizedCommand: true }, on, { wake: false, reason: 'participation_observes' }],
    ['免 @ 档的已识别命令，群参与开着：命令照常唤醒', { recognizedCommand: true, mentionPolicy: 'never' }, on, { wake: true, reason: 'never_policy', guardBotTurn: true }],
    ['未知会话类型', { chatType: 'unknown' }, undefined, { wake: false, reason: 'not_addressed' }]
  ])('%s', (_name, patch, participation, expected) => {
    expect(decideWake({ ...base, ...patch }, participation)).toEqual(expected);
  });

  it.each<[string, Partial<WakeFacts>, ReturnType<typeof wakeSignals>['participation']]>([
    ['@ 我', { mentionsBot: true, hasMentions: true }, { explicit: true, addressed: true, ownedTopic: false }],
    ['接手话题里免 @ 续聊', { ownedTopic: true }, { explicit: false, addressed: true, ownedTopic: true }],
    ['接手话题里的机器人消息', { ownedTopic: true, botSender: true }, { explicit: false, addressed: false, ownedTopic: false }],
    ['重启恢复的 @ 消息', { mentionsBot: true, hasMentions: true, recovering: true }, { explicit: true, addressed: false, ownedTopic: false }],
    ['@ 我的已识别命令', { mentionsBot: true, hasMentions: true, recognizedCommand: true }, { explicit: true, addressed: false, ownedTopic: false }],
    ['免 @ 档的已识别命令', { recognizedCommand: true, mentionPolicy: 'never' }, { explicit: true, addressed: false, ownedTopic: false }],
    ['回复仍在等待的提问', { pendingAskContinuation: true }, { explicit: true, addressed: false, ownedTopic: false }],
    ['续说自己的请求', { requestContinuation: true }, { explicit: true, addressed: true, ownedTopic: false }],
    ['普通群消息', {}, { explicit: false, addressed: false, ownedTopic: false }]
  ])('交给群参与的输入：%s', (_name, patch, expected) => {
    expect(wakeSignals({ ...base, ...patch }).participation).toEqual(expected);
  });
});

/** 抽取前 coordinator-inbound.handle() 里的原式，逐字照抄，作为等价性的对照。 */
function inlineBaseline(f: WakeFacts, participation: Participation) {
  const explicit = !f.botSender && (f.chatType === 'p2p' || f.mentionsBot || f.quotedWorkflow || f.adopted);
  const continuedTopic = f.mentionPolicy === 'topic' && f.ownedTopic;
  const ambientOpen = f.mentionPolicy === 'ambient' && !f.hasMentions;
  const legacyWake = f.quotedWorkflow || f.chatType === 'p2p' || (f.chatType === 'group' && (f.mentionsBot || !f.botSender && (continuedTopic || f.mentionPolicy === 'never' || ambientOpen)));
  const commandInteraction = !f.botSender && f.recognizedCommand && legacyWake;
  const addressed = explicit || f.requestContinuation;
  const topicContinuation = f.ownedTopic && !f.botSender;
  const input = { explicit: addressed || f.pendingAskContinuation || commandInteraction, addressed: (addressed || topicContinuation) && !f.recognizedCommand && !f.recovering, ownedTopic: topicContinuation };
  if (participation?.handled) return { explicit, addressed, input, wake: false };
  if (participation?.enabled && !addressed && !f.pendingAskContinuation && !commandInteraction && !(f.botSender && legacyWake)) return { explicit, addressed, input, wake: false };
  const shouldWake = legacyWake || f.adopted || f.pendingAskContinuation || Boolean(participation?.enabled && f.requestContinuation);
  return { explicit, addressed, input, wake: shouldWake, ...(shouldWake ? { guard: f.chatType === 'group' && !f.triage } : {}) };
}

describe('唤醒判定与抽取前的原式逐条一致', () => {
  it('所有布尔事实、唤醒方式、会话类型和群参与结果的组合', () => {
    const flags = ['botSender', 'mentionsBot', 'hasMentions', 'quotedWorkflow', 'adopted', 'recovering', 'recognizedCommand', 'ownedTopic', 'triage', 'pendingAskContinuation', 'requestContinuation'] as const;
    const policies: WakeMentionPolicy[] = ['always', 'topic', 'never', 'ambient'];
    const participations: Participation[] = [undefined, { enabled: false }, { enabled: true }, { enabled: true, handled: true }, { enabled: false, handled: true }];
    let checked = 0;
    const mismatches: unknown[] = [];
    for (let mask = 0; mask < 1 << flags.length; mask++) {
      const bits = Object.fromEntries(flags.map((flag, index) => [flag, Boolean(mask & (1 << index))])) as Pick<WakeFacts, (typeof flags)[number]>;
      for (const chatType of ['group', 'p2p', 'unknown']) for (const mentionPolicy of policies) for (const participation of participations) {
        const facts: WakeFacts = { ...bits, chatType, mentionPolicy };
        const expected = inlineBaseline(facts, participation);
        const signals = wakeSignals(facts);
        const decision = decideWake(facts, participation);
        const actual = { explicit: isExplicitWake(facts), addressed: signals.addressed, input: signals.participation, wake: decision.wake, ...(decision.wake ? { guard: decision.guardBotTurn } : {}) };
        if (JSON.stringify(actual) !== JSON.stringify(expected)) mismatches.push({ facts, participation, expected, actual });
        checked++;
      }
    }
    expect(mismatches.slice(0, 3)).toEqual([]);
    expect(checked).toBe(2048 * 3 * 4 * 5);
  });
});
