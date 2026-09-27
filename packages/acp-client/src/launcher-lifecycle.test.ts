import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRuntimeStore } from 'acpx/runtime';
import { AcpxAdapter } from './index.js';

afterEach(() => vi.unstubAllEnvs());
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    if (process.platform === 'linux') return !/^[ZX] /.test(readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').slice(1).join(') '));
    return true;
  } catch { return false; }
};

it.each(['environment', 'claude', 'nested', 'forced-exit'])('checks real Agent cleanup when stopping the %s launcher', async kind => {
  const cwd = await mkdtemp(join(tmpdir(), 'dd-launcher-lifecycle-'));
  const fixture = join(cwd, 'stubborn.mjs');
  await writeFile(join(cwd, 'release'), 'ready');
  await writeFile(fixture, `process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); await import(${JSON.stringify(resolve('tests/fixtures/acp-lifecycle-agent.mjs'))});`);
  const claude = kind === 'claude' || kind === 'nested';
  if (claude) {
    vi.stubEnv('DUTYDECK_CLAUDE_ACP_COMMAND', process.execPath);
    vi.stubEnv('DUTYDECK_CLAUDE_ACP_ARGS_JSON', JSON.stringify([fixture]));
    vi.stubEnv('CLAUDE_CONFIG_DIR', cwd);
  }
  const sessionKey = `launcher-${kind}`;
  const adapter = new AcpxAdapter({
    id: `fixture-${kind}`, name: 'Fixture', command: process.execPath,
    args: [claude ? resolve('packages/acp-client/agents/claude-acp.mjs') : fixture],
    protocol: 'acp', cwd, permissionMode: 'full-trust', timeout: 10,
    capabilities: { pause: false, resume: true }, builtin: false,
    env: { lifecycle_directory: cwd, dutydeck_group_tools_token: 'fixture-token', ...(kind !== 'claude' ? { VENDOR_FIXTURE: 'synthetic' } : {}) }
  }, { sessionKey, onEvent() {} });
  let pid: number | undefined;
  try {
    await adapter.start();
    const calls = (await readFile(join(cwd, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    pid = calls.find(call => call.method === 'spawn').pid;
    expect(alive(pid!)).toBe(true);
    if (kind === 'forced-exit') {
      const launcher = [...(adapter as any).processes.keys()][0];
      launcher.kill('SIGKILL');
      await expect.poll(() => launcher.signalCode).toBe('SIGKILL');
      await adapter.stop();
      expect(await adapter.isStopped()).toBe(false);
      return;
    }
    await adapter.stop();
    expect(await adapter.isStopped()).toBe(true);
    expect(alive(pid!)).toBe(false);
    const stored = await createRuntimeStore({ stateDir: join(cwd, '.dutydeck', 'acpx') }).load(sessionKey);
    const env = stored?.acpx?.session_options?.env ?? {};
    expect(Object.keys(env).every(key => /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(key))).toBe(true);
    expect(env.dutydeck_group_tools_token).toBe('fixture-token');
    expect(env).not.toHaveProperty('VENDOR_FIXTURE');
  } finally {
    if (pid && alive(pid)) process.kill(pid, 'SIGKILL');
    await adapter.stop().catch(() => {});
    await rm(cwd, { recursive: true, force: true });
  }
});
