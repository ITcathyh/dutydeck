import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { get as httpGet, type IncomingMessage } from 'node:http';
import { buildApp } from './app.js';
import { createRepositories } from '@dutydeck/storage';
import { larkBotsConfigKey } from './lark/config.js';
import { LoginLinkStore, signSessionShareToken } from './auth/auth.js';
import { RuntimeError } from '@dutydeck/shared';

const apps: any[] = [];
const tempDirectories: string[] = [];
const repositories: Array<ReturnType<typeof createRepositories>> = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close()));
  for (const repository of repositories.splice(0)) repository.close();
  await Promise.all(tempDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('HTTP API boundary', () => {
  it('reports observed driver support without claiming recovery or attaching a process', async () => {
    const driver = { createTerminalStream: vi.fn(), recover: vi.fn() };
    const runtime = { getSession: vi.fn(async () => ({ id: 's1', protocol: 'pty-cli' })), getDriver: vi.fn(() => driver), getTerminalDriver: vi.fn() } as any;
    const app = await buildApp(runtime); apps.push(app);
    const response = await app.inject({ method: 'GET', url: '/api/sessions/s1/capabilities' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ terminal: 'available', structuredApproval: 'unavailable', turnRecovery: 'unverified' });
    expect(runtime.getTerminalDriver).not.toHaveBeenCalled();
    expect(driver.createTerminalStream).not.toHaveBeenCalled();
    runtime.getDriver.mockReturnValue(undefined);
    expect((await app.inject({ method: 'GET', url: '/api/sessions/s1/capabilities' })).json()).toMatchObject({ terminal: 'unverified', structuredApproval: 'unverified' });
    const denied = await buildApp(runtime, { executionPolicy: { authorize: async () => ({ allowed: false, action: 'task.view_result', code: 'forbidden', reason: 'denied', source: 'integration' }) } }); apps.push(denied);
    runtime.getDriver.mockClear();
    expect((await denied.inject({ method: 'GET', url: '/api/sessions/s1/capabilities' })).statusCode).toBe(403);
    expect(runtime.getDriver).not.toHaveBeenCalled();
  });

  it('checks the session execution adapter before invoking runtime mutations', async () => {
    const runtime = { dispatch: vi.fn() } as any;
    const authorize = vi.fn(async (_request: any, _sessionId: string, _boundary: any, action: any) => ({
      allowed: false, action, code: 'channel_bot_disabled', reason: 'staged GroupBinding runtime is blocked', source: 'integration' as const
    }));
    const app = await buildApp(runtime, { executionPolicy: { authorize } }); apps.push(app);

    const response = await app.inject({ method: 'POST', url: '/api/sessions/ses_managed/send', payload: { prompt: 'must not execute' } });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'channel_bot_disabled' } });
    expect(authorize).toHaveBeenCalledWith(expect.any(Object), 'ses_managed', 'session', 'turn.append');
    expect(runtime.dispatch).not.toHaveBeenCalled();
  });

  it('returns /api/agents through an allowlist without launch secrets or PII', async () => {
    const privateAgent = {
      id: 'private-agent',
      name: 'Safe display name',
      command: 'private-command-canary',
      args: ['private-arg-canary'],
      protocol: 'acp',
      model: 'model-a',
      reasoningEffort: 'private-reasoning-canary',
      version: '1.2.3',
      cwd: '/private/alice@example.com',
      env: { PRIVATE_TOKEN: 'private-env-canary' },
      systemPrompt: 'private-system-canary for alice@example.com',
      permissionMode: 'ask',
      timeout: 600,
      capabilities: { pause: false, resume: true },
      builtin: true
    };
    const app = await buildApp({ listAgents: vi.fn(async () => [privateAgent]) } as any); apps.push(app);

    const response = await app.inject({ method: 'GET', url: '/api/agents' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([{
      id: 'private-agent',
      name: 'Safe display name',
      version: '1.2.3',
      model: 'model-a',
      protocol: 'acp',
      permissionMode: 'ask'
    }]);
    for (const canary of ['private-command-canary', 'private-arg-canary', 'private-reasoning-canary', '/private/', 'alice@example.com', 'PRIVATE_TOKEN', 'private-env-canary', 'private-system-canary']) {
      expect(response.body).not.toContain(canary);
    }
    for (const privateField of ['command', 'args', 'cwd', 'env', 'systemPrompt', 'reasoningEffort', 'timeout', 'capabilities', 'builtin']) {
      expect(response.json()[0]).not.toHaveProperty(privateField);
    }
  });

  it('mounts optional Lark status, send, and update routes', async () => {
    const lark: any = { send: vi.fn(async () => ({ messageId: 'om_sent', chatId: 'oc_chat' })), update: vi.fn(async () => ({ messageId: 'om_sent' })) };
    const app = await buildApp({} as any, { lark: { env: { LARK_APP_ID: 'cli_test', LARK_APP_SECRET: 'secret_test', LARK_AGENT_NAME: 'My Agent' }, service: lark } }); apps.push(app);
    expect((await app.inject({ method: 'GET', url: '/api/lark/status' })).json()).toMatchObject({ configured: true, listening: false, defaultAgentName: 'My Agent' });
    expect((await app.inject({ method: 'POST', url: '/api/lark/send', payload: { receiveId: 'user@example.com', markdown: 'done' } })).json()).toEqual({ messageId: 'om_sent', chatId: 'oc_chat' });
    expect((await app.inject({ method: 'POST', url: '/api/lark/update', payload: { messageId: 'om_sent', markdown: 'updated' } })).json()).toEqual({ messageId: 'om_sent' });
    expect(lark.send).toHaveBeenCalledWith(expect.objectContaining({ markdown: 'done' }));
    expect(lark.update).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'om_sent', markdown: 'updated' }));
  });

  it('starts and polls a secret-free Lark Open Platform configuration job', async () => {
    const completed = {
      id: 'job-test', appId: 'cli_auto', status: 'completed',
      createdAt: '2026-08-30T00:00:00.000Z', updatedAt: '2026-08-30T00:00:01.000Z',
      accountName: '测试账号', tenantName: '测试企业',
      result: { status: 'ready', scopeCount: 16, eventCount: 1, callbackCount: 1, versionId: 'version-test' }
    } as const;
    const jobs = {
      start: vi.fn(() => ({ ...completed, status: 'preparing' as const, result: undefined })),
      get: vi.fn((id: string) => id === completed.id ? completed : undefined)
    };
    const app = await buildApp({} as any, { lark: { env: {}, openPlatformJobs: jobs } }); apps.push(app);

    const invalid = await app.inject({ method: 'POST', url: '/api/lark/open-platform/configure', payload: {} });
    expect(invalid.statusCode).toBe(400);
    const invalidPath = await app.inject({ method: 'POST', url: '/api/lark/open-platform/configure', payload: { appId: 'cli_test/versions?draft=1' } });
    expect(invalidPath.statusCode).toBe(400);
    expect(invalidPath.json().error.code).toBe('INVALID_LARK_APP_ID');
    expect(jobs.start).not.toHaveBeenCalled();
    const started = await app.inject({ method: 'POST', url: '/api/lark/open-platform/configure', payload: { appId: ' cli_auto ', forceLogin: true } });
    expect(started.statusCode).toBe(202);
    expect(started.headers['cache-control']).toBe('no-store');
    expect(started.json()).toMatchObject({ id: 'job-test', appId: 'cli_auto', status: 'preparing' });
    expect(jobs.start).toHaveBeenCalledWith('cli_auto', { forceLogin: true });
    const polled = await app.inject({ method: 'GET', url: '/api/lark/open-platform/jobs/job-test' });
    expect(polled.headers['cache-control']).toBe('no-store');
    expect(polled.json()).toEqual(completed);
    expect(polled.body).not.toMatch(/secret|cookie|csrf|token/i);
    expect((await app.inject({ method: 'GET', url: '/api/lark/open-platform/jobs/missing' })).statusCode).toBe(404);
  });

  it('keeps Dutydeck available when Lark is not configured', async () => {
    const app = await buildApp({} as any, { lark: { env: {} } }); apps.push(app);
    expect((await app.inject({ method: 'GET', url: '/api/lark/status' })).json()).toMatchObject({ configured: false, missing: ['LARK_APP_ID', 'LARK_APP_SECRET'] });
    const response = await app.inject({ method: 'POST', url: '/api/lark/send', payload: { receiveId: 'user@example.com', markdown: 'done' } });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('LARK_NOT_CONFIGURED');
  });

  it('serves workspace cleanup preview and executes cleanup with valid fingerprint', async () => {
    const runtime = {
      getWorkspaceCleanupPreview: vi.fn(async (id: string) => ({ sessionId: id, canClean: true, fingerprint: 'fp_123' })),
      cleanWorkspace: vi.fn(async (id: string, fp: string) => ({ sessionId: id, cleaned: true, fingerprint: fp }))
    } as any;
    const app = await buildApp(runtime); apps.push(app);

    const preview = await app.inject({ method: 'GET', url: '/api/sessions/s1/workspace/cleanup' });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({ sessionId: 's1', canClean: true, fingerprint: 'fp_123' });
    expect(runtime.getWorkspaceCleanupPreview).toHaveBeenCalledWith('s1');

    const invalid = await app.inject({ method: 'POST', url: '/api/sessions/s1/workspace/cleanup', payload: {} });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe('INVALID_FINGERPRINT');

    const cleaned = await app.inject({ method: 'POST', url: '/api/sessions/s1/workspace/cleanup', payload: { fingerprint: 'fp_123' } });
    expect(cleaned.statusCode).toBe(200);
    expect(cleaned.json()).toMatchObject({ sessionId: 's1', cleaned: true, fingerprint: 'fp_123' });
    expect(runtime.cleanWorkspace).toHaveBeenCalledWith('s1', 'fp_123');
  });

  it('selects the requested persisted bot for service card calls', async () => {
    const repos = createRepositories(':memory:'); repositories.push(repos);
    await repos.config.set(larkBotsConfigKey, JSON.stringify([
      { appId: 'cli_one', appSecret: 'secret_one', defaultAgentId: 'codex', listening: false, pushIntervalMs: 1000, hideTraceOnComplete: false },
      { appId: 'cli_two', appSecret: 'secret_two', defaultAgentId: 'codex', listening: false, pushIntervalMs: 1000, hideTraceOnComplete: false }
    ]));
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, tenant_access_token: 'token_two', expire: 7200 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: { message_id: 'om_two', chat_id: 'oc_group' } }), { status: 200 }));
    const app = await buildApp({} as any, { lark: { env: {}, config: repos.config, fetcher: fetcher as typeof fetch } }); apps.push(app);
    expect((await app.inject({ method: 'POST', url: '/api/lark/send', payload: { botAppId: 'cli_two', chatId: 'oc_group', markdown: 'hello', state: 'completed' } })).json()).toMatchObject({ messageId: 'om_two' });
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({ app_id: 'cli_two', app_secret: 'secret_two' });
    const missing = await app.inject({ method: 'POST', url: '/api/lark/send', payload: { botAppId: 'cli_missing', chatId: 'oc_group', markdown: 'hello' } });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('LARK_BOT_NOT_FOUND');
  });

  it('exposes the real macOS directory picker through a guarded system API', async () => {
    const selectDirectory = vi.fn(async () => '/Users/test/project');
    const selectFile = vi.fn(async () => '/Users/test/project/App.tsx');
    const discoverSkills = vi.fn(async () => [{ name: 'review', description: 'Review code', path: '/Users/test/.codex/skills/review/SKILL.md', source: 'user' as const }]);
    const app = await buildApp({} as any, { system: { platform: 'darwin', selectDirectory, selectFile, discoverSkills } }); apps.push(app);
    expect((await app.inject({ method: 'GET', url: '/api/system/capabilities' })).json()).toEqual({ platform: 'darwin', directoryPicker: true, filePicker: true });
    expect((await app.inject({ method: 'POST', url: '/api/system/select-directory' })).json()).toEqual({ path: '/Users/test/project' });
    expect((await app.inject({ method: 'POST', url: '/api/system/select-file' })).json()).toEqual({ path: '/Users/test/project/App.tsx' });
    expect((await app.inject({ method: 'GET', url: '/api/system/skills?cwd=%2Frepo' })).json()).toEqual([{ name: 'review', description: 'Review code', path: '/Users/test/.codex/skills/review/SKILL.md', source: 'user' }]);
    expect(selectDirectory).toHaveBeenCalledOnce();
    expect(selectFile).toHaveBeenCalledOnce();
    expect(discoverSkills).toHaveBeenCalledWith('/repo');
  });

  it('routes lifecycle actions exclusively through Runtime', async () => {
    const session = { id: 's1', agentId: 'mock', state: 'idle', cwd: '/tmp', permissionMode: 'full-trust', runId: 'r1', createdAt: '', updatedAt: '' };
    const task = { id: 't1', sessionId: 's1', prompt: 'hello', status: 'queued', createdAt: '', updatedAt: '' };
    const runtime: any = { listAgents: vi.fn(async () => []), listSessions: vi.fn(async () => [session]), start: vi.fn(async () => session), getSession: vi.fn(async () => session), getEvents: vi.fn(async () => []), subscribe: vi.fn(() => () => {}), dispatch: vi.fn(async () => task), setModel: vi.fn(async () => ({ ...session, model: 'model-b' })), setReasoningEffort: vi.fn(async () => ({ ...session, reasoningEffort: 'high' })), cancelQueued: vi.fn(async () => ({ ...task, status: 'cancelled' })), steerQueued: vi.fn(async () => task), interrupt: vi.fn(async () => {}), pause: vi.fn(async () => {}), resume: vi.fn(async () => {}), stop: vi.fn(async () => {}), restart: vi.fn(async () => session), archive: vi.fn(async () => ({ ...session, archivedAt: 'now' })), resolvePermission: vi.fn() };
    const app = await buildApp(runtime); apps.push(app);
    const invalidPermission = await app.inject({ method: 'POST', url: '/api/sessions', payload: { agentId: 'mock', permissionMode: 'sudo-everything' } });
    expect(invalidPermission.statusCode).toBe(400);
    expect(invalidPermission.json().error).toMatchObject({ code: 'INVALID_PERMISSION_MODE' });
    expect(runtime.start).not.toHaveBeenCalled();
    expect((await app.inject({ method: 'POST', url: '/api/sessions', payload: { agentId: 'mock', model: 'model-selected-in-web', reasoningEffort: 'high' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/sessions/s1/send', payload: { prompt: 'hello' } })).statusCode).toBe(202);
    expect((await app.inject({ method: 'PATCH', url: '/api/sessions/s1/config', payload: { model: 'model-b' } })).json()).toMatchObject({ model: 'model-b' });
    expect((await app.inject({ method: 'PATCH', url: '/api/sessions/s1/config', payload: { reasoningEffort: 'high' } })).json()).toMatchObject({ reasoningEffort: 'high' });
    expect((await app.inject({ method: 'DELETE', url: '/api/sessions/s1/queue/t1' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/sessions/s1/queue/t1/steer' })).statusCode).toBe(200);
    for (const action of ['interrupt', 'pause', 'resume', 'stop', 'restart']) expect((await app.inject({ method: 'POST', url: `/api/sessions/s1/${action}` })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/sessions/s1/archive' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'PUT', url: '/api/sessions/s1/permission-mode', payload: { mode: 'ask' } })).statusCode).toBe(404);
    expect(runtime.start).toHaveBeenCalledWith({ agentId: 'mock', model: 'model-selected-in-web', reasoningEffort: 'high' }); expect(runtime.dispatch).toHaveBeenCalledWith('s1', 'hello', 'queue', 'hello', undefined, undefined, undefined, undefined); expect(runtime.setModel).toHaveBeenCalledWith('s1', 'model-b'); expect(runtime.setReasoningEffort).toHaveBeenCalledWith('s1', 'high'); expect(runtime.cancelQueued).toHaveBeenCalledWith('s1', 't1'); expect(runtime.steerQueued).toHaveBeenCalledWith('s1', 't1'); expect(runtime.stop).toHaveBeenCalledOnce();
  });

  it('accepts a steer-mode send as a queued Task, then tries to inject it and reports what happened', async () => {
    const task = { id: 't2', sessionId: 's1', prompt: 'also check logs', status: 'queued', createdAt: '', updatedAt: '' };
    const runtime: any = { dispatch: vi.fn(async () => task), injectQueued: vi.fn(async () => ({ task: { ...task, status: 'completed' }, outcome: 'injected' })) };
    const app = await buildApp(runtime); apps.push(app);
    const sent = await app.inject({ method: 'POST', url: '/api/sessions/s1/send', payload: { prompt: 'also check logs', mode: 'steer' } });
    expect(sent.statusCode).toBe(202);
    expect(sent.json()).toMatchObject({ accepted: true, task: { id: 't2', status: 'completed' }, steering: { outcome: 'injected' } });
    expect(runtime.dispatch).toHaveBeenCalledWith('s1', 'also check logs', 'queue', 'also check logs', undefined, undefined, undefined, undefined);
    expect(runtime.injectQueued).toHaveBeenCalledWith('s1', 't2', undefined);
    runtime.injectQueued.mockResolvedValueOnce({ task, outcome: 'unsupported' });
    expect((await app.inject({ method: 'POST', url: '/api/sessions/s1/queue/t2/inject' })).json()).toMatchObject({ task: { status: 'queued' }, outcome: 'unsupported' });
    // 这一条直接开跑（前面没有正在执行的一轮）时不插话，按正常新一轮回报。
    runtime.dispatch.mockResolvedValueOnce({ ...task, status: 'running' });
    expect((await app.inject({ method: 'POST', url: '/api/sessions/s1/send', payload: { prompt: 'start', mode: 'steer' } })).json()).toMatchObject({ steering: { outcome: 'promptRequired' } });
    expect(runtime.injectQueued).toHaveBeenCalledTimes(2);
    // 派发时还在排队、插话前已经开跑：按它此刻的状态回报，而不是说「接不了插话」。
    runtime.injectQueued.mockRejectedValueOnce(new RuntimeError('QUEUED_TASK_NOT_FOUND', 'Queued task is missing', 404));
    runtime.getTasks = vi.fn(async () => [{ ...task, status: 'running' }]);
    expect((await app.inject({ method: 'POST', url: '/api/sessions/s1/send', payload: { prompt: 'also check logs', mode: 'steer' } })).json()).toMatchObject({ task: { id: 't2', status: 'running' }, steering: { outcome: 'moved' } });
  });

  it('passes exact selected Skill paths and enforces shell authority for verification', async () => {
    const runtime = { dispatch: vi.fn(async () => ({ id: 't1' })), runVerification: vi.fn(async () => ({ status: 'passed' })) };
    const authorize = vi.fn(async (_request: unknown, _id: string, _boundary: string, action: string) => ({ allowed: action !== 'terminal.write', source: 'owner', code: 'denied_shell', reason: 'terminal access required' }));
    const app = await buildApp(runtime as any, { executionPolicy: { authorize } as any }); apps.push(app);
    const path = '/project/.agents/skills/check/SKILL.md';
    expect((await app.inject({ method: 'POST', url: '/api/sessions/s1/send', payload: { prompt: 'check', skillRequests: [path] } })).statusCode).toBe(202);
    expect(runtime.dispatch).toHaveBeenCalledWith('s1', 'check', 'queue', 'check', undefined, 'installation_owner', undefined, [path]);
    expect((await app.inject({ method: 'POST', url: '/api/sessions/s1/send', payload: { prompt: 'check', skillRequests: ['/ok', 3] } })).statusCode).toBe(400);
    expect(runtime.dispatch).toHaveBeenCalledTimes(1);
    expect((await app.inject({ method: 'POST', url: '/api/sessions/s1/verifications', payload: { command: 'echo unsafe' } })).statusCode).toBe(403);
    expect(runtime.runVerification).not.toHaveBeenCalled();
  });

  it('projects the first task goal and current queued count as a cross-session run summary', async () => {
    const sessions = [
      { id: 's1', updatedAt: '2026-01-01T00:00:00.000Z' },
      { id: 's2', updatedAt: '2026-01-02T00:00:00.000Z' },
      { id: 'empty', updatedAt: '2026-01-03T00:00:00.000Z' }
    ];
    const runtime: any = {
      listSessions: vi.fn(async () => sessions),
      getTasks: vi.fn(async (id: string) => id === 's1'
        ? [{ id: 'cancelled', sessionId: id, prompt: 'ignore', status: 'cancelled', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }, { id: 't1', sessionId: id, prompt: '  修复登录超时  ', status: 'completed', createdAt: '2026-01-01T00:00:01.000Z', updatedAt: '2026-01-01T00:00:02.000Z' }, { id: 'queued-1', sessionId: id, prompt: '补充回归', status: 'queued', createdAt: '2026-01-01T00:00:03.000Z', updatedAt: '2026-01-01T00:00:03.000Z' }]
        : id === 's2' ? [{ id: 't2', sessionId: id, prompt: '补齐测试', status: 'running', createdAt: '2026-01-02T00:00:00.000Z', updatedAt: '2026-01-02T00:00:01.000Z' }] : [])
    };
    const app = await buildApp(runtime); apps.push(app);
    expect((await app.inject({ method: 'GET', url: '/api/sessions/summaries' })).json()).toEqual([
      { sessionId: 's1', taskId: 't1', prompt: '修复登录超时', status: 'completed', queuedCount: 1, updatedAt: '2026-01-01T00:00:03.000Z' },
      { sessionId: 's2', taskId: 't2', prompt: '补齐测试', status: 'running', queuedCount: 0, updatedAt: '2026-01-02T00:00:01.000Z' }
    ]);
  });

  it('validates queued send input before handing it to Runtime', async () => {
    const runtime: any = { dispatch: vi.fn() };
    const app = await buildApp(runtime); apps.push(app);
    expect((await app.inject({ method: 'POST', url: '/api/sessions/s1/send', payload: { prompt: '   ' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/sessions/s1/send', payload: { prompt: 'hello', mode: 'later' } })).statusCode).toBe(400);
    expect(runtime.dispatch).not.toHaveBeenCalled();
  });

  it('replays missed SSE events after Last-Event-ID reconnect', async () => {
    const missed = { id: 'e2', sessionId: 's1', sequence: 2, type: 'text', timestamp: new Date().toISOString(), data: { text: 'replayed' } };
    const runtime: any = { listAgents: async () => [], listSessions: async () => [], getSession: async () => undefined, start: vi.fn(), send: vi.fn(), interrupt: vi.fn(), pause: vi.fn(), resume: vi.fn(), stop: vi.fn(), restart: vi.fn(), resolvePermission: vi.fn(), getEventWindow: vi.fn(async (_id: string, options: any) => options.afterSequence === 1 ? [missed] : []), subscribe: vi.fn(() => () => {}) };
    const app = await buildApp(runtime); apps.push(app); await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address(); if (!address || typeof address === 'string') throw new Error('No port');
    const controller = new AbortController(); const response = await fetch(`http://127.0.0.1:${address.port}/api/sessions/s1/stream`, { headers: { 'Last-Event-ID': '1' }, signal: controller.signal });
    const reader = response.body!.getReader(); const decoder = new TextDecoder(); let chunk = '';
    while (!chunk.includes('id: 2')) { const next = await reader.read(); if (next.done) break; chunk += decoder.decode(next.value); }
    controller.abort();
    expect(chunk).toContain('id: 2'); expect(chunk).toContain('replayed'); expect(runtime.getEventWindow).toHaveBeenCalledWith('s1', { afterSequence: 1, direction: 'forward', limit: 1_000 });
  });

  it('pages long SSE reconnect gaps in bounded batches', async () => {
    const event = (sequence: number) => ({ id: `e${sequence}`, sessionId: 's1', sequence, type: 'text', timestamp: '2026-01-01T00:00:00.000Z', data: { text: String(sequence) } });
    const runtime: any = {
      getEventWindow: vi.fn(async (_id: string, options: any) => {
        if (options.afterSequence === 1) return Array.from({ length: 1_000 }, (_, index) => event(index + 2));
        if (options.afterSequence === 1_001) return [event(1_002)];
        return [];
      }),
      subscribe: vi.fn(() => () => {})
    };
    const app = await buildApp(runtime); apps.push(app); await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address(); if (!address || typeof address === 'string') throw new Error('No port');
    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/sessions/s1/stream?after=1`, { signal: controller.signal });
    const reader = response.body!.getReader(); const decoder = new TextDecoder(); let chunk = '';
    while (!chunk.includes('id: 1002')) { const next = await reader.read(); if (next.done) break; chunk += decoder.decode(next.value); }
    controller.abort();
    expect(chunk).toContain('id: 1002');
    expect(runtime.getEventWindow).toHaveBeenNthCalledWith(1, 's1', { afterSequence: 1, direction: 'forward', limit: 1_000 });
    expect(runtime.getEventWindow).toHaveBeenNthCalledWith(2, 's1', { afterSequence: 1_001, direction: 'forward', limit: 1_000 });
  });

  it('waits for socket drain before loading another SSE replay batch', async () => {
    const largeText = 'x'.repeat(8 * 1_024);
    const runtime: any = {
      getEventWindow: vi.fn(async (_id: string, options: any) => options.afterSequence >= 20_001 ? []
        : Array.from({ length: 1_000 }, (_, index) => {
            const sequence = options.afterSequence + index + 1;
            return { id: `e${sequence}`, sessionId: 's1', sequence, type: 'text', timestamp: '2026-01-01T00:00:00.000Z', data: { text: largeText } };
          })),
      subscribe: vi.fn(() => () => {})
    };
    const app = await buildApp(runtime); apps.push(app); await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address(); if (!address || typeof address === 'string') throw new Error('No port');
    let response: IncomingMessage | undefined;
    const request = httpGet(`http://127.0.0.1:${address.port}/api/sessions/s1/stream?after=1`, next => { response = next; next.pause(); });
    await vi.waitFor(() => expect(response).toBeDefined());
    try {
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(runtime.getEventWindow.mock.calls.length).toBeLessThan(10);
    } finally {
      response?.destroy(); request.destroy();
    }
  });

  it('continues after the newest SSE cursor without replaying acknowledged events', async () => {
    const runtime: any = { listAgents: async () => [], listSessions: async () => [], getSession: async () => undefined, start: vi.fn(), send: vi.fn(), interrupt: vi.fn(), pause: vi.fn(), resume: vi.fn(), stop: vi.fn(), restart: vi.fn(), resolvePermission: vi.fn(), getEventWindow: vi.fn(async () => []), subscribe: vi.fn(() => () => {}) };
    const app = await buildApp(runtime); apps.push(app); await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address(); if (!address || typeof address === 'string') throw new Error('No port');
    const controller = new AbortController(); await fetch(`http://127.0.0.1:${address.port}/api/sessions/s1/stream?after=4`, { headers: { 'Last-Event-ID': '9' }, signal: controller.signal }); controller.abort();
    expect(runtime.getEventWindow).toHaveBeenCalledWith('s1', { afterSequence: 9, direction: 'forward', limit: 1_000 });
  });

  it('buffers live SSE events emitted while persisted replay is being read', async () => {
    const replayed = { id: 'e2', sessionId: 's1', sequence: 2, type: 'text', timestamp: new Date().toISOString(), data: { text: 'replayed' } };
    const live = { id: 'e3', sessionId: 's1', sequence: 3, type: 'task', timestamp: new Date().toISOString(), data: { task: { id: 't1', status: 'completed' } } };
    let listener: ((event: typeof live) => void) | undefined;
    const runtime: any = {
      getEventWindow: vi.fn(async () => { listener?.(live); return [replayed]; }),
      subscribe: vi.fn((_id: string, next: typeof listener) => { listener = next; return () => {}; })
    };
    const app = await buildApp(runtime); apps.push(app); await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address(); if (!address || typeof address === 'string') throw new Error('No port');
    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/sessions/s1/stream?after=1`, { signal: controller.signal });
    const reader = response.body!.getReader(); const decoder = new TextDecoder(); let chunk = '';
    while (!chunk.includes('id: 3')) { const next = await reader.read(); if (next.done) break; chunk += decoder.decode(next.value); }
    controller.abort();
    expect(chunk.indexOf('id: 2')).toBeGreaterThanOrEqual(0);
    expect(chunk.indexOf('id: 3')).toBeGreaterThan(chunk.indexOf('id: 2'));
    expect(runtime.subscribe.mock.invocationCallOrder[0]).toBeLessThan(runtime.getEventWindow.mock.invocationCallOrder[0]);
  });

  it('unsubscribes immediately when the client disconnects during a slow SSE replay', async () => {
    let finishReplay: ((events: any[]) => void) | undefined;
    const replay = new Promise<any[]>(resolve => { finishReplay = resolve; });
    const unsubscribe = vi.fn();
    const runtime: any = {
      getEventWindow: vi.fn(() => replay),
      subscribe: vi.fn(() => unsubscribe)
    };
    const app = await buildApp(runtime); apps.push(app); await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address(); if (!address || typeof address === 'string') throw new Error('No port');
    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/sessions/s1/stream`, { signal: controller.signal });
    expect(response.status).toBe(200);
    controller.abort();
    await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledOnce());
    finishReplay?.([]);
  });

  it('serves bounded event windows by default and for forward cursors', async () => {
    const runtime: any = { getEventWindow: vi.fn(async () => ['window']) };
    const app = await buildApp(runtime); apps.push(app);
    expect((await app.inject({ method: 'GET', url: '/api/sessions/s1/events' })).json()).toEqual(['window']);
    expect(runtime.getEventWindow).toHaveBeenNthCalledWith(1, 's1', { afterSequence: undefined, beforeSequence: undefined, limit: undefined, direction: 'backward' });
    await app.inject({ method: 'GET', url: '/api/sessions/s1/events?after=42' });
    expect(runtime.getEventWindow).toHaveBeenNthCalledWith(2, 's1', { afterSequence: 42, beforeSequence: undefined, limit: undefined, direction: 'forward' });
    const windowed = await app.inject({ method: 'GET', url: '/api/sessions/s1/events?before=42&limit=20&direction=backward' });
    expect(windowed.json()).toEqual(['window']);
    expect(runtime.getEventWindow).toHaveBeenNthCalledWith(3, 's1', { afterSequence: undefined, beforeSequence: 42, limit: 20, direction: 'backward' });
    expect((await app.inject({ method: 'GET', url: '/api/sessions/s1/events?limit=-1' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/sessions/s1/events?limit=0' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/sessions/s1/events?limit=1001' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/sessions/s1/events?limit=20&direction=sideways' })).statusCode).toBe(400);
  });

  it('serves the bundled Web UI while preserving API 404 responses', async () => {
    const webRoot = await mkdtemp(join(tmpdir(), 'dutydeck-web-')); tempDirectories.push(webRoot);
    await mkdir(join(webRoot, 'assets'));
    await writeFile(join(webRoot, 'index.html'), '<main>Dutydeck UI</main>');
    await writeFile(join(webRoot, 'assets', 'app.js'), 'globalThis.dutydeck = true;');
    const runtime: any = { listAgents: async () => [], listSessions: async () => [], getSession: async () => undefined, start: vi.fn(), send: vi.fn(), interrupt: vi.fn(), pause: vi.fn(), resume: vi.fn(), stop: vi.fn(), restart: vi.fn(), resolvePermission: vi.fn(), getEvents: vi.fn(async () => []), getTasks: vi.fn(async () => []), subscribe: vi.fn(() => () => {}) };
    const app = await buildApp(runtime, { webRoot }); apps.push(app);

    const index = await app.inject({ method: 'GET', url: '/' });
    expect(index.statusCode).toBe(200); expect(index.headers['content-type']).toContain('text/html'); expect(index.body).toContain('Dutydeck UI');
    const asset = await app.inject({ method: 'GET', url: '/assets/app.js' });
    expect(asset.statusCode).toBe(200); expect(asset.headers['cache-control']).toContain('immutable');
    expect((await app.inject({ method: 'GET', url: '/sessions/s1' })).body).toContain('Dutydeck UI');
    const api = await app.inject({ method: 'GET', url: '/api/not-real' });
    expect(api.statusCode).toBe(404); expect(api.json().error.code).toBe('NOT_FOUND');
  });

  it('中央豁免名单：静态壳、自鉴权 agent-tools 与 relay capability 放行，其余 /api/* 要 token', async () => {
    // 守的是 app.ts 里那份 exempt 规则本身（auth 中间件的通用逻辑另有测试）。
    // 名单是"谁可以不带 token 就访问"，加一条就等于开一个口子，必须显式对拍。
    //
    // relay 只有 POST /send、/ask 可用会话 HMAC 自鉴权；人类查看/回答 ask 仍需 access token。
    const repos = createRepositories(':memory:'); repositories.push(repos);
    const app = await buildApp({} as any, {
      auth: { getToken: async () => 'secret-token', localOnly: false },
    }); apps.push(app);

    const remote = { remoteAddress: '8.8.8.8' } as const;
    // 豁免：静态壳（不含会话数据）
    expect((await app.inject({ method: 'GET', url: '/', ...remote })).statusCode).not.toBe(401);
    // 豁免：lark agent-tools 自带 Bearer 机制
    expect((await app.inject({ method: 'GET', url: '/api/lark/agent-tools/self', ...remote })).statusCode).not.toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/relay/sessions/self/send', ...remote })).statusCode).not.toBe(401);
    // 豁免：CI 回调前缀，路由自己校验签名
    expect((await app.inject({ method: 'POST', url: '/api/hooks/ci', ...remote })).statusCode).not.toBe(401);
    // 浏览器认证入口公开，但只返回认证状态；登录后 cookie 才能访问业务 API。
    expect((await app.inject({ method: 'GET', url: '/api/auth/status', ...remote })).json()).toEqual({ authenticated: false, required: true });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { token: 'secret-token' }, ...remote });
    expect(login.statusCode).toBe(200);
    expect(login.headers['set-cookie']).toContain('dutydeck_access=secret-token');
    expect((await app.inject({ method: 'GET', url: '/api/sessions', headers: { cookie: login.headers['set-cookie'] }, ...remote })).statusCode).not.toBe(401);

    // 非豁免：这些必须 401
    for (const url of ['/api/sessions', '/api/agents', '/api/relay/sessions/self/asks']) {
      expect(
        (await app.inject({ method: 'GET', url, ...remote })).statusCode,
        `${url} 不在豁免名单里，无 token 的远程请求必须 401`,
      ).toBe(401);
    }
  });

  it('分享 token 只能读绑定会话的详情、事件和任务，其他会话和写接口仍要登录', async () => {
    const runtime: any = {
      getSession: vi.fn(async (id: string) => ({ id })), getEventWindow: vi.fn(async () => []), getTasks: vi.fn(async () => []),
      send: vi.fn(), archive: vi.fn(), listSessions: vi.fn(async () => [])
    };
    const app = await buildApp(runtime, {
      auth: { mode: 'token', getToken: async () => 'secret-token', localOnly: false, getShareSecret: async () => 'share-secret' },
    }); apps.push(app);
    const remote = { remoteAddress: '8.8.8.8' } as const;
    const share = signSessionShareToken('share-secret', 'ses_1');
    for (const url of ['/api/sessions/ses_1', '/api/sessions/ses_1/events', '/api/sessions/ses_1/tasks']) {
      expect((await app.inject({ method: 'GET', url: `${url}?share=${share}`, ...remote })).statusCode, url).toBe(200);
    }
    for (const request of [
      { method: 'GET', url: `/api/sessions/ses_2?share=${share}` },
      { method: 'GET', url: `/api/sessions?share=${share}` },
      { method: 'GET', url: `/api/sessions/ses_1/workspace?share=${share}` },
      { method: 'POST', url: `/api/sessions/ses_1/send?share=${share}`, payload: { prompt: 'hi' } },
      { method: 'POST', url: `/api/sessions/ses_1/archive?share=${share}` },
    ] as const) {
      expect((await app.inject({ ...request, ...remote })).statusCode, `${request.method} ${request.url}`).toBe(401);
    }
    expect(runtime.getSession).toHaveBeenCalledTimes(1);
    expect(runtime.send).not.toHaveBeenCalled();
    expect(runtime.archive).not.toHaveBeenCalled();
  });

  it('一次性登录链接免 token：GET/HEAD 只回确认页，POST 兑换出能访问业务 API 的 cookie；其他方法照常鉴权', async () => {
    const loginLinks = new LoginLinkStore();
    const app = await buildApp({ listSessions: async () => [] } as any, {
      auth: { mode: 'token', getToken: async () => 'secret-token', localOnly: false, loginLinks },
    }); apps.push(app);
    const remote = { remoteAddress: '8.8.8.8' } as const;
    expect((await app.inject({ method: 'GET', url: '/api/auth/link?code=forged', ...remote })).statusCode).toBe(400);
    const code = loginLinks.issue('ses_1');
    for (const method of ['GET', 'HEAD'] as const) {
      const page = await app.inject({ method, url: `/api/auth/link?code=${code}`, ...remote });
      expect(page.statusCode).toBe(200);
      expect(page.headers['set-cookie']).toBeUndefined();
    }
    for (const method of ['PUT', 'PATCH', 'DELETE'] as const) {
      expect((await app.inject({ method, url: `/api/auth/link?code=${code}`, ...remote })).statusCode).toBe(401);
    }
    const redeemed = await app.inject({ method: 'POST', url: '/api/auth/link', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `code=${code}`, ...remote });
    expect(redeemed.statusCode).toBe(303);
    expect(redeemed.headers.location).toBe('/sessions/ses_1');
    expect(redeemed.headers['set-cookie']).toContain('dutydeck_access=secret-token');
    expect((await app.inject({ method: 'GET', url: '/api/sessions', headers: { cookie: redeemed.headers['set-cookie'] as string }, ...remote })).statusCode).toBe(200);
  });

});
