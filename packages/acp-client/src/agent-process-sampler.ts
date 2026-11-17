import { scanProcesses, type AgentProcessTree, type ProcessTable } from './agent-process-tree.js';

const SAMPLE_INTERVAL_MS = 100;
const MAX_UNGROUPED_SAMPLES = 50;
type SampledTree = Pick<AgentProcessTree, 'refresh' | 'hasGroups'>;
interface Registration { tree: SampledTree; nextDueAt: number; samples: number }

/** One process-wide /proc scan per tick, shared by every launcher tree due at that tick. */
export class AgentProcessSampler {
  private readonly pending = new Map<SampledTree, Registration>();
  private timer?: NodeJS.Timeout;

  constructor(private readonly scan: () => ProcessTable = scanProcesses) {}

  register(tree: SampledTree): () => void {
    const registration: Registration = { tree, nextDueAt: Date.now() + SAMPLE_INTERVAL_MS, samples: 0 };
    this.pending.set(tree, registration);
    this.schedule();
    return () => {
      if (this.pending.get(tree) !== registration) return;
      this.pending.delete(tree);
      this.schedule();
    };
  }

  private schedule() {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.pending.size) return;
    const nextDueAt = Math.min(...[...this.pending.values()].map(registration => registration.nextDueAt));
    this.timer = setTimeout(this.sample, Math.max(0, nextDueAt - Date.now()));
    this.timer.unref?.();
  }

  private readonly sample = () => {
    this.timer = undefined;
    const now = Date.now();
    const due = [...this.pending.values()].filter(registration => registration.nextDueAt <= now);
    if (!due.length) { this.schedule(); return; }
    const table = this.scan();
    for (const registration of due) {
      if (this.pending.get(registration.tree) !== registration) continue;
      if (registration.tree.refresh(table) === false || registration.tree.hasGroups()) {
        this.pending.delete(registration.tree);
        continue;
      }
      // Schedule from the actual tick, not the previous due time, so a delayed callback cannot cause dense catch-up.
      registration.nextDueAt = now + SAMPLE_INTERVAL_MS;
      if (++registration.samples >= MAX_UNGROUPED_SAMPLES) this.pending.delete(registration.tree);
    }
    this.schedule();
  };
}

export const agentProcessSampler = new AgentProcessSampler();
