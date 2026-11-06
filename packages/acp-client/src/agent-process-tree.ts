import { readdirSync, readFileSync } from 'node:fs';

/**
 * Process tree of one Agent child spawned by ACPX, read from Linux /proc. Other platforms see only the root.
 * Members are identified by PID plus start time so a reused PID is never signalled or counted as alive.
 */
interface Stat { ppid: number; pgid: number; start: string; zombie: boolean }
export interface TreeMember { pid: number; start: string }

function readStat(pid: number): Stat | undefined {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
    return { ppid: Number(fields[1]), pgid: Number(fields[2]), start: fields[19]!, zombie: fields[0] === 'Z' || fields[0] === 'X' };
  } catch { return undefined; }
}
function scan(): Map<number, Stat> {
  const table = new Map<number, Stat>();
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
const key = (member: TreeMember) => `${member.pid}:${member.start}`;
const alive = (member: TreeMember, table: Map<number, Stat>) => { const stat = table.get(member.pid); return !!stat && !stat.zombie && stat.start === member.start; };
const groupAlive = (pgid: number, table: Map<number, Stat>) => [...table.values()].some(stat => stat.pgid === pgid && !stat.zombie);

export class AgentProcessTree {
  private readonly root?: TreeMember;
  private readonly members = new Map<string, TreeMember>();
  /** Process groups led by a member (for example the Agent the env launcher detaches); they outlive a killed parent. */
  private readonly groups = new Set<number>();
  private readonly ownGroup: boolean;

  constructor(pid: number | undefined) {
    const stat = pid ? readStat(pid) : undefined;
    if (pid && stat) this.root = { pid, start: stat.start };
    this.ownGroup = !!pid && stat?.pgid === pid;
    if (this.ownGroup) this.groups.add(pid!);
  }
  /** Whether a process group led by a descendant (not the root's own group) has been recorded. */
  hasGroups() { return [...this.groups].some(group => group !== this.root?.pid); }
  /** Record the root's current descendants; returns false when /proc cannot be read. */
  refresh(): boolean {
    const table = scan();
    if (!table.size || !this.root) return false;
    const children = new Map<number, number[]>();
    for (const [pid, stat] of table) { const list = children.get(stat.ppid); if (list) list.push(pid); else children.set(stat.ppid, [pid]); }
    const pending = alive(this.root, table) ? [...children.get(this.root.pid) ?? []] : [];
    const seen = new Set<number>();
    while (pending.length) {
      const pid = pending.pop()!;
      if (seen.has(pid)) continue;
      seen.add(pid);
      const stat = table.get(pid)!;
      this.members.set(key({ pid, start: stat.start }), { pid, start: stat.start });
      if (stat.pgid === pid) this.groups.add(pid);
      pending.push(...children.get(pid) ?? []);
    }
    return true;
  }
  /** Signal the root's process group when it leads one, every recorded descendant, and every recorded group. */
  signal(name: NodeJS.Signals, signalRoot: () => void) {
    this.refresh();
    const table = scan();
    if (this.ownGroup) { try { process.kill(-this.root!.pid, name); } catch { /* Gone. */ } }
    else signalRoot();
    for (const member of this.members.values()) if (alive(member, table)) { try { process.kill(member.pid, name); } catch { /* Gone. */ } }
    for (const group of this.groups) if (group !== this.root?.pid && groupAlive(group, table)) { try { process.kill(-group, name); } catch { /* Gone. */ } }
  }
  /**
   * True once every recorded descendant and every recorded process group is gone. Undefined when it cannot be
   * proven: no /proc, or no descendant was ever recorded, so a detached Agent may survive unseen.
   */
  exited(): boolean | undefined {
    const table = scan();
    if (!table.size || !this.members.size) return undefined;
    return ![...this.members.values()].some(member => alive(member, table)) && ![...this.groups].some(group => groupAlive(group, table));
  }
}
