import type { AgentDriver, ExecutionBlocker, runtimeStateKeys, TaskRecord } from '@dutydeck/shared';

type StopBlock = ReturnType<typeof runtimeStateKeys.driverStopBlock.read>;
type BlockedDriver = { driver: AgentDriver; reason: string };
type Recheck = { timer: ReturnType<typeof setTimeout>; since: string };
type StopRecord = { block?: StopBlock; driver?: BlockedDriver; recheck?: Recheck };

export class DriverStopState {
  private readonly records = new Map<string, StopRecord>();
  // A clear must invalidate reads already in flight, even after removing the last fact.
  private readonly versions = new Map<string, number>();
  version(id: string) { return this.versions.get(id) ?? 0; }
  block(id: string) { return this.records.get(id)?.block; }
  driver(id: string) { return this.records.get(id)?.driver; }
  recheck(id: string) { return this.records.get(id)?.recheck; }
  reason(id: string) { return this.block(id)?.reason ?? this.driver(id)?.reason; }
  recheckingReason(id: string) {
    return this.recheck(id) && this.driver(id)?.driver.stopUnverifiable?.() !== true ? this.reason(id) : undefined;
  }

  private update(id: string, change: Partial<StopRecord>) {
    const next = { ...this.records.get(id), ...change };
    if (next.block || next.driver || next.recheck) this.records.set(id, next);
    else this.records.delete(id);
  }
  load(id: string, block: StopBlock) { this.update(id, { block }); }
  setBlock(id: string, block?: StopBlock) {
    this.versions.set(id, this.version(id) + 1);
    this.update(id, { block });
  }
  setDriver(id: string, driver?: BlockedDriver) { this.update(id, { driver }); }
  setRecheck(id: string, recheck?: Recheck) {
    clearTimeout(this.recheck(id)?.timer);
    this.update(id, { recheck });
  }
  clearRechecks() {
    for (const [id, record] of this.records) if (record.recheck) this.setRecheck(id);
  }
}

const checks = {
  drain: ['capacity_wait', 'pty_retirement', 'shutting_down', 'queue_held', 'initialization_failed', 'queue_blocked',
    'resource_queue_blocked', 'driver_retiring', 'stop_running', 'stop_unverified', 'blocked_driver', 'lifecycle_invalid',
    'drain_active', 'attempt_active', 'verification_active', 'steering_active', 'verification_blocked', 'queue_empty'],
  held: ['attempt_active', 'turn_active', 'steering_active', 'verification_active', 'stop_unverified', 'blocked_driver',
    'stop_running', 'driver_retiring', 'verification_blocked'],
  idle_reclaim: ['shutting_down', 'driver_replaced', 'lifecycle_revoked', 'recovery_in_flight', 'blocked_driver',
    'driver_retiring', 'steering_active', 'verification_active', 'permission_pending', 'answer_pending', 'background_work',
    'driver_detached', 'driver_not_idle', 'unresolved_tasks', 'queued_or_running']
} as const;
type Purpose = keyof typeof checks;
type Code = typeof checks[Purpose][number];
export type GateReason = { code: 'stop_unverified' | 'blocked_driver'; reason: string } | { code: Exclude<Code, 'stop_unverified' | 'blocked_driver'> };
type ReadFact = (id: string, driver?: AgentDriver) => boolean;
type ExternalFacts = Record<Exclude<Code, 'stop_unverified' | 'blocked_driver' | 'background_work' | 'driver_detached' | 'driver_not_idle'>, ReadFact>;

export class SessionGate {
  get stops() { return this.stopFacts(); }
  constructor(private readonly facts: ExternalFacts, private readonly hasDriver: (id: string) => boolean,
    private readonly taskStatus: (id: string) => TaskRecord['status'] | undefined,
    private readonly stopFacts: () => Pick<DriverStopState, 'block' | 'driver' | 'reason' | 'recheckingReason'>) {}

  reasons(id: string, purpose: Purpose, options: { driver?: AgentDriver; firstOnly?: boolean } = {}): GateReason[] {
    const result: GateReason[] = [];
    for (const code of checks[purpose]) {
      if (code === 'stop_unverified' || code === 'blocked_driver') {
        const stop = code === 'stop_unverified' ? this.stops.block(id) : this.stops.driver(id);
        if (stop) result.push({ code, reason: stop.reason });
      } else {
        let blocked: boolean;
        switch (code) {
          case 'background_work': blocked = options.driver?.hasBackgroundWork?.() === true; break;
          case 'driver_detached': blocked = options.driver?.isDetachedForShutdown?.() === true; break;
          case 'driver_not_idle': blocked = options.driver?.isIdle?.() !== true; break;
          default: blocked = this.facts[code](id, options.driver);
        }
        if (blocked) result.push({ code });
      }
      // Admission must short-circuit before calling driver/host probes or consulting the ledger.
      if (options.firstOnly && result.length) break;
    }
    return result;
  }

  stuckWorkspaceBlockers(blockers: ExecutionBlocker[]) {
    const status = (block: ExecutionBlocker) => block.taskId ? this.taskStatus(block.taskId) : undefined;
    const busy = new Set(blockers.filter(block => ['running', 'queued'].includes(status(block) ?? '') ||
      this.facts.attempt_active(block.sessionId)).map(block => block.sessionId));
    const stuck = new Map<string, { block: ExecutionBlocker; unknown: boolean }>();
    for (const block of blockers) {
      if (busy.has(block.sessionId) || stuck.has(block.sessionId)) continue;
      const unknown = status(block) === 'reconcile_required';
      if (!unknown && block.code === 'WORKSPACE_PHYSICAL_RESOURCE_UNSAFE' && this.hasDriver(block.sessionId)
        && this.stops.reason(block.sessionId) === undefined) continue;
      stuck.set(block.sessionId, { block, unknown });
    }
    return stuck.values();
  }
}
