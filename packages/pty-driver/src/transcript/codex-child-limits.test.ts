import { afterEach, expect, it, vi } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NormalizedDriverEvent } from '@dutydeck/shared';
import { CodexTranscriptTailer } from './codex.js';

const parent = '11111111-1111-4111-8111-111111111111';
const child = '22222222-2222-4222-8222-222222222222';
const roots: string[] = [], tails: CodexTranscriptTailer[] = [];
afterEach(() => { tails.splice(0).forEach(t => t.stop()); vi.restoreAllMocks(); roots.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); });
const line = (value: unknown) => JSON.stringify(value) + '\n';
const event = (type: string, turn_id: string, fields = {}) => ({ type: 'event_msg', timestamp: new Date(Date.now()).toISOString(), payload: { type, turn_id, ...fields } });
const started = (fields = {}) => event('item_completed', 'parent-turn', { thread_id: parent, started_at_ms: Date.now() - 1000,
  item: { type: 'SubAgentActivity', kind: 'started', id: 'activity-child', agent_thread_id: child }, ...fields });
const terminal = (turn = 'child-turn', error: unknown = { codex_error_info: 'usage_limit_exceeded', message: 'sensitive upstream body' }) => event('task_complete', turn, { error });

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dd-child-limit-')); roots.push(root);
  const now = new Date();
  const day = join(root, 'sessions', String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'));
  mkdirSync(day, { recursive: true });
  const path = join(day, `rollout-parent-${parent}.jsonl`), childPath = join(day, `rollout-child-${child}.jsonl`);
  writeFileSync(path, line({ type: 'session_meta', payload: { id: parent } }));
  const tail = new CodexTranscriptTailer({ cwd: root, transcriptPath: path, env: { CODEX_HOME: root } }); tails.push(tail);
  const events: NormalizedDriverEvent[] = []; tail.onEvent(e => events.push(e));
  await tail.flush();
  const receipt = tail.waitForInput('question', new AbortController().signal);
  appendFileSync(path, line(event('task_started', 'parent-turn')) + line(event('user_message', 'parent-turn', { message: 'question' })));
  await tail.flush(); await receipt;
  return { root, day, path, childPath, tail, events,
    child: (records = [event('task_started', 'child-turn'), terminal()], metadata = {}) => writeFileSync(childPath,
      line({ type: 'session_meta', payload: { id: child, parent_thread_id: parent, ...metadata } }) + records.map(line).join('')) };
}

it('emits a visible child quota diagnostic while the parent remains active and may succeed', async () => {
  const h = await fixture(); h.child(); appendFileSync(h.path, line(started())); await h.tail.flush();
  const diagnostics = h.events.filter(e => e.data.diagnostic === 'child_quota');
  expect(diagnostics).toEqual([expect.objectContaining({ type: 'status', sourceId: expect.any(String), data: expect.objectContaining({
    activityId: 'activity-child', state: 'child_quota', name: '子任务额度诊断', status: 'failed', code: 'usage_limit_exceeded', output: expect.stringContaining('父任务继续')
  }) })]);
  expect(JSON.stringify(diagnostics)).not.toContain('sensitive upstream body');
  expect(h.tail.hasTurnTerminal()).toBe(false); expect(h.tail.takeInputError()).toBeUndefined();
  appendFileSync(h.path, line(event('task_complete', 'parent-turn', { last_agent_message: 'parent success' }))); await h.tail.flush();
  expect(h.tail.hasTurnTerminal()).toBe(true); expect(h.tail.takeInputError()).toBeUndefined();
  expect(h.events.filter(e => e.type === 'text').map(e => e.data.text)).toEqual(['parent success']);
});

it.each([
  { forked_from_id: parent },
  { parent_thread_id: '33333333-3333-4333-8333-333333333333' },
  { id: '33333333-3333-4333-8333-333333333333' },
  { source: { subagent: { thread_spawn: { parent_thread_id: 'foreign' } } } }
])('ignores unproven fork, foreign child, grandchild or mismatched metadata %j', async metadata => {
  const h = await fixture(); h.child(undefined, metadata); appendFileSync(h.path, line(started())); await h.tail.flush();
  expect(h.events.filter(e => e.data.diagnostic)).toEqual([]);
  expect(h.tail.takeInputError()).toBeUndefined();
});

it('excludes fork-inherited failures and requires an own native child turn', async () => {
  const h = await fixture();
  h.child([event('task_started', 'inherited'), terminal('inherited'), event('task_started', 'child-turn'), terminal()],
    { forked_from_id: parent, subagent_history_start_ordinal: 3 });
  appendFileSync(h.path, line(started())); await h.tail.flush();
  expect(h.events.filter(e => e.data.diagnostic)).toHaveLength(1);
  expect(h.events.find(e => e.data.diagnostic)?.data.childTurnId).toBe('child-turn');
});

it('rejects old parent turns/foreign threads, transient rate snapshots and foreign child terminals', async () => {
  const h = await fixture();
  h.child([{ ...event('task_started', 'old-child-turn'), timestamp: new Date(Date.now() - 5000).toISOString() }, terminal('old-child-turn'),
    event('task_started', 'child-turn'), terminal('other-turn')]);
  appendFileSync(h.path, line(started({ turn_id: 'old-parent' })) + line(started({ thread_id: 'foreign-parent' }))
    + line(event('token_count', 'parent-turn', { rate_limits: { primary: { used_percent: 100 } } })));
  await h.tail.flush(); expect(h.events.filter(e => e.data.diagnostic)).toEqual([]);
  appendFileSync(h.path, line(started())); await h.tail.flush();
  expect(h.events.filter(e => e.data.diagnostic)).toEqual([]);
});

it('deduplicates across polls, ignores completed parents and does not replay children before a recovery cursor', async () => {
  const h = await fixture(); h.child(); appendFileSync(h.path, line(started())); await h.tail.flush();
  const cursor = h.tail.checkpoint(); h.tail.stop();
  const restored = new CodexTranscriptTailer({ cwd: h.root, transcriptPath: h.path, env: { CODEX_HOME: h.root } }); tails.push(restored);
  const events: NormalizedDriverEvent[] = []; restored.onEvent(e => events.push(e)); restored.restore(cursor); await restored.flush();
  const time = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(time + 3000);
  await restored.flush(); expect(events.filter(e => e.data.diagnostic)).toEqual([]);
  expect(h.events.filter(e => e.data.diagnostic)).toHaveLength(1);
});

it('distinguishes request rate limits from quota and deduplicates repeated child terminals', async () => {
  const h = await fixture(); h.child([event('task_started', 'child-turn'), terminal('child-turn', { message: '429 rate limit secret' }), terminal('child-turn')]);
  appendFileSync(h.path, line(started())); await h.tail.flush();
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3000); await h.tail.flush();
  expect(h.events.filter(e => e.data.diagnostic)).toEqual([expect.objectContaining({ data: expect.objectContaining({ diagnostic: 'child_rate_limit', code: 'rate_limit' }) })]);
  expect(JSON.stringify(h.events.filter(e => e.data.diagnostic))).not.toContain('secret');
});

it('keeps a new diagnostic distinct on a different parent turn', async () => {
  const h = await fixture(); h.child(); appendFileSync(h.path, line(started())); await h.tail.flush();
  const first = h.events.find(e => e.data.diagnostic)!;
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3000);
  h.child([event('task_started', 'new-child-turn'), terminal('new-child-turn')]);
  const receipt = h.tail.waitForInput('next question', new AbortController().signal);
  appendFileSync(h.path, line(event('task_started', 'next-parent')) + line(event('user_message', 'next-parent', { message: 'next question' }))
    + line(started({ turn_id: 'next-parent' })));
  await h.tail.flush(); await receipt;
  const diagnostics = h.events.filter(e => e.data.diagnostic);
  expect(diagnostics).toHaveLength(2); expect(diagnostics[1]!.sourceId).not.toBe(first.sourceId);
});

it('does not publish a child failure after final text and terminal enter the same parent flush', async () => {
  const h = await fixture(); h.child();
  appendFileSync(h.path, line(started()) + line({ type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final', content: [{ type: 'output_text', text: 'final success' }] } })
    + line(event('task_complete', 'parent-turn', { last_agent_message: 'final success' })));
  await h.tail.flush();
  expect(h.tail.hasTurnTerminal()).toBe(true); expect(h.tail.takeInputError()).toBeUndefined();
  expect(h.events.filter(e => e.data.diagnostic)).toEqual([]);
  expect(h.events.filter(e => e.type === 'text').map(e => e.data.text)).toEqual(['final success']);
});

it('does not publish a late child terminal on polls after the parent completed', async () => {
  const h = await fixture(); h.child([event('task_started', 'child-turn')]);
  appendFileSync(h.path, line(started())); await h.tail.flush();
  appendFileSync(h.path, line(event('task_complete', 'parent-turn', { last_agent_message: 'completed' }))); await h.tail.flush();
  appendFileSync(h.childPath, line(terminal()));
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3000); await h.tail.flush();
  expect(h.events.filter(e => e.data.diagnostic)).toEqual([]); expect(h.tail.takeInputError()).toBeUndefined();
});
