import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { RelayAskBroker, type RelayAskChoice } from '@dutydeck/relay';
import { createRepositories } from '@dutydeck/storage';
import { createRelayAskStore } from '../relay-ask-store.js';
import { buildLarkCard, larkCardSafeLimits } from './service.js';
import { LarkWorkflowInteractions, countCardComponents, type LarkInteraction, type LarkInteractionContext } from './workflow-interactions.js';
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
      expect(service.update).toHaveBeenCalledWith(expect.objectContaining({ messageId: ask.cardId, statusLabel: '已失效', readOnly: true }));

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

describe('structured ask cards (P0-2)', () => {
  interface StructuredHarness {
    directory: string;
    repositories: ReturnType<typeof createRepositories>;
    service: LarkCardService;
    reply: ReturnType<typeof vi.fn>;
    broker: RelayAskBroker;
    workflow: LarkWorkflowInteractions;
    ask: (index: number, choices?: RelayAskChoice[], multiple?: boolean, question?: string)
      => Promise<{ waiting: Promise<unknown>; askId: string; ctx: LarkInteractionContext; event: AgentEvent }>;
    cleanup: () => Promise<void>;
    cardAt: (index: number) => Record<string, any>;
  }

  const setupHarness = async (): Promise<StructuredHarness> => {
    const { directory, repositories } = await openDatabase();
    const { runtime } = makeRuntime([runningTask()], []);
    const { service, reply } = makeService();
    const broker = new RelayAskBroker({ publish: async () => undefined }, createRelayAskStore(repositories.config));
    const workflow = new LarkWorkflowInteractions(repositories.config, runtime, service, broker, async () => true);
    const ask: StructuredHarness['ask'] = async (index, choices, multiple = false, question = '怎么继续？') => {
      // 先前提问可能仍在 pending，也可能已被回答：按「出现新 id」等待本次登记完成，
      // 不能只看 pending 数量，否则会取到上一个 ask 的 id。
      const before = new Set(broker.listPending().map(item => item.id));
      const waiting = broker.register({
        sessionId: 'ses_one', question, timeoutMs: 60_000,
        ...(choices ? { choices } : {}), ...(multiple ? { multiple: true } : {})
      });
      let registerError: unknown;
      void waiting.catch(error => { registerError = error; });
      await vi.waitFor(() => {
        if (registerError) throw registerError;
        if (!broker.listPending().some(item => !before.has(item.id))) throw new Error('提问尚未登记');
      });
      const askId = broker.listPending().find(item => !before.has(item.id))!.id;
      const ctx = context({ event: larkMessage({ messageId: `om_structured_${index}` }) });
      return { waiting, askId, ctx, event: agentEvent('text', { relay: 'ask', askId }) };
    };
    return {
      directory, repositories, service, reply, broker, workflow, ask,
      cleanup: async () => { broker.close(); await broker.flush(); repositories.close(); await rm(directory, { recursive: true, force: true }); },
      cardAt: index => reply.mock.calls[index]![0] as Record<string, any>
    };
  };

  const findRecord = async (workflow: LarkWorkflowInteractions, askId: string) =>
    (await workflow.list('app_one')).find(record => record.nativeId === askId)!;

  it('开关关闭时保留文本卡，选项仍以可读文本显示', async () => {
    const h = await setupHarness();
    try {
      const plain = await h.ask(0);
      const withChoices = await h.ask(1, [{ label: '跑测试' }, { label: '直接合并' }]);
      await h.workflow.observe(plain.ctx, plain.event, { structuredAskCards: false });
      await h.workflow.observe(withChoices.ctx, withChoices.event, { structuredAskCards: false });
      const classic = [
        { tag: 'div', text: { tag: 'plain_text', content: '怎么继续？' } },
        { tag: 'markdown', content: '请引用本卡片回复你的答案。' }
      ];
      expect(h.cardAt(0).elements.filter((element: any) => !element.content?.startsWith('回答截止时间'))).toEqual(classic);
      expect(h.cardAt(1).elements.filter((element: any) => !element.content?.startsWith('回答截止时间'))).toEqual([...classic,
        { tag: 'div', text: { tag: 'plain_text', content: '可选项：\n1. 跑测试\n2. 直接合并' } }
      ]);
      for (const card of [h.cardAt(0), h.cardAt(1)]) {
        expect(JSON.stringify(card.elements)).not.toContain('form');
        expect(card.elements.some((element: any) => element.tag === 'button')).toBe(false);
        expect(card.webBaseUrl).toBeUndefined();
      }
      const records = await h.workflow.list('app_one');
      expect(records).toHaveLength(2);
      expect(records.every(record => record.structured === undefined && record.multiple === undefined)).toBe(true);
    } finally { await h.cleanup(); }
  });

  it('单选：每个选项一个回调按钮，点按经同一 CAS 把选项 value 送达 broker', async () => {
    const h = await setupHarness();
    try {
      const single = await h.ask(0, [{ label: '跑全部测试', value: 'test' }, { label: '直接合并' }]);
      await h.workflow.observe(single.ctx, single.event);
      const card = h.cardAt(0);
      const buttons = card.elements.filter((element: any) => element.tag === 'button');
      expect(buttons.map((button: any) => button.text.content)).toEqual(['跑全部测试', '直接合并']);
      const record = await findRecord(h.workflow, single.askId);
      expect(buttons[0]).toMatchObject({ behaviors: [{ value: { dutydeck_workflow: 'answer', request_id: record.id, generation: record.boot, answer: 'test' } }] });
      expect(buttons[1]).toMatchObject({ behaviors: [{ value: { answer: '直接合并' } }] });
      expect(JSON.stringify(card.elements)).toContain('引用本卡片');
      expect(record).toMatchObject({ structured: true });
      expect(record.multiple).toBeUndefined();

      // 伪造回调值先于 CAS 被拒，卡片保持 pending 可继续点按
      await expect(h.workflow.respond(responseInput(record, { answer: 'not-an-option' })))
        .rejects.toMatchObject({ code: 'LARK_ANSWER_CHOICE_INVALID' });
      expect((await findRecord(h.workflow, single.askId)).state).toBe('pending');

      // 合法点按走与审批相同的 generation CAS + broker.answer，一次性决议
      const response = await h.workflow.respond(responseInput(record, { answer: 'test' }));
      expect(response).toBe('回答已送达原任务。');
      await expect(single.waiting).resolves.toMatchObject({ status: 'answered', answer: 'test' });

      // 引用卡片回复是自由文本兜底，不经过选项校验（低版本客户端入口）
      const quoted = await h.ask(1, [{ label: '选项甲' }]);
      await h.workflow.observe(quoted.ctx, quoted.event, { structuredAskCards: true });
      const quotedRecord = await findRecord(h.workflow, quoted.askId);
      await h.workflow.respond(responseInput(quotedRecord, { callback: false, cardId: undefined, generation: undefined, answer: '我自己的答案' }));
      await expect(quoted.waiting).resolves.toMatchObject({ status: 'answered', answer: '我自己的答案' });
    } finally { await h.cleanup(); }
  });

  it('多选：原生表单收集所选值，提交时经 selected 一次性 CAS 合并送达', async () => {
    const h = await setupHarness();
    try {
      const choices = [{ label: '甲', value: 'a' }, { label: '乙', value: 'b' }, { label: '丙', value: 'c' }];
      const multiple = await h.ask(0, choices, true);
      await h.workflow.observe(multiple.ctx, multiple.event, { structuredAskCards: true });
      const form = h.cardAt(0).elements.find((element: any) => element.tag === 'form');
      expect(form).toBeDefined();
      const select = form.elements.find((element: any) => element.tag === 'multi_select_static');
      expect(select).toMatchObject({ name: 'answer', options: [{ value: 'a' }, { value: 'b' }, { value: 'c' }] });
      const submit = form.elements.find((element: any) => element.tag === 'button');
      expect(submit).toMatchObject({ form_action_type: 'submit', behaviors: [{ value: { dutydeck_workflow: 'answer', multiple: true } }] });
      // form 必须位于卡片 body 根层级（JSON 2.0 不允许嵌进其它组件）
      const assembled = buildLarkCard({ state: 'running', permissionMode: 'ask', elements: h.cardAt(0).elements });
      expect(assembled.body.elements.some((element: any) => element.tag === 'form')).toBe(true);

      const record = await findRecord(h.workflow, multiple.askId);
      expect(record).toMatchObject({ structured: true, multiple: true });
      await expect(h.workflow.respond(responseInput(record, { selected: [] })))
        .rejects.toMatchObject({ code: 'LARK_ANSWER_CHOICE_INVALID' });
      await expect(h.workflow.respond(responseInput(record, { selected: ['a', 'x'] })))
        .rejects.toMatchObject({ code: 'LARK_ANSWER_CHOICE_INVALID' });
      expect((await findRecord(h.workflow, multiple.askId)).state).toBe('pending');

      await h.workflow.respond(responseInput(record, { selected: ['c', 'a', 'a'] }));
      // 去重后按提交顺序合并成一条答案文本
      await expect(multiple.waiting).resolves.toMatchObject({ status: 'answered', answer: 'c、a' });
    } finally { await h.cleanup(); }
  });

  it('自由文本：无选项 ask 在开关开启时渲染 input 表单（max_length 1000），文本回答照常决议', async () => {
    const h = await setupHarness();
    try {
      const free = await h.ask(0);
      await h.workflow.observe(free.ctx, free.event, { structuredAskCards: true });
      const form = h.cardAt(0).elements.find((element: any) => element.tag === 'form');
      expect(form).toBeDefined();
      expect(JSON.stringify(h.cardAt(0).elements)).toContain('在下方填写答案并点击提交');
      expect(JSON.stringify(h.cardAt(0).elements)).not.toContain('点选下方选项');
      expect(form.elements.find((element: any) => element.tag === 'input'))
        .toMatchObject({ name: 'answer', input_type: 'multiline_text', max_length: 1000 });
      expect(form.elements.find((element: any) => element.tag === 'multi_select_static')).toBeUndefined();
      const submit = form.elements.find((element: any) => element.tag === 'button');
      expect(submit).toMatchObject({ form_action_type: 'submit', behaviors: [{ value: { dutydeck_workflow: 'answer' } }] });
      const record = await findRecord(h.workflow, free.askId);
      expect(record.structured).toBeUndefined();
      await h.workflow.respond(responseInput(record, { answer: '先只跑 smoke 用例' }));
      await expect(free.waiting).resolves.toMatchObject({ status: 'answered', answer: '先只跑 smoke 用例' });
    } finally { await h.cleanup(); }
  });

  it('升级前持久化的旧 ask 记录（无 structured 标记）：即使以卡片回调提交任意文本，也按自由文本接受', async () => {
    const h = await setupHarness();
    try {
      // broker 侧带选项，但交互记录是旧版本持久化的（没有 structured/multiple）
      const legacy = await h.ask(0, [{ label: '选项甲', value: 'a' }]);
      const record: LarkInteraction = {
        appId: 'app_one', sessionId: 'ses_one', taskId: 'task_one', turn: 1, event: larkMessage(),
        id: 'interaction_legacy', boot: h.workflow.boot, kind: 'ask', nativeId: legacy.askId,
        question: '怎么继续？', state: 'pending', cardId: 'om_legacy_card', updatedAt: new Date().toISOString()
      };
      await persistInteraction(h.repositories.config, record);
      await h.workflow.respond(responseInput(record, { cardId: 'om_legacy_card', answer: '完全自由的文本' }));
      await expect(legacy.waiting).resolves.toMatchObject({ status: 'answered', answer: '完全自由的文本' });
    } finally { await h.cleanup(); }
  });

  it('CAS：重复回调只决议一次，第二击只拿到 stale，冻结只画一次', async () => {
    const h = await setupHarness();
    try {
      const single = await h.ask(0, [{ label: '跑全部测试', value: 'test' }, { label: '直接合并' }]);
      await h.workflow.observe(single.ctx, single.event, { structuredAskCards: true });
      const record = await findRecord(h.workflow, single.askId);
      const outcomes = await Promise.allSettled([
        h.workflow.respond(responseInput(record, { answer: 'test' })),
        h.workflow.respond(responseInput(record, { answer: 'test' }))
      ]);
      expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
      expect(outcomes.filter(outcome => outcome.status === 'rejected')).toHaveLength(1);
      expect((outcomes.find(outcome => outcome.status === 'rejected') as PromiseRejectedResult).reason)
        .toMatchObject({ code: 'LARK_INTERACTION_EXPIRED' });
      await expect(single.waiting).resolves.toMatchObject({ status: 'answered', answer: 'test' });
      expect(h.broker.get(single.askId)).toMatchObject({ status: 'answered' });
      // renderClosed 只画一次冻结卡，第二击不产生重复 PATCH
      expect(h.service.update).toHaveBeenCalledTimes(1);
    } finally { await h.cleanup(); }
  });

  it('过期 generation 的回调只被拒绝，不触碰 broker，当前代点击仍正常决议', async () => {
    const h = await setupHarness();
    try {
      const single = await h.ask(0, [{ label: '跑全部测试', value: 'test' }]);
      await h.workflow.observe(single.ctx, single.event, { structuredAskCards: true });
      const record = await findRecord(h.workflow, single.askId);
      await expect(h.workflow.respond(responseInput(record, { generation: 'boot_other' })))
        .rejects.toMatchObject({ code: 'LARK_INTERACTION_EXPIRED' });
      expect(h.broker.get(single.askId)?.status).toBe('pending');
      expect(h.service.update).not.toHaveBeenCalled();
      await h.workflow.respond(responseInput(record, { answer: 'test' }));
      await expect(single.waiting).resolves.toMatchObject({ status: 'answered', answer: 'test' });
    } finally { await h.cleanup(); }
  });

  it('发送卡片期间超时收敛仍绑定消息并移除刚发出的按钮', async () => {
    const h = await setupHarness();
    let deliver!: (value: { messageId: string }) => void;
    try {
      h.reply.mockImplementationOnce(() => new Promise(resolve => { deliver = resolve; }));
      const ask = await h.ask(0, [{ label: '继续' }]);
      const sending = h.workflow.observe(ask.ctx, ask.event);
      await vi.waitFor(() => expect(h.reply).toHaveBeenCalledTimes(1));
      await h.workflow.expireTask(ask.ctx.appId, ask.ctx.taskId);
      deliver({ messageId: 'om_delayed_card' });
      await sending;
      expect(await findRecord(h.workflow, ask.askId)).toMatchObject({ state: 'expired', cardId: 'om_delayed_card' });
      expect(h.service.update).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'om_delayed_card', statusLabel: '已失效' }));
      expect(JSON.stringify(vi.mocked(h.service.update).mock.calls)).not.toContain('callback');
    } finally { await h.cleanup(); }
  });

  it.each([false, true])('选项集超预算回落文字且24KB/180内（multiple=%s）', async multiple => {
    const h = await setupHarness();
    try {
      // 50 个近 200 字选项（relay schema 上限）：每个选项在按钮里出现两次（文案 + 回调值），
      // 整卡约 30KB，触发字节预算回落。
      const choices: RelayAskChoice[] = Array.from({ length: 50 }, (_, index) =>
        ({ label: `选项${String(index).padStart(2, '0')}${'内'.repeat(195)}` }));
      const oversized = await h.ask(0, choices, multiple);
      await h.workflow.observe(oversized.ctx, oversized.event, { structuredAskCards: true });
      const card = h.cardAt(0);
      expect(card.elements.some((element: any) => element.tag === 'form')).toBe(false);
      expect(card.elements.some((element: any) => element.tag === 'button')).toBe(false);
      expect(card.elements).toContainEqual({ tag: 'markdown', content: '请引用本卡片回复你的答案。' });
      expect(JSON.stringify(card.elements)).toContain('可选项：');
      expect(JSON.stringify(card.elements)).toMatch(/还有 \d+ 个选项未展示/);
      // 回落卡真整卡试算必须达标，不能把超预算内容原样发给飞书
      const assembled = buildLarkCard({
        state: 'running', statusLabel: '等待回答', awaitingHuman: true, readOnly: true,
        taskName: 'Agent 需要你的回答', permissionMode: 'ask', elements: card.elements
      });
      expect(Buffer.byteLength(JSON.stringify(assembled), 'utf8')).toBeLessThanOrEqual(larkCardSafeLimits.bytes);
      expect(countCardComponents(assembled)).toBeLessThanOrEqual(larkCardSafeLimits.components);
    } finally { await h.cleanup(); }
  });

  it('群 @ 开启且选项超预算回落时：@ 元素保留、问题正文不被提示语下标错位覆盖', async () => {
    const h = await setupHarness();
    try {
      // 同预算体量（约 30KB）触发回落；同时开启群 @：元素序列变为 [group_mention, 问题div, hint]。
      const choices: RelayAskChoice[] = Array.from({ length: 50 }, (_, index) =>
        ({ label: `选项${String(index).padStart(2, '0')}${'内'.repeat(195)}` }));
      const oversized = await h.ask(0, choices, false, '请选择发布范围');
      const groupCtx = context({ event: larkMessage({ messageId: 'om_group_ask', senderOpenId: 'ou_alice' }) });
      await h.workflow.observe(groupCtx, oversized.event, { structuredAskCards: true, groupMention: true });
      const card = h.cardAt(0);
      expect(card.elements[0]).toMatchObject({ tag: 'markdown', element_id: 'group_mention', content: '<at id=ou_alice></at>' });
      // 回落只能替换 hint 自身：严禁按固定下标写 elements[1]，否则群 @ 开启时覆盖的是问题正文。
      expect(card.elements[1]).toEqual({ tag: 'div', text: { tag: 'plain_text', content: '请选择发布范围' } });
      expect(card.elements.some((element: any) => element.tag === 'form')).toBe(false);
      expect(card.elements).toContainEqual({ tag: 'markdown', content: '请引用本卡片回复你的答案。' });
      expect(JSON.stringify(card.elements)).not.toContain('点选下方选项');
    } finally { await h.cleanup(); }
  });

  it('组件计数与 service.ts 同口径：带 tag 的对象递归计 1', () => {
    expect(countCardComponents([{ tag: 'a' }, { tag: 'b', children: [{ tag: 'c' }] }])).toBe(3);
    expect(countCardComponents(Array.from({ length: 181 }, () => ({ tag: 'markdown' })))).toBe(181);
  });

  it('webBaseUrl 仅在开关开启且地址合法时透传，未配置/非法/开关关闭均不渲染', async () => {
    const h = await setupHarness();
    try {
      const withChoices = await h.ask(0, [{ label: '选项甲' }]);
      await h.workflow.observe(withChoices.ctx, withChoices.event,
        { structuredAskCards: true, webBaseUrl: 'https://dutydeck.example.com' });
      expect(h.cardAt(0).webBaseUrl).toBe('https://dutydeck.example.com');

      const illegal = await h.ask(1, [{ label: '选项乙' }]);
      await h.workflow.observe(illegal.ctx, illegal.event,
        { structuredAskCards: true, webBaseUrl: 'javascript:alert(1)' });
      expect(h.cardAt(1).webBaseUrl).toBeUndefined();

      const flagOff = await h.ask(2, [{ label: '选项丙' }]);
      await h.workflow.observe(flagOff.ctx, flagOff.event,
        { structuredAskCards: false, webBaseUrl: 'https://dutydeck.example.com' });
      expect(h.cardAt(2).webBaseUrl).toBeUndefined();

      const trimmed = await h.ask(3);
      await h.workflow.observe(trimmed.ctx, trimmed.event,
        { structuredAskCards: true, webBaseUrl: '  https://x.example.com  ' });
      expect(h.cardAt(3).webBaseUrl).toBe('https://x.example.com');
    } finally { await h.cleanup(); }
  });
});

describe('过期卡持久修复与结果附件引用', () => {
  it('旧expired记录在重启修复失败后可重试，成功只更新一次且无按钮', async () => {
    const { directory, repositories } = await openDatabase();
    try {
      const { runtime } = makeRuntime([], []);
      const { service } = makeService();
      const update = vi.mocked(service.update);
      update.mockRejectedValueOnce(new Error('temporary network error'));
      await persistInteraction(repositories.config, interaction({ state: 'expired', expiresAt: '2026-09-16T01:00:00.000Z' }));
      const workflow = new LarkWorkflowInteractions(repositories.config, runtime, service, undefined, async () => true);
      await workflow.initialize('app_one');
      await workflow.reconcile('app_one');
      await workflow.reconcile('app_one');
      expect(update).toHaveBeenCalledTimes(2);
      expect(update.mock.calls[1]![0]).toMatchObject({ statusLabel: '已失效', readOnly: true });
      expect(JSON.stringify(update.mock.calls[1])).toContain('2026/9/16 09:00:00（北京时间）');
      expect(JSON.stringify(update.mock.calls[1])).not.toContain('callback');
    } finally { repositories.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it('摘要和附件引用同一旧验收，鉴权与一次性决议不变，附件不能伪造主卡回调', async () => {
    const { directory, repositories } = await openDatabase();
    try {
      const { runtime, resolvePermission } = makeRuntime([], []);
      const { service } = makeService();
      const authorize = vi.fn(async (_record: LarkInteraction, actor: string) => actor === 'user_one');
      const workflow = new LarkWorkflowInteractions(repositories.config, runtime, service, undefined, authorize);
      const ctx = context();
      await persistInteraction(repositories.config, legacyResult(ctx));
      await Promise.all([workflow.result(ctx, 'om_summary', ['om_attachment']), workflow.result(ctx, 'om_summary', ['om_attachment'])]);
      await workflow.result(ctx, 'om_summary'); // refresh without attachment argument preserves its quoted entry
      const summary = await workflow.quoted(ctx.appId, larkMessage({ parentId: 'om_summary' }));
      const attached = await workflow.quoted(ctx.appId, larkMessage({ parentId: 'om_attachment' }));
      expect(summary?.id).toBeTruthy();
      expect(attached).toEqual(summary);
      expect(await workflow.quoted('app_two', larkMessage({ parentId: 'om_attachment' }))).toBeUndefined();
      expect(await workflow.quoted(ctx.appId, larkMessage({ parentId: 'om_attachment', chatId: 'oc_other' }))).toBeUndefined();
      await expect(workflow.respond(responseInput(summary!, { action: 'accept', actorId: 'other', callback: false }))).rejects.toMatchObject({ code: 'LARK_INTERACTION_DENIED' });
      await expect(workflow.respond(responseInput(summary!, { action: 'accept', cardId: 'om_attachment' }))).rejects.toMatchObject({ code: 'LARK_INTERACTION_EXPIRED' });
      await workflow.respond(responseInput(attached!, { action: 'accept', callback: false }));
      await expect(workflow.respond(responseInput(summary!, { action: 'accept', callback: false }))).rejects.toMatchObject({ code: 'LARK_INTERACTION_EXPIRED' });
      expect(resolvePermission).not.toHaveBeenCalled();
    } finally { repositories.close(); await rm(directory, { recursive: true, force: true }); }
  });
});

describe('conservative urgency in workflow interactions', () => {
  it('is disabled by default and reconcile makes zero urgentApp calls', async () => {
    const { directory, repositories } = await openDatabase();
    try {
      const permissions: PermissionRequestData[] = [{ id: 'perm_default_off', title: '执行受控操作', status: 'pending' }];
      const { runtime } = makeRuntime([runningTask()], permissions);
      const urgentApp = vi.fn().mockResolvedValue({ invalidUserIdList: [] });
      const service = { reply: vi.fn(async () => ({ messageId: 'om_card_off' })), update: vi.fn(async () => {}), urgentApp } as unknown as LarkCardService;
      // Default: no urgent option passed -> must be OFF by default
      const workflow = new LarkWorkflowInteractions(repositories.config, runtime, service, undefined, async () => true);

      const ctx = context({ event: larkMessage({ senderOpenId: 'ou_requester' }) });
      await workflow.observe(ctx, agentEvent('permission_request', permissions[0]));

      // 15 minutes later (well past default 10min threshold)
      const fifteenMinLater = Date.now() + 15 * 60 * 1000;
      const viNow = vi.spyOn(Date, 'now').mockReturnValue(fifteenMinLater);
      try {
        // Reconcile must not make any urgentApp calls!
        await workflow.reconcile(ctx.appId);
        expect(urgentApp).not.toHaveBeenCalled();

        // checkAndUrgePending returns empty result and does not call urgentApp
        const result = await workflow.checkAndUrgePending(ctx.appId, { now: fifteenMinLater });
        expect(result.checked).toBe(0);
        expect(result.urged).toHaveLength(0);
        expect(urgentApp).not.toHaveBeenCalled();
      } finally {
        viNow.mockRestore();
      }
    } finally {
      repositories.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('runs urgency in reconcile when explicitly enabled', async () => {
    const { directory, repositories } = await openDatabase();
    try {
      const permissions: PermissionRequestData[] = [{ id: 'perm_enabled_on', title: '执行受控操作', status: 'pending' }];
      const { runtime } = makeRuntime([runningTask()], permissions);
      const urgentApp = vi.fn().mockResolvedValue({ invalidUserIdList: [] });
      const service = { reply: vi.fn(async () => ({ messageId: 'om_card_on' })), update: vi.fn(async () => {}), urgentApp } as unknown as LarkCardService;
      const workflow = new LarkWorkflowInteractions(repositories.config, runtime, service, undefined, async () => true, {
        urgent: true
      });

      const ctx = context({ event: larkMessage({ senderOpenId: 'ou_requester' }) });
      await workflow.observe(ctx, agentEvent('permission_request', permissions[0]));

      // 15 minutes later
      const fifteenMinLater = Date.now() + 15 * 60 * 1000;
      const viNow = vi.spyOn(Date, 'now').mockReturnValue(fifteenMinLater);
      try {
        await workflow.reconcile(ctx.appId);
        expect(urgentApp).toHaveBeenCalledTimes(1);
        expect(urgentApp).toHaveBeenCalledWith({
          messageId: 'om_card_on',
          userIdList: ['ou_requester'],
          userIdType: 'open_id'
        });
      } finally {
        viNow.mockRestore();
      }
    } finally {
      repositories.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('urges pending cards that exceeded the 10-minute threshold when explicitly enabled and persists urgentAt', async () => {
    const { directory, repositories } = await openDatabase();
    try {
      const permissions: PermissionRequestData[] = [{ id: 'perm_urgent', title: '执行受控操作', status: 'pending' }];
      const { runtime } = makeRuntime([runningTask()], permissions);
      const urgentApp = vi.fn().mockResolvedValue({ invalidUserIdList: [] });
      const service = { reply: vi.fn(async () => ({ messageId: 'om_card_perm' })), update: vi.fn(), urgentApp } as unknown as LarkCardService;
      const workflow = new LarkWorkflowInteractions(repositories.config, runtime, service, undefined, async () => true, {
        urgent: true
      });

      const ctx = context({ event: larkMessage({ senderOpenId: 'ou_requester' }) });
      await workflow.observe(ctx, agentEvent('permission_request', permissions[0]));

      // 5 minutes later: should not urge yet
      const fiveMinLater = Date.now() + 5 * 60 * 1000;
      const resultEarly = await workflow.checkAndUrgePending(ctx.appId, { now: fiveMinLater });
      expect(resultEarly.urged).toHaveLength(0);
      expect(urgentApp).not.toHaveBeenCalled();

      // 12 minutes later: should urge
      const twelveMinLater = Date.now() + 12 * 60 * 1000;
      const resultUrged = await workflow.checkAndUrgePending(ctx.appId, { now: twelveMinLater });
      expect(resultUrged.urged).toHaveLength(1);
      expect(urgentApp).toHaveBeenCalledWith({
        messageId: 'om_card_perm',
        userIdList: ['ou_requester'],
        userIdType: 'open_id'
      });

      // Subsequent check: already urged, should skip
      const resultDuplicate = await workflow.checkAndUrgePending(ctx.appId, { now: twelveMinLater + 60000 });
      expect(resultDuplicate.urged).toHaveLength(0);
      expect(urgentApp).toHaveBeenCalledTimes(1);

      // Verify persistent record has urgentAt set
      const records = await workflow.list(ctx.appId);
      expect(records[0]?.urgentAt).toBeDefined();
    } finally {
      repositories.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('supports configuring custom thresholdMs and maxPerHourPerChat via options.urgent', async () => {
    const { directory, repositories } = await openDatabase();
    try {
      const permissions: PermissionRequestData[] = [{ id: 'perm_custom', title: '执行受控操作', status: 'pending' }];
      const { runtime } = makeRuntime([runningTask()], permissions);
      const urgentApp = vi.fn().mockResolvedValue({ invalidUserIdList: [] });
      const service = { reply: vi.fn(async () => ({ messageId: 'om_card_custom' })), update: vi.fn(), urgentApp } as unknown as LarkCardService;

      // Custom 3-minute threshold
      const workflow = new LarkWorkflowInteractions(repositories.config, runtime, service, undefined, async () => true, {
        urgent: { thresholdMs: 3 * 60 * 1000, maxPerHourPerChat: 1 }
      });

      const ctx = context({ event: larkMessage({ senderOpenId: 'ou_requester' }) });
      await workflow.observe(ctx, agentEvent('permission_request', permissions[0]));

      // 4 minutes later: exceeds 3-minute custom threshold, so should urge
      const fourMinLater = Date.now() + 4 * 60 * 1000;
      const result = await workflow.checkAndUrgePending(ctx.appId, { now: fourMinLater });
      expect(result.urged).toHaveLength(1);
      expect(urgentApp).toHaveBeenCalledTimes(1);
    } finally {
      repositories.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});


describe('过期审批跟随权威恢复状态', () => {
  it('blocked and manually settled unknown requests show consistent cards and callback errors without approving', async () => {
    const { directory, repositories } = await openDatabase();
    try {
      const { runtime, resolvePermission } = makeRuntime([runningTask({ status: 'reconcile_required' })], []);
      const recovery = vi.fn(async () => ({ status: 'reconcile_required', blockers: [{ code: 'DRIVER_RESOURCE_UNSAFE' }], resolvedUnknown: false }));
      runtime.getTaskRecovery = recovery;
      const { service } = makeService();
      const record = interaction({ kind: 'permission', state: 'expired' });
      await persistInteraction(repositories.config, record);
      const workflow = new LarkWorkflowInteractions(repositories.config, runtime, service, undefined, async () => true);
      await workflow.initialize('app_one');
      expect(JSON.stringify(vi.mocked(service.update).mock.calls)).toContain('原任务已保留，管理员可以用 `dutydeck recovery` 命令核对');
      expect(JSON.stringify(vi.mocked(service.update).mock.calls)).not.toContain('重新提问');
      // 审批卡上没有转到新会话的按钮，正文也不提。
      expect(JSON.stringify(vi.mocked(service.update).mock.calls)).not.toContain('在新会话中');
      await expect(workflow.respond(responseInput(record, { action: 'approve' }))).rejects.toThrow('原任务已保留');
      recovery.mockResolvedValue({ status: 'reconcile_required', blockers: [], resolvedUnknown: true });
      await workflow.reconcile('app_one');
      expect(JSON.stringify(vi.mocked(service.update).mock.calls.at(-1))).toContain('可以继续发送新请求');
      await expect(workflow.respond(responseInput(record, { action: 'approve' }))).rejects.toThrow('结果未确认');
      expect(resolvePermission).not.toHaveBeenCalled();
    } finally { repositories.close(); await rm(directory, { recursive: true, force: true }); }
  });
});

describe('权限卡截止时间与自动拒绝', () => {
  const minute = 60_000;
  const livePermissions = (id: string) => {
    const permissions: PermissionRequestData[] = [{ id, title: '写入配置', status: 'pending' }];
    const resolvePermission = vi.fn(async (_sessionId: string, permissionId: string) => {
      const index = permissions.findIndex(item => item.id === permissionId);
      if (index >= 0) permissions.splice(index, 1);
      return undefined;
    });
    return { permissions, ...makeRuntime([runningTask()], permissions, resolvePermission as any) };
  };
  const replies = (reply: ReturnType<typeof makeService>['reply']) => reply.mock.calls.map(call => (call as unknown as [Record<string, any>])[0]);

  it('写入 30 分钟截止时间，截止前 10 分钟只提醒一次，到点经 runtime 拒绝并把卡改成已过期', async () => {
    const { directory, repositories } = await openDatabase();
    const at = Date.parse('2026-09-25T02:00:00.000Z');
    const clock = vi.spyOn(Date, 'now').mockReturnValue(at);
    try {
      const { permissions, runtime, resolvePermission } = livePermissions('perm_deadline');
      const { service, reply } = makeService();
      const workflow = new LarkWorkflowInteractions(repositories.config, runtime, service, undefined, async () => true);
      await workflow.observe(context(), agentEvent('permission_request', permissions[0]));
      let [record] = await workflow.list('app_one');
      expect(record!.expiresAt).toBe(new Date(at + 30 * minute).toISOString());
      expect(JSON.stringify(replies(reply)[0])).toContain('审批截止时间：2026/9/25 10:30:00（北京时间）。到时仍未处理将自动拒绝。');

      clock.mockReturnValue(at + 19 * minute);
      await workflow.reconcile('app_one', 'task_one');
      expect(reply).toHaveBeenCalledTimes(1);
      clock.mockReturnValue(at + 20 * minute);
      await workflow.reconcile('app_one', 'task_one');
      await workflow.reconcile('app_one', 'task_one');
      expect(reply).toHaveBeenCalledTimes(2);
      expect(replies(reply)[1]).toMatchObject({ messageId: record!.cardId, idempotencyKey: `workflow_remind_${record!.id}` });
      expect(JSON.stringify(replies(reply)[1])).toContain('这条审批即将超时');
      expect((await workflow.list('app_one'))[0]!.remindedAt).toBe(new Date(at + 20 * minute).toISOString());
      expect(resolvePermission).not.toHaveBeenCalled();

      clock.mockReturnValue(at + 30 * minute);
      await workflow.reconcile('app_one', 'task_one');
      expect(resolvePermission).toHaveBeenCalledExactlyOnceWith('ses_one', 'perm_deadline', false);
      [record] = await workflow.list('app_one');
      expect(record).toMatchObject({ state: 'expired', timedOutAt: expect.any(String), timeoutNoticeAt: expect.any(String) });
      const closed = vi.mocked(service.update).mock.calls.at(-1)![0] as Record<string, any>;
      expect(closed).toMatchObject({ messageId: record!.cardId, statusLabel: '已过期' });
      expect(JSON.stringify(closed)).toContain('审批超时，已自动拒绝，不再接受批准。需要的话请重新发起。');
      expect(JSON.stringify(closed)).not.toContain('允许本次');
      expect(replies(reply)[2]).toMatchObject({ messageId: record!.cardId, idempotencyKey: `workflow_timeout_${record!.id}` });
      expect(JSON.stringify(replies(reply)[2])).toContain('审批超时，已自动拒绝');

      await workflow.reconcile('app_one', 'task_one');
      expect(reply).toHaveBeenCalledTimes(3);
      await expect(workflow.respond(responseInput(record!, { action: 'approve' }))).rejects.toThrow('审批超时，已自动拒绝');
      expect(resolvePermission).toHaveBeenCalledOnce();
    } finally { clock.mockRestore(); repositories.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it('截止后对账前的迟到批准按超时收尾，不会把批准送达执行端', async () => {
    const { directory, repositories } = await openDatabase();
    const at = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(at);
    try {
      const { permissions, runtime, resolvePermission } = livePermissions('perm_late');
      const { service } = makeService();
      const workflow = new LarkWorkflowInteractions(repositories.config, runtime, service, undefined, async () => true);
      await workflow.observe(context(), agentEvent('permission_request', permissions[0]));
      const [record] = await workflow.list('app_one');
      clock.mockReturnValue(at + 30 * minute + 1_000);
      await expect(workflow.respond(responseInput(record!, { action: 'approve' }))).rejects.toThrow('审批超时，已自动拒绝');
      expect(resolvePermission).toHaveBeenCalledExactlyOnceWith('ses_one', 'perm_late', false);
      expect((await workflow.list('app_one'))[0]).toMatchObject({ state: 'expired', timedOutAt: expect.any(String) });
    } finally { clock.mockRestore(); repositories.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it('执行端暂时没接住拒绝时保持待审批，下一次对账再拒', async () => {
    const { directory, repositories } = await openDatabase();
    const at = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(at);
    try {
      const { permissions, runtime, resolvePermission } = livePermissions('perm_retry');
      const { service } = makeService();
      const workflow = new LarkWorkflowInteractions(repositories.config, runtime, service, undefined, async () => true);
      await workflow.observe(context(), agentEvent('permission_request', permissions[0]));
      clock.mockReturnValue(at + 31 * minute);
      resolvePermission.mockRejectedValueOnce(Object.assign(new Error('intent write failed'), { code: 'EVENT_WRITE_FAILED' }));
      await workflow.reconcile('app_one', 'task_one');
      expect((await workflow.list('app_one'))[0]).toMatchObject({ state: 'pending' });
      expect((await workflow.list('app_one'))[0]!.timedOutAt).toBeUndefined();
      await workflow.reconcile('app_one', 'task_one');
      expect(resolvePermission).toHaveBeenCalledTimes(2);
      expect((await workflow.list('app_one'))[0]).toMatchObject({ state: 'expired', timedOutAt: expect.any(String) });
    } finally { clock.mockRestore(); repositories.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it('协调器重建后沿用持久化的截止时间与提醒记录，不重新计时', async () => {
    const { directory, repositories } = await openDatabase();
    const at = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(at);
    try {
      const { permissions, runtime, resolvePermission } = livePermissions('perm_restart');
      const first = makeService();
      const before = new LarkWorkflowInteractions(repositories.config, runtime, first.service, undefined, async () => true);
      await before.observe(context(), agentEvent('permission_request', permissions[0]));
      clock.mockReturnValue(at + 21 * minute);
      await before.reconcile('app_one', 'task_one');
      const [original] = await before.list('app_one');
      expect(original!.remindedAt).toBeDefined();

      clock.mockReturnValue(at + 25 * minute);
      const second = makeService();
      const after = new LarkWorkflowInteractions(repositories.config, runtime, second.service, undefined, async () => true);
      await after.initialize('app_one');
      expect((await after.list('app_one'))[0]).toMatchObject({ state: 'expired' });
      expect((await after.list('app_one'))[0]!.timedOutAt).toBeUndefined();
      expect(resolvePermission).not.toHaveBeenCalled();
      await after.observe(context(), agentEvent('permission_request', permissions[0]));
      const renewed = (await after.list('app_one')).find(item => item.boot === after.boot)!;
      expect(renewed).toMatchObject({ state: 'pending', expiresAt: original!.expiresAt, remindedAt: original!.remindedAt });
      await after.reconcile('app_one', 'task_one');
      expect(second.reply).toHaveBeenCalledOnce();

      clock.mockReturnValue(at + 30 * minute);
      await after.reconcile('app_one', 'task_one');
      expect(resolvePermission).toHaveBeenCalledExactlyOnceWith('ses_one', 'perm_restart', false);
      expect((await after.list('app_one')).find(item => item.boot === after.boot)).toMatchObject({ state: 'expired', timedOutAt: expect.any(String) });
    } finally { clock.mockRestore(); repositories.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it('重启时按持久化的 expiresAt 处理停机期间到期的审批：执行端仍挂着就拒绝，已不在也照样收尾并说明', async () => {
    const { directory, repositories } = await openDatabase();
    const at = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(at);
    try {
      const overdue = interaction({ id: 'perm_overdue', kind: 'permission', nativeId: 'perm_live', cardId: 'card_overdue', expiresAt: new Date(at - minute).toISOString() });
      const gone = interaction({ id: 'perm_gone', kind: 'permission', nativeId: 'perm_gone_native', cardId: 'card_gone', expiresAt: new Date(at - minute).toISOString() });
      const early = interaction({ id: 'perm_early', kind: 'permission', nativeId: 'perm_early_native', cardId: 'card_early', expiresAt: new Date(at + 10 * minute).toISOString() });
      for (const record of [overdue, gone, early]) await persistInteraction(repositories.config, record);
      const { permissions, runtime, resolvePermission } = livePermissions('perm_live');
      const { service, reply } = makeService();
      const workflow = new LarkWorkflowInteractions(repositories.config, runtime, service, undefined, async () => true);
      await workflow.initialize('app_one');
      expect(permissions).toHaveLength(0);
      expect(resolvePermission).toHaveBeenCalledExactlyOnceWith('ses_one', 'perm_live', false);
      const records = new Map((await workflow.list('app_one')).map(record => [record.id, record]));
      expect(records.get('perm_overdue')).toMatchObject({ state: 'expired', timedOutAt: expect.any(String), timeoutNoticeAt: expect.any(String) });
      expect(records.get('perm_gone')).toMatchObject({ state: 'expired', timedOutAt: expect.any(String), timeoutNoticeAt: expect.any(String) });
      expect(records.get('perm_early')).toMatchObject({ state: 'expired' });
      expect(records.get('perm_early')!.timedOutAt).toBeUndefined();
      expect(replies(reply).map(item => item.idempotencyKey).sort()).toEqual(['workflow_timeout_perm_gone', 'workflow_timeout_perm_overdue']);
      const labels = new Map(vi.mocked(service.update).mock.calls.map(call => [(call[0] as any).messageId, (call[0] as any).statusLabel]));
      expect(Object.fromEntries(labels)).toEqual({ card_overdue: '已过期', card_gone: '已过期', card_early: '已失效' });
    } finally { clock.mockRestore(); repositories.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it('超时说明发送失败时计入待对账，重试成功后只发一次', async () => {
    const { directory, repositories } = await openDatabase();
    const at = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(at);
    try {
      await persistInteraction(repositories.config, interaction({ id: 'perm_notice', kind: 'permission', state: 'expired', cardId: 'card_notice',
        expiresAt: new Date(at - minute).toISOString(), timedOutAt: new Date(at).toISOString() }));
      const { runtime } = makeRuntime([runningTask()], []);
      const { service, reply } = makeService();
      reply.mockRejectedValueOnce(new Error('rate limited'));
      const workflow = new LarkWorkflowInteractions(repositories.config, runtime, service, undefined, async () => true);
      expect(await workflow.reconcile('app_one')).toBe(1);
      expect((await workflow.list('app_one'))[0]!.timeoutNoticeAt).toBeUndefined();
      expect(await workflow.reconcile('app_one')).toBe(0);
      expect(await workflow.reconcile('app_one')).toBe(0);
      expect(reply).toHaveBeenCalledTimes(2);
      expect((await workflow.list('app_one'))[0]!.timeoutNoticeAt).toBeDefined();
    } finally { clock.mockRestore(); repositories.close(); await rm(directory, { recursive: true, force: true }); }
  });
});
