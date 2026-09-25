import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCliAdapter, pinnedSessionUuid } from '@dutydeck/cli-adapters';
import type { NormalizedDriverEvent } from '@dutydeck/shared';
import type { SessionBackend } from '@dutydeck/session-backends';
import { PtyCliDriver } from './driver.js';

// Captured from Claude Code 2.1.280 in a 120x30 tmux pane, pointed at a local
// stand-in for the Messages API: turn 1 is a plain answer, turn 2 launches one
// background Agent that reports after 40s. The screens (after turn 1, while
// waiting, after the follow-up) are verbatim capture-pane output;
// transcript.jsonl holds that session's user, assistant, queue-operation and
// turn_duration records verbatim (attachments omitted).
const fixture = (name: string) => readFileSync(new URL(`./fixtures/claude-background-agent/${name}`, import.meta.url), 'utf8');
const turnOneScreen = fixture('turn1-screen.txt');
const waitingScreen = fixture('waiting-screen.txt');
const finalScreen = fixture('final-screen.txt');
const records = fixture('transcript.jsonl').trimEnd().split('\n');
const pendingRecord = records.findIndex(line => JSON.parse(line).pendingBackgroundAgentCount === 1);
const turnOne = records.slice(0, 3);
const dispatch = records.slice(3, pendingRecord + 1);
const followUp = records.slice(pendingRecord + 1);
const repaint = (text: string) => `\x1b[2J\x1b[H${text.replaceAll('\n', '\r\n')}`;
// The agent panel redraws only its elapsed-seconds cell, once per second.
const panelTick = (second: number) => `\x1b[H\r\x1b[116C\x1b[29B\x1b[38;5;246m${second % 10}\x1b[39m\x1b[30;1H\x1b[25;3H`;
const HOLD_MS = 60 * 60_000;

describe('PTY completion while Claude background agents are still running', () => {
  let directory: string;
  let driver: PtyCliDriver;
  let output: (data: string) => void;
  let events: NormalizedDriverEvent[];
  let transcript: string;
  let submitted: boolean;
  let submittedOutputAt: number | undefined;
  let submittedProcessKey: object | undefined;

  beforeEach(async () => {
    vi.useFakeTimers();
    directory = mkdtempSync(join(tmpdir(), 'dutydeck-background-'));
    const project = join(directory, 'projects', realpathSync(directory).replace(/[^A-Za-z0-9-]/g, '-'));
    mkdirSync(project, { recursive: true });
    transcript = join(project, `${pinnedSessionUuid('ses_background-fixture')}.jsonl`);
    // Turn 1 already happened; the tailer starts at the end of existing history.
    writeFileSync(transcript, turnOne.map(line => `${line}\n`).join(''));
    events = [];
    submitted = false;
    submittedOutputAt = undefined;
    submittedProcessKey = undefined;
    const backend: SessionBackend = {
      kind: 'pty', spawn() {}, write() {}, resize() {}, kill() {}, onExit() {},
      onData(callback) { output = callback; },
      interrupt() { output(repaint('Interrupted · What should Claude do instead?\n❯\n  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents')); },
    };
    driver = new PtyCliDriver({
      agent: { id: 'claude-code', name: 'Claude', command: 'unused', args: [], protocol: 'pty-cli', cwd: directory,
        env: { CLAUDE_CONFIG_DIR: directory }, permissionMode: 'full-trust', timeout: 60,
        capabilities: { pause: false, resume: true }, builtin: false },
      adapter: {
        ...createCliAdapter('claude-code'),
        writeInput(target) {
          submitted = true;
          submittedOutputAt = target.lastOutputAt?.();
          submittedProcessKey = target.processKey;
        },
      },
      backend, sessionId: 'ses_background-fixture', onEvent: event => events.push(event), onExit() {},
    });
    await driver.start();
    output(repaint(turnOneScreen));
    await vi.advanceTimersByTimeAsync(250);
  });

  afterEach(async () => {
    await driver?.stop();
    vi.useRealTimers();
    rmSync(directory, { recursive: true, force: true });
  });

  const append = (lines: string[]) => appendFileSync(transcript, lines.map(line => `${line}\n`).join(''));
  const completed = () => events.filter(event => event.type === 'completed');
  const send = async () => {
    let settled = false;
    const pending = driver.send('LAUNCH_BG please start the background check').then(() => { settled = true; });
    for (let attempt = 0; attempt < 10 && !submitted; attempt++) await Promise.resolve();
    expect(submitted).toBe(true);
    return { pending, settled: () => settled };
  };
  const tick = async (seconds: number) => {
    for (let second = 0; second < seconds; second++) {
      output(panelTick(second));
      await vi.advanceTimersByTimeAsync(1_000);
    }
  };

  it('keeps the turn open until the follow-up turn that carries the background result ends', async () => {
    const turn = await send();
    append(dispatch);
    output(repaint(waitingScreen));
    await tick(30);
    // The panel can also stop redrawing; repeated idle checks still hold.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(turn.settled()).toBe(false);
    expect(completed()).toHaveLength(0);

    append(followUp);
    output(repaint(finalScreen));
    await vi.advanceTimersByTimeAsync(600);
    await turn.pending;
    expect(completed()).toEqual([{ type: 'completed', data: { stopReason: 'end_turn' } }]);
    const result = events.findIndex(event => event.type === 'text' && event.data.text === 'FINAL: background result merged.');
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThan(events.findIndex(event => event.type === 'completed'));
  });

  it('holds on the transcript record alone when no waiting line is rendered', async () => {
    const turn = await send();
    append(dispatch);
    // With turn durations hidden, only turn 1's completion line is on screen.
    output(repaint(waitingScreen.split('\n').filter(line => !line.includes('Waiting for')).join('\n')));
    await tick(30);
    expect(completed()).toHaveLength(0);

    append(followUp);
    output(repaint(finalScreen));
    await vi.advanceTimersByTimeAsync(600);
    await turn.pending;
    expect(completed()).toHaveLength(1);
  });

  it('holds on the rendered waiting line alone when the transcript has no record', async () => {
    const turn = await send();
    append(dispatch.slice(0, -1));
    output(repaint(waitingScreen));
    await tick(30);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(completed()).toHaveLength(0);

    append(followUp);
    output(repaint(finalScreen));
    await vi.advanceTimersByTimeAsync(600);
    await turn.pending;
    expect(completed()).toHaveLength(1);
  });

  it('stops waiting once the hold limit passes', async () => {
    const turn = await send();
    append(dispatch);
    output(repaint(waitingScreen));
    await tick(5);
    // No output arrives meanwhile, so the synchronous clock is enough and far faster.
    vi.advanceTimersByTime(HOLD_MS - 10_000);
    expect(completed()).toHaveLength(0);
    // The limit counts from the first vetoed idle, a few seconds after the repaint.
    await vi.advanceTimersByTimeAsync(20_000);
    await turn.pending;
    expect(completed()).toEqual([{ type: 'completed', data: { stopReason: 'end_turn' } }]);
  });

  it('does not hold an interrupted turn', async () => {
    const turn = await send();
    append(dispatch);
    output(repaint(waitingScreen));
    await tick(5);
    await driver.interrupt();
    await vi.advanceTimersByTimeAsync(4_000);
    await turn.pending;
    expect(completed()).toEqual([{ type: 'completed', data: { stopReason: 'cancelled' } }]);
  });

  it('gives the adapter the time of the latest PTY output', async () => {
    const renderedAt = Date.now();
    output('\x1b[25;3H');
    const turn = await send();
    expect(submittedOutputAt).toBe(renderedAt);
    await driver.stop();
    await expect(turn.pending).rejects.toThrow('Driver stopped');
  });

  it('hands the adapter one process key across submissions', async () => {
    const first = await send();
    const processKey = submittedProcessKey;
    expect(processKey).toBeDefined();
    output(repaint(turnOneScreen));
    await vi.advanceTimersByTimeAsync(600);
    await first.pending;
    submitted = false;
    const second = await send();
    expect(submittedProcessKey).toBe(processKey);
    await driver.stop();
    await expect(second.pending).rejects.toThrow('Driver stopped');
  });
});
