import { defaultDriverProviders } from '../../../apps/server/src/driver-providers.js';
import { afterEach, expect, it, vi } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
async function fixture(inputType?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'dd-runtime-traex-canonical-'));
  releases.push(async () => rmSync(dir, { recursive: true, force: true }));
  const day = join(dir, 'cli', 'sessions', '2026', '10', '15'); mkdirSync(day, { recursive: true });
  const path = join(day, `rollout-2026-10-15T10-00-00-${thread}.jsonl`);
  writeFileSync(path, line({ type: 'session_meta', payload: { id: thread, cwd: dir } }));
  // Deliberately no history.jsonl or legacy user_message: either would mask a
  // broken canonical receipt/turn binding with an independent receipt source.
  const writes: string[] = [];
  const kill = vi.fn();
  let paint!: (data: string) => void;
  const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' });
  const runtime = new DutydeckRuntime(repos, {
    providers: defaultDriverProviders(),
    probe: () => ({ protocol: 'pty-cli', available: true, pause: false, resume: true }),
    driverFactory: (agent, _protocol, onEvent, onExit, sessionId) => {
      const backend: SessionBackend = { kind: 'pty', spawn() {}, write() {}, resize() {}, kill, interrupt() {}, onData(cb) { paint = cb; }, onExit() {} };
      const adapter = createCliAdapter('traex');
      return new PtyCliDriver({ agent, adapter: { ...adapter, prepareInput: undefined, writeInput(_backend, prompt) {
        writes.push(prompt);
        if (inputType) appendFileSync(path, line(mutation({ type: 'UserMessage', id: 'user', content: [{ type: inputType, text: prompt }] })));
      } }, backend, sessionId, onEvent, onExit });
    },
  });
  releases.push(async () => { await runtime.shutdown(); repos.close(); });
  const agent = agentConfigSchema.parse({ id: 'traex', name: 'traex', command: 'unused-fixture', args: [], protocol: 'pty-cli', cwd: dir,
    env: { TRAE_HOME: dir }, permissionMode: 'full-trust', timeout: inputType ? 10 : 180, capabilities: { pause: false, resume: true } });
  await runtime.initialize([agent]);
  const session = await runtime.start({ agentId: 'traex' });
  const pending = runtime.send(session.id, 'question\nsecond line'); void pending.catch(() => {});
  await vi.waitFor(() => expect(writes).toHaveLength(1));
  return { runtime, repos, session, path, pending, kill, paint: (screen = 'answer\n❯ Ask TraeCode CLI\nContext 100% left') => paint('\x1b[2J\x1b[H' + screen.replaceAll('\n', '\r\n')) };
}
// The content type only selects receipt text extraction and the outcome only the
// settlement path; any unrecognized type fails every outcome. Each type runs the
// fast failed path, and the slower screen-settled outcomes run once.
const cases = [...['text', 'input_text', 'Text', 'output_text'].map(type => ({ type, outcome: 'failed' })),
  { type: 'output_text', outcome: 'completed' }, { type: 'input_text', outcome: 'interrupted' }];
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

it('refuses manual failure while the recorded TraeX footer is busy after native receipt timeout', async () => {
  const tape = JSON.parse(readFileSync(new URL('../../cli-adapters/src/fixtures/traex-startup/0.209.1-footers.json', import.meta.url), 'utf8'));
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const h = await fixture();
    h.paint(tape.frames[0].screen);
    await vi.waitFor(async () => expect(await h.runtime.getEvents(h.session.id)).toContainEqual(
      expect.objectContaining({ type: 'status', data: expect.objectContaining({ state: 'input_receipt', phase: 'pending' }) })
    ));
    await vi.advanceTimersByTimeAsync(90_000);
    const task = await h.pending;
    const attempt = h.repos.execution.getTaskExecution(task.id)!.currentAttempt!;
    expect(attempt).toMatchObject({ state: 'reconcile_required', reconcileReason: { code: 'DRIVER_INPUT_UNCONFIRMED' } });
    await vi.waitFor(() => expect(h.runtime.getActiveTaskContext(h.session.id)).toBeUndefined());
    await expect(h.runtime.resolveUnknownTask(h.session.id, { taskId: task.id, target: attempt.attemptId,
      decisionId: 'manual-failure', action: 'failed', evidenceRefs: ['operator:checked'] },
    { kind: 'installation_owner', id: 'installation_owner' })).rejects.toMatchObject({ code: 'RECOVERY_EXECUTION_ACTIVE' });
    expect(h.kill).not.toHaveBeenCalled();
    expect(h.runtime.getDriver(h.session.id)?.quiescence?.()).toEqual({ state: 'busy', evidence: 'adapter_busy_screen' });
    expect(h.repos.execution.getTaskExecution(task.id)?.task.status).toBe('reconcile_required');
  } finally { vi.useRealTimers(); }
});
