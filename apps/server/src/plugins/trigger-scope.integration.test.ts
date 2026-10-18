import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { PublicTaskRecord, Session } from '@dutydeck/shared';
import { DutydeckRuntime } from '@dutydeck/runtime';
import { createRepositories } from '@dutydeck/storage';
import { PluginHost } from './host.js';
import { createTriggerDispatcher, PLUGIN_TRIGGER_SOURCE } from './integration.js';
import { PluginStore } from './store.js';
import { PluginTriggerService } from './triggers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function harness(scope: string, workspace?: string, reusedCwd?: string | null, useRuntime = false) {
  const directory = await mkdtemp(join(tmpdir(), 'dutydeck-trigger-scope-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const path = (value: string) => join(directory, value);
  for (const value of ['/allowed/child', '/allowed-sibling', '/outside']) await mkdir(path(value), { recursive: true });
  await symlink(path('/outside'), path('/allowed/escape'));
  await symlink(path('/allowed'), path('/scope-alias'));
  await symlink(path('/allowed/child'), path('/target-alias'));
  await symlink(path('/missing'), path('/allowed/broken'));
  if (scope.startsWith('workspace:')) scope = `workspace:${path(scope.slice('workspace:'.length))}`;
  workspace = workspace ? path(workspace) : undefined;
  reusedCwd = reusedCwd ? path(reusedCwd) : reusedCwd;
  const root = join(directory, 'plugin'), dataDir = join(directory, 'data');
  await mkdir(join(root, '.dutydeck-plugin'), { recursive: true });
  await mkdir(join(root, 'triggers'));
  await writeFile(join(root, '.dutydeck-plugin/plugin.json'), JSON.stringify({ name: 'scoped' }));
  await writeFile(join(root, 'triggers', 'ping.json'), JSON.stringify({ auth: { type: 'token' }, target: { botAppId: 'cli_a', chatId: 'oc_b', session: reusedCwd === undefined ? 'new' : 'reuse' }, prompt: '{{payload}}' }));
  const store = new PluginStore(dataDir);
  await store.install(root, { yes: true, scope });
  const { token } = await store.ensureTriggerToken('scoped', 'ping');
  const host = await PluginHost.load({ dataDir, builtinRoot: join(directory, 'empty') });
  expect(host.diagnostics).toEqual([]);
  const fakeRuntime = {
    listSessions: vi.fn(async () => reusedCwd === undefined ? [] : [{ id: 'existing', cwd: reusedCwd ?? undefined, source: PLUGIN_TRIGGER_SOURCE, sourceId: 'cli_a:oc_b:plugin:scoped:ping', state: 'idle', updatedAt: '2026-01-01' }] as Session[]),
    start: vi.fn(async () => ({ id: 'new', cwd: workspace }) as Session),
    dispatch: vi.fn(async () => ({ id: 'task' }) as PublicTaskRecord)
  };
  const driverStart = vi.fn<(cwd: string | undefined) => void>();
  const driverSend = vi.fn<(prompt: string) => void>();
  let runtime: Pick<DutydeckRuntime, 'start' | 'dispatch' | 'listSessions'> = fakeRuntime;
  if (useRuntime) {
    const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' });
    const actual = new DutydeckRuntime(repos, {
      workspaceRoot: path('/workspaces'), driverIdleTimeoutMs: 0,
      probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }),
      driverFactory: (agent, _protocol, emit) => ({
        start: async () => { driverStart(agent.cwd); },
        send: async prompt => { driverSend(prompt); emit({ type: 'completed', data: { stopReason: 'end_turn' } }); },
        interrupt: async () => {}, resume: async () => {}, stop: async () => {}, isStopped: async () => true
      })
    });
    cleanups.push(async () => { await actual.shutdown(); repos.close(); });
    await actual.initialize([{ id: 'mock', name: 'Mock', command: process.execPath, args: [], protocol: 'acp', cwd: directory, env: {}, permissionMode: 'ask', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false }]);
    if (reusedCwd) {
      await actual.start({ agentId: 'mock', cwd: reusedCwd, source: PLUGIN_TRIGGER_SOURCE, sourceId: 'cli_a:oc_b:plugin:scoped:ping' });
      driverStart.mockClear();
    }
    runtime = actual;
  }
  vi.spyOn(runtime, 'start');
  vi.spyOn(runtime, 'dispatch');
  const triggers = new PluginTriggerService({ lookup: (plugin, id) => host.trigger(plugin, id), token: (plugin, id) => host.triggerToken(plugin, id),
    deliver: createTriggerDispatcher({ runtime, readBot: async () => ({ appId: 'cli_a', workspace }), fallbackAgentId: () => 'mock' }) });
  const receive = () => triggers.receive({ plugin: 'scoped', triggerId: 'ping', rawBody: Buffer.from('{"scope":"global"}'), headers: { 'x-dutydeck-token': token } });
  return { runtime, triggers, receive, driverStart, driverSend, path };
}

it.each(['/outside', '/allowed-sibling', undefined])('rejects a workspace trigger targeting %s before creating or dispatching a session', async workspace => {
  const h = await harness('workspace:/allowed', workspace);
  expect((await h.receive()).statusCode).toBe(502);
  expect(h.runtime.start).not.toHaveBeenCalled(); expect(h.runtime.dispatch).not.toHaveBeenCalled();
  expect(h.triggers.inFlightCount('scoped', 'ping')).toBe(0);
});

it.each(['/outside', '/allowed-sibling', null])('rejects a reused session with cwd %s even when the bot workspace is allowed', async cwd => {
  const h = await harness('workspace:/allowed', '/allowed', cwd);
  expect((await h.receive()).statusCode).toBe(502);
  expect(h.runtime.start).not.toHaveBeenCalled(); expect(h.runtime.dispatch).not.toHaveBeenCalled();
});

it.each(['/allowed', '/allowed/child'])('allows creating and reusing sessions inside %s', async cwd => {
  for (const reuse of [false, true]) {
    const h = await harness('workspace:/allowed', cwd, reuse ? cwd : undefined);
    expect((await h.receive()).statusCode).toBe(202);
    expect(h.runtime.start).toHaveBeenCalledTimes(reuse ? 0 : 1);
    expect(h.runtime.dispatch).toHaveBeenCalledWith(reuse ? 'existing' : 'new', expect.any(String), 'queue', expect.any(String), undefined, 'installation_owner', expect.any(String));
  }
});

it.each(['global', 'bot:cli_a'])('preserves %s triggers without a configured bot workspace', async scope => {
  const h = await harness(scope);
  expect((await h.receive()).statusCode).toBe(202);
  expect(h.runtime.start).toHaveBeenCalledOnce(); expect(h.runtime.dispatch).toHaveBeenCalledOnce();
});

it('rejects a trigger targeting a different bot scope', async () => {
  const h = await harness('bot:cli_other', '/allowed');
  expect((await h.receive()).statusCode).toBe(404);
  expect(h.runtime.start).not.toHaveBeenCalled(); expect(h.runtime.dispatch).not.toHaveBeenCalled();
});


it.each([false, true])('rejects a symlink escape before Agent startup or dispatch (reuse=%s)', async reuse => {
  const h = await harness('workspace:/allowed', '/allowed/escape', reuse ? '/allowed/escape' : undefined, true);
  expect((await h.receive()).statusCode).toBe(502);
  expect(h.runtime.start).not.toHaveBeenCalled();
  expect(h.runtime.dispatch).not.toHaveBeenCalled();
  expect(h.driverStart).not.toHaveBeenCalled();
  expect(h.driverSend).not.toHaveBeenCalled();
  expect(h.triggers.inFlightCount('scoped', 'ping')).toBe(0);
  if (!reuse) expect(await h.runtime.listSessions()).toEqual([]);
});

it('rejects reuse when the persisted cwd has become a symlink outside the scope', async () => {
  const h = await harness('workspace:/allowed', '/allowed', '/allowed/child', true);
  await rm(h.path('/allowed/child'), { recursive: true });
  await symlink(h.path('/outside'), h.path('/allowed/child'));
  expect((await h.receive()).statusCode).toBe(502);
  expect(h.runtime.start).not.toHaveBeenCalled();
  expect(h.runtime.dispatch).not.toHaveBeenCalled();
  expect(h.driverStart).not.toHaveBeenCalled();
  expect(h.driverSend).not.toHaveBeenCalled();
});

it.each([
  ['workspace:/allowed', '/allowed'],
  ['workspace:/allowed', '/allowed/child'],
  ['workspace:/allowed', '/target-alias'],
  ['workspace:/scope-alias', '/allowed/child'],
  ['workspace:/scope-alias', '/target-alias']
])('runs inside the real scope for %s and %s, then reuses the session', async (scope, cwd) => {
  const h = await harness(scope, cwd, undefined, true);
  const first = await h.receive();
  expect(first.statusCode).toBe(202);
  const expectedCwd = await realpath(h.path(cwd));
  expect(h.runtime.start).toHaveBeenCalledWith(expect.objectContaining({ cwd: expectedCwd }));
  expect(h.driverStart).toHaveBeenCalledExactlyOnceWith(expectedCwd);
  expect((await h.runtime.listSessions())[0]?.cwd).toBe(expectedCwd);
  await vi.waitFor(() => expect(h.driverSend).toHaveBeenCalledOnce());
  // Exercise the persisted session's reuse path with a new key, even after the bot workspace changes.
  const deliver = createTriggerDispatcher({ runtime: h.runtime, readBot: async () => ({ appId: 'cli_a', workspace: h.path('/outside') }), fallbackAgentId: () => 'mock' });
  const reused = await deliver({ scope: `workspace:${h.path(scope.slice('workspace:'.length))}`, plugin: 'scoped', triggerId: 'ping', target: { botAppId: 'cli_a', chatId: 'oc_b', session: 'reuse' }, prompt: 'again', key: 'again' });
  expect(reused.sessionId).toBe(first.body.sessionId);
  expect(h.runtime.start).toHaveBeenCalledOnce();
  expect(h.runtime.dispatch).toHaveBeenCalledTimes(2);
  await vi.waitFor(() => expect(h.driverSend).toHaveBeenCalledTimes(2));
});

it.each([
  ['workspace:/missing', '/allowed'],
  ['workspace:/allowed', '/missing'],
  ['workspace:/allowed', '/allowed/broken']
])('fails closed when %s or %s cannot be resolved', async (scope, cwd) => {
  const h = await harness(scope, cwd, undefined, true);
  expect((await h.receive()).statusCode).toBe(502);
  expect(h.runtime.start).not.toHaveBeenCalled();
  expect(h.runtime.dispatch).not.toHaveBeenCalled();
  expect(h.driverStart).not.toHaveBeenCalled();
  expect(h.driverSend).not.toHaveBeenCalled();
});
