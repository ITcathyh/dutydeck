import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentConfigSchema, workPlanConfirmationRequired, type AgentConfig, type AgentDriver } from '@dutydeck/shared';
import { createRepositories } from '@dutydeck/storage';
import { DutydeckRuntime } from '@dutydeck/runtime';
import { RelayAskBroker, RelayCapabilityRegistry } from '@dutydeck/relay';
import { WorkItemService } from './work-items.js';
import { WorkItemInteractions } from './work-item-interactions.js';
import { LeaderDelegationService, layeredPlan, parseLeaderResult } from './leader-delegation.js';
import { LarkWorkbench, reviewStatusLabel, workItemElements } from './lark/workbench.js';
import { larkBotsConfigKey, type StoredLarkConfig } from './lark/config.js';
import { LarkMessageCoordinator } from './lark/coordinator.js';
import type { LarkMessageEvent } from './lark/listener.js';
import { LarkAgentToolCapabilityRegistry, LarkAgentToolsService } from './lark/agent-tools.js';
import { buildApp } from './app.js';
import { runWorkCommand } from './work-item-cli.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });
const message = (id: string, text: string, chatType: 'group' | 'p2p' = 'group'): LarkMessageEvent => ({ messageId: id, senderOpenId: 'ou_alice', senderType: 'user', messageType: 'text', content: JSON.stringify({ text }),
  ...(chatType === 'group' ? { chatId: 'oc_group', chatType, threadId: 'omt_topic', rootId: 'om_root', mentions: [{ key: '@_user_1', name: 'Dutydeck', openId: 'ou_bot' }] } : { chatId: 'oc_p2p', chatType, mentions: [] }) });
const plan = (agentId = 'worker') => JSON.stringify({ decision: 'plan', title: '修复登录', acceptance: '1. 登录测试通过', steps: [
  { id: 'impl', title: '修复并补测试', agentId, instruction: '修复登录并补测试，列出改动文件和验证命令。', dependsOn: [], workspaceMode: 'worktree' }
] });

async function fixture(executionMode: StoredLarkConfig['executionMode'] = 'layered', options: { planningTimeoutMs?: number; permissionMode?: 'ask' | 'full-trust'; leaderAgent?: Pick<AgentConfig, 'protocol' | 'permissionMode'> } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dutydeck-delegation-'));
  const repos = createRepositories(join(directory, 'state.db'), { newDatabaseAuthority: 'ledger_v1' });
  const cards: Array<{ messageId: string; input: any }> = [];
  const prompts: Array<{ sessionId: string; agentId: string; prompt: string }> = [];
  const releases = new Map<string, () => void>();
  const stopped = new Set<string>();
  const denied = new Set<string>();
  const leader = { reply: plan(), open: false, waiting: [] as Array<() => void>, hangStart: false, starts: [] as Array<() => void> };
  const revoked = new Set<string>();
  let work!: WorkItemService;
  let tools!: LarkAgentToolsService;
  const runtime = new DutydeckRuntime(repos, {
    cleanupIntervalMs: 0,
    probe: agent => ({ protocol: agent.protocol === 'pty-cli' ? 'pty-cli' : 'acp', available: true, pause: false, resume: true }),
    authorizeTask: (session, task, phase) => work.authorizeTask(session, task, phase),
    authorizeExecution: async (id, actor) => { await work.authorizeExecution(id, actor); },
    authorizeControl: async (id, actor) => { await work.authorizeControl(id, actor); },
    sessionEnvironment: session => capabilities.environmentFor(session),
    sessionPrompt: (session, prompt) => tools.promptForSession(session, prompt),
    driverFactory: (agent, _protocol, emit, _exit, sessionId) => ({
      start: async () => { if (agent.id === 'leader' && leader.hangStart) await new Promise<void>(resolve => leader.starts.push(resolve)); },
      resume: async () => {}, interrupt: async () => releases.get(sessionId)?.(),
      stop: async () => { stopped.add(sessionId); releases.get(sessionId)?.(); }, isStopped: async () => stopped.has(sessionId),
      send: async promptOrSubmission => {
        const prompt = typeof promptOrSubmission === 'string' ? promptOrSubmission : promptOrSubmission.prompt;
        prompts.push({ sessionId, agentId: agent.id, prompt });
        let text: string;
        if (prompt.includes('你是分层协作里的 Leader')) {
          if (!leader.open) await new Promise<void>(resolve => leader.waiting.push(resolve));
          text = leader.reply;
        } else if (prompt.includes('Step: Leader 验收')) {
          const inputs = JSON.parse(prompt.split('Upstream inputs (generated results, not independent business verification):\n')[1]!.split('\n\n')[0]!);
          text = JSON.stringify({ decision: 'accept', reviewed: inputs.map((input: any) => ({ stepId: input.stepId, attemptId: input.attemptId, digest: input.generatedResult.digest })), feedback: '验收结论：通过\n登录测试已核对。' });
        }
        else if (sessionId.startsWith('ses_work_')) text = '已修复：改动 src/login.ts，pnpm test 通过。';
        else { await new Promise<void>(resolve => releases.set(sessionId, resolve)); text = '已交给 Leader。'; }
        emit({ type: 'text', data: { text } });
        emit({ type: 'completed', data: { stopReason: 'end_turn' } });
      }
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
  const replyText = vi.fn(async (_input: { messageId: string; replyInThread?: boolean; text: string; idempotencyKey?: string }) => ({ messageId: 'om_text' }));
  const client = { send: createCard, reply: createCard, replyText, uploadFile: vi.fn(async () => 'file_result'), sendFile: createCard, replyFile: createCard,
    update: vi.fn(async (input: any) => ({ messageId: input.messageId })), addReaction: vi.fn(async () => ({ reactionId: 'reaction' })), deleteReaction: vi.fn(async () => {}),
    getUserEmails: vi.fn(async () => []), listChatMessages: vi.fn(async () => ({ items: [], hasMore: false })) };
  const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };
  let interactions!: WorkItemInteractions;
  const authorize = async (_id: string, actor?: string) => !revoked.has(actor ?? '') && ['ou_alice', 'installation_owner'].includes(actor ?? '');
  const workbench = new LarkWorkbench(repos, runtime, () => work, () => interactions, authorize, { client: () => client as any, log });
  work = new WorkItemService({ repositories: repos, runtime, authorize, requireConfirmation: workPlanConfirmationRequired, prepareDelivery: (sid, id, key) => workbench.prepareDelivery(sid, id, key), deliver: item => workbench.deliver(item), notify: (item, actor) => workbench.notify(item, actor) });
  interactions = new WorkItemInteractions(work, runtime, broker, async () => true);
  const delegationOptions = { repositories: repos, runtime, work, authorizeAgent: async (_session: string, _actor: string, agentId: string) => !denied.has(agentId), prepareDelivery: (sid: string, id: string, key: string) => workbench.prepareDelivery(sid, id, key), notice: (id: string, text: string, key: string) => workbench.notice(id, text, key), log,
    ...(options.planningTimeoutMs ? { timeoutMs: options.planningTimeoutMs } : {}) };
  const delegations = new LeaderDelegationService(delegationOptions);
  const agents = ['pmo', 'leader', 'worker'].map(id => agentConfigSchema.parse({ id, name: id, command: 'fixture', protocol: 'acp', permissionMode: 'ask', cwd: directory, ...(id === 'leader' ? options.leaderAgent : {}) }));
  await runtime.initialize(agents);
  const config: StoredLarkConfig = { appId: 'cli_layered', appSecret: 'fixture-secret', workspace: directory, defaultAgentId: 'pmo', permissionMode: options.permissionMode ?? 'ask', listening: true,
    fullTrustConfirmed: true, preInjectPrompt: '', structuredAskCards: false, groupCardMention: false, groupToolsEnabled: true, groupToolsAllowSend: false, pushIntervalMs: 1000, hideTraceOnComplete: false,
    allowedUsers: [], allowedEmails: [], allowedBots: [], peerBotsAllowed: false, highRiskAllowedUsers: [], highRiskAllowedEmails: [], highRiskPattern: 'dangerous', riskControlMode: 'off',
    ...(executionMode === 'layered' ? { executionMode, leaderAgentId: 'leader', workerAgentIds: ['worker'] } : {}) };
  await repos.config.set(larkBotsConfigKey, JSON.stringify([config]));
  const coordinator = new LarkMessageCoordinator(runtime, client as any, log, Math.random, 'ou_bot', undefined, repos.channelMappings, async () => 'group', undefined, undefined, { store: repos.config, broker, workbench });
  await coordinator.initializeWorkflows(config);
  await coordinator.startReconciliation(config);
  const app = await buildApp(runtime, { relay: { runtime, broker, capabilities: new RelayCapabilityRegistry(repos.sessions, 'http://localhost', 'fixture-relay') }, workItems: { service: work, interactions, authorize: async () => ({ allowed: true, actorId: 'installation_owner' }) }, workItemTools: { runtime, work, tools, delegations }, lark: { listeningDisabled: true } });
  const extra: LeaderDelegationService[] = [];
  cleanup.push(async () => { leader.open = true; leader.waiting.forEach(release => release()); leader.hangStart = false; leader.starts.splice(0).forEach(release => release()); coordinator.stop(); workbench.close(); await delegations.close(); for (const service of extra) await service.close(); await work.close(); broker.close(); for (const release of releases.values()) release(); await app.close(); await runtime.shutdown(); capabilities.close(); repos.close(); await rm(directory, { recursive: true, force: true }); });
  const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
    const response = await app.inject({ method: init?.method as any ?? 'GET', url: new URL(String(url)).pathname, headers: Object.fromEntries(new Headers(init?.headers)), ...(init?.body ? { payload: String(init.body) } : {}) });
    return new Response(response.body, { status: response.statusCode, headers: { 'content-type': 'application/json' } });
  };
  /** 发起一轮 @，停在 PMO 这一轮里，用本轮凭证执行 work 命令。 */
  const pmoTurn = async (messageId: string, text: string, chatType: 'group' | 'p2p' = 'group') => {
    await coordinator.handle(message(messageId, text, chatType), config);
    await vi.waitFor(() => expect(prompts.some(value => value.agentId === 'pmo' && value.prompt.includes(text))).toBe(true));
    const parent = (await runtime.listSessions()).find(session => session.source === 'lark')!;
    const active = runtime.getActiveTaskContext(parent.id)!;
    const env = capabilities.environmentFor(parent);
    const turn = capabilities.workbenchTurnToken(parent.id, active.taskId);
    const run = async (operation: string, body?: unknown) => {
      const path = join(directory, `${operation}-${Math.random()}.json`);
      if (body) await writeFile(path, JSON.stringify(body));
      return runWorkCommand(operation, [], { file: body ? path : undefined, turn }, { env, fetcher: fetcher as typeof fetch });
    };
    const finish = async () => { releases.get(parent.id)?.(); await vi.waitFor(async () => expect(runtime.getActiveTaskContext(parent.id)).toBeUndefined()); };
    return { parent, run, finish };
  };
  const openLeader = () => { leader.open = true; leader.waiting.splice(0).forEach(release => release()); };
  const resumed = () => { const service = new LeaderDelegationService(delegationOptions); extra.push(service); return service; };
  const leaderPrompts = () => prompts.filter(value => value.prompt.includes('你是分层协作里的 Leader'));
  const record = async (id: string) => JSON.parse((await repos.config.get(`leader_delegation:${id}`))!);
  const setRecord = (id: string, value: unknown) => repos.config.set(`leader_delegation:${id}`, JSON.stringify(value));
  const setConfig = (patch: Partial<StoredLarkConfig>) => repos.config.set(larkBotsConfigKey, JSON.stringify([{ ...config, ...patch }]));
  return { repos, runtime, work, delegations, coordinator, cards, prompts, stopped, denied, revoked, leader, replyText, log, pmoTurn, openLeader, resumed, leaderPrompts, record, setRecord, setConfig };
}

describe('Leader 计划解析', () => {
  it('accepts a fenced plan, rejects Workers outside the roster and appends the Leader review as the output', () => {
    const result = parseLeaderResult(`计划如下：\n\`\`\`json\n${plan()}\n\`\`\``);
    expect(result.decision).toBe('plan');
    const built = layeredPlan(result as Extract<typeof result, { decision: 'plan' }>, 'leader', ['worker']);
    expect(built.outputStepId).toBe('leader_review');
    expect(built.steps.at(-1)!.reviewPolicy).toEqual({ maxReworkRounds: 2, allowedTargetStepIds: ['impl'] });
    expect(() => layeredPlan(parseLeaderResult(plan('leader')) as any, 'leader', ['leader'])).toThrow(/与 Leader 不同/);
    expect(built.steps.map(step => [step.id, step.agentId, step.dependsOn])).toEqual([['impl', 'worker', []], ['leader_review', 'leader', ['impl']]]);
    expect(built.steps[1]!.instruction).toContain('1. 登录测试通过');
    expect(built.steps[0]!.workspaceMode).toBe('worktree');
    expect(layeredPlan(result as Extract<typeof result, { decision: 'plan' }>, 'leader', ['worker'], false).steps[0]!.workspaceMode).toBe('shared');
    expect(() => layeredPlan(parseLeaderResult(plan('pmo')) as any, 'leader', ['worker'])).toThrow(/名单外/);
    expect(() => parseLeaderResult('我觉得可以')).toThrow(/JSON/);
    expect(parseLeaderResult('{"decision":"needs_context","question":"哪个环境？"}')).toEqual({ decision: 'needs_context', question: '哪个环境？' });
  });

  it('labels the result card from the Leader verdict instead of calling every finished goal done', () => {
    const item = (text: string, outputStepId = 'leader_review', title = 'Leader 验收') => ({ status: 'completed', plan: { outputStepId, steps: [{ id: outputStepId, title }] }, output: { text } }) as any;
    expect(reviewStatusLabel(item('验收结论：通过\n全部核对'))).toBeUndefined();
    expect(reviewStatusLabel(item('验收结论：需返修\n步骤 impl 缺测试'))).toBe('验收需返修');
    expect(reviewStatusLabel(item('验收结论：缺少信息'))).toBe('验收缺少信息');
    expect(reviewStatusLabel(item('看起来没问题'))).toBe('验收待核对');
    // 终端模式 Leader 调工具前说的话会排在结论前面；行中间提到「验收结论」不算。
    expect(reviewStatusLabel(item('先实跑核对一下，避免在验收结论里写错：\n验收结论：通过\n全部核对'))).toBeUndefined();
    expect(reviewStatusLabel(item('验收结论：通过\n复核后发现问题：\n验收结论：需返修\n步骤 impl 缺测试'))).toBe('验收需返修');
    expect(reviewStatusLabel(item('看起来没问题', 'report'))).toBeUndefined();
    // 普通目标恰好用了同名步骤 id，也不当成 Leader 验收。
    expect(reviewStatusLabel(item('普通产出', 'leader_review', '汇总'))).toBeUndefined();
    const rework = { ...item('验收结论：需返修'), id: 'work_1', parentSessionId: 'ses_1', title: '修复登录', goal: '修复登录', revision: 1, steps: [] };
    expect(workItemElements(rework)[0]!.content).toMatch(/^\*\*验收需返修 · 修复登录\*\*/);
  });
});

describe('分层协作：PMO 交接、Leader 规划、Worker 执行、Leader 验收', () => {
  it('runs a group goal end to end after human confirmation and stops each child once it settles', async () => {
    const f = await fixture();
    const turn = await f.pmoTurn('om_goal', '帮我修复登录并补测试');
    const pmoPrompt = f.prompts.find(value => value.agentId === 'pmo')!.prompt;
    expect(pmoPrompt).toContain('[Dutydeck 分层协作]');
    expect(pmoPrompt).toContain('work --turn');
    expect(pmoPrompt).toContain('delegate --file');
    expect(pmoPrompt).not.toContain('[Dutydeck 目标编排]');

    const brief = { goal: '修复登录', context: '用户说登录页 500；仓库在当前目录', idempotencyKey: 'login' };
    const delegated = await turn.run('delegate', brief) as { id: string; status: string; workId: string };
    expect(delegated).toMatchObject({ status: 'planning', workId: expect.stringMatching(/^work_/) });
    expect(await turn.run('delegate', brief)).toEqual(delegated);
    // 同一请求键换了简报内容：拒绝，而不是静默沿用旧指令。
    await expect(turn.run('delegate', { ...brief, context: '只改测试' })).rejects.toMatchObject({ statusCode: 409, error: { code: 'LEADER_DELEGATION_IDEMPOTENCY_CONFLICT' } });
    // PMO 本轮先结束，Leader 规划在后台完成后才创建目标。
    await turn.finish();
    f.openLeader();

    await vi.waitFor(async () => expect(await f.work.listBySession(turn.parent.id, 'ou_alice')).toHaveLength(1));
    const [item] = await f.work.listBySession(turn.parent.id, 'ou_alice');
    expect(item).toMatchObject({ id: delegated.workId, status: 'awaiting_confirmation' });
    expect(item!.goal).toContain('用户说登录页 500');
    expect(item!.plan.steps.map(step => step.agentId)).toEqual(['worker', 'leader']);
    // 测试目录不是 git 仓库：Leader 被告知只能用 shared，计划里的 worktree 也被改成 shared。
    expect(item!.plan.steps[0]!.workspaceMode).toBe('shared');
    const leaderSessions = (await f.runtime.listSessions()).filter(session => session.source === 'lark-leader');
    expect(leaderSessions).toHaveLength(1);
    expect(leaderSessions[0]).toMatchObject({ agentId: 'leader', permissionMode: 'deny-all', sourceId: delegated.id });
    expect(f.prompts.filter(value => value.prompt.includes('你是分层协作里的 Leader'))).toHaveLength(1);
    const leaderPromptText = f.prompts.find(value => value.prompt.includes('你是分层协作里的 Leader'))!.prompt;
    expect(leaderPromptText).toContain('用户说登录页 500');
    expect(leaderPromptText).toContain('不是 git 仓库');

    await f.work.tick();
    const confirmCard = () => f.cards.find(card => card.input.elements?.some((element: any) => element.behaviors?.[0]?.value?.dutydeck_work_item === 'confirm'));
    await vi.waitFor(() => expect(confirmCard()).toBeDefined());
    expect(confirmCard()!.input).toMatchObject({ messageId: 'om_goal', replyInThread: true });
    const value = confirmCard()!.input.elements.find((element: any) => element.behaviors?.[0]?.value?.dutydeck_work_item === 'confirm').behaviors[0].value;
    await f.coordinator.handleAction(value, 'ou_alice', { messageId: confirmCard()!.messageId, chatId: 'oc_group' });

    await vi.waitFor(async () => {
      await f.work.tick();
      const current = await f.work.get(turn.parent.id, item!.id, 'ou_alice');
      expect(current.status, JSON.stringify({ error: current.error, steps: current.steps.map(step => [step.id, step.status, step.attempts.at(-1)?.error]) })).toBe('completed');
    }, { timeout: 10_000 });
    const done = await f.work.get(turn.parent.id, item!.id, 'ou_alice');
    expect(done.output?.text).toContain('验收结论：通过');
    expect(f.prompts.find(value => value.prompt.includes('Step: Leader 验收'))!.prompt).toContain('已修复：改动 src/login.ts');
    const children = done.steps.map(step => step.attempts.at(-1)!.sessionId!);
    await vi.waitFor(() => expect([...f.stopped]).toEqual(expect.arrayContaining(children)));
    expect(f.stopped.has(turn.parent.id)).toBe(false);
    await vi.waitFor(() => expect(f.cards.find(card => card.input.elements?.some((element: any) => element.element_id === 'final_output'))?.input).toMatchObject({ messageId: 'om_goal', replyInThread: true, state: 'completed' }));
    expect(f.cards.find(card => card.input.elements?.some((element: any) => element.element_id === 'final_output'))!.input.statusLabel).toBeUndefined();
    expect(f.replyText).not.toHaveBeenCalled();
  });

  it('asks the user in the origin thread when the Leader needs context, resends a lost notice, and reports invalid plans', async () => {
    const f = await fixture();
    f.leader.reply = '{"decision":"needs_context","question":"登录走哪个环境？"}';
    f.openLeader();
    f.replyText.mockRejectedValueOnce(new Error('飞书暂时不可用'));
    const first = await f.pmoTurn('om_ask', '修一下登录');
    const asked = await first.run('delegate', { goal: '修复登录', idempotencyKey: 'ask' }) as { id: string };
    const stored = async () => JSON.parse((await f.repos.config.get(`leader_delegation:${asked.id}`))!);
    await vi.waitFor(async () => { expect(f.replyText).toHaveBeenCalledTimes(1); expect(await stored()).toMatchObject({ status: 'needs_context', notice: { kind: 'needs_context' } }); });
    // 发送失败的通知留在记录里；重启（或每分钟补发）用同一个请求键重发，送达后清除。
    await f.resumed().start();
    expect(f.replyText).toHaveBeenCalledTimes(2);
    expect(f.replyText.mock.calls[1]![0]).toMatchObject({ messageId: 'om_ask', replyInThread: true, text: expect.stringContaining('登录走哪个环境？'), idempotencyKey: f.replyText.mock.calls[0]![0].idempotencyKey });
    expect((await stored()).notice).toBeUndefined();
    expect(await f.work.listBySession(first.parent.id, 'ou_alice')).toHaveLength(0);

    f.leader.reply = plan('pmo');
    await first.run('delegate', { goal: '修复登录', context: '预发环境', idempotencyKey: 'retry' });
    await vi.waitFor(() => expect(f.replyText).toHaveBeenLastCalledWith(expect.objectContaining({ text: expect.stringContaining('名单外的 Agent：pmo') })));
    expect(await f.work.listBySession(first.parent.id, 'ou_alice')).toHaveLength(0);
    expect(f.replyText.mock.calls.map(([input]) => input.idempotencyKey)).toEqual(Array(3).fill(expect.stringMatching(/^dlg_[a-f0-9]{40}$/)));
    expect(new Set(f.replyText.mock.calls.map(([input]) => input.idempotencyKey)).size).toBe(2);
  });

  it('resumes planning interrupted by a restart', async () => {
    const f = await fixture();
    const turn = await f.pmoTurn('om_resume', '修复登录');
    const delegated = await turn.run('delegate', { goal: '修复登录', idempotencyKey: 'resume' }) as { id: string; workId: string };
    await turn.finish();
    await vi.waitFor(() => expect(f.leader.waiting).toHaveLength(1));
    await f.delegations.close();
    const resumed = f.resumed();
    await resumed.start();
    await vi.waitFor(() => expect(f.leader.waiting).toHaveLength(2));
    f.openLeader();
    await vi.waitFor(async () => expect((await f.work.listBySession(turn.parent.id, 'ou_alice')).map(item => item.id)).toEqual([delegated.workId]));
    // 已关闭的旧服务拿到迟到的 Leader 结果后不再写记录。
    const leaderSessions = (await f.runtime.listSessions()).filter(session => session.source === 'lark-leader');
    await vi.waitFor(() => expect(leaderSessions.every(session => f.stopped.has(session.id))).toBe(true));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(await f.record(delegated.id)).toMatchObject({ status: 'started' });
    expect(f.log.warn).not.toHaveBeenCalledWith(expect.anything(), 'Leader 规划记录更新失败');
  });

  it('keeps the single-Agent prompt and refuses delegation when the Bot is not layered', async () => {
    const f = await fixture('single');
    const turn = await f.pmoTurn('om_single', '修复登录');
    const prompt = f.prompts.find(value => value.agentId === 'pmo')!.prompt;
    expect(prompt).toContain('[Dutydeck 目标编排]');
    expect(prompt).not.toContain('[Dutydeck 分层协作]');
    await expect(turn.run('delegate', { goal: '修复登录', idempotencyKey: 'single' })).rejects.toMatchObject({ statusCode: 409, error: { code: 'LEADER_DELEGATION_DISABLED' } });
  });

  it('keeps the single-Agent prompt in direct messages, where goals have no pinned delivery', async () => {
    const f = await fixture();
    const turn = await f.pmoTurn('om_p2p', '修复登录', 'p2p');
    const prompt = f.prompts.find(value => value.agentId === 'pmo')!.prompt;
    expect(prompt).toContain('[Dutydeck 目标编排]');
    expect(prompt).not.toContain('[Dutydeck 分层协作]');
    await expect(turn.run('delegate', { goal: '修复登录', idempotencyKey: 'p2p' })).rejects.toMatchObject({ statusCode: 409, error: { code: 'WORK_ITEM_ORIGIN_MISSING' } });
    expect(f.leaderPrompts()).toHaveLength(0);
  });

  it('runs at most three Leader plannings at a time and queues the rest', async () => {
    const f = await fixture();
    const turn = await f.pmoTurn('om_queue', '修复登录');
    for (const key of ['q1', 'q2', 'q3', 'q4']) await turn.run('delegate', { goal: `修复登录 ${key}`, idempotencyKey: key });
    await vi.waitFor(() => expect(f.leader.waiting).toHaveLength(3));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(f.leaderPrompts()).toHaveLength(3);
    f.openLeader();
    await vi.waitFor(async () => expect(await f.work.listBySession(turn.parent.id, 'ou_alice')).toHaveLength(4));
    expect(f.leaderPrompts()).toHaveLength(4);
  });

  it('frees the planning slots when Leader sessions hang before they can answer', async () => {
    const f = await fixture('layered', { planningTimeoutMs: 300 });
    const turn = await f.pmoTurn('om_hang', '修复登录');
    f.leader.hangStart = true;
    const hung: Array<{ id: string }> = [];
    for (const key of ['h1', 'h2', 'h3']) hung.push(await turn.run('delegate', { goal: `修复登录 ${key}`, idempotencyKey: key }) as { id: string });
    await vi.waitFor(() => expect(f.leader.starts).toHaveLength(3));
    f.leader.hangStart = false;
    f.openLeader();
    const next = await turn.run('delegate', { goal: '修复注册', idempotencyKey: 'next' }) as { workId: string };
    await vi.waitFor(async () => expect((await f.work.listBySession(turn.parent.id, 'ou_alice')).map(item => item.id)).toEqual([next.workId]));
    for (const { id } of hung) expect(await f.record(id)).toMatchObject({ status: 'failed', error: 'Leader 规划超时' });
  });

  it('checks the roster again before creating the goal and only offers usable Workers', async () => {
    const f = await fixture();
    const turn = await f.pmoTurn('om_roster', '修复登录');
    f.denied.add('worker');
    await expect(turn.run('delegate', { goal: '修复登录', idempotencyKey: 'denied' })).rejects.toMatchObject({ statusCode: 403, error: { code: 'LEADER_DELEGATION_FORBIDDEN' } });
    f.denied.clear();
    await turn.run('delegate', { goal: '修复登录', idempotencyKey: 'roster' });
    await vi.waitFor(() => expect(f.leader.waiting).toHaveLength(1));
    // Leader 规划期间管理员把 Worker 换掉：按旧名单拆出的计划不执行。
    await f.setConfig({ executionMode: 'layered', leaderAgentId: 'leader', workerAgentIds: ['pmo'] });
    f.openLeader();
    await vi.waitFor(() => expect(f.replyText).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('步骤 impl 的 Agent worker 已不在名单里') })));
    expect(await f.work.listBySession(turn.parent.id, 'ou_alice')).toHaveLength(0);
  });

  it('lets a terminal Leader plan and review at full trust only when the Bot and the Agent are both full trust', async () => {
    const terminal = { protocol: 'pty-cli', permissionMode: 'full-trust' } as const;
    // 终端模式没有 deny-all：机器人或 Agent 不是完全信任时在交接时就拒绝，不起 Leader 会话。
    for (const options of [{ leaderAgent: terminal }, { permissionMode: 'full-trust', leaderAgent: { ...terminal, permissionMode: 'ask' } }] as const) {
      const denied = await fixture('layered', options);
      const turn = await denied.pmoTurn('om_cli_denied', '修复登录');
      await expect(turn.run('delegate', { goal: '修复登录', idempotencyKey: 'cli' })).rejects.toMatchObject({ statusCode: 403, error: { code: 'LEADER_DELEGATION_FORBIDDEN', message: expect.stringContaining('完全信任') } });
      expect(denied.leaderPrompts()).toHaveLength(0);
    }
    const f = await fixture('layered', { permissionMode: 'full-trust', leaderAgent: terminal });
    const turn = await f.pmoTurn('om_cli', '修复登录');
    f.openLeader();
    const delegated = await turn.run('delegate', { goal: '修复登录', idempotencyKey: 'cli' }) as { id: string; workId: string };
    await turn.finish();
    await vi.waitFor(async () => expect(await f.work.listBySession(turn.parent.id, 'ou_alice')).toHaveLength(1));
    // 按 deny-all 起会被运行时拒绝，规划会话按完全信任起；风险策略按原话题与发起人取。
    const planning = (await f.runtime.listSessions()).filter(session => session.source === 'lark-leader');
    expect(planning).toEqual([expect.objectContaining({ agentId: 'leader', permissionMode: 'full-trust', sourceId: delegated.id })]);
    expect(await f.delegations.parentForSession(planning[0]!.id)).toEqual({ parentSessionId: turn.parent.id, actorId: 'ou_alice', parentTaskId: expect.stringMatching(/^task_/) });
    expect(await f.delegations.parentForSession(turn.parent.id)).toBeUndefined();
    await f.work.tick();
    const confirm = () => f.cards.find(card => card.input.elements?.some((element: any) => element.behaviors?.[0]?.value?.dutydeck_work_item === 'confirm'));
    await vi.waitFor(() => expect(confirm()).toBeDefined());
    const value = confirm()!.input.elements.find((element: any) => element.behaviors?.[0]?.value?.dutydeck_work_item === 'confirm').behaviors[0].value;
    await f.coordinator.handleAction(value, 'ou_alice', { messageId: confirm()!.messageId, chatId: 'oc_group' });
    await vi.waitFor(async () => { await f.work.tick(); expect((await f.work.get(turn.parent.id, delegated.workId, 'ou_alice')).status).toBe('completed'); }, { timeout: 10_000 });
    const review = (await f.work.get(turn.parent.id, delegated.workId, 'ou_alice')).steps.find(step => step.id === 'leader_review')!.attempts.at(-1)!.sessionId!;
    expect(await f.runtime.getSession(review)).toMatchObject({ agentId: 'leader', permissionMode: 'full-trust' });
  });

  it('refuses a terminal Leader once the Bot is no longer full trust, even from a full-trust topic', async () => {
    const f = await fixture('layered', { permissionMode: 'full-trust', leaderAgent: { protocol: 'pty-cli', permissionMode: 'full-trust' } });
    const turn = await f.pmoTurn('om_cli_downgrade', '修复登录');
    const queued: Array<{ id: string }> = [];
    for (const key of ['d1', 'd2', 'd3', 'd4']) queued.push(await turn.run('delegate', { goal: `修复登录 ${key}`, idempotencyKey: key }) as { id: string });
    await vi.waitFor(() => expect(f.leader.waiting).toHaveLength(3));
    // 排队期间管理员把机器人改成逐项确认，原话题会话仍是完全信任：已出的计划不建目标，排队的不再规划。
    await f.setConfig({ permissionMode: 'ask' });
    f.openLeader();
    await vi.waitFor(async () => { for (const { id } of queued) expect(await f.record(id)).toMatchObject({ status: 'failed', error: expect.stringContaining('完全信任') }); });
    expect(f.leaderPrompts()).toHaveLength(3);
    expect(await f.work.listBySession(turn.parent.id, 'ou_alice')).toHaveLength(0);
  });

  it('builds a saved plan after a restart without asking the Leader again, and expires stale requests', async () => {
    const f = await fixture();
    const turn = await f.pmoTurn('om_saved', '修复登录');
    const saved = await turn.run('delegate', { goal: '修复登录', idempotencyKey: 'saved' }) as { id: string; workId: string };
    const stale = await turn.run('delegate', { goal: '修复注册', idempotencyKey: 'stale' }) as { id: string };
    await turn.finish();
    await vi.waitFor(() => expect(f.leader.waiting).toHaveLength(2));
    await f.delegations.close();
    // 模拟上次在计划落盘后、建目标前中断，以及一条停机很久的规划。
    await f.setRecord(saved.id, { ...await f.record(saved.id), plan: layeredPlan(parseLeaderResult(plan()) as any, 'leader', ['worker'], false) });
    await f.setRecord(stale.id, { ...await f.record(stale.id), createdAt: new Date(Date.now() - 31 * 60_000).toISOString() });
    await f.resumed().start();
    await vi.waitFor(async () => expect((await f.work.listBySession(turn.parent.id, 'ou_alice')).map(item => item.id)).toEqual([saved.workId]));
    expect(f.leaderPrompts()).toHaveLength(2);
    expect(await f.record(stale.id)).toMatchObject({ status: 'failed', error: expect.stringContaining('不再自动执行') });
    expect(f.replyText).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('不再自动执行') }));
    // 目标已经建好、只差回写状态的旧记录照常补记，不报失败；父会话已停、操作者失去权限也一样。
    await vi.waitFor(async () => expect(await f.record(saved.id)).toMatchObject({ status: 'started' }));
    await f.setRecord(saved.id, { ...await f.record(saved.id), status: 'planning', createdAt: new Date(Date.now() - 31 * 60_000).toISOString() });
    await f.runtime.stop(turn.parent.id);
    f.revoked.add('ou_alice');
    await f.resumed().start();
    await vi.waitFor(async () => expect(await f.record(saved.id)).toMatchObject({ status: 'started' }));
    expect(await f.record(saved.id)).not.toHaveProperty('error');
  });
});
