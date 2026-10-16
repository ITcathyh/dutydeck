// Agent 代用户发飞书命令（dutydeck command）：查看类直接出结果卡，会改东西的先发确认卡，点「确认」后以点击人身份执行。
// 真实 DutydeckRuntime + SQLite + 真实确认卡，飞书接口用替身。
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
import { LarkConfirmCards } from './confirm-cards.js';
import { agentActionCommand, agentCommandHelp, agentCommandPlan } from './agent-command.js';
import { parseLarkNewSession } from './new-session.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const event = (id: string, text: string, mentions: LarkMessageEvent['mentions'] = []): LarkMessageEvent => ({
  messageId: id, chatId: 'oc_group', chatType: 'group', threadId: 'omt_topic', rootId: 'om_root',
  senderOpenId: 'ou_alice', senderType: 'user', messageType: 'text', content: JSON.stringify({ text: `@_user_1 ${text}` }),
  mentions: [{ key: '@_user_1', name: 'Dock', openId: 'ou_bot' }, ...mentions]
});

async function harness(workflow: Record<string, unknown> = {}) {
  const state = await mkdtemp(join(tmpdir(), 'dutydeck-lark-agent-command-'));
  const repos = createRepositories(join(state, 'state.db'), { newDatabaseAuthority: 'ledger_v1' });
  const prompts: string[] = [];
  const runtime = new DutydeckRuntime(repos, {
    probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }),
    driverFactory: (_config, _protocol, emit) => ({
      start: async () => {}, resume: async () => {}, stop: async () => {}, interrupt: async () => {}, isStopped: async () => true,
      send: async prompt => {
        prompts.push(typeof prompt === 'string' ? prompt : JSON.stringify(prompt));
        emit({ type: 'text', data: { text: `第 ${prompts.length} 轮做完了` } });
        emit({ type: 'completed', data: { stopReason: 'end_turn' } });
      }
    } satisfies AgentDriver)
  });
  const agent: AgentConfig = { id: 'mock', name: 'Mock', command: process.execPath, args: [], protocol: 'acp', cwd: state, env: {},
    permissionMode: 'ask', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };
  await runtime.initialize([agent]);
  const config: StoredLarkConfig = { appId: 'cli_agent_command', appSecret: 'fake-secret', name: 'Dock', workspace: state, defaultAgentId: 'mock',
    permissionMode: 'ask', listening: true, fullTrustConfirmed: true, preInjectPrompt: '', structuredAskCards: false,
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
  cleanups.push(async () => { coordinator.stop(); await runtime.shutdown(); repos.close(); await rm(state, { recursive: true, force: true }); });
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
  return { repos, runtime, participation, config, service, cards, prompts, coordinator, result, turn, repliesTo, sent, current };
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
