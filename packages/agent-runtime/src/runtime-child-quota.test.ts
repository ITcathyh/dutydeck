import { afterEach, expect, it, vi } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCliAdapter } from '@dutydeck/cli-adapters';
import type { SessionBackend } from '@dutydeck/session-backends';
import { agentConfigSchema } from '@dutydeck/shared';
import { createRepositories } from '@dutydeck/storage';
import { PtyCliDriver } from '../../pty-driver/src/driver.js';
import { buildTimeline, buildTimelineSections, createTimelineProjector } from '../../../apps/web/src/timeline.js';
import { renderLarkProcessElements, renderLarkResultElements } from '../../../apps/server/src/lark/card-renderer.js';
import { DutydeckRuntime } from './index.js';

const releases: Array<() => Promise<void>> = [];
afterEach(async () => { for (const release of releases.splice(0).reverse()) await release(); });
const line = (record: unknown) => JSON.stringify(record) + '\n';
const thread = '11111111-1111-4111-8111-111111111111';
const record = (type: string, turnId: string, extra: Record<string, unknown> = {}) => ({ type: 'event_msg', timestamp: new Date().toISOString(), payload: { type, turn_id: turnId, ...extra } });
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'dd-runtime-pty-terminal-'));
  releases.push(async () => rmSync(dir, { recursive: true, force: true }));
  const root = dir;
  const date = new Date();
  const day = join(root, 'sessions', String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0'));  mkdirSync(day, { recursive: true });
  const path = join(day, `rollout-2026-10-15T10-00-00-${thread}.jsonl`);
  writeFileSync(path, line({ type: 'session_meta', payload: { id: thread, cwd: dir } }));
  writeFileSync(join(root, 'history.jsonl'), '');
  const writes: string[] = [];
  let paint!: (data: string) => void;
  let currentTurn = '';
  const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' });
  const runtime = new DutydeckRuntime(repos, {
    probe: () => ({ protocol: 'pty-cli', available: true, pause: false, resume: true }),
    driverFactory: (agent, _protocol, onEvent, onExit, sessionId) => {
      const backend: SessionBackend = { kind: 'pty', spawn() {}, write() {}, resize() {}, kill() {}, interrupt() {}, onData(cb) { paint = cb; }, onExit() {} };
      const adapter = createCliAdapter('codex');
      const driver = new PtyCliDriver({ agent, adapter: { ...adapter, prepareInput: undefined, writeInput(_backend, prompt) {
        writes.push(prompt); currentTurn = `native-turn-${writes.length}`;
        appendFileSync(join(root, 'history.jsonl'), line({ session_id: thread, ts: Date.now() / 1000, text: prompt }));
        appendFileSync(path, line(record('task_started', currentTurn)) + line(record('user_message', currentTurn, { message: prompt })));
      } }, backend, sessionId, onEvent, onExit });
      return driver;
    },
  });
  releases.push(async () => { await runtime.shutdown(); repos.close(); });
  const agent = agentConfigSchema.parse({ id: 'codex', name: 'Codex', command: 'unused-fixture', args: [], protocol: 'pty-cli', cwd: dir,
    env: { CODEX_HOME: dir }, permissionMode: 'full-trust', timeout: 10, capabilities: { pause: false, resume: true } });
  await runtime.initialize([agent]);
  const session = await runtime.start({ agentId: 'codex' });
  return { runtime, repos, session, path, day, paint: (text: string) => paint(`\x1b[2J\x1b[H${text.replaceAll('\n', '\r\n')}`),
    turn: () => currentTurn,
    send: async (text = 'question') => {
      const pending = runtime.send(session.id, text); void pending.catch(() => {});
      const count = writes.length;
      await vi.waitFor(() => expect(writes).toHaveLength(count + 1));
      return { pending };
    },
  };
}


// Synthetic terminal errors use the verified upstream Codex 0.156 shape;
// parent activity/child metadata match the local 0.162.1 structural sample.
it.each(['usage_limit_exceeded', 'rate_limit'])('shows child %s in Web/Lark while the real Runtime keeps the parent running and then succeeds', async code => {
  const h = await fixture(), { pending } = await h.send();
  const child = '22222222-2222-4222-8222-222222222222';
  const childPath = join(h.day, `rollout-child-${child}.jsonl`);
  writeFileSync(childPath, line({ type: 'session_meta', payload: { id: child, parent_thread_id: thread } })
    + line(record('task_started', 'child-turn'))
    + line(record('task_complete', 'child-turn', { error: { codex_error_info: code, message: 'do-not-display-upstream-body' } })));
  appendFileSync(h.path, line(record('item_completed', h.turn(), { thread_id: thread, started_at_ms: Date.now() - 1000,
    item: { type: 'SubAgentActivity', kind: 'started', id: 'real-activity', agent_thread_id: child } })));
  await vi.waitFor(async () => {
    const events = await h.runtime.getEvents(h.session.id);
    expect(events.some(e => (e.data as any).diagnostic)).toBe(true);
  }, { timeout: 5000 });
  const running = (await h.runtime.getTasks(h.session.id)).at(-1)!;
  expect(running.status).toBe('running');
  const events = await h.runtime.getEvents(h.session.id);
  expect(events.filter(e => e.type === 'error')).toEqual([]);
  expect(events.filter(e => e.type === 'completed')).toEqual([]);
  const warning = events.find(e => (e.data as any).diagnostic)!;
  expect(warning.type).toBe('status');
  expect(events.filter(e => e.type === 'tool_result')).toEqual([]);
  expect((warning.data as any).output).toContain('父任务继续');
  const project = createTimelineProjector();
  const before = events.filter(e => e.sequence < warning.sequence);
  project(before as any);
  const web = project(events as any, [], false, { previousEvents: before as any, changes: events.filter(e => e.sequence >= warning.sequence) as any }).timeline;
  expect(web.some(e => e.type === 'tool_result' && e.data.diagnostic)).toBe(true);
  const card = JSON.stringify(renderLarkProcessElements(events, { traceLimit: 20, compactTrace: false, hideTraceOnComplete: false }));
  expect(card).toContain('子任务额度诊断'); expect(card).toContain('父任务继续');
  expect(card).not.toContain('do-not-display-upstream-body');
  await new Promise(resolve => setTimeout(resolve, 2100));
  expect((await h.runtime.getEvents(h.session.id)).filter(e => (e.data as any).diagnostic)).toHaveLength(1);
  appendFileSync(h.path, line(record('task_complete', h.turn(), { last_agent_message: '父任务正常完成' })));
  h.paint('父任务正常完成\n› \n100% context left');
  expect((await pending).status).toBe('completed');
  expect(h.repos.execution.getTaskExecution(running.id)?.currentAttempt?.outcome).toBe('completed');
  const completedEvents = await h.runtime.getEvents(h.session.id);
  expect(JSON.stringify(renderLarkProcessElements(completedEvents, { traceLimit: 20, compactTrace: false, hideTraceOnComplete: false }, true))).toContain('父任务继续');
  expect(renderLarkResultElements(completedEvents).find(e => e.element_id === 'final_output')?.content).toBe('父任务正常完成');
});

it('preserves parent success when final output and a late child failure are drained together', async () => {
  const h = await fixture(), { pending } = await h.send();
  const child = '22222222-2222-4222-8222-222222222222';
  writeFileSync(join(h.day, `rollout-child-${child}.jsonl`), line({ type: 'session_meta', payload: { id: child, parent_thread_id: thread } })
    + line(record('task_started', 'child-turn')) + line(record('task_complete', 'child-turn', { error: { codex_error_info: 'usage_limit_exceeded' } })));
  appendFileSync(h.path, line(record('item_completed', h.turn(), { thread_id: thread, started_at_ms: Date.now() - 1000,
    item: { type: 'SubAgentActivity', kind: 'started', id: 'late-activity', agent_thread_id: child } }))
    + line(record('task_complete', h.turn(), { last_agent_message: '最终成功' })));
  h.paint('最终成功\n› \n100% context left');
  expect((await pending).status).toBe('completed');
  expect((await h.runtime.getEvents(h.session.id)).filter(e => (e.data as any).diagnostic)).toEqual([]);
});


it('preserves an already published parent final answer when a child diagnostic arrives before task_complete', async () => {
  const h = await fixture(), { pending } = await h.send();
  const answer = '父任务已给出的最终正文';
  appendFileSync(h.path, line({ type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final',
    content: [{ type: 'output_text', text: answer }] } }));
  await vi.waitFor(async () => expect((await h.runtime.getEvents(h.session.id)).some(e => e.type === 'text' && (e.data as any).text === answer)).toBe(true));
  const child = '22222222-2222-4222-8222-222222222222';
  writeFileSync(join(h.day, `rollout-child-${child}.jsonl`), line({ type: 'session_meta', payload: { id: child, parent_thread_id: thread } })
    + line(record('task_started', 'child-turn')) + line(record('task_complete', 'child-turn', { error: { codex_error_info: 'usage_limit_exceeded' } })));
  appendFileSync(h.path, line(record('item_completed', h.turn(), { thread_id: thread, started_at_ms: Date.now() - 1000,
    item: { type: 'SubAgentActivity', kind: 'started', id: 'between-final-terminal', agent_thread_id: child } })));
  await vi.waitFor(async () => expect((await h.runtime.getEvents(h.session.id)).some(e => (e.data as any).diagnostic)).toBe(true), { timeout: 5000 });
  expect((await h.runtime.getTasks(h.session.id)).at(-1)?.status).toBe('running');
  appendFileSync(h.path, line(record('task_complete', h.turn(), { last_agent_message: answer })));
  h.paint(`${answer}\n› \n100% context left`);
  await vi.waitFor(async () => expect((await h.runtime.getTasks(h.session.id)).at(-1)?.status).toBe('completed'), { timeout: 4000 });
  expect((await pending).status).toBe('completed');
  const events = await h.runtime.getEvents(h.session.id), tasks = await h.runtime.getTasks(h.session.id);
  expect(events.filter(e => e.type === 'text' && (e.data as any).text === answer)).toHaveLength(1);
  const sections = buildTimelineSections(buildTimeline(events as any), tasks as any);
  expect(sections.some(s => s.kind === 'event' && s.final && s.event.data.text === answer)).toBe(true);
  const card = JSON.stringify(renderLarkProcessElements(events, { traceLimit: 20, compactTrace: false, hideTraceOnComplete: false }));
  expect(card).toContain(answer); expect(card).toContain('父任务继续');
  expect(renderLarkResultElements(events).find(e => e.element_id === 'final_output')?.content).toBe(answer);
});
