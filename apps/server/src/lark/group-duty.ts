// 群里的分工：告警初筛订阅和接话人。本模块是纯函数，状态、发卡和派发在 group-participation.ts。
//
// 接话人在多个 Bot 实例之间靠群消息同步：各实例存储不共享，但群消息大家都收得到。某个 Bot 成为接话人
// （群里确认卡确认，或在 Web 上设成本 Bot）后在群里发一条声明；其他实例收到别的 Bot 发的声明，就把接话人记成它，
// 自己让出。没指定接话人时，多机器人群里没 @ 的消息谁都不接（见 participation-rules 的 no_responder）。

import { createHash } from 'node:crypto';
import type { AlarmSubscription } from '@dutydeck/shared';
import { stripMentionPlaceholders } from './participation-rules.js';

/** 告警指纹：来源 + 去掉链接、数字、长十六进制串和空白后的正文。时间、数值、实例号这类每次都变的部分不参与比较。 */
export function alarmFingerprint(sourceAppId: string, text: string): string {
  const stable = text.replace(/https?:\/\/\S+/g, '').replace(/\b[0-9a-f]{8,}\b/gi, '#').replace(/[0-9０-９]+/g, '#').replace(/\s+/g, '').slice(0, 2000);
  return createHash('sha256').update(JSON.stringify([sourceAppId, stable])).digest('hex').slice(0, 32);
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** 告警文本里有任一个级别关键字；英文数字关键字按整词比，「P1」不匹配「P10」。没设级别时都算命中。 */
export function alarmLevelMatches(levels: string[], text: string): boolean {
  return !levels.length || levels.some(level => (/^[a-z0-9]+$/i.test(level)
    ? new RegExp(`(?<![a-z0-9])${escapeRegExp(level)}(?![a-z0-9])`, 'i') : new RegExp(escapeRegExp(level), 'i')).test(text));
}

export type AlarmIntent = { kind: 'subscribe'; levels: string[] } | { kind: 'unsubscribe' };
const alarmOff = /(告警|报警).{0,6}(别|不要|不用|无需|停止|停掉|取消|关掉|关闭)再?(分析|看|初筛|处理|管)|(取消|关掉|关闭|停掉|停止)(告警|报警)(订阅|初筛|分析)/;
const alarmOn = /(告警|报警).{0,8}(先|帮我|帮忙|自动)(初筛|分析|看看|看一下|看下|看|处理)|(订阅|开启|打开)(告警|报警)(初筛|分析)?|(告警|报警)初筛/;
const levelTokens = /\b(p[0-4]|sev[0-4]|critical|fatal|major|warning|error)\b|严重|紧急|致命/gi;
/** 在叫机器人的短消息（去掉 @ 后不超过 40 字）里开关告警初筛的说法；「只看 P0」这类级别一并取出。 */
export function alarmIntentOf(text: string): AlarmIntent | undefined {
  const plain = stripMentionPlaceholders(text);
  if (!plain || plain.length > 40) return undefined;
  if (alarmOff.test(plain)) return { kind: 'unsubscribe' };
  if (!alarmOn.test(plain)) return undefined;
  return { kind: 'subscribe', levels: [...new Set([...plain.matchAll(levelTokens)].map(match => match[0].toUpperCase()))] };
}

/** 订阅的一句话说明：确认卡、/status、Web 都用。 */
export function describeAlarm(alarm: Pick<AlarmSubscription, 'sources' | 'levels' | 'dedupeHours' | 'maxPerHour'>): string {
  const sources = alarm.sources.map(source => source.name ? `${source.name}（${source.appId}）` : source.appId).join('、') || '未填写';
  return `来源 ${sources}；级别${alarm.levels.length ? `只看 ${alarm.levels.join('、')}` : '不限'}；同一条告警 ${alarm.dedupeHours} 小时内只分析一次，每小时最多 ${alarm.maxPerHour} 条`;
}

/** 初筛任务的提示词约定，放在告警原文前面。 */
export function alarmTriagePrompt(sourceName: string): string {
  return [
    `[告警初筛] 下面是「${sourceName}」在群里发的告警。本群订阅了告警初筛，请先做一次初步分析，按这个格式简短回答：`,
    '1. 判断：真异常 / 误报 / 待确认，一句话说明理由。',
    '2. 证据：支撑判断的关键数据、日志或链接；没查到就写没查到。',
    '3. 需要谁做什么：没有就写「暂不需要处理」。',
    '4. 可直接转发：一段能直接转给相关同学的话。',
    '拿不准就写「待确认」并说明还缺什么，不要猜。',
    '[告警原文]'
  ].join('\n');
}

export type AlarmOutcome = 'triaged' | 'level' | 'duplicate' | 'rate_limited' | 'not_responder' | 'no_requester';
export const alarmOutcomeReasons: Record<AlarmOutcome, string> = {
  triaged: '告警命中订阅，已起初筛任务',
  level: '告警级别不在订阅范围内',
  duplicate: '同一条告警在去重窗口内已经分析过',
  rate_limited: '本小时初筛条数已到上限',
  not_responder: '本群接话人是别的机器人，告警由它初筛',
  no_requester: '订阅缺少确认人，初筛任务没法发起；请在群里重新说一次开启订阅'
};

/** 群里指定接话人的说法；name 为空或「你」时指被 @ 的那个机器人。 */
export function responderIntentOf(text: string): { name: string } | undefined {
  const plain = stripMentionPlaceholders(text).replace(/\s+/g, ' ').trim();
  if (!plain || plain.length > 30) return undefined;
  const match = plain.match(/^(?:这个群|本群|群里)?(?:以后|之后)?(?:都)?(?:由|让|请)?\s*(.{0,20}?)\s*(?:来|负责|专门|统一)*(?:接话|当接话人|做接话人)(?:吧|就行|就好|了)?[。.!！]?$/)
    ?? plain.match(/^(?:这个群|本群|群里)?的?接话人(?:改成|改为|设为|设成|换成|是|用)\s*(.{1,20}?)(?:吧|就行|就好|了)?[。.!！]?$/);
  if (!match) return undefined;
  const name = match[1]!.trim();
  return name === '我' || /^(谁|哪个)/.test(name) ? undefined : { name: name === '你' ? '' : name };
}

const ANNOUNCEMENT = '【接话人】';
/** 接话人的声明消息：成为接话人或卸任时由它自己发到群里，其他 Bot 实例据此同步。 */
export const responderClaimText = (name: string) => `${ANNOUNCEMENT}本群没 @ 机器人的消息由我（${name}）接；其他机器人只接 @ 和自己接手的话题。`;
export const responderReleaseText = (name: string) => `${ANNOUNCEMENT}我（${name}）不再负责接本群没 @ 机器人的消息。`;
export function responderAnnouncementOf(text: string): { kind: 'claim' | 'release'; name?: string } | undefined {
  if (!text.startsWith(ANNOUNCEMENT)) return undefined;
  const name = text.match(/我（(.{1,128}?)）/)?.[1];
  const kind = text.includes('不再负责') ? 'release' : text.includes('由我') ? 'claim' : undefined;
  return kind && { kind, ...(name ? { name } : {}) };
}
