import { expect, it } from 'vitest';
import type { DriverIdleCpuProof } from '@dutydeck/shared';
import { IdleCpuWindow } from './idle-cpu.js';
const proof = (cpuMs: number, extra = {}): DriverIdleCpuProof => ({ identity: 'root:123:birth', generation: 1, inputRevision: 1, lastInputAt: 0, nativeSessionId: 'native', cpuMs, sampledAt: 0, ...extra });

it('requires five minutes and three valid high windows, reports once, and never counts old CPU', () => {
  const window = new IdleCpuWindow();
  expect(window.sample(proof(1_000_000), 0)).toBeUndefined();
  expect(window.sample(proof(1_060_000), 120_000)).toBeUndefined();
  expect(window.sample(proof(1_120_000), 240_000)).toBeUndefined();
  expect(window.sample(proof(1_180_000), 360_000)).toEqual({ ratio: 0.5, report: true });
  expect(window.sample(proof(1_240_000), 480_000)).toEqual({ ratio: 0.5, report: false });
});

it.each(['low', 'backwards', 'gap', 'pid', 'generation', 'input', 'native', 'counter'])('resets the entire high window after %s', change => {
  const window = new IdleCpuWindow();
  window.sample(proof(0), 0); window.sample(proof(120_000), 120_000); window.sample(proof(240_000), 240_000);
  const changes: Record<string, [number, number, object]> = {
    low: [250_000, 360_000, {}], backwards: [360_000, 100_000, {}], gap: [1_000_000, 1_000_000, {}],
    pid: [360_000, 360_000, { identity: 'root:123:reused' }], generation: [360_000, 360_000, { generation: 2 }],
    input: [360_000, 360_000, { inputRevision: 2 }], native: [360_000, 360_000, { nativeSessionId: 'other' }], counter: [1, 360_000, {}],
  };
  const [cpu, at, extra] = changes[change]!;
  expect(window.sample(proof(cpu, extra), at)).toBeUndefined();
  expect(window.sample(proof(cpu + 120_000, extra), at + 120_000)).toBeUndefined();
  expect(window.sample(proof(cpu + 240_000, extra), at + 240_000)).toBeUndefined();
  expect(window.sample(proof(cpu + 360_000, extra), at + 360_000)).toEqual({ ratio: 1, report: true });
});

it('accumulates short maintenance intervals without granting an early decision', () => {
  const window = new IdleCpuWindow();
  for (let at = 0; at < 300_000; at += 10_000) expect(window.sample(proof(at), at)).toBeUndefined();
  expect(window.sample(proof(300_000), 300_000)).toEqual({ ratio: 1, report: true });
});
