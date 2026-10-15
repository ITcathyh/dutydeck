import Fastify from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import { createRepositories } from '@dutydeck/storage';
import { RuntimeError, type Session } from '@dutydeck/shared';
import { registerCollaborationRoutes, type CollaborationRouteOptions } from './collaboration-routes.js';
import { CollaborationService } from './collaboration-service.js';
import { CollaborationExtensions } from './collaboration-extensions.js';
import { CollaborationEvaluation } from './collaboration-evaluation.js';
import { LarkAgentToolCapabilityRegistry, LarkAgentToolsService } from './lark/agent-tools.js';
import { runCollaboration } from './collaboration-cli.js';
import { LarkGroupParticipation } from './lark/group-participation.js';
import { PluginHost } from './plugins/host.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });
const scope = { appId: 'cli_one', chatId: 'oc_one' };
type Repositories = ReturnType<typeof createRepositories>;
async function fixture(extra: Partial<CollaborationRouteOptions> | ((repos: Repositories, directory: string) => Promise<Partial<CollaborationRouteOptions>>) = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'collaboration-routes-'));
  const repos = createRepositories(join(directory, 'test.db'));
  const now = new Date().toISOString();
  const session: Session = { id: 'session', agentId: 'agent', cwd: directory, source: 'lark', sourceId: 'cli_one:oc_one:group:chat:oc_one', state: 'thinking', runId: 'run', createdAt: now, updatedAt: now };
  await repos.sessions.save(session);
  await repos.config.set('lark.bots', JSON.stringify([{ appId: scope.appId, appSecret: 'synthetic', groupToolsEnabled: true }]));
  const capabilities = new LarkAgentToolCapabilityRegistry(repos.sessions, 'http://localhost');
  const env = capabilities.environmentFor(session);
  const tools = new LarkAgentToolsService(capabilities, repos.config);
  let actorId: string | undefined = 'ou_alice'; let taskId = 'task-one';
  const runtime = { getSession: (id: string) => repos.sessions.get(id), getActiveTaskContext: () => actorId ? { taskId, actorId } : undefined } as any;
  const authorize = async (candidate: typeof scope, actor: string, action: string) => candidate.appId === scope.appId && candidate.chatId === scope.chatId && (actor === 'owner' || actor === 'ou_alice' && action !== 'manage');
  const service = new CollaborationService({ repositories: repos, authorize, resolveScheduleScope: async () => ({ channelBotId: 'bot', identityRef: 'identity', secretRef: 'secret' }) });
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) => reply.code(error instanceof ZodError ? 400 : (error as RuntimeError).statusCode ?? 500).send({ error: { code: (error as RuntimeError).code, message: error.message } }));
  await registerCollaborationRoutes(app, { service, runtime, tools, authorizeManagement: async request => request.headers.authorization === 'Bearer management' ? 'owner' : undefined,
    bootstrap: async () => {}, extensions: new CollaborationExtensions({ repository: repos.collaboration, authorize }), evaluation: new CollaborationEvaluation({ repository: repos.collaboration, evaluate: async () => ({ action: 'silent', reason: '', evidenceIds: [] }) }), ...(typeof extra === 'function' ? await extra(repos, directory) : extra) });
  cleanups.push(async () => { capabilities.close(); await app.close(); repos.close(); await rm(directory, { recursive: true, force: true }); });
  const headers = () => ({ authorization: `Bearer ${env.dutydeck_group_tools_token}`, 'x-dutydeck-work-turn': capabilities.workbenchTurnToken(session.id, taskId) });
  return { repos, app, env, headers, capabilities, changeTask() { taskId = 'task-two'; }, endTask() { actorId = undefined; } };
}
it('binds a mutation to the active actor and turn, scopes stable retries and rejects body identity overrides', async () => {
  const f = await fixture(); const url = '/api/lark/agent-tools/collaboration/followups';
  const payload = { id: 'stable-key', goal: '补齐文档', steps: [{ id: 'one', label: '补例子', status: 'open' }] };
  const send = (body = payload, headers = f.headers()) => f.app.inject({ method: 'POST', url, headers, payload: body });
  const first = await send(); expect(first.statusCode).toBe(200);
  expect(first.json().followup).toMatchObject({ scope, createdBy: 'ou_alice', provenance: 'inferred' });
  expect(first.json().followup.id).not.toBe(payload.id);
  expect((await send()).json().followup.id).toBe(first.json().followup.id);
  expect((await send({ ...payload, goal: 'changed' })).statusCode).toBe(409);
  expect((await send({ ...payload, scope: { appId: 'cli_other', chatId: 'oc_other' } } as any)).statusCode).toBe(400);
  const oldHeaders = f.headers(); f.changeTask();
  expect((await send(payload, oldHeaders)).statusCode).toBe(403);
  expect((await send()).json().followup.id).not.toBe(first.json().followup.id);
  f.endTask(); expect((await send()).statusCode).toBe(403);
});
it('reports hourly decision and reply usage so shadow-mode cost is visible', async () => {
  const f = await fixture(); const url = '/api/lark/groups/cli_one/oc_one/collaboration';
  const headers = { authorization: 'Bearer management' };
  const fresh = (await f.app.inject({ url, headers })).json();
  expect(fresh.usage).toMatchObject({ decisionsLastHour: 0, maxDecisionsPerHour: 60, maxProactivePerHour: 6, decisionWindowComplete: true });
  const record = (id: string, patch: Record<string, unknown> = {}) => f.repos.collaboration.recordDecision({
    id, scope, contextRevision: 0, policyVersion: 'v1', action: 'silent', reason: '', evidenceIds: [],
    status: 'suppressed', inputSnapshot: {}, createdAt: new Date().toISOString(), ...patch });
  await record('decision_real');
  await record('decision_gated', { inputSnapshot: { gate: 'decision_budget' } });
  // 真实判定计入用量，被闸门挡下的记录不计入，否则超限后用量永远降不回来。
  expect((await f.app.inject({ url, headers })).json().usage.decisionsLastHour).toBe(1);
});
it('validates management auth, scoped paths and optimistic revisions through HTTP', async () => {
  const f = await fixture(); const url = '/api/lark/groups/cli_one/oc_one/collaboration';
  expect((await f.app.inject({ url })).statusCode).toBe(403);
  const headers = { authorization: 'Bearer management' };
  expect((await f.app.inject({ url, headers })).statusCode).toBe(200);
  expect((await f.app.inject({ url: url.replace('oc_one', 'oc_foreign'), headers })).statusCode).toBe(403);
  const created = await f.app.inject({ method: 'POST', url: `${url}/followups`, headers, payload: { id: 'manual', goal: '准备资料' } });
  expect(created.json().followup.provenance).toBe('confirmed');
  const update = (revision: number) => f.app.inject({ method: 'PATCH', url: `${url}/followups/manual`, headers, payload: { expectedRevision: revision, progress: '已完成一半' } });
  expect((await update(1)).statusCode).toBe(200); expect((await update(1)).statusCode).toBe(409);
  const cleared = await f.app.inject({ method: 'PATCH', url: `${url}/followups/manual`, headers, payload: { expectedRevision: 2, progress: '' } });
  expect(cleared.statusCode).toBe(200); expect(cleared.json().followup.progress).toBe('');
  const denied = await f.app.inject({ method: 'PATCH', url: '/api/lark/agent-tools/collaboration/settings', headers: f.headers(), payload: { expectedRevision: 0, participation: 'selective' } });
  expect(denied.statusCode).toBe(403);
});
it('group duty: overview shows it, management PATCH validates the body and needs a wired handler', async () => {
  const url = '/api/lark/groups/cli_one/oc_one/collaboration';
  const headers = { authorization: 'Bearer management' };
  const unwired = await fixture();
  expect((await unwired.app.inject({ url, headers })).json().duty).toMatchObject({ scope, revision: 0 });
  expect((await unwired.app.inject({ method: 'PATCH', url: `${url}/duty`, headers, payload: { expectedRevision: 0, responder: 'self' } })).statusCode).toBe(503);
  const calls: unknown[][] = [];
  const f = await fixture({ updateDuty: async (...args) => { calls.push(args); return { duty: { revision: 1 } }; } });
  const patch = (payload: unknown, withAuth = true) => f.app.inject({ method: 'PATCH', url: `${url}/duty`, ...(withAuth ? { headers } : {}), payload: payload as object });
  expect((await patch({ expectedRevision: 0, responder: 'self' }, false)).statusCode).toBe(403);
  expect((await patch({ expectedRevision: 0, responder: 'cli_other' })).statusCode).toBe(400);
  const alarm = { enabled: true, params: { sources: [{ appId: 'cli_source_a' }], levels: ['P0'], dedupeHours: 6, maxPerHour: 3 } };
  // 确认人和包版本只能由群里的确认卡写入。
  expect((await patch({ expectedRevision: 0, scenarios: { alarm: { ...alarm, requesterId: 'ou_bob' } } })).statusCode).toBe(400);
  expect((await patch({ expectedRevision: 0, scenarios: { alarm: { ...alarm, packVersion: '1.0.0' } } })).statusCode).toBe(400);
  expect(calls).toEqual([]);
  const saved = await patch({ expectedRevision: 0, responder: null, scenarios: { alarm } });
  expect(saved.statusCode).toBe(200); expect(saved.json()).toEqual({ duty: { revision: 1 } });
  expect(calls).toEqual([[scope, { expectedRevision: 0, responder: null, scenarios: { alarm } }, 'owner']]);
});
it('group duty: scenario bindings are checked against the loaded packs; confirmer and pack version stay as confirmed in the group', async () => {
  const url = '/api/lark/groups/cli_one/oc_one/collaboration';
  const headers = { authorization: 'Bearer management' };
  let participation!: LarkGroupParticipation;
  const f = await fixture(async (repos, directory) => {
    const host = await PluginHost.load({ dataDir: directory });
    participation = new LarkGroupParticipation({ repository: repos.collaboration, decider: {} as any, authorize: async () => true, serviceFor: () => ({}) as any,
      readConfig: async appId => appId === scope.appId ? { appId, appSecret: 'synthetic' } as any : undefined, scenarios: host.scenarios });
    cleanups.push(() => participation.close());
    return { updateDuty: (target, patch, actorId) => participation.updateDuty(target, patch, actorId), scenarios: target => participation.scenarioOverview(target) };
  });
  const overview = async () => (await f.app.inject({ url, headers })).json();
  const patch = async (payload: unknown) => {
    const response = await f.app.inject({ method: 'PATCH', url: `${url}/duty`, headers, payload: payload as object });
    return { status: response.statusCode, code: response.json().error?.code, body: response.json() };
  };
  const alarmPack = (await overview()).scenarios.find((item: { id: string }) => item.id === 'alarm');
  expect(alarmPack).toMatchObject({ version: '1.1.0', mode: 'direct', builtin: true, requiresRequester: true, versionStale: false, enableHint: expect.any(String),
    params: { sources: { type: 'bot_list', role: 'source' }, levels: { type: 'string_list', default: [] }, dedupeHours: { type: 'integer', min: 1, max: 168, default: 6 }, maxPerHour: { type: 'integer', min: 1, max: 30, default: 3 } } });
  expect(alarmPack).not.toHaveProperty('binding');

  const sources = [{ appId: 'cli_source_a', name: '来源 A' }];
  expect(await patch({ expectedRevision: 0, scenarios: { alarm: { enabled: false, params: { sources }, requesterId: 'ou_tester' } } })).toMatchObject({ status: 400, code: 'COLLABORATION_INVALID_INPUT' });
  expect(await patch({ expectedRevision: 0, scenarios: { alarm: { enabled: false, params: { sources }, packVersion: '1.0.0' } } })).toMatchObject({ status: 400, code: 'COLLABORATION_INVALID_INPUT' });
  expect(await patch({ expectedRevision: 0, scenarios: { 'no-such-pack': { enabled: false } } })).toMatchObject({ status: 400, code: 'COLLABORATION_SCENARIO_UNKNOWN' });
  expect(await patch({ expectedRevision: 0, scenarios: { alarm: { enabled: false, params: { dedupeHours: 200 } } } })).toMatchObject({ status: 400, code: 'COLLABORATION_SCENARIO_INVALID' });
  expect(await patch({ expectedRevision: 0, scenarios: { alarm: { enabled: false, params: { severity: ['P0'] } } } })).toMatchObject({ status: 400, code: 'COLLABORATION_SCENARIO_INVALID' });
  expect(await patch({ expectedRevision: 0, scenarios: { alarm: { enabled: false, params: { sources: [{ appId: scope.appId }] } } } })).toMatchObject({ status: 400, code: 'COLLABORATION_SCENARIO_SELF_SOURCE' });
  // 从没在群里确认过的 direct 包不能在 Web 上开启，但可以先存成关闭的。
  expect(await patch({ expectedRevision: 0, scenarios: { alarm: { enabled: true, params: { sources } } } })).toMatchObject({ status: 409, code: 'COLLABORATION_SCENARIO_REQUESTER_REQUIRED' });
  expect((await overview()).duty.revision).toBe(0);
  const off = await patch({ expectedRevision: 0, scenarios: { alarm: { enabled: false, params: { sources } } } });
  expect(off.status).toBe(200);
  expect(off.body.duty.scenarios).toEqual({ alarm: { enabled: false, params: { sources, levels: [], dedupeHours: 6, maxPerHour: 3 }, packVersion: '1.1.0' } });

  // 群里确认过（确认卡写入确认人和包版本）后，Web 只给改动的参数，其余沿用。
  await f.repos.collaboration.updateDuty(scope, { expectedRevision: 1, scenarios: { alarm: { ...off.body.duty.scenarios.alarm, enabled: true, requesterId: 'ou_tester' } } }, 'ou_tester');
  const levels = await patch({ expectedRevision: 2, scenarios: { alarm: { enabled: true, params: { levels: ['P1'] } } } });
  expect(levels.status).toBe(200);
  expect(levels.body.duty.scenarios.alarm).toEqual({ enabled: true, params: { sources, levels: ['P1'], dedupeHours: 6, maxPerHour: 3 }, requesterId: 'ou_tester', packVersion: '1.1.0' });
  expect(await patch({ expectedRevision: 2, scenarios: { alarm: { enabled: true } } })).toMatchObject({ status: 409, code: 'COLLABORATION_REVISION_CONFLICT' });
  expect((await overview()).scenarios.find((item: { id: string }) => item.id === 'alarm')).toMatchObject({ binding: levels.body.duty.scenarios.alarm, webDescription: expect.stringContaining('ou_tester') });

  // 绑定的大版本落后于包：显示过期，开启被拒，关闭可以。
  await f.repos.collaboration.updateDuty(scope, { expectedRevision: 3, scenarios: { alarm: { ...levels.body.duty.scenarios.alarm, packVersion: '0.9.0' } } }, 'ou_tester');
  expect((await overview()).scenarios.find((item: { id: string }) => item.id === 'alarm')).toMatchObject({ versionStale: true });
  expect(await patch({ expectedRevision: 4, scenarios: { alarm: { enabled: true, params: { maxPerHour: 5 } } } })).toMatchObject({ status: 409, code: 'COLLABORATION_SCENARIO_VERSION_STALE' });
  const disabled = await patch({ expectedRevision: 4, scenarios: { alarm: { enabled: false } } });
  expect(disabled.body.duty.scenarios.alarm).toMatchObject({ enabled: false, requesterId: 'ou_tester', packVersion: '0.9.0' });

  // null 删掉这个包的绑定。
  expect((await patch({ expectedRevision: 5, scenarios: { alarm: null } })).status).toBe(200);
  const after = await overview();
  expect(after.duty.scenarios?.alarm).toBeUndefined();
  expect(after.scenarios.find((item: { id: string }) => item.id === 'alarm')).not.toHaveProperty('binding');
});
it('sends CLI requests with the active turn and stable create id through the real route', async () => {
  const f = await fixture();
  const fetcher: typeof fetch = async (input, init) => {
    const response = await f.app.inject({ method: init?.method as any, url: new URL(String(input)).pathname, headers: Object.fromEntries(new Headers(init?.headers).entries()), payload: init?.body as string });
    return new Response(response.body, { status: response.statusCode });
  };
  const options = { env: f.env, fetcher, turn: f.headers()['x-dutydeck-work-turn'], json: JSON.stringify({ id: 'cli-request', goal: '整理资料' }) };
  const first = await runCollaboration('followup-create', undefined, options);
  expect(first).toMatchObject({ followup: { goal: '整理资料', createdBy: 'ou_alice' } });
  expect(await runCollaboration('followup-create', undefined, options)).toEqual(first);
  await expect(runCollaboration('followup-create', undefined, { ...options, json: '{"goal":"missing id"}' })).rejects.toThrow('稳定 id');
  await expect(runCollaboration('followup-create', undefined, { ...options, turn: 'stale' })).rejects.toMatchObject({ statusCode: 403 });
});

it('routes agent mandate creation to the confirmation card instead of creating it, while the management route still creates immediately', async () => {
  const confirmMandate = vi.fn(async () => ({ pendingConfirmation: true, message: '已发确认卡，等用户确认后生效。' }));
  const f = await fixture({ confirmMandate });
  const body = { id: 'daily', goal: '每天总结', mode: 'agent', prompt: '总结', trigger: { kind: 'cron', expression: '0 18 * * 1-5' }, timezone: 'Asia/Shanghai' };
  const response = await f.app.inject({ method: 'POST', url: '/api/lark/agent-tools/collaboration/mandates', headers: f.headers(), payload: body });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ pendingConfirmation: true, message: expect.stringContaining('已发确认卡') });
  expect(confirmMandate).toHaveBeenCalledWith(scope, 'ou_alice', expect.objectContaining({ goal: '每天总结', id: expect.not.stringMatching(/^daily$/) }), {});
  expect(await f.repos.collaboration.listMandates(scope)).toEqual([]);
  // Web 管理端是用户自己在页面操作，不走确认卡；这里只验证没有被拦到确认流程。
  await f.app.inject({ method: 'POST', url: '/api/lark/groups/cli_one/oc_one/collaboration/mandates', headers: { authorization: 'Bearer management' }, payload: body });
  expect(confirmMandate).toHaveBeenCalledOnce();
});
