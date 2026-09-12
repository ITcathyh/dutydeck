import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { RelayAskBroker } from '@dutydeck/relay';
import { createRepositories } from '@dutydeck/storage';
import { createRelayAskStore } from '../relay-ask-store.js';
import { LarkWorkflowInteractions, type LarkInteraction, type LarkInteractionContext } from './workflow-interactions.js';
import type { LarkCardService } from './service.js';
import type { AgentEvent, PermissionRequestData, TaskRecord } from '@dutydeck/shared';
import type { LarkMessageEvent, LarkRuntime } from './listener.js';

const larkMessage = (overrides: Partial<LarkMessageEvent> = {}): LarkMessageEvent => ({
  messageId: 'om_trigger',
  chatId: 'oc_chat',
  chatType: 'group',
  messageType: 'text',
  content: '{"text":"开始"}',
  mentions: [],
  ...overrides
});

const context = (overrides: Partial<LarkInteractionContext> = {}): LarkInteractionContext => ({
  appId: 'app_one',
  sessionId: 'ses_one',
  taskId: 'task_one',
  turn: 1,
  event: larkMessage(),
  ...overrides
});

const agentEvent = (type: AgentEvent['type'], data: unknown, overrides: Partial<AgentEvent> = {}): AgentEvent => ({
  id: 'event_one',
  sessionId: 'ses_one',
  sequence: 1,
  type,
  timestamp: new Date().toISOString(),
  data,
  ...overrides
});

const runningTask = (overrides: Partial<TaskRecord> = {}): TaskRecord => ({
  id: 'task_one',
  sessionId: 'ses_one',
  prompt: '执行任务',
  status: 'running',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...overrides
});

const interaction = (overrides: Partial<LarkInteraction> = {}): LarkInteraction => ({
  ...context(),
  id: 'interaction_one',
  boot: 'old_boot',
  kind: 'ask',
  nativeId: 'native_one',
  question: '继续吗？',
  state: 'pending',
  cardId: 'card_one',
  updatedAt: new Date().toISOString(),
  ...overrides
});

type ResponseInput = Parameters<LarkWorkflowInteractions['respond']>[0];
const responseInput = (record: LarkInteraction, overrides: Partial<ResponseInput> = {}): ResponseInput => ({
  appId: record.appId,
  chatId: record.event.chatId,
  actorId: 'user_one',
  requestId: record.id,
  action: 'answer',
  answer: '可以',
  cardId: record.cardId,
  generation: record.boot,
  callback: true,
  ...overrides
});

const openDatabase = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dutydeck-lark-workflow-'));
  const filename = join(directory, 'state.db');
  return { directory, filename, repositories: createRepositories(filename) };
};

const makeService = () => {
  let cardNumber = 0;
  const reply = vi.fn(async () => ({ messageId: `om_card_${++cardNumber}` }));
  return { reply, service: { reply, update: vi.fn(async () => ({})) } as unknown as LarkCardService };
};

const makeRuntime = (tasks: TaskRecord[], permissions: PermissionRequestData[], resolvePermission = vi.fn(async () => undefined)) => {
  const getTasks = vi.fn(async () => tasks);
  const getPendingPermissions = vi.fn(async () => permissions);
  const runtime = { getTasks, getPendingPermissions, resolvePermission } as unknown as LarkRuntime;
  return { runtime, getTasks, getPendingPermissions, resolvePermission };
};

const persistInteraction = async (config: { set(key: string, value: string): Promise<void> }, record: LarkInteraction) => {
  await config.set(`lark.interaction.${record.appId}.${record.id}`, JSON.stringify(record));
};

const legacyResult = (ctx: LarkInteractionContext, overrides: Partial<LarkInteraction> = {}): LarkInteraction => ({
  ...interaction({ ...ctx, kind: 'result', nativeId: ctx.taskId, question: '结果验收', boot: 'legacy_boot', ...overrides }),
  id: createHash('sha256').update([ctx.appId, ctx.sessionId, ctx.taskId, ctx.turn, 'result', ctx.taskId, ''].join('\0')).digest('hex').slice(0, 24)
});

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};

describe('persistent Lark workflow interactions', () => {
  it('shows supplied tool facts and one-request scope in the permission card', async () => {
    const { directory, repositories } = await openDatabase();
    try {
      const permissions: PermissionRequestData[] = [{ id: 'perm_facts', title: '运行检查', status: 'pending', operation: { source: 'acp_tool_call', cwd: '/work/project', resource: '/work/project/config.ts', command: 'pnpm test --token=synthetic-secret' } }];
      const { runtime } = makeRuntime([runningTask()], permissions);
      const { service, reply } = makeService();
      const workflow = new LarkWorkflowInteractions(repositories.config, runtime, service, undefined, async () => true);
      await workflow.observe(context(), agentEvent('permission_request', permissions[0]));
      const card = JSON.stringify(reply.mock.calls);
      expect(card).toContain('来源：执行端工具请求');
      expect(card).toContain('目录：/work/project');
      expect(card).toContain('资源：/work/project/config.ts');
      expect(card).toContain('pnpm test --token=[REDACTED]');
      expect(card).not.toContain('synthetic-secret');
      expect(card).toContain('本次选择只处理这一条请求');
      expect(card).toContain('允许本次');
    } finally { repositories.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it('retries an undelivered live permission with the same UUID and excludes concurrent deliveries', async () => {
    const { directory, repositories } = await openDatabase();
    const at = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(at);
    try {
      const permissions: PermissionRequestData[] = [{ id: 'perm_delivery', title: '确认写入', status: 'pending' }];
      const { runtime } = makeRuntime([runningTask()], permissions);
      const { service, reply } = makeService();
      reply.mockRejectedValueOnce(new Error('temporary card delivery failure'));
      const workflow = new LarkWorkflowInteractions(repositories.config, runtime, service, undefined, async () => true);
      const emitted = agentEvent('permission_request', permissions[0]);
      await expect(workflow.observe(context(), emitted)).rejects.toThrow('temporary card delivery failure');
      expect((await workflow.list('app_one'))[0]).toMatchObject({ state: 'pending', nativeId: 'perm_delivery' });
      expect((await workflow.list('app_one'))[0]?.cardId).toBeUndefined();
      await workflow.observe(context(), emitted);
      expect(reply).toHaveBeenCalledOnce();
      clock.mockReturnValue(at + 5_001);
      const gate = deferred();
      reply.mockImplementationOnce(async () => { await gate.promise; return { messageId: 'om_retried' }; });
      const retry = workflow.observe(context(), emitted);
      await vi.waitFor(() => expect(reply).toHaveBeenCalledTimes(2));
      await workflow.observe(context(), emitted);
      gate.resolve(); await retry;
      expect(reply).toHaveBeenCalledTimes(2);
      expect((reply.mock.calls[0] as any)[0].idempotencyKey).toBe((reply.mock.calls[1] as any)[0].idempotencyKey);
      expect((await workflow.list('app_one'))[0]).toMatchObject({ state: 'pending', cardId: 'om_retried' });
      await expect(workflow.respond(responseInput((await workflow.list('app_one'))[0]!, { action: 'approve' }))).resolves.toContain('已接受');
    } finally { clock.mockRestore(); repositories.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it('rejects missing identity, wrong chat/card/boot/kind, revoked permissions, and ended tasks', async () => {
    const { directory, repositories } = await openDatabase();
    try {
      const tasks = [runningTask()];
      const permissions: PermissionRequestData[] = [{ id: 'perm_one', title: '执行命令', status: 'pending' }];
      const { runtime, resolvePermission } = makeRuntime(tasks, permissions);
      const { service } = makeService();
      const authorize = vi.fn(async () => true);
      const workflow = new LarkWorkflowInteractions(repositories.config, runtime, service, undefined, authorize);
      const ask = interaction({ id: 'ask_validation', nativeId: 'ask_native' });
      const permission = interaction({ id: 'permission_validation', kind: 'permission', nativeId: 'perm_one', question: '批准命令？', cardId: 'card_permission' });
      await persistInteraction(repositories.config, ask);
      await persistInteraction(repositories.config, permission);

      const validAsk = responseInput(ask);
      await expect(workflow.respond({ ...validAsk, actorId: undefined })).rejects.toMatchObject({ code: 'LARK_INTERACTION_EXPIRED' });
      await expect(workflow.respond({ ...validAsk, chatId: 'oc_other_chat' })).rejects.toMatchObject({ code: 'LARK_INTERACTION_EXPIRED' });
      await expect(workflow.respond({ ...validAsk, cardId: 'card_other' })).rejects.toMatchObject({ code: 'LARK_INTERACTION_EXPIRED' });
      await expect(workflow.respond({ ...validAsk, generation: 'boot_other' })).rejects.toMatchObject({ code: 'LARK_INTERACTION_EXPIRED' });
      await expect(workflow.respond({ ...validAsk, action: 'approve' })).rejects.toMatchObject({ code: 'LARK_INTERACTION_EXPIRED' });

      tasks[0]!.status = 'completed';
      await expect(workflow.respond(validAsk)).rejects.toMatchObject({ code: 'LARK_INTERACTION_EXPIRED' });
      expect((await workflow.list('app_one')).find(record => record.id === ask.id)?.state).toBe('expired');

      tasks[0]!.status = 'running';
      permissions.splice(0);
      await expect(workflow.respond(responseInput(permission, { action: 'approve' })))
        .rejects.toMatchObject({ code: 'LARK_INTERACTION_EXPIRED' });
      expect(resolvePermission).not.toHaveBeenCalled();
      expect((await workflow.list('app_one')).find(record => record.id === permission.id)?.state).toBe('expired');
    } finally {
      repositories.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('expires old-boot permission and ask interactions after a file reopen without resolving either', async () => {
    const { directory, filename, repositories } = await openDatabase();
    let reopened = false;
    try {
      const firstBroker = new RelayAskBroker({ publish: async () => undefined }, createRelayAskStore(repositories.config));
      const waiting = firstBroker.register({ sessionId: 'ses_one', question: '旧问题？' });
      await vi.waitFor(() => expect(firstBroker.listPending()).toHaveLength(1));
      const ask = firstBroker.listPending()[0]!;
      const oldAsk = interaction({ id: 'old_ask_interaction', boot: 'boot_before_restart', nativeId: ask.id, cardId: 'card_old_ask' });
      const oldPermission = interaction({ id: 'old_permission_interaction', boot: 'boot_before_restart', kind: 'permission', nativeId: 'perm_old', cardId: 'card_old_permission' });
      await persistInteraction(repositories.config, oldAsk);
      await persistInteraction(repositories.config, oldPermission);
      firstBroker.close('old process stopped');
      await firstBroker.flush();
      await expect(waiting).resolves.toMatchObject({ status: 'cancelled' });
      repositories.close();
      reopened = true;

      const reopenedRepositories = createRepositories(filename);
      try {
        const secondBroker = new RelayAskBroker({ publish: async () => undefined }, createRelayAskStore(reopenedRepositories.config));
        await secondBroker.initialize();
        const tasks = [runningTask()];
        const permissions: PermissionRequestData[] = [{ id: 'perm_old', title: '旧权限', status: 'pending' }];
        const { runtime, resolvePermission } = makeRuntime(tasks, permissions);
        const { service } = makeService();
        const workflow = new LarkWorkflowInteractions(reopenedRepositories.config, runtime, service, secondBroker, async () => true);
        await workflow.initialize('app_one');
        const records = await workflow.list('app_one');
        expect(records).toHaveLength(2);
        expect(records.every(record => record.state === 'expired')).toBe(true);
        expect(resolvePermission).not.toHaveBeenCalled();
        await expect(secondBroker.answer(ask.id, '不应送达')).rejects.toMatchObject({ code: 'RELAY_ASK_SETTLED' });
        await secondBroker.flush();
      } finally {
        reopenedRepositories.close();
      }
    } finally {
      if (!reopened) repositories.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('creates one card for duplicate ask events and answers it through the real broker store', async () => {
    const { directory, repositories } = await openDatabase();
    try {
      const tasks = [runningTask()];
      const { runtime } = makeRuntime(tasks, []);
      const { service, reply } = makeService();
      const broker = new RelayAskBroker({ publish: async () => undefined }, createRelayAskStore(repositories.config));
      const workflow = new LarkWorkflowInteractions(repositories.config, runtime, service, broker, async () => true);
      const waiting = broker.register({ sessionId: 'ses_one', question: '需要回答吗？' });
      await vi.waitFor(() => expect(broker.listPending()).toHaveLength(1));
      const askId = broker.listPending()[0]!.id;
      const interactionContext = context({ event: larkMessage({ messageId: 'om_question' }) });
      const event = agentEvent('text', { relay: 'ask', askId });

      await workflow.observe(interactionContext, event);
      await workflow.observe(interactionContext, event);
      expect(reply).toHaveBeenCalledTimes(1);
      const records = await workflow.list('app_one');
      expect(records).toHaveLength(1);
      const record = records[0]!;
      expect(record.kind).toBe('ask');
      const response = await workflow.respond(responseInput(record, { action: 'answer', answer: '可以' }));
      expect(response).toBe('回答已送达原任务。');
      await expect(waiting).resolves.toMatchObject({ status: 'answered', answer: '可以' });
      expect(broker.get(askId)).toMatchObject({ status: 'answered', answer: '可以' });
      await broker.flush();
    } finally {
      repositories.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('lets only one concurrent approval call the runtime resolver', async () => {
    const { directory, repositories } = await openDatabase();
    try {
      const tasks = [runningTask()];
      const permissions: PermissionRequestData[] = [{ id: 'perm_concurrent', title: '执行高风险命令', status: 'pending' }];
      const gate = deferred();
      const resolvePermission = vi.fn(async () => {
        await gate.promise;
        permissions[0]!.status = 'approved';
      });
      const { runtime } = makeRuntime(tasks, permissions, resolvePermission);
      const { service } = makeService();
      const workflow = new LarkWorkflowInteractions(repositories.config, runtime, service, undefined, async () => true);
      const ctx = context({ event: larkMessage({ messageId: 'om_permission' }) });
      await workflow.observe(ctx, agentEvent('permission_request', { id: 'perm_concurrent', title: '执行高风险命令', status: 'pending' }));
      const record = (await workflow.list('app_one'))[0]!;
      const first = workflow.respond(responseInput(record, { action: 'approve' }));
      const second = workflow.respond(responseInput(record, { action: 'approve' }));
      const outcomesPromise = Promise.allSettled([first, second]);
      await vi.waitFor(() => expect(resolvePermission).toHaveBeenCalledTimes(1));
      gate.resolve();
      const outcomes = await outcomesPromise;
      expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
      expect(outcomes.filter(outcome => outcome.status === 'rejected')).toHaveLength(1);
      expect(resolvePermission).toHaveBeenCalledTimes(1);
      expect((await workflow.list('app_one'))[0]).toMatchObject({ state: 'approved', actorId: 'user_one' });
    } finally {
      repositories.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('does not create result feedback for a new completed task', async () => {
    const { directory, repositories } = await openDatabase();
    try {
      const { runtime } = makeRuntime([runningTask({ status: 'completed' })], []);
      const { service } = makeService();
      const workflow = new LarkWorkflowInteractions(repositories.config, runtime, service, undefined, async () => true);
      const ctx = context({ event: larkMessage({ messageId: 'om_result' }) });
      expect(await workflow.result(ctx, 'om_result_card')).toEqual([]);
      expect(await workflow.result(ctx, 'om_result_card')).toEqual([]);
      expect(await workflow.list('app_one')).toEqual([]);
    } finally {
      repositories.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('renders and consumes a persisted legacy result acceptance once without invoking the runtime', async () => {
    const { directory, repositories } = await openDatabase();
    try {
      const tasks = [runningTask({ status: 'completed' })];
      const permissions: PermissionRequestData[] = [];
      const { runtime, getTasks, resolvePermission } = makeRuntime(tasks, permissions);
      const { service } = makeService();
      const workflow = new LarkWorkflowInteractions(repositories.config, runtime, service, undefined, async () => true);
      const ctx = context({ event: larkMessage({ messageId: 'om_result' }) });
      await persistInteraction(repositories.config, legacyResult(ctx));
      const firstCard = await workflow.result(ctx, 'om_result_card');
      const secondCard = await workflow.result(ctx, 'om_result_card');
      expect(secondCard).toEqual(firstCard);
      const record = (await workflow.list('app_one'))[0]!;
      const first = workflow.respond(responseInput(record, { action: 'accept', cardId: 'om_result_card' }));
      const second = workflow.respond(responseInput(record, { action: 'accept', cardId: 'om_result_card' }));
      const outcomes = await Promise.allSettled([first, second]);
      expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
      expect(outcomes.filter(outcome => outcome.status === 'rejected')).toHaveLength(1);
      expect((await workflow.list('app_one'))[0]).toMatchObject({ state: 'accepted', actorId: 'user_one' });
      expect(getTasks).not.toHaveBeenCalled();
      expect(resolvePermission).not.toHaveBeenCalled();
    } finally {
      repositories.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('permission interaction retry after Runtime pre-consumption faults', () => {
  const retryAfterFault = async (message: string) => {
    const { directory, repositories } = await openDatabase();
    try {
      const tasks = [runningTask()];
      const permissions: PermissionRequestData[] = [{ id: 'perm_retry', title: '写入文件', status: 'pending' }];
      const resolvePermission = vi.fn().mockRejectedValueOnce(new Error(message)).mockResolvedValueOnce(undefined);
      const { runtime } = makeRuntime(tasks, permissions, resolvePermission);
      const { service } = makeService();
      const workflow = new LarkWorkflowInteractions(repositories.config, runtime, service, undefined, async () => true);
      await workflow.observe(context(), agentEvent('permission_request', permissions[0]!));
      const record = (await workflow.list('app_one'))[0]!;
      await expect(workflow.respond(responseInput(record, { action: 'approve' }))).rejects.toThrow(message);
      const pending = (await workflow.list('app_one'))[0]!;
      expect(pending).toMatchObject({ id: record.id, state: 'pending' });
      expect((service.update as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(expect.objectContaining({ messageId: record.cardId, statusLabel: '等待审批' }));
      await expect(workflow.respond(responseInput(pending, { action: 'approve' }))).resolves.toBe('执行端已接受本次批准。');
      expect(resolvePermission).toHaveBeenCalledTimes(2);
      expect((await workflow.list('app_one'))[0]).toMatchObject({ id: record.id, state: 'approved' });
    } finally {
      repositories.close();
      await rm(directory, { recursive: true, force: true });
    }
  };

  it('keeps the card pending when Runtime intent persistence fails before driver consumption', async () => {
    await retryAfterFault('intent save unavailable');
  });

  it('keeps the card pending when the Runtime driver throws before consuming the permission', async () => {
    await retryAfterFault('driver transport unavailable');
  });

  it('expires a permission when the Runtime reports an unconsumed driver rejection', async () => {
    const { directory, repositories } = await openDatabase();
    try {
      const permissions: PermissionRequestData[] = [{ id: 'perm_false', title: '拒绝', status: 'pending' }];
      const { runtime } = makeRuntime([runningTask()], permissions, vi.fn(async () => false));
      const { service } = makeService();
      const workflow = new LarkWorkflowInteractions(repositories.config, runtime, service, undefined, async () => true);
      await workflow.observe(context(), agentEvent('permission_request', permissions[0]!));
      const record = (await workflow.list('app_one'))[0]!;
      await expect(workflow.respond(responseInput(record, { action: 'approve' }))).rejects.toMatchObject({ code: 'LARK_INTERACTION_EXPIRED' });
      expect((await workflow.list('app_one'))[0]).toMatchObject({ state: 'expired' });
    } finally {
      repositories.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
