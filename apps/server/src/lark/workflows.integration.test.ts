import { LarkGroupParticipation } from './group-participation.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepositories } from '@dutydeck/storage';
import { DutydeckRuntime, type AgentDriver } from '@dutydeck/runtime';
import { RelayAskBroker } from '@dutydeck/relay';
import type { AgentConfig, AgentEvent } from '@dutydeck/shared';
import { createRelayAskStore } from '../relay-ask-store.js';
import { LarkMessageCoordinator } from './coordinator.js';
import { LarkGroupManager } from './group-management.js';
import { larkBotsConfigKey, type StoredLarkConfig } from './config.js';
import type { LarkMessageEvent } from './listener.js';
import type { LarkInteraction } from './workflow-interactions.js';
import { buildLarkCard, LarkServiceError } from './service.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const event = (id: string, text: string, patch: Partial<LarkMessageEvent> = {}): LarkMessageEvent => ({
  messageId: id, chatId: 'oc_group', chatType: 'group', threadId: 'omt_topic', rootId: 'om_root',
  senderOpenId: 'ou_alice', senderType: 'user', messageType: 'text', content: JSON.stringify({ text }),
  mentions: [{ key: '@_user_1', name: 'Dock', openId: 'ou_bot' }], ...patch
});
async function harness(kind: 'normal' | 'ask' | 'permission' = 'normal', options: { participation?: LarkGroupParticipation; participationMode?: 'observe' | 'selective'; mentionPolicy?: StoredLarkConfig['mentionPolicy']; managedGroup?: boolean; answerChunks?: string[]; traceEvents?: Array<Pick<AgentEvent, 'type' | 'data'>>; askTimeoutMs?: number } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'dutydeck-lark-workflows-'));
  const repos = createRepositories(join(cwd, 'state.db'), { newDatabaseAuthority: 'ledger_v1' });
  let broker!: RelayAskBroker;
  let release: (() => void) | undefined;
  const send = vi.fn(); const resolvePermission = vi.fn();
  const runtime = new DutydeckRuntime(repos, {
    probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }),
    driverFactory: (_config, _protocol, emit, _exit, sessionId) => {
      let currentRelease: (() => void) | undefined;
      let currentCancelled = false;
      const cancelCurrent = () => {
        if (kind === 'permission') emit({ type: 'permission_request', data: { id: 'native_permission', title: '修改文件', status: 'rejected', options: [{ id: 'once', label: '一次', kind: 'allow_once' }] } });
        currentCancelled = true;
        emit({ type: 'completed', data: { stopReason: 'cancelled' } });
        currentRelease?.();
        currentRelease = undefined;
      };
      const driver: AgentDriver = {
        start: async () => {}, resume: async () => {}, stop: async () => cancelCurrent(), interrupt: async () => cancelCurrent(),
        send: async prompt => {
          try { send(prompt); } catch (error) { emit({ type: 'error', data: { message: String(error) } }); emit({ type: 'completed', data: { stopReason: 'end_turn' } }); return; }
          currentCancelled = false;
          if (kind === 'ask') {
            const result = await broker.register({ sessionId: sessionId!, question: '选择哪一种实现？', timeoutMs: options.askTimeoutMs });
            if (result.status === 'answered') {
              emit({ type: 'text', data: { text: `已收到：${result.answer}` } });
            }
            emit({ type: 'completed', data: { stopReason: 'end_turn' } });
          } else if (kind === 'permission') {
            emit({ type: 'permission_request', data: { id: 'native_permission', title: '修改文件', status: 'pending', options: [{ id: 'once', label: '一次', kind: 'allow_once' }] } });
            await new Promise<void>(done => { currentRelease = done; });
            if (currentCancelled) return;
            currentRelease = undefined;
            emit({ type: 'text', data: { text: '审批处理完成' } });
            emit({ type: 'completed', data: { stopReason: 'end_turn' } });
          } else if (options.answerChunks) {
            emit({ type: 'text', data: { text: '正在检查执行结果' } });
            emit({ type: 'tool_call', data: { id: 'tool_check', name: 'Bash', input: { command: 'pnpm test' }, status: 'running' } });
            emit({ type: 'tool_result', data: { id: 'tool_check', output: '125 passed', status: 'completed' } });
            for (const item of options.traceEvents ?? []) emit(item);
            for (const text of options.answerChunks) emit({ type: 'text', data: { text } });
            emit({ type: 'completed', data: { stopReason: 'end_turn' } });
          } else {
            emit({ type: 'text', data: { text: '工作已完成' } });
            emit({ type: 'completed', data: { stopReason: 'end_turn' } });
          }
        },
        resolvePermission: async (id, approved) => { resolvePermission(id, approved); emit({ type: 'permission_request', data: { id, title: '修改文件', status: approved ? 'approved' : 'rejected', options: [{ id: 'once', label: '一次', kind: 'allow_once' }] } }); currentRelease?.(); currentRelease = undefined; return true; }
      };
      return driver;
    }
  });
  broker = new RelayAskBroker({ publish: async (sessionId, input) => { await runtime.publishSessionEvent(sessionId, 'text', { text: input.text, relay: input.kind, askId: input.askId }); } }, createRelayAskStore(repos.config));
  await broker.initialize();
  const agent: AgentConfig = { id: 'mock', name: 'Mock', command: process.execPath, args: [], protocol: 'acp', cwd, env: {}, permissionMode: 'ask', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };
  await runtime.initialize([agent]);
  const config: StoredLarkConfig = { appId: 'cli_workflows', appSecret: 'fake-secret', workspace: cwd, defaultAgentId: 'mock', permissionMode: 'ask', listening: true,
    mentionPolicy: options.mentionPolicy, fullTrustConfirmed: true, preInjectPrompt: '', structuredAskCards: false, groupCardMention: false, groupToolsEnabled: false, groupToolsAllowSend: false, pushIntervalMs: 1000, hideTraceOnComplete: false,
    // 集成夹具按完整过程卡语义断言工具记录；精简模式由 card-renderer.compact.test.ts 单独覆盖。
    compactTrace: false,
    allowedUsers: [], allowedEmails: [], allowedBots: [], peerBotsAllowed: false, highRiskAllowedUsers: [{ openId: 'ou_alice', name: 'Alice' }], highRiskAllowedEmails: [], highRiskPattern: 'dangerous', riskControlMode: 'off' };
  await repos.config.set(larkBotsConfigKey, JSON.stringify([config]));
  let groupManager: LarkGroupManager | undefined;
  if (options.managedGroup) {
    groupManager = new LarkGroupManager(repos, { client: () => ({
      getBotInfo: async () => ({ appName: config.appId, openId: 'ou_bot' }),
      checkApplicationIdentity: async () => ({ verified: true, reportedAppId: config.appId, tenantKey: 'synthetic-tenant' }),
      listChats: async () => ({ items: [{ chatId: 'oc_group', name: '工作流群', chatMode: 'topic' }], hasMore: false }),
      listChatMembers: async () => ({ items: [
        { memberId: 'ou_alice', openId: 'ou_alice', name: 'Alice', memberType: 'user' },
        { memberId: 'ou_bob', openId: 'ou_bob', name: 'Bob', memberType: 'user' }
      ], hasMore: false, securityLimited: false }),
      getUserEmails: async () => []
    }) as any });
    await groupManager.sync(config.appId);
    await groupManager.save(config.appId, 'oc_group', { expectedRevision: 0, patch: {} });
  }
  let nextCard = 0;
  const cards = new Map<string, any>();
  const files = new Map<string, Uint8Array>();
  const createCard = async (input: any) => { const id = `om_card_${++nextCard}`; cards.set(id, input); return { messageId: id }; };
  const service = {
    send: vi.fn(createCard), reply: vi.fn(createCard),
    uploadFile: vi.fn(async (input: any) => { const key = `file_${files.size + 1}`; files.set(key, input.data); return key; }),
    replyFile: vi.fn(createCard), sendFile: vi.fn(createCard),
    update: vi.fn(async (input: any) => { cards.set(input.messageId, input); return { messageId: input.messageId }; }),
    addReaction: vi.fn(async (messageId: string) => {
      const record = await repos.config.get(`lark.inbox.${config.appId}.${messageId}`);
      expect(record, 'receipt must follow durable inbox acceptance').toBeTruthy();
      return { reactionId: `reaction_${messageId}` };
    }),
    deleteReaction: vi.fn(async () => {}), getUserEmails: vi.fn(async () => []),
    listChatMembers: vi.fn(async () => ({ items: [{ memberId: 'ou_alice' }, { memberId: 'ou_bob' }], hasMore: false })),
    listChatMessages: vi.fn(async () => ({ items: [], hasMore: false })),
    getMessage: vi.fn(async (id: string) => ({ messageId: id, chatId: 'oc_group', threadId: 'omt_topic', messageType: 'text', rawContent: JSON.stringify({ text: '已核实的引用材料' }), sender: { type: 'user' }, mentions: [] })),
    getMessageItems: vi.fn(async () => []),
    downloadMessageResource: vi.fn(async () => ({ data: new Uint8Array([65, 66, 67]), contentType: 'text/plain' })),
    readDocument: vi.fn(async (url: string) => ({ url, title: '需求', text: '文档中的明确验收条件' }))
  };
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  let participation = options.participation;
  if (options.participationMode) {
    await repos.collaboration.updateSettings({ appId: config.appId, chatId: 'oc_group' }, { expectedRevision: 0, participation: options.participationMode }, 'manager');
    participation = new LarkGroupParticipation({ repository: repos.collaboration, decider: { decide: async () => ({ action: 'silent', reason: '普通材料', evidenceIds: [], updates: [] }), respond: vi.fn() },
      authorize: async () => true, readConfig: async () => config, serviceFor: () => service as any, debounceMs: 10000 });
  }
  const createCoordinator = () => new LarkMessageCoordinator(runtime, service as any, log, Math.random, 'ou_bot', undefined, repos.channelMappings, async () => 'group', undefined, groupManager, { store: repos.config, broker, participation });
  const coordinator = createCoordinator();
  await coordinator.initializeWorkflows(config);
  await coordinator.startReconciliation(config);
  cleanups.push(async () => { coordinator.stop(); participation?.closeApp?.(config.appId); broker.close(); release?.(); await broker.flush(); await runtime.shutdown(); repos.close(); await rm(cwd, { recursive: true, force: true }); });
  const interactions = async () => (await repos.config.list!(`lark.interaction.${config.appId}.`)).map(row => JSON.parse(row.value) as LarkInteraction);
  const completed = async () => {
    await vi.waitFor(async () => {
      const sessions = await runtime.listSessions();
      const tasks = (await Promise.all(sessions.map(s => runtime.getTasks(s.id)))).flat();
      expect(tasks.some(t => t.status === 'completed')).toBe(true);
    });
    await vi.waitFor(async () => expect((await repos.channelMappings.list(`lark-card:${config.appId}`)).some(mapping => {
      const saved = JSON.parse(mapping.extra ?? '{}');
      return mapping.externalId === 'om_task' && saved.state === 'completed' && saved.final_delivery_state === 'delivered';
    })).toBe(true));
  };
  return { repos, runtime, broker, config, coordinator, createCoordinator, groupManager, service, cards, files, log, send, resolvePermission, interactions, completed };
}

async function seedLegacyResult(h: Awaited<ReturnType<typeof harness>>) {
  const [mapping] = await h.repos.channelMappings.list(`lark-card:${h.config.appId}`);
  const saved = JSON.parse(mapping!.extra!);
  const id = createHash('sha256').update([h.config.appId, mapping!.sessionId, saved.runtime_task_id, saved.turn, 'result', saved.runtime_task_id, ''].join('\0')).digest('hex').slice(0, 24);
  const record: LarkInteraction = {
    appId: h.config.appId, sessionId: mapping!.sessionId, taskId: saved.runtime_task_id, turn: saved.turn,
    event: event(mapping!.externalId, saved.prompt, { chatId: saved.chat_id, chatType: saved.chat_type, threadId: saved.thread_id, senderOpenId: saved.sender_open_id, mentions: [] }),
    id, boot: 'legacy_boot', kind: 'result', nativeId: saved.runtime_task_id, question: '结果验收', state: 'pending', cardId: saved.final_message_id, relatedCardIds: saved.final_attachment_message_id ? [saved.final_attachment_message_id] : undefined,
    updatedAt: new Date().toISOString()
  };
  await h.repos.config.set(`lark.interaction.${h.config.appId}.${id}`, JSON.stringify(record));
  return record;
}

describe('Feishu workflows through coordinator, Runtime and persistent storage', () => {
  it('delivers a complete oversized file and summary without imposing feedback, then continues in the same session', async () => {
    const answer = `开头\n${'完整结果🙂'.repeat(5000)}\n末尾`;
    const h = await harness('normal', { answerChunks: [answer] });
    await h.coordinator.handle(event('om_task', '生成长结果'), h.config);
    await h.completed();
    expect(h.service.reply).toHaveBeenCalledTimes(2);
    expect(h.service.replyFile).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ messageId: 'om_task', replyInThread: true }));
    expect(h.cards.size).toBe(3);
    const fileText = Buffer.from([...h.files.values()][0]!).toString('utf8');
    expect(fileText).toBe(answer);
    expect(fileText).not.toContain('验收通过');
    const process = structuredClone(h.cards.get('om_card_1'));
    const file = structuredClone(h.cards.get('om_card_2'));
    const summary = structuredClone(h.cards.get('om_card_3'));
    expect(summary.taskName).toBe('生成长结果');
    expect(JSON.stringify(summary)).toContain('正文开头节选');
    expect(JSON.stringify(summary)).not.toContain('workflow_accept');
    expect(JSON.stringify(file)).not.toContain('workflow_accept');
    expect(await h.interactions()).toEqual([]);
    await h.coordinator.handle(event('om_revision', '补充一个例子', { parentId: 'om_card_2' }), h.config);
    await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(2));
    expect(await h.runtime.listSessions()).toHaveLength(1);
    expect(h.cards.get('om_card_1')).toEqual(process);
    expect(h.cards.get('om_card_2')).toEqual(file);
    expect(h.cards.get('om_card_3')).toEqual(summary);
  });

  it('retains named long-result summary and file across coordinator restart without another mention or message', async () => {
    const h = await harness('normal', { answerChunks: ['需要用户继续扫码。\n' + '正文'.repeat(15000)] });
    h.config.groupCardMention = true;
    await h.repos.config.set(larkBotsConfigKey, JSON.stringify([h.config]));
    await h.coordinator.handle(event('om_task', '创建应用'), h.config);
    await h.completed();
    const [mapping] = await h.repos.channelMappings.list(`lark-card:${h.config.appId}`);
    const saved = JSON.parse(mapping!.extra!);
    expect(saved).toMatchObject({ final_message_id: 'om_card_3', final_attachment_message_id: 'om_card_2', progress_frozen: true });
    expect(h.cards.get(saved.final_message_id).elements.filter((item: any) => item.element_id === 'group_mention')).toHaveLength(1);
    const before = structuredClone([...h.cards]);
    h.coordinator.stop();
    const restored = h.createCoordinator();
    try {
      await restored.initializeWorkflows(h.config);
      expect(await restored.reconcile(h.config)).toBe(0);
      expect(await restored.reconcile(h.config)).toBe(0);
      expect([...h.cards]).toEqual(before);
      expect(h.service.replyFile).toHaveBeenCalledOnce();
      expect(h.service.reply).toHaveBeenCalledTimes(2);
    } finally { restored.stop(); }
  });

  it.each(['om_card_2', 'om_card_3'])('authorizes either quoted result attachment or summary against one existing acceptance record: %s', async quotedId => {
    const h = await harness('normal', { answerChunks: ['全文'.repeat(16000)] });
    await h.coordinator.handle(event('om_task', '长结果验收'), h.config);
    await h.completed();
    const record = await seedLegacyResult(h);
    h.coordinator.stop();
    const restored = h.createCoordinator();
    try {
      await restored.initializeWorkflows(h.config);
      await restored.reconcile(h.config);
      await restored.handle(event('om_unauthorized_accept', '验收通过', { senderOpenId: 'ou_bob', parentId: quotedId }), h.config);
      expect((await h.interactions()).find(item => item.id === record.id)?.state).toBe('pending');
      await restored.handle(event('om_authorized_accept', '验收通过', { parentId: quotedId }), h.config);
      expect((await h.interactions()).find(item => item.id === record.id)?.state).toBe('accepted');
      expect(h.send).toHaveBeenCalledOnce();
      expect(h.cards.get('om_card_3').elements.find((item: any) => item.element_id === 'workflow_result_status')?.content).toBe('验收：已通过');
      expect(h.service.addReaction).toHaveBeenCalledWith('om_card_2', 'CheckMark');
    } finally { restored.stop(); }
  });

  it('exports only this task’s untruncated public events after restart, with permissions, redaction and deduplication', async () => {
    const privateThought = 'PRIVATE_REASONING_MARKER';
    const screen = 'OPAQUE_TERMINAL_REASONING';
    const longOutput = `START\n${'public detail\n'.repeat(1500)}END`;
    const chunks = ['最终结果'];
    const h = await harness('normal', { answerChunks: chunks, traceEvents: [
      { type: 'thinking', data: { text: privateThought } },
      { type: 'raw_terminal', data: { text: screen } },
      { type: 'tool_result', data: { id: 'detailed', name: 'Bash', status: 'completed',
        input: { token: 'INPUT_CREDENTIAL', command: 'curl --password CLI_CREDENTIAL' },
        output: { detail: longOutput, access_token: 'OUTPUT_CREDENTIAL', text: 'Authorization: Bearer HEADER_CREDENTIAL' } } }
    ] });
    await h.coordinator.handle(event('om_task', 'USER_ORIGINAL_SECRET_REQUEST'), h.config);
    await h.completed();
    const summary = h.cards.get('om_card_2');
    const card = buildLarkCard(summary);
    const value = (card.body.elements.find((item: any) => item.element_id === 'export_trace') as any).behaviors[0].value;
    chunks.splice(0, 1, 'LATER_TASK_PRIVATE_OUTPUT');
    await h.coordinator.handle(event('om_later_task', '另一个目标'), h.config);
    await vi.waitFor(async () => expect((await h.repos.channelMappings.list('lark-card:cli_workflows')).some(item => item.externalId === 'om_later_task' && JSON.parse(item.extra ?? '{}').final_delivery_state === 'delivered')).toBe(true));
    h.coordinator.stop();
    const restored = h.createCoordinator();
    try {
      await restored.initializeWorkflows(h.config);
      await restored.startReconciliation(h.config);
      const callback = { messageId: 'om_card_2', chatId: 'oc_group' };
      expect(await restored.handleAction(value, 'ou_mallory', callback)).toMatchObject({ type: 'warning' });
      expect(await restored.handleAction(value, 'ou_alice', { ...callback, chatId: 'oc_other' })).toMatchObject({ type: 'warning' });
      expect(await restored.handleAction(value, 'ou_alice', { ...callback, messageId: 'om_forged' })).toMatchObject({ type: 'warning' });
      expect(await restored.handleAction({ ...value, turn: '999' }, 'ou_alice', callback)).toMatchObject({ type: 'warning' });
      expect(h.service.uploadFile).not.toHaveBeenCalled();
      expect(await restored.handleAction(value, 'ou_alice', callback)).toMatchObject({ type: 'success' });
      await vi.waitFor(() => expect(h.service.replyFile).toHaveBeenCalledOnce());
      const text = Buffer.from([...h.files.values()][0]!).toString('utf8');
      expect(text).toContain(longOutput.replaceAll('\n', '\\n'));
      expect(text).toContain('最终结果');
      for (const secret of [privateThought, screen, 'INPUT_CREDENTIAL', 'CLI_CREDENTIAL', 'OUTPUT_CREDENTIAL', 'HEADER_CREDENTIAL', 'USER_ORIGINAL_SECRET_REQUEST', 'LATER_TASK_PRIVATE_OUTPUT']) expect(text).not.toContain(secret);
      expect(text).toContain('[REDACTED]');
      expect(text).toContain('不含内部分析');
      expect(h.service.replyFile).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'om_task', replyInThread: true }));
      expect(await restored.handleAction(value, 'ou_alice', callback)).toMatchObject({ type: 'success' });
      await vi.waitFor(async () => expect((await h.repos.config.list!('lark.delivery.trace_')).length).toBe(2));
      expect(h.service.uploadFile).toHaveBeenCalledOnce();
      expect(h.service.replyFile).toHaveBeenCalledOnce();
      h.config.allowedUsers = [{ openId: 'ou_someone_else', name: 'Other' }];
      await h.repos.config.set(larkBotsConfigKey, JSON.stringify([h.config]));
      expect(await restored.handleAction(value, 'ou_alice', callback)).toMatchObject({ type: 'warning' });
    } finally { restored.stop(); }
  });

  it('returns warning on export callback for queued or cancelled tasks without exporting files or altering tasks', async () => {
    const h = await harness('permission');
    await h.coordinator.handle(event('om_running_task', '前置长任务'), h.config);
    await vi.waitFor(async () => expect((await h.interactions()).some(item => item.kind === 'permission' && item.state === 'pending')).toBe(true));
    const permission = (await h.interactions()).find(item => item.kind === 'permission' && item.state === 'pending')!;

    await h.coordinator.handle(event('om_queued_task', '排队中的任务'), h.config);
    await vi.waitFor(async () => {
      const mapping = (await h.repos.channelMappings.list(`lark-card:${h.config.appId}`)).find(item => item.externalId === 'om_queued_task');
      expect(mapping).toBeDefined();
    });

    const [mapping] = (await h.repos.channelMappings.list(`lark-card:${h.config.appId}`)).filter(item => item.externalId === 'om_queued_task');
    const saved = JSON.parse(mapping!.extra!);
    const task = (await h.runtime.getTasks(mapping!.sessionId)).find(item => item.id === saved.runtime_task_id);
    expect(task?.status).toBe('queued');

    const exportValue = { dutydeck_export_trace: 'download', task_id: 'om_queued_task', turn: String(saved.turn ?? 0) };
    const queuedCallback = { messageId: saved.card_message_id, chatId: 'oc_group' };

    const queuedOutcome = await h.coordinator.handleAction(exportValue, 'ou_alice', queuedCallback);
    expect(queuedOutcome).toEqual({ type: 'warning', content: '任务尚未执行，暂无执行记录可导出。' });
    expect(h.service.uploadFile).not.toHaveBeenCalled();
    expect(h.service.replyFile).not.toHaveBeenCalled();
    expect(h.service.sendFile).not.toHaveBeenCalled();
    const taskAfterQueuedAttempt = (await h.runtime.getTasks(mapping!.sessionId)).find(item => item.id === saved.runtime_task_id);
    expect(taskAfterQueuedAttempt?.status).toBe('queued');

    await h.runtime.cancelQueued(mapping!.sessionId, saved.runtime_task_id, 'ou_alice');
    await vi.waitFor(async () => {
      const current = (await h.runtime.getTasks(mapping!.sessionId)).find(item => item.id === saved.runtime_task_id);
      expect(current?.status).toBe('cancelled');
    });

    const cancelledOutcome = await h.coordinator.handleAction(exportValue, 'ou_alice', queuedCallback);
    expect(cancelledOutcome).toEqual({ type: 'warning', content: '任务尚未执行，暂无执行记录可导出。' });
    expect(h.service.uploadFile).not.toHaveBeenCalled();
    expect(h.service.replyFile).not.toHaveBeenCalled();
    expect(h.service.sendFile).not.toHaveBeenCalled();
    const taskAfterCancelledAttempt = (await h.runtime.getTasks(mapping!.sessionId)).find(item => item.id === saved.runtime_task_id);
    expect(taskAfterCancelledAttempt?.status).toBe('cancelled');

    await h.runtime.resolvePermission!(permission.sessionId, permission.nativeId, true);
    await vi.waitFor(async () => {
      const current = (await h.runtime.getTasks(mapping!.sessionId)).find(item => item.id === permission.taskId);
      expect(current?.status).toBe('completed');
    });
  });

  it('delivers exactly a retained process card and a complete streamed result, then leaves both unchanged on recovery', async () => {
    const answerChunks = Array.from({ length: 1700 }, (_, index) => `line${index}\n`);
    const answer = answerChunks.join('').trim();
    const h = await harness('normal', { answerChunks });
    await h.coordinator.handle(event('om_task', '生成完整结果'), { ...h.config, hideTraceOnComplete: true });
    await h.completed();
    expect(h.service.reply).toHaveBeenCalledTimes(2);
    expect(h.service.send).not.toHaveBeenCalled();
    for (const [sent] of h.service.reply.mock.calls) expect(sent).toMatchObject({ messageId: 'om_task', replyInThread: true });
    const process = h.cards.get('om_card_1');
    const result = h.cards.get('om_card_2');
    expect(process.state).toBe('completed');
    expect(JSON.stringify(process)).toContain('125 passed');
    expect(process.elements.some((element: any) => element.tag === 'collapsible_panel')).toBe(true);
    expect(process.elements.some((element: any) => element.element_id === 'final_output')).toBe(false);
    expect(result.elements.find((element: any) => element.element_id === 'final_output')?.content).toBe(answer);
    expect(JSON.stringify(result)).not.toContain('125 passed');
    const [mapping] = await h.repos.channelMappings.list(`lark-card:${h.config.appId}`);
    expect(JSON.parse(mapping!.extra!)).toMatchObject({ card_message_id: 'om_card_1', final_message_id: 'om_card_2', progress_frozen: true });
    expect(await h.interactions()).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('workflow_accept');
    const before = structuredClone([...h.cards]);
    const updates = h.service.update.mock.calls.length;
    h.coordinator.stop();
    const restored = h.createCoordinator();
    try {
      await restored.initializeWorkflows(h.config);
      expect(await restored.reconcile(h.config)).toBe(0);
      expect(await restored.reconcile(h.config)).toBe(0);
      expect(h.service.reply).toHaveBeenCalledTimes(2);
      expect(h.service.update).toHaveBeenCalledTimes(updates);
      expect([...h.cards]).toEqual(before);
    } finally { restored.stop(); }
  });

  it('preserves the user goal, injects sourced quote/document material once, and navigates to the original topic', async () => {
    const h = await harness();
    await h.coordinator.handle(event('om_task', '完成目标 https://team.feishu.cn/docx/doc1', { parentId: 'om_reference' }), h.config);
    await h.completed();
    expect(h.send.mock.calls[0]?.[0]).toContain('完成目标 https://team.feishu.cn/docx/doc1');
    expect(h.send.mock.calls[0]?.[0]).toContain('已核实的引用材料');
    expect(h.send.mock.calls[0]?.[0]).toContain('文档中的明确验收条件');
    const [session] = await h.runtime.listSessions();
    expect((await h.runtime.getTasks(session!.id))[0]?.prompt).toBe('完成目标 https://team.feishu.cn/docx/doc1');
    await h.coordinator.handle(event('om_followup', '继续', { parentId: 'om_reference' }), h.config);
    await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(2));
    expect(h.send.mock.calls[1]?.[0]).not.toContain('已核实的引用材料');
    await h.coordinator.handle(event('om_tasks', '/tasks'), h.config);
    expect(h.send).toHaveBeenCalledTimes(2);
    const navigation = [...h.cards.values()].find(card => card.taskId === 'om_tasks');
    expect(JSON.stringify(navigation)).toContain('client/thread/open');
    expect(JSON.stringify(navigation)).toContain('omt_topic');
  });

  it('recovers a failed result send without rerunning the task or repainting its frozen process', async () => {
    const h = await harness();
    const reply = h.service.reply.getMockImplementation()!;
    const send = h.service.send.getMockImplementation()!;
    h.service.reply.mockImplementation(async input => {
      if (input.state === 'completed') throw new Error('result unavailable');
      return reply(input);
    });
    h.service.send.mockRejectedValue(new Error('result unavailable'));
    await h.coordinator.handle(event('om_task', '交付结果'), h.config);
    await vi.waitFor(() => expect(h.log.error).toHaveBeenCalledWith(expect.anything(), '交付飞书执行结果失败，等待对账补偿'));
    const [mapping] = await h.repos.channelMappings.list(`lark-card:${h.config.appId}`);
    expect(JSON.parse(mapping!.extra!)).toMatchObject({ state: 'completed', progress_frozen: true });
    expect(JSON.parse(mapping!.extra!).final_message_id).toBeUndefined();
    expect(h.cards.size).toBe(1);
    const process = structuredClone(h.cards.get('om_card_1'));
    const updates = h.service.update.mock.calls.length;
    const failedResultKey = h.service.reply.mock.calls[1]?.[0].idempotencyKey;
    h.coordinator.stop();
    h.service.reply.mockImplementation(reply);
    h.service.send.mockImplementation(send);
    const restored = h.createCoordinator();
    try {
      await restored.initializeWorkflows(h.config);
      expect(await restored.reconcile(h.config)).toBe(0);
      expect(await restored.reconcile(h.config)).toBe(0);
      expect(h.send).toHaveBeenCalledOnce();
      expect(h.cards.size).toBe(2);
      expect(h.cards.get('om_card_1')).toEqual(process);
      expect(h.service.update).toHaveBeenCalledTimes(updates);
      expect(h.service.reply.mock.calls[2]?.[0].idempotencyKey).toBe(failedResultKey);
      expect(h.cards.get('om_card_2').elements.find((element: any) => element.element_id === 'final_output')?.content).toBe('工作已完成');
      expect(await h.interactions()).toEqual([]);
    } finally { restored.stop(); }
  });

  it('paginates the same task card after restart and checks callback identity and live access', async () => {
    const h = await harness();
    for (let index = 0; index < 11; index++) {
      await h.coordinator.handle(event(index === 0 ? 'om_task' : `om_task_${index}`, `目标 ${index}`, { threadId: `omt_${index}`, rootId: `om_root_${index}` }), h.config);
    }
    // 11 个任务的终态投递在全量套件并行负载下接近 1s 默认等待的边界，放宽等待时间；断言条件不变。
    await vi.waitFor(async () => expect((await h.repos.channelMappings.list(`lark-card:${h.config.appId}`))
      .filter(mapping => JSON.parse(mapping.extra ?? '{}').final_delivery_state === 'delivered')).toHaveLength(11), { timeout: 5_000 });
    await h.coordinator.handle(event('om_dashboard', '/tasks', { chatType: 'p2p', chatId: 'oc_dm' }), h.config);
    const [cardId, first] = [...h.cards].find(([, card]) => card.taskId === 'om_dashboard')!;
    const next = first.elements.find((element: any) => element.element_id === 'task_dashboard_navigation').columns.at(-1).elements[0].behaviors[0].value;
    expect(next).toEqual({ dutydeck_task_dashboard: 'page', page: 2 });
    h.coordinator.stop();
    const restored = h.createCoordinator();
    try {
      await restored.initializeWorkflows(h.config);
      const context = { messageId: cardId, chatId: 'oc_dm' };
      const updates = h.service.update.mock.calls.length;
      expect(await restored.handleAction(next, 'ou_bob', context)).toMatchObject({ type: 'warning' });
      expect(await restored.handleAction(next, 'ou_alice', { ...context, chatId: 'oc_other' })).toMatchObject({ type: 'warning' });
      expect(await restored.handleAction(next, 'ou_alice', { ...context, messageId: 'om_forged' })).toMatchObject({ type: 'warning' });
      expect(await restored.handleAction({ ...next, page: 1.5 }, 'ou_alice', context)).toMatchObject({ type: 'error' });
      expect(h.service.update).toHaveBeenCalledTimes(updates);
      expect(await restored.handleAction(next, 'ou_alice', context)).toMatchObject({ type: 'success' });
      const second = h.cards.get(cardId);
      expect(JSON.stringify(second)).toContain('第 2/2 页');
      expect(second.elements.filter((element: any) => element.element_id?.startsWith('task_row_'))).toHaveLength(1);
      expect(h.send).toHaveBeenCalledTimes(11);
      h.service.listChatMembers.mockResolvedValue({ items: [{ memberId: 'ou_bob' }], hasMore: false });
      expect(await restored.handleAction(next, 'ou_alice', context)).toMatchObject({ type: 'success' });
      expect(JSON.stringify(h.cards.get(cardId))).toContain('暂无可查看的任务');
      expect(JSON.stringify(h.cards.get(cardId))).not.toContain('目标 ');
      await h.repos.config.set(larkBotsConfigKey, JSON.stringify([{ ...h.config, listening: false }]));
      const beforeDisabled = h.service.update.mock.calls.length;
      expect(await restored.handleAction(next, 'ou_alice', context)).toMatchObject({ type: 'warning' });
      expect(h.service.update).toHaveBeenCalledTimes(beforeDisabled);
    } finally { restored.stop(); }
  });

  it('answers the original Relay waiter by quoting its card without creating another task or result feedback', async () => {
    const h = await harness('ask');
    await h.coordinator.handle(event('om_task', '开始工作'), h.config);
    await vi.waitFor(async () => expect((await h.interactions()).find(item => item.kind === 'ask')?.cardId).toBeTruthy());
    const ask = (await h.interactions()).find(item => item.kind === 'ask')!;
    await h.coordinator.handle(event('om_answer', '方案 A', { parentId: ask.cardId, mentions: [] }), h.config);
    await h.completed();
    expect(h.broker.get(ask.nativeId)).toMatchObject({ status: 'answered', answer: '方案 A' });
    expect(h.send).toHaveBeenCalledOnce();
    await h.coordinator.handle(event('om_duplicate', `/answer ${ask.id} 方案 B`), h.config);
    expect(h.send).toHaveBeenCalledOnce();
    expect((await h.interactions()).some(item => item.kind === 'result')).toBe(false);
  });

  it('answers the original Relay waiter from an ordinary owner reply in the same topic without queueing a task', async () => {
    const h = await harness('ask');
    await h.coordinator.handle(event('om_task', '帮我选择 CLI'), h.config);
    await vi.waitFor(async () => expect((await h.interactions()).find(item => item.kind === 'ask')?.cardId).toBeTruthy());
    const ask = (await h.interactions()).find(item => item.kind === 'ask')!;
    await h.coordinator.handle(event('om_answer', '@_user_1 bdev-codex', { parentId: 'om_root' }), h.config);
    expect(h.broker.get(ask.nativeId)).toMatchObject({ status: 'answered', answer: 'bdev-codex' });
    await h.completed();
    expect(h.send).toHaveBeenCalledOnce();
    expect(await h.runtime.getTasks(ask.sessionId)).toEqual([expect.objectContaining({ id: ask.taskId, status: 'completed' })]);
    const inbox = JSON.parse((await h.repos.config.get(`lark.inbox.${h.config.appId}.om_answer`))!);
    expect(inbox).toMatchObject({ state: 'accepted', workflowRequestId: ask.id });
  });

  it.each([
    ['another requester', { senderOpenId: 'ou_bob' }],
    ['another topic', { rootId: 'om_other_root', threadId: 'omt_other' }],
    ['another chat', { chatId: 'oc_other' }],
    ['an explicit quote', { parentId: 'om_other_message' }],
    ['an attachment', { messageType: 'file', content: JSON.stringify({ file_key: 'file_answer', file_name: 'answer.txt' }) }]
  ] as Array<[string, Partial<LarkMessageEvent>]>)('keeps %s on the task route instead of answering a pending ask', async (_name, patch) => {
    const h = await harness('ask');
    await h.coordinator.handle(event('om_task', '开始工作'), h.config);
    await vi.waitFor(async () => expect((await h.interactions()).find(item => item.kind === 'ask')?.cardId).toBeTruthy());
    const ask = (await h.interactions()).find(item => item.kind === 'ask')!;
    await h.coordinator.handle(event('om_unrelated', '另外一个目标', patch), h.config);
    await vi.waitFor(async () => {
      const tasks = (await Promise.all((await h.runtime.listSessions()).map(session => h.runtime.getTasks(session.id)))).flat();
      expect(tasks).toHaveLength(2);
    });
    expect(h.broker.get(ask.nativeId)?.status).toBe('pending');
    expect(JSON.parse((await h.repos.config.get(`lark.inbox.${h.config.appId}.om_unrelated`))!).workflowRequestId).toBeUndefined();
  });

  it('routes a same-actor pending answer without @ before selective participation, but does not consume other actors', async () => {
    const handle = vi.fn(async () => ({ enabled: true, instructions: '' }));
    // guardBotTurn 是机器人回合门禁的入口，coordinator 在唤醒前必调；缺了它整条链路会按
    // 「门禁判定失败」保守拦下，所以这个替身必须给出放行结论（本用例的发送方都是人类）。
    const h = await harness('ask', { participation: { handle, instructions: async () => '', taskContext: async () => '', guardBotTurn: async () => undefined } as unknown as LarkGroupParticipation });
    await h.coordinator.handle(event('om_task', '开始工作'), h.config);
    await vi.waitFor(async () => expect((await h.interactions()).find(item => item.kind === 'ask')?.cardId).toBeTruthy());
    const ask = (await h.interactions()).find(item => item.kind === 'ask')!;
    await h.coordinator.handle(event('om_other_actor', '不能代表别人回答', { senderOpenId: 'ou_bob', mentions: [] }), h.config);
    expect(h.broker.get(ask.nativeId)?.status).toBe('pending');
    await h.coordinator.handle(event('om_plain_answer', '先执行测试', { mentions: [] }), h.config);
    expect(h.broker.get(ask.nativeId)).toMatchObject({ status: 'answered', answer: '先执行测试' });
    expect(handle).toHaveBeenLastCalledWith(expect.objectContaining({ messageId: 'om_plain_answer' }), expect.anything(), expect.objectContaining({ explicit: true }));
    await h.completed();
    expect(await h.runtime.getTasks(ask.sessionId)).toHaveLength(1);
  });

  it.each(['observe', 'selective'] as const)('%s retains unmentioned stop/help under ambient, never, and owned-topic rules without granting other actors control', async mode => {
    for (const mentionPolicy of ['ambient', 'never', 'topic'] as const) {
      const h = await harness('permission', { managedGroup: true, participationMode: mode, mentionPolicy });
      await h.coordinator.handle(event('om_task', '开始工作'), h.config);
      await vi.waitFor(async () => expect((await h.interactions()).find(item => item.kind === 'permission')?.cardId).toBeTruthy());
      const request = (await h.interactions()).find(item => item.kind === 'permission')!;
      const interrupt = vi.spyOn(h.runtime, 'interrupt');
      await h.coordinator.handle(event('om_unknown', '/tmp', { mentions: [] }), h.config);
      expect(await h.repos.config.get(`lark.inbox.${h.config.appId}.om_unknown`)).toBeUndefined();
      await h.coordinator.handle(event('om_denied_stop', '/stop', { senderOpenId: 'ou_bob', mentions: [] }), h.config);
      expect(interrupt).not.toHaveBeenCalled();
      expect([...h.cards.values()].some(card => card.taskId === 'om_denied_stop' && card.state === 'failed')).toBe(true);
      expect((await h.runtime.getTasks(request.sessionId))[0]!.status).not.toBe('interrupted');
      await h.coordinator.handle(event('om_help', '/help', { mentions: [] }), h.config);
      expect([...h.cards.values()].some(card => card.taskId === 'om_help')).toBe(true);
      await h.coordinator.handle(event('om_stop', '/stop', { mentions: [] }), h.config);
      await vi.waitFor(() => expect(interrupt).toHaveBeenCalledOnce());
      await vi.waitFor(async () => expect((await h.runtime.getTasks(request.sessionId))[0]!.status).toBe('interrupted'));
      expect(await h.runtime.getTasks(request.sessionId)).toHaveLength(1);
      expect(h.send).toHaveBeenCalledOnce();
      const observed = await h.repos.collaboration.listObservations({ appId: h.config.appId, chatId: 'oc_group' });
      expect(observed.find(item => item.messageId === 'om_stop')!.refs).toContain('dutydeck:explicit');
    }
  });

  it.each(['observe', 'selective'] as const)('%s does not expand mention-only command wake rules', async mode => {
    const h = await harness('permission', { managedGroup: true, participationMode: mode, mentionPolicy: 'always' });
    await h.coordinator.handle(event('om_task', '开始工作'), h.config);
    await vi.waitFor(async () => expect((await h.interactions()).find(item => item.kind === 'permission')?.cardId).toBeTruthy());
    const interrupt = vi.spyOn(h.runtime, 'interrupt');
    await h.coordinator.handle(event('om_silent_stop', '/stop', { mentions: [] }), h.config);
    expect(interrupt).not.toHaveBeenCalled();
    expect(await h.repos.config.get(`lark.inbox.${h.config.appId}.om_silent_stop`)).toBeUndefined();
  });

  it('accepts a plain multiline post as the answer to the current question', async () => {
    const h = await harness('ask');
    await h.coordinator.handle(event('om_task', '开始工作'), h.config);
    await vi.waitFor(async () => expect((await h.interactions()).find(item => item.kind === 'ask')?.cardId).toBeTruthy());
    const ask = (await h.interactions()).find(item => item.kind === 'ask')!;
    await h.coordinator.handle(event('om_post_answer', '', { parentId: 'om_root', messageType: 'post', content: JSON.stringify({ zh_cn: {
      title: '', content: [[{ tag: 'text', text: 'bdev-codex' }], [{ tag: 'text', text: '先执行测试' }]]
    } }) }), h.config);
    expect(h.broker.get(ask.nativeId)).toMatchObject({ status: 'answered', answer: 'bdev-codex\n\n先执行测试' });
    await h.completed();
    expect(await h.runtime.getTasks(ask.sessionId)).toHaveLength(1);
  });

  it('does not cross native topics even when the configured session scope is shared', async () => {
    const h = await harness('ask');
    h.config.groupReplyMode = 'chat';
    await h.repos.config.set(larkBotsConfigKey, JSON.stringify([h.config]));
    await h.coordinator.handle(event('om_task', '开始工作', { rootId: undefined }), h.config);
    await vi.waitFor(async () => expect((await h.interactions()).find(item => item.kind === 'ask')?.cardId).toBeTruthy());
    const ask = (await h.interactions()).find(item => item.kind === 'ask')!;
    await h.coordinator.handle(event('om_other_topic', '新话题目标', { rootId: undefined, threadId: 'omt_other' }), h.config);
    await vi.waitFor(async () => expect(await h.runtime.getTasks(ask.sessionId)).toHaveLength(2));
    expect(h.broker.get(ask.nativeId)?.status).toBe('pending');
  });

  it('does not answer another bot application’s pending question', async () => {
    const h = await harness('ask');
    await h.coordinator.handle(event('om_task', '开始工作'), h.config);
    await vi.waitFor(async () => expect((await h.interactions()).find(item => item.kind === 'ask')?.cardId).toBeTruthy());
    const ask = (await h.interactions()).find(item => item.kind === 'ask')!;
    const other = { ...h.config, appId: 'cli_other' };
    await h.repos.config.set(larkBotsConfigKey, JSON.stringify([h.config, other]));
    await h.coordinator.handle(event('om_other_bot', '其他机器人的任务'), other);
    await vi.waitFor(async () => expect((await h.runtime.listSessions()).length).toBe(2));
    expect(h.broker.get(ask.nativeId)?.status).toBe('pending');
  });

  it('keeps slash commands out of the pending answer and execution queue', async () => {
    const h = await harness('ask');
    await h.coordinator.handle(event('om_task', '开始工作'), h.config);
    await vi.waitFor(async () => expect((await h.interactions()).find(item => item.kind === 'ask')?.cardId).toBeTruthy());
    const ask = (await h.interactions()).find(item => item.kind === 'ask')!;
    await h.coordinator.handle(event('om_tasks', '/tasks', { parentId: 'om_root' }), h.config);
    expect(h.broker.get(ask.nativeId)?.status).toBe('pending');
    expect(await h.runtime.getTasks(ask.sessionId)).toHaveLength(1);
    expect(h.send).toHaveBeenCalledOnce();
  });

  it('requires a quoted question when multiple live asks share the requester and topic, without queueing the answer', async () => {
    const h = await harness('ask');
    await h.coordinator.handle(event('om_task', '开始工作'), h.config);
    await vi.waitFor(async () => expect((await h.interactions()).find(item => item.kind === 'ask')?.cardId).toBeTruthy());
    const ask = (await h.interactions()).find(item => item.kind === 'ask')!;
    const other = h.broker.register({ sessionId: ask.sessionId, question: '另外一个问题？', timeoutMs: 60_000 });
    await vi.waitFor(async () => expect((await h.interactions()).filter(item => item.kind === 'ask' && item.cardId)).toHaveLength(2));
    await h.coordinator.handle(event('om_ambiguous', 'bdev-codex', { parentId: 'om_root' }), h.config);
    expect(h.broker.listPending(ask.sessionId)).toHaveLength(2);
    expect(await h.runtime.getTasks(ask.sessionId)).toHaveLength(1);
    expect(h.service.reply).toHaveBeenCalledWith(expect.objectContaining({ markdown: expect.stringContaining('多个问题等待回答') }));
    await h.broker.cancelSession(ask.sessionId, 'test cleanup');
    await other;
  });

  it('never applies a duplicate or an interrupted acknowledgement to a later ask', async () => {
    const h = await harness('ask');
    await h.coordinator.handle(event('om_task', '开始工作'), h.config);
    await vi.waitFor(async () => expect((await h.interactions()).find(item => item.kind === 'ask')?.cardId).toBeTruthy());
    const first = (await h.interactions()).find(item => item.kind === 'ask')!;
    const answerEvent = event('om_answer', 'bdev-codex', { parentId: 'om_root' });
    await h.coordinator.handle(answerEvent, h.config);
    await h.completed();
    await h.coordinator.handle(event('om_next', '下一个任务'), h.config);
    await vi.waitFor(async () => expect((await h.interactions()).some(item => item.kind === 'ask' && item.nativeId !== first.nativeId && item.cardId)).toBe(true));
    const next = (await h.interactions()).find(item => item.kind === 'ask' && item.nativeId !== first.nativeId)!;
    await h.coordinator.handle(answerEvent, h.config);
    expect(h.broker.get(next.nativeId)?.status).toBe('pending');

    // Simulate a crash after answering the pinned waiter but before inbox ACK.
    const key = `lark.inbox.${h.config.appId}.om_answer`;
    const stored = JSON.parse((await h.repos.config.get(key))!);
    await h.repos.config.set(key, JSON.stringify({ ...stored, state: 'received', boot: 'previous_listener' }));
    h.coordinator.stop();
    const restored = h.createCoordinator();
    try {
      await restored.initializeWorkflows(h.config);
      await restored.startReconciliation(h.config);
      await vi.waitFor(async () => expect(JSON.parse((await h.repos.config.get(key))!).state).toBe('accepted'));
      expect(h.broker.get(next.nativeId)?.status).toBe('pending');
      expect(await h.runtime.getTasks(first.sessionId)).toHaveLength(2);
      expect(h.send).toHaveBeenCalledTimes(2);
    } finally { restored.stop(); }
  });

  it('rejects an expired quoted ask without converting the reply into another task or a newer answer', async () => {
    const h = await harness('ask', { askTimeoutMs: 1_000 });
    await h.coordinator.handle(event('om_task', '开始工作'), h.config);
    await vi.waitFor(async () => expect((await h.interactions()).find(item => item.kind === 'ask')?.cardId).toBeTruthy());
    const first = (await h.interactions()).find(item => item.kind === 'ask')!;
    await vi.waitFor(() => expect(h.broker.get(first.nativeId)?.status).toBe('expired'), { timeout: 2_000 });
    await vi.waitFor(async () => expect((await h.runtime.getTasks(first.sessionId))[0]?.status).toBe('failed'));
    await h.coordinator.handle(event('om_next', '下一个任务'), h.config);
    await vi.waitFor(async () => expect((await h.interactions()).some(item => item.kind === 'ask' && item.nativeId !== first.nativeId && item.cardId)).toBe(true));
    const next = (await h.interactions()).find(item => item.kind === 'ask' && item.nativeId !== first.nativeId)!;
    await h.coordinator.handle(event('om_stale_answer', '过时的答案', { parentId: first.cardId }), h.config);
    expect(h.broker.get(next.nativeId)?.status).toBe('pending');
    expect(await h.runtime.getTasks(first.sessionId)).toHaveLength(2);
    expect(h.send).toHaveBeenCalledTimes(2);
  });

  it('binds an ACP approval to the real card and current authority; simultaneous approvals resolve only once', async () => {
    const h = await harness('permission');
    await h.coordinator.handle(event('om_task', '修改实现'), h.config);
    await vi.waitFor(async () => expect((await h.interactions()).find(item => item.kind === 'permission')?.cardId).toBeTruthy());
    const request = (await h.interactions()).find(item => item.kind === 'permission')!;
    const value = { dutydeck_workflow: 'approve', request_id: request.id, generation: request.boot };
    expect(await h.coordinator.handleAction(value, 'ou_alice', { messageId: 'om_forged', chatId: 'oc_group' })).toMatchObject({ type: 'error' });
    expect(await h.coordinator.handleAction(value, 'ou_bob', { messageId: request.cardId, chatId: 'oc_group' })).toMatchObject({ type: 'error' });
    expect(h.resolvePermission).not.toHaveBeenCalled();
    const outcomes = await Promise.all([1, 2].map(() => h.coordinator.handleAction(value, 'ou_alice', { messageId: request.cardId, chatId: 'oc_group' })));
    expect(outcomes.filter(outcome => outcome.type === 'success')).toHaveLength(1);
    expect(h.resolvePermission).toHaveBeenCalledExactlyOnceWith('native_permission', true);
    await h.completed();
  });

  it('approves by quoting the permission card, whose request id is no longer printed anywhere', async () => {
    const h = await harness('permission');
    await h.coordinator.handle(event('om_task', '修改实现'), h.config);
    await vi.waitFor(async () => expect((await h.interactions()).find(item => item.kind === 'permission')?.cardId).toBeTruthy());
    const request = (await h.interactions()).find(item => item.kind === 'permission')!;
    // 审批卡正文不再带 `/approve <编号>`，编号在卡上任何位置都不显示，所以「引用那张卡 +
    // 无参 /approve」是按钮失灵时唯一还走得通的路径：requestId 必须从引用关系回落取到。
    await h.coordinator.handle(event('om_quoted_approve', '/approve', { parentId: request.cardId, mentions: [] }), h.config);
    expect(h.resolvePermission).toHaveBeenCalledExactlyOnceWith('native_permission', true);
    await h.completed();
  });

  it('rejects revoked members and old cards after coordinator recreation', async () => {
    const h = await harness('permission');
    await h.coordinator.handle(event('om_task', '等待批准'), h.config);
    await vi.waitFor(async () => expect((await h.interactions()).find(item => item.kind === 'permission')?.cardId).toBeTruthy());
    const request = (await h.interactions()).find(item => item.kind === 'permission')!;
    h.service.listChatMembers.mockResolvedValue({ items: [], hasMore: false });
    await h.coordinator.handle(event('om_revoked', `/approve ${request.id}`), h.config);
    expect(h.resolvePermission).not.toHaveBeenCalled();
    h.coordinator.stop();
    const restored = h.createCoordinator();
    try {
      await restored.initializeWorkflows(h.config); await restored.startReconciliation(h.config);
      expect(await restored.handleAction({ dutydeck_workflow: 'approve', request_id: request.id, generation: request.boot }, 'ou_alice', { messageId: request.cardId, chatId: 'oc_group' })).toMatchObject({ type: 'error' });
      expect(h.resolvePermission).not.toHaveBeenCalled();
    } finally { restored.stop(); }
  });

  it('uses each task requester for managed-group cancel and retries with the current operator after restart', async () => {
    const h = await harness('permission', { managedGroup: true });
    await h.coordinator.handle(event('om_alice_task', 'Alice 的任务'), h.config);
    await vi.waitFor(async () => expect((await h.interactions()).some(item => item.kind === 'permission' && item.state === 'pending')).toBe(true));
    const alicePermission = (await h.interactions()).find(item => item.kind === 'permission' && item.state === 'pending')!;

    await h.coordinator.handle(event('om_bob_task', 'Bob 的任务', { senderOpenId: 'ou_bob' }), h.config);
    await h.runtime.resolvePermission!(alicePermission.sessionId, alicePermission.nativeId, true);
    await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(2));
    await vi.waitFor(async () => expect((await h.interactions()).some(item => item.kind === 'permission' && item.state === 'pending' && item.event.senderOpenId === 'ou_bob')).toBe(true));

    const interrupt = vi.spyOn(h.runtime, 'interrupt');
    await h.coordinator.handle(event('om_alice_cancel_bob', '/cancel'), h.config);
    await vi.waitFor(() => expect([...h.cards.values()].some(card => card.taskId === 'om_alice_cancel_bob' && String(card.markdown).includes('不在机器人白名单'))).toBe(true));
    expect(interrupt).not.toHaveBeenCalled();

    await h.coordinator.handle(event('om_bob_cancel_self', '/cancel', { senderOpenId: 'ou_bob' }), h.config);
    await vi.waitFor(() => expect(interrupt).toHaveBeenCalledTimes(1));
    const [session] = await h.runtime.listSessions();
    await vi.waitFor(async () => expect((await h.runtime.getTasks(session!.id)).at(-1)?.status).toBe('interrupted'));

    h.coordinator.stop();
    const restored = h.createCoordinator();
    try {
      await restored.initializeWorkflows(h.config);
      await restored.startReconciliation(h.config);
      await restored.handle(event('om_bob_retry', '/retry', { senderOpenId: 'ou_bob' }), h.config);
      await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(3));
      const tasks = await h.runtime.getTasks(session!.id);
      const retried = tasks.at(-1)!;
      expect((await h.repos.tasks.get!(retried.id))?.executionContext?.actorId).toBe('ou_bob');
      const retryPermission = (await h.interactions()).find(item => item.kind === 'permission' && item.state === 'pending' && item.event.senderOpenId === 'ou_bob');
      expect(retryPermission).toBeDefined();
      await h.runtime.resolvePermission!(retryPermission!.sessionId, retryPermission!.nativeId, true);
      await vi.waitFor(async () => expect((await h.runtime.getTasks(session!.id)).at(-1)?.status).toBe('completed'));
    } finally { restored.stop(); }
  });

  it('requires a retry operator, reloads current config, and dispatches one concurrent card retry', async () => {
    const h = await harness();
    h.send.mockImplementationOnce(() => { throw new Error('synthetic retry failure'); });
    await h.coordinator.handle(event('om_retry_task', '重试这项工作'), h.config);
    await vi.waitFor(() => expect([...h.cards.values()].some(card => card.taskId === 'om_retry_task' && card.state === 'failed')).toBe(true));

    const action = { action: 'retry', task_id: 'om_retry_task' };
    await expect(h.coordinator.handleAction(action)).resolves.toMatchObject({ type: 'warning', content: '缺少操作人身份，无法重试' });
    await h.repos.config.set(larkBotsConfigKey, JSON.stringify([{ ...h.config, allowedUsers: [{ openId: 'ou_bob', name: 'Bob' }] }]));
    const outcomes = await Promise.all([
      h.coordinator.handleAction(action, 'ou_bob'),
      h.coordinator.handleAction(action, 'ou_bob')
    ]);
    await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(2));
    expect(outcomes.filter(outcome => outcome.type === 'success')).toHaveLength(1);
    const [session] = await h.runtime.listSessions();
    const retried = (await h.runtime.getTasks(session!.id)).at(-1)!;
    expect((await h.repos.tasks.get!(retried.id))?.executionContext?.actorId).toBe('ou_bob');
  });

  it('replays a crash between Runtime acceptance and inbox bookkeeping without dispatching the task again', async () => {
    const h = await harness();
    const compareAndSet = h.repos.config.compareAndSet!.bind(h.repos.config);
    h.repos.config.compareAndSet = async (key, expected, value) => {
      if (key.includes('lark.inbox.') && JSON.parse(value).state === 'accepted') throw new Error('crash after dispatch');
      if (key.startsWith('lark.context.')) throw new Error('crash before cursor commit');
      return compareAndSet(key, expected, value);
    };
    await h.coordinator.handle(event('om_task', '执行一次'), h.config);
    await h.completed();
    expect(h.send).toHaveBeenCalledOnce();
    h.coordinator.stop(); h.repos.config.compareAndSet = compareAndSet;
    h.service.listChatMessages.mockResolvedValue({ items: [{ messageId: 'om_late', chatId: 'oc_group', threadId: 'omt_topic', createTime: '2000',
      messageType: 'text', rawContent: JSON.stringify({ text: '停机期间新增的材料' }), sender: { type: 'user' }, mentions: [] }] as any, hasMore: false });
    const restored = h.createCoordinator();
    try {
      await restored.initializeWorkflows(h.config);
      await vi.waitFor(async () => expect(JSON.parse((await h.repos.config.get('lark.inbox.cli_workflows.om_task'))!).state).toBe('accepted'));
      expect(h.send).toHaveBeenCalledOnce();
      expect((await h.runtime.listSessions())).toHaveLength(1);
      const [session] = await h.runtime.listSessions();
      expect(await h.repos.config.get(`lark.context.cli_workflows.${session!.id}`)).not.toContain('om_late');
      await restored.handle(event('om_after_restart', '继续处理新材料'), h.config);
      await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(2));
      expect(h.send.mock.calls[1]?.[0]).toContain('停机期间新增的材料');
    } finally { restored.stop(); }
  });

  it('replays a received waiter after mapping persistence fails without dispatching a second runtime task', async () => {
    const h = await harness('ask');
    const saveMapping = h.repos.channelMappings.save.bind(h.repos.channelMappings);
    const casMapping = h.repos.channelMappings.compareAndSetExtra.bind(h.repos.channelMappings);
    let failRuntimeMapping = true;
    // 存储故障必须挡住两条写路径：协调器对已存在的记录走 compareAndSetExtra（与对账同一把锁），
    // 只挡 save 等于没挡住，这条用例声称的「mapping persistence fails」就不成立。
    h.repos.channelMappings.save = async mapping => {
      if (failRuntimeMapping && JSON.parse(mapping.extra ?? '{}').runtime_task_id) throw new Error('synthetic mapping outage');
      await saveMapping(mapping);
    };
    h.repos.channelMappings.compareAndSetExtra = async (id, expected, extra) => {
      if (failRuntimeMapping && JSON.parse(extra || '{}').runtime_task_id) throw new Error('synthetic mapping outage');
      return casMapping(id, expected, extra);
    };
    await h.coordinator.handle(event('om_task', '等待恢复'), h.config);
    await vi.waitFor(async () => expect((await h.interactions()).find(item => item.kind === 'ask')?.cardId).toBeTruthy());
    expect(JSON.parse((await h.repos.config.get('lark.inbox.cli_workflows.om_task'))!)).toMatchObject({ state: 'received' });
    const firstAsk = (await h.interactions()).find(item => item.kind === 'ask')!;
    expect(await h.repos.channelMappings.list('lark-card:cli_workflows')).toHaveLength(1);

    h.coordinator.stop();
    failRuntimeMapping = false;
    h.repos.channelMappings.save = saveMapping;
    h.repos.channelMappings.compareAndSetExtra = casMapping;
    const restored = h.createCoordinator();
    try {
      await restored.initializeWorkflows(h.config);
      await vi.waitFor(async () => expect((await h.interactions()).some(item => item.kind === 'ask' && item.boot !== firstAsk.boot && item.cardId)).toBe(true));
      const freshAsk = (await h.interactions()).find(item => item.kind === 'ask' && item.boot !== firstAsk.boot)!;
      await restored.handle(event('om_after_restart', '方案 A', { parentId: freshAsk.cardId, mentions: [] }), h.config);
      await h.completed();
      expect(h.send).toHaveBeenCalledOnce();
      const [session] = await h.runtime.listSessions();
      expect(await h.runtime.getTasks(session!.id)).toHaveLength(1);
      expect(JSON.parse((await h.repos.config.get('lark.inbox.cli_workflows.om_task'))!)).toMatchObject({ state: 'accepted' });
    } finally { restored.stop(); }
  });

  it('reattaches a live question after listener recreation and answers through a new card', async () => {
    const h = await harness('ask');
    await h.coordinator.handle(event('om_task', '等我回答'), h.config);
    await vi.waitFor(async () => expect((await h.interactions()).find(item => item.kind === 'ask')?.cardId).toBeTruthy());
    const old = (await h.interactions()).find(item => item.kind === 'ask')!;
    h.coordinator.stop();
    const restored = h.createCoordinator();
    try {
      await restored.initializeWorkflows(h.config);
      await vi.waitFor(async () => expect((await h.interactions()).find(item => item.kind === 'ask' && item.boot !== old.boot)?.cardId).toBeTruthy());
      const fresh = (await h.interactions()).find(item => item.kind === 'ask' && item.boot !== old.boot)!;
      expect((await h.interactions()).find(item => item.id === old.id)?.state).toBe('expired');
      await restored.handle(event('om_fresh_answer', '继续', { parentId: fresh.cardId, mentions: [] }), h.config);
      await h.completed();
      expect(h.send).toHaveBeenCalledOnce();
      expect(h.broker.get(fresh.nativeId)).toMatchObject({ status: 'answered', answer: '继续' });
    } finally { restored.stop(); }
  });

  it('keeps private task navigation limited to the requester and current group membership', async () => {
    const h = await harness();
    await h.coordinator.handle(event('om_task', 'Alice 的目标'), h.config);
    await h.completed();
    await h.coordinator.handle(event('om_bob_task', 'Bob 的目标', { senderOpenId: 'ou_bob' }), h.config);
    await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(2));
    await h.coordinator.handle(event('om_dm_tasks', '/tasks', { chatType: 'p2p', chatId: 'oc_dm', threadId: undefined }), h.config);
    const dm = JSON.stringify([...h.cards.values()].find(card => card.taskId === 'om_dm_tasks'));
    expect(dm).toContain('Alice 的目标'); expect(dm).not.toContain('Bob 的目标');
    await h.coordinator.handle(event('om_group_tasks', '/tasks'), h.config);
    const group = JSON.stringify([...h.cards.values()].find(card => card.taskId === 'om_group_tasks'));
    expect(group).toContain('Alice 的目标'); expect(group).toContain('Bob 的目标');
    h.service.listChatMembers.mockResolvedValue({ items: [{ memberId: 'ou_bob' }], hasMore: false });
    await h.coordinator.handle(event('om_revoked_tasks', '/tasks', { chatType: 'p2p', chatId: 'oc_dm', threadId: undefined }), h.config);
    expect(JSON.stringify([...h.cards.values()].find(card => card.taskId === 'om_revoked_tasks'))).not.toContain('Alice 的目标');
    expect(h.send).toHaveBeenCalledTimes(2);
  });

  it('restores a failed task with its original attachment/document material and separate user goal', async () => {
    const h = await harness();
    const fileMessageId = `om_workflow_file_${randomUUID()}`;
    cleanups.push(() => rm(join(tmpdir(), 'dutydeck', 'lark-resources', fileMessageId), { recursive: true, force: true }));
    h.send.mockImplementationOnce(() => { throw new Error('synthetic execution failure'); });
    h.service.getMessage.mockResolvedValueOnce({ messageId: fileMessageId, chatId: 'oc_group', threadId: 'omt_topic', messageType: 'file',
      rawContent: JSON.stringify({ file_key: 'file_reference', file_name: 'evidence.txt' }), sender: { type: 'user' }, mentions: [] });
    const goal = '检查证据 https://team.feishu.cn/docx/spec';
    await h.coordinator.handle(event('om_task', goal, { parentId: fileMessageId }), h.config);
    await vi.waitFor(() => expect([...h.cards.values()].some(card => card.taskId === 'om_task' && card.state === 'failed')).toBe(true));
    expect(h.send.mock.calls[0]?.[0]).toContain('evidence.txt');
    expect(h.send.mock.calls[0]?.[0]).toContain('文档中的明确验收条件');
    h.coordinator.stop();
    const restored = h.createCoordinator();
    try {
      await restored.initializeWorkflows(h.config);
      await restored.handle(event('om_retry', '/retry'), h.config);
      await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(2));
      expect(h.send.mock.calls[1]?.[0]).toContain('evidence.txt');
      expect(h.send.mock.calls[1]?.[0]).toContain('文档中的明确验收条件');
      expect(h.service.downloadMessageResource).toHaveBeenCalledOnce();
      const [session] = await h.runtime.listSessions();
      expect((await h.runtime.getTasks(session!.id)).map(task => task.prompt)).toEqual([goal, goal]);
    } finally { restored.stop(); }
  });

  it('does not add feedback controls when the terminal mapping is saved after result delivery', async () => {
    const h = await harness();
    let release!: () => void;
    const gate = new Promise<void>(done => { release = done; });
    const save = h.repos.channelMappings.save.bind(h.repos.channelMappings);
    const cas = h.repos.channelMappings.compareAndSetExtra.bind(h.repos.channelMappings);
    let blocked = false;
    // 终态落库既可能走 save（新建记录），也可能走 compareAndSetExtra（记录已存在）；
    // 两条都要能被卡住，否则这条用例卡不到「结果已送达、映射还没落库」那个窗口。
    h.repos.channelMappings.save = async mapping => {
      if (JSON.parse(mapping.extra ?? '{}').final_delivery_state === 'delivered' && !blocked) { blocked = true; await gate; }
      await save(mapping);
    };
    h.repos.channelMappings.compareAndSetExtra = async (id, expected, extra) => {
      if (JSON.parse(extra || '{}').final_delivery_state === 'delivered' && !blocked) { blocked = true; await gate; }
      return cas(id, expected, extra);
    };
    try {
      await h.coordinator.handle(event('om_task', '生成最终结果'), h.config);
      await vi.waitFor(() => expect(blocked).toBe(true));
      const before = h.cards.get('om_card_2');
      expect(JSON.stringify(before)).toContain('工作已完成');
      expect(JSON.stringify(before)).not.toContain('workflow_accept');
      expect(await h.interactions()).toEqual([]);
      release();
      await h.completed();
      expect(h.cards.get('om_card_2')).toEqual(before);
    } finally { release(); }
  });

  it('keeps a persisted legacy acceptance card actionable after restart when the process card is missing', async () => {
    const h = await harness();
    const update = h.service.update.getMockImplementation()!;
    h.service.update.mockImplementation(async input => {
      if (input.messageId === 'om_card_1' && input.state === 'completed') throw new LarkServiceError('LARK_OPENAPI_ERROR', 'message not found', 502, { upstreamCode: 230030 });
      return update(input);
    });
    await h.coordinator.handle(event('om_task', '生成结果'), h.config);
    await h.completed();
    const record = await seedLegacyResult(h);
    h.coordinator.stop();
    const restored = h.createCoordinator();
    try {
      await restored.initializeWorkflows(h.config);
      await restored.reconcile(h.config);
      const value = { dutydeck_workflow: 'changes', request_id: record.id, generation: record.boot };
      expect(await restored.handleAction(value, 'ou_bob', { messageId: 'om_card_2', chatId: 'oc_group' })).toMatchObject({ type: 'error' });
      expect(await restored.handleAction(value, 'ou_alice', { messageId: 'om_card_2', chatId: 'oc_group' })).toMatchObject({ type: 'success' });
      await restored.handle(event('om_revision', '增加一个例子', { parentId: 'om_card_2', rootId: 'om_branch', threadId: 'omt_branch' }), h.config);
      await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(2));
      expect(await h.runtime.listSessions()).toHaveLength(1);
    } finally { restored.stop(); }
  });

  it('keeps the agent host on the result card when acceptance refreshes it in place', async () => {
    const h = await harness();
    await h.coordinator.handle(event('om_task', '生成结果'), h.config);
    await h.completed();
    expect(h.cards.get('om_card_2')).toMatchObject({ agentName: 'Mock' });
    const record = await seedLegacyResult(h);
    expect(await h.coordinator.handleAction({ dutydeck_workflow: 'accept', request_id: record.id, generation: record.boot },
      'ou_alice', { messageId: 'om_card_2', chatId: 'oc_group' })).toMatchObject({ type: 'success' });
    // 验收是对结果卡的原地覆盖。这里漏传执行宿主名，卡上的 Claude Code / Codex
    // 就会被服务端兜底名改写，读者再也看不出这轮任务是哪个 CLI 跑的。
    expect(h.service.update).toHaveBeenLastCalledWith(expect.objectContaining({ messageId: 'om_card_2', agentName: 'Mock' }));
    expect(h.cards.get('om_card_2')).toMatchObject({ agentName: 'Mock' });
  });

  it('continues a direct result reply in the same session without creating feedback records', async () => {
    const h = await harness();
    await h.coordinator.handle(event('om_task', '生成初稿'), h.config);
    await h.completed();
    await h.coordinator.handle(event('om_direct_revision', '补充一个例子', { parentId: 'om_card_2' }), h.config);
    await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(2));
    expect((await h.interactions()).some(item => item.kind === 'result')).toBe(false);
    expect(await h.runtime.listSessions()).toHaveLength(1);
    const [session] = await h.runtime.listSessions();
    const tasks = await h.runtime.getTasks(session!.id);
    expect(tasks.map(task => task.prompt)).toEqual(['生成初稿', '补充一个例子']);
    expect(await h.repos.tasks.get!(tasks[1]!.id)).toMatchObject({ sessionId: session!.id, prompt: '补充一个例子' });
  });
});
