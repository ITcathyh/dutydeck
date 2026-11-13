import { afterEach, expect, it } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import { agentConfigSchema } from '@dutydeck/shared';
import { buildApp } from '../app.js';
import { larkBotsConfigKey, readLarkConfig } from './config.js';

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

it('validates and persists independent default-off polishing settings through HTTP and clears a model when changing Agent', async () => {
  const repos = createRepositories(':memory:'); cleanups.push(() => repos.close());
  await repos.config.set(larkBotsConfigKey, JSON.stringify([{ appId: 'cli_polish', appSecret: 'fake', listening: false, riskControlMode: 'off', defaultModel: 'primary-model' }]));
  for (const id of ['editor', 'other', 'terminal']) await repos.agents.save(agentConfigSchema.parse({ id, name: id, command: 'mock', protocol: id === 'terminal' ? 'pty-cli' : 'acp' }));
  const app = await buildApp({} as any, { lark: { env: { DUTYDECK_DISABLE_LARK_LISTENER: 'true' }, config: repos.config, agents: repos.agents } });
  cleanups.push(() => app.close());
  const patch = (body: Record<string, unknown>) => app.inject({ method: 'PUT', url: '/api/lark/config', payload: { originalAppId: 'cli_polish', ...body } });
  expect((await app.inject({ method: 'GET', url: '/api/lark/config' })).json().bots[0]).toMatchObject({ replyPolishEnabled: false, replyPolishTimeoutMs: 60_000 });
  for (const invalid of [{ replyPolishEnabled: true }, { replyPolishEnabled: 'yes' }, { replyPolishAgentId: 42 }, { replyPolishModel: null }, { replyPolishTimeoutMs: 0 }, { replyPolishTimeoutMs: -1 }, { replyPolishTimeoutMs: 1.5 }, { replyPolishTimeoutMs: 2_147_483_648 }, { replyPolishTimeoutMs: '120000' },
    { replyPolishEnabled: true, replyPolishAgentId: 'missing' }, { replyPolishEnabled: true, replyPolishAgentId: 'terminal' }]) {
    const before = await repos.config.get(larkBotsConfigKey);
    expect((await patch(invalid)).statusCode).toBe(400);
    expect(await repos.config.get(larkBotsConfigKey)).toBe(before);
  }
  const fields = { replyPolishEnabled: true, replyPolishAgentId: 'editor', replyPolishModel: 'editor-model', replyPolishTimeoutMs: 120_000 };
  expect((await patch(fields)).json().bots[0]).toMatchObject(fields);
  expect(await readLarkConfig(repos.config, 'cli_polish')).toMatchObject({ ...fields, defaultModel: 'primary-model' });
  expect((await patch({ preInjectPrompt: 'preserve editor' })).json().bots[0]).toMatchObject(fields);
  const switched = (await patch({ replyPolishAgentId: 'other' })).json().bots[0];
  expect(switched).toMatchObject({ replyPolishEnabled: true, replyPolishAgentId: 'other', defaultModel: 'primary-model' });
  expect(switched).not.toHaveProperty('replyPolishModel');
  const cleared = (await patch({ replyPolishEnabled: false, replyPolishAgentId: '', replyPolishModel: ' ' })).json().bots[0];
  expect(cleared).toMatchObject({ replyPolishEnabled: false, replyPolishTimeoutMs: 120_000 });
  expect((await patch({ replyPolishTimeoutMs: null })).json().bots[0]).toMatchObject({ replyPolishEnabled: false, replyPolishTimeoutMs: 60_000 });
  expect(await readLarkConfig(repos.config, 'cli_polish')).not.toHaveProperty('replyPolishTimeoutMs');
  expect(cleared).not.toHaveProperty('replyPolishAgentId');
  expect(cleared).not.toHaveProperty('replyPolishModel');
});
