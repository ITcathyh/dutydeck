import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { parseProcStat, procStatExited } from '@dutydeck/shared';

/**
 * Process tree of one Agent child spawned by ACPX, read from Linux /proc. Other platforms see only the root.
 * Members are identified by PID plus start time so a reused PID is never signalled or counted as alive.
 */
export interface ProcessStat { ppid: number; pgid: number; start: string; zombie: boolean; /** utime + stime + cutime + cstime, in USER_HZ ticks. */ ticks: number }
export type ProcessTable = Map<number, ProcessStat>;
export interface TreeMember { pid: number; start: string }

function readStat(pid: number): ProcessStat | undefined {
  try {
    const stat = parseProcStat(readFileSync(`/proc/${pid}/stat`, 'utf8'));
    return { ppid: stat.ppid, pgid: stat.pgid, start: stat.start, zombie: procStatExited(stat), ticks: stat.cpuTicks };
  } catch { return undefined; }
}
/** Every readable process; empty off Linux or when /proc cannot be listed. One synchronous pass over /proc, so share it. */
export function scanProcesses(): ProcessTable {
  const table: ProcessTable = new Map();
  if (process.platform !== 'linux') return table;
  let names: string[];
  try { names = readdirSync('/proc'); } catch { return table; }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const stat = readStat(Number(name));
    if (stat) table.set(Number(name), stat);
  }
  return table;
}
/** The roots present in the table and all their descendants. */
export function processTreePids(table: ProcessTable, roots: number[]): number[] {
  const children = new Map<number, number[]>();
  for (const [pid, stat] of table) { const list = children.get(stat.ppid); if (list) list.push(pid); else children.set(stat.ppid, [pid]); }
  const pending = roots.filter(pid => table.has(pid));
  const seen = new Set<number>();
  while (pending.length) {
    const pid = pending.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    pending.push(...children.get(pid) ?? []);
  }
  return [...seen];
}
const key = (member: TreeMember) => `${member.pid}:${member.start}`;
const alive = (member: TreeMember, table: ProcessTable) => { const stat = table.get(member.pid); return !!stat && !stat.zombie && stat.start === member.start; };
const groupAlive = (pgid: number, table: ProcessTable) => [...table.values()].some(stat => stat.pgid === pgid && !stat.zombie);

export class AgentProcessTree {
  private readonly root?: TreeMember;
  private readonly members = new Map<string, TreeMember>();
  /** Process groups led by a member (for example the Agent the env launcher detaches); they outlive a killed parent. */
  private readonly groups = new Set<number>();
  private readonly ownGroup: boolean;
  /** Where a Dutydeck launcher root records the Agent it detached, read even after the launcher died before any sample. */
  private readonly report?: string;

  constructor(pid: number | undefined, reports?: string) {
    const stat = pid ? readStat(pid) : undefined;
    if (pid && stat) this.root = { pid, start: stat.start };
    this.ownGroup = !!pid && stat?.pgid === pid;
    if (this.ownGroup) this.groups.add(pid!);
    if (reports && this.root) this.report = join(reports, `${this.root.pid}.${this.root.start}`);
  }
  /** Drop the launcher's report file; whatever it named stays recorded. */
  discardReport() { if (this.report) rmSync(this.report, { force: true }); }
  private adoptReported(table: ProcessTable) {
    let raw: string;
    try { raw = readFileSync(this.report!, 'utf8'); } catch { return; }
    const match = /^(\d+) (\d+)\n$/.exec(raw);
    if (!match) return;
    const member = { pid: Number(match[1]), start: match[2]! };
    // The report lives in the workspace: only a process the launcher could have started is accepted.
    if (member.pid === this.root!.pid || Number(member.start) < Number(this.root!.start)) return;
    const stat = table.get(member.pid);
    this.members.set(key(member), member);
    // A leader PID cannot be reused while its group has members, so a gone leader still names its live group.
    if (stat ? stat.start === member.start : groupAlive(member.pid, table)) this.groups.add(member.pid);
  }
  /** Whether a process group led by a descendant (not the root's own group) has been recorded. */
  hasGroups() { return [...this.groups].some(group => group !== this.root?.pid); }
  /** Record the root's current descendants; returns false when /proc cannot be read. */
  refresh(table = scanProcesses()): boolean {
    if (!table.size || !this.root) return false;
    for (const pid of alive(this.root, table) ? processTreePids(table, [this.root.pid]) : []) {
      if (pid === this.root.pid) continue;
      const stat = table.get(pid)!;
      this.members.set(key({ pid, start: stat.start }), { pid, start: stat.start });
      if (stat.pgid === pid) this.groups.add(pid);
    }
    if (this.report) this.adoptReported(table);
    return true;
  }
  /** Signal the root's process group when it leads one, every recorded descendant, and every recorded group. */
  signal(name: NodeJS.Signals, signalRoot: () => void, table = scanProcesses()) {
    this.refresh(table);
    if (this.ownGroup) { try { process.kill(-this.root!.pid, name); } catch { /* Gone. */ } }
    else signalRoot();
    for (const member of this.members.values()) if (alive(member, table)) { try { process.kill(member.pid, name); } catch { /* Gone. */ } }
    for (const group of this.groups) if (group !== this.root?.pid && groupAlive(group, table)) { try { process.kill(-group, name); } catch { /* Gone. */ } }
  }
  /**
   * True once every recorded descendant and every recorded process group is gone. Undefined when it cannot be
   * proven: no /proc, or no descendant was ever recorded, so a detached Agent may survive unseen.
   */
  exited(table = scanProcesses()): boolean | undefined {
    if (!table.size || !this.members.size) return undefined;
    return ![...this.members.values()].some(member => alive(member, table)) && ![...this.groups].some(group => groupAlive(group, table));
  }
}
