import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTraexAdapter } from '@dutydeck/cli-adapters';
import type { SessionBackend } from '@dutydeck/session-backends';
import type { NormalizedDriverEvent } from '@dutydeck/shared';
import { PtyCliDriver } from './driver.js';
const thread = '11111111-1111-4111-8111-111111111111';
const ready = 'TraeX\n  Worked for 1s\n────────────\n❯ Ask TraeCode CLI\nContext 100% left';
const busy = ready.replace('  Worked for 1s', '❖ Working… (1s • esc to interrupt)');
const line = (record: unknown) => JSON.stringify(record) + '\n';
let directory: string, path: string, driver: PtyCliDriver, output: (data: string) => void, writes: string[], events: NormalizedDriverEvent[];
let turn: number, prompt: string;
const paint = (screen: string) => output(`\x1b[2J\x1b[H${screen.replaceAll('\n', '\r\n')}`);
const append = (type: string, fields: Record<string, unknown> = {}) => appendFileSync(path, line({ type: 'event_msg', timestamp: new Date().toISOString(), payload: { type, turn_id: `turn-${turn}`, ...fields } }));
beforeEach(async () => {
  vi.useFakeTimers(); directory = mkdtempSync(join(tmpdir(), 'dd-traex-footer-')); writes = []; events = []; turn = 0; prompt = '';
  const day = join(directory, 'cli', 'sessions', '2026', '10', '15'); mkdirSync(day, { recursive: true });
  path = join(day, `rollout-2026-10-15T10-00-00-${thread}.jsonl`); writeFileSync(path, line({ type: 'session_meta', payload: { id: thread, cwd: directory } }));
  writeFileSync(join(directory, 'cli', 'history.jsonl'), '');
  const backend: SessionBackend = { kind: 'pty', spawn() {}, resize() {}, kill() {}, interrupt() {}, onExit() {}, onData(cb) { output = cb; }, write(data) {
    writes.push(data);
    if (data.startsWith('\x1b[200~')) prompt = data.slice(6, -6);
    if (data === '\r') {
      turn++; appendFileSync(join(directory, 'cli', 'history.jsonl'), line({ session_id: thread, ts: Date.now() / 1000, text: prompt }));
      append('task_started'); append('user_message', { message: prompt });
    }
  } };
  driver = new PtyCliDriver({ agent: { id: 'traex', name: 'fixture', command: 'unused', args: [], protocol: 'pty-cli', cwd: directory, env: { TRAE_HOME: directory }, permissionMode: 'full-trust', timeout: 0, capabilities: { pause: false, resume: true }, builtin: false },
    adapter: createTraexAdapter(), backend, sessionId: 'ses_traex-footer', onEvent(event) { events.push(event); }, onExit() {} });
  await driver.start(); paint(ready); await vi.advanceTimersByTimeAsync(250);
});
afterEach(async () => { await driver.stop(); vi.useRealTimers(); rmSync(directory, { recursive: true, force: true }); });
async function send() { const pending = driver.send('question'); void pending.catch(() => {}); await vi.advanceTimersByTimeAsync(700); expect(turn).toBe(1); return { pending }; }
const answer = () => appendFileSync(path, line({ type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final', content: [{ type: 'output_text', text: 'answer' }] } }));

it('vetoes completion on geometric busy even after a real native terminal, then completes once the screen clears', async () => {
  const { pending } = await send(); paint(busy); answer(); append('task_complete', { last_agent_message: 'answer' });
  await vi.advanceTimersByTimeAsync(6000); expect(events.filter(e => e.type === 'completed')).toEqual([]);
  paint(ready); await vi.advanceTimersByTimeAsync(4000); await pending;
  expect(events.filter(e => e.type === 'completed')).toHaveLength(1);
});

it('holds the real submission on busy geometry and requires the native terminal after the static screen becomes ready', async () => {
  paint(busy); await vi.advanceTimersByTimeAsync(250);
  const pending = driver.send('question'); void pending.catch(() => {});
  await vi.advanceTimersByTimeAsync(1000); expect(writes).toEqual([]);
  paint(ready); await vi.advanceTimersByTimeAsync(700); expect(turn).toBe(1);
  answer(); await vi.advanceTimersByTimeAsync(5000); expect(events.filter(e => e.type === 'completed')).toEqual([]);
  // No more PTY redraw after this point: terminal progress must reuse ready.
  append('task_complete', { last_agent_message: '' }); await vi.advanceTimersByTimeAsync(4000); await pending;
  expect(events.filter(e => e.type === 'completed')).toHaveLength(1);
});
