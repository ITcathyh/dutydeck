import { afterEach, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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
  await append(final); expect(source.hasTurnTerminal()).toBe(false);
  await append({ type: 'system', subtype: 'turn_duration', uuid: 'own-duration', parentUuid: 'final' });
  expect(source.hasTurnTerminal()).toBe(true);
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

it('versions bound terminal identities without treating metadata or replay as new terminals', async () => {
  const { append } = await harness(); source.start(); await source.flush();
  const receipt = source.waitForInput('exact prompt', new AbortController().signal); await append(input); await receipt;
  expect(source.turnTerminalRevision()).toBe(0);
  await append(final); expect(source.turnTerminalRevision()).toBe(1);
  await append({ type: 'system', subtype: 'metadata', parentUuid: 'final' });
  expect(source.turnTerminalRevision()).toBe(1);
  await append({ ...final, uuid: 'second', parentUuid: 'final' }); expect(source.turnTerminalRevision()).toBe(2);
  await append(final); expect(source.turnTerminalRevision()).toBe(2);
  await append({ type: 'assistant', uuid: 'empty', parentUuid: 'second', message: { stop_reason: null, content: [] } },
    { ...final, uuid: 'third', parentUuid: 'empty' });
  expect(source.hasTurnTerminal()).toBe(true); expect(source.turnTerminalRevision()).toBe(3);
  await append({ ...final, uuid: 'side', isSidechain: true }); expect(source.turnTerminalRevision()).toBe(3);
});

it('rejects a terminal in a replacement file even at a later byte offset', async () => {
  const { path, append } = await harness(); source.start(); await source.flush();
  const receipt = source.waitForInput('exact prompt', new AbortController().signal); await append(input); await receipt;
  const watermark = source.captureWatermark()!;
  renameSync(path, path + '.old'); writeFileSync(path, line(input));
  await append(final);
  expect(source.hasTurnTerminal()).toBe(true);
  expect(source.hasTurnTerminalAfter(watermark)).toBe(false);
});
it('invalidates a busy watermark after detected transcript truncation', async () => {
  const { path, append } = await harness(); source.start(); await source.flush();
  const receipt = source.waitForInput('exact prompt', new AbortController().signal); await append(input); await receipt;
  const watermark = source.captureWatermark()!;
  writeFileSync(path, ''); await source.flush();
  await append(input, final);
  expect(source.hasTurnTerminalAfter(watermark)).toBe(false);
});

it('learns duration support from a restored baseline and releases the requirement at the next real input', async () => {
  const history = line({ type: 'system', subtype: 'turn_duration', uuid: 'old-duration', parentUuid: 'old-input' });
  const { path, append } = await harness(history);
  source.restore({ path, offset: Buffer.byteLength(history) }); source.start(); await source.flush();
  await append(input, final);
  expect(source.requiresTurnTerminal).toBe(true); expect(source.hasTurnTerminal()).toBe(false);
  await append({ type: 'user', uuid: 'next-input', message: { role: 'user', content: 'typed next' } });
  expect(source.requiresTurnTerminal).toBe(false); expect(source.hasTurnTerminal()).toBe(false);
  await append({ type: 'system', subtype: 'turn_duration', uuid: 'foreign-duration', parentUuid: 'next-input' });
  expect(source.hasTurnTerminal()).toBe(false);
});
it('learns duration support live and requires the next input complete marker', async () => {
  const { append } = await harness(); source.start(); await source.flush();
  await append({ type: 'system', subtype: 'turn_duration', uuid: 'previous-duration' });
  const receipt = source.waitForInput('exact prompt', new AbortController().signal); await append(input); await receipt;
  await append(final); expect(source.requiresTurnTerminal).toBe(true); expect(source.hasTurnTerminal()).toBe(false);
  await append({ type: 'system', subtype: 'turn_duration', uuid: 'duration', parentUuid: 'final' });
  expect(source.hasTurnTerminal()).toBe(true);
});

it('scopes parentless native records by the exact physical input and rejects replayed historical durations', async () => {
  const previous = { type: 'system', subtype: 'turn_duration', uuid: 'historical-duration' };
  const { append } = await harness(line(previous)); source.start(); await source.flush();
  const receipt = source.waitForInput('exact prompt', new AbortController().signal); await append(input); await receipt;
  await append({ ...final, parentUuid: undefined });
  expect(source.hasTurnTerminal()).toBe(false);
  await append(previous); expect(source.hasTurnTerminal()).toBe(false);
  await append({ type: 'system', subtype: 'turn_duration', uuid: 'current-duration' });
  expect(source.hasTurnTerminal()).toBe(true);
});
