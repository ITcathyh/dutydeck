import type Database from 'better-sqlite3';
import type { ConfigRepository } from '@dutydeck/shared';
import { cachedStatement } from './statement-cache.js';
import { LARK_INBOX_REASON, LARK_INBOX_SCOPE, LARK_INBOX_STATE } from './lark-inbox-schema.js';

const patterns = {
  'session_automation/schedule/': 'session_automation/schedule/*',
  'session_automation/occurrence/': 'session_automation/occurrence/*',
  'session_automation/ci/': 'session_automation/ci/*',
  'relay.ask.': 'relay.ask.*'
} as const;
type JsonFilter = Parameters<NonNullable<ConfigRepository['listByJsonField']>>[1];
/** 坏 JSON 的行按空对象看待。path 会拼进 SQL 原文，调用方先用 assertJsonPaths 校验外部传入的路径。 */
export const expression = (field: string) => `json_extract(CASE WHEN json_valid(value) THEN value ELSE '{}' END,'$.${field}')`;

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

/** v48 的 lark.inbox 索引按固定原文建立；按 state / 原因过滤时用同一份表达式常量。 */
const frozenExpressions: Partial<Record<string, string>> = { state: LARK_INBOX_STATE, 'disposition.reason': LARK_INBOX_REASON };
const filterExpression = (field: JsonFilter['field'] | 'disposition.reason') => frozenExpressions[field] ?? expression(field);

/** Literal paths/patterns match the partial expression indexes. Other prefixes keep the same semantics through a parameterized comparison. */
function prefixScope(prefix: string): { scope: string; params: unknown[] } {
  const pattern = Object.hasOwn(patterns, prefix) ? patterns[prefix as keyof typeof patterns] : undefined;
  if (pattern) return { scope: `key GLOB '${pattern}'`, params: [] };
  // per-bot inbox prefixes (`lark.inbox.<appId>.`) share one partial index; the literal GLOB lets SQLite pick it.
  const inbox = prefix.startsWith('lark.inbox.') ? `${LARK_INBOX_SCOPE} AND ` : '';
  return { scope: `${inbox}substr(key,1,length(?))=?`, params: [prefix, prefix] };
}

export function listConfigByJsonField(db: Database.Database, prefix: string, filter: JsonFilter) {
  const { scope, params } = prefixScope(prefix);
  const field = filterExpression(filter.field);
  params.push(...filter.values);
  let where = `${scope} AND ${field} IN (${filter.values.map(() => '?').join(',')})`;
  if (filter.sessionId !== undefined) { where += ` AND ${expression('sessionId')}=?`; params.push(filter.sessionId); }
  if (filter.scheduleId !== undefined) { where += ` AND ${expression('scheduleId')}=?`; params.push(filter.scheduleId); }
  return db.prepare(`SELECT key,value FROM configs WHERE ${where} ORDER BY key`).all(...params) as Array<{ key: string; value: string }>;
}

const jsonPath = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;
export function assertJsonPaths(paths: readonly string[]): void {
  if (!paths.length || paths.some(path => !jsonPath.test(path))) throw new Error('Invalid JSON field paths');
}
/** SQLite 以 JSON 文本返回所选路径（`value -> path`），这里按路径解码；缺失的字段为 undefined。 */
export const decodeJsonFields = (paths: readonly string[], values: ReadonlyArray<string | null | undefined>): Record<string, unknown> =>
  Object.fromEntries(paths.map((path, index) => [path, values[index] == null ? undefined : JSON.parse(values[index]!)]));

/** Selected paths come back as SQLite JSON text and are decoded here; a malformed row comes back with `fields: undefined` for the caller to judge. */
export function listConfigJsonFields(db: Database.Database, prefix: string, paths: readonly string[], filter?: { field: 'state' | 'disposition.reason'; values: Array<string | null> }) {
  assertJsonPaths(paths);
  if (filter && !filter.values.length) return [];
  const { scope, params: scopeParams } = prefixScope(prefix);
  const columns = paths.map((_, index) => `CASE WHEN valid THEN value -> ? END AS f${index}`).join(',');
  const pathParams = paths.map(path => `$.${path}`);
  const select = (where: string) => `SELECT key,valid,${columns} FROM (SELECT key,value,json_valid(value) AS valid FROM configs WHERE ${where})`;
  const branches: Array<{ sql: string; params: unknown[] }> = [];
  if (!filter) branches.push({ sql: select(scope), params: [...pathParams, ...scopeParams] });
  else {
    // 每个分支单独走索引：IN 和「缺字段或坏 JSON」（null）写进同一个 OR 会让 SQLite 放弃表达式索引。
    const values = filter.values.filter((value): value is string => value !== null);
    if (values.length) branches.push({ sql: select(`${scope} AND ${filterExpression(filter.field)} IN (${values.map(() => '?').join(',')})`), params: [...pathParams, ...scopeParams, ...values] });
    if (filter.values.includes(null)) branches.push({ sql: select(`${scope} AND ${filterExpression(filter.field)} IS NULL`), params: [...pathParams, ...scopeParams] });
  }
  const rows = cachedStatement(db, `${branches.map(branch => branch.sql).join(' UNION ALL ')} ORDER BY key`).raw().all(...branches.flatMap(branch => branch.params)) as Array<[string, number, ...Array<string | null>]>;
  return rows.map(([key, valid, ...values]) => ({ key, fields: valid ? decodeJsonFields(paths, values) : undefined }));
}
