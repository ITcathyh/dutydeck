import type { AdapterSessionContext, CliAdapter, PtyLike } from '../types.js';
import { buildDockmuxRoutingBlock } from '../shared-hints.js';

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Claude Code 完成标记：`✳ Worked for 12s` 等耗时行。 */
const COMPLETION_RE = /\u2733\s*(?:Worked|Crunched|Cogitated|Cooked|Churned|Saut[eé]ed|Baked|Brewed) for \d+[smh]/;

const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';

/** 单次 send-keys 的最大 UTF-8 字节数：整行一次发会触发 Claude Code 的
 *  paste-burst 检测，所以每行都按小 chunk 分块键入。 */
export const CLAUDE_INPUT_CHUNK_BYTES = 96;

/** 按 UTF-8 字节预算切分，不切断 Unicode 码位。 */
export function chunkTextByUtf8Bytes(text: string, maxBytes: number = CLAUDE_INPUT_CHUNK_BYTES): string[] {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 4) {
    throw new RangeError('maxBytes must be an integer >= 4');
  }
  const chunks: string[] = [];
  let chunk = '';
  let chunkBytes = 0;
  for (const char of text) {
    const charBytes = Buffer.byteLength(char, 'utf8');
    if (chunk && chunkBytes + charBytes > maxBytes) {
      chunks.push(chunk);
      chunk = '';
      chunkBytes = 0;
    }
    chunk += char;
    chunkBytes += charBytes;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

/** 已接收过首次写入的后端。首次写入落在 Ink 启动渲染期，需要更长的 settle
 *  和节流；按 identity 跟踪，同一后端跨适配器实例共享 warmup 状态。 */
const firstWriteSeen = new WeakSet<PtyLike>();

export function createClaudeCodeAdapter(): CliAdapter {
  return {
    id: 'claude-code',
    capabilities: { resume: true },

    buildArgs({ sessionId, resume, resumeSessionId, model }: AdapterSessionContext): string[] {
      // dockmux sessionId 形如 "ses_<uuid>"，claude --session-id/--resume 只接受裸 UUID。
      const uuid = sessionId.replace(/^ses_/, '');
      const args: string[] = [];
      if (resume) {
        args.push('--resume', resumeSessionId ?? uuid);
      } else {
        args.push('--session-id', uuid);
      }
      if (model && model.trim()) {
        args.push('--model', model.trim());
      }
      // dockmux MVP 是无人值守形态：固定走 botmux 的 bypass 分支
      // （!disableCliBypass），跳过权限确认。
      args.push('--dangerously-skip-permissions');
      args.push(
        '--settings',
        JSON.stringify({
          skipDangerousModePermissionPrompt: true,
          permissions: { defaultMode: 'bypassPermissions' },
        }),
      );
      // PlanMode 的审批 TUI 在 IM 场景无法驱动，直接禁掉。
      args.push('--disallowed-tools', 'EnterPlanMode,ExitPlanMode');
      return args;
    },

    // 会话上下文（路由块）由 driver 拼到首轮 prompt 前（契约统一走 prompt
    // 前缀，不再走 botmux 的 --append-system-prompt）。
    injectSessionContext(ctx: AdapterSessionContext): string {
      return buildDockmuxRoutingBlock(ctx.locale);
    },

    async writeInput(backend: PtyLike, prompt: string): Promise<void> {
      const isFirstWrite = !firstWriteSeen.has(backend);
      if (isFirstWrite) {
        firstWriteSeen.add(backend);
        // 首次写入落在 Ink 启动渲染期，先等队列稳定。
        await delay(200);
      }
      const throttleMs = isFirstWrite ? 80 : 30;
      const tick = () => delay(throttleMs);

      if (backend.sendText && backend.sendSpecialKeys) {
        // tmux：逐行、按字节分块键入；换行用 '\' + Enter（Claude Code 的
        // soft-newline，内容留在输入框不提交），最后一个 Enter 才是提交。
        const lines = prompt.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (line && line.length > 0) {
            for (const chunk of chunkTextByUtf8Bytes(line)) {
              backend.sendText(chunk);
              await tick();
            }
          }
          if (i < lines.length - 1) {
            backend.sendText('\\');
            await tick();
            backend.sendSpecialKeys('Enter');
            await tick();
          }
        }
      } else {
        // 裸 PTY：bracketed paste 标记自己包，多行内容不会被拆成多次提交。
        backend.write(BRACKETED_PASTE_START + prompt + BRACKETED_PASTE_END);
      }
      await delay(500);
      if (backend.sendSpecialKeys) backend.sendSpecialKeys('Enter');
      else backend.write('\r');
    },

    buildResumeCommand(sessionId: string): string[] {
      return ['--resume', sessionId.replace(/^ses_/, '')];
    },

    completionPattern: COMPLETION_RE,
    readyPattern: /❯/,
  };
}
