// 升级前留下的告警数据的兼容读取。新代码不再写这些形状，只在读旧入站记录、旧确认卡和旧卡片映射时转换。
//
// - 旧入站记录：内部告警派生的事件带 triage（放在告警原文前的初筛约定），恢复时照旧按初筛处理。
// - 旧确认卡：种类 alarm_subscription，payload 平铺，sources、levels 是 JSON 字符串；作为告警包确认卡的别名处理。
// - 旧卡片映射：过程卡顶部「上一次同一告警」存的是 alert_recall: { date, headline, url? }，对账重绘时按旧格式画一行。

import type { PersistedLarkCardTask } from './coordinator.js';
import type { LarkMessageEvent } from './listener.js';
import type { LarkScenarioRecallLine } from './scenario-recall.js';
import { larkScenarioAdoptionSchema, type LarkScenarioAdoption } from './scenario-direct.js';

export const LEGACY_ALARM_PACK_ID = 'alarm';

/** 事件的收养字段：新字段 scenario 按形状校验；只有旧字段 triage 时转成告警包的旧指令。 */
export function larkScenarioAdoptionOf(event: Pick<LarkMessageEvent, 'scenario' | 'triage'>): LarkScenarioAdoption | undefined {
  const parsed = larkScenarioAdoptionSchema.safeParse(event.scenario);
  if (parsed.success) return parsed.data;
  return typeof event.triage === 'string' && event.triage ? { mode: 'direct', packId: LEGACY_ALARM_PACK_ID, legacyInstruction: event.triage } : undefined;
}

/** 旧确认卡的 payload 转成告警包的参数；转不出来时返回 undefined，按确认卡失效处理。 */
function legacyAlarmConfirmParams(payload: Readonly<Record<string, string | number | boolean>>): Record<string, unknown> | undefined {
  try {
    return { sources: JSON.parse(String(payload.sources)), levels: JSON.parse(String(payload.levels)), dedupeHours: payload.dedupeHours, maxPerHour: payload.maxPerHour };
  } catch { return undefined; }
}

/** 升级前发出的确认卡：种类 → 对应的包和 payload 转换（开启时用；关闭的 payload 只有 enabled: false，新旧一样）。 */
export const legacyConfirmAliases: ReadonlyArray<{ kind: string; packId: string; params(payload: Readonly<Record<string, string | number | boolean>>): Record<string, unknown> | undefined }> = [
  { kind: 'alarm_subscription', packId: LEGACY_ALARM_PACK_ID, params: legacyAlarmConfirmParams }
];

/** 卡片映射里过程卡顶部那一行：新映射存 scenario_recall；旧映射的 alert_recall 按升级前的格式画成一行。 */
export function persistedRecallLine(persisted: Pick<PersistedLarkCardTask, 'scenario_recall' | 'alert_recall'>): LarkScenarioRecallLine | undefined {
  if (persisted.scenario_recall) return persisted.scenario_recall;
  const recall = persisted.alert_recall as { date?: unknown; headline?: unknown; url?: unknown } | undefined;
  if (typeof recall?.date !== 'string' || typeof recall.headline !== 'string') return undefined;
  return { packId: LEGACY_ALARM_PACK_ID, line: `📎 ${recall.date} 同一告警规则：${recall.headline}${typeof recall.url === 'string' && recall.url ? ` · [查看](${recall.url})` : ''}` };
}
