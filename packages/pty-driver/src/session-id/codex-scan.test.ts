import { afterEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSessionMarker, resolveCliSessionId } from './index.js';
import * as scan from './fs-scan.js';
vi.mock('./fs-scan.js', async original => {
  const actual = await original<typeof import('./fs-scan.js')>();
  return { ...actual, walkFiles: vi.fn(actual.walkFiles), nativeTranscriptObjects: vi.fn(actual.nativeTranscriptObjects), readTail: vi.fn(actual.readTail) };
});
const roots: string[] = [];
afterEach(() => { vi.clearAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const sessionId = 'ses_scan_priority_regression';
const modern = buildSessionMarker(sessionId);
const legacy = `[dutydeck-session:${sessionId}]`;
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'codex-scan-')); roots.push(home);
  const sessions = join(home, 'sessions'); mkdirSync(sessions);
  const write = (path: string, rows: unknown[]) => writeFileSync(path, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  return {
    resolve: () => resolveCliSessionId('codex', { sessionId, cwd: home, env: { CODEX_HOME: home } }),
    history: (rows: unknown[]) => write(join(home, 'history.jsonl'), rows),
    rollout: (id: string, texts: string[], mtime: number) => {
      const path = join(sessions, `rollout-${id}.jsonl`);
      write(path, [{ type: 'session_meta', payload: { id, cwd: home } }, ...texts.map(text => ({ type: 'response_item', payload: { type: 'message', role: 'user', content: text } }))]);
      utimesSync(path, mtime, mtime);
    },
  };
}
it('enumerates once and traverses each candidate once when all marker formats are missing', () => {
  const f = fixture(); for (let i = 0; i < 60; i++) f.rollout(`native-${i}`, ['unrelated input'], i + 1);
  f.history([{ session_id: 'other', text: 'unrelated input' }]);
  expect(f.resolve()).toBeUndefined();
  const traversed = vi.mocked(scan.nativeTranscriptObjects).mock.calls.map(([path]) => path);
  expect({ enumerations: vi.mocked(scan.walkFiles).mock.calls.length, traversals: traversed.length, historyReads: vi.mocked(scan.readTail).mock.calls.length })
    .toEqual({ enumerations: 1, traversals: 60, historyReads: 1 });
  expect(new Set(traversed).size).toBe(60);
});
it('prefers global modern then legacy then raw matches, regardless of file order', () => {
  const f = fixture(); f.rollout('raw', [sessionId], 3); f.rollout('legacy', [legacy], 2); f.rollout('modern', [modern], 1);
  f.history([{ session_id: 'history-legacy', text: legacy }]);
  expect(f.resolve()).toBe('modern');
  f.rollout('modern', ['unrelated'], 1);
  expect(f.resolve()).toBe('history-legacy');
  f.history([]); expect(f.resolve()).toBe('legacy');
  f.rollout('legacy', ['unrelated'], 2); expect(f.resolve()).toBe('raw');
});
it('finds a later modern marker in a file already containing legacy and raw matches', () => {
  const f = fixture(); f.rollout('native', [sessionId, legacy, modern], 1);
  f.history([{ session_id: 'legacy-history', text: legacy }]);
  expect(f.resolve()).toBe('native');
});
it('retains newest history, history-before-rollout and newest rollout ordering', () => {
  const f = fixture(); f.rollout('old', [modern], 1); f.rollout('new', [modern], 2);
  f.history([{ session_id: 'old-history', text: modern }, { session_id: 'new-history', text: modern }]);
  expect(f.resolve()).toBe('new-history');
  f.history([]); expect(f.resolve()).toBe('new');
});

it.each(['modern', 'legacy'])('ignores inherited %s parent ownership when a later child envelope exists', format => {
  const f = fixture(); const parentMarker = format === 'modern' ? modern : legacy;
  f.rollout('parent', [parentMarker], 1);
  f.rollout('child', [sessionId, parentMarker, buildSessionMarker('ses_native_child_ownership')], 2);
  expect(f.resolve()).toBe('parent');
});
it.each([[modern, legacy], [modern + '\n' + legacy]])('retains modern priority when the same ownership repeats in legacy form: %j', (...texts) => {
  const f = fixture(); f.rollout('native', texts, 1);
  f.history([{ session_id: 'legacy-history', text: legacy }]);
  expect(f.resolve()).toBe('native');
});
