import { describe, expect, it } from 'vitest';
import { builtinAgents, loadConfig } from './index.js';

describe('working directory configuration', () => {
  it('uses the server process cwd when no default is specified', () => {
    const config = loadConfig({});
    expect(config.agents.every(agent => agent.cwd === process.cwd())).toBe(true);
    expect(config.databaseUrl).toBe(`${process.cwd()}/.dockmux/dockmux.db`);
    expect(config.host).toBe('127.0.0.1');
    expect(config.driverIdleTimeoutMs).toBe(21_600_000);
    expect(config.cleanupIntervalMs).toBe(300_000);
    expect(config.agents.some(agent => ['mock-acp', 'jsonl-demo', 'pty-demo'].includes(agent.id))).toBe(false);
    expect(config.agents.every(agent => agent.protocol === 'acp')).toBe(true);
  });

  it('uses the explicit server default cwd for every built-in agent', () => {
    const cwd = '/tmp/dockmux-project';
    expect(loadConfig({ DOCKMUX_DEFAULT_CWD: cwd }).agents).toEqual(builtinAgents(cwd));
  });

  it('binds only to loopback when local-only startup mode is enabled', () => {
    expect(loadConfig({ DOCKMUX_LOCAL_ONLY: 'true', DOCKMUX_HOST: '0.0.0.0' }).host).toBe('127.0.0.1');
  });

  it('applies the server default cwd to custom agents that omit cwd', () => {
    const cwd = '/tmp/agent-buddy-project';
    const custom = { id: 'custom', name: 'Custom', command: process.execPath, args: [], protocol: 'acp' };
    const configured = loadConfig({ DOCKMUX_DEFAULT_CWD: cwd, DOCKMUX_AGENTS_JSON: JSON.stringify([custom]) });
    expect(configured.agents.find(agent => agent.id === 'custom')?.cwd).toBe(cwd);
    expect(configured.agents.find(agent => agent.id === 'custom')?.permissionMode).toBe('ask');
  });

  it('keeps an explicit legacy permissionMode while defaulting omitted configs to ask', () => {
    const explicit = { id: 'trusted', name: 'Trusted', command: process.execPath, protocol: 'acp', permissionMode: 'full-trust' };
    const configured = loadConfig({ DOCKMUX_AGENTS_JSON: JSON.stringify([explicit]) });
    expect(configured.agents.find(agent => agent.id === 'trusted')?.permissionMode).toBe('full-trust');
  });

  it('preserves an agent-specific cwd over the server default', () => {
    const custom = { id: 'custom', name: 'Custom', command: process.execPath, args: [], protocol: 'acp', cwd: '/tmp/custom-agent-project' };
    const configured = loadConfig({ DOCKMUX_DEFAULT_CWD: '/tmp/agent-buddy-project', DOCKMUX_AGENTS_JSON: JSON.stringify([custom]) });
    expect(configured.agents.find(agent => agent.id === 'custom')?.cwd).toBe('/tmp/custom-agent-project');
  });
});
