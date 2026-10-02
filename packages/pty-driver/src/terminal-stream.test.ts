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
    let gap!: (dropped: number) => void, resolve!: (screen: string) => void, calls = 0;
    backend.onOutputGap = callback => { gap = callback; };
    backend.resyncOutput = boundary => { calls++; boundary?.(); return new Promise(done => { resolve = done; }); };
    await driver.start();
    const frames: string[] = [];
    driver.createTerminalStream().onData(data => frames.push(data));
    gap(100);
    expect(frames[0]).toContain('terminal output exceeded its buffer');
    // The authoritative capture has happened, but its Promise response is delayed.
    output('AFTER_CAPTURE'); resolve('SCREEN');
    await new Promise(done => setTimeout(done, 10));
    expect(frames.join('')).toContain('SCREENAFTER_CAPTURE');
    gap(100);
    output('x'.repeat(300000)); resolve('OBSOLETE');
    await Promise.resolve(); await Promise.resolve();
    expect(calls).toBe(3);
    output('LATEST_TAIL'); resolve('LATEST');
    await new Promise(done => setTimeout(done, 10));
    expect(frames.slice(-2).join('')).toContain('LATESTLATEST_TAIL');
    expect(frames.at(-1)).not.toContain('OBSOLETE');
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

});
