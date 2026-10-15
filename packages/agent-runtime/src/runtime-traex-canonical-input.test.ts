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
const thread = '11111111-1111-4111-8111-111111111111', turn = 'native-turn';
const line = (entry: unknown) => JSON.stringify(entry) + '\n';
const mutation = (item: unknown) => ({ type: 'history_mutation', timestamp: new Date().toISOString(), payload: { operation: 'append', turn_id: turn,
  display_completions: [{ thread_id: thread, turn_id: turn, item }] } });
async function fixture(inputType: string) {
  const dir = mkdtempSync(join(tmpdir(), 'dd-runtime-traex-canonical-'));
  releases.push(async () => rmSync(dir, { recursive: true, force: true }));
  const day = join(dir, 'cli', 'sessions', '2026', '10', '15'); mkdirSync(day, { recursive: true });
  const path = join(day, `rollout-2026-10-15T10-00-00-${thread}.jsonl`);
  writeFileSync(path, line({ type: 'session_meta', payload: { id: thread, cwd: dir } }));
  // Deliberately no history.jsonl or legacy user_message: either would mask a
  // broken canonical receipt/turn binding with an independent receipt source.
  const writes: string[] = [];
  let paint!: (data: string) => void;
  const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' });
  const runtime = new DutydeckRuntime(repos, {
    probe: () => ({ protocol: 'pty-cli', available: true, pause: false, resume: true }),
    driverFactory: (agent, _protocol, onEvent, onExit, sessionId) => {
      const backend: SessionBackend = { kind: 'pty', spawn() {}, write() {}, resize() {}, kill() {}, interrupt() {}, onData(cb) { paint = cb; }, onExit() {} };
      const adapter = createCliAdapter('traex');
      return new PtyCliDriver({ agent, adapter: { ...adapter, prepareInput: undefined, writeInput(_backend, prompt) {
        writes.push(prompt);
        appendFileSync(path, line(mutation({ type: 'UserMessage', id: 'user', content: [{ type: inputType, text: prompt }] })));
      } }, backend, sessionId, onEvent, onExit });
    },
  });
  releases.push(async () => { await runtime.shutdown(); repos.close(); });
  const agent = agentConfigSchema.parse({ id: 'traex', name: 'traex', command: 'unused-fixture', args: [], protocol: 'pty-cli', cwd: dir,
    env: { TRAE_HOME: dir }, permissionMode: 'full-trust', timeout: 10, capabilities: { pause: false, resume: true } });
  await runtime.initialize([agent]);
  const session = await runtime.start({ agentId: 'traex' });
  const pending = runtime.send(session.id, 'question\nsecond line'); void pending.catch(() => {});
  await vi.waitFor(() => expect(writes).toHaveLength(1));
  return { runtime, repos, session, path, pending, paint: () => paint('\x1b[2J\x1b[Hanswer\r\n❯ Ask TraeCode CLI\r\nContext 100% left') };
}
const cases = ['text', 'input_text', 'Text', 'output_text'].flatMap(type => ['completed', 'failed', 'interrupted'].map(outcome => ({ type, outcome })));
it.each(cases)('settles canonical $type as $outcome through real tailer, driver and Runtime without history', async ({ type, outcome }) => {
  const h = await fixture(type);
  if (outcome !== 'interrupted') appendFileSync(h.path, line(mutation({ type: 'AgentMessage', id: 'reply', phase: 'final_answer', content: [{ type: 'Text', text: 'answer' }] })));
  appendFileSync(h.path, line({ type: 'event_msg', payload: { type: outcome === 'interrupted' ? 'turn_aborted' : 'task_complete', turn_id: turn,
    last_agent_message: '', ...(outcome === 'failed' ? { error: { message: 'backend failed' } } : {}) } }));
  if (outcome === 'completed') h.paint();
  await vi.waitFor(async () => expect((await h.runtime.getTasks(h.session.id)).at(-1)?.status).toBe(outcome), { timeout: 4_000 });
  const task = await h.pending; expect(task.status).toBe(outcome);
  expect(h.repos.execution.getTaskExecution(task.id)?.currentAttempt).toMatchObject({ state: 'settled', outcome });
  const events = await h.runtime.getEvents(h.session.id);
  expect(events.filter(e => e.type === 'completed')).toHaveLength(1);
  expect(events.filter(e => e.type === 'error')).toEqual(outcome === 'failed'
    ? [expect.objectContaining({ data: expect.objectContaining({ code: 'native_task_failed', message: 'backend failed' }) })] : []);
  expect(events.filter(e => e.type === 'text' && (e.data as any).role !== 'user').map(e => (e.data as any).text)).toEqual(outcome === 'interrupted' ? [] : ['answer']);
});
