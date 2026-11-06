/**
 * 飞书入站记录索引（迁移 v48）的表达式与建表语句。查询和索引共用这些常量，SQLite 才会选中索引。
 * 已升级的库按这里的原文建过索引：改动任何一条都要追加新迁移重建索引，lark-inbox-migration.test.ts 的原文快照会拦住直接修改。
 */
export const LARK_INBOX_SCOPE = "key GLOB 'lark.inbox.*'";
export const LARK_INBOX_APP = "json_extract(CASE WHEN json_valid(value) THEN value ELSE '{}' END,'$.appId')";
export const LARK_INBOX_STATE = "json_extract(CASE WHEN json_valid(value) THEN value ELSE '{}' END,'$.state')";
export const LARK_INBOX_REASON = "json_extract(CASE WHEN json_valid(value) THEN value ELSE '{}' END,'$.disposition.reason')";
export const LARK_INBOX_RECEIVED = "json_extract(CASE WHEN json_valid(value) THEN value ELSE '{}' END,'$.receivedAt')";
export const LARK_INBOX_BODY_EXPIRES = "json_extract(CASE WHEN json_valid(value) THEN value ELSE '{}' END,'$.bodyExpiresAt')";
/** 发送方是其他机器人（bot/app）为 1，其余（含缺字段）为 0。 */
export const LARK_INBOX_BOT = "(IFNULL(json_extract(CASE WHEN json_valid(value) THEN value ELSE '{}' END,'$.event.senderType'),'') IN ('bot','app'))";

export const LARK_INBOX_V48_INDEXES: readonly string[] = [
  `CREATE INDEX config_lark_inbox_state ON configs(${LARK_INBOX_STATE},key) WHERE ${LARK_INBOX_SCOPE}`,
  `CREATE INDEX config_lark_inbox_reason ON configs(${LARK_INBOX_REASON},key) WHERE ${LARK_INBOX_SCOPE}`,
  `CREATE INDEX config_lark_inbox_ignored ON configs(${LARK_INBOX_APP},${LARK_INBOX_STATE},${LARK_INBOX_BOT},${LARK_INBOX_RECEIVED},key) WHERE ${LARK_INBOX_SCOPE}`,
  `CREATE INDEX config_lark_inbox_body ON configs(${LARK_INBOX_APP},${LARK_INBOX_BODY_EXPIRES}) WHERE ${LARK_INBOX_SCOPE}`
];
