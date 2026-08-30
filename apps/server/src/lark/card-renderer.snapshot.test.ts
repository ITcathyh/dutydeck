import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@dockmux/shared';
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
    expect(buildLarkCard({
      agentName: 'Dockmux', state: 'running', taskName: '验证 Dockmux 测试', taskId: 'task-running', elapsedSeconds: 2,
      elements: renderLarkCardElements(runningEvents, config, false)
    })).toMatchSnapshot();
  });

  it('completed 态：思考 + 工具调用/结果 + 终态输出', () => {
    expect(buildLarkCard({
      agentName: 'Dockmux', state: 'completed', taskName: '验证 Dockmux 测试', taskId: 'task-completed', elapsedSeconds: 2,
      elements: renderLarkCardElements(completedEvents, config, true)
    })).toMatchSnapshot();
  });

  it('待审批态：高风险操作使用强提醒且不伪造操作按钮', () => {
    const events = [
      event(1, 'text', t0, { role: 'assistant', text: '准备清理构建缓存。' }),
      event(2, 'permission_request', t1, { id: 'permission-1', title: '高危操作：删除构建缓存目录', status: 'pending', options: ['allow_once', 'reject_once'] })
    ];
    expect(buildLarkCard({
      agentName: 'Dockmux', state: 'running', taskName: '清理构建缓存', taskId: 'task-approval', elapsedSeconds: 2,
      elements: renderLarkCardElements(events, config, false)
    })).toMatchSnapshot();
  });

  it('renderLarkTrace markdown 形态（completed）', () => {
    expect(renderLarkTrace(completedEvents, config, true)).toMatchSnapshot();
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
    expect(rendered).toContain('7 个阶段');
    expect(rendered).toContain('仅展示最近 5 个阶段，另有 2 个阶段');
    expect(rendered).not.toContain('阶段 1');
    expect(rendered).not.toContain('阶段 2');
    expect(rendered).toContain('阶段 3');
    expect(rendered).toContain('阶段 7');
  });
});
