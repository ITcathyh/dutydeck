import { describe, expect, it, vi } from 'vitest';
import { hostname, userInfo } from 'node:os';
import type { ConfigRepository } from '@dutydeck/shared';
import { describeWebBaseUrlReachability, larkBotsConfigKey, larkCredentialsConfigKey, larkExecutionConfirmed, larkExecutionIdentity, larkPermissionMode, publicLarkConfig, publicLarkConfigs, readLarkConfigs, saveLarkConfig } from './config.js';

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
  it('keeps a legacy configuration without permissionMode as full-trust when full trust was confirmed', async () => {
    const [config] = await readLarkConfigs(seedBots([{ appId: 'cli_legacy', appSecret: 'secret', defaultAgentId: 'codex', fullTrustConfirmed: true }]));
    expect(publicLarkConfig(config)).toMatchObject({ permissionMode: 'full-trust', fullTrustConfirmed: true, setupComplete: true });
  });

  it('defaults a bot with neither a permission mode nor a full-trust confirmation to approve-reads', async () => {
    const [config] = await readLarkConfigs(seedBots([{ appId: 'cli_legacy', appSecret: 'secret', defaultAgentId: 'codex' }]));
    expect(larkPermissionMode(config)).toBe('approve-reads');
    expect(larkExecutionConfirmed(config)).toBe(true);
    expect(publicLarkConfig(config)).toMatchObject({ permissionMode: 'approve-reads', fullTrustConfirmed: false, setupComplete: true });
  });

  it('never changes an explicit permission mode, including after the stored list is written back', async () => {
    const repository = seedBots([
      { appId: 'cli_reads', appSecret: 'secret', defaultAgentId: 'codex', permissionMode: 'approve-reads', fullTrustConfirmed: true },
      { appId: 'cli_ask', appSecret: 'secret', defaultAgentId: 'codex', permissionMode: 'ask', fullTrustConfirmed: true },
      { appId: 'cli_trust', appSecret: 'secret', defaultAgentId: 'codex', permissionMode: 'full-trust', fullTrustConfirmed: true },
      { appId: 'cli_unconfirmed', appSecret: 'secret', defaultAgentId: 'codex', permissionMode: 'full-trust' }
    ]);
    for (let read = 0; read < 2; read++) {
      const bots = await readLarkConfigs(repository);
      expect(bots.map(larkPermissionMode)).toEqual(['approve-reads', 'ask', 'full-trust', 'full-trust']);
      // 显式 full-trust 但未确认：仍按 full-trust 处理，照旧不能无人值守运行。
      expect(larkExecutionConfirmed(bots[3]!)).toBe(false);
      expect(publicLarkConfig(bots[3]!)).toMatchObject({ permissionMode: 'full-trust', setupComplete: false });
    }
    // 默认值保存一次后成为显式配置，此后照原样读回。
    const legacy = seedBots([{ appId: 'cli_legacy', appSecret: 'secret', defaultAgentId: 'codex' }]);
    await saveLarkConfig(legacy, undefined, { originalAppId: 'cli_legacy', name: '改名' });
    expect(JSON.parse((await legacy.get(larkBotsConfigKey))!)[0]).toMatchObject({ permissionMode: 'approve-reads' });
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
  it('旧配置缺省时结构化问答与群提及都开启，并在公开视图暴露布尔值', async () => {
    const [config] = await readLarkConfigs(seedBots([{ appId: 'cli_legacy', appSecret: 'secret' }]));
    expect(config.structuredAskCards).toBe(true);
    expect(config.groupCardMention).toBe(true);
    expect(publicLarkConfig(config)).toMatchObject({ structuredAskCards: true, groupCardMention: true });
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

  it('保存时显式 true 往返落库，缺省保存问答与群提及都开启', async () => {
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
    expect(configs.find(item => item.appId === 'cli_default')).toMatchObject({ structuredAskCards: true, groupCardMention: true });
    const [persistedDefault] = JSON.parse((await repository.get(larkBotsConfigKey))!).filter((bot: any) => bot.appId === 'cli_default');
    expect(persistedDefault).toMatchObject({ structuredAskCards: true, groupCardMention: true });
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
    expect(collection.bots[0]).toMatchObject({ structuredAskCards: true, groupCardMention: true });
  });

  it('显式 false 仍能关掉群提及，重新保存不会被默认值翻回来', async () => {
    const repository = createRepository();
    await saveLarkConfig(repository, undefined, { appId: 'cli_off', appSecret: 'secret', groupCardMention: false });
    await saveLarkConfig(repository, undefined, { originalAppId: 'cli_off', appId: 'cli_off', appSecret: 'secret', preInjectPrompt: 'hi' });
    const [config] = await readLarkConfigs(repository);
    expect(config.groupCardMention).toBe(false);
  });
});

describe('新机器人的 Web 地址', () => {
  // 扫码一键创建和 CLI 创建保存时都不带 webBaseUrl；没有它卡片上就没有「查看详情」。
  it('新建时没给地址就沿用已有机器人的地址', async () => {
    const repository = createRepository();
    await saveLarkConfig(repository, undefined, { appId: 'cli_first', appSecret: 'secret', webBaseUrl: 'https://dutydeck.example.com' });
    await saveLarkConfig(repository, undefined, { stage: 'lark', appId: 'cli_created', appSecret: 'secret', name: '新助手', listening: false });
    const configs = await readLarkConfigs(repository);
    expect(configs.find(item => item.appId === 'cli_created')?.webBaseUrl).toBe('https://dutydeck.example.com');
  });

  it('显式传空串不配置；已有机器人再保存时不从别的机器人继承', async () => {
    const repository = createRepository();
    await saveLarkConfig(repository, undefined, { appId: 'cli_first', appSecret: 'secret', webBaseUrl: 'https://dutydeck.example.com' });
    await saveLarkConfig(repository, undefined, { appId: 'cli_blank', appSecret: 'secret', webBaseUrl: '' });
    await saveLarkConfig(repository, undefined, { originalAppId: 'cli_blank', appId: 'cli_blank', appSecret: 'secret', preInjectPrompt: 'hi' });
    const configs = await readLarkConfigs(repository);
    expect(configs.find(item => item.appId === 'cli_blank')?.webBaseUrl).toBeUndefined();
  });

  it('第一台机器人没有可沿用的地址', async () => {
    const repository = createRepository();
    await saveLarkConfig(repository, undefined, { appId: 'cli_only', appSecret: 'secret' });
    const [config] = await readLarkConfigs(repository);
    expect(config.webBaseUrl).toBeUndefined();
  });
});

describe('compactTrace 精简过程卡开关', () => {
  it('旧配置缺省时归一化为开启，并在公开视图暴露 true', async () => {
    const [config] = await readLarkConfigs(seedBots([{ appId: 'cli_legacy', appSecret: 'secret' }]));
    expect(config.compactTrace).toBe(true);
    expect(publicLarkConfig(config)).toMatchObject({ compactTrace: true });
  });

  it('saveLarkConfig 显式 false 后持久化与读回均为 false', async () => {
    const repository = createRepository();
    await saveLarkConfig(repository, undefined, {
      appId: 'cli_compact', appSecret: 'secret', compactTrace: false
    });
    const [persisted] = JSON.parse((await repository.get(larkBotsConfigKey))!);
    expect(persisted).toMatchObject({ compactTrace: false });
    const [config] = await readLarkConfigs(repository);
    expect(config.compactTrace).toBe(false);
    expect(publicLarkConfig(config)).toMatchObject({ compactTrace: false });
  });

  it('再次保存未带开关时继承现值', async () => {
    const repository = createRepository();
    await saveLarkConfig(repository, undefined, {
      appId: 'cli_compact', appSecret: 'secret', compactTrace: false
    });
    await saveLarkConfig(repository, undefined, { originalAppId: 'cli_compact', appId: 'cli_compact', appSecret: 'secret', preInjectPrompt: 'hi' });
    const [config] = await readLarkConfigs(repository);
    expect(config.compactTrace).toBe(false);
  });
});

describe('工作目录别名表与执行身份', () => {
  it('只保留指向绝对路径的别名，空表归一化为不存在', async () => {
    const repository = seedBots([{
      appId: 'cli_test', appSecret: 'secret',
      workspaceAliases: { 项目: '  /srv/project  ', 相对: 'relative/path', 空: '   ', 数字: 42, '': '/srv/x' }
    }]);
    const [config] = await readLarkConfigs(repository);
    expect(config.workspaceAliases).toEqual({ 项目: '/srv/project' });

    const [empty] = await readLarkConfigs(seedBots([{ appId: 'cli_test', appSecret: 'secret', workspaceAliases: { 相对: 'relative' } }]));
    expect(empty.workspaceAliases).toBeUndefined();
    const [absent] = await readLarkConfigs(seedBots([{ appId: 'cli_test', appSecret: 'secret' }]));
    expect(absent.workspaceAliases).toBeUndefined();
  });

  it('保存时沿用同一套归一化，未提供时保留既有别名', async () => {
    const repository = createRepository();
    await saveLarkConfig(repository, undefined, { appId: 'cli_test', appSecret: 'secret', workspaceAliases: { 项目: '/srv/project', 坏: 'relative' } });
    let [config] = await readLarkConfigs(repository);
    expect(config.workspaceAliases).toEqual({ 项目: '/srv/project' });
    await saveLarkConfig(repository, undefined, { originalAppId: 'cli_test', appId: 'cli_test', appSecret: 'secret', preInjectPrompt: 'hi' });
    [config] = await readLarkConfigs(repository);
    expect(config.workspaceAliases).toEqual({ 项目: '/srv/project' });
    await saveLarkConfig(repository, undefined, { originalAppId: 'cli_test', appId: 'cli_test', appSecret: 'secret', workspaceAliases: {} });
    [config] = await readLarkConfigs(repository);
    expect(config.workspaceAliases).toBeUndefined();
  });

  it('执行身份给出部署这台服务的真实系统账号与主机名', () => {
    expect(larkExecutionIdentity()).toBe(`${userInfo().username}@${hostname()}`);
  });
});

describe('加急与置顶开关归一化', () => {
  it('旧配置缺省时两项都关闭，阈值字段整条缺席', async () => {
    const [config] = await readLarkConfigs(seedBots([{ appId: 'cli_legacy', appSecret: 'secret' }]));
    // 加急是飞书里的强提醒横幅，置顶会改写别人的群会话列表：升级不能替用户打开任何一个。
    expect(config.urgentEnabled).toBe(false);
    expect(config.pinLongTasks).toBe(false);
    expect(config.urgentThresholdMs).toBeUndefined();
    expect(config.urgentMaxPerHourPerChat).toBeUndefined();
    expect(config.pinAfterMs).toBeUndefined();
    expect(publicLarkConfig(config)).toMatchObject({ urgentEnabled: false, pinLongTasks: false });
  });

  it('显式打开并调阈值时往返落库，非法阈值整条丢弃回落模块默认', async () => {
    const repository = seedBots([
      { appId: 'cli_on', appSecret: 'secret', urgentEnabled: true, urgentThresholdMs: 180_000, urgentMaxPerHourPerChat: 1, pinLongTasks: true, pinAfterMs: 300_000 },
      { appId: 'cli_dirty', appSecret: 'secret', urgentEnabled: 'yes', urgentThresholdMs: -1, urgentMaxPerHourPerChat: 0, pinLongTasks: 1, pinAfterMs: 'soon' }
    ]);
    const [on, dirty] = await readLarkConfigs(repository);
    expect(on).toMatchObject({ urgentEnabled: true, urgentThresholdMs: 180_000, urgentMaxPerHourPerChat: 1, pinLongTasks: true, pinAfterMs: 300_000 });
    expect(dirty!.urgentEnabled).toBe(false);
    expect(dirty!.pinLongTasks).toBe(false);
    expect(dirty!.urgentThresholdMs).toBeUndefined();
    expect(dirty!.urgentMaxPerHourPerChat).toBeUndefined();
    expect(dirty!.pinAfterMs).toBeUndefined();
  });

  it('保存时缺省两项都关闭，显式 true 落库，再保存未带开关时继承现值', async () => {
    const repository = createRepository();
    await saveLarkConfig(repository, undefined, { appId: 'cli_default', appSecret: 'secret' });
    expect((await readLarkConfigs(repository))[0]).toMatchObject({ urgentEnabled: false, pinLongTasks: false });

    await saveLarkConfig(repository, undefined, {
      originalAppId: 'cli_default', appId: 'cli_default', appSecret: 'secret',
      urgentEnabled: true, urgentThresholdMs: 120_000, urgentMaxPerHourPerChat: 2, pinLongTasks: true, pinAfterMs: 600_000
    });
    const [persisted] = JSON.parse((await repository.get(larkBotsConfigKey))!);
    expect(persisted).toMatchObject({ urgentEnabled: true, urgentThresholdMs: 120_000, urgentMaxPerHourPerChat: 2, pinLongTasks: true, pinAfterMs: 600_000 });

    await saveLarkConfig(repository, undefined, { originalAppId: 'cli_default', appId: 'cli_default', appSecret: 'secret', preInjectPrompt: 'hi' });
    expect((await readLarkConfigs(repository))[0]).toMatchObject({ urgentEnabled: true, urgentThresholdMs: 120_000, pinLongTasks: true });

    await saveLarkConfig(repository, undefined, { originalAppId: 'cli_default', appId: 'cli_default', appSecret: 'secret', urgentEnabled: false, pinLongTasks: false });
    expect((await readLarkConfigs(repository))[0]).toMatchObject({ urgentEnabled: false, pinLongTasks: false });
  });

  it('保存越界阈值直接拒绝，而不是悄悄写进去', async () => {
    const repository = createRepository();
    await expect(saveLarkConfig(repository, undefined, { appId: 'cli_bad', appSecret: 'secret', urgentEnabled: true, urgentThresholdMs: 500 }))
      .rejects.toMatchObject({ code: 'INVALID_LARK_CONFIG' });
    await expect(saveLarkConfig(repository, undefined, { appId: 'cli_bad', appSecret: 'secret', urgentEnabled: true, urgentMaxPerHourPerChat: 0 }))
      .rejects.toMatchObject({ code: 'INVALID_LARK_CONFIG' });
    await expect(saveLarkConfig(repository, undefined, { appId: 'cli_bad', appSecret: 'secret', pinLongTasks: true, pinAfterMs: 100 }))
      .rejects.toMatchObject({ code: 'INVALID_LARK_CONFIG' });
  });
});


describe('Bot default group participation', () => {
  it.each(['off', 'observe', 'selective'] as const)('round-trips %s through storage and public config', async defaultGroupParticipation => {
    const repository = createRepository();
    await saveLarkConfig(repository, undefined, { appId: 'cli_test', appSecret: 'secret', defaultGroupParticipation });
    expect(JSON.parse((await repository.get(larkBotsConfigKey))!)[0].defaultGroupParticipation).toBe(defaultGroupParticipation);
    const [config] = await readLarkConfigs(repository);
    expect(config.defaultGroupParticipation).toBe(defaultGroupParticipation);
    expect(publicLarkConfig(config).defaultGroupParticipation).toBe(defaultGroupParticipation);
    expect(publicLarkConfigs([config]).bots[0].defaultGroupParticipation).toBe(defaultGroupParticipation);
  });

  it('defaults legacy and invalid stored values to off without changing mention or permissions', async () => {
    const configs = await readLarkConfigs(seedBots([
      { appId: 'cli_old', appSecret: 'secret', mentionPolicy: 'topic', permissionMode: 'ask' },
      { appId: 'cli_invalid', appSecret: 'secret', defaultGroupParticipation: 'always' }
    ]));
    expect(configs.map(config => config.defaultGroupParticipation)).toEqual(['off', 'off']);
    expect(publicLarkConfig(configs[0])).toMatchObject({ defaultGroupParticipation: 'off', mentionPolicy: 'topic', permissionMode: 'ask', fullTrustConfirmed: false });
    expect(publicLarkConfig({ ...configs[0], defaultGroupParticipation: undefined }).defaultGroupParticipation).toBe('off');
  });

  it('updates only participation and inherits it on later partial saves', async () => {
    const repository = seedBots([{
      appId: 'cli_test', appSecret: 'secret', permissionMode: 'ask', mentionPolicy: 'topic',
      workspace: '/srv/project', defaultAgentId: 'codex', defaultModel: 'model-a', listening: true,
      allowedUsers: [{ openId: 'ou_owner', name: 'Owner' }], groupToolsEnabled: true, groupToolsAllowSend: false
    }]);
    const [before] = await readLarkConfigs(repository);
    await saveLarkConfig(repository, undefined, { originalAppId: 'cli_test', defaultGroupParticipation: 'selective' });
    const [updated] = await readLarkConfigs(repository);
    expect(updated).toEqual({ ...before, revision: 2, defaultGroupParticipation: 'selective' });
    await saveLarkConfig(repository, undefined, { originalAppId: 'cli_test', preInjectPrompt: 'hello' });
    expect((await readLarkConfigs(repository))[0].defaultGroupParticipation).toBe('selective');
  });

  it.each(['always', '', null, 1])('rejects invalid input %s without saving', async value => {
    const repository = seedBots([{ appId: 'cli_test', appSecret: 'secret', riskControlMode: 'off' }]);
    const before = await repository.get(larkBotsConfigKey);
    await expect(saveLarkConfig(repository, undefined, {
      originalAppId: 'cli_test', defaultGroupParticipation: value as 'off'
    })).rejects.toMatchObject({ code: 'INVALID_LARK_CONFIG', statusCode: 400 });
    expect(await repository.get(larkBotsConfigKey)).toBe(before);
  });
});

describe('分层协作执行方式', () => {
  const terminal: Record<string, object> = { 'cli-leader': { protocol: 'pty-cli', permissionMode: 'ask' }, 'trusted-cli': { protocol: 'pty-cli', permissionMode: 'full-trust' }, 'legacy-pty': { protocol: 'pty', permissionMode: 'full-trust' } };
  const agents = { get: vi.fn(async (id: string) => ['pmo', 'leader', 'worker'].includes(id) ? { id, protocol: 'acp' } : terminal[id] ? { id, ...terminal[id] } : undefined) } as any;
  const base = { appId: 'cli_layered', appSecret: 'secret', groupToolsEnabled: true };

  it('defaults to single and keeps the Leader and Worker selections when switching back', async () => {
    const repository = createRepository();
    await saveLarkConfig(repository, agents, base);
    expect(publicLarkConfig((await readLarkConfigs(repository))[0]!)).toMatchObject({ executionMode: 'single', workerAgentIds: [] });
    await saveLarkConfig(repository, agents, { ...base, originalAppId: 'cli_layered', executionMode: 'layered', leaderAgentId: ' leader ', workerAgentIds: ['worker', ' worker ', ''] });
    const [layered] = await readLarkConfigs(repository);
    expect(layered).toMatchObject({ executionMode: 'layered', leaderAgentId: 'leader', workerAgentIds: ['worker'] });
    await saveLarkConfig(repository, agents, { ...base, originalAppId: 'cli_layered', executionMode: 'single' });
    const [single] = await readLarkConfigs(repository);
    expect(single.executionMode).toBeUndefined();
    expect(publicLarkConfig(single)).toMatchObject({ executionMode: 'single', leaderAgentId: 'leader', workerAgentIds: ['worker'] });
  });

  it.each([
    ['group tools off', { groupToolsEnabled: false, leaderAgentId: 'leader', workerAgentIds: ['worker'] }, '群工具'],
    ['missing Leader', { leaderAgentId: '', workerAgentIds: ['worker'] }, 'Leader'],
    ['no Worker', { leaderAgentId: 'leader', workerAgentIds: [] }, 'Worker'],
    ['too many Workers', { leaderAgentId: 'leader', workerAgentIds: Array.from({ length: 9 }, (_, index) => `worker${index}`) }, 'Worker'],
    ['unknown Agent', { leaderAgentId: 'leader', workerAgentIds: ['ghost'] }, 'ghost'],
    ['a terminal Leader that is not full trust', { leaderAgentId: 'cli-leader', workerAgentIds: ['worker'] }, '完全信任'],
    ['a full-trust terminal Leader on an ask Bot', { permissionMode: 'ask', leaderAgentId: 'trusted-cli', workerAgentIds: ['worker'] }, '完全信任'],
    ['a legacy PTY Leader', { leaderAgentId: 'legacy-pty', workerAgentIds: ['worker'] }, '旧版 PTY'],
    ['unknown mode', { executionMode: 'swarm', leaderAgentId: 'leader', workerAgentIds: ['worker'] }, '执行方式']
  ])('rejects layered mode with %s', async (_name, input, message) => {
    await expect(saveLarkConfig(createRepository(), agents, { ...base, executionMode: 'layered', ...input } as any))
      .rejects.toMatchObject({ code: 'INVALID_LARK_CONFIG', statusCode: 400, message: expect.stringContaining(message) });
  });

  it('accepts a terminal Leader when the Bot and the Agent are both full trust', async () => {
    const repository = createRepository();
    await saveLarkConfig(repository, agents, { ...base, executionMode: 'layered', leaderAgentId: 'trusted-cli', workerAgentIds: ['worker'] });
    expect((await readLarkConfigs(repository))[0]).toMatchObject({ executionMode: 'layered', leaderAgentId: 'trusted-cli' });
  });

  it('checks the roster only when it is submitted, so a deleted Worker does not block other saves', async () => {
    const repository = createRepository();
    await saveLarkConfig(repository, agents, { ...base, executionMode: 'layered', leaderAgentId: 'leader', workerAgentIds: ['worker', 'pmo'] });
    const afterDelete = { get: vi.fn(async (id: string) => id === 'pmo' ? undefined : agents.get(id)) } as any;
    await saveLarkConfig(repository, afterDelete, { originalAppId: 'cli_layered', stage: 'lark', pushIntervalMs: 2000 });
    expect((await readLarkConfigs(repository))[0]).toMatchObject({ pushIntervalMs: 2000, workerAgentIds: ['worker', 'pmo'] });
    await expect(saveLarkConfig(repository, afterDelete, { originalAppId: 'cli_layered', executionMode: 'layered', leaderAgentId: 'leader', workerAgentIds: ['worker', 'pmo'] }))
      .rejects.toMatchObject({ code: 'INVALID_LARK_CONFIG', message: expect.stringContaining('pmo') });
    await saveLarkConfig(repository, afterDelete, { originalAppId: 'cli_layered', executionMode: 'layered', leaderAgentId: 'leader', workerAgentIds: ['worker'] });
    expect((await readLarkConfigs(repository))[0]).toMatchObject({ workerAgentIds: ['worker'] });
  });
});
