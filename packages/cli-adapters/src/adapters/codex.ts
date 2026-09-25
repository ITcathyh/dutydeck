import type { AdapterSessionContext, CliAdapter, PtyLike } from '../types.js';
import { isDutydeckSessionId, usableResumeId } from '../resume-id.js';
import { pollScreenReady } from './screen-ready-helper.js';
import { buildCwdTrustArgs } from './cwd-trust.js';
import { waitForInputEcho, waitForQuietScreen } from './input-settle.js';

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Codex 活动态 busy 标记：turn 进行中重绘的状态行。 */
const CODEX_ACTIVE_BUSY_PATTERN = /Working[^\r\n]{0,160}esc to interrupt/i;

export function createCodexAdapter(): CliAdapter {
  return {
    id: 'codex',
    capabilities: { resume: true },

    buildArgs({ resume, resumeSessionId, cwd, model, reasoningEffort, permissionMode }: AdapterSessionContext): string[] {
      const usable = usableResumeId(resumeSessionId);
      const isRealResume = Boolean(resume && usable);

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
        // fresh 与真正 resume 都预置 cwd 信任。我们的信任只来自进程级 -c、从不写盘，
        // 因此 resume 一个「首次启动仅靠 -c 预置信任」的会话时，若本次不带 -c，
        // 该目录仍是未受信任状态、照样弹文件夹信任页（真机 codex 0.156.1 已验证）。
        if (cwd) {
          args.push(...buildCwdTrustArgs(cwd));
        }
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
      // 只做精确 id 续接；无 resumeSessionId 时新起会话（不支持通过
      // history.jsonl 模糊反查）。
      // 仅前移 -c 配置覆盖参数到 resume 子命令之前，保证外层/启动器的 -c 生效，
      // 子命令选项保留在 resume 之后。
      if (isRealResume) {
        const rootConfigArgs: string[] = [];
        const subcommandArgs: string[] = [];
        for (let i = 0; i < args.length; i++) {
          const arg = args[i]!;
          if (arg === '-c') {
            rootConfigArgs.push(arg, args[++i]!);
          } else {
            subcommandArgs.push(arg);
          }
        }
        return [...rootConfigArgs, 'resume', ...subcommandArgs, usable!];
      }
      return args;
    },

    async prepareInput(backend: PtyLike, ctx?: AdapterSessionContext): Promise<void> {
      await pollScreenReady(backend, 'Codex', { cwd: ctx?.cwd, permissionMode: ctx?.permissionMode });
    },

    async writeInput(backend: PtyLike, prompt: string): Promise<void> {
      // CLI 还在输出时粘贴会和它的重绘交错：先等屏幕静止，回显稳定后再提交。
      await waitForQuietScreen(backend);
      const typedAt = Date.now();
      // Codex 把字面 \n 当 Enter，必须 bracketed paste 包住多行内容，
      // 否则一条多行消息会被拆成多个 turn。
      if (backend.pasteText) {
        backend.pasteText(prompt);
      } else {
        backend.write('\x1b[200~' + prompt + '\x1b[201~');
      }
      await delay(200);
      await waitForInputEcho(backend, typedAt);
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
