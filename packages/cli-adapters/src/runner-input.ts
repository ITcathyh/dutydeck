import type { PtyLike } from './types.js';

/**
 * runner 类适配器的 stdin 分块注入 + 控制行协议（移植自 botmux
 * `runner-input.ts`，去掉 turnId / trustedCaller 关联）。
 *
 * runner 不驱动 TUI：它逐字节读 stdin，只在看到行尾换行时入队一条消息。
 * 每条消息是一行控制行：
 *
 *     ::dockmux-<id>:<base64(JSON)>\n
 *
 * 整行一次性写入会撑爆 pane pty 的 ~4KB 输入缓冲，所以按小 chunk 分块、
 * chunk 之间留节流；chunk 之间绝不插换行——runner 自己累积半行，只在最终
 * Enter 时入队。控制行是纯 ASCII（marker + base64），按 code unit 切就是
 * 干净的字节切分。
 *
 * 仅 runner 类兼容适配器使用；当前可发现的本机 Agent 不依赖该协议。
 */

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** 单次写入的最大字节数，远低于 ~4KB N_TTY 输入缓冲。 */
export const RUNNER_INPUT_CHUNK_BYTES = 1024;

/** chunk 间节流，给 runner 排空 pane pty 的时间。 */
export const RUNNER_INPUT_THROTTLE_MS = 20;

/** 把消息内容编码成控制行的 base64 payload。 */
export function encodeRunnerInput(content: string): string {
  return Buffer.from(JSON.stringify({ type: 'message', content }), 'utf8').toString('base64');
}

/** 把 ASCII 字符串切成 <=maxBytes 的片段（调用方只传 marker + base64）。 */
export function chunkAscii(line: string, maxBytes: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < line.length; i += maxBytes) {
    chunks.push(line.slice(i, i + maxBytes));
  }
  return chunks;
}

/**
 * 向 runner 后端写一条控制行（分块 + 节流）。
 *
 * 缓冲卫生约定（runner 只在换行时清空 stdin 缓冲，半行残留会拼到下一条消息前
 * 腐蚀两条消息）：
 *  - 写前先发一个 Enter，终结上一次失败写入可能留下的半行；
 *  - 某个 chunk 无法确认时，补发一个 Enter 尽量冲掉半行；
 *  - 提交 Enter 带重试，避免完整行停在缓冲里未入队。
 */
export async function writeRunnerInput(
  backend: PtyLike,
  markerPrefix: string,
  content: string,
): Promise<{ submitted: boolean }> {
  const line = `${markerPrefix}${encodeRunnerInput(content)}`;

  // 裸 PTY 回退：单次写入即可，没有 send-keys 超时问题。
  if (!backend.sendText || !backend.sendSpecialKeys) {
    try {
      if (backend.write(line + '\r') === false) return { submitted: false };
    } catch {
      return { submitted: false };
    }
    return { submitted: true };
  }

  const sendText = backend.sendText.bind(backend);
  const sendEnterWithRetry = (attempts = 3): boolean => {
    for (let i = 0; i < attempts; i++) {
      if (backend.sendSpecialKeys!('Enter') !== false) return true;
    }
    return false;
  };

  // 预冲 Enter 必须先落地：缓冲里若有旧半行，直接写新行会把两者拼成一条
  // runner 丢弃的坏行，而提交 Enter 仍报成功（静默丢消息）。
  try {
    if (!sendEnterWithRetry()) return { submitted: false };
  } catch {
    return { submitted: false };
  }

  const chunks = chunkAscii(line, RUNNER_INPUT_CHUNK_BYTES);
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    let chunkWritten: void | boolean;
    try {
      chunkWritten = sendText(chunk);
    } catch {
      return { submitted: false };
    }
    if (chunkWritten === false) {
      // 已写入的 chunk 是没有换行的半行，补发 Enter 冲掉它。
      try { sendEnterWithRetry(); } catch { /* 尽力而为 */ }
      return { submitted: false };
    }
    if (i < chunks.length - 1) await delay(RUNNER_INPUT_THROTTLE_MS);
  }

  // 提交 Enter（带重试：单次未确认可能让完整行停在缓冲里）。
  try {
    if (!sendEnterWithRetry()) return { submitted: false };
  } catch {
    return { submitted: false };
  }
  return { submitted: true };
}
