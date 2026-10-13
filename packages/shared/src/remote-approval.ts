/**
 * 终端模式里能把工具确认交给飞书 / Web 处理的 CLI 适配器：Claude Code 家族经 PermissionRequest hook 回传。
 * 其它终端模式 CLI 的确认只能在终端里点。
 */
export const remoteApprovalCliAdapterIds: readonly string[] = ['claude-code', 'seed', 'relay'];

/**
 * Agent 的工具确认能否在飞书逐项审批。ACP 走协议自带的权限请求；auto 通常解析为 ACP，
 * 解析成别的协议时由会话路由在启动后按实际协议拦下。
 */
export const supportsRemoteApproval = (agent: { id: string; protocol: string; adapterId?: string }) =>
  agent.protocol === 'acp' || agent.protocol === 'auto'
  || (agent.protocol === 'pty-cli' && remoteApprovalCliAdapterIds.includes(agent.adapterId ?? agent.id));
