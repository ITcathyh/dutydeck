import type { AdapterSessionContext, CliAdapter, PtyLike } from '../types.js';
import { isDutydeckSessionId, usableResumeId } from '../resume-id.js';

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const STARTUP_POLL_MS = 100;
const STARTUP_TIMEOUT_MS = 30_000;

const CODEX_STARTUP_PENDING_PATTERN = /│[ \t]+(?:model|directory):[ \t]+loading\b/;
const CODEX_STARTUP_READY_PATTERN = /│[ \t]+model:[ \t]+(?!loading\b)[^│\s][^│\r\n]*│[ \t\r\n]*│[ \t]+directory:[ \t]+(?!loading\b)[^│\s][^│\r\n]*│/;
const CODEX_COMPOSER_PATTERN = /›(?!\s*\d+\.)/;

/** Codex 活动态 busy 标记：turn 进行中重绘的状态行。 */
const CODEX_ACTIVE_BUSY_PATTERN = /Working[^\r\n]{0,160}esc to interrupt/i;

export function createCodexAdapter(): CliAdapter {
  return {
    id: 'codex',
    capabilities: { resume: true },

    buildArgs({ resume, resumeSessionId, cwd, model, reasoningEffort, permissionMode }: AdapterSessionContext): string[] {
      const args: string[] = [
        '--no-alt-screen',
        // 启动更新选择器会吞掉首条消息，进程级关掉（不动用户全局 config）。
        '-c',
        'check_for_update_on_startup=false',
        // 隐藏低额度模型提示；仅作用于本进程，不修改用户全局 config。
        '-c',
        'notice.hide_rate_limit_model_nudge=true',
      ];
      if (permissionMode === 'full-trust') {
        args.unshift('--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-hook-trust');
      }
      if (model && model.trim()) {
        args.push('--model', model.trim());
      }
      if (reasoningEffort) {
        args.push('-c', `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`);
      }
      if (cwd) {
        args.push('-C', cwd);
      }
      // 只做精确 id 续接；无 resumeSessionId 时新起会话（botmux 的
      // history.jsonl 反查已随 transcript 机制一起丢弃）。
      const usable = usableResumeId(resumeSessionId);
      if (resume && usable) {
        return ['resume', ...args, usable];
      }
      return args;
    },

    async prepareInput(backend: PtyLike): Promise<void> {
      if (!backend.readScreen) {
        throw new Error('Codex startup readiness requires a terminal screen reader');
      }

      const startedAt = Date.now();
      while (Date.now() - startedAt < STARTUP_TIMEOUT_MS) {
        const screen = backend.readScreen();
        const pending = CODEX_STARTUP_PENDING_PATTERN.test(screen);
        if (CODEX_STARTUP_READY_PATTERN.test(screen)) return;
        // Older/non-standard banners may omit the model and directory cells.
        // A composer is usable unless the same screen explicitly says startup
        // is still loading.
        if (!pending && CODEX_COMPOSER_PATTERN.test(screen)) return;
        await delay(STARTUP_POLL_MS);
      }
      throw new Error('Codex 启动尚未就绪，请打开终端检查启动状态后再发送任务。');
    },

    async writeInput(backend: PtyLike, prompt: string): Promise<void> {
      // Codex 把字面 \n 当 Enter，必须 bracketed paste 包住多行内容，
      // 否则一条多行消息会被拆成多个 turn。
      if (backend.pasteText) {
        backend.pasteText(prompt);
      } else {
        backend.write('\x1b[200~' + prompt + '\x1b[201~');
      }
      await delay(200);
      if (backend.sendSpecialKeys) backend.sendSpecialKeys('Enter');
      else backend.write('\r');
    },

    /**
     * Codex 自己铸 rollout id（也是 UUID 形态），dutydeck 钉不了。
     *
     * 收到 dutydeck 自己的 `ses_<uuid>` = 反查（session-id/codex.ts 扫
     * history.jsonl）没找到锚点，这个 id codex 从没见过：`codex resume <未知id>`
     * 起不来。返回 null 让 driver 改起新会话——丢上下文是降级，起不来是故障。
     *
     * 注意这里只挡 `ses_` 前缀那一种形态：codex 原生 id 本身就是裸 UUID，
     * 把裸 UUID 一并当成「dutydeck 的」会误杀所有正常 resume（见 resume-id.ts）。
     */
    buildResumeCommand(sessionId: string): string[] | null {
      if (isDutydeckSessionId(sessionId)) return null;
      return ['resume', sessionId];
    },

    busyPattern: CODEX_ACTIVE_BUSY_PATTERN,
    idleToBusyPattern: CODEX_ACTIVE_BUSY_PATTERN,
    // 更新选择器也渲染 `› 1. Update now`，裸 › 会把菜单当成 composer，
    // 所以排除带序号的菜单行。
    readyPattern: /›(?!\s*\d+\.)|\d+% left/,
  };
}
