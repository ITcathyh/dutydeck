import { relayCommandEnvKey, relayTokenEnvKey, relayUrlEnvKey } from './capability.js';

/**
 * 回传通道的提示文案。
 *
 * ## 为什么这里是「函数」而不是静态常量
 *
 * `larkGroupToolsPrompt` 明确要求「不要改用 PATH 中的其他 dockmux」，因为多安装
 * 共存时裸 `dockmux` 可能命中另一个版本，其 token 与本 daemon 不匹配。正确的前缀是
 * `agentDockGroupToolsCommand()` 在运行期算出的 `'<node>' '<abs>/cli.js'`——
 * 静态字符串常量拿不到它（这也是 packages/skills/src/definitions.ts:18-26
 * 拒绝把 group 命令做成静态 SKILL.md 的原因）。
 *
 * 但 `DOCKMUX_SHELL_HINTS` 的消费方（pty-driver、各 adapter 的
 * `injectSessionContext`）都不持有那个前缀：`groupToolsCommand` 只存在于
 * service.ts → LarkAgentToolsService，从没下发到 driver 层。
 *
 * 解法：**把前缀经 env 下发，在文案构造时读回**。服务端 `environmentFor()` 已经要
 * 给子进程注入 `dockmux_relay_url` / `dockmux_relay_token`，顺带注入
 * `dockmux_relay_command`（同一份运行期绝对路径）。driver 拼提示块时
 * 从 `agent.env` 取——那一刻 env 已经被 `configureAgentForSession` 合并好了。
 * 于是「运行期路径」与「静态文案」的矛盾在**注入点**解决，无需改动 driver 与
 * adapter 的既有签名（它们照旧调 `buildDockmuxRoutingBlock()`，只是多接一个可选参数）。
 *
 * 取不到前缀时回退到裸 `dockmux`——单安装场景仍可用，与 `larkGroupToolsPrompt`
 * 的 `command = 'dockmux'` 默认值一致。
 */
export interface RelayPromptEnv {
  [relayUrlEnvKey]?: string;
  [relayTokenEnvKey]?: string;
  [relayCommandEnvKey]?: string;
  [key: string]: string | undefined;
}

/** 从注入的 env 里解析出应当写进提示文案的命令前缀 */
export function relayCommandFrom(env: RelayPromptEnv = {}): string {
  return env[relayCommandEnvKey]?.trim() || 'dockmux';
}

/** 该会话是否具备回传能力（env 齐全才有） */
export function relayEnabled(env: RelayPromptEnv = {}): boolean {
  return Boolean(env[relayUrlEnvKey]?.trim() && env[relayTokenEnvKey]?.trim());
}

/**
 * 生成教 CLI 使用回传命令的提示行。
 * 未注入 relay env 时返回兜底文案（「直接输出文本」），保持旧行为不回归。
 */
export function relayHintLines(env: RelayPromptEnv = {}): string[] {
  if (!relayEnabled(env)) {
    return ['需要向用户回传内容时，直接输出文本即可（本会话未启用专用回传命令）。'];
  }
  const command = relayCommandFrom(env);
  return [
    `需要在轮次中途主动告知用户时，用 ${command} session send "内容"——立刻送达，不必等本轮结束。`,
    `需要用户决策才能继续时，用 ${command} session ask "问题"：命令会阻塞，用户回答后答案从 stdout 返回（退出码 0）；超时退出 124，通道不可用退出 3。不要自己猜测用户的选择。`,
    `${command} 必须原样使用上面给出的完整路径，不要改用 PATH 中的其他 dockmux——其它安装的凭证在本会话无效。`
  ];
}
