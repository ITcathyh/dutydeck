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
  let active: { taskId: string; actorId?: string } | undefined = { taskId: 'task_1', actorId: 'ou_alice' };
  const automated = new Set<string>();
  const saved = new Map<string, PublicSessionSchedule>();
  const createSchedule = vi.fn<AgentRequestToolsOptions['automation']['createSchedule']>(async (sessionId, input, actorId, receipt) => {
    const id = `schedule_${receipt!.key}`;
    if (!saved.has(id)) {
      await receipt!.prepareDelivery!(id);
      saved.set(id, { schemaVersion: 1, id, revision: 1, generation: 1, sessionId, name: input.name, prompt: input.prompt, trigger: input.trigger, timezone: input.timezone,
        dstPolicy: input.dstPolicy, condition: { kind: 'always' }, enabled: false, createdAt: '', updatedAt: '' } as PublicSessionSchedule);
    }
    expect(actorId).toBe('ou_alice');
    return saved.get(id)!;
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
  await registerAgentRequestTools(app, { runtime: { getActiveTaskContext: () => active }, automatedTask: taskId => automated.has(taskId), tools, automation: { createSchedule }, prepareDelivery, sendConfirmation });
  const request = (target: Session, payload: object, turn = capabilities.workbenchTurnToken(target.id, active?.taskId ?? ''), path = 'schedules') => app.inject({
    method: 'POST', url: `/api/lark/agent-tools/${path}`, payload,
    headers: { authorization: `Bearer ${capabilities.environmentFor(target).dutydeck_group_tools_token}`, 'x-dutydeck-work-turn': turn }
  });
  const command = (payload: object, turn?: string) => request(group, payload, turn, 'commands');
  // dutydeck agent 默认不带 --turn：不发 x-dutydeck-work-turn。
  const agent = (method: 'GET' | 'POST', path: string, payload?: object, turn?: string) => app.inject({
    method, url: `/api/lark/agent-tools/${path}`, ...(payload ? { payload } : {}),
    headers: { authorization: `Bearer ${capabilities.environmentFor(group).dutydeck_group_tools_token}`, ...(turn ? { 'x-dutydeck-work-turn': turn } : {}) }
  });
  const currentTurn = () => capabilities.workbenchTurnToken(group.id, active?.taskId ?? '');
  return { group, p2p, request, command, agent, currentTurn, tools, createSchedule, prepareDelivery, sendConfirmation, saved, automated, setActive: (value: typeof active) => { active = value; } };
}

describe('Agent schedule requests', () => {
  it('creates a disabled schedule for the turn requester, posts one confirmation card, and returns the same schedule on retry', async () => {
    const f = await setup();
    const first = await f.request(f.group, { every: 15, prompt: '看看这个话题有没有排查结论', name: '盯结论' });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ pendingConfirmation: true, scheduleId: expect.stringMatching(/^schedule_agent-request:/) });
    const input = f.createSchedule.mock.calls[0]![1];
    expect(input).toMatchObject({ name: '盯结论', prompt: '看看这个话题有没有排查结论', trigger: { kind: 'interval', everySeconds: 900 }, timezone: 'Asia/Shanghai', condition: { kind: 'always' } });
    expect(f.prepareDelivery).toHaveBeenCalledWith('ses_group', 'task_1', first.json().scheduleId);
    expect(f.sendConfirmation).toHaveBeenCalledTimes(1);
    expect(f.sendConfirmation.mock.calls[0]![0]).toMatchObject({ id: first.json().scheduleId, enabled: false });

    const retry = await f.request(f.group, { every: 15, prompt: '看看这个话题有没有排查结论', name: '盯结论' });
    expect(retry.json().scheduleId).toBe(first.json().scheduleId);
    expect(f.saved.size).toBe(1);
    const other = await f.request(f.group, { cron: '0 9 * * *', prompt: '汇总昨天的告警' });
    expect(other.json().scheduleId).not.toBe(first.json().scheduleId);
    expect(f.createSchedule.mock.calls[2]![1]).toMatchObject({ name: '汇总昨天的告警', trigger: { kind: 'cron', expression: '0 9 * * *' } });

    // 用户已经点过「启用」：不再发确认卡。
    f.saved.get(first.json().scheduleId)!.enabled = true;
    f.sendConfirmation.mockClear();
    expect((await f.request(f.group, { every: 15, prompt: '看看这个话题有没有排查结论', name: '盯结论' })).json()).toMatchObject({ pendingConfirmation: false });
    expect(f.sendConfirmation).not.toHaveBeenCalled();
  });

  it('works in p2p chats and for one-off times', async () => {
    const f = await setup();
    const response = await f.request(f.p2p, { at: '2026-10-17T10:00', prompt: '提醒我看发布结果' });
    expect(response.statusCode).toBe(200);
    expect(f.createSchedule.mock.calls[0]![0]).toBe('ses_p2p');
    expect(f.createSchedule.mock.calls[0]![1].trigger).toEqual({ kind: 'at', localDateTime: '2026-10-17T10:00' });
  });

  it('only accepts the current turn of an active requester and exactly one valid time', async () => {
    const f = await setup();
    expect((await f.request(f.group, { every: 15, prompt: 'x' }, 'stale-turn')).json().error.code).toBe('WORK_ITEM_TURN_EXPIRED');
    for (const payload of [{ prompt: 'x' }, { every: 15, cron: '0 9 * * *', prompt: 'x' }, { every: 0, prompt: 'x' }, { every: 15 }, { cron: 'not a cron', prompt: 'x' }]) {
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
    expect(f.createSchedule).not.toHaveBeenCalled();
    expect(f.sendConfirmation).not.toHaveBeenCalled();
  });

  it('dryRun previews the schedule and card without creating it; bad options name the parameter', async () => {
    const f = await setup();
    const preview = await f.request(f.group, { cron: '0 9 * * *', prompt: '汇总昨天的告警', dryRun: true });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({ dryRun: true, needsConfirmation: true, schedule: { name: '汇总昨天的告警', prompt: '汇总昨天的告警', when: expect.any(String), nextRunAt: expect.any(String) },
      confirmCard: { body: expect.stringContaining('汇总昨天的告警') }, effect: expect.stringContaining('启用') });
    expect(f.createSchedule).not.toHaveBeenCalled();
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
  it('without --turn use the running turn; a wrong --turn or no running turn is refused as before', async () => {
    const f = await setup();
    const run = vi.fn(async (request: object) => ({ request }));
    const view = vi.fn(async (request: object) => ({ request }));
    f.tools.commands.set('cli_bot', run, view);
    const status = await f.agent('GET', 'views/status');
    expect(status.statusCode).toBe(200);
    expect(view).toHaveBeenLastCalledWith({ sessionId: 'ses_group', taskId: 'task_1', actorId: 'ou_alice', view: 'status' });
    expect((await f.agent('GET', 'views/tasks?page=2', undefined, f.currentTurn())).statusCode).toBe(200);
    expect(view).toHaveBeenLastCalledWith({ sessionId: 'ses_group', taskId: 'task_1', actorId: 'ou_alice', view: 'tasks', page: 2 });
    expect((await f.agent('GET', 'views/status', undefined, 'stale-turn')).json().error.code).toBe('WORK_ITEM_TURN_EXPIRED');
    expect((await f.agent('POST', 'actions/retry', {}, 'stale-turn')).json().error.code).toBe('WORK_ITEM_TURN_EXPIRED');
    f.setActive(undefined);
    expect((await f.agent('GET', 'views/status')).json().error.code).toBe('AGENT_REQUEST_ACTOR_REQUIRED');
    expect((await f.agent('POST', 'actions/retry', {})).json().error.code).toBe('AGENT_REQUEST_ACTOR_REQUIRED');
    f.setActive({ taskId: 'task_1', actorId: 'ou_alice' });
    f.automated.add('task_1');
    expect((await f.agent('GET', 'views/queue')).json().error.code).toBe('AGENT_REQUEST_AUTOMATED');
    expect(view).toHaveBeenCalledTimes(2);
    expect(run).not.toHaveBeenCalled();
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
