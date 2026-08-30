import type { AdapterSessionContext, CliAdapter, PtyLike } from '../types.js';
import { isDockmuxSessionId, usableResumeId } from '../resume-id.js';

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';
const KIMI_FIRST_WRITE_SETTLE_MS = 250;

const kimiFirstWriteSeen = new WeakSet<PtyLike>();

export function createKimiAdapter(): CliAdapter {
  return {
    id: 'kimi',
    capabilities: { resume: true },

    buildArgs({ resume, resumeSessionId, model }: AdapterSessionContext): string[] {
      const args: string[] = ['--yolo'];
      if (model && model.trim()) {
        args.push('--model', model.trim());
      }
      const usable = usableResumeId(resumeSessionId);
      if (resume && usable) {
        args.push('--resume', usable);
      }
      // 绝不 --continue：它续接全局最近会话，会串到兄弟会话上下文
      // （同一 Kimi config home 被所有会话共享）。
      return args;
    },

    async writeInput(backend: PtyLike, prompt: string): Promise<void> {
      if (!kimiFirstWriteSeen.has(backend)) {
        kimiFirstWriteSeen.add(backend);
        await delay(KIMI_FIRST_WRITE_SETTLE_MS);
      }
      if (backend.pasteText && backend.sendSpecialKeys) {
        backend.pasteText(prompt);
        await delay(200);
        backend.sendSpecialKeys('Enter');
      } else {
        backend.write(BRACKETED_PASTE_START + prompt + BRACKETED_PASTE_END);
        await delay(1000);
        backend.write('\r');
      }
    },

    /** Kimi 自己铸会话 id；dockmux 的 `ses_<uuid>` 不是它的 id → null，
     *  driver 改起新会话。 */
    buildResumeCommand(sessionId: string): string[] | null {
      if (isDockmuxSessionId(sessionId)) return null;
      return ['--resume', sessionId];
    },
  };
}
