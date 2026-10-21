import { afterEach, expect, it, vi } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCliAdapter, pinnedSessionUuid } from '@dutydeck/cli-adapters';
import type { NormalizedDriverEvent } from '@dutydeck/shared';
import type { SessionBackend } from '@dutydeck/session-backends';
import { PtyCliDriver } from './driver.js';

const records = readFileSync(new URL('./fixtures/claude-background-tasks/before-clear.jsonl', import.meta.url), 'utf8').trim().split('\n').map(line => JSON.parse(line));
const screen = readFileSync(new URL('./fixtures/claude-background-agent/turn1-screen.txt', import.meta.url), 'utf8');
const repaint = (text: string) => `\x1b[2J\x1b[H${text.replaceAll('\n', '\r\n')}`;
let root: string, driver: PtyCliDriver;
afterEach(async () => { await driver?.stop(); vi.useRealTimers(); if (root) rmSync(root, { recursive: true, force: true }); });
it('completes an explicitly answered main turn promptly, retains background status, and excludes a late old result from the next turn', async () => {
  vi.useFakeTimers(); root = mkdtempSync(join(tmpdir(), 'dd-driver-bg-native-'));
  const project = join(root, 'projects', realpathSync(root).replace(/[^A-Za-z0-9-]/g, '-')); mkdirSync(project, { recursive: true });
  const path = join(project, `${pinnedSessionUuid('ses_background_native')}.jsonl`); writeFileSync(path, '');
  const events: NormalizedDriverEvent[] = []; let output!: (text: string) => void, submitted = 0;
  const backend: SessionBackend = { kind: 'pty', spawn() {}, write() {}, resize() {}, kill() {}, onExit() {}, onData(callback) { output = callback; } };
  const append = (entries: any[]) => appendFileSync(path, entries.map(entry => JSON.stringify(entry) + '\n').join(''));
  driver = new PtyCliDriver({
    agent: { id: 'claude-code', name: 'Claude', command: process.execPath, args: [], protocol: 'pty-cli', cwd: root, env: { CLAUDE_CONFIG_DIR: root }, permissionMode: 'full-trust', timeout: 60, capabilities: { pause: false, resume: true }, builtin: false },
    adapter: { ...createCliAdapter('claude-code'), writeInput(_backend, prompt) { submitted++; append([{ type: 'user', uuid: submitted === 1 ? records[0].uuid : 'next-input', timestamp: new Date().toISOString(), message: { role: 'user', content: prompt } }]); } },
    backend, sessionId: 'ses_background_native', onEvent: event => events.push(event), onExit() {},
  });
  await driver.start(); output(repaint(screen)); await vi.advanceTimersByTimeAsync(300);
  const first = driver.send('Launch independent background work');
  await vi.waitFor(() => expect(submitted).toBe(1)); append(records.slice(1, 7)); output(repaint(screen)); await vi.advanceTimersByTimeAsync(5_000); await first;
  expect(events.filter(event => event.type === 'completed')).toHaveLength(1);
  expect(events.filter(event => event.type === 'status' && event.data.state === 'background_work').at(-1)?.data).toMatchObject({ count: 2, mainTurnEnded: true });
  const boundary = events.length, second = driver.send('A separate request'); await vi.waitFor(() => expect(submitted).toBe(2));
  append(records.slice(10, 15));
  append([{ type: 'user', uuid: 'next-input-repeat', message: { role: 'user', content: 'A separate request' } },
    { type: 'assistant', uuid: 'next-answer', parentUuid: 'next-input', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Fresh independent answer' }] } },
    { type: 'system', subtype: 'turn_duration' }]);
  output(repaint(screen)); await vi.advanceTimersByTimeAsync(5_000); await second;
  expect(events.slice(boundary).filter(event => event.type === 'text').map(event => event.data.text)).toEqual(['Fresh independent answer']);
});
