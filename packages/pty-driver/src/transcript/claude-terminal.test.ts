import { afterEach, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ClaudeTranscriptTailer } from './claude.js';

let directory: string, source: ClaudeTranscriptTailer;
afterEach(() => { source?.stop(); if (directory) rmSync(directory, { recursive: true, force: true }); });
const line = (entry: unknown) => JSON.stringify(entry) + '\n';
const input = { type: 'user', uuid: 'input', message: { role: 'user', content: 'exact prompt' } };
const final = { type: 'assistant', uuid: 'final', parentUuid: 'input', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'final' }] } };
async function harness(history = '') {
  directory = mkdtempSync(join(tmpdir(), 'dd-claude-terminal-'));
  const path = join(directory, 'session.jsonl'); writeFileSync(path, history);
  source = new ClaudeTranscriptTailer({ cwd: directory, transcriptPath: path });
  const append = async (...entries: unknown[]) => { appendFileSync(path, entries.map(line).join('')); await source.flush(); };
  return { path, append };
}
it('binds terminal markers to the exact receipt and rejects old, sidechain and foreign inputs', async () => {
  const { append } = await harness(line({ ...final, uuid: 'old', parentUuid: 'old-input' }));
  source.start(); await source.flush();
  const receipt = source.waitForInput('exact prompt', new AbortController().signal);
  await append(input); await receipt;
  await append({ ...final, uuid: 'side', isSidechain: true }, { ...final, uuid: 'old', parentUuid: 'old-input' },
    { type: 'system', subtype: 'turn_duration' });
  expect(source.hasTurnTerminal()).toBe(false);
  await append(final); expect(source.hasTurnTerminal()).toBe(true);
  await append({ type: 'assistant', uuid: 'continuation', parentUuid: 'final', message: { stop_reason: null, content: [] } });
  expect(source.hasTurnTerminal()).toBe(false);
  await append({ type: 'user', uuid: 'foreign', message: { role: 'user', content: 'other prompt' } }, { ...final, uuid: 'foreign-final', parentUuid: 'foreign' });
  expect(source.hasTurnTerminal()).toBe(false);
});
it('accepts turn_duration alone and waits through background notification follow-up', async () => {
  const { append } = await harness(); source.start(); await source.flush();
  const receipt = source.waitForInput('exact prompt', new AbortController().signal); await append(input); await receipt;
  await append({ type: 'system', subtype: 'turn_duration', uuid: 'duration', parentUuid: 'input', pendingBackgroundAgentCount: 1 });
  expect(source.hasTurnTerminal()).toBe(false); expect(source.pendingBackgroundWork()).toBe(1);
  await append({ type: 'user', uuid: 'notification', parentUuid: 'duration', turnOrigin: 'task_notification', message: { role: 'user', content: '<task-notification>done</task-notification>' } });
  await append({ type: 'system', subtype: 'turn_duration', uuid: 'done', parentUuid: 'notification' });
  expect(source.hasTurnTerminal()).toBe(true); expect(source.pendingBackgroundWork()).toBe(0);
});
it('uses the recovery cursor input boundary instead of old terminal history', async () => {
  const history = line(final); const { path, append } = await harness(history);
  source.restore({ path, offset: Buffer.byteLength(history) }); source.start(); await source.flush();
  expect(source.hasTurnTerminal()).toBe(false);
  await append({ ...final, uuid: 'late-old', parentUuid: 'old-input' }); expect(source.hasTurnTerminal()).toBe(false);
  await append(input, final); expect(source.hasTurnTerminal()).toBe(true);
});
