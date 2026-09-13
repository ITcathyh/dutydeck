import { describe, expect, it, vi } from 'vitest';
import { larkCommandRegistry } from './commands.js';
import {
  buildWelcomeCardContent,
  createLarkWelcomeService,
  welcomedDedupeKey
} from './welcome.js';

const fullCapabilities = {
  getSession: true, send: true, dispatch: true, interrupt: true, cancelQueued: true,
  stop: true, getTasks: true, listAgents: true, listSessions: true
} as const;

describe('welcomedDedupeKey', () => {
  it('对齐仓内 lark.xxx.${appId}.${id} 键风格', () => {
    expect(welcomedDedupeKey('cli_a', 'oc_b')).toBe('lark.welcomed.cli_a.oc_b');
  });
});

describe('buildWelcomeCardContent', () => {
  it('群欢迎卡说明群里要 @，命令简介来自 registry 而非平行文案表', () => {
    const card = buildWelcomeCardContent({ chatType: 'group', capabilities: { ...fullCapabilities } });
    expect(card.title).toBe('Dutydeck 机器人已入群');
    expect(card.markdown).toContain('@我');
    expect(card.markdown).toContain('/help');
    for (const line of card.markdown.split('\n')) {
      // 只校验命令行（页脚里的 `/help` 是引导文案，不要求带摘要）。
      const match = /^\*\*`\/(\w+)`\*\*/.exec(line);
      if (!match) continue;
      const name = match[1]!;
      expect(larkCommandRegistry.some(command => command.name === name || command.aliases?.includes(name))).toBe(true);
      // 摘要必须与 registry 一致。
      const definition = larkCommandRegistry.find(command => command.name === name);
      expect(line).toContain(definition!.summary);
    }
    // 元素只用 markdown（schema 2.0 拒绝 note）。
    expect(card.elements.every(element => element.tag === 'markdown')).toBe(true);
  });

  it('私聊欢迎卡不要求 @，并引导直接发任务', () => {
    const card = buildWelcomeCardContent({ chatType: 'p2p', capabilities: { ...fullCapabilities } });
    expect(card.markdown).toContain('直接给我发消息');
    expect(card.markdown).not.toContain('@我');
    expect(card.markdown).toContain('/new');
  });

  it('无能力信息时只承诺无能力门的 /help，不列出可能不可用的命令', () => {
    const card = buildWelcomeCardContent({ chatType: 'p2p' });
    expect(card.markdown).toContain('/help');
    expect(card.markdown).not.toContain('/new');
    expect(card.markdown).not.toContain('/status');
  });
});

describe('createLarkWelcomeService', () => {
  const kvWithRecords = (records: Record<string, string> = {}) => {
    const store = new Map(Object.entries(records));
    return {
      get: vi.fn(async (key: string) => store.get(key)),
      set: vi.fn(async (key: string, value: string) => { store.set(key, value); }),
      compareAndSet: vi.fn(async (key: string, expected: string | undefined, value: string) => {
        if (store.get(key) !== expected) return false;
        store.set(key, value);
        return true;
      }),
      snapshot: () => [...store.entries()]
    };
  };

  it('bot 入群只发一次欢迎；重复事件被 CAS 去重', async () => {
    const kv = kvWithRecords();
    const send = vi.fn(async () => {});
    const service = createLarkWelcomeService({ appId: 'cli_a', kv, send, capabilities: { ...fullCapabilities } });

    await service.welcomeBotAdded('oc_group');
    await service.welcomeBotAdded('oc_group');

    expect(send).toHaveBeenCalledTimes(1);
    expect(kv.compareAndSet).toHaveBeenCalledWith('lark.welcomed.cli_a.oc_group', undefined, expect.any(String));
    const content = send.mock.calls[0]![1];
    expect(content.title).toBe('Dutydeck 机器人已入群');
  });

  it('重启后 kv 已有记录时不重发欢迎', async () => {
    const kv = kvWithRecords({ 'lark.welcomed.cli_a.oc_old': JSON.stringify({ at: '2026-09-12T00:00:00.000Z' }) });
    const send = vi.fn(async () => {});
    const service = createLarkWelcomeService({ appId: 'cli_a', kv, send });

    await service.welcomeBotAdded('oc_old');

    expect(send).not.toHaveBeenCalled();
  });

  it('群聊普通消息不触发私聊欢迎；只有 p2p 会话首次消息才发私聊欢迎', async () => {
    const kv = kvWithRecords();
    const send = vi.fn(async () => {});
    const service = createLarkWelcomeService({ appId: 'cli_a', kv, send, capabilities: { ...fullCapabilities } });

    // 群消息路径根本不调用 welcomeP2pChat；这里直接验证 p2p 与群使用互不串扰的键。
    await service.welcomeP2pChat('ou_dm');
    await service.welcomeP2pChat('ou_dm');
    await service.welcomeBotAdded('oc_group');

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]![1].title).toBe('欢迎使用 Dutydeck');
    expect(send.mock.calls[1]![1].title).toBe('Dutydeck 机器人已入群');
    expect(kv.snapshot().map(([key]) => key).sort()).toEqual([
      'lark.welcomed.cli_a.oc_group',
      'lark.welcomed.cli_a.ou_dm'
    ]);
  });

  it('欢迎发送失败不抛出且不重发（标记已认领）', async () => {
    const kv = kvWithRecords();
    const warn = vi.fn();
    const send = vi.fn(async () => { throw new Error('open api 500'); });
    const service = createLarkWelcomeService({ appId: 'cli_a', kv, send, log: { warn } });

    await expect(service.welcomeP2pChat('ou_dm')).resolves.toBeUndefined();
    await service.welcomeP2pChat('ou_dm');

    expect(send).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ chatId: 'ou_dm' }), expect.stringContaining('欢迎卡失败'));
  });

  it('kv 不支持 CAS 时退化为 get/set，已有记录同样不重发', async () => {
    const store = new Map<string, string>();
    const kv = {
      get: vi.fn(async (key: string) => store.get(key)),
      set: vi.fn(async (key: string, value: string) => { store.set(key, value); })
    };
    const send = vi.fn(async () => {});
    const service = createLarkWelcomeService({ appId: 'cli_a', kv, send });

    await service.welcomeBotAdded('oc_group');
    await service.welcomeBotAdded('oc_group');

    expect(send).toHaveBeenCalledTimes(1);
    expect(kv.get).toHaveBeenCalledWith('lark.welcomed.cli_a.oc_group');
  });

  it('kv 读取异常时跳过欢迎且不抛出', async () => {
    const kv = {
      get: vi.fn(async () => { throw new Error('kv down'); }),
      set: vi.fn(async () => {}),
      compareAndSet: vi.fn(async () => { throw new Error('kv down'); })
    };
    const send = vi.fn(async () => {});
    const warn = vi.fn();
    const service = createLarkWelcomeService({ appId: 'cli_a', kv, send, log: { warn } });

    await expect(service.welcomeP2pChat('ou_dm')).resolves.toBeUndefined();
    expect(send).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ chatId: 'ou_dm' }), expect.stringContaining('去重标记失败'));
  });

  it('空 chatId 直接忽略', async () => {
    const kv = kvWithRecords();
    const send = vi.fn(async () => {});
    const service = createLarkWelcomeService({ appId: 'cli_a', kv, send });

    await service.welcomeBotAdded('');

    expect(kv.compareAndSet).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});
