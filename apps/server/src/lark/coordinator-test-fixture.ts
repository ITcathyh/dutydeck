import { onTestFinished } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import { randomUUID } from 'node:crypto';
import type { AcceptedTask, AgentEvent } from '@dutydeck/shared';
import { LarkMessageCoordinator } from './coordinator.js';
import { larkBotsConfigKey, type StoredLarkConfig } from './config.js';
import type { LarkRuntime } from './runtime.js';

type Args = ConstructorParameters<typeof LarkMessageCoordinator>;

// Simulated drivers in routing tests provide their own execution and events.
// Model task acceptance separately from the driver's later completion.
export function fixtureRuntime(runtime: LarkRuntime): LarkRuntime {
  if ('dispatchRequest' in runtime && typeof runtime.dispatchRequest === 'function') return runtime;
  const listeners = new Map<string, Set<(event: AgentEvent) => void>>();
  const accepted = new Map<string, AcceptedTask>();
  const history = new Map<string, AgentEvent[]>();
  let sequence = 0;
  function emit(sessionId: string, type: AgentEvent['type'], data: unknown) {
    const event = { id: 'event-' + ++sequence, type, data, sessionId, sequence, timestamp: new Date().toISOString() };
    for (const receive of listeners.get(sessionId) ?? []) receive(event);
  }
  const dispatch: LarkRuntime['dispatchRequest'] = async (request, material = {}) => {
    const { sessionId, prompt, key } = request;
    const actor = request.actor.kind === 'unspecified' ? undefined : request.actor.id;
    const now = new Date().toISOString();
    const task = runtime.dispatch
      ? await runtime.dispatch(sessionId, prompt, 'queue', material.agentPrompt, material.riskPolicy, actor, key, request.skills, request, material.idleCompactHours, material.promptParts)
      : { id: randomUUID(), status: 'running', queuedAhead: 0 };
    const record: AcceptedTask = { request, replayValidation: 'complete',
      task: { ...task, status: task.status as AcceptedTask['task']['status'], sessionId, prompt, revision: 1, digestVersion: 'v1', createdAt: now, updatedAt: now } };
    accepted.set(task.id, record);
    if (!runtime.dispatch) {
      const args: Parameters<LarkRuntime['send']> = [sessionId, prompt, material.agentPrompt];
      if (material.riskPolicy) args.push(material.riskPolicy);
      void new Promise<void>(resolve => setImmediate(resolve)).then(() => {
        emit(sessionId, 'task', { task: { ...record.task } });
        return runtime.send(...args);
      }).then(
        () => { record.task.status = 'completed'; emit(sessionId, 'task', { task: { ...record.task } }); },
        error => { emit(sessionId, 'error', { message: String(error) }); record.task.status = 'failed'; emit(sessionId, 'task', { task: { ...record.task } }); }
      );
    }
    return { ...record.task, queuedAhead: task.queuedAhead ?? 0, replayed: false };
  };
  return {
    ...runtime, dispatchRequest: dispatch,
    async getRecentEvents(id, limit = 500) {
      if (runtime.getRecentEvents) return runtime.getRecentEvents(id, limit);
      const events = runtime.getEvents ? await runtime.getEvents(id) : history.get(id) ?? [];
      return events.slice(-limit);
    },
    getAcceptedTask: runtime.getAcceptedTask ?? (id => accepted.get(id)),
    getAcceptedTaskByKey: runtime.getAcceptedTaskByKey ?? ((namespace, id, key) =>
      [...accepted.values()].find(a => a.request?.sessionId === id && a.request.namespace === namespace && a.request.key === key)),
    subscribe(id, listener) {
      const receive = (event: AgentEvent) => {
        const events = history.get(id) ?? [];
        events.push(event); history.set(id, events);
        listener(event);
      };
      const group = listeners.get(id) ?? new Set(); group.add(receive); listeners.set(id, group);
      const unsubscribe = runtime.subscribe(id, receive);
      return () => { group.delete(receive); unsubscribe?.(); };
    }
  };
}

export function createTestLarkStorage(config?: StoredLarkConfig) {
  const repos = createRepositories(':memory:');
  if (config) repos.transaction(tx => tx.config.set(larkBotsConfigKey, JSON.stringify([config])));
  onTestFinished(() => repos.close());
  return { workflowStore: repos.config, cardMappings: repos.channelMappings };
}

export function createTestLarkCoordinator(config: StoredLarkConfig, runtime: Args[0], service: Args[1], log: Args[2],
  random?: Args[3], bot?: Args[4], peer?: Args[5], mappings?: Args[6], resolve?: Args[7], policy?: Args[8],
  groups?: Args[9], options: Partial<Args[10]> = {}) {
  const memory = createTestLarkStorage(config);
  const coordinator = new LarkMessageCoordinator(fixtureRuntime(runtime), service, log, random, bot, peer, mappings ?? memory.cardMappings,
    resolve, policy, groups, { ...options, store: options.store ?? memory.workflowStore });
  onTestFinished(() => coordinator.stop());
  return Object.assign(coordinator, {
    async handleWithBotConfig(...args: Parameters<typeof coordinator.handle>) {
      const store = options.store ?? memory.workflowStore;
      const bot = args[1];
      const bots = JSON.parse(await store.get(larkBotsConfigKey) ?? '[]') as StoredLarkConfig[];
      await store.set(larkBotsConfigKey, JSON.stringify([...bots.filter(item => item.appId !== bot.appId), bot]));
      return coordinator.handle(...args);
    }
  });
}
