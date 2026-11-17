import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentProcessTree, scanProcesses, type ProcessStat, type ProcessTable } from './agent-process-tree.js';

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function processTable(rootStat: ProcessStat, ...members: Array<[number, ProcessStat]>): ProcessTable {
  return new Map([[process.pid, rootStat], ...members]);
}

function fixture() {
  const root = scanProcesses().get(process.pid)!;
  expect(root).toBeDefined();
  const stat = (ppid: number, pgid: number, offset: number): ProcessStat => ({ ppid, pgid, start: String(Number(root.start) + offset), zombie: false, ticks: 0 });
  const leaderPid = 700_000_001, memberPid = 700_000_002, unrelatedPid = 700_000_003;
  const leader = stat(process.pid, leaderPid, 1);
  const member = stat(leaderPid, leaderPid, 2);
  const unrelatedOrphan = stat(1, leaderPid, 101);
  const table = (...members: Array<[number, ProcessStat]>) => processTable(root, ...members);
  return { root, stat, leaderPid, memberPid, unrelatedPid, leader, member, unrelatedOrphan, table };
}

function recordedTree() {
  const values = fixture();
  const tree = new AgentProcessTree(process.pid);
  expect(tree.refresh(values.table([values.leaderPid, values.leader], [values.memberPid, values.member]))).toBe(true);
  return { ...values, tree };
}

function signal(tree: AgentProcessTree, table: ProcessTable) {
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
  const signalRoot = vi.fn();
  tree.signal('SIGKILL', signalRoot, table);
  return { kill, signalRoot };
}

describe.skipIf(process.platform !== 'linux')('AgentProcessTree process-group birth identity', () => {
  it('refuses a leaderless numeric group after an unsampled reuse cycle and leaves exit unconfirmed', () => {
    const h = recordedTree();
    const current = h.table([h.unrelatedPid, h.unrelatedOrphan]);
    const { kill, signalRoot } = signal(h.tree, current);
    expect(kill).not.toHaveBeenCalled();
    expect(signalRoot).toHaveBeenCalledTimes(1);
    expect(h.tree.exited(current)).toBeUndefined();
  });

  it('never revives a group whose original members were already observed gone', () => {
    const h = recordedTree();
    expect(h.tree.exited(h.table())).toBe(true);
    const current = h.table([h.unrelatedPid, h.unrelatedOrphan]);
    const { kill, signalRoot } = signal(h.tree, current);
    expect(kill).not.toHaveBeenCalled();
    expect(signalRoot).toHaveBeenCalledTimes(1);
    expect(h.tree.exited(current)).toBe(true);
  });

  it('does not adopt a leaderless numeric group from a stale launcher report', () => {
    const h = fixture();
    const reports = mkdtempSync(join(tmpdir(), 'dutydeck-r1-reports-')); directories.push(reports);
    writeFileSync(join(reports, `${process.pid}.${h.root.start}`), `${h.leaderPid} ${h.leader.start}\n`);
    const tree = new AgentProcessTree(process.pid, reports);
    const current: ProcessTable = new Map([[h.unrelatedPid, h.unrelatedOrphan]]);
    expect(tree.hasGroups()).toBe(false);
    const { kill, signalRoot } = signal(tree, current);
    expect(tree.hasGroups()).toBe(false);
    expect(kill).not.toHaveBeenCalled();
    expect(signalRoot).toHaveBeenCalledTimes(1);
    expect(tree.exited(current)).toBeUndefined();
  });

  it('applies the same continuity fence to the root ownGroup branch', () => {
    const h = fixture();
    const tree = new AgentProcessTree(process.pid);
    Object.defineProperty(tree, 'ownGroup', { value: true });
    (tree as any).groups.set(process.pid, { leader: { pid: process.pid, start: h.root.start }, proven: true, exited: false });
    const originalChild = h.stat(process.pid, process.pid, 2);
    tree.refresh(new Map([[process.pid, { ...h.root, pgid: process.pid }], [h.memberPid, originalChild]]));
    const current = new Map([[h.unrelatedPid, h.stat(1, process.pid, 101)]]);
    const { kill, signalRoot } = signal(tree, current);
    expect(kill).not.toHaveBeenCalled();
    expect(signalRoot).not.toHaveBeenCalled();
    expect(tree.exited(current)).toBeUndefined();
  });

  it('still cleans an original group after its leader exits but a known member survives', () => {
    const h = recordedTree();
    const current = h.table([h.memberPid, { ...h.member, ppid: 1 }]);
    const { kill, signalRoot } = signal(h.tree, current);
    expect(kill.mock.calls.map(([pid]) => pid)).toEqual(expect.arrayContaining([h.memberPid, -h.leaderPid]));
    expect(signalRoot).toHaveBeenCalledTimes(1);
    expect(h.tree.exited(current)).toBe(false);
  });

  it('confirms exit and refuses the group when a reused leader is still visible', () => {
    const h = recordedTree();
    const current = h.table([h.leaderPid, h.stat(1, h.leaderPid, 100)], [h.unrelatedPid, h.unrelatedOrphan]);
    const { kill, signalRoot } = signal(h.tree, current);
    expect(kill).not.toHaveBeenCalled();
    expect(signalRoot).toHaveBeenCalledTimes(1);
    expect(h.tree.exited(current)).toBe(true);
  });

  it('adopts and cleans a reported group while its original leader is still alive', () => {
    const h = fixture();
    const reports = mkdtempSync(join(tmpdir(), 'dutydeck-r1-reports-')); directories.push(reports);
    writeFileSync(join(reports, `${process.pid}.${h.root.start}`), `${h.leaderPid} ${h.leader.start}\n`);
    const tree = new AgentProcessTree(process.pid, reports);
    const current: ProcessTable = new Map([[h.leaderPid, { ...h.leader, ppid: 1 }], [h.memberPid, h.member]]);
    const { kill, signalRoot } = signal(tree, current);
    expect(tree.hasGroups()).toBe(true);
    expect(kill.mock.calls.map(([pid]) => pid)).toEqual(expect.arrayContaining([h.leaderPid, -h.leaderPid]));
    expect(signalRoot).toHaveBeenCalledTimes(1);
    expect(tree.exited(current)).toBe(false);
  });

  it('does not turn an unreadable process scan into a confirmed group exit', () => {
    const h = recordedTree();
    const { kill, signalRoot } = signal(h.tree, new Map());
    expect(kill).not.toHaveBeenCalled();
    const current = h.table([h.unrelatedPid, h.unrelatedOrphan]);
    h.tree.signal('SIGKILL', signalRoot, current);
    expect(kill).not.toHaveBeenCalled();
    expect(h.tree.exited(current)).toBeUndefined();
  });

  it('does not treat zombies or unreadable process evidence as a live group', () => {
    const h = recordedTree();
    const zombie = h.table([h.leaderPid, { ...h.leader, zombie: true }], [h.memberPid, { ...h.member, zombie: true }]);
    expect(h.tree.exited(zombie)).toBe(true);
    const { kill, signalRoot } = signal(h.tree, zombie);
    expect(kill).not.toHaveBeenCalled();
    expect(signalRoot).toHaveBeenCalledTimes(1);
    expect(h.tree.exited(new Map())).toBeUndefined();
    h.tree.signal('SIGKILL', signalRoot, new Map());
    expect(kill).not.toHaveBeenCalled();
  });
});
