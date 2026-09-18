import type { AdapterSessionContext, CliAdapter, PtyLike } from '../types.js';
import { buildDutydeckRoutingBlock } from '../shared-hints.js';

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
      permissionMode,
    }: AdapterSessionContext): string[] {
      const args: string[] = ['--no-plan'];
      if (permissionMode === 'full-trust') args.unshift('--always-approve');
      if (model && model.trim()) {
        args.push('--model', model.trim());
      }
      if (reasoningEffort && reasoningEffort.trim()) {
        args.push('--reasoning-effort', reasoningEffort.trim());
      }
      if (resume) {
        // 精确 resume：fresh spawn 会把 --session-id 钉到 dutydeck 的 UUID，
        // 所以 dutydeck sessionId 就是 grok 会话 id。绝不 --continue（会续接
        // 全局最近会话，串到兄弟会话上下文）。
        const sid = resumeSessionId || sessionId;
        if (sid) {
          args.push('--resume', sid);
        }
      } else if (sessionId) {
        // 把 grok 会话 id 钉到 dutydeck 的 UUID，resume 才能精确复用。
        // （dutydeck 的会话 id 每次新生成，冲突概率可忽略，不进行额外目录探测。）
        args.push('--session-id', sessionId);
      }
      // 位置参数首轮 prompt：TUI 启动后处理，fresh / resume spawn 都生效。
      if (initialPrompt) {
        args.push(initialPrompt);
      }
      return args;
    },

    // 会话上下文（路由块）由 driver 拼到首轮 prompt 前（契约统一走 prompt 前缀）。
    injectSessionContext(ctx: AdapterSessionContext): string {
      return buildDutydeckRoutingBlock(ctx.locale, ctx.env);
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
