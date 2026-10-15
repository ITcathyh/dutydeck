import { afterEach, expect, it, vi } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCliAdapter } from '@dutydeck/cli-adapters';
import type { SessionBackend } from '@dutydeck/session-backends';
import { agentConfigSchema } from '@dutydeck/shared';
import { createRepositories } from '@dutydeck/storage';
import { PtyCliDriver } from '../../pty-driver/src/driver.js';
import { DutydeckRuntime } from './index.js';

const releases: Array<() => Promise<void>> = [];
afterEach(async () => { for (const release of releases.splice(0).reverse()) await release(); });
const line = (record: unknown) => JSON.stringify(record) + '\n';
const thread = '11111111-1111-4111-8111-111111111111';
const record = (type: string, turnId: string, extra: Record<string, unknown> = {}) => ({ type: 'event_msg', timestamp: new Date().toISOString(), payload: { type, turn_id: turnId, ...extra } });
async function fixture(kind: 'codex' | 'traex') {
  const dir = mkdtempSync(join(tmpdir(), 'dd-runtime-pty-terminal-'));
  releases.push(async () => rmSync(dir, { recursive: true, force: true }));
  const root = kind === 'traex' ? join(dir, 'cli') : dir;
  const day = join(root, 'sessions', '2026', '10', '15'); mkdirSync(day, { recursive: true });
  const path = join(day, `rollout-2026-10-15T10-00-00-${thread}.jsonl`);
  writeFileSync(path, line({ type: 'session_meta', payload: { id: thread, cwd: dir } }));
  writeFileSync(join(root, 'history.jsonl'), '');
  const writes: string[] = [], drivers: PtyCliDriver[] = [];
  let paint!: (data: string) => void;
  let currentTurn = '';
  const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' });
  const runtime = new DutydeckRuntime(repos, {
    probe: () => ({ protocol: 'pty-cli', available: true, pause: false, resume: true }),
    driverFactory: (agent, _protocol, onEvent, onExit, sessionId) => {
      const backend: SessionBackend = { kind: 'pty', spawn() {}, write() {}, resize() {}, kill() {}, interrupt() {}, onData(cb) { paint = cb; }, onExit() {} };
      const adapter = createCliAdapter(kind);
      const driver = new PtyCliDriver({ agent, adapter: { ...adapter, prepareInput: undefined, writeInput(_backend, prompt) {
        writes.push(prompt); currentTurn = `native-turn-${writes.length}`;
        appendFileSync(join(root, 'history.jsonl'), line({ session_id: thread, ts: Date.now() / 1000, text: prompt }));
        appendFileSync(path, line(record('task_started', currentTurn)) + line(record('user_message', currentTurn, { message: prompt })));
      } }, backend, sessionId, onEvent, onExit });
      drivers.push(driver); return driver;
    },
  });
  releases.push(async () => { await runtime.shutdown(); repos.close(); });
  const agent = agentConfigSchema.parse({ id: kind, name: kind, command: 'unused-fixture', args: [], protocol: 'pty-cli', cwd: dir,
    env: kind === 'codex' ? { CODEX_HOME: dir } : { TRAE_HOME: dir }, permissionMode: 'full-trust', timeout: 10, capabilities: { pause: false, resume: true } });
  await runtime.initialize([agent]);
  const session = await runtime.start({ agentId: kind });
  return { runtime, repos, session, path, writes, drivers, paint: (text: string) => paint(`\x1b[2J\x1b[H${text.replaceAll('\n', '\r\n')}`),
    turn: () => currentTurn,
    send: async (text = 'question') => {
      const pending = runtime.send(session.id, text); void pending.catch(() => {});
      const count = writes.length;
      await vi.waitFor(() => expect(writes).toHaveLength(count + 1));
      return { pending };
    },
  };
}

it.each(['codex', 'traex'] as const)('%s settles textless quota failure through the real PTY driver and Runtime ledger', async kind => {
  const h = await fixture(kind), { pending } = await h.send();
  appendFileSync(h.path, line(record('task_complete', h.turn(), { last_agent_message: null, error: { codex_error_info: 'usage_limit_exceeded', message: 'Usage exhausted' } })));
  const task = await pending;
  expect(task.status).toBe('failed');
  expect(h.repos.execution.getTaskExecution(task.id)?.currentAttempt).toMatchObject({ state: 'settled', outcome: 'failed' });
  const events = await h.runtime.getEvents(h.session.id);
  expect(events.filter(e => e.type === 'error')).toEqual([expect.objectContaining({ data: expect.objectContaining({ code: 'usage_limit_exceeded', retryable: false }) })]);
  expect(events.filter(e => e.type === 'completed')).toHaveLength(1);
});

it.each(['codex', 'traex'] as const)('%s cannot turn partial output plus native error into success after a late idle or mirrored final', async kind => {
  const h = await fixture(kind), { pending } = await h.send();
  appendFileSync(h.path, line({ type: 'response_item', payload: { type: 'message', phase: 'final', role: 'assistant', content: [{ type: 'output_text', text: 'partial answer' }] } })
    + line(record('task_complete', h.turn(), { last_agent_message: 'partial answer', error: { message: 'backend failed' } })));
  const task = await pending; expect(task.status).toBe('failed');
  h.paint(kind === 'traex' ? 'partial answer\n❯ Ask TraeCode CLI\nContext 100% left' : 'partial answer\n› \n100% context left');
  appendFileSync(h.path, line(record('task_complete', h.turn(), { last_agent_message: 'partial answer' })));
  await new Promise(resolve => setTimeout(resolve, 700));
  expect(h.repos.execution.getTaskExecution(task.id)?.task.status).toBe('failed');
  const events = await h.runtime.getEvents(h.session.id);
  expect(events.filter(e => e.type === 'completed')).toHaveLength(1);
  expect(events.filter(e => e.type === 'text' && (e.data as any).role !== 'user').map(e => (e.data as any).text)).toEqual(['partial answer']);
});

it.each(['codex', 'traex'] as const)('%s rejects foreign/old errors on the next input and settles native cancellation as interrupted', async kind => {
  const h = await fixture(kind), first = await h.send();
  const oldTurn = h.turn();
  appendFileSync(h.path, line(record('turn_aborted', oldTurn, { reason: 'interrupted' })));
  const cancelled = await first.pending;
  expect(cancelled.status).toBe('interrupted');
  const second = await h.send('next question');
  appendFileSync(h.path, line(record('task_complete', oldTurn, { error: { message: 'late old error' } }))
    + line(record('task_complete', 'foreign-turn', { error: { message: 'foreign error' } })));
  await new Promise(resolve => setTimeout(resolve, 400));
  expect(h.repos.execution.getTaskExecution(cancelled.id)?.currentAttempt?.outcome).toBe('interrupted');
  expect((await h.runtime.getTasks(h.session.id)).at(-1)?.status).toBe('running');
  appendFileSync(h.path, line(record('task_complete', h.turn(), { last_agent_message: '', error: { message: '429 rate limit' } })));
  const task = await second.pending; expect(task.status).toBe('failed');
  const errors = (await h.runtime.getEvents(h.session.id)).filter(e => e.type === 'error');
  expect(errors).toEqual([expect.objectContaining({ data: expect.objectContaining({ code: 'rate_limit', retryable: true }) })]);
});


it.each(['codex', 'traex'] as const)('%s waits past the legacy terminal grace for a late failure on an already idle screen', async kind => {
  const h = await fixture(kind), { pending } = await h.send();
  appendFileSync(h.path, line({ type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final', content: [{ type: 'output_text', text: 'partial before terminal' }] } }));
  h.paint(kind === 'traex' ? 'partial before terminal\n❯ Ask TraeCode CLI\nContext 100% left' : 'partial before terminal\n› \n100% context left');
  await new Promise(resolve => setTimeout(resolve, 4_600));
  expect((await h.runtime.getTasks(h.session.id)).at(-1)?.status).toBe('running');
  appendFileSync(h.path, line(record('task_complete', h.turn(), { last_agent_message: 'partial before terminal', error: { message: 'late backend error' } })));
  const task = await pending; expect(task.status).toBe('failed');
  expect((await h.runtime.getEvents(h.session.id)).filter(e => e.type === 'completed')).toHaveLength(1);
});

it.each(['codex', 'traex'] as const)('%s settles a late empty success terminal against the existing screen without another redraw', async kind => {
  const h = await fixture(kind), { pending } = await h.send();
  appendFileSync(h.path, line({ type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final', content: [{ type: 'output_text', text: 'complete answer' }] } }));
  h.paint(kind === 'traex' ? 'complete answer\n❯ Ask TraeCode CLI\nContext 100% left' : 'complete answer\n› \n100% context left');
  await new Promise(resolve => setTimeout(resolve, 2_500));
  expect((await h.runtime.getTasks(h.session.id)).at(-1)?.status).toBe('running');
  appendFileSync(h.path, line(record('task_complete', h.turn(), { last_agent_message: '' })));
  const task = await pending; expect(task.status).toBe('completed');
  const next = await h.send('next input after terminal');
  appendFileSync(h.path, line(record('turn_aborted', h.turn())));
  expect((await next.pending).status).toBe('interrupted');
});
