import Fastify from 'fastify';
import { ZodError } from 'zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import { RuntimeError, type PublicSessionSchedule, type Session } from '@dutydeck/shared';
import { AgentGroupToolError, LarkAgentToolCapabilityRegistry, LarkAgentToolsService } from './lark/agent-tools.js';
import { larkBotsConfigKey } from './lark/config.js';
import { AgentCommandParamError } from './lark/agent-command.js';
import { isAutomatedRequest, registerAgentRequestTools, type AgentRequestToolsOptions } from './agent-request-tools.js';

const apps: ReturnType<typeof Fastify>[] = [];
const repositories: Array<ReturnType<typeof createRepositories>> = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close()));
  for (const repository of repositories.splice(0)) repository.close();
});

const session = (id: string, sourceId: string): Session => ({ id, agentId: 'codex', state: 'idle', cwd: '/tmp', source: 'lark', sourceId, runId: 'run_1', createdAt: '', updatedAt: '' });

async function setup() {
  const repos = createRepositories(':memory:'); repositories.push(repos);
  const group = session('ses_group', 'cli_bot:oc_group:group');
  const p2p = session('ses_p2p', 'cli_bot:oc_p2p:p2p');
  await repos.sessions.save(group);
  await repos.sessions.save(p2p);
  // 群协作工具关着也要能用：私聊和没开群工具的机器人同样不该让用户去记 /schedule。
  await repos.config.set(larkBotsConfigKey, JSON.stringify([{ appId: 'cli_bot', appSecret: 'secret', name: 'Bot', defaultAgentId: 'codex', groupToolsEnabled: false }]));
  const capabilities = new LarkAgentToolCapabilityRegistry(repos.sessions, 'http://127.0.0.1:4310');
  const tools = new LarkAgentToolsService(capabilities, repos.config, {});
  let active: { taskId: string; actorId?: string; attemptId?: string } | undefined = { taskId: 'task_1', actorId: 'ou_alice', attemptId: 'attempt_1' };
  const automated = new Set<string>();
  const saved = new Map<string, PublicSessionSchedule>();
  const requestSchedule = vi.fn<AgentRequestToolsOptions['automation']['requestSchedule']>(async (sessionId, input, actorId, receipt) => {
    const id = `schedule_${receipt!.key}`;
    if (!saved.has(id)) {
      await receipt!.prepareDelivery!(id);
      saved.set(id, { schemaVersion: 1, id, revision: 1, generation: 1, sessionId, name: input.name, prompt: input.prompt, trigger: input.trigger, timezone: input.timezone,
        dstPolicy: input.dstPolicy, condition: { kind: 'always' }, enabled: false, createdAt: '', updatedAt: '' } as PublicSessionSchedule);
    }
    expect(actorId).toBe('ou_alice');
    return { schedule: saved.get(id)! };
  });
  const prepareDelivery = vi.fn(async () => {});
  const sendConfirmation = vi.fn(async () => {});
  const app = Fastify(); apps.push(app);
  // 与 app.ts 相同的错误映射。
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: error.message } });
    if (error instanceof AgentGroupToolError || error instanceof AgentCommandParamError) return reply.code(error.statusCode).send(error.response());
    if (error instanceof RuntimeError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
    return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: error.message } });
  });
  const requestScheduleStop = vi.fn(async () => ({ pendingDelivery: true, scheduleId: 'host_bound' }));
  await registerAgentRequestTools(app, { runtime: { getActiveTaskContext: () => active }, automatedTask: taskId => automated.has(taskId), tools, automation: { requestSchedule, requestScheduleStop }, prepareDelivery, sendConfirmation });
  const request = (target: Session, payload: object, turn = capabilities.workbenchTurnToken(target.id, active?.taskId ?? '', active?.attemptId ?? ''), path = 'schedules') => app.inject({
    method: 'POST', url: `/api/lark/agent-tools/${path}`, payload,
    headers: { authorization: `Bearer ${capabilities.environmentFor(target).dutydeck_group_tools_token}`, 'x-dutydeck-work-turn': turn }
  });
  const command = (payload: object, turn?: string) => request(group, payload, turn, 'commands');
  // 模拟本轮提示提供的不可变 agent --turn 前缀。
  const agent = (method: 'GET' | 'POST', path: string, payload?: object, turn = capabilities.workbenchTurnToken(group.id, active?.taskId ?? '', active?.attemptId ?? '')) => app.inject({
    method, url: `/api/lark/agent-tools/${path}`, ...(payload ? { payload } : {}),
    headers: { authorization: `Bearer ${capabilities.environmentFor(group).dutydeck_group_tools_token}`, ...(turn ? { 'x-dutydeck-work-turn': turn } : {}) }
  });
  const currentTurn = () => capabilities.workbenchTurnToken(group.id, active?.taskId ?? '', active?.attemptId ?? '');
  return { group, p2p, request, command, agent, requestScheduleStop, currentTurn, tools, requestSchedule, prepareDelivery, sendConfirmation, saved, automated, setActive: (value: typeof active) => { active = value; } };
}

describe('Agent schedule requests', () => {
  it('accepts only a self stop request without an arbitrary schedule id during an automated active turn', async () => {
    const f = await setup(); f.automated.add('task_1');
    const result = await f.agent('POST', 'schedules/stop-self', {});
    expect(result.statusCode).toBe(200);
    expect(f.requestScheduleStop).toHaveBeenCalledWith('ses_group', 'task_1', 'attempt_1', 'ou_alice');
    expect((await f.agent('POST', 'schedules/stop-self', { scheduleId: 'other' })).statusCode).toBe(400);
    expect(f.requestScheduleStop).toHaveBeenCalledOnce();
  });

  it('creates a disabled schedule for the turn requester, posts one confirmation card, and returns the same schedule on retry', async () => {
    const f = await setup();
    const first = await f.request(f.group, { every: 15, prompt: '看看这个话题有没有排查结论', name: '盯结论' });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ pendingConfirmation: true, scheduleId: expect.stringMatching(/^schedule_agent-request:/) });
    const input = f.requestSchedule.mock.calls[0]![1];
    expect(input).toMatchObject({ name: '盯结论', prompt: '看看这个话题有没有排查结论', trigger: { kind: 'interval', everySeconds: 900 }, timezone: 'Asia/Shanghai', condition: { kind: 'always' } });
    expect(f.prepareDelivery).toHaveBeenCalledWith('ses_group', 'task_1', first.json().scheduleId);
    expect(f.sendConfirmation).toHaveBeenCalledTimes(1);
    expect(f.sendConfirmation.mock.calls[0]![0]).toMatchObject({ id: first.json().scheduleId, enabled: false });

    const retry = await f.request(f.group, { every: 15, prompt: '看看这个话题有没有排查结论', name: '盯结论' });
    expect(retry.json().scheduleId).toBe(first.json().scheduleId);
    expect(f.saved.size).toBe(1);
    const other = await f.request(f.group, { cron: '0 9 * * *', prompt: '汇总昨天的告警' });
    expect(other.json().scheduleId).not.toBe(first.json().scheduleId);
    expect(f.requestSchedule.mock.calls[2]![1]).toMatchObject({ name: '汇总昨天的告警', trigger: { kind: 'cron', expression: '0 9 * * *' } });

    // 用户已经点过「启用」：不再发确认卡。
    f.saved.get(first.json().scheduleId)!.enabled = true;
    f.sendConfirmation.mockClear();
    expect((await f.request(f.group, { every: 15, prompt: '看看这个话题有没有排查结论', name: '盯结论' })).json()).toMatchObject({ pendingConfirmation: false });
    expect(f.sendConfirmation).not.toHaveBeenCalled();
  });

  it('passes the fresh-session mode through and rejects unknown modes', async () => {
    const f = await setup();
    expect((await f.request(f.group, { cron: '0 2 * * *', prompt: '更新并部署', name: '部署', mode: 'fresh' })).statusCode).toBe(200);
    expect(f.requestSchedule.mock.calls[0]![1]).toMatchObject({ name: '部署', mode: 'fresh' });
    expect((await f.request(f.group, { cron: '0 2 * * *', prompt: '更新并部署', mode: 'independent' })).statusCode).toBe(400);
    expect(f.requestSchedule).toHaveBeenCalledTimes(1);
  });

  it('defaults new recurring schedules to fresh sessions unless the user asked to continue the chat', async () => {
    const f = await setup();
    await f.request(f.group, { every: 15, prompt: '盯结论', name: 'A' });
    await f.request(f.group, { cron: '0 9 * * *', prompt: '汇总', name: 'B', mode: 'session' });
    await f.request(f.group, { at: '2026-10-17T10:00', prompt: '提醒我', name: 'C' });
    const [fresh, session, once] = f.requestSchedule.mock.calls;
    expect(fresh![1].mode).toBeUndefined();
    expect(fresh![3]).toMatchObject({ newMode: 'fresh' });
    expect(session![1].mode).toBe('session');
    expect(session![3].newMode).toBeUndefined();
    expect(once![3].newMode).toBeUndefined();
    const dryRun = await f.request(f.group, { every: 15, prompt: '盯结论', dryRun: true });
    expect(dryRun.json().effect).toContain('每次在新会话里执行');
  });

  it('works in p2p chats and for one-off times', async () => {
    const f = await setup();
    const response = await f.request(f.p2p, { at: '2026-10-17T10:00', prompt: '提醒我看发布结果' });
    expect(response.statusCode).toBe(200);
    expect(f.requestSchedule.mock.calls[0]![0]).toBe('ses_p2p');
    expect(f.requestSchedule.mock.calls[0]![1].trigger).toEqual({ kind: 'at', localDateTime: '2026-10-17T10:00' });
  });

  it('reports a saved, disabled schedule when confirmation delivery fails and retries the same schedule', async () => {
    const f = await setup();
    f.sendConfirmation.mockRejectedValueOnce(new Error('Lark confirmation unavailable'));
    const payload = { every: 15, prompt: '看看有没有结论' };
    const failed = await f.request(f.group, payload);
    expect(failed.statusCode).toBe(200);
    const result = failed.json();
    expect(result).toMatchObject({ saved: true, pendingConfirmation: true, confirmationDelivery: 'failed', scheduleId: expect.any(String),
      warning: { code: 'SCHEDULE_CONFIRMATION_DELIVERY_FAILED', message: 'Lark confirmation unavailable' },
      message: expect.stringContaining('已保存') });
    expect(result.message).toContain(`/schedule enable ${result.scheduleId}`);
    expect(result.message).toContain('相同参数');
    expect(result.message).not.toContain('已发确认卡');
    expect(f.saved.get(result.scheduleId)?.enabled).toBe(false);
    const retry = await f.request(f.group, payload);
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({ pendingConfirmation: true, scheduleId: result.scheduleId, message: expect.stringContaining('已发确认卡') });
    expect(f.saved.size).toBe(1);
    expect(f.sendConfirmation).toHaveBeenCalledTimes(2);
  });

  it('keeps save and delivery-target failures as errors before a schedule exists', async () => {
    const f = await setup();
    f.prepareDelivery.mockRejectedValueOnce(new Error('destination unavailable'));
    const response = await f.request(f.group, { every: 15, prompt: 'x' });
    expect(response.statusCode).toBe(500);
    expect(f.saved.size).toBe(0);
    expect(f.sendConfirmation).not.toHaveBeenCalled();
  });

  it('only accepts the current turn of an active requester and exactly one valid time', async () => {
    const f = await setup();
    expect((await f.request(f.group, { every: 15, prompt: 'x' }, 'stale-turn')).json().error.code).toBe('WORK_ITEM_TURN_EXPIRED');
    for (const payload of [{ prompt: 'x' }, { every: 15, cron: '0 9 * * *', prompt: 'x' }, { every: 0, prompt: 'x' }, { every: 15 }, { cron: 'not a cron', prompt: 'x' }, { at: '2026-02-30T09:00', prompt: 'x' }, { at: '2026-02-28T25:00', prompt: 'x' }]) {
      expect((await f.request(f.group, payload)).statusCode).toBe(400);
    }
    // 定时任务到点执行的那一轮不能再建计划，否则每次到点都会多一个。
    f.automated.add('task_1');
    expect((await f.request(f.group, { every: 15, prompt: 'x' })).json().error.code).toBe('AGENT_REQUEST_AUTOMATED');
    f.automated.clear();
    f.setActive({ taskId: 'task_1' });
    expect((await f.request(f.group, { every: 15, prompt: 'x' })).json().error.code).toBe('AGENT_REQUEST_ACTOR_REQUIRED');
    f.setActive(undefined);
    expect((await f.request(f.group, { every: 15, prompt: 'x' })).statusCode).toBe(403);
    expect(f.requestSchedule).not.toHaveBeenCalled();
    expect(f.sendConfirmation).not.toHaveBeenCalled();
  });

  it('dryRun previews the schedule and card without creating it; bad options name the parameter', async () => {
    const f = await setup();
    const preview = await f.request(f.group, { cron: '0 9 * * *', prompt: '汇总昨天的告警', dryRun: true });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({ dryRun: true, needsConfirmation: true, schedule: { name: '汇总昨天的告警', prompt: '汇总昨天的告警', when: expect.any(String), nextRunAt: expect.any(String) },
      confirmCard: { body: expect.stringContaining('汇总昨天的告警') }, effect: expect.stringContaining('启用') });
    expect(f.requestSchedule).not.toHaveBeenCalled();
    expect(f.prepareDelivery).not.toHaveBeenCalled();
    expect(f.sendConfirmation).not.toHaveBeenCalled();
    const both = await f.request(f.group, { every: 15, cron: '0 9 * * *', prompt: 'x' });
    expect(both.statusCode).toBe(400);
    expect(both.json().error).toMatchObject({ code: 'INVALID_ARGUMENT', params: [{ name: '--every/--cron/--at' }], hint: expect.stringContaining('schedule create --help') });
    expect((await f.request(f.group, { every: 0, prompt: 'x' })).json().error.params).toEqual([{ name: '--every', reason: expect.any(String) }]);
    expect((await f.request(f.group, { cron: 'not a cron', prompt: 'x' })).json().error).toMatchObject({ code: 'SCHEDULE_REQUEST_INVALID', params: [{ name: '--cron' }] });
  });
});

describe('dutydeck agent views and actions', () => {
  it('rejects omitted and stale credentials after task or attempt changes, without borrowing the next actor', async () => {
    const f = await setup();
    const run = vi.fn(async (request: object) => ({ request }));
    const view = vi.fn(async (request: object) => ({ request }));
    f.tools.commands.set('cli_bot', run, view);
    const oldTurn = f.currentTurn();
    expect((await f.agent('GET', 'views/status')).statusCode).toBe(200);
    expect(view).toHaveBeenLastCalledWith({ sessionId: 'ses_group', taskId: 'task_1', actorId: 'ou_alice', view: 'status' });
    f.setActive({ taskId: 'task_2', attemptId: 'attempt_2', actorId: 'ou_bob' });
    for (const turn of ['', oldTurn, 'forged']) {
      expect((await f.agent('POST', 'actions/retry', {}, turn)).json().error.code).toBe('WORK_ITEM_TURN_EXPIRED');
      expect((await f.agent('GET', 'views/status', undefined, turn)).statusCode).toBe(403);
    }
    expect(run).not.toHaveBeenCalled();
    expect(view).toHaveBeenCalledOnce();
    expect((await f.agent('POST', 'actions/retry', {})).statusCode).toBe(200);
    expect(run).toHaveBeenLastCalledWith(expect.objectContaining({ taskId: 'task_2', actorId: 'ou_bob' }));
    const secondTurn = f.currentTurn();
    f.setActive({ taskId: 'task_2', attemptId: 'attempt_3', actorId: 'ou_bob' });
    expect((await f.agent('POST', 'actions/retry', {}, secondTurn)).statusCode).toBe(403);
    expect((await f.agent('POST', 'actions/retry', {})).statusCode).toBe(200);
    f.setActive({ taskId: 'task_2', actorId: 'ou_bob' });
    expect((await f.agent('POST', 'actions/retry', {})).statusCode).toBe(403);
    f.setActive(undefined);
    expect((await f.agent('POST', 'actions/retry', {})).json().error.code).toBe('AGENT_REQUEST_ACTOR_REQUIRED');
    f.setActive({ taskId: 'task_1', attemptId: 'attempt_1', actorId: 'ou_alice' });
    f.automated.add('task_1');
    expect((await f.agent('GET', 'views/queue')).json().error.code).toBe('AGENT_REQUEST_AUTOMATED');
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('actions turn parameters into the same slash command and pass dryRun through; bad parameters are named', async () => {
    const f = await setup();
    const run = vi.fn(async (request: object) => ({ request }));
    f.tools.commands.set('cli_bot', run, vi.fn());
    const created = await f.agent('POST', 'actions/session.new', { agent: 'claude', task: '修复登录页报错', dryRun: true });
    expect(created.statusCode).toBe(200);
    expect(run).toHaveBeenLastCalledWith({ sessionId: 'ses_group', taskId: 'task_1', actorId: 'ou_alice', command: '/new --agent claude -- 修复登录页报错', action: 'session.new', dryRun: true });
    await f.agent('POST', 'actions/access.grant', { members: ['Bob'] });
    expect(run).toHaveBeenLastCalledWith({ sessionId: 'ses_group', taskId: 'task_1', actorId: 'ou_alice', command: '/grant @Bob', action: 'access.grant', dryRun: false, members: ['Bob'] });
    // --member '@' 规范化后为空：dry-run 和真实执行都拒绝，不会变成对全群生效的命令。
    for (const [path, payload] of [['actions/access.grant', { members: ['@'], dryRun: true }], ['actions/access.grant', { members: ['@'] }], ['actions/access.revoke', { members: ['@ '] }]] as const) {
      const empty = await f.agent('POST', path, payload);
      expect(empty.statusCode).toBe(400);
      expect(empty.json().error).toMatchObject({ code: 'INVALID_ARGUMENT', params: [{ name: '--member' }] });
    }
    const bad = await f.agent('POST', 'actions/queue.cancel', { index: 0 });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatchObject({ code: 'INVALID_ARGUMENT', params: [{ name: '<编号>', reason: '从 1 开始' }] });
    expect((await f.agent('POST', 'actions/retry', { dryRun: 'yes' })).json().error.params).toEqual([{ name: '--dry-run', reason: '不带值' }]);
    expect((await f.agent('POST', 'actions/nope', {})).json().error).toMatchObject({ code: 'AGENT_ACTION_UNKNOWN', params: [{ name: '<命令>' }] });
    expect((await f.agent('GET', 'views/nope')).json().error).toMatchObject({ code: 'AGENT_ACTION_UNKNOWN', params: [{ name: '<命令>', reason: expect.stringContaining('status') }] });
    expect((await f.agent('GET', 'views/tasks?page=0')).json().error).toMatchObject({ code: 'INVALID_ARGUMENT', params: [{ name: '--page' }] });
    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe('Agent commands', () => {
  it('forwards the command to the bot that owns the session, as the turn requester', async () => {
    const f = await setup();
    // 机器人的监听没在运行：不能代办。
    expect((await f.command({ command: '/status' })).json().error.code).toBe('AGENT_COMMAND_UNAVAILABLE');
    const handler = vi.fn(async () => ({ executed: true }));
    f.tools.commands.set('cli_bot', handler);
    const response = await f.command({ command: '  /new --agent claude -- 修复登录页报错 ' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ executed: true });
    expect(handler).toHaveBeenCalledWith({ sessionId: 'ses_group', taskId: 'task_1', actorId: 'ou_alice', command: '/new --agent claude -- 修复登录页报错' });
  });

  it('only runs for the current turn of an active requester that no schedule started', async () => {
    const f = await setup();
    const handler = vi.fn(async () => ({ executed: true }));
    f.tools.commands.set('cli_bot', handler);
    expect((await f.command({ command: '/status' }, 'stale-turn')).json().error.code).toBe('WORK_ITEM_TURN_EXPIRED');
    expect((await f.command({ command: '' })).statusCode).toBe(400);
    f.automated.add('task_1');
    expect((await f.command({ command: '/status' })).json().error.code).toBe('AGENT_REQUEST_AUTOMATED');
    f.automated.clear();
    f.setActive({ taskId: 'task_1' });
    expect((await f.command({ command: '/status' })).json().error.code).toBe('AGENT_REQUEST_ACTOR_REQUIRED');
    expect(handler).not.toHaveBeenCalled();
  });
});

it('treats schedule, CI and PR follow-up rounds as automated, and Lark or Web requests as not', () => {
  expect(isAutomatedRequest({ namespace: 'schedule', key: 'occurrence_1' })).toBe(true);
  expect(isAutomatedRequest({ namespace: 'automation', key: 'ci_1' })).toBe(true);
  expect(isAutomatedRequest({ namespace: 'runtime', key: 'ci-webhook:sub_1:fix:1:abc1234' })).toBe(true);
  expect(isAutomatedRequest({ namespace: 'runtime', key: 'pull-request:pr_1:ci:1' })).toBe(true);
  expect(isAutomatedRequest({ namespace: 'lark', key: 'om_1' })).toBe(false);
  expect(isAutomatedRequest({ namespace: 'runtime', key: 'request_1' })).toBe(false);
  expect(isAutomatedRequest(undefined)).toBe(false);
});


it('forwards settings operations using only the active human turn identity', async () => {
  const h = await setup();
  const settings = vi.fn(async () => ({ busyTriage: false }));
  h.tools.commands.set('cli_bot', vi.fn(), undefined, settings);
  expect((await h.agent('GET', 'settings')).statusCode).toBe(200);
  expect(settings).toHaveBeenLastCalledWith({ sessionId: h.group.id, taskId: 'task_1', actorId: 'ou_alice', action: 'show' });
  expect((await h.agent('POST', 'settings', { pairs: ['busyTriage=true'], dryRun: true })).statusCode).toBe(200);
  expect(settings).toHaveBeenLastCalledWith({ sessionId: h.group.id, taskId: 'task_1', actorId: 'ou_alice', action: 'set', pairs: ['busyTriage=true'], dryRun: true });
  const calls = settings.mock.calls.length;
  for (const body of [{ pairs: [] }, { pairs: ['busyTriage=true'], actorId: 'ou_admin' }, { pairs: ['busyTriage=true'], dryRun: 'true' }]) {
    expect((await h.agent('POST', 'settings', body)).statusCode).toBe(400);
  }
  h.automated.add('task_1');
  expect((await h.agent('GET', 'settings')).statusCode).toBe(403);
  expect(settings).toHaveBeenCalledTimes(calls);
});


it('does not accept a client-provided schedule origin or actor', async () => {
  const h = await setup();
  for (const extra of [{ replyMessageId: 'om_forged' }, { actorId: 'ou_admin' }, { origin: { appId: 'cli_bot', chatId: 'oc_other', messageId: 'om_forged' } }]) {
    expect((await h.agent('POST', 'schedules', { prompt: '看 CI', cron: '0 9 * * *', ...extra })).statusCode).toBe(400);
  }
  expect(h.requestSchedule).not.toHaveBeenCalled(); expect(h.prepareDelivery).not.toHaveBeenCalled(); expect(h.sendConfirmation).not.toHaveBeenCalled();
});
