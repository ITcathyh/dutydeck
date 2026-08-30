/**
 * 会话提示块注入机制（移植自 botmux `shared-hints.ts`，精简形态）。
 *
 * botmux 版教 CLI 用 `botmux send` 回传消息；dockmux 的对应命令是
 * `dockmux session send` / `dockmux session ask`（M3 通用回传通道，见 @dockmux/relay）。
 * 注入机制保留：
 *
 *  - 不实现 `injectSessionContext` 的适配器（codex / gemini / opencode /
 *    cursor / kimi / traex）：driver 用 `prependRoutingBlock` 把路由块拼进
 *    首轮 prompt 前。
 *  - 实现 `injectSessionContext` 的适配器（claude-code / grok）：适配器返回
 *    上下文块，driver 同样拼进首轮 prompt 前。契约统一走 prompt 前缀，
 *    不再走 botmux 的 `--append-system-prompt` / `--rules` flag。
 *
 * ## 为什么回传命令这几行要「运行期算」
 *
 * 正确的命令前缀是 `'<node>' '<abs>/cli.js'` 这种绝对路径形态（理由见
 * `apps/server/src/lark/agent-tools.ts` 的 `larkGroupToolsPrompt`：多安装共存时
 * 裸 `dockmux` 可能命中另一个安装，其凭证在本会话无效）。静态常量拿不到运行期路径。
 *
 * 解法是**经会话 env 下发**：服务端注入子进程的 `dockmux_relay_command` 就是那个
 * 运行期前缀，`relayHintLines(env)` 在拼文案时读回。所以下面的
 * `DOCKMUX_SHELL_HINTS` 退化为「与回传无关的通用提示」，回传相关的行由
 * `buildDockmuxRoutingBlock(locale, env)` 在运行期补。不传 env 时回退到
 * 「直接输出文本」的旧文案，行为不回归。
 */
import { relayHintLines, type RelayPromptEnv } from '@dockmux/relay';

/** 与回传通道无关的通用提示（静态部分） */
export const DOCKMUX_SHELL_HINTS: readonly string[] = [
  '你运行在一个 IM 桥接的会话中：用户看不到你的终端，只能看到你回传的内容。',
  '多行或长内容用引号 / heredoc 包裹，避免被拆成多条消息。',
];

/**
 * 路由块文本。
 * @param locale 预留给 i18n，MVP 只有中文静态文案
 * @param env    会话 env（含 relay 注入的 url/token/command）；不传则不含回传命令说明
 */
export function buildDockmuxRoutingBlock(locale?: string, env?: RelayPromptEnv): string {
  void locale;
  return [
    '<dockmux_routing>',
    ...DOCKMUX_SHELL_HINTS.map(hint => `  ${hint}`),
    ...relayHintLines(env ?? {}).map(hint => `  ${hint}`),
    '</dockmux_routing>',
  ].join('\n');
}

/** 把路由块拼到首轮 prompt 前（非 injectSessionContext 适配器的注入入口）。 */
export function prependRoutingBlock(prompt: string, locale?: string, env?: RelayPromptEnv): string {
  return `${buildDockmuxRoutingBlock(locale, env)}\n\n${prompt}`;
}
