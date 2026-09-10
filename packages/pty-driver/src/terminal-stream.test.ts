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
  return { driver, output: (data: string) => output(data) };
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
});
