import type { AdapterSessionContext, CliAdapter, PtyLike } from '../types.js';
import { writeRunnerInput } from '../runner-input.js';

/**
 * dsh（DeepSeek Harness）适配器 —— runner 类：由一个 Node runner 以 JSON-RPC
 * 桥接 `dsh-jsonrpc-agent`，不驱动 TUI（TUI 形态见 dsh-tui 适配器）。
 *
 * ⚠️ 本适配器只构建 runner 参数，command 须指向已安装 runner，不含路径探测/鉴权/沙箱管理
 * （不自动为文件沙盒预建目录等文件系统副作用）。
 *
 * 会话活在 runner 的 JSON-RPC 连接内部，没有稳定的用户可见 CLI deeplink 可以
 * 恢复，故不实现 buildResumeCommand。runner 自己注入上下文，也就不实现
 * injectSessionContext。
 */

/** value 为 undefined 或空串就跳过。 */
function pushOpt(args: string[], key: string, value: string | undefined): void {
  if (value === undefined || value.length === 0) return;
  args.push(key, value);
}

export function createDshAdapter(): CliAdapter {
  return {
    id: 'dsh',
    // buildArgs 完全不看 resume：会话是 runner JSON-RPC 连接内的状态，
    // 适配器层面没有 resume 参数可接。
    capabilities: {},

    buildArgs({ sessionId, cwd, model, locale }: AdapterSessionContext): string[] {
      const args = ['--session-id', sessionId];
      pushOpt(args, '--cwd', cwd);
      pushOpt(args, '--locale', locale);
      pushOpt(args, '--model', model && model.trim() ? model.trim() : undefined);
      return args;
    },

    async writeInput(backend: PtyLike, prompt: string): Promise<void> {
      // 分块 + 节流 stdin 注入：整条控制行一次 send-keys 会溢出 pane pty 输入缓冲。
      await writeRunnerInput(backend, '::dutydeck-dsh:', prompt);
    },

    readyPattern: /›/,
  };
}
