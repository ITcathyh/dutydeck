import type { AdapterSessionContext, CliAdapter, PtyLike } from '../types.js';
import { buildDutydeckRoutingBlock } from '../shared-hints.js';

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export function createGeniusAdapter(): CliAdapter {
  return {
    id: 'genius',
    capabilities: { resume: true },

    buildArgs({ sessionId, cwd, resume, resumeSessionId, model, permissionMode }: AdapterSessionContext): string[] {
      // Genius 是 Claude 家族（同样的 --session-id/--resume/--settings 形态），
      // 会话 id 按裸 UUID 传；dutydeck sessionId 形如 "ses_<uuid>"。
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

    // 统一由 driver 把返回块拼到首轮 prompt 前作为会话上下文。
    injectSessionContext(ctx: AdapterSessionContext): string {
      return buildDutydeckRoutingBlock(ctx.locale, ctx.env);
    },

    async writeInput(backend: PtyLike, prompt: string): Promise<void> {
      // 整段发送 + 单个 Enter 提交（不走 bracketed paste）。
      // 精简契约的 writeInput 无返回通道，不进行额外的提交落地重试校验。
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
