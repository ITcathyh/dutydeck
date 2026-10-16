import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepositories } from '@dutydeck/storage';
import { buildApp } from '../app.js';
import { larkBotsConfigKey } from './config.js';

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean(); });

it('lets Agents launched with the process guard enable enforced risk control without a workspace hook', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dutydeck-risk-routes-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const repos = createRepositories(join(directory, 'test.sqlite'));
  cleanups.push(() => repos.close());
  for (const [id, adapterId] of [['ccflash', 'claude-code'], ['genius-custom', 'genius']]) {
    await repos.agents.save({ id, name: id, command: 'claude', protocol: 'pty-cli', adapterId, permissionMode: 'full-trust', timeout: 60, capabilities: { pause: false, resume: true }, builtin: false } as any);
  }
  const bot = (appId: string, defaultAgentId: string) => ({ appId, appSecret: 'fake', listening: false, permissionMode: 'full-trust', defaultAgentId, workspace: directory });
  await repos.config.set(larkBotsConfigKey, JSON.stringify([bot('cli_guarded', 'ccflash'), bot('cli_plain', 'genius-custom')]));
  const fetcher = vi.fn(async () => { throw new Error('Unexpected network'); });
  const app = await buildApp({} as any, { lark: { env: { DUTYDECK_DISABLE_LARK_LISTENER: 'true' }, config: repos.config, agents: repos.agents, fetcher } });
  cleanups.push(() => app.close());
  expect((await app.inject({ method: 'GET', url: '/api/lark/hooks/status?appId=cli_guarded' })).json()).toMatchObject({ supported: true, installed: true, trustRequired: false });
  const enforced = await app.inject({ method: 'PUT', url: '/api/lark/config', payload: { originalAppId: 'cli_guarded', riskControlMode: 'enforced' } });
  expect(enforced.statusCode).toBe(200);
  expect(enforced.json().bots.find((item: { appId: string }) => item.appId === 'cli_guarded')).toMatchObject({ riskControlMode: 'enforced' });
  const refused = await app.inject({ method: 'PUT', url: '/api/lark/config', payload: { originalAppId: 'cli_plain', riskControlMode: 'enforced' } });
  expect(refused.statusCode).toBe(409);
  expect(refused.json().error.code).toBe('RISK_CONTROL_HOOK_NOT_READY');
  expect(fetcher).not.toHaveBeenCalled();
});
