import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NormalizedDriverEvent } from '@dutydeck/shared';
import { JsonlTailer } from './tail.js';
import { mapClaudeEntry } from './claude.js';
import { mapCodexEntry } from './codex.js';
import { mapTraexEntry } from './traex.js';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function fixture(mapEntry = (entry: any): NormalizedDriverEvent[] => [{ type: 'text', data: { text: entry.text } }]) {
  const dir = mkdtempSync(join(tmpdir(), 'tail-budget-'));
  const path = join(dir, 'transcript.jsonl');
  writeFileSync(path, '');
  const events: NormalizedDriverEvent[] = [];
  const tailer = new JsonlTailer({ resolvePath: () => path, mapEntry, pollIntervalMs: 60_000 });
  tailer.onEvent(event => events.push(event));
  tailer.start();
  cleanup.push(() => { tailer.stop(); rmSync(dir, { recursive: true, force: true }); });
  return { tailer, path, events };
}

describe('bounded transcript drains', () => {
  it('rejects resolver errors without throwing from start or the polling timer, then retries', async () => {
    vi.useFakeTimers();
    let fail = true;
    let calls = 0;
    const error = Object.assign(new Error('temporary resolver EIO'), { code: 'EIO' });
    const tailer = new JsonlTailer({ resolvePath: () => { calls++; if (fail) throw error; return undefined; }, mapEntry: () => [] });
    try {
      expect(() => tailer.start()).not.toThrow();
      await expect(tailer.flush()).rejects.toBe(error);
      await vi.advanceTimersByTimeAsync(600);
      expect(calls).toBeGreaterThanOrEqual(3);
      fail = false;
      await vi.advanceTimersByTimeAsync(300);
      await expect(tailer.flush()).resolves.toBeUndefined();
    } finally { tailer.stop(); vi.useRealTimers(); }
  });

  it('yields while draining and stops exactly at the captured waterline', async () => {
    const { tailer, path, events } = fixture();
    await tailer.flush();
    const line = JSON.stringify({ text: 'x'.repeat(1024) }) + '\n';
    appendFileSync(path, line.repeat(6000));
    const waterline = statSync(path).size;
    const drain = tailer.flush();
    let observedDuringDrain = -1;
    await new Promise<void>(resolve => setImmediate(() => {
      observedDuringDrain = events.length;
      appendFileSync(path, JSON.stringify({ text: 'after waterline' }) + '\n');
      resolve();
    }));
    await drain;
    expect(observedDuringDrain).toBeGreaterThan(0);
    expect(observedDuringDrain).toBeLessThan(6000);
    expect(events).toHaveLength(6000);
    expect(tailer.checkpoint().offset).toBe(waterline);
    await tailer.flush();
    expect(events.at(-1)?.data.text).toBe('after waterline');
  });

  it.each([
    ['claude', mapClaudeEntry], ['codex', mapCodexEntry], ['traex', mapTraexEntry],
  ] as const)('drains a multi-budget %s real-schema record, preserving UTF-8 and source identity', async (name, mapper) => {
    const mapEntry = (entry: any) => mapper(entry) ?? [];
    const { tailer, path, events } = fixture(mapEntry);
    await tailer.flush();
    const entry = JSON.parse(readFileSync(new URL(`../fixtures/transcript-dialects/${name}.jsonl`, import.meta.url), 'utf8'));
    const text = '脱敏🙂'.repeat(100_000);
    if (name === 'claude') entry.message.content[0].text = text;
    else if (name === 'codex') entry.payload.last_agent_message = text;
    else entry.payload.message = text;
    const bytes = Buffer.from(JSON.stringify(entry) + '\n');
    appendFileSync(path, bytes.subarray(0, bytes.length - 5));
    await tailer.flush();
    expect(events).toEqual([]);
    expect(tailer.checkpoint().offset).toBe(0);
    appendFileSync(path, bytes.subarray(bytes.length - 5));
    await tailer.flush();
    expect(events).toHaveLength(1);
    expect(events[0]?.data.text).toBe(text);
    expect(tailer.checkpoint().offset).toBe(bytes.length);
    const replay = new JsonlTailer({ resolvePath: () => path, mapEntry });
    const replayed: NormalizedDriverEvent[] = [];
    replay.onEvent(event => replayed.push(event));
    replay.restore({ path, offset: 0 });
    replay.start();
    try { await replay.flush(); expect(replayed).toEqual(events); }
    finally { replay.stop(); }
  });

  it('fails an oversized unfinished record explicitly and retains its recoverable cursor', async () => {
    const { tailer, path, events } = fixture();
    await tailer.flush();
    appendFileSync(path, JSON.stringify({ text: 'before' }) + '\n');
    await tailer.flush();
    const cursor = tailer.checkpoint();
    appendFileSync(path, 'x'.repeat(16 * 1024 * 1024 + 1));
    await expect(tailer.flush()).rejects.toThrow('Transcript record exceeds');
    expect(tailer.checkpoint()).toEqual(cursor);
    expect(events.at(-1)).toMatchObject({ type: 'error', data: { code: 'transcript_record_too_large' } });
    await expect(tailer.flush()).rejects.toThrow('Transcript record exceeds');
    expect(events.filter(event => event.type === 'error')).toHaveLength(1);
  });

  it('drains a newly born transcript in the first explicit completion flush', async () => {
    const { tailer, path, events } = fixture();
    tailer.stop(); unlinkSync(path);
    tailer.start();
    await tailer.flush();
    writeFileSync(path, '{"text":"first and final"}\n');
    await tailer.flush();
    expect(events.map(event => event.data.text)).toEqual(['first and final']);
    expect(tailer.checkpoint().offset).toBe(statSync(path).size);
  });

  it('surfaces a restore failure after validation instead of swallowing it in start polling', async () => {
    const { tailer, path } = fixture();
    await tailer.flush();
    tailer.stop();
    writeFileSync(path, '{"text":"old"}\n');
    tailer.restore({ path, offset: statSync(path).size });
    unlinkSync(path);
    tailer.start();
    await expect(tailer.flush()).rejects.toThrow('cursor file is unavailable');
  });

  it('re-resolves a vanished file and preserves the partial suffix when switching paths', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tail-switch-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const first = join(dir, 'first.jsonl'), second = join(dir, 'second.jsonl');
    let path = first;
    writeFileSync(first, '');
    const events: NormalizedDriverEvent[] = [];
    const tailer = new JsonlTailer({ resolvePath: () => path, mapEntry: entry => [{ type: 'text', data: { text: entry.text } }], pollIntervalMs: 60_000 });
    cleanup.push(() => tailer.stop());
    tailer.onEvent(event => events.push(event)); tailer.start(); await tailer.flush();
    unlinkSync(first); await expect(tailer.flush()).rejects.toThrow('unavailable');
    expect(tailer.checkpoint()).toEqual({ path: first, offset: 0 });
    writeFileSync(first, ''); await tailer.flush();
    writeFileSync(second, '{"text":"history"}\n{"text":"part');
    path = second; await tailer.flush();
    expect(tailer.checkpoint()).toEqual({ path: second, offset: 19 });
    appendFileSync(second, 'ial"}\n'); await tailer.flush();
    expect(events.map(event => event.data.text)).toEqual(['partial']);
  });

  it('resets a partial line on truncation and never emits an old drain after stop', async () => {
    const { tailer, path, events } = fixture();
    await tailer.flush();
    appendFileSync(path, '{"text":"partial');
    await tailer.flush();
    writeFileSync(path, '{"text":"new"}\n');
    await tailer.flush();
    expect(events.map(event => event.data.text)).toEqual(['new']);
    appendFileSync(path, (JSON.stringify({ text: 'x'.repeat(1024) }) + '\n').repeat(6000));
    const drain = tailer.flush();
    await new Promise<void>(resolve => setImmediate(resolve));
    tailer.stop();
    const count = events.length;
    await drain;
    expect(events).toHaveLength(count);
  });
});
