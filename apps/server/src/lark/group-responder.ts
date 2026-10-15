// 群里的接话人。本模块是纯函数，状态、发卡和派发在 group-participation.ts。
//
// 接话人在多个 Bot 实例之间靠群消息同步：各实例存储不共享，但群消息大家都收得到。某个 Bot 成为接话人
// （群里确认卡确认，或在 Web 上设成本 Bot）后在群里发一条声明；其他实例收到别的 Bot 发的声明，就把接话人记成它，
// 自己让出。没指定接话人时，多机器人群里没 @ 的消息谁都不接（见 participation-rules 的 no_responder）。

import { stripMentionPlaceholders } from './participation-rules.js';

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
