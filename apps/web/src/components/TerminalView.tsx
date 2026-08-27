import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { nextTerminalBackoffMs, parseTerminalFrame, terminalWsUrl } from '../terminal';

// PTY 实时终端视图：xterm.js 直连 WebSocket，协议见 apps/web/TERMINAL_API.md
export function TerminalView({ sessionId, className }: { sessionId: string; className?: string }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // 创建终端实例：浅色主题与页面 zinc 色系协调
    const term = new Terminal({
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      fontSize: 12,
      cursorBlink: true,
      scrollback: 5000,
      theme: { background: '#fafafa', foreground: '#3f3f46' }
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    // 容器尺寸为 0（如隐藏的 tab）时 fit 会抛错，忽略即可
    const tryFit = () => { try { fit.fit(); } catch { /* 容器尚未可见，等下次 ResizeObserver 回调 */ } };
    tryFit();

    let ws: WebSocket | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let connectedOnce = false;
    let disposed = false;

    const sendResize = () => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    };

    function connect() {
      if (disposed) return;
      ws = new WebSocket(terminalWsUrl(sessionId));
      ws.onopen = () => {
        attempt = 0;
        // 服务端不保证缓存历史，重连后保留当前屏幕内容，仅提示一行
        if (connectedOnce) term.write('\r\n\x1b[90m[已重新连接]\x1b[0m\r\n');
        connectedOnce = true;
        sendResize();
      };
      ws.onmessage = event => {
        const frame = parseTerminalFrame(String(event.data));
        if (!frame) return;
        if (frame.type === 'data') term.write(frame.data);
        else if (frame.type === 'exit') term.write(`\r\n\x1b[90m[进程已退出，code=${frame.code}]\x1b[0m\r\n`);
        else term.write(`\r\n\x1b[90m[终端错误] ${frame.message}\x1b[0m\r\n`);
      };
      ws.onclose = () => {
        if (disposed) return;
        // 断线后指数退避重连，上限 30s
        reconnectTimer = setTimeout(connect, nextTerminalBackoffMs(attempt));
        attempt += 1;
      };
    }

    // 键盘输入转发给 PTY
    const inputDisposable = term.onData(data => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data }));
    });

    // 容器尺寸变化时重新适配尺寸，并把新的行列数通知服务端
    const observer = new ResizeObserver(() => { tryFit(); sendResize(); });
    observer.observe(container);

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      observer.disconnect();
      inputDisposable.dispose();
      ws?.close();
      term.dispose();
    };
  }, [sessionId]);

  return <div ref={containerRef} className={className}/>;
}
