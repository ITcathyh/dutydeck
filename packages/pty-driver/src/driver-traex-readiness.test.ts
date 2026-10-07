import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createTraexAdapter } from '@dutydeck/cli-adapters';
import type { SessionBackend } from '@dutydeck/session-backends';
import { PtyCliDriver } from './driver.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ready = 'TraeX\n❯ Ask TraeCode CLI\nContext 100% left';
let driver: PtyCliDriver, output: (data: string) => void, writes: string[], screen: string, directory: string;
let prepare: ReturnType<typeof vi.fn>;
const paint = (text: string) => output(`\x1b[2J\x1b[H${text.replaceAll('\n', '\r\n')}`);
beforeEach(async () => {
  vi.useFakeTimers(); writes = []; screen = ready; directory = mkdtempSync(join(tmpdir(), 'dd-traex-ready-'));
  const adapter = createTraexAdapter(); prepare = vi.fn(adapter.prepareInput);
  const backend: SessionBackend = { kind: 'pty', spawn() {}, resize() {}, kill() {}, onExit() {}, interrupt() {},
    onData(cb) { output = cb; }, write(data) { writes.push(data); return true; } };
  driver = new PtyCliDriver({
    agent: { id: 'traex', name: 'fixture', command: 'unused', args: [], protocol: 'pty-cli', cwd: directory, env: { TRAE_HOME: directory },
      permissionMode: 'full-trust', timeout: 0, capabilities: { pause: false, resume: true }, builtin: false },
    // Input receipts have separate real-source coverage. Disable them here
    // solely to isolate every-turn write gating and lifecycle cancellation.
    adapter: { ...adapter, capabilities: {}, prepareInput: prepare }, backend,
    sessionId: 'ses_traex-readiness', onEvent() {}, onExit() {},
  });
  await driver.start(); paint(screen); await vi.advanceTimersByTimeAsync(250);
});
afterEach(async () => { await driver.stop(); vi.useRealTimers(); rmSync(directory, { recursive: true, force: true }); });
async function firstTurn() {
  const pending = driver.send('first'); await vi.advanceTimersByTimeAsync(250);
  expect(writes).toHaveLength(2); expect(writes[0]).toMatch(/^\x1b\[200~[\s\S]*first\x1b\[201~$/); expect(writes[1]).toBe('\r');
  // The scoped screen reader comes from the real driver snapshot.
  await finish(pending); writes = [];
}
async function finish(pending: Promise<void>) {
  // No transcript result in this write-only fixture: preserve the real
  // driver's startup grace and give it fresh screen evidence after it.
  await vi.advanceTimersByTimeAsync(16_000); paint(ready);
  await vi.advanceTimersByTimeAsync(4_000);
  expect((driver as unknown as { turnActive: boolean }).turnActive).toBe(false);
  await pending;
}
it.each(['Queued for next turn', '⠋ Queued for next turn', 'Queued for capacity', 'esc to interrupt', '❯ 1. Choose mode', '❯ unsent manual draft'])
('holds the real second submission with %s and submits once after ready', async busy => {
  await firstTurn(); paint(busy.startsWith('❯') ? ready.replace('❯ Ask TraeCode CLI', busy) : `${busy}\n${ready}`);
  await vi.advanceTimersByTimeAsync(250);
  const pending = driver.send('second\r\nline'); void pending.catch(() => {});
  await vi.advanceTimersByTimeAsync(1_000); expect(writes).toEqual([]); expect(prepare).toHaveBeenCalledTimes(1);
  paint(ready); await vi.advanceTimersByTimeAsync(500);
  expect(writes).toEqual(['\x1b[200~second\nline\x1b[201~', '\r']);
  await finish(pending);
});
it.each(['interrupt', 'stop'] as const)('never writes after %s cancels a held second submission', async action => {
  await firstTurn(); paint(`Queued for next turn\n${ready}`); await vi.advanceTimersByTimeAsync(250);
  const pending = driver.send('second'); void pending.catch(() => {});
  await vi.advanceTimersByTimeAsync(500); expect(writes).toEqual([]);
  await driver[action](); await expect(pending).rejects.toThrow();
  paint(ready); await vi.advanceTimersByTimeAsync(2_000); expect(writes).toEqual([]);
});
it('accepts quoted queue/esc prose without treating it as current status', async () => {
  await firstTurn(); paint(`The response explains "Queued for next turn" and "esc to interrupt".\n${ready}`);
  await vi.advanceTimersByTimeAsync(250);
  const pending = driver.send('second'); await vi.advanceTimersByTimeAsync(500);
  expect(writes).toEqual(['\x1b[200~second\x1b[201~', '\r']);
  await finish(pending);
});
