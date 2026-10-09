import { describe, expect, it } from 'vitest';
import { botNameTokens, callsBotName, evaluateParticipationRules, participationIntentOf, ruleContextOf, type RuleContext } from './participation-rules.js';

const at = Date.parse('2026-10-06T10:00:00.000Z');
const ctx = (patch: Partial<RuleContext> = {}): RuleContext => ({
  text: '今天下午发版', messageType: 'text', senderId: 'ou_a', senderKind: 'human', at, mentionsOther: false,
  botNames: ['bdev-flash'], ownedNames: [], hasActiveMandates: false, level: 'selective', ...patch
});
const rule = (patch: Partial<RuleContext>) => evaluateParticipationRules(ctx(patch));

describe('participation rules', () => {
  it('试点原句：机器人发完总结 28 秒后说「关掉这个总结任务」，算在叫它', () => {
    expect(rule({ text: '关掉这个总结任务', hasActiveMandates: true, ownedNames: ['每天 18 点总结群里的讨论'],
      recent: { lastSelfAt: at - 28_000, humanBetween: false, partners: [] }, members: { humans: 2, bots: 1 } }))
      .toMatchObject({ action: 'addressed', rule: 'owned_item' });
    // 没有生效委托、或机器人十分钟前才说过话，就不靠这条规则认定。
    expect(rule({ text: '关掉这个总结任务', recent: { lastSelfAt: at - 28_000, humanBetween: true, partners: [] } })).toBeUndefined();
    expect(rule({ text: '关掉这个总结任务', hasActiveMandates: true, recent: { lastSelfAt: at - 600_000, humanBetween: false, partners: [] } })).toBeUndefined();
  });

  it('试点原句：单人群里没 @ 的「总结下这个文档要做的事情 <链接>」算在叫它；多个机器人同群时不算', () => {
    const text = '总结下这个文档要做的事情 https://bytedance.larkoffice.com/docx/AbCdEf123';
    expect(rule({ text, members: { humans: 1, bots: 1 } })).toMatchObject({ action: 'addressed', rule: 'single_human' });
    expect(rule({ text, members: { humans: 1, bots: 0 } })).toMatchObject({ action: 'addressed', rule: 'single_human' });
    expect(rule({ text, members: { humans: 1, bots: 2 } })).toMatchObject({ action: 'silent', rule: 'no_responder' });
    expect(rule({ text, members: { humans: 1, bots: 2 }, level: 'eager' })).toMatchObject({ action: 'silent', rule: 'no_responder' });
    expect(rule({ text, members: { humans: 1, bots: 2 }, level: 'eager', responder: 'self' })).toMatchObject({ action: 'addressed', rule: 'eager_default' });
    expect(rule({ text, members: { humans: 3, bots: 1 } })).toBeUndefined();
    expect(rule({ text })).toBeUndefined();
  });

  it('叫名字：开头点名或「<名字>帮我…」；只是提到名字不算', () => {
    const tokens = botNameTokens(['bdev-flash', undefined]);
    expect(tokens).toEqual(['bdev-flash', 'flash', 'bdev']);
    expect(callsBotName('flash 帮我看下这个报错', tokens)).toBe(true);
    expect(callsBotName('Flash，查一下发布单', tokens)).toBe(true);
    expect(callsBotName('麻烦 flash 帮我总结一下', tokens)).toBe(true);
    expect(callsBotName('flashback 是什么', tokens)).toBe(false);
    expect(callsBotName('这个 flash 卡顿问题谁在跟', tokens)).toBe(false);
    expect(botNameTokens(['Tag 机器人'])).toEqual(['tag 机器人']);
    expect(rule({ text: 'flash 帮我看下', mentionsOther: true })).toMatchObject({ action: 'addressed', rule: 'calls_name' });
  });

  it('明显不是对它说的直接沉默：@ 别人、回复别人、只有表情、致谢、机器人发的', () => {
    expect(rule({ mentionsOther: true, members: { humans: 1, bots: 1 } })).toMatchObject({ action: 'silent', rule: 'mentions_other' });
    expect(rule({ parent: 'other', level: 'eager' })).toMatchObject({ action: 'silent', rule: 'reply_to_other' });
    expect(rule({ text: '[赞][赞]', level: 'eager' })).toMatchObject({ action: 'silent', rule: 'emoji_only' });
    expect(rule({ text: '', messageType: 'sticker', level: 'eager' })).toMatchObject({ action: 'silent', rule: 'emoji_only' });
    for (const text of ['谢谢', '好的，收到', 'OK', '辛苦了！', '嗯嗯']) expect(rule({ text, level: 'eager' })).toMatchObject({ action: 'silent', rule: 'short_thanks' });
    expect(rule({ text: '好的，那你帮我把发布单也建一下', members: { humans: 1, bots: 1 } })).toMatchObject({ rule: 'single_human' });
    expect(rule({ senderKind: 'bot', text: 'flash 帮我看下' })).toMatchObject({ action: 'silent', rule: 'bot_sender' });
  });

  it('回复它的消息、它开的话题、紧接着的续问都算在叫它', () => {
    expect(rule({ parent: 'self' })).toMatchObject({ action: 'addressed', rule: 'reply_to_self' });
    expect(rule({ threadRootSelf: true })).toMatchObject({ action: 'addressed', rule: 'reply_to_self' });
    expect(rule({ threadRootSelf: true, parent: 'other' })).toMatchObject({ action: 'silent', rule: 'reply_to_other' });
    const recent = { lastSelfAt: at - 120_000, humanBetween: false, partners: ['ou_a'] };
    expect(rule({ text: '那第二个呢', recent })).toMatchObject({ action: 'addressed', rule: 'follow_up' });
    expect(rule({ text: '那第二个呢', recent: { ...recent, humanBetween: true } })).toBeUndefined();
    expect(rule({ text: '那第二个呢', recent: { ...recent, partners: ['ou_b'] } })).toBeUndefined();
    expect(rule({ text: '那第二个呢', recent: { ...recent, lastSelfAt: at - 6 * 60_000 } })).toBeUndefined();
  });

  it('提到它负责的委托或事项算在叫它；积极档里其余真人消息都接', () => {
    expect(rule({ text: '容量评估那个事项进展到哪了', ownedNames: ['完成容量评估'] })).toBeUndefined();
    expect(rule({ text: '完成容量评估这件事什么时候好', ownedNames: ['完成容量评估'] })).toMatchObject({ action: 'addressed', rule: 'owned_item' });
    expect(rule({ level: 'eager' })).toMatchObject({ action: 'addressed', rule: 'eager_default' });
    expect(rule({ level: 'eager', mentionsOther: true })).toMatchObject({ action: 'silent', rule: 'mentions_other' });
  });
});

describe('多机器人群的接话人', () => {
  const crowded = { members: { humans: 3, bots: 2 } };
  it('没指定接话人时没 @ 的消息都不接；单机器人群和成员数未知时不受影响', () => {
    expect(rule({ ...crowded, level: 'eager' })).toMatchObject({ action: 'silent', rule: 'no_responder' });
    expect(rule({ members: { humans: 3, bots: 1 }, level: 'eager' })).toMatchObject({ action: 'addressed', rule: 'eager_default' });
    expect(rule({ level: 'eager' })).toMatchObject({ action: 'addressed', rule: 'eager_default' });
  });

  it('接话人是自己时照常接，是别人时只接叫自己的', () => {
    expect(rule({ ...crowded, level: 'eager', responder: 'self' })).toMatchObject({ action: 'addressed', rule: 'eager_default' });
    expect(rule({ ...crowded, level: 'eager', responder: 'other' })).toMatchObject({ action: 'silent', rule: 'not_responder' });
    expect(rule({ ...crowded, responder: 'other', text: 'flash 帮我看下' })).toMatchObject({ action: 'addressed', rule: 'calls_name' });
    expect(rule({ ...crowded, responder: 'other', parent: 'self' })).toMatchObject({ action: 'addressed', rule: 'reply_to_self' });
    expect(rule({ ...crowded, responder: 'other', ownedTopic: true })).toMatchObject({ action: 'addressed', rule: 'owned_topic' });
  });

  it('接话人也不抢别的机器人的话：叫别的机器人、别人的话题都不接', () => {
    expect(rule({ ...crowded, level: 'eager', responder: 'self', callsOther: true })).toMatchObject({ action: 'silent', rule: 'calls_other' });
    expect(rule({ ...crowded, level: 'eager', responder: 'self', threadRootOther: true })).toMatchObject({ action: 'silent', rule: 'topic_of_other' });
    expect(rule({ level: 'eager', threadRootOther: true })).toMatchObject({ action: 'addressed', rule: 'eager_default' });
    expect(rule({ ...crowded, level: 'eager', responder: 'self', threadRootOther: true, ownedTopic: true })).toMatchObject({ action: 'addressed', rule: 'owned_topic' });
  });
});

describe('participation intents', () => {
  it.each([
    ['积极点', 'eager'], ['以后积极一点', 'eager'], ['主动点吧', 'eager'],
    ['按需', 'selective'], ['改成按需参与', 'selective'],
    ['话题里不用@', 'topic'], ['别插话', 'topic'], ['安静点', 'topic'],
    ['只在@时回', 'mention'], ['@了再回', 'mention']
  ] as const)('「%s」→ %s', (text, level) => {
    expect(participationIntentOf(`@_user_1 ${text}`)).toEqual({ kind: 'level', level });
  });

  it('「为什么没回」是询问原因', () => {
    for (const text of ['刚才为什么没回', '@_user_1 为什么不回我', '你怎么没理我']) expect(participationIntentOf(text)).toEqual({ kind: 'why_silent' });
  });

  it('长句或只是碰巧含关键词的句子不算', () => {
    expect(participationIntentOf('按需求改一下这个接口')).toBeUndefined();
    expect(participationIntentOf('积极点评估一下这三个方案的风险和成本好吗')).toBeUndefined();
    expect(participationIntentOf('为什么没回滚这次发布')).toBeUndefined();
    expect(participationIntentOf('帮我看看为什么这个服务不回包，日志在群公告里')).toBeUndefined();
  });
});

describe('roleScope 负责范围绕过规则与兼容', () => {
  const crowded = { members: { humans: 3, bots: 2 } };
  const scope = '报警与线上排查';

  it('有 roleScope 时仅绕过 not_responder、no_responder、eager_default、single_human 四条规则', () => {
    // 1. no_responder：多机器人群未指定接话人，无 scope 沉默，有 scope 绕过交给模型（返回 undefined）
    expect(rule({ ...crowded, level: 'selective' })).toMatchObject({ action: 'silent', rule: 'no_responder' });
    expect(rule({ ...crowded, level: 'selective', roleScope: scope })).toBeUndefined();

    // 2. not_responder：多机器人群接话人为别人，无 scope 沉默，有 scope 绕过交给模型（返回 undefined）
    expect(rule({ ...crowded, responder: 'other' })).toMatchObject({ action: 'silent', rule: 'not_responder' });
    expect(rule({ ...crowded, responder: 'other', roleScope: scope })).toBeUndefined();

    // 3. eager_default：积极档，无 scope 直接接，有 scope 绕过交给模型（返回 undefined）
    expect(rule({ level: 'eager' })).toMatchObject({ action: 'addressed', rule: 'eager_default' });
    expect(rule({ level: 'eager', roleScope: scope })).toBeUndefined();

    // 4. single_human：单人群，无 scope 直接接，有 scope 绕过交给模型（返回 undefined）
    expect(rule({ members: { humans: 1, bots: 1 } })).toMatchObject({ action: 'addressed', rule: 'single_human' });
    expect(rule({ members: { humans: 1, bots: 1 }, roleScope: scope })).toBeUndefined();
  });

  it('有 roleScope 时仍严格保留其余明确规则', () => {
    // 叫名字：仍直接接
    expect(rule({ text: 'flash 帮我看下报警', roleScope: scope })).toMatchObject({ action: 'addressed', rule: 'calls_name' });
    // 别人的话题：仍直接沉默
    expect(rule({ ...crowded, threadRootOther: true, roleScope: scope })).toMatchObject({ action: 'silent', rule: 'topic_of_other' });
    // @ 别人：仍直接沉默
    expect(rule({ mentionsOther: true, roleScope: scope })).toMatchObject({ action: 'silent', rule: 'mentions_other' });
    // 机器人发送：仍直接沉默
    expect(rule({ senderKind: 'bot', text: '【报警】cpu 高', roleScope: scope })).toMatchObject({ action: 'silent', rule: 'bot_sender' });
    // 回复自己：仍直接接
    expect(rule({ parent: 'self', roleScope: scope })).toMatchObject({ action: 'addressed', rule: 'reply_to_self' });
    // 表情与简短致谢：仍直接沉默
    expect(rule({ text: '[OK]', roleScope: scope })).toMatchObject({ action: 'silent', rule: 'emoji_only' });
    expect(rule({ text: '好的谢谢', roleScope: scope })).toMatchObject({ action: 'silent', rule: 'short_thanks' });
  });

  it('无 roleScope 或空白 scope 时保持原有规则行为', () => {
    for (const emptyScope of [undefined, '', '   ']) {
      expect(rule({ ...crowded, level: 'selective', roleScope: emptyScope })).toMatchObject({ action: 'silent', rule: 'no_responder' });
      expect(rule({ ...crowded, responder: 'other', roleScope: emptyScope })).toMatchObject({ action: 'silent', rule: 'not_responder' });
      expect(rule({ level: 'eager', roleScope: emptyScope })).toMatchObject({ action: 'addressed', rule: 'eager_default' });
      expect(rule({ members: { humans: 1, bots: 1 }, roleScope: emptyScope })).toMatchObject({ action: 'addressed', rule: 'single_human' });
    }
  });

  it('ruleContextOf 支持传入第 5 个可选参数 roleScope', () => {
    const trigger = { id: 'obs_1', scope: { appId: 'cli_a', chatId: 'oc_1' }, sequence: 1, source: 'lark.message', eventId: 'om_1', occurredAt: '2026-10-09T00:00:00Z', receivedAt: '2026-10-09T00:00:00Z', senderId: 'ou_1', senderKind: 'human' as const, text: '告警排查', refs: [], origin: 'live' as const, missing: [], revision: 1 };
    const owned = { names: [], hasActiveMandates: false };
    const facts = { level: 'selective' as const };

    const ctxWithScope = ruleContextOf(trigger, owned, ['flash'], facts, '告警排查');
    expect(ctxWithScope.roleScope).toBe('告警排查');

    const ctxWithoutScope = ruleContextOf(trigger, owned, ['flash'], facts);
    expect(ctxWithoutScope.roleScope).toBeUndefined();
  });
});
