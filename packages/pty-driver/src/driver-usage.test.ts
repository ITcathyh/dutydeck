import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCliAdapter, pinnedSessionUuid } from '@dutydeck/cli-adapters';
import type { NormalizedDriverEvent } from '@dutydeck/shared';
import type { SessionBackend } from '@dutydeck/session-backends';
import { PtyCliDriver } from './driver.js';

const idleFooter = '⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents';
const repaint = (text: string) => `\x1b[2J\x1b[H${text.replaceAll('\n', '\r\n')}`;

let directory: string, driver: PtyCliDriver, output: (data: string) => void, events: NormalizedDriverEvent[], transcript: string, submitted: boolean;
beforeEach(async () => {
  vi.useFakeTimers();
  directory = mkdtempSync(join(tmpdir(), 'dutydeck-usage-'));
  const project = join(directory, 'projects', realpathSync(directory).replace(/[^A-Za-z0-9-]/g, '-'));
  mkdirSync(project, { recursive: true });
  transcript = join(project, `${pinnedSessionUuid('ses_usage-fixture')}.jsonl`);
  writeFileSync(transcript, '');
  events = []; submitted = false;
  const backend: SessionBackend = { kind: 'pty', spawn() {}, write() {}, resize() {}, kill() {}, onExit() {}, onData(callback) { output = callback; }, interrupt() {} };
  driver = new PtyCliDriver({
    agent: { id: 'claude-code', name: 'Claude', command: 'unused', args: [], protocol: 'pty-cli', cwd: directory, env: { CLAUDE_CONFIG_DIR: directory },
      permissionMode: 'full-trust', timeout: 60, capabilities: { pause: false, resume: true }, builtin: false },
    adapter: { ...createCliAdapter('claude-code'), writeInput(_backend, prompt) {
      submitted = true;
      appendFileSync(transcript, JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: prompt } }) + '\n');
    } },
    backend, sessionId: 'ses_usage-fixture', onEvent: event => events.push(event), onExit() {}
  });
  await driver.start();
  output(repaint(`Claude Code v2.1.267\n${directory}\n────────────────\n❯ \n────────────────\n${idleFooter}`));
  await vi.advanceTimersByTimeAsync(250);
});
afterEach(async () => { await driver?.stop(); vi.useRealTimers(); rmSync(directory, { recursive: true, force: true }); });

const answer = (text: string, usage?: Record<string, number>) => appendFileSync(transcript, JSON.stringify({ type: 'assistant', message: {
  id: `msg_${text}`, role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text }], stop_reason: 'end_turn', ...(usage ? { usage } : {}) } }) + '\n');
async function turn(prompt: string, write: () => void) {
  const pending = driver.send(prompt);
  for (let attempt = 0; attempt < 30 && !submitted; attempt++) await Promise.resolve();
  write();
  output(repaint(`${prompt}\n✻ Cooked for 3s · done 7:56 PM\n❯\n${idleFooter}`));
  await vi.advanceTimersByTimeAsync(600);
  await pending;
}

it('emits the turn token usage from the transcript right before completed', async () => {
  await turn('问题一', () => answer('一', { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5000, cache_creation_input_tokens: 300 }));
  const types = events.map(event => event.type);
  expect(types.filter(type => type === 'completed')).toHaveLength(1);
  const usage = events.findIndex(event => event.type === 'status' && event.data.state === 'turn_usage');
  expect(usage).toBe(types.indexOf('completed') - 1);
  expect(events[usage]!.data).toEqual({ state: 'turn_usage', usageRef: 'claude:msg_一', model: 'claude-sonnet-5-5',
    breakdown: { inputTokens: 100, outputTokens: 20, cachedReadTokens: 5000, cachedWriteTokens: 300 } });
});

it('emits no usage, not a zero reading, when the transcript has none, and does not carry a turn into the next', async () => {
  await turn('问题一', () => answer('一'));
  expect(events.some(event => event.type === 'status' && event.data.state === 'turn_usage')).toBe(false);
  submitted = false;
  await turn('问题二', () => answer('二', { input_tokens: 7, output_tokens: 1 }));
  expect(events.filter(event => event.type === 'status' && event.data.state === 'turn_usage').map(event => event.data.breakdown.inputTokens)).toEqual([7]);
});
