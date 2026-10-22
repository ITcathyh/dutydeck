import { afterEach, expect, it, vi } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCliAdapter } from '@dutydeck/cli-adapters';
import type { NormalizedDriverEvent } from '@dutydeck/shared';
import type { SessionBackend } from '@dutydeck/session-backends';
import { PtyCliDriver } from './driver.js';

const line = (entry: unknown) => JSON.stringify(entry) + '\n';
const frame = (state: string) => `\x1b]7501;state=${state}:app=codex\x07`;
let cwd: string, driver: PtyCliDriver;
afterEach(async () => { await driver?.stop(); vi.useRealTimers(); if (cwd) rmSync(cwd, { recursive: true, force: true }); });
it('finishes the original driver send once after its bound native session rotates with copied history', async () => {
  vi.useFakeTimers(); cwd = mkdtempSync(join(tmpdir(), 'dd-codex-driver-generation-'));
  const day = join(cwd, 'sessions', '2026', '10', '22'); mkdirSync(day, { recursive: true });
  const sid = '11111111-1111-4111-8111-111111111111', gen = '22222222-2222-4222-8222-222222222222';
  const meta = line({ type: 'session_meta', payload: { id: sid, cwd } });
  const input = line({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'original' } })
    + line({ type: 'event_msg', payload: { type: 'user_message', turn_id: 'original', message: 'question' } });
  const old = join(day, `rollout-2026-10-22T09-00-00-${sid}.jsonl`); writeFileSync(old, meta);
  writeFileSync(join(cwd, 'history.jsonl'), line({ session_id: sid, ts: Date.now() / 1000, text: '<dutydeck_session_id>ses_generation_driver</dutydeck_session_id>' }));
  let output!: (data: string) => void;
  const backend: SessionBackend = { kind: 'pty', spawn() {}, write() {}, resize() {}, kill() {}, interrupt() {}, onExit() {}, onData(cb) { output = cb; } };
  const events: NormalizedDriverEvent[] = [];
  driver = new PtyCliDriver({ agent: { id: 'codex', name: 'Codex', command: 'unused', args: [], protocol: 'pty-cli', cwd,
    env: { CODEX_HOME: cwd }, permissionMode: 'ask', timeout: 3600, capabilities: { pause: false, resume: false }, builtin: false },
    adapter: { ...createCliAdapter('codex'), prepareInput: undefined, writeInput(_backend, prompt) { appendFileSync(old, line({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'original' } }) + line({ type: 'event_msg', payload: { type: 'user_message', turn_id: 'original', message: prompt } })); } },
    backend, sessionId: 'ses_generation_driver', onEvent: event => events.push(event), onExit() {} });
  await driver.start(); output(frame('idle')); const pending = driver.send('question'); void pending.catch(() => {});
  await vi.advanceTimersByTimeAsync(350);
  expect(events.some(event => event.type === 'status' && event.data.state === 'input_receipt' && event.data.phase === 'confirmed')).toBe(true);
  output('\x1b[2J\x1b[HWorking\r\n› question\r\nesc to interrupt'); await vi.advanceTimersByTimeAsync(3_000);
  expect(events.filter(event => event.type === 'completed')).toHaveLength(0);
  const next = join(day, `rollout-2026-10-22T10-00-00-${sid}_${gen}.jsonl`);
  output('\x1b[2J\x1b[H› \r\n? for shortcuts');
  writeFileSync(next, meta + input + line({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'original', last_agent_message: 'complete answer' } }));
  await vi.advanceTimersByTimeAsync(4_000); await pending;
  expect(events.filter(event => event.type === 'text').map(event => event.data.text)).toEqual(['complete answer']);
  expect(events.filter(event => event.type === 'completed')).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(3_000); expect(events.filter(event => event.type === 'completed')).toHaveLength(1);
});
