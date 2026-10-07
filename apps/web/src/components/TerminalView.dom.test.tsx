import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalView } from './TerminalView';

const terminals = vi.hoisted(() => [] as any[]);
const fits = vi.hoisted(() => [] as any[]);

// Exercise the real component lifecycle; only the browser terminal renderer is replaced.
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    element?: HTMLElement;
    options: any;
    buffer = { active: { viewportY: 0, baseY: 0 } };
    writes: string[] = [];
    writeCallbacks: Array<() => void> = [];
    onInput?: (data: string) => void;
    resize = vi.fn((cols: number, rows: number) => { this.cols = cols; this.rows = rows; });
    reset = vi.fn();
    dispose = vi.fn();
    focus = vi.fn();
    scrollToBottom = vi.fn();
    constructor(options: any) { this.options = options; terminals.push(this); }
    loadAddon(addon: any) { addon.term = this; }
    open(host: HTMLElement) { this.element = document.createElement('div'); host.append(this.element); }
    onRender() { return { dispose() {} }; }
    onData(callback: (data: string) => void) { this.onInput = callback; return { dispose() {} }; }
    write(data: string, callback?: () => void) { this.writes.push(data); if (callback) this.writeCallbacks.push(callback); }
  }
}));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    term: any;
    fit = vi.fn(() => this.term.resize(60, 20));
    constructor() { fits.push(this); }
  }
}));

class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 0;
  onopen?: () => void;
  onclose?: () => void;
  onmessage?: (event: { data: string }) => void;
  sent: unknown[] = [];
  close = vi.fn(() => { this.readyState = 3; this.onclose?.(); });
  constructor(readonly url: string) { Socket.instances.push(this); }
  open() { this.readyState = Socket.OPEN; this.onopen?.(); }
  frame(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) }); }
  send(raw: string) { this.sent.push(JSON.parse(raw)); }
}

const observers: Array<() => void> = [];
beforeEach(() => {
  vi.useFakeTimers();
  terminals.length = 0;
  fits.length = 0;
  Socket.instances = [];
  observers.length = 0;
  vi.stubGlobal('WebSocket', Socket);
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { observers.push(callback); }
    observe() {}
    disconnect() {}
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('TerminalView', () => {
  it('keeps the read-only snapshot grid through container resize, live data, and reconnect without sending input or resize', () => {
    const { container } = render(<TerminalView sessionId="work_item_session" readOnly showKeyBar/>);
    const term = terminals[0];
    const socket = Socket.instances[0];
    act(() => {
      socket.open();
      socket.frame({ type: 'snapshot', cols: 120, rows: 30, data: 'initial snapshot' });
      // Resize during asynchronous snapshot restoration must not change its grid.
      observers[0]();
      term.writeCallbacks.shift()!();
    });
    expect([term.cols, term.rows]).toEqual([120, 30]);
    expect(socket.sent).toEqual([]);
    expect(term.options.disableStdin).toBe(true);
    expect(screen.queryByRole('toolbar')).toBeNull();

    Object.defineProperty(container.firstElementChild!.firstElementChild!, 'clientWidth', { value: 320 });
    act(() => {
      observers[0]();
      term.onInput('must not reach PTY');
      socket.frame({ type: 'data', data: 'continued output' });
    });
    expect(term.options.fontSize).toBe(9);
    expect([term.cols, term.rows]).toEqual([120, 30]);
    expect(term.writes).toContain('continued output');
    expect(socket.readyState).toBe(Socket.OPEN);
    expect(socket.close).not.toHaveBeenCalled();
    expect(socket.sent).toEqual([]);

    act(() => { socket.close(); vi.advanceTimersByTime(1_000); });
    const reconnected = Socket.instances[1];
    act(() => {
      reconnected.open();
      reconnected.frame({ type: 'snapshot', cols: 132, rows: 40, data: 'reconnected snapshot' });
      term.writeCallbacks.shift()!();
      observers[0]();
      reconnected.frame({ type: 'data', data: 'output after reconnect' });
      term.onInput('still read only');
    });
    expect([term.cols, term.rows]).toEqual([132, 40]);
    expect(term.writes).toContain('output after reconnect');
    expect(reconnected.sent).toEqual([]);
    expect(reconnected.close).not.toHaveBeenCalled();
    expect(reconnected.readyState).toBe(Socket.OPEN);
    expect(fits[0].fit).not.toHaveBeenCalled();
  });

  it('does not send resize for a read-only stream without a snapshot', () => {
    render(<TerminalView sessionId="legacy_stream" readOnly/>);
    const socket = Socket.instances[0];
    act(() => { socket.open(); socket.frame({ type: 'data', data: 'legacy output' }); observers[0](); });
    expect(socket.sent).toEqual([]);
    expect(terminals[0].writes).toEqual(['legacy output']);
    expect(socket.close).not.toHaveBeenCalled();
  });

  it('continues fitting and forwarding resize and input for writable terminals', () => {
    render(<TerminalView sessionId="writable_session" showKeyBar={false}/>);
    const term = terminals[0];
    const socket = Socket.instances[0];
    act(() => { socket.open(); observers[0](); });
    expect(socket.sent).toEqual([]);
    act(() => {
      socket.frame({ type: 'snapshot', cols: 120, rows: 30, data: 'snapshot' });
      observers[0]();
    });
    expect(socket.sent).toEqual([]);
    act(() => { term.writeCallbacks.shift()!(); observers[0](); term.onInput('hello'); });
    expect(socket.sent).toEqual([
      { type: 'resize', cols: 60, rows: 20 },
      { type: 'resize', cols: 60, rows: 20 },
      { type: 'input', data: 'hello' }
    ]);
    expect([term.cols, term.rows]).toEqual([60, 20]);
    expect(term.options.disableStdin).toBe(false);
  });
});
