import { afterEach, expect, it, vi } from 'vitest';
import { appendFileSync, mkdirSync, renameSync, symlinkSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { CodexChildLimits, childDiagnosticLimits } from './codex-child-limits.js';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); roots.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); });
const parent = '11111111-1111-4111-8111-111111111111', line = (value: unknown) => JSON.stringify(value) + '\n';
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dd-child-budget-')); roots.push(root);
  const time = Date.now(), date = new Date(time);
  const day = join(root, String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')); mkdirSync(day, { recursive: true });
  // Count/byte tests control elapsed time; the dedicated deadline test below
  // explicitly advances it. Host scheduling must not decide their outcome.
  vi.spyOn(performance, 'now').mockReturnValue(0);
  const reader = new CodexChildLimits(root); reader.observe({ type: 'session_meta', payload: { id: parent } }, true, undefined);
  const add = (index: number, body = '') => {
    const id = `22222222-2222-4222-8222-${String(index).padStart(12, '0')}`;
    const path = join(day, `rollout-child-${id}.jsonl`);
    reader.observe({ type: 'event_msg', timestamp: new Date(time).toISOString(), payload: { type: 'item_completed', started_at_ms: time - 1000, turn_id: 'parent-turn', thread_id: parent,
      item: { type: 'SubAgentActivity', id: `activity-${index}`, kind: 'started', agent_thread_id: id } } }, false, 'parent-turn');
    writeFileSync(path, line({ type: 'session_meta', payload: { id, parent_thread_id: parent } }) + body);
    return path;
  };
  const clock = vi.spyOn(Date, 'now').mockReturnValue(time);
  return { root, day, reader, add, advance: () => clock.mockReturnValue((clock() as number) + 2001) };
}
const failed = () => line({ type: 'event_msg', timestamp: new Date(Date.now()).toISOString(), payload: { type: 'task_started', turn_id: 'child-turn' } })
  + line({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'child-turn', error: { codex_error_info: 'usage_limit_exceeded' } } });

it('bounds children, directory queries and bytes; repeated polls are throttled and fair', () => {
  const h = fixture();
  for (let index = 0; index < 40; index++) h.add(index, failed());
  const first = h.reader.poll('parent-turn');
  expect(first.length).toBeGreaterThan(0); expect(first.length).toBeLessThanOrEqual(4);
  expect(h.reader.lastPoll.queries).toBeLessThanOrEqual(4);
  expect(h.reader.lastPoll.entries).toBeLessThanOrEqual(512);
  expect(h.reader.lastPoll.bytes).toBeLessThanOrEqual(4 * 65536);
  expect(h.reader.poll('parent-turn')).toEqual([]);
  const all = [...first];
  for (let tick = 0; tick < 20; tick++) { h.advance(); all.push(...h.reader.poll('parent-turn')); }
  expect(all).toHaveLength(childDiagnosticLimits.children);
  expect(new Set(all.map(event => event.sourceId)).size).toBe(all.length);
});

it('advances complete lines only, limits each file read and waits for a partial terminal', () => {
  const h = fixture();
  const padding = Array.from({ length: 800 }, () => line({ type: 'padding', payload: 'x'.repeat(100) })).join('');
  const path = h.add(1, padding);
  expect(h.reader.poll('parent-turn')).toEqual([]);
  expect(h.reader.lastPoll.bytes).toBe(65536);
  const terminal = failed();
  appendFileSync(path, terminal.slice(0, -2)); h.advance(); expect(h.reader.poll('parent-turn')).toEqual([]);
  appendFileSync(path, terminal.slice(-2)); h.advance(); expect(h.reader.poll('parent-turn')).toHaveLength(1);
});

it('bounds scanned entries and expires unresolved lookups', () => {
  const h = fixture();
  for (let index = 0; index < 600; index++) writeFileSync(join(h.day, `noise-${index}`), '');
  h.add(1, failed()); h.reader.poll('parent-turn');
  expect(h.reader.lastPoll.entries).toBeLessThanOrEqual(512);
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 120001);
  expect(h.reader.poll('parent-turn')).toEqual([]);
  expect(h.reader.lastPoll.bytes).toBe(0); clock.mockRestore();
});

it('checks the monotonic time budget before filesystem queries', () => {
  const h = fixture(); h.add(1, failed());
  let monotonic = 0; vi.spyOn(performance, 'now').mockImplementation(() => monotonic += 11);
  expect(h.reader.poll('parent-turn')).toEqual([]);
  expect(h.reader.lastPoll).toEqual({ queries: 0, entries: 0, bytes: 0 });
});

it('does not descend into nested child paths or follow symlink targets', () => {
  const h = fixture(), path = h.add(1, failed()), nested = join(h.day, 'nested'); mkdirSync(nested);
  const moved = join(nested, 'rollout-child.jsonl'); renameSync(path, moved); symlinkSync(moved, path);
  expect(h.reader.poll('parent-turn')).toEqual([]); expect(h.reader.lastPoll.bytes).toBe(0);
});
