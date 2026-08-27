import { describe, expect, it, vi } from 'vitest';
import type { ConfigRepository } from '@dockmux/shared';
import { larkBotsConfigKey, publicLarkConfig, publicLarkConfigs, readLarkConfigs, saveLarkConfig } from './config.js';

const createRepository = (initial: Record<string, string> = {}): ConfigRepository => {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    get: vi.fn(async (key: string) => store.get(key)),
    set: vi.fn(async (key: string, value: string) => { store.set(key, value); })
  };
};

const seedBots = (bots: unknown[]) => createRepository({ [larkBotsConfigKey]: JSON.stringify(bots) });

describe('Lark config new-field normalization', () => {
  it('keeps valid enum values and sanitizes env / startupCommands / displayName', async () => {
    const repository = seedBots([{
      appId: 'cli_test',
      appSecret: 'secret',
      p2pMode: 'thread',
      groupReplyMode: 'chat-topic',
      brand: 'lark',
      env: { KEEP: 'v', NUM: 42, FLAG: true, NESTED: { a: 1 } },
      startupCommands: ['  /model opus  ', '', '   ', '/effort high'],
      displayName: '  展示名  '
    }]);
    const [config] = await readLarkConfigs(repository);
    expect(config.p2pMode).toBe('thread');
    expect(config.groupReplyMode).toBe('chat-topic');
    expect(config.brand).toBe('lark');
    expect(config.env).toEqual({ KEEP: 'v' });
    expect(config.startupCommands).toEqual(['/model opus', '/effort high']);
    expect(config.displayName).toBe('展示名');
  });

  it('drops invalid enum values, non-object env, non-array commands, and blank displayName', async () => {
    const repository = seedBots([{
      appId: 'cli_test',
      appSecret: 'secret',
      p2pMode: 'group',
      groupReplyMode: 'bogus',
      brand: 'wechat',
      env: 'not-an-object',
      startupCommands: 'not-an-array',
      displayName: '   '
    }]);
    const [config] = await readLarkConfigs(repository);
    expect(config.p2pMode).toBeUndefined();
    expect(config.groupReplyMode).toBeUndefined();
    expect(config.brand).toBeUndefined();
    expect(config.env).toBeUndefined();
    expect(config.startupCommands).toBeUndefined();
    expect(config.displayName).toBeUndefined();
  });

  it('drops env arrays and env objects whose values are all non-string', async () => {
    const repository = seedBots([
      { appId: 'cli_array', appSecret: 'secret', env: ['A', 'B'] },
      { appId: 'cli_numbers', appSecret: 'secret', env: { A: 1, B: false } }
    ]);
    const configs = await readLarkConfigs(repository);
    expect(configs[0].env).toBeUndefined();
    expect(configs[1].env).toBeUndefined();
  });

  it('parses legacy JSON without the new fields and leaves them undefined', async () => {
    const repository = seedBots([{ appId: 'cli_legacy', appSecret: 'secret', preInjectPrompt: '', listening: true }]);
    const [config] = await readLarkConfigs(repository);
    expect(config.appId).toBe('cli_legacy');
    expect(config.p2pMode).toBeUndefined();
    expect(config.groupReplyMode).toBeUndefined();
    expect(config.env).toBeUndefined();
    expect(config.startupCommands).toBeUndefined();
    expect(config.brand).toBeUndefined();
    expect(config.displayName).toBeUndefined();
  });
});

describe('saveLarkConfig inheritance semantics', () => {
  it('inherits new fields from current when input omits them', async () => {
    const repository = createRepository();
    await saveLarkConfig(repository, undefined, {
      appId: 'cli_test', appSecret: 'secret',
      p2pMode: 'thread', groupReplyMode: 'new-topic', brand: 'lark',
      env: { A: '1' }, startupCommands: ['/model opus'], displayName: 'dn'
    });
    await saveLarkConfig(repository, undefined, { originalAppId: 'cli_test', appId: 'cli_test', appSecret: 'secret', preInjectPrompt: 'hi' });
    const [config] = await readLarkConfigs(repository);
    expect(config.preInjectPrompt).toBe('hi');
    expect(config.p2pMode).toBe('thread');
    expect(config.groupReplyMode).toBe('new-topic');
    expect(config.brand).toBe('lark');
    expect(config.env).toEqual({ A: '1' });
    expect(config.startupCommands).toEqual(['/model opus']);
    expect(config.displayName).toBe('dn');
  });

  it('overrides new fields when input provides them', async () => {
    const repository = createRepository();
    await saveLarkConfig(repository, undefined, {
      appId: 'cli_test', appSecret: 'secret',
      p2pMode: 'thread', groupReplyMode: 'new-topic', brand: 'feishu',
      env: { A: '1' }, startupCommands: ['/model opus'], displayName: 'dn'
    });
    await saveLarkConfig(repository, undefined, {
      originalAppId: 'cli_test', appId: 'cli_test', appSecret: 'secret',
      p2pMode: 'chat', groupReplyMode: 'shared', brand: 'lark',
      env: { B: '2' }, startupCommands: ['  /effort high  '], displayName: '  new name  '
    });
    const [config] = await readLarkConfigs(repository);
    expect(config.p2pMode).toBe('chat');
    expect(config.groupReplyMode).toBe('shared');
    expect(config.brand).toBe('lark');
    expect(config.env).toEqual({ B: '2' });
    expect(config.startupCommands).toEqual(['/effort high']);
    expect(config.displayName).toBe('new name');
  });

  it('drops invalid input values instead of persisting or inheriting them', async () => {
    const repository = createRepository();
    await saveLarkConfig(repository, undefined, { appId: 'cli_test', appSecret: 'secret', p2pMode: 'thread', brand: 'lark' });
    await saveLarkConfig(repository, undefined, {
      originalAppId: 'cli_test', appId: 'cli_test', appSecret: 'secret',
      p2pMode: 'bogus', brand: 'wechat', env: { A: 1 }, startupCommands: ['  '], displayName: '  '
    });
    const [config] = await readLarkConfigs(repository);
    expect(config.p2pMode).toBeUndefined();
    expect(config.brand).toBeUndefined();
    expect(config.env).toBeUndefined();
    expect(config.startupCommands).toBeUndefined();
    expect(config.displayName).toBeUndefined();
  });
});

describe('publicLarkConfig new-field exposure', () => {
  it('exposes the new fields in the public view', async () => {
    const repository = seedBots([{
      appId: 'cli_test', appSecret: 'secret',
      p2pMode: 'thread', groupReplyMode: 'chat-topic', brand: 'lark',
      env: { A: '1' }, startupCommands: ['/model opus'], displayName: 'dn'
    }]);
    const [config] = await readLarkConfigs(repository);
    const pub = publicLarkConfig(config);
    expect(pub.p2pMode).toBe('thread');
    expect(pub.groupReplyMode).toBe('chat-topic');
    expect(pub.brand).toBe('lark');
    expect(pub.env).toEqual({ A: '1' });
    expect(pub.startupCommands).toEqual(['/model opus']);
    expect(pub.displayName).toBe('dn');
  });

  it('omits the new fields from the public view when unset', async () => {
    const repository = seedBots([{ appId: 'cli_test', appSecret: 'secret' }]);
    const [config] = await readLarkConfigs(repository);
    const pub = publicLarkConfig(config);
    expect(pub).not.toHaveProperty('p2pMode');
    expect(pub).not.toHaveProperty('groupReplyMode');
    expect(pub).not.toHaveProperty('env');
    expect(pub).not.toHaveProperty('startupCommands');
    expect(pub).not.toHaveProperty('brand');
    expect(pub).not.toHaveProperty('displayName');
  });

  it('exposes the new fields through publicLarkConfigs collection', async () => {
    const repository = seedBots([{
      appId: 'cli_test', appSecret: 'secret',
      p2pMode: 'chat', env: { A: '1' }, displayName: 'dn'
    }]);
    const configs = await readLarkConfigs(repository);
    const collection = publicLarkConfigs(configs, { activeAppIds: ['cli_test'] });
    expect(collection.configured).toBe(true);
    expect(collection.bots[0].p2pMode).toBe('chat');
    expect(collection.bots[0].env).toEqual({ A: '1' });
    expect(collection.bots[0].displayName).toBe('dn');
    expect(collection.bots[0].activeListening).toBe(true);
  });
});
