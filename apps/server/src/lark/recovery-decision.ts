import { isDeepStrictEqual } from 'node:util';
import type { ChannelMappingRepository, ConfigRepository } from '@dutydeck/shared';
import type { ListenerLog } from './listener.js';
import { parseOptionalCardTask } from './persisted-card-task.js';
import { recoveryKind, type PersistedLarkCardTask } from './turn-record.js';

type Recovery = NonNullable<PersistedLarkCardTask['recovery']>;
type Kind = Recovery['kind'];
export const turnDecisionKey = (kind: Kind, appId: string, messageId: string, turn: number, runtimeTaskId?: string) => ({ kind, appId, messageId, turn, runtimeTaskId });
export type TurnDecisionKey = ReturnType<typeof turnDecisionKey>;

function legacyKey(key: TurnDecisionKey, kind = key.kind) {
  return ['lark', kind, key.appId, key.messageId, key.turn].join('.');
}

function decisionBasis(kind: Kind, value: Record<string, unknown>): string {
  const cause = value.redispatch as { code?: string; auto?: boolean } | undefined;
  if (typeof value.code === 'string') return value.code;
  if (cause?.code) return cause.code;
  if (cause?.auto) return 'execution_recovery';
  if (value.revoked) return 'settlement_revoked';
  if (kind === 'continue' || kind === 'relaunch' || value.operatorOpenId) return 'operator_action';
  return kind === 'settled' ? 'agent_quiet' : 'execution_recovery';
}

function competingDecision(values: Recovery['values'], kind: Kind, next: Record<string, unknown>, basis: string) {
  const taken = (claim?: Record<string, unknown>) => claim?.phase === 'claimed' || claim?.phase === 'moved' || claim?.phase === 'abandoned';
  const activeSettlement = values.settled && !values.settled.revoked;
  if (activeSettlement && (basis === 'continue_unresolved' || (kind === 'redispatch' || kind === 'relaunch') && next.phase === 'claimed')) return true;
  if (kind === 'redispatch' && next.phase === 'claimed') return taken(values.relaunch) || taken(values.continue) || values.continue?.phase === 'done';
  if (kind === 'relaunch' && next.phase === 'claimed') return taken(values.redispatch) || taken(values.continue) || values.continue?.phase === 'done';
  if (kind === 'redispatch' && (next.phase === 'moved' || next.phase === 'abandoned') && taken(values.relaunch)) return true;
  if (kind === 'continue' && next.phase === 'claimed') {
    const settled = activeSettlement && values.redispatch?.phase === 'moved';
    return taken(values.relaunch) || taken(values.redispatch) && !settled;
  }
  if (kind === 'settled' && !next.revoked) return taken(values.relaunch) || taken(values.redispatch) || taken(values.continue);
  return false;
}

export class TurnRecoveryDecisions {
  private readonly warnings = new Set<string>();

  constructor(private readonly store: ConfigRepository | undefined, private readonly mappings: ChannelMappingRepository | undefined,
    private readonly log: Pick<ListenerLog, 'warn'>) {}

  private async mapping(key: TurnDecisionKey) {
    const row = await this.mappings?.get('lark-card:' + key.appId, key.messageId);
    const record = parseOptionalCardTask(row?.extra);
    if (row?.extra && record?.app_id === key.appId && (record.turn ?? 0) === key.turn) return { row, record, extra: row.extra };
  }

  private value(key: TurnDecisionKey, recovery: Recovery | undefined, legacy: string | undefined) {
    if (!recovery) return legacy;
    const value = recovery.values[key.kind];
    let matches = false;
    try { matches = isDeepStrictEqual(value, legacy === undefined ? undefined : JSON.parse(legacy)); }
    catch { /* A malformed mirror cannot override a verified decision. */ }
    if (!matches && !this.warnings.has(legacyKey(key))) {
      this.warnings.add(legacyKey(key));
      this.log.warn(key, '飞书轮次恢复决定与旧键不一致，采用卡片记录');
    }
    return value === undefined ? undefined : JSON.stringify(value);
  }

  async get(key: TurnDecisionKey) {
    const current = await this.mapping(key);
    return this.value(key, current?.record.recovery, await this.store?.get(legacyKey(key)));
  }

  async compareAndSet(key: TurnDecisionKey, expected: string | undefined, next: string, evidence?: string) {
    if (!this.store?.compareAndSetMappingAndConfig) return false;
    const value: Record<string, unknown> = JSON.parse(next);
    const basis = evidence ?? decisionBasis(key.kind, value);
    for (let attempt = 0; attempt < 5; attempt++) {
      const current = await this.mapping(key);
      if (!current || key.runtimeTaskId && current.record.runtime_task_id !== key.runtimeTaskId
        || value.sessionId && value.sessionId !== current.row.sessionId
        || value.runtimeTaskId && value.runtimeTaskId !== current.record.runtime_task_id) return false;
      const { record, row, extra } = current;
      // On first write bring across all the old facts, including a settlement followed by a continuation.
      const kinds = record.recovery ? [key.kind] : recoveryKind.options;
      const checks = await Promise.all(kinds.map(async kind => ({ kind, key: legacyKey(key, kind), expected: await this.store!.get(legacyKey(key, kind)) })));
      const previous = checks.find(item => item.kind === key.kind)!.expected;
      if (this.value(key, record.recovery, previous) !== expected) return false;
      const values = record.recovery?.values ?? Object.fromEntries(checks.filter(item => item.expected !== undefined)
        .map(item => [item.kind, JSON.parse(item.expected!)]));
      if (competingDecision(values, key.kind, value, basis)) return false;
      const recovery: Recovery = { ...record.recovery, kind: key.kind, decided_at: Date.now(), basis,
        values: { ...values, [key.kind]: value } };
      if (await this.store.compareAndSetMappingAndConfig({ id: row.id, expected: extra, extra: JSON.stringify({ ...record, recovery }) },
        checks, [{ key: legacyKey(key), value: next }])) return true;
    }
    return false;
  }
}
