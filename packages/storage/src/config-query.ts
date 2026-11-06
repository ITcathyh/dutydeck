import type Database from 'better-sqlite3';
import type { ConfigRepository } from '@dutydeck/shared';

// 与 database-control.ts 的 cachedStatement 相同；放在这里免得迁移模块经由它绕回自己。
const statements = new WeakMap<Database.Database, Map<string, Database.Statement>>();
export function preparedOnce(db: Database.Database, sql: string): Database.Statement {
  let byText = statements.get(db);
  if (!byText) statements.set(db, byText = new Map());
  let statement = byText.get(sql);
  if (!statement) byText.set(sql, statement = db.prepare(sql));
  return statement;
}

const patterns = {
  'session_automation/schedule/': 'session_automation/schedule/*',
  'session_automation/occurrence/': 'session_automation/occurrence/*',
  'session_automation/ci/': 'session_automation/ci/*',
  'relay.ask.': 'relay.ask.*'
} as const;
type JsonFilter = Parameters<NonNullable<ConfigRepository['listByJsonField']>>[1];
const expression = (field: JsonFilter['field'] | 'scheduleId' | 'disposition.reason') => `json_extract(CASE WHEN json_valid(value) THEN value ELSE '{}' END,'$.${field}')`;

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

/** v47: per-bot inbox prefixes (`lark.inbox.<appId>.`) share one partial index; the literal GLOB lets SQLite pick it. */
const LARK_INBOX_PATTERN = 'lark.inbox.*';
export function createLarkInboxStateIndex(db: Database.Database): void {
  db.exec(`CREATE INDEX config_lark_inbox_state ON configs(${expression('state')},key) WHERE key GLOB '${LARK_INBOX_PATTERN}'`);
  db.exec(`CREATE INDEX config_lark_inbox_reason ON configs(${expression('disposition.reason')},key) WHERE key GLOB '${LARK_INBOX_PATTERN}'`);
}

/** Literal paths/patterns match the partial expression indexes. Other prefixes keep the same semantics through a parameterized comparison. */
function prefixScope(prefix: string): { scope: string; params: unknown[] } {
  const pattern = Object.hasOwn(patterns, prefix) ? patterns[prefix as keyof typeof patterns] : undefined;
  if (pattern) return { scope: `key GLOB '${pattern}'`, params: [] };
  const inbox = prefix.startsWith('lark.inbox.') ? `key GLOB '${LARK_INBOX_PATTERN}' AND ` : '';
  return { scope: `${inbox}substr(key,1,length(?))=?`, params: [prefix, prefix] };
}

export function listConfigByJsonField(db: Database.Database, prefix: string, filter: JsonFilter) {
  const { scope, params } = prefixScope(prefix);
  const field = expression(filter.field);
  params.push(...filter.values);
  let where = `${scope} AND ${field} IN (${filter.values.map(() => '?').join(',')})`;
  if (filter.sessionId !== undefined) { where += ` AND ${expression('sessionId')}=?`; params.push(filter.sessionId); }
  if (filter.scheduleId !== undefined) { where += ` AND ${expression('scheduleId')}=?`; params.push(filter.scheduleId); }
  return db.prepare(`SELECT key,value FROM configs WHERE ${where} ORDER BY key`).all(...params) as Array<{ key: string; value: string }>;
}

const jsonPath = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;
/** Selected paths come back as SQLite JSON text and are decoded here; a malformed row comes back with `fields: undefined` for the caller to judge. */
export function listConfigJsonFields(db: Database.Database, prefix: string, paths: readonly string[], filter?: { field: 'state' | 'disposition.reason'; values: Array<string | null> }) {
  if (!paths.length || paths.some(path => !jsonPath.test(path))) throw new Error('Invalid JSON field paths');
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
    if (values.length) branches.push({ sql: select(`${scope} AND ${expression(filter.field)} IN (${values.map(() => '?').join(',')})`), params: [...pathParams, ...scopeParams, ...values] });
    if (filter.values.includes(null)) branches.push({ sql: select(`${scope} AND ${expression(filter.field)} IS NULL`), params: [...pathParams, ...scopeParams] });
  }
  const rows = preparedOnce(db, `${branches.map(branch => branch.sql).join(' UNION ALL ')} ORDER BY key`).raw().all(...branches.flatMap(branch => branch.params)) as Array<[string, number, ...Array<string | null>]>;
  return rows.map(([key, valid, ...values]) => ({ key, fields: valid ? Object.fromEntries(paths.map((path, index) => [path, values[index] == null ? undefined : JSON.parse(values[index]!)])) : undefined }));
}
