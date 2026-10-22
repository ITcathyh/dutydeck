import { relayCommandEnvKey, relayTokenEnvKey, relayUrlEnvKey } from './capability.js';

/**
 * 回传通道的提示文案。
 *
 * ## 为什么这里是「函数」而不是静态常量
 *
 * `larkGroupToolsPrompt` 明确要求「不要改用 PATH 中的其他 dutydeck」，因为多安装
 * 共存时裸 `dutydeck` 可能命中另一个版本，其 token 与本 daemon 不匹配。正确的前缀是
 * `dutydeckGroupToolsCommand()` 在运行期算出的 `'<node>' '<abs>/cli.js'`——
 * 静态字符串常量拿不到它，因此群工具提示必须在运行时按 Session 注入。
 *
 * 但 `DUTYDECK_SHELL_HINTS` 的消费方（pty-driver、各 adapter 的
 * `injectSessionContext`）都不持有那个前缀：`groupToolsCommand` 只存在于
 * service.ts → LarkAgentToolsService，从没下发到 driver 层。
 *
 * 解法：**把前缀经 env 下发，在文案构造时读回**。服务端 `environmentFor()` 已经要
 * 给子进程注入 `dutydeck_relay_url` / `dutydeck_relay_token`，顺带注入
 * `dutydeck_relay_command`（同一份运行期绝对路径）。driver 拼提示块时
 * 从 `agent.env` 取——那一刻 env 已经被 `configureAgentForSession` 合并好了。
 * 于是「运行期路径」与「静态文案」的矛盾在**注入点**解决，无需改动 driver 与
 * adapter 的既有签名（它们照旧调 `buildDutydeckRoutingBlock()`，只是多接一个可选参数）。
 *
 * 取不到前缀时回退到裸 `dutydeck`——单安装场景仍可用，与 `larkGroupToolsPrompt`
 * 的 `command = 'dutydeck'` 默认值一致。
 */
export interface RelayPromptEnv {
  [relayUrlEnvKey]?: string;
  [relayTokenEnvKey]?: string;
  [relayCommandEnvKey]?: string;
  [key: string]: string | undefined;
}

/** 从注入的 env 里解析出应当写进提示文案的命令前缀 */
export function relayCommandFrom(env: RelayPromptEnv = {}): string {
  return env[relayCommandEnvKey]?.trim() || 'dutydeck';
}

/**
 * Claude PermissionRequest hook 的超时（秒）。飞书审批最长等 24 小时才自动拒绝，hook 自己在 24 小时 5 分钟时拒绝；
 * Claude 侧超时再多留 5 分钟，确保 hook 总能先交回明确的拒绝，而不是被 Claude 取消后退回终端确认。
 */
export const relayPermissionHookTimeoutSeconds = 24 * 60 * 60 + 10 * 60;

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
    `中途进展用 ${command} session send "内容"；成功只表示事件已发布，实际展示取决于会话设置，不证明 IM 已送达。${env.dutydeck_session_source === 'lark' ? '' : '最终答复直接输出，由运行时按设置交付。'}`,
    `需要用户决定时用 ${command} session ask "问题"，仅退出 0 表示已回答，答案从 stdout 返回；2 表示参数或凭证缺失等用法错误，3 表示通道不可用、提问取消或已登记持久确认，124 表示超时。结构化单选直接用 --choices '[{"label":"选项"}]'；Claude 可直接用原生 AskUserQuestion，宿主会转成提问卡；其他参数按需查看同一命令的 session ask --help（无需服务或凭证）。只发送真实问题，不发测试卡；返回 deferred 表示确认已登记，宿主结束本轮，等待用户点击后另起一轮，不是用户取消或操作完成。`,
    '必须原样使用完整绑定命令，不要改用 PATH 中其他 dutydeck；超时或通道不可用不能视为用户已回答。'
  ];
}
