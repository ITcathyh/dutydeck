import { afterEach, describe, expect, it, vi } from 'vitest';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { agentConfigSchema } from '@dutydeck/shared';
import { createRepositories } from '@dutydeck/storage';
import { DutydeckRuntime } from './index.js';

const releases: Array<() => Promise<void>> = [];
afterEach(async () => { for (const release of releases.splice(0).reverse()) await release(); });
async function fixture(protocol: 'acp' | 'jsonl' | 'pipe') {
  const directory = await mkdtemp(join(tmpdir(), 'runtime-native-ledger-'));
  releases.push(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'release'), 'ready');
  const agent = agentConfigSchema.parse({ id: 'native', name: 'Native fixture', protocol, command: process.execPath,
    args: [resolve(protocol === 'acp' ? 'tests/fixtures/acp-lifecycle-agent.mjs' : 'tests/fixtures/process-driver-turn-agent.mjs')],
    cwd: directory, env: protocol === 'acp' ? { lifecycle_directory: directory } : { turn_agent_submission_log: join(directory, 'sent.jsonl') },
    permissionMode: protocol === 'acp' ? 'full-trust' : 'ask', timeout: 15, capabilities: { pause: false, resume: true }
  });
  const path = join(directory, 'state.db');
  const open = async () => {
    const repos = createRepositories(path, { newDatabaseAuthority: 'ledger_v1' });
    const runtime = new DutydeckRuntime(repos, { cleanupIntervalMs: 0 });
    releases.push(async () => { await runtime.shutdown(); repos.close(); });
    await runtime.initialize([agent]); return { repos, runtime };
  };
  return { directory, agent, open };
}
describe('real native drivers behind the Runtime ledger', () => {
  it.each(['acp', 'jsonl', 'pipe'] as const)('%s retains ledger history through stop/resume, restart and Runtime reopen', async protocol => {
    const h = await fixture(protocol); const first = await h.open();
    const session = await first.runtime.start({ agentId: h.agent.id });
    expect((await first.runtime.send(session.id, 'one')).status).toBe('completed');
    await first.runtime.stop(session.id);
    expect(first.repos.execution.getSessionResourceBlockers(session.id)).toEqual([]);
    await first.runtime.resume(session.id);
    const secondTask = await first.runtime.send(session.id, 'two');
    expect(secondTask.status, JSON.stringify(first.repos.execution.getTaskExecution(secondTask.id))).toBe('completed');
    const restarted = await first.runtime.restart(session.id);
    expect(restarted.runId).not.toBe(session.runId);
    expect((await first.runtime.send(session.id, 'three')).status).toBe('completed');
    await first.runtime.shutdown();
    expect(first.repos.execution.getSessionResourceBlockers(session.id)).toEqual([]);
    first.repos.close();
    const second = await h.open();
    await second.runtime.resume(session.id);
    expect((await second.runtime.send(session.id, 'four')).status).toBe('completed');
    expect((await second.runtime.getTasks(session.id)).map(task => task.status)).toEqual(['completed', 'completed', 'completed', 'completed']);
    const events = await second.runtime.getEvents(session.id);
    expect(events.filter(event => event.type === 'completed')).toHaveLength(4);
    expect(new Set(events.filter(event => event.type === 'completed').map(event => event.attemptId)).size).toBe(4);
    if (protocol === 'acp') {
      const calls = (await readFile(join(h.directory, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { method: string });
      expect(calls.filter(call => call.method === 'session/new')).toHaveLength(1);
      expect(calls.filter(call => call.method === 'session/prompt')).toHaveLength(4);
    } else {
      const sent = (await readFile(join(h.directory, 'sent.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      expect(sent).toEqual(['one', 'two', 'three', 'four']);
    }
  });
});

function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

describe('native ledger review regressions', () => {
  it('publishes subscriber side effects only to their explicit Session', async () => {
    const h = await fixture('jsonl'); const { runtime } = await h.open();
    const a = await runtime.start({ agentId: h.agent.id }), b = await runtime.start({ agentId: h.agent.id });
    const done = gate(); let error: unknown; let target: string | undefined;
    runtime.subscribe(a.id, async event => {
      if (event.type !== 'text' || (event.data as { role?: string }).role === 'user') return;
      try { target = (await runtime.publishSessionEvent(b.id, 'text', { text: 'belongs-to-B' })).sessionId; }
      catch (failure) { error = failure; } finally { done.resolve(); }
    });
    await runtime.send(a.id, 'native output'); await done.promise;
    expect(error).toBeUndefined(); expect(target).toBe(b.id);
    expect((await runtime.getEvents(a.id)).some(event => (event.data as { text?: string }).text === 'belongs-to-B')).toBe(false);
    const event = (await runtime.getEvents(b.id)).find(event => (event.data as { text?: string }).text === 'belongs-to-B');
    expect(event).toMatchObject({ sessionId: b.id }); expect(event?.attemptId).toBeNull();
  });
  it('lets a late subscriber publish outside its settled Attempt after lifecycle replacement', async () => {
    const h = await fixture('jsonl'); const { runtime } = await h.open();
    const session = await runtime.start({ agentId: h.agent.id });
    const entered = gate(), release = gate(), done = gate(); let error: unknown;
    releases.push(async () => { release.resolve(); });
    runtime.subscribe(session.id, async event => {
      if (event.type !== 'text' || (event.data as { text?: string }).text !== 'echo:native output' || (event.data as { role?: string }).role === 'user') return;
      entered.resolve(); await release.promise;
      try { await runtime.publishSessionEvent(session.id, 'text', { text: 'late notification' }); }
      catch (failure) { error = failure; } finally { done.resolve(); }
    });
    const task = await runtime.send(session.id, 'native output'); await entered.promise;
    expect(task.status).toBe('completed'); await runtime.stop(session.id); await runtime.resume(session.id);
    release.resolve(); await done.promise; expect(error).toBeUndefined();
    const event = (await runtime.getEvents(session.id)).find(event => (event.data as { text?: string }).text === 'late notification');
    expect(event).toBeDefined(); expect(event?.attemptId).toBeNull();
  });
});

const configurationAgent = String.raw`
import readline from 'node:readline';
import { appendFileSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const dir = process.env.configuration_directory;
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const options = [
 { type: 'select', id: 'model', name: 'Model', category: 'model', currentValue: 'model-a', options: [{ value: 'model-a', name: 'A' }, { value: 'model-b', name: 'B' }] },
 { type: 'select', id: 'effort', name: 'Effort', category: 'thought_level', currentValue: 'low', options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] }
];
readline.createInterface({ input: process.stdin }).on('line', async line => {
 const { id, method, params = {} } = JSON.parse(line);
 appendFileSync(join(dir, 'calls.jsonl'), JSON.stringify({ method }) + '\n');
 if (method === 'initialize') return reply(id, { protocolVersion: params.protocolVersion, agentCapabilities: { loadSession: true }, authMethods: [] });
 if (method === 'session/new') return reply(id, { sessionId: 'configuration-native', configOptions: options });
 if (method === 'session/load') return reply(id, { configOptions: options });
 if (method === 'session/set_config_option') {
  writeFileSync(join(dir, 'selected'), JSON.stringify({ key: params.configId ?? params.key, value: params.value }));
  while (!existsSync(join(dir, 'ack'))) await new Promise(resolve => setTimeout(resolve, 5));
  return send({ jsonrpc: '2.0', id, error: { code: -32603, message: 'ACK lost after actual configuration changed' } });
 }
 if (method === 'session/prompt') {
  send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: existsSync(join(dir, 'selected')) ? readFileSync(join(dir, 'selected'), 'utf8') : 'initial' } } } });
  return reply(id, { stopReason: 'end_turn' });
 }
 if (method === 'session/cancel') return;
 if (id !== undefined) return send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Unsupported method' } });
});
`;
async function configurationFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'runtime-native-configuration-'));
  releases.push(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'agent.mjs'), configurationAgent);
  const agent = agentConfigSchema.parse({ id: 'configuration', name: 'Configuration', protocol: 'acp', command: process.execPath, args: [join(directory, 'agent.mjs')], cwd: directory,
    env: { configuration_directory: directory }, model: 'model-a', permissionMode: 'full-trust', timeout: 10, capabilities: { pause: false, resume: true } });
  const open = async () => {
    const repos = createRepositories(join(directory, 'db'), { newDatabaseAuthority: 'ledger_v1' });
    const runtime = new DutydeckRuntime(repos, { cleanupIntervalMs: 0 });
    releases.push(async () => { await runtime.shutdown(); repos.close(); });
    await runtime.initialize([agent]); return { repos, runtime };
  };
  const first = await open(); releases.push(() => writeFile(join(directory, 'ack'), 'release'));
  const session = await first.runtime.start({ agentId: agent.id });
  return { ...first, directory, session, open };
}
describe('persistent native configuration gate', () => {
  it('retains a durable pending operation after its outcome write fails, across SQLite reopen', async () => {
    const h = await configurationFixture();
    const changing = h.runtime.setModel(h.session.id, 'model-b').catch(error => error);
    try {
      await vi.waitFor(async () => { await access(join(h.directory, 'selected')); });
      h.repos.config.compareAndSet = vi.fn(h.repos.config.compareAndSet!.bind(h.repos.config)).mockResolvedValueOnce(false);
      await writeFile(join(h.directory, 'ack'), 'release'); await changing;
      const raw = await h.repos.config.get('runtime_driver_configuration:' + h.session.id);
      expect(JSON.parse(raw!).state).toBe('pending');
      await h.runtime.stop(h.session.id); await h.runtime.shutdown(); h.repos.close();
      const reopened = await h.open();
      expect(await reopened.repos.config.get('runtime_driver_configuration:' + h.session.id)).toBe(raw);
      await expect(reopened.runtime.resume(h.session.id)).rejects.toMatchObject({ code: 'DRIVER_CONFIGURATION_UNKNOWN' });
      const methods = (await readFile(join(h.directory, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => (JSON.parse(line) as { method: string }).method);
      expect(methods.filter(method => method === 'session/prompt')).toEqual([]);
      expect(methods.filter(method => method === 'session/new')).toHaveLength(1);
    } finally { await writeFile(join(h.directory, 'ack'), 'release'); await changing; }
  });
  it.each(['model', 'reasoningEffort'] as const)('blocks %s ACK pending and unknown across stop/restart/reopen without an extra native prompt', async field => {
    const h = await configurationFixture();
    const changing = (field === 'model' ? h.runtime.setModel(h.session.id, 'model-b') : h.runtime.setReasoningEffort(h.session.id, 'high')).catch(error => error);
    try {
      await vi.waitFor(async () => { await access(join(h.directory, 'selected')); });
      const task = await h.runtime.dispatch(h.session.id, 'while ACK pending');
      await vi.waitFor(() => expect(h.repos.execution.getTaskExecution(task.id)?.currentAttempt).toBeDefined());
      expect(h.repos.execution.getTaskExecution(task.id)?.currentAttempt?.submissionState).toBe('not_submitted');
      await writeFile(join(h.directory, 'ack'), 'release'); expect(await changing).toMatchObject({ code: field === 'model' ? 'MODEL_SWITCH_FAILED' : 'REASONING_SWITCH_FAILED' });
      const failed = await h.runtime.send(h.session.id, 'after lost ACK');
      expect(failed.status).toBe('failed'); expect(h.repos.execution.getTaskExecution(failed.id)?.currentAttempt?.submissionState).toBe('not_submitted');
      await h.runtime.stop(h.session.id);
      await expect(h.runtime.resume(h.session.id)).rejects.toMatchObject({ code: 'DRIVER_CONFIGURATION_UNKNOWN' });
      await expect(h.runtime.restart(h.session.id)).rejects.toMatchObject({ code: 'DRIVER_CONFIGURATION_UNKNOWN' });
      await h.runtime.shutdown(); h.repos.close();
      const reopened = await h.open();
      await expect(reopened.runtime.resume(h.session.id)).rejects.toMatchObject({ code: 'DRIVER_CONFIGURATION_UNKNOWN' });
      await expect(reopened.runtime.setModel(h.session.id, 'model-a')).rejects.toMatchObject({ code: 'DRIVER_CONFIGURATION_UNKNOWN' });
      const methods = (await readFile(join(h.directory, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => (JSON.parse(line) as { method: string }).method);
      expect(methods.filter(method => method === 'session/prompt')).toEqual([]);
      expect(methods.filter(method => method === 'session/new')).toHaveLength(1);
      expect(methods.filter(method => method === 'session/set_config_option')).toHaveLength(1);
    } finally { await writeFile(join(h.directory, 'ack'), 'release'); await changing; }
  });
});
