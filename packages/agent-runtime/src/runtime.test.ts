import { describe, expect, it, vi } from 'vitest';
import { createRepositories } from '@dockmux/storage';
import type { AgentConfig, Session } from '@dockmux/shared';
import { DockmuxRuntime, type AgentDriver, type DriverFactory } from './index.js';

const agent: AgentConfig = { id: 'mock', name: 'Mock', command: process.execPath, args: [], protocol: 'acp', cwd: '/tmp', env: {}, permissionMode: 'ask', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };

function harness(options: { onSend?: (emit: (event: any) => void) => void; exitOnSend?: number; driverIdleTimeoutMs?: number; sessionEnvironment?: (session: Session) => Record<string, string>; sessionPrompt?: (session: Session, prompt: string) => string | Promise<string> } = {}) {
  const repos = createRepositories(':memory:'); let emit!: (event: any) => void; let exit!: (code: number | null) => void; const configuredAgents: AgentConfig[] = [];
  const driver: AgentDriver = { start: vi.fn(async () => {}), send: vi.fn(async () => { options.onSend?.(emit); if (options.exitOnSend) exit(options.exitOnSend); }), interrupt: vi.fn(async () => {}), resume: vi.fn(async () => {}), stop: vi.fn(async () => {}), setModel: vi.fn(async () => {}), setReasoningEffort: vi.fn(async () => {}), setPermissionMode: vi.fn() };
  const runtime = new DockmuxRuntime(repos, { probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }), driverFactory: (configuredAgent, _p, onEvent, onExit) => { configuredAgents.push(configuredAgent); emit = onEvent; exit = onExit; return driver; }, driverIdleTimeoutMs: options.driverIdleTimeoutMs, sessionEnvironment: options.sessionEnvironment, sessionPrompt: options.sessionPrompt });
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

  it('forces complete access even when Agent config or session input requests approval', async () => {
    const h = harness(); await h.runtime.initialize([{ ...agent, permissionMode: 'ask' }]);
    const session = await h.runtime.start({ agentId: 'mock', permissionMode: 'deny-all' });
    expect(session.permissionMode).toBe('full-trust');
    expect(h.configuredAgents[0]?.permissionMode).toBe('full-trust');
    expect((await h.runtime.listAgents())[0]?.permissionMode).toBe('full-trust');
    await h.runtime.shutdown(); h.repos.close();
  });

  it('migrates persisted sessions to complete access during initialization', async () => {
    const h = harness();
    await h.repos.sessions.save({ id: 'ses_old', agentId: 'mock', state: 'idle', cwd: '/tmp', permissionMode: 'ask', runId: 'run_old', createdAt: '', updatedAt: '' });
    await h.runtime.initialize([agent]);
    expect(await h.runtime.getSession('ses_old')).toMatchObject({ permissionMode: 'full-trust' });
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
    const first = await h.runtime.dispatch(session.id, 'first'); expect(first.queuedAhead).toBe(0); await vi.waitFor(() => expect(h.driver.send).toHaveBeenCalledWith('first'));
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
    const restored = new DockmuxRuntime(first.repos, { probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }), driverFactory: () => driver });
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
    const restored = new DockmuxRuntime(first.repos, { driverFactory: current => { configured = current; return driver; } });
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
  it('stop delegates process-tree cleanup and marks stopped', async () => { const h = harness(); await h.runtime.initialize([agent]); const s = await h.runtime.start({ agentId: 'mock' }); await h.runtime.stop(s.id); expect(h.driver.stop).toHaveBeenCalledOnce(); expect((await h.runtime.getSession(s.id))?.state).toBe('stopped'); h.repos.close(); });
  it('permanently archives a session and rejects subsequent actions', async () => { const h = harness(); await h.runtime.initialize([agent]); const s = await h.runtime.start({ agentId: 'mock' }); const archived = await h.runtime.archive(s.id); expect(archived.archivedAt).toBeTruthy(); expect(archived.state).toBe('stopped'); await expect(h.runtime.dispatch(s.id, 'not allowed')).rejects.toMatchObject({ code: 'SESSION_ARCHIVED' }); expect((await h.runtime.listSessions())[0]?.archivedAt).toBe(archived.archivedAt); await h.runtime.shutdown(); h.repos.close(); });
  it('restart creates a new run instance', async () => { const h = harness(); await h.runtime.initialize([agent]); const s = await h.runtime.start({ agentId: 'mock' }); const old = s.runId; const restarted = await h.runtime.restart(s.id); expect(restarted.runId).not.toBe(old); expect(h.driver.stop).toHaveBeenCalledOnce(); h.repos.close(); });
  it('abnormal agent exit produces failed state and error event', async () => { const h = harness({ exitOnSend: 17 }); await h.runtime.initialize([agent]); const s = await h.runtime.start({ agentId: 'mock' }); await h.runtime.send(s.id, 'exit'); await vi.waitFor(async () => expect((await h.runtime.getEvents(s.id)).some(e => e.type === 'error')).toBe(true)); h.repos.close(); });
  it('permission requests can be approved and rejected', async () => { const h = harness({ onSend: emit => { emit({ type: 'permission_request', data: { id: 'p1', title: 'Write?', status: 'pending' } }); emit({ type: 'permission_request', data: { id: 'p2', title: 'Delete?', status: 'pending' } }); } }); await h.runtime.initialize([agent]); const s = await h.runtime.start({ agentId: 'mock' }); await h.runtime.send(s.id, 'write'); expect((await h.runtime.resolvePermission(s.id, 'p1', true)).status).toBe('approved'); expect((await h.runtime.resolvePermission(s.id, 'p2', false)).status).toBe('rejected'); await expect(h.runtime.resolvePermission(s.id, 'p1', true)).rejects.toMatchObject({ code: 'PERMISSION_NOT_FOUND' }); await h.runtime.shutdown(); h.repos.close(); });
  it('returns an explicit error for unsupported pause/resume', async () => { const h = harness(); await h.runtime.initialize([agent]); const s = await h.runtime.start({ agentId: 'mock' }); await expect(h.runtime.pause(s.id)).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY', statusCode: 422 }); h.repos.close(); });
  it('returns a clear dependency error when a scanned Agent becomes unavailable', async () => { const h = harness(); const unavailable = { ...agent, id: 'trae', name: 'Trae', command: 'missing-trae' }; const runtime = new DockmuxRuntime(h.repos, { probe: () => ({ protocol: 'acp', available: false, detail: 'command disappeared after scan', pause: false, resume: true }) }); await runtime.initialize([unavailable]); await expect(runtime.start({ agentId: 'trae' })).rejects.toMatchObject({ code: 'AGENT_UNAVAILABLE' }); h.repos.close(); });

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
    expect(await h.runtime.getSession(s.id)).toMatchObject({ state: 'idle', error: 'Agent 未返回最终输出' });
    h.driver.send = vi.fn(async () => h.emit({ type: 'text', data: { text: 'done' } }));
    await h.runtime.send(s.id, 'second');
    expect((await h.runtime.getTasks(s.id)).find(task => task.prompt === 'second')?.status).toBe('completed');
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

  function ptyHarness(ptyDriverFactory?: DriverFactory) {
    const repos = createRepositories(':memory:');
    let emit!: (event: any) => void;
    const driver: AgentDriver = { start: vi.fn(async () => {}), send: vi.fn(async () => { emit({ type: 'text', data: { text: 'answer' } }); emit({ type: 'completed', data: { stopReason: 'end_turn' } }); }), interrupt: vi.fn(async () => {}), resume: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
    let routedProtocol: string | undefined;
    const runtime = new DockmuxRuntime(repos, {
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

  it('rejects pty-cli sessions when no ptyDriverFactory is injected', async () => {
    const repos = createRepositories(':memory:');
    const runtime = new DockmuxRuntime(repos, { probe: ptyProbe });
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
    const runtime = new DockmuxRuntime(repos, { probe: ptyProbe, driverFactory: custom, ptyDriverFactory: ptyFallback });
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

describe('publishSessionEvent — 带外事件入口（@dockmux/relay 的落点）', () => {
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
});
