import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import type { AgentConfig, Session } from '@dutydeck/shared';
import { RuntimeError } from '@dutydeck/shared';
import { DutydeckRuntime, type AgentDriver } from './index.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const agent: AgentConfig = {
  id: 'mock-agent',
  name: 'Mock Agent',
  command: process.execPath,
  args: [],
  protocol: 'acp',
  cwd: '/tmp',
  env: {},
  permissionMode: 'ask',
  timeout: 10,
  capabilities: { pause: false, resume: true },
  builtin: false
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

interface HarnessOptions {
  onSend?: (emit: (event: any) => void) => void | 'manual';
}

function createHarness(dbPathOrOptions: string | HarnessOptions = ':memory:', maybeOptions?: HarnessOptions) {
  const dbPath = typeof dbPathOrOptions === 'string' ? dbPathOrOptions : ':memory:';
  const options = typeof dbPathOrOptions === 'object' ? dbPathOrOptions : (maybeOptions ?? {});
  const repos = createRepositories(dbPath, { newDatabaseAuthority: 'ledger_v1' });
  let emit!: (event: any) => void;
  const driver: AgentDriver = {
    start: vi.fn(async () => {}),
    send: vi.fn(async () => {
      const mode = options.onSend?.(emit);
      if (mode !== 'manual') emit({ type: 'completed', data: { stopReason: 'end_turn' } });
    }),
    interrupt: vi.fn(async () => {}),
    resume: vi.fn(async () => {}),
    isStopped: async () => true,
    stop: vi.fn(async () => {}),
    resolvePermission: vi.fn(async () => true),
    setModel: vi.fn(async () => {}),
    setReasoningEffort: vi.fn(async () => {}),
    setPermissionMode: vi.fn()
  };
  const runtime = new DutydeckRuntime(repos, {
    probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }),
    driverFactory: (_agent, _p, onEvent) => {
      emit = onEvent;
      return driver;
    }
  });
  return { repos, runtime, driver, emit: (event: any) => emit(event) };
}

describe('session names runtime integration', () => {
  it('throws 404 SESSION_NOT_FOUND for unknown session', async () => {
    const { repos, runtime } = createHarness();
    await runtime.initialize([agent]);
    await expect(runtime.setSessionName('ses_nonexistent', 'New Name')).rejects.toThrowError(
      expect.objectContaining({ code: 'SESSION_NOT_FOUND', statusCode: 404 })
    );
    await runtime.shutdown();
    repos.close();
  });

  it('rejects renaming work_item managed session with 400 INVALID_WORK_SESSION', async () => {
    const { repos, runtime } = createHarness();
    await runtime.initialize([agent]);
    const workSession = await runtime.startWorkItemSession(
      { agentId: agent.id, source: 'work_item', sourceId: 'work-1' },
      'ses_work_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      async () => {}
    );
    await expect(runtime.setSessionName(workSession.id, 'Renamed Work Session')).rejects.toThrowError(
      expect.objectContaining({ code: 'INVALID_WORK_SESSION', statusCode: 400 })
    );
    await runtime.shutdown();
    repos.close();
  });

  it('rejects invalid names with 400 INVALID_SESSION_NAME', async () => {
    const { repos, runtime } = createHarness();
    await runtime.initialize([agent]);
    const session = await runtime.start({ agentId: agent.id });

    // Empty or whitespace
    await expect(runtime.setSessionName(session.id, '')).rejects.toThrowError(
      expect.objectContaining({ code: 'INVALID_SESSION_NAME', statusCode: 400 })
    );
    await expect(runtime.setSessionName(session.id, '   ')).rejects.toThrowError(
      expect.objectContaining({ code: 'INVALID_SESSION_NAME', statusCode: 400 })
    );

    // Over 80 chars
    await expect(runtime.setSessionName(session.id, 'a'.repeat(81))).rejects.toThrowError(
      expect.objectContaining({ code: 'INVALID_SESSION_NAME', statusCode: 400 })
    );

    // Newlines
    await expect(runtime.setSessionName(session.id, 'Name\nWith\nNewline')).rejects.toThrowError(
      expect.objectContaining({ code: 'INVALID_SESSION_NAME', statusCode: 400 })
    );

    await runtime.shutdown();
    repos.close();
  });

  it('sets, retrieves, projects, and clears session name without altering session metadata or updatedAt', async () => {
    const { repos, runtime } = createHarness();
    await runtime.initialize([agent]);
    const session = await runtime.start({ agentId: agent.id });

    // Initially no name
    const initialSession = await runtime.getSession(session.id);
    expect(initialSession?.name).toBeUndefined();
    const originalUpdatedAt = initialSession!.updatedAt;

    // Set valid name
    const renamed = await runtime.setSessionName(session.id, '  My Custom Session  ');
    expect(renamed.id).toBe(session.id);
    expect(renamed.name).toBe('My Custom Session');
    expect(renamed.updatedAt).toBe(originalUpdatedAt);

    // Projection in getSession and listSessions
    const fetched = await runtime.getSession(session.id);
    expect(fetched?.name).toBe('My Custom Session');
    expect(fetched?.updatedAt).toBe(originalUpdatedAt);

    const listed = await runtime.listSessions();
    const listedSession = listed.find(s => s.id === session.id);
    expect(listedSession?.name).toBe('My Custom Session');

    // Clear name with null
    const cleared = await runtime.setSessionName(session.id, null);
    expect(cleared.name).toBeUndefined();
    expect(cleared.updatedAt).toBe(originalUpdatedAt);

    const fetchedAfterClear = await runtime.getSession(session.id);
    expect(fetchedAfterClear?.name).toBeUndefined();

    await runtime.shutdown();
    repos.close();
  });

  it('allows renaming archived session and preserves name', async () => {
    const { repos, runtime } = createHarness();
    await runtime.initialize([agent]);
    const session = await runtime.start({ agentId: agent.id });
    await runtime.archive(session.id);

    const archivedSession = await runtime.getSession(session.id);
    expect(archivedSession?.archivedAt).toBeDefined();

    const renamed = await runtime.setSessionName(session.id, 'Archived Renamed');
    expect(renamed.name).toBe('Archived Renamed');

    const fetched = await runtime.getSession(session.id);
    expect(fetched?.name).toBe('Archived Renamed');

    await runtime.shutdown();
    repos.close();
  });

  it('renames a genuinely running session without extra driver calls or mutated session/task fields', async () => {
    // sendStarted resolves only once driver.send has actually been entered;
    // sendGate keeps the driver turn open (and thus the session busy) until released.
    let markSendStarted!: () => void;
    const sendStarted = new Promise<void>(resolve => { markSendStarted = resolve; });
    let unblockSend!: () => void;
    const sendGate = new Promise<void>(resolve => { unblockSend = resolve; });

    const h = createHarness();
    // Override the harness driver so send() genuinely blocks while the turn is in flight.
    // No synthetic events: the runtime already transitions state to 'thinking' before
    // invoking driver.send, so emitting one here would only race an extra saveState.
    h.driver.send = vi.fn(async () => {
      markSendStarted();
      await sendGate;
      h.emit({ type: 'text', data: { text: 'done' } });
      h.emit({ type: 'completed', data: { stopReason: 'end_turn' } });
    });

    await h.runtime.initialize([agent]);
    const session = await h.runtime.start({ agentId: agent.id });
    const startCallsBefore = (h.driver.start as ReturnType<typeof vi.fn>).mock.calls.length;
    const stopCallsBefore = (h.driver.stop as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(startCallsBefore).toBeGreaterThanOrEqual(1);
    expect(stopCallsBefore).toBe(0);

    const sendPromise = h.runtime.send(session.id, 'Do some task');
    await sendStarted;
    // Prove the turn is actually running (state set by the runtime before driver.send).
    await vi.waitFor(async () => expect((await h.repos.sessions.get(session.id))?.state).toBe('thinking'));

    // Baseline captured only after driver.send is genuinely in flight.
    const before = await h.repos.sessions.get(session.id);
    expect(before).toBeDefined();
    const beforeRunId = before!.runId;
    const beforeCwd = before!.cwd;
    const beforeState = before!.state;
    const beforeUpdatedAt = before!.updatedAt;

    const renamed = await h.runtime.setSessionName(session.id, 'Busy Session');
    expect(renamed.name).toBe('Busy Session');

    // Rename must not touch the driver or execution lifecycle.
    expect((h.driver.start as ReturnType<typeof vi.fn>).mock.calls.length).toBe(startCallsBefore);
    expect((h.driver.stop as ReturnType<typeof vi.fn>).mock.calls.length).toBe(stopCallsBefore);

    const after = await h.repos.sessions.get(session.id);
    expect(after?.runId).toBe(beforeRunId);
    expect(after?.cwd).toBe(beforeCwd);
    expect(after?.state).toBe(beforeState);
    expect(after?.updatedAt).toBe(beforeUpdatedAt);

    const tasks = await h.runtime.getTasks(session.id);
    expect(tasks[0]?.prompt).toBe('Do some task');

    unblockSend();
    const sendResult = await sendPromise;
    expect(sendResult.status).toBe('completed');

    // Name still projected after the turn completes; driver start/stop counts unchanged by rename.
    expect((await h.runtime.getSession(session.id))?.name).toBe('Busy Session');
    expect((h.driver.start as ReturnType<typeof vi.fn>).mock.calls.length).toBe(startCallsBefore);
    expect((h.driver.stop as ReturnType<typeof vi.fn>).mock.calls.length).toBe(stopCallsBefore);

    await h.runtime.shutdown();
    h.repos.close();
  });

  it('projects the persisted name through representative session mutations and drops it after reset', async () => {
    const { repos, runtime } = createHarness();
    await runtime.initialize([agent]);
    const session = await runtime.start({ agentId: agent.id });
    await runtime.setSessionName(session.id, 'Mutation Name');

    // config mutation (setModel) returns the projected name
    const modelUpdated = await runtime.setModel(session.id, 'custom/model');
    expect(modelUpdated.name).toBe('Mutation Name');
    expect(modelUpdated.model).toBe('custom/model');

    // reset then a representative mutation must not resurrect the name
    await runtime.setSessionName(session.id, null);
    const modelAfterReset = await runtime.setModel(session.id, 'custom/model-2');
    expect(modelAfterReset.name).toBeUndefined();

    // rename again so restart/archive below have a name to project
    await runtime.setSessionName(session.id, 'Mutation Name');

    // restart returns a fresh run but keeps the projected name
    const restarted = await runtime.restart(session.id);
    expect(restarted.name).toBe('Mutation Name');
    expect(restarted.runId).not.toBe(session.runId);
    const persistedAfterRestart = await repos.sessions.get(session.id);
    expect(persistedAfterRestart?.name).toBeUndefined();

    // archive returns the projected name
    const archived = await runtime.archive(session.id);
    expect(archived.name).toBe('Mutation Name');
    expect(archived.archivedAt).toBeDefined();

    // reset on the archived session leaves no residual name
    await runtime.setSessionName(session.id, null);
    expect((await runtime.getSession(session.id))?.name).toBeUndefined();

    await runtime.shutdown();
    repos.close();
  });

  it('persists session names across runtime database restarts using real SQLite file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dutydeck-session-name-db-'));
    dirs.push(dir);
    const dbPath = join(dir, 'test.db');

    // 1st instance: create and name session
    {
      const h1 = createHarness(dbPath);
      await h1.runtime.initialize([agent]);
      const session = await h1.runtime.start({ agentId: agent.id });
      await h1.runtime.setSessionName(session.id, 'Persistent Across Restart');
      await h1.runtime.shutdown();
      h1.repos.close();
    }

    // 2nd instance: reopen same SQLite DB
    {
      const h2 = createHarness(dbPath);
      await h2.runtime.initialize([agent]);
      const listed = await h2.runtime.listSessions();
      expect(listed.length).toBeGreaterThan(0);
      const session = listed[0]!;
      expect(session.name).toBe('Persistent Across Restart');

      const fetched = await h2.runtime.getSession(session.id);
      expect(fetched?.name).toBe('Persistent Across Restart');

      // Clear in 2nd instance
      await h2.runtime.setSessionName(session.id, null);
      const afterClear = await h2.runtime.getSession(session.id);
      expect(afterClear?.name).toBeUndefined();

      await h2.runtime.shutdown();
      h2.repos.close();
    }
  });
});
