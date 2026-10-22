import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { nextTerminalBackoffMs, parseTerminalFrame, terminalFontSize, terminalWsUrl } from '../terminal';
import { bindTerminalTouchScroll } from '../terminal-touch';
import { readThemeColor } from '../theme';
import { useMediaQuery } from '../useMediaQuery';
import { TerminalKeyBar } from './TerminalKeyBar';

// 主题色只能给 xterm 真实色值，CSS 变量它读不懂，所以运行时从 :root 上取计算值。
// readThemeColor 在 jsdom（返回空串）与取值失败时回落到原来写死的浅色配色。
function readTerminalTheme(): { background: string; foreground: string; cursor: string; selectionBackground: string } {
  return {
    background: readThemeColor('--terminal-bg', '#fafafa'),
    foreground: readThemeColor('--terminal-fg', '#3f3f46'),
    cursor: readThemeColor('--terminal-cursor', '#3f3f46'),
    selectionBackground: readThemeColor('--terminal-selection', '#d4d4d8')
  };
}

// 屏幕快捷键条只在真正需要它的地方出现：粗指针（触屏）或窄视口。桌面鼠标 + 物理键盘上它只挡内容。
const KEY_BAR_MEDIA = '(pointer: coarse), (max-width: 767px)';
// 触屏拖选的抑制规则单独用「只有粗指针」判定：窄窗口的桌面浏览器仍是鼠标，不该被剥掉拖选复制。
const COARSE_MEDIA = '(pointer: coarse)';
const HANDSHAKE_TIMEOUT_MS = 10_000;

// PTY 实时终端视图：xterm.js 直连 WebSocket，协议见 apps/web/TERMINAL_API.md
// showKeyBar 显式指定是否渲染快捷键条；不传时按媒体查询判断（jsdom 查不出粗指针，所以留出这个口子）
export function TerminalView({ sessionId, className, showKeyBar, readOnly = false }: { sessionId: string; className?: string; showKeyBar?: boolean; readOnly?: boolean }) {
  // xterm 会往 hostRef 里塞自己的 DOM，所以它必须是一个 React 不放子节点的空容器：
  // 快捷键条挂在外层 wrapper 上，两边各管一棵子树，React 的 diff 不会和 xterm 抢节点。
  const hostRef = useRef<HTMLDivElement>(null);
  // 快捷键条要往已建立的 WS 里写字节，而 ws 实例活在 effect 作用域里，用 ref 把发送口暴露出来
  const sendInputRef = useRef<(data: string) => void>(() => {});
  const wideEnoughForKeys = useMediaQuery(KEY_BAR_MEDIA);
  const coarsePointer = useMediaQuery(COARSE_MEDIA);
  // 选择模式：默认关（触屏拖动 = 滚动回看历史），开启后放开 xterm 原生拖选以便复制
  const [selectMode, setSelectMode] = useState(false);
  const selectModeRef = useRef(selectMode);
  useEffect(() => { selectModeRef.current = selectMode; }, [selectMode]);
  const scrollToBottomRef = useRef<(focus: boolean) => void>(() => {});
  const [scrolledUp, setScrolledUp] = useState(false);
  /*
    连续两次握手都没成功就显示说明。服务端拒绝挂接时在握手阶段回 404/503 并附原因，
    但浏览器的 WebSocket 读不到失败握手的状态码与正文，只收到 close：
    不给提示的话，界面就是一块永远空白、静默重连的终端。重连照常进行，连上即撤掉说明。
    文案不猜原因：进程已退出与运行时拒绝挂接在这里无法区分。
  */
  const [unreachable, setUnreachable] = useState(false);
  const [connectionState, setConnectionState] = useState<'initializing' | 'connecting' | 'waiting' | 'ready'>('initializing');

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    // 创建终端实例：配色取自 CSS 变量，随亮/暗色主题走
    const term = new Terminal({
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      // 字号由容器宽度反推：窄视口自动缩小换更多列数，见 terminalFontSize 的注释
      fontSize: terminalFontSize(host.clientWidth),
      cursorBlink: !readOnly,
      disableStdin: readOnly,
      scrollback: 5000,
      theme: readTerminalTheme()
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    const unbindTouchScroll = bindTerminalTouchScroll(term, () => selectModeRef.current);
    setScrolledUp(false);
    setUnreachable(false);
    scrollToBottomRef.current = focus => { term.scrollToBottom(); if (focus) term.focus(); };
    // xterm 的原生 viewport 滚动会抑制 onScroll；渲染事件同时覆盖滚轮、触摸和新输出。
    const scrollDisposable = term.onRender(() => {
      setScrolledUp(term.buffer.active.viewportY < term.buffer.active.baseY);
    });
    // 隐藏的 tab 仍保持连接；不能用 CSS 的 100% 拟合出小网格并改写真实 PTY 尺寸。
    const hasVisibleSize = () => host.clientWidth > 0 && host.clientHeight > 0;
    // 只读视图保留快照的 ANSI 网格；fit 会改行列数，且不能向托管 PTY 请求 resize。
    const tryFit = () => {
      if (!hasVisibleSize()) return;
      const next = terminalFontSize(host.clientWidth);
      if (term.options.fontSize !== next) term.options.fontSize = next;
      if (readOnly) return;
      try { fit.fit(); } catch { /* 容器尚未准备好，等下次 ResizeObserver 回调 */ }
    };
    tryFit();

    let ws: WebSocket | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let handshakeTimer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let disposed = false;
    let waitingForSnapshot = true;
    let restoring = false;

    const sendResize = () => {
      if (!readOnly && hasVisibleSize() && !waitingForSnapshot && !restoring && ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    };
    const sendInput = (data: string) => {
      if (!readOnly && ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data }));
    };
    // 快捷键条按下后把焦点还给终端：软键盘不收起，用户点完快捷键能接着打字
    sendInputRef.current = (data: string) => { sendInput(data); try { term.focus(); } catch { /* 终端已销毁 */ } };

    function connect() {
      if (disposed) return;
      waitingForSnapshot = true;
      restoring = false;
      setConnectionState('connecting');
      ws = new WebSocket(terminalWsUrl(sessionId));
      const connection = ws;
      const disconnected = () => {
        if (disposed || ws !== connection) return;
        if (handshakeTimer) clearTimeout(handshakeTimer);
        ws = undefined;
        setConnectionState('connecting');
        // 断线后指数退避重连，上限 30s；保留终端里的可读输出。
        reconnectTimer = setTimeout(connect, nextTerminalBackoffMs(attempt));
        attempt += 1;
        if (attempt >= 2) setUnreachable(true);
      };
      handshakeTimer = setTimeout(() => {
        if (disposed || ws !== connection) return;
        disconnected();
        connection.close();
      }, HANDSHAKE_TIMEOUT_MS);
      ws.onopen = () => {
        if (disposed || ws !== connection) return;
        if (handshakeTimer) clearTimeout(handshakeTimer);
        setConnectionState('waiting');
        attempt = 0;
        setUnreachable(false);
        sendResize();
      };
      ws.onmessage = event => {
        if (disposed || ws !== connection) return;
        const frame = parseTerminalFrame(String(event.data));
        if (!frame) return;
        if (frame.type === 'snapshot') {
          setConnectionState(frame.data ? 'ready' : 'waiting');
          waitingForSnapshot = false;
          restoring = true;
          term.reset();
          term.resize(frame.cols, frame.rows);
          term.write(frame.data, () => {
            if (disposed || ws !== connection) return;
            restoring = false;
            tryFit();
            sendResize();
          });
        } else if (frame.type === 'data') {
          if (frame.data) setConnectionState('ready');
          // Compatibility with streams that do not provide snapshots.
          if (waitingForSnapshot) { waitingForSnapshot = false; sendResize(); }
          term.write(frame.data);
        }
        else {
          setConnectionState('ready');
          if (frame.type === 'exit') term.write(`\r\n\x1b[90m[进程已退出，code=${frame.code}]\x1b[0m\r\n`);
          else term.write(`\r\n\x1b[90m[终端错误] ${frame.message}\x1b[0m\r\n`);
        }
      };
      ws.onclose = disconnected;
    }

    // 键盘输入转发给 PTY
    const inputDisposable = term.onData(data => sendInput(data));

    // 容器尺寸变化时：先按新宽度复算字号（字号换档字宽就变，反过来 fit 出来的是旧字号下的列数），
    // 可写视图再 fit 并把新的行列数通知服务端；只读视图只更新字号。
    const observer = new ResizeObserver(() => {
      if (restoring) return;
      tryFit();
      sendResize();
    });
    observer.observe(host);

    // 亮/暗色切换后必须重刷 xterm 主题：颜色被它烤进了自己的渲染层，页面换 CSS 变量传不进去，
    // 不重刷就会停在「暗色页面 + 浅色终端」。两个来源都要听：data-theme（用户显式选择）与系统偏好。
    const applyTheme = () => { try { term.options.theme = readTerminalTheme(); } catch { /* 终端已销毁 */ } };
    const themeObserver = new MutationObserver(applyTheme);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
    const colorScheme = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : undefined;
    colorScheme?.addEventListener('change', applyTheme);

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (handshakeTimer) clearTimeout(handshakeTimer);
      observer.disconnect();
      themeObserver.disconnect();
      colorScheme?.removeEventListener('change', applyTheme);
      inputDisposable.dispose();
      scrollDisposable.dispose();
      unbindTouchScroll();
      scrollToBottomRef.current = () => {};
      sendInputRef.current = () => {};
      ws?.close();
      term.dispose();
    };
  }, [sessionId, readOnly]);

  const onKey = useCallback((data: string) => sendInputRef.current(data), []);
  const keyBarVisible = !readOnly && (showKeyBar ?? wideEnoughForKeys);

  // 滚动模式禁用触屏长按菜单；实际滚动由 bindTerminalTouchScroll 处理。
  const touchScroll = coarsePointer && !selectMode;

  return <div className={`relative ${className ?? ''}`}>
    <div ref={hostRef} data-touch-scroll={touchScroll ? 'on' : undefined} className={`h-full w-full ${touchScroll ? '[&_.xterm-screen]:select-none [&_.xterm-screen]:[-webkit-touch-callout:none] [&_.xterm-screen_*]:select-none [&_.xterm-viewport]:overscroll-none' : ''}`}/>
    {connectionState !== 'ready' && <div role="status" className="pointer-events-none absolute bottom-14 left-2 right-2 z-sticky rounded-md border border-default bg-surface p-3 text-caption text-secondary shadow-panel">
      {unreachable ? <><p className="font-medium text-primary">终端暂时连不上</p><p>服务端没有接受终端连接，浏览器拿不到具体原因。任务进度仍可在「执行记录」查看。仍在自动重试。</p></>
        : connectionState === 'initializing' ? '正在初始化终端…'
          : connectionState === 'connecting' ? '正在连接终端…'
            : '已连接，等待终端输出…'}
    </div>}
    {scrolledUp && <button type="button" onPointerDown={event => event.preventDefault()} onMouseDown={event => event.preventDefault()} onClick={event => scrollToBottomRef.current(document.activeElement === event.currentTarget)} className="absolute right-2 top-2 z-sticky min-h-11 rounded-md border border-default bg-surface px-3 text-caption text-secondary shadow-panel">回到底部</button>}
    {keyBarVisible && <TerminalKeyBar onKey={onKey} selectMode={selectMode} onSelectModeChange={setSelectMode}/>}
  </div>;
}
