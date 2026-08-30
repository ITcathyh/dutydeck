import type { AdapterSessionContext, CliAdapter, PtyLike } from '../types.js';

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** OpenCode 原生会话 id 形态（V2 与 V1 同规则）：`ses_` + 纯字母数字。 */
const OPENCODE_SESSION_ID_RE = /^ses_[0-9A-Za-z]+$/;

/** 超过该长度（或含换行）的内容走 pasteText，避免 TUI paste 检测折叠。 */
const OPENCODE_PASTE_THRESHOLD = 150;

/**
 * OpenCode 2.0（`opencode2`）适配器。V2 是 1.x 的下一个主版本（beta，二进制名
 * `opencode2`，与 V1 可并行安装）。与 V1 适配器的两处关键差异：
 *
 *  - **顶层 TUI 没有 `--model`**（只有 `run` 子命令有）。传了会被当 unknown flag
 *    直接打印帮助退出，所以 buildArgs 绝不注入 model——模型只能由 opencode 配置
 *    / UI 决定。
 *  - **`--prompt` 不自动提交**：实测只把 prompt 填进 composer 就停住。因此不声明
 *    initialPromptViaArgs，首条消息一律走 writeInput，fresh 与 resume 路径一致。
 */
export function createOpenCode2Adapter(): CliAdapter {
  return {
    id: 'opencode2',
    capabilities: { resume: true },

    buildArgs({ resume, resumeSessionId }: AdapterSessionContext): string[] {
      const args: string[] = [];
      // 只做精确 id 续接；无有效 id 时新起会话（botmux 的 SQLite 反查已丢弃）。
      // 绝不带无效 id 启动：`Session not found` 会让进程立即退出。
      if (resume && resumeSessionId && OPENCODE_SESSION_ID_RE.test(resumeSessionId)) {
        args.push('--session', resumeSessionId);
      }
      return args;
    },

    async writeInput(backend: PtyLike, prompt: string): Promise<void> {
      // 斜杠命令是 TUI 命令面板输入，必须逐字键入（paste 会被面板吃掉）。
      const isSlashCommand = prompt.startsWith('/');
      if (backend.sendText && backend.sendSpecialKeys) {
        if (!isSlashCommand && backend.pasteText
          && (prompt.length > OPENCODE_PASTE_THRESHOLD || prompt.includes('\n'))) {
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
