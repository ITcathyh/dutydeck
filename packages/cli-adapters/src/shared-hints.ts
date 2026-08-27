/**
 * 会话提示块注入机制（移植自 botmux `shared-hints.ts`，精简形态）。
 *
 * botmux 版教 CLI 用 `botmux send` 回传消息；dockmux 的回传命令 M2 才定，
 * 下方文案中相关位置留 TODO。注入机制保留：
 *
 *  - 不实现 `injectSessionContext` 的适配器（codex / gemini / opencode /
 *    cursor / kimi / traex）：driver 用 `prependRoutingBlock` 把路由块拼进
 *    首轮 prompt 前。
 *  - 实现 `injectSessionContext` 的适配器（claude-code / grok）：适配器返回
 *    上下文块，driver 同样拼进首轮 prompt 前。契约统一走 prompt 前缀，
 *    不再走 botmux 的 `--append-system-prompt` / `--rules` flag。
 */

// TODO(M2): dockmux 的回传命令确定后替换（botmux 版为 `botmux send "..."`）。
export const DOCKMUX_SHELL_HINTS: readonly string[] = [
  '你运行在一个 IM 桥接的无人值守会话中：用户看不到终端，只能看到你输出的文本。',
  // TODO(M2): 回传命令（例如 `dockmux send "..."`）确定后补全这一行。
  '需要向用户回传内容时，直接输出文本即可（专用回传命令 M2 接入）。',
  '多行或长内容用引号 / heredoc 包裹，避免被拆成多条消息。',
  '需要用户决策才能继续时，直接在输出里说明阻塞点；无人值守，不会有人实时回答。',
];

/** 路由块文本。`locale` 预留给 i18n（M2），MVP 只有中文静态文案。 */
export function buildDockmuxRoutingBlock(locale?: string): string {
  void locale;
  return [
    '<dockmux_routing>',
    ...DOCKMUX_SHELL_HINTS.map(hint => `  ${hint}`),
    '</dockmux_routing>',
  ].join('\n');
}

/** 把路由块拼到首轮 prompt 前（非 injectSessionContext 适配器的注入入口）。 */
export function prependRoutingBlock(prompt: string, locale?: string): string {
  return `${buildDockmuxRoutingBlock(locale)}\n\n${prompt}`;
}
