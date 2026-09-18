import type { AdapterSessionContext, CliAdapter, PtyLike } from '../types.js';
import { isDutydeckSessionId, usableResumeId } from '../resume-id.js';

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Reasonix Bubble Tea TUI 适配器。
 *
 * Reasonix 每轮结束后不发稳定的就绪标记，也没有可靠的 busy 标记，
 * 就绪判定完全靠 PTY 静默（quiescence）。
 *
 * 当前不支持的能力：不支持从 lease 文件（按进程树 pid 匹配）反查会话 stem
 * 来捕获 cliSessionId。精简契约里适配器不能读文件系统 / 拿不到 CLI pid，
 * 这套捕获无法表达——没有 driver 交回的精确 id 时，每次重启都会新起会话。
 * 也绝不用 `reasonix session list`：它报的是 `session_<hmac>` 这类不透明机器
 * id（只有 `session show|status|recovery` 查询面接受），而且首轮持久化之前
 * 根本不列出该会话。
 */
export function createReasonixAdapter(): CliAdapter {
  return {
    id: 'reasonix',
    capabilities: { resume: true },

    buildArgs({ resume, resumeSessionId, model, permissionMode }: AdapterSessionContext): string[] {
      const args: string[] = permissionMode === 'full-trust' ? ['--yolo'] : [];
      if (model && model.trim()) {
        args.push('--model', model.trim());
      }
      // 只做精确 id 续接。缺原生 id 时新起会话，绝不用 cwd 维度的 `--continue`：
      // 同一工作目录下它可能选中另一个话题的会话。
      const usable = usableResumeId(resumeSessionId);
      if (resume && usable) {
        args.push('--resume', usable);
      }
      return args;
    },

    async writeInput(backend: PtyLike, prompt: string): Promise<void> {
      if (backend.sendText && backend.sendSpecialKeys) {
        if (backend.sendText(prompt) === false) return;
        await delay(200);
        backend.sendSpecialKeys('Enter');
      } else {
        backend.write(prompt);
        await delay(1000);
        backend.write('\r');
      }
    },

    /** Reasonix 自己铸会话 id（精简契约下 dutydeck 拿不到精确 id）；收到 dutydeck 的
     *  `ses_<uuid>` → null，driver 改起新会话。 */
    buildResumeCommand(sessionId: string): string[] | null {
      if (isDutydeckSessionId(sessionId)) return null;
      return ['--resume', sessionId];
    },
  };
}
