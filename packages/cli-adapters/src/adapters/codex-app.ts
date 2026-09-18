import type { AdapterSessionContext, CliAdapter, PtyLike } from '../types.js';
import { writeRunnerInput } from '../runner-input.js';

/**
 * Codex App 适配器 —— runner 类：由一个 Node runner 通过 app-server 协议
 * （`codex app-server`）驱动 Codex，不驱动 TUI。
 *
 * ⚠️ 本适配器只构建 runner 参数，command 须指向已安装 runner，不含路径探测/鉴权/沙箱管理。
 *
 * Codex App 的 thread 由 runner 经 app-server 协议恢复，没有稳定的用户可见 CLI
 * deeplink 能精确定位一个 desktop thread，故不实现 buildResumeCommand。runner
 * 自己注入上下文，也就不实现 injectSessionContext。
 */

/** value 为 undefined 或空串就跳过。 */
function pushOpt(args: string[], key: string, value: string | undefined): void {
  if (value === undefined || value.length === 0) return;
  args.push(key, value);
}

export function createCodexAppAdapter(): CliAdapter {
  return {
    id: 'codex-app',
    // resume 能力位为否：buildArgs 虽能接 --thread-id（driver 回填
    // resumeSessionId 时可用），但没有 buildResumeCommand——thread id 是
    // app-server 铸的，driver 的 resume() 只拿得到 dutydeck sessionId，拼出来
    // 必然指向不存在的 thread，故返回 null。
    capabilities: {},

    buildArgs({ sessionId, resume, resumeSessionId, cwd, model, reasoningEffort, locale }: AdapterSessionContext): string[] {
      const args = ['--session-id', sessionId];
      if (resume && resumeSessionId) args.push('--thread-id', resumeSessionId);
      pushOpt(args, '--cwd', cwd);
      pushOpt(args, '--locale', locale);
      // 每轮覆盖项：runner 把它们注入 app-server 的 thread/start
      // （model + config.model_reasoning_effort）。
      pushOpt(args, '--model', model && model.trim() ? model.trim() : undefined);
      pushOpt(args, '--reasoning-effort', reasoningEffort);
      return args;
    },

    async writeInput(backend: PtyLike, prompt: string): Promise<void> {
      // 分块 + 节流 stdin 注入：整条控制行（可能 ~20KB）一次 send-keys 会溢出
      // pane pty 输入缓冲并被丢弃。
      await writeRunnerInput(backend, '::dutydeck-codex-app:', prompt);
    },

    readyPattern: /›/,
  };
}
