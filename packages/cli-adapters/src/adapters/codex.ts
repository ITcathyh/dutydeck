import type { AdapterSessionContext, CliAdapter, PtyLike } from '../types.js';

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Codex 活动态 busy 标记：turn 进行中重绘的状态行。 */
const CODEX_ACTIVE_BUSY_PATTERN = /Working[^\r\n]{0,160}esc to interrupt/i;

export function createCodexAdapter(): CliAdapter {
  return {
    id: 'codex',
    capabilities: { resume: true },

    buildArgs({ resume, resumeSessionId, cwd, model, reasoningEffort }: AdapterSessionContext): string[] {
      const args: string[] = [
        // dockmux MVP 无人值守：bypass 审批 + 沙箱（botmux !disableCliBypass 分支）。
        '--dangerously-bypass-approvals-and-sandbox',
        // botmux bypassHookTrust 默认 ON：跳过 0.14x 的 hook 信任交互门，
        // 否则无人值守的首个 turn 会永远卡在 "Press t to trust"。
        '--dangerously-bypass-hook-trust',
        '--no-alt-screen',
        // 启动更新选择器会吞掉首条消息，进程级关掉（不动用户全局 config）。
        '-c',
        'check_for_update_on_startup=false',
      ];
      if (model && model.trim()) {
        args.push('--model', model.trim());
      }
      if (reasoningEffort) {
        args.push('-c', `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`);
      }
      if (cwd) {
        args.push('-C', cwd);
      }
      // 只做精确 id 续接；无 resumeSessionId 时新起会话（botmux 的
      // history.jsonl 反查已随 transcript 机制一起丢弃）。
      if (resume && resumeSessionId) {
        return ['resume', ...args, resumeSessionId];
      }
      return args;
    },

    async writeInput(backend: PtyLike, prompt: string): Promise<void> {
      // Codex 把字面 \n 当 Enter，必须 bracketed paste 包住多行内容，
      // 否则一条多行消息会被拆成多个 turn。
      if (backend.pasteText) {
        backend.pasteText(prompt);
      } else {
        backend.write('\x1b[200~' + prompt + '\x1b[201~');
      }
      await delay(200);
      if (backend.sendSpecialKeys) backend.sendSpecialKeys('Enter');
      else backend.write('\r');
    },

    buildResumeCommand(sessionId: string): string[] {
      return ['resume', sessionId];
    },

    busyPattern: CODEX_ACTIVE_BUSY_PATTERN,
    idleToBusyPattern: CODEX_ACTIVE_BUSY_PATTERN,
    // 更新选择器也渲染 `› 1. Update now`，裸 › 会把菜单当成 composer，
    // 所以排除带序号的菜单行。
    readyPattern: /›(?!\s*\d+\.)|\d+% left/,
  };
}
