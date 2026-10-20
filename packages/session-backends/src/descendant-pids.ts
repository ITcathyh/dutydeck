import { readFileSync, readdirSync } from 'node:fs';

/** Includes roots; callers validate ownership and resolve physical identities. */
export function descendantPids(roots: number[]): number[] {
  const children = new Map<number, number[]>();
  for (const entry of readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
    try {
      const raw = readFileSync(`/proc/${entry}/stat`, 'utf8');
      const parent = Number(raw.slice(raw.lastIndexOf(')') + 2).split(' ')[1]);
      children.set(parent, [...(children.get(parent) ?? []), Number(entry)]);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const pids = new Set<number>();
  const pending = [...roots];
  while (pending.length) {
    const pid = pending.pop()!;
    if (pids.has(pid)) continue;
    pids.add(pid); pending.push(...(children.get(pid) ?? []));
  }
  return [...pids];
}
