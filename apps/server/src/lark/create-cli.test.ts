import { afterEach, expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import { agentConfigSchema } from '@dutydeck/shared';
import { createCliProgram } from '../cli-program.js';
import { createCliUi } from '../cli-ui.js';
import { runLarkCreate, type LarkCreateCliResult } from './create-cli.js';
import { LarkAppCreationJobManager } from './app-creation.js';
import { LARK_COMMON_TENANT_SCOPES } from './open-platform-configurator.js';
import { readLarkConfig, saveLarkConfig } from './config.js';
import type { ConnectOpenPlatformSessionOptions } from './open-platform-session.js';

const secret = 'SECRET_CANARY_NEVER_IN_CLI';
const uuid = 'dfe543ed-a565-46af-8f04-552fd038df58';
const repos: ReturnType<typeof createRepositories>[] = [];
afterEach(() => { for (const repo of repos.splice(0)) repo.close(); });

async function harness(tty = true) {
  const repositories = createRepositories(':memory:');
  repos.push(repositories);
  await repositories.agents.save(agentConfigSchema.parse({ id: 'ccflash', name: 'CCFlash', protocol: 'pty-cli', adapterId: 'claude-code', command: process.execPath, model: 'gemini-3.8-flash-high' }));
  let stdout = ''; let stderr = '';
  const ui = createCliUi({ tty, color: false, stdout: { write: text => { stdout += text; } }, stderr: { write: text => { stderr += text; } } });
  let scopes = false; let events = false; let callbacks = false; let callbackMode = 0;
  const postJson = vi.fn(async (path: string, body?: Record<string, unknown>): Promise<unknown> => {
    if (path.includes('/manifest/upsert_by_template')) return { data: { ClientID: 'cli_created' } };
    if (path.includes('/secret/')) return { data: { secret } };
    if (path.includes('/scope/all/')) return { data: { appScopeList: LARK_COMMON_TENANT_SCOPES.map((scopeName, i) => ({ scopeId: `s-${i}`, scopeName, status: scopes ? 5 : 0 })) } };
    if (path.includes('/scope/update/')) { scopes = true; return { code: 0 }; }
    if (path.includes('/robot/switch/') || path.includes('/event/switch/')) return { code: 0 };
    if (path.includes('/event/update/')) { events = true; return { code: 0 }; }
    if (path === '/developers/v1/event/cli_created') return { data: { eventMode: 4, appEvents: events ? ['im.message.receive_v1'] : [] } };
    if (path.includes('/callback/switch/')) { callbackMode = 4; return { code: 0 }; }
    if (path.includes('/callback/update/')) { callbacks = true; return { code: 0 }; }
    if (path === '/developers/v1/callback/cli_created') return { data: { callbackMode, callbacks: callbacks ? ['card.action.trigger'] : [] } };
    if (path.includes('/app_version/list/')) return { data: { versions: [] } };
    if (path.includes('/app_version/create/')) {
      expect(body?.visibleSuggest).toMatchObject({ members: ['private-user'] });
      return { data: { versionId: 'first-version' } };
    }
    if (path.includes('/publish/commit/')) return { code: 0 };
    throw new Error(`Unexpected endpoint: ${path}`);
  });
  const postForm = vi.fn(async (_path: string, form: FormData) => {
    expect(form.get('uploadType')).toBe('4');
    return { data: { url: 'https://example.invalid/icon.png' } };
  });
  const connect = vi.fn(async (options: ConnectOpenPlatformSessionOptions = {}) => {
    expect(options.forceLogin).toBe(true);
    await options.onQrUpdate?.({ qrPayload: 'private-qr-token', status: 'waiting_for_scan' });
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

it.each([
  { json: true }, { listen: true }, { agent: 'ccflash' }, { status: true },
  { agent: 'unknown', fullTrust: true }, { agent: 'ccflash', fullTrust: true, workspace: '/nonexistent-dutydeck-fixture' },
])('rejects invalid or noninteractive creation before login: %j', async options => {
  const h = await harness();
  expect(await runLarkCreate('Bot', options, h.context)).toMatchObject({ ok: false });
  expect(h.connect).not.toHaveBeenCalled();
  expect(await h.context.config.get('lark.bots')).toBeUndefined();
});

it('rejects piped creation without starting a QR flow', async () => {
  const h = await harness(false);
  expect(await runLarkCreate('Bot', {}, h.context)).toMatchObject({ ok: false, error: expect.stringContaining('终端') });
  expect(h.connect).not.toHaveBeenCalled();
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
