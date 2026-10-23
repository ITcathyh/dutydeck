import { afterEach, expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import { buildApp } from '../app.js';
import { larkBotsConfigKey, readLarkConfig } from './config.js';

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

it('rejects invalid reply/routing enums over HTTP without changing the saved values or revision', async () => {
  const repos = createRepositories(':memory:'); cleanups.push(() => repos.close());
  await repos.config.set(larkBotsConfigKey, JSON.stringify([{ appId: 'cli_modes', appSecret: 'fixture', defaultAgentId: 'codex', permissionMode: 'ask', p2pMode: 'thread', groupReplyMode: 'shared', groupMemoryScope: 'per-group', brand: 'lark', revision: 4 }]));
  const app = await buildApp({} as any, { lark: { config: repos.config, listeningDisabled: true, fetcher: vi.fn(async () => { throw new Error('Unexpected network'); }) } });
  cleanups.push(() => app.close());
  const before = await readLarkConfig(repos.config, 'cli_modes');
  for (const field of ['p2pMode', 'groupReplyMode', 'groupMemoryScope', 'brand']) for (const value of ['invalid', '', 1, {}, ...(field === 'groupReplyMode' ? [] : [null])]) {
    const response = await app.inject({ method: 'PUT', url: '/api/lark/config', payload: { stage: 'agent', originalAppId: 'cli_modes', expectedRevision: 4, [field]: value } });
    expect(response.statusCode, `${field}=${JSON.stringify(value)}`).toBe(400);
    expect(response.json().error.code).toBe('INVALID_LARK_CONFIG');
    expect(await readLarkConfig(repos.config, 'cli_modes')).toEqual(before);
  }
  for (const groupReplyMode of ['chat', 'shared', 'new-topic', 'chat-topic', null]) {
    const response = await app.inject({ method: 'PUT', url: '/api/lark/config', payload: { stage: 'agent', originalAppId: 'cli_modes', groupReplyMode, p2pMode: 'chat' } });
    expect(response.statusCode).toBe(200);
    if (groupReplyMode === null) expect(response.json().bots[0]).not.toHaveProperty('groupReplyMode');
    else expect(response.json().bots[0]).toMatchObject({ groupReplyMode });
  }
});
