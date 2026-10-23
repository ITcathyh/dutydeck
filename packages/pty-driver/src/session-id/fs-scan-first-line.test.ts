import { afterEach, expect, it, vi } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, readSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFirstLine } from './fs-scan.js';
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>();
  return { ...actual, readSync: vi.fn(actual.readSync) };
});
const roots: string[] = [];
afterEach(() => { vi.clearAllMocks(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
function file(text: string) {
  const root = mkdtempSync(join(tmpdir(), 'dd-first-line-')); roots.push(root);
  const path = join(root, 'rollout.jsonl'); writeFileSync(path, text); return path;
}
it('stops after one block for a short metadata line followed by megabytes of output', () => {
  const line = JSON.stringify({ type: 'session_meta', payload: { id: 'native' } });
  expect(readFirstLine(file(line + '\n' + 'x'.repeat(2 * 1024 * 1024)), 1024 * 1024)).toBe(line);
  expect(readSync).toHaveBeenCalledTimes(1);
  expect(vi.mocked(readSync).mock.calls[0]![3]).toBe(4096);
});
it('preserves real TraeX metadata with its original large catalog size and split UTF-8', () => {
  const real = JSON.parse(readFileSync(new URL('../transcript/fixtures/traex-0.207.1-terminal.jsonl', import.meta.url), 'utf8').split('\n')[0]!);
  real.payload.model_catalog_snapshot.sanitized_padding = '';
  const paddingBytes = 353510 - Buffer.byteLength(JSON.stringify(real));
  real.payload.model_catalog_snapshot.sanitized_padding = '相'.repeat(Math.floor(paddingBytes / 3)) + 'x'.repeat(paddingBytes % 3);
  const line = JSON.stringify(real); expect(Buffer.byteLength(line)).toBe(353510);
  expect(readFirstLine(file(line + '\n'), 1024 * 1024)).toBe(line);
});
it('rejects incomplete and over-budget first lines but observes a subsequently completed line', () => {
  const path = file('{"type":"session_meta"}');
  expect(readFirstLine(path, 1024 * 1024)).toBe('');
  appendFileSync(path, '\n'); expect(readFirstLine(path, 1024 * 1024)).toBe('{"type":"session_meta"}');
  expect(readFirstLine(file('x'.repeat(1024 * 1024) + '\n'), 1024 * 1024)).toBe('');
});
