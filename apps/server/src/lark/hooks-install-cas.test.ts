import Fastify from 'fastify';
import { createRepositories } from '@dutydeck/storage';
import { afterEach, expect, it, vi } from 'vitest';
import { readLarkConfig, saveLarkConfig } from './config.js';
import { registerLarkRoutes } from './routes.js';
import { installLarkHook } from './security-hooks.js';

vi.mock('./security-hooks.js', async importOriginal => ({
  ...await importOriginal<typeof import('./security-hooks.js')>(),
  installLarkHook: vi.fn(),
}));
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.resetAllMocks(); });

async function fixture() {
  const repos = createRepositories(':memory:'); cleanup.push(() => repos.close());
  await saveLarkConfig(repos.config, undefined, {
    stage: 'lark', appId: 'cli_test', appSecret: 'fixture', defaultAgentId: 'codex', fullTrustConfirmed: true, expectedRevision: 0,
  });
  const hook = { agentId: 'codex', supported: true, installed: true, writable: true, trustRequired: false };
  vi.mocked(installLarkHook).mockResolvedValue(hook);
  const app = Fastify(); cleanup.push(() => app.close());
  await registerLarkRoutes(app, { config: repos.config, listeningDisabled: true,
    listener: { listening: false, activeAppIds: [], sync: async () => {}, stop() {} },
  });
  const install = (expectedRevision: number) => app.inject({ method: 'POST', url: '/api/lark/hooks/install', payload: { appId: 'cli_test', highRiskPattern: 'rm\\b', expectedRevision } });
  return { repos, hook, install, app };
}

it.each([undefined, { fallbackAgentId: 'claude', workspace: '/draft' }])('rejects a stale hook request before changing files or configuration: %j', async draft => {
  const f = await fixture();
  const response = await f.app.inject({ method: 'POST', url: '/api/lark/hooks/install', payload: { appId: 'cli_test', expectedRevision: 0, ...(draft ? { draft } : {}) } });
  expect(response.statusCode).toBe(409);
  expect(response.json().error.code).toBe('LARK_CONFIG_REVISION_CONFLICT');
  expect(installLarkHook).not.toHaveBeenCalled();
  expect(await readLarkConfig(f.repos.config, 'cli_test')).toMatchObject({ revision: 1, riskControlMode: 'off' });
});

it('returns the exact configuration revision written by hook installation', async () => {
  const f = await fixture();
  const response = await f.install(1);
  expect(response.statusCode).toBe(200);
  expect(installLarkHook).toHaveBeenCalledExactlyOnceWith('codex', undefined, undefined);
  expect(response.json()).toMatchObject({ ...f.hook, configRevision: 2 });
  expect(await readLarkConfig(f.repos.config, 'cli_test')).toMatchObject({ revision: 2, riskControlMode: 'guidance' });
});

it('does not overwrite a concurrent configuration change while installing hook files', async () => {
  const f = await fixture();
  let started!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  vi.mocked(installLarkHook).mockImplementation(async () => { started(); await gate; return f.hook; });
  const response = f.install(1).then(value => value);
  try {
    await entered;
    await saveLarkConfig(f.repos.config, undefined, { stage: 'agent', originalAppId: 'cli_test', expectedRevision: 1, highRiskPattern: 'secret', riskControlMode: 'off' });
  } finally { release(); }
  expect((await response).statusCode).toBe(409);
  expect(await readLarkConfig(f.repos.config, 'cli_test')).toMatchObject({ revision: 2, highRiskPattern: 'secret', riskControlMode: 'off' });
});


it('prepares unsaved routing and workspace without saving or downgrading enforced configuration', async () => {
  const f = await fixture();
  await saveLarkConfig(f.repos.config, undefined, { stage: 'agent', originalAppId: 'cli_test', expectedRevision: 1, riskControlMode: 'enforced' });
  const before = await readLarkConfig(f.repos.config, 'cli_test');
  const response = await f.app.inject({ method: 'POST', url: '/api/lark/hooks/install', payload: {
    appId: 'cli_test', expectedRevision: 2, draft: { workspace: '/draft-workspace', defaultAgentId: 'claude', fallbackAgentId: 'codex', defaultAgentWeights: [{ agentId: 'pi', weight: 1 }] }
  } });
  expect(response.statusCode).toBe(200);
  expect(vi.mocked(installLarkHook).mock.calls.map(([id, workspace]) => [id, workspace])).toEqual([
    ['claude', '/draft-workspace'], ['codex', '/draft-workspace'], ['pi', '/draft-workspace']
  ]);
  expect(await readLarkConfig(f.repos.config, 'cli_test')).toEqual(before);
  expect(response.json()).not.toHaveProperty('configRevision');
});

it('never downgrades an enforced bot when reinstalling its saved hooks', async () => {
  const f = await fixture();
  await saveLarkConfig(f.repos.config, undefined, { stage: 'agent', originalAppId: 'cli_test', expectedRevision: 1, riskControlMode: 'enforced' });
  expect((await f.install(2)).statusCode).toBe(200);
  expect(await readLarkConfig(f.repos.config, 'cli_test')).toMatchObject({ riskControlMode: 'enforced', revision: 3 });
});

it.each([
  { workspace: 'relative' },
  { defaultAgentWeights: [null] },
  { fallbackAgentId: 'codex' }
])('rejects invalid preparation targets before writing hook files: %j', async draft => {
  const f = await fixture();
  const response = await f.app.inject({ method: 'POST', url: '/api/lark/hooks/install', payload: { appId: 'cli_test', expectedRevision: 1, draft } });
  expect(response.statusCode).toBe(400);
  expect(installLarkHook).not.toHaveBeenCalled();
});


it('leaves a concurrent configuration change intact during draft preparation and rejects saving the stale draft', async () => {
  const f = await fixture();
  vi.mocked(installLarkHook).mockImplementation(async () => {
    await saveLarkConfig(f.repos.config, undefined, { stage: 'agent', originalAppId: 'cli_test', expectedRevision: 1, preInjectPrompt: 'concurrent edit' });
    return f.hook;
  });
  const prepared = await f.app.inject({ method: 'POST', url: '/api/lark/hooks/install', payload: { appId: 'cli_test', expectedRevision: 1, draft: { workspace: '/draft-workspace' } } });
  expect(prepared.statusCode).toBe(200);
  expect(prepared.json()).not.toHaveProperty('configRevision');
  const saved = await f.app.inject({ method: 'PUT', url: '/api/lark/config', payload: { stage: 'agent', originalAppId: 'cli_test', expectedRevision: 1, workspace: '/draft-workspace', riskControlMode: 'enforced' } });
  expect(saved.statusCode).toBe(409);
  expect(saved.json().error.code).toBe('LARK_CONFIG_REVISION_CONFLICT');
  expect(await readLarkConfig(f.repos.config, 'cli_test')).toMatchObject({ revision: 2, preInjectPrompt: 'concurrent edit' });
});


it('does not save an enforced hook reinstall when any installed routing hook is natively unready', async () => {
  const f = await fixture();
  await saveLarkConfig(f.repos.config, undefined, { stage: 'agent', originalAppId: 'cli_test', expectedRevision: 1, fallbackAgentId: 'claude', riskControlMode: 'enforced' });
  const before = await readLarkConfig(f.repos.config, 'cli_test');
  vi.mocked(installLarkHook).mockImplementation(async agentId => ({ ...f.hook, agentId, nativeReady: agentId !== 'codex', ...(agentId === 'codex' ? { reason: '请审核 Codex 当前 Hook' } : {}) }));
  const response = await f.install(2);
  expect(response.statusCode).toBe(409);
  expect(response.json().error).toMatchObject({ code: 'RISK_CONTROL_HOOK_NOT_READY', message: '请审核 Codex 当前 Hook' });
  expect(await readLarkConfig(f.repos.config, 'cli_test')).toEqual(before);
  const prepared = await f.app.inject({ method: 'POST', url: '/api/lark/hooks/install', payload: { appId: 'cli_test', expectedRevision: 2, draft: {} } });
  expect(prepared.statusCode).toBe(200);
  expect(prepared.json()).toMatchObject({ agentId: 'codex', nativeReady: false });
  expect(await readLarkConfig(f.repos.config, 'cli_test')).toEqual(before);
});
