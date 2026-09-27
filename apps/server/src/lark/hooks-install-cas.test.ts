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
  return { repos, hook, install };
}

it('rejects a stale hook request before changing files or configuration', async () => {
  const f = await fixture();
  const response = await f.install(0);
  expect(response.statusCode).toBe(409);
  expect(response.json().error.code).toBe('LARK_CONFIG_REVISION_CONFLICT');
  expect(installLarkHook).not.toHaveBeenCalled();
  expect(await readLarkConfig(f.repos.config, 'cli_test')).toMatchObject({ revision: 1, riskControlMode: 'off' });
});

it('returns the exact configuration revision written by hook installation', async () => {
  const f = await fixture();
  const response = await f.install(1);
  expect(response.statusCode).toBe(200);
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
