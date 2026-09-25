import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ActivityPanel } from './ActivityPanel';
import type { TimelineActivityGroup } from '../timeline';

const groups: TimelineActivityGroup[] = [{
  id: 'group-1', label: '执行命令', startedAt: '2026-09-25T00:00:00.000Z', completedAt: '2026-09-25T00:00:05.000Z',
  events: [{ id: 'tool-1', sequence: 1, type: 'tool_call', timestamp: '2026-09-25T00:00:00.000Z', data: { name: 'terminal', status: 'running', input: { command: 'git status' } } }]
}];

describe('ActivityPanel 执行状态', () => {
  it('执行结果未确认的一轮（例如被服务重启切断）标「结果未知」，不标失败', () => {
    const { container } = render(<ActivityPanel groups={groups} ongoing={false} taskStatus="reconcile_required" modelLabel="Codex"/>);
    const summary = container.querySelector('summary')!.textContent;
    expect(summary).toContain('结果未知');
    expect(summary).not.toMatch(/已失败|已完成|未完成/);
    expect(screen.getByRole('status').textContent).toBe('这一轮的执行结果未确认。');
  });
});
