import { readdirSync, readFileSync } from 'node:fs';
import { parseProcStat, procStatExited } from './proc-stat.js';

/**
 * Process tree of one Agent child spawned by ACPX, read from Linux /proc. Other platforms see only the root.
 * Members are identified by PID plus start time so a reused PID is never signalled or counted as alive.
 */
export interface ProcessStat { ppid: number; pgid: number; start: string; zombie: boolean; /** utime + stime + cutime + cstime, in USER_HZ ticks. */ ticks: number }
export type ProcessTable = Map<number, ProcessStat>;
export interface TreeMember { pid: number; start: string }

export function readStat(pid: number): ProcessStat | undefined {
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
