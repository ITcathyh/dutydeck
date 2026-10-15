/** 飞书会话的 sourceId：`appId:chatId:chatType[:scope…]`，由 server 的 larkSourceId 生成；没有 scope 表示整个聊天共用一个会话。 */
export const parseLarkSourceId = (sourceId: string | null | undefined) => {
  const [appId, chatId, chatType, ...scope] = sourceId?.split(':') ?? [];
  return { appId, chatId, chatType, scope };
};

/**
 * sourceId 形状为 `<appId>:…`、会话直接归属某个飞书机器人的会话来源（主会话、群协作、
 * 记忆/决策/回复后台会话、插件触发器）。新增 bot 作用域会话类型时在此登记一处，
 * 模型服务归属、用量归集等调用方都从这里识别；注意 lark-leader 的 sourceId 是委托
 * 记录 id（不含 appId），work_item 的 sourceId 是 attempt id，二者都只能沿父会话链找归属。
 */
export const larkScopedSessionSources = ['lark', 'lark-memory', 'lark-decision', 'lark-response', 'plugin_trigger'] as const;

/** 会话直接绑定的机器人 appId；非 bot 作用域会话返回 undefined（调用方再沿父会话链查找）。 */
export const botAppIdOfSession = (session: { source?: string | null; sourceId?: string | null }): string | undefined =>
  (larkScopedSessionSources as readonly string[]).includes(session.source ?? '')
    ? parseLarkSourceId(session.sourceId).appId : undefined;
