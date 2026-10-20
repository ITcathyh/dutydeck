import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PtyLike } from '../types.js';
import { createOpenCodeAdapter } from './opencode.js';
import { createOpenCode2Adapter } from './opencode2.js';

const prompts = [
  { name: 'empty', prompt: '', paste: false },
  { name: 'short', prompt: 'hello', paste: false },
  { name: '150 characters', prompt: 'a'.repeat(150), paste: false },
  { name: '151 characters', prompt: 'a'.repeat(151), paste: true },
  { name: 'multiline', prompt: 'first\nsecond', paste: true },
  { name: 'long slash command', prompt: '/' + 'a'.repeat(150), paste: true },
  { name: 'multiline slash command', prompt: '/first\nsecond', paste: true },
];
const cases = Array.from({ length: 8 }, (_, capabilities) => capabilities)
  .flatMap(capabilities => [undefined, false].flatMap(response => prompts.map(prompt => ({
    ...prompt, capabilities, response,
    label: `${prompt.name}, capabilities=${capabilities}, return=${response}`,
  }))));

describe.each([createOpenCodeAdapter(), createOpenCode2Adapter()])('$id prompt submission', adapter => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
  afterEach(() => { vi.useRealTimers(); });

  it.each(cases)('$label', async ({ prompt, paste, capabilities, response }) => {
    const calls: Array<{ method: string; data: string; at: number }> = [];
    const record = (method: string) => function (this: PtyLike, data: string) {
      expect(this).toBe(backend);
      calls.push({ method, data, at: Date.now() });
      return response;
    };
    const backend: PtyLike = { write: record('write') };
    const sendText = Boolean(capabilities & 1), pasteText = Boolean(capabilities & 2), specialKeys = Boolean(capabilities & 4);
    if (sendText) backend.sendText = record('sendText');
    if (pasteText) Object.assign(backend, { pasteText: record('pasteText') });
    if (specialKeys) backend.sendSpecialKeys = record('sendSpecialKeys');

    const keyed = sendText && specialKeys;
    const usePaste = keyed && pasteText && paste && !(adapter.id === 'opencode2' && prompt.startsWith('/'));
    const input = { method: keyed ? usePaste ? 'pasteText' : 'sendText' : 'write', data: prompt, at: 0 };
    const wait = keyed ? 200 : 1000;
    const writing = adapter.writeInput(backend, prompt);
    await vi.advanceTimersByTimeAsync(wait - 1);
    expect(calls).toEqual([input]);
    await vi.advanceTimersByTimeAsync(1);
    await writing;
    expect(calls).toEqual([
      input,
      { method: keyed ? 'sendSpecialKeys' : 'write', data: keyed ? 'Enter' : '\r', at: wait },
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
