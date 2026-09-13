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
      cleanup: async () => { repositories.close(); await rm(directory, { recursive: true, force: true }); },
      cardAt: index => reply.mock.calls[index]![0] as Record<string, any>
    };
  };

  const findRecord = async (workflow: LarkWorkflowInteractions, askId: string) =>
    (await workflow.list('app_one')).find(record => record.nativeId === askId)!;

  it('开关缺省时：带选项的 ask 与无选项 ask 逐字节一致，均为经典文本卡', async () => {
    const h = await setupHarness();
    try {
      const plain = await h.ask(0);
      const withChoices = await h.ask(1, [{ label: '跑测试' }, { label: '直接合并' }]);
      await h.workflow.observe(plain.ctx, plain.event);
      await h.workflow.observe(withChoices.ctx, withChoices.event);
      const classic = [
        { tag: 'div', text: { tag: 'plain_text', content: '怎么继续？' } },
        { tag: 'markdown', content: '回复此卡片即可回答。' }
      ];
      expect(h.cardAt(0).elements).toEqual(classic);
      expect(JSON.stringify(h.cardAt(1).elements)).toBe(JSON.stringify(h.cardAt(0).elements));
      for (const card of [h.cardAt(0), h.cardAt(1)]) {
        expect(JSON.stringify(card.elements)).not.toContain('form');
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
      await h.workflow.observe(single.ctx, single.event, { structuredAskCards: true });
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

  it('选项集超出整卡预算时回落为经典文本卡，回落卡仍在 24KB/180 预算内', async () => {
    const h = await setupHarness();
    try {
      // 50 个近 200 字选项（relay schema 上限）：每个选项在按钮里出现两次（文案 + 回调值），
      // 整卡约 30KB，触发字节预算回落。
      const choices: RelayAskChoice[] = Array.from({ length: 50 }, (_, index) =>
        ({ label: `选项${String(index).padStart(2, '0')}${'内'.repeat(195)}` }));
      const oversized = await h.ask(0, choices);
      await h.workflow.observe(oversized.ctx, oversized.event, { structuredAskCards: true });
      const card = h.cardAt(0);
      expect(card.elements.some((element: any) => element.tag === 'form')).toBe(false);
      expect(card.elements.some((element: any) => element.tag === 'button')).toBe(false);
      expect(card.elements).toContainEqual({ tag: 'markdown', content: '回复此卡片即可回答。' });
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
      expect(card.elements[0]).toMatchObject({ tag: 'markdown', element_id: 'group_mention', content: '<at user_id="ou_alice">成员</at>' });
      // 回落只能替换 hint 自身：严禁按固定下标写 elements[1]，否则群 @ 开启时覆盖的是问题正文。
      expect(card.elements[1]).toEqual({ tag: 'div', text: { tag: 'plain_text', content: '请选择发布范围' } });
      expect(card.elements.some((element: any) => element.tag === 'form')).toBe(false);
      expect(card.elements).toContainEqual({ tag: 'markdown', content: '回复此卡片即可回答。' });
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
