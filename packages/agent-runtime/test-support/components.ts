import type { HumanWaits } from '../src/runtime/human-waits.js';
import type { DutydeckRuntime } from '../src/index.js';
import type { Maintenance } from '../src/runtime/maintenance.js';

interface RuntimeComponents {
  humanWaits: Pick<HumanWaits, 'pendingPermissionCount' | 'register'>;
  maintenance: Pick<Maintenance, 'currentRun' | 'idleCpuBlocked'>;
}

/** Internal probes used by the runtime's wiring and shutdown tests. */
export function runtimeComponents(runtime: DutydeckRuntime): RuntimeComponents {
  return runtime as unknown as RuntimeComponents;
}
