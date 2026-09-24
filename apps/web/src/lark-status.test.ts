import { describe, expect, it } from 'vitest';
import type { LarkBotConfig } from './api';
import { buildLarkBotAppLink, formatLarkNavSummary, projectLarkBotStatus } from './lark-status';

const createBot = (overrides: Partial<LarkBotConfig> = {}): LarkBotConfig => ({
  configured: true,
  appId: 'cli_test_123',
  name: '测试助手',
  tabLabel: '测试',
  setupComplete: true,
  workspace: '/workspace/project',
  fullTrustConfirmed: true,
  preInjectPrompt: '',
  listening: true,
  activeListening: true,
  groupToolsEnabled: true,
  groupToolsAllowSend: false,
  pushIntervalMs: 2000,
  hideTraceOnComplete: true,
  allowedUsers: [],
  allowedEmails: [],
  allowedBots: [],
  peerBotsAllowed: false,
  highRiskAllowedUsers: [],
  highRiskAllowedEmails: [],
  highRiskPattern: '',
  riskControlMode: 'guidance',
  ...overrides
});

describe('projectLarkBotStatus', () => {
  it('loading 为真时返回状态加载中', () => {
    const status = projectLarkBotStatus(createBot(), false, true);
    expect(status.key).toBe('loading');
    expect(status.label).toBe('状态加载中');
    expect(status.tone).toBe('neutral');
  });

  it('bot 为空或 setupComplete 为 false 时返回配置未完成', () => {
    expect(projectLarkBotStatus(undefined).key).toBe('incomplete');
    expect(projectLarkBotStatus(createBot({ setupComplete: false })).key).toBe('incomplete');
    expect(projectLarkBotStatus(createBot({ setupComplete: false })).label).toBe('配置未完成');
    expect(projectLarkBotStatus(createBot({ setupComplete: false })).description).toBe('尚未选择默认 Agent 或确认执行权限');
    expect(projectLarkBotStatus(createBot({ setupComplete: false })).tone).toBe('warning');
  });

  it('listeningDisabled 为真时优先判定为本次启动禁用监听', () => {
    const status = projectLarkBotStatus(createBot({ setupComplete: true, listening: true, activeListening: true }), true);
    expect(status.key).toBe('daemon_disabled');
    expect(status.label).toBe('本次启动禁用监听');
    expect(status.tone).toBe('warning');
  });

  it('本实例 listening 为 false 时只描述当前服务，不归因为用户', () => {
    const status = projectLarkBotStatus(createBot({ setupComplete: true, listening: false, activeListening: false }));
    expect(status.key).toBe('paused');
    expect(status.label).toBe('本实例未开启监听');
    expect(status.description).toBe('当前服务未开启此机器人的监听；若已在其他实例运行，请到对应实例查看');
    expect(`${status.label} ${status.description}`).not.toContain('用户');
    expect(status.tone).toBe('neutral');
  });

  it('用户开启 listening 但 activeListening 为 false 时判定为监听尚未启动', () => {
    const status = projectLarkBotStatus(createBot({ setupComplete: true, listening: true, activeListening: false }));
    expect(status.key).toBe('not_started');
    expect(status.label).toBe('监听尚未启动');
    expect(status.tone).toBe('danger');
  });

  it('setupComplete、listening 与 activeListening 均满足且未全局禁用时判定为监听已启动', () => {
    const status = projectLarkBotStatus(createBot({ setupComplete: true, listening: true, activeListening: true }));
    expect(status.key).toBe('listening');
    expect(status.label).toBe('监听已启动');
    expect(status.description).toBe('监听已启动，可到飞书发送消息');
    expect(status.tone).toBe('success');
  });

  it('查询失败时判定为状态未确认，且优先于缓存里的就绪字段', () => {
    // 有缓存（字段全就绪）但本轮读取失败：不得沿用旧值说「监听已启动」。
    const status = projectLarkBotStatus(createBot({ setupComplete: true, listening: true, activeListening: true }), false, false, true);
    expect(status.key).toBe('unknown');
    expect(status.label).toBe('状态未确认');
    expect(status.tone).toBe('warning');
    // 也不得退化成「配置未完成」。
    expect(projectLarkBotStatus(undefined, false, false, true).key).toBe('unknown');
    // loading 仍然优先于 failed：正在重试时说「加载中」比「失败」更准确。
    expect(projectLarkBotStatus(createBot(), false, true, true).key).toBe('loading');
  });
});

describe('formatLarkNavSummary', () => {
  it('loading 时诚实展示正在读取接入状态', () => {
    expect(formatLarkNavSummary({ loading: true })).toBe('正在读取接入状态…');
  });

  it('无 Bot 时展示尚未配置机器人', () => {
    expect(formatLarkNavSummary({ bots: [] })).toBe('尚未配置机器人');
    expect(formatLarkNavSummary({ bots: undefined })).toBe('尚未配置机器人');
  });

  it('本次启动禁用监听时给出明确提示', () => {
    const bot = createBot();
    expect(formatLarkNavSummary({ bots: [bot], listeningDisabled: true })).toBe('1 个机器人 · 本次启动禁用监听');
  });

  /*
    聚合口径与 projectLarkBotStatus 的分支顺序必须是同一份判据。

    此前 listeningDisabled 在这里是一条提前 return，于是「未配置完成 + 全局禁用」
    这个组合下，卡片投影说「配置未完成」、侧栏 hint 说「本次启动禁用监听」——
    同屏两处对同一个 Bot 给出不同判据。现在 hint 也先投影再聚合，两者一致。
  */
  it('未配置完成 + 全局禁用监听时，聚合口径与逐个投影的优先级一致', () => {
    const incomplete = createBot({ setupComplete: false });
    // 投影侧：setupComplete 先判，所以是「配置未完成」。
    expect(projectLarkBotStatus(incomplete, true).key).toBe('incomplete');
    // 聚合侧必须跟随投影，不得因为全局禁用就整体说成「本次启动禁用监听」。
    expect(formatLarkNavSummary({ bots: [incomplete], listeningDisabled: true })).toBe('1 个机器人 · 配置未完成');
    // 混合（一个未配置完成、一个仅被全局禁用）时不谎报任一单一结论。
    expect(formatLarkNavSummary({ bots: [incomplete, createBot()], listeningDisabled: true })).toBe('2 个机器人 · 0 个监听中');
  });

  it('多个 Bot 全就绪与混合状态均诚实呈现', () => {
    const activeBot1 = createBot({ appId: 'bot_1' });
    const activeBot2 = createBot({ appId: 'bot_2' });
    const incompleteBot = createBot({ appId: 'bot_3', setupComplete: false });
    const pausedBot = createBot({ appId: 'bot_4', listening: false });

    expect(formatLarkNavSummary({ bots: [activeBot1, activeBot2] })).toBe('2 个机器人 · 监听已启动');
    expect(formatLarkNavSummary({ bots: [incompleteBot] })).toBe('1 个机器人 · 配置未完成');
    expect(formatLarkNavSummary({ bots: [pausedBot] })).toBe('1 个机器人 · 本实例未开启监听');
    expect(formatLarkNavSummary({ bots: [activeBot1, incompleteBot] })).toBe('2 个机器人 · 1 个监听中');
  });

  it('读取失败时说状态未确认或读取失败，绝不说「尚未配置」', () => {
    // 无缓存：不能说「尚未配置机器人」——读不到 ≠ 没有。
    expect(formatLarkNavSummary({ bots: [], failed: true })).toBe('接入状态读取失败');
    expect(formatLarkNavSummary({ bots: undefined, failed: true })).toBe('接入状态读取失败');
    // 有缓存：条数照报，但状态必须标为未确认，不说「监听已启动」。
    expect(formatLarkNavSummary({ bots: [createBot()], failed: true })).toBe('1 个机器人 · 状态未确认');
    // loading 优先于 failed。
    expect(formatLarkNavSummary({ bots: [], loading: true, failed: true })).toBe('正在读取接入状态…');
  });
});

describe('buildLarkBotAppLink', () => {
  it('安全构建飞书官方 AppLink', () => {
    expect(buildLarkBotAppLink('cli_test_123')).toBe('lark://applink.feishu.cn/client/bot/open?appId=cli_test_123');
    expect(buildLarkBotAppLink('  cli_abc  ')).toBe('lark://applink.feishu.cn/client/bot/open?appId=cli_abc');
    expect(buildLarkBotAppLink('cli_test?foo=bar&baz=1')).toBe('lark://applink.feishu.cn/client/bot/open?appId=cli_test%3Ffoo%3Dbar%26baz%3D1');
    expect(buildLarkBotAppLink('')).toBeUndefined();
    expect(buildLarkBotAppLink(undefined)).toBeUndefined();
  });
});
