import { afterEach, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { NormalizedDriverEvent } from '@dutydeck/shared';
import { ClaudeTranscriptTailer } from './claude.js';
import { ClaudeBackgroundTasks } from './claude-background.js';
// Captured native Claude JSONL, adapted from Botmux f89419093 (MIT).
const records = readFileSync(new URL('../fixtures/claude-background-tasks/before-clear.jsonl', import.meta.url), 'utf8').trim().split('\n').map(line => JSON.parse(line));
let root: string, tailer: ClaudeTranscriptTailer;
afterEach(() => { tailer?.stop(); if (root) rmSync(root, { recursive: true, force: true }); });
it('tracks real Agent and Bash launches independently of a completed main turn and isolates late results', async () => {
  root = mkdtempSync(join(tmpdir(), 'dd-bg-native-')); const path = join(root, 'session.jsonl'); writeFileSync(path, '');
  tailer = new ClaudeTranscriptTailer({ cwd: root, transcriptPath: path }); const events: NormalizedDriverEvent[] = []; tailer.onEvent(event => events.push(event));
  tailer.start(); await tailer.flush();
  const append = async (entries: any[]) => { appendFileSync(path, entries.map(entry => JSON.stringify(entry) + '\n').join('')); await tailer.flush(); };
  await append(records.slice(0, 7));
  expect(tailer.pendingBackgroundWork()).toBe(2); expect(tailer.hasIndependentBackgroundWork()).toBe(true);
  expect(events.filter(event => event.type === 'status').at(-1)?.data).toMatchObject({ state: 'background_work', count: 2, mainTurnEnded: true });
  await append(records.slice(7, 10)); expect(events.filter(event => event.type === 'text').at(-1)?.data.text).toBe('hi');
  await append(records.slice(10, 20)); expect(tailer.pendingBackgroundWork()).toBe(0);
  expect(events.filter(event => event.type === 'text').map(event => event.data.text)).toEqual(['launched', 'hi']);
});
it('rebuilds live task identities after restart without replaying old replies', async () => {
  root = mkdtempSync(join(tmpdir(), 'dd-bg-restore-')); const path = join(root, 'session.jsonl');
  const history = records.slice(0, 7).map(entry => JSON.stringify(entry) + '\n').join(''); writeFileSync(path, history);
  tailer = new ClaudeTranscriptTailer({ cwd: root, transcriptPath: path }); tailer.restore({ path, offset: Buffer.byteLength(history) });
  const events: NormalizedDriverEvent[] = []; tailer.onEvent(event => events.push(event)); tailer.start(); await tailer.flush();
  expect(tailer.pendingBackgroundWork()).toBe(2); expect(events.map(event => event.type)).toEqual(['status']);
  expect(events[0]?.data).toMatchObject({ state: 'background_work', count: 2 });
  appendFileSync(path, records.slice(10, 20).map(entry => JSON.stringify(entry) + '\n').join('')); await tailer.flush();
  expect(tailer.pendingBackgroundWork()).toBe(0); expect(events.some(event => event.type === 'text')).toBe(false);
});
it('keeps a single accepted next input and its ancestry alive across late background notice chains', async () => {
  root = mkdtempSync(join(tmpdir(), 'dd-bg-interleaved-')); const path = join(root, 'session.jsonl'); writeFileSync(path, '');
  tailer = new ClaudeTranscriptTailer({ cwd: root, transcriptPath: path }); const events: NormalizedDriverEvent[] = []; tailer.onEvent(event => events.push(event));
  const append = async (...rows: any[]) => { appendFileSync(path, rows.map(row => JSON.stringify(row) + '\n').join('')); await tailer.flush(); };
  tailer.start(); await tailer.flush(); await append(...records.slice(0, 7));
  const receipt = tailer.waitForInput('A separate request', new AbortController().signal);
  await append({ type: 'user', uuid: 'next-input', timestamp: new Date().toISOString(), message: { role: 'user', content: 'A separate request' } }); await receipt;
  await append(...records.slice(10, 15));
  await append({ type: 'assistant', uuid: 'next-step', parentUuid: 'next-input', message: { content: [{ type: 'text', text: 'Fresh progress' }] } });
  // Another old notice between current-input chunks must not reclaim its answer.
  const notice = { ...records[17], uuid: 'late-notice-again' };
  await append(notice, { type: 'assistant', uuid: 'old-note', parentUuid: notice.uuid, message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Old background postscript' }] } });
  await append({ type: 'assistant', uuid: 'next-answer', parentUuid: 'next-step', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Fresh independent answer' }] } },
    { type: 'system', subtype: 'turn_duration', uuid: 'next-terminal', parentUuid: 'next-answer' });
  expect(events.filter(event => event.type === 'text').map(event => event.data.text)).toEqual(['launched', 'Fresh progress', 'Fresh independent answer']);
  expect(tailer.hasTurnTerminal()).toBe(true);
});
it('restores legacy pending counters as required waiting, alongside native identities', async () => {
  root = mkdtempSync(join(tmpdir(), 'dd-bg-legacy-restore-')); const path = join(root, 'session.jsonl');
  const legacy = readFileSync(new URL('../fixtures/claude-background-agent/transcript.jsonl', import.meta.url), 'utf8').trim().split('\n');
  const end = legacy.findIndex(line => JSON.parse(line).pendingBackgroundAgentCount === 1);
  writeFileSync(path, legacy.slice(0, end + 1).join('\n') + '\n');
  tailer = new ClaudeTranscriptTailer({ cwd: root, transcriptPath: path }); tailer.start(); await tailer.flush();
  expect(tailer.pendingBackgroundWork()).toBe(1); expect(tailer.hasIndependentBackgroundWork()).toBe(false);
});
it('settles only known native task IDs across /clear without importing another transcript answer', async () => {
  root = mkdtempSync(join(tmpdir(), 'dd-bg-clear-')); const path = join(root, 'before.jsonl');
  writeFileSync(path, records.map(entry => JSON.stringify(entry) + '\n').join(''));
  tailer = new ClaudeTranscriptTailer({ cwd: root, transcriptPath: path }); const events: NormalizedDriverEvent[] = []; tailer.onEvent(event => events.push(event));
  tailer.start(); await tailer.flush(); expect(tailer.pendingBackgroundWork()).toBe(1);
  writeFileSync(join(root, 'after.jsonl'), readFileSync(new URL('../fixtures/claude-background-tasks/after-clear.jsonl', import.meta.url)));
  await tailer.flush(); expect(tailer.pendingBackgroundWork()).toBe(0); expect(events.some(event => event.type === 'text')).toBe(false);
  expect(events.at(-1)?.data.count).toBe(0);
});
it('handles successful TaskStop without a notice and does not finish a Monitor on event-only updates', () => {
  const tracker = new ClaudeBackgroundTasks(); const at = new Date().toISOString();
  const call = (id: string, name: string) => tracker.observe({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name }] } });
  const result = (id: string, value: any) => tracker.observe({ type: 'user', timestamp: at, toolUseResult: value, message: { content: [{ type: 'tool_result', tool_use_id: id }] } });
  call('m', 'Monitor'); result('m', { taskId: 'monitor', persistent: false, timeoutMs: 1_000 }); expect(tracker.snapshot().count).toBe(1);
  tracker.observe({ type: 'queue-operation', operation: 'enqueue', content: '<task-notification><task-id>monitor</task-id><summary>changed</summary></task-notification>' }); expect(tracker.snapshot().count).toBe(1);
  call('stop', 'TaskStop'); result('stop', { task_id: 'monitor', task_type: 'monitor' }); expect(tracker.snapshot().count).toBe(0);
  call('expiring', 'Monitor'); result('expiring', { taskId: 'expired', persistent: false, timeoutMs: 1 });
  const clock = Date.now; Date.now = () => Date.parse(at) + 2;
  try { expect(tracker.snapshot().tasks.find(task => task.id === 'expired')?.state).toBe('expired'); } finally { Date.now = clock; }
});
it('allows a necessary same-input child result to contribute before the main turn has answered', () => {
  const tracker = new ClaudeBackgroundTasks();
  tracker.observe({ type: 'user', uuid: 'original-input', message: { content: [{ type: 'text', text: 'Wait for the child result' }] } });
  tracker.observe({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'child-tool', name: 'Agent' }] } });
  tracker.observe({ type: 'user', toolUseResult: { isAsync: true, agentId: 'child' }, message: { content: [{ type: 'tool_result', tool_use_id: 'child-tool' }] } });
  tracker.observe({ type: 'user', turnOrigin: 'task_notification', message: { content: '<task-notification><task-id>child</task-id><status>completed</status></task-notification>' } });
  expect(tracker.isNotificationContinuation()).toBe(false); expect(tracker.snapshot().count).toBe(0);
  tracker.observe({ type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Here is the combined result' }] } });
  expect(tracker.snapshot().mainTurnEnded).toBe(true);
});
