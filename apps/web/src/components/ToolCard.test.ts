import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ToolCard } from './ToolCard';
import type { TimelineEvent } from '../timeline';

const toolEvent = (status: 'completed' | 'running'): TimelineEvent => ({
  id: 'tool-1',
  sequence: 1,
  type: 'tool_call',
  timestamp: '2026-08-27T00:00:00.000Z',
  data: {
    name: 'terminal',
    status,
    input: { command: 'ls -la' },
    startedAt: '2026-08-27T00:00:00.000Z',
    completedAt: status === 'completed' ? '2026-08-27T00:00:01.000Z' : undefined
  }
});

describe('ToolCard', () => {
  it('renders a completed tool call with its action label and 已完成 status', () => {
    const html = renderToStaticMarkup(createElement(ToolCard, { event: toolEvent('completed') }));
    expect(html).toContain('已运行命令');
    expect(html).toContain('ls -la');
    expect(html).toContain('已完成');
  });

  it('renders a running tool call with 执行中 status', () => {
    const html = renderToStaticMarkup(createElement(ToolCard, { event: toolEvent('running') }));
    expect(html).toContain('正在运行命令');
    expect(html).toContain('执行中');
  });
});
