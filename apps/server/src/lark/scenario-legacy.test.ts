import { describe, expect, it } from 'vitest';
import { buildLarkCard } from './service.js';
import { larkScenarioAdoptionOf, legacyConfirmAliases, persistedRecallLine } from './scenario-legacy.js';

describe('升级前的数据兼容读取', () => {
  const adoption = { mode: 'direct', packId: 'alarm', version: '1.0.0', digest: 'd', instruction: '[告警初筛] 指令', sourceAppId: 'cli_alarm', recordId: 'decision_alarm_x' } as const;

  it('收养字段：新字段按形状校验，形状不对按没有场景；只有旧字段 triage 时转成告警包的旧指令', () => {
    expect(larkScenarioAdoptionOf({ scenario: adoption })).toEqual(adoption);
    expect(larkScenarioAdoptionOf({ scenario: { ...adoption, extra: true } as never })).toBeUndefined();
    expect(larkScenarioAdoptionOf({ scenario: { mode: 'model', packId: 'alarm' } as never })).toBeUndefined();
    expect(larkScenarioAdoptionOf({ triage: '[告警初筛] 旧约定\n[告警原文]' })).toEqual({ mode: 'direct', packId: 'alarm', legacyInstruction: '[告警初筛] 旧约定\n[告警原文]' });
    expect(larkScenarioAdoptionOf({ scenario: adoption, triage: '旧' })).toEqual(adoption);
    expect(larkScenarioAdoptionOf({})).toBeUndefined();
  });

  it('旧确认卡 alarm_subscription 是告警包确认卡的别名，平铺 payload 转成包参数', () => {
    const alias = legacyConfirmAliases.find(item => item.kind === 'alarm_subscription')!;
    expect(alias.packId).toBe('alarm');
    expect(alias.params({ enabled: true, sources: JSON.stringify([{ appId: 'cli_alarm', name: '监控' }]), levels: '["P0"]', dedupeHours: 6, maxPerHour: 3 }))
      .toEqual({ sources: [{ appId: 'cli_alarm', name: '监控' }], levels: ['P0'], dedupeHours: 6, maxPerHour: 3 });
    expect(alias.params({ enabled: true, sources: '{', levels: '[]' })).toBeUndefined();
  });

  it('旧卡片映射的 alert_recall 按升级前的格式画成同一行，过程卡照常重绘', () => {
    const legacy = { alert_recall: { date: '9-22', headline: '文件服务流量突增', url: 'https://applink.feishu.cn/client/thread/open?open_thread_id=omt_1' } };
    const line = '📎 9-22 同一告警规则：文件服务流量突增 · [查看](https://applink.feishu.cn/client/thread/open?open_thread_id=omt_1)';
    expect(persistedRecallLine(legacy)).toEqual({ packId: 'alarm', line });
    expect(persistedRecallLine({ alert_recall: { date: '9-22', headline: '结论' } })).toEqual({ packId: 'alarm', line: '📎 9-22 同一告警规则：结论' });
    expect(persistedRecallLine({ scenario_recall: { packId: 'alarm', line: '新的一行' }, alert_recall: legacy.alert_recall })).toEqual({ packId: 'alarm', line: '新的一行' });
    expect(persistedRecallLine({ alert_recall: { date: 1 } })).toBeUndefined();
    const card = buildLarkCard({ cardKind: 'process', state: 'running', taskId: 'task_1', markdown: '正在思考中…', scenarioRecall: persistedRecallLine(legacy)! }) as any;
    expect(card.body.elements[0]).toMatchObject({ element_id: 'scenario_recall', content: line });
  });
});
