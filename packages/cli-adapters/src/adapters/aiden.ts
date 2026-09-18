import type { AdapterSessionContext, CliAdapter, PtyLike } from '../types.js';
import { buildDutydeckRoutingBlock } from '../shared-hints.js';

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export function createAidenAdapter(): CliAdapter {
  return {
    id: 'aiden',
    capabilities: { resume: true },

    buildArgs({ sessionId, resume, resumeSessionId, permissionMode }: AdapterSessionContext): string[] {
      const args: string[] = [];
      if (resume) {
        // Aiden 直接吃外部会话 id（无 id 轮换、无 CLI 自有 id），
        // 新建会话时它自己生成 id，所以只有 resume 分支需要传。
        args.push('--resume', resumeSessionId ?? sessionId);
      }
      if (permissionMode === 'full-trust') args.push('--permission-mode', 'agentFull');
      return args;
    },

    // 由 driver 把返回块拼到首轮 prompt 前作为会话上下文。
    injectSessionContext(ctx: AdapterSessionContext): string {
      return buildDutydeckRoutingBlock(ctx.locale, ctx.env);
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

    buildResumeCommand(sessionId: string): string[] {
      return ['--resume', sessionId];
    },

    // 无完成标记可依赖，idle 判定只靠静默（quiescence only）。
  };
}
