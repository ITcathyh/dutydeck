import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentConfigSchema, agentWeightsSchema, type Session } from '@dutydeck/shared';
import { createRepositories, type RepositoryBundle } from '@dutydeck/storage';
import { readLarkConfig, publicLarkConfig, saveLarkConfig, type StoredLarkConfig } from './config.js';
import { larkSessionConfigKey, listPersistedLarkSessions, resolveLarkSession, selectLarkAgent } from './session-resolver.js';

const weights = [{ agentId: 'codex', weight: 30 }, { agentId: 'ccflash', weight: 70 }];
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'dutydeck-weights-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const repos: RepositoryBundle = createRepositories(join(directory, 'state.sqlite'));
  cleanups.push(() => repos.close());
  for (const id of ['codex', 'ccflash']) await repos.agents.save(agentConfigSchema.parse({ id, name: id, command: process.execPath, cwd: directory, protocol: 'acp' }));
  await saveLarkConfig(repos.config, repos.agents, { appId: 'cli_test', appSecret: 'synthetic', workspace: directory, defaultAgentId: 'codex', defaultAgentWeights: weights, defaultModel: 'codex-model', defaultReasoningEffort: 'high', permissionMode: 'full-trust', fullTrustConfirmed: true });
  const config = (await readLarkConfig(repos.config, 'cli_test'))!;
  const sessions: Session[] = [];
  const runtime = {
    getSession: vi.fn(async (id: string) => sessions.find(session => session.id === id)),
    listSessions: vi.fn(async () => sessions), listAgents: vi.fn(() => repos.agents.list()), stop: vi.fn(async (id: string) => { const session = sessions.find(item => item.id === id); if (session) session.state = 'stopped'; }),
    start: vi.fn(async (input: any) => {
      const session: Session = { ...input, cwd: input.cwd, id: `session_${sessions.length}`, runId: 'run', state: 'idle', protocol: 'acp', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      sessions.push(session); return session;
    })
  };
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const resolve = (group = { tail: Promise.resolve() }, settings: StoredLarkConfig = config, options?: Parameters<typeof resolveLarkSession>[9]) => resolveLarkSession(runtime as any, log, group as any, settings, 'oc_test', 'p2p', 'p2p', repos.channelMappings, options);
  return { config, repos, runtime, resolve };
}

describe('weighted primary Agent routing', () => {
  it.each([0, 0.299999, 0.3, 0.999999])('uses the 30/70 boundary at %s', random => {
    expect(selectLarkAgent({ defaultAgentId: 'codex', defaultAgentWeights: weights } as StoredLarkConfig, () => random)).toBe(random < 0.3 ? 'codex' : 'ccflash');
  });

  it('persists, publishes, preserves and clears weights through the real config store', async () => {
    const { repos, config } = await fixture();
    expect(publicLarkConfig(config).defaultAgentWeights).toEqual(weights);
    await saveLarkConfig(repos.config, repos.agents, { originalAppId: 'cli_test', preInjectPrompt: 'updated' });
    expect((await readLarkConfig(repos.config, 'cli_test'))!.defaultAgentWeights).toEqual(weights);
    await saveLarkConfig(repos.config, repos.agents, { originalAppId: 'cli_test', defaultAgentWeights: [] });
    expect((await readLarkConfig(repos.config, 'cli_test'))!.defaultAgentWeights).toBeUndefined();
  });

  it.each([
    [{ agentId: 'codex', weight: 0 }], [{ agentId: 'codex', weight: -1 }], [{ agentId: 'codex', weight: Infinity }],
    [{ agentId: 'codex', weight: NaN }], [{ agentId: 'codex', weight: '30' }],
    [{ agentId: 'codex', weight: 1 }, { agentId: ' codex ', weight: 2 }],
    [{ agentId: 'codex', weight: Number.MAX_VALUE }, { agentId: 'ccflash', weight: Number.MAX_VALUE }]
  ])('rejects invalid weights %j', async row => {
    expect(agentWeightsSchema.safeParse(row).success).toBe(false);
    const { repos } = await fixture();
    await expect(saveLarkConfig(repos.config, repos.agents, { originalAppId: 'cli_test', defaultAgentWeights: row as any })).rejects.toMatchObject({ code: 'INVALID_LARK_CONFIG' });
  });

  it('rejects unknown or approval-incompatible candidate Agents', async () => {
    const { repos } = await fixture();
    await expect(saveLarkConfig(repos.config, repos.agents, { originalAppId: 'cli_test', defaultAgentWeights: [{ agentId: 'missing', weight: 1 }] })).rejects.toMatchObject({ code: 'INVALID_LARK_CONFIG' });
    await repos.agents.save(agentConfigSchema.parse({ id: 'terminal', name: 'terminal', command: process.execPath, protocol: 'pty-cli', adapterId: 'codex' }));
    await expect(saveLarkConfig(repos.config, repos.agents, { originalAppId: 'cli_test', permissionMode: 'ask', defaultAgentWeights: [{ agentId: 'terminal', weight: 1 }] })).rejects.toMatchObject({ code: 'LARK_APPROVAL_UNSUPPORTED' });
  });

  it('draws once, isolates model settings, and resumes the chosen Agent after weights are removed and memory bindings are lost', async () => {
    const { config, runtime, resolve } = await fixture();
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.3);
    const group = { tail: Promise.resolve() };
    const first = await resolve(group);
    expect(first.agentId).toBe('ccflash');
    expect(runtime.start.mock.calls[0]![0]).not.toHaveProperty('model');
    expect(runtime.start.mock.calls[0]![0]).not.toHaveProperty('reasoningEffort');
    const changed = { ...config, defaultAgentWeights: undefined };
    expect(larkSessionConfigKey(changed)).toBe(larkSessionConfigKey(config));
    expect(await resolve(group, changed)).toBe(first);
    expect(await resolve(undefined, changed)).toBe(first);
    expect(runtime.start).toHaveBeenCalledOnce();
    expect(random).toHaveBeenCalledOnce();
  });

  it.each([{ agentId: 'codex' }, { model: 'explicit-model' }, { reasoningEffort: 'low' }])('keeps explicit options on the requested/default Agent: %j', async options => {
    const { runtime, resolve } = await fixture();
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.99);
    await resolve(undefined, undefined, options);
    expect(runtime.start).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'codex', ...options }));
    expect(random).not.toHaveBeenCalled();
  });

  it('lets explicit Agent overrides use their own defaults', async () => {
    const { runtime, resolve } = await fixture();
    await resolve(undefined, undefined, { agentId: 'ccflash' });
    expect(runtime.start.mock.calls[0]![0]).not.toHaveProperty('model');
    expect(runtime.start.mock.calls[0]![0]).not.toHaveProperty('reasoningEffort');
  });

  it('lets /new discover and retire a candidate whose launch binding was never saved', async () => {
    const { config, repos, runtime, resolve } = await fixture();
    const old = await runtime.start({ agentId: 'ccflash', cwd: config.workspace, permissionMode: 'full-trust', source: 'lark', sourceId: 'cli_test:oc_test:p2p' });
    const sessions = await listPersistedLarkSessions(runtime as any, config, 'oc_test', 'p2p', 'p2p', repos.channelMappings);
    expect(sessions).toEqual([old]);
    for (const session of sessions) await runtime.stop(session.id);
    expect((await resolve()).id).not.toBe(old.id);
  });

  it('recovers a started routing candidate when its launch binding was never saved', async () => {
    const { config, runtime, resolve } = await fixture();
    const session = await runtime.start({ agentId: 'ccflash', cwd: config.workspace, model: 'flash-model', permissionMode: 'full-trust', source: 'lark', sourceId: 'cli_test:oc_test:p2p' });
    runtime.start.mockClear();
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(await resolve()).toBe(session);
    expect(await resolve(undefined, { ...config, defaultAgentWeights: undefined })).toBe(session);
    expect(runtime.start).not.toHaveBeenCalled();
    expect(random).not.toHaveBeenCalled();
  });

  it('retains a weighted first-turn workspace override when recovering a started session', async () => {
    const { config, runtime, resolve } = await fixture();
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.8);
    const first = await resolve(undefined, config, { cwd: config.workspace });
    expect(await resolve(undefined, config, { cwd: config.workspace })).toBe(first);
    expect(runtime.start).toHaveBeenCalledOnce();
    expect(random).toHaveBeenCalledOnce();
  });

  it('accepts an ACP Claude candidate protected by its process guard', async () => {
    const { config, repos, runtime, resolve } = await fixture();
    const launcher = join(process.cwd(), 'packages', 'acp-client', 'agents', 'claude-acp.mjs');
    await repos.agents.save(agentConfigSchema.parse({ id: 'ccflash', name: 'ccflash', command: process.execPath, args: [launcher], protocol: 'acp' }));
    vi.spyOn(Math, 'random').mockReturnValue(0.8);
    expect((await resolve(undefined, { ...config, riskControlMode: 'enforced' })).agentId).toBe('ccflash');
    expect(runtime.start).toHaveBeenCalledOnce();
  });

  it('checks the selected Agent hook before starting with enforced risk control', async () => {
    const { config, runtime, resolve } = await fixture();
    vi.spyOn(Math, 'random').mockReturnValue(0.8);
    await expect(resolve(undefined, { ...config, riskControlMode: 'enforced' })).rejects.toMatchObject({ code: 'RISK_CONTROL_HOOK_NOT_READY' });
    expect(runtime.start).not.toHaveBeenCalled();
  });
});
