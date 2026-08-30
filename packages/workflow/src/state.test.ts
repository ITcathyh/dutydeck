import { describe, expect, it } from 'vitest';
import { formatAttemptId, materialize, nextAttemptId } from './state.js';
import type { StoredEvent, WorkflowEvent } from './types.js';

let clock = 0;
const ev = (event: WorkflowEvent): StoredEvent => ({ ts: ++clock, ...event });
const fold = (events: WorkflowEvent[]) => materialize('r', events.map(ev));

describe('materialize — 状态转移', () => {
  it('空 journal → 所有节点视为 pending，run 在跑', () => {
    const snap = fold([]);
    expect(snap.runStatus).toBe('running');
    expect(snap.nodes.size).toBe(0);
  });

  it('dispatched → running，并累加 attempts', () => {
    const snap = fold([
      { type: 'runStarted', runId: 'r' },
      { type: 'nodeDispatched', nodeId: 'a', attemptId: 'a/attempts/001' },
    ]);
    expect(snap.nodes.get('a')).toMatchObject({ status: 'running', attempts: 1 });
  });

  it('succeeded → done，并记下 outputs 供下游取用', () => {
    const snap = fold([
      { type: 'nodeDispatched', nodeId: 'a', attemptId: 'a/attempts/001' },
      { type: 'nodeSucceeded', nodeId: 'a', attemptId: 'a/attempts/001', outputs: { report: 'x.md' } },
    ]);
    expect(snap.nodes.get('a')!.status).toBe('done');
    expect(snap.nodes.get('a')!.outputs).toEqual({ report: 'x.md' });
  });

  it('failed / blocked 分别落到各自终态并保留归因', () => {
    const failed = fold([
      { type: 'nodeDispatched', nodeId: 'a', attemptId: 'a/attempts/001' },
      { type: 'nodeFailed', nodeId: 'a', attemptId: 'a/attempts/001', errorClass: 'timeout', message: '超时' },
    ]);
    expect(failed.nodes.get('a')).toMatchObject({ status: 'failed', errorClass: 'timeout', message: '超时' });

    const blocked = fold([
      { type: 'nodeDispatched', nodeId: 'a', attemptId: 'a/attempts/001' },
      { type: 'nodeBlocked', nodeId: 'a', attemptId: 'a/attempts/001', errorClass: 'resultInvalid' },
    ]);
    expect(blocked.nodes.get('a')).toMatchObject({ status: 'blocked', errorClass: 'resultInvalid' });
  });

  it('retryRequested 把节点拉回 pending，并把 run 从 blocked 拉回 running', () => {
    const snap = fold([
      { type: 'nodeDispatched', nodeId: 'a', attemptId: 'a/attempts/001' },
      { type: 'nodeBlocked', nodeId: 'a', attemptId: 'a/attempts/001', errorClass: 'resultInvalid' },
      { type: 'runBlocked', blockedNodeId: 'a' },
      { type: 'nodeRetryRequested', nodeId: 'a', previousAttemptId: 'a/attempts/001', nextAttemptId: 'a/attempts/002' },
    ]);
    // 不把 run 拉回 running 的话，重放后调度器再也不会看它一眼
    expect(snap.runStatus).toBe('running');
    expect(snap.blockedNodeId).toBeUndefined();
    expect(snap.nodes.get('a')!.status).toBe('pending');
  });

  it('gateDispatched → gateWaiting 并登记未决闸门', () => {
    const snap = fold([
      { type: 'gateDispatched', nodeId: 'a', waitId: 'w1', prompt: '确认', timeoutMs: 5000 },
    ]);
    expect(snap.nodes.get('a')!.status).toBe('gateWaiting');
    expect(snap.openGates.get('a')).toMatchObject({ waitId: 'w1', prompt: '确认', timeoutMs: 5000 });
  });

  it('闸门放行 → pending + gateCleared，且闸门从未决列表移除', () => {
    const snap = fold([
      { type: 'gateDispatched', nodeId: 'a', waitId: 'w1', prompt: '确认' },
      { type: 'gateResolved', nodeId: 'a', waitId: 'w1', resolution: 'approved', by: 'alice' },
    ]);
    expect(snap.nodes.get('a')).toMatchObject({ status: 'pending', gateCleared: true });
    expect(snap.openGates.size).toBe(0);
  });

  it('闸门被拒 → failed（gateRejected）', () => {
    const snap = fold([
      { type: 'gateDispatched', nodeId: 'a', waitId: 'w1', prompt: '确认' },
      { type: 'gateResolved', nodeId: 'a', waitId: 'w1', resolution: 'rejected', by: 'bob' },
    ]);
    expect(snap.nodes.get('a')).toMatchObject({ status: 'failed', errorClass: 'gateRejected' });
    expect(snap.nodes.get('a')!.message).toContain('bob');
  });

  it('闸门超时 → failed（gateExpired），与被拒区分开', () => {
    const snap = fold([
      { type: 'gateDispatched', nodeId: 'a', waitId: 'w1', prompt: '确认' },
      { type: 'gateResolved', nodeId: 'a', waitId: 'w1', resolution: 'expired', by: 'timeout' },
    ]);
    expect(snap.nodes.get('a')!.errorClass).toBe('gateExpired');
  });

  it('gateCleared 跨越后续派发保留——重试时不该再被同一个闸门拦一次', () => {
    const snap = fold([
      { type: 'gateDispatched', nodeId: 'a', waitId: 'w1', prompt: '确认' },
      { type: 'gateResolved', nodeId: 'a', waitId: 'w1', resolution: 'approved', by: 'alice' },
      { type: 'nodeDispatched', nodeId: 'a', attemptId: 'a/attempts/001' },
      { type: 'nodeBlocked', nodeId: 'a', attemptId: 'a/attempts/001', errorClass: 'resultInvalid' },
      { type: 'nodeRetryRequested', nodeId: 'a', previousAttemptId: 'a/attempts/001', nextAttemptId: 'a/attempts/002' },
    ]);
    expect(snap.nodes.get('a')!.gateCleared).toBe(true);
  });

  it('edgeResolved 首次裁决即固化，重复事件不改变结论', () => {
    const snap = fold([
      { type: 'edgeResolved', from: 'a', to: 'b', active: true },
      { type: 'edgeResolved', from: 'a', to: 'b', active: false },
    ]);
    expect(snap.edges.get('a->b')).toEqual({ active: true });
  });

  it('run 终态事件被记录并带上归因', () => {
    expect(fold([{ type: 'runSucceeded' }]).runStatus).toBe('succeeded');
    const failed = fold([{ type: 'runFailed', failedNodeId: 'x' }]);
    expect(failed).toMatchObject({ runStatus: 'failed', failedNodeId: 'x' });
    const blocked = fold([{ type: 'runBlocked', blockedNodeId: 'y' }]);
    expect(blocked).toMatchObject({ runStatus: 'blocked', blockedNodeId: 'y' });
  });
});

describe('materialize — 纯函数性质', () => {
  it('同样的事件序列永远得到同样的快照', () => {
    const events: WorkflowEvent[] = [
      { type: 'runStarted', runId: 'r' },
      { type: 'nodeDispatched', nodeId: 'a', attemptId: 'a/attempts/001' },
      { type: 'nodeSucceeded', nodeId: 'a', attemptId: 'a/attempts/001', outputs: { k: 1 } },
      { type: 'edgeResolved', from: 'a', to: 'b', active: true },
    ];
    const stored = events.map(ev);
    const first = materialize('r', stored);
    const second = materialize('r', stored);
    expect([...second.nodes]).toEqual([...first.nodes]);
    expect([...second.edges]).toEqual([...first.edges]);
    expect(second.runStatus).toBe(first.runStatus);
  });

  it('前缀重放 = 中途崩溃后的状态，能继续往前推', () => {
    const stored = [
      ev({ type: 'nodeDispatched', nodeId: 'a', attemptId: 'a/attempts/001' }),
      ev({ type: 'nodeSucceeded', nodeId: 'a', attemptId: 'a/attempts/001' }),
      ev({ type: 'nodeDispatched', nodeId: 'b', attemptId: 'b/attempts/001' }),
    ];
    const partial = materialize('r', stored.slice(0, 2));
    expect(partial.nodes.get('a')!.status).toBe('done');
    expect(partial.nodes.has('b')).toBe(false);
    const full = materialize('r', stored);
    expect(full.nodes.get('b')!.status).toBe('running');
  });
});

describe('attemptId', () => {
  it('首次派发是 001，零填充三位', () => {
    expect(nextAttemptId([], 'a')).toBe('a/attempts/001');
    expect(formatAttemptId('a', 12)).toBe('a/attempts/012');
  });

  it('从 journal 折出下一个编号，不与已用过的重复', () => {
    const events = [
      ev({ type: 'nodeDispatched', nodeId: 'a', attemptId: 'a/attempts/001' }),
      ev({ type: 'nodeDispatched', nodeId: 'a', attemptId: 'a/attempts/002' }),
      ev({ type: 'nodeDispatched', nodeId: 'b', attemptId: 'b/attempts/001' }),
    ];
    expect(nextAttemptId(events, 'a')).toBe('a/attempts/003');
    expect(nextAttemptId(events, 'b')).toBe('b/attempts/002');
  });

  it('按编号取最大值，不受事件顺序影响（迟到的旧 attempt 不能让编号倒退）', () => {
    const events = [
      ev({ type: 'nodeDispatched', nodeId: 'a', attemptId: 'a/attempts/003' }),
      ev({ type: 'nodeDispatched', nodeId: 'a', attemptId: 'a/attempts/001' }),
    ];
    expect(nextAttemptId(events, 'a')).toBe('a/attempts/004');
  });
});
