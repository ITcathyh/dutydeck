// 档位说明表与规则层的契约：欢迎卡和执行 Agent 的说明教用户说的话，规则层都要认得出来。
import { describe, expect, it } from 'vitest';
import { participationLevelLabels, participationLevelPhraseHint, participationLevelPhrases, participationLevels, type ParticipationLevel } from '@dutydeck/shared';
import { buildWelcomeCardContent } from './welcome.js';
import { participationIntentOf } from './participation-rules.js';
import { responderIntentOf } from './group-responder.js';

/** 卡片里「说「…」」教用户说的短语。 */
const taughtPhrases = (text: string) => [...text.matchAll(/说((?:「[^」]+」(?:或)?)+)/g)].flatMap(match => [...match[1]!.matchAll(/「([^」]+)」/g)].map(item => item[1]!));
/** 规则层按什么认这句话：改档、指定接话人。 */
const recognized = (phrase: string) => participationIntentOf(`@_user_1 ${phrase}`) ?? (responderIntentOf(`@_user_1 ${phrase}`) ? { kind: 'responder' } : undefined);

describe('档位说明表', () => {
  it.each(participationLevels)('「%s」档的改档短语能被规则层认成同一档', level => {
    expect(participationIntentOf(`@_user_1 ${participationLevelPhrases[level]}`)).toEqual({ kind: 'level', level });
  });

  it('改档提示按积极、按需、话题内免 @、只在 @ 时的顺序列出全部短语', () => {
    expect(participationLevelPhraseHint).toBe('「积极点」「按需」「话题里不用@」或「只在@时回」');
  });
});

describe('欢迎卡教用户说的话', () => {
  const routings: Array<[string, Parameters<typeof buildWelcomeCardContent>[0]['routing']]> = [
    ['只在 @ 时', { mentionPolicy: 'always' }],
    ['话题内免 @', { mentionPolicy: 'topic' }],
    ['按需、没负责范围', { mentionPolicy: 'topic', participation: 'selective' }],
    ['积极、有负责范围', { mentionPolicy: 'topic', participation: 'eager', roleScope: '发布和告警' }],
    ['旧配置缺唤醒方式', {}]
  ];
  it.each(routings)('%s：每句短语都能被规则层识别', (_name, routing) => {
    const card = buildWelcomeCardContent({ chatType: 'group', routing });
    const phrases = taughtPhrases(card.markdown);
    expect(phrases).toEqual(expect.arrayContaining(Object.values(participationLevelPhrases)));
    for (const phrase of phrases) expect({ phrase, intent: recognized(phrase) }).toEqual({ phrase, intent: expect.anything() });
  });

  it('多机器人群没指定接话人时教的「你负责接话」认得出来', () => {
    const card = buildWelcomeCardContent({ chatType: 'group', routing: { mentionPolicy: 'topic', participation: 'selective' } });
    expect(taughtPhrases(card.markdown)).toContain('你负责接话');
    expect(responderIntentOf('@_user_1 你负责接话')).toEqual({ name: '' });
  });

  it.each<[string, Parameters<typeof buildWelcomeCardContent>[0]['routing'], ParticipationLevel]>([
    ['只在 @ 时', { mentionPolicy: 'always' }, 'mention'],
    ['话题内免 @', { mentionPolicy: 'topic' }, 'topic'],
    ['按需', { mentionPolicy: 'topic', participation: 'selective' }, 'selective'],
    ['积极', { mentionPolicy: 'topic', participation: 'eager' }, 'eager'],
    ['旧配置缺唤醒方式，按只在 @ 时', {}, 'mention']
  ])('%s：卡上的档位名称取自表', (_name, routing, level) => {
    expect(buildWelcomeCardContent({ chatType: 'group', routing }).markdown).toContain(`本群参与强度：**${participationLevelLabels[level]}**`);
  });
});
