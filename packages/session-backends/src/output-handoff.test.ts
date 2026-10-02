import { describe, expect, it, vi } from 'vitest';
import { OutputHandoff } from './output-handoff.js';
describe('bounded initial output handoff', () => {
  it('delivers subscription-window increments in order once, without replaying them to a later viewer', () => {
    const handoff = new OutputHandoff(), first = vi.fn(), second = vi.fn();
    handoff.data('DURING1'); handoff.data('DURING2'); handoff.onData(first);
    expect(first.mock.calls).toEqual([['DURING1DURING2']]);
    handoff.onData(second); expect(second).not.toHaveBeenCalled();
    handoff.data('AFTER'); expect(second).toHaveBeenCalledWith('AFTER');
  });
  it('bounds 256KiB and emits gap before accepting new-boundary data, without replaying old increments', () => {
    const handoff = new OutputHandoff(), events: string[] = [];
    handoff.data('x'.repeat(256 * 1024)); handoff.data('y'); handoff.data('z');
    expect((handoff as any).pending).toBe(''); expect((handoff as any).bytes).toBe(0);
    handoff.onGap(bytes => { events.push(`gap:${bytes}`); handoff.data('NEW'); });
    handoff.onData(data => events.push(data));
    expect(events).toEqual([`gap:${256 * 1024 + 2}`, 'NEW']);
  });
  it('clears old attachment listeners and increments on detach', () => {
    const handoff = new OutputHandoff(), old = vi.fn(), next = vi.fn();
    handoff.data('OLD'); handoff.reset(); handoff.onData(old); handoff.reset();
    handoff.data('NEW'); handoff.onData(next);
    expect(old).not.toHaveBeenCalled(); expect(next).toHaveBeenCalledExactlyOnceWith('NEW');
  });
});
