import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProgramStatusFramingStream } from '@dutydeck/session-backends';
import { IdleDetector } from './idle-detector.js';

const monotonicNow = performance.now.bind(performance);
const detectors: IdleDetector[] = [];
afterEach(() => { detectors.splice(0).forEach(d => d.dispose()); vi.useRealTimers(); });
function fixture() {
  vi.useFakeTimers();
  const detector = new IdleDetector({ completionPattern: /DONE/, readyPattern: /❯/ });
  detectors.push(detector);
  const idle = vi.fn(), mode = vi.fn();
  detector.onIdle(idle); detector.enableProgramStatus(mode);
  const status = (state: 'working' | 'blocked' | 'done' | 'idle' | 'error' | 'clear', id?: string) => detector.observeProgramStatus({ state, app: 'claude-code', ...(id === undefined ? {} : { id }) });
  return { detector, idle, mode, status };
}
describe('program status authority', () => {
  it('keeps malformed OSC parsing and downstream screen feeding bounded', () => {
    const malformed = '\x1b]7501;state=working:'.repeat(Math.ceil(256 * 1024 / 21));
    const times: number[] = [];
    for (let run = 0; run < 3; run++) {
      const h = fixture(), parser = new ProgramStatusFramingStream();
      const start = monotonicNow();
      for (const part of parser.feed(malformed)) if (part.type === 'data') h.detector.feed(part.text);
      times.push(monotonicNow() - start);
    }
    const median = times.sort((a, b) => a - b)[1]!;
    console.info(`malformed OSC parser + screen 256KiB median=${median.toFixed(2)}ms`);
    expect(median).toBeLessThan(150);
  });
  it.each(['working', 'blocked'] as const)('%s vetoes screen and every external idle source without a heartbeat', async state => {
    const h = fixture(); h.status(state); h.detector.feed('❯ DONE'); h.detector.fireIdle();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.idle).not.toHaveBeenCalled(); expect(h.detector.programStatusActive()).toBe(true);
    h.status('done'); expect(h.idle).toHaveBeenCalledExactlyOnceWith('program-status');
  });
  it.each(['clear', 'startup-timeout', 'output-gap'] as const)('accepts fresh working authority after %s fallback', async reason => {
    const h = fixture();
    if (reason === 'startup-timeout') await vi.advanceTimersByTimeAsync(15_000);
    else {
      h.status('working');
      if (reason === 'clear') h.status('clear');
      else h.detector.fallbackProgramStatus('terminal output gap may have lost status frames');
    }
    h.status('working');
    expect(h.detector.programStatusActive()).toBe(true);
    h.detector.feed('❯ DONE'); h.detector.fireIdle();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.idle).not.toHaveBeenCalled();
    h.status('done'); expect(h.idle).toHaveBeenCalledExactlyOnceWith('program-status');
  });
  it('waits for all busy child records, including subtrees cleared explicitly', () => {
    const h = fixture(); h.status('working'); h.status('blocked', 'tool/1'); h.status('done');
    expect(h.idle).not.toHaveBeenCalled(); h.status('clear', 'tool'); expect(h.idle).toHaveBeenCalledOnce();
  });
  it('uses screen fallback after a missing startup handshake', async () => {
    const h = fixture(); await vi.advanceTimersByTimeAsync(15_000);
    h.detector.feed('❯ DONE'); await vi.advanceTimersByTimeAsync(500);
    expect(h.idle).toHaveBeenCalledExactlyOnceWith('screen'); expect(h.mode).toHaveBeenLastCalledWith('screen', expect.stringContaining('handshake'));
  });
  it('waits for a fresh status on each submission then falls back if the signal stops', async () => {
    const h = fixture(); h.status('idle'); h.idle.mockClear(); h.detector.reset(); h.detector.beginProgramStatusTurn();
    h.detector.feed('❯ DONE'); h.detector.fireIdle(); await vi.advanceTimersByTimeAsync(14_999); expect(h.idle).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_001); expect(h.idle).toHaveBeenCalledExactlyOnceWith('screen');
    expect(h.mode).toHaveBeenLastCalledWith('screen', expect.stringContaining('submission'));
  });
  it('recovers evicted busy IDs when they finish or their subtree clears', () => {
    const h = fixture();
    for (let i = 0; i < 257; i++) h.status('working', `tool/${i}`);
    h.status('done'); expect(h.idle).not.toHaveBeenCalled();
    h.status('done', 'tool/0'); h.status('clear', 'tool'); expect(h.idle).toHaveBeenCalledOnce();
  });
  it('keeps conservative busy evidence when its bounded child table overflows', () => {
    const h = fixture(); h.status('working', 'old');
    for (let i = 0; i < 256; i++) h.status('done', `child/${i}`);
    h.status('done'); expect(h.idle).not.toHaveBeenCalled();
    h.status('done', 'old'); expect(h.idle).toHaveBeenCalledOnce();
  });
});
