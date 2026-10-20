import { afterEach, expect, it, vi } from 'vitest';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCliAdapter } from '@dutydeck/cli-adapters';
import { TmuxBackend } from '@dutydeck/session-backends';
import { agentConfigSchema, type NormalizedDriverEvent } from '@dutydeck/shared';
import { createRepositories } from '@dutydeck/storage';
import { PtyCliDriver } from '../../pty-driver/src/driver.js';
import { buildSessionMarker, resolveCliSessionId } from '../../pty-driver/src/session-id/index.js';
import { DutydeckRuntime } from './index.js';

const releases: Array<() => Promise<void>> = [];
afterEach(async () => { for (const release of releases.splice(0).reverse()) await release(); vi.restoreAllMocks(); });
const line = (record: unknown) => JSON.stringify(record) + '\n';
const terminal = JSON.parse(readFileSync(new URL('../../pty-driver/src/fixtures/transcript-dialects/codex.jsonl', import.meta.url), 'utf8'));
const ready = 'Codex\r\n›\r\n100% left';

it.each([false, true])('Codex continues the same verified native session after idle cleanup=%s', async cleanup => {
  const cwd = mkdtempSync(join(tmpdir(), 'dd-codex-idle-reconnect-'));
  releases.push(async () => rmSync(cwd, { recursive: true, force: true }));
  const panes = new Map<string, { id: string; path: string; owner?: string; killed: boolean; prompt: string; writes: number; metadata: Map<string, string>; paint: (data: string) => void; screen: string }>();
  const launches: string[][] = [];
  vi.spyOn(TmuxBackend, 'probeSession').mockImplementation(async name => panes.has(name) && !panes.get(name)!.killed ? 'exists' : 'missing');
  vi.spyOn(TmuxBackend, 'sessionOwner').mockImplementation(async name => panes.get(name)?.owner);
  vi.spyOn(TmuxBackend.prototype, 'spawn').mockImplementation(async function (_command, args) {
    const id = args.includes('resume') ? args.at(-1)! : randomUUID();
    const day = join(cwd, 'sessions', '2026', '10', '20'); mkdirSync(day, { recursive: true });
    const path = join(day, `rollout-2026-10-20-${id}.jsonl`);
    panes.set(this.sessionName, { id, path, owner: this.ownerId, killed: false, prompt: '', writes: 0, metadata: new Map(), paint() {}, screen: ready });
    this.initialScreen = { data: ready, cols: 120, rows: 30 }; launches.push(args);
  });
  vi.spyOn(TmuxBackend.prototype, 'getPid').mockResolvedValue(undefined);
  vi.spyOn(TmuxBackend.prototype, 'onData').mockImplementation(function (cb) { panes.get(this.sessionName)!.paint = cb; });
  vi.spyOn(TmuxBackend.prototype, 'onExit').mockImplementation(() => {});
  vi.spyOn(TmuxBackend.prototype, 'captureCurrentScreen').mockImplementation(async function () { return panes.get(this.sessionName)!.screen; });
  vi.spyOn(TmuxBackend.prototype, 'getDutydeckMetadata').mockImplementation(async function (key) { return panes.get(this.sessionName)!.metadata.get(key); });
  vi.spyOn(TmuxBackend.prototype, 'setDutydeckMetadata').mockImplementation(async function (key, value) { panes.get(this.sessionName)!.metadata.set(key, value); });
  vi.spyOn(TmuxBackend.prototype, 'kill').mockImplementation(async function () { panes.get(this.sessionName)!.killed = true; });
  vi.spyOn(TmuxBackend.prototype, 'detach').mockResolvedValue();
  vi.spyOn(TmuxBackend.prototype, 'write').mockImplementation(async function (data) {
    const prompt = data.replace(/^\x1b\[200~/, '').replace(/\x1b\[201~$/, '');
    const pane = panes.get(this.sessionName)!; pane.prompt = prompt;
    pane.paint('\x1bcCodex\r\n› ' + prompt.replaceAll('\n', '\r\n') + '\r\n100% left'); return true;
  });
  vi.spyOn(TmuxBackend.prototype, 'sendSpecialKeys').mockImplementation(async function (...keys) {
    expect(keys).toEqual(['Enter']);
    const pane = panes.get(this.sessionName)!, turn = randomUUID();
    const answer = `answer-${++pane.writes}`;
    const completed = structuredClone(terminal); completed.payload.turn_id = turn; completed.payload.last_agent_message = answer;
    if (!existsSync(pane.path)) writeFileSync(pane.path, line({ type: 'session_meta', payload: { id: pane.id, cwd, source: 'cli' } }));
    appendFileSync(pane.path, line({ type: 'event_msg', payload: { type: 'task_started', turn_id: turn } })
      + line({ type: 'event_msg', payload: { type: 'user_message', turn_id: turn, message: pane.prompt } }) + line(completed));
    appendFileSync(join(cwd, 'history.jsonl'), line({ session_id: pane.id, text: pane.prompt, ts: Date.now() / 1000 }));
    pane.screen = `Codex\r\n${answer}\r\n›\r\n100% left`; pane.paint('\x1bc' + pane.screen); return true;
  });
  const repos = createRepositories(join(cwd, 'state.sqlite'), { newDatabaseAuthority: 'ledger_v1' });
  const drivers: PtyCliDriver[] = [], events: NormalizedDriverEvent[] = [];
  const runtime = new DutydeckRuntime(repos, { cleanupIntervalMs: 0,
    probe: () => ({ available: true, protocol: 'pty-cli', resume: true }),
    ptyDriverFactory: (agent, _protocol, emit, onExit, sessionId) => {
      const backend = new TmuxBackend(`idle-${sessionId}`, { ownerId: `dutydeck:${sessionId}` });
      const driver = new PtyCliDriver({ agent, adapter: createCliAdapter('codex'), backend, sessionId,
        onEvent(event) { events.push(event); emit(event); }, onExit });
      // Physical transport is the only simulated boundary; stop and runtime removal stay real.
      vi.spyOn(driver, 'isStopped').mockImplementation(async () => panes.get(backend.sessionName)?.killed === true);
      drivers.push(driver); return driver;
    } });
  releases.push(async () => { await runtime.shutdown(); repos.close(); });
  const agent = agentConfigSchema.parse({ id: 'codex', name: 'fixture', command: 'unused-fixture', args: [], cwd,
    env: { CODEX_HOME: cwd }, permissionMode: 'ask', timeout: 5, protocol: 'pty-cli', capabilities: { resume: true } });
  await runtime.initialize([agent]);
  const session = await runtime.start({ agentId: 'codex', cwd });
  expect((await runtime.send(session.id, 'first task')).status).toBe('completed');
  const nativeId = resolveCliSessionId('codex', { sessionId: session.id, cwd, env: agent.env, requireMarker: true });
  expect(nativeId).toBeDefined();
  if (cleanup) {
    await vi.waitFor(() => expect(runtime.getActiveTaskContext(session.id)).toBeUndefined());
    await runtime.cleanupIdleDrivers(Date.now() + 6 * 60 * 60_000 + 1);
    expect(panes.get(`idle-${session.id}`)?.killed).toBe(true);
    expect((await runtime.getSession(session.id)).state).toBe('interrupted');
  }
  const eventOffset = events.length;
  const sending = runtime.send(session.id, 'second task');
  await vi.waitFor(() => expect(events.slice(eventOffset).some(event => event.data?.state === 'input_receipt' && event.data.phase === 'confirmed')).toBe(true));
  const queued = await runtime.dispatch(session.id, 'third task');
  expect(queued.status).toBe('queued');
  const second = await sending;
  expect(second.status).toBe('completed');
  expect(drivers).toHaveLength(cleanup ? 2 : 1);
  expect(launches.at(-1)!.includes('resume')).toBe(cleanup);
  expect(panes.get(`idle-${session.id}`)?.id).toBe(nativeId);
  expect(panes.get(`idle-${session.id}`)?.prompt).not.toContain(buildSessionMarker(session.id));
  expect(events.slice(eventOffset).find(event => event.type === 'text')?.data.text).toBe(cleanup ? 'answer-1' : 'answer-2');
  expect((await runtime.getEvents(session.id)).filter(event => event.taskId === second.id && event.type === 'text' && event.data.role !== 'user').map(event => event.data.text)).toEqual([cleanup ? 'answer-1' : 'answer-2']);
  expect(repos.execution.getTaskExecution(second.id)?.currentAttempt).toMatchObject({ state: 'settled', outcome: 'completed' });
  expect((await runtime.getSession(session.id)).runId).toBe(session.runId);
  await vi.waitFor(async () => expect((await runtime.getTasks(session.id)).find(task => task.id === queued.id)?.status).toBe('completed'), { timeout: 6_000 });
  expect(repos.execution.getTaskExecution(queued.id)?.currentAttempt).toMatchObject({ state: 'settled', outcome: 'completed' });
}, 20_000);
