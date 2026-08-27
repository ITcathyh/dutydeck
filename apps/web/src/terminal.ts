// PTY 终端 WebSocket 协议的纯函数层：URL 推导、帧解析、重连退避。
// 帧格式见 apps/web/TERMINAL_API.md。

export type TerminalServerFrame =
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
  return `${scheme}://${location.host}/api/terminal/${encodeURIComponent(sessionId)}`;
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
