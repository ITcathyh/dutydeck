import type { AdapterSessionContext, CliAdapter, PtyLike } from '../types.js';
import { isDutydeckSessionId, usableResumeId } from '../resume-id.js';

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Google Antigravity CLI（`agy`）适配器。数据落在 `~/.gemini/antigravity-cli/`
 * （复用 Gemini CLI 的 home，独立子目录）。
 *
 * 下面的结论都是对 agy 1.0.0 实测出来的，别按 Gemini CLI 的直觉改：
 *  - bracketed paste（`\e[200~…\e[201~`）**无效**：agy 把标记当字面字符打进
 *    composer，只能逐行 sendText + 软换行。
 *  - 软换行是 M-Enter（alt+Enter），**不是** Claude Code 的 `\` + Enter——agy
 *    不把反斜杠当转义。
 *  - `-i / --prompt-interactive` 虽然存在，但实测**不自动提交**，且首轮 prompt
 *    会静默消失，所以不声明 initialPromptViaArgs，首条消息一律走 writeInput。
 */
export function createAntigravityAdapter(): CliAdapter {
  return {
    id: 'antigravity',
    capabilities: { resume: true },

    buildArgs({ resume, resumeSessionId, permissionMode }: AdapterSessionContext): string[] {
      const args: string[] = permissionMode === 'full-trust' ? ['--dangerously-skip-permissions'] : [];
      // 只做精确 id 续接：agy 在 spawn 时自己生成 conversation id 并忽略外部传值，
      // `--conversation` 严格按既有 id 查找，所以 dutydeck 的 sessionId 在这里没用。
      // 无 resumeSessionId 时新起会话；绝不用 `-c/--continue`——"最近一个"在多会话
      // 并行时会串到兄弟会话。
      const usable = usableResumeId(resumeSessionId);
      if (resume && usable) {
        args.push('--conversation', usable);
      }
      return args;
    },

    async writeInput(backend: PtyLike, prompt: string): Promise<void> {
      const lines = prompt.split('\n');
      if (backend.sendText && backend.sendSpecialKeys) {
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (line && line.length > 0) backend.sendText(line);
          if (i < lines.length - 1) backend.sendSpecialKeys('M-Enter');
        }
      } else {
        // 裸 PTY 回退：ESC + CR 就是 M-Enter 的字节形态。
        for (let i = 0; i < lines.length; i++) {
          backend.write(lines[i] ?? '');
          if (i < lines.length - 1) backend.write('\x1b\r');
        }
      }
      await delay(300);
      // 单次 Enter，**绝不重试**：agy 的提交落盘可能远晚于任何短窗口（冷启动、
      // 大 prompt、网络态鉴权），重试的 Enter 会落在已提交的 composer 上，把同一
      // 条 prompt 重复提交多次。
      if (backend.sendSpecialKeys) backend.sendSpecialKeys('Enter');
      else backend.write('\r');
    },

    /** agy 自己铸 conversation UUID 并忽略外部传值，`--conversation` 严格按既有
     *  id 查找。收到 dutydeck 的 `ses_<uuid>` 必然查不到 → null，改起新会话。 */
    buildResumeCommand(sessionId: string): string[] | null {
      if (isDutydeckSessionId(sessionId)) return null;
      return ['--conversation', sessionId];
    },
  };
}
