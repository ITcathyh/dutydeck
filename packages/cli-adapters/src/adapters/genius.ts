import type { AdapterSessionContext, CliAdapter, PtyLike } from '../types.js';
import { buildDockmuxRoutingBlock } from '../shared-hints.js';

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export function createGeniusAdapter(): CliAdapter {
  return {
    id: 'genius',
    capabilities: { resume: true },

    buildArgs({ sessionId, cwd, resume, resumeSessionId, model, permissionMode }: AdapterSessionContext): string[] {
      // Genius 是 Claude 家族（同样的 --session-id/--resume/--settings 形态），
      // 会话 id 按裸 UUID 传；dockmux sessionId 形如 "ses_<uuid>"。
      const uuid = sessionId.replace(/^ses_/, '');
      const args: string[] = [];
      if (cwd) args.push('--add-dir', cwd);
      if (resume) {
        args.push('--resume', (resumeSessionId ?? uuid).replace(/^ses_/, ''));
      } else {
        args.push('--session-id', uuid);
      }
      if (model && model.trim()) args.push('--model', model.trim());
      if (permissionMode === 'full-trust') {
        args.push('--dangerously-skip-permissions');
        args.push(
          '--settings',
          JSON.stringify({
            skipDangerousModePermissionPrompt: true,
            permissions: { defaultMode: 'bypassPermissions' },
          }),
        );
      }
      return args;
    },

    // botmux 走 --append-system-prompt 注入共用提示（所以它把 systemHints 置空、
    // 标记自注入）；精简契约统一改为 driver 把返回块拼到首轮 prompt 前。
    injectSessionContext(ctx: AdapterSessionContext): string {
      return buildDockmuxRoutingBlock(ctx.locale, ctx.env);
    },

    async writeInput(backend: PtyLike, prompt: string): Promise<void> {
      // 整段发送 + 单个 Enter 提交（不走 bracketed paste）。
      // botmux 在这之后还会读 transcript JSONL 确认提交是否落地、必要时补发
      // 至多 3 次 Enter；精简契约的 writeInput 无返回通道，这层校验略去。
      if (backend.sendText) backend.sendText(prompt);
      else backend.write(prompt);
      await delay(200);
      if (backend.sendSpecialKeys) backend.sendSpecialKeys('Enter');
      else backend.write('\r');
    },

    buildResumeCommand(sessionId: string): string[] {
      return ['--resume', sessionId.replace(/^ses_/, '')];
    },

    busyPattern: /Working…|esc to interrupt/i,
    readyPattern: /⏵⏵\s+accept edits on|(?:^|[\n\r])[❯›]\s*/,
  };
}
