import { describe, expect, it } from 'vitest';
import { workPlanConfirmationRequired, workPlanSchema, type WorkPlan } from './work-items.js';

const step = (id: string, dependsOn: string[] = []) => ({ id, title: id, kind: 'agent' as const, agentId: 'alpha', instruction: '做事', dependsOn });
const plan: WorkPlan = { title: '编排', outputStepId: 'join', steps: [step('a'), step('b'), step('join', ['a', 'b'])] };

describe('workPlanConfirmationRequired', () => {
  it('群聊里的计划默认需要人工确认，单聊与非飞书来源不拦', () => {
    expect(workPlanConfirmationRequired({ source: 'lark', sourceId: 'cli_app:oc_group:group' })).toBe(true);
    expect(workPlanConfirmationRequired({ source: 'lark', sourceId: 'cli_app:oc_chat:p2p' })).toBe(false);
    expect(workPlanConfirmationRequired({ source: 'lark', sourceId: 'cli_app:ou_owner:root_message' })).toBe(false);
    expect(workPlanConfirmationRequired({ source: 'cli' })).toBe(false);
    expect(workPlanConfirmationRequired({})).toBe(false);
  });
});

describe('闸门不得削弱既有计划校验', () => {
  it('仍然拒绝环、不可达步骤，并保留 12 步上限', () => {
    expect(() => workPlanSchema.parse({ ...plan, steps: [step('a', ['join']), step('b'), step('join', ['a', 'b'])] })).toThrow(/acyclic/);
    expect(() => workPlanSchema.parse({ ...plan, steps: [...plan.steps, step('orphan')] })).toThrow(/contribute/);
    const many = Array.from({ length: 12 }, (_value, index) => step(`s${index}`));
    expect(() => workPlanSchema.parse({ title: '太多', outputStepId: 'join', steps: [...many, step('join', many.map(value => value.id))] })).toThrow();
  });
});
