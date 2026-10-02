import { afterEach, afterAll, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonlTailer } from './tail.js';
import { CodexInputReceipt } from './codex-input-receipt.js';
import { claudeInputText, codexInputText, normalizeInputText } from './input-receipt.js';

const directory = mkdtempSync(join(tmpdir(), 'dd-native-receipt-'));
const sources: { stop(): void }[] = [];
afterEach(() => { for (const source of sources.splice(0)) source.stop(); });
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const line = (entry: unknown) => JSON.stringify(entry) + '\n';
const user = (text: string) => ({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: text } });

it('keeps legal Unicode, narrows line endings, and excludes assistant/tool/sidechain records', () => {
  const text = '中文👩‍💻\u200c\u200b\r\nsecond\rthird';
  expect(normalizeInputText(text)).toBe('中文👩‍💻\u200c\u200b\nsecond\nthird');
  expect(claudeInputText(user(text))).toBe(text);
  expect(claudeInputText({ ...user(text), isSidechain: true })).toBeUndefined();
  expect(claudeInputText({ type: 'assistant', message: { role: 'assistant', content: text } })).toBeUndefined();
  expect(claudeInputText({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: text }] } })).toBeUndefined();
  expect(codexInputText({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text }] } } })).toBe(text);
});

it('requires a new full user record, ignores history, partial pre-waterline records and prefix collisions', async () => {
  const path = join(directory, 'waterline.jsonl');
  const partial = line(user('ok')).trimEnd();
  writeFileSync(path, line(user('ok')) + partial);
  const tail = new JsonlTailer({ resolvePath: () => path, mapEntry: () => undefined, inputText: claudeInputText }); sources.push(tail);
  await tail.flush();
  const controller = new AbortController();
  let confirmed = false;
  const pending = tail.waitForInput('ok', controller.signal).then(() => { confirmed = true; });
  appendFileSync(path, '\n' + line(user('okay')) + line({ type: 'assistant', message: { role: 'assistant', content: 'ok' } }));
  await tail.flush(); expect(confirmed).toBe(false);
  appendFileSync(path, line(user('ok'))); await tail.flush(); await pending; expect(confirmed).toBe(true);
});

it('captures the first receipt when a session transcript is born after arming', async () => {
  const path = join(directory, 'born.jsonl');
  const tail = new JsonlTailer({ resolvePath: () => path, mapEntry: () => undefined, inputText: claudeInputText }); sources.push(tail);
  await tail.flush();
  const pending = tail.waitForInput('first\r\n👩‍💻', new AbortController().signal);
  writeFileSync(path, line(user('first\n👩‍💻'))); await tail.flush(); await pending;
});

it('rejects old late-resolved history without a waterline, but accepts timestamped new receipt or known-path append', async () => {
  const file = join(directory, 'late-resolved.jsonl');
  const untimed = { type: 'user', message: { role: 'user', content: 'ok' } };
  writeFileSync(file, line(untimed) + line({ ...untimed, timestamp: '1970-01-01T00:00:01.000Z' }));
  let path: string | undefined;
  const tail = new JsonlTailer({ resolvePath: () => path, mapEntry: () => undefined, inputText: claudeInputText }); sources.push(tail);
  await tail.flush(); let confirmed = false;
  const pending = tail.waitForInput('ok', new AbortController().signal).then(() => { confirmed = true; });
  path = file; await tail.flush(); expect(confirmed).toBe(false);
  appendFileSync(file, line(user('ok'))); await tail.flush(); await pending; expect(confirmed).toBe(true);
  // With a known session path the exact byte waterline proves a new record,
  // including compatible older dialects which have no timestamp field.
  const next = tail.waitForInput('ok', new AbortController().signal);
  appendFileSync(file, line(untimed)); await tail.flush(); await next;
});

it('never uses a sibling path or late cancelled callback to acknowledge a turn', async () => {
  const first = join(directory, 'bound.jsonl'), sibling = join(directory, 'sibling.jsonl');
  writeFileSync(first, ''); writeFileSync(sibling, ''); let path = first;
  const tail = new JsonlTailer({ resolvePath: () => path, mapEntry: () => undefined, inputText: claudeInputText }); sources.push(tail);
  await tail.flush(); const controller = new AbortController();
  const pending = tail.waitForInput('ok', controller.signal); void pending.catch(() => {});
  path = sibling; await tail.flush(); appendFileSync(sibling, line(user('ok'))); await tail.flush();
  controller.abort(new Error('cancelled')); await expect(pending).rejects.toThrow('cancelled');
  const next = tail.waitForInput('next', new AbortController().signal);
  appendFileSync(sibling, line(user('ok'))); await tail.flush();
  appendFileSync(sibling, line(user('next'))); await tail.flush(); await next;
});

it('binds shared history to native session and second-resolution time; missing time is insufficient', async () => {
  const historyPath = join(directory, 'history.jsonl'), rolloutPath = join(directory, 'rollout.jsonl');
  writeFileSync(historyPath, ''); writeFileSync(rolloutPath, '');
  const history = new CodexInputReceipt(historyPath, () => 'native-one');
  const rollout = new JsonlTailer({ resolvePath: () => rolloutPath, mapEntry: () => undefined, inputText: codexInputText });
  sources.push(history, rollout); await history.flush(); await rollout.flush();
  let confirmed = false;
  const pending = history.waitForInput(rollout, 'ok', new AbortController().signal).then(() => { confirmed = true; });
  appendFileSync(historyPath, [
    { session_id: 'native-one', ts: 1, text: 'ok' },
    { session_id: 'sibling', ts: Math.floor(Date.now() / 1000), text: 'ok' },
    { session_id: 'native-one', text: 'ok' },
  ].map(line).join(''));
  await history.flush(); expect(confirmed).toBe(false);
  appendFileSync(historyPath, line({ session_id: 'native-one', ts: Math.floor(Date.now() / 1000), text: 'ok' }));
  await history.flush(); await pending; expect(confirmed).toBe(true);
});
