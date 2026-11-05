import { execFile } from 'node:child_process';
import type { AdapterSessionContext, CliAdapter, PtyLike } from '../types.js';
import { isDutydeckSessionId, usableResumeId } from '../resume-id.js';
import { delay, submitPrompt } from './input-settle.js';

const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';
const KIMI_FIRST_WRITE_SETTLE_MS = 250;

const KIMI_HELP_TIMEOUT_MS = 3000;

const kimiFirstWriteSeen = new WeakSet<PtyLike>();
/** 按命令缓存的 `--auto` 探测；存 Promise，并发启动同一命令只读一次帮助。 */
const kimiAutoProbes = new Map<string, Promise<boolean>>();
const kimiAutoSupport = new Map<string, boolean>();

/** 异步读一次 `<command> --help`：帮助里列出 `--auto` 才算支持。
 *  同样叫 `kimi` 的 Python 版 kimi-cli 没有 `--auto`，传了会因未知选项退出；探测失败也按不支持处理。
 *  env 用 driver 给的 spawn 环境（已经过 child-environment 清洗），与真正启动 CLI 时一致。 */
function probeKimiAuto(command: string, env: Record<string, string>): Promise<boolean> {
  let probe = kimiAutoProbes.get(command);
  if (!probe) {
    probe = new Promise<boolean>(resolve => {
      execFile(command, ['--help'], { encoding: 'utf8', timeout: KIMI_HELP_TIMEOUT_MS, env: { ...env, NO_COLOR: '1' } }, (error, stdout, stderr) => {
        resolve(!error && /(^|[\s,])--auto(?![\w-])/m.test(`${stdout ?? ''}\n${stderr ?? ''}`));
      });
    }).then(supported => { kimiAutoSupport.set(command, supported); return supported; });
    kimiAutoProbes.set(command, probe);
  }
  return probe;
}

export function createKimiAdapter(): CliAdapter {
  return {
    id: 'kimi',
    capabilities: { resume: true },

    async prepareLaunch({ command, permissionMode }: AdapterSessionContext, env: Record<string, string>): Promise<void> {
      if (permissionMode === 'full-trust') await probeKimiAuto(command || 'kimi', env);
    },

    buildArgs({ command, resume, resumeSessionId, model, permissionMode }: AdapterSessionContext): string[] {
      // Kimi Code 的 `--yolo` 只放行普通工具调用，高危操作仍会停下等人；`--auto`（Never Ask）才是免审批。
      // Python 版 kimi-cli 只有 `--yolo`（它在那里就是全部放行），所以只在 prepareLaunch 确认帮助里有 `--auto` 时才用它；
      // 没探测过（调用方没先 prepareLaunch）也按不支持处理。
      const args: string[] = permissionMode === 'full-trust' ? [kimiAutoSupport.get(command || 'kimi') ? '--auto' : '--yolo'] : [];
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
