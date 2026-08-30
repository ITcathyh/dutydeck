import type { AdapterSessionContext, CliAdapter, PtyLike } from '../types.js';
import { buildDockmuxRoutingBlock } from '../shared-hints.js';

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export function createGrokAdapter(): CliAdapter {
  return {
    id: 'grok',
    capabilities: { resume: true },

    buildArgs({
      sessionId,
      resume,
      resumeSessionId,
      model,
      reasoningEffort,
      initialPrompt,
    }: AdapterSessionContext): string[] {
      const args: string[] = [
        // 无人值守 YOLO（对应 claude 的 --dangerously-skip-permissions）。
        '--always-approve',
        // 对齐 claude 的 EnterPlanMode/ExitPlanMode 禁用：IM 场景驱动不了
        // plan 审批 TUI。
        '--no-plan',
      ];
      if (model && model.trim()) {
        args.push('--model', model.trim());
      }
      if (reasoningEffort && reasoningEffort.trim()) {
        args.push('--reasoning-effort', reasoningEffort.trim());
      }
      if (resume) {
        // 精确 resume：fresh spawn 会把 --session-id 钉到 dockmux 的 UUID，
        // 所以 dockmux sessionId 就是 grok 会话 id。绝不 --continue（会续接
        // 全局最近会话，串到兄弟会话上下文）。
        const sid = resumeSessionId || sessionId;
        if (sid) {
          args.push('--resume', sid);
        }
      } else if (sessionId) {
        // 把 grok 会话 id 钉到 dockmux 的 UUID，resume 才能精确复用。
        // （botmux 在这里有 grokSessionDirExists 探测，避免 id 冲突 exit 1；
        // 该文件系统探测已丢弃，dockmux 的会话 id 每次新生成，冲突概率可忽略。）
        args.push('--session-id', sessionId);
      }
      // 位置参数首轮 prompt：TUI 启动后处理，fresh / resume spawn 都生效。
      if (initialPrompt) {
        args.push(initialPrompt);
      }
      return args;
    },

    // 会话上下文（路由块）由 driver 拼到首轮 prompt 前（botmux 走 --rules，
    // 精简契约统一走 prompt 前缀）。
    injectSessionContext(ctx: AdapterSessionContext): string {
      return buildDockmuxRoutingBlock(ctx.locale, ctx.env);
    },

    async writeInput(backend: PtyLike, prompt: string): Promise<void> {
      // grok 把字面 \n 当 composer 内的软换行（不是提交），直接发整段即可。
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

    buildResumeCommand(sessionId: string): string[] {
      return ['--resume', sessionId];
    },

    readyPattern: /❯/,
    busyPattern: /Waiting for response|Ctrl\+c:\s*cancel/i,
  };
}
