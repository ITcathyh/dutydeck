import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createRuntimeStore } from 'acpx/runtime';
import { AcpxAdapter } from '@dutydeck/acp-client';
import { createRepositories } from '@dutydeck/storage';
import { sessionUsageSnapshot } from './session-usage.js';
import { UsageLedger } from './usage-ledger.js';
import { registerUsageRoutes } from './usage-routes.js';
import Fastify from 'fastify';
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
it('recovers context and independent quotas behind long history and isolates session routes', async () => {
  const repos = createRepositories(':memory:'); const app = Fastify();
  registerUsageRoutes(app, { ledger: new UsageLedger({ repositories: repos }), snapshot: id => sessionUsageSnapshot(repos, id), authorize: () => false }, async () => {});
  try {
    await repos.events.append({ id: 'context', sessionId: 'one', sequence: 1, type: 'status', timestamp: '2026-10-02T00:00:00Z', data: { state: 'usage', used: 100, size: 1000, rateLimits: { fiveHour: { usedPercent: 0, resetsAt: 1791000000 } } } });
    await repos.events.append({ id: 'quota', sessionId: 'one', sequence: 2, type: 'status', timestamp: '2026-10-02T01:00:00Z', data: { state: 'usage', rateLimits: { sevenDay: { usedPercent: 25, resetsAt: 1791000000 } } } });
    for (let i = 3; i <= 800; i++) await repos.events.append({ id: `other-${i}`, sessionId: 'one', sequence: i, type: 'text', timestamp: '2026-10-02T02:00:00Z', data: { text: 'filler' } });
    const one = (await app.inject('/api/sessions/one/usage')).json();
    expect(one.snapshot).toMatchObject({ context: { used: 100, size: 1000 }, rateLimits: { fiveHour: { usedPercent: 0 }, sevenDay: { usedPercent: 25 } } });
    expect((await repos.events.listLatestUsage!('one')).length).toBeLessThanOrEqual(3);
    expect((await app.inject('/api/sessions/two/usage')).json().snapshot).toEqual({});
    await repos.events.append({ id: 'invalid', sessionId: 'two', sequence: 1, type: 'status', timestamp: '2026-10-02T00:00:00Z', data: { state: 'usage', used: -1, rateLimits: { fiveHour: { usedPercent: 101, resetsAt: 1 } }, breakdown: { totalTokens: 999999 } } });
    expect(await sessionUsageSnapshot(repos, 'two')).toEqual({});
  } finally { await app.close(); repos.close(); }
});
it('reads Codex native data from the bound ACPX session and agent home, never a newer unrelated file', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dutydeck-usage-native-')); dirs.push(cwd);
  const customHome = join(cwd, 'custom-codex'); const dir = join(customHome, 'sessions', '2026', '10', '02'); await mkdir(dir, { recursive: true });
  const repos = createRepositories(':memory:');
  try {
    await repos.agents.save({ id: 'codex', name: 'Codex', command: 'codex-acp', args: [], protocol: 'acp', env: { CODEX_HOME: customHome }, permissionMode: 'deny-all', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false });
    await repos.sessions.save({ id: 'bound', runId: 'run_bound', agentId: 'codex', cwd, state: 'completed', createdAt: '2026-10-02T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z' });
    const store = createRuntimeStore({ stateDir: join(cwd, '.dutydeck', 'acpx') });
    const adapter = new AcpxAdapter({ ...(await repos.agents.get('codex'))!, command: process.execPath, args: [resolve(process.cwd(), 'tests/fixtures/mock-acp-agent.mjs')], cwd }, { sessionKey: 'bound', onEvent: () => {} });
    await adapter.start(); await adapter.stop();
    const record = (await store.load('bound'))!;
    record.acpSessionId = 'native-bound'; record.agentSessionId = 'native-bound'; await store.save(record);
    const entries = [{ type: 'session_meta', payload: { id: 'native-bound', cwd } }, { type: 'event_msg', timestamp: '2026-10-02T01:00:00Z', payload: { type: 'token_count', info: { model_context_window: 10000, last_token_usage: { total_tokens: 400 }, total_token_usage: { total_tokens: 999999 } }, rate_limits: { primary: { window_minutes: 10080, used_percent: 0, resets_at: 1791000000 }, secondary: null } } }];
    await writeFile(join(dir, 'rollout-old-native-bound.jsonl'), entries.map(e => JSON.stringify(e)).join('\n') + '\n');
    await writeFile(join(dir, 'rollout-new-unrelated.jsonl'), JSON.stringify({ type: 'session_meta', payload: { id: 'unrelated', cwd } }) + '\n');
    expect(await sessionUsageSnapshot(repos, 'bound')).toMatchObject({ context: { used: 400, size: 10000 }, rateLimits: { sevenDay: { usedPercent: 0 } } });
    expect((await sessionUsageSnapshot(repos, 'bound')).rateLimits?.fiveHour).toBeUndefined();
    await repos.sessions.save({ id: 'unbound', runId: 'run_unbound', agentId: 'codex', cwd, state: 'completed', createdAt: '2026-10-02T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z' });
    expect(await sessionUsageSnapshot(repos, 'unbound')).toEqual({});
    await repos.events.append({ id: 'old-context', sessionId: 'bound', sequence: 1, type: 'status', timestamp: '2026-10-02T00:00:00Z', data: { state: 'usage', used: 100, size: 10000 } });
    expect((await sessionUsageSnapshot(repos, 'bound')).context?.used).toBe(400);
    const native = vi.spyOn(repos.execution, 'getNativeContext');
    const locator = { nativeCreationId: 'creation', sessionKey: 'bound', agent: 'codex', command: ['codex-acp'], cwd, executionDomain: 'test', acpxRecordId: 'record', backendSessionId: 'native-bound', defaults: {} };
    native.mockReturnValue({ resource: { purpose: 'acp_native_context', identity: { locator } } } as any);
    expect((await sessionUsageSnapshot(repos, 'bound')).context?.used).toBe(400);
    native.mockReturnValue({ resource: { purpose: 'acp_native_context', identity: { locator: { ...locator, agent: 'other-agent' } } } } as any);
    expect((await sessionUsageSnapshot(repos, 'bound')).context?.used).toBe(100);
    native.mockReturnValue({ resource: { purpose: 'acp_native_context', identity: { locator: { ...locator, cwd: 'other-cwd' } } } } as any);
    expect((await sessionUsageSnapshot(repos, 'bound')).context?.used).toBe(100);
    native.mockReturnValue({ resource: { purpose: 'acp_native_context', identity: { locator: 'invalid-receipt' } } } as any);
    expect(await sessionUsageSnapshot(repos, 'bound')).toMatchObject({ error: '原生会话用量读取失败' });
    native.mockRestore();
  } finally { repos.close(); }
});
