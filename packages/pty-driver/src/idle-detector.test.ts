/**
 * Unit tests for IdleDetector (dutydeck port of botmux's idle-detector).
 *
 * Run: pnpm vitest run packages/pty-driver/src/idle-detector.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IdleDetector, type IdlePatterns } from './idle-detector.js';

function makePatterns(opts: IdlePatterns = {}): IdlePatterns {
  return { ...opts };
}

describe('IdleDetector: completion marker strategy', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('fires onIdle("screen") 500ms after a completion pattern match', () => {
    const detector = new IdleDetector(makePatterns({ completionPattern: /\$ $/ }));
    const cb = vi.fn();
    detector.onIdle(cb);

    detector.feed('command output\n$ ');
    expect(cb).not.toHaveBeenCalled();
    vi.advanceTimersByTime(499);
    expect(cb).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith('screen');
    detector.dispose();
  });

  it('matches a completion marker split across chunks via the rolling tail', () => {
    const detector = new IdleDetector(makePatterns({ completionPattern: /DONE>$/ }));
    const cb = vi.fn();
    detector.onIdle(cb);

    detector.feed('DON');
    vi.advanceTimersByTime(100);
    detector.feed('E>');
    vi.advanceTimersByTime(500);
    expect(cb).toHaveBeenCalledTimes(1);
    detector.dispose();
  });

  it('matches a completion marker in the current chunk even when pushed out of the tail', () => {
    const detector = new IdleDetector(makePatterns({ completionPattern: /COMPLETE/ }));
    const cb = vi.fn();
    detector.onIdle(cb);

    detector.feed('COMPLETE' + 'x'.repeat(600));
    vi.advanceTimersByTime(500);
    expect(cb).toHaveBeenCalledTimes(1);
    detector.dispose();
  });

  it('strips ANSI sequences before pattern matching', () => {
    const detector = new IdleDetector(makePatterns({ completionPattern: /DONE$/ }));
    const cb = vi.fn();
    detector.onIdle(cb);

    detector.feed('\x1b[32mDONE\x1b[0m');
    vi.advanceTimersByTime(500);
    expect(cb).toHaveBeenCalledTimes(1);
    detector.dispose();
  });

  it('converts CSI cursor-forward to spaces', () => {
    const detector = new IdleDetector(makePatterns({ completionPattern: /A {3}B$/ }));
    const cb = vi.fn();
    detector.onIdle(cb);

    detector.feed('A\x1b[3CB');
    vi.advanceTimersByTime(500);
    expect(cb).toHaveBeenCalledTimes(1);
    detector.dispose();
  });
});

describe('IdleDetector: quiescence strategy', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('fires idle after 2000ms of PTY silence when no spinner was seen', () => {
    const detector = new IdleDetector(makePatterns());
    const cb = vi.fn();
    detector.onIdle(cb);

    detector.feed('hello world');
    vi.advanceTimersByTime(2000);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith('screen');
    detector.dispose();
  });

  it('defers quiescence while a spinner was seen within the 3000ms guard window', () => {
    const detector = new IdleDetector(makePatterns());
    const cb = vi.fn();
    detector.onIdle(cb);

    detector.feed('loading ⠋');
    vi.advanceTimersByTime(2000);
    expect(cb).not.toHaveBeenCalled();

    // Spinner guard (3000ms) + 200ms slack.
    vi.advanceTimersByTime(3500);
    expect(cb).toHaveBeenCalledTimes(1);
    detector.dispose();
  });

  it('resets the quiescence timer on every new feed', () => {
    const detector = new IdleDetector(makePatterns());
    const cb = vi.fn();
    detector.onIdle(cb);

    detector.feed('output 1');
    vi.advanceTimersByTime(1500);
    expect(cb).not.toHaveBeenCalled();

    detector.feed('output 2');
    vi.advanceTimersByTime(1500);
    expect(cb).not.toHaveBeenCalled();

    vi.advanceTimersByTime(500);
    expect(cb).toHaveBeenCalledTimes(1);
    detector.dispose();
  });

  it('suppresses quiescence until readyPattern appears', () => {
    const detector = new IdleDetector(makePatterns({ readyPattern: /READY>/ }));
    const cb = vi.fn();
    detector.onIdle(cb);

    detector.feed('still loading...');
    vi.advanceTimersByTime(10_000);
    expect(cb).not.toHaveBeenCalled();

    detector.feed('READY>');
    vi.advanceTimersByTime(2000);
    expect(cb).toHaveBeenCalledTimes(1);
    detector.dispose();
  });

  it('does not treat status-bar spinner chars as spinners after readyPattern was seen', () => {
    const detector = new IdleDetector(makePatterns({ readyPattern: /READY>/ }));
    const cb = vi.fn();
    detector.onIdle(cb);

    detector.feed('READY>');
    vi.advanceTimersByTime(100);
    detector.feed('·'); // middle dot — status bar decoration, not a spinner
    vi.advanceTimersByTime(2000);
    expect(cb).toHaveBeenCalledTimes(1);
    detector.dispose();
  });
});

describe('IdleDetector: static-busy latch (capacity queue)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const patterns: IdlePatterns = {
    staticBusyPattern: /QUEUED/i,
    staticBusyClearPattern: /PROMPT>/,
    readyPattern: /PROMPT>/,
  };

  it('suppresses a completion-marker idle while latched, then recovers on the clear pattern', () => {
    const detector = new IdleDetector(makePatterns({
      ...patterns,
      completionPattern: /DONE$/,
    }));
    const cb = vi.fn();
    detector.onIdle(cb);

    // Queue evidence + completion marker in the same stream: latch wins.
    detector.feed('QUEUED for capacity\nDONE');
    vi.advanceTimersByTime(10_000);
    expect(cb).not.toHaveBeenCalled();

    // Composer redraw clears the latch; quiescence now fires.
    detector.feed('PROMPT> ');
    vi.advanceTimersByTime(5_500);
    expect(cb).toHaveBeenCalledTimes(1);
    detector.dispose();
  });

  it('does not re-latch from stale queue text lingering in the rolling tail after a clear', () => {
    const detector = new IdleDetector(makePatterns(patterns));
    const cb = vi.fn();
    detector.onIdle(cb);

    detector.feed('QUEUED for capacity');
    vi.advanceTimersByTime(5_000);
    expect(cb).not.toHaveBeenCalled();

    // Composer clears the latch; do NOT advance timers — stale tail present.
    detector.feed('PROMPT>');
    // A noise chunk must not re-set the latch from the stale tail.
    detector.feed('status bar redraw');
    vi.advanceTimersByTime(5_000);
    expect(cb).toHaveBeenCalledTimes(1);
    detector.dispose();
  });

  it('detects a queue marker split across chunks via the rolling tail', () => {
    const detector = new IdleDetector(makePatterns(patterns));
    const cb = vi.fn();
    detector.onIdle(cb);

    detector.feed('QUE');
    detector.feed('UED for capacity');
    vi.advanceTimersByTime(10_000);
    expect(cb).not.toHaveBeenCalled();

    detector.feed('PROMPT> ');
    vi.advanceTimersByTime(5_500);
    expect(cb).toHaveBeenCalledTimes(1);
    detector.dispose();
  });

  it('lets external fireIdle through while latched', () => {
    const detector = new IdleDetector(makePatterns(patterns));
    const cb = vi.fn();
    detector.onIdle(cb);

    detector.feed('QUEUED for capacity');
    vi.advanceTimersByTime(10_000);
    expect(cb).not.toHaveBeenCalled();

    detector.fireIdle();
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith('external');
    detector.dispose();
  });
});

describe('IdleDetector: idleToBusy edge', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('fires onBusy at most once per idle cycle when the busy marker renders', () => {
    const idleToBusyPattern = /Working[^\r\n]{0,160}esc to interrupt/i;
    const detector = new IdleDetector(makePatterns({ idleToBusyPattern }));
    const cb = vi.fn();
    detector.onBusy(cb);

    detector.fireIdle();
    detector.feed('\x1b[2K› Ask anything');
    expect(cb).not.toHaveBeenCalled();

    detector.feed('\x1b[2K• Working (3s • esc to interrupt)');
    detector.feed('• Working (4s • esc to interrupt)');
    expect(cb).toHaveBeenCalledTimes(1);

    // Re-arms after the next idle.
    detector.fireIdle();
    detector.feed('• Working (1s • esc to interrupt)');
    expect(cb).toHaveBeenCalledTimes(2);
    detector.dispose();
  });
});

describe('IdleDetector: fireIdle / reset lifecycle', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('fireIdle fires synchronously, is idempotent, and re-arms after reset()', () => {
    const detector = new IdleDetector(makePatterns());
    const cb = vi.fn();
    detector.onIdle(cb);

    detector.fireIdle();
    detector.fireIdle();
    detector.fireIdle();
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith('external');

    detector.reset();
    detector.fireIdle();
    expect(cb).toHaveBeenCalledTimes(2);
    detector.dispose();
  });

  it('fireIdle bypasses a readyPattern that never appears', () => {
    const detector = new IdleDetector(makePatterns({ readyPattern: /THIS_NEVER_APPEARS/ }));
    const cb = vi.fn();
    detector.onIdle(cb);

    detector.feed('lots of output without the magic ready token');
    vi.advanceTimersByTime(10_000);
    expect(cb).toHaveBeenCalledTimes(0);

    detector.fireIdle();
    expect(cb).toHaveBeenCalledTimes(1);
    detector.dispose();
  });

  it('reset() clears the tail so a split marker cannot complete across it', () => {
    const detector = new IdleDetector(makePatterns({ completionPattern: /DONE$/ }));
    const cb = vi.fn();
    detector.onIdle(cb);

    detector.feed('DON');
    detector.reset();
    detector.feed('E');
    vi.advanceTimersByTime(500);
    expect(cb).not.toHaveBeenCalled();

    // Quiescence still works (reset synthesizes a recent spinner → full guard).
    vi.advanceTimersByTime(5_000);
    expect(cb).toHaveBeenCalledTimes(1);
    detector.dispose();
  });

  it('starts a fresh detection cycle when PTY data arrives after idle', () => {
    const detector = new IdleDetector(makePatterns({ completionPattern: /DONE$/ }));
    const cb = vi.fn();
    detector.onIdle(cb);

    detector.feed('DONE');
    vi.advanceTimersByTime(500);
    expect(cb).toHaveBeenCalledTimes(1);

    detector.feed('more data DONE');
    vi.advanceTimersByTime(500);
    expect(cb).toHaveBeenCalledTimes(2);
    detector.dispose();
  });
});

describe('IdleDetector: dispose()', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('clears pending timers and nulls callbacks', () => {
    const detector = new IdleDetector(makePatterns({ completionPattern: /DONE$/ }));
    const cb = vi.fn();
    detector.onIdle(cb);

    detector.feed('DONE');
    detector.dispose();

    vi.advanceTimersByTime(10_000);
    expect(cb).not.toHaveBeenCalled();

    // Even a manual reset+feed after dispose stays quiet.
    detector.reset();
    detector.feed('DONE');
    vi.advanceTimersByTime(10_000);
    expect(cb).not.toHaveBeenCalled();
  });
});
