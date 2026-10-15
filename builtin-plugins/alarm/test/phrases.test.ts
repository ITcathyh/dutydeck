// 告警包的开关说法（phrases）和一句话说明（status.summary），经核心的正则执行器和模板渲染运行，和升级前的 alarmIntentOf、describeAlarm 逐条对照。
import { describe, expect, it } from 'vitest';
import { LarkScenarios } from '../../../apps/server/src/lark/group-scenarios.js';
import { scenarioSummary } from '../../../apps/server/src/lark/scenario-template.js';
import { builtinScenarioRegistry } from '../../../apps/server/src/plugins/builtin-scenarios.test-helpers.js';

const bot = { appId: 'cli_test' };
/** 核心的识别结果换成升级前的说法：开启带级别，关闭不带。 */
const intentOf = async (text: string) => {
  const phrase = await new LarkScenarios(await builtinScenarioRegistry()).phrase(bot, text);
  if (!phrase) return undefined;
  expect(phrase.entry.pack.id).toBe('alarm');
  return phrase.kind === 'disable' ? { kind: 'unsubscribe' } : { kind: 'subscribe', levels: phrase.captures.levels };
};

describe('告警订阅的说法', () => {
  it.each([
    ['以后告警先帮我初筛', { kind: 'subscribe', levels: [] }],
    ['订阅告警初筛，只看 P0 和 p1', { kind: 'subscribe', levels: ['P0', 'P1'] }],
    ['告警你帮忙看看', { kind: 'subscribe', levels: [] }],
    ['告警别再分析了', { kind: 'unsubscribe' }],
    ['关闭告警初筛', { kind: 'unsubscribe' }]
  ] as const)('「%s」', async (text, intent) => {
    expect(await intentOf(`@_user_1 ${text}`)).toEqual(intent);
  });

  it('不相干或太长的消息不算', async () => {
    expect(await intentOf('@_user_1 这个告警是什么意思')).toBeUndefined();
    expect(await intentOf(`@_user_1 以后告警先帮我初筛${'，另外'.repeat(20)}`)).toBeUndefined();
  });

  it('说明里有来源、级别、去重窗口和上限', async () => {
    const pack = (await builtinScenarioRegistry()).get('alarm')!.pack;
    expect(scenarioSummary(pack, { sources: [{ appId: 'cli_alarm', name: '监控' }], levels: ['P0'], dedupeHours: 6, maxPerHour: 3 }))
      .toBe('来源 监控（cli_alarm）；级别只看 P0；同一条告警 6 小时内只分析一次，每小时最多 3 条');
  });
});
