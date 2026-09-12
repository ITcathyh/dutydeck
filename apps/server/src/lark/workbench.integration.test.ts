import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentConfigSchema, type AgentDriver, type WorkPlan } from '@dutydeck/shared';
import { createRepositories } from '@dutydeck/storage';
import { DutydeckRuntime } from '@dutydeck/runtime';
import { RelayAskBroker, RelayCapabilityRegistry } from '@dutydeck/relay';
import { WorkItemService } from '../work-items.js';
import { WorkItemInteractions } from '../work-item-interactions.js';
import { LarkWorkbench, researchWorkPlan } from './workbench.js';
import { larkBotsConfigKey, type StoredLarkConfig } from './config.js';
import { LarkMessageCoordinator } from './coordinator.js';
import type { LarkMessageEvent } from './listener.js';
import { LarkAgentToolCapabilityRegistry, LarkAgentToolsService } from './agent-tools.js';
import { buildApp } from '../app.js';
import { runWorkCommand } from '../work-item-cli.js';
import { SessionAutomationService } from '../session-automation.js';
import { executeScheduleCommand } from './schedule-command.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });
const message = (id: string, text: string, actor = 'ou_alice'): LarkMessageEvent => ({ messageId: id, chatId: 'oc_group', chatType: 'group', threadId: 'omt_topic', rootId: 'om_root',
  senderOpenId: actor, senderType: 'user', messageType: 'text', content: JSON.stringify({ text }), mentions: [{ key: '@_user_1', name: 'Dutydeck', openId: 'ou_bot' }] });

async function fixture(mode: 'normal' | 'permission' | 'held' | 'terminal' = 'normal') {
  const directory = await mkdtemp(join(tmpdir(), 'dutydeck-workbench-'));
  const repos = createRepositories(join(directory, 'state.db'));
  const cards: Array<{ messageId: string; input: any }> = [];
  const prompts: Array<{ sessionId: string; prompt: string }> = [];
  const releases = new Map<string, () => void>();
  const permissionCalls = vi.fn();
  const terminalWrites = vi.fn();
  const approval = vi.fn(async () => true);
  let work!: WorkItemService;
  let tools!: LarkAgentToolsService;
  const runtime = new DutydeckRuntime(repos, {
    cleanupIntervalMs: 0,
    probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }),
    authorizeTask: (session, task, phase) => work.authorizeTask(session, task, phase),
    authorizeExecution: async (id, actor) => { await work.authorizeExecution(id, actor); },
    sessionEnvironment: session => capabilities.environmentFor(session),
    sessionPrompt: (session, prompt) => tools.promptForSession(session, prompt),
    driverFactory: (_config, _protocol, emit, _exit, sessionId) => ({
      start: async () => {}, interrupt: async () => releases.get(sessionId)?.(), stop: async () => releases.get(sessionId)?.(),
      send: async prompt => {
        prompts.push({ sessionId, prompt });
        if (mode === 'held' || mode === 'permission' || mode === 'terminal') {
          const wait = new Promise<void>(resolve => releases.set(sessionId, resolve));
          if (mode === 'permission') emit({ type: 'permission_request', data: { id: `permit_${sessionId}`, title: '读取指定文件', status: 'pending' } });
          await wait;
        }
        emit({ type: 'text', data: { text: prompt.includes('综合两个') ? '最终报告：两项证据一致。' : '独立结果及来源。' } });
        emit({ type: 'completed', data: { stopReason: 'end_turn' } });
      },
      createTerminalStream: () => ({ onData: (_data, snapshot) => snapshot?.({ data: '\x1b[31mAllow tool? [y/n]\x1b[0m', cols: 80, rows: 24 }), write: terminalWrites, resize: () => {}, dispose: () => {} }),
      resolvePermission: async (id, allowed) => { permissionCalls(id, allowed); releases.get(sessionId)?.(); return true; }
    } satisfies AgentDriver)
  });
  const capabilities = new LarkAgentToolCapabilityRegistry(repos.sessions, 'http://localhost', 'fixture-signing-key');
  tools = new LarkAgentToolsService(capabilities, repos.config, { workbenchTask: id => runtime.getActiveTaskContext(id) });
  const broker = new RelayAskBroker({ publish: async (id, input) => { await runtime.publishSessionEvent(id, 'text', { text: input.text, relay: input.kind, askId: input.askId }); } });
  const createCard = vi.fn(async (input: any) => {
    const messageId = `om_card_${cards.length + 1}`;
    cards.push({ messageId, input });
    return { messageId };
  });
  const client = { send: createCard, reply: createCard, uploadFile: vi.fn(async () => 'file_result'), sendFile: createCard, replyFile: createCard,
    update: vi.fn(async (input: any) => ({ messageId: input.messageId })), addReaction: vi.fn(async () => ({ reactionId: 'reaction' })), deleteReaction: vi.fn(async () => {}),
    getUserEmails: vi.fn(async () => []), listChatMessages: vi.fn(async () => ({ items: [], hasMore: false })) };
  const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };
  let interactions!: WorkItemInteractions;
  const authorize = async (_id: string, actor?: string) => ['ou_alice', 'ou_bob', 'installation_owner'].includes(actor ?? '');
  const workbench = new LarkWorkbench(repos, runtime, () => work, () => interactions, authorize, { client: () => client as any, log });
  work = new WorkItemService({ repositories: repos, runtime, authorize, prepareDelivery: (sid, id, key) => workbench.prepareDelivery(sid, id, key), deliver: item => workbench.deliver(item), notify: (item, actor) => workbench.notify(item, actor) });
  interactions = new WorkItemInteractions(work, runtime, broker, approval);
  const agents = ['alpha', 'beta'].map(id => agentConfigSchema.parse({ id, name: id, command: 'fixture', protocol: 'acp', permissionMode: 'ask', cwd: directory }));
  await runtime.initialize(agents);
  const config: StoredLarkConfig = { appId: 'cli_workbench', appSecret: 'fixture-secret', workspace: directory, defaultAgentId: 'alpha', permissionMode: 'ask', listening: true,
    fullTrustConfirmed: true, preInjectPrompt: '', groupToolsEnabled: true, groupToolsAllowSend: false, pushIntervalMs: 1000, hideTraceOnComplete: false,
    allowedUsers: [], allowedEmails: [], allowedBots: [], peerBotsAllowed: false, highRiskAllowedUsers: [], highRiskAllowedEmails: [], highRiskPattern: 'dangerous', riskControlMode: 'off' };
  await repos.config.set(larkBotsConfigKey, JSON.stringify([config]));
  const coordinator = new LarkMessageCoordinator(runtime, client as any, log, Math.random, 'ou_bot', undefined, repos.channelMappings, async () => 'group', undefined, undefined, { store: repos.config, broker, workbench });
  await coordinator.initializeWorkflows(config);
  await coordinator.startReconciliation(config);
  const app = await buildApp(runtime, { relay: { runtime, broker, capabilities: new RelayCapabilityRegistry(repos.sessions, 'http://localhost', 'fixture-relay') }, workItems: { service: work, interactions, authorize: async () => ({ allowed: true, actorId: 'installation_owner' }) }, workItemTools: { runtime, work, tools }, lark: { listeningDisabled: true } });
  cleanup.push(async () => { coordinator.stop(); workbench.close(); await work.close(); broker.close(); for (const release of releases.values()) release(); await app.close(); await runtime.shutdown(); capabilities.close(); repos.close(); await rm(directory, { recursive: true, force: true }); });
  const parent = async () => (await runtime.listSessions()).find(session => session.source === 'lark')!;
  const item = async () => (await work.listBySession((await parent()).id, 'ou_alice'))[0]!;
  const settle = async () => { await vi.waitFor(async () => expect((await runtime.listSessions()).filter(session => session.source === 'work_item').every(session => ['completed', 'failed', 'stopped'].includes(session.state))).toBe(true)); };
  return { directory, repos, runtime, work, broker, approval, terminalWrites, tools, capabilities, interactions, workbench, coordinator, app, client, config, cards, prompts, permissionCalls, releases, parent, item, settle };
}

describe('Feishu workbench with real Runtime, SQLite and HTTP routes', () => {
  it('starts one goal from Feishu, runs two independent Agents, joins and delivers to the originating topic', async () => {
    const f = await fixture();
    await f.coordinator.handle(message('om_goal', '/work research 比较两个方案'), f.config);
    expect((await f.item()).plan.steps).toHaveLength(3);
    await f.work.tick(); await f.settle();
    expect(f.prompts).toHaveLength(2);
    expect(new Set(f.prompts.map(value => value.sessionId)).size).toBe(2);
    await f.work.tick(); await f.settle(); await f.work.tick();
    const item = await f.item();
    expect(item.status).toBe('completed');
    expect(f.prompts).toHaveLength(3);
    expect(f.prompts[2]!.prompt).toContain('独立结果及来源。');
    await vi.waitFor(() => expect(f.cards.some(card => card.input.elements?.some((value: any) => value.element_id === 'final_output'))).toBe(true));
    const result = f.cards.find(card => card.input.elements?.some((value: any) => value.element_id === 'final_output'))!;
    expect(result.input).toMatchObject({ messageId: 'om_goal', replyInThread: true, state: 'completed' });
    expect(result.input.elements.find((value: any) => value.element_id === 'final_output').content).toBe('最终报告：两项证据一致。');
    await f.work.tick(); expect(f.prompts).toHaveLength(3);
    await f.coordinator.handle(message('om_goal', '/work research 比较两个方案'), f.config);
    expect(await f.work.listBySession((await f.parent()).id, 'ou_alice')).toHaveLength(1);
    const saved = await f.app.inject({ method: 'POST', url: `/api/sessions/${item.parentSessionId}/work-items/${item.id}/template`, payload: { name: '每周对比' } });
    expect(saved.statusCode).toBe(200);
    const template = saved.json();
    expect(template.version).toBe(1);
    const run = await f.app.inject({ method: 'POST', url: `/api/sessions/${item.parentSessionId}/work-templates/${template.id}/run`, payload: { version: 1, goal: '比较新的材料', idempotencyKey: 'next' } });
    expect(run.statusCode).toBe(200); expect(run.json().plan).toEqual(item.plan);
  });

  it('sends native permission requests to the main topic and rejects copied cards, wrong owners and duplicate decisions', async () => {
    const f = await fixture('permission');
    await f.coordinator.handle(message('om_goal', '/work research 比较'), f.config);
    await f.work.tick();
    await vi.waitFor(async () => expect((await f.interactions.list((await f.parent()).id, (await f.item()).id, 'ou_alice')).length).toBe(2));
    await f.work.tick();
    await vi.waitFor(() => expect(f.cards.some(card => card.input.elements?.some((value: any) => value.behaviors?.[0]?.value?.answer === 'approve'))).toBe(true));
    const card = f.cards.find(card => card.input.elements?.some((value: any) => value.behaviors?.[0]?.value?.answer === 'approve'))!;
    expect(card, 'pending child permission must proactively appear in the original topic').toBeDefined();
    const action = card.input.elements.find((value: any) => value.behaviors?.[0]?.value?.answer === 'approve').behaviors[0].value;
    expect((await f.coordinator.handleAction(action, 'ou_alice', { messageId: card.messageId, chatId: 'oc_other' })).type).toBe('error');
    expect((await f.coordinator.handleAction(action, 'ou_bob', { messageId: card.messageId, chatId: 'oc_group' })).type).toBe('error');
    expect(f.permissionCalls).not.toHaveBeenCalled();
    expect((await f.coordinator.handleAction(action, 'ou_alice', { messageId: card.messageId, chatId: 'oc_group' })).type).toBe('success');
    expect(f.permissionCalls).toHaveBeenCalledTimes(1);
    expect((await f.coordinator.handleAction(action, 'ou_alice', { messageId: card.messageId, chatId: 'oc_group' })).type).toBe('error');
    expect(f.permissionCalls).toHaveBeenCalledTimes(1);
  });

  it('rechecks approval permission after a native request has already arrived', async () => {
    const f = await fixture('permission');
    await f.coordinator.handle(message('om_goal', '/work research 比较'), f.config);
    await f.work.tick();
    const item = await f.item();
    await vi.waitFor(async () => expect((await f.interactions.list(item.parentSessionId, item.id, 'ou_alice')).length).toBe(2));
    const request = (await f.interactions.list(item.parentSessionId, item.id, 'ou_alice'))[0]!;
    f.approval.mockResolvedValue(false);
    const { sessionId: _session, text: _text, ...input } = request;
    await expect(f.interactions.respond(item.parentSessionId, item.id, { ...input, answer: 'approve' }, 'ou_alice')).rejects.toMatchObject({ statusCode: 403 });
    expect(f.permissionCalls).not.toHaveBeenCalled();
    await f.interactions.respond(item.parentSessionId, item.id, { ...input, answer: 'reject' }, 'ou_alice');
    expect(f.permissionCalls).toHaveBeenCalledWith(request.requestId, false);
  });

  it('keeps legacy relay answers closed for managed children and rejects answers after cancellation', async () => {
    const f = await fixture('held');
    await f.coordinator.handle(message('om_goal', '/work research 比较'), f.config);
    await f.work.tick();
    const item = await f.item();
    const attempt = item.steps[0]!.attempts[0]!;
    const pending = f.broker.register({ sessionId: attempt.sessionId!, question: '继续吗？' });
    await vi.waitFor(() => expect(f.broker.listPending(attempt.sessionId!)).toHaveLength(1));
    const request = (await f.interactions.list(item.parentSessionId, item.id, 'ou_alice'))[0]!;
    const url = `/api/relay/sessions/${attempt.sessionId}/asks`;
    expect((await f.app.inject({ method: 'GET', url })).statusCode).toBe(403);
    expect((await f.app.inject({ method: 'POST', url: `${url}/${request.requestId}/answer`, payload: { answer: 'yes' } })).statusCode).toBe(403);
    expect(f.broker.listPending(attempt.sessionId!)).toHaveLength(1);
    await f.work.cancel(item.parentSessionId, item.id, item.revision, 'ou_alice');
    const { sessionId: _session, text: _text, ...input } = request;
    await expect(f.interactions.respond(item.parentSessionId, item.id, { ...input, answer: 'yes' }, 'ou_alice')).rejects.toMatchObject({ statusCode: 409 });
    f.broker.close(); await pending;
  });

  it('shows a terminal in Feishu and accepts only human input for the current active task', async () => {
    const f = await fixture('terminal');
    await f.coordinator.handle(message('om_goal', '/work research 比较'), f.config);
    await f.work.tick();
    const item = await f.item();
    f.approval.mockResolvedValue(false);
    await expect(f.interactions.terminal(item.parentSessionId, item.id, 'research', 'ou_alice')).rejects.toMatchObject({ statusCode: 403 });
    f.approval.mockResolvedValue(true);
    const view = await f.interactions.terminal(item.parentSessionId, item.id, 'research', 'ou_alice');
    expect(view.screen).toBe('Allow tool? [y/n]');
    await f.workbench.command(item.parentSessionId, `terminal ${item.id} research`, message('om_terminal', ''), f.config);
    expect(JSON.stringify(f.cards.at(-1))).toContain(`/work input ${item.id} research ${view.taskId}`);
    await expect(f.interactions.terminalInput(item.parentSessionId, item.id, { stepId: 'research', taskId: 'old', text: 'y' }, 'ou_alice')).rejects.toMatchObject({ statusCode: 409 });
    f.approval.mockResolvedValue(false);
    await expect(f.interactions.terminalInput(item.parentSessionId, item.id, { stepId: 'research', taskId: view.taskId, text: 'y' }, 'ou_alice')).rejects.toMatchObject({ statusCode: 403 });
    expect(f.terminalWrites).not.toHaveBeenCalled();
    f.approval.mockResolvedValue(true);
    await f.workbench.command(item.parentSessionId, `input ${item.id} research ${view.taskId} y`, message('om_input', ''), f.config);
    expect(f.terminalWrites).toHaveBeenCalledWith('y\r');
    await f.work.cancel(item.parentSessionId, item.id, item.revision, 'ou_alice');
    await expect(f.interactions.terminalInput(item.parentSessionId, item.id, { stepId: 'research', taskId: view.taskId, key: 'enter' }, 'ou_alice')).rejects.toMatchObject({ statusCode: 409 });
    expect(f.terminalWrites).toHaveBeenCalledTimes(1);
  });

  it('does not persist a late Feishu response after the workbench is closed', async () => {
    const f = await fixture();
    await f.coordinator.handle(message('om_goal', '/work research 比较'), f.config);
    const item = await f.item();
    let release!: (value: { messageId: string }) => void;
    f.client.reply.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const delivery = f.workbench.deliver(item);
    const rejection = expect(delivery).rejects.toMatchObject({ code: 'WORKBENCH_CLOSED' });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    f.workbench.close();
    const save = vi.spyOn(f.repos.channelMappings, 'save');
    const set = vi.spyOn(f.repos.config, 'set');
    release({ messageId: 'om_late' });
    await rejection;
    expect(save).not.toHaveBeenCalled(); expect(set).not.toHaveBeenCalled();
  });

  it('requires both the scoped session credential and the current instruction credential for natural-language tool use', async () => {
    const f = await fixture('held');
    await f.coordinator.handle(message('om_parent', '为这个目标安排独立研究'), f.config);
    await vi.waitFor(() => expect(f.prompts).toHaveLength(1));
    const parent = await f.parent();
    const active = f.runtime.getActiveTaskContext(parent.id)!;
    // The first card is durable before dispatch; the receipt can lag the CLI tool call.
    for (const mapping of await f.repos.channelMappings.list(`lark-card:${f.config.appId}`)) {
      const saved = JSON.parse(mapping.extra!); delete saved.runtime_task_id;
      await f.repos.channelMappings.save({ ...mapping, extra: JSON.stringify(saved) });
    }
    const env = f.capabilities.environmentFor(parent);
    const turn = f.capabilities.workbenchTurnToken(parent.id, active.taskId);
    expect(f.prompts[0]!.prompt).toContain(`work --turn ${turn} create`);
    const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
      const response = await f.app.inject({ method: init?.method as any ?? 'GET', url: new URL(String(url)).pathname, headers: Object.fromEntries(new Headers(init?.headers)), ...(init?.body ? { payload: String(init.body) } : {}) });
      return new Response(response.body, { status: response.statusCode, headers: { 'content-type': 'application/json' } });
    };
    const path = join(f.directory, 'plan.json');
    await writeFile(path, JSON.stringify({ goal: '独立目标', plan: researchWorkPlan(['alpha', 'beta']), idempotencyKey: 'delegation' }));
    await expect(runWorkCommand('create', [], { file: path, turn: 'old-turn' }, { env, fetcher: fetcher as typeof fetch })).rejects.toMatchObject({ statusCode: 403 });
    const created = await runWorkCommand('create', [], { file: path, turn }, { env, fetcher: fetcher as typeof fetch });
    expect(created).toMatchObject({ status: 'running', parentSessionId: parent.id });
    expect(await runWorkCommand('create', [], { file: path, turn }, { env, fetcher: fetcher as typeof fetch })).toMatchObject({ id: created.id });
    const unauthorized = await f.app.inject({ method: 'POST', url: '/api/lark/agent-tools/work-items', headers: { authorization: `Bearer ${env.dutydeck_group_tools_token}` }, payload: { goal: 'x', plan: researchWorkPlan(['alpha']), idempotencyKey: 'no-turn' } });
    expect(unauthorized.statusCode).toBe(403);
    f.releases.get(parent.id)!();
    await vi.waitFor(() => expect(f.runtime.getActiveTaskContext(parent.id)).toBeUndefined());
    await expect(runWorkCommand('list', [], { turn }, { env, fetcher: fetcher as typeof fetch })).rejects.toMatchObject({ statusCode: 403 });
  });

  it('retains a failed delivery without running Agents again and accepts only the correct wait owner', async () => {
    const f = await fixture();
    await f.coordinator.handle(message('om_home', '/work research 开始'), f.config);
    const parent = await f.parent();
    const first = await f.item();
    await f.work.cancel(parent.id, first.id, first.revision, 'ou_alice');
    const plan: WorkPlan = { title: '需补充资料', outputStepId: 'report', steps: [
      { id: 'input', title: '选择资料', kind: 'wait', instruction: '请提供资料链接', dependsOn: [] },
      { id: 'report', title: '汇总', kind: 'agent', agentId: 'alpha', instruction: '综合两个来源', dependsOn: ['input'] }
    ] };
    await f.workbench.recordOrigin(parent.id, 'waiting', message('om_wait', ''), f.config);
    let waiting = await f.work.create(parent.id, { goal: '根据资料总结', plan, idempotencyKey: 'waiting' }, 'ou_alice');
    await f.work.tick(); waiting = await f.work.get(parent.id, waiting.id, 'ou_alice');
    expect(waiting.status).toBe('waiting');
    await expect(f.work.answer(parent.id, waiting.id, 'input', '秘密资料', waiting.revision, 'ou_bob')).rejects.toMatchObject({ code: 'WORK_ITEM_FORBIDDEN' });
    await f.coordinator.handle(message('om_answer', `/work answer ${waiting.id} input https://example.com/source`), f.config);
    await f.work.tick(); await f.settle();
    f.client.reply.mockRejectedValueOnce(new Error('transport failure'));
    f.client.send.mockRejectedValueOnce(new Error('transport failure'));
    await f.work.tick();
    await vi.waitFor(async () => expect((await f.work.get(parent.id, waiting.id, 'ou_alice')).delivery.status).toBe('error'));
    const count = f.prompts.length;
    await f.work.tick();
    await vi.waitFor(async () => expect((await f.work.get(parent.id, waiting.id, 'ou_alice')).delivery.status).toBe('delivered'));
    expect(f.prompts).toHaveLength(count);
    expect((await f.work.get(parent.id, waiting.id, 'ou_alice')).output?.text).toBeTruthy();
  });

  it('creates a disabled Feishu schedule once and enables/disables it using the existing executor', async () => {
    const f = await fixture();
    const parent = await f.runtime.start({ agentId: 'alpha', cwd: f.directory, source: 'lark', sourceId: `${f.config.appId}:oc_group:group:thread:omt_topic`, permissionMode: 'ask' });
    const automation = new SessionAutomationService({ repositories: f.repos, runtime: f.runtime, authorize: async (_sid, actor) => actor === 'ou_alice' });
    cleanup.push(() => automation.close());
    const event = message('om_schedule', '/schedule every 60 汇总目标');
    await executeScheduleCommand(automation, f.repos.config, parent.id, 'every 60 汇总目标', event, f.config);
    await executeScheduleCommand(automation, f.repos.config, parent.id, 'every 60 汇总目标', event, f.config);
    const schedules = (await automation.listBySession(parent.id, 'ou_alice')).schedules;
    expect(schedules).toHaveLength(1); expect(schedules[0]!.enabled).toBe(false);
    expect(JSON.parse((await f.repos.config.get(`automation.delivery-target.${schedules[0]!.id}`))!)).toMatchObject({ replyMessageId: 'om_schedule', replyInThread: true });
    await executeScheduleCommand(automation, f.repos.config, parent.id, `enable ${schedules[0]!.id}`, event, f.config);
    expect((await automation.listBySession(parent.id, 'ou_alice')).schedules[0]!.enabled).toBe(true);
    await executeScheduleCommand(automation, f.repos.config, parent.id, `disable ${schedules[0]!.id}`, event, f.config);
    expect((await automation.listBySession(parent.id, 'ou_alice')).schedules[0]!.enabled).toBe(false);
    expect(f.prompts).toHaveLength(0);
  });
});
