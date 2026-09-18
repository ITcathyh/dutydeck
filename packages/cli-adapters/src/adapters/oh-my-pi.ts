import type { AdapterSessionContext, CliAdapter, PtyLike } from '../types.js';
import { isDutydeckSessionId, usableResumeId } from '../resume-id.js';

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';

/** 保持每次 paste 低于 OMP 的 `[Paste #N]` 折叠阈值（>1000 字符 或 >10 行）。 */
const OMP_INPUT_CHUNK_CHARS = 512;
const OMP_INPUT_CHUNK_NEWLINES = 9;
const OMP_INPUT_THROTTLE_MS = 20;

/** OMP 把 500ms 内的第二个 Ctrl+C 当退出，清理输入框必须避开这个窗口。 */
const OMP_CANCEL_COOLDOWN_MS = 550;

/** 对齐 OMP 自己的 paste 语义，再把内容放到按键路径上。 */
function normalizeOmpInput(text: string): string {
  return text
    // 整体剥掉 ANSI/VT 序列：只删 ESC 会在粘贴的终端日志里留下 `[31m` 这类可见残尾。
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[ -/]*[@-~]/g, '')
    .replace(/\r\n?/g, '\n')
    .normalize('NFC')
    .replace(/\t/g, '   ')
    // 这些字节作为字面终端输入会被当成按键（Backspace / DEL / Escape 等）。
    // 换行保留，靠 paste 模式投递。
    .replace(/[\x00-\x09\x0B-\x1F\x7F-\x9F]/g, '');
}

function chunkOmpInput(text: string): string[] {
  const chunks: string[] = [];
  let current = '';
  let newlines = 0;
  for (const ch of text) {
    if (
      current &&
      (current.length + ch.length > OMP_INPUT_CHUNK_CHARS ||
        (ch === '\n' && newlines >= OMP_INPUT_CHUNK_NEWLINES))
    ) {
      chunks.push(current);
      current = '';
      newlines = 0;
    }
    current += ch;
    if (ch === '\n') newlines++;
  }
  if (current) chunks.push(current);
  return chunks;
}

function sendLiteral(backend: PtyLike, text: string): boolean {
  try {
    if (backend.sendText) return backend.sendText(text) !== false;
    backend.write(text);
    return true;
  } catch {
    return false;
  }
}

function submitEnter(backend: PtyLike, attempts = 3): boolean {
  for (let i = 0; i < attempts; i++) {
    try {
      if (backend.sendSpecialKeys) {
        if (backend.sendSpecialKeys('Enter') !== false) return true;
      } else {
        backend.write('\r');
        return true;
      }
    } catch {
      // 重试
    }
  }
  return false;
}

/**
 * oh-my-pi 原生 TUI（`omp`）适配器。
 *
 * 当前不支持的能力：暂不支持为每个会话分配独立的 `--session-dir`（OMP 没有
 * `--session-id`，目录隔离是唯一手段）。精简契约里适配器不能碰文件系统 / homedir，所以
 * `--session-dir` 无法构造——多会话共享 OMP 默认目录，resume 只能靠
 * driver 交回精确的 transcript 路径。
 */
export function createOhMyPiAdapter(): CliAdapter {
  // 上一次 best-effort 清理本身也可能被丢弃；输入框内容未知时绝不追加新消息。
  let composerDirty = false;
  let lastClearAttemptAt = 0;

  const clearComposer = async (backend: PtyLike): Promise<boolean> => {
    const waitMs = OMP_CANCEL_COOLDOWN_MS - (Date.now() - lastClearAttemptAt);
    if (waitMs > 0) await delay(waitMs);
    lastClearAttemptAt = Date.now();
    try {
      if (backend.sendSpecialKeys) return backend.sendSpecialKeys('C-c') !== false;
      backend.write('\x03');
      return true;
    } catch {
      return false;
    }
  };

  return {
    id: 'oh-my-pi',
    capabilities: { resume: true },

    // 绝不把 prompt 当位置参数传：OMP 只会把它塞进 TUI 输入框、不自动提交。
    // prompt 一律走 writeInput，由 dutydeck 掌握最终的提交键。
    buildArgs({ resume, resumeSessionId, model, cwd, permissionMode }: AdapterSessionContext): string[] {
      const args = ['--no-title'];
      // OMP 的 `--resume` 吃的是 transcript 文件路径，不是会话 id
      // （不进行扫描 session 目录最新 .jsonl 的文件系统探测）。
      const usable = usableResumeId(resumeSessionId);
      if (resume && usable) args.push('--resume', usable);
      if (permissionMode === 'full-trust') args.push('--approval-mode', 'yolo');
      if (model && model.trim()) args.push('--model', model.trim());
      if (cwd) args.push('--cwd', cwd);
      return args;
    },

    async writeInput(backend: PtyLike, prompt: string): Promise<void> {
      const normalized = normalizeOmpInput(prompt);
      // 清理控制字符后为空：不发空消息。
      if (!normalized) return;

      if (composerDirty) {
        // 清不干净就放弃本次写入，避免把新消息拼到未知残留后面。
        if (!(await clearComposer(backend))) return;
        composerDirty = false;
      }

      // OMP 会把单次大 bracketed paste 折叠成 `[Paste #N]` 占位符，紧随其后的
      // 程序化 Enter 还可能被忽略。既保留 paste 语义（tab/换行/控制字节按文本
      // 处理，不当按键），又在最终真 Enter 之前切到两个阈值以下。
      for (const chunk of chunkOmpInput(normalized)) {
        // 自己发 paste 标记而不依赖后端的 pasteText：tmux/zellij 实现的是
        // bracketed paste，别的后端只做字面写入。统一线格式让各后端等价。
        if (!sendLiteral(backend, `${BRACKETED_PASTE_START}${chunk}${BRACKETED_PASTE_END}`)) {
          composerDirty = !(await clearComposer(backend));
          return;
        }
        await delay(OMP_INPUT_THROTTLE_MS);
      }

      if (!submitEnter(backend)) {
        composerDirty = !(await clearComposer(backend));
        return;
      }
      composerDirty = false;
    },

    buildResumeCommand(sessionId: string): string[] | null {
      // OMP 的 `--resume` 吃的是 transcript **文件路径**，不是会话 id。
      // dutydeck 的 `ses_<uuid>` 显然不是路径 → null，driver 改起新会话。
      if (isDutydeckSessionId(sessionId)) return null;
      return ['--resume', sessionId];
    },

    busyPattern: /Working(?:\.\.\.|…)/,
  };
}
