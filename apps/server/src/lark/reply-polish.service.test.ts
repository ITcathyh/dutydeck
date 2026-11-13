import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { createRepositories } from '@dutydeck/storage';
import type { AgentConfig, RepositoryBundle } from '@dutydeck/shared';
import type { AgentDriver, RuntimeOptions } from '@dutydeck/runtime';
import { startLocalServer } from '../service.js';
import { PluginStore } from '../plugins/store.js';
import type { StoredLarkConfig } from './config.js';
import { LarkReplyPolisher } from './reply-polish.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const freePort = () => new Promise<number>((resolve, reject) => {
  const server = createServer(); server.on('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (!address || typeof address === 'string') return reject(new Error('No local port'));
    server.close(error => error ? reject(error) : resolve(address.port));
  });
});

it.each(['deny', 'rewrite'] as const)('keeps task.beforeRun %s policy on the real service polishing path', async mode => {
  const root = await mkdtemp(join(tmpdir(), 'dutydeck-polish-service-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const database = join(root, 'dutydeck.db');
  createRepositories(database, { newDatabaseAuthority: 'ledger_v1' }).close();
  const source = join(root, 'plugin');
  const record = join(root, 'hook-inputs.jsonl');
  await mkdir(join(source, '.dutydeck-plugin'), { recursive: true });
  await writeFile(join(source, '.dutydeck-plugin/plugin.json'), JSON.stringify({ name: 'polish-policy', providers: 'index.mjs' }));
  const output = mode === 'deny' ? { decision: 'deny', reason: 'POLISH_DENIED' } : { updatedPrompt: 'UNTRUSTED_REWRITE_CANARY', additionalContext: 'UNTRUSTED_CONTEXT_CANARY' };
  await writeFile(join(source, 'index.mjs'), `import { appendFileSync } from 'node:fs';
export default api => api.registerHookHandler('task.beforeRun', input => {
  appendFileSync(${JSON.stringify(record)}, JSON.stringify(input) + String.fromCharCode(10));
  return ${JSON.stringify(output)};
});`);
  await new PluginStore(root).install(source, { yes: true });
  const server = await startLocalServer({ webRoot: root, env: {
    ...process.env, HOME: root, NODE_ENV: 'test', DUTYDECK_HOST: '127.0.0.1', DUTYDECK_PORT: String(await freePort()),
    DUTYDECK_DEFAULT_CWD: root, DUTYDECK_DATABASE_URL: database, DUTYDECK_DAEMON_DIR: join(root, 'daemon'),
    DUTYDECK_AUTH: 'false', DUTYDECK_DISABLE_LARK_LISTENER: 'true',
    DUTYDECK_AGENTS_JSON: JSON.stringify([{ id: 'editor', name: 'Editor', command: process.execPath, protocol: 'acp' }])
  } });
  cleanups.push(() => server.close());
  const internals = server.runtime as unknown as { options: RuntimeOptions; repos: RepositoryBundle; factory: NonNullable<RuntimeOptions['driverFactory']> };
  const starts: AgentConfig[] = [];
  const send = vi.fn();
  internals.options.probe = () => ({ protocol: 'acp', available: true, pause: false, resume: true });
  internals.factory = (agent, _protocol, emit) => {
    starts.push(agent);
    let stopped = false;
    return { start: async () => {}, resume: async () => {}, stop: async () => { stopped = true; }, isStopped: () => stopped, interrupt: async () => {},
      send: async prompt => {
        const text = typeof prompt === 'string' ? prompt : prompt.prompt;
        send(text);
        emit({ type: 'text', data: { text: JSON.stringify({ text: '本次结果尚未验证。' }) } });
        emit({ type: 'completed', data: { stopReason: 'end_turn' } });
      }
    } satisfies AgentDriver;
  };
  const polisher = new LarkReplyPolisher({ runtime: server.runtime, repos: internals.repos });
  const original = '值得注意的是，本次结果尚未验证。';
  const config = { appId: 'cli_polish', replyPolishEnabled: true, replyPolishAgentId: 'editor', replyPolishTimeoutMs: 10000 } as StoredLarkConfig;
  const stop = vi.spyOn(server.runtime, 'stop');
  const result = await polisher.polish(config, original, mode, 'oc_chat');
  const hookInputs = (await readFile(record, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  expect(hookInputs).toHaveLength(1);
  expect(hookInputs[0]).toMatchObject({ event: 'task.beforeRun', botAppId: 'cli_polish', payload: { source: 'lark-reply-polish', skills: [] } });
  if (mode === 'deny') {
    expect(result).toBe(original);
    expect(send).not.toHaveBeenCalled();
  } else {
    expect(send).toHaveBeenCalledOnce();
    expect(result).toBe('本次结果尚未验证。');
    expect(send.mock.calls[0]![0]).toContain(original);
    expect(send.mock.calls[0]![0]).not.toMatch(/UNTRUSTED_(?:REWRITE|CONTEXT)_CANARY/);
  }
  expect(stop).toHaveBeenCalledOnce();
  await expect(stop.mock.results[0]!.value).resolves.toBeUndefined();
  for (const agent of starts) {
    expect(agent.env).not.toHaveProperty('dutydeck_group_tools_token');
    expect(agent.env).not.toHaveProperty('dutydeck_relay_token');
  }
}, 30_000);
