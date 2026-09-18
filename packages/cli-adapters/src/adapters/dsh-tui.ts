import type { AdapterSessionContext, CliAdapter, PtyLike } from '../types.js';

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * dsh-tui 适配器 —— DeepSeek Harness 的 PTY 驱动全屏 TUI 变体。
 *
 * 与 headless 的 `dsh`（走 JSON-RPC runner）不同，这里**不是** runner 类：直接
 * 通过 PTY 驱动 `dsh-tui` 的 Ink TUI，交互模型与 claude-code 一致，写入走普通
 * TUI 键入而非控制帧。
 *
 * `dsh-tui` 二进制本身是个 launcher，启动 `dsh --profile dsh-tui`：
 *   - 位置参数会被当成初始 prompt，但这里**故意不**把 prompt 塞进 argv：launcher
 *     会把形似路径/URL 的位置参数当作工作区目标（DSH_TUI_WORKSPACE_TARGET），
 *     一条恰好长得像路径的 prompt 会被劫持。所有 prompt 一律走 writeInput。
 *   - `--resume` 由 launcher 拦截（从 ~/.dsh-tui/resume.txt 读 DSH_TUI_RESUME_SESSION），
 *     这里透传用于会话恢复。
 *
 * 不实现 buildResumeCommand：裸 `--resume` 读的是 resume.txt 里的「最后一个会话」，
 * 不按 dutydeck 会话隔离，交给用户可能恢复到别的会话去。
 */
export function createDshTuiAdapter(): CliAdapter {
  return {
    id: 'dsh-tui',
    // resume 能力位为否：buildArgs 虽能接 --resume（driver 回填 resumeSessionId
    // 时可用），但没有 buildResumeCommand——裸 --resume 读的是 ~/.dsh-tui/resume.txt
    // 里的「最后一个会话」，不按 dutydeck 会话隔离，可能恢复到兄弟会话去；显式 id
    // 又要 TUI 自己铸的 session id（driver 拿不到），故返回 null。
    capabilities: {},

    buildArgs({ resume, resumeSessionId }: AdapterSessionContext): string[] {
      const args: string[] = [];
      if (resume) {
        // 裸 --resume 让 launcher 去读 ~/.dsh-tui/resume.txt；显式 session id 原样透传。
        if (resumeSessionId) args.push('--resume', resumeSessionId);
        else args.push('--resume');
      }
      return args;
    },

    async writeInput(backend: PtyLike, prompt: string): Promise<void> {
      if (backend.sendText && backend.sendSpecialKeys) {
        backend.sendText(prompt);
        await delay(200);
        backend.sendSpecialKeys('Enter');
      } else {
        backend.write(prompt);
        await delay(1000);
        backend.write('\r');
      }
    },

    // TUI 的 PromptInput 用 `❯ ` 作提示符（turn 进行中变暗但仍在）。它一直可见，
    // 所以单靠 readyPattern 无法判定 idle —— 真正的完成信号是静默（turn 结束时
    // spinner 停止）。
    readyPattern: /❯/,
  };
}
