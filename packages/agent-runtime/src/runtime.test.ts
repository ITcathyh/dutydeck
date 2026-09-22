import { describe, expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import type { AgentConfig, Session, ToolRiskPolicy } from '@dutydeck/shared';
import { RuntimeError } from '@dutydeck/shared';
import { DutydeckRuntime, type AgentDriver, type DriverFactory } from './index.js';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const agent: AgentConfig = { id: 'mock', name: 'Mock', command: process.execPath, args: [], protocol: 'acp', cwd: '/tmp', env: {}, permissionMode: 'ask', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };

function harness(options: { onSend?: (emit: (event: any) => void) => void | 'manual'; exitOnSend?: number; driverIdleTimeoutMs?: number; sessionEnvironment?: (session: Session) => Record<string, string>; sessionPrompt?: (session: Session, prompt: string) => string | Promise<string>; resolvePermission?: (id: string, approved: boolean) => Promise<boolean>; authorizeTask?: NonNullable<ConstructorParameters<typeof DutydeckRuntime>[1]>['authorizeTask'] } = {}) {
  const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' }); let emit!: (event: any) => void; let exit!: (code: number | null) => void; const configuredAgents: AgentConfig[] = [];
  let boundExecution: ReturnType<typeof repos.execution.bind> | undefined;
  const bindExecution = repos.execution.bind.bind(repos.execution);
  vi.spyOn(repos.execution, 'bind').mockImplementation(claim => { boundExecution = bindExecution(claim); return boundExecution; });
  const driver: AgentDriver = { start: vi.fn(async () => {}), send: vi.fn(async () => { const mode = options.onSend?.(emit); if (mode !== 'manual') emit({ type: 'completed', data: { stopReason: 'end_turn' } }); if (options.exitOnSend) exit(options.exitOnSend); }), interrupt: vi.fn(async () => {}), resume: vi.fn(async () => {}), isStopped: async () => true, stop: vi.fn(async () => {}), resolvePermission: vi.fn(options.resolvePermission ?? (async () => true)), setModel: vi.fn(async () => {}), setReasoningEffort: vi.fn(async () => {}), setPermissionMode: vi.fn() };
  const runtime = new DutydeckRuntime(repos, { probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }), driverFactory: (configuredAgent, _p, onEvent, onExit) => { configuredAgents.push(configuredAgent); emit = onEvent; exit = onExit; return driver; }, driverIdleTimeoutMs: options.driverIdleTimeoutMs, sessionEnvironment: options.sessionEnvironment, sessionPrompt: options.sessionPrompt, authorizeTask: options.authorizeTask });
  return { repos, runtime, driver, configuredAgents, bound: () => boundExecution!, emit: (event: any) => emit(event), exit: (code: number | null) => exit(code) };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe('runtime lifecycle acceptance', () => {
  it('removes stale built-in demo agents during configuration sync', async () => {
    const h = harness();
    await h.repos.agents.save({ ...agent, id: 'mock-acp', name: 'Mock ACP', builtin: true });
    await h.runtime.initialize([agent]);
    expect((await h.runtime.listAgents()).map(item => item.id)).toEqual(['mock']);
    await h.runtime.shutdown(); h.repos.close();
  });

  it('starts, streams a prompt, and completes while preserving tool correlation', async () => {
    const h = harness({ onSend: emit => { emit({ type: 'thinking', data: { text: 'think' } }); emit({ type: 'tool_call', data: { id: 't', name: 'read', input: '.', status: 'running' } }); emit({ type: 'tool_result', data: { id: 't', name: 'read', output: 'ok', status: 'completed' } }); emit({ type: 'text', data: { text: 'done' } }); } });
    await h.runtime.initialize([agent]); const session = await h.runtime.start({ agentId: 'mock' }); const result = await h.runtime.send(session.id, 'work');
    expect(result.status).toBe('completed');
    expect((await h.runtime.getSession(session.id))?.state).toBe('idle');
    const events = await h.runtime.getEvents(session.id); expect(events.map(e => e.type)).toEqual(expect.arrayContaining(['thinking', 'tool_call', 'tool_result', 'text', 'completed']));
    const call = events.find(e => e.type === 'tool_call')!;
    const toolResult = events.find(e => e.type === 'tool_result')!;
    const callData = call.data as { id: string; input?: unknown };
    const resultData = toolResult.data as { id: string; input?: unknown; completedAt?: unknown };
    expect(resultData.id).toBe(callData.id);
    expect(resultData.input).toBe('.');
    expect(resultData.completedAt).toBeDefined();
    await h.runtime.shutdown(); h.repos.close();
  });

  it('passes explicit model and reasoning effort to the Agent driver', async () => {
    const h = harness(); await h.runtime.initialize([agent]);
    const session = await h.runtime.start({ agentId: 'mock', model: 'model-selected-in-web', reasoningEffort: 'high' });
    expect(session.model).toBe('model-selected-in-web');
    expect(session.reasoningEffort).toBe('high');
    expect(h.configuredAgents[0]?.model).toBe('model-selected-in-web');
    expect(h.configuredAgents[0]?.reasoningEffort).toBe('high');
    await h.runtime.shutdown(); h.repos.close();
  });

  it('archives a session and discards partial driver state when startup fails', async () => {
    const h = harness(); await h.runtime.initialize([agent]);
    h.driver.start = vi.fn(async () => { throw new Error('SDK unavailable'); });
    await expect(h.runtime.start({ agentId: 'mock' })).rejects.toMatchObject({ code: 'START_FAILED', statusCode: 503 });
    const [session] = await h.runtime.listSessions();
    expect(session).toMatchObject({ state: 'failed', error: 'SDK unavailable' });
    expect(session?.archivedAt).toBeTruthy();
    expect(h.driver.stop).toHaveBeenCalledWith({ discardSession: true });
    await h.runtime.shutdown(); h.repos.close();
  });

  it('switches the active ACP model and persists the selection between turns', async () => {
    const h = harness(); await h.runtime.initialize([agent]);
    const session = await h.runtime.start({ agentId: 'mock', model: 'model-a' });
    await expect(h.runtime.setModel(session.id, 'model-b')).resolves.toMatchObject({ model: 'model-b' });
    expect(h.driver.setModel).toHaveBeenCalledWith('model-b');
    expect(await h.runtime.getSession(session.id)).toMatchObject({ model: 'model-b' });
    await h.runtime.shutdown(); h.repos.close();
  });

  it('switches reasoning effort without recreating the Session', async () => {
    const h = harness(); await h.runtime.initialize([agent]);
    const session = await h.runtime.start({ agentId: 'mock', reasoningEffort: 'medium' });
    await expect(h.runtime.setReasoningEffort(session.id, 'high')).resolves.toMatchObject({ reasoningEffort: 'high' });
    expect(h.driver.setReasoningEffort).toHaveBeenCalledWith('high');
    expect(await h.runtime.getSession(session.id)).toMatchObject({ reasoningEffort: 'high', runId: session.runId });
    await h.runtime.shutdown(); h.repos.close();
  });

  it('preserves the configured permission posture and lets session input make it stricter', async () => {
    const h = harness(); await h.runtime.initialize([{ ...agent, permissionMode: 'ask' }]);
    const session = await h.runtime.start({ agentId: 'mock', permissionMode: 'deny-all' });
    expect(session.permissionMode).toBe('deny-all');
    expect(h.configuredAgents[0]?.permissionMode).toBe('deny-all');
    expect((await h.runtime.listAgents())[0]?.permissionMode).toBe('ask');
    await h.runtime.shutdown(); h.repos.close();
  });

  it('preserves the permission posture of persisted sessions during initialization', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dutydeck-posture-'));
    const path = join(dir, 'state.sqlite');
    const firstRepos = createRepositories(path, { newDatabaseAuthority: 'ledger_v1' });
    const firstRuntime = new DutydeckRuntime(firstRepos, {
      driverIdleTimeoutMs: 0,
      probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }),
      driverFactory: () => ({ start: vi.fn(async () => {}), send: vi.fn(async () => {}), interrupt: vi.fn(async () => {}), resume: vi.fn(async () => {}), isStopped: async () => true, stop: vi.fn(async () => {}) })
    });
    await firstRuntime.initialize([{ ...agent, permissionMode: 'ask' }]);
    const session = await firstRuntime.start({ agentId: 'mock' });
    expect(session.permissionMode).toBe('ask');
    await firstRuntime.shutdown();
    firstRepos.close();

    // Reopen with a full-trust Agent default; the existing Session must preserve its ask posture.
    const secondRepos = createRepositories(path, { newDatabaseAuthority: 'ledger_v1' });
    const secondRuntime = new DutydeckRuntime(secondRepos, {
      driverIdleTimeoutMs: 0,
      probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }),
      driverFactory: () => ({ start: vi.fn(async () => {}), send: vi.fn(async () => {}), interrupt: vi.fn(async () => {}), resume: vi.fn(async () => {}), isStopped: async () => true, stop: vi.fn(async () => {}) })
    });
    try {
      await secondRuntime.initialize([{ ...agent, permissionMode: 'full-trust' }]);
      const restored = await secondRuntime.getSession(session.id);
      expect(restored?.id).toBe(session.id);
      expect(restored?.permissionMode).toBe('ask');
    } finally {
      await secondRuntime.shutdown();
      secondRepos.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('switches permission mode only when the live driver can apply it', async () => {
    const h = harness(); await h.runtime.initialize([agent]);
    const session = await h.runtime.start({ agentId: 'mock' });
    await expect(h.runtime.setPermissionMode(session.id, 'full-trust')).resolves.toMatchObject({ permissionMode: 'full-trust' });
    expect(h.driver.setPermissionMode).toHaveBeenCalledWith('full-trust');
    await h.runtime.shutdown(); h.repos.close();
  });

  it('does not persist a permission change that a live driver cannot apply', async () => {
    const h = harness(); await h.runtime.initialize([agent]);
    const session = await h.runtime.start({ agentId: 'mock' });
    delete h.driver.setPermissionMode;
    await expect(h.runtime.setPermissionMode(session.id, 'full-trust')).rejects.toMatchObject({ code: 'PERMISSION_MODE_SWITCH_UNSUPPORTED', statusCode: 422 });
    expect(await h.runtime.getSession(session.id)).toMatchObject({ permissionMode: 'ask' });
    await h.runtime.shutdown(); h.repos.close();
  });

  it('marks tasks left running by a previous process reconcile_required during legacy upgrade', async () => {
    const timestamp = new Date().toISOString();
    const directory = mkdtempSync(join(tmpdir(), 'dutydeck-legacy-running-'));
    const path = join(directory, 'state.sqlite');
    const legacy = createRepositories(path);
    await legacy.sessions.save({ id: 'ses_orphaned', agentId: 'mock', state: 'running_tool', cwd: '/tmp', permissionMode: 'full-trust', protocol: 'acp', runId: 'run_old', createdAt: timestamp, updatedAt: timestamp });
    await legacy.tasks.save({ id: 'task_orphaned', sessionId: 'ses_orphaned', prompt: 'long task', status: 'running', createdAt: timestamp, updatedAt: timestamp });
    legacy.execution.upgradeLegacy();
    legacy.close();

    const repos = createRepositories(path, { newDatabaseAuthority: 'ledger_v1' });
    const runtime = new DutydeckRuntime(repos, { driverIdleTimeoutMs: 0, probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }), driverFactory: () => ({ start: async () => {}, send: async () => {}, interrupt: async () => {}, resume: async () => {}, isStopped: async () => true, stop: async () => {} }) });
    try {
      await runtime.initialize([agent]);
      // A single ambiguous running turn converts to reconcile_required; its
      // Session projection is interrupted and the old result is never guessed.
      expect((await runtime.getTasks('ses_orphaned'))[0]?.status).toBe('reconcile_required');
      expect((await runtime.getSession('ses_orphaned'))?.state).toBe('interrupted');
    } finally { await runtime.shutdown(); repos.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it('blocks legacy queued tasks that lack frozen execution options instead of replaying them', async () => {
    const timestamp = new Date().toISOString();
    const directory = mkdtempSync(join(tmpdir(), 'dutydeck-legacy-queue-'));
    const path = join(directory, 'state.sqlite');
    const legacy = createRepositories(path);
    await legacy.sessions.save({ id: 'ses_legacy_queue', agentId: 'mock', state: 'completed', cwd: '/tmp', permissionMode: 'full-trust', protocol: 'acp', runId: 'run_old', createdAt: timestamp, updatedAt: timestamp });
    await legacy.tasks.save({ id: 'task_legacy_queue', sessionId: 'ses_legacy_queue', prompt: 'do not replay without options', status: 'queued', createdAt: timestamp, updatedAt: timestamp });
    legacy.execution.upgradeLegacy();
    legacy.close();

    const repos = createRepositories(path, { newDatabaseAuthority: 'ledger_v1' });
    let sent = 0;
    const runtime = new DutydeckRuntime(repos, { driverIdleTimeoutMs: 0, probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }), driverFactory: () => ({ start: async () => {}, send: async () => { sent++; }, interrupt: async () => {}, resume: async () => {}, isStopped: async () => true, stop: async () => {} }) });
    try {
      await runtime.initialize([agent]);
      // No frozen execution options => the queued Task is blocked and the
      // driver is never invoked; the consumer-facing send would report
      // INPUT_OPTIONS_UNVERIFIABLE/INPUT_SNAPSHOT_UNVERIFIABLE rather than replay.
      expect(sent).toBe(0);
      // A queued legacy Task carries no frozen accepted input, so it can never
      // pass the v2 execution-options gate; it is exposed only as legacy_partial.
      const accepted = repos.execution.getAcceptedTask('task_legacy_queue');
      expect(accepted?.input).toBeUndefined();
      expect(accepted?.replayValidation).toBe('legacy_partial');
      expect((await runtime.getTasks('ses_legacy_queue'))[0]?.status).toBe('queued');
    } finally { await runtime.shutdown(); repos.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it('keeps an incomplete startup Session blocked as a recovery blocker rather than archiving it silently', async () => {
    const timestamp = new Date().toISOString();
    const directory = mkdtempSync(join(tmpdir(), 'dutydeck-legacy-starting-'));
    const path = join(directory, 'state.sqlite');
    const legacy = createRepositories(path);
    await legacy.sessions.save({ id: 'ses_starting', agentId: 'mock', state: 'starting', cwd: '/tmp', permissionMode: 'full-trust', protocol: 'acp', runId: 'run_old', createdAt: timestamp, updatedAt: timestamp });
    legacy.execution.upgradeLegacy();
    legacy.close();

    const repos = createRepositories(path, { newDatabaseAuthority: 'ledger_v1' });
    let factoryCalls = 0;
    const runtime = new DutydeckRuntime(repos, { driverIdleTimeoutMs: 0, probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }), driverFactory: () => { factoryCalls++; return { start: async () => {}, send: async () => {}, interrupt: async () => {}, resume: async () => {}, isStopped: async () => true, stop: async () => {} }; } });
    try {
      await runtime.initialize([agent]);
      // The legacy Session is not auto-archived; it carries an unresolved
      // legacy resource blocker and never spawns a driver.
      const blockers = repos.execution.getSessionResourceBlockers('ses_starting').map(b => b.code);
      expect(blockers.some(code => code === 'LEGACY_RESOURCE_UNSAFE' || code === 'DRIVER_RESOURCE_UNSAFE')).toBe(true);
      expect(factoryCalls).toBe(0);
      expect((await runtime.getSession('ses_starting'))?.archivedAt).toBeFalsy();
    } finally { await runtime.shutdown(); repos.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it('persists the source metadata used by external chat channels', async () => {
    const h = harness(); await h.runtime.initialize([agent]);
    const session = await h.runtime.start({ agentId: 'mock', source: 'lark', sourceId: 'cli_test:oc_chat' });
    expect(await h.runtime.getSession(session.id)).toMatchObject({ source: 'lark', sourceId: 'cli_test:oc_chat' });
    await h.runtime.shutdown(); h.repos.close();
  });

  it('injects session-scoped environment without replacing the Agent environment', async () => {
    const h = harness({ sessionEnvironment: (current): Record<string, string> => current.source === 'lark' ? { GROUP_TOKEN: current.id, RESERVED: 'scoped' } : {} });
    await h.runtime.initialize([{ ...agent, env: { KEEP_ME: 'yes', RESERVED: 'agent' } }]);
    const session = await h.runtime.start({ agentId: 'mock', source: 'lark', sourceId: 'cli_test:oc_chat' });
    expect(h.configuredAgents[0]?.env).toEqual({ KEEP_ME: 'yes', RESERVED: 'scoped', GROUP_TOKEN: session.id });
    await h.runtime.shutdown(); h.repos.close();
  });

  it('applies session-scoped prompt context to every entry point without changing persisted user text', async () => {
    const h = harness({ sessionPrompt: (current, prompt) => current.source === 'lark' ? `[group:${current.sourceId}]\n${prompt}` : prompt });
    await h.runtime.initialize([agent]);
    const session = await h.runtime.start({ agentId: 'mock', source: 'lark', sourceId: 'cli_test:oc_chat:group' });
    // A Lark-channel Session requires the channel actor carrying its App id.
    await h.runtime.dispatch(session.id, 'from web', 'queue', 'from web', undefined, 'ou_user');
    await vi.waitFor(() => expect(h.driver.send).toHaveBeenCalledWith('[group:cli_test:oc_chat:group]\nfrom web'));
    expect((await h.runtime.getTasks(session.id))[0]?.prompt).toBe('from web');
    await h.runtime.shutdown(); h.repos.close();
  });

  it('keeps the same agent session across consecutive turns', async () => {
    const h = harness({ onSend: emit => emit({ type: 'text', data: { text: 'answer' } }) });
    await h.runtime.initialize([agent]); const session = await h.runtime.start({ agentId: 'mock' });
    await h.runtime.send(session.id, 'first'); await h.runtime.send(session.id, 'second');
    expect(h.driver.start).toHaveBeenCalledOnce(); expect(h.driver.send).toHaveBeenCalledTimes(2);
    expect((await h.runtime.getTasks(session.id)).map(task => task.prompt)).toEqual(['first', 'second']); await h.runtime.shutdown(); h.repos.close();
  });

  it('persists queued prompts, runs them in order, and supports cancellation', async () => {
    const gate = deferred(); const h = harness();
    h.driver.send = vi.fn(async prompt => { if (prompt === 'first') await gate.promise; h.emit({ type: 'text', data: { text: `answer:${prompt}` } }); h.emit({ type: 'completed', data: { stopReason: 'end_turn' } }); });
    await h.runtime.initialize([agent]); const session = await h.runtime.start({ agentId: 'mock' });
    const first = await h.runtime.dispatch(session.id, 'first'); await vi.waitFor(() => expect(h.driver.send).toHaveBeenCalledWith('first'));
    const second = await h.runtime.dispatch(session.id, 'second');
    const third = await h.runtime.dispatch(session.id, 'third');
    expect((await h.runtime.getTasks(session.id)).filter(task => task.status === 'queued').map(task => task.id)).toEqual([second.id, third.id]);
    expect((await h.runtime.getTasks(session.id)).find(task => task.id === second.id)?.status).toBe('queued');
    await h.runtime.cancelQueued(session.id, second.id, 'installation_owner');
    gate.resolve();
    await vi.waitFor(() => expect(h.driver.send).toHaveBeenCalledWith('third'));
    await vi.waitFor(async () => expect((await h.runtime.getTasks(session.id)).find(task => task.prompt === 'third')?.status).toBe('completed'));
    expect((h.driver.send as ReturnType<typeof vi.fn>).mock.calls.map(call => call[0])).toEqual(['first', 'third']);
    expect((await h.runtime.getTasks(session.id)).find(task => task.id === second.id)?.status).toBe('cancelled');
    await h.runtime.shutdown(); h.repos.close();
  });

  it('interrupts a queued task revoked at the final submission fence without sending or recording an error', async () => {
    const firstGate = deferred();
    const phases: string[] = [];
    const h = harness({
      authorizeTask: async (_session, task, phase) => {
        phases.push(`${task.prompt}:${phase}`);
        if (task.prompt === 'revoked' && phase === 'submit') throw new RuntimeError('SESSION_AUTOMATION_TASK_REVOKED', 'automation was disabled', 409);
      }
    });
    h.driver.send = vi.fn(async prompt => {
      if (prompt === 'first') await firstGate.promise;
      h.emit({ type: 'text', data: { text: `answer:${prompt}` } });
      h.emit({ type: 'completed', data: { stopReason: 'end_turn' } });
    });
    await h.runtime.initialize([agent]); const session = await h.runtime.start({ agentId: agent.id });
    await h.runtime.dispatch(session.id, 'first'); await vi.waitFor(() => expect(h.driver.send).toHaveBeenCalledWith('first'));
    const revoked = await h.runtime.dispatch(session.id, 'revoked');
    firstGate.resolve();
    // An unsubmitted Attempt rejected at the submit fence settles cancelled.
    await vi.waitFor(async () => expect((await h.runtime.getTasks(session.id)).find(task => task.id === revoked.id)?.status).toBe('cancelled'));
    expect(h.driver.send).toHaveBeenCalledTimes(1);
    expect(phases).toContain('revoked:submit');
    expect((await h.runtime.getEvents(session.id)).filter(event => event.type === 'error')).toEqual([]);
    await h.runtime.shutdown(); h.repos.close();
  });

  it('does not auto-resubmit a legacy queued task lacking frozen v2 options after restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dutydeck-runtime-recovery-'));
    const database = join(directory, 'dutydeck.db');
    const timestamp = new Date().toISOString();
    const riskPolicy: ToolRiskPolicy = { enabled: true, authorized: true, pattern: 'rm\\s', actorEmail: 'owner@example.com', reason: 'approved in Lark' };
    const rawContext = { agentPrompt: 'agent prompt with group context', riskPolicy };
    // Seed a genuine legacy database with a queued task that has only a partial
    // (legacy_unverifiable) snapshot, then convert it offline.
    const seeded = createRepositories(database);
    await seeded.sessions.save({ id: 'ses_recovery', agentId: 'mock', state: 'completed', cwd: directory, permissionMode: 'full-trust', source: 'lark', sourceId: 'oc_group', protocol: 'acp', runId: 'run_old', createdAt: timestamp, updatedAt: timestamp });
    await seeded.tasks.save({
      id: 'task_recovery', sessionId: 'ses_recovery', prompt: 'visible user prompt', status: 'queued',
      executionContext: rawContext,
      createdAt: timestamp, updatedAt: timestamp
    });
    seeded.execution.upgradeLegacy();
    seeded.close();

    const repos = createRepositories(database, { newDatabaseAuthority: 'ledger_v1' });
    const driver: AgentDriver = {
      start: vi.fn(async () => {}),
      send: vi.fn(async () => {}),
      interrupt: vi.fn(async () => {}), resume: vi.fn(async () => {}),
      isStopped: async () => true, stop: vi.fn(async () => {}), setRiskPolicy: vi.fn()
    };
    const restored = new DutydeckRuntime(repos, {
      driverIdleTimeoutMs: 0,
      driverFactory: () => driver
    });
    try {
      await restored.initialize([agent]);
      await new Promise(resolve => setTimeout(resolve, 80));
      // The legacy partial input cannot be auto-resubmitted: zero driver calls
      // and the task stays queued behind INPUT_OPTIONS_UNVERIFIABLE.
      expect(driver.send).not.toHaveBeenCalled();
      expect(driver.setRiskPolicy).not.toHaveBeenCalled();

      // 1. Raw repository preserves the full original executionContext and riskPolicy
      const rawTasks = await repos.tasks.listBySession('ses_recovery');
      expect(rawTasks[0]?.executionContext).toEqual(rawContext);

      // 2. Frozen accepted input preserves the full original context without mutation
      const accepted = repos.execution.getAcceptedTask('task_recovery')!;
      expect(accepted.input?.executionContext).toEqual(rawContext);
      expect(accepted.input?.version).not.toBe(2);
      expect(accepted.replayValidation).toBe('legacy_partial');

      // 3. Runtime public getTasks exposes identity and visible prompt while redacting private context
      const publicTasks = await restored.getTasks('ses_recovery');
      const publicTask = publicTasks[0]!;
      expect(publicTask.id).toBe('task_recovery');
      expect(publicTask.prompt).toBe('visible user prompt');
      expect(publicTask.status).toBe('queued');
      expect(publicTask).not.toHaveProperty('executionContext');
      expect(publicTask).not.toHaveProperty('riskPolicy');
      const serialized = JSON.stringify(publicTask);
      expect(serialized).not.toContain('agent prompt with group context');
      expect(serialized).not.toContain('owner@example.com');
      expect(serialized).not.toContain('approved in Lark');
      // Match the actual JSON-encoded pattern (a single backslash is escaped to \\ in JSON text)
      expect(serialized).not.toContain(JSON.stringify(riskPolicy.pattern));
      expect(serialized).not.toContain('riskPolicy');
    } finally {
      await restored.shutdown();
      repos.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('cleans up a turn when the driver rejects its persisted risk policy and remains reusable', async () => {
    const h = harness({ onSend: emit => emit({ type: 'text', data: { text: 'answer' } }) });
    const policy: ToolRiskPolicy = { enabled: true, authorized: true, pattern: 'rm\\s' };
    h.driver.setRiskPolicy = vi.fn(current => { if (current) throw new Error('risk policy rejected'); });
    await h.runtime.initialize([agent]);
    const session = await h.runtime.start({ agentId: 'mock' });

    const failed = await h.runtime.dispatch(session.id, 'guarded work', 'queue', 'guarded agent prompt', policy);
    await vi.waitFor(async () => expect((await h.runtime.getTasks(session.id)).find(task => task.id === failed.id)?.status).toBe('failed'));
    expect(h.driver.send).not.toHaveBeenCalled();
    // The failure is recorded on the Attempt/event; the Session returns to idle.
    expect((await h.runtime.getSession(session.id))?.state).toBe('idle');
    const stored = h.repos.execution.getTaskExecution(failed.id)!;
    expect(stored.currentAttempt).toMatchObject({ state: 'settled', outcome: 'failed' });
    expect(stored.currentAttempt?.settlement).toMatchObject({ reason: expect.stringContaining('risk policy rejected') });

    await h.runtime.dispatch(session.id, 'safe retry');
    await vi.waitFor(async () => expect((await h.runtime.getTasks(session.id)).find(task => task.prompt === 'safe retry')?.status).toBe('completed'));
    expect(h.driver.send).toHaveBeenCalledWith('safe retry');
    await h.runtime.shutdown(); h.repos.close();
  });

  it('cleans up a turn when risk policy persistence fails and continues later queued work', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dutydeck-risk-write-'));
    const invalidCwd = join(directory, 'not-a-directory');
    await mkdir(invalidCwd);
    const h = harness({ onSend: emit => emit({ type: 'text', data: { text: 'answer' } }) });
    const policy: ToolRiskPolicy = { enabled: true, authorized: true, pattern: 'rm\\s' };
    h.driver.setRiskPolicy = vi.fn();
    try {
      await h.runtime.initialize([agent]);
      const session = await h.runtime.start({ agentId: 'mock', cwd: invalidCwd });
      await rm(invalidCwd, { recursive: true });
      await writeFile(invalidCwd, 'file blocks nested security directory');
      const failed = await h.runtime.dispatch(session.id, 'guarded work', 'queue', 'guarded agent prompt', policy);
      await vi.waitFor(async () => expect((await h.runtime.getTasks(session.id)).find(task => task.id === failed.id)?.status).toBe('failed'));
      expect(h.driver.setRiskPolicy).toHaveBeenCalledWith(policy);
      expect(h.driver.send).not.toHaveBeenCalled();

      await rm(invalidCwd, { force: true });
      await mkdir(invalidCwd);
      await h.runtime.dispatch(session.id, 'safe retry');
      await vi.waitFor(async () => expect((await h.runtime.getTasks(session.id)).find(task => task.prompt === 'safe retry')?.status).toBe('completed'));
      expect(h.driver.send).toHaveBeenCalledWith('safe retry');
      await h.runtime.shutdown(); h.repos.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('clears a previous task risk policy before running an unguarded task in the same session', async () => {
    const h = harness({ onSend: emit => emit({ type: 'text', data: { text: 'answer' } }) });
    const policy: ToolRiskPolicy = { enabled: true, authorized: true, pattern: 'rm\\s' };
    h.driver.setRiskPolicy = vi.fn();
    await h.runtime.initialize([agent]);
    const session = await h.runtime.start({ agentId: 'mock' });

    await h.runtime.dispatch(session.id, 'guarded', 'queue', 'guarded', policy);
    await vi.waitFor(async () => expect((await h.runtime.getTasks(session.id)).find(task => task.prompt === 'guarded')?.status).toBe('completed'));
    await h.runtime.dispatch(session.id, 'ordinary');
    await vi.waitFor(async () => expect((await h.runtime.getTasks(session.id)).find(task => task.prompt === 'ordinary')?.status).toBe('completed'));

    expect(h.driver.setRiskPolicy).toHaveBeenNthCalledWith(1, policy);
    expect(h.driver.setRiskPolicy).toHaveBeenNthCalledWith(2, undefined);
    await h.runtime.shutdown(); h.repos.close();
  });

  it('paginates across more than 5,000 events in the current turn without an unbounded history read', async () => {
    const h = harness({ onSend: emit => {
      emit({ type: 'text', data: { text: 'final answer before terminal noise' } });
      for (let index = 0; index < 5_000; index += 1) {
        emit({ type: 'raw_terminal', data: { text: 'noise:' + String(index) } });
      }
    } });
    await h.runtime.initialize([agent]);
    const session = await h.runtime.start({ agentId: 'mock' });
    // The settlement output digest pages through the bound ledger in bounded
    // windows rather than issuing an unbounded event read.
    const getPage = vi.spyOn(h.repos.execution, 'getAttemptEvents');

    await h.runtime.send(session.id, 'new work');

    expect(getPage.mock.calls.length).toBeGreaterThan(25);
    for (const [, window] of getPage.mock.calls) expect(window).toEqual(expect.objectContaining({ limit: 200 }));
    expect((await h.runtime.getTasks(session.id))[0]?.status).toBe('completed');
    await h.runtime.shutdown(); h.repos.close();
  });

  it('interrupts the active turn so the interrupt-mode replacement runs after it settles', async () => {
    const gate = deferred(); const h = harness();
    h.driver.send = vi.fn(async prompt => {
      if (prompt === 'first') await gate.promise;
      h.emit({ type: 'text', data: { text: `answer:${prompt}` } });
      h.emit({ type: 'completed', data: { stopReason: 'end_turn' } });
    });
    h.driver.interrupt = vi.fn(async () => gate.resolve());
    await h.runtime.initialize([agent]); const session = await h.runtime.start({ agentId: 'mock' });
    await h.runtime.dispatch(session.id, 'first'); await vi.waitFor(() => expect(h.driver.send).toHaveBeenCalledWith('first'));
    await h.runtime.dispatch(session.id, 'replacement', 'interrupt', 'replacement', undefined, 'installation_owner', undefined);
    await vi.waitFor(() => expect(h.driver.interrupt).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(h.driver.send).toHaveBeenCalledWith('replacement'));
    await vi.waitFor(async () => expect((await h.runtime.getTasks(session.id)).find(task => task.prompt === 'replacement')?.status).toBe('completed'));
    // Both turns completed on the same driver instance (interrupt, no recreate).
    expect(h.driver.start).toHaveBeenCalledTimes(1);
    await h.runtime.shutdown(); h.repos.close();
  });

  it('promotes an existing queued task ahead of the others after the interrupted active turn', async () => {
    const gate = deferred(); const h = harness();
    h.driver.send = vi.fn(async prompt => {
      if (prompt === 'first') await gate.promise;
      h.emit({ type: 'text', data: { text: `answer:${prompt}` } });
      h.emit({ type: 'completed', data: { stopReason: 'end_turn' } });
    });
    h.driver.interrupt = vi.fn(async () => gate.resolve());
    await h.runtime.initialize([agent]); const session = await h.runtime.start({ agentId: 'mock' });
    await h.runtime.dispatch(session.id, 'first'); await vi.waitFor(() => expect(h.driver.send).toHaveBeenCalledWith('first'));
    await h.runtime.dispatch(session.id, 'second');
    const third = await h.runtime.dispatch(session.id, 'third');
    await expect(h.runtime.steerQueued(session.id, third.id, 'installation_owner')).resolves.toMatchObject({ id: third.id, prompt: 'third' });
    await vi.waitFor(() => expect(h.driver.interrupt).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(h.driver.send).toHaveBeenCalledWith('third'));
    await vi.waitFor(() => expect(h.driver.send).toHaveBeenCalledWith('second'));
    expect((h.driver.send as ReturnType<typeof vi.fn>).mock.calls.map(call => call[0])).toEqual(['first', 'third', 'second']);
    const tasks = await h.runtime.getTasks(session.id);
    expect(tasks.find(task => task.id === third.id)?.status).toBe('completed');
    expect(tasks.find(task => task.prompt === 'first')?.status).toBe('completed');
    await h.runtime.shutdown(); h.repos.close();
  });

  it('reconnects a persisted completed session before its next turn', async () => {
    const first = harness({ onSend: emit => emit({ type: 'text', data: { text: 'answer' } }) }); await first.runtime.initialize([agent]); const session = await first.runtime.start({ agentId: 'mock' }); await first.runtime.send(session.id, 'before restart');
    const driver: AgentDriver = { start: vi.fn(async () => {}), send: vi.fn(async () => {}), interrupt: vi.fn(async () => {}), resume: vi.fn(async () => {}), isStopped: async () => true, stop: vi.fn(async () => {}) };
    await first.runtime.shutdown();
    const restored = new DutydeckRuntime(first.repos, { probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }), driverFactory: () => driver });
    await restored.initialize([agent]);
    await restored.send(session.id, 'after restart');
    expect(driver.start).toHaveBeenCalledOnce(); expect(driver.send).toHaveBeenCalledWith('after restart');
    expect((await restored.getTasks(session.id)).map(task => task.prompt)).toEqual(['before restart', 'after restart']); await restored.shutdown(); first.repos.close();
  });

  it('uses the persisted session system prompt when reconnecting after config changes', async () => {
    const first = harness({ onSend: emit => emit({ type: 'text', data: { text: 'answer' } }) });
    await first.runtime.initialize([{ ...agent, systemPrompt: 'session prompt' }]);
    const session = await first.runtime.start({ agentId: 'mock' });
    await first.runtime.send(session.id, 'before restart');
    await first.repos.agents.save({ ...agent, systemPrompt: 'new global prompt' });
    let configured: AgentConfig | undefined;
    const driver: AgentDriver = { start: vi.fn(async () => {}), send: vi.fn(async () => {}), interrupt: vi.fn(async () => {}), resume: vi.fn(async () => {}), isStopped: async () => true, stop: vi.fn(async () => {}) };
    await first.runtime.shutdown();
    const restored = new DutydeckRuntime(first.repos, { driverFactory: current => { configured = current; return driver; } });
    await restored.initialize([{ ...agent, systemPrompt: 'new global prompt' }]);
    await restored.send(session.id, 'after restart');
    expect(configured?.systemPrompt).toBe('session prompt');
    await restored.shutdown(); first.repos.close();
  });

  it('releases idle drivers and reconnects them on the next turn', async () => {
    const h = harness({ driverIdleTimeoutMs: 10, onSend: emit => emit({ type: 'text', data: { text: 'answer' } }) }); await h.runtime.initialize([agent]); const session = await h.runtime.start({ agentId: 'mock' }); await h.runtime.send(session.id, 'first');
    await h.runtime.cleanupIdleDrivers(Date.now() + 100);
    expect(h.driver.stop).toHaveBeenCalledOnce();
    await h.runtime.send(session.id, 'second');
    expect(h.driver.start).toHaveBeenCalledTimes(2); expect(h.driver.send).toHaveBeenCalledTimes(2); await h.runtime.shutdown(); h.repos.close();
  });

  it('interrupt signals the active turn and records the interrupt intent on the task', async () => {
    const gate = deferred();
    const h = harness();
    h.driver.send = vi.fn(async () => { await gate.promise; });
    await h.runtime.initialize([agent]); const s = await h.runtime.start({ agentId: 'mock' });
    const sending = h.runtime.send(s.id, 'busy').catch(() => {});
    await vi.waitFor(() => expect(h.runtime.getActiveTaskContext(s.id)).toBeTruthy());
    const taskId = h.runtime.getActiveTaskContext(s.id)!.taskId;
    await expect(h.runtime.interrupt(s.id, taskId, 'installation_owner')).resolves.toMatchObject({ interrupted: true });
    expect(h.driver.interrupt).toHaveBeenCalledOnce();
    // The interrupt intent (with actor) durably lands on the Task before the
    // unconfirmed turn settles.
    const task = h.repos.execution.getTaskExecution(taskId)!.task;
    expect(task.interruptedByActor).toBe('installation_owner');
    gate.resolve(); await sending;
    // Without a proven driver result the submitted Attempt stays reconcile.
    expect(h.repos.execution.getTaskExecution(taskId)!.currentAttempt?.state).toBe('reconcile_required');
    await h.runtime.shutdown(); h.repos.close();
  });

  it('reports no active attempt when interrupt is called on an idle session', async () => {
    const h = harness();
    await h.runtime.initialize([agent]); const s = await h.runtime.start({ agentId: 'mock' });
    await expect(h.runtime.interrupt(s.id)).resolves.toMatchObject({ interrupted: false, reason: 'no_active_attempt' });
    expect(h.driver.interrupt).not.toHaveBeenCalled();
    await h.runtime.shutdown(); h.repos.close();
  });

  it('persists the interrupt actor on the active task before and at the terminal write', async () => {
    const gate = deferred();
    const h = harness();
    h.driver.send = vi.fn(async () => { await gate.promise; });
    await h.runtime.initialize([agent]); const s = await h.runtime.start({ agentId: 'mock' });
    const sending = h.runtime.send(s.id, 'work');
    await vi.waitFor(() => expect(h.runtime.getActiveTaskContext(s.id)).toBeTruthy());
    const taskId = h.runtime.getActiveTaskContext(s.id)!.taskId;
    await h.runtime.interrupt(s.id, taskId, 'installation_owner');
    // The actor is recorded on the Task as part of the interrupt intent before
    // the in-flight turn settles, so it survives an immediate process exit.
    expect(h.repos.execution.getTaskExecution(taskId)!.task.interruptedByActor).toBe('installation_owner');
    gate.resolve();
    await sending.catch(() => {});
    const terminal = h.repos.execution.getTaskExecution(taskId)!.task;
    expect(terminal).toMatchObject({ id: taskId, interruptedByActor: 'installation_owner' });
    await h.runtime.shutdown(); h.repos.close();
  });

  it('leaves interruptedByActor unset when interrupt is called without an actor', async () => {
    const gate = deferred();
    const h = harness();
    h.driver.send = vi.fn(async () => { await gate.promise; });
    await h.runtime.initialize([agent]); const s = await h.runtime.start({ agentId: 'mock' });
    const sending = h.runtime.send(s.id, 'work').catch(() => {});
    await vi.waitFor(() => expect(h.runtime.getActiveTaskContext(s.id)).toBeTruthy());
    const taskId = h.runtime.getActiveTaskContext(s.id)!.taskId;
    // No actor on an unspecified (non-channel) session is allowed; it records no actor.
    await h.runtime.interrupt(s.id, taskId);
    gate.resolve();
    await sending;
    const terminal = h.repos.execution.getTaskExecution(taskId)!.task;
    expect(terminal.interruptedByActor).toBeUndefined();
    // The unconfirmed submitted Attempt stays reconcile_required, not guessed interrupted.
    expect(h.repos.execution.getTaskExecution(taskId)!.currentAttempt?.state).toBe('reconcile_required');
    await h.runtime.shutdown(); h.repos.close();
  });
  it('does not interrupt a replacement task when authorization finished for an older task', async () => {
    const secondTurn = deferred();
    const h = harness(); await h.runtime.initialize([agent]); const s = await h.runtime.start({ agentId: 'mock' });
    const sendMock = vi.fn(async () => {
      if (sendMock.mock.calls.length === 2) { await secondTurn.promise; }
      h.emit({ type: 'text', data: { text: 'done' } });
      h.emit({ type: 'completed', data: { stopReason: 'end_turn' } });
    });
    h.driver.send = sendMock;
    const first = await h.runtime.dispatch(s.id, 'first');
    const second = await h.runtime.dispatch(s.id, 'second');
    await vi.waitFor(() => expect(h.driver.send).toHaveBeenCalledTimes(2));
    // The first Task is no longer the active Attempt; interrupting by its id is rejected.
    await expect(h.runtime.interrupt(s.id, first.id)).rejects.toMatchObject({ code: 'TASK_NOT_ACTIVE', statusCode: 409 });
    expect(h.driver.interrupt).not.toHaveBeenCalled();
    secondTurn.resolve();
    await vi.waitFor(async () => expect((await h.runtime.getTasks(s.id)).find(task => task.id === second.id)?.status).toBe('completed'));
    await h.runtime.shutdown(); h.repos.close();
  });

  it('does not overwrite the queued replacement task while an interrupt on the first is in flight', async () => {
    const firstTurn = deferred(); const interruptDone = deferred();
    const h = harness(); await h.runtime.initialize([agent]); const s = await h.runtime.start({ agentId: 'mock' });
    h.driver.send = vi.fn(async () => { await firstTurn.promise; });
    h.driver.interrupt = vi.fn(async () => { await interruptDone.promise; });
    const first = await h.runtime.dispatch(s.id, 'first');
    const second = await h.runtime.dispatch(s.id, 'second');
    await vi.waitFor(() => expect(h.driver.send).toHaveBeenCalledTimes(1));
    const interrupting = h.runtime.interrupt(s.id, first.id, 'installation_owner');
    await vi.waitFor(() => expect(h.driver.interrupt).toHaveBeenCalledOnce());
    // While the interrupt is still finishing, only the first Task is touched;
    // the queued replacement keeps its identity and is not sent.
    expect(h.driver.send).toHaveBeenCalledTimes(1);
    firstTurn.resolve();
    interruptDone.resolve();
    await expect(interrupting).resolves.toMatchObject({ interrupted: true });
    expect(h.driver.send).toHaveBeenCalledTimes(1);
    const firstState = h.repos.execution.getTaskExecution(first.id)!;
    expect(firstState.task.interruptedByActor).toBe('installation_owner');
    expect((await h.runtime.getTasks(s.id)).find(task => task.id === second.id)?.status).toBe('queued');
    await h.runtime.shutdown(); h.repos.close();
  });
  it('stop delegates process-tree cleanup and marks stopped', async () => { const h = harness(); await h.runtime.initialize([agent]); const s = await h.runtime.start({ agentId: 'mock' }); await h.runtime.stop(s.id); expect(h.driver.stop).toHaveBeenCalledOnce(); expect((await h.runtime.getSession(s.id))?.state).toBe('stopped'); await h.runtime.shutdown(); h.repos.close(); });
  it('permanently archives a session and rejects subsequent actions', async () => { const h = harness(); await h.runtime.initialize([agent]); const s = await h.runtime.start({ agentId: 'mock' }); const archived = await h.runtime.archive(s.id); expect(archived.archivedAt).toBeTruthy(); expect(archived.state).toBe('stopped'); await expect(h.runtime.dispatch(s.id, 'not allowed')).rejects.toMatchObject({ code: 'SESSION_ARCHIVED' }); expect((await h.runtime.listSessions())[0]?.archivedAt).toBe(archived.archivedAt); await h.runtime.shutdown(); h.repos.close(); });
  it('restart creates a new run instance', async () => { const h = harness(); await h.runtime.initialize([agent]); const s = await h.runtime.start({ agentId: 'mock' }); const old = s.runId; const restarted = await h.runtime.restart(s.id); expect(restarted.runId).not.toBe(old); expect(h.driver.stop).toHaveBeenCalledOnce(); await h.runtime.shutdown(); h.repos.close(); });
  it('abnormal agent exit during an in-flight turn leaves its result unconfirmed (reconcile_required)', async () => {
    const h = harness();
    let releaseSend!: () => void;
    const sendGate = new Promise<void>(resolve => { releaseSend = resolve; });
    const sendEntered = deferred();
    h.driver.send = vi.fn(async () => {
      sendEntered.resolve();
      // Wait for exit callback invocation; never emits completed
      await sendGate;
    });
    await h.runtime.initialize([agent]); const s = await h.runtime.start({ agentId: 'mock' });
    const result = h.runtime.send(s.id, 'exit');
    void result.catch(() => {});
    try {
      await sendEntered.promise;

      // Capture the original Task/Attempt/Submission identity at the real SQLite intent fence.
      await vi.waitFor(async () => expect((await h.runtime.getTasks(s.id)).length).toBeGreaterThan(0));
      const taskId = (await h.runtime.getTasks(s.id))[0]!.id;
      let originalAttemptId = '';
      let originalSubmissionId = '';
      await vi.waitFor(() => {
        const stored = h.repos.execution.getTaskExecution(taskId);
        expect(stored?.currentAttempt?.submissionState).toBe('intent_recorded');
        originalAttemptId = stored!.currentAttempt!.attemptId;
        originalSubmissionId = stored!.currentAttempt!.submission!.submissionId;
      });

      // Real invocation of fixture exit callback without ever emitting completed
      h.exit(17);
      releaseSend();

      // The public send resolves (does not reject) with the unique reconcile_required result and original id
      const publicResult = await result;
      expect(publicResult.id).toBe(taskId);
      expect(publicResult.status).toBe('reconcile_required');

      // Task and the single Attempt settle reconcile_required while preserving Attempt/Submission identity
      await vi.waitFor(async () => {
        const task = (await h.runtime.getTasks(s.id))[0];
        expect(task?.id).toBe(taskId);
        expect(task?.status).toBe('reconcile_required');
      });
      const finalStored = h.repos.execution.getTaskExecution(taskId)!;
      expect(finalStored.attempts).toHaveLength(1);
      expect(finalStored.attempts[0]!.attemptId).toBe(originalAttemptId);
      expect(finalStored.attempts[0]!.submission?.submissionId).toBe(originalSubmissionId);
      expect(finalStored.attempts[0]!.state).toBe('reconcile_required');
      expect(finalStored.attempts[0]!.submissionState).toBe('intent_recorded');

      // No completed settlement event and no fabricated error event
      const events = await h.runtime.getEvents(s.id);
      expect(events.some(e => e.type === 'completed')).toBe(false);
      expect(events.some(e => e.type === 'error')).toBe(false);
    } finally {
      releaseSend();
      try {
        await h.runtime.shutdown();
      } finally {
        await Promise.allSettled([result]);
        h.repos.close();
      }
    }
  });
  it('permission requests call the live driver for approve and reject exactly once', async () => {
    const h = harness(); const permissionTurn = deferred();
    h.driver.send = vi.fn(async () => {
      h.emit({ type: 'permission_request', data: { id: 'p1', title: 'Write?', status: 'pending' } });
      h.emit({ type: 'permission_request', data: { id: 'p2', title: 'Delete?', status: 'pending' } });
      await permissionTurn.promise;
      h.emit({ type: 'text', data: { text: 'done' } });
      h.emit({ type: 'completed', data: { stopReason: 'end_turn' } });
    });
    await h.runtime.initialize([agent]); const s = await h.runtime.start({ agentId: 'mock' });
    const turn = h.runtime.send(s.id, 'write');
    await vi.waitFor(() => expect(h.runtime.getPendingPermissions(s.id)).toHaveLength(2));
    // The public permission id is attempt-scoped; resolve using those ids while
    // the driver still receives the original native ids.
    const pending = () => h.runtime.getPendingPermissions(s.id);
    const scoped = (title: string) => pending().find(item => (item as any).title === title)!.id;
    const writeId = scoped('Write?');
    expect((await h.runtime.resolvePermission(s.id, writeId, true)).status).toBe('approved');
    expect((await h.runtime.resolvePermission(s.id, scoped('Delete?'), false)).status).toBe('rejected');
    expect(h.driver.resolvePermission).toHaveBeenNthCalledWith(1, 'p1', true);
    expect(h.driver.resolvePermission).toHaveBeenNthCalledWith(2, 'p2', false);
    await expect(h.runtime.resolvePermission(s.id, writeId, true)).rejects.toMatchObject({ code: 'PERMISSION_NOT_FOUND' });
    permissionTurn.resolve(); expect((await turn).status).toBe('completed');
    await h.runtime.shutdown(); h.repos.close();
  });

  it('keeps a claim private while the driver decision is in flight', async () => {
    const gate = deferred(); const turnGate = deferred();
    const h = harness({ resolvePermission: async () => { await gate.promise; return true; } });
    h.driver.send = vi.fn(async () => {
      h.emit({ type: 'permission_request', data: { id: 'race', title: 'Race', status: 'pending' } });
      await turnGate.promise;
      h.emit({ type: 'completed', data: { stopReason: 'end_turn' } });
    });
    await h.runtime.initialize([agent]); const s = await h.runtime.start({ agentId: 'mock' });
    const turn = h.runtime.send(s.id, 'write');
    await vi.waitFor(() => expect(h.runtime.getPendingPermissions(s.id)).toHaveLength(1));
    const pid = h.runtime.getPendingPermissions(s.id)[0]!.id;
    const first = h.runtime.resolvePermission(s.id, pid, true);
    await vi.waitFor(() => expect(h.driver.resolvePermission).toHaveBeenCalledWith('race', true));
    expect(h.runtime.getPendingPermissions(s.id)).toEqual([]);
    await expect(h.runtime.resolvePermission(s.id, pid, true)).rejects.toMatchObject({ code: 'PERMISSION_RESOLVING', statusCode: 409 });
    gate.resolve();
    await expect(first).resolves.toMatchObject({ status: 'approved' });
    expect(h.driver.resolvePermission).toHaveBeenCalledTimes(1);
    turnGate.resolve(); await turn;
    await h.runtime.shutdown(); h.repos.close();
  });

  it('persists an approval intent before the driver and consumes it when audit delivery fails', async () => {
    const h = harness();
    const turnGate = deferred();
    h.driver.send = vi.fn(async () => {
      h.emit({ type: 'permission_request', data: { id: 'audit', title: 'Audit', status: 'pending' } });
      await turnGate.promise;
    });
    await h.runtime.initialize([agent]); const s = await h.runtime.start({ agentId: 'mock' });
    const turn = h.runtime.send(s.id, 'write').catch(error => error);
    await vi.waitFor(() => expect(h.runtime.getPendingPermissions(s.id)).toHaveLength(1));
    const pid = h.runtime.getPendingPermissions(s.id)[0]!.id;
    // The intent artifact is persisted before the driver call.
    const save = h.repos.artifacts.savePermission.bind(h.repos.artifacts);
    const order: string[] = [];
    h.repos.artifacts.savePermission = vi.fn(async (...args: Parameters<typeof save>) => { order.push('save'); return save(...args); });
    h.driver.resolvePermission = vi.fn(async () => { order.push('driver'); return true; });
    // The terminal accepted decision is audited through the bound appendEvent
    // command; make that one command fail.
    const execution = h.bound();
    const realAppend = execution.appendEvent.bind(execution);
    vi.spyOn(execution, 'appendEvent').mockImplementation((fence, event) => {
      if (event.type === 'permission_request' && (event.data as any)?.status === 'approved') { order.push('audit-fail'); throw new Error('event store down'); }
      return realAppend(fence, event);
    });
    await expect(h.runtime.resolvePermission(s.id, pid, true)).rejects.toMatchObject({ code: 'PERMISSION_ACCEPTED_AUDIT_FAILED', statusCode: 503 });
    expect(order.indexOf('save')).toBeLessThan(order.indexOf('driver'));
    expect(h.driver.resolvePermission).toHaveBeenCalledOnce();
    await expect(h.runtime.resolvePermission(s.id, pid, true)).rejects.toMatchObject({ code: 'PERMISSION_NOT_FOUND' });
    turnGate.resolve(); await turn;
    await h.runtime.shutdown(); h.repos.close();
  });

  it('does not submit to an old driver when stop wins while the decision intent is saving', async () => {
    const h = harness(); const gate = deferred(), entered = deferred(), turnGate = deferred();
    h.driver.send = vi.fn(async () => {
      h.emit({ type: 'permission_request', data: { id: 'stop-race', title: 'stop-race', status: 'pending' } });
      await turnGate.promise;
    });
    h.driver.stop = vi.fn(async () => { turnGate.resolve(); });
    await h.runtime.initialize([agent]); const s = await h.runtime.start({ agentId: agent.id }); const turn = h.runtime.send(s.id, 'work').catch(e => e);
    await vi.waitFor(() => expect(h.runtime.getPendingPermissions(s.id)).toHaveLength(1)); const id = h.runtime.getPendingPermissions(s.id)[0]!.id;
    const save = h.repos.artifacts.savePermission.bind(h.repos.artifacts);
    h.repos.artifacts.savePermission = vi.fn(async (...args: Parameters<typeof save>) => { entered.resolve(); await gate.promise; return save(...args); });
    const approval = h.runtime.resolvePermission(s.id, id, true).catch(e => e);
    await entered.promise;
    let stopped = false;
    const stop = h.runtime.stop(s.id).then(() => { stopped = true; });
    await new Promise(r => setImmediate(r));
    expect(stopped).toBe(false);
    gate.resolve();
    await stop;
    const result = await approval;
    expect(result).toMatchObject({ code: 'PERMISSION_EXPIRED' });
    expect(h.driver.resolvePermission).not.toHaveBeenCalled();
    await turn;
    await h.runtime.shutdown(); h.repos.close();
  });

  it('does not turn a synchronous terminal driver update into a false expiry', async () => {
    const h = harness();
    const turnGate = deferred();
    h.driver.send = vi.fn(async () => {
      h.emit({ type: 'permission_request', data: { id: 'synchronous-terminal', title: 'Sync', status: 'pending' } });
      await turnGate.promise;
    });
    await h.runtime.initialize([agent]); const s = await h.runtime.start({ agentId: 'mock' });
    const turn = h.runtime.send(s.id, 'write').catch(() => {});
    await vi.waitFor(() => expect(h.runtime.getPendingPermissions(s.id)).toHaveLength(1));
    const pid = h.runtime.getPendingPermissions(s.id)[0]!.id;
    let returned = false;
    h.driver.resolvePermission = vi.fn(async () => {
      h.emit({ type: 'permission_request', data: { id: 'synchronous-terminal', title: 'Sync', status: 'approved' } });
      await new Promise(resolve => setTimeout(resolve, 20));
      returned = true; return true;
    });
    await expect(h.runtime.resolvePermission(s.id, pid, true)).resolves.toMatchObject({ status: 'approved' });
    // Exactly one terminal approved audit event is written by the bounded
    // settlement, after the driver result is observed.
    const terminals = (await h.runtime.getEvents(s.id)).filter(event => event.type === 'permission_request' && (event.data as any).status === 'approved');
    expect(terminals).toHaveLength(1);
    expect(returned).toBe(true);
    turnGate.resolve(); await turn;
    await h.runtime.shutdown(); h.repos.close();
  });

  it('reports accepted decision when accepted artifact persistence fails after canonical event write', async () => {
    const h = harness();
    const turnGate = deferred();
    h.driver.send = vi.fn(async () => {
      h.emit({ type: 'permission_request', data: { id: 'save-failure', title: 'Save', status: 'pending' } });
      await turnGate.promise;
    });
    await h.runtime.initialize([agent]); const s = await h.runtime.start({ agentId: agent.id });
    const turn = h.runtime.send(s.id, 'work').catch(e => e);
    await vi.waitFor(() => expect(h.runtime.getPendingPermissions(s.id)).toHaveLength(1));
    const pid = h.runtime.getPendingPermissions(s.id)[0]!.id;
    const save = h.repos.artifacts.savePermission.bind(h.repos.artifacts);
    let failed = false;
    h.repos.artifacts.savePermission = vi.fn(async (...args: Parameters<typeof save>) => {
      if ((args[1] as { status?: string })?.status === 'approved') {
        failed = true;
        throw new Error('accepted artifact down');
      }
      return save(...args);
    });
    try {
      await expect(h.runtime.resolvePermission(s.id, pid, true)).resolves.toMatchObject({ status: 'approved' });
      expect(failed).toBe(true);
      expect(h.driver.resolvePermission).toHaveBeenCalledOnce();
      expect(h.driver.resolvePermission).toHaveBeenCalledWith('save-failure', true);
      expect(h.runtime.getPendingPermissions(s.id)).toEqual([]);
      expect((await h.runtime.getEvents(s.id)).filter(e => e.type === 'permission_request' && (e.data as any).status === 'approved')).toHaveLength(1);
      // Attempting to approve the same pid a second time is explicitly rejected and does not issue a second RPC
      await expect(h.runtime.resolvePermission(s.id, pid, true)).rejects.toMatchObject({ code: 'PERMISSION_NOT_FOUND' });
      expect(h.driver.resolvePermission).toHaveBeenCalledOnce();
    } finally {
      turnGate.resolve();
      await turn;
      await h.runtime.shutdown();
      h.repos.close();
    }
  });

  it('does not leave a retryable approval after the live driver rejects it', async () => {
    const turnGate = deferred();
    const h = harness({ resolvePermission: async () => false });
    h.driver.send = vi.fn(async () => {
      h.emit({ type: 'permission_request', data: { id: 'rejected-by-driver', title: 'Reject', status: 'pending' } });
      await turnGate.promise;
    });
    await h.runtime.initialize([agent]); const s = await h.runtime.start({ agentId: 'mock' });
    const turn = h.runtime.send(s.id, 'write').catch(() => {});
    await vi.waitFor(() => expect(h.runtime.getPendingPermissions(s.id)).toHaveLength(1));
    const pid = h.runtime.getPendingPermissions(s.id)[0]!.id;
    await expect(h.runtime.resolvePermission(s.id, pid, true)).rejects.toMatchObject({ code: 'PERMISSION_EXPIRED', statusCode: 409 });
    expect(h.driver.resolvePermission).toHaveBeenCalledOnce();
    await expect(h.runtime.resolvePermission(s.id, pid, true)).rejects.toMatchObject({ code: 'PERMISSION_NOT_FOUND' });
    turnGate.resolve(); await turn;
    await h.runtime.shutdown(); h.repos.close();
  });

  it('clears a pending permission when the driver reports its terminal state', async () => {
    const h = harness(); const turnGate = deferred();
    h.driver.send = vi.fn(async () => {
      h.emit({ type: 'permission_request', data: { id: 'terminal', title: 'Terminal', status: 'pending' } });
      await turnGate.promise;
    });
    await h.runtime.initialize([agent]); const s = await h.runtime.start({ agentId: 'mock' });
    const turn = h.runtime.send(s.id, 'write').catch(() => {});
    await vi.waitFor(() => expect(h.runtime.getPendingPermissions(s.id)).toHaveLength(1));
    h.emit({ type: 'permission_request', data: { id: 'terminal', title: 'Terminal', status: 'rejected' } });
    await vi.waitFor(() => expect(h.runtime.getPendingPermissions(s.id)).toEqual([]));
    await expect(h.runtime.resolvePermission(s.id, 'terminal', false)).rejects.toMatchObject({ code: 'PERMISSION_NOT_FOUND' });
    turnGate.resolve(); await turn;
    await h.runtime.shutdown(); h.repos.close();
  });

  it('drops callbacks from a stopped driver after restart even when the permission id repeats', async () => {
    const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' });
    const callbacks: Array<(event: any) => void> = [];
    const drivers: AgentDriver[] = [];
    let turn2Gate = deferred();
    const runtime = new DutydeckRuntime(repos, {
      probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }),
      driverFactory: (_configured, _protocol, onEvent) => {
        callbacks.push(onEvent);
        const index = drivers.length;
        const driver: AgentDriver = {
          start: vi.fn(async () => {}),
          send: vi.fn(async () => {
            if (index === 0) {
              onEvent({ type: 'text', data: { text: 'first turn output' } });
              onEvent({ type: 'completed', data: { stopReason: 'end_turn' } });
            } else {
              onEvent({ type: 'permission_request', data: { id: 'same', title: 'new', status: 'pending' } });
              await turn2Gate.promise;
              onEvent({ type: 'text', data: { text: 'second turn output' } });
              onEvent({ type: 'completed', data: { stopReason: 'end_turn' } });
            }
          }),
          interrupt: vi.fn(async () => {}),
          resume: vi.fn(async () => {}),
          isStopped: async () => true,
          stop: vi.fn(async () => { turn2Gate.resolve(); }),
          resolvePermission: vi.fn(async () => true)
        };
        drivers.push(driver);
        return driver;
      }
    });
    await runtime.initialize([agent]); const s = await runtime.start({ agentId: 'mock' });
    // First turn cleanly completes so Attempt 1 is settled and session is idle.
    await runtime.send(s.id, 'first');
    expect(drivers).toHaveLength(1);

    // Restart creates a new generation and prepares for driver 2.
    await runtime.restart(s.id);
    // Create a fresh gate for turn 2 so driver 1's stop during restart does not prematurely resolve it.
    turn2Gate = deferred();

    // Second turn starts; driver 2's Attempt is held in turn2Gate.
    const secondTurn = runtime.send(s.id, 'second');
    await vi.waitFor(() => expect(drivers).toHaveLength(2));
    await vi.waitFor(() => expect(drivers[1]!.send).toHaveBeenCalled());

    // Stale callback from driver 1's emitter emits permission 'same' from the dead generation.
    callbacks[0]!({ type: 'permission_request', data: { id: 'same', title: 'stale', status: 'pending' } });
    await new Promise(resolve => setTimeout(resolve, 20));

    // Only driver 2's permission 'new' is registered.
    await vi.waitFor(() => expect(runtime.getPendingPermissions(s.id)).toEqual([expect.objectContaining({ title: 'new' })]));
    const pid = runtime.getPendingPermissions(s.id)[0]!.id;
    await runtime.resolvePermission(s.id, pid, true);
    expect(drivers[0]!.resolvePermission).not.toHaveBeenCalled();
    expect(drivers[1]!.resolvePermission).toHaveBeenCalledWith('same', true);
    turn2Gate.resolve();
    await secondTurn;
    await runtime.shutdown(); repos.close();
  });

  it('uses durable task ids to replay duplicate dispatches and reject conflicting deliveries', async () => {
    const h = harness({ onSend: emit => emit({ type: 'text', data: { text: 'done' } }) });
    await h.runtime.initialize([agent]); const s = await h.runtime.start({ agentId: 'mock' });
    const owner = 'installation_owner';
    const accepted = await h.runtime.dispatch(s.id, 'one', 'queue', 'one', undefined, owner, 'message_1');
    const replay = await h.runtime.dispatch(s.id, 'one', 'queue', 'one', undefined, owner, 'message_1');
    expect(replay).toMatchObject({ id: accepted.id, replayed: true });
    // Same idempotency key with a mutated request digest is a conflict.
    await expect(h.runtime.dispatch(s.id, 'changed', 'queue', 'changed', undefined, owner, 'message_1')).rejects.toMatchObject({ code: 'TASK_IDEMPOTENCY_CONFLICT' });
    await vi.waitFor(() => expect(h.driver.send).toHaveBeenCalledTimes(1));
    await h.runtime.shutdown(); h.repos.close();
  });

  it('returns an explicit error for unsupported pause/resume', async () => { const h = harness(); await h.runtime.initialize([agent]); const s = await h.runtime.start({ agentId: 'mock' }); await expect(h.runtime.pause(s.id)).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY', statusCode: 422 }); await h.runtime.shutdown(); h.repos.close(); });
  it('returns a clear dependency error when a scanned Agent becomes unavailable', async () => { const h = harness(); const unavailable = { ...agent, id: 'trae', name: 'Trae', command: 'missing-trae' }; const runtime = new DutydeckRuntime(h.repos, { probe: () => ({ protocol: 'acp', available: false, detail: 'command disappeared after scan', pause: false, resume: true }) }); await runtime.initialize([unavailable]); await expect(runtime.start({ agentId: 'trae' })).rejects.toMatchObject({ code: 'AGENT_UNAVAILABLE' }); await runtime.shutdown(); h.repos.close(); });

  it('marks a turn failed when the agent stops mid-thinking without final text', async () => {
    const h = harness({ onSend: emit => { emit({ type: 'thinking', data: { text: 'still thinking' } }); emit({ type: 'completed', data: { stopReason: 'end_turn' } }); return 'manual'; } });
    await h.runtime.initialize([agent]); const s = await h.runtime.start({ agentId: 'mock' });
    await h.runtime.send(s.id, 'work');
    expect((await h.runtime.getTasks(s.id))[0]?.status).toBe('failed');
    const stored = h.repos.execution.getTaskExecution((await h.runtime.getTasks(s.id))[0]!.id)!; expect(stored.currentAttempt?.outcome).toBe('failed');
    await h.runtime.shutdown(); h.repos.close();
  });

  it('marks a turn failed when tools finish but the agent never returns final text', async () => {
    const h = harness({ onSend: emit => { emit({ type: 'tool_call', data: { id: 't', name: 'read', input: '.', status: 'running' } }); emit({ type: 'tool_result', data: { id: 't', name: 'read', output: 'ok', status: 'completed' } }); emit({ type: 'completed', data: { stopReason: 'end_turn' } }); return 'manual'; } });
    await h.runtime.initialize([agent]); const s = await h.runtime.start({ agentId: 'mock' });
    await h.runtime.send(s.id, 'work');
    expect((await h.runtime.getTasks(s.id))[0]?.status).toBe('failed');
    const stored = h.repos.execution.getTaskExecution((await h.runtime.getTasks(s.id))[0]!.id)!; expect(stored.currentAttempt?.outcome).toBe('failed');
    await h.runtime.shutdown(); h.repos.close();
  });

  it('keeps a shared session reusable after a task-level "no final output" failure so the next turn runs', async () => {
    // First turn produces activity but no terminal assistant text -> task fails.
    // The session must not be poisoned into `failed`; a following turn must run.
    const h = harness({ onSend: emit => { emit({ type: 'thinking', data: { text: 'still thinking' } }); emit({ type: 'completed', data: { stopReason: 'end_turn' } }); return 'manual'; } });
    await h.runtime.initialize([agent]); const s = await h.runtime.start({ agentId: 'mock' });
    await h.runtime.send(s.id, 'first');
    expect((await h.runtime.getTasks(s.id))[0]?.status).toBe('failed');
    await vi.waitFor(async () => expect((await h.runtime.getSession(s.id))?.state).toBe('idle'));
    // A second, well-formed turn must run on the same session.
    h.driver.send = vi.fn(async () => { h.emit({ type: 'text', data: { text: 'done' } }); h.emit({ type: 'completed', data: { stopReason: 'end_turn' } }); });
    await h.runtime.send(s.id, 'second');
    expect(h.driver.send).toHaveBeenCalledWith('second');
    await vi.waitFor(async () => expect((await h.runtime.getTasks(s.id)).find(task => task.prompt === 'second')?.status).toBe('completed'));
    expect((await h.runtime.getSession(s.id))?.state).toBe('idle');
    await h.runtime.shutdown(); h.repos.close();
  });

  it('keeps a shared session reusable after a driver error event during a task', async () => {
    const h = harness({ onSend: emit => { emit({ type: 'error', data: { message: 'temporary SDK error' } }); emit({ type: 'completed', data: { stopReason: 'end_turn' } }); return 'manual'; } });
    await h.runtime.initialize([agent]); const s = await h.runtime.start({ agentId: 'mock' });
    await h.runtime.send(s.id, 'first');
    expect((await h.runtime.getTasks(s.id))[0]?.status).toBe('failed');
    expect((await h.runtime.getSession(s.id))?.state).toBe('idle');
    expect((await h.runtime.getEvents(s.id)).some(e => e.type === 'error' && (e.data as any).message === 'temporary SDK error')).toBe(true);
    h.driver.send = vi.fn(async () => { h.emit({ type: 'text', data: { text: 'done' } }); h.emit({ type: 'completed', data: { stopReason: 'end_turn' } }); });
    await h.runtime.send(s.id, 'second');
    expect((await h.runtime.getTasks(s.id)).find(task => task.prompt === 'second')?.status).toBe('completed');
    await h.runtime.shutdown(); h.repos.close();
  });

  it('keeps a current-turn error terminal even when assistant text was already emitted', async () => {
const h = harness({ onSend: emit => {
      emit({ type: 'text', data: { text: 'partial answer' } });
      emit({ type: 'error', data: { message: 'terminal SDK error' } });
      emit({ type: 'completed', data: { stopReason: 'end_turn' } });
      return 'manual';
    } });
    await h.runtime.initialize([agent]); const s = await h.runtime.start({ agentId: 'mock' });

    await h.runtime.send(s.id, 'work');

    expect((await h.runtime.getTasks(s.id))[0]?.status).toBe('failed');
    expect((await h.runtime.getSession(s.id))?.state).toBe('idle');
    const events = await h.runtime.getEvents(s.id);
    expect(events.some(event => event.type === 'text' && (event.data as any).text === 'partial answer')).toBe(true);
    expect(events.some(event => event.type === 'error' && (event.data as any).message === 'terminal SDK error')).toBe(true);
    // The settlement boundary is always recorded, carrying the failed outcome;
    // there is no successful completion.
    const completed = events.filter(event => event.type === 'completed');
    expect(completed).toHaveLength(1);
    expect((completed[0]!.data as any).outcome).toBe('failed');
    expect((completed[0]!.data as any).outcome).not.toBe('completed');
    await h.runtime.shutdown(); h.repos.close();
  });

  it('holds queued work instead of auto-draining behind an unconfirmed task-level SDK failure', async () => {
    const firstTurn = deferred();
    const h = harness();
    await h.runtime.initialize([agent]); const s = await h.runtime.start({ agentId: 'mock' });
    h.driver.send = vi.fn(async prompt => {
      if (prompt === 'fail-me') {
        await firstTurn.promise;
        throw new Error('temporary SDK error');
      }
      h.emit({ type: 'text', data: { text: 'done' } });
      h.emit({ type: 'completed', data: { stopReason: 'end_turn' } });
    });

    const first = await h.runtime.dispatch(s.id, 'fail-me');
    await vi.waitFor(() => expect(h.driver.send).toHaveBeenCalledWith('fail-me'));
    const second = await h.runtime.dispatch(s.id, 'queued-after-failure');
    expect((await h.repos.tasks.listQueued!(s.id)).map(task => task.id)).toContain(second.id);
    firstTurn.resolve();
    await new Promise(resolve => setTimeout(resolve, 80));

    // A submitted turn whose send rejected is unconfirmed -> reconcile_required;
    // the queued Task is not auto-drained until an explicit recovery decision.
    expect((await h.runtime.getTasks(s.id)).find(task => task.id === first.id)?.status).toBe('reconcile_required');
    expect((await h.runtime.getTasks(s.id)).find(task => task.id === second.id)?.status).toBe('queued');
    expect(h.driver.send).toHaveBeenCalledTimes(1);
    await h.runtime.shutdown(); h.repos.close();
  });

  it('marks a turn interrupted when the driver reports a cancelled stopReason', async () => {
    const h = harness({ onSend: emit => { emit({ type: 'completed', data: { stopReason: 'cancelled' } }); return 'manual'; } });
    await h.runtime.initialize([agent]); const s = await h.runtime.start({ agentId: 'mock' });
    await h.runtime.send(s.id, 'work');
    // The cancelled stopReason settles the Attempt interrupted; the Session
    // itself returns to idle (the terminal outcome lives on the Attempt).
    expect((await h.runtime.getTasks(s.id))[0]?.status).toBe('interrupted');
    const stored = h.repos.execution.getTaskExecution((await h.runtime.getTasks(s.id))[0]!.id)!;
    expect(stored.currentAttempt?.outcome).toBe('interrupted');
    expect((await h.runtime.getSession(s.id))?.state).toBe('idle');
    await h.runtime.shutdown(); h.repos.close();
  });

  it('keeps cancellation terminal even when the driver also emitted an error', async () => {
    const h = harness({ onSend: emit => {
      emit({ type: 'error', data: { message: 'cancel race error' } });
      emit({ type: 'completed', data: { stopReason: 'cancelled' } });
      return 'manual';
    } });
    await h.runtime.initialize([agent]);
    const session = await h.runtime.start({ agentId: 'mock' });
    const task = await h.runtime.send(session.id, 'cancel work');
    expect(task.status).toBe('interrupted');
    expect((await h.runtime.getSession(session.id))?.state).toBe('idle');
    const completed = (await h.runtime.getEvents(session.id)).filter(event => event.type === 'completed');
    expect(completed).toHaveLength(1);
    expect((completed[0]!.data as any).outcome).toBe('interrupted');
    await h.runtime.shutdown(); h.repos.close();
  });

  it('does not duplicate a driver error when send rejects after emitting it', async () => {
    const h = harness();
    const saveError = vi.spyOn(h.repos.artifacts, 'saveError');
    await h.runtime.initialize([agent]);
    const session = await h.runtime.start({ agentId: 'mock' });
    h.driver.send = vi.fn(async () => {
      h.emit({ type: 'error', data: { message: 'canonical driver error' } });
      throw new Error('transport rejected');
    });
    // The submitted turn is unconfirmed when send rejects; the caller gets the
    // reconcile_required result rather than a thrown transport error, while the
    // canonical driver error is persisted exactly once.
    const result = await h.runtime.send(session.id, 'broken work');
    expect(result.status).toBe('reconcile_required');
    const errors = (await h.runtime.getEvents(session.id)).filter(event => event.type === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.data).toMatchObject({ message: 'canonical driver error' });
    expect(saveError).toHaveBeenCalledTimes(1);
    expect(saveError).toHaveBeenCalledWith(session.id, 'canonical driver error', undefined);
    // The lifecycle is interrupted by the rejected turn; the Session state is
    // interrupted rather than a clean idle.
    expect(['idle', 'interrupted']).toContain((await h.runtime.getSession(session.id))?.state ?? '');
    await h.runtime.shutdown(); h.repos.close();
  });

  it('marks a turn failed when the driver reports a max_tokens stopReason', async () => {
    const h = harness({ onSend: emit => { emit({ type: 'completed', data: { stopReason: 'max_tokens' } }); return 'manual'; } });
    await h.runtime.initialize([agent]); const s = await h.runtime.start({ agentId: 'mock' });
    await h.runtime.send(s.id, 'work');
    const stored = h.repos.execution.getTaskExecution((await h.runtime.getTasks(s.id))[0]!.id)!;
    expect(stored.task.status).toBe('failed');
    expect(stored.currentAttempt?.outcome).toBe('failed');
    expect(stored.currentAttempt?.settlement).toMatchObject({ stopReason: 'max_tokens' });
    await h.runtime.shutdown(); h.repos.close();
  });
});

describe('multi-driver routing', () => {
  const ptyAgent: AgentConfig = { id: 'mock-pty', name: 'Mock PTY', command: process.execPath, args: [], protocol: 'pty-cli', cwd: '/tmp', env: {}, permissionMode: 'full-trust', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };
  const ptyProbe = () => ({ protocol: 'pty-cli' as const, available: true, pause: false, resume: true });

  it('fails closed for the legacy PTY transport that cannot enforce permissions or expose approval', async () => {
    const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' });
    const legacy: AgentConfig = { ...ptyAgent, id: 'legacy-pty', protocol: 'pty', permissionMode: 'ask' };
    const factory = vi.fn();
    const runtime = new DutydeckRuntime(repos, { probe: () => ({ protocol: 'pty' as const, available: true, pause: false, resume: true }), driverFactory: factory });
    await repos.agents.save(legacy);
    await runtime.initialize([legacy]);
    await expect(runtime.start({ agentId: legacy.id })).rejects.toMatchObject({ code: 'PERMISSION_MODE_UNSUPPORTED', statusCode: 422 });
    expect(factory).not.toHaveBeenCalled();
    expect(await runtime.listSessions()).toEqual([]);
    await runtime.shutdown(); repos.close();
  });

  function ptyHarness(ptyDriverFactory?: DriverFactory) {
    const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' });
    let emit!: (event: any) => void;
    const driver: AgentDriver = { start: vi.fn(async () => {}), send: vi.fn(async () => { emit({ type: 'text', data: { text: 'answer' } }); emit({ type: 'completed', data: { stopReason: 'end_turn' } }); }), interrupt: vi.fn(async () => {}), resume: vi.fn(async () => {}), isStopped: async () => true, stop: vi.fn(async () => {}) };
    let routedProtocol: string | undefined;
    const runtime = new DutydeckRuntime(repos, {
      probe: ptyProbe,
      ptyDriverFactory: ptyDriverFactory ?? ((_agent, protocol, onEvent) => { routedProtocol = protocol; emit = onEvent; return driver; })
    });
    return { repos, runtime, driver, routedProtocol: () => routedProtocol };
  }

  it('routes pty-cli agents to the injected ptyDriverFactory and streams a turn', async () => {
    const h = ptyHarness();
    await h.repos.agents.save(ptyAgent);
    await h.runtime.initialize([ptyAgent]);
    const session = await h.runtime.start({ agentId: 'mock-pty' });
    expect(h.routedProtocol()).toBe('pty-cli');
    expect((await h.runtime.getSession(session.id))?.state).toBe('idle');
    await h.runtime.send(session.id, 'work');
    expect(h.driver.send).toHaveBeenCalledWith('work');
    expect((await h.runtime.getSession(session.id))?.state).toBe('idle');
    expect((await h.runtime.getEvents(session.id)).map(e => e.type)).toEqual(expect.arrayContaining(['text', 'completed']));
    await h.runtime.shutdown(); h.repos.close();
  });

  it.each(['approve-reads', 'deny-all'] as const)('rejects unsupported PTY permission mode %s with 422 before creating a driver', async permissionMode => {
    const factory = vi.fn();
    const h = ptyHarness(factory);
    await h.repos.agents.save(ptyAgent);
    await h.runtime.initialize([ptyAgent]);

    await expect(h.runtime.start({ agentId: 'mock-pty', permissionMode })).rejects.toMatchObject({
      code: 'PERMISSION_MODE_UNSUPPORTED',
      statusCode: 422
    });
    expect(factory).not.toHaveBeenCalled();
    expect(await h.runtime.listSessions()).toEqual([]);
    await h.runtime.shutdown(); h.repos.close();
  });

  it('rejects pty-cli sessions when no ptyDriverFactory is injected', async () => {
    const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' });
    const runtime = new DutydeckRuntime(repos, { probe: ptyProbe });
    await repos.agents.save(ptyAgent);
    await runtime.initialize([ptyAgent]);
    await expect(runtime.start({ agentId: 'mock-pty' })).rejects.toMatchObject({ code: 'DRIVER_UNAVAILABLE', statusCode: 503 });
    await runtime.shutdown(); repos.close();
  });

  it('lets a custom driverFactory take precedence over pty-cli routing', async () => {
    const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' });
    const driver: AgentDriver = { start: vi.fn(async () => {}), send: vi.fn(async () => {}), interrupt: vi.fn(async () => {}), resume: vi.fn(async () => {}), isStopped: async () => true, stop: vi.fn(async () => {}) };
    const custom = vi.fn(() => driver);
    const ptyFallback = vi.fn(() => driver);
    const runtime = new DutydeckRuntime(repos, { probe: ptyProbe, driverFactory: custom, ptyDriverFactory: ptyFallback });
    await repos.agents.save(ptyAgent);
    await runtime.initialize([ptyAgent]);
    await runtime.start({ agentId: 'mock-pty' });
    expect(custom).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'mock-pty' }),
      'pty-cli',
      expect.any(Function),
      expect.any(Function),
      expect.any(String),
      expect.objectContaining({
        protocol: 'local-only',
        mode: 'create',
        sessionId: expect.any(String),
        runId: expect.any(String),
        driverInstanceId: expect.any(String),
        resources: expect.any(Object)
      })
    );
    expect(ptyFallback).not.toHaveBeenCalled();
    await runtime.shutdown(); repos.close();
  });
});

describe('driver accessor', () => {
  it('exposes the live driver after start and releases it after stop', async () => {
    const h = harness();
    await h.runtime.initialize([agent]);
    expect(h.runtime.getDriver('ses_unknown')).toBeUndefined();
    const session = await h.runtime.start({ agentId: 'mock' });
    expect(h.runtime.getDriver(session.id)).toBe(h.driver);
    await h.runtime.stop(session.id);
    expect(h.runtime.getDriver(session.id)).toBeUndefined();
    await h.runtime.shutdown(); h.repos.close();
  });
});

describe('driver exit subscription', () => {
  it('fans driver exit codes out to per-session subscribers and stops after unsubscribe', async () => {
    const h = harness();
    await h.runtime.initialize([agent]);
    const session = await h.runtime.start({ agentId: 'mock' });
    const codes: Array<number | null> = [];
    const unsubscribe = h.runtime.onDriverExit(session.id, code => codes.push(code));
    h.exit(137);
    expect(codes).toEqual([137]);
    unsubscribe();
    h.exit(1);
    expect(codes).toEqual([137]);
    await h.runtime.shutdown(); h.repos.close();
  });

  it('does not fan exit codes out to subscribers of other sessions', async () => {
    const h = harness();
    await h.runtime.initialize([agent]);
    const session = await h.runtime.start({ agentId: 'mock' });
    const otherCodes: Array<number | null> = [];
    h.runtime.onDriverExit('ses_other', code => otherCodes.push(code));
    h.exit(0);
    expect(otherCodes).toEqual([]);
    expect((await h.runtime.getSession(session.id))?.state).not.toBe('failed');
    await h.runtime.shutdown(); h.repos.close();
  });
});

describe('publishSessionEvent — 带外事件入口（@dutydeck/relay 的落点）', () => {
  // 这个入口存在的**唯一理由**就是「不能直接调 repos.events.append()」：
  // 那样只落库，既不通知在线 SSE 订阅者，也不推进 runtime 的序号计数器。
  // 下面两条把这个理由本身钉成契约——此前它只写在注释里，把实现换成
  // 裸 append 时全套测试仍然全绿（实测 367/367 通过），等于没有守卫。

  it('投递给在线订阅者，而不只是落库', async () => {
    const h = harness();
    await h.runtime.initialize([agent]);
    const session = await h.runtime.start({ agentId: 'mock' });

    const received: any[] = [];
    const unsubscribe = h.runtime.subscribe(session.id, event => { received.push(event); });
    const published = await h.runtime.publishSessionEvent(session.id, 'text', { text: 'relay 带外消息', relay: 'send' });
    unsubscribe();

    // 落库
    const stored = await h.runtime.getEvents(session.id);
    expect(stored.some(e => e.id === published.id)).toBe(true);
    // fan-out：这条是裸 append 过不了的那一关
    expect(received.map(e => e.id), '带外事件没有推给在线订阅者（SSE 客户端将收不到）')
      .toContain(published.id);

    await h.runtime.shutdown(); h.repos.close();
  });

  it('推进会话序号，后续事件不会撞 (session_id, sequence) 唯一索引', async () => {
    const h = harness({ onSend: emit => emit({ type: 'text', data: { text: 'driver 的回答' } }) });
    await h.runtime.initialize([agent]);
    const session = await h.runtime.start({ agentId: 'mock' });

    const published = await h.runtime.publishSessionEvent(session.id, 'text', { text: '带外', relay: 'send' });
    // 带外事件之后再走一遍正常 driver 路径：序号没推进的话这里会撞唯一索引。
    await h.runtime.send(session.id, 'work');

    const sequences = (await h.runtime.getEvents(session.id)).map(e => e.sequence);
    expect(new Set(sequences).size, `序号出现重复：${sequences.join(',')}`).toBe(sequences.length);
    expect(Math.max(...sequences), '带外事件之后的事件序号应继续增长')
      .toBeGreaterThan(published.sequence);

    await h.runtime.shutdown(); h.repos.close();
  });

  it('拒绝未知会话与已归档会话', async () => {
    const h = harness();
    await h.runtime.initialize([agent]);
    // 断言必须钉到具体错误码，不能只用 rejects.toThrow()：去掉存在性校验后
    // 代码会在 `session.archivedAt` 上抛 TypeError，裸 toThrow() 照样满足，
    // 这条守卫就成了摆设（我实测过：变异后仍然全绿）。
    await expect(h.runtime.publishSessionEvent('ses_nope', 'text', { text: 'x' }))
      .rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });

    const session = await h.runtime.start({ agentId: 'mock' });
    await h.runtime.archive(session.id);
    await expect(
      h.runtime.publishSessionEvent(session.id, 'text', { text: 'x' }),
      '归档会话是只读的，带外入口不该成为绕过它的后门',
    ).rejects.toMatchObject({ code: 'SESSION_ARCHIVED' });

    await h.runtime.shutdown(); h.repos.close();
  });
  /**
   * 【已知缺陷 · 未修复】忙碌轮次中 stop / archive / restart 永久挂起
   *
   * 现象（隔离实例 + 假 claude CLI，pty-cli 协议，多次稳定复现）：
   *   - 会话空闲 / 已完成时：POST /stop        → 110ms 返回 200
   *   - 会话处于忙碌轮次（thinking）时：
   *       POST /stop / /archive / /restart     → 20s 打满仍不返回，状态卡在 thinking
   *   - 同样忙碌，但有人在订阅 /api/sessions/:id/stream 时：
   *       POST /archive                        → 117ms 返回 200
   *   - POST /interrupt 始终不受影响（11ms 返回）——因为 interrupt()（index.ts:546）
   *     压根不调 waitForTurn，发完 driver.interrupt() 直接返回。不是它更可靠，是它不等。
   *
   * 代码坐标：
   *   - stop()            index.ts:622，其中 :627 无条件 `await this.waitForTurn(id)`
   *   - archive()         index.ts:631 先调 stop()
   *   - restart()         index.ts:643 先调 stop()
   *   - waiter 只在两处 resolve：轮次自然走完的 finally（:454）、驱动进程退出
   *     notifyDriverExit（:672）。两处都没发生，就是永久等待。
   *
   * ── 关于「没有 SSE 订阅者所以轮次不推进」这条解释：已被证伪，别再复用 ──
   *
   * 我最初据「有订阅者 117ms / 无订阅者挂死」的对照给出过这个因果，整合者反驳得对：
   * emit()（:257）用的是 Node EventEmitter 的同步派发，无监听者时是空操作，不阻塞；
   * 事件先 `await this.repos.events.append(event)` 落库，那一步与订阅者无关。
   * 「事件消费链被抽干」在代码上没有依据。
   *
   * 我随后做了两次定向观测，结论是**订阅者和 driver 都不是真因**：
   *
   *   观测 A（真实 PtyCliDriver + 假 CLI，忙碌轮次中直接调 driver.stop()）：
   *     driver.stop() 1ms 就返回，并把 send() 的 promise 以 'Driver stopped' reject，
   *     onExit(code=0) 也正常回调。→ driver 侧行为完全正确，不是它不返回。
   *
   *   观测 B（本文件同款 harness，driver.send 永不 resolve、driver.stop 立即 resolve，
   *           全程零 HTTP、零 SSE、emitter 上一个监听者都没有）：
   *     runtime.stop() 仍然挂死 6s+ 超时。→ 在完全没有「订阅者」这个变量的环境里
   *     照样复现，直接排除订阅者假设。
   *
   * 由此定位到真因在 runtime 自身的顺序上：stop() 先 `await driver.stop()`，
   * 此时 driver 已把 send() reject 掉，但 runTask 的 catch/finally 是在**另一条
   * 异步链**上跑的；stop() 紧接着 `await this.waitForTurn(id)` 时，若那条链尚未推进到
   * finally（:451-455）去 resolve waiters，stop() 就再也等不到了。有 SSE 订阅者时
   * 之所以「恰好好了」，最可能是订阅带来的额外 I/O / 微任务让那条链先跑到了 finally
   * ——即**时序巧合，不是因果**。这一点尚未被单独证明，留给修复者验证。
   *
   * 为什么当时 skip 而不修：三支前端队正在并发改 UI，此刻改 runtime 核心会让那一轮
   * 改版的验证结论不可信（出问题分不清是布局还是 runtime）。
   *
   * ── 2026-09-03 已修复，本用例转为回归守卫 ──
   *
   * 修法：`waitForTurn` 加 2s 上限（index.ts）。**不是**"修好竞争"——竞争可以调顺序
   * 缓解，但根子上，等待一条自己不掌控的异步链本就不该没有上限。到点就往下走，
   * 让 stop 的后续清理（cancelSessionQueue / releaseSessionMemory / saveState）
   * 照常执行；那些清理才是 stop 的实质，调用方拿到的仍然是"已停止"。
   *
   * 取值踩过一次坑：初版设 5s，正好等于本用例的判定窗口，成了平局竞态，测试照样红。
   * 改 2s 后通过（实测 2081ms）。教训是**兜底必须明显快于调用方的耐心阈值**，
   * 贴着边设等于没设。
   *
   * 上面「时序巧合而非因果」那一条**仍未被单独证明**，修复没有依赖它——
   * 超时兜底对两种解释都成立。想深究的人可以从那里接着查。
   */
  it('忙碌轮次中 stop() 不应永久挂起（2026-09-03 缺陷回归守卫）', async () => {
    // driver.send stays busy until stop; driver.stop releases it and resolves,
    // matching the observed real driver contract (stop interrupts the turn).
    let releaseTurn!: () => void;
    const h = harness();
    h.driver.send = vi.fn(async () => await new Promise<void>(resolve => { releaseTurn = resolve; }));
    h.driver.stop = vi.fn(async () => { releaseTurn?.(); });

    await h.runtime.initialize([agent]);
    const session = await h.runtime.start({ agentId: 'mock' });
    void h.runtime.send(session.id, 'busy work').catch(() => { /* interrupted by stop */ });
    await vi.waitFor(async () => expect((await h.runtime.getSession(session.id))?.state).toBe('thinking'));

    const outcome = await Promise.race([
      h.runtime.stop(session.id).then(() => 'returned' as const),
      new Promise<'hung'>(resolve => { setTimeout(() => resolve('hung'), 5_000); })
    ]);
    expect(outcome, 'stop() 在忙碌轮次中必须能返回，而不是永久等待一个不掌控的 Promise').toBe('returned');
    expect(h.driver.stop).toHaveBeenCalled();

    await h.runtime.shutdown(); h.repos.close();
  }, 15_000);
});

it('exposes only the matching active attempt and preserves currentAttemptId through repository reads and restart', async () => {
  const gate = deferred();
  const h = harness();
  h.driver.send = vi.fn(async () => { await gate.promise; h.emit({ type: 'text', data: { text: 'done' } }); h.emit({ type: 'completed', data: { stopReason: 'end_turn' } }); });
  await h.runtime.initialize([agent]);
  const session = await h.runtime.start({ agentId: 'mock' });
  expect(h.runtime.getActiveTaskContext(session.id)).toBeUndefined();
  const sending = h.runtime.send(session.id, 'answer');
  await vi.waitFor(() => expect(h.runtime.getActiveTaskContext(session.id)?.attemptId).toBeTruthy());
  const active = h.runtime.getActiveTaskContext(session.id)!;
  expect((await h.repos.tasks.get!(active.taskId))?.currentAttemptId).toBe(active.attemptId);
  expect((await h.runtime.getTasks(session.id))[0]?.currentAttemptId).toBe(active.attemptId);
  const owner = (h.runtime as any).attempts.get(session.id);
  const ref = (h.runtime as any).attemptRefs.get(owner);
  (h.runtime as any).attemptRefs.set(owner, { ...ref, taskId: 'another-task' });
  expect(h.runtime.getActiveTaskContext(session.id)).toMatchObject({ taskId: active.taskId });
  expect(h.runtime.getActiveTaskContext(session.id)?.attemptId).toBeUndefined();
  (h.runtime as any).attemptRefs.set(owner, ref);
  gate.resolve(); await sending; await h.runtime.shutdown();
  const restarted = new DutydeckRuntime(h.repos);
  try {
    await restarted.initialize([agent]);
    expect((await restarted.getTasks(session.id))[0]).toMatchObject({ id: active.taskId, currentAttemptId: active.attemptId, status: 'completed' });
    expect(restarted.getActiveTaskContext(session.id)).toBeUndefined();
  } finally { await restarted.shutdown(); h.repos.close(); }
});
