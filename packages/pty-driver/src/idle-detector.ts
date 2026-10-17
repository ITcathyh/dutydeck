// Adapted from botmux (https://github.com/deepcoldy/botmux), MIT License, Copyright (c) 2026 botmux contributors
import type { ProgramStatusEvent } from '@dutydeck/session-backends';

/**
 * Idle detection state machine.
 * Third-party attribution: see THIRD_PARTY_NOTICES.md.
 *
 * The detector takes a plain IdlePatterns bag so pty-driver internals do not
 * reverse-depend on cli-adapters types.
 *
 * Strategy logic and boundary policies:
 *   - Strategy 1: CLI completion marker → 500ms delayed idle
 *   - Strategy 2: quiescence (2000ms PTY silence) + spinner guard (3000ms)
 *   - readyPattern gating (quiescence suppressed until the prompt renders)
 *   - static-busy latch (capacity-queue screens) with stale-tail position
 *     tracking
 *   - idleToBusy edge arming (at most one busy emit per idle cycle)
 *   - ANSI stripping, 500-char rolling tail, lastMatchIndex helper
 */

export type IdleEvidenceSource = 'screen' | 'external' | 'program-status';

/** Pattern bag driving the detector; every field is optional. */
export interface IdlePatterns {
  completionPattern?: RegExp;
  idleToBusyPattern?: RegExp;
  staticBusyPattern?: RegExp;
  staticBusyClearPattern?: RegExp;
  readyPattern?: RegExp;
}

/** Spinner frames — animate while CLI is working.
 *  Includes Claude Code symbols, Ink dots braille chars (Gemini),
 *  and OpenCode progress bar chars (■⬝). */
const SPINNER_RE = /[·✢✳✶✻✽⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏■⬝]/;

/** Default quiescence timeout (ms) — idle if PTY silent + no recent spinner */
const QUIESCENCE_MS = 2_000;
/** Spinner guard — don't declare idle if spinner seen within this window */
const SPINNER_GUARD_MS = 3_000;

export class IdleDetector {
  private programStatusEnabled = false;
  private programStatusAuthority = false;
  private programStatusPending = false;
  private readonly programStatusRecords = new Map<string, ProgramStatusEvent>();
  private readonly programStatusEvictedBusy = new Set<string>();
  private programStatusTimer: ReturnType<typeof setTimeout> | undefined;
  private programStatusLog?: (mode: 'osc7501' | 'screen', reason: string) => void;

  enableProgramStatus(log: (mode: 'osc7501' | 'screen', reason: string) => void): void {
    this.programStatusEnabled = true;
    this.programStatusLog = log;
    log('screen', 'waiting for OSC 7501 negotiation');
    this.waitForProgramStatus('no startup status within 15000ms (handshake unavailable)');
  }

  /** No heartbeat is promised. Only a host submission expects a new edge. */
  beginProgramStatusTurn(): void {
    if (!this.programStatusEnabled) return;
    this.programStatusRecords.clear();
    this.programStatusEvictedBusy.clear();
    this.programStatusPending = this.programStatusAuthority;
    this.waitForProgramStatus('no status after submission within 15000ms');
  }

  private waitForProgramStatus(reason: string): void {
    if (this.programStatusTimer) clearTimeout(this.programStatusTimer);
    this.programStatusTimer = setTimeout(() => this.fallbackProgramStatus(reason), 15_000);
    this.programStatusTimer.unref();
  }

  fallbackProgramStatus(reason: string): void {
    if (!this.programStatusEnabled) return;
    // A fallback retires only current evidence; a later valid frame may recover.
    this.programStatusAuthority = false;
    this.programStatusPending = false;
    this.programStatusRecords.clear();
    this.programStatusEvictedBusy.clear();
    if (this.programStatusTimer) clearTimeout(this.programStatusTimer);
    this.programStatusTimer = undefined;
    this.programStatusLog?.('screen', reason);
    // Reuse the accumulated prompt/spinner evidence; no new PTY byte is needed.
    if (!this.isIdle && (!this.readyPattern || this.readySeen)) {
      this.clearTimer();
      this.quiescenceTimer = setTimeout(() => this.quiescenceCheck(), QUIESCENCE_MS);
    }
  }

  observeProgramStatus(event: ProgramStatusEvent): void {
    if (!this.programStatusEnabled || event.app !== 'claude-code') return;
    if (event.id !== undefined && (!event.id || event.id.length > 256 || /[\x00-\x20\x7f]/.test(event.id))) return;
    if (this.programStatusTimer) clearTimeout(this.programStatusTimer);
    this.programStatusTimer = undefined;
    if (event.state === 'clear' && event.id === undefined) {
      this.fallbackProgramStatus('CLI cleared program status');
      return;
    }
    if (!this.programStatusAuthority) this.programStatusLog?.('osc7501', 'received valid program status');
    this.programStatusAuthority = true;
    this.programStatusPending = false;
    const id = event.id ?? '';
    if (event.state === 'clear') {
      for (const key of this.programStatusRecords.keys()) {
        if (key === id || key.startsWith(id + '/')) this.programStatusRecords.delete(key);
      }
      for (const key of this.programStatusEvictedBusy) {
        if (key === id || key.startsWith(id + '/')) this.programStatusEvictedBusy.delete(key);
      }
    } else {
      this.programStatusEvictedBusy.delete(id);
      if (!this.programStatusRecords.has(id) && this.programStatusRecords.size >= 256) {
        const children = [...this.programStatusRecords.keys()].filter(key => key !== '');
        const oldest = children.find(key => !['working', 'blocked'].includes(this.programStatusRecords.get(key)!.state)) ?? children[0];
        if (oldest !== undefined) {
          const prior = this.programStatusRecords.get(oldest)!;
          if (prior.state === 'working' || prior.state === 'blocked') this.programStatusEvictedBusy.add(oldest);
          this.programStatusRecords.delete(oldest);
        }
      }
      this.programStatusRecords.set(id, event);
    }
    if (this.programStatusRecords.size === 0 && this.programStatusEvictedBusy.size === 0) {
      this.fallbackProgramStatus('CLI cleared all program status records');
      return;
    }
    this.clearTimer();
    this.isIdle = false;
    this.busyTransitionArmed = false;
    if (this.programStatusTerminal()) this.fireIdle();
  }

  programStatusActive(): boolean { return this.programStatusAuthority; }

  programStatusTerminal(): boolean {
    if (!this.programStatusAuthority || this.programStatusPending || this.programStatusEvictedBusy.size > 0) return false;
    for (const rec of this.programStatusRecords.values()) {
      if (rec.state === 'working' || rec.state === 'blocked') return false;
    }
    const root = this.programStatusRecords.get('');
    return !!root && ['done', 'idle', 'error'].includes(root.state);
  }

  programStatusBlock(): ProgramStatusEvent | undefined {
    let blocked: ProgramStatusEvent | undefined;
    for (const record of this.programStatusRecords.values()) {
      if (record.state === 'blocked') blocked = record;
    }
    return this.programStatusAuthority ? blocked : undefined;
  }

  programStatusError(): string | undefined {
    const root = this.programStatusRecords.get('');
    return this.programStatusAuthority && root?.state === 'error' ? root.msg ?? 'CLI reported an error' : undefined;
  }

  /** Also used after asynchronous transcript flushes to recheck fresh busy edges. */
  programStatusAllowsIdle(): boolean {
    return !this.programStatusAuthority || this.programStatusTerminal();
  }

  private outputTail = '';
  private lastSpinnerAt = 0;
  private quiescenceTimer: ReturnType<typeof setTimeout> | null = null;
  private isIdle = false;
  private idleCallback: ((source: IdleEvidenceSource) => void) | null = null;
  private busyCallback: (() => void) | null = null;
  private completionPattern: RegExp | undefined;
  private idleToBusyPattern: RegExp | undefined;
  private staticBusyPattern: RegExp | undefined;
  private staticBusyClearPattern: RegExp | undefined;
  private busyTransitionArmed = false;
  private readyPattern: RegExp | undefined;
  private readySeen = false;
  /** Pre-idle latch for static busy screens (capacity queue). Set from PTY
   *  chunks carrying explicit static-busy evidence (scanned across chunks
   *  via the rolling tail); suppresses screen-derived idle until a chunk
   *  with explicit composer evidence (staticBusyClearPattern) redraws. */
  private staticBusyLatch = false;
  /** Tail position of the last composer clear evidence. Queue evidence in
   *  the tail at or before this position is stale (from before the clear)
   *  and must not re-set the latch. -1 = no clear recorded. */
  private staticBusyClearTailPos = -1;

  constructor(patterns: IdlePatterns) {
    this.completionPattern = patterns.completionPattern;
    this.idleToBusyPattern = patterns.idleToBusyPattern;
    this.staticBusyPattern = patterns.staticBusyPattern;
    this.staticBusyClearPattern = patterns.staticBusyClearPattern;
    this.readyPattern = patterns.readyPattern;
  }

  onIdle(cb: (source: IdleEvidenceSource) => void): void {
    this.idleCallback = cb;
  }

  onBusy(cb: () => void): void {
    this.busyCallback = cb;
  }

  /**
   * Seed readyPattern evidence for a prompt that IS on screen but was rendered
   * before resetReadyEvidence() cleared the flag. A new session (SessionStart
   * source=startup) never redraws after that boundary, so Strategy 2's
   * `!readySeen` early return would suppress quiescence detection forever.
   *
   * The caller must first confirm the PTY is quiet AND the current rendered
   * screen matches readyPattern. This only restores readySeen — a full
   * quiescence check (spinner guard included) still runs on top of it, so no
   * existing check is bypassed.
   */
  seedReadyEvidence(): boolean {
    if (this.isIdle || this.readySeen) return false;
    this.readySeen = true;
    this.clearTimer();
    this.quiescenceCheck();
    return true;
  }

  feed(data: string): void {
    // A programmatic submit calls reset() before writing input, but adopted
    // panes can also receive local terminal input while we are already idle.
    // Treat any later PTY data as a fresh cycle so that local work can become
    // idle and flush transcript-driven fallback output.
    if (this.isIdle) {
      this.isIdle = false;
      this.outputTail = '';
      this.readySeen = false;
      this.staticBusyClearTailPos = -1;
      this.lastSpinnerAt = Date.now();
    }

    const stripped = this.stripAnsi(data);
    // Shift the clear position left when the tail window drops characters
    // from the head, so it stays relative to the current window.
    const combined = this.outputTail + stripped;
    const dropped = Math.max(0, combined.length - 500);
    this.outputTail = combined.slice(-500);
    if (this.staticBusyClearTailPos >= 0) {
      this.staticBusyClearTailPos = Math.max(-1, this.staticBusyClearTailPos - dropped);
    }

    // Only an explicitly opted-in CLI marker may turn a previously reported
    // idle cycle back into busy. Plain PTY activity — and legacy busyPattern
    // matches — can be a transcript redraw, so they are insufficient evidence.
    // Keep the edge armed across chunks, then emit at most once per cycle.
    if (
      this.busyTransitionArmed
      && this.idleToBusyPattern
      && (
        this.idleToBusyPattern.test(stripped)
        || this.idleToBusyPattern.test(this.outputTail)
      )
    ) {
      this.busyTransitionArmed = false;
      this.busyCallback?.();
    }

    // Track when the CLI's input prompt appears.
    // Check the current chunk too — a single chunk can contain the prompt
    // AND a full status-bar redraw (hundreds of chars), pushing the prompt
    // out of the 500-char outputTail before the check runs.
    const readyMatched = this.readyPattern && (
      this.readyPattern.test(stripped) || this.readyPattern.test(this.outputTail)
    );
    if (readyMatched) {
      this.readySeen = true;
    }

    // Pre-idle static-busy latch (capacity-queue screens).
    // SET: scan both the current chunk AND the rolling tail — the queue
    //  marker can be split across chunks ("Queued for cap" + "acity"), and
    //  the tail already holds the full text by the time the second chunk
    //  arrives (consistent with idleToBusy/completionPattern split-chunk
    //  handling).
    // CLEAR: explicit composer evidence (staticBusyClearPattern) in the
    //  CURRENT chunk. The broad readyPattern includes `\d+% left` (status
    //  bar), which the queue screen itself carries — using it to clear
    //  would re-open the false-idle bug when queue and status bar arrive
    //  in separate chunks.
    // ORDER: within a single chunk, whichever evidence appears LAST wins —
    //  a submitted user message (`› text`) followed by a fresh queue line
    //  must NOT clear the latch (the queue is fresher), while a queue line
    //  followed by a real composer redraw must clear it.
    // STALE-TAIL: after a clear, queue text lingering in the tail must not
    //  re-set the latch. Record the clear position in the tail; only queue
    //  evidence AFTER that position is fresh enough to set.
    if (this.staticBusyPattern) {
      const clearIdx = this.staticBusyClearPattern
        ? lastMatchIndex(this.staticBusyClearPattern, stripped)
        : -1;
      const staticChunkIdx = lastMatchIndex(this.staticBusyPattern, stripped);
      const staticTailIdx = lastMatchIndex(this.staticBusyPattern, this.outputTail);
      if (clearIdx >= 0 && clearIdx > staticChunkIdx) {
        this.staticBusyLatch = false;
        // Record where the clear landed in the tail so stale queue text
        // before it doesn't re-set the latch on the next chunk.
        const chunkStart = this.outputTail.length - stripped.length;
        this.staticBusyClearTailPos = chunkStart >= 0
          ? chunkStart + clearIdx
          : this.outputTail.length;
      } else if (staticTailIdx >= 0 && staticTailIdx > this.staticBusyClearTailPos) {
        this.staticBusyLatch = true;
      }
    }

    // Track spinner — but not if it's part of completion marker,
    // and not after ready pattern is seen (status bar chars like · are not real spinners)
    if (SPINNER_RE.test(stripped) && !(this.completionPattern?.test(stripped) || this.completionPattern?.test(this.outputTail)) && !this.readySeen) {
      this.lastSpinnerAt = Date.now();
    }

    if (this.programStatusAuthority) { this.clearTimer(); return; }

    // Strategy 1: CLI-specific completion marker
    // Check the current chunk too: a single full-screen redraw can contain
    // the completion line and enough trailing status text to push it out of
    // the 500-char tail before this check runs.
    if (this.completionPattern?.test(stripped) || this.completionPattern?.test(this.outputTail)) {
      this.clearTimer();
      this.quiescenceTimer = setTimeout(() => {
        this.quiescenceTimer = null;
        // A static-busy latch outranks a completion marker: the queue screen
        // can carry both, and the latch only clears on a composer redraw.
        if (!this.isIdle && !this.staticBusyLatch) this.markIdle('screen');
      }, 500);
      return;
    }

    // Strategy 2: quiescence (PTY silence + no recent spinner)
    // When readyPattern is set, suppress quiescence until the input prompt appears.
    if (this.readyPattern && !this.readySeen) return;

    this.clearTimer();
    this.quiescenceTimer = setTimeout(() => this.quiescenceCheck(), QUIESCENCE_MS);
  }

  reset(): void {
    this.isIdle = false;
    this.busyTransitionArmed = false;
    this.outputTail = '';
    this.readySeen = false;
    this.staticBusyLatch = false;
    this.staticBusyClearTailPos = -1;
    this.lastSpinnerAt = Date.now();
    this.clearTimer();
  }

  /**
   * Drop prompt evidence observed before a SessionStart boundary. Unlike the
   * ordinary per-turn reset, this does not synthesize a recent spinner: once
   * Claude finishes the remaining parallel hooks, its newly rendered prompt
   * should need only the normal quiescence window.
   */
  resetReadyEvidence(): void {
    this.isIdle = false;
    this.busyTransitionArmed = false;
    this.outputTail = '';
    this.readySeen = false;
    this.staticBusyLatch = false;
    this.staticBusyClearTailPos = -1;
    this.lastSpinnerAt = 0;
    this.clearTimer();
  }

  /** External idle source — lets transcript-driven detectors (Claude jsonl
   *  Stop, Codex rollout assistant_final, CoCo events.jsonl finish_reason
   *  stop) push idle without waiting for screen-pattern + quiescence to
   *  agree. Idempotent within a turn (gated by isIdle); reset() re-arms it
   *  for the next turn — same lifecycle as the internal markIdle path. */
  fireIdle(): void {
    if (this.isIdle || !this.programStatusAllowsIdle()) return;
    this.markIdle(this.programStatusAuthority ? 'program-status' : 'external');
  }

  dispose(): void {
    if (this.programStatusTimer) clearTimeout(this.programStatusTimer);
    this.programStatusTimer = undefined;
    this.clearTimer();
    this.idleCallback = null;
    this.busyCallback = null;
    this.busyTransitionArmed = false;
    this.staticBusyLatch = false;
    this.staticBusyClearTailPos = -1;
  }

  private quiescenceCheck(): void {
    this.quiescenceTimer = null;
    if (this.isIdle) return;
    // Explicit static-busy evidence (capacity queue): the screen is not
    // quiescing into a prompt — it is parked on a queue notice. Do not mark
    // idle and do not re-arm: the latch clears on the composer redraw, whose
    // feed() re-arms quiescence.
    if (this.staticBusyLatch) return;
    const sinceSpinner = Date.now() - this.lastSpinnerAt;
    if (sinceSpinner < SPINNER_GUARD_MS) {
      this.quiescenceTimer = setTimeout(
        () => this.quiescenceCheck(),
        SPINNER_GUARD_MS - sinceSpinner + 200,
      );
      return;
    }
    this.markIdle('screen');
  }

  private markIdle(source: IdleEvidenceSource): void {
    if (this.programStatusAuthority && (source !== 'program-status' || !this.programStatusTerminal())) return;
    this.isIdle = true;
    // Arm before the callback: markPromptReady may synchronously flush queued
    // input and call reset(), which must win and disarm this edge.
    this.busyTransitionArmed = true;
    this.outputTail = '';
    this.clearTimer();
    this.idleCallback?.(source);
  }

  private clearTimer(): void {
    if (this.quiescenceTimer) {
      clearTimeout(this.quiescenceTimer);
      this.quiescenceTimer = null;
    }
  }

  private stripAnsi(str: string): string {
    return str
      .replace(/\x1b\[(\d*)C/g, (_m, n) => ' '.repeat(Number(n) || 1))
      .replace(/\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-B]|\x1b\[[\?]?[0-9;]*[hlmsuJ]/g, '');
  }
}

/** Find the LAST match index of a regex in a string, or -1. Handles
 *  non-global regexes by cloning with the g flag. */
function lastMatchIndex(re: RegExp, s: string): number {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  let last = -1;
  let m: RegExpExecArray | null;
  while ((m = g.exec(s)) !== null) {
    last = m.index;
    if (g.lastIndex === m.index) g.lastIndex++;
  }
  return last;
}
