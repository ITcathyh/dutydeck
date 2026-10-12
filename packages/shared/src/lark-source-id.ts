/** 飞书会话的 sourceId：`appId:chatId:chatType[:scope…]`，由 server 的 larkSourceId 生成；没有 scope 表示整个聊天共用一个会话。 */
export const parseLarkSourceId = (sourceId: string | null | undefined) => {
  const [appId, chatId, chatType, ...scope] = sourceId?.split(':') ?? [];
  return { appId, chatId, chatType, scope };
};
