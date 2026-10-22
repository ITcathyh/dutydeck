import { afterEach, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NormalizedDriverEvent } from '@dutydeck/shared';
import { ClaudeTranscriptTailer } from './claude.js';

// Real Claude 2.1.308 interactive Skill invocation with a local mock provider.
// Keep every UUID ancestor and all non-attachment fields. Attachments retain only
// type, UUID, parentUuid, isSidechain, timestamp and version; their bulky tool
// schemas/reminders do not affect input classification or terminal ancestry.
const entries = readFileSync(new URL('./fixtures/claude-skill-2.1.308.jsonl', import.meta.url), 'utf8').trim().split('\n').map(line => JSON.parse(line));
const input = entries[0], context = entries.find(entry => entry.sourceToolUseID);
let directory: string, source: ClaudeTranscriptTailer;
afterEach(() => { source?.stop(); if (directory) rmSync(directory, { recursive: true, force: true }); });
async function harness() {
  directory = mkdtempSync(join(tmpdir(), 'dd-claude-skill-'));
  const path = join(directory, 'session.jsonl'); writeFileSync(path, '');
  source = new ClaudeTranscriptTailer({ cwd: directory, transcriptPath: path });
  const events: NormalizedDriverEvent[] = []; source.onEvent(event => events.push(event));
  source.start(); await source.flush();
  // Rebase replay timestamps so native receipt freshness checks remain active.
  const append = async (...records: Record<string, unknown>[]) => { appendFileSync(path, records.map(entry => JSON.stringify({ ...entry, timestamp: new Date().toISOString() }) + '\n').join('')); await source.flush(); };
  return { append, events };
}
it('preserves native Skill ancestry after the exact receipt, then closes scope for a new human input', async () => {
  const { append, events } = await harness();
  const receipt = source.waitForInput(input.message.content, new AbortController().signal);
  await append(input); await receipt;
  await append(...entries.slice(1));
  expect(events.filter(event => event.type === 'text').map(event => event.data.text)).toEqual(['Interactive fixture answer after skill.']);
  expect(source.hasTurnTerminal()).toBe(true); expect(source.turnTerminalRevision()).toBe(2);
  expect(events.filter(event => event.type === 'tool_call')).toMatchObject([{ data: { name: 'Skill' } }]);
  expect(events.filter(event => event.type === 'tool_result')).toHaveLength(1);
  const revision = source.turnTerminalRevision();
  await append({ ...entries.at(-1), uuid: 'side-duration', isSidechain: true });
  expect(source.turnTerminalRevision()).toBe(revision);
  await append({ ...input, uuid: 'next-input', message: { role: 'user', content: 'next question' } },
    { ...entries.at(-2), uuid: 'next-answer', parentUuid: 'next-input' },
    { ...entries.at(-1), uuid: 'next-duration', parentUuid: 'next-answer' });
  expect(source.hasTurnTerminal()).toBe(false);
  expect(events.filter(event => event.type === 'text')).toHaveLength(1);
});
it.each(['isMeta', 'sourceToolUseID', 'isSidechain'] as const)('does not acknowledge Skill text matching a pending submission when marked by %s', async marker => {
  const { append, events } = await harness();
  const text = context.message.content[0].text;
  let confirmed = false;
  const receipt = source.waitForInput(text, new AbortController().signal).then(() => { confirmed = true; });
  await append({ ...context, isMeta: undefined, sourceToolUseID: undefined, [marker]: marker === 'sourceToolUseID' ? context.sourceToolUseID : true });
  expect(confirmed).toBe(false); expect(source.hasTurnTerminal()).toBe(false);
  await append({ ...input, message: { role: 'user', content: text } }); await receipt;
  expect(confirmed).toBe(true); expect(events.filter(event => event.type === 'text')).toEqual([]);
});
