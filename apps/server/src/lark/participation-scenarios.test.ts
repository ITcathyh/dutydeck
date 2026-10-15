import { describe, expect, it } from 'vitest';
import { collaborationSnapshotSchema } from '@dutydeck/shared';
import { evaluateParticipationRules, ruleContextOf } from './participation-rules.js';
import { decisionInput } from './readonly-decider.js';
import { participationScenarios, scenarioCategories, scenarioFacts, scenarioLevel, scenarioOwned, scenarioSnapshot, type ParticipationScenario } from './participation-scenarios.test-helpers.js';

/** 按实时顺序跑两轮规则：第一轮不带最近发言，第二轮补上。 */
function runRules(scenario: ParticipationScenario) {
  const { trigger } = scenarioSnapshot(scenario);
  const { group } = scenario;
  const round = (n: 1 | 2) => evaluateParticipationRules(ruleContextOf(trigger, scenarioOwned(scenario), [group.botName], scenarioFacts(scenario, n), group.roleScope));
  return { first: round(1), second: round(2) };
}

const ruleCases = participationScenarios.filter(item => item.expected.layer === 'rule');
const modelCases = participationScenarios.filter(item => item.expected.layer === 'model');

describe('判定回归用例：数据', () => {
  it('id 唯一，每类场景都有用例，规则层和模型层都有', () => {
    expect(new Set(participationScenarios.map(item => item.id)).size).toBe(participationScenarios.length);
    for (const category of scenarioCategories) expect(participationScenarios.some(item => item.category === category), category).toBe(true);
    expect(ruleCases.length).toBeGreaterThan(0);
    expect(modelCases.length).toBeGreaterThan(0);
  });

  it('事实和实时一致：别人的话题、叫别的机器人只在多机器人群里查；最近发言只在第二轮用', () => {
    for (const scenario of participationScenarios) {
      const bots = (scenario.group.members?.bots ?? 0) - (scenario.group.alarmSources ?? 0);
      if (scenario.message.threadRootOther || scenario.message.callsOther) expect(bots, scenario.id).toBeGreaterThan(1);
      expect(scenarioFacts(scenario, 1).lastSelfAgoMs, scenario.id).toBeUndefined();
      // 走到规则层的只有群参与按需或积极的群。
      expect(['selective', 'eager'], scenario.id).toContain(scenarioLevel(scenario));
    }
  });
});

describe('判定回归用例：规则层（锁住当前行为）', () => {
  it.each(ruleCases.map(item => [item.id, item] as const))('%s', (_id, scenario) => {
    const expected = scenario.expected;
    if (expected.layer !== 'rule') throw new Error('not a rule case');
    const { first, second } = runRules(scenario);
    const verdict = { action: expected.action, rule: expected.rule };
    if (expected.round === 1) {
      expect(first).toMatchObject(verdict);
    } else {
      expect(first).toBeUndefined();
      expect(second).toMatchObject(verdict);
    }
  });
});

describe('判定回归用例：模型层（越过两轮规则，能组装成判定快照）', () => {
  it.each(modelCases.map(item => [item.id, item] as const))('%s', (_id, scenario) => {
    const expected = scenario.expected;
    if (expected.layer !== 'model') throw new Error('not a model case');
    expect(expected.why.length).toBeGreaterThan(0);
    expect(expected.acceptable ?? []).not.toContain(expected.action);
    const { first, second } = runRules(scenario);
    expect(first).toBeUndefined();
    expect(second).toBeUndefined();
    const { snapshot, trigger } = scenarioSnapshot(scenario);
    expect(() => collaborationSnapshotSchema.parse(snapshot)).not.toThrow();
    expect(decisionInput(snapshot, trigger.id).observations.at(-1)).toMatchObject({ id: trigger.id, senderKind: 'human' });
  });
});
