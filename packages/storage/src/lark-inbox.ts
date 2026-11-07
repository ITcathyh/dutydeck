import type Database from 'better-sqlite3';
import { assertJsonPaths, decodeJsonFields, expression as field } from './config-query.js';
import { cachedStatement } from './statement-cache.js';
import { LARK_INBOX_APP as APP, LARK_INBOX_BODY_EXPIRES as BODY_EXPIRES, LARK_INBOX_BOT as BOT, LARK_INBOX_RECEIVED as RECEIVED, LARK_INBOX_SCOPE as SCOPE, LARK_INBOX_STATE as STATE } from './lark-inbox-schema.js';

// 走索引的表达式来自 lark-inbox-schema.ts，与 v48 建索引的原文逐字一致；field 只用于不走索引的附加条件。
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
    const prune = cachedStatement(db, PRUNE_IGNORED_SQL);
    let removed = 0;
    for (const bot of [0, 1]) removed += prune.run({ prefix, app: appId, bot, before: options.receivedBefore, keep: options.keep }).changes;
    const slimmed = cachedStatement(db, SLIM_IGNORED_SQL).run({ prefix, app: appId, now: options.now }).changes;
    return { removed, slimmed };
  }).immediate();
}

/** 去向列表：每个机器人、每类各按索引倒序取最近 @limit 条，合并后再取最近 @limit 条；坏 JSON 的行在索引里 state 为空，不会出现。 */
export function listRecentIgnoredLarkInbox(db: Database.Database, input: { appId?: string; since: string; chatId?: string; limit: number; paths: readonly string[] }) {
  assertJsonPaths(input.paths);
  const apps = input.appId !== undefined ? [input.appId]
    : (cachedStatement(db, `SELECT DISTINCT ${APP} AS app FROM configs INDEXED BY config_lark_inbox_ignored WHERE ${SCOPE} AND ${APP} IS NOT NULL`).all() as Array<{ app: string }>).map(row => row.app);
  const columns = input.paths.map((path, index) => `value -> '$.${path}' AS f${index}`).join(',');
  const bucket = `SELECT key,${RECEIVED} AS received,${columns} FROM configs INDEXED BY config_lark_inbox_ignored WHERE ${ignored} AND ${RECEIVED} >= @since
    AND IFNULL(${field('reason')},'') NOT IN ('participation_handled','participation_replied')${input.chatId !== undefined ? ` AND ${field('event.chatId')}=@chat` : ''}
    ORDER BY ${RECEIVED} DESC,key DESC LIMIT @limit`;
  const statement = cachedStatement(db, `SELECT * FROM (SELECT * FROM (${bucket.replaceAll('@bot', '0')}) UNION ALL SELECT * FROM (${bucket.replaceAll('@bot', '1')})) ORDER BY received DESC,key DESC LIMIT @limit`);
  const rows = apps.flatMap(app => statement.all({ prefix: `lark.inbox.${app}.`, app, since: input.since, limit: input.limit, ...(input.chatId !== undefined ? { chat: input.chatId } : {}) }) as Array<Record<string, string | null>>);
  const order = (a: string | null | undefined, b: string | null | undefined) => (a ?? '') < (b ?? '') ? 1 : (a ?? '') > (b ?? '') ? -1 : 0;
  return rows.sort((a, b) => order(a.received, b.received) || order(a.key, b.key)).slice(0, input.limit)
    .map(row => ({ key: row.key as string, fields: decodeJsonFields(input.paths, input.paths.map((_, index) => row[`f${index}`])) }));
}
