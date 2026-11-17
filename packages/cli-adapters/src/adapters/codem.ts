import type { AdapterSessionContext, CliAdapter, PtyLike } from '../types.js';
import { isDutydeckSessionId, nativeResumeCommand, usableResumeId } from '../resume-id.js';
import { pasteAndSubmit } from './input-settle.js';

/** CodeM's interactive terminal surface. It owns history by an explicit
 * session id; never use a global "latest" resume shortcut. */
export function createCodemAdapter(): CliAdapter {
  return {
    id: 'codem',
    capabilities: { resume: true },

    buildArgs({ sessionId, resume, resumeSessionId, model, permissionMode }: AdapterSessionContext): string[] {
      const args: string[] = [];
      if (permissionMode === 'full-trust') args.push('--yolo');
      if (model?.trim()) args.push('--model', model.trim());
      const native = usableResumeId(resumeSessionId);
      if (resume && native && !isDutydeckSessionId(native)) args.push('--resume', native);
      else args.push('--session', sessionId);
      return args;
    },

    async writeInput(backend: PtyLike, prompt: string): Promise<void> {
      await pasteAndSubmit(backend, prompt);
    },

    buildResumeCommand: nativeResumeCommand,

    readyPattern: /Type a task|use \/ @ ! for commands/i,
  };
}
