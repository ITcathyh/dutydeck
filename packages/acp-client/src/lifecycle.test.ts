import { existsSync } from 'node:fs';
import { getEventListeners } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRuntimeStore } from 'acpx/runtime';
import { AcpxAdapter } from './index.js';
import * as regex from './regex-timeout.js';

const releases: Array<() => void> = [];
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  releases.push(() => resolve(undefined as T));
  return { promise, resolve, reject };
}
const dirs: string[] = [];
const adapters: AcpxAdapter[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const release of releases.splice(0)) release();
  for (const directory of dirs) {
    await writeFile(join(directory, 'release'), 'release');
    await writeFile(join(directory, 'release_cancel'), 'release');
  }
  await Promise.allSettled(adapters.splice(0).map(adapter => adapter.stop()));
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});
async function setup(extra = {}, options = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'dutydeck-acp-lifecycle-')); dirs.push(cwd);
  const events: any[] = [];
  const adapter = new AcpxAdapter({ id: 'mock', name: 'Mock', command: process.execPath, args: [resolve('tests/fixtures/acp-lifecycle-agent.mjs')], protocol: 'acp', cwd, permissionMode: 'ask', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false, ...extra, env: { lifecycle_directory: cwd, ...('env' in extra ? extra.env as object : {}) } }, { sessionKey: 'lifecycle-persistent-key', onEvent: event => events.push(event), ...options });
  adapters.push(adapter);
  const runtime = (adapter as any).runtime;
  return { adapter, runtime, cwd, events };
}
function fakeResources(runtime: any) {
  vi.spyOn(runtime, 'ensureSession').mockResolvedValue({ sessionKey: 'fake' });
  vi.spyOn(runtime, 'close').mockResolvedValue(undefined);
}

describe('ACP instance revocation', () => {
  it('waits for a real delayed persistent creation, closes it, and never installs the late handle', async () => {
    const { adapter, cwd } = await setup({ env: { MOCK_VENDOR_TOKEN: 'test-secret' } });
    // Keep the real ACP runtime, native subprocess and persisted session key.
    const starting = adapter.start().then(() => 'started', error => error);
    await expect.poll(() => existsSync(join(cwd, 'creating'))).toBe(true);
    let settled = false;
    const stopping = adapter.stop().finally(() => { settled = true; });
    await new Promise(resolve => setImmediate(resolve));
    const settledBeforeCreation = settled;
    await writeFile(join(cwd, 'release'), 'release');
    const startupOutcome = await starting;
    await stopping;
    expect(settledBeforeCreation).toBe(false);
    expect(startupOutcome).toBeInstanceOf(Error);
    expect((adapter as any).handle).toBeUndefined();
    const record = await createRuntimeStore({ stateDir: join(cwd, '.dutydeck', 'acpx') }).load('lifecycle-persistent-key');
    expect(record?.closed).toBe(true);
    expect(Object.keys(record?.acpx?.session_options?.env ?? {}).every(key => /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(key))).toBe(true);
    const pid = Number(await readFile(join(cwd, 'creating'), 'utf8'));
    await expect.poll(() => { try { process.kill(pid, 0); return true; } catch { return false; } }).toBe(false);
    await expect(adapter.start()).rejects.toThrow(/stopped/i);
  });

  it('does not reset, ensure again, resend or emit when a missing-session error arrives after stop', async () => {
    const { adapter, runtime, events } = await setup(); fakeResources(runtime);
    const release = deferred(); const entered = deferred();
    const turn = { events: { async *[Symbol.asyncIterator]() { entered.resolve(); await release.promise; throw new Error('Resource not found'); } }, result: Promise.resolve({ status: 'failed', error: { message: 'Resource not found' } }), cancel: vi.fn().mockResolvedValue(undefined) };
    vi.spyOn(runtime, 'startTurn').mockReturnValue(turn);
    const reset = vi.spyOn(adapter as any, 'resetPersistentState');
    await adapter.start();
    const sending = adapter.send('once').catch(error => error);
    await entered.promise;
    const stopping = adapter.stop();
    release.resolve();
    await Promise.allSettled([stopping, sending]);
    expect(reset).not.toHaveBeenCalled();
    expect(runtime.ensureSession).toHaveBeenCalledTimes(1);
    expect(runtime.startTurn).toHaveBeenCalledTimes(1);
    expect(events).toEqual([]);
  });

  it.each(['full-trust', 'approve-reads', 'ask'] as const)('rejects a policy continuation after stop in %s mode', async permissionMode => {
    const policy = deferred<undefined>(); const entered = deferred();
    const { adapter, runtime, events } = await setup({ permissionMode }, { resolveRiskPolicy: () => { entered.resolve(); return policy.promise; } });
    const decision = runtime.options.onPermissionRequest({ inferredKind: 'read', raw: { toolCall: { toolCallId: 'late', title: 'Read file' } } });
    await entered.promise;
    await adapter.stop(); policy.resolve(undefined);
    expect(await Promise.race([decision, new Promise(resolve => setImmediate(() => resolve('hung')))])).toEqual({ outcome: 'reject_once' });
    expect((adapter as any).pendingPermissions.size).toBe(0);
    expect(events).toEqual([]);
  });

  it('still closes a captured handle after turn cancellation fails and retains the stop error', async () => {
    const { adapter, runtime } = await setup(); fakeResources(runtime); await adapter.start();
    (adapter as any).turn = { cancel: vi.fn().mockRejectedValue(new Error('cancel failed')) };
    await expect(adapter.stop()).rejects.toThrow(/cancel failed/);
    expect(runtime.close).toHaveBeenCalledTimes(1);
    await expect(adapter.send('no revival')).rejects.toThrow(/stopped/i);
    expect(runtime.ensureSession).toHaveBeenCalledTimes(1);
  });

  it('keeps a real native session across start, active interrupt and resume', async () => {
    const { adapter, cwd, events } = await setup();
    await writeFile(join(cwd, 'release'), 'release');
    await adapter.start();
    const sending = adapter.send('wait');
    await expect.poll(async () => (await readFile(join(cwd, 'calls.jsonl'), 'utf8')).includes('session/prompt')).toBe(true);
    await adapter.interrupt(); await sending;
    await adapter.resume(); await adapter.send('again');
    await adapter.stop();
    const calls = (await readFile(join(cwd, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(calls.filter(call => call.method === 'session/new')).toHaveLength(1);
    expect(calls.filter(call => call.method === 'session/prompt')).toHaveLength(2);
    expect(events.some(event => event.type === 'text' && event.data.text === 'lifecycle-native-session')).toBe(true);
  });

  it('rejects a regex continuation and synchronous permission publication on stop', async () => {
    const match = deferred<boolean>(); const entered = deferred();
    vi.spyOn(regex, 'testRegexWithTimeout').mockImplementation(() => { entered.resolve(); return match.promise; });
    const { adapter, runtime, events } = await setup({ permissionMode: 'full-trust' });
    adapter.setRiskPolicy({ enabled: true, authorized: false, pattern: 'read' });
    const decision = runtime.options.onPermissionRequest({ raw: { toolCall: { toolCallId: 'late' } } });
    await entered.promise; await adapter.stop(); match.resolve(false);
    expect(await decision).toEqual({ outcome: 'reject_once' }); expect(events).toEqual([]);

    const other = await setup();
    (other.adapter as any).options.onEvent = () => { void other.adapter.stop(); };
    expect(await other.runtime.options.onPermissionRequest({ raw: { toolCall: { toolCallId: 'sync' } } })).toEqual({ outcome: 'reject_once' });
    expect((other.adapter as any).pendingPermissions.size).toBe(0);
  });

  it.each(['send', 'setModel', 'setReasoningEffort'] as const)('revokes implicit startup from %s and queued resource work', async method => {
    const { adapter, runtime } = await setup(); fakeResources(runtime);
    const creating = deferred<any>(); const entered = deferred();
    runtime.ensureSession.mockImplementation(() => { entered.resolve(); return creating.promise; });
    const invoking = adapter[method]('value').catch(error => error);
    await entered.promise;
    const queued = adapter.resume().catch(error => error);
    const stopping = adapter.stop();
    const handle = { sessionKey: 'late' }; creating.resolve(handle);
    expect(await invoking).toBeInstanceOf(Error); expect(await queued).toBeInstanceOf(Error);
    await stopping;
    expect(runtime.ensureSession).toHaveBeenCalledTimes(1);
    expect(runtime.close).toHaveBeenCalledWith({ handle, reason: 'Dutydeck stop' });
    expect((adapter as any).handle).toBeUndefined();
  });

  it.each(['setModel', 'setReasoningEffort'] as const)('does not apply configuration after stopped getStatus in %s', async method => {
    const { adapter, runtime } = await setup(); fakeResources(runtime); await adapter.start();
    const status = deferred<any>(); const entered = deferred();
    vi.spyOn(runtime, 'getStatus').mockImplementation(() => { entered.resolve(); return status.promise; });
    const set = vi.spyOn(runtime, 'setConfigOption').mockResolvedValue(undefined);
    const setting = adapter[method]('new-value').catch(error => error);
    await entered.promise; const stopping = adapter.stop();
    status.resolve({ details: { configOptions: [{ id: 'model' }, { id: 'effort' }] } });
    expect(await setting).toBeInstanceOf(Error); await stopping;
    expect(set).not.toHaveBeenCalled();
  });

  it('waits for entered setConfig and does not commit the late model value', async () => {
    const { adapter, runtime } = await setup(); fakeResources(runtime); await adapter.start();
    vi.spyOn(runtime, 'getStatus').mockResolvedValue({ details: { configOptions: [{ id: 'model' }] } });
    const config = deferred(); const entered = deferred();
    vi.spyOn(runtime, 'setConfigOption').mockImplementation(() => { entered.resolve(); return config.promise; });
    const setting = adapter.setModel('late-model').catch(error => error);
    await entered.promise;
    let stopped = false; const stopping = adapter.stop().then(() => { stopped = true; });
    await new Promise(resolve => setImmediate(resolve)); expect(stopped).toBe(false);
    config.resolve(); expect(await setting).toBeInstanceOf(Error); await stopping;
    expect(adapter.agent.model).toBeUndefined();
  });

  it('closes the produced handle even when pending startup configuration rejects', async () => {
    const { adapter, runtime } = await setup({ reasoningEffort: 'high' }); fakeResources(runtime);
    const status = deferred<any>(); const entered = deferred();
    vi.spyOn(runtime, 'getStatus').mockImplementation(() => { entered.resolve(); return status.promise; });
    const starting = adapter.start().catch(error => error); await entered.promise;
    const stopping = adapter.stop().catch(error => error);
    status.reject(new Error('status failed'));
    expect(await starting).toMatchObject({ message: 'status failed' });
    expect(await stopping).toMatchObject({ message: 'status failed' });
    expect(runtime.close).toHaveBeenCalledTimes(2);
  });

  it('does not save a reset loaded before revocation', async () => {
    const { adapter, runtime } = await setup(); fakeResources(runtime); await adapter.start();
    const store = (adapter as any).sessionStore;
    const loading = deferred<any>(); const entered = deferred();
    vi.spyOn(store, 'load').mockImplementation(() => { entered.resolve(); return loading.promise; });
    const save = vi.spyOn(store, 'save').mockResolvedValue(undefined);
    vi.spyOn(runtime, 'startTurn').mockReturnValue({ events: { async *[Symbol.asyncIterator]() {} }, result: Promise.resolve({ status: 'failed', error: { message: 'Resource not found' } }), cancel: vi.fn().mockResolvedValue(undefined) });
    await expect(adapter.send('once')).rejects.toThrow('Resource not found');
    expect(save).not.toHaveBeenCalled();
    Reflect.set(adapter,'handle',undefined);
    const sending = adapter.start().catch(error => error); await entered.promise;
    const stopping = adapter.stop(); loading.resolve({ acpx: {} });
    await Promise.all([sending, stopping]); expect(save).not.toHaveBeenCalled();
    expect(runtime.ensureSession).toHaveBeenCalledTimes(1);
  });

  it('keeps one stream consumer through an idle timeout and waits for SDK finalization before env cleanup', async () => {
    const { adapter, runtime, events } = await setup({ timeout: 0.02, env: { MOCK_VENDOR_TOKEN: 'secret' } }); fakeResources(runtime);
    const envFile = (adapter as any).launch.sessionOptions.env.dutydeck_agent_env_file;
    const tail = deferred(); const entered = deferred(); let consumers = 0;
    const turn = { events: { async *[Symbol.asyncIterator]() { consumers++; entered.resolve(); await tail.promise; yield { type: 'text_delta', text: 'old text' }; } }, result: Promise.resolve({ status: 'completed' }), cancel: vi.fn().mockResolvedValue(undefined) };
    vi.spyOn(runtime, 'startTurn').mockReturnValue(turn);
    const sending = adapter.send('idle').catch(error => error); await entered.promise;
    expect(await sending).toMatchObject({ name: 'AgentIdleTimeoutError' });
    let stopped = false; const stopping = adapter.stop().then(() => { stopped = true; });
    await new Promise(resolve => setImmediate(resolve));
    expect(stopped).toBe(false); expect(existsSync(envFile)).toBe(true);
    tail.resolve(); await stopping;
    expect(consumers).toBe(1); expect(events).toEqual([]); expect(existsSync(envFile)).toBe(false);
  });

  it('retains a visible close failure and forbids all implicit revival paths', async () => {
    const { adapter, runtime } = await setup(); fakeResources(runtime); await adapter.start();
    runtime.close.mockRejectedValue(new Error('close failed'));
    await expect(adapter.stop()).rejects.toThrow('close failed');
    await expect(adapter.stop()).rejects.toThrow('close failed');
    for (const action of [() => adapter.start(), () => adapter.resume(), () => adapter.send('x'), () => adapter.setModel('x'), () => adapter.setReasoningEffort('x')]) await expect(action()).rejects.toThrow(/stopped/i);
    expect(runtime.ensureSession).toHaveBeenCalledTimes(1);
    // Physical proof now has its own real-process regressions; a close error
    // still revokes this adapter and remains visible to the caller.
    expect(adapter.isStopped).toBeTypeOf('function');
  });

  it('stops a real ACP request without waiting for a suspended policy resolver', async () => {
    const policy = deferred<undefined>(); const entered = deferred();
    const { adapter, runtime, events } = await setup({ args: [resolve('tests/fixtures/mock-acp-agent.mjs')], permissionMode: 'full-trust' }, { resolveRiskPolicy: () => { entered.resolve(); return policy.promise; } });
    const permission = vi.spyOn(runtime.options, 'onPermissionRequest');
    await adapter.start();
    const sending = adapter.send('request permission').catch(error => error);
    await entered.promise;
    const eventCount = events.length;
    await adapter.stop();
    policy.resolve(undefined); await sending;
    expect(await permission.mock.results[0]!.value).toEqual({ outcome: 'reject_once' });
    expect((adapter as any).pendingPermissions.size).toBe(0);
    expect(events).toHaveLength(eventCount);
  });

  it('waits for an entered persistent reset save but never ensures or resends afterwards', async () => {
    const { adapter, runtime } = await setup(); fakeResources(runtime); await adapter.start();
    const store = (adapter as any).sessionStore;
    vi.spyOn(store, 'load').mockResolvedValue({ acpx: {session_options:{env:{dutydeck_group_tools_token:'old'}}} });
    const saving = deferred(); const entered = deferred();
    vi.spyOn(store, 'save').mockImplementation(() => { entered.resolve(); return saving.promise; });
    vi.spyOn(runtime, 'startTurn').mockReturnValue({ events: { async *[Symbol.asyncIterator]() {} }, result: Promise.resolve({ status: 'failed', error: { message: 'Resource not found' } }), cancel: vi.fn().mockResolvedValue(undefined) });
    await expect(adapter.send('once')).rejects.toThrow('Resource not found');
    expect(store.save).not.toHaveBeenCalled();
    Reflect.set(adapter,'handle',undefined);
    const sending = adapter.start().catch(error => error); await entered.promise;
    let stopped = false; const stopping = adapter.stop().then(() => { stopped = true; });
    await new Promise(resolve => setImmediate(resolve)); expect(stopped).toBe(false);
    saving.resolve(); await Promise.all([sending, stopping]);
    expect(runtime.ensureSession).toHaveBeenCalledTimes(1); expect(runtime.startTurn).toHaveBeenCalledTimes(1);
  });

  it.each(['setModel', 'setReasoningEffort'] as const)('does not query status after the %s handle-await boundary is revoked', async method => {
    const { adapter, runtime } = await setup(); fakeResources(runtime); await adapter.start();
    const ready = deferred<any>(); const entered = deferred();
    vi.spyOn(adapter as any, 'ensureHandle').mockImplementation(() => { entered.resolve(); return ready.promise; });
    const status = vi.spyOn(runtime, 'getStatus');
    const setting = adapter[method]('late').catch(error => error); await entered.promise;
    const stopping = adapter.stop(); ready.resolve((adapter as any).handle);
    expect(await setting).toBeInstanceOf(Error); await stopping;
    expect(status).not.toHaveBeenCalled();
  });

  it('observes rejected resource creation and repeated stop keeps the failure visible', async () => {
    const { adapter, runtime } = await setup(); fakeResources(runtime);
    const creating = deferred<any>(); const entered = deferred();
    runtime.ensureSession.mockImplementation(() => { entered.resolve(); return creating.promise; });
    const starting = adapter.start().catch(error => error); await entered.promise;
    const stopping = adapter.stop().catch(error => error);
    creating.reject(new Error('creation could not be confirmed'));
    expect(await starting).toMatchObject({ message: 'creation could not be confirmed' });
    expect(await stopping).toMatchObject({ message: 'creation could not be confirmed' });
    await expect(adapter.stop()).rejects.toThrow('creation could not be confirmed');
  });

  it('finishes consuming after an event callback throws, before surfacing the failure', async () => {
    const { adapter, runtime } = await setup(); fakeResources(runtime);
    const tail = deferred(); const entered = deferred(); let consumers = 0;
    (adapter as any).options.onEvent = () => { throw new Error('event write failed'); };
    vi.spyOn(runtime, 'startTurn').mockReturnValue({ events: { async *[Symbol.asyncIterator]() { consumers++; yield { type: 'text_delta', text: 'first' }; entered.resolve(); await tail.promise; } }, result: Promise.resolve({ status: 'completed' }), cancel: vi.fn().mockResolvedValue(undefined) });
    const sending = adapter.send('once').catch(error => error); await entered.promise;
    let stopped = false; const stopping = adapter.stop().then(() => { stopped = true; });
    await new Promise(resolve => setImmediate(resolve)); expect(stopped).toBe(false);
    tail.resolve(); await stopping;
    expect(await sending).toBeInstanceOf(Error); expect(consumers).toBe(1);
  });

  it('reports known cancellation failure without losing the still-pending finalizer', async () => {
    const { adapter, runtime } = await setup({ env: { MOCK_VENDOR_TOKEN: 'secret' } }); fakeResources(runtime);
    const envFile = (adapter as any).launch.sessionOptions.env.dutydeck_agent_env_file;
    const tail = deferred(); const entered = deferred();
    vi.spyOn(runtime, 'startTurn').mockReturnValue({ events: { async *[Symbol.asyncIterator]() { entered.resolve(); await tail.promise; } }, result: Promise.resolve({ status: 'cancelled' }), cancel: vi.fn().mockRejectedValue(new Error('cancel failed')) });
    const sending = adapter.send('blocked').catch(error => error); await entered.promise;
    await expect(adapter.stop()).rejects.toThrow('cancel failed');
    const closesBeforeFinalization = runtime.close.mock.calls.length;
    expect(closesBeforeFinalization).toBeGreaterThanOrEqual(1); expect(existsSync(envFile)).toBe(true);
    tail.resolve(); await sending;
    await expect.poll(() => runtime.close.mock.calls.length).toBe(closesBeforeFinalization + 1);
    expect(existsSync(envFile)).toBe(true);
    await expect(adapter.resume()).rejects.toThrow(/stopped/i);
  });

  it('removes policy abort listeners on settlement and observes a late rejection after revocation', async () => {
    const normal = await setup({ permissionMode: 'full-trust' }, { resolveRiskPolicy: async () => undefined });
    expect(await normal.runtime.options.onPermissionRequest({ raw: {} })).toEqual({ outcome: 'allow_once' });
    expect(getEventListeners((normal.adapter as any).revocation.signal, 'abort')).toHaveLength(0);
    const policy = deferred<undefined>(); const entered = deferred();
    const { adapter, runtime } = await setup({ permissionMode: 'full-trust' }, { resolveRiskPolicy: () => { entered.resolve(); return policy.promise; } });
    const decision = runtime.options.onPermissionRequest({ raw: {} }); await entered.promise;
    expect(getEventListeners((adapter as any).revocation.signal, 'abort')).toHaveLength(1);
    await adapter.stop(); expect(await decision).toEqual({ outcome: 'reject_once' });
    expect(getEventListeners((adapter as any).revocation.signal, 'abort')).toHaveLength(0);
    policy.reject(new Error('late policy failure'));
    await new Promise(resolve => setImmediate(resolve));
  });

  it.each(['getStatus', 'interrupt'] as const)('closes an existing handle before waiting for a blocked %s RPC', async method => {
    const { adapter, runtime } = await setup(); fakeResources(runtime); await adapter.start();
    const rpc = deferred<any>(); const entered = deferred(); const trace: string[] = [];
    let running: Promise<unknown>;
    if (method === 'getStatus') {
      vi.spyOn(runtime, 'getStatus').mockImplementation(() => { trace.push('rpc'); entered.resolve(); return rpc.promise; });
      running = adapter.setModel('late').catch(error => error);
    } else {
      vi.spyOn(runtime, 'cancel').mockImplementation(() => { trace.push('rpc'); entered.resolve(); return rpc.promise; });
      running = adapter.interrupt().catch(error => error);
    }
    await entered.promise;
    runtime.close.mockImplementation(async () => { trace.push('close'); rpc.resolve(undefined); });
    await adapter.stop(); await running;
    expect(trace).toEqual(['rpc', 'close', 'close']);
    expect((adapter as any).handle).toBeUndefined();
  });

  it('waits outside the resource lane for a timed-out stream before a sequential prompt', async () => {
    const { adapter, runtime } = await setup({ timeout: 0.02 }); fakeResources(runtime);
    const tail = deferred();
    vi.spyOn(runtime, 'startTurn')
      .mockReturnValueOnce({ events: { async *[Symbol.asyncIterator]() { await tail.promise; } }, result: Promise.resolve({ status: 'cancelled' }), cancel: vi.fn().mockResolvedValue(undefined) })
      .mockReturnValueOnce({ events: { async *[Symbol.asyncIterator]() {} }, result: Promise.resolve({ status: 'completed' }), cancel: vi.fn().mockResolvedValue(undefined) });
    await expect(adapter.send('first')).rejects.toMatchObject({ name: 'AgentIdleTimeoutError' });
    let outcome: unknown = 'pending';
    const second = adapter.send('second').then(() => { outcome = 'completed'; }, error => { outcome = error; });
    await new Promise(resolve => setImmediate(resolve));
    const whileWaiting = outcome; const submissionsWhileWaiting = runtime.startTurn.mock.calls.length;
    // A short resource operation must still run while this public send waits.
    let resumed = false; const resume = adapter.resume().then(() => { resumed = true; });
    await new Promise(resolve => setImmediate(resolve)); const resumedWhileWaiting = resumed;
    tail.resolve(); await Promise.all([second, resume]);
    expect(whileWaiting).toBe('pending'); expect(submissionsWhileWaiting).toBe(1); expect(resumedWhileWaiting).toBe(true);
    expect(outcome).toBe('completed');
    expect(runtime.startTurn.mock.calls.map(([input]: any[]) => input.text)).toEqual(['first', 'second']);
  });

  it('revokes a sequential prompt waiting for a timed-out stream without resubmission', async () => {
    const { adapter, runtime } = await setup({ timeout: 0.02 }); fakeResources(runtime);
    const tail = deferred();
    vi.spyOn(runtime, 'startTurn').mockReturnValue({ events: { async *[Symbol.asyncIterator]() { await tail.promise; } }, result: Promise.resolve({ status: 'cancelled' }), cancel: vi.fn().mockResolvedValue(undefined) });
    await expect(adapter.send('first')).rejects.toMatchObject({ name: 'AgentIdleTimeoutError' });
    const second = adapter.send('second').catch(error => error);
    await new Promise(resolve => setImmediate(resolve));
    const stopping = adapter.stop();
    const outcome = await Promise.race([second, new Promise(resolve => setImmediate(() => resolve('pending')))]);
    tail.resolve(); await stopping;
    expect(outcome).toMatchObject({ message: expect.stringMatching(/stopped/i) });
    expect(runtime.startTurn).toHaveBeenCalledTimes(1);
  });

  it('still rejects genuinely overlapping public sends', async () => {
    const { adapter, runtime } = await setup(); fakeResources(runtime);
    const tail = deferred(); const entered = deferred();
    vi.spyOn(runtime, 'startTurn').mockReturnValue({ events: { async *[Symbol.asyncIterator]() { entered.resolve(); await tail.promise; } }, result: Promise.resolve({ status: 'completed' }), cancel: vi.fn().mockResolvedValue(undefined) });
    const first = adapter.send('first'); await entered.promise;
    await expect(adapter.send('concurrent')).rejects.toThrow(/already in progress/i);
    tail.resolve(); await first; expect(runtime.startTurn).toHaveBeenCalledTimes(1);
  });

  it.each(['close', 'cancel'] as const)('reports known %s failure while a configuration RPC remains pending', async operation => {
    const { adapter, runtime } = await setup({ env: { MOCK_VENDOR_TOKEN: 'secret' } }); fakeResources(runtime); await adapter.start();
    const envFile = (adapter as any).launch.sessionOptions.env.dutydeck_agent_env_file;
    const rpc = deferred<any>(); const entered = deferred();
    vi.spyOn(runtime, 'getStatus').mockImplementation(() => { entered.resolve(); return rpc.promise; });
    const setting = adapter.setModel('late').catch(error => error); await entered.promise;
    if (operation === 'close') runtime.close.mockRejectedValue(new Error('known close failure'));
    else (adapter as any).turn = { cancel: vi.fn().mockRejectedValue(new Error('known cancel failure')) };
    let outcome: unknown = 'pending';
    const stopping = adapter.stop().then(() => { outcome = 'success'; }, error => { outcome = error; });
    await new Promise(resolve => setImmediate(resolve)); const beforeRpcRelease = outcome;
    expect(existsSync(envFile)).toBe(true);
    rpc.resolve(undefined); await Promise.all([setting, stopping]);
    expect(beforeRpcRelease).toMatchObject({ message: expect.stringContaining(`known ${operation} failure`) });
    await expect.poll(() => runtime.close.mock.calls.length).toBe(2);
    expect(existsSync(envFile)).toBe(true);
    await expect(adapter.send('no revival')).rejects.toThrow(/stopped/i);
  });

  it('submits one real sequential prompt after a timed-out native turn finishes cancelling', async () => {
    const { adapter, cwd } = await setup({ env: { lifecycle_cancel_gate: '1' } });
    await writeFile(join(cwd, 'release'), 'release');
    await adapter.start(); adapter.agent.timeout = 0.05;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const sending = adapter.send('wait').catch(error => error);
    // Let the real subprocess receive the prompt before triggering idle cancellation.
    await expect.poll(async () => (await readFile(join(cwd, 'calls.jsonl'), 'utf8')).includes('session/prompt')).toBe(true);
    await vi.advanceTimersByTimeAsync(50);
    await expect.poll(() => existsSync(join(cwd, 'cancelling'))).toBe(true);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await sending).toMatchObject({ name: 'AgentIdleTimeoutError' });
    vi.useRealTimers();
    adapter.agent.timeout = 10;
    let finished = false; const next = adapter.send('next').then(() => { finished = true; });
    await new Promise(resolve => setImmediate(resolve));
    const before = (await readFile(join(cwd, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(before.filter(call => call.method === 'session/prompt')).toHaveLength(1); expect(finished).toBe(false);
    await writeFile(join(cwd, 'release_cancel'), 'release'); await next; await adapter.stop();
    const after = (await readFile(join(cwd, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(after.filter(call => call.method === 'session/prompt')).toHaveLength(2);
    expect(after.filter(call => call.method === 'session/new')).toHaveLength(1);
  });

  it('still closes a late-created handle after reporting an earlier close failure', async () => {
    const { adapter, runtime } = await setup(); fakeResources(runtime); await adapter.start();
    const creating = deferred<any>(); const entered = deferred();
    runtime.ensureSession.mockImplementation(() => { entered.resolve(); return creating.promise; });
    vi.spyOn(runtime, 'startTurn').mockReturnValue({ events: { async *[Symbol.asyncIterator]() {} }, result: Promise.resolve({ status: 'failed', error: { message: 'Resource not found' } }), cancel: vi.fn().mockResolvedValue(undefined) });
    runtime.close.mockRejectedValueOnce(new Error('old close failed')).mockResolvedValue(undefined);
    await expect(adapter.send('once')).rejects.toThrow('Resource not found');
    expect(runtime.ensureSession).toHaveBeenCalledTimes(1);
    Reflect.set(adapter,'handle',undefined);
    const sending = adapter.start().catch(error => error); await entered.promise;
    await expect(adapter.stop()).rejects.toThrow('old close failed');
    const late = { sessionKey: 'late-handle' }; creating.resolve(late); await sending;
    await expect.poll(() => runtime.close.mock.calls.some(([input]: any[]) => input.handle === late)).toBe(true);
    expect(runtime.startTurn).toHaveBeenCalledTimes(1);
    await expect(adapter.start()).rejects.toThrow(/stopped/i);
  });
});

describe('approve-reads 只读判定', () => {
  const request = (toolCallId: string, toolCall: Record<string, unknown>, inferredKind?: string) => ({ ...(inferredKind ? { inferredKind } : {}), raw: { toolCall: { toolCallId, ...toolCall } } });
  const settledNow = (decision: Promise<unknown>) => Promise.race([decision, new Promise(resolve => setImmediate(() => resolve('pending')))]);

  it('只放行执行端声明为 read / search 的请求，其余照常等待审批', async () => {
    const { runtime, events } = await setup({ permissionMode: 'approve-reads' });
    expect(await settledNow(runtime.options.onPermissionRequest(request('declared_read', { kind: 'read', title: 'Read src/index.ts' }, 'read')))).toEqual({ outcome: 'allow_once' });
    expect(await settledNow(runtime.options.onPermissionRequest(request('declared_search', { kind: 'search', title: 'Grep TODO' }, 'search')))).toEqual({ outcome: 'allow_once' });
    const held = [
      // 缺 kind 时 acpx 按标题猜出 read，不算执行端声明。
      request('guessed_read', { title: 'Read and delete: config.json' }, 'read'),
      request('declared_fetch', { kind: 'fetch', title: 'Fetch https://example.com' }, 'fetch'),
      request('declared_execute', { kind: 'execute', title: 'cat README.md' }, 'execute'),
      request('declared_edit', { kind: 'edit', title: 'Write result.txt' }, 'edit'),
      request('unknown', { title: 'Check status' })
    ];
    for (const item of held) expect(await settledNow(runtime.options.onPermissionRequest(item))).toBe('pending');
    expect(events.filter(event => event.type === 'permission_request' && event.data.status === 'pending').map(event => event.data.id))
      .toEqual(['guessed_read', 'declared_fetch', 'declared_execute', 'declared_edit', 'unknown']);
  });

  it('ask 模式下声明为 read 的请求也要审批', async () => {
    const { runtime, events } = await setup({ permissionMode: 'ask' });
    expect(await settledNow(runtime.options.onPermissionRequest(request('ask_read', { kind: 'read', title: 'Read file' }, 'read')))).toBe('pending');
    expect(events).toEqual([expect.objectContaining({ type: 'permission_request', data: expect.objectContaining({ id: 'ask_read', status: 'pending' }) })]);
  });
});
