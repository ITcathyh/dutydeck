import { spawnSync } from 'node:child_process';
import type { AdapterSessionContext, CliAdapter, PtyLike } from '../types.js';
import { isDutydeckSessionId, usableResumeId } from '../resume-id.js';
import { delay, submitPrompt } from './input-settle.js';

const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';
const KIMI_FIRST_WRITE_SETTLE_MS = 250;

const KIMI_HELP_TIMEOUT_MS = 3000;

const kimiFirstWriteSeen = new WeakSet<PtyLike>();
const kimiAutoSupport = new Map<string, boolean>();

/** 读一次 `<command> --help` 并按命令缓存：帮助里列出 `--auto` 才算支持。
 *  同样叫 `kimi` 的 Python 版 kimi-cli 没有 `--auto`，传了会因未知选项退出；探测失败也按不支持处理。 */
function kimiSupportsAuto(command: string): boolean {
  const cached = kimiAutoSupport.get(command);
  if (cached !== undefined) return cached;
  const result = spawnSync(command, ['--help'], { encoding: 'utf8', timeout: KIMI_HELP_TIMEOUT_MS, env: { ...process.env, NO_COLOR: '1' } });
  const supported = result.status === 0 && /(^|[\s,])--auto(?![\w-])/m.test(`${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  kimiAutoSupport.set(command, supported);
  return supported;
}

export function createKimiAdapter(): CliAdapter {
  return {
    id: 'kimi',
    capabilities: { resume: true },

    buildArgs({ command, resume, resumeSessionId, model, permissionMode }: AdapterSessionContext): string[] {
      // Kimi Code 的 `--yolo` 只放行普通工具调用，高危操作仍会停下等人；`--auto`（Never Ask）才是免审批。
      // Python 版 kimi-cli 只有 `--yolo`（它在那里就是全部放行），所以只在帮助里确认有 `--auto` 时才用它。
      const args: string[] = permissionMode === 'full-trust' ? [kimiSupportsAuto(command || 'kimi') ? '--auto' : '--yolo'] : [];
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
      await submitPrompt(backend, prompt, { paste: true, fallbackText: BRACKETED_PASTE_START + prompt + BRACKETED_PASTE_END });
    },

    /** Kimi 自己铸会话 id；dutydeck 的 `ses_<uuid>` 不是它的 id → null，
     *  driver 改起新会话。 */
    buildResumeCommand(sessionId: string): string[] | null {
      if (isDutydeckSessionId(sessionId)) return null;
      return ['--resume', sessionId];
    },
  };
}
