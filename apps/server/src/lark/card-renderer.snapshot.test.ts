import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@dockmux/shared';
import { renderLarkCardElements, renderLarkTrace } from './card-renderer.js';

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
    expect(renderLarkCardElements(runningEvents, config, false)).toMatchSnapshot();
  });

  it('completed 态：思考 + 工具调用/结果 + 终态输出', () => {
    expect(renderLarkCardElements(completedEvents, config, true)).toMatchSnapshot();
  });

  it('renderLarkTrace markdown 形态（completed）', () => {
    expect(renderLarkTrace(completedEvents, config, true)).toMatchSnapshot();
  });
});
