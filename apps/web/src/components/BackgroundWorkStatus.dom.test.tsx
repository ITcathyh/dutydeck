import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { DockEvent } from '../api';
import { BackgroundWorkStatus } from './BackgroundWorkStatus';

const status = (data: Record<string, unknown>, sequence = 1): DockEvent => ({ id: `e${sequence}`, sequence, timestamp: '', type: 'status', data: { state: 'background_work', ...data } });
afterEach(cleanup);

describe('BackgroundWorkStatus', () => {
  it('shows a completed main round separately from native background tasks', () => {
    render(<BackgroundWorkStatus events={[status({ count: 2, mainTurnEnded: true, tasks: [
      { id: 'agent-one', toolUseId: 'tool-one', kind: 'agent', state: 'running', originInputId: 'old-input' },
      { id: 'monitor-one', toolUseId: 'tool-two', kind: 'monitor', state: 'running', expiresAt: 123 }
    ] })]}/>);
    expect(screen.getByRole('status').textContent).toContain('主回合已结束 · 后台子任务运行中（2）');
    expect(screen.getByText(/Agent · 运行中/)).toBeTruthy();
    expect(screen.getByText(/监控 · 运行中/)).toBeTruthy();
  });

  it('retains legacy background-count display without claiming the main round ended', () => {
    render(<BackgroundWorkStatus events={[status({ count: 1 })]}/>);
    expect(screen.getByRole('status').textContent).toBe('后台子任务运行中（1）');
  });

  it('uses the newest lifecycle snapshot and clears the display once no tasks remain', () => {
    const { rerender } = render(<BackgroundWorkStatus events={[status({ count: 1, mainTurnEnded: true })]}/>);
    rerender(<BackgroundWorkStatus events={[status({ count: 1, mainTurnEnded: true }), status({ count: 0, mainTurnEnded: true, tasks: [{ id: 'agent-one', kind: 'agent', state: 'completed' }] }, 2)]}/>);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('does not label a later business input as finished using an older snapshot', () => {
    const user: DockEvent = { id: 'input', sequence: 2, timestamp: '', type: 'text', data: { role: 'user', text: 'next task' } };
    render(<BackgroundWorkStatus events={[status({ count: 1, mainTurnEnded: true }), user]}/>);
    expect(screen.getByRole('status').textContent).toBe('后台子任务运行中（1）');
  });
});
