import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionBackend } from '@dutydeck/session-backends';
import type { CliAdapter } from '@dutydeck/cli-adapters';
import { DriverRecoveryError, type NormalizedDriverEvent } from '@dutydeck/shared';
import { PtyCliDriver } from './driver.js';
import { TurnCpu } from './turn-cpu.js';

const drivers: PtyCliDriver[] = [];
beforeEach(() => { vi.useFakeTimers(); });
afterEach(async () => {
  for (const driver of drivers.splice(0)) await driver.stop();
  vi.restoreAllMocks(); vi.useRealTimers();
});
async function fixture(options: { awaitingAnswer?: () => boolean; writeInput?: CliAdapter['writeInput']; write?: SessionBackend['write'] } = {}) {
  let output!: (data: string) => void;
  const killed = vi.fn(), events: NormalizedDriverEvent[] = [];
  const backend: SessionBackend = {
    kind: 'pty', spawn() {}, resize() {}, kill: killed, interrupt() {}, onExit() {},
    write: options.write ?? (() => true), onData(callback) { output = callback; },
  };
  const driver = new PtyCliDriver({
    agent: { id: 'fixture', name: 'Fixture', command: 'unused', args: [], env: {}, protocol: 'pty-cli',
      permissionMode: 'full-trust', timeout: 1, builtin: false, capabilities: { pause: false, resume: false } },
    adapter: { id: 'fixture', capabilities: {}, buildArgs: () => [], writeInput: options.writeInput ?? (() => {}) },
    backend, awaitingAnswer: options.awaitingAnswer, sessionId: 'fixture', onEvent: event => events.push(event), onExit() {},
  });
  drivers.push(driver); await driver.start();
  const progress = (event: NormalizedDriverEvent) => (driver as unknown as { noteTurnProgress(event: NormalizedDriverEvent): void }).noteTurnProgress(event);
  return { driver, output: (data: string) => output(data), progress, killed, events };
}
async function send(driver: PtyCliDriver) {
  let settled = false;
  const result = driver.send('prompt').then(() => { settled = true; return undefined; }, error => { settled = true; return error; });
  await vi.advanceTimersByTimeAsync(0);
  return { result, settled: () => settled };
}

describe('PTY verified inactivity deadline', () => {
  it('rejects an inert turn with recovery evidence, without killing or completing it', async () => {
    const f = await fixture(), turn = await send(f.driver);
    await vi.advanceTimersByTimeAsync(1001);
    expect(await turn.result).toBeInstanceOf(DriverRecoveryError);
    expect(f.killed).not.toHaveBeenCalled();
    expect(f.events.some(event => event.type === 'completed')).toBe(false);
    expect(f.events.some(event => event.data.state === 'turn_timeout')).toBe(true);
  });
  it('reports the inactivity deadline as AGENT_IDLE_TIMEOUT with minutes, not as an unknown driver result', async () => {
    const f = await fixture(), turn = await send(f.driver);
    await vi.advanceTimersByTimeAsync(1001);
    expect(await turn.result).toMatchObject({ name: 'DriverRecoveryError', code: 'AGENT_IDLE_TIMEOUT' });
    expect(f.events.filter(event => event.type === 'error').map(event => event.data))
      .toEqual([{ message: '1 分钟没有任何输出，已停止', code: 'AGENT_IDLE_TIMEOUT', timeoutMinutes: 1, retryable: true }]);
  });
  it('does not allow endless spinner redraws or identical tool results to extend the deadline', async () => {
    const f = await fixture(), turn = await send(f.driver);
    for (let at = 0; at < 8; at++) {
      f.output(`\r✻ Working… ${at}s`);
      f.progress({ type: 'tool_result', data: { id: 'same', output: 'same' } });
      await vi.advanceTimersByTimeAsync(150);
    }
    expect(await turn.result).toBeInstanceOf(DriverRecoveryError);
  });
  it('extends on repeated nonempty structured text chunks and verified CPU work', async () => {
    const cpu = vi.spyOn(TurnCpu.prototype, 'active').mockResolvedValue(true);
    const f = await fixture(), turn = await send(f.driver);
    await vi.advanceTimersByTimeAsync(1500);
    expect(turn.settled()).toBe(false);
    cpu.mockResolvedValue(false);
    for (let at = 0; at < 4; at++) { f.progress({ type: 'text', data: { text: 'chunk' } }); await vi.advanceTimersByTimeAsync(800); }
    expect(turn.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1001);
    expect(await turn.result).toBeInstanceOf(DriverRecoveryError);
  });
  it('pauses for authoritative relay waits and permission requests, then gives a fresh inactivity window', async () => {
    let waiting = true;
    const f = await fixture({ awaitingAnswer: () => waiting }), turn = await send(f.driver);
    await vi.advanceTimersByTimeAsync(3000); expect(turn.settled()).toBe(false);
    waiting = false;
    f.progress({ type: 'permission_request', data: { id: 'approve', status: 'pending' } });
    await vi.advanceTimersByTimeAsync(3000); expect(turn.settled()).toBe(false);
    f.progress({ type: 'permission_request', data: { id: 'approve', status: 'granted' } });
    await vi.advanceTimersByTimeAsync(999); expect(turn.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(2); expect(await turn.result).toBeInstanceOf(DriverRecoveryError);
  });
  it('fences an Enter queued behind an unfinished asynchronous paste when stop cancels submission', async () => {
    let release!: () => void;
    const gate = new Promise<boolean>(resolve => { release = () => resolve(true); });
    const writes: string[] = [];
    const f = await fixture({
      write(data) { writes.push(data); return data === 'paste' ? gate : true; },
      writeInput(backend) { backend.write('paste'); backend.write('\r'); },
    });
    const turn = await send(f.driver);
    expect(writes).toEqual(['paste']);
    await f.driver.stop(); release(); await vi.advanceTimersByTimeAsync(0);
    expect(writes).toEqual(['paste']);
    expect((await turn.result).message).toBe('Driver stopped');
  });
});
