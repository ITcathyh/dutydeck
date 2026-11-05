import { describe, expect, it } from 'vitest';
import { analyzeWorkPlanRevision, workPlanConfirmationRequired, workPlanSchema, workRevisionConfirmationReasons, type WorkPlan, type WorkStep } from './work-items.js';

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

describe('计划修订影响分析', () => {
  // a → b → join，c → join。
  const base: WorkPlan = { title: '链路', outputStepId: 'join', steps: [step('a'), step('b', ['a']), step('c'), step('join', ['b', 'c'])] };
  const states = (statuses: Record<string, WorkStep['status']>) => ({ plan: base, steps: base.steps.map(value => ({ id: value.id, status: statuses[value.id] ?? 'pending' })) });
  const edit = (id: string, patch: Partial<WorkPlan['steps'][number]>) => ({ ...base, steps: base.steps.map(value => value.id === id ? { ...value, ...patch } : value) });

  it('改指令影响自身与全部下游，旁路保留', () => {
    const impact = analyzeWorkPlanRevision(states({ a: 'completed', b: 'running', c: 'completed' }), edit('a', { instruction: '换个做法' }));
    expect(impact).toEqual({ keep: ['c'], rerun: ['a', 'b', 'join'], stop: ['b'], discard: ['a'], remove: [], add: [] });
  });
  it.each([
    ['Agent', { agentId: 'beta' }], ['依赖', { dependsOn: [] as string[] }], ['工作区', { workspaceMode: 'worktree' as const }], ['Skill', { skills: ['lint'] }], ['标题', { title: '新标题' }]
  ])('改%s同样算内容变化', (_label, patch) => {
    const next = patch.dependsOn ? { ...base, steps: base.steps.map(value => value.id === 'b' ? { ...value, ...patch } : value.id === 'join' ? { ...value, dependsOn: ['a', 'b', 'c'] } : value) } : edit('b', patch);
    expect(analyzeWorkPlanRevision(states({}), next).rerun).toContain('b');
    expect(analyzeWorkPlanRevision(states({}), next).keep).toContain('c');
  });
  it('缺省字段与显式默认值、键顺序不同不算变化', () => {
    const same = { ...base, steps: base.steps.map(value => value.id === 'c' ? { workspaceMode: 'shared' as const, skills: [], ...value } : value) };
    same.steps[3] = { ...same.steps[3]!, instruction: '汇总得更细' };
    expect(analyzeWorkPlanRevision(states({ c: 'completed' }), same)).toMatchObject({ keep: ['a', 'b', 'c'], rerun: ['join'] });
  });
  it('删除步骤会让改了依赖的下游重跑，运行中的被删步骤要先停止', () => {
    const next: WorkPlan = { ...base, steps: [step('a'), step('c'), step('join', ['a', 'c'])] };
    expect(analyzeWorkPlanRevision(states({ a: 'completed', b: 'running', c: 'completed' }), next)).toEqual({ keep: ['a', 'c'], rerun: ['join'], stop: ['b'], discard: [], remove: ['b'], add: [] });
  });
  it('新增步骤只影响新增者及其下游', () => {
    const next: WorkPlan = { ...base, steps: [...base.steps.slice(0, 3), step('extra', ['c']), step('join', ['b', 'c', 'extra'])] };
    expect(analyzeWorkPlanRevision(states({ a: 'completed', b: 'completed', c: 'completed' }), next)).toEqual({ keep: ['a', 'b', 'c'], rerun: ['join'], stop: [], discard: [], remove: [], add: ['extra'] });
  });
  it('下游传播跨越多层，并只把运行中的受影响步骤列入停止', () => {
    const deep: WorkPlan = { title: '深链', outputStepId: 'd', steps: [step('a'), step('b', ['a']), step('c', ['b']), step('d', ['c'])] };
    const impact = analyzeWorkPlanRevision({ plan: deep, steps: [{ id: 'a', status: 'completed' }, { id: 'b', status: 'completed' }, { id: 'c', status: 'running' }, { id: 'd', status: 'pending' }] },
      { ...deep, steps: deep.steps.map(value => value.id === 'b' ? { ...value, instruction: '改' } : value) });
    expect(impact).toEqual({ keep: ['a'], rerun: ['b', 'c', 'd'], stop: ['c'], discard: ['b'], remove: [], add: [] });
  });
});

describe('Agent 修订的确认边界', () => {
  const wait = { id: 'ask', title: '问', kind: 'wait' as const, instruction: '选哪个', dependsOn: [] };
  const base: WorkPlan = { title: '编排', outputStepId: 'join', steps: [step('a'), step('b'), wait, { ...step('join', ['a', 'b', 'ask']), skills: ['lint', 'test'] }] };
  const current = (statuses: Record<string, WorkStep['status']> = {}, plan = base) => ({ plan, steps: plan.steps.map(value => ({ id: value.id, status: statuses[value.id] ?? 'pending' })) });
  it('收窄不需要确认：改指令、删 Agent 步骤、加依赖、减 Skill', () => {
    const next: WorkPlan = { ...base, steps: [{ ...step('a'), instruction: '更具体' }, wait, { ...step('join', ['a', 'ask']), skills: ['lint'] }] };
    expect(workRevisionConfirmationReasons(current({ a: 'completed', b: 'running' }), next)).toEqual([]);
    expect(workRevisionConfirmationReasons(current(), { ...base, steps: [step('a'), { ...step('b'), dependsOn: ['a'] }, wait, base.steps[3]!] })).toEqual([]);
  });
  it('扩大范围需要确认', () => {
    const reasons = workRevisionConfirmationReasons(current(), { ...base, steps: [
      { ...step('a'), agentId: 'beta' }, { ...step('b'), skills: ['deploy'] }, { ...step('new'), agentId: 'gamma' },
      { ...step('join', ['a', 'b', 'new']), skills: ['lint', 'test'], workspaceMode: 'worktree' }
    ] });
    expect(reasons).toEqual(['步骤 a 更换执行者', '步骤 b 新增 Skill', '新增步骤 new（新 Agent gamma）', '步骤 join 改变工作区模式', '删除人工等待 ask']);
  });
  it('删除带审查策略的步骤、更换最终输出步骤需要确认', () => {
    const reviewed: WorkPlan = { title: '审查', outputStepId: 'review', steps: [step('a'), step('b'), { ...step('review', ['a', 'b']), reviewPolicy: { maxReworkRounds: 1, allowedTargetStepIds: ['b'] } }] };
    const next: WorkPlan = { ...reviewed, outputStepId: 'join', steps: [step('a'), step('b'), step('join', ['a', 'b'])] };
    expect(workRevisionConfirmationReasons(current({}, reviewed), next)).toEqual(['新增步骤 join', '删除带审查策略的步骤 review', '最终输出步骤由 review 改为 join']);
    // 只换最终输出步骤、步骤本身不变，同样要确认。
    const plain: WorkPlan = { title: '输出', outputStepId: 'join', steps: [step('a'), step('join', ['a'])] };
    expect(workRevisionConfirmationReasons(current({}, plain), { ...plain, steps: [step('a'), step('join', ['a']), step('alt', ['a'])], outputStepId: 'alt' }))
      .toEqual(['新增步骤 alt', '最终输出步骤由 join 改为 alt']);
  });
  it('让已失败步骤重跑需要确认：直接改它或改它的上游都算，没受影响的失败步骤不算', () => {
    const next: WorkPlan = { ...base, steps: base.steps.map(value => value.id === 'a' ? { ...value, instruction: '换个做法' } : value) };
    expect(workRevisionConfirmationReasons(current({ a: 'failed' }), next)).toEqual(['重跑已失败的步骤 a']);
    expect(workRevisionConfirmationReasons(current({ join: 'failed' }), next)).toEqual(['重跑已失败的步骤 join']);
    expect(workRevisionConfirmationReasons(current({ b: 'failed' }), next)).toEqual([]);
  });
});
