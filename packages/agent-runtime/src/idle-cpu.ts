import { sameIdleCpuProof, type DriverIdleCpuProof } from '@dutydeck/shared';

export const IDLE_CPU_MIN_IDLE_MS = 10 * 60_000;
const MIN_WINDOW_MS = 60_000;
const MAX_WINDOW_MS = 10 * 60_000;
const MIN_HIGH_MS = 5 * 60_000;

/** At least three fresh high windows, with no gaps, low sample or identity change. */
export class IdleCpuWindow {
  private previous?: { proof: DriverIdleCpuProof; at: number };
  private highMs = 0;
  private windows = 0;
  private reported = false;
  sample(proof: DriverIdleCpuProof, at: number): { ratio: number; report: boolean } | undefined {
    const previous = this.previous;
    const elapsed = previous ? at - previous.at : 0;
    const used = previous ? proof.cpuMs - previous.proof.cpuMs : 0;
    if (!previous || !sameIdleCpuProof(previous.proof, proof) || elapsed <= 0
      || elapsed > MAX_WINDOW_MS || !Number.isFinite(used) || used < elapsed * 0.5) {
      this.previous = { proof, at };
      this.highMs = 0; this.windows = 0; this.reported = false;
      return undefined;
    }
    if (elapsed < MIN_WINDOW_MS) return undefined;
    this.previous = { proof, at };
    this.highMs += elapsed; this.windows++;
    if (this.highMs < MIN_HIGH_MS || this.windows < 3) return undefined;
    const report = !this.reported; this.reported = true;
    return { ratio: used / elapsed, report };
  }
}
