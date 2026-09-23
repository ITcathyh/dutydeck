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

describe('compactTrace 精简过程卡', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-08-27T00:00:09.000Z') });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('运行态：无工具条目与折叠面板，历史阶段为 markdown 行，当前阶段含标题与步骤计数', () => {
    const elements = renderLarkProcessElements(multiStageEvents, compactConfig, false);
    const serialized = JSON.stringify(elements);
    expect(serialized).not.toContain('trace_tool_');
    expect(elements.some(element => element.tag === 'collapsible_panel')).toBe(false);

    const groups = elements.filter(element => String(element.element_id ?? '').startsWith('trace_group_'));
    expect(groups).toHaveLength(3);
    // 前两个是历史阶段，都退化为 markdown 标题行。
    expect(groups[0]).toMatchObject({ tag: 'markdown', element_id: 'trace_group_0' });
    expect(groups[1]).toMatchObject({ tag: 'markdown', element_id: 'trace_group_1' });
    // 失败的历史阶段标题带失败后缀。
    expect(String(groups[1]!.content)).toContain('失败');

    // 当前阶段保持 interactive_container 约定。
    const current = groups[2]!;
    expect(current.tag).toBe('interactive_container');
    expect(current.element_id).toBe('trace_group_2');
    const inner = current.elements as Record<string, unknown>[];
    expect(inner.some(element => element.element_id === 'current_title')).toBe(true);
    const steps = inner.find(element => element.element_id === 'current_steps');
    expect(steps).toBeDefined();
    expect(String(steps!.content)).toContain('已执行 2 个步骤，1 个失败');
    // 当前阶段旁白是标题主体。
    expect(String((inner.find(element => element.element_id === 'current_title')!).content)).toContain('根据失败信息修复');
    // 终端回显不渲染为独立条目，也不计入步骤数。
    expect(serialized).not.toContain('终端输出');
  });

  it('完成态：所有阶段均为 markdown 标题行，无工具条目', () => {
    const elements = renderLarkProcessElements(multiStageEvents, compactConfig, true);
    const groups = elements.filter(element => String(element.element_id ?? '').startsWith('trace_group_'));
    expect(groups.length).toBeGreaterThan(0);
    for (const group of groups) {
      expect(group.tag).toBe('markdown');
    }
    expect(JSON.stringify(elements)).not.toContain('trace_tool_');
    expect(elements.some(element => element.tag === 'collapsible_panel')).toBe(false);
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
