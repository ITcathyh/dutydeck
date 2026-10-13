import { describe, expect, it } from 'vitest';
import { agentProbeTarget, builtinAgents, describeDroppedAgent, loadConfig, loadConfigWithDiagnostics } from './index.js';

describe('working directory configuration', () => {
  it('uses the server process cwd when no default is specified', () => {
    const config = loadConfig({});
    expect(config.agents.every(agent => agent.cwd === process.cwd())).toBe(true);
    expect(config.databaseUrl).toBe(`${process.cwd()}/.dutydeck/dutydeck.db`);
    expect(config.host).toBe('127.0.0.1');
    expect(config.authEnabled).toBe(true);
    expect(config.driverIdleTimeoutMs).toBe(21_600_000);
    expect(config.cleanupIntervalMs).toBe(300_000);
    expect(config.agents.some(agent => ['mock-acp', 'jsonl-demo', 'pty-demo'].includes(agent.id))).toBe(false);
    expect(config.agents.every(agent => agent.protocol === 'acp')).toBe(true);
  });

  it('uses the explicit server default cwd for every built-in agent', () => {
    const cwd = '/tmp/dutydeck-project';
    expect(loadConfig({ DUTYDECK_DEFAULT_CWD: cwd }).agents).toEqual(builtinAgents(cwd));
  });

  it('binds only to loopback when local-only startup mode is enabled', () => {
    expect(loadConfig({ DUTYDECK_LOCAL_ONLY: 'true', DUTYDECK_HOST: '0.0.0.0' }).host).toBe('127.0.0.1');
  });

  it('disables access authentication only through an explicit false value', () => {
    expect(loadConfig({ DUTYDECK_HOST: '0.0.0.0', DUTYDECK_AUTH: 'false' })).toMatchObject({ host: '0.0.0.0', authEnabled: false });
    expect(loadConfig({ DUTYDECK_HOST: '0.0.0.0', DUTYDECK_AUTH: 'true' })).toMatchObject({ host: '0.0.0.0', authEnabled: true });
    expect(() => loadConfig({ DUTYDECK_AUTH: '0' })).toThrow();
  });

  it('applies the server default cwd to custom agents that omit cwd', () => {
    const cwd = '/tmp/agent-buddy-project';
    const custom = { id: 'custom', name: 'Custom', command: process.execPath, args: [], protocol: 'acp' };
    const configured = loadConfig({ DUTYDECK_DEFAULT_CWD: cwd, DUTYDECK_AGENTS_JSON: JSON.stringify([custom]) });
    expect(configured.agents.find(agent => agent.id === 'custom')?.cwd).toBe(cwd);
    expect(configured.agents.find(agent => agent.id === 'custom')?.permissionMode).toBe('ask');
  });

  it('keeps an explicit legacy permissionMode while defaulting omitted configs to ask', () => {
    const explicit = { id: 'trusted', name: 'Trusted', command: process.execPath, protocol: 'acp', permissionMode: 'full-trust' };
    const configured = loadConfig({ DUTYDECK_AGENTS_JSON: JSON.stringify([explicit]) });
    expect(configured.agents.find(agent => agent.id === 'trusted')?.permissionMode).toBe('full-trust');
  });

  it('preserves an agent-specific cwd over the server default', () => {
    const custom = { id: 'custom', name: 'Custom', command: process.execPath, args: [], protocol: 'acp', cwd: '/tmp/custom-agent-project' };
    const configured = loadConfig({ DUTYDECK_DEFAULT_CWD: '/tmp/agent-buddy-project', DUTYDECK_AGENTS_JSON: JSON.stringify([custom]) });
    expect(configured.agents.find(agent => agent.id === 'custom')?.cwd).toBe('/tmp/custom-agent-project');
  });

  it('keeps a custom Claude CLI profile alongside the built-in agents', () => {
    const custom = {
      id: 'ccflash', name: 'CCFlash (Claude Code)', command: process.execPath,
      protocol: 'pty-cli', adapterId: 'claude-code', model: 'gemini-custom-flash',
      args: ['--settings', '/private/ccflash-settings.json'],
      env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8320' }
    };
    const configured = loadConfig({ DUTYDECK_AGENTS_JSON: JSON.stringify([custom]) });
    expect(configured.agents.find(agent => agent.id === 'ccflash')).toMatchObject(custom);
    expect(configured.agents.find(agent => agent.id === 'ccflash')?.version).toBeUndefined();
    for (const builtin of builtinAgents()) expect(configured.agents).toContainEqual(builtin);
  });
});

describe('DUTYDECK_AGENTS_JSON diagnostics', () => {
  const missing = { id: 'ghost', name: 'Ghost', command: 'definitely-not-installed-agent-cli', protocol: 'acp' };

  it('reports custom agents whose command cannot be found instead of dropping them silently', () => {
    const { config, droppedAgents } = loadConfigWithDiagnostics({ DUTYDECK_AGENTS_JSON: JSON.stringify([missing]) });
    expect(config.agents.some(agent => agent.id === 'ghost')).toBe(false);
    expect(droppedAgents).toEqual([{ id: 'ghost', name: 'Ghost', command: 'definitely-not-installed-agent-cli', reason: 'command_not_found' }]);
  });

  it('does not report agents whose command exists', () => {
    const present = { ...missing, id: 'present', command: process.execPath };
    expect(loadConfigWithDiagnostics({ DUTYDECK_AGENTS_JSON: JSON.stringify([present]) }).droppedAgents).toEqual([]);
  });

  it('names the variable when the JSON cannot be parsed', () => {
    expect(() => loadConfig({ DUTYDECK_AGENTS_JSON: '[{"id":"x",}]' })).toThrow(/DUTYDECK_AGENTS_JSON 不是合法 JSON/);
  });

  it('names the variable when the value is not an array', () => {
    expect(() => loadConfig({ DUTYDECK_AGENTS_JSON: '{"id":"x"}' })).toThrow(/DUTYDECK_AGENTS_JSON 必须是 JSON 数组/);
  });

  it('names the variable, the entry position and the agent id when an entry is invalid', () => {
    const message = (() => {
      try { loadConfig({ DUTYDECK_AGENTS_JSON: JSON.stringify([{ id: 'broken', name: 'Broken' }]) }); } catch (error) { return (error as Error).message; }
      return '';
    })();
    expect(message).toContain('DUTYDECK_AGENTS_JSON 第 1 项（id=broken）无效');
    expect(message).toContain('command');
  });

  it('tells the user to switch to an absolute path and gives a copyable command', () => {
    const described = describeDroppedAgent({ id: 'ghost', name: 'Ghost', command: 'ghost-cli', reason: 'command_not_found' });
    expect(described.detail).toContain('ghost');
    expect(described.detail).toContain('ghost-cli');
    expect(described.remedy).toContain('绝对路径');
    expect(described.command).toBe('command -v ghost-cli');
    expect(describeDroppedAgent({ id: 'ghost', name: 'Ghost', command: '/opt/missing/agent', reason: 'command_not_found' }).command).toBe('ls -l /opt/missing/agent');
  });

  it('probes the real CLI for built-in ACP agents and skips executing custom pty wrappers', () => {
    expect(agentProbeTarget({ id: 'claude', command: 'npx', protocol: 'acp', builtin: true })).toEqual({ command: 'claude', execute: true });
    expect(agentProbeTarget({ id: 'ccflash', command: '/opt/ccflash', protocol: 'pty-cli', builtin: false, adapterId: 'claude-code' })).toEqual({ command: '/opt/ccflash', execute: false });
    expect(agentProbeTarget({ id: 'custom', command: '/opt/custom', protocol: 'acp', builtin: false })).toEqual({ command: '/opt/custom', execute: true });
  });
});

describe('plugin agents', () => {
  const pluginAgent = (id: string, name: string) => ({ id, name, command: 'node', args: [], protocol: 'acp' as const, env: {} });

  it('merges plugin agents before DUTYDECK_AGENTS_JSON so the environment wins on the same id', () => {
    const config = loadConfig({ DUTYDECK_AGENTS_JSON: JSON.stringify([{ id: 'reviewer', name: 'From env', command: 'node' }]) }, [], [pluginAgent('reviewer', 'From plugin'), pluginAgent('helper', 'Plugin helper')]);
    expect(config.agents.find(agent => agent.id === 'reviewer')?.name).toBe('From env');
    expect(config.agents.find(agent => agent.id === 'helper')?.name).toBe('Plugin helper');
  });

  it('never lets a plugin replace a built-in agent', () => {
    const config = loadConfig({}, [{ id: 'pty-tool', name: 'PTY tool', command: 'node' }], [pluginAgent('pty-tool', 'Hijacked'), pluginAgent('claude', 'Hijacked')]);
    expect(config.agents.find(agent => agent.id === 'pty-tool')?.name).toBe('PTY tool');
    expect(config.agents.find(agent => agent.id === 'claude')?.name).not.toBe('Hijacked');
  });
});
