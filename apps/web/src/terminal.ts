// PTY 终端 WebSocket 协议的纯函数层：URL 推导、帧解析、重连退避。
// 帧格式见 apps/web/TERMINAL_API.md。
import { instanceApiUrl } from './instance';

export type TerminalServerFrame =
  | { type: 'snapshot'; data: string; cols: number; rows: number }
  | { type: 'data'; data: string }
  | { type: 'exit'; code: number | null }
  | { type: 'error'; message: string };

export type TerminalClientFrame =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number };

// 由页面 location 推导终端 WS 地址：http→ws、https→wss，sessionId 需编码
export function terminalWsUrl(sessionId: string, locationLike?: { protocol: string; host: string }): string {
  const location = locationLike ?? window.location;
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${location.host}${instanceApiUrl(`/api/terminal/${encodeURIComponent(sessionId)}`)}`;
}

// 解析服务端→客户端 JSON 帧；非法 JSON / 未知 type / 缺字段时返回 undefined（不抛异常）
export function parseTerminalFrame(raw: string): TerminalServerFrame | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  switch (record.type) {
    case 'snapshot':
      return typeof record.data === 'string'
        && typeof record.cols === 'number' && Number.isInteger(record.cols) && record.cols > 0
        && typeof record.rows === 'number' && Number.isInteger(record.rows) && record.rows > 0
        ? { type: 'snapshot', data: record.data, cols: record.cols, rows: record.rows } : undefined;
    case 'data':
      return typeof record.data === 'string' ? { type: 'data', data: record.data } : undefined;
    case 'exit':
      return typeof record.code === 'number' || record.code === null ? { type: 'exit', code: record.code } : undefined;
    case 'error':
      return typeof record.message === 'string' ? { type: 'error', message: record.message } : undefined;
    default:
      return undefined;
  }
}

// 断线重连的指数退避：1000 * 2^attempt，上限 30000ms
export function nextTerminalBackoffMs(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 30000);
}

// ── 终端字号按容器宽度自适应 ──────────────────────────────────────────────────
// xterm 的 fontSize 是终端唯一的几何输入：字号写死，列数就只能被容器宽度被动决定。
// 12px 是照桌面宽度调的，手机 390px 宽的面板一行只剩约 48 列，多数 CLI 的 TUI 会被迫
// 在 48 列上硬折行。这里把因果反过来：先定一个可读的目标列数，再由容器宽度反推字号。
//
// FONT_ADVANCE 是等宽字体标称的「字宽 / 字号」比（Menlo、Consolas、DejaVu Sans Mono
// 都是 0.6），只用于估算；真实列数仍由 xterm 量完字体后自己 fit() 出来，估算偏一点最多
// 让列数在目标附近浮动，不会错位。
// 只缩不放：算出来比 FONT_BASE 大一律按 base 走，所以宽度够（约 446px 以上）的桌面一律
// 还是 12px，存量渲染零变化；窄容器才往下缩，最低到 FONT_MIN（再小就读不清了）。
const FONT_MIN = 9, FONT_BASE = 12, FONT_ADVANCE = 0.6, TARGET_COLS = 62;

export function terminalFontSize(containerWidthPx: number): number {
  // 宽度还没布局出来（隐藏的 tab、刚插进 DOM）或拿到 NaN 时保持基准字号，等尺寸事件再纠正
  if (!(containerWidthPx > 0)) return FONT_BASE;
  const ideal = containerWidthPx / (TARGET_COLS * FONT_ADVANCE);
  // 半档取整：比整数细一档，又不会停在容易糊掉的亚像素字号上
  const stepped = Math.round(Math.min(ideal, FONT_BASE) * 2) / 2;
  // 硬边界：字号是唯一的几何输入，任何异常宽度都不许把它推到读不了的档位
  return Math.max(FONT_MIN, Math.min(stepped, FONT_BASE));
}
