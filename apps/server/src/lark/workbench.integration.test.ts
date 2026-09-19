import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RuntimeError, agentConfigSchema, workPlanConfirmationRequired, type AgentDriver, type WorkItem, type WorkPlan } from '@dutydeck/shared';
import { createRepositories } from '@dutydeck/storage';
import { DutydeckRuntime } from '@dutydeck/runtime';
import { RelayAskBroker, RelayCapabilityRegistry } from '@dutydeck/relay';
import { WorkItemService } from '../work-items.js';
import type { WorkItemRequest } from '../work-item-interactions.js';
import { WorkItemInteractions } from '../work-item-interactions.js';
import { LarkWorkbench, composeWorkPlan, researchWorkPlan, workItemElements, workNoticeFingerprint } from './workbench.js';
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
  const repos = createRepositories(join(directory, 'state.db'), { newDatabaseAuthority: 'ledger_v1' });
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
      start: async () => {}, resume: async () => {}, interrupt: async () => releases.get(sessionId)?.(), stop: async () => releases.get(sessionId)?.(),
      send: async promptOrSubmission => {
        const prompt = typeof promptOrSubmission === 'string' ? promptOrSubmission : promptOrSubmission.prompt;
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
  tools = new LarkAgentToolsService(capabilities, repos.config, { workbenchTask: (id: string) => runtime.getActiveTaskContext(id) });
  const broker = new RelayAskBroker({ publish: async (id: string, input: any) => { await runtime.publishSessionEvent(id, 'text', { text: input.text, relay: input.kind, askId: input.askId }); } });
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
  work = new WorkItemService({ repositories: repos, runtime, authorize, requireConfirmation: workPlanConfirmationRequired, prepareDelivery: (sid, id, key) => workbench.prepareDelivery(sid, id, key), deliver: item => workbench.deliver(item), notify: (item, actor) => workbench.notify(item, actor) });
  interactions = new WorkItemInteractions(work, runtime, broker, approval);
  const agents = ['alpha', 'beta'].map(id => agentConfigSchema.parse({ id, name: id, command: 'fixture', protocol: 'acp', permissionMode: 'ask', cwd: directory }));
  await runtime.initialize(agents);
  const config: StoredLarkConfig = { appId: 'cli_workbench', appSecret: 'fixture-secret', workspace: directory, defaultAgentId: 'alpha', permissionMode: 'ask', listening: true,
    fullTrustConfirmed: true, preInjectPrompt: '', structuredAskCards: false, groupCardMention: false, groupToolsEnabled: true, groupToolsAllowSend: false, pushIntervalMs: 1000, hideTraceOnComplete: false,
    allowedUsers: [], allowedEmails: [], allowedBots: [], peerBotsAllowed: false, highRiskAllowedUsers: [], highRiskAllowedEmails: [], highRiskPattern: 'dangerous', riskControlMode: 'off' };
  await repos.config.set(larkBotsConfigKey, JSON.stringify([config]));
  const coordinator = new LarkMessageCoordinator(runtime, client as any, log, Math.random, 'ou_bot', undefined, repos.channelMappings, async () => 'group', undefined, undefined, { store: repos.config, broker, workbench });
  await coordinator.initializeWorkflows(config);
  await coordinator.startReconciliation(config);
  const app = await buildApp(runtime, { relay: { runtime, broker, capabilities: new RelayCapabilityRegistry(repos.sessions, 'http://localhost', 'fixture-relay') }, workItems: { service: work, interactions, authorize: async () => ({ allowed: true, actorId: 'installation_owner' }) }, workItemTools: { runtime, work, tools }, lark: { listeningDisabled: true } });
  cleanup.push(async () => { coordinator.stop(); workbench.close(); await work.close(); broker.close(); for (const release of releases.values()) release(); await app.close(); await runtime.shutdown(); capabilities.close(); repos.close(); await rm(directory, { recursive: true, force: true }); });
  const parent = async () => (await runtime.listSessions()).find(session => session.source === 'lark')!;
  const item = async () => (await work.listBySession((await parent()).id, 'ou_alice'))[0]!;
  const settle = async () => { await vi.waitFor(async () => { const children = (await runtime.listSessions()).filter(session => session.source === 'work_item'); const tasks = (await Promise.all(children.map(s => runtime.getTasks(s.id)))).flat(); expect(tasks.length).toBeGreaterThan(0); expect(tasks.every(t => ['completed','failed','cancelled','interrupted'].includes(t.status))).toBe(true); }); };
  return { directory, repos, runtime, work, broker, approval, terminalWrites, tools, capabilities, interactions, workbench, coordinator, app, client, config, cards, prompts, permissionCalls, releases, parent, item, settle };
}

describe('亮屏指纹与卡片元素（纯函数）', () => {
  const baseItem = (status: WorkItem['status'], stepStatus: WorkItem['steps'][number]['status']): WorkItem => ({
    id: 'work_1', parentSessionId: 'ses_1', title: '研究目标', goal: '比较两个方案', revision: 2, status,
    plan: { title: '研究目标', outputStepId: 'alpha', steps: [
      { id: 'alpha', title: '独立研究', kind: 'agent', agentId: 'alpha', instruction: '独立完成研究', dependsOn: [] }
    ] },
    steps: [{ id: 'alpha', status: stepStatus, attempts: [] }],
    createdAt: '2026-09-13T00:00:00Z', updatedAt: '2026-09-13T00:00:00Z',
    delivery: { status: 'not_requested', attempts: 0 }
  });
  const question = (text: string): WorkItemRequest[] =>
    [{ stepId: 'alpha', sessionId: 'ses_child', taskId: 'task_1', requestId: 'req_1', kind: 'question', text }];

  it('N2 回归②：焦点态不变（含 running→completed）指纹一致，错误文案变化也不换指纹', () => {
    expect(workNoticeFingerprint(baseItem('completed', 'completed'))).toBe(workNoticeFingerprint(baseItem('running', 'running')));
    expect(workNoticeFingerprint(baseItem('running', 'pending'))).toBe(workNoticeFingerprint(baseItem('running', 'running')));
    expect(workNoticeFingerprint(baseItem('waiting', 'running'), question('问题 A')))
      .toBe(workNoticeFingerprint(baseItem('waiting', 'running'), question('问题 A 的文案完全改写但 requestId 不变')));
  });

  it('N2 回归①的判定基础：waiting / blocked / failed 或新待决请求出现必换指纹', () => {
    const running = workNoticeFingerprint(baseItem('running', 'running'));
    expect(workNoticeFingerprint(baseItem('waiting', 'waiting'))).not.toBe(running);
    expect(workNoticeFingerprint(baseItem('failed', 'failed'))).not.toBe(running);
    expect(workNoticeFingerprint(baseItem('running', 'running'), question('新问题'))).not.toBe(running);
    const requests = question('同一问题');
    const replaced: WorkItemRequest[] = [{ ...requests[0]!, requestId: 'req_2' }];
    expect(workNoticeFingerprint(baseItem('waiting', 'running'), replaced)).not.toBe(workNoticeFingerprint(baseItem('waiting', 'running'), requests));
  });

  it('待确认卡只列计划：分工、依赖、工作区与开始执行/取消计划，不出现执行期入口', () => {
    const preview: WorkItem = { ...baseItem('awaiting_confirmation', 'pending'),
      plan: { title: '两步编排', outputStepId: 'report', steps: [
        { id: 'alpha', title: '独立研究', kind: 'agent', agentId: 'alpha', instruction: '独立完成研究', dependsOn: [], workspaceMode: 'worktree' },
        { id: 'report', title: '汇总并交付', kind: 'agent', agentId: 'beta', instruction: '综合上游成果', dependsOn: ['alpha'] }
      ] },
      steps: [{ id: 'alpha', status: 'pending', attempts: [] }, { id: 'report', status: 'pending', attempts: [] }] };
    const elements = workItemElements(preview, [], { agentNames: { alpha: '调研专家' } });
    const rendered = JSON.stringify(elements);
    expect(rendered).toContain('调研专家（alpha）');
    expect(rendered).toContain('独立 worktree');
    expect(rendered).toContain('依赖：独立研究');
    const operations = elements.flatMap(element => element.behaviors?.map((behavior: any) => behavior.value.dutydeck_work_item) ?? []);
    expect(operations).toEqual(['confirm', 'cancel', 'show']);
    expect(rendered).not.toContain('/work answer');
  });

  it('S5：agent 有显示名时展示「名称（agentId）」，名称缺失或与 id 相同则只显示 agentId', () => {
    const item = baseItem('running', 'running');
    const named = JSON.stringify(workItemElements(item, [], { agentNames: { alpha: '调研专家' } }));
    expect(named).toContain('调研专家（alpha）');
    const fallback = JSON.stringify(workItemElements(item));
    expect(fallback).toContain(' · alpha');
    expect(fallback).not.toContain('（alpha）');
    const sameName = JSON.stringify(workItemElements(item, [], { agentNames: { alpha: 'alpha' } }));
    expect(sameName).not.toContain('（alpha）');
  });
});

describe('Feishu workbench with real Runtime, SQLite and HTTP routes', () => {
  it('starts one goal from Feishu, runs two independent Agents, joins and delivers to the originating topic', async () => {
    const f = await fixture();
    await f.coordinator.handle(message('om_goal', '/work research 比较两个方案'), f.config);
    expect((await f.item()).plan.steps).toHaveLength(3);
    // 人手输入的固定模板不过闸门：本人即发起人，直接开跑。
    expect((await f.item()).status).toBe('running');
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

  it('群聊里 Agent 提交的计划先进待确认：确认前不派发任何步骤，只有目标发起人能确认', async () => {
    const f = await fixture('held');
    await f.coordinator.handle(message('om_gate', '为这个目标安排独立研究'), f.config);
    await vi.waitFor(() => expect(f.prompts).toHaveLength(1));
    const parent = await f.parent();
    const active = f.runtime.getActiveTaskContext(parent.id)!;
    const env = f.capabilities.environmentFor(parent);
    const turn = f.capabilities.workbenchTurnToken(parent.id, active.taskId);
    expect(f.prompts[0]!.prompt).toContain('awaiting_confirmation');
    expect(f.prompts[0]!.prompt).toContain('不提供代替用户回答等待、批准权限或确认计划的入口');
    const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
      const response = await f.app.inject({ method: init?.method as any ?? 'GET', url: new URL(String(url)).pathname, headers: Object.fromEntries(new Headers(init?.headers)), ...(init?.body ? { payload: String(init.body) } : {}) });
      return new Response(response.body, { status: response.statusCode, headers: { 'content-type': 'application/json' } });
    };
    const path = join(f.directory, 'plan.json');
    await writeFile(path, JSON.stringify({ goal: '独立目标', plan: researchWorkPlan(['alpha', 'beta']), idempotencyKey: 'gated' }));
    const created = await runWorkCommand('create', [], { file: path, turn }, { env, fetcher: fetcher as typeof fetch }) as unknown as WorkItem;
    expect(created.status).toBe('awaiting_confirmation');

    // 闸门核心：确认前 tick 多轮也不得起任何子 Session、不得下发任何 prompt。
    await f.work.tick(); await f.work.tick(); await f.work.tick();
    expect((await f.runtime.listSessions()).filter(session => session.source === 'work_item')).toHaveLength(0);
    expect(f.prompts).toHaveLength(1);
    expect((await f.work.get(parent.id, created.id, 'ou_alice')).steps.every(step => !step.attempts.length)).toBe(true);

    const confirmCard = () => f.cards.find(card => card.input.elements?.some((element: any) => element.behaviors?.[0]?.value?.dutydeck_work_item === 'confirm'));
    await vi.waitFor(() => expect(confirmCard()).toBeDefined());
    const card = confirmCard()!;
    const value = card.input.elements.find((element: any) => element.behaviors?.[0]?.value?.dutydeck_work_item === 'confirm').behaviors[0].value;
    expect((await f.coordinator.handleAction(value, 'ou_bob', { messageId: card.messageId, chatId: 'oc_group' })).type).toBe('error');
    expect((await f.work.get(parent.id, created.id, 'ou_alice')).status).toBe('awaiting_confirmation');
    expect(f.prompts).toHaveLength(1);

    expect((await f.coordinator.handleAction(value, 'ou_alice', { messageId: card.messageId, chatId: 'oc_group' })).type).toBe('success');
    expect((await f.work.get(parent.id, created.id, 'ou_alice')).status).toBe('running');
    await f.work.tick();
    await vi.waitFor(() => expect(f.prompts.length).toBeGreaterThan(1));
  });

  it('人可以自己起一次编排：/work plan 拼出计划、先出一张待确认卡，确认后才执行', async () => {
    const f = await fixture();
    await f.coordinator.handle(message('om_plan', '/work plan 调研可行方案；核查风险与反例'), f.config);
    const item = await f.item();
    expect(item.status).toBe('awaiting_confirmation');
    expect(item.plan.steps.map(step => step.id)).toEqual(['step1', 'step2', 'report']);
    expect(item.plan.steps[2]!.dependsOn).toEqual(['step1', 'step2']);
    await f.work.tick(); await f.work.tick();
    expect(f.prompts).toHaveLength(0);
    const preview = () => f.cards.filter(card => card.input.elements?.some((element: any) => element.behaviors?.[0]?.value?.dutydeck_work_item === 'confirm'));
    const confirmCards = preview();
    expect(confirmCards).toHaveLength(1);
    // 卡头必须说「待确认」并按等待人的样式渲染，不能顶着「执行中」和转圈图标。
    expect(confirmCards[0]!.input).toMatchObject({ statusLabel: '待确认', awaitingHuman: true });
    // 重放同一条命令（同一 messageId → 同一目标）不得再推一张一样的卡。
    await f.workbench.command(item.parentSessionId, 'plan 调研可行方案；核查风险与反例', message('om_plan', ''), f.config);
    expect(preview()).toHaveLength(1);
    const value = confirmCards[0]!.input.elements.find((element: any) => element.behaviors?.[0]?.value?.dutydeck_work_item === 'confirm').behaviors[0].value;
    expect((await f.coordinator.handleAction(value, 'ou_alice', { messageId: confirmCards[0]!.messageId, chatId: 'oc_group' })).type).toBe('success');
    await f.work.tick(); await f.settle();
    expect(f.prompts).toHaveLength(2);
    await expect(f.workbench.command(item.parentSessionId, `plan 只有一步`, message('om_plan_bad', ''), f.config)).rejects.toMatchObject({ code: 'WORK_ITEM_PLAN_STEPS_REQUIRED' });
    // 超长分段要给出可读报错，而不是把 zod 的校验 JSON 贴到卡上。
    await expect(f.workbench.command(item.parentSessionId, `plan ${'很'.repeat(30_001)}；第二步`, message('om_plan_long', ''), f.config)).rejects.toMatchObject({ code: 'WORK_ITEM_PLAN_STEP_TOO_LONG' });
  });

  it('待确认卡只出一张：通知侧与命令侧抢同一条剧集键，抢到的才发', async () => {
    const f = await fixture();
    const confirmCards = () => f.cards.filter(card => card.input.elements?.some((element: any) => element.behaviors?.[0]?.value?.dutydeck_work_item === 'confirm'));
    await f.coordinator.handle(message('om_plan', '/work plan 调研可行方案；核查风险'), f.config);
    const parent = (await f.parent()).id;
    expect(confirmCards()).toHaveLength(1);
    await f.workbench.recordOrigin(parent, 'om_race', message('om_race', '/work plan 另起一个；再核查'), f.config);
    const item = await f.work.create(parent, { goal: '另起一个；再核查', plan: composeWorkPlan(['另起一个', '再核查'], ['alpha', 'beta']), idempotencyKey: 'om_race' }, 'ou_alice', true);
    expect(item.status).toBe('awaiting_confirmation');
    // 1 秒心跳与命令侧并发落在同一条剧集上：两侧都必须用 CAS 抢键，群里只能出现一张卡。
    await Promise.all([f.workbench.notify(item, 'ou_alice'), f.workbench.notify(item, 'ou_alice')]);
    expect(confirmCards()).toHaveLength(2);
  });

  it('发送失败不把待确认闸门静默丢掉：退避到期后补发一张，已发出的不再重发', async () => {
    const f = await fixture();
    const confirmCards = () => f.cards.filter(card => card.input.elements?.some((element: any) => element.behaviors?.[0]?.value?.dutydeck_work_item === 'confirm'));
    await f.coordinator.handle(message('om_plan', '/work plan 调研可行方案；核查风险'), f.config);
    const parent = (await f.parent()).id;
    const before = confirmCards().length;
    await f.workbench.recordOrigin(parent, 'om_retry', message('om_retry', '/work plan 补发用例；再核查'), f.config);
    const item = await f.work.create(parent, { goal: '补发用例；再核查', plan: composeWorkPlan(['补发用例', '再核查'], ['alpha', 'beta']), idempotencyKey: 'om_retry' }, 'ou_alice', true);
    const key = `workbench.notice.${item.id}.${workNoticeFingerprint(item, [])}`;

    // 一次瞬时发送失败：回复和它的兜底发送都打不通。
    const [reply, send] = [f.client.reply, f.client.send];
    f.client.reply = vi.fn(async () => { throw new Error('feishu unavailable'); }) as any;
    f.client.send = vi.fn(async () => { throw new Error('feishu unavailable'); }) as any;
    await expect(f.workbench.notify(item, 'ou_alice')).rejects.toThrow();
    Object.assign(f.client, { reply, send });
    expect(confirmCards()).toHaveLength(before);

    // 键被置回可重试，并且带退避：1 秒心跳不会把一次失败放大成每秒一次的飞书请求。
    const failed = await f.repos.config.get(key);
    expect(failed).toMatch(/^failed:1:\d+$/);
    expect(Number(failed!.split(':')[2])).toBeGreaterThan(Date.now() + 1_000);

    // 退避未到期时重入只原位 PATCH，不补卡。
    await f.workbench.notify(item, 'ou_alice');
    expect(confirmCards()).toHaveLength(before);

    // 退避到期后的下一轮心跳把这张待确认卡补出来——闸门不会因为一次失败就消失。
    await f.repos.config.set(key, 'failed:1:0');
    await f.workbench.notify(item, 'ou_alice');
    expect(confirmCards()).toHaveLength(before + 1);

    // 已经发出去的卡是终态，后续心跳只 PATCH，不会再发一遍。
    expect(await f.repos.config.get(key)).toBe('sent');
    await f.workbench.notify(item, 'ou_alice');
    await f.workbench.notify(item, 'ou_alice');
    expect(confirmCards()).toHaveLength(before + 1);
  });

  it('命令侧与通知侧共用同一把锁：/work plan 发送失败后由心跳补发，不重复也不丢', async () => {
    const f = await fixture();
    const confirmCards = () => f.cards.filter(card => card.input.elements?.some((element: any) => element.behaviors?.[0]?.value?.dutydeck_work_item === 'confirm'));
    await f.coordinator.handle(message('om_plan', '/work plan 调研可行方案；核查风险'), f.config);
    const parent = (await f.parent()).id;
    const before = confirmCards().length;

    const [reply, send] = [f.client.reply, f.client.send];
    f.client.reply = vi.fn(async () => { throw new Error('feishu unavailable'); }) as any;
    f.client.send = vi.fn(async () => { throw new Error('feishu unavailable'); }) as any;
    await expect(f.workbench.command(parent, 'plan 命令侧补发；再核查', message('om_plan_fail', ''), f.config)).rejects.toThrow();
    Object.assign(f.client, { reply, send });
    expect(confirmCards()).toHaveLength(before);

    const item = (await f.work.listBySession(parent, 'ou_alice')).find(value => value.title.startsWith('命令侧补发'))!;
    // 计划已落库停在待确认，卡却没发出去——命令侧必须把键置回可重试，否则闸门就此静默消失。
    expect(item.status).toBe('awaiting_confirmation');
    const key = `workbench.notice.${item.id}.${workNoticeFingerprint(item, [])}`;
    expect(await f.repos.config.get(key)).toMatch(/^failed:1:\d+$/);

    await f.repos.config.set(key, 'failed:1:0');
    await f.workbench.notify(item, 'ou_alice');
    expect(confirmCards()).toHaveLength(before + 1);
    // 补发之后命令重放也不会再推一张：两侧看的是同一把锁的同一个终态。
    await f.workbench.command(parent, 'plan 命令侧补发；再核查', message('om_plan_fail', ''), f.config);
    expect(confirmCards()).toHaveLength(before + 1);
  });

  it('持有者发送耗时超过租约时仍只留下一张待确认卡：两条路径用同一个幂等键', async () => {
    const f = await fixture();
    const confirmCards = () => f.cards.filter(card => card.input.elements?.some((element: any) => element.behaviors?.[0]?.value?.dutydeck_work_item === 'confirm'));
    await f.coordinator.handle(message('om_plan', '/work plan 调研可行方案；核查风险'), f.config);
    const parent = (await f.parent()).id;
    const before = confirmCards().length;

    // 飞书按 uuid 收拢重复发送：同一个幂等键只产生一条消息。
    const byIdempotencyKey = new Map<string, { messageId: string }>();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let firstSend = true;
    const deliver = async (input: any) => {
      // 第一次发送撞上频控退避，耗时超过租约。
      if (firstSend) { firstSend = false; await held; }
      const existing = byIdempotencyKey.get(input.idempotencyKey);
      if (existing) return existing;
      const result = { messageId: `om_dedup_${byIdempotencyKey.size + 1}` };
      byIdempotencyKey.set(input.idempotencyKey, result);
      f.cards.push({ messageId: result.messageId, input });
      return result;
    };
    Object.assign(f.client, { reply: vi.fn(deliver), send: vi.fn(deliver) });

    const running = f.workbench.command(parent, 'plan 长发送；再核查', message('om_hold', ''), f.config);
    const item = await vi.waitFor(async () => {
      const found = (await f.work.listBySession(parent, 'ou_alice')).find(value => value.title.startsWith('长发送'));
      expect(found).toBeDefined();
      return found!;
    });
    const key = `workbench.notice.${item.id}.${workNoticeFingerprint(item, [])}`;
    await vi.waitFor(async () => expect(await f.repos.config.get(key)).toMatch(/^sending:1:\d+$/));

    // 租约到期，但持有者还卡在发送里：心跳这一侧会合法地抢到锁，再发一次。
    await f.repos.config.set(key, 'sending:1:0');
    await f.workbench.notify(item, 'ou_alice');
    release();
    await running;

    // 两次发送用的是同一个幂等键，飞书把第二次收拢掉，群里仍然只有一张。
    expect(confirmCards()).toHaveLength(before + 1);
    expect(byIdempotencyKey.size).toBe(1);
  });

  it('HTTP 也能确认待确认的计划，确认前 REST 层不会启动任何步骤', async () => {
    const f = await fixture();
    await f.coordinator.handle(message('om_rest', '/work plan 先调研；再核查'), f.config);
    const parent = await f.parent();
    const item = await f.item();
    expect(item.status).toBe('awaiting_confirmation');
    const stale = await f.app.inject({ method: 'POST', url: `/api/sessions/${parent.id}/work-items/${item.id}/confirm`, payload: { expectedRevision: item.revision + 3 } });
    expect(stale.statusCode).toBe(409);
    await f.work.tick(); expect(f.prompts).toHaveLength(0);
    const confirmed = await f.app.inject({ method: 'POST', url: `/api/sessions/${parent.id}/work-items/${item.id}/confirm`, payload: { expectedRevision: item.revision } });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json().status).toBe('running');
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
    expect(f.permissionCalls).toHaveBeenCalledWith(`permit_${request.sessionId}`, false);
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
    expect(created).toMatchObject({ status: 'awaiting_confirmation', parentSessionId: parent.id });
    expect(await runWorkCommand('create', [], { file: path, turn }, { env, fetcher: fetcher as typeof fetch })).toMatchObject({ id: created.id });
    const unauthorized = await f.app.inject({ method: 'POST', url: '/api/lark/agent-tools/work-items', headers: { authorization: `Bearer ${env.dutydeck_group_tools_token}` }, payload: { goal: 'x', plan: researchWorkPlan(['alpha']), idempotencyKey: 'no-turn' } });
    expect(unauthorized.statusCode).toBe(403);
    f.releases.get(parent.id)!();
    await vi.waitFor(() => expect(f.runtime.getActiveTaskContext(parent.id)).toBeUndefined());
    await expect(runWorkCommand('list', [], { turn }, { env, fetcher: fetcher as typeof fetch })).rejects.toMatchObject({ statusCode: 403 });
  });

  it('prepareDelivery rejects on wrong namespace, wrong App, wrong turn, or missing legacy source when runtime_task_id is missing', async () => {
    const f = await fixture('held');
    await f.coordinator.handle(message('om_delivery_narrow', '测试交付来源绑定的窄拒绝'), f.config);
    await vi.waitFor(() => expect(f.prompts).toHaveLength(1));
    const parent = await f.parent();

    const cards = await f.repos.channelMappings.list(`lark-card:${f.config.appId}`);
    const cardMapping = cards.find(c => c.sessionId === parent.id)!;
    const originalExtra = JSON.parse(cardMapping.extra!);

    // 1. 模拟回执尚未落库（删掉 runtime_task_id）
    // 1a. 错 turn: saved.turn 设为 9999
    await f.repos.channelMappings.save({ ...cardMapping, extra: JSON.stringify({ ...originalExtra, runtime_task_id: undefined, turn: 9999 }) });
    await expect(f.workbench.prepareDelivery(parent.id, 'work_wrong_turn', 'key_wrong_turn')).rejects.toMatchObject({
      code: 'WORK_ITEM_ORIGIN_MISSING'
    });

    // 1b. 错 App: saved.app_id 设为 'cli_other_app'
    await f.repos.channelMappings.save({ ...cardMapping, extra: JSON.stringify({ ...originalExtra, runtime_task_id: undefined, app_id: 'cli_other_app' }) });
    await expect(f.workbench.prepareDelivery(parent.id, 'work_wrong_app', 'key_wrong_app')).rejects.toMatchObject({
      code: 'WORK_ITEM_ORIGIN_MISSING'
    });

    // 1c. 错 namespace: 当前任务接受记录不是 'runtime'
    const getAccepted = f.repos.execution.getAcceptedTask.bind(f.repos.execution);
    const spy = vi.spyOn(f.repos.execution, 'getAcceptedTask').mockImplementation((tid: string) => {
      const real = getAccepted(tid);
      if (!real) return undefined;
      return { ...real, request: real.request ? { ...real.request, namespace: 'work_item' as any } : undefined };
    });
    await f.repos.channelMappings.save({ ...cardMapping, extra: JSON.stringify({ ...originalExtra, runtime_task_id: undefined }) });
    await expect(f.workbench.prepareDelivery(parent.id, 'work_wrong_ns', 'key_wrong_ns')).rejects.toMatchObject({
      code: 'WORK_ITEM_ORIGIN_MISSING'
    });
    spy.mockRestore();

    // 1d. legacy 缺来源：getAcceptedTask 抛 EXECUTION_AUTHORITY_LEGACY
    const legacySpy = vi.spyOn(f.repos.execution, 'getAcceptedTask').mockImplementation(() => {
      throw new RuntimeError('EXECUTION_AUTHORITY_LEGACY', 'Legacy execution authority', 409);
    });
    await expect(f.workbench.prepareDelivery(parent.id, 'work_legacy_missing', 'key_legacy_missing')).rejects.toMatchObject({
      code: 'WORK_ITEM_ORIGIN_MISSING'
    });
    legacySpy.mockRestore();

    // 恢复原卡片映射并放行
    await f.repos.channelMappings.save({ ...cardMapping, extra: JSON.stringify(originalExtra) });
    f.releases.get(parent.id)!();
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
    let waiting = await f.work.create(parent.id, { goal: '根据资料总结', plan, idempotencyKey: 'waiting' }, 'ou_alice', false);
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

  // 构造一个含 wait 步骤、首个 tick 后停在 waiting 并已亮屏推卡的目标。
  async function startWaitingWork(f: Awaited<ReturnType<typeof fixture>>) {
    await f.coordinator.handle(message('om_goal', '/work research 开始'), f.config);
    const parentId = (await f.parent()).id;
    const first = (await f.work.listBySession(parentId, 'ou_alice'))[0]!;
    await f.work.cancel(parentId, first.id, first.revision, 'ou_alice');
    const plan: WorkPlan = { title: '需补充资料', outputStepId: 'report', steps: [
      { id: 'input', title: '选择资料', kind: 'wait', instruction: '请提供资料链接', dependsOn: [] },
      { id: 'report', title: '汇总', kind: 'agent', agentId: 'alpha', instruction: '综合两个来源', dependsOn: ['input'] }
    ] };
    await f.workbench.recordOrigin(parentId, 'waiting', message('om_wait', ''), f.config);
    const created = await f.work.create(parentId, { goal: '根据资料总结', plan, idempotencyKey: 'waiting' }, 'ou_alice', false);
    await f.work.tick();
    await vi.waitFor(() => expect(f.cards.some(card => JSON.stringify(card.input).includes('/work answer'))).toBe(true));
    const card = f.cards.find(card => JSON.stringify(card.input).includes('/work answer'))!;
    return { parentId, workId: created.id, card };
  }

  const findButton = (card: { input: any }, operation: string) =>
    card.input.elements.find((element: any) => element.tag === 'button' && element.behaviors?.[0]?.value?.dutydeck_work_item === operation).behaviors[0].value;

  it('N2：wait 步骤出现必推新卡；同一焦点剧集重复 notify 只原位 PATCH 不推新卡', async () => {
    const f = await fixture();
    const { workId, card } = await startWaitingWork(f);
    expect(card.input.elements.some((element: any) => element.tag === 'form' && String(element.name).startsWith('work_answer_'))).toBe(true);
    const mapping = await f.repos.channelMappings.get(`lark-work-card:${f.config.appId}`, card.messageId);
    expect(JSON.parse(mapping!.extra!)).toMatchObject({ workId, chatId: 'oc_group', messageId: card.messageId });
    const answerCards = () => f.cards.filter(candidate => JSON.stringify(candidate.input).includes('/work answer'));
    expect(answerCards()).toHaveLength(1);
    // 第二个 tick 焦点态仍为 waiting：指纹相同，只能 PATCH 已发出的卡。
    await f.work.tick();
    await vi.waitFor(() => expect(f.client.update).toHaveBeenCalledWith(expect.objectContaining({ messageId: card.messageId })));
    expect(answerCards()).toHaveLength(1);
  });

  it('P0-3：表单回调一次性 CAS 推进 waiting 步骤；listener 未合入 form_value 时 fail-closed', async () => {
    const f = await fixture();
    const { parentId, workId, card } = await startWaitingWork(f);
    const form = card.input.elements.find((element: any) => element.tag === 'form' && String(element.name).startsWith('work_answer_'));
    const value = form.elements.find((element: any) => element.form_action_type === 'submit').behaviors[0].value;
    const context = { messageId: card.messageId, chatId: 'oc_group' };
    const missing = await f.coordinator.handleAction({ ...value }, 'ou_alice', context);
    expect(missing).toMatchObject({ type: 'error' });
    expect(String(missing.content)).toContain('请填写回答内容');
    expect((await f.work.listBySession(parentId, 'ou_alice')).find(item => item.id === workId)!.status).toBe('waiting');
    const result = await f.coordinator.handleAction({ ...value, form_value: { answer: '  https://example.com/data  ' } }, 'ou_alice', context);
    expect(result).toMatchObject({ type: 'success' });
    const updated = (await f.work.listBySession(parentId, 'ou_alice')).find(item => item.id === workId)!;
    expect(updated.steps.find(step => step.id === 'input')?.answer).toBe('https://example.com/data');
    expect(updated.steps.find(step => step.id === 'input')?.status).not.toBe('waiting');
    await vi.waitFor(() => expect(f.client.update).toHaveBeenCalledWith(expect.objectContaining({ messageId: card.messageId })));
  });

  it('P0-3：回调先回 toast 再整卡 PATCH 被点消息，并把新 revision 写回 mapping', async () => {
    const f = await fixture();
    const { card } = await startWaitingWork(f);
    const cancel = findButton(card, 'cancel');
    const result = await f.coordinator.handleAction({ ...cancel }, 'ou_alice', { messageId: card.messageId, chatId: 'oc_group' });
    expect(result).toMatchObject({ type: 'success', content: '目标状态已更新' });
    expect(f.client.update).not.toHaveBeenCalled();
    await vi.waitFor(async () => {
      const mapping = await f.repos.channelMappings.get(`lark-work-card:${f.config.appId}`, card.messageId);
      expect(JSON.parse(mapping!.extra!).revision).toBeGreaterThan(cancel.revision);
    });
    expect(f.client.update).toHaveBeenCalledWith(expect.objectContaining({ messageId: card.messageId }));
  });

  it('P0-3：被点消息 PATCH 失败时回退发送新卡，并为新卡登记 mapping', async () => {
    const f = await fixture();
    const { parentId, workId, card } = await startWaitingWork(f);
    f.client.update.mockImplementation(async (input: any) => {
      if (input.messageId === card.messageId) throw new Error('message too old');
      return { messageId: input.messageId };
    });
    const cancel = findButton(card, 'cancel');
    const before = f.cards.length;
    const result = await f.coordinator.handleAction({ ...cancel }, 'ou_alice', { messageId: card.messageId, chatId: 'oc_group' });
    expect(result).toMatchObject({ type: 'success' });
    await vi.waitFor(async () => {
      const mappings = (await f.repos.channelMappings.list(`lark-work-card:${f.config.appId}`))
        .filter(mapping => mapping.sessionId === parentId).map(mapping => ({ externalId: mapping.externalId, extra: JSON.parse(mapping.extra!) }));
      expect(mappings.some(mapping => mapping.externalId !== card.messageId && mapping.extra.workId === workId)).toBe(true);
    });
    expect(f.cards.length).toBeGreaterThan(before);
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
