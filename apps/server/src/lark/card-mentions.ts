// 飞书卡片 markdown 内的群 @ 助手（P0-4 N1 用）。
// 语法依据是飞书卡片 markdown 组件官方文档 `<at id=open_id></at>`：属性名是 id，
// 标签体为空，平台自动填名字；@所有人是 `<at id=all></at>`。
// 相对文本消息链路的加固（卡片是持久化渲染面，输入来自任务记录而非当场查到的群成员）：
//   - openId 做 ID 字符集白名单校验，非法值拒绝产出标签（杜绝属性注入）。
//
// 平台前提（终裁 V1，未真机验证）：普通交互卡（非延时卡）内的 <at> 在群免打扰下
// 能否锁屏触达，证据库只有「消息里 @ 人」的一般性核证，没有卡片内实测结论。使用约束：
//   1. 只用于需要人行动或终态的卡（结果卡卡尾 @，审批/提问卡卡首 @），且只 @ 任务发起人；
//   2. 排队卡、心跳卡永不使用（仅 PATCH，不承担触达，终裁 §6 通知策略）；
//   3. 私聊（p2p）永不使用（无必要，调用前先过 isGroupChat）；
//   4. V1 真机核查通过前，不得承诺卡内 @ 的锁屏触达效果；
//   5. 发起人是机器人时永不使用：机器人之间互相 @ 正是刷屏回路的燃料。

/** 飞书 open_id 属性位只放行平台 ID 字符集，异常值拒绝产出标签，杜绝属性注入。 */
const SAFE_OPEN_ID = /^[A-Za-z0-9_-]+$/;

/** 群聊判定。仓内 chat_type 字面量只有 'group' / 'p2p'（见 coordinator、agent-tools 绑定）。 */
export function isGroupChat(chatType: string | undefined): boolean {
  return chatType === 'group';
}

/**
 * 渲染可嵌入卡片 markdown 的 at 串。openId 非法（空或含属性位之外字符）时返回 undefined，
 * 由调用方跳过 at——卡片渲染不允许为了 @ 拼出半截标签。
 */
export function renderGroupMention(openId: string): string | undefined {
  const id = openId?.trim();
  if (!id || !SAFE_OPEN_ID.test(id)) return undefined;
  return `<at id=${id}></at>`;
}

/** 飞书事件里的机器人发送方。仓内 sender_type 字面量为 'user' / 'app' / 'bot'。 */
export function isBotSenderType(senderType: string | undefined): boolean {
  return senderType === 'app' || senderType === 'bot';
}

/**
 * 群内卡片 @ 回发起人的唯一入口，一次性落实上述约束 1、3 与 5。
 * 调用方只判「这张卡该不该 @」，不再各自重复拼开关、群聊与发送方类型三个条件。
 */
export function senderGroupMention(
  enabled: boolean | undefined,
  event: { chatType?: string; senderOpenId?: string; senderType?: string }
): string | undefined {
  if (enabled !== true || !isGroupChat(event.chatType) || !event.senderOpenId || isBotSenderType(event.senderType)) return undefined;
  return renderGroupMention(event.senderOpenId);
}
