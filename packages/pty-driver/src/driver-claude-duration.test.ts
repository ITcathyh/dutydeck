import { afterEach, expect, it, vi } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCliAdapter, pinnedSessionUuid } from '@dutydeck/cli-adapters';
import type { NormalizedDriverEvent } from '@dutydeck/shared';
import type { SessionBackend } from '@dutydeck/session-backends';
import { PtyCliDriver } from './driver.js';

const line = (entry: unknown) => JSON.stringify(entry) + '\n';
const frame = (state: string) => `\x1b]7501;state=${state}:app=claude-code\x07`;
const duration = (parentUuid = 'block-2') => ({ type: 'system', subtype: 'turn_duration', uuid: `duration-${parentUuid}`, parentUuid, pendingBackgroundAgentCount: 0 });
const block = (uuid: string, parentUuid: string, text: string) => ({ type: 'assistant', uuid, parentUuid,
  message: { id: 'shared-message', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text }] } });
let driver: PtyCliDriver, cwd: string;
afterEach(async () => { await driver?.stop(); vi.useRealTimers(); if (cwd) rmSync(cwd, { recursive: true, force: true }); });
async function fixture(history = line(duration('historical')), input = { type: 'user', uuid: 'input', message: { role: 'user', content: '' } }) {
  vi.useFakeTimers(); cwd = mkdtempSync(join(tmpdir(), 'dd-claude-duration-'));
  const project = join(cwd, 'projects', realpathSync(cwd).replace(/[^A-Za-z0-9-]/g, '-')); mkdirSync(project, { recursive: true });
  const path = join(project, `${pinnedSessionUuid('ses_duration')}.jsonl`); writeFileSync(path, history);
  const append = (...entries: unknown[]) => appendFileSync(path, entries.map(line).join(''));
  const events: NormalizedDriverEvent[] = []; let output!: (data: string) => void, exit!: (code: number) => void;
  const backend: SessionBackend = { kind: 'pty', spawn() {}, write() {}, resize() {}, kill() {}, interrupt() {}, onExit(cb) { exit = cb; }, onData(cb) { output = cb; } };
  driver = new PtyCliDriver({ agent: { id: 'claude-code', name: 'Claude', command: 'unused', args: [], protocol: 'pty-cli', cwd,
    env: { CLAUDE_CONFIG_DIR: cwd }, permissionMode: 'ask', timeout: 3600, capabilities: { pause: false, resume: false }, builtin: false },
    adapter: { ...createCliAdapter('claude-code'), prepareInput: undefined, writeInput(_backend, prompt) {
      append({ ...input, timestamp: new Date().toISOString(), message: { ...input.message, content: prompt } });
    } }, backend, sessionId: 'ses_duration', onEvent: event => events.push(event), onExit() {} });
  await driver.start(); output(frame('idle'));
  const pending = driver.send('exact prompt'); void pending.catch(() => {});
  await vi.advanceTimersByTimeAsync(350);
  expect(events.some(event => event.type === 'status' && event.data.state === 'input_receipt' && event.data.phase === 'confirmed')).toBe(true);
  output(frame('working')); output('\x1b[2J\x1b[HAnswer\r\n✻ Cooked for 3s\r\n❯\r\n⏵⏵ bypass permissions on');
  const completed = () => events.filter(event => event.type === 'completed');
  return { append, events, output, exit, pending, completed };
}
it.each(['lost OSC', 'OSC first'] as const)('delivers the native Claude 2.1.308 Skill answer and completes once with %s', async mode => {
  const entries = readFileSync(new URL('./transcript/fixtures/claude-skill-2.1.308.jsonl', import.meta.url), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  // Preserve native UUID ancestry; only the exact submitted input and its freshness timestamp change.
  const h = await fixture('', entries[0]);
  let resolved = false; void h.pending.then(() => { resolved = true; }, () => {});
  if (mode === 'OSC first') h.output(frame('done'));
  h.append(...entries.slice(1));
  await vi.advanceTimersByTimeAsync(3_000);
  expect(h.events.filter(event => event.type === 'text').map(event => event.data.text)).toEqual(['Interactive fixture answer after skill.']);
  expect(h.completed()).toHaveLength(1); expect(resolved).toBe(true); await h.pending;
  expect(h.events.findIndex(event => event.type === 'completed')).toBeGreaterThan(h.events.findIndex(event => event.type === 'text'));
  expect(h.events.filter(event => event.type === 'error')).toEqual([]);
  h.output(frame('done')); await vi.advanceTimersByTimeAsync(3_000); expect(h.completed()).toHaveLength(1);
});
it.each(['lost OSC', 'OSC first'] as const)('holds split text through Stop-hook continuations with %s and baseline duration support', async mode => {
  const h = await fixture();
  h.append({ type: 'assistant', uuid: 'thinking', parentUuid: 'input', message: { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: 'thinking' }] } });
  if (mode === 'OSC first') h.output(frame('done'));
  await vi.advanceTimersByTimeAsync(3_000); expect(h.completed()).toHaveLength(0);
  h.append(block('block-1', 'thinking', 'FIRST'));
  await vi.advanceTimersByTimeAsync(3_000); expect(h.completed()).toHaveLength(0);
  h.append(block('block-2', 'block-1', 'SECOND'));
  await vi.advanceTimersByTimeAsync(3_000); expect(h.completed()).toHaveLength(0);
  h.append(duration()); await vi.advanceTimersByTimeAsync(3_000); await h.pending;
  expect(h.completed()).toHaveLength(1);
  expect(h.events.filter(event => event.type === 'text').map(event => event.data.text)).toEqual(['FIRST', 'SECOND']);
  expect(h.events.findIndex(event => event.type === 'completed')).toBeGreaterThan(h.events.findIndex(event => event.type === 'text' && event.data.text === 'SECOND'));
  h.append(duration()); await vi.advanceTimersByTimeAsync(3_000); expect(h.completed()).toHaveLength(1);
});
it('keeps a late provider failure on the original turn until the duration marker', async () => {
  const h = await fixture(); h.append(block('block-1', 'input', 'PARTIAL')); h.output(frame('done'));
  await vi.advanceTimersByTimeAsync(3_000); expect(h.completed()).toHaveLength(0);
  h.append({ type: 'assistant', uuid: 'error', parentUuid: 'block-1', isApiErrorMessage: true, error: 'server_error',
    message: { content: [{ type: 'text', text: 'late provider failure' }] } });
  await vi.advanceTimersByTimeAsync(3_000); expect(h.completed()).toHaveLength(0);
  h.append(duration('error')); await vi.advanceTimersByTimeAsync(3_000); await h.pending;
  expect(h.events.filter(event => event.type === 'error')).toMatchObject([{ data: { code: 'claude_api_server_error' } }]);
  expect(h.completed()).toHaveLength(1);
});
it('does not hang legacy transcripts that have never emitted a duration marker', async () => {
  const h = await fixture(''); h.append(block('block-1', 'input', 'legacy')); h.output(frame('done'));
  await vi.advanceTimersByTimeAsync(3_000); await h.pending; expect(h.completed()).toHaveLength(1);
});
it('drains output and rejects an exited process even when its duration marker is missing', async () => {
  const h = await fixture(); h.append(block('block-1', 'input', 'partial')); h.output(frame('done'));
  await vi.advanceTimersByTimeAsync(3_000); expect(h.completed()).toHaveLength(0);
  h.exit(1); await expect(h.pending).rejects.toThrow('Agent exited with code 1');
  expect(h.events.some(event => event.type === 'text' && event.data.text === 'partial')).toBe(true);
  expect(h.completed()).toHaveLength(0);
});
it.each([false, true])('settles the original output at the next input boundary without collecting unrelated output (original error=%s)', async originalError => {
  const h = await fixture(); h.append(block('block-1', 'input', 'ORIGINAL')); h.output(frame('done'));
  await vi.advanceTimersByTimeAsync(3_000); expect(h.completed()).toHaveLength(0);
  if (originalError) {
    h.append({ type: 'assistant', uuid: 'original-error', parentUuid: 'block-1', isApiErrorMessage: true, error: 'authentication_failed', message: { content: 'original failure' } });
    await vi.advanceTimersByTimeAsync(1_000); expect(h.completed()).toHaveLength(0);
  }
  h.append({ type: 'user', uuid: 'typed-next', message: { role: 'user', content: 'another question' } },
    block('foreign-answer', 'typed-next', 'UNRELATED ANSWER'),
    { type: 'assistant', uuid: 'foreign-error', parentUuid: 'foreign-answer', isApiErrorMessage: true, error: 'server_error', message: { content: 'UNRELATED ERROR' } },
    duration('foreign-error'));
  await vi.advanceTimersByTimeAsync(3_000); await h.pending;
  expect(h.completed()).toHaveLength(1);
  expect(h.events.filter(event => event.type === 'text').map(event => event.data.text)).toEqual(['ORIGINAL']);
  expect(h.events.filter(event => event.type === 'error').map(event => event.data.code)).toEqual(originalError ? ['claude_api_authentication_failed'] : []);
});
