import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalExecutionJson, type LegacyRetirementCandidate, type LegacyRetirementReceipt } from '@dutydeck/shared';
import { createRepositories, LEGACY_RETIREMENT_NOTICE } from './index.js';

const opened: Array<ReturnType<typeof createRepositories>> = [];
afterEach(() => { while (opened.length) { try { opened.pop()!.close(); } catch {} } });
const path = () => join(mkdtempSync(join(tmpdir(), 'dutydeck-retire-')), 'test.db');
const open = (file: string) => { const repositories = createRepositories(file); opened.push(repositories); return repositories; };

async function seed(file: string, status = 'completed') {
  const repositories = open(file);
  const time = '2026-09-15T00:00:00.000Z';
  await repositories.sessions.save({ id: 'ses_old', agentId: 'ccflash', state: status === 'queued' ? 'idle' : 'completed', cwd: '/workspace', protocol: 'pty-cli', runId: 'run_old', createdAt: time, updatedAt: time, error: 'original error' });
  await repositories.tasks.save({ id: 'task_old', sessionId: 'ses_old', prompt: 'keep prompt', status, executionContext: { agentPrompt: 'keep material prompt' }, createdAt: time, updatedAt: time });
  repositories.close(); opened.pop();
  const db = new Database(file);
  db.prepare("INSERT INTO events (id,session_id,sequence,type,timestamp,data,raw) VALUES ('event_old','ses_old',1,'text',?,?,'keep raw')").run(time, JSON.stringify({ text: 'keep output' }));
  db.close();
}

function receipt(candidate: LegacyRetirementCandidate): LegacyRetirementReceipt {
  const readable = candidate.sessionId.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 48) || 'session';
  const targetName = `dutydeck-${readable}-${createHash('sha256').update(candidate.sessionId).digest('hex').slice(0, 16)}`;
  const verifiedAt = '2026-09-15T01:00:00.000Z';
  const content = {
    version: 1 as const, sessionId: candidate.sessionId, runId: candidate.runId,
    databaseEntity: candidate.databaseEntity, snapshotDigest: candidate.snapshotDigest,
    protocol: 'pty-cli' as const, verifiedAt, archivedAt: candidate.archivedAt ?? verifiedAt,
    verifier: { hostname: 'test-host', uid: 1001, process: { host: 'machine', boot: 'boot', namespace: 'pid:[1]', pid: 123, start: '1' } },
    evidence: { kind: 'pty_tmux_absent' as const, socketPath: '/tmp/test.sock', targetName, owner: `dutydeck:${candidate.sessionId}`, outcome: 'already_missing' as const, paneProcesses: [] }
  };
  return { ...content, receiptId: `legacy_retirement_${createHash('sha256').update(canonicalExecutionJson(content)).digest('hex')}` };
}

describe('legacy session retirement maintenance', () => {
  it('archives a terminal migrated session atomically and replays across reopen without changing history', async () => {
    const file = path(); await seed(file);
    let repositories = open(file); repositories.execution.upgradeLegacy();
    const before = new Database(file, { readonly: true });
    const history = before.prepare("SELECT prompt,execution_context,status,current_attempt_id FROM tasks WHERE id='task_old'").get();
    const event = before.prepare("SELECT sequence,data,raw FROM events WHERE id='event_old'").get();
    const resource = before.prepare("SELECT json FROM driver_resources WHERE session_id='ses_old'").pluck().get();
    before.close();
    const maintenance = repositories.execution.beginLegacyRetirement();
    const candidate = maintenance.listCandidates()[0]!;
    expect(candidate.blockers).toEqual([]);
    const proof = receipt(candidate);
    const first = maintenance.retireSession(proof);
    expect(first).toMatchObject({ replayed: false, session: { state: 'stopped', archivedAt: proof.verifiedAt } });
    expect(first.session.error).toBe(`original error\n\n${LEGACY_RETIREMENT_NOTICE}`);
    expect(maintenance.retireSession(proof).replayed).toBe(true);
    maintenance.close(); repositories.close(); opened.pop();

    repositories = open(file);
    const reopened = repositories.execution.beginLegacyRetirement();
    const replayCandidate = reopened.listCandidates()[0]!;
    expect(replayCandidate.receipt).toEqual(proof);
    expect(reopened.retireSession(proof).replayed).toBe(true);
    reopened.close();
    expect(repositories.execution.upgradeLegacy().legacy).toEqual({ unresolvedSessions: 0, retiredSessions: 1, evidenceIncomplete: 1 });
    const after = new Database(file, { readonly: true });
    expect(after.prepare("SELECT prompt,execution_context,status,current_attempt_id FROM tasks WHERE id='task_old'").get()).toEqual(history);
    expect(after.prepare("SELECT sequence,data,raw FROM events WHERE id='event_old'").get()).toEqual(event);
    expect(after.prepare("SELECT json FROM driver_resources WHERE session_id='ses_old'").pluck().get()).toBe(resource);
    expect(after.prepare("SELECT COUNT(*) FROM task_attempts").pluck().get()).toBe(1);
    expect(after.prepare("SELECT COUNT(*) FROM configs WHERE key='legacy_retirement:ses_old'").pluck().get()).toBe(1);
    after.close();
  });

  it('retires an already archived legacy session without changing its archive time and rejects a forged archive time', async () => {
    const file = path(); await seed(file);
    const originalArchivedAt = '2026-08-20T02:00:00.000Z';
    const archived = new Database(file);
    archived.prepare("UPDATE sessions SET state='failed',archived_at=? WHERE id='ses_old'").run(originalArchivedAt);
    archived.close();
    let repositories = open(file); repositories.execution.upgradeLegacy();
    let maintenance = repositories.execution.beginLegacyRetirement();
    const candidate = maintenance.listCandidates()[0]!;
    expect(candidate).toMatchObject({ state: 'failed', archivedAt: originalArchivedAt, blockers: [] });
    expect(() => maintenance.retireSession(receipt({ ...candidate, archivedAt: '2026-08-21T02:00:00.000Z' })))
      .toThrow(/LEGACY_RETIREMENT_ARCHIVE_CONFLICT/);
    expect(maintenance.retireSession(receipt(candidate))).toMatchObject({
      replayed: false, session: { state: 'stopped', archivedAt: originalArchivedAt, updatedAt: '2026-09-15T01:00:00.000Z' }
    });
    maintenance.close(); repositories.close(); opened.pop();

    repositories = open(file);
    maintenance = repositories.execution.beginLegacyRetirement();
    const replay = maintenance.listCandidates()[0]!;
    expect(replay.receipt?.archivedAt).toBe(originalArchivedAt);
    expect(maintenance.retireSession(replay.receipt!)).toMatchObject({ replayed: true, session: { archivedAt: originalArchivedAt } });
    maintenance.close();
    expect(repositories.execution.upgradeLegacy().legacy).toEqual({ unresolvedSessions: 0, retiredSessions: 1, evidenceIncomplete: 1 });
  });

  it('keeps queued legacy work blocked', async () => {
    const file = path(); await seed(file, 'queued');
    const repositories = open(file); repositories.execution.upgradeLegacy();
    const maintenance = repositories.execution.beginLegacyRetirement();
    const candidate = maintenance.listCandidates()[0]!;
    expect(candidate.blockers).toContainEqual(expect.objectContaining({ code: 'LEGACY_RETIREMENT_TASK_ACTIVE', taskId: 'task_old' }));
    expect(() => maintenance.retireSession(receipt(candidate))).toThrow(expect.objectContaining({ code: 'LEGACY_RETIREMENT_BLOCKED' }));
    maintenance.close();
    expect(await repositories.sessions.get('ses_old')).toMatchObject({ archivedAt: null });
  });

  it('keeps active session states blocked even when tasks are terminal or absent', async () => {
    const file = path(); await seed(file);
    const repositories = open(file); repositories.execution.upgradeLegacy();
    const raw = new Database(file);
    raw.prepare("UPDATE sessions SET state='thinking' WHERE id='ses_old'").run(); raw.close();
    let maintenance = repositories.execution.beginLegacyRetirement();
    let candidate = maintenance.listCandidates()[0]!;
    expect(candidate.blockers).toContainEqual(expect.objectContaining({ code: 'LEGACY_RETIREMENT_SESSION_ACTIVE', detail: 'thinking' }));
    expect(() => maintenance.retireSession(receipt(candidate))).toThrow(expect.objectContaining({ code: 'LEGACY_RETIREMENT_BLOCKED' }));
    maintenance.close();

    const emptyFile = path();
    const emptyRepositories = open(emptyFile);
    const time = '2026-09-15T00:00:00.000Z';
    await emptyRepositories.sessions.save({ id: 'ses_empty', agentId: 'ccflash', state: 'running_tool', cwd: '/workspace', protocol: 'pty-cli', runId: 'run_empty', createdAt: time, updatedAt: time });
    emptyRepositories.execution.upgradeLegacy();
    maintenance = emptyRepositories.execution.beginLegacyRetirement();
    candidate = maintenance.listCandidates()[0]!;
    expect(candidate.blockers).toContainEqual(expect.objectContaining({ code: 'LEGACY_RETIREMENT_SESSION_ACTIVE', detail: 'running_tool' }));
    expect(() => maintenance.retireSession(receipt(candidate))).toThrow(expect.objectContaining({ code: 'LEGACY_RETIREMENT_BLOCKED' }));
    maintenance.close();
  });

  it('includes channel mappings and session-scoped configs in the retirement snapshot CAS', async () => {
    const file = path(); await seed(file);
    const repositories = open(file); repositories.execution.upgradeLegacy();
    const before = new Database(file);
    before.prepare("INSERT INTO channel_mappings VALUES ('mapping','lark','message','ses_old','{}','2026-09-15T00:00:00.000Z')").run();
    before.prepare("INSERT INTO configs VALUES (?,?)").run('lark.context.cli_test.ses_old', '{"cursor":1}'); before.close();
    const maintenance = repositories.execution.beginLegacyRetirement();
    const candidate = maintenance.listCandidates()[0]!;
    const changed = new Database(file);
    changed.prepare("UPDATE channel_mappings SET extra='changed' WHERE id='mapping'").run();
    changed.prepare("UPDATE configs SET value='changed' WHERE key='lark.context.cli_test.ses_old'").run(); changed.close();
    expect(() => maintenance.retireSession(receipt(candidate))).toThrow(/LEGACY_RETIREMENT_SNAPSHOT_CONFLICT/);
    maintenance.close();
  });

  it('reports corrupt legacy rows per session and still retires another verified candidate', async () => {
    const file = path(); await seed(file);
    const repositories = open(file);
    const time = '2026-09-15T00:00:00.000Z';
    for (const id of ['ses_bad_receipt', 'ses_bad_resource']) {
      await repositories.sessions.save({ id, agentId: 'ccflash', state: 'completed', cwd: '/workspace', protocol: 'pty-cli', runId: `run_${id}`, createdAt: time, updatedAt: time });
      await repositories.tasks.save({ id: `task_${id}`, sessionId: id, prompt: 'keep', status: 'completed', createdAt: time, updatedAt: time });
    }
    repositories.execution.upgradeLegacy();
    const corrupt = new Database(file);
    corrupt.prepare("INSERT INTO configs VALUES ('legacy_retirement:ses_bad_receipt','{invalid')").run();
    corrupt.prepare("UPDATE driver_resources SET json='{}' WHERE session_id='ses_bad_resource'").run(); corrupt.close();
    const maintenance = repositories.execution.beginLegacyRetirement();
    const candidates = maintenance.listCandidates();
    expect(candidates.find(item => item.sessionId === 'ses_bad_receipt')?.blockers).toContainEqual(expect.objectContaining({ code: 'LEGACY_RETIREMENT_RECEIPT_INVALID' }));
    expect(candidates.find(item => item.sessionId === 'ses_bad_resource')?.blockers).toContainEqual(expect.objectContaining({ code: 'LEGACY_RETIREMENT_METADATA_INVALID' }));
    const ready = candidates.find(item => item.sessionId === 'ses_old')!;
    expect(maintenance.retireSession(receipt(ready))).toMatchObject({ replayed: false, session: { state: 'stopped' } });
    maintenance.close();
  });

  it('rejects a stale full-session snapshot and rolls back a late write failure', async () => {
    const file = path(); await seed(file);
    const repositories = open(file); repositories.execution.upgradeLegacy();
    let maintenance = repositories.execution.beginLegacyRetirement();
    const stale = maintenance.listCandidates()[0]!;
    const external = new Database(file);
    external.prepare("UPDATE sessions SET updated_at='2026-09-15T00:30:00.000Z' WHERE id='ses_old'").run();
    external.close();
    expect(() => maintenance.retireSession(receipt(stale))).toThrow(/LEGACY_RETIREMENT_SNAPSHOT_CONFLICT/);
    maintenance.close();

    maintenance = repositories.execution.beginLegacyRetirement();
    const current = maintenance.listCandidates()[0]!;
    const triggerDb = new Database(file);
    triggerDb.exec("CREATE TRIGGER fail_retirement BEFORE UPDATE ON sessions WHEN NEW.archived_at IS NOT NULL BEGIN SELECT RAISE(ABORT, 'injected retirement failure'); END");
    triggerDb.close();
    expect(() => maintenance.retireSession(receipt(current))).toThrow(/injected retirement failure/);
    maintenance.close();
    const check = new Database(file, { readonly: true });
    expect(check.prepare("SELECT archived_at FROM sessions WHERE id='ses_old'").pluck().get()).toBeNull();
    expect(check.prepare("SELECT COUNT(*) FROM configs WHERE key='legacy_retirement:ses_old'").pluck().get()).toBe(0);
    check.close();
  });
});
