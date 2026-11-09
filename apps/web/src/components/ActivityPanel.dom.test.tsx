import { fireEvent, render, screen } from '@testing-library/react';
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
    expect(summary).toContain('工作过程');
    expect(summary).toContain('结果未知');
    expect(summary).not.toMatch(/已失败|已完成|未完成/);
    expect(screen.getByRole('status').textContent).toBe('这一轮的执行结果未确认。');
  });

  it('任务完成后默认收起工作过程，且支持通过属性与用户操作展开', () => {
    const completedGroups: TimelineActivityGroup[] = [
      { id: 'g1', label: '步骤1', startedAt: '2026-09-25T00:00:00.000Z', events: [{ id: 'e1', sequence: 1, type: 'tool_call', timestamp: '', data: { name: 'read' } }] },
      { id: 'g2', label: '步骤2', startedAt: '2026-09-25T00:00:01.000Z', events: [{ id: 'e2', sequence: 2, type: 'tool_call', timestamp: '', data: { name: 'edit' } }] }
    ];
    const { container } = render(<ActivityPanel groups={completedGroups} ongoing={false} hasAnswer={true} taskStatus="completed" modelLabel="Codex"/>);
    const details = container.querySelector('details')!;
    expect(details.open).toBe(false);
    expect(container.textContent).toContain('工作过程');
    expect(container.textContent).toContain('2 个阶段 · 2 次操作');
  });

  it('密度切换时同步展开状态与阶段展示范围，且不影响后续手动操作', () => {
    const multiGroups: TimelineActivityGroup[] = [
      { id: 'g1', label: '阶段1', startedAt: '2026-09-25T00:00:00.000Z', events: [{ id: 'e1', sequence: 1, type: 'tool_call', timestamp: '', data: { name: 'read' } }] },
      { id: 'g2', label: '阶段2', startedAt: '2026-09-25T00:00:01.000Z', events: [{ id: 'e2', sequence: 2, type: 'tool_call', timestamp: '', data: { name: 'edit' } }] },
      { id: 'g3', label: '阶段3', startedAt: '2026-09-25T00:00:02.000Z', events: [{ id: 'e3', sequence: 3, type: 'tool_call', timestamp: '', data: { name: 'test' } }] },
      { id: 'g4', label: '阶段4', startedAt: '2026-09-25T00:00:03.000Z', events: [{ id: 'e4', sequence: 4, type: 'tool_call', timestamp: '', data: { name: 'commit' } }] }
    ];
    const { container, rerender } = render(<ActivityPanel groups={multiGroups} ongoing={false} hasAnswer={true} taskStatus="completed" modelLabel="Codex" density="standard"/>);
    const details = container.querySelector('details')!;
    expect(details.open).toBe(false);

    // 切换到详细：已挂载组件自动展开，并展示全部阶段
    rerender(<ActivityPanel groups={multiGroups} ongoing={false} hasAnswer={true} taskStatus="completed" modelLabel="Codex" density="detail"/>);
    expect(details.open).toBe(true);
    expect(screen.getByText('阶段1')).toBeTruthy();

    // 切换到摘要：自动收起
    rerender(<ActivityPanel groups={multiGroups} ongoing={false} hasAnswer={true} taskStatus="completed" modelLabel="Codex" density="summary"/>);
    expect(details.open).toBe(false);

    // 用户随后手动展开：正常生效
    details.open = true;
    fireEvent(details, new Event('toggle'));
    expect(details.open).toBe(true);
  });
});
