import type { AdapterSessionContext, CliAdapter, PtyLike } from '../types.js';
import { isDutydeckSessionId, usableResumeId } from '../resume-id.js';
import { delay } from './input-settle.js';

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
      if (backend.pasteText) await backend.pasteText(prompt);
      else await backend.write(`\x1b[200~${prompt}\x1b[201~`);
      await delay(200);
      if (backend.sendSpecialKeys) await backend.sendSpecialKeys('Enter');
      else await backend.write('\r');
    },

    buildResumeCommand(sessionId: string): string[] | null {
      if (isDutydeckSessionId(sessionId)) return null;
      return ['--resume', sessionId];
    },

    readyPattern: /Type a task|use \/ @ ! for commands/i,
  };
}
