import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@dutydeck/shared';
import { renderLarkCardElements, renderLarkProcessElements, renderLarkRecordExport } from './card-renderer.js';
import { buildLarkCard } from './service.js';

// 精简过程卡（compactTrace）：历史阶段与当前阶段都退化为标题行，
// 不输出任何 trace_tool_* 元素或 collapsible_panel；完整记录导出不受影响。
// traceElapsed 对进行中的工具用 Date.now()，用 fake timers 固定时间保证可重复。

const t0 = '2026-08-27T00:00:00.000Z';
const t1 = '2026-08-27T00:00:01.000Z';
const t2 = '2026-08-27T00:00:02.000Z';
const t3 = '2026-08-27T00:00:03.000Z';
const t4 = '2026-08-27T00:00:04.000Z';
const t5 = '2026-08-27T00:00:05.000Z';
const t6 = '2026-08-27T00:00:06.000Z';
const t7 = '2026-08-27T00:00:07.000Z';
const t8 = '2026-08-27T00:00:08.000Z';

const event = (sequence: number, type: AgentEvent['type'], timestamp: string, data: Record<string, unknown>): AgentEvent => ({
  id: `e${sequence}`,
  sessionId: 'ses_1',
  sequence,
  type,
  timestamp,
  data
});

// 三个阶段：两个历史阶段（第二个含失败工具），当前阶段含一个成功工具、一个失败工具与一段终端回显。
const multiStageEvents: AgentEvent[] = [
  event(1, 'text', t0, { role: 'assistant', text: '先看配置文件。' }),
  event(2, 'tool_call', t1, { id: 'tool-read', name: 'Read', input: { path: '/repo/package.json' }, status: 'running', startedAt: t1 }),
  event(3, 'tool_result', t2, { id: 'tool-read', name: 'Read', output: 'package json', status: 'completed', completedAt: t2 }),
  event(4, 'text', t3, { role: 'assistant', text: '跑测试看是否通过。' }),
  event(5, 'tool_call', t4, { id: 'tool-test', name: 'Bash', input: { command: 'pnpm vitest run' }, status: 'running', startedAt: t4 }),
  event(6, 'tool_result', t5, { id: 'tool-test', name: 'Bash', output: '1 failed', status: 'failed', completedAt: t5 }),
  event(7, 'raw_terminal', t5, { text: 'FAIL src/broken.test.ts\n' }),
  event(8, 'text', t6, { role: 'assistant', text: '根据失败信息修复。' }),
  event(9, 'tool_result', t7, { id: 'tool-edit', name: 'Edit', input: { path: '/repo/src/broken.ts' }, output: 'applied', status: 'completed', startedAt: t6, completedAt: t7 }),
  event(10, 'tool_result', t8, { id: 'tool-retry', name: 'Bash', input: { command: 'pnpm vitest run' }, output: 'still failing', status: 'failed', startedAt: t7, completedAt: t8 })
];

const compactConfig = { traceLimit: 10, compactTrace: true } as const;

const components = (value: any): any[] => {
  if (Array.isArray(value)) return value.flatMap(components);
  if (!value || typeof value !== 'object') return [];
  return [...(typeof value.tag === 'string' ? [value] : []), ...Object.values(value).flatMap(components)];
};

describe('compactTrace 精简过程卡', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-08-27T00:00:09.000Z') });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('运行态：无工具条目与折叠面板，历史阶段一行一段，当前阶段写旁白、此刻这一步和按类型的步骤计数', () => {
    const elements = renderLarkProcessElements(multiStageEvents, compactConfig, false);
    const serialized = JSON.stringify(elements);
    expect(serialized).not.toContain('trace_tool_');
    expect(elements.some(element => element.tag === 'collapsible_panel')).toBe(false);

    const groups = elements.filter(element => String(element.element_id ?? '').startsWith('trace_group_'));
    expect(groups).toHaveLength(3);
    // 前两个是历史阶段：一行，左边图标说明结束与否、是否整段失败；不足 3 秒的阶段不写耗时。
    const [done, failed] = groups as any[];
    expect(done).toMatchObject({ tag: 'column_set', element_id: 'trace_group_0' });
    expect(done.columns).toHaveLength(1);
    expect(done.columns[0].elements[0]).toMatchObject({ content: '先看配置文件。', icon: { token: 'done_outlined', color: 'grey' } });
    expect(failed).toMatchObject({ tag: 'column_set', element_id: 'trace_group_1' });
    expect(failed.columns[0].elements[0].icon).toMatchObject({ token: 'close_outlined', color: 'red' });

    // 当前阶段保持 interactive_container 约定，不再套底色。
    const current = groups[2]!;
    expect(current).toMatchObject({ tag: 'interactive_container', element_id: 'trace_group_2' });
    expect(current.background_style).toBeUndefined();
    const title = components(current).find(element => element.element_id === 'current_title');
    expect(title.content).toBe('**根据失败信息修复。**');
    expect(components(current).find(element => element.element_id === 'current_elapsed').content).toBe("<font color='grey'>3s</font>");
    // 有旁白时另起一行写最新一步；它失败了就直接标红。
    expect(components(current).find(element => element.element_id === 'current_now').content)
      .toBe("<font color='red'>失败：pnpm vitest run</font>");
    const steps = components(current).find(element => element.element_id === 'current_steps').content as string;
    const counted = [...steps.matchAll(/<text_tag color='neutral'>[^<]+ (\d+)<\/text_tag>/g)].reduce((sum, match) => sum + Number(match[1]), 0);
    expect(counted).toBe(2);
    expect(steps).toContain("<text_tag color='red'>失败 1</text_tag>");
    // 终端回显不渲染为独立条目，也不计入步骤数。
    expect(serialized).not.toContain('终端输出');
  });

  it('运行态没有旁白时：标题跟着最新一步走，不再另起「正在」一行', () => {
    const events: AgentEvent[] = [
      event(1, 'tool_result', t1, { id: 'a', name: 'Read', input: { path: '/repo/package.json' }, output: 'ok', status: 'completed', startedAt: t0, completedAt: t1 }),
      event(2, 'tool_call', t2, { id: 'b', name: 'Bash', input: { command: 'pnpm build' }, status: 'running', startedAt: t2 })
    ];
    const elements = renderLarkProcessElements(events, compactConfig, false);
    expect(components(elements).find(element => element.element_id === 'current_title').content).toBe('**pnpm build**');
    expect(components(elements).some(element => element.element_id === 'current_now')).toBe(false);

    const card: any = buildLarkCard({ cardKind: 'process', state: 'running', taskName: '构建', elapsedSeconds: 9, elements });
    expect(card.config.summary.content).toBe('执行中 · pnpm build');
  });

  it('完成态：每个阶段一行并带耗时，无工具条目', () => {
    const elements = renderLarkProcessElements(multiStageEvents, compactConfig, true);
    const groups = elements.filter(element => String(element.element_id ?? '').startsWith('trace_group_'));
    expect(groups.length).toBeGreaterThan(0);
    for (const group of groups) expect(group.tag).toBe('column_set');
    expect(JSON.stringify(elements)).not.toContain('trace_tool_');
    expect(elements.some(element => element.tag === 'collapsible_panel')).toBe(false);

    // 展开回执后要能看出每段花了多久：耗时单独一列靠右。
    const slow = renderLarkProcessElements([
      event(1, 'text', t0, { role: 'assistant', text: '跑一遍构建。' }),
      event(2, 'tool_result', t5, { id: 'b', name: 'Bash', input: { command: 'pnpm build' }, output: 'ok', status: 'completed', startedAt: t0, completedAt: t5 })
    ], compactConfig, true);
    const stage = slow.find(element => element.element_id === 'trace_group_0') as any;
    expect(stage.columns[1]).toMatchObject({ width: 'auto', elements: [{ content: "<font color='grey'>5s</font>" }] });
  });

  it('经 buildLarkCard 组装后的过程卡不含 trace_tool_ 且不超过飞书 24KB 限制', () => {
    const elements = renderLarkProcessElements(multiStageEvents, compactConfig, false);
    const card = buildLarkCard({
      cardKind: 'process', state: 'running', agentName: 'Dutydeck', taskName: '精简过程卡任务',
      taskId: 'task-compact', elapsedSeconds: 9, elements
    });
    const json = JSON.stringify(card);
    expect(json).not.toContain('trace_tool_');
    expect(Buffer.byteLength(json, 'utf8')).toBeLessThanOrEqual(24 * 1024);
  });

  it('compactTrace 缺省与显式 false 渲染逐字节一致，显式 true 与两者不同', () => {
    const fullDefault = renderLarkProcessElements(multiStageEvents, { traceLimit: 10 }, false);
    const explicitFalse = renderLarkProcessElements(multiStageEvents, { traceLimit: 10, compactTrace: false }, false);
    const compact = renderLarkProcessElements(multiStageEvents, { traceLimit: 10, compactTrace: true }, false);
    expect(fullDefault).toEqual(explicitFalse);
    expect(compact).not.toEqual(fullDefault);
  });

  it('导出执行记录仍保留工具的输入与输出', () => {
    const markdown = renderLarkRecordExport(multiStageEvents);
    expect(markdown).toContain('pnpm vitest run');
    expect(markdown).toContain('still failing');
    expect(markdown).toContain('/repo/src/broken.ts');
  });
});
