import { describe, expect, it } from 'vitest';
import type { DockEvent } from './api';
import { buildTraceRows, filterTraceRows, groupTraceRows, traceDuration } from './trace-view';

const event = (sequence: number, type: string, data: unknown = {}, extra: Partial<DockEvent> = {}): DockEvent => ({ id: `e${sequence}`, sequence, type, timestamp: `2026-10-28T00:00:${String(sequence).padStart(2, '0')}Z`, data, ...extra });

describe('live trace projection', () => {
  it('keeps canonical sequence order, replaces duplicates and tolerates missing payload/time', () => {
    const rows = buildTraceRows([event(3, 'thinking', null, { timestamp: '' }), event(1, 'status'), event(2, 'text', { text: 'stale' }), event(2, 'text', { text: 'corrected' })]);
    expect(rows.map(row => row.event.sequence)).toEqual([1, 2, 3]);
    expect(rows[1]!.summary).toBe('corrected');
    expect(rows[2]!.at).toBeUndefined();
    expect(buildTraceRows([event(1, 'text', undefined), event(2, 'tool_call', {}), event(3, 'error', { message: 'bad' })]).map(row => row.summary)).toEqual(['text', '工具更新', 'bad']);
  });

  it('summarizes persisted nested task status, with the prompt only when recorded', () => {
    const rows = buildTraceRows([event(1, 'task', { task: { id: 't1', status: 'running', revision: 2 } }), event(2, 'task', { task: { id: 't1', status: 'completed', prompt: '  inspect\n  the workspace  ' } }), event(3, 'task', { task: { id: 't2', status: 'reconcile_required' } })]);
    expect(rows.map(row => row.summary)).toEqual(['running', '已完成 · inspect the workspace', 'reconcile_required']);
    expect(rows.every(row => row.category === 'system' && row.label === '任务状态')).toBe(true);
  });

  it('classifies the status payloads emitted by the runtime and ACP adapter as context', () => {
    const rows = buildTraceRows([event(1, 'status', { state: 'prompt_assembly', stage: 'accepted_input', chars: 120 }), event(2, 'status', { state: 'usage', used: 500, size: 10000 }), event(3, 'status', { state: 'compaction', phase: 'start' }), event(4, 'status', { state: 'idle' })]);
    expect(rows.map(row => row.category)).toEqual(['context', 'context', 'context', 'system']);
    expect(filterTraceRows(rows, 'context', '', false)).toHaveLength(3);
  });

  it('pairs tool IDs inside a task/attempt, preserving concurrent same-name tools', () => {
    const fence = { taskId: 't1', attemptId: 'a1' };
    const rows = buildTraceRows([
      event(1, 'tool_call', { id: 'one', name: 'Read' }, fence),
      event(2, 'tool_call', { id: 'two', name: 'Read' }, fence),
      event(3, 'tool_result', { id: 'one', status: 'completed' }, fence),
      event(4, 'tool_result', { id: 'two', status: 'failed' }, fence),
      event(5, 'tool_result', { id: 'one' }, { taskId: 't1', attemptId: 'a2' }),
      event(6, 'tool_result', { id: 'one' }, { taskId: 't2', attemptId: 'a1' }),
      event(7, 'tool_result', { name: 'Read' }, fence)
    ]);
    expect(rows.map(row => row.duration)).toEqual([undefined, undefined, 2000, 2000, undefined, undefined, undefined]);
    expect(rows[0]!.toolKey).toBe(rows[2]!.toolKey);
    expect(rows[0]!.toolKey).not.toBe(rows[1]!.toolKey);
    expect(rows[4]!.toolKey).not.toBe(rows[0]!.toolKey);
    expect(filterTraceRows(rows, 'error', '', true).map(row => row.event.sequence)).toEqual([4]);
  });

  it('prefers recorded tool boundaries, rejecting reversed or invalid durations and orphan guesses', () => {
    const rows = buildTraceRows([
      event(1, 'tool_result', { id: 'x', startedAt: '2026-10-28T00:00:00Z', completedAt: '2026-10-28T00:00:04Z' }),
      event(2, 'tool_result', { id: 'y', startedAt: '2026-10-28T00:00:04Z', completedAt: '2026-10-28T00:00:00Z' }),
      event(3, 'tool_result', { id: 'z', startedAt: 'invalid' }),
      event(4, 'text', { text: 'model answer' })
    ]);
    expect(rows.map(row => row.duration)).toEqual([4000, undefined, undefined, undefined]);
    expect(traceDuration(undefined)).toBe('—');
    expect(traceDuration(0)).toBe('0 ms');
  });

  it('assigns a compact queued-task promotion to its nested task ID across two user rounds', () => {
    const rows = buildTraceRows([
      event(1, 'text', { role: 'user', taskId: 'first', text: 'first round' }),
      event(2, 'text', { role: 'user', taskId: 'second', text: 'second round' }),
      event(3, 'task', { task: { id: 'queued', status: 'queued' }, queueAction: { sessionId: 's1', runId: 'r1', operationId: 'promote-queued', source: 'promote', taskId: 'queued', actor: { kind: 'unspecified' }, interrupt: false, revision: 1, state: 'applied' } }),
      event(4, 'task', { task: { id: 'first', status: 'completed' } }, { taskId: 'recorded' }),
      event(5, 'task', { taskId: 'legacy', task: { id: 'first', status: 'completed' } })
    ]);
    expect(rows.map(row => row.turn)).toEqual(['task:first', 'task:second', 'task:queued', 'task:recorded', 'task:legacy']);
    expect(groupTraceRows(rows, true).find(group => group.id === 'task:queued')?.rows.map(row => row.event.sequence)).toEqual([3]);
  });

  it('groups by explicit identity and preserves steering and late events in their recorded round', () => {
    const rows = buildTraceRows([
      event(1, 'status'),
      event(2, 'text', { role: 'user', text: 'first', taskId: 'a' }),
      event(3, 'text', { role: 'user', text: 'steer', steering: { target: { taskId: 'a' } } }),
      event(4, 'text', { role: 'user', text: 'second', taskId: 'b' }),
      event(5, 'tool_result', { id: 'late' }, { taskId: 'a' }),
      event(6, 'completed'),
      event(7, 'status'),
      event(8, 'text', { role: 'user', text: 'legacy' })
    ]);
    expect(rows.map(row => row.turn)).toEqual(['unassigned', 'task:a', 'task:a', 'task:b', 'task:a', 'task:b', 'unassigned', 'input:8']);
    expect(groupTraceRows(filterTraceRows(rows, 'all', '', true), true).map(group => group.id)).toEqual(['input:8', 'unassigned', 'task:b', 'task:a']);
    expect(filterTraceRows(rows, 'user', 'SECOND', false).map(row => row.event.sequence)).toEqual([4]);
    expect(filterTraceRows(rows, 'tool', 'late', false).map(row => row.event.sequence)).toEqual([5]);
  });
});
