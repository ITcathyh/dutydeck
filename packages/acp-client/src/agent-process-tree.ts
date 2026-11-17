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
interface ObservedMember extends TreeMember { pgid: number }
interface ProcessGroup { leader: TreeMember; proven: boolean; exited: boolean }
type GroupState = 'live' | 'unknown' | 'exited';

export class AgentProcessTree {
  private readonly root?: TreeMember;
  private readonly members = new Map<string, ObservedMember>();
  /** Birth identity, adoption proof and a permanent exit tombstone for each numeric PGID. */
  private readonly groups = new Map<number, ProcessGroup>();
  private readonly ownGroup: boolean;
  /** Where a Dutydeck launcher root records the Agent it detached, read even after the launcher died before any sample. */
  private readonly report?: string;

  constructor(pid: number | undefined, reports?: string) {
    const stat = pid ? readStat(pid) : undefined;
    if (pid && stat) this.root = { pid, start: stat.start };
    this.ownGroup = !!pid && stat?.pgid === pid;
    if (this.ownGroup) this.groups.set(pid!, { leader: this.root!, proven: true, exited: false });
    if (reports && this.root) this.report = join(reports, `${this.root.pid}.${this.root.start}`);
  }
  /** Drop the launcher's report file only after the caller proves that its recorded tree exited. */
  discardReport() { if (this.report) rmSync(this.report, { force: true }); }
  /** Reserved exit code plus the launcher's synchronous marker; either one alone is an ordinary exit. */
  hasCleanupUnknownReport(exitCode: number | null) {
    if (exitCode !== 120 || !this.report) return false;
    try {
      return /^dutydeck_cleanup_unknown \{"sourcesClosed":(?:true|false),"destinationFlushed":(?:true|false),"groupExited":(?:true|false)\}\n$/m.test(readFileSync(this.report, 'utf8'));
    } catch { return false; }
  }
  private adoptReported(table: ProcessTable) {
    let raw: string;
    try { raw = readFileSync(this.report!, 'utf8'); } catch { return; }
    const match = /^(\d+) (\d+)\n/.exec(raw);
    if (!match) return;
    const member: ObservedMember = { pid: Number(match[1]), start: match[2]!, pgid: Number(match[1]) };
    // The report lives in the workspace: only a process the launcher could have started is accepted.
    if (member.pid === this.root!.pid || Number(member.start) < Number(this.root!.start)) return;
    this.members.set(key(member), member);
    let group = this.groups.get(member.pid);
    if (!group) { group = { leader: member, proven: false, exited: false }; this.groups.set(member.pid, group); }
    if (group.exited) return;
    const stat = table.get(member.pid);
    // A stale report alone cannot adopt a leaderless group. Its original leader
    // or a previously observed original member must still prove continuity.
    if ((stat && !stat.zombie && stat.start === group.leader.start && stat.pgid === member.pid) || this.hasKnownGroupMember(member.pid, table)) group.proven = true;
  }
  private hasKnownGroupMember(pgid: number, table: ProcessTable) {
    return [...this.members.values()].some(member => member.pgid === pgid && alive(member, table) && table.get(member.pid)?.pgid === pgid);
  }
  private groupState(pgid: number, group: ProcessGroup, table: ProcessTable): GroupState {
    if (group.exited) return 'exited';
    if (!table.size) return 'unknown';
    const leader = table.get(pgid);
    // Reusing the leader PID proves that no member of the original group survives.
    if (leader && leader.start !== group.leader.start) { group.exited = true; return 'exited'; }
    if ((leader && !leader.zombie && leader.start === group.leader.start && leader.pgid === pgid) || this.hasKnownGroupMember(pgid, table)) {
      group.proven = true;
      return 'live';
    }
    // A same-numbered leaderless group may be old or new. Never signal it or
    // call it cleaned without birth-identity continuity.
    if ([...table.values()].some(stat => stat.pgid === pgid && !stat.zombie)) return 'unknown';
    group.exited = true;
    return 'exited';
  }
  /** Whether a proven process group led by a descendant (not the root's own group) has been recorded. */
  hasGroups() { return [...this.groups].some(([pgid, group]) => pgid !== this.root?.pid && group.proven); }
  /** Record the root's current descendants; returns false when /proc cannot be read. */
  refresh(table = scanProcesses()): boolean {
    if (!table.size || !this.root) return false;
    for (const pid of alive(this.root, table) ? processTreePids(table, [this.root.pid]) : []) {
      if (pid === this.root.pid) continue;
      const stat = table.get(pid)!;
      const member: ObservedMember = { pid, start: stat.start, pgid: stat.pgid };
      this.members.set(key(member), member);
      if (stat.pgid === pid) {
        const group = this.groups.get(pid);
        if (!group) this.groups.set(pid, { leader: member, proven: true, exited: false });
        else if (!group.exited && group.leader.start === member.start) group.proven = true;
      }
    }
    if (this.report) this.adoptReported(table);
    return true;
  }
  /** Signal the root's process group when it leads one, every recorded descendant, and every recorded group. */
  signal(name: NodeJS.Signals, signalRoot: () => void, table = scanProcesses()) {
    this.refresh(table);
    const ownGroup = this.ownGroup ? this.groups.get(this.root!.pid) : undefined;
    if (ownGroup && this.groupState(this.root!.pid, ownGroup, table) === 'live') { try { process.kill(-this.root!.pid, name); } catch { /* Gone. */ } }
    else if (!this.ownGroup) signalRoot();
    for (const member of this.members.values()) if (alive(member, table)) { try { process.kill(member.pid, name); } catch { /* Gone. */ } }
    for (const [pgid, group] of this.groups) if (pgid !== this.root?.pid && this.groupState(pgid, group, table) === 'live') { try { process.kill(-pgid, name); } catch { /* Gone. */ } }
  }
  /**
   * True once every recorded descendant and every recorded process group is gone. Undefined when it cannot be
   * proven: no /proc, or no descendant was ever recorded, so a detached Agent may survive unseen.
   */
  exited(table = scanProcesses()): boolean | undefined {
    if (!table.size || !this.members.size) return undefined;
    let live = [...this.members.values()].some(member => alive(member, table));
    let unknown = false;
    for (const [pgid, group] of this.groups) {
      const state = this.groupState(pgid, group, table);
      if (state === 'live') live = true;
      else if (state === 'unknown') unknown = true;
    }
    return live ? false : unknown ? undefined : true;
  }
}
