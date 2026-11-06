import type Database from 'better-sqlite3';
import { preparedOnce } from './config-query.js';

// 表达式必须与索引定义逐字一致，SQLite 才会选中索引；坏 JSON 的行按空对象看待。
const safe = "CASE WHEN json_valid(value) THEN value ELSE '{}' END";
const field = (path: string) => `json_extract(${safe},'$.${path}')`;
const SCOPE = "key GLOB 'lark.inbox.*'";
const APP = field('appId');
const STATE = field('state');
const RECEIVED = field('receivedAt');
const BODY_EXPIRES = field('bodyExpiresAt');
/** 发送方是其他机器人（bot/app）为 1，其余（含缺字段）为 0。 */
const BOT = `(IFNULL(${field('event.senderType')},'') IN ('bot','app'))`;

/** v47：按（机器人、类别、时间）找已忽略记录，按（机器人、正文到期时间）找待瘦身记录。 */
export function createLarkInboxRetentionIndexes(db: Database.Database): void {
  db.exec(`CREATE INDEX config_lark_inbox_ignored ON configs(${APP},${STATE},${BOT},${RECEIVED},key) WHERE ${SCOPE}`);
  db.exec(`CREATE INDEX config_lark_inbox_body ON configs(${APP},${BODY_EXPIRES}) WHERE ${SCOPE}`);
}

const ignored = `${SCOPE} AND substr(key,1,length(@prefix))=@prefix AND ${APP}=@app AND ${STATE}='ignored' AND ${BOT}=@bot`;
/**
 * 删除早于 @before 的、以及按（receivedAt, key）倒序排在第 @keep 名之后的。两者都是索引顺序里最旧的一段，
 * 取两条边界里较新的那条（第 @keep 名只在覆盖索引里数），再按 receivedAt 范围删掉：
 * (@before, '') 这条边界等价于 receivedAt < @before（key 不会是空串）。
 */
export const PRUNE_IGNORED_SQL = `WITH boundary AS (SELECT received,key FROM (
    SELECT * FROM (SELECT ${RECEIVED} AS received,key FROM configs INDEXED BY config_lark_inbox_ignored WHERE ${ignored} ORDER BY ${RECEIVED} DESC,key DESC LIMIT 1 OFFSET @keep)
    UNION ALL SELECT @before,'') ORDER BY received DESC,key DESC LIMIT 1)
  DELETE FROM configs INDEXED BY config_lark_inbox_ignored WHERE ${ignored} AND ${RECEIVED} <= (SELECT received FROM boundary)
    AND (${RECEIVED} < (SELECT received FROM boundary) OR key <= (SELECT key FROM boundary))`;
const content = "json_extract(value,'$.event.content')";
// 摘要与 apps/server/src/lark/disposition.ts 的 messageSnippet 同口径：JSON 里有 text 取 text，否则取原文，前 160 字。
const snippet = `COALESCE(CASE WHEN json_valid(${content}) THEN CASE WHEN json_type(${content},'$.text')='text' THEN substr(json_extract(${content},'$.text'),1,160) END END, substr(${content},1,160), '')`;
export const SLIM_IGNORED_SQL = `UPDATE configs INDEXED BY config_lark_inbox_body SET value=json_remove(json_set(value,'$.snippet',${snippet},'$.event.content',''),'$.bodyExpiresAt')
  WHERE ${SCOPE} AND substr(key,1,length(@prefix))=@prefix AND ${APP}=@app AND ${BODY_EXPIRES} < @now AND ${STATE}='ignored'`;

/**
 * 一个机器人的已忽略记录：其他机器人的消息和其余消息各自按时间保留、各自封顶；正文到期的机器人消息换成摘要。
 * 只动 state=ignored 的行，同一事务内完成。
 */
export function pruneIgnoredLarkInbox(db: Database.Database, appId: string, options: { receivedBefore: string; keep: number; now: string }) {
  const prefix = `lark.inbox.${appId}.`;
  return db.transaction(() => {
    const prune = preparedOnce(db, PRUNE_IGNORED_SQL);
    let removed = 0;
    for (const bot of [0, 1]) removed += prune.run({ prefix, app: appId, bot, before: options.receivedBefore, keep: options.keep }).changes;
    const slimmed = preparedOnce(db, SLIM_IGNORED_SQL).run({ prefix, app: appId, now: options.now }).changes;
    return { removed, slimmed };
  }).immediate();
}

const jsonPath = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;
/** 去向列表：每个机器人、每类各按索引倒序取最近 @limit 条，合并后再取最近 @limit 条；坏 JSON 的行在索引里 state 为空，不会出现。 */
export function listRecentIgnoredLarkInbox(db: Database.Database, input: { appId?: string; since: string; chatId?: string; limit: number; paths: readonly string[] }) {
  if (!input.paths.length || input.paths.some(path => !jsonPath.test(path))) throw new Error('Invalid JSON field paths');
  const apps = input.appId !== undefined ? [input.appId]
    : (preparedOnce(db, `SELECT DISTINCT ${APP} AS app FROM configs INDEXED BY config_lark_inbox_ignored WHERE ${SCOPE} AND ${APP} IS NOT NULL`).all() as Array<{ app: string }>).map(row => row.app);
  const columns = input.paths.map((path, index) => `value -> '$.${path}' AS f${index}`).join(',');
  const bucket = `SELECT key,${RECEIVED} AS received,${columns} FROM configs INDEXED BY config_lark_inbox_ignored WHERE ${ignored} AND ${RECEIVED} >= @since
    AND IFNULL(${field('reason')},'') NOT IN ('participation_handled','participation_replied')${input.chatId !== undefined ? ` AND ${field('event.chatId')}=@chat` : ''}
    ORDER BY ${RECEIVED} DESC,key DESC LIMIT @limit`;
  const statement = preparedOnce(db, `SELECT * FROM (SELECT * FROM (${bucket.replaceAll('@bot', '0')}) UNION ALL SELECT * FROM (${bucket.replaceAll('@bot', '1')})) ORDER BY received DESC,key DESC LIMIT @limit`);
  const rows = apps.flatMap(app => statement.all({ prefix: `lark.inbox.${app}.`, app, since: input.since, limit: input.limit, ...(input.chatId !== undefined ? { chat: input.chatId } : {}) }) as Array<Record<string, string | null>>);
  const order = (a: string | null | undefined, b: string | null | undefined) => (a ?? '') < (b ?? '') ? 1 : (a ?? '') > (b ?? '') ? -1 : 0;
  return rows.sort((a, b) => order(a.received, b.received) || order(a.key, b.key)).slice(0, input.limit)
    .map(row => ({ key: row.key as string, fields: Object.fromEntries(input.paths.map((path, index) => [path, row[`f${index}`] == null ? undefined : JSON.parse(row[`f${index}`]!)])) as Record<string, unknown> }));
}
