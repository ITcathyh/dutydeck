import { afterEach, expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import { buildApp } from '../app.js';
import { larkBotsConfigKey } from './config.js';

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean(); });

it('round-trips independent models through HTTP partial updates, lists, and clears without network access', async () => {
  const repos = createRepositories(':memory:'); cleanups.push(() => repos.close());
  await repos.config.set(larkBotsConfigKey, JSON.stringify([{ appId: 'cli_roles', appSecret: 'fake', listening: false, riskControlMode: 'off', memoryAgentId: 'legacy', memoryModel: 'legacy-model' }]));
  const fetcher = vi.fn(async () => { throw new Error('Unexpected network'); });
  const app = await buildApp({} as any, { lark: { env: { DUTYDECK_DISABLE_LARK_LISTENER: 'true' }, config: repos.config, fetcher } });
  cleanups.push(() => app.close());
  const roles = { decisionAgentId: 'classifier', decisionModel: 'fast', responseAgentId: 'writer', responseModel: 'quality' };
  const saved = await app.inject({ method: 'PUT', url: '/api/lark/config', payload: { originalAppId: 'cli_roles', ...roles } });
  expect(saved.statusCode).toBe(200); expect(saved.json().bots[0]).toMatchObject(roles);
  expect((await app.inject({ method: 'GET', url: '/api/lark/config' })).json().bots[0]).toMatchObject(roles);
  const partial = await app.inject({ method: 'PUT', url: '/api/lark/config', payload: { originalAppId: 'cli_roles', responseModel: 'new-quality' } });
  expect(partial.json().bots[0]).toMatchObject({ ...roles, responseModel: 'new-quality' });
  const cleared = await app.inject({ method: 'PUT', url: '/api/lark/config', payload: { originalAppId: 'cli_roles', decisionAgentId: '', decisionModel: '', responseAgentId: '', responseModel: '' } });
  expect(cleared.statusCode).toBe(200);
  for (const key of Object.keys(roles)) expect(cleared.json().bots[0]).not.toHaveProperty(key);
  expect(cleared.json().bots[0]).toMatchObject({ memoryAgentId: 'legacy', memoryModel: 'legacy-model' });
  expect(fetcher).not.toHaveBeenCalled();
});
