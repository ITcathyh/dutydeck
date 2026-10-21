import { afterEach, expect, it, vi } from 'vitest';
import { codexExistingModelKeys, pollScreenReady } from './adapters/screen-ready-helper.js';

const menu = 'Meet GPT-6 Sol\n› 1. Try new model\n  2. Use existing model\nenter/esc confirm · ^c quit';
afterEach(() => vi.useRealTimers());
it('only selects the existing model on a positive active picker', () => {
  expect(codexExistingModelKeys(menu)).toEqual(['Down', 'Enter']);
  expect(codexExistingModelKeys(menu.replace('› 1.', '  1.').replace('  2.', '› 2.'))).toEqual(['Enter']);
  expect(codexExistingModelKeys(menu.replace('› ', ''))).toBeUndefined();
  expect(codexExistingModelKeys(menu + '\n› Ask Codex')).toBeUndefined();
  expect(codexExistingModelKeys(menu.replace('enter/esc confirm · ^c quit', 'gpt-6-sol · /workspace'))).toBeUndefined();
  expect(codexExistingModelKeys(menu.replace('Use existing model', 'Choose another model'))).toBeUndefined();
});
it('waits for a subsequent composer after accepting the existing model', async () => {
  vi.useFakeTimers(); let screen = menu, ready = false;
  const keys = vi.fn();
  const pending = pollScreenReady({ write() {}, readScreen: () => screen, sendSpecialKeys: keys }, 'Codex').then(() => { ready = true; });
  await vi.advanceTimersByTimeAsync(100);
  expect(keys).toHaveBeenCalledExactlyOnceWith('Down', 'Enter'); expect(ready).toBe(false);
  screen = 'Codex\n› Ask Codex'; await vi.advanceTimersByTimeAsync(100); await pending;
});
it('bounds menu attempts and never writes task text into an unresolved picker', async () => {
  vi.useFakeTimers(); const write = vi.fn();
  const pending = pollScreenReady({ write, readScreen: () => menu }, 'Codex');
  const failure = expect(pending).rejects.toThrow('启动尚未就绪');
  await vi.advanceTimersByTimeAsync(30_100); await failure;
  expect(write.mock.calls).toEqual(Array.from({ length: 3 }, () => ['\x1b[B\r']));
});
