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
  structuredAskCards: false, groupCardMention: false,
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
    let stopped = false;
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
      // This test backend owns no pending persistent turn before its first prompt.
      isStopped: async () => stopped && !turnId,
      stop: vi.fn(async () => { stopped = true; attached?.reject(new DriverDetachedError()); attached = undefined; }),
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
  const repos = createRepositories(file, { newDatabaseAuthority: 'ledger_v1' });
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
    send: vi.fn(async (input: any) => ({ messageId: input?.messageId ?? `om_card_${++cards}`, ...input })),
    update: vi.fn(async (input: any) => ({ messageId: input?.messageId ?? 'om_card', ...input })),
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
  it.each([false, true])('preserves in-flight task in reconcile_required across restart without auto-resend or card corruption (listener stops first: %s)', async listenerFirst => {
    const file = database();
    const backend = persistentBackend();
    const service = cardService();
    const { first, firstCoordinator } = await prepareFirstDaemon(file, backend, service);
    backend.publish('重启前的已有进度');
    const [session] = await first.runtime.listSessions();
    await vi.waitFor(async () => expect((await first.runtime.getEvents(session!.id)).some(event => (event.data as { text?: string })?.text === '重启前的已有进度')).toBe(true));
    const [before] = await first.repos.channelMappings.list(`lark-card:${config.appId}`);
    const originalCardId = JSON.parse(before!.extra!).card_message_id;
    const originalStartedAt = JSON.parse(before!.extra!).started_at;

    if (listenerFirst) firstCoordinator.stop();
    await close(first);
    firstCoordinator.stop();
    expect([...service.send.mock.calls, ...service.update.mock.calls].some(([input]) => ['failed', 'interrupted', 'completed'].includes(input?.state))).toBe(false);

    const second = open(file, backend.factory);
    await second.runtime.initialize([agent]);
    const restored = coordinator(second, service);
    await restored.initializeWorkflows(config);
    await restored.startReconciliation(config);

    // 验证保守安全契约：
    // 1. 重启后原已提交 Attempt 保持在 reconcile_required，不自动标记 running/completed
    const [restoredSession] = await second.runtime.listSessions();
    const tasks = await second.runtime.getTasks(restoredSession!.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.status).toBe('reconcile_required');
    const taskExec = second.repos.execution.getTaskExecution(tasks[0]!.id)!;
    expect(taskExec.attempts).toHaveLength(1);
    expect(taskExec.attempts[0]?.state).toBe('reconcile_required');
    expect(taskExec.attempts[0]?.submission).toBeDefined();

    // 2. 原输出归属保留：重启前进度事件依然可查
    const events = await second.runtime.getEvents(restoredSession!.id);
    expect(events.some(event => (event.data as { text?: string })?.text === '重启前的已有进度')).toBe(true);

    // 3. 不会自动重发/创建替代 Agent，也不会向驱动重复发送
    expect(backend.prompts).toHaveLength(1);
    expect(backend.prompts[0]).toContain('完成原始任务');
    expect(backend.drivers).toHaveLength(1);

    // 4. 原卡不会误报完成或重复发送完成卡
    expect(service.send.mock.calls.some(([input]) => input?.state === 'completed')).toBe(false);
    expect(service.update.mock.calls.some(([input]) => input?.state === 'completed')).toBe(false);

    // 5. 原卡片映射与入站收据状态保持受控
    const [mapping] = await second.repos.channelMappings.list(`lark-card:${config.appId}`);
    expect(JSON.parse(mapping!.extra!)).toMatchObject({ card_message_id: originalCardId, started_at: originalStartedAt });
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
    expect([...service.send.mock.calls, ...service.update.mock.calls].some(([input]) => ['failed', 'interrupted', 'completed'].includes(input?.state))).toBe(false);
    original.stop(); await close(first);

    const second = open(file, backend.factory);
    await second.runtime.initialize([agent]);
    const restored = coordinator(second, service);
    await restored.initializeWorkflows(config);
    await vi.waitFor(() => expect(backend.prompts).toHaveLength(1));
    backend.publish('自动恢复结果'); backend.complete();
    await vi.waitFor(() => expect(service.send.mock.calls.filter(([input]) => input?.state === 'completed' && input?.readOnly)).toHaveLength(1));
    expect([...service.send.mock.calls, ...service.update.mock.calls].some(([input]) => ['failed', 'interrupted'].includes(input?.state))).toBe(false);
    const [mapping] = await second.repos.channelMappings.list(`lark-card:${config.appId}`);
    if (inbox.cardId) expect(JSON.parse(mapping!.extra!).card_message_id).toBe(inbox.cardId);
    restored.stop();
  });

  it('retains in-flight task in reconcile_required across consecutive daemon restarts without duplicate prompts', async () => {
    const file = database(); const backend = persistentBackend(); const service = cardService();
    const { first, firstCoordinator } = await prepareFirstDaemon(file, backend, service);
    const [session] = await first.runtime.listSessions();
    const [originalTask] = await first.runtime.getTasks(session!.id);
    firstCoordinator.stop(); await close(first);

    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const authorize = vi.fn(() => gate);
    const second = open(file, backend.factory, { authorizeExecution: authorize });
    await second.runtime.initialize([agent]);
    const recovering = coordinator(second, service);
    await recovering.initializeWorkflows(config);
    // Leave card subscribers live while Runtime shuts down so a transient
    // interrupted/failed task cannot be hidden by listener teardown ordering.
    const stopping = second.runtime.shutdown();
    release(); await stopping;
    recovering.stop(); await close(second);

    const third = open(file, backend.factory);
    await third.runtime.initialize([agent]);
    const restored = coordinator(third, service);
    await restored.initializeWorkflows(config);
    await restored.startReconciliation(config);

    // 验证保守安全契约：二次重启仍保留原未知状态（reconcile_required），不串旧回调，不重复发 prompt
    const [thirdSession] = await third.runtime.listSessions();
    const tasks = await third.runtime.getTasks(thirdSession!.id);
    expect(tasks.map(task => task.id)).toEqual([originalTask!.id]);
    expect(tasks[0]?.status).toBe('reconcile_required');
    const taskExec = third.repos.execution.getTaskExecution(originalTask!.id)!;
    expect(taskExec.attempts[0]?.state).toBe('reconcile_required');
    expect(backend.prompts).toHaveLength(1);
    expect(service.send.mock.calls.filter(([input]) => input?.state === 'completed')).toHaveLength(0);
    expect([...service.send.mock.calls, ...service.update.mock.calls].some(([input]) => input?.state === 'failed')).toBe(false);

    restored.stop();
  });

  it('keeps offline-completed task in reconcile_required without safe attach evidence rather than fabricating completion', async () => {
    const file = database();
    const backend = persistentBackend();
    const service = cardService();
    const { first, firstCoordinator } = await prepareFirstDaemon(file, backend, service);
    firstCoordinator.stop();
    await close(first);

    // 离线期间后台输出了结果并声称完成，但因为 Runtime 已经关机，没有现场安全 attach/认领凭证
    backend.publish('停机期间完成的结果');
    backend.complete();

    const second = open(file, backend.factory);
    await second.runtime.initialize([agent]);

    // 验证保守安全契约：无安全认领证据时，不能直接把新任务冒充为已完成，仍保持在 reconcile_required 等待核对
    const [session] = await second.runtime.listSessions();
    const tasks = await second.runtime.getTasks(session!.id);
    expect(tasks[0]?.status).toBe('reconcile_required');
    const taskExec = second.repos.execution.getTaskExecution(tasks[0]!.id)!;
    expect(taskExec.attempts[0]?.state).toBe('reconcile_required');

    const restored = coordinator(second, service);
    await restored.initializeWorkflows(config);
    await restored.startReconciliation(config);

    // 原卡不会误报完成
    expect(service.send.mock.calls.filter(([input]) => input?.state === 'completed')).toHaveLength(0);
    expect(backend.prompts).toHaveLength(1);
    expect(backend.prompts[0]).toContain('完成原始任务');

    restored.stop();
  });
});
