import type { AdapterSessionContext, CliAdapter, PtyLike } from '../types.js';

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** 超过该长度（或含换行）的内容走 pasteText，避免 TUI paste 检测折叠。 */
const OPENCODE_PASTE_THRESHOLD = 150;

export function createOpenCodeAdapter(): CliAdapter {
  return {
    id: 'opencode',
    capabilities: { resume: true, initialPromptViaArgs: true },

    buildArgs({ resume, resumeSessionId, initialPrompt, model }: AdapterSessionContext): string[] {
      const args: string[] = [];
      if (model && model.trim()) {
        args.push('--model', model.trim());
      }
      // 只做精确 id 续接；无 id 时新起会话（botmux 的 SQLite 反查已丢弃）。
      // 绝不带无效 id 启动：`opencode -s <不存在的id>` 会立即 exit 1。
      if (resume && resumeSessionId) {
        args.push('--session', resumeSessionId);
      }
      // 首轮 prompt 走 --prompt：Bubble Tea TUI 启动期的 stdin 写入可能丢失。
      // 注意：`-s` resume 下 --prompt 会被 OpenCode 静默忽略——driver 需要在
      // resume 时把首轮 prompt 改走 writeInput（botmux 靠
      // initialPromptArgsIgnoredOnResume 标记，精简契约里由 driver 自行处理）。
      if (initialPrompt) {
        args.push('--prompt', initialPrompt);
      }
      return args;
    },

    async writeInput(backend: PtyLike, prompt: string): Promise<void> {
      if (backend.sendText && backend.sendSpecialKeys) {
        if (backend.pasteText && (prompt.length > OPENCODE_PASTE_THRESHOLD || prompt.includes('\n'))) {
          backend.pasteText(prompt);
        } else {
          backend.sendText(prompt);
        }
        await delay(200);
        backend.sendSpecialKeys('Enter');
      } else {
        backend.write(prompt);
        await delay(1000);
        backend.write('\r');
      }
    },

    buildResumeCommand(sessionId: string): string[] {
      return ['-s', sessionId];
    },
  };
}
