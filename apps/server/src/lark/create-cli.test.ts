import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import { agentConfigSchema } from '@dutydeck/shared';
import { createCliProgram } from '../cli-program.js';
import { createCliUi } from '../cli-ui.js';
import { runLarkCreate, type LarkCreateCliResult } from './create-cli.js';
import { LarkAppCreationJobManager } from './app-creation.js';
import { LARK_COMMON_TENANT_SCOPES, LARK_REQUIRED_EVENTS } from './open-platform-configurator.js';
import { readLarkConfig, saveLarkConfig } from './config.js';
import { connectLarkOpenPlatformSession, writeOpenPlatformSessionCookies, OpenPlatformSessionError, type ConnectOpenPlatformSessionOptions } from './open-platform-session.js';

const secret = 'SECRET_CANARY_NEVER_IN_CLI';
const uuid = 'dfe543ed-a565-46af-8f04-552fd038df58';
const repos: ReturnType<typeof createRepositories>[] = [];
afterEach(() => { for (const repo of repos.splice(0)) repo.close(); });

async function harness(tty = true, versionStatus = 2) {
  const repositories = createRepositories(':memory:');
  repos.push(repositories);
  await repositories.agents.save(agentConfigSchema.parse({ id: 'ccflash', name: 'CCFlash', protocol: 'pty-cli', adapterId: 'claude-code', command: process.execPath, model: 'gemini-3.8-flash-high' }));
  let stdout = ''; let stderr = '';
  const ui = createCliUi({ tty, color: false, stdout: { write: text => { stdout += text; } }, stderr: { write: text => { stderr += text; } } });
  let scopes = false; let events = false; let callbacks = false; let callbackMode = 0; let published = false;
  const postJson = vi.fn(async (path: string, body?: Record<string, unknown>): Promise<unknown> => {
    if (path.includes('/manifest/upsert_by_template')) return { data: { ClientID: 'cli_created' } };
    if (path.includes('/secret/')) return { data: { secret } };
    if (path.includes('/privilege/all/')) return { data: { privileges: [] } };
    if (path.includes('/scope/all/')) return { data: { appScopeList: LARK_COMMON_TENANT_SCOPES.map((scopeName, i) => ({ scopeId: `s-${i}`, scopeName, status: published && versionStatus === 2 ? 5 : scopes ? 1 : 0 })) } };
    if (path.includes('/scope/update/')) { scopes = true; return { code: 0 }; }
    if (path.includes('/robot/switch/') || path.includes('/event/switch/')) return { code: 0 };
    if (path.includes('/event/update/')) { events = true; return { code: 0 }; }
    if (path === '/developers/v1/event/cli_created') return { data: { eventMode: 4, appEvents: events ? [...LARK_REQUIRED_EVENTS] : [] } };
    if (path.includes('/callback/switch/')) { callbackMode = 4; return { code: 0 }; }
    if (path.includes('/callback/update/')) { callbacks = true; return { code: 0 }; }
    if (path === '/developers/v1/callback/cli_created') return { data: { callbackMode, callbacks: callbacks ? ['card.action.trigger'] : [] } };
    if (path.includes('/app_version/list/')) return { data: { versions: published ? [{ versionId: 'first-version', appVersion: '0.0.1', versionStatus }] : [] } };
    if (path.includes('/app_version/create/')) {
      expect(body?.visibleSuggest).toMatchObject({ members: ['private-user'] });
      return { data: { versionId: 'first-version' } };
    }
    if (path.includes('/publish/commit/')) { published = true; return { code: 0 }; }
    throw new Error(`Unexpected endpoint: ${path}`);
  });
  const postForm = vi.fn(async (_path: string, form: FormData) => {
    expect(form.get('uploadType')).toBe('4');
    return { data: { url: 'https://example.invalid/icon.png' } };
  });
  const connect = vi.fn(async (options: ConnectOpenPlatformSessionOptions = {}) => {
    if (options.allowQrLogin !== false) await options.onQrUpdate?.({ qrPayload: 'private-qr-token', status: 'waiting_for_scan' });
    return { source: 'qr_login' as const, owner: { userId: 'private-user', tenantId: 'private-tenant', userName: 'Alice', tenantName: 'Acme' }, client: { apiOrigin: 'https://open.feishu.cn', postJson, postForm } };
  });
  const context = { config: repositories.config, agents: repositories.agents, database: "/tmp/Bot's state.db", ui, connect };
  return { repositories, context, connect, postJson, postForm, output: () => stdout + stderr, stdout: () => stdout };
}

it('runs CLI parsing, real creation/configurator and SQLite through QR, publication and CCFlash selection', async () => {
  const h = await harness();
  await saveLarkConfig(h.context.config, h.context.agents, { appId: 'cli_previous', appSecret: 'old-secret', name: 'Old Bot' });
  const previous = await readLarkConfig(h.context.config, 'cli_previous');
  let result!: LarkCreateCliResult;
  const program = createCliProgram('test', { larkCreate: async (name, options) => { result = await runLarkCreate(name, options, h.context); } });
  await program.parseAsync(['node', 'dutydeck', 'lark', 'create', 'CCFlash 助手', '--agent', 'ccflash', '--full-trust', '--listen', '--workspace', process.cwd()]);
  expect(result).toMatchObject({ ok: true, job: { status: 'completed', appId: 'cli_created' }, bot: { defaultAgentId: 'ccflash', listening: true, activeListening: false, fullTrustConfirmed: true, workspace: process.cwd() }, restartRequired: true });
  expect(h.connect).toHaveBeenCalledOnce();
  expect(h.postJson.mock.calls.filter(([path]) => path.includes('/manifest/'))).toHaveLength(1);
  expect(h.postJson.mock.calls.filter(([path]) => path.includes('/publish/commit/'))).toHaveLength(1);
  expect(await readLarkConfig(h.context.config, 'cli_created')).toMatchObject({ appSecret: secret, defaultAgentId: 'ccflash' });
  expect(await readLarkConfig(h.context.config, 'cli_previous')).toEqual(previous);
  expect(h.output()).toContain('扫码');
  expect(h.output()).toMatch(/[▀▄█]/);
  expect(h.output()).toContain('中断后续跑同一任务');
  expect(h.output()).toContain("--database '/tmp/Bot'\\''s state.db'");
  expect(result.next).toContain('dutydeck restart');
  expect(result.next).toContain("dutydeck restart --database '/tmp/Bot'\\''s state.db'");
  expect(result.next).toContain("dutydeck start --database '/tmp/Bot'\\''s state.db'");
  for (const value of [h.output(), JSON.stringify(result)]) for (const canary of [secret, 'private-user', 'private-tenant', 'private-qr-token']) expect(value).not.toContain(canary);
  const before = await readLarkConfig(h.context.config, 'cli_created');
  await runLarkCreate(undefined, { resume: result.job!.id, agent: 'ccflash', fullTrust: true, listen: true, workspace: process.cwd() }, h.context);
  expect(h.connect).toHaveBeenCalledOnce();
  expect(await readLarkConfig(h.context.config, 'cli_created')).toEqual(before);
});

it('saves a draft without an Agent, then completes that same bot on resume', async () => {
  const h = await harness();
  const first = await runLarkCreate('Draft', {}, h.context);
  expect(first).toMatchObject({ ok: true, bot: { setupComplete: false, listening: false, fullTrustConfirmed: false } });
  const resumed = await runLarkCreate(undefined, { resume: first.job!.id, agent: 'ccflash', fullTrust: true }, h.context);
  expect(resumed).toMatchObject({ ok: true, bot: { defaultAgentId: 'ccflash', listening: false } });
  expect(h.connect).toHaveBeenCalledOnce();
});

it('reports a real configurator review result and binds the requested Agent without publishing twice', async () => {
  const h = await harness(true, 1);
  const result = await runLarkCreate('Bot', { agent: 'ccflash', fullTrust: true, listen: true }, h.context);
  expect(result).toMatchObject({ ok: true, job: { status: 'pending_review', retryable: false }, bot: { defaultAgentId: 'ccflash' }, next: expect.stringContaining('审核通过后生效') });
  expect(result).not.toHaveProperty('error');
  expect(h.output()).toContain('正在等待飞书管理员审核');
  expect(h.output()).not.toContain('已回读确认');
  expect(result.next).toContain("dutydeck restart --database '/tmp/Bot'\\''s state.db'");
  expect(result.next).toContain("dutydeck start --database '/tmp/Bot'\\''s state.db'");
  const count = h.postJson.mock.calls.length;
  const resumed = await runLarkCreate(undefined, { resume: result.job!.id }, h.context);
  expect(resumed.job?.status).toBe('pending_review');
  expect(h.postJson).toHaveBeenCalledTimes(count);
  const queried = await runLarkCreate(undefined, { resume: result.job!.id, status: true, json: true }, h.context);
  expect(queried).toMatchObject({ ok: true, job: { status: 'pending_review' } });
  expect(h.postJson).toHaveBeenCalledTimes(count);
});

it.each([
  { json: true, forceLogin: true }, { listen: true }, { agent: 'ccflash' }, { status: true },
  { agent: 'unknown', fullTrust: true }, { agent: 'ccflash', fullTrust: true, workspace: '/nonexistent-dutydeck-fixture' },
])('rejects invalid or noninteractive creation before login: %j', async options => {
  const h = await harness();
  expect(await runLarkCreate('Bot', options, h.context)).toMatchObject({ ok: false });
  expect(h.connect).not.toHaveBeenCalled();
  expect(await h.context.config.get('lark.bots')).toBeUndefined();
});

it.each([false, true])('creates with a cached login in noninteractive mode (json=%s)', async json => {
  const h = await harness(false);
  const renderQr = vi.fn();
  const result = await runLarkCreate('Bot', { json }, { ...h.context, renderQr });
  expect(result).toMatchObject({ ok: true, job: { status: 'completed' } });
  expect(h.connect).toHaveBeenCalledWith(expect.objectContaining({ forceLogin: false, allowQrLogin: false }));
  expect(renderQr).not.toHaveBeenCalled();
  if (json) {
    expect(h.output()).toBe(h.stdout());
    expect(h.stdout().trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(h.stdout())).toEqual(result);
  }
});

it('returns a resumable failure when headless login needs a scan', async () => {
  const h = await harness(false);
  h.connect.mockRejectedValueOnce(new OpenPlatformSessionError('login_required'));
  const result = await runLarkCreate('Bot', { json: true }, h.context);
  expect(result).toMatchObject({ ok: false, job: { status: 'failed', retryable: true }, error: expect.stringContaining('交互终端') });
  expect(result.next).toContain(`--resume ${result.job!.id}`);
  expect(h.postJson).not.toHaveBeenCalled();
  expect(JSON.parse(h.stdout())).toEqual(result);
});

it('forwards explicit re-login on both create and safe resume', async () => {
  const h = await harness();
  h.connect.mockRejectedValueOnce(new OpenPlatformSessionError('qr_login'));
  const failed = await runLarkCreate('Bot', { forceLogin: true }, h.context);
  expect(await runLarkCreate(undefined, { resume: failed.job!.id, forceLogin: true }, h.context)).toMatchObject({ ok: true });
  expect(h.connect.mock.calls.map(([options]) => options!.forceLogin)).toEqual([true, true]);
});

it('rejects force-login with status without changing the stored job', async () => {
  const h = await harness();
  const raw = JSON.stringify({ id: uuid, name: 'Bot', status: 'failed', retryable: true, createdAt: 'now', updatedAt: 'now' });
  await h.context.config.set(`lark.app_creation.${uuid}`, raw);
  expect(await runLarkCreate(undefined, { resume: uuid, status: true, forceLogin: true }, h.context)).toMatchObject({ ok: false, error: expect.stringContaining('--status') });
  expect(h.connect).not.toHaveBeenCalled();
  expect(await h.context.config.get(`lark.app_creation.${uuid}`)).toBe(raw);
});

it('returns one JSON status line without scanning, retrying or saving Agent settings', async () => {
  const h = await harness(false);
  const raw = JSON.stringify({ id: uuid, name: 'Bot', status: 'failed', retryable: true, createdAt: 'now', updatedAt: 'now' });
  await h.context.config.set(`lark.app_creation.${uuid}`, raw);
  const result = await runLarkCreate(undefined, { resume: uuid, status: true, json: true }, h.context);
  expect(result).toMatchObject({ ok: false, job: { status: 'failed', retryable: true } });
  expect(JSON.parse(h.stdout())).toEqual(result);
  expect(h.stdout().trim().split('\n')).toHaveLength(1);
  expect(h.output()).toBe(h.stdout());
  expect(h.connect).not.toHaveBeenCalled();
  expect(await h.context.config.get(`lark.app_creation.${uuid}`)).toBe(raw);
});

it('resumes a failed secret read using the known app instead of creating another one', async () => {
  const h = await harness();
  h.postJson.mockImplementationOnce(async () => ({ data: { ClientID: 'cli_created' } })).mockRejectedValueOnce(new Error(secret));
  const failed = await runLarkCreate('Bot', {}, h.context);
  expect(failed).toMatchObject({ ok: false, job: { appId: 'cli_created', retryable: true } });
  expect(failed.next).toContain(`--resume ${failed.job!.id}`);
  expect(failed.next).not.toContain(secret);
  expect(await runLarkCreate(undefined, { resume: failed.job!.id }, h.context)).toMatchObject({ ok: true });
  expect(h.postJson.mock.calls.filter(([path]) => path.includes('/manifest/'))).toHaveLength(1);
});

it('does not retry an unknown creation outcome', async () => {
  const h = await harness();
  h.postJson.mockRejectedValueOnce(new Error(secret));
  const failed = await runLarkCreate('Bot', {}, h.context);
  expect(failed).toMatchObject({ ok: false, job: { retryable: false } });
  const resumed = await runLarkCreate(undefined, { resume: failed.job!.id }, h.context);
  expect(resumed).toMatchObject({ ok: false, job: { retryable: false } });
  expect(resumed.next).toContain('open.feishu.cn');
  expect(h.connect).toHaveBeenCalledOnce();
  expect(h.output()).not.toContain(secret);
});

it('reports a live foreign job without claiming completion or starting another run', async () => {
  const h = await harness();
  await h.context.config.set(`lark.app_creation.${uuid}`, JSON.stringify({ id: uuid, name: 'Bot', status: 'waiting_for_scan', retryable: false, createdAt: 'now', updatedAt: 'now', runner: { pid: process.pid, instanceId: 'foreign' } }));
  const result = await runLarkCreate(undefined, { resume: uuid }, h.context);
  expect(result).toMatchObject({ ok: false, job: { status: 'waiting_for_scan' }, next: expect.stringContaining('原进程运行') });
  expect(result.job).not.toHaveProperty('runner');
  expect(h.connect).not.toHaveBeenCalled();
});

it('preserves a saved bot after publication failure for manual continuation', async () => {
  const h = await harness();
  const result = await runLarkCreate('Bot', { agent: 'ccflash', fullTrust: true, listen: true }, { ...h.context, configure: async () => { throw new Error(secret); } });
  expect(result).toMatchObject({ ok: false, job: { botSaved: true, retryable: false }, bot: { listening: false, setupComplete: false }, next: expect.stringContaining('Dashboard') });
  expect(h.output()).not.toContain(secret);
  const other = new LarkAppCreationJobManager(h.context);
  expect(await other.get(result.job!.id)).toMatchObject({ appId: 'cli_created', botSaved: true });
});


it('reports interrupted status without persisting recovery or changing Bot settings', async () => {
  const h = await harness(false);
  const raw = JSON.stringify({ id: uuid, name: 'Bot', status: 'preparing', retryable: false, createdAt: 'now', updatedAt: 'now' });
  await h.context.config.set(`lark.app_creation.${uuid}`, raw);
  const result = await runLarkCreate(undefined, { resume: uuid, status: true, json: true }, h.context);
  expect(result).toMatchObject({ ok: false, job: { status: 'failed', retryable: true } });
  expect(h.connect).not.toHaveBeenCalled();
  expect(await h.context.config.get(`lark.app_creation.${uuid}`)).toBe(raw);
  expect(await h.context.config.get('lark.bots')).toBeUndefined();
});


it.each([false, true])('uses the real session cache and never requests QR in headless creation (json=%s)', async json => {
  const h = await harness(false);
  const root = mkdtempSync(join(tmpdir(), 'dutydeck-create-cache-'));
  try {
    const sessionFilePath = join(root, 'session.json');
    writeOpenPlatformSessionCookies(sessionFilePath, [{ name: 'session', value: 'private-session', domain: '.feishu.cn', path: '/', secure: true, httpOnly: true, hostOnly: false }]);
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      expect(path).not.toContain('/accounts/qrlogin/');
      expect(new Headers(init?.headers).get('cookie')).toContain('session=private-session');
      if (path === '/app') return new Response('<script>window.csrfToken="csrf";window.user={"id":"private-user","name":"Alice","tenantId":"private-tenant","tenantDisplayName":{"value":"Acme"}};</script>');
      if (init?.body instanceof FormData) return Response.json(await h.postForm(path, init.body));
      return Response.json(await h.postJson(path, init?.body === undefined ? undefined : JSON.parse(String(init.body))));
    }) as typeof fetch;
    const renderQr = vi.fn();
    const result = await runLarkCreate('Cached bot', { json }, { ...h.context, renderQr, connect: options => connectLarkOpenPlatformSession({ ...options, sessionFilePath, fetchImpl }) });
    expect(result).toMatchObject({ ok: true, job: { status: 'completed', appId: 'cli_created' } });
    expect(fetchImpl).toHaveBeenCalled();
    expect(renderQr).not.toHaveBeenCalled();
    expect(h.output()).not.toContain('private-session');
    if (json) {
      expect(h.output()).toBe(h.stdout());
      expect(h.stdout().trim().split('\n')).toHaveLength(1);
      expect(JSON.parse(h.stdout())).toEqual(result);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});


it.each(['lark.bots', 'lark.credentials'])('status never migrates legacy Bot configuration in %s', async key => {
  for (const status of ['completed', 'configuring'] as const) {
    const h = await harness(false);
    const bot = { appId: 'cli_created', appSecret: secret, gateEnabled: true };
    const stored = JSON.stringify(key === 'lark.bots' ? [bot] : bot);
    const raw = JSON.stringify({ id: uuid, name: 'Bot', appId: 'cli_created', status, retryable: false, createdAt: 'now', updatedAt: 'now' });
    await h.context.config.set(key, stored);
    await h.context.config.set(`lark.app_creation.${uuid}`, raw);
    const set = vi.spyOn(h.context.config, 'set');
    const compareAndSet = vi.spyOn(h.context.config, 'compareAndSet');
    const result = await runLarkCreate(undefined, { resume: uuid, status: true, json: true }, h.context);
    expect(result.bot).toMatchObject({ appId: 'cli_created', riskControlMode: 'guidance' });
    expect(set).not.toHaveBeenCalled();
    expect(compareAndSet).not.toHaveBeenCalled();
    expect(await h.context.config.get(key)).toBe(stored);
    expect(await h.context.config.get(`lark.app_creation.${uuid}`)).toBe(raw);
    expect(h.output()).not.toContain(secret);
  }
});
