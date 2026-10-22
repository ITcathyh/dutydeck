import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { AcpxAdapter, listAcpxBuiltinAgents } from '@dutydeck/acp-client';
import { createRepositories } from '@dutydeck/storage';
import type { AgentConfig, DriverFactory } from '@dutydeck/shared';
import { DutydeckRuntime } from './index.js';

vi.mock('@dutydeck/acp-client', async importOriginal => ({
  ...await importOriginal<typeof import('@dutydeck/acp-client')>(),
  listAcpxBuiltinAgents: () => ['claude', 'gemini'].map(id => ({ id, argv: [process.execPath, resolve('packages/acp-client/tests/fixtures/compact-agent.mjs'), id] }))
}));

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

it.each(['claude', 'gemini'])('continues a persisted %s ACP native session and resume capability after terminal becomes the default', async id => {
  const cwd = await mkdtemp(join(tmpdir(), 'dd-builtin-protocol-'));
  cleanup.push(() => rm(cwd, { recursive: true, force: true }));
  const log = join(cwd, 'prompts.log');
  const repos = createRepositories(join(cwd, 'state.db'), { newDatabaseAuthority: 'ledger_v1' });
  cleanup.push(async () => repos.close());
  const argv = listAcpxBuiltinAgents().find(agent => agent.id === id)!.argv;
  const oldAgent: AgentConfig = { id, name: id, command: argv[0]!, args: argv.slice(1), protocol: 'acp', cwd,
    env: { compact_test_log: log }, permissionMode: 'ask', timeout: 10, capabilities: { pause: false, resume: true }, builtin: true };
  const configured: AgentConfig[] = [], callbackProtocols: Array<string | undefined> = [];
  const factory: DriverFactory = Object.assign((agent, protocol, onEvent, onExit, sessionId, context) => {
    configured.push(agent);
    if (protocol === 'acp') return new AcpxAdapter(agent, { onEvent, onExit, sessionKey: sessionId, context });
    return { start: async () => {}, send: async () => { onEvent({ type: 'text', data: { text: 'terminal reply' } }); onEvent({ type: 'completed', data: { stopReason: 'end_turn' } }); },
      stop: async () => {}, interrupt: async () => {}, resume: async () => {}, isStopped: async () => true };
  }, { controlledResources: (protocol: string) => protocol === 'acp' });
  const open = async (agent: AgentConfig) => {
    const runtime = new DutydeckRuntime(repos, { driverIdleTimeoutMs: 0, driverFactory: factory,
      probe: candidate => ({ protocol: candidate.protocol === 'pty-cli' ? 'pty-cli' : 'acp', available: true, pause: false, resume: true }),
      configureAgent: async candidate => { callbackProtocols.push(candidate.protocol); return candidate; } });
    cleanup.push(() => runtime.shutdown());
    await runtime.initialize([agent]); return runtime;
  };
  const first = await open(oldAgent);
  const session = await first.start({ agentId: oldAgent.id });
  expect((await first.send(session.id, 'before upgrade')).status).toBe('completed');
  const nativeBefore = repos.execution.getResources(session.id).filter(resource => resource.purpose === 'acp_native_context').map(resource => resource.resourceId);
  expect(nativeBefore).toHaveLength(1);
  await first.shutdown();

  const terminalAgent: AgentConfig = { ...oldAgent, command: '/bin/sh', args: [], protocol: 'pty-cli', adapterId: id === 'claude' ? 'claude-code' : 'gemini', capabilities: { pause: false, resume: id !== 'gemini' } };
  const restored = await open(terminalAgent);
  await restored.resume(session.id);
  expect((await restored.send(session.id, 'after upgrade')).status).toBe('completed');
  expect((await readFile(log, 'utf8')).trim().split('\n')).toEqual(['before upgrade', 'after upgrade']);
  expect((await restored.getSession(session.id))?.protocol).toBe('acp');
  expect(repos.execution.getResources(session.id).filter(resource => resource.purpose === 'acp_native_context').map(resource => resource.resourceId)).toEqual(nativeBefore);
  expect(configured.at(-1)).toMatchObject({ command: argv[0], args: argv.slice(1), protocol: 'acp', permissionMode: 'ask' });
  expect(configured.at(-1)?.adapterId).toBeUndefined();
  expect(callbackProtocols.at(-1)).toBe('acp');

  const fresh = await restored.start({ agentId: terminalAgent.id });
  expect(fresh).toMatchObject({ protocol: 'pty-cli', terminalBackend: 'tmux', permissionMode: 'ask' });
  const terminalTask = await restored.send(fresh.id, 'new terminal');
  expect(terminalTask).toMatchObject({ status: 'completed' });
  expect(configured.at(-1)).toMatchObject({ command: '/bin/sh', protocol: 'pty-cli', env: { dutydeck_terminal_backend: 'tmux' } });
});

it('keeps an explicitly configured ACP launcher for the same built-in id', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dd-explicit-acp-'));
  cleanup.push(() => rm(cwd, { recursive: true, force: true }));
  const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' });
  cleanup.push(async () => repos.close());
  const agent: AgentConfig = { id: 'claude', name: 'Custom ACP', command: process.execPath, args: [resolve('packages/acp-client/tests/fixtures/compact-agent.mjs'), 'custom'],
    protocol: 'acp', cwd, env: {}, permissionMode: 'approve-reads', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };
  const configured: AgentConfig[] = [];
  const factory: DriverFactory = Object.assign((candidate, _protocol, onEvent, onExit, sessionId, context) => {
    configured.push(candidate); return new AcpxAdapter(candidate, { onEvent, onExit, sessionKey: sessionId, context });
  }, { controlledResources: () => true });
  const runtime = new DutydeckRuntime(repos, { driverFactory: factory, probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }) });
  cleanup.push(() => runtime.shutdown());
  await runtime.initialize([agent]);
  const session = await runtime.start({ agentId: agent.id });
  expect((await runtime.send(session.id, 'custom work')).status).toBe('completed');
  expect(configured.at(-1)).toMatchObject({ command: agent.command, args: agent.args, protocol: 'acp', permissionMode: 'approve-reads', builtin: false });
});
