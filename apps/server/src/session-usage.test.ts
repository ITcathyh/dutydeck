import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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

it('reads bound Claude-family PTY transcripts from frozen roots, isolates sessions and leaves the ledger unchanged', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dutydeck-usage-claude-')); dirs.push(cwd);
  const root = join(cwd, 'frozen-account'); await mkdir(root);
  const repos = createRepositories(':memory:'); const app = Fastify();
  const ledger = new UsageLedger({ repositories: repos });
  registerUsageRoutes(app, { ledger, snapshot: id => sessionUsageSnapshot(repos, id), authorize: () => false }, async () => {});
  const source = (sessionId: string, nativeSessionId: string, path: string) => ({ observationId: `source-${sessionId}`, sessionId, activeRunId: `run-${sessionId}`, driverInstanceId: 'driver', client: 'claude' as const, launchKind: 'created' as const, proofKind: 'launch_observed' as const, capturedAt: '2026-10-13T08:00:00Z', dataRoot: root, cwd, nativeSessionId, verifiedPath: path, identityProof: 'content_verified', streamIdentity: { kind: 'main' as const, nativeAgentId: null } });
  try {
    await repos.agents.save({ id: 'ccflash', adapterId: 'claude-code', name: 'Claude', command: 'claude', args: [], protocol: 'pty-cli', env: { CLAUDE_CONFIG_DIR: join(cwd, 'new-account') }, permissionMode: 'deny-all', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false });
    for (const id of ['one', 'two', 'unbound']) await repos.sessions.save({ id, runId: `run-${id}`, agentId: 'ccflash', protocol: 'pty-cli', cwd, state: 'thinking', createdAt: '2026-10-13T00:00:00Z', updatedAt: '2026-10-13T00:00:00Z' });
    const fixture = await readFile(new URL('../../../packages/pty-driver/src/transcript/fixtures/usage-claude-2.1.295.jsonl', import.meta.url), 'utf8');
    const one = join(root, 'one.jsonl'); const two = join(root, 'two.jsonl');
    await writeFile(one, fixture.replaceAll('/workspace/usage', cwd));
    await writeFile(two, fixture.replaceAll('/workspace/usage', cwd).replaceAll('native-claude', 'native-two').replaceAll('115780', '100'));
    const sources = vi.spyOn(repos.insight, 'listSources').mockImplementation(id => id === 'one' ? [source(id, 'native-claude', one)] : id === 'two' ? [source(id, 'native-two', two)] : []);
    const result = (await app.inject('/api/sessions/one/usage')).json();
    expect(result.snapshot).toMatchObject({ context: { used: 116348, source: 'claude_transcript' }, nativeTokens: { totalTokens: 117160, scope: 'current_native_session' } });
    expect(result.snapshot.context.size).toBeUndefined(); expect(result.snapshot.rateLimits).toBeUndefined();
    expect(result.own.entries).toBe(0); expect(result.subSteps.entries).toBe(0);
    expect((await app.inject('/api/sessions/two/usage')).json().snapshot.nativeTokens.totalTokens).toBe(1480);
    expect(await sessionUsageSnapshot(repos, 'unbound')).toEqual({});
    // Querying snapshots again never backfills historical pricing/ledger rows.
    expect((await app.inject('/api/sessions/one/usage')).json().snapshot.nativeTokens.totalTokens).toBe(117160);
    expect((await ledger.sessionUsage('one')).own.entries).toBe(0);
    sources.mockReturnValue([source('one', 'native-two', one)]);
    expect(await sessionUsageSnapshot(repos, 'one')).toEqual({});
    sources.mockReturnValue([{ ...source('one', 'native-claude', one), verifiedPath: join(root, 'missing') }]);
    expect(await sessionUsageSnapshot(repos, 'one')).toEqual({ error: '原生会话用量读取失败' });
  } finally { await app.close(); repos.close(); }
});

it('selects the current driver source during a rollover and refuses ambiguous historical contexts', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dutydeck-usage-rollover-')); dirs.push(cwd);
  const repos = createRepositories(':memory:');
  try {
    await repos.agents.save({ id: 'seed', adapterId: 'seed', name: 'Seed', command: 'claude', args: [], protocol: 'pty-cli', env: {}, permissionMode: 'deny-all', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false });
    await repos.sessions.save({ id: 'one', runId: 'new-run', agentId: 'seed', protocol: 'pty-cli', cwd, state: 'thinking', createdAt: '2026-10-13T00:00:00Z', updatedAt: '2026-10-13T00:00:00Z' });
    const file = join(cwd, 'new.jsonl'); await writeFile(file, JSON.stringify({ type: 'user', sessionId: 'native-new', cwd }) + '\n' + JSON.stringify({ type: 'assistant', sessionId: 'native-new', timestamp: '2026-10-13T08:00:00Z', message: { id: 'new', usage: { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }) + '\n');
    const make = (id: string, run: string, driver: string) => ({ observationId: id, sessionId: 'one', activeRunId: run, driverInstanceId: driver, client: 'claude' as const, launchKind: 'created' as const, proofKind: 'launch_observed' as const, capturedAt: '2026-10-13T08:00:00Z', dataRoot: cwd, cwd, nativeSessionId: `native-${id}`, verifiedPath: file, streamIdentity: { kind: 'main' as const, nativeAgentId: null } });
    const sources = vi.spyOn(repos.insight, 'listSources').mockReturnValue([make('old', 'old-run', 'old-driver'), make('new', 'new-run', 'new-driver')]);
    vi.spyOn(repos.execution, 'getResources').mockReturnValue([{ runId: 'new-run', stage: 'created', kind: 'local_only', resourceId: 'new-driver', identity: { identityId: 'identity' } }] as any);
    expect((await sessionUsageSnapshot(repos, 'one')).nativeTokens?.totalTokens).toBe(3);
    sources.mockReturnValue([make('old', 'old-run', 'old-driver')]);
    expect(await sessionUsageSnapshot(repos, 'one')).toEqual({});
    vi.mocked(repos.execution.getResources).mockReturnValue([]);
    sources.mockReturnValue([make('old', 'old-run', 'old-driver'), make('new', 'old-run', 'other-driver')]);
    expect(await sessionUsageSnapshot(repos, 'one')).toEqual({});
  } finally { repos.close(); }
});

it('reads the exact built-in ACP Claude shape with a real ACPX native-session record', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dutydeck-usage-acp-claude-')); dirs.push(cwd);
  const root = join(cwd, 'claude-home'); const project = join(root, 'projects', cwd.replace(/[^A-Za-z0-9-]/g, '-')); await mkdir(project, { recursive: true });
  const repos = createRepositories(':memory:');
  try {
    const agent = { id: 'claude', name: 'Claude', command: 'claude-acp', args: [], protocol: 'acp' as const, env: { CLAUDE_CONFIG_DIR: root }, permissionMode: 'deny-all' as const, timeout: 10, capabilities: { pause: false, resume: true }, builtin: true };
    await repos.agents.save(agent);
    await repos.sessions.save({ id: 'acp-bound', runId: 'run-bound', agentId: agent.id, protocol: 'acp', cwd, state: 'completed', createdAt: '2026-10-13T00:00:00Z', updatedAt: '2026-10-13T00:00:00Z' });
    const adapter = new AcpxAdapter({ ...agent, command: process.execPath, args: [resolve(process.cwd(), 'tests/fixtures/mock-acp-agent.mjs')], cwd }, { sessionKey: 'acp-bound', onEvent: () => {} });
    await adapter.start(); await adapter.stop();
    const store = createRuntimeStore({ stateDir: join(cwd, '.dutydeck', 'acpx') }); const record = (await store.load('acp-bound'))!;
    // ACP backend IDs are not CLI session IDs for Claude.
    record.acpSessionId = 'different-backend-id'; record.agentSessionId = 'native-claude'; await store.save(record);
    const fixture = await readFile(new URL('../../../packages/pty-driver/src/transcript/fixtures/usage-claude-2.1.295.jsonl', import.meta.url), 'utf8');
    await writeFile(join(project, 'native-claude.jsonl'), fixture.replaceAll('/workspace/usage', cwd));
    expect(await sessionUsageSnapshot(repos, 'acp-bound')).toMatchObject({ nativeTokens: { source: 'claude_transcript', totalTokens: 117160 }, context: { used: 116348 } });
    record.agentSessionId = undefined; await store.save(record);
    expect(await sessionUsageSnapshot(repos, 'acp-bound')).toEqual({});
  } finally { repos.close(); }
});
