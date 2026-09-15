import { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRuntimeStore } from 'acpx/runtime';
import { AcpxAdapter } from './index.js';

const fixtures = resolve('tests/fixtures/acp-lifecycle-agent.mjs');
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const run of cleanup.splice(0).reverse()) await run(); vi.restoreAllMocks(); });
async function setup(extra: Record<string, any> = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'dutydeck-acp-proof-'));
  await writeFile(join(cwd, 'release'), 'ready');
  const adapter = new AcpxAdapter({ id: 'mock', name: 'Mock', command: process.execPath, args: [fixtures], protocol: 'acp', cwd, permissionMode: 'full-trust', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false, ...extra, env: { lifecycle_directory: cwd, ...extra.env } }, { sessionKey: 'resource-proof', onEvent() {} });
  const runtime = (adapter as any).runtime;
  const events: any[] = []; const observer = runtime.options.onProcess;
  runtime.options.onProcess = (event: any) => { events.push(event); observer?.(event); };
  cleanup.push(async () => {
    await writeFile(join(cwd, 'release'), 'ready'); await writeFile(join(cwd, 'version-release'), 'ready');
    for (const event of events) if (event.phase === 'spawned' && event.child.exitCode === null && event.child.signalCode === null) event.child.kill('SIGKILL');
    await adapter.stop().catch(() => undefined);
    await rm(cwd, { recursive: true, force: true });
  });
  return { adapter, runtime, cwd, events, children: () => events.filter(event => event.phase === 'spawned'), probe: () => (adapter as any).isStopped?.() };
}

describe('ACP physical resource proof', () => {
  it('observes real SDK spawning and proves a normal persisted stop', async () => {
    const { adapter, children, probe, cwd } = await setup();
    await adapter.start();
    expect(children()).toHaveLength(1); expect(children()[0].kind).toBe('agent');
    expect(await probe()).toBe(false);
    await adapter.stop(); expect(await probe()).toBe(true);
    expect(children()[0].child.exitCode !== null || children()[0].child.signalCode !== null).toBe(true);
    const record = await createRuntimeStore({ stateDir: join(cwd, '.dutydeck', 'acpx') }).load('resource-proof');
    expect(JSON.stringify(record)).not.toMatch(/onProcess|creation-started|ChildProcess/);
  });

  it('does not equate SDK close success with a live process having exited', async () => {
    const { adapter, runtime, children, probe } = await setup(); await adapter.start();
    const close = vi.spyOn(runtime, 'close').mockResolvedValue(undefined);
    await adapter.stop();
    expect(await probe()).toBe(false);
    const child = children()[0].child;
    close.mockRestore(); child.kill('SIGKILL');
    await expect.poll(probe).toBe(true);
  });

  it('ignores killed, error and stream close as exit evidence for a PID-bearing child', async () => {
    const { adapter, runtime, probe } = await setup();
    const child = new ChildProcess(); Object.assign(child, { pid: 999999, killed: true });
    runtime.options.onProcess({ phase: 'spawned', kind: 'agent', child });
    child.emit('error', new Error('not an exit')); child.emit('close', null, null);
    await adapter.stop(); expect(await probe()).toBe(false);
    child.emit('exit', null, 'SIGKILL'); expect(await probe()).toBe(true);
  });

  it('treats a definitive spawn failure with no PID as no remaining process', async () => {
    const { adapter, runtime, probe } = await setup();
    const child = new ChildProcess();
    runtime.options.onProcess({ phase: 'spawned', kind: 'agent', child }); child.emit('error', new Error('ENOENT'));
    await adapter.stop(); expect(await probe()).toBe(true);
  });

  it('tracks a real delayed creation until stop and native cleanup complete', async () => {
    const { adapter, cwd, children, probe } = await setup(); await rm(join(cwd, 'release'));
    const starting = adapter.start().catch(error => error);
    await expect.poll(() => existsSync(join(cwd, 'creating'))).toBe(true);
    const stopping = adapter.stop(); expect(await probe()).toBe(false);
    await writeFile(join(cwd, 'release'), 'ready'); await Promise.all([starting, stopping]);
    expect(children()).toHaveLength(1); expect(await probe()).toBe(true);
  });

  it('observes independent control clients, later turns and a new adapter instance', async () => {
    const { adapter, runtime, children, probe, cwd } = await setup(); await adapter.start();
    await runtime.close({ handle: (adapter as any).handle, reason: 'simulate disconnected idle client' });
    await adapter.setModel('model-b'); await adapter.send('third client');
    expect(children().length).toBeGreaterThanOrEqual(3);
    await adapter.stop(); expect(await probe()).toBe(true);
    const next = new AcpxAdapter({ ...adapter.agent }, { sessionKey: 'resource-proof', onEvent() {} });
    try { await next.start(); await next.send('continued'); await next.stop(); expect(await (next as any).isStopped()).toBe(true); }
    finally { await next.stop(); }
    const calls = (await readFile(join(cwd, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(calls.filter(call => call.method === 'session/new')).toHaveLength(1);
  });

  it('registers an initialization-failure child before initialize can reject', async () => {
    const { adapter, children, probe } = await setup({ env: { lifecycle_initialize_fail: '1' } });
    await expect(adapter.start()).rejects.toThrow(); await adapter.stop();
    expect(children()).toHaveLength(1); await expect.poll(probe).toBe(true);
  });

  it('includes the real host terminal as a separate managed process', async () => {
    const { adapter, children, probe } = await setup(); await adapter.start(); await adapter.send('host terminal');
    expect(children().map(event => event.kind)).toEqual(['agent', 'terminal']);
    await adapter.stop(); await expect.poll(probe).toBe(true);
    expect(children().every(event => event.child.exitCode !== null || event.child.signalCode !== null)).toBe(true);
  });

  it('keeps SDK creation pending after outer startup timeout and prevents its late spawn', async () => {
    const { adapter, runtime, cwd, events, children, probe } = await setup();
    const command = join(cwd, 'gemini');
    await writeFile(command, `#!/usr/bin/env node\nimport{existsSync,writeFileSync}from'node:fs';import{dirname,join}from'node:path';import{fileURLToPath}from'node:url';const cwd=dirname(fileURLToPath(import.meta.url));if(process.argv.includes('--version')){writeFileSync(join(cwd,'version-started'),'yes');const timer=setInterval(()=>{if(existsSync(join(cwd,'version-release'))){clearInterval(timer);console.log('0.40.0');}},10);}else{await import(${JSON.stringify(fixtures)});}`);
    await chmod(command, 0o700);
    runtime.options.agentRegistry = { resolve: () => [command, '--acp'], list: () => ['mock'] }; runtime.options.timeoutMs = 30;
    await expect(adapter.start()).rejects.toThrow(); const stopping = adapter.stop();
    expect(await probe()).toBe(false);
    await expect.poll(() => existsSync(join(cwd, 'version-started'))).toBe(true);
    expect(events.some(event => event.phase === 'creation-started')).toBe(true);
    await writeFile(join(cwd, 'version-release'), 'ready');
    await stopping;
    await expect.poll(probe).toBe(true);
    expect(children()).toHaveLength(1); expect(existsSync(join(cwd, 'calls.jsonl'))).toBe(false);
  });

  it('does not bypass an unfinished stop barrier after every process exits', async () => {
    const { adapter, runtime, probe } = await setup(); await adapter.start();
    const close = runtime.close.bind(runtime); let release!: () => void; let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }); const closed = new Promise<void>(resolve => { entered = resolve; });
    vi.spyOn(runtime, 'close').mockImplementation(async (...args: any[]) => { await close(...args); entered(); await gate; });
    const stopping = adapter.stop(); await closed;
    const before = await probe(); release(); await stopping;
    expect(before).toBe(false); expect(await probe()).toBe(true);
  });

  it('can later prove exit after stop reported an error, without changing that error', async () => {
    const { adapter, runtime, children, probe } = await setup(); await adapter.start();
    vi.spyOn(runtime, 'close').mockRejectedValue(new Error('close failed'));
    await expect(adapter.stop()).rejects.toThrow('close failed'); expect(await probe()).toBe(false);
    children()[0].child.kill('SIGKILL'); await expect.poll(probe).toBe(true);
    await expect(adapter.stop()).rejects.toThrow('close failed');
  });

  it('observes a real spawn failure without inventing an exited PID', async () => {
    const { adapter, runtime, children, probe, cwd } = await setup();
    runtime.options.agentRegistry = { resolve: () => [join(cwd, 'missing-agent')], list: () => ['mock'] };
    await expect(adapter.start()).rejects.toThrow(); await adapter.stop();
    expect(children()).toHaveLength(1); expect(children()[0].child.pid).toBeUndefined(); expect(await probe()).toBe(true);
  });

  it('tracks both the failed direct terminal spawn and its shell fallback', async () => {
    const { adapter, children, probe } = await setup(); await adapter.start(); await adapter.send('host terminal fallback');
    const terminals = children().filter(event => event.kind === 'terminal');
    expect(terminals).toHaveLength(2); expect(terminals[0].child.pid).toBeUndefined(); expect(terminals[1].child.pid).toBeTypeOf('number');
    await adapter.stop(); await expect.poll(probe).toBe(true);
  });

  it('cannot spawn a terminal fallback after the SDK terminal owner closes', async () => {
    const { adapter, runtime, children, probe } = await setup();
    const manager = await runtime.getManager(); const create = manager.createClient.bind(manager); let client: any;
    vi.spyOn(manager, 'createClient').mockImplementation((options: any) => { client = create(options); return client; });
    const observe = runtime.options.onProcess;
    runtime.options.onProcess = (event: any) => {
      observe(event);
      if (event.phase === 'spawned' && event.kind === 'terminal' && !event.child.pid) void client.terminalManager.shutdown().catch(() => undefined);
    };
    await adapter.start(); await adapter.send('host terminal fallback');
    expect(children().filter(event => event.kind === 'terminal')).toHaveLength(1);
    await adapter.stop(); expect(await probe()).toBe(true);
  });
});
