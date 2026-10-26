import type Database from 'better-sqlite3';
import type { ConfigRepository } from '@dutydeck/shared';

const patterns = {
  'session_automation/schedule/': 'session_automation/schedule/*',
  'session_automation/occurrence/': 'session_automation/occurrence/*',
  'session_automation/ci/': 'session_automation/ci/*',
  'relay.ask.': 'relay.ask.*'
} as const;
type JsonFilter = Parameters<NonNullable<ConfigRepository['listByJsonField']>>[1];
const expression = (field: JsonFilter['field'] | 'scheduleId') => `json_extract(CASE WHEN json_valid(value) THEN value ELSE '{}' END,'$.${field}')`;

/** SQLite maintains these expressions in the same write as each source config CAS. */
export function createConfigReadIndexes(db: Database.Database): void {
  for (const [name, prefix, field] of [
    ['config_occurrence_run', 'session_automation/occurrence/', 'runStatus'],
    ['config_occurrence_delivery', 'session_automation/occurrence/', 'delivery.status'],
    ['config_ci_status', 'session_automation/ci/', 'status'],
    ['config_ci_delivery', 'session_automation/ci/', 'delivery.status'],
    ['config_relay_status', 'relay.ask.', 'status']
  ] as const) {
    const schedule = field === 'runStatus' ? `,${expression('scheduleId')}` : '';
    db.exec(`CREATE INDEX ${name} ON configs(${expression(field)}${schedule},key) WHERE key GLOB '${patterns[prefix]}'`);
  }
}

export function listConfigByJsonField(db: Database.Database, prefix: string, filter: JsonFilter) {
  const pattern = Object.hasOwn(patterns, prefix) ? patterns[prefix as keyof typeof patterns] : undefined;
  // Literal paths/patterns match the partial expression indexes. Unregistered prefixes
  // retain the same prefix semantics using a parameterized fallback.
  const scope = pattern ? `key GLOB '${pattern}'` : 'substr(key,1,length(?))=?';
  const params: unknown[] = pattern ? [] : [prefix, prefix];
  const field = expression(filter.field);
  params.push(...filter.values);
  let where = `${scope} AND ${field} IN (${filter.values.map(() => '?').join(',')})`;
  if (filter.sessionId !== undefined) { where += ` AND ${expression('sessionId')}=?`; params.push(filter.sessionId); }
  if (filter.scheduleId !== undefined) { where += ` AND ${expression('scheduleId')}=?`; params.push(filter.scheduleId); }
  return db.prepare(`SELECT key,value FROM configs WHERE ${where} ORDER BY key`).all(...params) as Array<{ key: string; value: string }>;
}
