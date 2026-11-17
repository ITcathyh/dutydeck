import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TerminalScreen } from '@dutydeck/shared';
import { TerminalSnapshot } from '@dutydeck/terminal-renderer';
import type { SessionBackend } from '@dutydeck/session-backends';
import { PtyCliDriver } from './driver.js';

const drivers: PtyCliDriver[] = [];
afterEach(async () => { await Promise.all(drivers.splice(0).map(driver => driver.stop())); });
function fixture() {
  let output!: (data: string) => void;
  const backend: SessionBackend = {
    kind: 'pty', spawn() {}, write() {}, resize() {}, kill() {}, interrupt() {}, onExit() {},
    onData(callback) { output = callback; }
  };
  const driver = new PtyCliDriver({
    agent: { id: 'fixture', name: 'Fixture', command: 'unused', args: [], env: {}, protocol: 'pty-cli',
      permissionMode: 'full-trust', timeout: 30, builtin: false, capabilities: { pause: false, resume: false } },
    adapter: { id: 'fixture', capabilities: {}, buildArgs: () => [], writeInput() {} },
    backend, sessionId: 'fixture', onEvent() {}, onExit() {}
  });
  drivers.push(driver);
  return { driver, backend, output: (data: string) => output(data) };
}

describe('terminal initial screen', () => {
  it('replays quiet output, then delivers each concurrent and later byte exactly once', async () => {
    const { driver, output } = fixture();
    await driver.start();
    output('before');
    const frames: Array<TerminalScreen | string> = [];
    driver.createTerminalStream().onData(data => frames.push(data), screen => frames.push(screen));
    output('during');
    await vi.waitFor(() => expect(frames).toHaveLength(1));
    output('after');
    expect(frames.slice(1)).toEqual(['after']);
    const screen = frames[0] as TerminalScreen;
    const restored = new TerminalSnapshot(screen.cols, screen.rows);
    await restored.writeAndFlush(screen.data + frames.slice(1).join(''));
    expect(restored.viewportText()).toBe('beforeduringafter');
    restored.dispose();
    // A second subscription has no fresh output to wake it up.
    const second = await new Promise<TerminalScreen>(resolve => driver.createTerminalStream().onData(() => {}, resolve));
    expect(second.data).toContain('beforeduringafter');
  });

  it('restores cursor-addressed pending bytes before a narrower browser resize', async () => {
    const { driver, output } = fixture();
    await driver.start();
    const stream = driver.createTerminalStream();
    stream.resize(80, 24);
    output('READY');
    const screen = new Promise<TerminalScreen>(resolve => stream.onData(() => {}, resolve));
    output('\x1b[24;80H#');
    const initial = await screen;
    const restored = new TerminalSnapshot(initial.cols, initial.rows);
    await restored.writeAndFlush(initial.data);
    expect(restored.xterm.buffer.active.getLine(23)?.getCell(79)?.getChars()).toBe('#');
    expect(restored.xterm.buffer.active.getLine(23)?.getCell(39)?.getChars()).not.toBe('#');
    restored.resize(40, 24);
    restored.dispose();
  });

  it('does not invoke callbacks after disposal or stop during snapshot capture', async () => {
    const { driver, output } = fixture();
    await driver.start();
    output('queued');
    const callback = vi.fn();
    const stream = driver.createTerminalStream();
    stream.onData(callback, callback);
    stream.dispose();
    driver.createTerminalStream().onData(callback, callback);
    await driver.stop();
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(callback).not.toHaveBeenCalled();
  });
  it('bounds a slow initial snapshot and retries after overflow before forwarding increments', async () => {
    const { driver, output } = fixture();
    await driver.start();
    const captures: Array<(screen: TerminalScreen) => void> = [];
    const capture = vi.spyOn(TerminalSnapshot.prototype, 'capture').mockImplementation(callback => { captures.push(callback); });
    try {
      const frames: Array<TerminalScreen | string> = [];
      driver.createTerminalStream().onData(data => frames.push(data), screen => frames.push(screen));
      for (let at = 0; at < 32; at++) { output('x'.repeat(16384)); await new Promise(resolve => setTimeout(resolve, 0)); }
      captures.shift()!({ data: 'STALE', cols: 120, rows: 30 });
      expect(frames).toEqual([]);
      expect(captures).toHaveLength(1);
      captures.shift()!({ data: 'FRESH', cols: 120, rows: 30 });
      expect(frames).toEqual([{ data: 'FRESH', cols: 120, rows: 30 }]);
      output('TAIL'); expect(frames[1]).toBe('TAIL');
    } finally { capture.mockRestore(); }
  });

  it('recovers the snapshot-to-response window with bounded increments and visibly reports loss', async () => {
    const { driver, backend, output } = fixture();
    let gap!: (dropped: number) => void, calls = 0;
    const captureStarted: Array<() => void> = [];
    const started = Array.from({ length: 3 }, () => new Promise<void>(resolve => { captureStarted.push(resolve); }));
    const captures: Array<(screen: string) => void> = [];
    backend.onOutputGap = callback => { gap = callback; };
    backend.resyncOutput = boundary => {
      const capture = calls++;
      boundary?.();
      return new Promise<string>(resolve => { captures[capture] = resolve; captureStarted[capture]!(); });
    };
    await driver.start();
    const frames: string[] = [];
    let firstTailEmitted!: () => void, latestTailEmitted!: () => void;
    const firstTail = new Promise<void>(resolve => { firstTailEmitted = resolve; });
    const latestTail = new Promise<void>(resolve => { latestTailEmitted = resolve; });
    driver.createTerminalStream().onData(data => {
      frames.push(data);
      if (data === 'AFTER_CAPTURE') firstTailEmitted();
      if (data === 'LATEST_TAIL') latestTailEmitted();
    });
    const recovery = driver as unknown as { feedRecoveredScreen(screen: string): Promise<void>; refreshingScreen: boolean };
    const feed = vi.spyOn(recovery, 'feedRecoveredScreen');
    const finishRefresh = async (tail: Promise<void>) => {
      await tail;
      await feed.mock.results.at(-1)!.value;
      // After the last tail is parsed, capture only returns through catch/finally.
      // Let that Promise chain finish before issuing the next gap.
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(recovery.refreshingScreen).toBe(false);
    };
    try {
      gap(100);
      await started[0];
      expect(frames[0]).toContain('terminal output exceeded its buffer');
      // The authoritative capture has happened, but its Promise response is delayed.
      output('AFTER_CAPTURE'); captures[0]!('SCREEN');
      await finishRefresh(firstTail);
      expect(frames.join('')).toContain('SCREENAFTER_CAPTURE');
      gap(100);
      await started[1];
      output('x'.repeat(300000)); captures[1]!('OBSOLETE');
      await started[2];
      expect(calls).toBe(3);
      output('LATEST_TAIL'); captures[2]!('LATEST');
      await finishRefresh(latestTail);
      expect(calls).toBe(3);
      expect(frames.slice(-2).join('')).toContain('LATESTLATEST_TAIL');
      expect(frames.join('')).not.toContain('OBSOLETE');
    } finally {
      for (const resolve of captures) resolve('');
      await driver.stop();
      feed.mockRestore();
    }
  });

  it('does not queue repeated snapshots while the renderer is stalled', async () => {
    const { driver, backend, output } = fixture();
    let gap!: (dropped: number) => void, calls = 0;
    backend.onOutputGap = callback => { gap = callback; };
    backend.resyncOutput = async boundary => { calls++; boundary?.(); return 'CURRENT'; };
    await driver.start();
    const writes: Array<() => void> = [];
    const flush = vi.spyOn(TerminalSnapshot.prototype, 'writeAndFlush').mockImplementation(() => new Promise(resolve => { writes.push(resolve); }));
    try {
      output('x'.repeat(256 * 1024));
      gap(100); await Promise.resolve(); await Promise.resolve();
      expect(calls).toBe(1); expect(writes).toHaveLength(2);
      for (let at = 0; at < 100; at++) output('x'.repeat(16384));
      await Promise.resolve(); await Promise.resolve();
      expect(calls).toBe(1); expect(writes).toHaveLength(2);
      writes[0](); writes[1](); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      expect(calls).toBe(2);
      expect(writes).toHaveLength(3);
      writes[2]();
      await Promise.resolve(); await Promise.resolve();
    } finally { flush.mockRestore(); }
  });

  it('keeps the newest output revision when concurrent raw writes finish out of order', async () => {
    const { driver, backend } = fixture();
    await driver.start();
    let finishA!: () => void, finishB!: () => void;
    backend.write = (data: string) => new Promise<void>(resolve => {
      if (data === 'A') finishA = resolve; else finishB = resolve;
    });
    const terminal = driver.createTerminalStream();
    (driver as any).screenRevision = 10;
    const a = terminal.write('A');
    (driver as any).screenRevision = 11;
    const b = terminal.write('B');
    finishB(); await b;
    finishA(); await a;
    expect((driver as any).rawWriteBarrier.outputRevision).toBe(11);
    terminal.dispose();
  });

  it.each(['generation', 'replacement'] as const)('ignores an expired expanded-viewport restore after %s changes', async staleBy => {
    const { driver, backend } = fixture();
    await driver.start();
    vi.useFakeTimers();
    const target = backend as SessionBackend & { getPaneSize(): Promise<{ cols: number; rows: number }> };
    target.getPaneSize = async () => ({ cols: 80, rows: 24 });
    target.resize = vi.fn(async () => {});
    const snapshot = (driver as any).snapshot;
    const originalResize = vi.spyOn(snapshot, 'resize');
    try {
      const expanding = (driver as any).beginExpandedSubmissionInput(target);
      await vi.advanceTimersByTimeAsync(100);
      const restore = await expanding;
      const replacement = { ...target, resize: vi.fn(async () => {}) };
      const replacementSnapshot = { resize: vi.fn() };
      (driver as any).wiringGeneration++;
      if (staleBy === 'replacement') {
        (driver as any).backend = replacement;
        (driver as any).snapshot = replacementSnapshot;
      }
      await restore();
      await vi.advanceTimersByTimeAsync(100);
      expect(target.resize).toHaveBeenCalledTimes(1);
      expect(originalResize).toHaveBeenCalledTimes(1);
      expect(replacement.resize).not.toHaveBeenCalled();
      expect(replacementSnapshot.resize).not.toHaveBeenCalled();
    } finally {
      (driver as any).backend = backend;
      (driver as any).snapshot = snapshot;
      originalResize.mockRestore();
      vi.useRealTimers();
    }
  });

});
