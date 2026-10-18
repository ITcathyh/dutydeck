import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { PublicTaskRecord, Session } from '@dutydeck/shared';
import { PluginHost } from './host.js';
import { createTriggerDispatcher, PLUGIN_TRIGGER_SOURCE } from './integration.js';
import { PluginStore } from './store.js';
import { PluginTriggerService } from './triggers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function harness(scope: string, workspace?: string, reusedCwd?: string | null) {
  const directory = await mkdtemp(join(tmpdir(), 'dutydeck-trigger-scope-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'plugin'), dataDir = join(directory, 'data');
  await mkdir(join(root, '.dutydeck-plugin'), { recursive: true });
  await mkdir(join(root, 'triggers'));
  await writeFile(join(root, '.dutydeck-plugin/plugin.json'), JSON.stringify({ name: 'scoped' }));
  await writeFile(join(root, 'triggers', 'ping.json'), JSON.stringify({ auth: { type: 'token' }, target: { botAppId: 'cli_a', chatId: 'oc_b', session: 'reuse' }, prompt: '{{payload}}' }));
  const store = new PluginStore(dataDir);
  await store.install(root, { yes: true, scope });
  const { token } = await store.ensureTriggerToken('scoped', 'ping');
  const host = await PluginHost.load({ dataDir, builtinRoot: join(directory, 'empty') });
  expect(host.diagnostics).toEqual([]);
  const runtime = {
    listSessions: vi.fn(async () => reusedCwd === undefined ? [] : [{ id: 'existing', cwd: reusedCwd ?? undefined, source: PLUGIN_TRIGGER_SOURCE, sourceId: 'cli_a:oc_b:plugin:scoped:ping', state: 'idle', updatedAt: '2026-01-01' }] as Session[]),
    start: vi.fn(async () => ({ id: 'new', cwd: workspace }) as Session),
    dispatch: vi.fn(async () => ({ id: 'task' }) as PublicTaskRecord)
  };
  const triggers = new PluginTriggerService({ lookup: (plugin, id) => host.trigger(plugin, id), token: (plugin, id) => host.triggerToken(plugin, id),
    deliver: createTriggerDispatcher({ runtime, readBot: async () => ({ appId: 'cli_a', workspace }), fallbackAgentId: () => 'mock' }) });
  const receive = () => triggers.receive({ plugin: 'scoped', triggerId: 'ping', rawBody: Buffer.from('{"scope":"global"}'), headers: { 'x-dutydeck-token': token } });
  return { runtime, triggers, receive };
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
