import { readFileSync, readdirSync } from 'node:fs';
import { parseProcStat, procStatExited } from '@dutydeck/shared';

/** Linux exports /proc CPU times in USER_HZ (100 ticks/second), independently of CONFIG_HZ.
 * Only this process's utime/stime count: reaped-child lifetime CPU is not idle CPU. */
function stat(pid: number) {
  const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
  return { ...parseProcStat(raw), cpuMs: (Number(fields[11]) + Number(fields[12])) * 10 };
}

/** Fail closed on unreadable trees; remember observed children even after reparenting. */
export class IdleCpuProcess {
  private readonly descendants = new Map<number, string>();
  constructor(readonly pid: number, readonly start: string) {}

  sample(): number | undefined {
    if (process.platform !== 'linux' || !this.start) return undefined;
    try {
      const root = stat(this.pid);
      if (root.start !== this.start || procStatExited(root) || !Number.isFinite(root.cpuMs)) return undefined;
      const pending = [this.pid], seen = new Set<number>();
      let childrenAlive = false;
      while (pending.length) {
        const pid = pending.pop()!;
        if (seen.has(pid)) continue;
        seen.add(pid);
        for (const tid of readdirSync(`/proc/${pid}/task`)) {
          // A vanished thread is an incomplete scan, never proof of an empty tree.
          const children = readFileSync(`/proc/${pid}/task/${tid}/children`, 'utf8').trim();
          if (!children) continue;
          for (const child of children.split(/\s+/).map(Number)) {
            if (!Number.isSafeInteger(child) || child <= 0) return undefined;
            const value = stat(child);
            this.descendants.set(child, value.start);
            if (!procStatExited(value)) { childrenAlive = true; pending.push(child); }
          }
        }
      }
      for (const [pid, start] of this.descendants) {
        try {
          const value = stat(pid);
          if (value.start === start && !procStatExited(value)) childrenAlive = true;
          else this.descendants.delete(pid);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return undefined;
          this.descendants.delete(pid);
        }
      }
      // Detect PID reuse while reading the children, too.
      return !childrenAlive && stat(this.pid).start === this.start ? root.cpuMs : undefined;
    } catch { return undefined; }
  }
}
