// Turns Claude starts itself from a session scheduled task (CronCreate). The
// record shape is synthesised from field names a real Claude Code 2.1.318 cron
// fire wrote (no real content): a `system/scheduled_task_fire` record, then a
// meta `user` record with `turnOrigin: 'scheduled'`, then the turn's own
// assistant and `turn_duration` records chained by `parentUuid`.
import { afterEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_FOLLOWUP, isBackgroundFollowup, type NormalizedDriverEvent } from '@dutydeck/shared';
import { ClaudeTranscriptTailer } from './claude.js';

const sessionId = '00000000-0000-4000-8000-0000000000aa';
const at = () => new Date(Date.now() + 1_000).toISOString();
const base = (uuid: string, parentUuid: string | null) => ({ uuid, parentUuid, isSidechain: false, sessionId, timestamp: at() });
const human = (uuid: string, parentUuid: string | null, text: string) => ({ ...base(uuid, parentUuid), type: 'user', origin: { kind: 'human' }, promptSource: 'typed', turnOrigin: 'human', message: { role: 'user', content: text } });
const assistant = (uuid: string, parentUuid: string, text: string, id = uuid) => ({ ...base(uuid, parentUuid), type: 'assistant', message: { id, role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: 'private' }, { type: 'text', text }], usage: { input_tokens: 1, output_tokens: 1 } } });
const duration = (uuid: string, parentUuid: string) => ({ ...base(uuid, parentUuid), type: 'system', subtype: 'turn_duration', durationMs: 1, isMeta: false });
const cronTurn = (prefix: string, parentUuid: string) => [
  { type: 'queue-operation', operation: 'enqueue', sessionId, timestamp: at(), content: 'scheduled prompt' },
  { type: 'queue-operation', operation: 'dequeue', sessionId, timestamp: at() },
  { ...base(`${prefix}-fire`, parentUuid), type: 'system', subtype: 'scheduled_task_fire', isMeta: false, taskId: 'task0001', cron: '* * * * *', prompt: 'scheduled prompt', content: 'Running scheduled task' },
  { ...base(`${prefix}-user`, `${prefix}-fire`), type: 'user', isMeta: true, promptSource: 'system', wakeupSource: 'schedule_wakeup', scheduledTaskId: 'task0001', scheduledFireId: `${prefix}-fire`, turnOrigin: 'scheduled', queuePriority: 'later', message: { role: 'user', content: 'scheduled prompt' } },
  assistant(`${prefix}-answer`, `${prefix}-user`, 'SCHEDULED ANSWER'),
  duration(`${prefix}-done`, `${prefix}-answer`),
];

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'dd-claude-scheduled-')); dirs.push(dir);
  const file = join(dir, `${sessionId}.jsonl`); writeFileSync(file, '');
  const tailer = new ClaudeTranscriptTailer({ cwd: dir, transcriptPath: file, pollIntervalMs: 60_000 });
  const events: NormalizedDriverEvent[] = []; tailer.onEvent(event => events.push(event));
  tailer.start(); await tailer.flush();
  const write = async (records: unknown[]) => { appendFileSync(file, records.map(record => JSON.stringify(record)).join('\n') + '\n'); await tailer.flush(); };
  const texts = (from: number) => events.slice(from).filter(event => event.type === 'text' || event.type === 'thinking').map(event => [event.type, event.data.text, isBackgroundFollowup(event)]);
  return { tailer, events, write, texts };
}

describe('Claude scheduled-task turns', () => {
  it('after a completed turn: run-level follow-up, no new terminal for the old receipt', async () => {
    const { tailer, events, write, texts } = await setup();
    try {
      const receipt = tailer.waitForInput('first question', new AbortController().signal);
      await write([human('h1', null, 'first question'), assistant('a1', 'h1', 'FIRST ANSWER'), duration('d1', 'a1')]);
      await receipt;
      expect(tailer.hasTurnTerminal()).toBe(true);
      const revision = tailer.turnTerminalRevision(), before = events.length;
      await write(cronTurn('c1', 'd1'));
      expect(texts(before)).toEqual([['text', 'SCHEDULED ANSWER', true]]);
      const followup = events.slice(before).find(event => event.type === 'text')!;
      expect(followup.data.origin).toBe(BACKGROUND_FOLLOWUP);
      expect(followup.data.nativeTurnId).toBeUndefined();
      expect(tailer.turnTerminalRevision()).toBe(revision);
    } finally { tailer.stop(); }
  });

  it('while the next receipt waits: neither confirms nor joins it, and the human turn completes normally', async () => {
    const { tailer, events, write, texts } = await setup();
    try {
      const first = tailer.waitForInput('first question', new AbortController().signal);
      await write([human('h1', null, 'first question'), assistant('a1', 'h1', 'FIRST ANSWER'), duration('d1', 'a1')]);
      await first;
      let confirmed = false;
      const second = tailer.waitForInput('second question', new AbortController().signal).then(() => { confirmed = true; });
      const before = events.length;
      await write(cronTurn('c1', 'd1'));
      expect(confirmed).toBe(false);
      expect(tailer.hasTurnTerminal()).toBe(false);
      expect(texts(before)).toEqual([['text', 'SCHEDULED ANSWER', true]]);
      // Claude parents the queued human prompt on the scheduled turn's last record.
      const middle = events.length;
      await write([human('h2', 'c1-done', 'second question'), assistant('a2', 'h2', 'SECOND ANSWER')]);
      await second;
      expect(confirmed).toBe(true);
      expect(texts(middle)).toEqual([['thinking', 'private', false], ['text', 'SECOND ANSWER', false]]);
      expect(events.slice(middle).find(event => event.type === 'text')!.data.nativeTurnId).toBe('h2');
      await write([duration('d2', 'a2')]);
      expect(tailer.hasTurnTerminal()).toBe(true);
    } finally { tailer.stop(); }
  });

  it('interleaved with an active receipt: does not end it; its own terminal still does', async () => {
    const { tailer, events, write, texts } = await setup();
    try {
      const receipt = tailer.waitForInput('long question', new AbortController().signal);
      await write([human('h1', null, 'long question'), { ...assistant('a1', 'h1', 'working'), message: { id: 'a1', role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tool1', name: 'Bash', input: {} }] } }]);
      await receipt;
      const before = events.length;
      await write(cronTurn('c1', 'a1'));
      expect(tailer.hasTurnTerminal()).toBe(false);
      expect(texts(before)).toEqual([['text', 'SCHEDULED ANSWER', true]]);
      await write([assistant('a2', 'a1', 'LONG ANSWER'), duration('d2', 'a2')]);
      expect(tailer.hasTurnTerminal()).toBe(true);
      expect(texts(before).filter(([, , followup]) => !followup).map(([, text]) => text)).toEqual(['private', 'LONG ANSWER']);
    } finally { tailer.stop(); }
  });

  it('a task-notification turn keeps its existing handling', async () => {
    const { tailer, write } = await setup();
    try {
      const receipt = tailer.waitForInput('question', new AbortController().signal);
      await write([human('h1', null, 'question'), assistant('a1', 'h1', 'ANSWER'), duration('d1', 'a1')]);
      await receipt;
      const revision = tailer.turnTerminalRevision();
      // A meta user record without turnOrigin 'scheduled' is not a scheduled turn.
      await write([{ ...base('m1', 'd1'), type: 'user', isMeta: true, message: { role: 'user', content: 'skill context' } }, assistant('a2', 'm1', 'MORE'), duration('d2', 'a2')]);
      expect(tailer.turnTerminalRevision()).toBeGreaterThan(revision);
    } finally { tailer.stop(); }
  });
});
