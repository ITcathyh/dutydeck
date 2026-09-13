import { describe, expect, it } from 'vitest';
import { builtinAgents, loadConfig } from './index.js';

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
