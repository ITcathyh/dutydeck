// Tag 模式判定回归用例：人工标注的群配置、消息事实和期望结果。
//
// layer: 'rule' 是规则层能决定的，participation-scenarios.test.ts 直接跑两轮规则断言当前结果；
// 当前行为有争议的照当前结果断言，在 note 里写争议，不改行为。
// layer: 'model' 是两轮规则都拿不准、交给模型的，标注期望 action 和理由，供离线模型评估用，不进 CI；
// CI 只断言它们确实越过两轮规则，并能组装成判定快照。
// @ 本机器人的消息走显式路径，不进判定，这里没有这类用例。

import { collaborationSettingsSchema, participationLevelOf, type CollaborationObservation, type CollaborationSnapshot, type ParticipationLevel } from '@dutydeck/shared';
import type { ParticipationRule, RuleFacts } from './participation-rules.js';

export const scenarioCategories = ['目标求助', '范围内告警', '已接手话题追问', '闲聊', '范围外提问', '@别人', '其他机器人消息', '单真人群',
  '多机器人群无接话人', '指定接话人', '负责范围', '别人的话题', '负责范围重叠', '致谢与表情'] as const;
export type ScenarioCategory = (typeof scenarioCategories)[number];
export type ModelAction = 'reply' | 'act' | 'silent';

export interface ScenarioGroup {
  /** 本机器人的名称，规则层按它认「叫名字」。 */
  botName: string;
  mentionPolicy: 'always' | 'topic' | 'never' | 'ambient';
  participation: 'observe' | 'selective' | 'eager';
  roleTitle?: string;
  roleScope?: string;
  /** 本群接话人：self 是本机器人，other 是别的机器人；不填表示没指定。 */
  responder?: 'self' | 'other';
  /** 群成员数，bots 含本机器人和场景包来源机器人；不填表示查不到（没权限或被安全策略截断）。 */
  members?: { humans: number; bots: number };
  /** members.bots 里有几个是本群场景包绑定的来源机器人；规则计数时排除（group-participation.ts 的 talkingBots）。 */
  sourceBots?: number;
}

export interface ScenarioHistoryItem {
  /** self 是本机器人；human 是当前消息的发送者，otherHuman 是另一个真人；bot 是别的机器人。 */
  sender: 'self' | 'human' | 'otherHuman' | 'bot';
  text: string;
  minutesAgo: number;
  /** 和当前消息在同一个话题里。 */
  inThread?: boolean;
  /** 这条消息 @ 了本机器人。 */
  mentionsSelf?: boolean;
}

export interface ScenarioMessage {
  /** 飞书文本，@ 用占位符 @_user_N、@所有人 用 @_all。 */
  text: string;
  messageType?: string;
  sender: 'human' | 'bot';
  /** @ 了别人（不含本机器人）。 */
  mentionsOther?: boolean;
  inThread?: boolean;
  /** 引用回复的那条消息是谁发的。 */
  parent?: 'self' | 'sender' | 'other';
  /** 话题根是本机器人发的。 */
  threadRootSelf?: boolean;
  /** 入站判定这个话题是本机器人接手的（话题里有本机器人的会话）。 */
  ownedTopic?: boolean;
  /** 话题根是别的机器人发的、或 @ 的是别人；实时只在多机器人群里查。 */
  threadRootOther?: boolean;
  /** 消息开头叫的是群里另一个机器人；实时只在多机器人群里查。 */
  callsOther?: boolean;
  /** 第二轮规则才查的最近发言。 */
  recent?: { lastSelfAgoMs: number; humanBetween: boolean; partner: boolean };
  /** 本机器人生效中的委托名称。 */
  mandates?: string[];
  /** 交给模型时的前文。 */
  history?: ScenarioHistoryItem[];
}

export type ScenarioExpectation =
  | { layer: 'rule'; round: 1 | 2; action: 'addressed' | 'silent'; rule: ParticipationRule }
  | { layer: 'model'; action: ModelAction; acceptable?: ModelAction[]; why: string };

export interface ParticipationScenario {
  id: string;
  category: ScenarioCategory;
  title: string;
  group: ScenarioGroup;
  message: ScenarioMessage;
  expected: ScenarioExpectation;
  /** 当前行为有争议或有前提时的说明。 */
  note?: string;
}

const ALARM_SCOPE = '报警和告警（监控告警卡、P0/P1 告警）、服务异常与线上问题排查、告警统计与降噪';
const ALERT = [
  '<card title="order-service(canary) 内存占用过高">',
  '**服务**：demo.order.service',
  '**环境**：canary',
  '**异常原因：实例内存使用率过高(连续5秒平均使用率60%)**',
  '**影响面：最近2分钟内该服务一共有16个实例处于高负载状态**',
  '**错误次数：16060次**',
  '</card>'
].join('\n');
/** 群友约饭的前文：接话人反例和正例共用。 */
const LUNCH: ScenarioHistoryItem[] = [
  { sender: 'otherHuman', text: '中午去哪吃？楼下新开了家麻辣烫', minutesAgo: 6 },
  { sender: 'human', text: '上周去过，排队要半小时', minutesAgo: 4 }];

/** 群成员数查不到。 */
const membersUnknown: ScenarioGroup = { botName: 'bdev-flash', mentionPolicy: 'topic', participation: 'selective' };
/** 3 个真人、只有本机器人一个机器人。 */
const single: ScenarioGroup = { ...membersUnknown, members: { humans: 3, bots: 1 } };
/** 3 个真人、两个会接话的机器人（本机器人和另一个 Dutydeck 机器人）。 */
const crowded: ScenarioGroup = { ...single, members: { humans: 3, bots: 2 } };
/** 1 个真人、1 个机器人。 */
const solo: ScenarioGroup = { ...single, members: { humans: 1, bots: 1 } };
/** 10-12 评估用的真实测试群：1 个真人、15 个机器人（14 个工具机器人）；Tag 的配置是「始终 @」加「按需」。 */
const tools: ScenarioGroup = { botName: 'Tag 验证 · CCFlash', mentionPolicy: 'always', participation: 'selective', members: { humans: 1, bots: 15 } };
const alarmRole = { roleTitle: '告警值班', roleScope: ALARM_SCOPE };

const rule = (round: 1 | 2, action: 'addressed' | 'silent', name: ParticipationRule): ScenarioExpectation => ({ layer: 'rule', round, action, rule: name });
const model = (action: ModelAction, why: string, acceptable?: ModelAction[]): ScenarioExpectation => ({ layer: 'model', action, why, ...(acceptable ? { acceptable } : {}) });
const human = (text: string, patch: Partial<ScenarioMessage> = {}): ScenarioMessage => ({ text, sender: 'human', ...patch });

export const participationScenarios: ParticipationScenario[] = [
  // 目标求助
  { id: 'help_calls_name', category: '目标求助', title: '开头叫名字求助', group: single, message: human('flash 帮我看下这个报错'), expected: rule(1, 'addressed', 'calls_name') },
  { id: 'help_calls_name_other_responder', category: '目标求助', title: '接话人是别的机器人，叫我名字照常接', group: { ...crowded, responder: 'other' },
    message: human('flash，查一下今天的发布单'), expected: rule(1, 'addressed', 'calls_name') },
  { id: 'help_calls_ccflash', category: '目标求助', title: '多工具机器人群里叫「ccflash」', group: tools, message: human('ccflash 帮我看下这个告警'), expected: rule(1, 'addressed', 'calls_name') },
  { id: 'help_calls_generic_tag', category: '目标求助', title: '多工具机器人群里叫「Tag」', group: tools, message: human('Tag 帮我看下这个告警'), expected: rule(1, 'silent', 'no_responder'),
    note: '有争议：「tag」被当成泛称，不算叫名字；本群又是没指定接话人的多机器人群，所以不接。10-12 评估认为用户期望接。' },
  { id: 'help_reply_to_self', category: '目标求助', title: '引用回复我的消息追问', group: single, message: human('这个结论的依据是什么', { parent: 'self' }), expected: rule(1, 'addressed', 'reply_to_self') },
  { id: 'help_owned_item', category: '目标求助', title: '提到我负责的委托', group: single, message: human('完成容量评估这件事什么时候好', { mandates: ['完成容量评估'] }), expected: rule(1, 'addressed', 'owned_item') },
  { id: 'help_deictic_task', category: '目标求助', title: '我刚发完总结，紧接着说「关掉这个总结任务」', group: { ...single, members: { humans: 2, bots: 1 } },
    message: human('关掉这个总结任务', { mandates: ['每天 18 点总结群里的讨论'], recent: { lastSelfAgoMs: 28_000, humanBetween: false, partner: false } }), expected: rule(2, 'addressed', 'owned_item') },
  { id: 'help_summarize_no_addressee', category: '目标求助', title: '单机器人群里没对象的「帮我总结下今天群里聊的」', group: single,
    message: human('帮我总结下今天群里聊的几个问题', { history: [
      { sender: 'otherHuman', text: '今天订单服务内存告警有点多', minutesAgo: 30 },
      { sender: 'human', text: '嗯，canary 那批实例', minutesAgo: 25 },
      { sender: 'otherHuman', text: '下午发版要不要延后', minutesAgo: 10 }] }),
    expected: model('silent', '没配负责范围、我也不是接话人，没有明确对象的请求不接；要我总结的人会 @ 我'),
    note: '10-15 由 reply 改为 silent：原标注认为单机器人群里「帮我总结群里聊的」就是对机器人说的，但这和产品规则冲突——没配负责范围、本机器人又不是接话人时，没有明确对象的泛问不接（指定接话人后会接）。10-12 回放和 10-15 离线评估（线上配置及降强度配置共 4 次）都判 silent。' },
  { id: 'help_generic_question', category: '目标求助', title: '单机器人群里问「有人知道…吗」', group: single, message: human('有人知道 ECONNRESET 这个报错怎么处理吗'),
    expected: model('silent', '问的是「有人」，对象是群友；没配负责范围、也没叫我，按设计不接') },

  // 范围内告警
  { id: 'alarm_bot_unsubscribed', category: '范围内告警', title: '告警机器人发告警，本群没订阅', group: single, message: { text: ALERT, sender: 'bot' }, expected: rule(1, 'silent', 'bot_sender'),
    note: '订阅的告警来源不走规则层，走告警初筛（group-participation.test.ts 和 participation-paths.test.ts 覆盖）。' },
  { id: 'alarm_bot_scope_unsubscribed', category: '范围内告警', title: '告警机器人发告警，配了告警负责范围但没订阅', group: { ...single, ...alarmRole }, message: { text: ALERT, sender: 'bot' },
    expected: rule(1, 'silent', 'bot_sender'), note: '有争议：负责范围不覆盖机器人发的消息；要自动初筛告警必须另开告警订阅。' },
  { id: 'alarm_human_paste_scope', category: '范围内告警', title: '多工具机器人群，真人转发告警原文，配了告警负责范围', group: { ...tools, ...alarmRole }, message: human(ALERT),
    expected: model('act', '真人贴出原始告警，在负责范围内、还没人处理，需要排查') },
  { id: 'alarm_human_paste_no_scope', category: '范围内告警', title: '单机器人群，真人转发告警原文，没配负责范围', group: single, message: human(ALERT),
    expected: model('silent', '没配负责范围；按设计普通告警不接，要我看的人会 @ 我'), note: '该不该接取决于有没有配负责范围；方案建议在要用的群配负责范围。' },
  { id: 'alarm_who_looks_scope', category: '范围内告警', title: '告警下面问「这个报警谁看下」，配了告警负责范围', group: { ...tools, ...alarmRole },
    message: human('这个报警谁看下', { history: [{ sender: 'bot', text: ALERT, minutesAgo: 1 }] }), expected: model('act', '没指定对象的泛问，落在负责范围里，还没人接手，需要排查') },
  { id: 'alarm_what_no_scope', category: '范围内告警', title: '告警下面问「这是什么情况？要紧吗」，没配负责范围', group: single,
    message: human('这是什么情况？要紧吗', { history: [{ sender: 'bot', text: ALERT, minutesAgo: 1 }] }),
    expected: model('silent', '没配负责范围、没指明问谁，可能是在问同事；按设计普通告警的泛问不接'), note: '10-12 标的 act? 不成立：没有负责范围时不应替同事回答告警泛问。' },
  { id: 'alarm_what_scope', category: '范围内告警', title: '告警下面问「这是什么情况？要紧吗」，配了告警负责范围', group: { ...single, ...alarmRole },
    message: human('这是什么情况？要紧吗', { history: [{ sender: 'bot', text: ALERT, minutesAgo: 1 }] }), expected: model('act', '负责范围内的告警，需要查数据才能判断要不要紧') },
  { id: 'alarm_recovered_scope', category: '范围内告警', title: '告警已有人处理并恢复，发进度', group: { ...single, ...alarmRole },
    message: human('已回滚，恢复了', { history: [{ sender: 'bot', text: ALERT, minutesAgo: 20 }, { sender: 'human', text: '我在看，像是 canary 发布导致的', minutesAgo: 15 }] }),
    expected: model('silent', '有人在处理且已恢复，只是进度播报') },

  // 已接手话题追问
  { id: 'owned_topic_followup', category: '已接手话题追问', title: '我接手的话题里不 @ 追问', group: crowded, message: human('那要不要回滚', { inThread: true, ownedTopic: true }), expected: rule(1, 'addressed', 'owned_topic') },
  { id: 'owned_topic_root_other_bot', category: '已接手话题追问', title: '告警机器人开的话题，我已接手，不 @ 追问', group: crowded,
    message: human('影响面多大', { inThread: true, ownedTopic: true, threadRootOther: true }), expected: rule(1, 'addressed', 'owned_topic') },
  { id: 'owned_thread_root_self', category: '已接手话题追问', title: '我发的消息开出的话题里追问', group: single, message: human('第二步怎么做', { inThread: true, threadRootSelf: true }), expected: rule(1, 'addressed', 'reply_to_self') },
  { id: 'owned_follow_up', category: '已接手话题追问', title: '我 2 分钟前回过他，他紧接着追问', group: single,
    message: human('那第二个呢', { recent: { lastSelfAgoMs: 120_000, humanBetween: false, partner: true } }), expected: rule(2, 'addressed', 'follow_up') },
  { id: 'owned_follow_up_interrupted', category: '已接手话题追问', title: '我回完之后别人插了一句，他再追问', group: single,
    message: human('那第二个呢', { recent: { lastSelfAgoMs: 180_000, humanBetween: true, partner: true }, history: [
      { sender: 'self', text: '排查结论有两个可能原因：第一个是连接池打满，已确认；第二个还在看。', minutesAgo: 3 },
      { sender: 'otherHuman', text: '我这边也看到连接池告警了', minutesAgo: 1 }] }),
    expected: model('reply', '问的是我刚才结论里的「第二个原因」，别人插的话没有换话题', ['act']) },
  { id: 'owned_late_followup', category: '已接手话题追问', title: '我 8 分钟前在话题里答过，同一人不 @ 追问', group: single,
    message: human('那影响面多大？要不要回滚', { inThread: true, recent: { lastSelfAgoMs: 480_000, humanBetween: false, partner: true }, history: [
      { sender: 'bot', text: ALERT, minutesAgo: 10, inThread: true },
      { sender: 'human', text: '@_user_1 帮我看下这条告警', minutesAgo: 9, inThread: true, mentionsSelf: true },
      { sender: 'self', text: '结论：canary 实例内存 60% 触发阈值，属于阈值偏低的噪音，暂不需要处理。', minutesAgo: 8, inThread: true }] }),
    expected: model('reply', '同一人在我答过的话题里连续追问；可以凭 8 分钟前的结论先文字答复，说明影响面和要不要回滚还要查新数据', ['act']),
    note: '话题里有本机器人未归档的会话时，入站会标成接手的话题，由 owned_topic 直接接；这条模拟没标上的情况（例如会话已归档）。10-15 主标注由 act 改为 reply、act 作备选：判定 prompt 规定能凭已有材料文字答复的用 reply，10-12 回放和 10-15 离线评估（3 种模型配置共 7 次）全判 reply；要查新数据时 act 也说得通。' },
  { id: 'owned_topic_thanks', category: '已接手话题追问', title: '我接手的话题里说「好的谢谢」', group: single, message: human('好的谢谢', { inThread: true, ownedTopic: true }), expected: rule(1, 'silent', 'short_thanks') },

  // 闲聊
  { id: 'chitchat_humans', category: '闲聊', title: '真人之间约时间', group: single, message: human('有的，3 点后', { history: [{ sender: 'otherHuman', text: '周五下午有空吗', minutesAgo: 1 }] }),
    expected: model('silent', '群友之间的问答，没叫我') },
  { id: 'chitchat_scope', category: '闲聊', title: '配了告警负责范围的群里聊团建', group: { ...tools, ...alarmRole }, message: human('周五团建去哪，有推荐吗'),
    expected: model('silent', '不在负责范围，也没叫我') },
  { id: 'chitchat_eager', category: '闲聊', title: '积极档、没配负责范围，聊团建', group: { ...single, participation: 'eager' }, message: human('周五团建去哪，有推荐吗'),
    expected: rule(1, 'addressed', 'eager_default'), note: '有争议：积极档会把闲聊也交给执行 Agent；档位说明写了「适合单人群」。' },
  { id: 'chitchat_reply_to_other', category: '闲聊', title: '引用回复同事的消息', group: single, message: human('哈哈确实', { parent: 'other' }), expected: rule(1, 'silent', 'reply_to_other') },

  // 范围外提问
  { id: 'out_of_scope_tools', category: '范围外提问', title: '配了告警负责范围，问会议室', group: { ...tools, ...alarmRole }, message: human('帮我查下明天下午的会议室'),
    expected: model('silent', '不在负责范围；群里还有很多工具机器人，没叫我') },
  { id: 'out_of_scope_single', category: '范围外提问', title: '配了告警负责范围，问需求文档', group: { ...single, ...alarmRole }, message: human('这个需求文档谁写的？'),
    expected: model('silent', '不在负责范围，问的是群友') },
  { id: 'out_of_scope_calls_name', category: '范围外提问', title: '配了告警负责范围，叫名字问范围外的事', group: { ...single, ...alarmRole },
    message: human('flash 帮我查下明天的会议室'), expected: rule(1, 'addressed', 'calls_name') },

  // @别人
  { id: 'mentions_other', category: '@别人', title: '@ 同事', group: single, message: human('@_user_1 你看下这个报错', { mentionsOther: true }), expected: rule(1, 'silent', 'mentions_other') },
  { id: 'mentions_all', category: '@别人', title: '@所有人 通知', group: single, message: human('@_all 今晚 8 点发版，大家注意'), expected: rule(1, 'silent', 'mentions_other') },
  { id: 'mentions_other_solo', category: '@别人', title: '单真人群里 @ 别人', group: solo, message: human('@_user_1 明天记得交周报', { mentionsOther: true }), expected: rule(1, 'silent', 'mentions_other') },
  { id: 'mentions_other_scope', category: '@别人', title: '配了告警负责范围，@ 同事看告警', group: { ...single, ...alarmRole },
    message: human('@_user_1 这个告警你看下', { mentionsOther: true }), expected: rule(1, 'silent', 'mentions_other') },
  { id: 'calls_other_bot', category: '@别人', title: '多机器人群里不 @、开头叫另一个机器人的名字', group: crowded, message: human('cc 帮我看下发布单', { callsOther: true }),
    expected: rule(1, 'silent', 'calls_other') },

  // 其他机器人消息
  { id: 'other_bot_plain', category: '其他机器人消息', title: '别的机器人发通知', group: crowded, message: { text: '发布单 #123 已完成', sender: 'bot' }, expected: rule(1, 'silent', 'bot_sender') },
  { id: 'other_bot_calls_me', category: '其他机器人消息', title: '别的机器人不 @ 叫我名字', group: single, message: { text: 'flash 帮我看下', sender: 'bot' }, expected: rule(1, 'silent', 'bot_sender') },

  // 单真人群
  { id: 'solo_casual', category: '单真人群', title: '单真人单机器人群里随口一句', group: solo, message: human('晚上记得把周报补了'), expected: rule(1, 'addressed', 'single_human'),
    note: '有争议：「按需」档在单真人群里等于「积极」，随口一句也交给执行 Agent，而且不占主动发言额度。' },
  { id: 'solo_doc', category: '单真人群', title: '单真人群里没 @ 的「总结下这个文档」', group: solo, message: human('总结下这个文档要做的事情 https://example.com/docx/AbCdEf123'),
    expected: rule(1, 'addressed', 'single_human') },
  { id: 'solo_with_alarm_source', category: '单真人群', title: '单真人群里还有一个订阅的告警机器人，随口一句', group: { ...solo, members: { humans: 1, bots: 2 }, sourceBots: 1 },
    message: human('晚上记得把周报补了'), expected: rule(1, 'addressed', 'single_human'), note: '订阅的告警来源不计数，所以按单真人单机器人处理，争议同 solo_casual。' },
  { id: 'solo_scope', category: '单真人群', title: '单真人群配了告警负责范围，随口一句', group: { ...solo, ...alarmRole }, message: human('晚上记得把周报补了'),
    expected: model('silent', '像是给自己的备忘，不在负责范围'), note: '配了负责范围后 single_human 不再直接执行，交给模型。' },
  { id: 'solo_members_unknown', category: '单真人群', title: '成员数查不到，随口一句', group: membersUnknown, message: human('晚上记得把周报补了'),
    expected: model('silent', '像是备忘或提醒同事，没叫我'), note: '群成员数查不到时 single_human 和多机器人群的规则都不触发。' },

  // 多机器人群无接话人
  { id: 'no_responder_tools', category: '多机器人群无接话人', title: '多工具机器人群顶层泛问', group: tools, message: human('这个告警谁帮忙看下'), expected: rule(1, 'silent', 'no_responder'),
    note: '有争议：工具机器人也算「会接话的机器人」，挂了工具机器人的群默认都不接没 @ 的消息（10-12 评估问题 1）。' },
  { id: 'no_responder_eager', category: '多机器人群无接话人', title: '两个机器人、积极档、没指定接话人', group: { ...crowded, participation: 'eager' }, message: human('今天下午三点发版'),
    expected: rule(1, 'silent', 'no_responder') },
  { id: 'no_responder_with_alarm_source', category: '多机器人群无接话人', title: '三个机器人里一个是订阅的告警来源', group: { ...crowded, members: { humans: 3, bots: 3 }, sourceBots: 1 },
    message: human('今天下午三点发版'), expected: rule(1, 'silent', 'no_responder') },

  // 指定接话人
  { id: 'responder_other', category: '指定接话人', title: '接话人是别的机器人', group: { ...crowded, responder: 'other' }, message: human('今天的发布单在哪看'), expected: rule(1, 'silent', 'not_responder') },
  { id: 'responder_self_eager', category: '指定接话人', title: '我是接话人、积极档', group: { ...crowded, participation: 'eager', responder: 'self' }, message: human('今天的发布单在哪看'),
    expected: rule(1, 'addressed', 'eager_default') },
  { id: 'responder_self_selective', category: '指定接话人', title: '我是接话人、按需档，群里泛问', group: { ...crowded, responder: 'self' }, message: human('有人知道今天的发布单在哪看吗'),
    expected: model('reply', '本群指定我接没 @ 的消息（/status 也这么写），群里的泛问该由我答；材料不够时说明缺什么', ['act']),
    note: '10-15 起判定材料带 facts.responder="self"，没配负责范围时判定 prompt 把没有明确对象、需要有机器人处理的求助算在叫接话人；之前 prompt 不知道接话人身份，模型都判 silent。' },

  // 我是接话人、没配负责范围：接没有对象的求助，但不接群友之间的话（反例），正例和闲聊同群，确认不是靠群里没人说话判对的
  { id: 'responder_self_chitchat', category: '指定接话人', title: '我是接话人、按需档，群友约饭吐槽', group: { ...crowded, responder: 'self' },
    message: human('那换食堂吧，三楼新开的窗口据说还行，就是辣得离谱', { history: LUNCH }), expected: model('silent', '群友之间约饭闲聊，不是求助') },
  { id: 'responder_self_peer_answered', category: '指定接话人', title: '我是接话人、按需档，群友已经在回答，他接着追问', group: { ...crowded, responder: 'self' },
    message: human('提完工单一般多久能批？我下午就要用', { history: [
      { sender: 'human', text: '测试环境的数据库账号在哪申请？', minutesAgo: 5 },
      { sender: 'otherHuman', text: '在 DBA 平台提工单，集群选 test 就行', minutesAgo: 3 }] }),
    expected: model('silent', '同事刚回答了他的问题，这句追问是接着问那位同事的') },
  { id: 'responder_self_progress', category: '指定接话人', title: '我是接话人、按需档，发布进度通知', group: { ...crowded, responder: 'self' },
    message: human('订单服务 v2.3.1 已发布到 staging，大家可以开始回归了'), expected: model('silent', '进度播报，不是求助') },
  { id: 'responder_self_help_after_chitchat', category: '指定接话人', title: '我是接话人、按需档，闲聊之后有人发没有对象的求助', group: { ...crowded, responder: 'self' },
    message: human('有人知道 staging 的日志平台地址吗？订单服务的日志一直搜不到', { history: LUNCH }),
    expected: model('reply', '本群指定我接没 @ 的消息，没有对象的求助该由我接；材料里没有日志平台地址，回复说明缺什么', ['act']),
    note: '和 responder_self_chitchat 同样的闲聊前文：群里有人说话时，接话人照样接求助。' },

  // 负责范围
  { id: 'scope_crowded_no_responder', category: '负责范围', title: '两个机器人、没指定接话人，配了告警负责范围，范围内的事', group: { ...crowded, ...alarmRole },
    message: human('线上订单服务报错率升高了'), expected: model('act', '在负责范围内、需要排查；负责范围绕过了 no_responder') },
  { id: 'scope_eager_out_of_scope', category: '负责范围', title: '积极档配了告警负责范围，聊团建', group: { ...single, participation: 'eager', ...alarmRole }, message: human('周五团建去哪，有推荐吗'),
    expected: model('silent', '积极档配了负责范围后按范围判，团建不在范围'), note: '配了负责范围后 eager_default 不再触发，交给模型。' },
  { id: 'scope_owned_topic', category: '负责范围', title: '配了负责范围，我接手的话题里问范围外的事', group: { ...crowded, ...alarmRole }, message: human('顺便问下周报模板在哪', { inThread: true, ownedTopic: true }),
    expected: rule(1, 'addressed', 'owned_topic') },

  // 别人的话题
  { id: 'topic_of_other_bot_root', category: '别人的话题', title: '别的机器人开的话题里不 @ 问', group: crowded, message: human('这个要紧吗', { inThread: true, threadRootOther: true }), expected: rule(1, 'silent', 'topic_of_other') },
  { id: 'topic_of_other_alarm_scope', category: '别人的话题', title: '告警机器人开的话题里不 @ 问，配了告警负责范围', group: { ...tools, ...alarmRole },
    message: human('这个要紧吗？要不要回滚', { inThread: true, threadRootOther: true }), expected: rule(1, 'silent', 'topic_of_other'),
    note: '有争议：多机器人群里告警机器人开的话题都算「别人的话题」，配了负责范围也不接；在话题里 @ 过本机器人、它接手后才接。' },
  { id: 'topic_of_other_responder_self', category: '别人的话题', title: '我是接话人，别的机器人开的话题', group: { ...crowded, participation: 'eager', responder: 'self' },
    message: human('这个要紧吗', { inThread: true, threadRootOther: true }), expected: rule(1, 'silent', 'topic_of_other') },
  { id: 'topic_of_other_quote_self', category: '别人的话题', title: '别人的话题里引用回复我的消息', group: crowded,
    message: human('这个结论能再解释下吗', { inThread: true, threadRootOther: true, parent: 'self' }), expected: rule(1, 'addressed', 'reply_to_self') },

  // 负责范围重叠：两个配了负责范围的机器人看到同一条消息
  { id: 'overlap_responder_self', category: '负责范围重叠', title: '范围重叠，我是接话人', group: { ...crowded, ...alarmRole, responder: 'self' },
    message: human('订单服务 5xx 突然升高，谁看下'), expected: model('act', '在负责范围内、需要排查') },
  { id: 'overlap_responder_other', category: '负责范围重叠', title: '范围重叠，接话人是另一个机器人', group: { ...crowded, roleTitle: '线上排查', roleScope: '线上问题排查与服务异常定位', responder: 'other' },
    message: human('订单服务 5xx 突然升高，谁看下'), expected: model('act', '在负责范围内、需要排查；负责范围绕过了 not_responder'),
    note: '负责范围不互斥：接话人是别的机器人时也按范围判定，和 overlap_responder_self 那个机器人可能同时接（方案「已知说明」）。' },
  { id: 'overlap_third_no_scope', category: '负责范围重叠', title: '同一条消息，第三个没配负责范围的机器人', group: { ...crowded, members: { humans: 3, bots: 3 }, responder: 'other' },
    message: human('订单服务 5xx 突然升高，谁看下'), expected: rule(1, 'silent', 'not_responder') },

  // 致谢与表情
  { id: 'thanks', category: '致谢与表情', title: '致谢', group: single, message: human('谢谢'), expected: rule(1, 'silent', 'short_thanks') },
  { id: 'thanks_eager', category: '致谢与表情', title: '积极档里的「好的，收到」', group: { ...single, participation: 'eager' }, message: human('好的，收到'), expected: rule(1, 'silent', 'short_thanks') },
  { id: 'thanks_solo', category: '致谢与表情', title: '单真人群里的「辛苦了！」', group: solo, message: human('辛苦了！'), expected: rule(1, 'silent', 'short_thanks') },
  { id: 'thanks_then_request_solo', category: '致谢与表情', title: '单真人群里「好的，那你帮我把发布单也建一下」', group: solo, message: human('好的，那你帮我把发布单也建一下'),
    expected: rule(1, 'addressed', 'single_human') },
  { id: 'emoji_text', category: '致谢与表情', title: '只有表情', group: single, message: human('[赞][赞]'), expected: rule(1, 'silent', 'emoji_only') },
  { id: 'emoji_sticker', category: '致谢与表情', title: '贴图', group: { ...single, participation: 'eager' }, message: human('', { messageType: 'sticker' }), expected: rule(1, 'silent', 'emoji_only') },
  { id: 'emoji_scope', category: '致谢与表情', title: '配了负责范围，回个 [OK]', group: { ...single, ...alarmRole }, message: human('[OK]'), expected: rule(1, 'silent', 'emoji_only') }
];

/** 用例组装用的群和身份。 */
export const scenarioScope = { appId: 'cli_scenario_self', chatId: 'oc_scenario' };
export const SCENARIO_SELF_OPEN_ID = 'ou_scenario_self';
const SENDERS = { self: scenarioScope.appId, human: 'ou_human_a', otherHuman: 'ou_human_b', bot: 'ou_other_bot' } as const;
const THREAD_ID = 'omt_scenario';
const NOW = Date.parse('2026-10-15T08:00:00.000Z');

export function scenarioLevel(scenario: ParticipationScenario): ParticipationLevel {
  return participationLevelOf(scenario.group.mentionPolicy, scenario.group.participation);
}

/** 两轮规则的事实：第一轮不带最近发言，第二轮补上。 */
export function scenarioFacts(scenario: ParticipationScenario, round: 1 | 2): RuleFacts {
  const { group, message } = scenario;
  return {
    level: scenarioLevel(scenario), messageType: message.messageType ?? 'text',
    ...(message.parent ? { parent: message.parent } : {}), ...(message.threadRootSelf ? { threadRootSelf: true } : {}),
    ...(message.ownedTopic ? { ownedTopic: true } : {}), ...(message.threadRootOther ? { threadRootOther: true } : {}),
    ...(message.callsOther ? { callsOther: true } : {}), ...(group.responder ? { responder: group.responder } : {}),
    ...(group.members ? { humans: group.members.humans, bots: group.members.bots - (group.sourceBots ?? 0) } : {}),
    ...(round === 2 && message.recent ? { lastSelfAgoMs: message.recent.lastSelfAgoMs, humanBetween: message.recent.humanBetween, partner: message.recent.partner } : {})
  };
}

export function scenarioOwned(scenario: ParticipationScenario) {
  const names = scenario.message.mandates ?? [];
  return { names, hasActiveMandates: names.length > 0 };
}

/** 判定快照：前文加当前消息，当前消息的 id 是 obs_trigger。 */
export function scenarioSnapshot(scenario: ParticipationScenario): { snapshot: CollaborationSnapshot; trigger: CollaborationObservation } {
  const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
  const observation = (id: string, sequence: number, sender: keyof typeof SENDERS, text: string, minutesAgo: number, inThread: boolean, refs: string[]): CollaborationObservation => ({
    id, scope: scenarioScope, sequence, source: 'lark.message', eventId: `om_${id}`, occurredAt: at(minutesAgo), receivedAt: at(minutesAgo),
    senderId: SENDERS[sender], senderKind: sender === 'self' || sender === 'bot' ? 'bot' : 'human', messageId: `om_${id}`,
    ...(inThread ? { threadId: THREAD_ID } : {}), text, refs: [`om_${id}`, `dutydeck:self:${SCENARIO_SELF_OPEN_ID}`, ...refs], origin: 'live', missing: [], revision: 1
  });
  const history = [...scenario.message.history ?? []].sort((left, right) => right.minutesAgo - left.minutesAgo)
    .map((item, index) => observation(`obs_history_${index + 1}`, index + 1, item.sender, item.text, item.minutesAgo, Boolean(item.inThread),
      item.mentionsSelf ? ['dutydeck:explicit', 'dutydeck:mention:self'] : []));
  const { message } = scenario;
  const trigger = observation('obs_trigger', history.length + 1, message.sender === 'bot' ? 'bot' : 'human', message.text, 0, Boolean(message.inThread),
    [...(message.parent ? ['om_parent', 'dutydeck:parent:om_parent'] : []), ...(message.mentionsOther ? ['dutydeck:mention:other'] : [])]);
  const observations = [...history, trigger];
  const settings = collaborationSettingsSchema.parse({ scope: scenarioScope, revision: 1, participation: scenario.group.participation, updatedAt: at(0) });
  return { snapshot: { scope: scenarioScope, contextRevision: observations.length, settings, observations, followups: [], mandates: [] }, trigger };
}
