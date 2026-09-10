import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepositories } from '@dutydeck/storage';
import { DutydeckRuntime } from '@dutydeck/runtime';
import {
  DriverDetachedError,
  DriverRecoveryError,
  RuntimeError,
  type AgentConfig,
  type AgentDriver,
  type DriverFactory,
  type DriverTurnRecovery,
  type NormalizedDriverEvent,
} from '@dutydeck/shared';
import { larkBotsConfigKey, type StoredLarkConfig } from './config.js';
import { LarkMessageCoordinator } from './coordinator.js';
import type { LarkMessageEvent } from './listener.js';

const directories: string[] = [];
const runtimes: DutydeckRuntime[] = [];
const repositories: ReturnType<typeof createRepositories>[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.shutdown();
  for (const repos of repositories.splice(0)) repos.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const agent: AgentConfig = {
  id: 'persistent', name: 'Persistent', command: 'unused', args: [], protocol: 'pty-cli', cwd: '/tmp', env: {},
  permissionMode: 'full-trust', timeout: 30, capabilities: { pause: false, resume: true }, builtin: false,
};

const config: StoredLarkConfig = {
  appId: 'cli_recovery', appSecret: 'fake-secret', workspace: '/tmp', defaultAgentId: agent.id,
  permissionMode: 'full-trust', listening: true, fullTrustConfirmed: true, preInjectPrompt: '',
  groupToolsEnabled: false, groupToolsAllowSend: false, pushIntervalMs: 60_000, hideTraceOnComplete: false,
  allowedUsers: [], allowedEmails: [], allowedBots: [], peerBotsAllowed: false,
  highRiskAllowedUsers: [], highRiskAllowedEmails: [], highRiskPattern: 'dangerous', riskControlMode: 'off',
};

const message: LarkMessageEvent = {
  messageId: 'om_original', chatId: 'ou_requester', chatType: 'p2p', messageType: 'text',
  content: JSON.stringify({ text: '完成原始任务' }), senderOpenId: 'ou_requester', senderType: 'user', mentions: [],
};

function persistentBackend() {
  const log: NormalizedDriverEvent[] = [];
  const prompts: string[] = [];
  const drivers: AgentDriver[] = [];
  let attached: { emit(event: NormalizedDriverEvent): void; resolve(): void; reject(error: Error): void } | undefined;
  let completed = false;
  let turnId = '';
  let serial = 0;

  const wait = (emit: (event: NormalizedDriverEvent) => void) => new Promise<void>((resolve, reject) => {
    attached = { emit, resolve, reject };
  });
  const factory: DriverFactory = (_agent, _protocol, emit) => {
    let recovery: DriverTurnRecovery;
    const driver: AgentDriver = {
      start: vi.fn(async () => {}), resume: vi.fn(async () => {}), interrupt: vi.fn(async () => {}),
      checkpoint: () => (recovery = {
        kind: 'pty-jsonl-v1', turnId: `turn_${++serial}`, transcript: { path: '/owned/transcript', offset: log.length },
      }),
      send: vi.fn(async prompt => {
        prompts.push(prompt);
        turnId = recovery.turnId;
        completed = false;
        return wait(emit);
      }),
      recover: vi.fn(async state => {
        if (state.turnId !== turnId) throw new DriverRecoveryError('原任务提交状态无法确认，未重新发送指令');
        const pending = wait(emit);
        for (const event of log.slice(state.transcript.offset)) emit(event);
        if (completed) {
          emit({ type: 'completed', data: { stopReason: 'end_turn' } });
          attached!.resolve();
        }
        return pending;
      }),
      stop: vi.fn(async () => { attached?.reject(new DriverDetachedError()); attached = undefined; }),
    };
    drivers.push(driver);
    return driver;
  };
  return {
    factory, prompts, drivers,
    publish(text: string) {
      const event: NormalizedDriverEvent = { type: 'text', data: { text }, sourceId: `record_${log.length}` };
      log.push(event);
      attached?.emit(event);
    },
    complete() {
      completed = true;
      attached?.emit({ type: 'completed', data: { stopReason: 'end_turn' } });
      attached?.resolve();
    },
  };
}

function database() {
  const directory = mkdtempSync(join(tmpdir(), 'dutydeck-lark-daemon-recovery-'));
  directories.push(directory);
  return join(directory, 'state.db');
}

function open(file: string, factory: DriverFactory, options: ConstructorParameters<typeof DutydeckRuntime>[1] = {}) {
  const repos = createRepositories(file);
  const runtime = new DutydeckRuntime(repos, {
    driverFactory: factory,
    probe: () => ({ available: true, protocol: 'pty-cli', pause: false, resume: true }),
    ...options,
  });
  repositories.push(repos);
  runtimes.push(runtime);
  return { repos, runtime };
}

async function close(handle: ReturnType<typeof open>) {
  await handle.runtime.shutdown();
  handle.repos.close();
  runtimes.splice(runtimes.indexOf(handle.runtime), 1);
  repositories.splice(repositories.indexOf(handle.repos), 1);
}

function cardService() {
  let cards = 0;
  return {
    addReaction: vi.fn(async () => ({ reactionId: 'reaction-original' })),
    deleteReaction: vi.fn(async () => {}),
    send: vi.fn(async () => ({ messageId: `om_card_${++cards}` })),
    update: vi.fn(async (input: { messageId: string }) => ({ messageId: input.messageId })),
    getUserEmails: vi.fn(async () => []),
  };
}

function coordinator(handle: ReturnType<typeof open>, service: ReturnType<typeof cardService>) {
  return new LarkMessageCoordinator(
    handle.runtime, service as any, { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, Math.random, 'ou_bot',
    undefined, handle.repos.channelMappings, undefined, undefined, undefined, { store: handle.repos.config },
  );
}

async function prepareFirstDaemon(file: string, backend: ReturnType<typeof persistentBackend>, service: ReturnType<typeof cardService>) {
  const first = open(file, backend.factory);
  await first.runtime.initialize([agent]);
  await first.repos.config.set(larkBotsConfigKey, JSON.stringify([config]));
  const firstCoordinator = coordinator(first, service);
  await firstCoordinator.initializeWorkflows(config);
  await firstCoordinator.handle(message, config);
  await vi.waitFor(() => expect(backend.prompts).toHaveLength(1));
  await vi.waitFor(async () => {
    const inbox = await first.repos.config.get(`lark.inbox.${config.appId}.${message.messageId}`);
    expect(JSON.parse(inbox!)).toMatchObject({ state: 'accepted' });
  });
  await vi.waitFor(async () => expect(await first.repos.channelMappings.list(`lark-card:${config.appId}`)).toHaveLength(1));
  return { first, firstCoordinator };
}

describe('daemon restart recovery through Runtime and Lark workflow coordinator', () => {
  it.each([false, true])('keeps the card running throughout restart and delivers one result (listener stops first: %s)', async listenerFirst => {
    const file = database();
    const backend = persistentBackend();
    const service = cardService();
    const { first, firstCoordinator } = await prepareFirstDaemon(file, backend, service);
    backend.publish('重启前的已有进度');
    const [session] = await first.runtime.listSessions();
    await vi.waitFor(async () => expect((await first.runtime.getEvents(session!.id)).some(event => event.data?.text === '重启前的已有进度')).toBe(true));
    const [before] = await first.repos.channelMappings.list(`lark-card:${config.appId}`);
    const originalCardId = JSON.parse(before!.extra!).card_message_id;
    const originalStartedAt = JSON.parse(before!.extra!).started_at;

    if (listenerFirst) firstCoordinator.stop();
    await close(first);
    firstCoordinator.stop();
    expect([...service.send.mock.calls, ...service.update.mock.calls].some(([input]) => ['failed', 'interrupted', 'completed'].includes(input.state))).toBe(false);

    const second = open(file, backend.factory);
    await second.runtime.initialize([agent]);
    const saves = vi.spyOn(second.repos.channelMappings, 'save');
    const updateOffset = service.update.mock.calls.length;
    const restored = coordinator(second, service);
    await restored.initializeWorkflows(config);
    await vi.waitFor(() => expect(backend.drivers[1]!.recover).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(service.update.mock.calls.slice(updateOffset).some(([input]) => input.messageId === originalCardId && input.state === 'running')).toBe(true));
    await restored.startReconciliation(config);
    expect([...service.send.mock.calls, ...service.update.mock.calls].some(([input]) => ['failed', 'interrupted', 'completed'].includes(input.state))).toBe(false);
    expect(service.update.mock.calls.slice(updateOffset).some(([input]) => input.state === 'queued')).toBe(false);
    expect(JSON.stringify(service.update.mock.calls.slice(updateOffset))).toContain('重启前的已有进度');
    expect(saves).toHaveBeenCalled();
    for (const [saved] of saves.mock.calls) {
      expect(JSON.parse(saved.extra!)).toMatchObject({ runtime_task_id: JSON.parse(before!.extra!).runtime_task_id, started_at: originalStartedAt });
    }

    backend.publish('恢复后的结果');
    backend.complete();
    await vi.waitFor(async () => expect((await second.runtime.getTasks((await second.runtime.listSessions())[0]!.id))[0]?.status).toBe('completed'));
    await vi.waitFor(async () => {
      const [mapping] = await second.repos.channelMappings.list(`lark-card:${config.appId}`);
      expect(JSON.parse(mapping!.extra!)).toMatchObject({
        card_message_id: originalCardId, state: 'completed', final_delivery_state: 'delivered',
      });
    });

    expect(backend.prompts).toHaveLength(1);
    expect(backend.prompts[0]).toContain('完成原始任务');
    expect((await second.runtime.getTasks((await second.runtime.listSessions())[0]!.id))).toHaveLength(1);
    expect(service.send.mock.calls.filter(([input]) => input.state === 'completed' && input.readOnly === true)).toHaveLength(1);
    expect(JSON.parse((await second.repos.config.get(`lark.inbox.${config.appId}.${message.messageId}`))!)).toMatchObject({ state: 'accepted' });

    restored.stop();
  });

  it.each(['start', 'dispatch'] as const)('defers a request rejected by daemon shutdown at %s without delivering a failure card', async phase => {
    const file = database(); const backend = persistentBackend(); const service = cardService();
    const first = open(file, backend.factory);
    await first.runtime.initialize([agent]);
    await first.repos.config.set(larkBotsConfigKey, JSON.stringify([config]));
    const operation = vi.spyOn(first.runtime, phase).mockRejectedValueOnce(new RuntimeError('RUNTIME_SHUTTING_DOWN', 'Dutydeck is shutting down', 503));
    const original = coordinator(first, service);
    await original.initializeWorkflows(config);
    await original.handle(message, config);
    await vi.waitFor(() => expect(operation).toHaveBeenCalledOnce());
    // handle queues runTurn, so await that turn before inspecting its receipt.
    await (original as any).groups.values().next().value.tail;
    const inbox = JSON.parse((await first.repos.config.get(`lark.inbox.${config.appId}.${message.messageId}`))!);
    expect(inbox.state).toBe('received');
    expect([...service.send.mock.calls, ...service.update.mock.calls].some(([input]) => ['failed', 'interrupted', 'completed'].includes(input.state))).toBe(false);
    original.stop(); await close(first);

    const second = open(file, backend.factory);
    await second.runtime.initialize([agent]);
    const restored = coordinator(second, service);
    await restored.initializeWorkflows(config);
    await vi.waitFor(() => expect(backend.prompts).toHaveLength(1));
    backend.publish('自动恢复结果'); backend.complete();
    await vi.waitFor(() => expect(service.send.mock.calls.filter(([input]) => input.state === 'completed' && input.readOnly)).toHaveLength(1));
    expect([...service.send.mock.calls, ...service.update.mock.calls].some(([input]) => ['failed', 'interrupted'].includes(input.state))).toBe(false);
    const [mapping] = await second.repos.channelMappings.list(`lark-card:${config.appId}`);
    if (inbox.cardId) expect(JSON.parse(mapping!.extra!).card_message_id).toBe(inbox.cardId);
    restored.stop();
  });

  it('keeps the original card and task running when another restart interrupts recovery setup', async () => {
    const file = database(); const backend = persistentBackend(); const service = cardService();
    const { first, firstCoordinator } = await prepareFirstDaemon(file, backend, service);
    const [session] = await first.runtime.listSessions();
    const [originalTask] = await first.runtime.getTasks(session!.id);
    const [mapping] = await first.repos.channelMappings.list(`lark-card:${config.appId}`);
    const cardId = JSON.parse(mapping!.extra!).card_message_id;
    firstCoordinator.stop(); await close(first);

    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const authorize = vi.fn(() => gate);
    const second = open(file, backend.factory, { authorizeExecution: authorize });
    await second.runtime.initialize([agent]);
    await vi.waitFor(() => expect(authorize).toHaveBeenCalledOnce());
    const recovering = coordinator(second, service);
    await recovering.initializeWorkflows(config);
    // Leave card subscribers live while Runtime shuts down so a transient
    // interrupted/failed task cannot be hidden by listener teardown ordering.
    const stopping = second.runtime.shutdown();
    release(); await stopping;
    expect((await second.runtime.getTasks(session!.id))[0]?.status).toBe('running');
    expect([...service.send.mock.calls, ...service.update.mock.calls].some(([input]) => ['failed', 'interrupted', 'completed'].includes(input.state))).toBe(false);
    recovering.stop(); await close(second);

    const third = open(file, backend.factory);
    await third.runtime.initialize([agent]);
    const restored = coordinator(third, service);
    await restored.initializeWorkflows(config);
    await vi.waitFor(() => expect(backend.drivers[1]!.recover).toHaveBeenCalledOnce());
    backend.publish('连续重启后的最终结果'); backend.complete();
    await vi.waitFor(async () => {
      const [current] = await third.repos.channelMappings.list(`lark-card:${config.appId}`);
      expect(JSON.parse(current!.extra!)).toMatchObject({ card_message_id: cardId, state: 'completed', final_delivery_state: 'delivered' });
    });
    expect((await third.runtime.getTasks(session!.id)).map(task => task.id)).toEqual([originalTask!.id]);
    expect(backend.prompts).toHaveLength(1);
    expect([...service.send.mock.calls, ...service.update.mock.calls].some(([input]) => ['failed', 'interrupted'].includes(input.state))).toBe(false);
    expect(service.send.mock.calls.filter(([input]) => input.state === 'completed' && input.readOnly)).toHaveLength(1);
    restored.stop();
  });

  it('reconciles an offline-completed task once when listener startup follows Runtime recovery', async () => {
    const file = database();
    const backend = persistentBackend();
    const service = cardService();
    const { first, firstCoordinator } = await prepareFirstDaemon(file, backend, service);
    firstCoordinator.stop();
    await close(first);

    backend.publish('停机期间完成的结果');
    backend.complete();

    const second = open(file, backend.factory);
    await second.runtime.initialize([agent]);
    await vi.waitFor(async () => {
      const [session] = await second.runtime.listSessions();
      expect((await second.runtime.getTasks(session!.id))[0]?.status).toBe('completed');
    });
    const restored = coordinator(second, service);
    await restored.initializeWorkflows(config);
    await restored.startReconciliation(config);
    const resultsAfterStart = service.send.mock.calls.filter(([input]) => input.state === 'completed' && input.readOnly === true);
    expect(resultsAfterStart).toHaveLength(1);

    expect(await restored.reconcile(config)).toBe(0);
    expect(service.send.mock.calls.filter(([input]) => input.state === 'completed' && input.readOnly === true)).toHaveLength(1);
    expect(backend.prompts).toHaveLength(1);
    expect(backend.prompts[0]).toContain('完成原始任务');

    restored.stop();
  });
});
