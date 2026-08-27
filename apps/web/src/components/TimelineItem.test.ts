import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TimelineItem } from './TimelineItem';
import type { TimelineEvent } from '../timeline';

describe('TimelineItem', () => {
  it('renders a user message with its text', () => {
    const event: TimelineEvent = {
      id: 'user-1',
      sequence: 1,
      type: 'text',
      timestamp: '2026-08-27T00:00:00.000Z',
      data: { role: 'user', text: '你好世界' }
    };
    const html = renderToStaticMarkup(createElement(TimelineItem, { event }));
    expect(html).toContain('你好世界');
  });

  it('renders an error event with the Agent 错误 heading', () => {
    const event: TimelineEvent = {
      id: 'error-1',
      sequence: 2,
      type: 'error',
      timestamp: '2026-08-27T00:00:01.000Z',
      data: { message: '会话执行失败' }
    };
    const html = renderToStaticMarkup(createElement(TimelineItem, { event }));
    expect(html).toContain('Agent 错误');
    expect(html).toContain('会话执行失败');
  });
});
