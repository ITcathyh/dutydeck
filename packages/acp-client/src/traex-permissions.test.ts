import '../../../tests/support/short-acpx-reply-drain.js';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRuntimeStore } from 'acpx/runtime';
import { agentConfigSchema } from '@dutydeck/shared';
import { childEnvironment } from '@dutydeck/shared/child-environment';
import { AcpxAdapter, prepareAcpxAgentLaunch } from './index.js';

const directories: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function directory() { const value = await mkdtemp(join(tmpdir(), 'dutydeck-traex-permissions-')); directories.push(value); return value; }

const restrictions = ['-c', 'sandbox_mode="read-only"',
  ...['exec', 'exec_command', 'apply_patch', 'spawn_agent', 'tool_search'].flatMap(tool => ['--disallowed-tool', tool])];

describe('native Traex ACP permissions', () => {
  it('keeps native restrictions on a clean direct launch without adding an environment bridge', async () => {
    const clean = childEnvironment(process.env);
    for (const [key, value] of Object.entries(process.env)) if (clean[key] !== value) vi.stubEnv(key, clean[key]);
    const cwd = await directory();
    const agent = agentConfigSchema.parse({ id: 'traex-acp', name: 'TRAE', command: 'traex', args: ['acp', 'serve'],
      protocol: 'acp', permissionMode: 'deny-all' });
    const launch = prepareAcpxAgentLaunch(agent, { workspace: cwd, sessionKey: 'direct' });
    try { expect(launch.command).toEqual(['traex', 'acp', 'serve', ...restrictions]); }
    finally { launch.cleanup(); }
  });

  it.each(['traex', 'traecli'])('restricts direct native %s deny-all launches, including bridged environments', async executable => {
    const cwd = await directory();
    const agent = agentConfigSchema.parse({ id: 'custom-traex', name: 'TRAE', command: `/opt/bin/${executable}`,
      args: ['acp', 'serve'], protocol: 'acp', permissionMode: 'deny-all', env: { VENDOR_ACCOUNT_TOKEN: 'account-placeholder' } });
    const launch = prepareAcpxAgentLaunch(agent, { workspace: cwd, sessionKey: 'text-only' });
    try {
      expect(launch.command.slice(2)).toEqual([agent.command, ...agent.args, ...restrictions]);
      expect(launch.sessionOptions.env).not.toHaveProperty('VENDOR_ACCOUNT_TOKEN');
      expect(agent.args).toEqual(['acp', 'serve']);
    } finally { launch.cleanup(); }
  });

  it.each(['ask', 'approve-reads', 'full-trust'] as const)('preserves ordinary %s launches', async permissionMode => {
    const cwd = await directory();
    const agent = agentConfigSchema.parse({ id: 'traex-acp', name: 'TRAE', command: 'traex', args: ['acp', 'serve'],
      protocol: 'acp', permissionMode });
    const launch = prepareAcpxAgentLaunch(agent, { workspace: cwd, sessionKey: 'ordinary' });
    try { expect(launch.command.slice(-3)).toEqual(['traex', 'acp', 'serve']); }
    finally { launch.cleanup(); }
  });

  it.each(['-y', '--yolo', '--dangerously-bypass-approvals-and-sandbox'])('rejects native sandbox bypass %s in deny-all sessions', async flag => {
    const cwd = await directory();
    const agent = agentConfigSchema.parse({ id: 'traex-acp', name: 'TRAE', command: 'traex', args: ['acp', 'serve', flag],
      protocol: 'acp', permissionMode: 'deny-all' });
    expect(() => prepareAcpxAgentLaunch(agent, { workspace: cwd, sessionKey: 'unsafe' })).toThrow('cannot bypass native approvals and sandboxing');
  });

  it.each([
    { command: 'node', args: ['traex-wrapper.mjs'] },
    { command: '/opt/custom-traex', args: ['acp', 'serve'] },
    { command: 'traex', args: ['custom-protocol'] }
  ])('does not rewrite an unrecognized wrapper or protocol: $command', async input => {
    const cwd = await directory();
    const agent = agentConfigSchema.parse({ id: 'traex-acp', name: 'Custom', ...input, protocol: 'acp', permissionMode: 'deny-all' });
    const launch = prepareAcpxAgentLaunch(agent, { workspace: cwd, sessionKey: 'wrapper' });
    try { expect(launch.command.slice(-1 - input.args.length)).toEqual([input.command, ...input.args]); }
    finally { launch.cleanup(); }
  });

  it.each([false, true])('retains native restrictions across real ACPX startup and persisted-session restore (bridged=%s)', async bridged => {
    const cwd = await directory();
    const command = join(cwd, 'traex');
    const argumentLog = join(cwd, 'arguments.jsonl');
    const fixture = pathToFileURL(resolve('tests/fixtures/mock-acp-agent.mjs')).href;
    await writeFile(command, `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(argumentLog)}, JSON.stringify(process.argv.slice(2)) + '\\n');\nimport(${JSON.stringify(fixture)});\n`, { mode: 0o755 });
    const config = agentConfigSchema.parse({ id: 'traex-acp', name: 'TRAE fixture', command, args: ['acp', 'serve'], protocol: 'acp', cwd,
      permissionMode: 'deny-all', env: bridged ? { MOCK_VENDOR_TOKEN: 'account-placeholder' } : {}, timeout: 10 });
    const sessionKey = 'traex-text-only-persistent';
    const store = createRuntimeStore({ stateDir: join(cwd, '.dutydeck', 'acpx') });
    let nativeSessionId: string | undefined;
    for (let turn = 0; turn < 2; turn++) {
      const texts: string[] = [];
      const adapter = new AcpxAdapter(config, { sessionKey, onEvent: event => { if (event.type === 'text') texts.push(String(event.data?.text)); } });
      try {
        await adapter.start();
        await adapter.send('permission');
        expect(texts.join('')).toContain('Permission: selected');
        expect(texts.join('')).toContain('"optionId":"deny"');
      } finally { await adapter.stop(); }
      const saved = await store.load(sessionKey);
      if (turn === 0) { expect(saved?.acpSessionId).toBeTruthy(); nativeSessionId = saved?.acpSessionId; }
      else expect(saved?.acpSessionId).toBe(nativeSessionId);
    }
    expect((await readFile(argumentLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line))).toEqual([
      ['acp', 'serve', ...restrictions], ['acp', 'serve', ...restrictions]
    ]);
    const record = await store.load(sessionKey);
    expect(record?.agentArgv?.slice(-restrictions.length)).toEqual(restrictions);
    expect(Object.keys(record?.acpx?.session_options?.env ?? {}).every(key => /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(key))).toBe(true);
  });
});
