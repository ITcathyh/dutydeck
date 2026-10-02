import { readFile, readdir } from 'node:fs/promises';

/** Linux process-tree CPU evidence. Unknown readings never prove activity. */
export class TurnCpu {
  private previous?: { at: number; ticks: Map<string, number> };
  async active(roots: number[]): Promise<boolean> {
    if (process.platform !== 'linux' || !roots.length) return false;
    const ticks = new Map<string, number>(), seen = new Set<number>(), pending = [...roots];
    try {
      while (pending.length) {
        const pid = pending.pop()!;
        if (seen.has(pid)) continue;
        seen.add(pid);
        try {
          const raw = await readFile(`/proc/${pid}/stat`, 'utf8');
          const fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
          ticks.set(`${pid}:${fields[19]}`, Number(fields[11]) + Number(fields[12]) + Number(fields[13]) + Number(fields[14]));
          for (const tid of await readdir(`/proc/${pid}/task`)) {
            const children = await readFile(`/proc/${pid}/task/${tid}/children`, 'utf8').catch(() => '');
            pending.push(...children.trim().split(/\s+/).map(Number).filter(pid => pid > 0));
          }
        } catch { /* An exited/unreadable process supplies no positive evidence. */ }
      }
      const now = Date.now(), previous = this.previous;
      this.previous = { at: now, ticks };
      if (!previous || now - previous.at < 1000) return false;
      let used = 0;
      for (const [key, value] of ticks) used += Math.max(0, value - (previous.ticks.get(key) ?? value));
      return used * 10 >= (now - previous.at) * 0.05;
    } catch { return false; }
  }
}
