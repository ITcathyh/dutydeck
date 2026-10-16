import Fastify from 'fastify';
import { ZodError } from 'zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import { RuntimeError, type PublicSessionSchedule, type Session } from '@dutydeck/shared';
import { AgentGroupToolError, LarkAgentToolCapabilityRegistry, LarkAgentToolsService } from './lark/agent-tools.js';
import { larkBotsConfigKey } from './lark/config.js';
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
    if (error instanceof AgentGroupToolError) return reply.code(error.statusCode).send(error.response());
    if (error instanceof RuntimeError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
    return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: error.message } });
  });
  await registerAgentRequestTools(app, { runtime: { getActiveTaskContext: () => active }, automatedTask: taskId => automated.has(taskId), tools, automation: { createSchedule }, prepareDelivery, sendConfirmation });
  const request = (target: Session, payload: object, turn = capabilities.workbenchTurnToken(target.id, active?.taskId ?? ''), path = 'schedules') => app.inject({
    method: 'POST', url: `/api/lark/agent-tools/${path}`, payload,
    headers: { authorization: `Bearer ${capabilities.environmentFor(target).dutydeck_group_tools_token}`, 'x-dutydeck-work-turn': turn }
  });
  const command = (payload: object, turn?: string) => request(group, payload, turn, 'commands');
  return { group, p2p, request, command, tools, createSchedule, prepareDelivery, sendConfirmation, saved, automated, setActive: (value: typeof active) => { active = value; } };
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
