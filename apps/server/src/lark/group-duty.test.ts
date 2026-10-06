import { describe, expect, it } from 'vitest';
import { alarmFingerprint, alarmIntentOf, alarmLevelMatches, describeAlarm, responderAnnouncementOf, responderClaimText, responderIntentOf, responderReleaseText } from './group-duty.js';

describe('告警指纹和级别', () => {
  it('同一条告警换了时间、数值、链接和实例号算同一条；来源或正文不同不算', () => {
    const a = alarmFingerprint('cli_alarm', '【P1】订单服务错误率 12.5% 超过阈值 2026-10-07 10:01:02 https://grafana/x?from=1 pod 3f9a8b7c6d5e');
    const b = alarmFingerprint('cli_alarm', '【P1】订单服务错误率 30.1% 超过阈值 2026-10-07 11:59:00 https://grafana/x?from=2 pod 0a1b2c3d4e5f');
    expect(a).toBe(b);
    expect(alarmFingerprint('cli_other', '【P1】订单服务错误率 12.5% 超过阈值')).not.toBe(alarmFingerprint('cli_alarm', '【P1】订单服务错误率 12.5% 超过阈值'));
    expect(alarmFingerprint('cli_alarm', '【P1】支付服务错误率 12.5% 超过阈值')).not.toBe(alarmFingerprint('cli_alarm', '【P1】订单服务错误率 12.5% 超过阈值'));
  });

  it('级别按整词比，不区分大小写；没设级别都算命中', () => {
    expect(alarmLevelMatches([], '随便什么')).toBe(true);
    expect(alarmLevelMatches(['P0', 'P1'], '【p1】订单服务')).toBe(true);
    expect(alarmLevelMatches(['P1'], '【P10】订单服务')).toBe(false);
    expect(alarmLevelMatches(['P1'], 'P2 告警')).toBe(false);
    expect(alarmLevelMatches(['严重'], '级别：严重')).toBe(true);
  });
});

describe('告警订阅的说法', () => {
  it.each([
    ['以后告警先帮我初筛', { kind: 'subscribe', levels: [] }],
    ['订阅告警初筛，只看 P0 和 p1', { kind: 'subscribe', levels: ['P0', 'P1'] }],
    ['告警你帮忙看看', { kind: 'subscribe', levels: [] }],
    ['告警别再分析了', { kind: 'unsubscribe' }],
    ['关闭告警初筛', { kind: 'unsubscribe' }]
  ] as const)('「%s」', (text, intent) => {
    expect(alarmIntentOf(`@_user_1 ${text}`)).toEqual(intent);
  });

  it('不相干或太长的消息不算', () => {
    expect(alarmIntentOf('@_user_1 这个告警是什么意思')).toBeUndefined();
    expect(alarmIntentOf(`@_user_1 以后告警先帮我初筛${'，另外'.repeat(20)}`)).toBeUndefined();
  });

  it('说明里有来源、级别、去重窗口和上限', () => {
    expect(describeAlarm({ sources: [{ appId: 'cli_alarm', name: '监控' }], levels: ['P0'], dedupeHours: 6, maxPerHour: 3 }))
      .toBe('来源 监控（cli_alarm）；级别只看 P0；同一条告警 6 小时内只分析一次，每小时最多 3 条');
  });
});

describe('接话人', () => {
  it.each([
    ['这个群由 flash 负责接话', 'flash'],
    ['以后让 bdev 来接话吧', 'bdev'],
    ['你来接话', ''],
    ['接话人改成 Tag 机器人', 'Tag 机器人']
  ])('「%s」→ %s', (text, name) => {
    expect(responderIntentOf(`@_user_1 ${text}`)).toEqual({ name });
  });

  it('问句或说自己不算', () => {
    expect(responderIntentOf('@_user_1 谁来接话')).toBeUndefined();
    expect(responderIntentOf('@_user_1 我来接话')).toBeUndefined();
    expect(responderIntentOf('@_user_1 接话的规则是什么')).toBeUndefined();
  });

  it('声明消息能解析回来', () => {
    expect(responderAnnouncementOf(responderClaimText('bdev-flash'))).toEqual({ kind: 'claim', name: 'bdev-flash' });
    expect(responderAnnouncementOf(responderReleaseText('bdev-flash'))).toEqual({ kind: 'release', name: 'bdev-flash' });
    expect(responderAnnouncementOf('本群没 @ 机器人的消息由我接')).toBeUndefined();
  });
});
