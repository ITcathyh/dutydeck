// 任务卡终端模式提示（P0-7）。
//
// 已核事实（终裁 P0-7）：PTY driver 不提供 resolvePermission，getPendingPermissions
// 返回空；任务挂在终端自己的提示处时，飞书侧既看不到待批卡也收不到通知。
// 因此 pty / pty-cli 任务卡必须如实标注「终端确认只能在电脑前响应，飞书无法远程批准」，
// 文案上不得承诺手机能批 PTY。'auto' 的实际协议要等 runtime 解析后才知道，卡面不臆断。

import type { PermissionMode } from '@dutydeck/shared';

export const TERMINAL_PROTOCOL_NOTE = '终端模式：工具确认需在电脑前响应，飞书无法远程批准。';

/** 终端模式协议判定：pty / pty-cli 为真；auto 不算（解析结果未知）。 */
export function isTerminalProtocol(protocol: string | undefined): boolean {
  return protocol === 'pty' || protocol === 'pty-cli';
}

/**
 * 取协议对应的卡面提示；非终端协议（含 acp / jsonl / pipe / auto / 未知）返回 undefined。
 * 入参协议枚举为 shared 的 protocols（auto/acp/jsonl/pipe/pty/pty-cli），这里按 string
 * 接收，枚举值调用点直接传入即可。
 *
 * permissionMode 不参与判定：终端通道缺失是 pty 协议的内禀属性，即使 runtime 侧
 * full-trust，CLI 自身在终端内的提示飞书一样看不到、批不了；该参数仅为与任务卡
 * 渲染调用点（都持有 larkPermissionMode(config)）签名对齐而保留。
 */
export function protocolModeNote(
  protocol: string | undefined,
  _permissionMode?: PermissionMode
): string | undefined {
  return isTerminalProtocol(protocol) ? TERMINAL_PROTOCOL_NOTE : undefined;
}
