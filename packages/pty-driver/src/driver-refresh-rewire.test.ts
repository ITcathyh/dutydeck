import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionBackend } from '@dutydeck/session-backends';
import { PtyCliDriver } from './driver.js';

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function fakeBackend(screen: Promise<string | null>) {
  let data: (chunk: string) => void = () => {}, gap: (dropped: number) => void = () => {};
  const backend: SessionBackend = {
    kind: 'pty', spawn() {}, resize() {}, kill() {}, interrupt() {}, write() {}, onExit() {},
    onData(cb) { data = cb; }, onOutputGap(cb) { gap = cb; }, captureCurrentScreen: () => screen,
  };
  return { backend, emit: (chunk: string) => data(chunk), gap: (dropped: number) => gap(dropped) };
}
const drivers: PtyCliDriver[] = [];
afterEach(async () => { for (const driver of drivers.splice(0)) await driver.stop(); });

describe('terminal refresh across rewiring', () => {
  it.each([false, true])('does not freeze the new wiring when a refresh was in flight (same backend=%s)', async sameBackend => {
    const stale = deferred<string | null>();
    const first = fakeBackend(stale.promise);
    const second = sameBackend ? first : fakeBackend(Promise.resolve(null));
    const driver = new PtyCliDriver({
      agent: { id: 'fixture', name: 'fixture', protocol: 'pty-cli', command: 'unused', args: [], env: {}, permissionMode: 'full-trust', timeout: 60, capabilities: {}, builtin: false },
      adapter: { id: 'fixture', capabilities: {}, buildArgs: () => [], writeInput() {} },
      backend: first.backend, sessionId: 'ses_refresh-rewire', onEvent() {}, onExit() {},
    });
    drivers.push(driver);
    const internals = driver as unknown as { backend: SessionBackend; snapshot: { viewportText(): string }; refreshingScreen: boolean; wire(b: SessionBackend): Promise<void>; teardownWiring(): void };
    await internals.wire(first.backend);
    first.gap(4096);
    expect(internals.refreshingScreen).toBe(true);

    internals.teardownWiring();
    internals.backend = second.backend;
    await internals.wire(second.backend);
    second.emit('FRESH_MARKER\r\n');
    await vi.waitFor(() => expect(internals.snapshot.viewportText()).toContain('FRESH_MARKER'));

    stale.resolve('STALE_SCREEN');
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(internals.snapshot.viewportText()).not.toContain('STALE_SCREEN');
    expect(internals.snapshot.viewportText()).toContain('FRESH_MARKER');
    second.emit('LATER_MARKER\r\n');
    await vi.waitFor(() => expect(internals.snapshot.viewportText()).toContain('LATER_MARKER'));
  });
});
