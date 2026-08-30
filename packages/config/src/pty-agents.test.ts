import { describe, expect, it, vi } from 'vitest';
import { builtinAgents, createRuntimeOptions, loadConfig, type PtyAgentContribution } from './index.js';
import { commandExists } from '@dockmux/transports';
import type { DriverFactory } from '@dockmux/runtime';

// ACPX 发现固定返回 claude/codex 两个内置 agent，与真实环境解耦
vi.mock('@dockmux/acp-client', () => ({
  listAcpxBuiltinAgents: vi.fn(() => [
    { id: 'claude', argv: ['/bin/claude-acp'] },
    { id: 'codex', argv: ['/bin/codex-acp'] }
  ])
}));

// 放行 node 本体（cliVersion 走真实 spawnSync，node --version 秒回，不会卡 timeout）
// 以及 ACPX mock 对应的两个 cli，否则 ACPX 内置 agent 会被 commandExists 过滤掉
vi.mock('@dockmux/transports', () => ({
  commandExists: vi.fn((command: string) => command === process.execPath || command === 'claude' || command === 'codex')
}));

const mockCommandExists = vi.mocked(commandExists);

describe('builtinAgents PTY contributions', () => {
  it('returns only ACPX agents when no PTY contributions are given', () => {
    const agents = builtinAgents('/tmp/dockmux-pty-test');
    expect(agents.map(agent => agent.id)).toEqual(['claude', 'codex']);
    expect(agents.every(agent => agent.protocol === 'acp')).toBe(true);
  });

  it('includes PTY contributions whose command exists with pty-cli protocol and defaults', () => {
    const contribution: PtyAgentContribution = { id: 'gemini', name: 'Gemini', command: process.execPath };
    const agents = builtinAgents('/tmp/dockmux-pty-test', [contribution]);
    const gemini = agents.find(agent => agent.id === 'gemini');
    expect(gemini).toBeDefined();
    expect(gemini?.protocol).toBe('pty-cli');
    expect(gemini?.args).toEqual([]);
    expect(gemini?.builtin).toBe(true);
    expect(gemini?.permissionMode).toBe('ask');
    expect(gemini?.version).toBeTruthy();
    expect(gemini?.cwd).toBe('/tmp/dockmux-pty-test');
  });

  it('propagates the contribution\'s declared capabilities instead of hardcoding resume:true', () => {
    // gemini 每次都是全新会话，没有 resume——贡献方显式声明后必须原样传播，
    // 否则 UI/runtime 会把它当成可恢复会话。
    const contribution: PtyAgentContribution = {
      id: 'gemini', name: 'Gemini', command: process.execPath,
      capabilities: { pause: false, resume: false },
    };
    const agents = builtinAgents('/tmp/dockmux-pty-caps', [contribution]);
    expect(agents.find(agent => agent.id === 'gemini')?.capabilities).toEqual({ pause: false, resume: false });
  });

  it('falls back to the conservative default when a contribution omits capabilities', () => {
    const contribution: PtyAgentContribution = { id: 'nocaps', name: 'NoCaps', command: process.execPath };
    const agents = builtinAgents('/tmp/dockmux-pty-caps', [contribution]);
    expect(agents.find(agent => agent.id === 'nocaps')?.capabilities).toEqual({ pause: false, resume: true });
  });

  it('filters out PTY contributions whose command does not exist', () => {    const contribution: PtyAgentContribution = { id: 'ghost', name: 'Ghost', command: '/bin/ghost-cli-that-does-not-exist' };
    const agents = builtinAgents('/tmp/dockmux-pty-test', [contribution]);
    expect(agents.some(agent => agent.id === 'ghost')).toBe(false);
  });

  it('skips PTY contributions whose id collides with an ACPX agent', () => {
    const contribution: PtyAgentContribution = { id: 'claude', name: 'Claude PTY', command: process.execPath };
    const agents = builtinAgents('/tmp/dockmux-pty-test', [contribution]);
    const claude = agents.find(agent => agent.id === 'claude');
    expect(claude?.protocol).toBe('acp');
    expect(agents.every(agent => agent.protocol !== 'pty-cli')).toBe(true);
  });

  it('probes each contribution command only once across repeated calls with the same arguments', () => {
    const contribution: PtyAgentContribution = { id: 'cache-probe', name: 'Cache Probe', command: process.execPath };
    mockCommandExists.mockClear();
    const first = builtinAgents('/tmp/dockmux-pty-test', [contribution]);
    const second = builtinAgents('/tmp/dockmux-pty-test', [contribution]);
    expect(first).toEqual(second);
    const probeCalls = mockCommandExists.mock.calls.filter(([command]) => command === contribution.command).length;
    expect(probeCalls).toBe(1);
  });
});

describe('loadConfig PTY contribution passthrough', () => {
  it('includes ptyContributions in the assembled config agents', () => {
    const contribution: PtyAgentContribution = { id: 'gemini', name: 'Gemini', command: process.execPath };
    const config = loadConfig({ DOCKMUX_DEFAULT_CWD: '/tmp/dockmux-pty-test' }, [contribution]);
    const gemini = config.agents.find(agent => agent.id === 'gemini');
    expect(gemini?.protocol).toBe('pty-cli');
    expect(gemini?.cwd).toBe('/tmp/dockmux-pty-test');
    expect(config.agents.some(agent => agent.id === 'claude' && agent.protocol === 'acp')).toBe(true);
  });

  it('stays pty-free when called without contributions', () => {
    const config = loadConfig({ DOCKMUX_DEFAULT_CWD: '/tmp/dockmux-pty-test' });
    expect(config.agents.every(agent => agent.protocol === 'acp')).toBe(true);
  });
});

describe('createRuntimeOptions', () => {
  it('maps AppConfig runtime fields and leaves ptyDriverFactory undefined by default', () => {
    const config = loadConfig({ DOCKMUX_ACPX_COMMAND: 'custom-acpx', DOCKMUX_DRIVER_IDLE_TIMEOUT_MS: '42000', DOCKMUX_CLEANUP_INTERVAL_MS: '7000' });
    const options = createRuntimeOptions(config);
    expect(options).toEqual({ acpxCommand: 'custom-acpx', driverIdleTimeoutMs: 42_000, cleanupIntervalMs: 7_000, ptyDriverFactory: undefined });
  });

  it('passes through an injected ptyDriverFactory', () => {
    const config = loadConfig({});
    const factory = vi.fn() as unknown as DriverFactory;
    const options = createRuntimeOptions(config, { ptyDriverFactory: factory });
    expect(options.ptyDriverFactory).toBe(factory);
  });
});
