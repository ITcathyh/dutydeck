import { expect, it, vi } from 'vitest';
import { createCliAdapter } from './factory.js';
import { isInputReady } from './adapters/screen-ready-helper.js';

// Captured footer/composer shape from Codex 0.159.3's native resume smoke;
// workspace, conversation title and response are harmless fixture values.
const ready = 'fixture answer\nWorked for 10s • 17:51\n› Ask Codex to do anything\nGPT-6-Astra low · /tmp/fixture/workspace · 执行隔离验收命令 ⚠ 2 warnings · f2 to view';
it('accepts the initialized Codex resume footer with a conversation title while retaining menu/busy guards', () => {
  expect(isInputReady(ready, 'Codex')).toBe(true);
  expect(isInputReady(ready.replace('› Ask Codex to do anything', '› 1. Approve and continue'), 'Codex')).toBe(false);
  expect(isInputReady('Review hooks\n' + ready, 'Codex')).toBe(false);
  expect(isInputReady('Working (esc to interrupt)\n' + ready, 'Codex')).toBe(false);
  expect(isInputReady(ready.replace('执行隔离验收命令', 'Working'), 'Codex')).toBe(false);
  expect(isInputReady(ready.replace('执行隔离验收命令', 'Select permissions'), 'Codex')).toBe(false);
  expect(isInputReady(ready.replace('/tmp/fixture/workspace', 'uninitialized'), 'Codex')).toBe(false);
});

it.each(['codex', 'traex'])('%s pastes one normalized message and preserves Unicode before submitting Enter', async id => {
  vi.useFakeTimers();
  try {
    const adapter = createCliAdapter(id), writes: string[] = [], keys: string[] = [];
    const pending = adapter.writeInput({ write(data) { writes.push(data); }, pasteText(text) { writes.push(text); }, sendSpecialKeys(...value) { keys.push(...value); } }, '中文👩‍💻\u200c\u200b\r\nsecond\rthird');
    await vi.advanceTimersByTimeAsync(1000); await pending;
    expect(writes).toEqual(['中文👩‍💻\u200c\u200b\nsecond\nthird']); expect(keys).toEqual(['Enter']);
    expect(adapter.capabilities.nativeInputReceipt).toBe(true);
  } finally { vi.useRealTimers(); }
});
