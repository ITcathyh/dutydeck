import type { CliProfile } from '../profile.js';
import type { AdapterSessionContext, CliAdapter, PtyLike } from '../types.js';
import { submitPrompt } from './input-settle.js';

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

    async writeInput(backend: PtyLike, prompt: string): Promise<void> {
      await submitPrompt(backend, prompt);
    },

    buildResumeCommand(sessionId: string): string[] {
      return ['--resume', sessionId];
    },

    // 无完成标记可依赖，idle 判定只靠静默（quiescence only）。
  };
}

export const aidenProfile = {
  createAdapter: createAidenAdapter,
  discoveryOrder: 21,
  contributions: [
    { id: 'aiden', name: 'Aiden', command: 'aiden', adapterId: 'aiden', capabilities: { pause: false, resume: true } },
  ],
} satisfies CliProfile;
