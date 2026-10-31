import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { canonicalExecutionJson, type TaskAttempt } from '@dutydeck/shared';
import { createRepositories } from '@dutydeck/storage';
import { DatabaseSync } from 'node:sqlite';
import { api } from '../apps/web/src/api.js';
import { completeEventHistory, loadHistoryRange, loadProjectedHistory, loadTurnHistory } from '../apps/web/src/event-history.js';

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const old = '2025-01-01T00:00:00.000Z';
const hash = (value: unknown) => createHash('sha256').update(canonicalExecutionJson(value)).digest('hex');
const fence = (attempt: TaskAttempt) => ({ sessionId: attempt.sessionId, runId: attempt.runId, taskId: attempt.taskId, attemptId: attempt.attemptId, expectedRevision: attempt.revision });

/** Two completed turns with missing middle raw terminal output in a legacy database, then read through the real storage window. */
async function prunedSession() {
  const dir = mkdtempSync(join(tmpdir(), 'dutydeck-web-prune-')); dirs.push(dir);
  const path = join(dir, 'runtime.db');
  const repos = createRepositories(path, { newDatabaseAuthority: 'ledger_v1' });
  const claim = repos.control.attachRuntime('web-prune');
  const execution = repos.execution.bind(claim);
  const scope = { sessionId: 's', runId: 'r' };
  execution.createSession({ id: 's', runId: 'r', agentId: 'agent', state: 'idle', cwd: dir, createdAt: old, updatedAt: old });
  for (const key of ['first', 'second']) {
    const content = { version: 2 as const, executionOptions: { permissionMode: 'ask' as const }, prompt: key, executionContext: { agentPrompt: key }, contentSources: [] };
    execution.acceptTask(scope, { version: 1, namespace: 'runtime', key, sessionId: 's', actor: { kind: 'unspecified' }, prompt: key, mode: 'queue', skills: [], options: {}, sources: [], sourcePayload: null }, { ...content, digest: hash(content) }, 'back');
    let attempt = execution.claimNext(scope)!.attempt!;
    attempt = execution.markSubmissionPending(fence(attempt), { submissionId: `submission-${key}`, inputDigest: hash(key), resourceRefs: [], authorizationRefs: [] }).attempt!;
    for (const [id, type, data] of [[`prompt-${key}`, 'text', { role: 'user', text: key }], [`raw-${key}`, 'raw_terminal', { text: `terminal ${key}` }],
      [`tool-${key}`, 'tool_call', { id: `call-${key}`, title: 'read' }], [`raw-tail-${key}`, 'raw_terminal', { text: `tail ${key}` }],
      [`output-${key}`, 'text', { role: 'assistant', text: `done ${key}` }]] as const) {
      execution.appendEvent(fence(attempt), { id, type, timestamp: old, data });
    }
    execution.settleAttempt(fence(attempt), `settlement-${key}`, { kind: 'driver_result', submissionId: `submission-${key}`, outcome: 'completed', outputDigest: createHash('sha256').update(`done ${key}`).digest('hex'), stopReason: 'end_turn', complete: true });
  }
  claim.release(); repos.close();
  // Model an already sparse legacy history in this private test database; the offline pruning command was removed.
  const fixture = new DatabaseSync(path);
  try { expect(fixture.prepare("DELETE FROM events WHERE type = 'raw_terminal'").run().changes).toBe(4); }
  finally { fixture.close(); }
  const read = createRepositories(path);
  vi.spyOn(api, 'events').mockImplementation(async (sessionId, query = {}) => read.events.listWindow(sessionId,
    { afterSequence: query.after, beforeSequence: query.before, limit: query.limit, direction: query.direction }));
  const all = await read.events.list('s');
  const outline = await read.events.listHistoryOutline!('s');
  return { read, all, outline };
}

it('reads retained turn details and the complete record after terminal output was pruned', async () => {
  const { read, all, outline } = await prunedSession();
  try {
    expect(all.some(event => event.type === 'raw_terminal')).toBe(false);
    const sequences = all.map(event => event.sequence);
    expect(sequences.some((sequence, index) => index > 0 && sequence !== sequences[index - 1]! + 1)).toBe(true);
    expect(outline.turns).toHaveLength(2);
    for (const turn of outline.turns) {
      const details = await loadTurnHistory('s', turn);
      expect(details.map(event => event.id)).toEqual(all.filter(event => event.sequence >= turn.firstSequence && event.sequence <= turn.lastSequence).map(event => event.id));
      expect(details.some(event => event.type === 'tool_call')).toBe(true);
      expect(details.at(-1)?.sequence).toBe(turn.lastSequence);
    }
    const complete = await loadHistoryRange('s', 0, outline.highWaterMark);
    expect(complete.map(event => event.id)).toEqual(all.map(event => event.id));
    const live = await loadProjectedHistory('s', outline);
    expect(completeEventHistory(complete, live.events)?.map(event => event.id)).toEqual(all.map(event => event.id));
  } finally { read.close(); }
});

it('still rejects a pruned history read that never reaches the requested end', async () => {
  const { read, outline } = await prunedSession();
  try {
    const listWindow = read.events.listWindow.bind(read.events);
    // A server that stops short (here: drops the final row) must not be mistaken for a pruned hole.
    vi.spyOn(api, 'events').mockImplementation(async (sessionId, query = {}) => (await listWindow(sessionId,
      { afterSequence: query.after, beforeSequence: query.before, limit: query.limit, direction: query.direction })).filter(event => event.sequence !== outline.highWaterMark));
    await expect(loadHistoryRange('s', 0, outline.highWaterMark)).rejects.toThrow('记录尚未读取完整');
    await expect(loadTurnHistory('s', outline.turns.at(-1)!)).rejects.toThrow('记录尚未读取完整');
  } finally { read.close(); }
});
