import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TmuxBackend } from '@dutydeck/session-backends';
import { PtyCliDriver } from './driver.js';

let directory: string;
const savedDirectory = process.env.TMUX_TMPDIR, savedTmux = process.env.TMUX;
const backends: TmuxBackend[] = [], drivers: PtyCliDriver[] = [];
beforeAll(() => { directory = mkdtempSync(join(tmpdir(), 'dd-driver-handoff-')); process.env.TMUX_TMPDIR = directory; delete process.env.TMUX; });
afterEach(async () => { for (const driver of drivers.splice(0)) await driver.stop(); for (const backend of backends.splice(0)) await backend.kill(); });
afterAll(() => {
  try { execFileSync('/usr/bin/tmux', ['kill-server'], { env: { ...process.env, TMUX_TMPDIR: directory, TMUX: '' }, stdio: 'ignore' }); } catch { /* empty isolated server */ }
  rmSync(directory, { recursive: true, force: true });
  if (savedDirectory === undefined) delete process.env.TMUX_TMPDIR; else process.env.TMUX_TMPDIR = savedDirectory;
  if (savedTmux === undefined) delete process.env.TMUX; else process.env.TMUX = savedTmux;
});
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function driverFor(backend: TmuxBackend, events: any[]) {
  const driver = new PtyCliDriver({ agent: { id: 'fixture', name: 'Fixture', command: 'unused', args: [], env: {}, protocol: 'pty-cli', permissionMode: 'full-trust', timeout: 30, builtin: false, capabilities: {} }, adapter: { id: 'fixture', capabilities: {}, buildArgs: () => [], writeInput() {} }, backend, sessionId: 'fixture', onEvent: event => events.push(event), onExit() {} });
  drivers.push(driver); return driver;
}
async function attached() {
  const name = `handoff-${process.pid}-${Date.now()}`;
  const first = new TmuxBackend(name); backends.push(first);
  await first.spawn('/bin/sh', ['-c', 'stty -echo; printf "READY\\r\\n"; exec /bin/sh'], { cwd: directory, cols: 80, rows: 24, env: process.env });
  await vi.waitFor(async () => expect(await first.captureCurrentScreen()).toContain('READY'));
  await first.write("printf 'BEFORE_MARKER\\r\\n'\r");
  await vi.waitFor(async () => expect(await first.captureCurrentScreen()).toContain('BEFORE_MARKER'));
  await first.detach();
  const backend = new TmuxBackend(name); backends.push(backend);
  await backend.attach({ cols: 80, rows: 24 });
  return backend;
}
describe('persistent driver initial output handoff', () => {
  it('preserves real tmux before/during/after output exactly once during a slow PID lookup', async () => {
    const backend = await attached(), gate = deferred<number | null>(), events: any[] = [];
    const pid = await backend.getPid(); vi.spyOn(backend, 'getPid').mockReturnValue(gate.promise);
    const driver = driverFor(backend, events);
    const wiring = (driver as any).wire(backend);
    await backend.write("printf 'DURING_MARKER\\r\\n'\r");
    await vi.waitFor(() => expect((backend as any).output.pending).toContain('DURING_MARKER'));
    gate.resolve(pid); await wiring;
    await backend.write("printf 'AFTER_MARKER\\r\\n'\r");
    await vi.waitFor(() => expect((driver as any).snapshot.viewportText()).toContain('AFTER_MARKER'));
    const screen = (driver as any).snapshot.viewportText();
    expect(screen.indexOf('BEFORE_MARKER')).toBeLessThan(screen.indexOf('DURING_MARKER'));
    expect(screen.indexOf('DURING_MARKER')).toBeLessThan(screen.indexOf('AFTER_MARKER'));
    for (const marker of ['BEFORE_MARKER', 'DURING_MARKER', 'AFTER_MARKER']) expect(screen.split(marker)).toHaveLength(2);
    expect(events.some(event => event.data?.state === 'terminal_output_gap')).toBe(false);
  });
  it('emits a subscription overflow gap and restores a fresh atomic tmux snapshot', async () => {
    const backend = await attached(), gate = deferred<number | null>(), events: any[] = [];
    const pid = await backend.getPid(); vi.spyOn(backend, 'getPid').mockReturnValue(gate.promise);
    const driver = driverFor(backend, events), resync = vi.spyOn(backend, 'resyncOutput');
    const wiring = (driver as any).wire(backend);
    await backend.write("printf 'RECOVERY_MARKER\\r\\n'\r");
    await vi.waitFor(() => expect((backend as any).output.pending).toContain('RECOVERY_MARKER'));
    // Deterministically overflow the same bounded capture-to-subscription buffer.
    (backend as any).output.data('x'.repeat(256 * 1024 + 1));
    expect((backend as any).output.pending).toBe('');
    gate.resolve(pid); await wiring;
    await vi.waitFor(() => expect(resync).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect((driver as any).refreshingScreen).toBe(false));
    expect(events.some(event => event.data?.state === 'terminal_output_gap')).toBe(true);
    expect((driver as any).snapshot.viewportText()).toContain('RECOVERY_MARKER');
    expect((driver as any).snapshot.viewportText()).not.toContain('xxxxxxxxxxxxxxxx');
  });
});
