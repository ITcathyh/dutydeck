import type { FastifyBaseLogger } from 'fastify';
import { ShutdownPhases } from '../shutdown-phases.js';

// Groups run in order. Within a group all stops begin before waiting for any one.
const stopOrder = [
  ['insight'], ['historyRetention'], ['watch'], ['pluginResults'],
  ['workbench', 'workbenchHttp', 'workItems', 'delegations', 'leaderMode', 'automation', 'ciWebhook', 'pullRequests'],
  ['relayClose'], ['collaboration', 'relayFlush', 'http', 'runtime'],
  ['capabilities'], ['database'], ['pluginDispose'],
] as const;
type Phase = typeof stopOrder[number][number];
type Operation = () => unknown;

export class ServerLifecycle {
  readonly phases = new ShutdownPhases(stopOrder.flat());
  private readonly stops = new Map<Phase, Operation>();
  private readonly rollback: Operation[] = [];
  private readonly quiesce = new Map<Phase, Operation>();
  private assembled = false;
  private closing?: Promise<void>;

  constructor(private readonly log: FastifyBaseLogger) {}

  // Until all core services exist, setup failures release acquired resources
  // concurrently, in reverse registration order, with SQLite closed last.
  onSetupFailure(stop: Operation) { this.rollback.push(stop); }

  register(phase: Phase, stop: Operation, duringSetup = true) {
    this.stops.set(phase, stop);
    if (duringSetup) this.onSetupFailure(stop);
  }

  beforeStop(phase: Phase, operation: Operation) { this.quiesce.set(phase, operation); }

  assembledCore() { this.assembled = true; }

  close = (): Promise<void> => this.closing ??= this.shutdown();

  private async shutdown() {
    const errors: unknown[] = [];
    if (!this.assembled) {
      try { await this.stops.get('insight')?.(); } catch (error) { errors.push(error); }
      const results = await Promise.allSettled(this.rollback.reverse().map(stop => Promise.resolve().then(stop)));
      await this.stops.get('database')?.();
      for (const result of results) if (result.status === 'rejected') errors.push(result.reason);
      if (errors.length) throw new AggregateError(errors, 'Dutydeck setup cleanup failed');
      return;
    }
    for (const group of stopOrder) {
      if (group[0] === 'historyRetention') {
        for (const phase of ['http', 'automation', 'collaboration'] as const) this.quiesce.get(phase)?.();
      }
      const results = await Promise.allSettled(group.map(name => this.phases.run(name, () => this.stops.get(name)?.())));
      for (const result of results) if (result.status === 'rejected') errors.push(result.reason);
    }
    this.log.info({ shutdownMs: this.phases.durationsMs() }, '停服各阶段耗时');
    if (errors.length) throw new AggregateError(errors, 'Dutydeck did not shut down cleanly');
  }
}
