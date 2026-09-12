import { describe, expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import type { AgentConfig, Session, ToolRiskPolicy } from '@dutydeck/shared';
import { DutydeckRuntime, type AgentDriver, type DriverFactory } from './index.js';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const agent: AgentConfig = { id: 'mock', name: 'Mock', command: process.execPath, args: [], protocol: 'acp', cwd: '/tmp', env: {}, permissionMode: 'ask', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };

function harness(options: { onSend?: (emit: (event: any) => void) => void; exitOnSend?: number; driverIdleTimeoutMs?: number; sessionEnvironment?: (session: Session) => Record<string, string>; sessionPrompt?: (session: Session, prompt: string) => string | Promise<string>; resolvePermission?: (id: string, approved: boolean) => Promise<boolean> } = {}) {
  const repos = createRepositories(':memory:'); let emit!: (event: any) => void; let exit!: (code: number | null) => void; const configuredAgents: AgentConfig[] = [];
  const driver: AgentDriver = { start: vi.fn(async () => {}), send: vi.fn(async () => { options.onSend?.(emit); if (options.exitOnSend) exit(options.exitOnSend); }), interrupt: vi.fn(async () => {}), resume: vi.fn(async () => {}), stop: vi.fn(async () => {}), resolvePermission: vi.fn(options.resolvePermission ?? (async () => true)), setModel: vi.fn(async () => {}), setReasoningEffort: vi.fn(async () => {}), setPermissionMode: vi.fn() };
  const runtime = new DutydeckRuntime(repos, { probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }), driverFactory: (configuredAgent, _p, onEvent, onExit) => { configuredAgents.push(configuredAgent); emit = onEvent; exit = onExit; return driver; }, driverIdleTimeoutMs: options.driverIdleTimeoutMs, sessionEnvironment: options.sessionEnvironment, sessionPrompt: options.sessionPrompt });
  return { repos, runtime, driver, configuredAgents, emit: (event: any) => emit(event), exit: (code: number | null) => exit(code) };
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
    h.repos.close();
  });

  it('starts, streams a prompt, and completes while preserving tool correlation', async () => {
    const h = harness({ onSend: emit => { emit({ type: 'thinking', data: { text: 'think' } }); emit({ type: 'tool_call', data: { id: 't', name: 'read', input: '.', status: 'running' } }); emit({ type: 'tool_result', data: { id: 't', name: 'read', output: 'ok', status: 'completed' } }); emit({ type: 'text', data: { text: 'done' } }); } });
    await h.runtime.initialize([agent]); const session = await h.runtime.start({ agentId: 'mock' }); await h.runtime.send(session.id, 'work');
    expect((await h.runtime.getSession(session.id))?.state).toBe('completed');
    const events = await h.runtime.getEvents(session.id); expect(events.map(e => e.type)).toEqual(expect.arrayContaining(['thinking', 'tool_call', 'tool_result', 'text', 'completed']));
    expect((events.find(e => e.type === 'tool_result')?.data as any).completedAt).toBeTruthy(); h.repos.close();
  });

  it('waits for asynchronously persisted driver events before publishing task completion', async () => {
    const gate = deferred();
    const h = harness({ onSend: emit => emit({ type: 'text', data: { text: 'late final answer' } }) });
    const append = h.repos.events.append.bind(h.repos.events);
    h.repos.events.append = vi.fn(async event => {
      if (event.type === 'text' && (event.data as any)?.text === 'late final answer') await gate.promise;
      await append(event);
    });
    await h.runtime.initialize([agent]);
    const session = await h.runtime.start({ agentId: 'mock' });
    let completed = false;
    const turn = h.runtime.send(session.id, 'work').then(result => { completed = true; return result; });
    await vi.waitFor(() => expect(h.repos.events.append).toHaveBeenCalledWith(expect.objectContaining({ type: 'text', data: expect.objectContaining({ text: 'late final answer' }) })));
    await Promise.resolve();
    expect(completed).toBe(false);
    gate.resolve();
    await turn;
    const events = await h.runtime.getEvents(session.id);
    const finalIndex = events.findIndex(event => event.type === 'text' && (event.data as any)?.text === 'late final answer');
    const terminalTaskIndex = events.findIndex(event => event.type === 'task' && (event.data as any)?.task?.status === 'completed');
    expect(finalIndex).toBeGreaterThanOrEqual(0);
    expect(terminalTaskIndex).toBeGreaterThan(finalIndex);
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
    const h = harness();
    await h.repos.sessions.save({ id: 'ses_old', agentId: 'mock', state: 'idle', cwd: '/tmp', permissionMode: 'ask', runId: 'run_old', createdAt: '', updatedAt: '' });
    await h.runtime.initialize([agent]);
    expect(await h.runtime.getSession('ses_old')).toMatchObject({ permissionMode: 'ask' });
    await h.runtime.shutdown(); h.repos.close();
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

  it('marks tasks left running by a previous process as interrupted during initialization', async () => {
    const h = harness();
    const timestamp = new Date().toISOString();
    await h.repos.sessions.save({ id: 'ses_orphaned', agentId: 'mock', state: 'running_tool', cwd: '/tmp', permissionMode: 'full-trust', protocol: 'acp', runId: 'run_old', createdAt: timestamp, updatedAt: timestamp });
    await h.repos.tasks.save({ id: 'task_orphaned', sessionId: 'ses_orphaned', prompt: 'long task', status: 'running', createdAt: timestamp, updatedAt: timestamp });
    await h.runtime.initialize([agent]);
    expect((await h.runtime.getTasks('ses_orphaned'))[0]?.status).toBe('interrupted');
    expect((await h.runtime.getSession('ses_orphaned'))?.state).toBe('interrupted');
    const events = await h.runtime.getEvents('ses_orphaned');
    expect(events.some(e => e.type === 'error' && e.data.message.includes('守护进程重启'))).toBe(true);
    await h.runtime.shutdown(); h.repos.close();
  });

  it('safely interrupts legacy queued tasks that lack persisted execution context', async () => {
    const h = harness();
    const timestamp = new Date().toISOString();
    await h.repos.sessions.save({ id: 'ses_legacy_queue', agentId: 'mock', state: 'completed', cwd: '/tmp', permissionMode: 'full-trust', protocol: 'acp', runId: 'run_old', createdAt: timestamp, updatedAt: timestamp });
    await h.repos.tasks.save({ id: 'task_legacy_queue', sessionId: 'ses_legacy_queue', prompt: 'do not replay without policy context', status: 'queued', createdAt: timestamp, updatedAt: timestamp });

    await h.runtime.initialize([agent]);

    expect(h.driver.send).not.toHaveBeenCalled();
    expect((await h.runtime.getTasks('ses_legacy_queue'))[0]?.status).toBe('interrupted');
    expect(await h.runtime.getSession('ses_legacy_queue')).toMatchObject({ state: 'interrupted', error: expect.stringContaining('缺少可验证的执行上下文') });
    const events = await h.runtime.getEvents('ses_legacy_queue');
    expect(events.some(event => event.type === 'task' && (event.data as any).task.status === 'interrupted')).toBe(true);
    expect(events.some(event => event.type === 'error' && /请重新发送/.test((event.data as any).message))).toBe(true);
    await h.runtime.shutdown(); h.repos.close();
  });

  it('archives incomplete startup sessions left behind by a previous process', async () => {
    const h = harness();
    const timestamp = new Date().toISOString();
    await h.repos.sessions.save({ id: 'ses_starting', agentId: 'mock', state: 'starting', cwd: '/tmp', permissionMode: 'full-trust', protocol: 'acp', runId: 'run_old', createdAt: timestamp, updatedAt: timestamp });
    await h.runtime.initialize([agent]);
    expect(await h.runtime.getSession('ses_starting')).toMatchObject({ state: 'failed', error: expect.stringContaining('未完成启动') });
    expect((await h.runtime.getSession('ses_starting'))?.archivedAt).toBeTruthy();
    await h.runtime.shutdown(); h.repos.close();
  });

  it('persists the source metadata used by external chat channels', async () => {
    const h = harness(); await h.runtime.initialize([agent]);
    const session = await h.runtime.start({ agentId: 'mock', source: 'lark', sourceId: 'cli_test:oc_chat' });
    expect(await h.runtime.getSession(session.id)).toMatchObject({ source: 'lark', sourceId: 'cli_test:oc_chat' });
    await h.runtime.shutdown(); h.repos.close();
  });

  it('injects session-scoped environment without replacing the Agent environment', async () => {
    const h = harness({ sessionEnvironment: current => current.source === 'lark' ? { GROUP_TOKEN: current.id, RESERVED: 'scoped' } : {} });
    await h.runtime.initialize([{ ...agent, env: { KEEP_ME: 'yes', RESERVED: 'agent' } }]);
    const session = await h.runtime.start({ agentId: 'mock', source: 'lark', sourceId: 'cli_test:oc_chat' });
    expect(h.configuredAgents[0]?.env).toEqual({ KEEP_ME: 'yes', RESERVED: 'scoped', GROUP_TOKEN: session.id });
    await h.runtime.shutdown(); h.repos.close();
  });

  it('applies session-scoped prompt context to every entry point without changing persisted user text', async () => {
    const h = harness({ sessionPrompt: (current, prompt) => current.source === 'lark' ? `[group:${current.sourceId}]\n${prompt}` : prompt });
    await h.runtime.initialize([agent]);
    const session = await h.runtime.start({ agentId: 'mock', source: 'lark', sourceId: 'cli_test:oc_chat:group' });
    await h.runtime.dispatch(session.id, 'from web');
    await vi.waitFor(() => expect(h.driver.send).toHaveBeenCalledWith('[group:cli_test:oc_chat:group]\nfrom web'));
    expect((await h.runtime.getTasks(session.id))[0]?.prompt).toBe('from web');
    await h.runtime.shutdown(); h.repos.close();
  });

  it('keeps the same agent session across consecutive turns', async () => {
    const h = harness({ onSend: emit => emit({ type: 'text', data: { text: 'answer' } }) });
    await h.runtime.initialize([agent]); const session = await h.runtime.start({ agentId: 'mock' });
    await h.runtime.send(session.id, 'first'); await h.runtime.send(session.id, 'second');
    expect(h.driver.start).toHaveBeenCalledOnce(); expect(h.driver.send).toHaveBeenCalledTimes(2);
    expect((await h.runtime.getTasks(session.id)).map(task => task.prompt)).toEqual(['first', 'second']); h.repos.close();
  });

  it('persists queued prompts, runs them in order, and supports cancellation', async () => {
    const gate = deferred(); const h = harness();
    h.driver.send = vi.fn(async prompt => { if (prompt === 'first') await gate.promise; h.emit({ type: 'text', data: { text: `answer:${prompt}` } }); });
    await h.runtime.initialize([agent]); const session = await h.runtime.start({ agentId: 'mock' });
    const first = await h.runtime.dispatch(session.id, 'first'); expect(first.queuedAhead).toBe(0); expect(first).not.toHaveProperty('executionContext'); await vi.waitFor(() => expect(h.driver.send).toHaveBeenCalledWith('first'));
    const second = await h.runtime.dispatch(session.id, 'second');
    const third = await h.runtime.dispatch(session.id, 'third');
    expect(second.queuedAhead).toBe(1);
    expect(third.queuedAhead).toBe(2);
    expect((await h.runtime.getTasks(session.id)).find(task => task.id === second.id)?.status).toBe('queued');
    await h.runtime.cancelQueued(session.id, second.id);
    gate.resolve();
    await vi.waitFor(() => expect(h.driver.send).toHaveBeenCalledWith('third'));
    await vi.waitFor(async () => expect((await h.runtime.getTasks(session.id)).find(task => task.prompt === 'third')?.status).toBe('completed'));
    expect((h.driver.send as ReturnType<typeof vi.fn>).mock.calls.map(call => call[0])).toEqual(['first', 'third']);
    expect((await h.runtime.getTasks(session.id)).find(task => task.id === second.id)?.status).toBe('cancelled');
    await h.runtime.shutdown(); h.repos.close();
  });

  it('restores queued execution context and risk policy from a real database after restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dutydeck-runtime-recovery-'));
    const database = join(directory, 'dutydeck.db');
    const timestamp = new Date().toISOString();
    const riskPolicy: ToolRiskPolicy = { enabled: true, authorized: true, pattern: 'rm\\s', actorEmail: 'owner@example.com', reason: 'approved in Lark' };
    const seeded = createRepositories(database);
    await seeded.sessions.save({ id: 'ses_recovery', agentId: 'mock', state: 'completed', cwd: directory, permissionMode: 'full-trust', source: 'lark', sourceId: 'oc_group', protocol: 'acp', runId: 'run_old', createdAt: timestamp, updatedAt: timestamp });
    await seeded.tasks.save({
      id: 'task_recovery',
      sessionId: 'ses_recovery',
      prompt: 'visible user prompt',
      status: 'queued',
      executionContext: { agentPrompt: 'agent prompt with group context', riskPolicy },
      createdAt: timestamp,
      updatedAt: timestamp
    });
    seeded.close();

    const repos = createRepositories(database);
    let emit!: (event: any) => void;
    const driver: AgentDriver = {
      start: vi.fn(async () => {}),
      send: vi.fn(async () => emit({ type: 'text', data: { text: 'recovered answer' } })),
      interrupt: vi.fn(async () => {}),
      resume: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      setRiskPolicy: vi.fn()
    };
    const restored = new DutydeckRuntime(repos, {
      driverIdleTimeoutMs: 0,
      driverFactory: (_configured, _protocol, onEvent) => { emit = onEvent; return driver; }
    });
    try {
      await restored.initialize([agent]);
      await vi.waitFor(async () => expect((await restored.getTasks('ses_recovery'))[0]?.status).toBe('completed'));

      expect(driver.send).toHaveBeenCalledWith('agent prompt with group context');
      expect(driver.setRiskPolicy).toHaveBeenCalledWith(riskPolicy);
      expect((await repos.tasks.listBySession('ses_recovery'))[0]?.executionContext).toEqual({ agentPrompt: 'agent prompt with group context', riskPolicy });
      expect((await restored.getTasks('ses_recovery'))[0]).not.toHaveProperty('executionContext');
      const taskEvents = (await restored.getEvents('ses_recovery')).filter(event => event.type === 'task');
      expect(taskEvents.length).toBeGreaterThan(0);
      for (const event of taskEvents) expect((event.data as any).task).not.toHaveProperty('executionContext');
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
    expect(await h.runtime.getSession(session.id)).toMatchObject({ state: 'idle', error: 'risk policy rejected' });

    await h.runtime.dispatch(session.id, 'safe retry');
    await vi.waitFor(async () => expect((await h.runtime.getTasks(session.id)).find(task => task.prompt === 'safe retry')?.status).toBe('completed'));
    expect(h.driver.send).toHaveBeenCalledWith('safe retry');
    await h.runtime.shutdown(); h.repos.close();
  });

  it('cleans up a turn when risk policy persistence fails and continues later queued work', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dutydeck-risk-write-'));
    const invalidCwd = join(directory, 'not-a-directory');
    await writeFile(invalidCwd, 'file blocks nested security directory');
    const h = harness({ onSend: emit => emit({ type: 'text', data: { text: 'answer' } }) });
    const policy: ToolRiskPolicy = { enabled: true, authorized: true, pattern: 'rm\\s' };
    h.driver.setRiskPolicy = vi.fn();
    try {
      await h.runtime.initialize([agent]);
      const session = await h.runtime.start({ agentId: 'mock', cwd: invalidCwd });
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
      for (let index = 0; index < 5_000; index++) emit({ type: 'raw_terminal', data: { text: `noise:${index}` } });
    } });
    await h.runtime.initialize([agent]);
    const session = await h.runtime.start({ agentId: 'mock' });
    const unboundedList = vi.spyOn(h.repos.events, 'list');
    const windowedList = vi.spyOn(h.repos.events, 'listWindow');

    await h.runtime.send(session.id, 'new work');

    expect(unboundedList).not.toHaveBeenCalled();
    expect(windowedList.mock.calls.length).toBeGreaterThan(25);
    for (const [, options] of windowedList.mock.calls) expect(options).toEqual(expect.objectContaining({ direction: 'backward', limit: 200 }));
    expect((await h.runtime.getTasks(session.id))[0]?.status).toBe('completed');
    await h.runtime.shutdown(); h.repos.close();
  });

  it('hard-stops the current driver before immediately sending the replacement prompt', async () => {
    const gate = deferred(); const h = harness();
    h.driver.send = vi.fn(async prompt => { if (prompt === 'first') await gate.promise; h.emit({ type: 'text', data: { text: `answer:${prompt}` } }); });
    h.driver.stop = vi.fn(async () => gate.resolve());
    await h.runtime.initialize([agent]); const session = await h.runtime.start({ agentId: 'mock' });
    await h.runtime.dispatch(session.id, 'first'); await vi.waitFor(() => expect(h.driver.send).toHaveBeenCalledWith('first'));
    await h.runtime.dispatch(session.id, 'replacement', 'interrupt');
    await vi.waitFor(() => expect(h.driver.send).toHaveBeenCalledWith('replacement'));
    await vi.waitFor(async () => expect((await h.runtime.getTasks(session.id)).find(task => task.prompt === 'replacement')?.status).toBe('completed'));
    const tasks = await h.runtime.getTasks(session.id);
    expect(tasks.find(task => task.prompt === 'first')?.status).toBe('interrupted');
    expect(h.driver.stop).toHaveBeenCalledOnce(); expect(h.driver.start).toHaveBeenCalledTimes(2);
    await h.runtime.shutdown(); h.repos.close();
  });

  it('promotes an existing queued task, interrupts the active turn, and preserves its task id', async () => {
    const gate = deferred(); const h = harness();
    h.driver.send = vi.fn(async prompt => { if (prompt === 'first') await gate.promise; h.emit({ type: 'text', data: { text: `answer:${prompt}` } }); });
    h.driver.stop = vi.fn(async () => gate.resolve());
    await h.runtime.initialize([agent]); const session = await h.runtime.start({ agentId: 'mock' });
    await h.runtime.dispatch(session.id, 'first'); await vi.waitFor(() => expect(h.driver.send).toHaveBeenCalledWith('first'));
    const second = await h.runtime.dispatch(session.id, 'second');
    const third = await h.runtime.dispatch(session.id, 'third');
    await expect(h.runtime.steerQueued(session.id, third.id)).resolves.toMatchObject({ id: third.id, prompt: 'third' });
    await vi.waitFor(() => expect(h.driver.send).toHaveBeenCalledWith('third'));
    await vi.waitFor(() => expect(h.driver.send).toHaveBeenCalledWith('second'));
    expect((h.driver.send as ReturnType<typeof vi.fn>).mock.calls.map(call => call[0])).toEqual(['first', 'third', 'second']);
    const tasks = await h.runtime.getTasks(session.id);
    expect(tasks.find(task => task.id === third.id)?.status).toBe('completed');
    expect(tasks.find(task => task.prompt === 'first')?.status).toBe('interrupted');
    await h.runtime.shutdown(); h.repos.close();
  });

  it('reconnects a persisted completed session before its next turn', async () => {
    const first = harness({ onSend: emit => emit({ type: 'text', data: { text: 'answer' } }) }); await first.runtime.initialize([agent]); const session = await first.runtime.start({ agentId: 'mock' }); await first.runtime.send(session.id, 'before restart');
    const driver: AgentDriver = { start: vi.fn(async () => {}), send: vi.fn(async () => {}), interrupt: vi.fn(async () => {}), resume: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
    const restored = new DutydeckRuntime(first.repos, { probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }), driverFactory: () => driver });
    await restored.send(session.id, 'after restart');
    expect(driver.start).toHaveBeenCalledOnce(); expect(driver.send).toHaveBeenCalledWith('after restart');
    expect((await restored.getTasks(session.id)).map(task => task.prompt)).toEqual(['before restart', 'after restart']); first.repos.close();
  });

  it('uses the persisted session system prompt when reconnecting after config changes', async () => {
    const first = harness({ onSend: emit => emit({ type: 'text', data: { text: 'answer' } }) });
    await first.runtime.initialize([{ ...agent, systemPrompt: 'session prompt' }]);
    const session = await first.runtime.start({ agentId: 'mock' });
    await first.runtime.send(session.id, 'before restart');
    await first.repos.agents.save({ ...agent, systemPrompt: 'new global prompt' });
    let configured: AgentConfig | undefined;
    const driver: AgentDriver = { start: vi.fn(async () => {}), send: vi.fn(async () => {}), interrupt: vi.fn(async () => {}), resume: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
    const restored = new DutydeckRuntime(first.repos, { driverFactory: current => { configured = current; return driver; } });
    await restored.send(session.id, 'after restart');
    expect(configured?.systemPrompt).toBe('session prompt');
    first.repos.close();
  });

  it('releases idle drivers and reconnects them on the next turn', async () => {
    const h = harness({ driverIdleTimeoutMs: 10, onSend: emit => emit({ type: 'text', data: { text: 'answer' } }) }); await h.runtime.initialize([agent]); const session = await h.runtime.start({ agentId: 'mock' }); await h.runtime.send(session.id, 'first');
    await h.runtime.cleanupIdleDrivers(Date.now() + 100);
    expect(h.driver.stop).toHaveBeenCalledOnce();
    await h.runtime.send(session.id, 'second');
    expect(h.driver.start).toHaveBeenCalledTimes(2); expect(h.driver.send).toHaveBeenCalledTimes(2); await h.runtime.shutdown(); h.repos.close();
  });

  it('interrupt cancels only the current turn and retains the session', async () => { const h = harness(); await h.runtime.initialize([agent]); const s = await h.runtime.start({ agentId: 'mock' }); await h.runtime.interrupt(s.id); expect(h.driver.interrupt).toHaveBeenCalledOnce(); expect((await h.runtime.getSession(s.id))?.state).toBe('interrupted'); h.repos.close(); });
  it('does not interrupt a replacement task when authorization finished for an older task', async () => {
    const secondTurn = deferred();
    const h = harness(); await h.runtime.initialize([agent]); const s = await h.runtime.start({ agentId: 'mock' });
    h.driver.send = vi.fn(async () => {
      if (h.driver.send.mock.calls.length === 2) await secondTurn.promise;
      h.emit({ type: 'text', data: { text: 'done' } });
    });
    const first = await h.runtime.dispatch(s.id, 'first');
    const second = await h.runtime.dispatch(s.id, 'second');
    await vi.waitFor(() => expect(h.driver.send).toHaveBeenCalledTimes(2));
    await expect(h.runtime.interrupt(s.id, first.id)).rejects.toMatchObject({ code: 'TASK_NOT_ACTIVE', statusCode: 409 });
    expect(h.driver.interrupt).not.toHaveBeenCalled();
    secondTurn.resolve();
    await vi.waitFor(async () => expect((await h.runtime.getTasks(s.id)).find(task => task.id === second.id)?.status).toBe('completed'));
    await h.runtime.shutdown(); h.repos.close();
  });

  it('does not overwrite a replacement task after an asynchronous interrupt finishes', async () => {
    const firstTurn = deferred(); const secondTurn = deferred(); const interruptDone = deferred();
    const h = harness(); await h.runtime.initialize([agent]); const s = await h.runtime.start({ agentId: 'mock' });
    h.driver.send = vi.fn(async () => {
      if (h.driver.send.mock.calls.length === 1) await firstTurn.promise;
      else await secondTurn.promise;
      h.emit({ type: 'text', data: { text: 'done' } });
    });
    h.driver.interrupt = vi.fn(async () => { await interruptDone.promise; });
    const first = await h.runtime.dispatch(s.id, 'first');
    const second = await h.runtime.dispatch(s.id, 'second');
    await vi.waitFor(() => expect(h.driver.send).toHaveBeenCalledTimes(1));
    const interrupting = h.runtime.interrupt(s.id, first.id);
    await vi.waitFor(() => expect(h.driver.interrupt).toHaveBeenCalledOnce());
    firstTurn.resolve();
    await vi.waitFor(() => expect(h.driver.send).toHaveBeenCalledTimes(2));
    expect((await h.runtime.getSession(s.id))?.state).toBe('thinking');
    interruptDone.resolve();
    await expect(interrupting).resolves.toBeUndefined();
    expect((await h.runtime.getSession(s.id))?.state).toBe('thinking');
    secondTurn.resolve();
    await vi.waitFor(async () => expect((await h.runtime.getTasks(s.id)).find(task => task.id === second.id)?.status).toBe('completed'));
    await h.runtime.shutdown(); h.repos.close();
  });
  it('stop delegates process-tree cleanup and marks stopped', async () => { const h = harness(); await h.runtime.initialize([agent]); const s = await h.runtime.start({ agentId: 'mock' }); await h.runtime.stop(s.id); expect(h.driver.stop).toHaveBeenCalledOnce(); expect((await h.runtime.getSession(s.id))?.state).toBe('stopped'); h.repos.close(); });
  it('permanently archives a session and rejects subsequent actions', async () => { const h = harness(); await h.runtime.initialize([agent]); const s = await h.runtime.start({ agentId: 'mock' }); const archived = await h.runtime.archive(s.id); expect(archived.archivedAt).toBeTruthy(); expect(archived.state).toBe('stopped'); await expect(h.runtime.dispatch(s.id, 'not allowed')).rejects.toMatchObject({ code: 'SESSION_ARCHIVED' }); expect((await h.runtime.listSessions())[0]?.archivedAt).toBe(archived.archivedAt); await h.runtime.shutdown(); h.repos.close(); });
  it('restart creates a new run instance', async () => { const h = harness(); await h.runtime.initialize([agent]); const s = await h.runtime.start({ agentId: 'mock' }); const old = s.runId; const restarted = await h.runtime.restart(s.id); expect(restarted.runId).not.toBe(old); expect(h.driver.stop).toHaveBeenCalledOnce(); h.repos.close(); });
  it('abnormal agent exit produces failed state and error event', async () => { const h = harness({ exitOnSend: 17 }); await h.runtime.initialize([agent]); const s = await h.runtime.start({ agentId: 'mock' }); await h.runtime.send(s.id, 'exit'); await vi.waitFor(async () => expect((await h.runtime.getEvents(s.id)).some(e => e.type === 'error')).toBe(true)); h.repos.close(); });
  it('permission requests call the live driver for approve and reject exactly once', async () => {
    const h = harness({ onSend: emit => { emit({ type: 'permission_request', data: { id: 'p1', title: 'Write?', status: 'pending' } }); emit({ type: 'permission_request', data: { id: 'p2', title: 'Delete?', status: 'pending' } }); } });
    await h.runtime.initialize([agent]); const s = await h.runtime.start({ agentId: 'mock' }); await h.runtime.send(s.id, 'write');
    expect((await h.runtime.resolvePermission(s.id, 'p1', true)).status).toBe('approved');
    expect((await h.runtime.resolvePermission(s.id, 'p2', false)).status).toBe('rejected');
    expect(h.driver.resolvePermission).toHaveBeenNthCalledWith(1, 'p1', true);
    expect(h.driver.resolvePermission).toHaveBeenNthCalledWith(2, 'p2', false);
    await expect(h.runtime.resolvePermission(s.id, 'p1', true)).rejects.toMatchObject({ code: 'PERMISSION_NOT_FOUND' });
    await h.runtime.shutdown(); h.repos.close();
  });

  it('keeps a claim private while the driver decision is in flight', async () => {
    const gate = deferred();
    const h = harness({ resolvePermission: async () => { await gate.promise; return true; } });
    await h.runtime.initialize([agent]); const s = await h.runtime.start({ agentId: 'mock' });
    h.emit({ type: 'permission_request', data: { id: 'race', title: 'Race', status: 'pending' } });
    await vi.waitFor(() => expect(h.runtime.getPendingPermissions(s.id)).toHaveLength(1));
    const first = h.runtime.resolvePermission(s.id, 'race', true);
    await vi.waitFor(() => expect(h.driver.resolvePermission).toHaveBeenCalledWith('race', true));
    expect(h.runtime.getPendingPermissions(s.id)).toEqual([]);
    await expect(h.runtime.resolvePermission(s.id, 'race', true)).rejects.toMatchObject({ code: 'PERMISSION_RESOLVING', statusCode: 409 });
    gate.resolve();
    await expect(first).resolves.toMatchObject({ status: 'approved' });
    expect(h.driver.resolvePermission).toHaveBeenCalledTimes(1);
    await h.runtime.shutdown(); h.repos.close();
  });

  it('persists an approval intent before the driver and consumes it when audit delivery fails', async () => {
    const h = harness();
    await h.runtime.initialize([agent]); const s = await h.runtime.start({ agentId: 'mock' });
    h.emit({ type: 'permission_request', data: { id: 'audit', title: 'Audit', status: 'pending' } });
    await vi.waitFor(() => expect(h.runtime.getPendingPermissions(s.id)).toHaveLength(1));
    const save = h.repos.artifacts.savePermission.bind(h.repos.artifacts);
    const order: string[] = [];
    h.repos.artifacts.savePermission = vi.fn(async (...args: Parameters<typeof save>) => { order.push('save'); return save(...args); });
    h.driver.resolvePermission = vi.fn(async () => { order.push('driver'); return true; });
    const append = h.repos.events.append.bind(h.repos.events);
    h.repos.events.append = vi.fn(async event => {
      if (event.type === 'permission_request' && (event.data as any)?.status === 'approved') throw new Error('event store down');
      return append(event);
    });
    await expect(h.runtime.resolvePermission(s.id, 'audit', true)).rejects.toMatchObject({ code: 'PERMISSION_ACCEPTED_AUDIT_FAILED', statusCode: 503 });
    expect(order.indexOf('save')).toBeLessThan(order.indexOf('driver'));
    expect(h.driver.resolvePermission).toHaveBeenCalledOnce();
    await expect(h.runtime.resolvePermission(s.id, 'audit', true)).rejects.toMatchObject({ code: 'PERMISSION_NOT_FOUND' });
    await h.runtime.shutdown(); h.repos.close();
  });

  it('does not submit to an old driver when stop wins while the decision intent is saving', async () => {
    const h = harness();
    await h.runtime.initialize([agent]); const s = await h.runtime.start({ agentId: 'mock' });
    h.emit({ type: 'permission_request', data: { id: 'stop-race', title: 'Stop race', status: 'pending' } });
    await vi.waitFor(() => expect(h.runtime.getPendingPermissions(s.id)).toHaveLength(1));
    const started = deferred(); const gate = deferred();
    const save = h.repos.artifacts.savePermission.bind(h.repos.artifacts);
    h.repos.artifacts.savePermission = vi.fn(async (...args: Parameters<typeof save>) => { started.resolve(); await gate.promise; return save(...args); });
    const decision = h.runtime.resolvePermission(s.id, 'stop-race', true);
    await started.promise;
    await h.runtime.stop(s.id);
    gate.resolve();
    await expect(decision).rejects.toMatchObject({ code: 'PERMISSION_EXPIRED', statusCode: 409 });
    expect(h.driver.resolvePermission).not.toHaveBeenCalled();
    await h.runtime.shutdown(); h.repos.close();
  });

  it('does not turn a synchronous terminal driver update into a false expiry', async () => {
    const h = harness();
    await h.runtime.initialize([agent]); const s = await h.runtime.start({ agentId: 'mock' });
    h.emit({ type: 'permission_request', data: { id: 'synchronous-terminal', title: 'Sync', status: 'pending' } });
    await vi.waitFor(() => expect(h.runtime.getPendingPermissions(s.id)).toHaveLength(1));
    h.driver.resolvePermission = vi.fn(async () => {
      h.emit({ type: 'permission_request', data: { id: 'synchronous-terminal', title: 'Sync', status: 'approved' } });
      await new Promise(resolve => setTimeout(resolve, 20));
      return true;
    });
    await expect(h.runtime.resolvePermission(s.id, 'synchronous-terminal', true)).resolves.toMatchObject({ status: 'approved' });
    const terminals = (await h.runtime.getEvents(s.id)).filter(event => event.type === 'permission_request' && (event.data as any)?.id === 'synchronous-terminal' && (event.data as any)?.status === 'approved');
    expect(terminals).toHaveLength(1);
    await h.runtime.shutdown(); h.repos.close();
  });

  it('reports accepted-but-audit-failed when persisting the accepted decision fails', async () => {
    const h = harness();
    await h.runtime.initialize([agent]); const s = await h.runtime.start({ agentId: 'mock' });
    h.emit({ type: 'permission_request', data: { id: 'save-failure', title: 'Save', status: 'pending' } });
    await vi.waitFor(() => expect(h.runtime.getPendingPermissions(s.id)).toHaveLength(1));
    const save = h.repos.artifacts.savePermission.bind(h.repos.artifacts);
    let saves = 0;
    h.repos.artifacts.savePermission = vi.fn(async (...args: Parameters<typeof save>) => {
      saves += 1;
      if (saves === 2) throw new Error('artifact store down');
      return save(...args);
    });
    await expect(h.runtime.resolvePermission(s.id, 'save-failure', true)).rejects.toMatchObject({ code: 'PERMISSION_ACCEPTED_AUDIT_FAILED', statusCode: 503 });
    expect(h.driver.resolvePermission).toHaveBeenCalledOnce();
    await expect(h.runtime.resolvePermission(s.id, 'save-failure', true)).rejects.toMatchObject({ code: 'PERMISSION_NOT_FOUND' });
    await h.runtime.shutdown(); h.repos.close();
  });

  it('does not leave a retryable approval after the live driver rejects it', async () => {
    const h = harness({ resolvePermission: async () => false });
    await h.runtime.initialize([agent]); const s = await h.runtime.start({ agentId: 'mock' });
    h.emit({ type: 'permission_request', data: { id: 'rejected-by-driver', title: 'Reject', status: 'pending' } });
    await vi.waitFor(() => expect(h.runtime.getPendingPermissions(s.id)).toHaveLength(1));
    await expect(h.runtime.resolvePermission(s.id, 'rejected-by-driver', true)).rejects.toMatchObject({ code: 'PERMISSION_EXPIRED', statusCode: 409 });
    expect(h.driver.resolvePermission).toHaveBeenCalledOnce();
    await expect(h.runtime.resolvePermission(s.id, 'rejected-by-driver', true)).rejects.toMatchObject({ code: 'PERMISSION_NOT_FOUND' });
    await h.runtime.shutdown(); h.repos.close();
  });

  it('clears a pending permission when the driver reports its terminal state', async () => {
    const h = harness(); await h.runtime.initialize([agent]); const s = await h.runtime.start({ agentId: 'mock' });
    h.emit({ type: 'permission_request', data: { id: 'terminal', title: 'Terminal', status: 'pending' } });
    await vi.waitFor(() => expect(h.runtime.getPendingPermissions(s.id)).toHaveLength(1));
    h.emit({ type: 'permission_request', data: { id: 'terminal', title: 'Terminal', status: 'rejected' } });
    await vi.waitFor(() => expect(h.runtime.getPendingPermissions(s.id)).toEqual([]));
    await expect(h.runtime.resolvePermission(s.id, 'terminal', false)).rejects.toMatchObject({ code: 'PERMISSION_NOT_FOUND' });
    await h.runtime.shutdown(); h.repos.close();
  });

  it('drops callbacks from a stopped driver after restart even when the permission id repeats', async () => {
    const repos = createRepositories(':memory:');
    const callbacks: Array<(event: any) => void> = [];
    const drivers: AgentDriver[] = [];
    const runtime = new DutydeckRuntime(repos, {
      probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }),
      driverFactory: (_configured, _protocol, onEvent) => {
        callbacks.push(onEvent);
        const driver: AgentDriver = { start: vi.fn(async () => {}), send: vi.fn(async () => {}), interrupt: vi.fn(async () => {}), resume: vi.fn(async () => {}), stop: vi.fn(async () => {}), resolvePermission: vi.fn(async () => true) };
        drivers.push(driver); return driver;
      }
    });
    await runtime.initialize([agent]); const s = await runtime.start({ agentId: 'mock' });
    callbacks[0]!({ type: 'permission_request', data: { id: 'same', title: 'old', status: 'pending' } });
    await vi.waitFor(() => expect(runtime.getPendingPermissions(s.id)).toHaveLength(1));
    await runtime.restart(s.id);
    callbacks[0]!({ type: 'permission_request', data: { id: 'same', title: 'stale', status: 'pending' } });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(runtime.getPendingPermissions(s.id)).toEqual([]);
    callbacks[1]!({ type: 'permission_request', data: { id: 'same', title: 'new', status: 'pending' } });
    await vi.waitFor(() => expect(runtime.getPendingPermissions(s.id)).toEqual([expect.objectContaining({ title: 'new' })]));
    await runtime.resolvePermission(s.id, 'same', true);
    expect(drivers[0]!.resolvePermission).not.toHaveBeenCalled();
    expect(drivers[1]!.resolvePermission).toHaveBeenCalledWith('same', true);
    await runtime.shutdown(); repos.close();
  });

  it('uses durable task ids to replay duplicate dispatches and reject conflicting deliveries', async () => {
    const h = harness({ onSend: emit => emit({ type: 'text', data: { text: 'done' } }) });
    await h.runtime.initialize([agent]); const s = await h.runtime.start({ agentId: 'mock' });
    const accepted = await h.runtime.dispatch(s.id, 'one', 'queue', 'one', undefined, 'ou_a', 'message_1');
    const replay = await h.runtime.dispatch(s.id, 'one', 'queue', 'one', undefined, 'ou_a', 'message_1');
    expect(replay).toMatchObject({ id: accepted.id, replayed: true });
    await expect(h.runtime.dispatch(s.id, 'changed', 'queue', 'changed', undefined, 'ou_a', 'message_1')).rejects.toMatchObject({ code: 'TASK_IDEMPOTENCY_CONFLICT' });
    await expect(h.runtime.dispatch(s.id, 'one', 'queue', 'one', undefined, 'ou_b', 'message_1')).rejects.toMatchObject({ code: 'TASK_IDEMPOTENCY_CONFLICT' });
    await vi.waitFor(() => expect(h.driver.send).toHaveBeenCalledTimes(1));
    await h.runtime.shutdown(); h.repos.close();
  });

  it('recovers an atomically created idempotent task after a storage failure before scheduling', async () => {
    const first = harness();
    await first.runtime.initialize([agent]); const s = await first.runtime.start({ agentId: 'mock' });
    const save = first.repos.tasks.save.bind(first.repos.tasks);
    let failOnce = true;
    first.repos.tasks.save = vi.fn(async task => {
      if (failOnce && task.status === 'queued') { failOnce = false; throw new Error('storage unavailable'); }
      return save(task);
    });
    await expect(first.runtime.dispatch(s.id, 'recover me', 'queue', 'agent recovery prompt', undefined, 'ou_a', 'delivery_1')).rejects.toThrow('storage unavailable');
    await first.runtime.shutdown();
    first.repos.tasks.save = save;
    let emit!: (event: any) => void;
    const driver: AgentDriver = { start: vi.fn(async () => {}), send: vi.fn(async () => emit({ type: 'text', data: { text: 'recovered' } })), interrupt: vi.fn(async () => {}), resume: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
    const restored = new DutydeckRuntime(first.repos, {
      probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }),
      driverFactory: (_configured, _protocol, onEvent) => { emit = onEvent; return driver; }
    });
    await restored.initialize([agent]);
    await vi.waitFor(async () => expect((await restored.getTasks(s.id)).find(task => task.prompt === 'recover me')?.status).toBe('completed'));
    const replay = await restored.dispatch(s.id, 'recover me', 'queue', 'agent recovery prompt', undefined, 'ou_a', 'delivery_1');
    expect(replay).toMatchObject({ replayed: true });
    expect(driver.send).toHaveBeenCalledTimes(1);
    await restored.shutdown(); first.repos.close();
  });

  it('returns an explicit error for unsupported pause/resume', async () => { const h = harness(); await h.runtime.initialize([agent]); const s = await h.runtime.start({ agentId: 'mock' }); await expect(h.runtime.pause(s.id)).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY', statusCode: 422 }); h.repos.close(); });
  it('returns a clear dependency error when a scanned Agent becomes unavailable', async () => { const h = harness(); const unavailable = { ...agent, id: 'trae', name: 'Trae', command: 'missing-trae' }; const runtime = new DutydeckRuntime(h.repos, { probe: () => ({ protocol: 'acp', available: false, detail: 'command disappeared after scan', pause: false, resume: true }) }); await runtime.initialize([unavailable]); await expect(runtime.start({ agentId: 'trae' })).rejects.toMatchObject({ code: 'AGENT_UNAVAILABLE' }); h.repos.close(); });

  it('marks a turn failed when the agent stops mid-thinking without final text', async () => {
    const h = harness({ onSend: emit => emit({ type: 'thinking', data: { text: 'still thinking' } }) });
    await h.runtime.initialize([agent]); const s = await h.runtime.start({ agentId: 'mock' });
    await h.runtime.send(s.id, 'work');
    expect((await h.runtime.getTasks(s.id))[0]?.status).toBe('failed');
    await vi.waitFor(async () => expect((await h.runtime.getEvents(s.id)).some(e => e.type === 'error' && /未返回最终输出/.test((e.data as any)?.message ?? ''))).toBe(true));
    await h.runtime.shutdown(); h.repos.close();
  });

  it('marks a turn failed when tools finish but the agent never returns final text', async () => {
    const h = harness({ onSend: emit => { emit({ type: 'tool_call', data: { id: 't', name: 'read', input: '.', status: 'running' } }); emit({ type: 'tool_result', data: { id: 't', name: 'read', output: 'ok', status: 'completed' } }); } });
    await h.runtime.initialize([agent]); const s = await h.runtime.start({ agentId: 'mock' });
    await h.runtime.send(s.id, 'work');
    expect((await h.runtime.getTasks(s.id))[0]?.status).toBe('failed');
    await vi.waitFor(async () => expect((await h.runtime.getEvents(s.id)).some(e => e.type === 'error' && /未返回最终输出/.test((e.data as any)?.message ?? ''))).toBe(true));
    await h.runtime.shutdown(); h.repos.close();
  });

  it('keeps a shared session reusable after a task-level "no final output" failure so the next turn runs', async () => {
    // First turn produces activity but no terminal assistant text -> task fails.
    // The session must not be poisoned into `failed`; a following turn must run.
    const h = harness({ onSend: emit => { emit({ type: 'thinking', data: { text: 'still thinking' } }); } });
    await h.runtime.initialize([agent]); const s = await h.runtime.start({ agentId: 'mock' });
    await h.runtime.send(s.id, 'first');
    expect((await h.runtime.getTasks(s.id))[0]?.status).toBe('failed');
    await vi.waitFor(async () => expect((await h.runtime.getSession(s.id))?.state).toBe('idle'));
    // A second, well-formed turn must run on the same session.
    h.driver.send = vi.fn(async () => h.emit({ type: 'text', data: { text: 'done' } }));
    await h.runtime.send(s.id, 'second');
    expect(h.driver.send).toHaveBeenCalledWith('second');
    await vi.waitFor(async () => expect((await h.runtime.getTasks(s.id)).find(task => task.prompt === 'second')?.status).toBe('completed'));
    expect((await h.runtime.getSession(s.id))?.state).toBe('completed');
    await h.runtime.shutdown(); h.repos.close();
  });

  it('keeps a shared session reusable after a driver error event during a task', async () => {
    const h = harness({ onSend: emit => emit({ type: 'error', data: { message: 'temporary SDK error' } }) });
    await h.runtime.initialize([agent]); const s = await h.runtime.start({ agentId: 'mock' });
    await h.runtime.send(s.id, 'first');
    expect((await h.runtime.getTasks(s.id))[0]?.status).toBe('failed');
    expect(await h.runtime.getSession(s.id)).toMatchObject({ state: 'idle', error: 'temporary SDK error' });
    h.driver.send = vi.fn(async () => h.emit({ type: 'text', data: { text: 'done' } }));
    await h.runtime.send(s.id, 'second');
    expect((await h.runtime.getTasks(s.id)).find(task => task.prompt === 'second')?.status).toBe('completed');
    await h.runtime.shutdown(); h.repos.close();
  });

  it('keeps a current-turn error terminal even when assistant text was already emitted', async () => {
    const h = harness({ onSend: emit => {
      emit({ type: 'text', data: { text: 'partial answer' } });
      emit({ type: 'error', data: { message: 'terminal SDK error' } });
      emit({ type: 'completed', data: { stopReason: 'end_turn' } });
    } });
    await h.runtime.initialize([agent]); const s = await h.runtime.start({ agentId: 'mock' });

    await h.runtime.send(s.id, 'work');

    expect((await h.runtime.getTasks(s.id))[0]?.status).toBe('failed');
    expect(await h.runtime.getSession(s.id)).toMatchObject({ state: 'idle', error: 'terminal SDK error' });
    const events = await h.runtime.getEvents(s.id);
    expect(events.some(event => event.type === 'text' && (event.data as any).text === 'partial answer')).toBe(true);
    expect(events.some(event => event.type === 'error' && (event.data as any).message === 'terminal SDK error')).toBe(true);
    expect(events.some(event => event.type === 'completed')).toBe(false);
    await h.runtime.shutdown(); h.repos.close();
  });

  it('drains work already queued behind a task-level SDK failure', async () => {
    const firstTurn = deferred();
    const h = harness();
    await h.runtime.initialize([agent]); const s = await h.runtime.start({ agentId: 'mock' });
    h.driver.send = vi.fn(async prompt => {
      if (prompt === 'fail-me') {
        await firstTurn.promise;
        throw new Error('temporary SDK error');
      }
      h.emit({ type: 'text', data: { text: 'done' } });
    });

    const first = await h.runtime.dispatch(s.id, 'fail-me');
    await vi.waitFor(() => expect(h.driver.send).toHaveBeenCalledWith('fail-me'));
    const second = await h.runtime.dispatch(s.id, 'queued-after-failure');
    expect(second.queuedAhead).toBe(1);
    firstTurn.resolve();

    await vi.waitFor(async () => expect((await h.runtime.getTasks(s.id)).find(task => task.id === first.id)?.status).toBe('failed'));
    await vi.waitFor(async () => expect((await h.runtime.getTasks(s.id)).find(task => task.id === second.id)?.status).toBe('completed'));
    expect(h.driver.send).toHaveBeenNthCalledWith(2, 'queued-after-failure');
    await h.runtime.shutdown(); h.repos.close();
  });

  it('marks a turn interrupted when the driver reports a cancelled stopReason', async () => {
    const h = harness({ onSend: emit => emit({ type: 'completed', data: { stopReason: 'cancelled' } }) });
    await h.runtime.initialize([agent]); const s = await h.runtime.start({ agentId: 'mock' });
    await h.runtime.send(s.id, 'work');
    expect((await h.runtime.getTasks(s.id))[0]?.status).toBe('interrupted');
    expect((await h.runtime.getSession(s.id))?.state).toBe('interrupted');
    await h.runtime.shutdown(); h.repos.close();
  });

  it('keeps cancellation terminal even when the driver also emitted an error', async () => {
    const h = harness({ onSend: emit => {
      emit({ type: 'error', data: { message: 'cancel race error' } });
      emit({ type: 'completed', data: { stopReason: 'cancelled' } });
    } });
    await h.runtime.initialize([agent]);
    const session = await h.runtime.start({ agentId: 'mock' });
    const task = await h.runtime.send(session.id, 'cancel work');
    expect(task.status).toBe('interrupted');
    expect((await h.runtime.getSession(session.id))?.state).toBe('interrupted');
    expect((await h.runtime.getEvents(session.id)).some(event => event.type === 'completed')).toBe(false);
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
    await expect(h.runtime.send(session.id, 'broken work')).rejects.toThrow('transport rejected');
    const errors = (await h.runtime.getEvents(session.id)).filter(event => event.type === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.data).toMatchObject({ message: 'canonical driver error' });
    expect(saveError).toHaveBeenCalledTimes(1);
    expect(saveError).toHaveBeenCalledWith(session.id, 'canonical driver error', undefined);
    expect((await h.runtime.getSession(session.id))?.state).toBe('idle');
    await h.runtime.shutdown(); h.repos.close();
  });

  it('marks a turn failed when the driver reports a max_tokens stopReason', async () => {
    const h = harness({ onSend: emit => emit({ type: 'completed', data: { stopReason: 'max_tokens' } }) });
    await h.runtime.initialize([agent]); const s = await h.runtime.start({ agentId: 'mock' });
    await h.runtime.send(s.id, 'work');
    expect((await h.runtime.getTasks(s.id))[0]?.status).toBe('failed');
    await vi.waitFor(async () => expect((await h.runtime.getEvents(s.id)).some(e => e.type === 'error' && /截断/.test((e.data as any)?.message ?? ''))).toBe(true));
    await h.runtime.shutdown(); h.repos.close();
  });
});

describe('multi-driver routing', () => {
  const ptyAgent: AgentConfig = { id: 'mock-pty', name: 'Mock PTY', command: process.execPath, args: [], protocol: 'pty-cli', cwd: '/tmp', env: {}, permissionMode: 'full-trust', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };
  const ptyProbe = () => ({ protocol: 'pty-cli' as const, available: true, pause: false, resume: true });

  it('fails closed for the legacy PTY transport that cannot enforce permissions or expose approval', async () => {
    const repos = createRepositories(':memory:');
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
    const repos = createRepositories(':memory:');
    let emit!: (event: any) => void;
    const driver: AgentDriver = { start: vi.fn(async () => {}), send: vi.fn(async () => { emit({ type: 'text', data: { text: 'answer' } }); emit({ type: 'completed', data: { stopReason: 'end_turn' } }); }), interrupt: vi.fn(async () => {}), resume: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
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
    expect((await h.runtime.getSession(session.id))?.state).toBe('completed');
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
    const repos = createRepositories(':memory:');
    const runtime = new DutydeckRuntime(repos, { probe: ptyProbe });
    await repos.agents.save(ptyAgent);
    await runtime.initialize([ptyAgent]);
    await expect(runtime.start({ agentId: 'mock-pty' })).rejects.toMatchObject({ code: 'DRIVER_UNAVAILABLE', statusCode: 503 });
    await runtime.shutdown(); repos.close();
  });

  it('lets a custom driverFactory take precedence over pty-cli routing', async () => {
    const repos = createRepositories(':memory:');
    const driver: AgentDriver = { start: vi.fn(async () => {}), send: vi.fn(async () => {}), interrupt: vi.fn(async () => {}), resume: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
    const custom = vi.fn(() => driver);
    const ptyFallback = vi.fn(() => driver);
    const runtime = new DutydeckRuntime(repos, { probe: ptyProbe, driverFactory: custom, ptyDriverFactory: ptyFallback });
    await repos.agents.save(ptyAgent);
    await runtime.initialize([ptyAgent]);
    await runtime.start({ agentId: 'mock-pty' });
    expect(custom).toHaveBeenCalledWith(expect.objectContaining({ id: 'mock-pty' }), 'pty-cli', expect.any(Function), expect.any(Function), expect.any(String));
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
    h.repos.close();
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
    const unsubscribe = h.runtime.subscribe(session.id, event => received.push(event));
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
    // driver.send 永不 resolve = 轮次一直忙；driver.stop 立即 resolve = 与实测的
    // 真实 PtyCliDriver 行为一致（1ms 返回）。这样复现里唯一的变量就只剩 runtime。
    const neverEndingTurn = new Promise<void>(() => {});
    const h = harness();
    h.driver.send = vi.fn(async () => neverEndingTurn);

    await h.runtime.initialize([agent]);
    const session = await h.runtime.start({ agentId: 'mock' });
    void h.runtime.send(session.id, 'busy work').catch(() => { /* 这一轮不会结束 */ });
    await vi.waitFor(async () => expect((await h.runtime.getSession(session.id))?.state).toBe('thinking'));

    const outcome = await Promise.race([
      h.runtime.stop(session.id).then(() => 'returned' as const),
      new Promise<'hung'>(resolve => { setTimeout(() => resolve('hung'), 5_000); })
    ]);
    expect(outcome, 'stop() 在忙碌轮次中必须能返回，而不是永久等待 waitForTurn').toBe('returned');
    expect(h.driver.stop).toHaveBeenCalled();

    await h.runtime.shutdown(); h.repos.close();
  }, 15_000);
});

describe('重启后的忙碌态回收', () => {
  /*
    2026-09-03 线上实测：4310 实例上 3 个会话卡在 thinking，界面一直放呼吸动画，
    而它们的 cwd(/tmp/dutydeck-test) 早被删除、任务记录已经是 failed——
    **会话态与任务态互相矛盾**，用户分不出「真在想」和「进程三天前就死了」。

    原有三条回收分支都漏了这种形状：第一条只认 created/starting/failed 且无任务记录，
    第二条只认有 running 任务的（SIGKILL 时任务状态来不及落库），第三条只认旧队列。
  */
  const agent: AgentConfig = { id: 'mock', name: 'Mock', command: process.execPath, args: [], protocol: 'acp', cwd: '/tmp', env: {}, permissionMode: 'full-trust', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };
  const stamp = new Date().toISOString();
  const boot = async (seed: (repos: ReturnType<typeof createRepositories>) => Promise<void>) => {
    const repos = createRepositories(':memory:');
    await repos.agents.save(agent);
    await seed(repos);
    const runtime = new DutydeckRuntime(repos, { probe: () => ({ protocol: 'acp' as const, available: true, pause: false, resume: true }), driverFactory: () => ({ start: vi.fn(async () => {}), send: vi.fn(async () => {}), interrupt: vi.fn(async () => {}), resume: vi.fn(async () => {}), stop: vi.fn(async () => {}) }) });
    await runtime.initialize([agent]);
    return { repos, runtime };
  };

  it('把重启后不可能仍在跑的忙碌会话落到 stopped 并说明原因', async () => {
    const { repos, runtime } = await boot(async seeded => {
      // 复刻线上那三个：会话 thinking，任务却已经是 failed
      await seeded.sessions.save({ id: 'ses_zombie', agentId: 'mock', state: 'thinking', cwd: '/tmp/gone', permissionMode: 'full-trust', source: 'web', protocol: 'acp', runId: 'run_old', createdAt: stamp, updatedAt: stamp });
      await seeded.tasks.save({ id: 'task_dead', sessionId: 'ses_zombie', prompt: 'p', status: 'failed', createdAt: stamp, updatedAt: stamp });
    });
    const session = await runtime.getSession('ses_zombie');
    expect(session?.state).toBe('stopped');
    // 光改状态不够：不说原因，用户只会以为自己的任务被无声吞了
    expect(session?.error).toContain('守护进程重启');
    await runtime.shutdown(); repos.close();
  });

  it('五个忙碌态一个都不漏', async () => {
    /*
      注意每个会话都带一条任务记录：第一条回收分支（created/starting/failed 且
      **无任务记录** → 判 failed 并归档）会先截胡 starting。那条分支是对的——
      「启动就没成功过」标 failed 比 stopped 准确——所以这里要测的是「已经跑起来过、
      然后进程没了」的形状，得让它落到本条兜底上。

      初版断言没给任务记录，starting 拿到 failed 当场红。那不是产品 bug，
      是我的断言把两种不同的场景混在了一起。
    */
    const busy = ['starting', 'thinking', 'running_tool', 'waiting_for_permission', 'interrupting'] as const;
    const { repos, runtime } = await boot(async seeded => {
      for (const state of busy) {
        await seeded.sessions.save({ id: `ses_${state}`, agentId: 'mock', state, cwd: '/tmp/gone', permissionMode: 'full-trust', source: 'web', protocol: 'acp', runId: 'run_old', createdAt: stamp, updatedAt: stamp });
        await seeded.tasks.save({ id: `task_${state}`, sessionId: `ses_${state}`, prompt: 'p', status: 'failed', createdAt: stamp, updatedAt: stamp });
      }
    });
    for (const state of busy) expect((await runtime.getSession(`ses_${state}`))?.state, state).toBe('stopped');
    await runtime.shutdown(); repos.close();
  });

  it('不碰已经是终态的会话', async () => {
    // 回收只该管「撒谎的」状态。completed / interrupted 是真话，改了反而抹掉历史。
    const settled = ['completed', 'interrupted', 'failed', 'idle'] as const;
    const { repos, runtime } = await boot(async seeded => {
      for (const state of settled) {
        await seeded.sessions.save({ id: `ses_${state}`, agentId: 'mock', state, cwd: '/tmp/gone', permissionMode: 'full-trust', source: 'web', protocol: 'acp', runId: 'run_old', createdAt: stamp, updatedAt: stamp });
        // 带一条任务记录，避开第一条回收分支（它只认「无任务记录」的）
        await seeded.tasks.save({ id: `task_${state}`, sessionId: `ses_${state}`, prompt: 'p', status: 'completed', createdAt: stamp, updatedAt: stamp });
      }
    });
    for (const state of settled) expect((await runtime.getSession(`ses_${state}`))?.state, state).toBe(state);
    await runtime.shutdown(); repos.close();
  });

  it('有待执行队列的忙碌会话不标 stopped——它下一秒就要被重新调度', async () => {
    /*
      这条是写修复时发现的真实冲突：initialize 末尾会给有队列的会话调 scheduleQueue，
      如果兜底排在它后面无差别地标 stopped，就会出现「正在跑却写着已停止」——
      修掉一个矛盾又造一个新的。所以兜底必须排在 scheduleQueue 之前，并跳过有队列的。
    */
    const { repos, runtime } = await boot(async seeded => {
      await seeded.sessions.save({ id: 'ses_queued', agentId: 'mock', state: 'thinking', cwd: '/tmp', permissionMode: 'full-trust', source: 'web', protocol: 'acp', runId: 'run_old', createdAt: stamp, updatedAt: stamp });
      await seeded.tasks.save({ id: 'task_next', sessionId: 'ses_queued', prompt: 'p', status: 'queued', executionContext: { agentPrompt: 'p' }, createdAt: stamp, updatedAt: stamp });
    });
    expect((await runtime.getSession('ses_queued'))?.state).not.toBe('stopped');
    await runtime.shutdown(); repos.close();
  });
});
