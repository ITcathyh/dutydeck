import Fastify from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { createRepositories } from '@dutydeck/storage';
import { RuntimeError, type Session } from '@dutydeck/shared';
import { registerCollaborationRoutes } from './collaboration-routes.js';
import { CollaborationService } from './collaboration-service.js';
import { CollaborationExtensions } from './collaboration-extensions.js';
import { CollaborationEvaluation } from './collaboration-evaluation.js';
import { LarkAgentToolCapabilityRegistry, LarkAgentToolsService } from './lark/agent-tools.js';
import { runCollaboration } from './collaboration-cli.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });
const scope = { appId: 'cli_one', chatId: 'oc_one' };
async function fixture() {
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
    bootstrap: async () => {}, extensions: new CollaborationExtensions({ repository: repos.collaboration, authorize }), evaluation: new CollaborationEvaluation({ repository: repos.collaboration, evaluate: async () => ({ action: 'silent', reason: '', evidenceIds: [] }) }) });
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
