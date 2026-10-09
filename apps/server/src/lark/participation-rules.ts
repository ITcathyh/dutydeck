// 群参与的规则层：不调模型，先把明确的情况判掉。
//
// 「在叫我」的消息按一次显式 @ 交给执行路径；明显不是对本机器人说的直接沉默；其余拿不准的才交给模型。
// 本模块是纯函数：外部事实（父消息是谁发的、最近谁说过话、群里几个人）由调用方查好放进上下文，
// 查不到就留空，对应的规则不触发。规则只决定接不接话，不改变任何授权：交出去的消息仍按发送者本人重新鉴权。

import type { CollaborationFollowup, CollaborationMandate, CollaborationObservation, ParticipationLevel } from '@dutydeck/shared';

export type ParticipationRule =
  | 'calls_name' | 'reply_to_self' | 'owned_topic' | 'owned_item' | 'follow_up' | 'single_human' | 'eager_default'
  | 'mentions_other' | 'reply_to_other' | 'emoji_only' | 'short_thanks' | 'bot_sender'
  | 'calls_other' | 'topic_of_other' | 'not_responder' | 'no_responder';

export interface RuleVerdict { action: 'addressed' | 'silent'; rule: ParticipationRule; reason: string }

/** 规则名对应的人话；判定记录的 reason 和「刚才为什么没回」都用它。 */
export const participationRuleReasons: Record<ParticipationRule, string> = {
  calls_name: '消息直接叫了我的名字',
  reply_to_self: '消息回复的是我发的消息',
  owned_topic: '消息在我接手的话题里',
  owned_item: '消息提到了我负责的委托或事项',
  follow_up: '我刚在这里说过话，你紧接着又说了，没有别人插进来',
  single_human: '群里只有你一个人，消息也没有 @ 别人',
  eager_default: '本群是积极档，没 @ 别人的消息都接',
  mentions_other: '那条消息 @ 了别人',
  reply_to_other: '那条消息是在回复别人',
  emoji_only: '那条消息只有表情',
  short_thanks: '那条消息只是致谢或确认',
  bot_sender: '那条消息是机器人发的',
  calls_other: '那条消息叫的是群里另一个机器人',
  topic_of_other: '那个话题是发给别人或别的机器人的',
  not_responder: '本群指定了别的机器人接没 @ 的消息，我只接 @ 和自己接手的话题',
  no_responder: '本群有多个机器人、还没指定接话人，没 @ 的消息我先不接'
};

export interface RuleRecentActivity {
  /** 本机器人在本群（话题内的消息看本话题）最近一次发言的时间。 */
  lastSelfAt?: number;
  /** 那次发言之后、当前消息之前，有没有其他真人说话。 */
  humanBetween: boolean;
  /** 本机器人最近在跟谁交互：它回复的人、叫过它的人、委托的发起人。 */
  partners: string[];
}

export interface RuleContext {
  text: string;
  messageType: string;
  senderId: string;
  senderKind: 'human' | 'bot' | 'system';
  at: number;
  /** 消息 @ 了本机器人以外的人或机器人（包括 @所有人）。 */
  mentionsOther: boolean;
  botNames: string[];
  /** 角色负责范围（设置后只绕过4条默认接话规则，交给模型按范围判定）。 */
  roleScope?: string;
  /** 消息引用回复的那条消息是谁发的；没引用或查不到时不填。 */
  parent?: 'self' | 'sender' | 'other';
  /** 消息所在话题的根消息是本机器人发的（例如委托产出）。 */
  threadRootSelf?: boolean;
  /** 消息所在话题是本机器人接手的（话题里有本机器人的会话，例如告警初筛）。 */
  ownedTopic?: boolean;
  /** 消息所在话题的根消息是别的机器人发的，或 @ 的是别人。只在多机器人群里查。 */
  threadRootOther?: boolean;
  /** 消息开头叫的是群里另一个机器人的名字。只在多机器人群里查。 */
  callsOther?: boolean;
  /** 本群的接话人是谁；没指定时不填。 */
  responder?: 'self' | 'other';
  /** 本机器人负责的委托、事项名称。 */
  ownedNames: string[];
  hasActiveMandates: boolean;
  level: ParticipationLevel;
  /** 以下两项要查飞书接口，没查或查不到时不填。 */
  recent?: RuleRecentActivity;
  members?: { humans: number; bots: number };
}

const FOLLOW_UP_WINDOW_MS = 5 * 60_000;
const genericNameTokens = new Set(['bot', 'robot', 'tag', 'ai', 'agent', '机器人', '助手', '测试', '验证']);
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 去掉飞书文本里的 @ 占位符。 */
export const stripMentionPlaceholders = (text: string) => text.replace(/@_user_\d+|@_all/g, ' ').replace(/\s+/g, ' ').trim();
/** 只留文字和数字，用于短语比对。 */
export const compactText = (text: string) => text.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');

/** 机器人的称呼：完整名称，加上按分隔符拆出来的、不是泛称的片段（「bdev-flash」也叫得出「flash」）。 */
export function botNameTokens(names: Array<string | undefined>): string[] {
  const tokens = new Set<string>();
  for (const name of names) {
    const full = name?.trim().toLowerCase();
    if (!full) continue;
    if (full.length >= 2) tokens.add(full);
    for (const part of full.split(/[\s·•\-_|/\\,，:：()（）[\]【】]+/)) {
      if (part.length >= 2 && !/^\d+$/.test(part) && !genericNameTokens.has(part)) tokens.add(part);
    }
  }
  return [...tokens].sort((a, b) => b.length - a.length);
}

/** 消息开头直接叫名字，或「<名字>帮我/你…」。 */
export function callsBotName(text: string, tokens: string[]): boolean {
  const lower = text.trim().toLowerCase();
  return tokens.some(token => {
    if (lower.startsWith(token)) {
      const rest = lower.slice(token.length);
      if (!rest || /^[\s,，:：、!！~～]/.test(rest) || /^(帮|你|能|可以|请|看|查|给|麻烦|在吗|在不在)/.test(rest)) return true;
    }
    return new RegExp(`${escapeRegExp(token)}\\s*(帮我|帮忙|你帮|你看|你查|你能|你来|麻烦)`).test(lower);
  });
}

export function onlyEmoji(text: string, messageType: string): boolean {
  if (messageType === 'sticker') return true;
  if (!text.trim()) return false;
  return !text.replace(/\[[^[\]\s]{1,8}\]/g, '').replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}‍️\s\p{P}\p{S}]/gu, '');
}

const thanksPattern = /^(谢谢|谢啦|谢了|多谢|感谢|感恩|thanks|thankyou|thx|好的|好滴|好嘞|好哒|嗯嗯|嗯|哦|噢|收到|ok|okay|了解|明白了|明白|知道了|辛苦了|辛苦|赞|棒|nice|你|您|啦|了|哈)+$/;
export function shortThanks(text: string): boolean {
  const compact = compactText(text.replace(/\[[^[\]\s]{1,8}\]/g, ''));
  return compact.length > 0 && compact.length <= 10 && thanksPattern.test(compact);
}

/** 委托、事项的名称或其开头一句出现在消息里。 */
export function mentionsOwnedName(text: string, names: string[]): boolean {
  const compact = compactText(text);
  return names.some(name => [name, name.split(/[，。,.;；:：\n]/)[0] ?? ''].map(compactText).some(candidate => candidate.length >= 4 && candidate.length <= 40 && compact.includes(candidate)));
}

const deicticTask = /(这个|那个|该|刚才的?|上面的?|你的)[^，。,.！!？?\s]{0,6}?(任务|委托|总结|提醒|日报|周报|定时)/;

/** 规则层判定；拿不准返回 undefined。 */
export function evaluateParticipationRules(ctx: RuleContext): RuleVerdict | undefined {
  const verdict = (action: RuleVerdict['action'], rule: ParticipationRule): RuleVerdict => ({ action, rule, reason: participationRuleReasons[rule] });
  if (ctx.senderKind !== 'human') return verdict('silent', 'bot_sender');
  const text = stripMentionPlaceholders(ctx.text);
  if (callsBotName(text, botNameTokens(ctx.botNames))) return verdict('addressed', 'calls_name');
  if (ctx.callsOther) return verdict('silent', 'calls_other');
  if (ctx.mentionsOther) return verdict('silent', 'mentions_other');
  if (onlyEmoji(text, ctx.messageType)) return verdict('silent', 'emoji_only');
  if (shortThanks(text)) return verdict('silent', 'short_thanks');
  if (ctx.parent === 'self' || !ctx.parent && ctx.threadRootSelf) return verdict('addressed', 'reply_to_self');
  if (!ctx.parent && ctx.ownedTopic) return verdict('addressed', 'owned_topic');
  if (ctx.parent === 'other') return verdict('silent', 'reply_to_other');
  // 多机器人群：每条没 @ 的消息最多一个机器人接。别人的话题不接；不是接话人的只接上面这些明确叫自己的。
  const crowded = (ctx.members?.bots ?? 0) > 1;
  if (crowded && !ctx.parent && ctx.threadRootOther) return verdict('silent', 'topic_of_other');
  const hasScope = Boolean(ctx.roleScope?.trim());
  if (!hasScope && ctx.responder === 'other') return verdict('silent', 'not_responder');
  if (!hasScope && crowded && ctx.responder !== 'self') return verdict('silent', 'no_responder');
  if (mentionsOwnedName(text, ctx.ownedNames)) return verdict('addressed', 'owned_item');
  if (!hasScope && ctx.level === 'eager') return verdict('addressed', 'eager_default');
  const recent = ctx.recent;
  const justSpoke = recent?.lastSelfAt !== undefined && ctx.at - recent.lastSelfAt >= 0 && ctx.at - recent.lastSelfAt <= FOLLOW_UP_WINDOW_MS;
  if (justSpoke && ctx.hasActiveMandates && deicticTask.test(text)) return verdict('addressed', 'owned_item');
  if (justSpoke && !recent!.humanBetween && recent!.partners.includes(ctx.senderId)) return verdict('addressed', 'follow_up');
  if (!hasScope && ctx.members && ctx.members.humans === 1 && ctx.members.bots <= 1) return verdict('addressed', 'single_human');
  return undefined;
}

/**
 * 规则查到的外部事实，存进判定记录（inputSnapshot.decider.facts），回放时据此重建规则上下文。
 * 没查或查不到的项不填，对应规则不触发。
 */
export type RuleFacts = {
  level: ParticipationLevel;
  messageType?: string;
  parent?: 'self' | 'sender' | 'other';
  threadRootSelf?: boolean;
  /** 本机器人上次发言距当前消息的毫秒数。 */
  lastSelfAgoMs?: number;
  humanBetween?: boolean;
  /** 发送者是不是本机器人最近的交互对象。 */
  partner?: boolean;
  humans?: number;
  bots?: number;
  ownedTopic?: boolean;
  threadRootOther?: boolean;
  callsOther?: boolean;
  responder?: 'self' | 'other';
};

/** 本机器人负责的委托与事项：名称供点名匹配，有生效委托时「这个任务」才算指它。 */
export function ownedItems(mandates: CollaborationMandate[], followups: CollaborationFollowup[]) {
  const active = mandates.filter(item => item.status === 'active');
  return { names: [...active.map(item => item.goal), ...followups.filter(item => item.status === 'open').map(item => item.goal)], hasActiveMandates: active.length > 0 };
}

/** 用一条观察和查到的事实组装规则上下文；实时判定和回放共用。 */
export function ruleContextOf(trigger: CollaborationObservation, owned: { names: string[]; hasActiveMandates: boolean }, botNames: string[], facts: RuleFacts, roleScope?: string): RuleContext {
  const occurred = Date.parse(trigger.occurredAt);
  const at = occurred > 0 ? occurred : Date.parse(trigger.receivedAt);
  const senderId = trigger.senderId ?? '';
  return {
    text: trigger.text, messageType: facts.messageType ?? 'text', senderId, senderKind: trigger.senderKind, at,
    // 走到判定的消息都没有 @ 本机器人，所以出现任何 @ 都是在点别人。
    mentionsOther: trigger.refs.some(ref => ref === 'dutydeck:mention:other' || ref === 'dutydeck:mention:unknown') || /@_all/.test(trigger.text),
    botNames, ownedNames: owned.names, hasActiveMandates: owned.hasActiveMandates, level: facts.level,
    ...(roleScope !== undefined ? { roleScope } : {}),
    ...(facts.parent ? { parent: facts.parent } : {}), ...(facts.threadRootSelf ? { threadRootSelf: true } : {}),
    ...(facts.ownedTopic ? { ownedTopic: true } : {}), ...(facts.threadRootOther ? { threadRootOther: true } : {}),
    ...(facts.callsOther ? { callsOther: true } : {}), ...(facts.responder ? { responder: facts.responder } : {}),
    ...(facts.lastSelfAgoMs !== undefined ? { recent: { lastSelfAt: at - facts.lastSelfAgoMs, humanBetween: Boolean(facts.humanBetween), partners: facts.partner ? [senderId] : [] } } : {}),
    ...(facts.humans !== undefined ? { members: { humans: facts.humans, bots: facts.bots ?? 0 } } : {})
  };
}

export type ParticipationIntent = { kind: 'level'; level: ParticipationLevel } | { kind: 'why_silent' };

const levelPhrases: Array<[ParticipationLevel, RegExp]> = [
  ['mention', /(只在@时回?|只在@的时候回?|只有@才回|@了?你?再回|@了?你?才回|只回@)/],
  ['topic', /(话题里不用@|话题内免@|话题里免@|话题里直接回|别插话|不要插话|少插话|别主动|不要主动|安静点|安静一点)/],
  ['selective', /(按需参与|按需回复?|按需)/],
  ['eager', /(积极点|积极一点|积极些|主动点|主动一点|主动些|多参与|每条都回)/]
];
// 改档的话除了关键短语只剩这些虚词时才算数，避免「按需求改一下」这类句子被误认。
const intentFillers = /(这个群|本群|群里|以后|之后|改成|切到|换成|调成|就行|就好|模式|档位|一下|麻烦|请|你|就|吧|呢|啊|呀|哈|了|档)/g;
const remainder = (text: string, phrase: string) => text.replace(phrase, '').replace(intentFillers, '').replace(/[\p{P}\p{S}]/gu, '');

/** 在叫机器人的短消息（去掉 @ 后不超过 20 字）里的固定短语：改参与强度、问刚才为什么没回。 */
export function participationIntentOf(text: string): ParticipationIntent | undefined {
  const plain = stripMentionPlaceholders(text);
  if (!plain || plain.length > 20) return undefined;
  const compact = plain.toLowerCase().replace(/\s+/g, '').replace(/＠/g, '@');
  const why = compact.match(/(为什么|为啥|怎么)(没|不)(回|理|接|说话)/);
  if (why && remainder(compact, why[0]).replace(/(刚才|刚刚|我|的|消息|那条)/g, '').length <= 2) return { kind: 'why_silent' };
  for (const [level, pattern] of levelPhrases) {
    const match = compact.match(pattern);
    if (match && remainder(compact, match[0]).length <= 2) return { kind: 'level', level };
  }
  return undefined;
}

/** 回复本机器人主动消息时表示「插话了」的说法。 */
export const intrusionPattern = /(别插话|不要插话|不用你|没问你|不是问你|没叫你|没在叫你|不需要你)/;
