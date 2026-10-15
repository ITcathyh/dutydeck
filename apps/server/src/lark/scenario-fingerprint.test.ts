import { describe, expect, it } from 'vitest';
import { keywordsMatch, sourceTextFingerprint } from './scenario-fingerprint.js';

describe('告警指纹和级别', () => {
  it('同一条告警换了时间、数值、链接和实例号算同一条；来源或正文不同不算', () => {
    const a = sourceTextFingerprint('cli_alarm', '【P1】订单服务错误率 12.5% 超过阈值 2026-10-07 10:01:02 https://grafana/x?from=1 pod 3f9a8b7c6d5e');
    const b = sourceTextFingerprint('cli_alarm', '【P1】订单服务错误率 30.1% 超过阈值 2026-10-07 11:59:00 https://grafana/x?from=2 pod 0a1b2c3d4e5f');
    expect(a).toBe(b);
    expect(sourceTextFingerprint('cli_other', '【P1】订单服务错误率 12.5% 超过阈值')).not.toBe(sourceTextFingerprint('cli_alarm', '【P1】订单服务错误率 12.5% 超过阈值'));
    expect(sourceTextFingerprint('cli_alarm', '【P1】支付服务错误率 12.5% 超过阈值')).not.toBe(sourceTextFingerprint('cli_alarm', '【P1】订单服务错误率 12.5% 超过阈值'));
  });

  it('级别按整词比，不区分大小写；没设级别都算命中', () => {
    expect(keywordsMatch([], '随便什么')).toBe(true);
    expect(keywordsMatch(['P0', 'P1'], '【p1】订单服务')).toBe(true);
    expect(keywordsMatch(['P1'], '【P10】订单服务')).toBe(false);
    expect(keywordsMatch(['P1'], 'P2 告警')).toBe(false);
    expect(keywordsMatch(['严重'], '级别：严重')).toBe(true);
  });
});

// source_text_v1 和升级前的告警指纹逐字节一致（场景包设计 9.2 第②类）。期望值用旧函数 alarmFingerprint 在 ec6b5a8 上算出。
describe('source_text_v1 与旧告警指纹逐字节一致', () => {
  it.each([
    ['全角数字和半角数字一样抹掉', '【P1】订单服务错误率 １２％ 超过阈值', '3612e1601c2f34bf9141c773a6c64e8c'],
    ['半角数字', '【P1】订单服务错误率 12％ 超过阈值', '3612e1601c2f34bf9141c773a6c64e8c'],
    ['只取前 2000 个 UTF-16 代码单元：第 2001 个以后不同仍同键', `${'告'.repeat(1999)}AB`, 'dd10b0190bc84cead249e11f4eea9a6e'],
    ['截断后的第 2000 个代码单元', `${'告'.repeat(1999)}AC`, 'dd10b0190bc84cead249e11f4eea9a6e'],
    ['截断落在代理对中间：只留高位代理', `${'告'.repeat(1999)}😀尾`, 'fcbd0992b747e798512bb82c6398e9d3'],
    ['高位代理相同的另一个字符同键', `${'告'.repeat(1999)}😃尾`, 'fcbd0992b747e798512bb82c6398e9d3'],
    ['8 位以上十六进制串不分大小写', 'trace deadbeef01 pod ABCDEF12', 'a11dec0d250d3033247e3f2c9e41e092'],
    ['空正文', '', '326a6ae09de32127fd4aa365de7369c2']
  ] as const)('%s', (_name, text, expected) => {
    expect(sourceTextFingerprint('cli_alarm', text)).toBe(expected);
  });
});
