import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalExecutionJson, type AcceptedTaskInput, type RepositoryBundle, type RuntimeControlClaim, type TaskAttempt, type TaskRequestV1 } from '@dutydeck/shared';
import { createRepositories } from './index.js';
import { COMPACTED_TERMINAL_SCREEN, ENTITY_VERSIONS_TO_KEEP, TERMINAL_SCREENS_TO_KEEP } from './retention.js';

const dirs: string[] = [];
const opened: Array<{ repos: RepositoryBundle; claim: RuntimeControlClaim; sql: Database.Database }> = [];
afterEach(() => {
  for (const item of opened.splice(0)) { item.sql.close(); item.claim.release(); item.repos.close(); }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const hash = (value: unknown) => createHash('sha256').update(canonicalExecutionJson(value)).digest('hex');
const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
const session = (id: string, protocol: 'pty-cli' | 'acp' = 'pty-cli') => ({ id, runId: 'r', agentId: 'a', cwd: '/tmp', state: 'idle' as const, protocol, createdAt: ago(60), updatedAt: ago(60) });
const request = (sessionId: string, key: string): TaskRequestV1 => ({ version: 1, namespace: 'runtime', key, sessionId, actor: { kind: 'unspecified' }, prompt: 'hello', mode: 'queue', skills: [], options: {}, sources: [], sourcePayload: null });
const input = (): AcceptedTaskInput => { const content = { version: 2 as const, executionOptions: { permissionMode: 'ask' as const }, prompt: 'hello', executionContext: { agentPrompt: 'hello' }, contentSources: [] }; return { ...content, digest: hash(content) }; };
const af = (a: TaskAttempt) => ({ sessionId: a.sessionId, runId: a.runId, taskId: a.taskId, attemptId: a.attemptId, expectedRevision: a.revision });
const intent = (submissionId: string) => ({ submissionId, inputDigest: hash('final'), resourceRefs: [], authorizationRefs: ['policy:1'] });

function ready() {
  const dir = mkdtempSync(join(tmpdir(), 'retention-')); dirs.push(dir);
  const filename = join(dir, 'retention.sqlite');
  const repos = createRepositories(filename);
  repos.execution.upgradeLegacy();
  const claim = repos.control.attachRuntime('retention-test');
  const x = repos.execution.bind(claim);
  const sql = new Database(filename);
  opened.push({ repos, claim, sql });
  return { repos, x, sql };
}
type Ledger = ReturnType<typeof ready>['x'];
/** 一轮已提交、正在执行的任务。 */
function activeAttempt(x: Ledger, sessionId: string, key: string) {
  const fence = { sessionId, runId: 'r' };
  x.acceptTask(fence, request(sessionId, key), input(), 'back');
  const attempt = x.claimNext(fence)!.attempt!;
  return x.markSubmissionPending(af(attempt), intent(`send-${key}`)).attempt!;
}
function complete(x: Ledger, attempt: TaskAttempt, submissionId: string) {
  const current = x.markSubmitted(af(attempt), { submissionId, kind: 'provider_accepted', provider: 'fixture', receiptRef: `remote:${submissionId}`, digest: hash(submissionId) }).attempt!;
  return x.settleAttempt(af(current), `done-${submissionId}`, { kind: 'driver_result', submissionId, outcome: 'completed', outputDigest: hash('done'), stopReason: 'end_turn', complete: true }).attempt!;
}
const data = (sql: Database.Database, id: string) => sql.prepare('SELECT data FROM events WHERE id=?').pluck().get(id) as string;
const sequences = async (repos: RepositoryBundle, sessionId: string) => (await repos.events.list(sessionId)).map(event => event.sequence);
const contiguous = (values: number[]) => values.every((value, index) => value === index + 1);

describe('terminal screen window', () => {
  it('keeps only the latest screens of an attempt, leaves other output alone and keeps sequences contiguous', async () => {
    const { repos, x, sql } = ready();
    x.createSession(session('s'));
    const attempt = activeAttempt(x, 's', 'one');
    const total = TERMINAL_SCREENS_TO_KEEP + 10;
    for (let index = 0; index < total; index++) {
      x.appendEvent(af(attempt), { id: `frame-${index}`, type: 'raw_terminal', data: { text: `screen ${index}\n$ ls`, screen: true } });
      if (index === 3) x.appendEvent(af(attempt), { id: 'stderr-line', type: 'raw_terminal', data: { text: 'npm warn deprecated' } });
      if (index === 4) x.appendEvent(af(attempt), { id: 'answer', type: 'text', data: { text: 'done' } });
    }
    // 重放同一帧不算新帧，不会再移出一帧。
    x.appendEvent(af(attempt), { id: `frame-${total - 1}`, type: 'raw_terminal', data: { text: `screen ${total - 1}\n$ ls`, screen: true } });

    const kept = Array.from({ length: total }, (_, index) => data(sql, `frame-${index}`) !== COMPACTED_TERMINAL_SCREEN);
    expect(kept.filter(Boolean)).toHaveLength(TERMINAL_SCREENS_TO_KEEP);
    expect(kept.indexOf(true)).toBe(total - TERMINAL_SCREENS_TO_KEEP);
    expect(JSON.parse(data(sql, `frame-${total - 1}`))).toEqual({ text: `screen ${total - 1}\n$ ls`, screen: true });
    expect(JSON.parse(data(sql, 'stderr-line'))).toEqual({ text: 'npm warn deprecated' });
    expect(JSON.parse(data(sql, 'answer'))).toEqual({ text: 'done' });
    expect(contiguous(await sequences(repos, 's'))).toBe(true);
  });

  it('counts screens per attempt', () => {
    const { x, sql } = ready();
    x.createSession(session('s'));
    const first = activeAttempt(x, 's', 'one');
    for (let index = 0; index < TERMINAL_SCREENS_TO_KEEP; index++) x.appendEvent(af(first), { id: `first-${index}`, type: 'raw_terminal', data: { text: `a ${index}\nb`, screen: true } });
    complete(x, first, 'send-one');
    const second = activeAttempt(x, 's', 'two');
    for (let index = 0; index < 5; index++) x.appendEvent(af(second), { id: `second-${index}`, type: 'raw_terminal', data: { text: `c ${index}\nd`, screen: true } });
    expect(Array.from({ length: TERMINAL_SCREENS_TO_KEEP }, (_, index) => data(sql, `first-${index}`)).includes(COMPACTED_TERMINAL_SCREEN)).toBe(false);
  });
});

describe('history retention', () => {
  it('trims only ended, old data and is idempotent', async () => {
    const { repos, x, sql } = ready();
    for (const id of ['s', 'quiet']) x.createSession(session(id));
    x.createSession(session('acp', 'acp'));
    // 旧版本写的整屏帧没有 screen 标记；不带 attempt 的写到空闲会话 quiet。
    const frame = (attempt: TaskAttempt | undefined, id: string, days: number) => x.appendEvent(attempt ? af(attempt) : { sessionId: 'quiet', runId: 'r' },
      { id, type: 'raw_terminal', data: { text: `${id}\n$` }, timestamp: ago(days) });

    // 已结束且超过 30 天：只留最后一帧。
    const done = activeAttempt(x, 's', 'done');
    for (const id of ['old-1', 'old-2', 'old-3']) frame(done, id, 40);
    const settled = complete(x, done, 'send-done');
    // 已结束但还在 30 天内：不动。
    const recent = activeAttempt(x, 's', 'recent');
    for (const id of ['recent-1', 'recent-2']) frame(recent, id, 5);
    complete(x, recent, 'send-recent');
    // 结果未知的任务：不动，会话也因此不算空闲。
    const unknown = activeAttempt(x, 's', 'unknown');
    for (const id of ['unknown-1', 'unknown-2']) frame(unknown, id, 40);
    x.markReconcileRequired(af(unknown), { reasonId: 'timeout', code: 'TIMEOUT', evidenceRefs: ['transport:closed'] });
    // 不属于任何轮的帧：会话空闲时只留最后一帧。
    for (const id of ['idle-1', 'idle-2', 'idle-3']) frame(undefined, id, 40);
    // ACP 的 raw_terminal 是逐行输出，不是整屏快照：不动。
    for (const id of ['acp-1', 'acp-2']) x.appendEvent({ sessionId: 'acp', runId: 'r' }, { id, type: 'raw_terminal', data: { text: id }, timestamp: ago(40) });

    // 旧版本的会话状态快照。
    const snapshot = (id: string, payload: object, days: number) => sql.prepare('INSERT INTO task_execution_commands VALUES (?,?,?)')
      .run(`session_state:${id}`, JSON.stringify(payload), JSON.stringify({ session: { updatedAt: ago(days) }, events: [{ text: 'x'.repeat(1000) }] }));
    snapshot('done-old', { sessionId: 's', runId: 'r', taskId: settled.taskId, attemptId: settled.attemptId, input: { state: 'thinking' } }, 40);
    snapshot('done-recent', { sessionId: 's', runId: 'r', taskId: settled.taskId, attemptId: settled.attemptId, input: { state: 'thinking' } }, 5);
    snapshot('unknown-old', { sessionId: 's', runId: 'r', taskId: unknown.taskId, attemptId: unknown.attemptId, input: { state: 'thinking' } }, 40);
    snapshot('quiet-old', { sessionId: 'quiet', runId: 'r', patch: { state: 'idle' } }, 40);
    snapshot('busy-old', { sessionId: 's', runId: 'r', patch: { state: 'idle' } }, 40);
    const otherCommands = sql.prepare("SELECT id FROM task_execution_commands WHERE id NOT LIKE 'session_state:%' ORDER BY id").pluck().all();
    expect(otherCommands.length).toBeGreaterThan(0);

    const toolCall = (id: string, sessionId: string, days: number) => sql.prepare('INSERT INTO tool_calls VALUES (?,?,?,?,?)').run(id, sessionId, '{}', ago(days), ago(days));
    toolCall('quiet-old', 'quiet', 40); toolCall('quiet-recent', 'quiet', 5); toolCall('busy-old', 's', 40);

    const version = sql.prepare("INSERT INTO wp1a_entity_versions (entity_kind, entity_id, from_revision, to_revision, before_json, after_hash, created_at) VALUES ('remote_chat_fact', ?, ?, ?, '{}', 'h', ?)");
    for (let revision = 1; revision <= ENTITY_VERSIONS_TO_KEEP + 5; revision++) version.run('chatty', revision - 1 || null, revision, ago(1));
    for (let revision = 1; revision <= 3; revision++) version.run('calm', revision - 1 || null, revision, ago(1));

    const before = { s: await sequences(repos, 's'), quiet: await sequences(repos, 'quiet') };
    expect(await repos.retention.prune()).toEqual({ terminalFrames: 4, sessionStateCommands: 2, toolCalls: 1, entityVersions: 5 });

    const compacted = (id: string) => data(sql, id) === COMPACTED_TERMINAL_SCREEN;
    expect(['old-1', 'old-2', 'old-3'].map(compacted)).toEqual([true, true, false]);
    expect(['idle-1', 'idle-2', 'idle-3'].map(compacted)).toEqual([true, true, false]);
    expect(['recent-1', 'recent-2', 'unknown-1', 'unknown-2', 'acp-1', 'acp-2'].some(compacted)).toBe(false);
    expect(sql.prepare("SELECT id FROM task_execution_commands WHERE id LIKE 'session_state:%' ORDER BY id").pluck().all())
      .toEqual(['session_state:busy-old', 'session_state:done-recent', 'session_state:unknown-old']);
    expect(sql.prepare("SELECT id FROM task_execution_commands WHERE id NOT LIKE 'session_state:%' ORDER BY id").pluck().all()).toEqual(otherCommands);
    expect(sql.prepare('SELECT id FROM tool_calls ORDER BY id').pluck().all()).toEqual(['busy-old', 'quiet-recent']);
    expect(sql.prepare("SELECT to_revision FROM wp1a_entity_versions WHERE entity_id='chatty' ORDER BY to_revision").pluck().all())
      .toEqual(Array.from({ length: ENTITY_VERSIONS_TO_KEEP }, (_, index) => index + 6));
    expect(sql.prepare("SELECT COUNT(*) FROM wp1a_entity_versions WHERE entity_id='calm'").pluck().get()).toBe(3);
    // 行与序号都还在，Web 读历史仍是连续的。
    expect({ s: await sequences(repos, 's'), quiet: await sequences(repos, 'quiet') }).toEqual(before);
    expect(contiguous(before.s) && contiguous(before.quiet)).toBe(true);
    expect(sql.pragma('foreign_key_check')).toEqual([]);

    expect(await repos.retention.prune()).toEqual({ terminalFrames: 0, sessionStateCommands: 0, toolCalls: 0, entityVersions: 0 });
  });

  it('stops between batches once aborted', async () => {
    const { repos, x, sql } = ready();
    x.createSession(session('quiet'));
    for (const id of ['idle-1', 'idle-2']) x.appendEvent({ sessionId: 'quiet', runId: 'r' }, { id, type: 'raw_terminal', data: { text: `${id}\n$` }, timestamp: ago(40) });
    const aborted = new AbortController(); aborted.abort();
    expect(await repos.retention.prune({ signal: aborted.signal })).toEqual({ terminalFrames: 0, sessionStateCommands: 0, toolCalls: 0, entityVersions: 0 });
    expect(data(sql, 'idle-1')).not.toBe(COMPACTED_TERMINAL_SCREEN);
  });
});
