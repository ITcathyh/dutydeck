import type { AgentDriver } from '@dutydeck/shared';
import type { RecoveryService } from '../src/runtime/recovery-service.js';
import type { HumanWaits } from '../src/runtime/human-waits.js';
import type { DutydeckRuntime } from '../src/index.js';
import type { DriverSupervisor } from '../src/runtime/driver-supervisor.js';
import type { RuntimeSessionMutations } from '../src/ownership.js';
import type { Maintenance } from '../src/runtime/maintenance.js';

interface RuntimeComponents {
  steering: { steeringSessions: Map<string, string>; steeringReplies: Map<string, {sessionId: string; driver: AgentDriver}> };
  humanWaits: Pick<HumanWaits, 'pendingPermissionCount' | 'register'>;
  recovery: Pick<RecoveryService, 'reservePtyRetirement'>;
  supervisor: Pick<DriverSupervisor, 'driverOperations' | 'factoryCleanups' | 'stopRuns' | 'retiringDrivers' | 'idleCpuBlocked'> & { lastActivity: Map<string, number>; stops: import('../src/session-gate.js').DriverStopState; connectedDrivers: Map<string, AgentDriver> };
  mutations: RuntimeSessionMutations;
  maintenance: Pick<Maintenance, 'currentRun'>;
}

/** Internal probes used by the runtime's wiring and shutdown tests. */
export function runtimeComponents(runtime: Pick<DutydeckRuntime, keyof DutydeckRuntime>): RuntimeComponents {
  return runtime as unknown as RuntimeComponents;
}
