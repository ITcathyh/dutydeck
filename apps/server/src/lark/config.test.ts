import { describe, expect, it, vi } from 'vitest';
import type { ConfigRepository } from '@dutydeck/shared';
import { describeWebBaseUrlReachability, larkBotsConfigKey, larkCredentialsConfigKey, publicLarkConfig, publicLarkConfigs, readLarkConfigs, saveLarkConfig } from './config.js';

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

describe('Lark risk-control migration', () => {
  it('defaults a completely missing legacy configuration to off and writes only the new field', async () => {
    const repository = seedBots([{ appId: 'cli_legacy', appSecret: 'secret' }]);

    const [config] = await readLarkConfigs(repository);

    expect(config.riskControlMode).toBe('off');
    const [persisted] = JSON.parse((await repository.get(larkBotsConfigKey))!);
    expect(persisted.riskControlMode).toBe('off');
    expect(persisted).not.toHaveProperty('gateEnabled');
    expect(persisted).not.toHaveProperty('softGateEnabled');
    expect(persisted).not.toHaveProperty('hardGateEnabled');
    expect(persisted).not.toHaveProperty('hookTrustConfirmed');
  });

  it.each([
    [{ gateEnabled: true }, 'guidance'],
    [{ softGateEnabled: true }, 'guidance'],
    [{ gateEnabled: false, hardGateEnabled: true }, 'off'],
    [{ riskControlMode: 'off', hardGateEnabled: true }, 'off']
  ] as const)('normalizes legacy fields %# to %s', async (legacy, expected) => {
    const repository = seedBots([{ appId: 'cli_legacy', appSecret: 'secret', ...legacy }]);

    const [config] = await readLarkConfigs(repository);

    expect(config.riskControlMode).toBe(expected);
    const [persisted] = JSON.parse((await repository.get(larkBotsConfigKey))!);
    expect(persisted.riskControlMode).toBe(expected);
    expect(persisted).not.toHaveProperty('gateEnabled');
    expect(persisted).not.toHaveProperty('softGateEnabled');
    expect(persisted).not.toHaveProperty('hardGateEnabled');
    expect(persisted).not.toHaveProperty('hookTrustConfirmed');
  });

  it('accepts old API input at the save boundary and persists only riskControlMode', async () => {
    const repository = createRepository();
    await saveLarkConfig(repository, undefined, { appId: 'cli_legacy', appSecret: 'secret', gateEnabled: true, hardGateEnabled: true });

    const [config] = await readLarkConfigs(repository);

    expect(config.riskControlMode).toBe('enforced');
    const [persisted] = JSON.parse((await repository.get(larkBotsConfigKey))!);
    expect(persisted).toMatchObject({ riskControlMode: 'enforced' });
    expect(persisted).not.toHaveProperty('gateEnabled');
    expect(persisted).not.toHaveProperty('softGateEnabled');
    expect(persisted).not.toHaveProperty('hardGateEnabled');
    expect(persisted).not.toHaveProperty('hookTrustConfirmed');
  });

  it('moves the single-bot credential record into the normalized collection', async () => {
    const repository = createRepository({
      [larkCredentialsConfigKey]: JSON.stringify({ appId: 'cli_credential', appSecret: 'secret', softGateEnabled: true })
    });

    const [config] = await readLarkConfigs(repository);

    expect(config.riskControlMode).toBe('guidance');
    const [persisted] = JSON.parse((await repository.get(larkBotsConfigKey))!);
    expect(persisted).toMatchObject({ appId: 'cli_credential', riskControlMode: 'guidance' });
    expect(persisted).not.toHaveProperty('softGateEnabled');
  });

  it('exposes only riskControlMode in the public API view', async () => {
    const repository = seedBots([{ appId: 'cli_test', appSecret: 'secret', hardGateEnabled: true, hookTrustConfirmed: true }]);
    const [config] = await readLarkConfigs(repository);

    const publicConfig = publicLarkConfig(config);

    expect(publicConfig.riskControlMode).toBe('enforced');
    expect(publicConfig).not.toHaveProperty('gateEnabled');
    expect(publicConfig).not.toHaveProperty('softGateEnabled');
    expect(publicConfig).not.toHaveProperty('hardGateEnabled');
    expect(publicConfig).not.toHaveProperty('hookTrustConfirmed');
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
  it('exposes safe new fields but never returns Agent environment credentials', async () => {
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
    expect(pub).not.toHaveProperty('env');
    expect(pub).not.toHaveProperty('startupCommands');
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
    expect(collection.bots[0]).not.toHaveProperty('env');
    expect(collection.bots[0].displayName).toBe('dn');
    expect(collection.bots[0].activeListening).toBe(true);
  });
});

describe('Lark permission posture persistence', () => {
  it('treats a legacy configuration without permissionMode as full-trust', async () => {
    const [config] = await readLarkConfigs(seedBots([{ appId: 'cli_legacy', appSecret: 'secret', defaultAgentId: 'codex' }]));
    expect(publicLarkConfig(config)).toMatchObject({ permissionMode: 'full-trust', fullTrustConfirmed: false, setupComplete: false });
  });

  it('allows ask mode without full-trust confirmation and marks the setup complete', async () => {
    const repository = createRepository();
    await expect(saveLarkConfig(repository, undefined, {
      appId: 'cli_ask', appSecret: 'secret', stage: 'agent', defaultAgentId: 'codex', permissionMode: 'ask', fullTrustConfirmed: false
    })).resolves.toHaveLength(1);
    const [config] = await readLarkConfigs(repository);
    expect(config).toMatchObject({ permissionMode: 'ask', fullTrustConfirmed: false });
    expect(publicLarkConfig(config)).toMatchObject({ permissionMode: 'ask', setupComplete: true });
  });

  it('rejects unsupported permission modes at the save boundary', async () => {
    await expect(saveLarkConfig(createRepository(), undefined, {
      appId: 'cli_invalid', appSecret: 'secret', permissionMode: 'approve-all' as any
    })).rejects.toMatchObject({ code: 'INVALID_LARK_CONFIG', statusCode: 400 });
  });
});

describe('describeWebBaseUrlReachability S7 分类矩阵', () => {
  it('未配置：空串、空白、null/undefined 归 unset 且带提示', () => {
    for (const value of [undefined, null, '', '   ', '\t']) {
      const result = describeWebBaseUrlReachability(value);
      expect(result.kind).toBe('unset');
      expect(result.message).toContain('未配置公网 Web 地址');
    }
  });

  it.each([
    ['http://localhost'],
    ['https://localhost:8080'],
    ['localhost:3000'],
    ['127.0.0.1'],
    ['https://127.0.0.1:3000/'],
    ['127.1.2.3'],
    ['0.0.0.0'],
    ['http://0.0.0.0:8080'],
    ['https://[::1]/'],
    ['machine.local'],
    ['10.0.0.1'],
    ['10.255.255.255'],
    ['192.168.1.1'],
    ['172.16.0.1'],
    ['172.31.255.255'],
    ['169.254.10.20'],
    ['http://[fe80::1]']
  ])('本机/内网地址 %s 归 local 且带提示', value => {
    const result = describeWebBaseUrlReachability(value);
    expect(result.kind).toBe('local');
    expect(result.message).toContain('内网');
  });

  it.each([
    ['172.15.255.255'],
    ['172.32.0.1'],
    ['8.8.8.8'],
    ['http://1.1.1.1'],
    ['dutydeck.example.com'],
    ['https://dutydeck.example.com/path'],
    ['https://dutydeck.example.com/'],
    // 路径/参数里自带 URL（含 ://）是合法公网地址，畸形守护只看主机段，不能误伤。
    ['https://dutydeck.example.com/?redirect=https://other.example.com'],
    ['https://dutydeck.example.com/path#https://other.example.com']
  ])('公网域名/IP %s 归 public 且无提示', value => {
    const result = describeWebBaseUrlReachability(value);
    expect(result.kind).toBe('public');
    expect(result.message).toBeUndefined();
  });

  it('畸形输入无法渲染成可用出口，归 local 并给出专属提示', () => {
    for (const value of ['https://', 'not a url', 'ftp://dutydeck.example.com']) {
      const result = describeWebBaseUrlReachability(value);
      expect(result.kind).toBe('local');
      expect(result.message).toContain('合法的 http(s) 链接');
    }
  });

  it('归一化存储态的非 http(s) 补协议产物（含第二个 ://）同样判畸形，不漏报', () => {
    // normalizeWebBaseUrl('ftp://dutydeck.example.com') 的实际存储值；启动日志拿到的是存储态。
    for (const value of ['https://ftp://dutydeck.example.com', 'http://ssh://dutydeck.example.com']) {
      const result = describeWebBaseUrlReachability(value);
      expect(result.kind).toBe('local');
      expect(result.message).toContain('合法的 http(s) 链接');
    }
  });
});

describe('Lark 实验卡片开关归一化', () => {
  it('旧配置缺省两个开关时读回均为 false，并在公开视图暴露布尔值', async () => {
    const [config] = await readLarkConfigs(seedBots([{ appId: 'cli_legacy', appSecret: 'secret' }]));
    expect(config.structuredAskCards).toBe(false);
    expect(config.groupCardMention).toBe(false);
    expect(publicLarkConfig(config)).toMatchObject({ structuredAskCards: false, groupCardMention: false });
  });

  it('存量配置显式 true 时归一化保留 true，非布尔脏值回落 false', async () => {
    const repository = seedBots([
      { appId: 'cli_on', appSecret: 'secret', structuredAskCards: true, groupCardMention: true },
      { appId: 'cli_dirty', appSecret: 'secret', structuredAskCards: 'yes', groupCardMention: 1 }
    ]);
    const [on, dirty] = await readLarkConfigs(repository);
    expect(on!.structuredAskCards).toBe(true);
    expect(on!.groupCardMention).toBe(true);
    expect(dirty!.structuredAskCards).toBe(false);
    expect(dirty!.groupCardMention).toBe(false);
  });

  it('保存时显式 true 往返落库，缺省保存按 false 落库', async () => {
    const repository = createRepository();
    await saveLarkConfig(repository, undefined, {
      appId: 'cli_test', appSecret: 'secret', structuredAskCards: true, groupCardMention: true
    });
    const [config] = await readLarkConfigs(repository);
    expect(config.structuredAskCards).toBe(true);
    expect(config.groupCardMention).toBe(true);
    const [persisted] = JSON.parse((await repository.get(larkBotsConfigKey))!);
    expect(persisted).toMatchObject({ structuredAskCards: true, groupCardMention: true });

    await saveLarkConfig(repository, undefined, { appId: 'cli_default', appSecret: 'secret' });
    const configs = await readLarkConfigs(repository);
    expect(configs.find(item => item.appId === 'cli_default')).toMatchObject({ structuredAskCards: false, groupCardMention: false });
    const [persistedDefault] = JSON.parse((await repository.get(larkBotsConfigKey))!).filter((bot: any) => bot.appId === 'cli_default');
    expect(persistedDefault).toMatchObject({ structuredAskCards: false, groupCardMention: false });
  });

  it('再次保存未带开关时继承现值；显式 false 可以关闭已开启项', async () => {
    const repository = createRepository();
    await saveLarkConfig(repository, undefined, {
      appId: 'cli_test', appSecret: 'secret', structuredAskCards: true, groupCardMention: true
    });
    await saveLarkConfig(repository, undefined, { originalAppId: 'cli_test', appId: 'cli_test', appSecret: 'secret', preInjectPrompt: 'hi' });
    let [config] = await readLarkConfigs(repository);
    expect(config.structuredAskCards).toBe(true);
    expect(config.groupCardMention).toBe(true);

    await saveLarkConfig(repository, undefined, { originalAppId: 'cli_test', appId: 'cli_test', appSecret: 'secret', structuredAskCards: false });
    [config] = await readLarkConfigs(repository);
    expect(config.structuredAskCards).toBe(false);
    expect(config.groupCardMention).toBe(true);
  });

  it('公开集合视图同样暴露两个开关', async () => {
    const repository = seedBots([{ appId: 'cli_test', appSecret: 'secret', structuredAskCards: true }]);
    const collection = publicLarkConfigs(await readLarkConfigs(repository));
    expect(collection.bots[0]).toMatchObject({ structuredAskCards: true, groupCardMention: false });
  });
});
