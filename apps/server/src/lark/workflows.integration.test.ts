import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepositories } from '@dockmux/storage';
import { DockmuxRuntime, type AgentDriver } from '@dockmux/runtime';
import { RelayAskBroker } from '@dockmux/relay';
import type { AgentConfig } from '@dockmux/shared';
import { createRelayAskStore } from '../relay-ask-store.js';
import { LarkMessageCoordinator } from './coordinator.js';
import { LarkGroupManager } from './group-management.js';
import { larkBotsConfigKey, type StoredLarkConfig } from './config.js';
import type { LarkMessageEvent } from './listener.js';
import type { LarkInteraction } from './workflow-interactions.js';
import { LarkServiceError } from './service.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const event = (id: string, text: string, patch: Partial<LarkMessageEvent> = {}): LarkMessageEvent => ({
  messageId: id, chatId: 'oc_group', chatType: 'group', threadId: 'omt_topic', rootId: 'om_root',
  senderOpenId: 'ou_alice', senderType: 'user', messageType: 'text', content: JSON.stringify({ text }),
  mentions: [{ key: '@_user_1', name: 'Dock', openId: 'ou_bot' }], ...patch
});
async function harness(kind: 'normal' | 'ask' | 'permission' = 'normal', options: { managedGroup?: boolean; answerChunks?: string[] } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'dockmux-lark-workflows-'));
  const repos = createRepositories(join(cwd, 'state.db'));
  let broker!: RelayAskBroker;
  let release: (() => void) | undefined;
  const send = vi.fn(); const resolvePermission = vi.fn();
  const runtime = new DockmuxRuntime(repos, {
    probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }),
    driverFactory: (_config, _protocol, emit, _exit, sessionId) => {
      const driver: AgentDriver = {
        start: async () => {}, stop: async () => { release?.(); }, interrupt: async () => { release?.(); },
        send: async prompt => {
          send(prompt);
          if (kind === 'ask') {
            const result = await broker.register({ sessionId: sessionId!, question: '选择哪一种实现？' });
            emit({ type: 'text', data: { text: `已收到：${result.answer}` } });
          } else if (kind === 'permission') {
            const waiting = new Promise<void>(done => { release = done; });
            emit({ type: 'permission_request', data: { id: 'native_permission', title: '修改文件', status: 'pending', options: [{ id: 'once', label: '一次', kind: 'allow_once' }] } });
            await waiting;
            emit({ type: 'text', data: { text: '审批处理完成' } });
          } else if (options.answerChunks) {
            emit({ type: 'text', data: { text: '正在检查执行结果' } });
            emit({ type: 'tool_call', data: { id: 'tool_check', name: 'Bash', input: { command: 'pnpm test' }, status: 'running' } });
            emit({ type: 'tool_result', data: { id: 'tool_check', output: '125 passed', status: 'completed' } });
            for (const text of options.answerChunks) emit({ type: 'text', data: { text } });
          } else emit({ type: 'text', data: { text: '工作已完成' } });
        },
        resolvePermission: async (id, approved) => { resolvePermission(id, approved); release?.(); return true; }
      };
      return driver;
    }
  });
  broker = new RelayAskBroker({ publish: async (sessionId, input) => { await runtime.publishSessionEvent(sessionId, 'text', { text: input.text, relay: input.kind, askId: input.askId }); } }, createRelayAskStore(repos.config));
  await broker.initialize();
  const agent: AgentConfig = { id: 'mock', name: 'Mock', command: process.execPath, args: [], protocol: 'acp', cwd, env: {}, permissionMode: 'ask', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };
  await runtime.initialize([agent]);
  const config: StoredLarkConfig = { appId: 'cli_workflows', appSecret: 'fake-secret', workspace: cwd, defaultAgentId: 'mock', permissionMode: 'ask', listening: true,
    fullTrustConfirmed: true, preInjectPrompt: '', groupToolsEnabled: false, groupToolsAllowSend: false, pushIntervalMs: 1000, hideTraceOnComplete: false,
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
  const createCoordinator = () => new LarkMessageCoordinator(runtime, service as any, log, Math.random, 'ou_bot', undefined, repos.channelMappings, async () => 'group', undefined, groupManager, { store: repos.config, broker });
  const coordinator = createCoordinator();
  await coordinator.initializeWorkflows(config);
  await coordinator.startReconciliation(config);
  cleanups.push(async () => { coordinator.stop(); broker.close(); release?.(); await broker.flush(); await runtime.shutdown(); repos.close(); await rm(cwd, { recursive: true, force: true }); });
  const interactions = async () => (await repos.config.list!(`lark.interaction.${config.appId}.`)).map(row => JSON.parse(row.value) as LarkInteraction);
  const completed = async () => {
    await vi.waitFor(async () => expect((await runtime.listSessions()).some(session => session.state === 'completed')).toBe(true));
    await vi.waitFor(async () => expect((await repos.channelMappings.list(`lark-card:${config.appId}`)).some(mapping => {
      const saved = JSON.parse(mapping.extra ?? '{}');
      return mapping.externalId === 'om_task' && saved.state === 'completed' && saved.final_delivery_state === 'delivered';
    })).toBe(true));
  };
  return { repos, runtime, broker, config, coordinator, createCoordinator, groupManager, service, cards, files, log, send, resolvePermission, interactions, completed };
}

describe('Feishu workflows through coordinator, Runtime and persistent storage', () => {
  it('delivers one oversized result file and accepts an explicit reply without rerunning the task', async () => {
    const answer = `开头\n${'完整结果🙂'.repeat(5000)}\n末尾`;
    const h = await harness('normal', { answerChunks: [answer] });
    await h.coordinator.handle(event('om_task', '生成长结果'), h.config);
    await h.completed();
    expect(h.service.reply).toHaveBeenCalledOnce();
    expect(h.service.replyFile).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ messageId: 'om_task', replyInThread: true }));
    expect(h.cards.size).toBe(2);
    const fileText = Buffer.from([...h.files.values()][0]!).toString('utf8');
    expect(fileText.startsWith(answer)).toBe(true);
    expect(fileText).toContain('回复本文件消息「验收通过」');
    const process = structuredClone(h.cards.get('om_card_1'));
    const file = structuredClone(h.cards.get('om_card_2'));
    const updates = h.service.update.mock.calls.length;
    const result = (await h.interactions()).find(item => item.kind === 'result')!;
    expect(result.cardId).toBe('om_card_2');
    await h.coordinator.handle(event('om_unauthorized_accept', '验收通过', { senderOpenId: 'ou_bob', parentId: result.cardId, mentions: [] }), h.config);
    expect((await h.interactions()).find(item => item.id === result.id)?.state).toBe('pending');
    await h.coordinator.handle(event('om_accept', '验收通过', { parentId: result.cardId, mentions: [] }), h.config);
    expect((await h.interactions()).find(item => item.id === result.id)?.state).toBe('accepted');
    expect(h.send).toHaveBeenCalledOnce();
    expect(h.cards.get('om_card_1')).toEqual(process);
    expect(h.cards.get('om_card_2')).toEqual(file);
    expect(h.service.update).toHaveBeenCalledTimes(updates);
    const [mapping] = await h.repos.channelMappings.list(`lark-card:${h.config.appId}`);
    expect(JSON.parse(mapping!.extra!)).toMatchObject({ final_message_id: 'om_card_2', result_feedback_state: 'accepted' });
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
    const interaction = (await h.interactions()).find(item => item.kind === 'result')!;
    expect(interaction.cardId).toBe('om_card_2');
    const processBeforeAcceptance = structuredClone(process);
    expect(await h.coordinator.handleAction({ dockmux_workflow: 'accept', request_id: interaction.id, generation: interaction.boot }, 'ou_alice',
      { messageId: interaction.cardId, chatId: 'oc_group' })).toMatchObject({ type: 'success' });
    expect(h.cards.get('om_card_1')).toEqual(processBeforeAcceptance);
    expect(h.cards.get('om_card_2').elements.find((element: any) => element.element_id === 'final_output')?.content).toBe(answer);
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
      expect((await h.interactions()).find(item => item.kind === 'result')?.cardId).toBe('om_card_2');
    } finally { restored.stop(); }
  });

  it('answers the original Relay waiter by quoting its card without creating another task, then records result acceptance once', async () => {
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
    const result = (await h.interactions()).find(item => item.kind === 'result')!;
    const value = { dockmux_workflow: 'accept', request_id: result.id, generation: result.boot };
    expect(await h.coordinator.handleAction(value, 'ou_bob', { messageId: result.cardId, chatId: 'oc_group' })).toMatchObject({ type: 'error' });
    expect(await h.coordinator.handleAction(value, 'ou_alice', { messageId: result.cardId, chatId: 'oc_group' })).toMatchObject({ type: 'success' });
    expect(await h.coordinator.handleAction(value, 'ou_alice', { messageId: result.cardId, chatId: 'oc_group' })).toMatchObject({ type: 'error' });
    expect(h.send).toHaveBeenCalledOnce();
    expect((await h.interactions()).find(item => item.id === result.id)?.state).toBe('accepted');
  });

  it('binds an ACP approval to the real card and current authority; simultaneous approvals resolve only once', async () => {
    const h = await harness('permission');
    await h.coordinator.handle(event('om_task', '修改实现'), h.config);
    await vi.waitFor(async () => expect((await h.interactions()).find(item => item.kind === 'permission')?.cardId).toBeTruthy());
    const request = (await h.interactions()).find(item => item.kind === 'permission')!;
    const value = { dockmux_workflow: 'approve', request_id: request.id, generation: request.boot };
    expect(await h.coordinator.handleAction(value, 'ou_alice', { messageId: 'om_forged', chatId: 'oc_group' })).toMatchObject({ type: 'error' });
    expect(await h.coordinator.handleAction(value, 'ou_bob', { messageId: request.cardId, chatId: 'oc_group' })).toMatchObject({ type: 'error' });
    expect(h.resolvePermission).not.toHaveBeenCalled();
    const outcomes = await Promise.all([1, 2].map(() => h.coordinator.handleAction(value, 'ou_alice', { messageId: request.cardId, chatId: 'oc_group' })));
    expect(outcomes.filter(outcome => outcome.type === 'success')).toHaveLength(1);
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
      expect(await restored.handleAction({ dockmux_workflow: 'approve', request_id: request.id, generation: request.boot }, 'ou_alice', { messageId: request.cardId, chatId: 'oc_group' })).toMatchObject({ type: 'error' });
      expect(h.resolvePermission).not.toHaveBeenCalled();
    } finally { restored.stop(); }
  });

  it('uses each task requester for managed-group cancel and retries with the current operator after restart', async () => {
    const h = await harness('permission', { managedGroup: true });
    await h.coordinator.handle(event('om_alice_task', 'Alice 的任务'), h.config);
    await vi.waitFor(async () => expect((await h.interactions()).some(item => item.kind === 'permission' && item.state === 'pending')).toBe(true));
    const alicePermission = (await h.interactions()).find(item => item.kind === 'permission' && item.state === 'pending')!;

    await h.coordinator.handle(event('om_bob_task', 'Bob 的任务', { senderOpenId: 'ou_bob' }), h.config);
    await h.runtime.resolvePermission!(alicePermission.sessionId, 'native_permission', true);
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
      expect((await h.repos.tasks.get(retried.id))?.executionContext?.actorId).toBe('ou_bob');
      const retryPermission = (await h.interactions()).find(item => item.kind === 'permission' && item.state === 'pending' && item.event.senderOpenId === 'ou_bob');
      expect(retryPermission).toBeDefined();
      await h.runtime.resolvePermission!(retryPermission!.sessionId, 'native_permission', true);
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
    expect((await h.repos.tasks.get(retried.id))?.executionContext?.actorId).toBe('ou_bob');
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
    let failRuntimeMapping = true;
    h.repos.channelMappings.save = async mapping => {
      if (failRuntimeMapping && JSON.parse(mapping.extra ?? '{}').runtime_task_id) throw new Error('synthetic mapping outage');
      await saveMapping(mapping);
    };
    await h.coordinator.handle(event('om_task', '等待恢复'), h.config);
    await vi.waitFor(async () => expect((await h.interactions()).find(item => item.kind === 'ask')?.cardId).toBeTruthy());
    expect(JSON.parse((await h.repos.config.get('lark.inbox.cli_workflows.om_task'))!)).toMatchObject({ state: 'received' });
    const firstAsk = (await h.interactions()).find(item => item.kind === 'ask')!;
    expect(await h.repos.channelMappings.list('lark-card:cli_workflows')).toHaveLength(1);

    h.coordinator.stop();
    failRuntimeMapping = false;
    h.repos.channelMappings.save = saveMapping;
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
    cleanups.push(() => rm(join(tmpdir(), 'dockmux', 'lark-resources', fileMessageId), { recursive: true, force: true }));
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

  it('does not overwrite the final answer when acceptance arrives before the terminal mapping is saved', async () => {
    const h = await harness();
    let release!: () => void;
    const gate = new Promise<void>(done => { release = done; });
    const save = h.repos.channelMappings.save.bind(h.repos.channelMappings);
    let blocked = false;
    h.repos.channelMappings.save = async mapping => {
      if (JSON.parse(mapping.extra ?? '{}').final_delivery_state === 'delivered' && !blocked) { blocked = true; await gate; }
      await save(mapping);
    };
    try {
      await h.coordinator.handle(event('om_task', '生成最终结果'), h.config);
      await vi.waitFor(() => expect(blocked).toBe(true));
      const record = (await h.interactions()).find(item => item.kind === 'result')!;
      const before = h.cards.get(record.cardId!);
      expect(JSON.stringify(before)).toContain('工作已完成');
      expect(await h.coordinator.handleAction({ dockmux_workflow: 'accept', request_id: record.id, generation: record.boot }, 'ou_alice',
        { messageId: record.cardId, chatId: 'oc_group' })).toMatchObject({ type: 'success' });
      expect(h.cards.get(record.cardId!)).toEqual(before);
      release();
      await vi.waitFor(() => expect(JSON.stringify(h.cards.get(record.cardId!))).toContain('验收：已通过'));
      expect(JSON.stringify(h.cards.get(record.cardId!))).toContain('工作已完成');
    } finally { release(); }
  });

  it('binds acceptance to the separate result when the process card is missing and keeps quoted changes in the original session', async () => {
    const h = await harness();
    const update = h.service.update.getMockImplementation()!;
    h.service.update.mockImplementation(async input => {
      if (input.messageId === 'om_card_1' && input.state === 'completed') throw new LarkServiceError('LARK_OPENAPI_ERROR', 'message not found', 502, { upstreamCode: 230030 });
      return update(input);
    });
    await h.coordinator.handle(event('om_task', '生成结果'), h.config);
    await vi.waitFor(async () => expect((await h.interactions()).find(item => item.kind === 'result')?.cardId).toBe('om_card_2'), { timeout: 4000 });
    const record = (await h.interactions()).find(item => item.kind === 'result')!;
    expect(await h.coordinator.handleAction({ dockmux_workflow: 'changes', request_id: record.id, generation: record.boot }, 'ou_alice',
      { messageId: 'om_card_2', chatId: 'oc_group' })).toMatchObject({ type: 'success' });
    await h.coordinator.handle(event('om_revision', '增加一个例子', { parentId: 'om_card_2', rootId: 'om_branch', threadId: 'omt_branch' }), h.config);
    await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(2));
    expect(await h.runtime.listSessions()).toHaveLength(1);
  });

  it('records a direct reply to a pending result as changes, while preserving acceptance for later follow-ups', async () => {
    const h = await harness();
    await h.coordinator.handle(event('om_task', '生成初稿'), h.config);
    await h.completed();
    const first = (await h.interactions()).find(item => item.kind === 'result')!;
    await h.coordinator.handle(event('om_direct_revision', '补充一个例子', { parentId: first.cardId, mentions: [] }), h.config);
    await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(2));
    expect((await h.interactions()).find(item => item.id === first.id)?.state).toBe('needs_changes');
    await vi.waitFor(async () => expect((await h.interactions()).filter(item => item.kind === 'result')).toHaveLength(2));
    const second = (await h.interactions()).find(item => item.kind === 'result' && item.id !== first.id)!;
    expect(await h.coordinator.handleAction({ dockmux_workflow: 'accept', request_id: second.id, generation: second.boot }, 'ou_alice',
      { messageId: second.cardId, chatId: 'oc_group' })).toMatchObject({ type: 'success' });
    await h.coordinator.handle(event('om_more_after_acceptance', '再写一份说明', { parentId: second.cardId, mentions: [] }), h.config);
    await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(3));
    expect((await h.interactions()).find(item => item.id === second.id)?.state).toBe('accepted');
    expect(await h.runtime.listSessions()).toHaveLength(1);
  });
});
