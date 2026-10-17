import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCliAdapter, type CliAdapter } from '@dutydeck/cli-adapters';
import type { SessionBackend } from '@dutydeck/session-backends';
import type { NormalizedDriverEvent } from '@dutydeck/shared';
import { PtyCliDriver } from './driver.js';

const captured = (name: string) => readFileSync(new URL(`./fixtures/osc7501/${name}.bin`, import.meta.url)).toString('utf8');
const frame = (state: string) => `\x1b]7501;state=${state}:app=claude-code\x07`;
const stateAt = (raw: string, state: string) => raw.indexOf(`\x1b]7501;state=${state}:`);
const tick = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };

describe('driver OSC 7501 with real PTY capture replay', () => {
  let cwd: string, driver: PtyCliDriver, output: (data: string) => void, events: NormalizedDriverEvent[], adapter: CliAdapter, submitted: boolean;
  const completed = () => events.filter(e => e.type === 'completed');
  beforeEach(() => { vi.useFakeTimers(); cwd = mkdtempSync(join(tmpdir(), 'dutydeck-osc-replay-')); events = []; submitted = false; });
  afterEach(async () => { await driver?.stop(); vi.useRealTimers(); rmSync(cwd, { recursive: true, force: true }); });
  async function start(enabled = true, prepareInput?: CliAdapter['prepareInput']) {
    // Use real Claude screen patterns; isolate the transcript separately from these PTY fixtures.
    adapter = { ...createCliAdapter('claude-code'), id: 'osc-replay', capabilities: enabled ? { programStatus: true } : {},
      prepareInput, writeInput() { submitted = true; } };
    const backend: SessionBackend = { kind: 'pty', spawn() {}, write() {}, interrupt() {}, resize() {}, kill() {}, onExit() {}, onData(cb) { output = cb; } };
    driver = new PtyCliDriver({ agent: { id: 'ccflash', name: 'Replay', command: 'unused', args: [], cwd, env: {}, permissionMode: 'ask', protocol: 'pty-cli', timeout: 3600, capabilities: { pause: false, resume: false }, builtin: false }, adapter, backend, sessionId: 'ses_osc-replay', onEvent: e => events.push(e), onExit() {} });
    await driver.start();
  }
  function replay(raw: string) { for (let i = 0; i < raw.length; i += 37) output(raw.slice(i, i + 37)); }
  it('holds a long silent thinking turn despite screen/external idle and ends immediately on real done', async () => {
    await start(); const raw = captured('ccflash-simple'), working = stateAt(raw, 'working'), done = stateAt(raw, 'done');
    replay(raw.slice(0, working)); const pending = driver.send('List files'); await tick(); expect(submitted).toBe(true);
    replay(raw.slice(working, done)); await vi.advanceTimersByTimeAsync(60_000);
    (driver as any).idleDetector.fireIdle(); expect(completed()).toHaveLength(0);
    const at = Date.now(); replay(raw.slice(done)); await tick(); await pending;
    expect(Date.now() - at).toBe(0); expect(completed()).toHaveLength(1);
  });
  it('keeps real permission blocked open, emits status and creates no duplicate approval item', async () => {
    await start(); const raw = captured('approval2'), working = stateAt(raw, 'working'), blocked = stateAt(raw, 'blocked');
    const resume = raw.indexOf('\x1b]7501;state=working:', blocked), done = stateAt(raw, 'done');
    replay(raw.slice(0, working)); const pending = driver.send('Write hello.txt'); await tick();
    replay(raw.slice(working, resume)); await vi.advanceTimersByTimeAsync(60_000);
    expect(completed()).toHaveLength(0); expect(events.filter(e => e.type === 'permission_request')).toHaveLength(0);
    expect(events.some(e => e.type === 'status' && e.data.programState === 'blocked' && e.data.kind === 'permission')).toBe(true);
    replay(raw.slice(resume, done)); expect(completed()).toHaveLength(0); replay(raw.slice(done)); await tick(); await pending;
    expect(completed()).toHaveLength(1);
  });
  it.each([false, true])('keeps legacy screen completion when negotiation has no state (capability=%s)', async enabled => {
    await start(enabled); replay(captured('no-reply'));
    await vi.advanceTimersByTimeAsync(15_000);
    const pending = driver.send('Hello'); await tick(); expect(submitted).toBe(true);
    output('\x1b[2J\x1b[HAnswer\r\n✻ Worked for 3s\r\n❯\r\n');
    await vi.advanceTimersByTimeAsync(600); await pending; expect(completed()).toHaveLength(1);
  });
  it('startup idle cannot bypass the existing screen preparation gate', async () => {
    let ready!: () => void;
    await start(true, () => new Promise(resolve => { ready = resolve; }));
    const pending = driver.send('Hello'); await tick(); output(frame('idle')); await vi.advanceTimersByTimeAsync(5_000);
    expect(submitted).toBe(false); expect(completed()).toHaveLength(0);
    ready(); await tick(); expect(submitted).toBe(true); output(frame('working')); output(frame('done')); await tick(); await pending;
    expect(completed()).toHaveLength(1);
  });
  it('finishes legacy native transcripts after the bounded drain without any further output', async () => {
    await start(); output(frame('idle')); const pending = driver.send('Hello'); await tick(); output(frame('working'));
    const internals = driver as any;
    adapter.capabilities.nativeInputReceipt = true;
    internals.turnHasTranscriptResult = true;
    internals.transcript = { flush: async () => {}, stop() {}, hasTurnTerminal: () => false, requiresTurnTerminal: false };
    output(frame('done')); await tick(); expect(completed()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_999); expect(completed()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1); await pending; expect(completed()).toHaveLength(1);
  });
  it('retires an OSC completion whose authority falls back during its asynchronous flush', async () => {
    await start(); output(frame('idle')); const pending = driver.send('Hello'); void pending.catch(() => {});
    await tick(); output(frame('working'));
    let release!: () => void;
    (driver as any).transcript = { flush: () => new Promise<void>(resolve => { release = resolve; }), stop() {} };
    output(frame('done')); await tick(); expect(release).toBeTypeOf('function');
    output(frame('working')); output(frame('clear'));
    output('\x1b[2J\x1b[HThinking\r\n❯\r\n⏵⏵ bypass permissions on · esc to interrupt');
    await tick(); release(); await tick();
    (driver as any).transcript = undefined;
    expect(completed()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(completed()).toHaveLength(0);
  });
  it('rechecks busy authority after an asynchronous transcript flush', async () => {
    await start(); output(frame('idle')); const pending = driver.send('Hello'); await tick(); output(frame('working'));
    let release!: () => void;
    (driver as any).transcript = { flush: () => new Promise<void>(resolve => { release = resolve; }), stop() {} };
    output(frame('done')); await tick(); output(frame('working')); release(); await tick(); expect(completed()).toHaveLength(0);
    (driver as any).transcript = undefined; output(frame('done')); await tick(); await pending; expect(completed()).toHaveLength(1);
  });
});
