import { createAutomationIntegration } from '../automation-integration.js';
import { SessionAutomationService } from '../session-automation.js';
// Agent 代用户发飞书命令（dutydeck command）：查看类直接出结果卡，会改东西的先发确认卡，点「确认」后以点击人身份执行。
// 真实 DutydeckRuntime + SQLite + 真实确认卡，飞书接口用替身。
import Fastify from 'fastify';
import { registerLarkRoutes } from './routes.js';
import { agentSettingsKeys } from './agent-settings.js';
import { LarkServiceError } from './service.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRepositories } from '@dutydeck/storage';
import { DutydeckRuntime, type AgentDriver } from '@dutydeck/runtime';
import type { AgentConfig } from '@dutydeck/shared';
import { LarkMessageCoordinator, type PersistedLarkCardTask } from './coordinator.js';
import { larkBotsConfigKey, readLarkConfig, type StoredLarkConfig } from './config.js';
import type { LarkMessageEvent } from './listener.js';
import { buildLarkCard } from './service.js';
import { LarkGroupManager } from './group-management.js';
import { LarkConfirmCards } from './confirm-cards.js';
import { agentActionCommand, agentCommandHelp, agentCommandPlan } from './agent-command.js';
import { parseBusyTriageResult } from './busy-triage.js';
import { parseLarkNewSession } from './new-session.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const event = (id: string, text: string, mentions: LarkMessageEvent['mentions'] = []): LarkMessageEvent => ({
  messageId: id, chatId: 'oc_group', chatType: 'group', threadId: 'omt_topic', rootId: 'om_root',
  senderOpenId: 'ou_alice', senderType: 'user', messageType: 'text', content: JSON.stringify({ text: `@_user_1 ${text}` }),
  mentions: [{ key: '@_user_1', name: 'Dock', openId: 'ou_bot' }, ...mentions]
});

async function harness(workflow: Record<string, unknown> = {}, holdFirst = false, terminal = false) {
  const state = await mkdtemp(join(tmpdir(), 'dutydeck-lark-agent-command-'));
  const repos = createRepositories(join(state, 'state.db'), { newDatabaseAuthority: 'ledger_v1' });
  const prompts: string[] = [];
  const steers: string[] = [];
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const runtime = new DutydeckRuntime(repos, {
    probe: () => ({ protocol: terminal ? 'pty-cli' : 'acp', available: true, pause: false, resume: true }),
    driverFactory: (_config, _protocol, emit) => ({
      ...(!terminal ? { steer: async (prompt: string) => { steers.push(prompt); return 'injected' as const; } } : {}),
      start: async () => {}, resume: async () => {}, stop: async () => {}, interrupt: async () => {}, isStopped: async () => true,
      send: async prompt => {
        prompts.push(typeof prompt === 'string' ? prompt : JSON.stringify(prompt));
        if (holdFirst && prompts.length === 1) await held;
        emit({ type: 'text', data: { text: `第 ${prompts.length} 轮做完了` } });
        emit({ type: 'completed', data: { stopReason: 'end_turn' } });
      }
    } satisfies AgentDriver)
  });
  const agent: AgentConfig = { id: 'mock', name: 'Mock', command: process.execPath, args: [], protocol: terminal ? 'pty-cli' : 'acp', cwd: state, env: {},
    permissionMode: terminal ? 'full-trust' : 'ask', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };
  await runtime.initialize([agent]);
  const config: StoredLarkConfig = { appId: 'cli_agent_command', appSecret: 'fake-secret', name: 'Dock', workspace: state, defaultAgentId: 'mock',
    permissionMode: terminal ? 'full-trust' : 'ask', listening: true, fullTrustConfirmed: true, preInjectPrompt: '', structuredAskCards: false,
    groupCardMention: false, groupToolsEnabled: false, groupToolsAllowSend: false, pushIntervalMs: 1_000, hideTraceOnComplete: false,
    completionReactionOnly: false, silentProgress: false, urgentEnabled: false, pinLongTasks: false,
    allowedUsers: [{ openId: 'ou_alice', name: 'Alice' }] as any, allowedEmails: [], allowedBots: [], peerBotsAllowed: false,
    highRiskAllowedUsers: [], highRiskAllowedEmails: [], highRiskPattern: 'dangerous', riskControlMode: 'off' };
  await repos.config.set(larkBotsConfigKey, JSON.stringify([config]));

  let nextMessage = 0;
  const cards = new Map<string, any>();
  const createCard = async (input: any) => { const id = `om_card_${++nextMessage}`; cards.set(id, input); return { messageId: id }; };
  const service = {
    send: vi.fn(createCard), reply: vi.fn(createCard),
    replyText: vi.fn(async () => ({ messageId: `om_echo_${++nextMessage}` })),
    uploadFile: vi.fn(async () => 'file_1'), replyFile: vi.fn(createCard), sendFile: vi.fn(createCard),
    update: vi.fn(async (input: any) => { cards.set(input.messageId, input); return { messageId: input.messageId }; }),
    addReaction: vi.fn(async (messageId: string, emojiType = 'OK') => ({ messageId, reactionId: `r_${messageId}_${emojiType}` })),
    deleteReaction: vi.fn(async () => {}), getUserEmails: vi.fn(async () => [] as string[]),
    listChatMembers: vi.fn(async () => ({ items: [{ memberId: 'ou_alice' }, { memberId: 'ou_mallory' }], hasMore: false })),
    listChatMessages: vi.fn(async () => ({ items: [] as any[], hasMore: false })),
    getMessageItems: vi.fn(async () => [] as any[])
  };
  const confirmations = new LarkConfirmCards({ repository: repos.collaboration, readConfig: appId => readLarkConfig(repos.config, appId), serviceFor: () => service as any });
  const participation = { confirmations, mode: async () => 'off', handle: async () => ({ handled: false, enabled: false }), guardBotTurn: async () => undefined,
    taskContext: async () => undefined, instructions: async () => '', describe: async () => undefined } as any;
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const coordinator = new LarkMessageCoordinator(runtime, service as any, log, Math.random, 'ou_bot',
    undefined, repos.channelMappings, async () => 'group', undefined, undefined, { store: repos.config, participation, ...workflow });
  await coordinator.initializeWorkflows(config);
  await coordinator.startReconciliation(config, 60_000);
  cleanups.push(async () => { release(); coordinator.stop(); await runtime.shutdown(); repos.close(); await rm(state, { recursive: true, force: true }); });
  const result = (taskId: string) => vi.waitFor(async () => {
    const mapping = await repos.channelMappings.get(`lark-card:${config.appId}`, taskId);
    const saved = { sessionId: mapping!.sessionId, ...JSON.parse(mapping!.extra!) as PersistedLarkCardTask };
    expect(saved.final_message_id).toBeTruthy();
    return saved;
  }, { timeout: 10_000 });
  // 跑完一轮普通请求，Agent 在这一轮里代发命令。
  const turn = async (request = event('om_1', '帮我看看'), command: string) => {
    if (!await repos.channelMappings.get(`lark-card:${config.appId}`, request.messageId)) await coordinator.handle(request, config);
    const saved = await result(request.messageId);
    return coordinator.agentCommand({ sessionId: saved.sessionId, taskId: saved.runtime_task_id!, actorId: 'ou_alice', command });
  };
  const repliesTo = (messageId: string) => service.reply.mock.calls.map(call => call[0]).filter(input => input.messageId === messageId);
  const sent = () => service.reply.mock.calls.length + service.send.mock.calls.length + service.replyText.mock.calls.length;
  // dutydeck agent 走的入口：这一轮跑完后按它的会话和任务代办。
  const current = async (request = event('om_1', '帮我看看')) => {
    if (!await repos.channelMappings.get(`lark-card:${config.appId}`, request.messageId)) await coordinator.handle(request, config);
    const saved = await result(request.messageId);
    return { sessionId: saved.sessionId, taskId: saved.runtime_task_id!, actorId: 'ou_alice' };
  };
  return { release, steers, repos, runtime, participation, config, service, cards, prompts, coordinator, result, turn, repliesTo, sent, current };
}

const findElement = (node: unknown, id: string): Record<string, any> | undefined => {
  if (Array.isArray(node)) { for (const item of node) { const found = findElement(item, id); if (found) return found; } return undefined; }
  if (!node || typeof node !== 'object') return undefined;
  const record = node as Record<string, any>;
  if (record.element_id === id) return record;
  for (const value of Object.values(record)) { const found = findElement(value, id); if (found) return found; }
  return undefined;
};

describe('Agent 代发飞书命令', () => {
  it('分出哪些直接执行、哪些先确认、哪些只能由用户做', () => {
    expect(agentCommandPlan('/status').confirm).toBe(false);
    expect(agentCommandPlan('/queue').confirm).toBe(false);
    expect(agentCommandPlan('/pr 修复登录').confirm).toBe(false);
    expect(agentCommandPlan('/queue cancel 2').confirm).toBe(true);
    expect(agentCommandPlan('/new --agent codex -- 修复登录').confirm).toBe(true);
    expect(agentCommandPlan('/schedule disable sch_1').confirm).toBe(true);
    for (const command of ['/stop', '/cancel', '/approve req_1', '/answer q_1 好', '/remember x']) {
      expect(() => agentCommandPlan(command)).toThrow(expect.objectContaining({ code: 'AGENT_COMMAND_USER_ONLY' }));
    }
    expect(() => agentCommandPlan('/schedule every 15 看看')).toThrow(expect.objectContaining({ code: 'AGENT_COMMAND_UNSUPPORTED' }));
    expect(() => agentCommandPlan('/foo')).toThrow(expect.objectContaining({ code: 'AGENT_COMMAND_UNKNOWN' }));
    expect(() => agentCommandPlan('看看状态')).toThrow(expect.objectContaining({ code: 'AGENT_COMMAND_UNKNOWN' }));
    expect(agentCommandHelp()).toContain('/new');
    expect(agentCommandHelp()).not.toContain('/cancel');
  });

  it('查看类以发起人身份直接执行，结果卡回在这一轮的请求消息下；同一轮的不同命令各回一张卡', async () => {
    const h = await harness();
    expect(await h.turn(undefined, '/status')).toMatchObject({ executed: true });
    expect(h.repliesTo('om_1').map(input => input.taskName)).toContain('任务状态');
    expect(h.prompts).toHaveLength(1);
    await h.turn(undefined, '/help 1');
    await h.turn(undefined, '/help 2');
    await h.turn(undefined, '/tasks 1');
    await h.turn(undefined, '/tasks 2');
    const commandKeys = () => h.repliesTo('om_1').map(input => String(input.idempotencyKey)).filter(key => /^(cmd|workflow_reply)_/.test(key));
    const keys = commandKeys();
    expect(keys).toHaveLength(5);
    expect(new Set(keys).size).toBe(5);
    // 同一条命令重试时还是同一张卡。
    await h.turn(undefined, '/help 2');
    expect(commandKeys().at(-1)).toBe(keys[2]);
  });

  it('/new 先发确认卡；没权限的人点被拒，发起人点确认后在新会话里执行，新一轮挂在确认卡下', async () => {
    const h = await harness();
    const first = await h.result((await h.coordinator.handle(event('om_1', '帮我看看'), h.config), 'om_1'));
    expect(await h.turn(undefined, '/new --agent mock -- 重新从头查一遍')).toMatchObject({ pendingConfirmation: true });
    const confirmCall = h.repliesTo('om_1').find(input => input.taskName === '待确认的操作')!;
    expect(confirmCall).toMatchObject({ replyInThread: true, statusLabel: '待确认' });
    expect(findElement(buildLarkCard(confirmCall), 'confirm_body')!.content).toContain('`/new --agent mock -- 重新从头查一遍`');
    const confirmCardId = [...h.cards].find(([, input]) => input === confirmCall)![0];
    // 同一轮里重复调用不再发第二张。
    await h.turn(undefined, '/new --agent mock -- 重新从头查一遍');
    expect(h.repliesTo('om_1').filter(input => input.taskName === '待确认的操作')).toHaveLength(1);
    expect(h.prompts).toHaveLength(1);

    // 话题根随确认单保存：重启后点确认，靠它找回话题续接的会话。
    const pending = (await h.repos.collaboration.listActions({ appId: h.config.appId, chatId: 'oc_group' })).find(action => (action.payload as any).payload?.command?.startsWith('/new'))!;
    expect((pending.payload as any).payload).toMatchObject({ root_id: 'om_root', thread_id: 'omt_topic', chat_type: 'group' });
    const value = findElement(buildLarkCard(confirmCall), 'confirm_confirm')!.behaviors[0].value;
    expect(await h.coordinator.handleAction(value, 'ou_mallory', { messageId: confirmCardId, chatId: 'oc_group' }))
      .toMatchObject({ type: 'warning', content: '只有发起人或有权限的人能确认。' });
    expect(await h.coordinator.handleAction(value, 'ou_alice', { messageId: confirmCardId, chatId: 'oc_group' }))
      .toMatchObject({ type: 'success', content: expect.stringContaining('已确认执行 /new') });
    await vi.waitFor(() => expect(h.prompts).toHaveLength(2), { timeout: 10_000 });
    expect(h.prompts[1]).toContain('重新从头查一遍');
    const next = await h.result(confirmCardId);
    expect(next.sessionId).not.toBe(first.sessionId);
    expect(h.service.update.mock.calls.map(call => call[0]).find(input => input.messageId === confirmCardId)).toMatchObject({ statusLabel: '已确认' });
    expect(await h.coordinator.handleAction(value, 'ou_alice', { messageId: confirmCardId, chatId: 'oc_group' })).toMatchObject({ content: '这张卡已经处理过了。' });
  });

  it('确认后执行中进程退出：重启后在确认卡下回执无法确认是否完成，不会重新执行', async () => {
    const h = await harness();
    expect(await h.turn(undefined, '/new')).toMatchObject({ pendingConfirmation: true });
    const confirmCall = h.repliesTo('om_1').find(input => input.taskName === '待确认的操作')!;
    const confirmCardId = [...h.cards].find(([, input]) => input === confirmCall)![0];
    // 模拟命令执行到一半进程退出：执行永远不返回。
    (h.coordinator as any).routeChatCommand = () => new Promise(() => {});
    const value = findElement(buildLarkCard(confirmCall), 'confirm_confirm')!.behaviors[0].value;
    expect(await h.coordinator.handleAction(value, 'ou_alice', { messageId: confirmCardId, chatId: 'oc_group' })).toMatchObject({ type: 'success' });
    const inboxKey = `lark.inbox.${h.config.appId}.${confirmCardId}`;
    expect(JSON.parse((await h.repos.config.get(inboxKey))!)).toMatchObject({ state: 'command', event: { senderOpenId: 'ou_alice' } });

    const restarted = new LarkMessageCoordinator(h.runtime, h.service as any, { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, Math.random, 'ou_bot',
      undefined, h.repos.channelMappings, async () => 'group', undefined, undefined, { store: h.repos.config, participation: h.participation });
    cleanups.push(() => restarted.stop());
    await restarted.initializeWorkflows(h.config);
    expect(h.repliesTo(confirmCardId).map(input => input.markdown).join('\n')).toContain('重启后无法确认这条命令是否完成');
    expect(JSON.parse((await h.repos.config.get(inboxKey))!)).toMatchObject({ state: 'failed' });
    expect(h.prompts).toHaveLength(1);
  });

  it('点取消不执行；Agent 编号填错、找不到这一轮时直接报错给 Agent；/grant 带上用户消息里 @ 过的成员', async () => {
    const h = await harness();
    await expect(h.turn(undefined, '/new --agent nope -- 重做')).rejects.toMatchObject({ code: 'AGENT_COMMAND_INVALID', message: expect.stringContaining('mock（Mock）') });
    await expect(h.coordinator.agentCommand({ sessionId: 'ses_unknown', taskId: 'task_x', actorId: 'ou_alice', command: '/status' })).rejects.toMatchObject({ code: 'AGENT_COMMAND_ORIGIN_MISSING' });

    expect(await h.turn(undefined, '/new')).toMatchObject({ pendingConfirmation: true });
    const confirmCall = h.repliesTo('om_1').find(input => input.taskName === '待确认的操作')!;
    const confirmCardId = [...h.cards].find(([, input]) => input === confirmCall)![0];
    const cancel = findElement(buildLarkCard(confirmCall), 'confirm_cancel')!.behaviors[0].value;
    expect(await h.coordinator.handleAction(cancel, 'ou_alice', { messageId: confirmCardId, chatId: 'oc_group' })).toMatchObject({ content: '已取消，没有改动。' });
    expect(h.service.update.mock.calls.map(call => call[0]).find(input => input.messageId === confirmCardId)).toMatchObject({ statusLabel: '已取消' });
    expect(h.repliesTo(confirmCardId)).toHaveLength(0);

    const grantRequest = event('om_2', '给 @_user_2 开权限', [{ key: '@_user_2', name: 'Bob', openId: 'ou_bob' }]);
    expect(await h.turn(grantRequest, '/grant @Bob')).toMatchObject({ pendingConfirmation: true });
    const actions = await h.repos.collaboration.listActions({ appId: h.config.appId, chatId: 'oc_group' });
    const grant = actions.find(action => (action.payload as any).payload?.command === '/grant @Bob')!;
    expect(JSON.parse((grant.payload as any).payload.mentions)).toEqual([{ key: '@_user_2', name: 'Bob', openId: 'ou_bob' }]);
  });
});

// dutydeck agent：查看类经真实协调器把数据交回给 Agent、不发卡；写入类把参数换成同一条 / 命令，dry-run 只预览。
const automation = () => ({
  ciConfigured: true, listCiProviders: () => [],
  listBySession: vi.fn(async () => ({
    schedules: [{ id: 'sch_1', name: '晨报', prompt: '汇总昨天的告警', enabled: false, trigger: { kind: 'cron', expression: '0 9 * * *' }, timezone: 'Asia/Shanghai', revision: 1 }],
    subscriptions: [{ id: 'ci_1', status: 'waiting', repository: { slug: 'acme/app' }, headSha: 'abcdef1234567890', expiresAt: '2026-10-17T00:00:00.000Z', revision: 1 }],
    occurrences: []
  }))
});

describe('dutydeck agent 查看类', () => {
  it('status、agents、tasks、queue、schedules、ci 都把结果交回给 Agent，对话里不多发卡', async () => {
    const h = await harness({ automation: automation() });
    const turn = await h.current();
    const before = h.sent();
    const view = (name: any, extra = {}) => h.coordinator.agentView({ ...turn, view: name, ...extra });
    const status = await view('status');
    expect(status).toMatchObject({ sessionId: turn.sessionId, agent: 'mock', workspace: h.config.workspace, state: expect.any(String), running: expect.any(Number), queued: 0, needsReview: 0 });
    // 文本与 /status 卡片同一份。
    expect(status.text).toContain('**Agent**：mock');
    expect(status.text).toContain(`**会话**：\`${turn.sessionId}\``);
    expect(await view('agents')).toMatchObject({ agents: [{ id: 'mock', name: 'Mock', default: true }], text: expect.stringContaining('Mock') });
    expect(await view('tasks', { page: 1 })).toMatchObject({ page: 1, totalPages: 1, total: 1, tasks: [{ taskId: turn.taskId, status: 'completed', agent: 'Mock' }] });
    expect(await view('queue')).toMatchObject({ queued: [], text: expect.stringContaining('当前没有待执行的指令') });
    expect(await view('schedules')).toMatchObject({ schedules: [{ id: 'sch_1', name: '晨报', enabled: false, when: expect.any(String) }], text: expect.stringContaining('晨报') });
    expect(await view('ci')).toMatchObject({ waits: [{ id: 'ci_1', repository: 'acme/app', status: 'waiting' }], webhookWaits: [], text: expect.stringContaining('acme/app') });
    expect(h.sent()).toBe(before);
    expect(h.prompts).toHaveLength(1);
  });

  it('权限和发起人在原话题自己发这条命令一致：没权限时报错给 Agent，也不发卡', async () => {
    const h = await harness({ automation: automation() });
    const turn = await h.current();
    const before = h.sent();
    await expect(h.coordinator.agentView({ ...turn, actorId: 'ou_mallory', view: 'queue' })).rejects.toMatchObject({ code: 'AGENT_COMMAND_REJECTED' });
    await expect(h.coordinator.agentView({ ...turn, actorId: 'ou_mallory', view: 'schedules' })).rejects.toMatchObject({ code: 'AGENT_COMMAND_REJECTED', message: expect.stringContaining('不在机器人白名单中') });
    // 没开通的能力同样如实报错。
    const bare = await harness();
    await expect(bare.coordinator.agentView({ ...await bare.current(), view: 'ci' })).rejects.toMatchObject({ code: 'AGENT_COMMAND_REJECTED', message: expect.stringContaining('CI 续作未配置') });
    expect(h.sent()).toBe(before);
  });
});

describe('dutydeck agent 写入类', () => {
  it('参数换成与用户自己发的 / 命令相同的那一条', () => {
    const command = (action: string, params: object = {}) => agentActionCommand(action, params).command;
    expect(command('session.new', { agent: 'codex', cwd: '/srv/my repo', workspace: 'worktree', model: 'gpt', effort: 'high', task: '修复登录' }))
      .toBe('/new --agent codex --cwd "/srv/my repo" --workspace worktree --model gpt --effort high -- 修复登录');
    expect(parseLarkNewSession(command('session.new', { agent: 'codex', cwd: '/srv/my repo', task: '修复登录' }).slice(5)))
      .toEqual({ prompt: '修复登录', launchOptions: { agentId: 'codex', cwd: '/srv/my repo' } });
    expect(parseLarkNewSession(command('session.new', { agent: 'codex', handoff: true, note: '接着查内存', task: '修复' }).slice(5)))
      .toEqual({ prompt: '修复', handoff: { note: '接着查内存' }, launchOptions: { agentId: 'codex' } });
    expect(command('session.new', { handoff: true })).toBe('/new --handoff');
    expect(command('session.new', { task: '--不是参数' })).toBe('/new -- --不是参数');
    expect(command('session.new')).toBe('/new');
    expect(command('retry')).toBe('/retry');
    expect(command('plan', { task: '把报错改成中文' })).toBe('/plan 把报错改成中文');
    expect(command('schedule.enable', { id: 'sch_1' })).toBe('/schedule enable sch_1');
    expect(command('schedule.disable', { id: 'sch_1' })).toBe('/schedule disable sch_1');
    expect(command('queue.cancel', { index: 2 })).toBe('/queue cancel 2');
    expect(command('queue.top', { index: 2 })).toBe('/queue top 2');
    expect(agentActionCommand('access.grant', { members: ['@Bob', 'Carol'] })).toEqual({ command: '/grant @Bob @Carol', members: ['Bob', 'Carol'] });
    expect(command('access.revoke')).toBe('/revoke');
    expect(command('pr.open', { title: '修复登录' })).toBe('/pr 修复登录');
    expect(command('ci.wait', { workflow: 'build.yml' })).toBe('/ci wait build.yml');
    expect(command('ci.fix')).toBe('/ci fix');
    expect(command('ci.cancel', { id: 'ci_1' })).toBe('/ci cancel ci_1');
    expect(command('repair')).toBe('/repair');
  });

  it('参数错误指出是哪个参数，能给可选值时给出', () => {
    const issue = (action: string, params: object) => { try { agentActionCommand(action, params); } catch (error) { return error as any; } throw new Error('应当报错'); };
    expect(issue('session.new', { workspace: 'x' })).toMatchObject({ code: 'INVALID_ARGUMENT', params: [{ name: '--workspace', reason: '只能是 shared 或 worktree' }] });
    expect(issue('session.new', { agent: 'codex' })).toMatchObject({ params: [{ name: '--task' }] });
    expect(issue('session.new', { note: 'x' })).toMatchObject({ params: [{ name: '--note', reason: '只能和 --handoff 一起用' }] });
    expect(issue('session.new', { handoff: true, note: 'a -- b' })).toMatchObject({ params: [{ name: '--note' }] });
    expect(issue('queue.cancel', { index: 0 })).toMatchObject({ params: [{ name: '<编号>', reason: '从 1 开始' }] });
    expect(issue('plan', {})).toMatchObject({ params: [{ name: '--task', reason: '必填' }] });
    expect(issue('retry', { force: true })).toMatchObject({ params: [{ name: '--force', reason: '不支持这个参数' }] });
    for (const members of [['@'], [' '], ['@ '], ['Bob', '@'], []]) {
      expect(issue('access.grant', { members })).toMatchObject({ code: 'INVALID_ARGUMENT', params: [{ name: '--member' }] });
      expect(issue('access.revoke', { members })).toMatchObject({ code: 'INVALID_ARGUMENT', params: [{ name: '--member' }] });
    }
    expect(issue('nope', {})).toMatchObject({ code: 'AGENT_ACTION_UNKNOWN', params: [{ name: '<命令>', reason: expect.stringContaining('session.new') }] });
  });

  it('--dry-run 只返回将要做什么和确认卡内容，不执行、不发卡；去掉后发出同样的确认卡', async () => {
    const h = await harness({ automation: automation() });
    const turn = await h.current();
    const cases: Array<[string, object]> = [['session.new', { agent: 'mock', task: '重新查一遍' }], ['retry', {}], ['plan', { task: '先出计划' }], ['schedule.enable', { id: 'sch_1' }],
      ['schedule.disable', { id: 'sch_1' }], ['queue.cancel', { index: 1 }], ['queue.top', { index: 1 }], ['ci.wait', { workflow: 'build.yml' }], ['ci.fix', {}], ['ci.cancel', { id: 'ci_1' }]];
    for (const [action, params] of cases) {
      const { command } = agentActionCommand(action, params);
      const before = h.sent();
      const preview = await h.coordinator.agentCommand({ ...turn, command, action, dryRun: true });
      expect(preview).toMatchObject({ dryRun: true, command, needsConfirmation: true, confirmCard: { title: '待确认的操作', body: expect.stringContaining(`\`${command}\``) }, effect: expect.stringContaining('确认') });
      expect(h.sent()).toBe(before);
      expect(await h.coordinator.agentCommand({ ...turn, command, action })).toMatchObject({ pendingConfirmation: true });
      const card = h.repliesTo('om_1').filter(input => input.taskName === '待确认的操作').at(-1)!;
      expect(findElement(buildLarkCard(card), 'confirm_body')!.content).toContain((preview.confirmCard as any).body.split('\n\n')[0]);
      expect(findElement(buildLarkCard(card), 'confirm_body')!.content).toContain(`\`${command}\``);
    }
    expect(h.prompts).toHaveLength(1);
    // 没开通的能力：dry-run 直接说不可用，不预告一张注定失败的卡。
    await expect(h.coordinator.agentCommand({ ...turn, command: '/grant', action: 'access.grant', dryRun: true })).rejects.toMatchObject({ code: 'AGENT_COMMAND_UNAVAILABLE' });
    // /repair 自己发确认卡：预览给出那张卡的内容。
    expect(await h.coordinator.agentCommand({ ...turn, command: '/repair', action: 'repair', dryRun: true })).toMatchObject({ needsConfirmation: true, confirmCard: { body: expect.stringContaining(h.config.appId) } });
  });

  it('确认后与斜杠命令同一条路：点「确认」以点击人的身份执行，新一轮挂在确认卡下', async () => {
    const h = await harness();
    const turn = await h.current();
    const { command } = agentActionCommand('session.new', { agent: 'mock', task: '把报错改成中文' });
    expect(await h.coordinator.agentCommand({ ...turn, command, action: 'session.new' })).toMatchObject({ pendingConfirmation: true });
    const confirmCall = h.repliesTo('om_1').find(input => input.taskName === '待确认的操作')!;
    const confirmCardId = [...h.cards].find(([, input]) => input === confirmCall)![0];
    const value = findElement(buildLarkCard(confirmCall), 'confirm_confirm')!.behaviors[0].value;
    expect(await h.coordinator.handleAction(value, 'ou_alice', { messageId: confirmCardId, chatId: 'oc_group' })).toMatchObject({ type: 'success', content: expect.stringContaining('/new') });
    await vi.waitFor(() => expect(h.prompts).toHaveLength(2), { timeout: 10_000 });
    expect(h.prompts[1]).toContain('把报错改成中文');
    expect((await h.result(confirmCardId)).sessionId).not.toBe(turn.sessionId);
  });

  it('自己发确认卡的命令没开通时如实报错给 Agent；--member 只能是用户消息里 @ 过的人；--agent 填错时列出可用编号', async () => {
    const h = await harness();
    const turn = await h.current();
    await expect(h.coordinator.agentCommand({ ...turn, command: '/pr', action: 'pr.open' })).rejects.toMatchObject({ code: 'AGENT_COMMAND_REJECTED', message: expect.stringContaining('开 PR 未配置') });
    await expect(h.coordinator.agentCommand({ ...turn, command: '/new --agent nope -- 重做', action: 'session.new' }))
      .rejects.toMatchObject({ code: 'AGENT_COMMAND_INVALID', params: [{ name: '--agent', reason: expect.stringContaining('mock（Mock）') }] });
    const grant = await h.current(event('om_2', '给 @_user_2 开权限', [{ key: '@_user_2', name: 'Bob', openId: 'ou_bob' }]));
    await expect(h.coordinator.agentCommand({ ...grant, ...agentActionCommand('access.grant', { members: ['Carol'] }), action: 'access.grant' }))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT', params: [{ name: '--member', reason: expect.stringContaining('这条消息 @ 过：Bob') }] });
    expect(await h.coordinator.agentCommand({ ...grant, ...agentActionCommand('access.grant', { members: ['Bob'] }), action: 'access.grant' })).toMatchObject({ pendingConfirmation: true });
    const actions = await h.repos.collaboration.listActions({ appId: h.config.appId, chatId: 'oc_group' });
    expect(JSON.parse((actions.find(action => (action.payload as any).payload?.command === '/grant @Bob')!.payload as any).payload.mentions)).toEqual([{ key: '@_user_2', name: 'Bob', openId: 'ou_bob' }]);
  });
});


describe('session resume/fork 参数与确认卡', () => {
  it('验证参数并归到 write-confirm', () => {
    expect(agentActionCommand('session.resume', {})).toEqual({ command: '/resume' });
    expect(agentActionCommand('session.resume', { id: 'ses_123' })).toEqual({ command: '/resume ses_123' });
    expect(agentActionCommand('session.fork', { task: '并行检查' })).toEqual({ command: '/fork -- 并行检查' });
    for (const command of ['/resume', '/resume ses_123', '/fork 并行检查']) expect(agentCommandPlan(command).confirm).toBe(true);
    expect(() => agentActionCommand('session.resume', { id: 'two ids' })).toThrow('不能含空白');
    expect(() => agentActionCommand('session.fork', { task: '', workspace: 'bad' })).toThrow();
    expect(() => agentActionCommand('session.fork', { id: 'other' })).toThrow('不支持这个参数');
  });
  it.each(['/resume ses_old', '/fork 并行检查'])('%s 先发确认卡，未点击不执行', async command => {
    const h = await harness();
    const current = await h.current();
    const before = await h.runtime.listSessions();
    const result = await h.coordinator.agentCommand({ ...current, command, action: command.startsWith('/resume') ? 'session.resume' : 'session.fork' });
    expect(result).toMatchObject({ pendingConfirmation: true });
    expect(await h.runtime.listSessions()).toEqual(before);
    expect(h.repliesTo('om_1').some(input => input.taskName === '待确认的操作')).toBe(true);
  });
});

async function busyHarness(enabled = true, terminal = false, flat = false) {
  const h = await harness({}, true, terminal);
  h.config.busyTriage = enabled;
  if (flat) h.config.groupReplyMode = 'chat';
  await h.repos.config.set(larkBotsConfigKey, JSON.stringify([h.config]));
  const triage = vi.fn(async () => ({ kind: 'queue' } as ReturnType<typeof parseBusyTriageResult>));
  h.participation.triageBusy = triage;
  await h.coordinator.handle({ ...event('om_busy_first', '修改接口'), ...(flat ? { threadId: undefined, rootId: undefined } : {}) }, h.config);
  const active = await vi.waitFor(async () => {
    const mapping = await h.repos.channelMappings.get(`lark-card:${h.config.appId}`, 'om_busy_first');
    expect(mapping).toBeDefined();
    const task = (await h.runtime.getTasks(mapping!.sessionId)).find(task => task.status === 'running');
    expect(task?.currentAttemptId).toBeTruthy();
    return { sessionId: mapping!.sessionId, task: task! };
  });
  await vi.waitFor(() => expect(h.prompts).toHaveLength(1));
  const receive = (text: string, patch: Partial<LarkMessageEvent> = {}) => h.coordinator.handle({ ...event('om_busy_second', text), ...(flat ? { threadId: undefined, rootId: undefined } : {}), ...patch }, h.config);
  const queued = () => vi.waitFor(async () => {
    const tasks = await h.runtime.getTasks(active.sessionId);
    expect(tasks.filter(task => task.status === 'queued')).toHaveLength(1);
    return tasks;
  });
  return { ...h, triage, active, receive, queued };
}

describe('busy message triage through real runtime and confirmation cards', () => {
  it('keeps the old queue path with the switch off without calling the model', async () => {
    const h = await busyHarness(false);
    h.triage.mockResolvedValue({ kind: 'progress' });
    await h.receive('做到哪了');
    await h.queued();
    expect(h.triage).not.toHaveBeenCalled();
    expect(h.steers).toEqual([]);
    expect(h.repliesTo('om_busy_second').some(card => card.markdown?.includes('按问进度回复'))).toBe(false);
  });

  it('answers progress from host state without changing the running turn or queuing', async () => {
    const h = await busyHarness();
    h.triage.mockResolvedValue({ kind: 'progress' });
    const dispatch = vi.spyOn(h.runtime, 'dispatch');
    const inject = vi.spyOn(h.runtime, 'injectQueued');
    const stop = vi.spyOn(h.runtime, 'stop');
    const interrupt = vi.spyOn(h.runtime, 'interrupt');
    const permissions = vi.spyOn(h.runtime, 'getPendingPermissions').mockResolvedValue([{ id: 'pending' }] as any);
    await h.receive('做到哪了');
    expect(dispatch).not.toHaveBeenCalled(); expect(inject).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled(); expect(interrupt).not.toHaveBeenCalled();
    expect(await h.runtime.getTasks(h.active.sessionId)).toEqual([expect.objectContaining({ id: h.active.task.id, currentAttemptId: h.active.task.currentAttemptId, status: 'running' })]);
    expect(h.repliesTo('om_busy_second')).toEqual([expect.objectContaining({ markdown: expect.stringMatching(/按问进度回复。.*阶段：.*最近一步：.*已用时间：.*排队数：0.*待审批：有/s) })]);
    permissions.mockRestore();
  });

  it.each(['repair', 'pr.open', 'settings.set', 'schedule.create', 'status', 'progress'])('queues a busy %s message when its card cannot be delivered', async action => {
    const h = await busyHarness();
    const prepare = vi.fn(async () => ({ id: 'pr_test', sessionId: h.active.sessionId, title: '修复', branch: 'dutydeck/test', baseBranch: 'main', commits: [], files: [], excluded: [], bodySummary: '', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString(), status: 'proposed' }));
    const attachCard = vi.fn();
    const integration = createAutomationIntegration(h.repos, h.runtime, { authorize: async () => undefined } as any,
      { client: () => h.service as any, log: { warn: vi.fn() } });
    const automation = new SessionAutomationService({ repositories: h.repos, runtime: h.runtime,
      authorize: integration.authorize, prepareDelivery: integration.prepareDelivery });
    Object.assign((h.coordinator as any).workflowOptions, { saveBotConfig: vi.fn(), automation,
      scheduleRequests: { prepareDelivery: integration.prepareMessageDelivery, sendConfirmation: integration.sendScheduleRequest } });
    Object.defineProperty(automation, 'pullRequests', { value: { prepare, attachCard, availability: () => ({ available: true }) } });
    const params = action === 'settings.set' ? { pairs: ['busyTriage=true'] } : action === 'schedule.create' ? { prompt: '看 CI', every: 60 } : {};
    h.triage.mockResolvedValue(action === 'progress' ? { kind: 'progress' } : parseBusyTriageResult(JSON.stringify({ kind: 'command', action, params })));
    // 拒绝控制卡，普通排队任务的接入卡仍可正常发送。
    const reply = h.service.reply.getMockImplementation()!;
    h.service.reply.mockImplementation(async input => {
      if (/^(busy_|cmd_|confirm_|schedule_request_)/.test(String(input.idempotencyKey))) throw new Error('card delivery failed');
      return reply(input);
    });
    await h.receive('处理这个忙时消息');
    await h.queued();
    expect(JSON.parse((await h.repos.config.get(`lark.inbox.${h.config.appId}.om_busy_second`))!).state).toBe('accepted');
    if (action === 'pr.open') { expect(prepare).toHaveBeenCalledTimes(1); expect(attachCard).not.toHaveBeenCalled(); }
  });

  it.each(['proposed', 'cancelled', 'open', 'expired', 'elapsed'])('retries the prepared PR after card delivery fails (state: %s)', async state => {
    const h = await busyHarness();
    const proposals: any[] = [];
    const prepare = vi.fn(async () => {
      const proposal = { id: `pr_${proposals.length + 1}`, sessionId: h.active.sessionId, title: '修复', branch: 'dutydeck/test', target: 'main', commits: [], files: [], excluded: [], bodySummary: '', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString(), status: 'proposed' };
      proposals.push(proposal); return proposal;
    });
    const attachCard = vi.fn();
    (h.coordinator as any).workflowOptions.automation = { pullRequests: { prepare, attachCard, availability: () => ({ available: true }), listBySession: async () => proposals } };
    h.triage.mockResolvedValue(parseBusyTriageResult('{"kind":"command","action":"pr.open","params":{}}'));
    const reply = h.service.reply.getMockImplementation()!;
    h.service.reply.mockImplementation(async input => { if (input.taskName === '/pr 需要确认') throw new Error('card delivery failed'); return reply(input); });
    await h.receive('帮我开 PR');
    const tasks = await h.queued();
    const queued = tasks.find(task => task.status === 'queued')!;
    h.service.reply.mockImplementation(reply);
    // 排队后 Agent 对同一条用户消息重试；必须发送之前准备好的提案。
    if (state !== 'proposed') {
      if (state === 'elapsed') proposals[0].expiresAt = new Date(Date.now() - 1).toISOString();
      else proposals[0].status = state;
      await expect(h.coordinator.agentCommand({ sessionId: h.active.sessionId, taskId: queued.id, actorId: 'ou_alice', command: '/pr', action: 'pr.open' })).rejects.toThrow('之前准备的 PR 提案已不可用');
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(attachCard).not.toHaveBeenCalled();
      expect(h.repliesTo('om_busy_second').filter(input => input.taskName === '/pr 需要确认')).toHaveLength(1);
      return;
    }
    await h.coordinator.agentCommand({ sessionId: h.active.sessionId, taskId: queued.id, actorId: 'ou_alice', command: '/pr', action: 'pr.open' });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(attachCard).toHaveBeenCalledWith('pr_1', expect.any(String));
    expect(proposals).toHaveLength(1);
  });

  it('injects a supplement through the existing ACP queue steering path', async () => {
    const h = await busyHarness();
    h.triage.mockResolvedValue({ kind: 'supplement' });
    const inject = vi.spyOn(h.runtime, 'injectQueued');
    const interrupt = vi.spyOn(h.runtime, 'interrupt');
    await h.receive('接口还要兼容旧版');
    await vi.waitFor(() => expect(h.steers).toHaveLength(1));
    expect(h.steers[0]).toContain('接口还要兼容旧版');
    const saved = await h.result('om_busy_second');
    expect(JSON.stringify(h.cards.get(saved.final_message_id!))).toContain('按补充当前任务处理。');
    expect(inject).toHaveBeenCalledWith(h.active.sessionId, expect.any(String), 'ou_alice', undefined,
      { taskId: h.active.task.id, attemptId: h.active.task.currentAttemptId });
    expect(interrupt).not.toHaveBeenCalled();
    expect((await h.runtime.getTasks(h.active.sessionId)).find(task => task.id === h.active.task.id)?.status).toBe('running');
  });

  it('keeps terminal supplements queued without interrupting or promoting', async () => {
    const h = await busyHarness(true, true);
    h.triage.mockResolvedValue({ kind: 'supplement' });
    const inject = vi.spyOn(h.runtime, 'injectQueued');
    const promote = vi.spyOn(h.runtime, 'steerQueued');
    await h.receive('接口还要兼容旧版');
    await h.queued();
    await vi.waitFor(() => expect(inject).toHaveBeenCalled());
    expect(promote).not.toHaveBeenCalled(); expect(h.steers).toEqual([]);
  });

  it('queues stop intent and uncertainty unchanged', async () => {
    const h = await busyHarness();
    h.triage.mockResolvedValue(parseBusyTriageResult('{"kind":"queue"}'));
    const interrupt = vi.spyOn(h.runtime, 'interrupt');
    await h.receive('这件事情先别做了吧');
    await h.queued();
    expect(interrupt).not.toHaveBeenCalled();
  });

  it.each(['timeout', 'error', 'invalid'])('falls back to the queue on %s', async failure => {
    const h = await busyHarness();
    h.triage.mockImplementation(async () => {
      if (failure === 'invalid') return parseBusyTriageResult('{"kind":"command","action":"stop","params":{}}');
      throw new Error(failure);
    });
    await h.receive('做到哪了');
    await h.queued();
    expect(h.repliesTo('om_busy_second').some(card => card.markdown?.includes('按问进度回复'))).toBe(false);
    expect(h.steers).toEqual([]);
  });

  it.each([[30, '30 秒'], [750, '12 分 30 秒'], [3900, '1 小时 5 分']] as const)('formats %s seconds of progress for people', async (seconds, expected) => {
    const h = await busyHarness();
    h.triage.mockResolvedValue({ kind: 'progress' });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    try {
      (h.coordinator as any).tasks.get('om_busy_first').startedAt = Date.now() - seconds * 1000;
      await h.receive('做到哪了');
      expect(h.repliesTo('om_busy_second')[0]?.markdown).toContain(`已用时间：${expected}`);
    } finally { clock.mockRestore(); }
  });

  it.each(['thread', 'chat'])('proposes a disabled schedule for the new sender at the current %s message, without dispatching', async mode => {
    const h = await busyHarness(true, false, mode === 'chat');
    h.config.allowedUsers.push({ openId: 'ou_bob', name: 'Bob' } as any);
    await h.repos.config.set(larkBotsConfigKey, JSON.stringify([h.config]));
    const integration = createAutomationIntegration(h.repos, h.runtime, { authorize: async () => undefined } as any,
      { client: () => h.service as any, log: { warn: vi.fn() } });
    const automation = new SessionAutomationService({ repositories: h.repos, runtime: h.runtime,
      authorize: integration.authorize, prepareDelivery: integration.prepareDelivery });
    Object.assign((h.coordinator as any).workflowOptions, { automation,
      scheduleRequests: { prepareDelivery: integration.prepareMessageDelivery, sendConfirmation: integration.sendScheduleRequest } });
    h.triage.mockResolvedValue(parseBusyTriageResult('{"kind":"command","action":"schedule.create","params":{"prompt":"看下 CI","cron":"0 9 * * *"}}'));
    const dispatch = vi.spyOn(h.runtime, 'dispatch');
    await h.receive('每天九点看下 CI', { senderOpenId: 'ou_bob', ...(mode === 'chat' ? { threadId: undefined, rootId: undefined } : {}) });
    const schedules = (await automation.listBySession(h.active.sessionId, 'ou_bob')).schedules;
    expect(schedules).toHaveLength(1);
    expect(schedules[0]).toMatchObject({ enabled: false, prompt: '看下 CI', trigger: { kind: 'cron', expression: '0 9 * * *' } });
    const record = JSON.parse((await h.repos.config.get(`session_automation/schedule/${schedules[0]!.id}`))!);
    expect(record.actorId).toBe('ou_bob');
    expect(JSON.parse((await h.repos.config.get(`automation.delivery-target.${record.id}`))!)).toMatchObject({
      appId: h.config.appId, chatId: 'oc_group', replyMessageId: 'om_busy_second', replyInThread: mode === 'thread'
    });
    expect(h.repliesTo('om_busy_second')).toHaveLength(1);
    expect(JSON.stringify(h.repliesTo('om_busy_second')[0])).toContain('按控制操作处理。');
    expect(JSON.stringify(h.repliesTo('om_busy_second')[0])).toContain('dutydeck_schedule_enable');
    expect(dispatch).not.toHaveBeenCalled(); expect(h.prompts).toHaveLength(1);
    expect(await h.runtime.getTasks(h.active.sessionId)).toHaveLength(1);
  });

  it('sends settings to the shared admin confirmation path using the current sender and message without saving', async () => {
    const h = await busyHarness();
    h.config.allowedUsers.push({ openId: 'ou_bob', name: 'Bob' } as any);
    await h.repos.config.set(larkBotsConfigKey, JSON.stringify([h.config]));
    h.service.listChatMembers.mockResolvedValue({ items: [{ memberId: 'ou_alice' }, { memberId: 'ou_bob' }], hasMore: false });
    const save = vi.fn();
    (h.coordinator as any).workflowOptions.saveBotConfig = save;
    h.triage.mockResolvedValue(parseBusyTriageResult('{"kind":"command","action":"settings.set","params":{"pairs":["defaultAgentId=mock","notifyQuietHours=22:00-08:00"]}}'));
    await h.receive('以后默认用 mock，晚上十点到早上八点别推送', { senderOpenId: 'ou_bob' });
    const actions = await h.repos.collaboration.listActions({ appId: h.config.appId, chatId: 'oc_group' });
    expect(actions).toEqual([expect.objectContaining({ requesterId: 'ou_bob', kind: `confirm.agent_settings.${h.config.appId}`, status: 'intent' })]);
    expect(actions[0]?.payload).toMatchObject({ summary: expect.stringContaining('按控制操作处理。'), replyTo: { messageId: 'om_busy_second' } });
    expect(h.repliesTo('om_busy_second')).toHaveLength(1);
    expect(save).not.toHaveBeenCalled();
    expect(await readLarkConfig(h.repos.config, h.config.appId)).not.toHaveProperty('notifyQuietHours');
    expect(await h.runtime.getTasks(h.active.sessionId)).toHaveLength(1);
  });

  it.each([
    ['schedule.create', { prompt: '看 CI', cron: 'invalid' }],
    ['schedule.create', { prompt: '看 CI', every: 0 }],
    ['schedule.create', { prompt: '看 CI', cron: '0 9 * * *', replyMessageId: 'om_wrong' }],
    ['settings.set', { pairs: ['permissionMode=full-trust'] }],
    ['settings.set', { pairs: ['notifyQuietHours=invalid'] }],
    ['settings.set', { pairs: ['defaultAgentId=missing'] }]
  ])('queues invalid busy %s parameters without creating a card or writing', async (action, params) => {
    const h = await busyHarness();
    const save = vi.fn();
    (h.coordinator as any).workflowOptions.saveBotConfig = save;
    h.triage.mockImplementation(async () => parseBusyTriageResult(JSON.stringify({ kind: 'command', action, params })));
    await h.receive('处理这个控制操作');
    await h.queued();
    expect(await h.repos.collaboration.listActions({ appId: h.config.appId, chatId: 'oc_group' })).toHaveLength(0);
    expect(save).not.toHaveBeenCalled();
    expect(h.repliesTo('om_busy_second')).not.toContainEqual(expect.objectContaining({ taskName: '定时任务' }));
    expect(await h.repos.config.list!('session_automation/schedule/')).toHaveLength(0);
  });

  it('runs read-only controls immediately in the message sender scope', async () => {
    const h = await busyHarness();
    h.triage.mockResolvedValue(parseBusyTriageResult('{"kind":"command","action":"queue","params":{}}'));
    await h.receive('看下排队列表');
    expect(h.repliesTo('om_busy_second')).toEqual([expect.objectContaining({ markdown: expect.stringContaining('按控制操作处理。') })]);
    expect(await h.runtime.getTasks(h.active.sessionId)).toHaveLength(1);
  });

  it('preserves the task navigation result for read-only task controls', async () => {
    const h = await busyHarness();
    h.triage.mockResolvedValue(parseBusyTriageResult('{"kind":"command","action":"tasks","params":{}}'));
    await h.receive('看看任务列表');
    const cards = h.repliesTo('om_busy_second');
    expect(cards).toHaveLength(1);
    expect(cards[0]?.elements[0]).toMatchObject({ content: '按控制操作处理。' });
    expect(cards[0]?.elements.length).toBeGreaterThan(1);
    expect(await h.runtime.getTasks(h.active.sessionId)).toHaveLength(1);
  });

  it('sends only a confirmation card for writes using the new sender, without executing', async () => {
    const h = await busyHarness();
    h.config.allowedUsers.push({ openId: 'ou_bob', name: 'Bob' } as any);
    await h.repos.config.set(larkBotsConfigKey, JSON.stringify([h.config]));
    h.triage.mockResolvedValue(parseBusyTriageResult('{"kind":"command","action":"session.new","params":{"agent":"mock","task":"重做接口"}}'));
    const stop = vi.spyOn(h.runtime, 'stop');
    await h.receive('换 mock 重做接口', { senderOpenId: 'ou_bob' });
    const actions = await h.repos.collaboration.listActions({ appId: h.config.appId, chatId: 'oc_group' });
    expect(actions).toEqual([expect.objectContaining({ requesterId: 'ou_bob', status: 'intent', kind: `confirm.agent_command.${h.config.appId}` })]);
    expect(actions[0]?.payload).toMatchObject({ summary: expect.stringContaining('按控制操作处理。'), replyTo: { messageId: 'om_busy_second' } });
    expect(h.repliesTo('om_busy_second')).toHaveLength(1);
    expect(stop).not.toHaveBeenCalled(); expect(h.prompts).toHaveLength(1);
    expect(await h.runtime.getTasks(h.active.sessionId)).toHaveLength(1);
  });

  it('does not triage unauthorized users', async () => {
    const h = await busyHarness();
    await h.receive('做到哪了', { senderOpenId: 'ou_mallory' });
    expect(h.triage).not.toHaveBeenCalled();
  });

  it.each(['slash', 'control', 'bot', 'automation', 'confirmation', 'question', 'approval'])('preserves the %s route', async kind => {
    const h = await busyHarness();
    let patch: Partial<LarkMessageEvent> = {};
    let text = '做到哪了';
    if (kind === 'slash') text = '/status';
    if (kind === 'control') text = '继续';
    if (kind === 'bot') patch.senderType = 'bot';
    if (kind === 'automation') patch.messageId = 'lark-task:test-guid';
    if (kind === 'question' || kind === 'approval') {
      patch.parentId = 'om_pending_card';
      await h.repos.config.set(`lark.interaction.${h.config.appId}.pending`, JSON.stringify({
        id: 'pending', appId: h.config.appId, sessionId: h.active.sessionId, taskId: h.active.task.id, turn: 1,
        boot: (h.coordinator as any).workflows.boot, kind: kind === 'question' ? 'ask' : 'permission', nativeId: 'native_pending',
        question: '继续吗？', state: 'pending', cardId: patch.parentId, updatedAt: new Date().toISOString(), event: event('om_busy_first', '修改接口')
      }));
    }
    if (kind === 'confirmation') {
      h.participation.confirmations.register('test', { authorize: async () => true, apply: async () => 'done' });
      const record = await h.participation.confirmations.request({ kind: 'test', scope: { appId: h.config.appId, chatId: 'oc_group' }, requesterId: 'ou_alice',
        replyTo: { messageId: 'om_busy_first' }, title: '确认', summary: '测试', payload: {} });
      patch.parentId = record!.cardMessageId;
    }
    await h.receive(text, patch);
    expect(h.triage).not.toHaveBeenCalled();
  });

  it('rechecks sender access after the model returns', async () => {
    const h = await busyHarness();
    h.triage.mockImplementation(async () => {
      h.config.allowedUsers = [{ openId: 'ou_bob', name: 'Bob' }] as any;
      await h.repos.config.set(larkBotsConfigKey, JSON.stringify([h.config]));
      return { kind: 'progress' };
    });
    await h.receive('做到哪了');
    expect(h.repliesTo('om_busy_second').some(card => card.markdown?.includes('按问进度回复'))).toBe(false);
  });

  it('does not inject a decision after the running attempt changes', async () => {
    const h = await busyHarness();
    h.triage.mockImplementation(async () => {
      h.release();
      await h.result('om_busy_first');
      return { kind: 'supplement' };
    });
    await h.receive('接口兼容旧版');
    await h.result('om_busy_second');
    expect(h.steers).toEqual([]);
  });
});


describe('恢复和分身确认卡不跨会话执行', () => {
  it.each(['/fork 并行检查', '/resume ses_old'])('确认 %s 前已切到新会话时拒绝', async command => {
    const h = await harness(); const first = await h.current();
    await h.coordinator.agentCommand({ ...first, command });
    const card = h.repliesTo('om_1').find(input => input.taskName === '待确认的操作')!;
    const cardId = [...h.cards].find(([, value]) => value === card)![0];
    await h.coordinator.handle(event('om_new', '/new'), h.config);
    await h.coordinator.handle(event('om_next', '新会话任务'), h.config);
    const next = await h.result('om_next'); expect(next.sessionId).not.toBe(first.sessionId);
    const before = await h.runtime.listSessions();
    const value = findElement(buildLarkCard(card), 'confirm_confirm')!.behaviors[0].value;
    expect(await h.coordinator.handleAction(value, 'ou_alice', { messageId: cardId, chatId: 'oc_group' })).toMatchObject({ content: expect.stringContaining('会话已经切换') });
    expect(await h.runtime.listSessions()).toEqual(before);
  });
  it('恢复确认卡按点击人重新检查目标的 run.resume 权限', async () => {
    const h = await harness(); const old = await h.current();
    await h.coordinator.handle(event('om_new', '/new'), h.config);
    const current = await h.current(event('om_next', '当前任务'));
    const authorize = vi.fn(async (_app: string, _chat: string, actor: string, action: string) => ({ allowed: action !== 'run.resume' || actor === 'ou_alice' }));
    (h.coordinator as any).groupManager = { resolved: async (config: any) => ({ ...config, managedGroup: { bindingId: 'binding', revision: 1 } }), authorize };
    await h.coordinator.agentCommand({ ...current, command: `/resume ${old.sessionId}` });
    const card = h.repliesTo('om_next').find(input => input.taskName === '待确认的操作')!;
    const cardId = [...h.cards].find(([, value]) => value === card)![0];
    const value = findElement(buildLarkCard(card), 'confirm_confirm')!.behaviors[0].value;
    await h.coordinator.handleAction(value, 'ou_bob', { messageId: cardId, chatId: 'oc_group' });
    await vi.waitFor(() => expect(h.repliesTo(cardId).map(card => card.markdown).join()).toContain('没有这个可见的已关闭会话'));
    expect((await h.runtime.getSession(old.sessionId))?.state).toBe('stopped');
    expect((await h.runtime.getSession(current.sessionId))?.state).toBe('idle');
    expect(authorize).toHaveBeenCalledWith(h.config.appId, 'oc_group', 'ou_bob', 'run.resume', old.sessionId, { taskRequesterOpenId: 'ou_alice' });
  });

  it('无编号恢复在确认卡中固定目标；归档后点击不能恢复', async () => {
    const h = await harness(); const first = await h.current();
    await h.coordinator.handle(event('om_new', '/new'), h.config);
    await h.coordinator.handle(event('om_next', '新会话任务'), h.config);
    const next = await h.current(event('om_next', '新会话任务'));
    await h.coordinator.agentCommand({ ...next, command: '/resume' });
    const card = h.repliesTo('om_next').find(input => input.taskName === '待确认的操作')!;
    expect(findElement(buildLarkCard(card), 'confirm_body')!.content).toContain(`/resume ${first.sessionId}`);
    await h.runtime.archive(first.sessionId, { kind: 'channel', id: 'ou_alice', appId: h.config.appId });
    const cardId = [...h.cards].find(([, value]) => value === card)![0];
    const value = findElement(buildLarkCard(card), 'confirm_confirm')!.behaviors[0].value;
    await h.coordinator.handleAction(value, 'ou_alice', { messageId: cardId, chatId: 'oc_group' });
    await vi.waitFor(() => expect(h.repliesTo(cardId).map(c => c.markdown).join()).toContain('没有这个可见的已关闭会话'));
    expect((await h.runtime.getSession(next.sessionId))?.state).toBe('idle');
  });
});

async function settingsHarness(managed = false) {
  let save!: (input: any) => Promise<unknown>;
  const h = await harness({ saveBotConfig: (input: any) => save(input) });
  const app = Fastify();
  const sync = vi.fn(async () => {});
  const refreshPolicies = vi.fn(async () => {});
  await registerLarkRoutes(app, { config: h.repos.config, agents: h.repos.agents, runtime: h.runtime, env: {},
    listener: { listening: true, activeAppIds: [h.config.appId], sync, stop() {} },
    groupManager: { refreshPolicies } as any, fetcher: vi.fn(async () => { throw new Error('Unexpected network'); }) });
  cleanups.push(() => app.close());
  const persist = vi.fn(async (input: any) => {
    const response = await app.inject({ method: 'PUT', url: '/api/lark/config', payload: input });
    if (response.statusCode >= 400) { const error = response.json().error; throw new LarkServiceError(error.code, error.message, response.statusCode); }
    return response.json();
  });
  save = persist;
  const turn = await h.current();
  if (managed) (h.coordinator as any).groupManager = {
    resolved: async (config: any) => ({ ...config, defaultAgentId: 'group-agent', defaultModel: 'group-model', notifyMentionDone: false }),
    authorize: async (_app: string, _chat: string, operator: string, action: string) => ({ allowed: action !== 'channel_bot.update' || operator === 'ou_alice' })
  };
  const request = (pairs?: string[], extra: Record<string, unknown> = {}) => h.coordinator.agentSettings({ ...turn, action: pairs ? 'set' : 'show', ...(pairs ? { pairs } : {}), ...extra });
  const record = async () => (await h.repos.collaboration.listActions({ appId: h.config.appId, chatId: 'oc_group' })).find(action => action.kind === `confirm.agent_settings.${h.config.appId}`)!;
  const confirm = async (operator = 'ou_alice') => {
    const action = await record();
    return h.coordinator.handleAction({ dutydeck_confirm: 'confirm', confirm_id: action.id, chat_id: 'oc_group' }, operator, { chatId: 'oc_group', messageId: action.receipt });
  };
  return { ...h, app, request, record, confirm, persist, sync, refreshPolicies };
}

describe('Agent common bot settings', () => {
  it('shows exactly the whitelist from bot defaults, ignoring group overrides and secrets', async () => {
    const h = await settingsHarness(true);
    const shown = await h.request();
    expect(Object.keys(shown).sort()).toEqual([...agentSettingsKeys].sort());
    expect(shown).toMatchObject({ defaultAgentId: 'mock', defaultModel: '', notifyMentionDone: true, busyTriage: false });
    expect(JSON.stringify(shown)).not.toMatch(/fake-secret|group-agent|group-model|allowedUsers|permissionMode/);
  });

  it.each(['permissionMode=full-trust', 'allowedUsers=[]', 'highRiskPattern=.*', 'appSecret=secret', 'notASetting=true'])('rejects non-whitelisted %s without a card', async pair => {
    const h = await settingsHarness();
    await expect(h.request([pair])).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(await h.record()).toBeUndefined(); expect(h.persist).not.toHaveBeenCalled();
  });

  it.each(['busyTriage=yes', 'notifyMentionDone=0', 'p2pMode=invalid', 'groupReplyMode=invalid', 'notifyQuietHours=25:00-08:00', 'notifyQuietHours=22:00-22:00', 'defaultAgentId=missing'])('rejects invalid %s before confirmation', async pair => {
    const h = await settingsHarness();
    await expect(h.request([pair])).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(await h.record()).toBeUndefined(); expect(h.persist).not.toHaveBeenCalled();
  });

  it('previews writes and saves only after an admin confirms through the Web save path', async () => {
    const h = await settingsHarness(true);
    const pairs = ['defaultAgentId=mock', 'defaultModel=custom', 'defaultReasoningEffort=custom-effort', 'notifyQuietHours=22:00-08:00', 'busyTriage=true'];
    expect(await h.request(pairs, { dryRun: true })).toMatchObject({ dryRun: true, needsConfirmation: true, settings: { busyTriage: true } });
    expect(await h.record()).toBeUndefined();
    expect(await h.request(pairs)).toMatchObject({ pendingConfirmation: true });
    expect(h.persist).not.toHaveBeenCalled();
    expect(await readLarkConfig(h.repos.config, h.config.appId)).toMatchObject({ busyTriage: false });
    expect(await h.confirm('ou_bob')).toMatchObject({ type: 'warning', content: '只有机器人管理员能确认。' });
    expect(h.persist).not.toHaveBeenCalled();
    const before = (await readLarkConfig(h.repos.config, h.config.appId))!;
    expect(await h.confirm()).toMatchObject({ type: 'success' });
    expect(h.persist).toHaveBeenCalledWith(expect.objectContaining({ originalAppId: h.config.appId, stage: 'agent', expectedRevision: before.revision ?? 1 }));
    expect(await readLarkConfig(h.repos.config, h.config.appId)).toMatchObject({ defaultModel: 'custom', defaultReasoningEffort: 'custom-effort', notifyQuietHours: '22:00-08:00', busyTriage: true });
    expect(h.sync).toHaveBeenCalledTimes(2); expect(h.refreshPolicies).toHaveBeenCalledTimes(1);
    expect(await h.confirm()).toMatchObject({ type: 'info' }); expect(h.persist).toHaveBeenCalledTimes(1);
  });

  it('denies highRisk own_runs operators but lets bot administrators confirm settings', async () => {
    const h = await settingsHarness(true);
    const manager = new LarkGroupManager(h.repos, { client: () => ({
      getBotInfo: async () => ({ appName: h.config.appId, openId: 'ou_bot' }),
      checkApplicationIdentity: async () => ({ verified: true, reportedAppId: h.config.appId, tenantKey: 'synthetic-tenant' }),
      listChats: async () => ({ items: [{ chatId: 'oc_group', name: '设置群', chatMode: 'topic' }], hasMore: false }),
      listChatMembers: async () => ({ items: ['alice', 'bob'].map(name => ({ memberId: `ou_${name}`, openId: `ou_${name}`, name, memberType: 'user' })), hasMore: false, securityLimited: false }),
      getUserEmails: async () => []
    }) as any });
    await manager.sync(h.config.appId);
    const members = (await manager.members(h.config.appId, 'oc_group')).members;
    await manager.save(h.config.appId, 'oc_group', { expectedRevision: 0, patch: {}, roleChanges: [
      { kind: 'create', principalId: members.find(member => member.openId === 'ou_bob')!.principalId, role: 'can_operate', operateScope: 'own_runs', actionGates: { highRisk: true, terminalWrite: false, groupToolsSend: false } }
    ] });
    const binding = (await manager.groups()).groups[0]!.bots[0]!.binding!;
    await h.repos.roleAssignments.create({ id: 'alice_admin', channelBotId: binding.channelBotId, groupBindingId: binding.id, principalId: members.find(member => member.openId === 'ou_alice')!.principalId, role: 'admin', operateScope: 'none', actionGates: { terminalWrite: false, highRisk: false, groupToolsSend: false } });
    (h.coordinator as any).groupManager = manager;
    expect(await manager.authorize(h.config.appId, 'oc_group', 'ou_bob', 'high_risk.execute')).toMatchObject({ allowed: true });
    expect(await manager.authorize(h.config.appId, 'oc_group', 'ou_bob', 'channel_bot.update')).toMatchObject({ allowed: false });
    await h.request(['busyTriage=true']);
    expect(await h.confirm('ou_bob')).toMatchObject({ type: 'warning', content: '只有机器人管理员能确认。' });
    expect(h.persist).not.toHaveBeenCalled();
    expect(await h.confirm()).toMatchObject({ type: 'success' });
    expect(h.persist).toHaveBeenCalledTimes(1);
  });

  it('denies the requester in a managed group when they lack bot management permission', async () => {
    const h = await settingsHarness(true);
    await h.request(['busyTriage=true'], { actorId: 'ou_bob' });
    expect((await h.record()).requesterId).toBe('ou_bob');
    expect(await h.confirm('ou_bob')).toMatchObject({ type: 'warning' });
    expect(h.persist).not.toHaveBeenCalled();
  });

  it('uses explicit static admins outside managed groups and saves all supported value types', async () => {
    const h = await settingsHarness();
    await h.request(['p2pMode=thread', 'groupReplyMode=shared', 'notifyMentionAction=false', 'notifyMentionDone=false', 'defaultModel=', 'defaultReasoningEffort=', 'notifyQuietHours=']);
    expect(await h.confirm('ou_bob')).toMatchObject({ type: 'warning' });
    expect(h.persist).not.toHaveBeenCalled();
    expect(await h.confirm()).toMatchObject({ type: 'success' });
    expect(await h.request()).toMatchObject({ p2pMode: 'thread', groupReplyMode: 'shared', notifyMentionAction: false, notifyMentionDone: false,
      defaultModel: '', defaultReasoningEffort: '', notifyQuietHours: '' });
  });

  it('requires a configured static admin list outside managed groups', async () => {
    const h = await settingsHarness();
    await h.request(['busyTriage=true']);
    h.config.allowedUsers = [];
    await h.repos.config.set(larkBotsConfigKey, JSON.stringify([h.config]));
    expect(await h.confirm()).toMatchObject({ type: 'warning' });
    expect(h.persist).not.toHaveBeenCalled();
  });

  it('rejects stale confirmation revisions and preserves the newer Web settings', async () => {
    const h = await settingsHarness(true);
    await h.request(['busyTriage=true']);
    const current = (await readLarkConfig(h.repos.config, h.config.appId))!;
    const response = await h.app.inject({ method: 'PUT', url: '/api/lark/config', payload: { originalAppId: h.config.appId, expectedRevision: current.revision ?? 1, defaultModel: 'newer-model' } });
    expect(response.statusCode).toBe(200);
    expect(await h.confirm()).toMatchObject({ type: 'error' });
    expect(await readLarkConfig(h.repos.config, h.config.appId)).toMatchObject({ defaultModel: 'newer-model', busyTriage: false });
  });
});
