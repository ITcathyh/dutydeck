import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NormalizedDriverEvent } from '@dutydeck/shared';
import { PtyBackend } from '@dutydeck/session-backends';
import { TerminalSnapshot } from '@dutydeck/terminal-renderer';
import { OutputHandoff } from '../../session-backends/src/output-handoff.js';
import { PtyCliDriver } from './driver.js';

const cleanup: string[] = [];
const drivers: PtyCliDriver[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const driver of drivers.splice(0).reverse()) await driver.stop();
  for (const directory of cleanup.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporary() {
  const directory = mkdtempSync(join(tmpdir(), 'dutydeck-terminal-output-'));
  cleanup.push(directory);
  return directory;
}

function agent(cwd: string) {
  return { id: 'terminal-fixture', name: 'Terminal fixture', command: process.execPath, args: [], cwd, env: { HOME: cwd }, protocol: 'pty-cli' as const, permissionMode: 'full-trust' as const, timeout: 10, capabilities: { pause: false, resume: false }, builtin: false };
}

describe('terminal output integrity', () => {
  it('delivers an oversized cursor-forward chunk unchanged through OutputHandoff and the driver', async () => {
    class IsolatedBackend {
      readonly kind = 'pty' as const;
      readonly handoff = new OutputHandoff();
      spawn() {}
      write() { return true; }
      interrupt() {}
      resize() {}
      onData(callback: (data: string) => void) { this.handoff.onData(callback); }
      onExit() {}
      kill() {}
      captureCurrentScreen() { return null; }
    }
    const backend = new IsolatedBackend();
    const events: NormalizedDriverEvent[] = [];
    const driver = new PtyCliDriver({
      agent: agent(temporary()),
      adapter: { id: 'terminal-fixture', capabilities: {}, buildArgs: () => [], writeInput: target => { target.write('unused'); } },
      backend, sessionId: 'terminal-cursor-overflow', onEvent: event => events.push(event), onExit: () => {},
    });
    drivers.push(driver);
    let received = '';
    await driver.start();
    const stream = driver.createTerminalStream();
    stream.onData(data => { received += data; });
    const largeCursor = '\x1b[999999999999999999C';
    try {
      backend.handoff.data('BEFORE\r\n');
      backend.handoff.data(largeCursor + 'LOST-OUTPUT\r\n');
      backend.handoff.data('AFTER\r\n');
      await vi.waitFor(() => expect(received).toContain('AFTER\r\n'));
      expect(received).toContain('BEFORE\r\n');
      expect(received).toContain(largeCursor + 'LOST-OUTPUT\r\n');
      expect(events.filter(event => event.type === 'error')).toEqual([]);
      expect(events.some(event => event.data?.state === 'terminal_output_gap')).toBe(false);
      const detector = (driver as any).idleDetector;
      vi.spyOn(detector, 'feed').mockImplementationOnce(() => { throw new Error('synthetic detector failure'); });
      backend.handoff.data('DETECTOR-FAILURE-OUTPUT\r\n');
      await vi.waitFor(() => expect(received).toContain('DETECTOR-FAILURE-OUTPUT\r\n'));
      expect((driver as any).idleDetector).toBeUndefined();
      expect(events.filter(event => event.type === 'completed')).toEqual([]);
    } finally { stream.dispose(); }
  });

  it('flushes the final parsed screen before reporting immediate process exit', async () => {
    const cwd = temporary();
    const fixture = join(cwd, 'immediate-exit.mjs');
    writeFileSync(fixture, "process.stdout.write('READY\\r\\n'); process.stdin.once('data', () => { process.stdout.write('FINAL-OUTPUT-BEFORE-EXIT\\r\\n'); process.exitCode = 0; process.stdin.destroy(); });\n");
    const events: NormalizedDriverEvent[] = [];
    const exits: Array<number | null> = [];
    let releaseRenderer!: () => void, markRendererEntered!: () => void, armRendererGate = false, rendererGateUsed = false;
    const rendererGate = new Promise<void>(resolve => { releaseRenderer = resolve; });
    const rendererEntered = new Promise<void>(resolve => { markRendererEntered = resolve; });
    const writeAndFlush = TerminalSnapshot.prototype.writeAndFlush;
    vi.spyOn(TerminalSnapshot.prototype, 'writeAndFlush').mockImplementation(async function (data, onParsed) {
      if (armRendererGate && !rendererGateUsed && data === '') {
        rendererGateUsed = true; markRendererEntered(); await rendererGate;
      }
      return writeAndFlush.call(this, data, onParsed);
    });
    const driver = new PtyCliDriver({
      agent: agent(cwd),
      adapter: { id: 'terminal-fixture', capabilities: {}, buildArgs: () => [fixture], writeInput: (target, prompt) => { target.write(prompt + '\r'); } },
      backend: new PtyBackend(), sessionId: 'terminal-final-screen', onEvent: event => events.push(event), onExit: code => exits.push(code),
    });
    drivers.push(driver);
    let terminal = '';
    await driver.start();
    const stream = driver.createTerminalStream();
    stream.onData(data => { terminal += data; if (terminal.includes('FINAL-OUTPUT-BEFORE-EXIT')) armRendererGate = true; });
    try {
      await vi.waitFor(() => expect(events.some(event => event.type === 'raw_terminal' && String(event.data.text).includes('READY'))).toBe(true));
      const sending = driver.send('go');
      const rejection = expect(sending).rejects.toThrow('Agent exited with code 0');
      await rendererEntered;
      await rejection;
      expect(exits).toEqual([]);
      expect(events.some(event => event.type === 'raw_terminal' && String(event.data.text).includes('FINAL-OUTPUT-BEFORE-EXIT'))).toBe(false);
      releaseRenderer();
      await vi.waitFor(() => expect(exits).toEqual([0]));
      expect(terminal).toContain('FINAL-OUTPUT-BEFORE-EXIT');
      const finalScreen = events.filter(event => event.type === 'raw_terminal').at(-1);
      expect(finalScreen?.data.text).toContain('READY');
      expect(finalScreen?.data.text).toContain('FINAL-OUTPUT-BEFORE-EXIT');
    } finally { releaseRenderer(); stream.dispose(); }
  }, 20_000);
});
