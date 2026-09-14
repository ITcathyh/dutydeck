import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AcpRuntime } from 'acpx/runtime';
import { agentConfigSchema } from '@dutydeck/shared';
import {
  AgentModelProbeTimeoutError,
  clearAgentModelsCacheForTesting,
  computeAgentModelProbeKey,
  discoverAgentModels,
  modelsFromAcpStatus,
  probeModelsThroughAcpRuntime
} from './agent-models.js';

const probeInput = { sessionKey: 'probe', agent: 'codex', mode: 'oneshot' as const };
const handle = { sessionKey: 'probe', backend: 'acpx', runtimeSessionName: 'probe', acpxRecordId: 'probe-record' };

function runtime(overrides: Partial<AcpRuntime>): AcpRuntime {
  return {
    ensureSession: vi.fn(async () => handle),
    startTurn: vi.fn(),
    runTurn: vi.fn(),
    cancel: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    ...overrides
  } as AcpRuntime;
}

describe('ACP-first Agent model discovery', () => {
  it.each([undefined, 'claude-code'])('does not launch a PTY command as ACP (adapter: %s)', async adapterId => {
    const fixture = resolve(process.cwd(), 'tests/fixtures/mock-acp-agent.mjs');
    // This command really advertises bridged-model if an ACP probe is started.
    const agent = agentConfigSchema.parse({
      id: `ccflash-${crypto.randomUUID()}`, name: 'CCFlash', command: process.execPath,
      args: [fixture], protocol: 'pty-cli', adapterId, model: 'gemini-custom-flash',
      env: { MOCK_VENDOR_TOKEN: 'model-probe-secret' }
    });
    await expect(discoverAgentModels(agent, undefined, true)).resolves.toEqual({
      models: [], defaultModel: 'gemini-custom-flash', reasoningEfforts: [], source: 'agent'
    });
  });

  it('reads a custom CLI default from the current profile without reusing a cached model', async () => {
    const agent = agentConfigSchema.parse({ id: 'ccflash', name: 'CCFlash', command: process.execPath,
      protocol: 'pty-cli', adapterId: 'claude-code', model: 'first-model' });
    expect((await discoverAgentModels(agent)).defaultModel).toBe('first-model');
    expect((await discoverAgentModels({ ...agent, model: 'second-model' })).defaultModel).toBe('second-model');
  });

  it('never executes a custom wrapper when refreshing its model metadata', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dutydeck-pty-models-'));
    const marker = join(root, 'executed');
    const agent = agentConfigSchema.parse({ id: 'ccflash-marker', name: 'CCFlash', command: process.execPath,
      args: ['-e', "require('node:fs').writeFileSync(process.argv[1], 'started')", marker],
      protocol: 'pty-cli', adapterId: 'claude-code' });
    try {
      await expect(discoverAgentModels(agent, undefined, true)).resolves.toEqual({ models: [], reasoningEfforts: [], source: 'agent' });
      expect(existsSync(marker)).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('uses Agent-advertised model identifiers and display names', () => {
    expect(modelsFromAcpStatus({
      models: { currentModelId: 'model-a', availableModelIds: ['model-a', 'model-b'] },
      details: { configOptions: [
        { id: 'model', category: 'model', options: [{ value: 'model-a', name: 'Model A' }, { value: 'model-b', name: 'Model B' }] },
        { id: 'effort', category: 'thought_level', currentValue: 'medium', options: [{ value: 'low', name: 'Low' }, { value: 'medium', name: 'Medium' }] }
      ] }
    })).toEqual({ models: [{ id: 'model-a', name: 'Model A' }, { id: 'model-b', name: 'Model B' }], defaultModel: 'model-a', reasoningEfforts: [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }], defaultReasoningEffort: 'medium', source: 'acp' });
  });

  it('bounds a stalled ensureSession instead of leaving the HTTP request pending', async () => {
    const close = vi.fn(async () => undefined);
    const target = runtime({ ensureSession: vi.fn(() => new Promise(() => undefined)), close });
    await expect(probeModelsThroughAcpRuntime(target, probeInput, 10)).rejects.toEqual(expect.objectContaining<Partial<AgentModelProbeTimeoutError>>({ name: 'AgentModelProbeTimeoutError', phase: 'ensureSession' }));
    expect(close).not.toHaveBeenCalled();
  });

  it('closes the probe child when getStatus stalls', async () => {
    const close = vi.fn(async () => undefined);
    const target = runtime({ getStatus: vi.fn(() => new Promise(() => undefined)), close });
    await expect(probeModelsThroughAcpRuntime(target, probeInput, 10)).rejects.toEqual(expect.objectContaining<Partial<AgentModelProbeTimeoutError>>({ phase: 'getStatus' }));
    expect(close).toHaveBeenCalledWith({ handle, reason: 'Dutydeck model discovery', discardPersistentState: true });
  });

  it('bounds close cleanup and still returns the model fallback', async () => {
    const target = runtime({
      getStatus: vi.fn(async () => ({ models: { currentModelId: 'codex', availableModelIds: ['codex'] } })),
      close: vi.fn(() => new Promise(() => undefined))
    });
    await expect(probeModelsThroughAcpRuntime(target, probeInput, 10)).resolves.toMatchObject({ defaultModel: 'codex', source: 'acp' });
  });

  it('patches acpx ensureSession initialization with its configured timeout', () => {
    const patch = readFileSync(new URL('../../../patches/acpx@0.13.0.patch', import.meta.url), 'utf8');
    const buildScript = readFileSync(new URL('../scripts/build.mjs', import.meta.url), 'utf8');
    expect(patch).toContain('await withTimeout(client.start(), this.options.timeoutMs)');
    expect(buildScript).toContain("fileURLToPath(import.meta.resolve('acpx/runtime'))");
  });

  it('discovers models through the real ACP runtime with uppercase Agent env bridged to the child', async () => {
    const fixture = resolve(process.cwd(), 'tests/fixtures/mock-acp-agent.mjs');
    const result = await discoverAgentModels({
      id: `model-probe-${crypto.randomUUID()}`,
      name: 'Model probe', command: process.execPath, args: [fixture], protocol: 'acp',
      env: { MOCK_VENDOR_TOKEN: 'model-probe-secret' }, permissionMode: 'ask', timeout: 10,
      capabilities: { pause: false, resume: true }, builtin: false
    }, undefined, true);
    expect(result).toMatchObject({ models: [{ id: 'bridged-model', name: 'Bridged Model' }], defaultModel: 'bridged-model', source: 'acp' });
  });
});

describe('in-flight 探测复用、缓存穿透与配置隔离', () => {
  let tempCliDir: string;
  let counterFile: string;
  let statusFile: string;
  let oldPath: string;

  beforeEach(() => {
    tempCliDir = mkdtempSync(join(tmpdir(), 'dutydeck-fake-cli-'));
    counterFile = join(tempCliDir, 'invoke-count.txt');
    statusFile = join(tempCliDir, 'status.txt');
    writeFileSync(counterFile, '0', 'utf8');
    writeFileSync(statusFile, 'ok', 'utf8');

    const opencodePath = join(tempCliDir, 'opencode');
    const script = `#!/usr/bin/env node
const fs = require('node:fs');
const status = fs.readFileSync(${JSON.stringify(statusFile)}, 'utf8').trim();
const count = parseInt(fs.readFileSync(${JSON.stringify(counterFile)}, 'utf8').trim(), 10) || 0;
fs.writeFileSync(${JSON.stringify(counterFile)}, String(count + 1), 'utf8');

if (status === 'fail') {
  process.stderr.write('simulated CLI failure\\n');
  process.exit(1);
}

setTimeout(() => {
  process.stdout.write('opencode-flash\\nopencode-deep\\n');
}, 60);
`;
    writeFileSync(opencodePath, script, { mode: 0o755 });
    oldPath = process.env.PATH ?? '';
    process.env.PATH = `${tempCliDir}:${oldPath}`;
    clearAgentModelsCacheForTesting();
  });

  afterEach(() => {
    process.env.PATH = oldPath;
    clearAgentModelsCacheForTesting();
    try {
      rmSync(tempCliDir, { recursive: true, force: true });
    } catch {}
  });

  it('8 并发请求同一配置只探测一次（复用 inFlight，只产生 1 个子进程）', async () => {
    const agent = agentConfigSchema.parse({
      id: 'opencode',
      name: 'OpenCode',
      command: 'opencode',
      protocol: 'pty-cli'
    });

    const requests = Array.from({ length: 8 }, () => discoverAgentModels(agent));
    const results = await Promise.all(requests);

    for (const result of results) {
      expect(result.models).toEqual([
        { id: 'opencode-flash', name: 'opencode-flash' },
        { id: 'opencode-deep', name: 'opencode-deep' }
      ]);
      expect(result.source).toBe('cli');
    }

    const count = parseInt(readFileSync(counterFile, 'utf8').trim(), 10);
    expect(count).toBe(1);
  });

  it('探测失败 fallback 不缓存 5 分钟，CLI 恢复后普通请求可重试恢复', async () => {
    const agent = agentConfigSchema.parse({
      id: 'opencode',
      name: 'OpenCode',
      command: 'opencode',
      protocol: 'pty-cli',
      model: 'default-fallback-model'
    });

    // 1. 设置 fake CLI 为失败状态
    writeFileSync(statusFile, 'fail', 'utf8');

    const failedResult = await discoverAgentModels(agent);
    expect(failedResult.models).toEqual([]);
    expect(failedResult.defaultModel).toBe('default-fallback-model');

    let count = parseInt(readFileSync(counterFile, 'utf8').trim(), 10);
    expect(count).toBe(1);

    // 2. CLI 恢复正常
    writeFileSync(statusFile, 'ok', 'utf8');

    // 普通请求（forceRefresh = false），验证不会被 5 分钟缓存拦截，而是重新探测
    const recoveredResult = await discoverAgentModels(agent, undefined, false);
    expect(recoveredResult.models).toEqual([
      { id: 'opencode-flash', name: 'opencode-flash' },
      { id: 'opencode-deep', name: 'opencode-deep' }
    ]);
    expect(recoveredResult.source).toBe('cli');

    // 验证第二次请求真正执行了探测
    count = parseInt(readFileSync(counterFile, 'utf8').trim(), 10);
    expect(count).toBe(2);

    // 3. 成功后再次普通请求，应命中成功缓存，不重复执行
    const cachedResult = await discoverAgentModels(agent, undefined, false);
    expect(cachedResult.models).toEqual(recoveredResult.models);
    count = parseInt(readFileSync(counterFile, 'utf8').trim(), 10);
    expect(count).toBe(2);
  });

  it('并发 forceRefresh 复用正在进行的探测，不会重复启动探测', async () => {
    const agent = agentConfigSchema.parse({
      id: 'opencode',
      name: 'OpenCode',
      command: 'opencode',
      protocol: 'pty-cli'
    });

    // 并发发起 3 个 forceRefresh 请求
    const requests = [
      discoverAgentModels(agent, undefined, true),
      discoverAgentModels(agent, undefined, true),
      discoverAgentModels(agent, undefined, true)
    ];

    const results = await Promise.all(requests);
    for (const result of results) {
      expect(result.models.length).toBe(2);
    }

    // 3 个并发 refresh 复用了同一 in-flight，底层 CLI 只执行了一次
    const count = parseInt(readFileSync(counterFile, 'utf8').trim(), 10);
    expect(count).toBe(1);

    // 在上一次探测完成后，再次调用 forceRefresh 会发起新的探测
    await discoverAgentModels(agent, undefined, true);
    const countAfterNewRefresh = parseInt(readFileSync(counterFile, 'utf8').trim(), 10);
    expect(countAfterNewRefresh).toBe(2);
  });

  it('缓存键隔离：协议/参数/CWD/ENV/版本/模型变更均生成不同安全摘要，避免凭据明文泄漏', () => {
    const baseAgent = agentConfigSchema.parse({
      id: 'custom-agent',
      name: 'Custom',
      command: 'custom',
      args: ['--flag'],
      protocol: 'auto',
      cwd: '/workspace/a',
      version: '1.0.0',
      model: 'model-1',
      env: { SECRET_TOKEN: 'sensitive-token-123', API_KEY: 'xyz' }
    });

    const baseKey = computeAgentModelProbeKey(baseAgent, 'requested-1');

    // 1. 凭据不在 key 明文中出现
    expect(baseKey).not.toContain('sensitive-token-123');
    expect(baseKey).not.toContain('xyz');
    expect(baseKey).toMatch(/^custom-agent:[a-f0-9]{64}$/);

    // 2. 任何影响探测的配置变更都会改变 key
    const diffProtocolKey = computeAgentModelProbeKey({ ...baseAgent, protocol: 'pty-cli' }, 'requested-1');
    expect(diffProtocolKey).not.toBe(baseKey);

    const diffArgsKey = computeAgentModelProbeKey({ ...baseAgent, args: ['--other'] }, 'requested-1');
    expect(diffArgsKey).not.toBe(baseKey);

    const diffCwdKey = computeAgentModelProbeKey({ ...baseAgent, cwd: '/workspace/b' }, 'requested-1');
    expect(diffCwdKey).not.toBe(baseKey);

    const diffVersionKey = computeAgentModelProbeKey({ ...baseAgent, version: '2.0.0' }, 'requested-1');
    expect(diffVersionKey).not.toBe(baseKey);

    const diffDefaultModelKey = computeAgentModelProbeKey({ ...baseAgent, model: 'model-2' }, 'requested-1');
    expect(diffDefaultModelKey).not.toBe(baseKey);

    const diffRequestedModelKey = computeAgentModelProbeKey(baseAgent, 'requested-2');
    expect(diffRequestedModelKey).not.toBe(baseKey);

    const diffEnvKey = computeAgentModelProbeKey({ ...baseAgent, env: { ...baseAgent.env, SECRET_TOKEN: 'other-token' } }, 'requested-1');
    expect(diffEnvKey).not.toBe(baseKey);

    const diffPermissionKey = computeAgentModelProbeKey({ ...baseAgent, permissionMode: 'auto' }, 'requested-1');
    expect(diffPermissionKey).not.toBe(baseKey);

    const diffTimeoutKey = computeAgentModelProbeKey({ ...baseAgent, timeout: 30 }, 'requested-1');
    expect(diffTimeoutKey).not.toBe(baseKey);

    // cwd 缺省按有效值 process.cwd() 区分
    const defaultCwdAgent = agentConfigSchema.parse({
      ...baseAgent,
      cwd: undefined
    });
    const defaultCwdKey = computeAgentModelProbeKey(defaultCwdAgent, 'requested-1');
    const explicitProcessCwdKey = computeAgentModelProbeKey({ ...defaultCwdAgent, cwd: process.cwd() }, 'requested-1');
    expect(defaultCwdKey).toBe(explicitProcessCwdKey);
    expect(defaultCwdKey).not.toBe(baseKey);

    // 3. ENV 键顺序不同但内容相同时，生成的安全摘要确定性一致
    const swappedEnvKey = computeAgentModelProbeKey({
      ...baseAgent,
      env: { API_KEY: 'xyz', SECRET_TOKEN: 'sensitive-token-123' }
    }, 'requested-1');
    expect(swappedEnvKey).toBe(baseKey);
  });

  it('无可探测方法与异常路径均能完整清理 inFlight，不会造成悬挂', async () => {
    const noProbeAgent = agentConfigSchema.parse({
      id: 'no-probe-agent',
      name: 'NoProbe',
      command: 'echo',
      protocol: 'pty-cli',
      model: 'configured-fallback'
    });

    // 首次调用无可用探测方法（非已知 CLI 命令，也不走 ACP）
    const res1 = await discoverAgentModels(noProbeAgent);
    expect(res1.models).toEqual([]);
    expect(res1.defaultModel).toBe('configured-fallback');

    // 再次调用，能够正常执行而不是卡在旧的 in-flight 或错误状态
    const res2 = await discoverAgentModels(noProbeAgent);
    expect(res2.models).toEqual([]);
    expect(res2.defaultModel).toBe('configured-fallback');
  });
});
