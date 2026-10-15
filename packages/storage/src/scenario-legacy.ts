import type Database from 'better-sqlite3';
import { z } from 'zod';
import {
  SCENARIO_RECORD,
  scenarioPolicyVersion,
  type CollaborationDecision,
  type CollaborationScope,
  type ScenarioBinding,
  type ScenarioOutcome,
  type ScenarioRecordSnapshot
} from '@dutydeck/shared';

/**
 * 告警初筛搬进内置场景包 alarm 之前存下的旧数据，只在这里读：
 * - collaboration_duties.alarm_json：v38 迁移会转进 scenarios_json；转不了的行原样保留，读取时再试一次；
 * - gate 为 alarm_triage 的判定记录：库里不改写，读取时映射成告警包的场景记录，去重和每小时上限照样能统计到。
 */

const ALARM_PACK_ID = 'alarm';
const ALARM_PACK_VERSION = '1.0.0';
const LEGACY_ALARM_GATE = 'alarm_triage';

/** v36 的告警初筛订阅（原 shared 的 alarmSubscriptionSchema）。 */
export const legacyAlarmSubscriptionSchema = z.object({
  enabled: z.boolean(),
  sources: z.array(z.object({ appId: z.string().trim().min(1).max(128), name: z.string().trim().max(128).optional() }).strict()).max(20),
  levels: z.array(z.string().trim().min(1).max(32)).max(20),
  dedupeHours: z.number().int().min(1).max(168),
  maxPerHour: z.number().int().min(1).max(30),
  requesterId: z.string().trim().min(1).max(128).optional()
}).strict();
export type LegacyAlarmSubscription = z.infer<typeof legacyAlarmSubscriptionSchema>;

/** 旧订阅对象转成告警包 1.0.0 的绑定；不符合旧格式时返回 undefined。 */
export function legacyAlarmBinding(value: unknown): ScenarioBinding | undefined {
  const parsed = legacyAlarmSubscriptionSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const { enabled, sources, levels, dedupeHours, maxPerHour, requesterId } = parsed.data;
  return { enabled, params: { sources, levels, dedupeHours, maxPerHour }, ...(requesterId ? { requesterId } : {}), packVersion: ALARM_PACK_VERSION };
}

/** v38：把每行 alarm_json 转进 scenarios_json（已有 alarm 键时不覆盖）并清空 alarm_json；转不了的行保留并记日志。 */
export function migrateLegacyDutyScenarios(db: Database.Database): void {
  const rows = db.prepare('SELECT app_id, chat_id, alarm_json, scenarios_json FROM collaboration_duties WHERE alarm_json IS NOT NULL')
    .all() as Array<{ app_id: string; chat_id: string; alarm_json: string; scenarios_json: string | null }>;
  const update = db.prepare('UPDATE collaboration_duties SET scenarios_json = ?, alarm_json = NULL WHERE app_id = ? AND chat_id = ?');
  for (const row of rows) {
    const binding = legacyAlarmBinding(JSON.parse(row.alarm_json));
    if (!binding) {
      process.stderr.write(`[dutydeck] v38 collaboration_scenarios: app ${row.app_id} chat ${row.chat_id} 的 alarm_json 不符合旧订阅格式，保留原样，读取时再兼容\n`);
      continue;
    }
    const scenarios = row.scenarios_json ? JSON.parse(row.scenarios_json) as Record<string, unknown> : {};
    update.run(JSON.stringify({ [ALARM_PACK_ID]: binding, ...scenarios }), row.app_id, row.chat_id);
  }
}

/** rowToDuty 用：scenarios 里还没有告警包、行上留着能转换的旧订阅时，按迁移规则补进去。row 是 SELECT * 读到的整行。 */
export function withLegacyDutyScenarios(row: object, scenarios: Record<string, ScenarioBinding> | undefined): Record<string, ScenarioBinding> | undefined {
  const legacy = (row as { alarm_json?: string | null }).alarm_json;
  if (!legacy || (scenarios && Object.hasOwn(scenarios, ALARM_PACK_ID))) return scenarios;
  const binding = legacyAlarmBinding(JSON.parse(legacy));
  return binding ? { ...scenarios, [ALARM_PACK_ID]: binding } : scenarios;
}

/**
 * updateDuty 写完 scenarios_json 后调用，packIds 是合并结果里的包和这次改过（含删除）的包。
 * 告警包在其中时，它的绑定已经由 scenarios_json 决定，清掉旧列，免得兼容读取把旧订阅带回来；否则旧列不动。
 */
export function retireLegacyDutyColumns(db: Database.Database, scope: CollaborationScope, packIds: Iterable<string>): void {
  if (![...packIds].includes(ALARM_PACK_ID)) return;
  db.prepare('UPDATE collaboration_duties SET alarm_json = NULL WHERE app_id = ? AND chat_id = ? AND alarm_json IS NOT NULL').run(scope.appId, scope.chatId);
}

const legacyOutcomes: Record<string, ScenarioOutcome> = {
  triaged: 'started',
  level: 'filtered',
  duplicate: 'duplicate',
  rate_limited: 'rate_limited',
  not_responder: 'not_responder',
  no_requester: 'no_requester'
};

/** 某个包在升级前的判定记录用的 gate（listScenarioRecords 按它把旧记录一起查出来）；没有旧记录的包为 undefined。 */
export const legacyScenarioGate = (packId: string) => packId === ALARM_PACK_ID ? LEGACY_ALARM_GATE : undefined;

/** 旧的告警初筛判定记录映射成告警包的场景记录；其他记录原样返回。 */
export function fromLegacyDecision(decision: CollaborationDecision): CollaborationDecision {
  const { gate, alarm, ...rest } = decision.inputSnapshot as { gate?: unknown; alarm?: unknown; [key: string]: unknown };
  if (gate !== LEGACY_ALARM_GATE || !alarm || typeof alarm !== 'object') return decision;
  const legacy = alarm as { outcome?: unknown; fingerprint?: unknown; sourceAppId?: unknown };
  const outcome = typeof legacy.outcome === 'string' && Object.hasOwn(legacyOutcomes, legacy.outcome) ? legacyOutcomes[legacy.outcome]! : undefined;
  if (!outcome) return decision;
  const scenario: ScenarioRecordSnapshot = {
    packId: ALARM_PACK_ID,
    version: ALARM_PACK_VERSION,
    digest: `legacy:${LEGACY_ALARM_GATE}`,
    outcome,
    ...(typeof legacy.fingerprint === 'string' ? { dedupeKey: legacy.fingerprint } : {}),
    ...(typeof legacy.sourceAppId === 'string' ? { sourceAppId: legacy.sourceAppId } : {})
  };
  const decider = rest.decider && typeof rest.decider === 'object' ? { ...rest.decider as Record<string, unknown>, rule: `scenario_${outcome}` } : rest.decider;
  return {
    ...decision,
    policyVersion: scenarioPolicyVersion(ALARM_PACK_ID, ALARM_PACK_VERSION),
    inputSnapshot: { ...rest, gate: SCENARIO_RECORD, scenario, ...(decider !== undefined ? { decider } : {}) }
  };
}
