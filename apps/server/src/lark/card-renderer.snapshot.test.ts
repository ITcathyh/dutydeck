import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@dutydeck/shared';
import { renderLarkCardElements, renderLarkTrace } from './card-renderer.js';
import { buildLarkCard } from './service.js';

// 卡片视觉快照：锁住 trace 卡片的完整 JSON 输出，任何渲染改动都会让快照失败。
// traceElapsed 对进行中的工具用 Date.now() 计算耗时，这里用 fake timers 固定当前时间，
// 事件时间戳也全部固定，保证快照可重复。

const t0 = '2026-08-27T00:00:00.000Z';
const t1 = '2026-08-27T00:00:01.000Z';
const t2 = '2026-08-27T00:00:02.000Z';
const config = { traceLimit: 10 };

const event = (sequence: number, type: AgentEvent['type'], timestamp: string, data: Record<string, unknown>): AgentEvent => ({
  id: `e${sequence}`,
  sessionId: 'ses_1',
  sequence,
  type,
  timestamp,
  data
});

const runningEvents: AgentEvent[] = [
  event(1, 'text', t0, { role: 'assistant', text: '正在分析需求，先跑一遍测试。' }),
  event(2, 'tool_call', t1, { id: 'tool-1', name: 'Bash', input: { command: 'pnpm test' }, status: 'running', startedAt: t1 })
];

const completedEvents: AgentEvent[] = [
  event(1, 'thinking', t0, { text: '先跑测试，失败再修。' }),
  event(2, 'tool_call', t1, { id: 'tool-1', name: 'Bash', input: { command: 'pnpm test' }, status: 'running', startedAt: t1 }),
  event(3, 'tool_result', t2, { id: 'tool-1', name: 'Bash', output: '125 passed', status: 'completed', completedAt: t2 }),
  event(4, 'text', t2, { role: 'assistant', text: '全部通过。' })
];

describe('renderLarkCardElements 视觉快照', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-08-27T00:00:02.000Z') });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('running 态：进展文本 + 进行中的工具调用', () => {
    const card = buildLarkCard({
      agentName: 'Dutydeck', state: 'running', taskName: '验证 Dutydeck 测试', taskId: 'task-running', elapsedSeconds: 2,
      elements: renderLarkCardElements(runningEvents, config, false)
    });
    expect(card.header).toMatchObject({
      title: { content: '验证 Dutydeck 测试' },
      subtitle: { content: 'Dutydeck' },
      template: 'blue',
    });
    expect(card.config?.summary?.content).toBe('验证 Dutydeck 测试 · 执行中');
    const bodyJson = JSON.stringify(card.body);
    expect(bodyJson).toContain('正在分析需求，先跑一遍测试。');
    expect(bodyJson).toContain('pnpm test');
    expect(bodyJson).toContain('已用时 2s');
    expect(card.body.elements.some((el: any) => el.element_id === 'task_action_row')).toBe(true);
    expect(card.body.elements.some((el: any) => el.element_id === 'trace_group_0')).toBe(true);
  });

  it('completed 态：思考 + 工具调用/结果 + 终态输出', () => {
    const card = buildLarkCard({
      agentName: 'Dutydeck', state: 'completed', taskName: '验证 Dutydeck 测试', taskId: 'task-completed', elapsedSeconds: 2,
      elements: renderLarkCardElements(completedEvents, config, true)
    });
    expect(card.header).toMatchObject({
      title: { content: '验证 Dutydeck 测试' },
      subtitle: { content: 'Dutydeck' },
      template: 'green',
    });
    expect(card.config?.summary?.content).toBe('验证 Dutydeck 测试 · 已完成');
    const bodyJson = JSON.stringify(card.body);
    expect(bodyJson).toContain('全部通过。');
    expect(bodyJson).toContain('pnpm test');
    expect(bodyJson).toContain('125 passed');
    expect(bodyJson).toContain('用时 2s');
    expect(card.body.elements.some((el: any) => el.element_id === 'final_output')).toBe(true);
    expect(card.body.elements.some((el: any) => el.element_id === 'trace_overview')).toBe(true);
  });

  it('待审批态：高风险操作使用强提醒且不伪造操作按钮', () => {
    const events = [
      event(1, 'text', t0, { role: 'assistant', text: '准备清理构建缓存。' }),
      event(2, 'permission_request', t1, { id: 'permission-1', title: '高危操作：删除构建缓存目录', status: 'pending', options: ['allow_once', 'reject_once'] })
    ];
    const card = buildLarkCard({
      agentName: 'Dutydeck', state: 'running', taskName: '清理构建缓存', taskId: 'task-approval', elapsedSeconds: 2,
      elements: renderLarkCardElements(events, config, false)
    });
    expect(card.header).toMatchObject({
      title: { content: '清理构建缓存' },
      subtitle: { content: 'Dutydeck' },
      template: 'orange',
    });
    expect(card.config?.summary?.content).toBe('清理构建缓存 · 等待审批');
    const bodyJson = JSON.stringify(card.body);
    expect(bodyJson).toContain('等待审批');
    expect(bodyJson).toContain('高危操作：删除构建缓存目录');
    expect(bodyJson).toContain('准备清理构建缓存。');
    expect(card.body.elements.some((el: any) => el.element_id === 'risk_alert_pending_0')).toBe(true);
  });

  it('renderLarkTrace markdown 形态（completed）', () => {
    const markdown = renderLarkTrace(completedEvents, config, true);
    expect(markdown).toContain('**内部分析**');
    expect(markdown).toContain('Agent 已完成内部分析（推理原文不展示）');
    expect(markdown).toContain('**工具 · Bash** · completed');
    expect(markdown).toContain('125 passed');
    expect(markdown).toContain('**Agent**');
    expect(markdown).toContain('全部通过。');
  });

  it('卡片只展示最近五个完整阶段并明确提示省略数量', () => {
    const events = Array.from({ length: 7 }, (_, index) => [
      event(index * 2 + 1, 'text', t0, { role: 'assistant', text: `阶段 ${index + 1}` }),
      event(index * 2 + 2, 'tool_result', t1, { id: `tool-${index + 1}`, name: 'Bash', input: { command: `step-${index + 1}` }, output: 'ok', status: 'completed' })
    ]).flat();

    const elements = renderLarkCardElements(events, { traceLimit: 50 }, false);
    const panels = elements.filter(element => String(element.element_id ?? '').startsWith('trace_group_'));
    const rendered = JSON.stringify(elements);
    expect(panels).toHaveLength(5);
    // 历史阶段就排在当前阶段下面，位置本身说明了它们是历史，不再单起一行讲「此前阶段」。
    // 位置表达不了的只有「还有多少个更早阶段没展示」，那一条 trace_omission 由运行态与
    // 非运行态两种布局共用，卡上只出现一次。
    expect(rendered).toContain('另有 2 个更早阶段未展示');
    expect(rendered).not.toContain('此前阶段');
    for (const state of ['running', 'queued', 'completed'] as const) {
      const card = JSON.stringify(buildLarkCard({ state, elements, taskName: '多阶段任务', taskId: 'task-omission', elapsedSeconds: 9 }));
      expect(card.split('个更早阶段未展示')).toHaveLength(2);
    }
    expect(rendered).not.toContain('阶段 1');
    expect(rendered).not.toContain('阶段 2');
    expect(rendered).toContain('阶段 3');
    expect(rendered).toContain('阶段 7');
  });
});
