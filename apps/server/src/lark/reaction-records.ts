// 文件型结果的验收 reaction 与本地幂等记录（S4）。
// 流程（由主控接线）：验收决议落库后 -> reactionDedupeKey 查 kv -> 无记录才
// service.addReaction(messageId, emojiType) -> 存 reactionId；重启对账先查后写，不重复。
//
// emoji_type 短名取自开放平台官方表情表
// （https://open.feishu.cn/document/server-docs/im-v1/message-reaction/emojis-introduce，
// 2026-09-13 核证，全表 182 个短名；短名存在性与表情图片已从官方 CDN 逐一核实）：
// - 验收通过 = 'CheckMark'：绿色对勾，即终裁要求的 ✅。同表 'DONE' 是带 DONE 字样的
//   卡通徽章（眨眼黄脸+绿色 DONE 牌），不是纯对勾，故不采用；
// - 需要修改 = 'Typing'：敲键盘表情。官方表中没有 📝/备忘录/铅笔类短名（已全表核查），
//   这是语义最接近「回去改」的可用项，属产品取值——真机上的表意是否被用户准确理解
//   未真机验证；V3（reaction 对文件消息可用性/幂等、是否产生红点）通过前，reaction
//   永不承担通知职责，验收通知仍以独立结果新消息为准。
// 仓内入群接收回执用的是 'OK'（👌，coordinator.ts addReaction），与验收对勾语义不同，不复用。

/** 验收决议（workflow-interactions respond 的 action）到飞书 emoji_type 短名的映射。 */
export const ACCEPTANCE_REACTION_EMOJI = {
  accept: 'CheckMark',
  changes: 'Typing'
} as const;

export type AcceptanceAction = keyof typeof ACCEPTANCE_REACTION_EMOJI;

/**
 * 「完成时只贴表情」贴在**原始请求消息**上的 emoji_type 短名。
 *
 * 与验收对勾同字形但不同位置、不同语义：验收贴在结果附件上，这一枚贴在用户那条请求上，
 * 意思只有一个——这一轮做完了。开关关闭时永不出现，失败终态也永不出现（失败仍发结果卡）。
 */
export const COMPLETION_REACTION_EMOJI = 'CheckMark';

/** 取验收决议对应的 emoji_type 短名；未知 action 返回 undefined，由调用方放弃 reaction。 */
export function reactionEmojiForAcceptance(action: string): string | undefined {
  return (ACCEPTANCE_REACTION_EMOJI as Record<string, string>)[action];
}

/**
 * 本地幂等记录 key，风格对齐 lark.interaction.${appId}.* / lark.welcomed.${appId}.*。
 * 三个入参都取自平台 ID/官方短名（om_* messageId、字母短名），直接拼接不再转义；
 * 同一 (appId, messageId, emojiType) 永远生成同一 key，重启对账据此判重。
 */
export function reactionDedupeKey(appId: string, messageId: string, emojiType: string): string {
  return `lark.reaction.${appId}.${messageId}.${emojiType}`;
}

/** kv 中保存的 reaction 记录（值由主控 JSON.stringify）。 */
export interface ReactionRecord {
  messageId: string;
  emojiType: string;
  /** addReaction 回传的 reaction_id，保留以便将来撤销；本期只写不删。 */
  reactionId: string;
  createdAt: string;
}

/**
 * 判定一次结果交付是否为文件型消息（S4 只给文件消息补 reaction）。
 *
 * 判据与 result-delivery.sendLarkResult 的返回形状对齐：output 能内联进结果卡时
 * 回传 elements 数组；超长 output 转存「执行结果.md」走 replyFile/sendFile 时，
 * 返回 { messageId, elements: undefined }。coordinator 把该返回值原样存到
 * task.finalElements，因此两种传法都可以：
 *   isFileResultDelivery(sendLarkResultReturn)
 *   isFileResultDelivery({ elements: task.finalElements })
 * 另：artifact-delivery.deliverArtifact 的返回值（文件/图片消息，天然不含 elements）
 * 同样判 true；本期接线点只在结果验收（interaction kind === 'result'）决议之后。
 */
export function isFileResultDelivery(delivery: { elements?: unknown } | null | undefined): boolean {
  return Boolean(delivery) && delivery!.elements === undefined;
}
