import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { nextTerminalBackoffMs, parseTerminalFrame, terminalFontSize, terminalWsUrl } from '../terminal';
import { readThemeColor } from '../theme';
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

function mediaMatches(query: string): boolean {
  try { return typeof window.matchMedia === 'function' && window.matchMedia(query).matches; }
  catch { return false; }
}

// 订阅媒体查询：初值同步取，之后跟着变化走（转屏、拖动窗口宽度）
function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => mediaMatches(query));
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [query]);
  return matches;
}

// PTY 实时终端视图：xterm.js 直连 WebSocket，协议见 apps/web/TERMINAL_API.md
// showKeyBar 显式指定是否渲染快捷键条；不传时按媒体查询判断（jsdom 查不出粗指针，所以留出这个口子）
export function TerminalView({ sessionId, className, showKeyBar }: { sessionId: string; className?: string; showKeyBar?: boolean }) {
  // xterm 会往 hostRef 里塞自己的 DOM，所以它必须是一个 React 不放子节点的空容器：
  // 快捷键条挂在外层 wrapper 上，两边各管一棵子树，React 的 diff 不会和 xterm 抢节点。
  const hostRef = useRef<HTMLDivElement>(null);
  // 快捷键条要往已建立的 WS 里写字节，而 ws 实例活在 effect 作用域里，用 ref 把发送口暴露出来
  const sendInputRef = useRef<(data: string) => void>(() => {});
  const wideEnoughForKeys = useMediaQuery(KEY_BAR_MEDIA);
  const coarsePointer = useMediaQuery(COARSE_MEDIA);
  // 选择模式：默认关（触屏拖动 = 滚动回看历史），开启后放开 xterm 原生拖选以便复制
  const [selectMode, setSelectMode] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    // 创建终端实例：配色取自 CSS 变量，随亮/暗色主题走
    const term = new Terminal({
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      // 字号由容器宽度反推：窄视口自动缩小换更多列数，见 terminalFontSize 的注释
      fontSize: terminalFontSize(host.clientWidth),
      cursorBlink: true,
      scrollback: 5000,
      theme: readTerminalTheme()
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
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
    const sendInput = (data: string) => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data }));
    };
    // 快捷键条按下后把焦点还给终端：软键盘不收起，用户点完快捷键能接着打字
    sendInputRef.current = (data: string) => { sendInput(data); try { term.focus(); } catch { /* 终端已销毁 */ } };

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
    const inputDisposable = term.onData(data => sendInput(data));

    // 容器尺寸变化时：先按新宽度复算字号（字号换档字宽就变，反过来 fit 出来的是旧字号下的列数），
    // 再 fit 并把新的行列数通知服务端
    const observer = new ResizeObserver(() => {
      const next = terminalFontSize(host.clientWidth);
      if (term.options.fontSize !== next) term.options.fontSize = next;
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
      observer.disconnect();
      themeObserver.disconnect();
      colorScheme?.removeEventListener('change', applyTheme);
      inputDisposable.dispose();
      sendInputRef.current = () => {};
      ws?.close();
      term.dispose();
    };
  }, [sessionId]);

  const onKey = useCallback((data: string) => sendInputRef.current(data), []);
  const keyBarVisible = showKeyBar ?? wideEnoughForKeys;

  // 触屏上 xterm 默认的拖动选中会和「拖动滚动回看历史」抢同一个手势：手指划过有字的区域会起
  // 原生选区并弹长按菜单，滚动就地卡住，而空白区域却照常能滚——这就是手机上滚动时好时坏的成因。
  // 判据抄 botmux 的 body.touch 规则：触屏下关掉渲染层的 user-select 与长按菜单，拖动因此落到
  // .xterm-viewport 的原生滚动上；要复制时用快捷键条的「选择」开关切回原生拖选。
  // 只认粗指针，鼠标一律不进这个分支，桌面（含窄窗口）的拖选复制不受影响。
  const touchScroll = coarsePointer && !selectMode;

  return <div className={`relative ${className ?? ''}`}>
    <div ref={hostRef} data-touch-scroll={touchScroll ? 'on' : undefined} className={`h-full w-full ${touchScroll ? '[&_.xterm-screen]:select-none [&_.xterm-screen]:[-webkit-touch-callout:none] [&_.xterm-screen_*]:select-none [&_.xterm-viewport]:overscroll-none' : ''}`}/>
    {keyBarVisible && <TerminalKeyBar onKey={onKey} selectMode={selectMode} onSelectModeChange={setSelectMode}/>}
  </div>;
}
