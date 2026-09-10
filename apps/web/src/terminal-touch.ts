import type { Terminal } from '@xterm/xterm';

// xterm 5 的触摸处理只滚动本地 viewport；鼠标协议开启时会直接跳过。
// 复用它的 wheel 编码，让全屏 CLI 收到与桌面滚轮相同的输入。
export function bindTerminalTouchScroll(term: Terminal, isSelecting: () => boolean): () => void {
  const element = term.element!;
  let gesture: { x: number; y: number; lastY: number; remainder: number; scrolling: boolean } | undefined;

  const start = (event: TouchEvent) => {
    gesture = undefined;
    if (isSelecting()) return;
    event.stopPropagation();
    if (event.touches.length !== 1) return;
    const touch = event.touches[0];
    gesture = { x: touch.clientX, y: touch.clientY, lastY: touch.clientY, remainder: 0, scrolling: false };
  };
  const move = (event: TouchEvent) => {
    if (isSelecting()) { gesture = undefined; return; }
    event.stopPropagation();
    if (event.touches.length !== 1) { gesture = undefined; return; }
    if (!gesture) return;
    const touch = event.touches[0];
    if (!gesture.scrolling) {
      const dx = Math.abs(touch.clientX - gesture.x);
      const dy = Math.abs(touch.clientY - gesture.y);
      if (Math.max(dx, dy) < 6) return;
      if (dx > dy) { gesture = undefined; return; }
      gesture.scrolling = true;
    }
    event.preventDefault();
    const rowHeight = element.querySelector('.xterm-screen')!.clientHeight / term.rows;
    if (rowHeight <= 0) return;
    gesture.remainder += (gesture.lastY - touch.clientY) / rowHeight;
    gesture.lastY = touch.clientY;
    const lines = Math.trunc(gesture.remainder);
    gesture.remainder -= lines;
    if (!lines) return;

    if (term.buffer.active.type === 'normal' && term.modes.mouseTrackingMode === 'none') {
      term.scrollLines(lines);
    } else {
      // 一次 wheel 对应一次鼠标报告；逐行派发保留距离，也由 xterm 选择 SGR/旧编码或方向键。
      for (let i = 0; i < Math.abs(lines); i++) {
        element.dispatchEvent(new WheelEvent('wheel', {
          deltaY: Math.sign(lines), deltaMode: WheelEvent.DOM_DELTA_LINE,
          clientX: gesture.x, clientY: gesture.y, bubbles: true, cancelable: true
        }));
      }
    }
  };
  const end = () => { gesture = undefined; };
  element.addEventListener('touchstart', start, { capture: true, passive: true });
  element.addEventListener('touchmove', move, { capture: true, passive: false });
  element.addEventListener('touchend', end, true);
  element.addEventListener('touchcancel', end, true);
  return () => {
    element.removeEventListener('touchstart', start, true);
    element.removeEventListener('touchmove', move, true);
    element.removeEventListener('touchend', end, true);
    element.removeEventListener('touchcancel', end, true);
  };
}
