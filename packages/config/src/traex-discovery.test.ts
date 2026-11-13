import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { agentConfigSchema, toPublicAgent } from '@dutydeck/shared';
import { PTY_AGENT_CONTRIBUTIONS } from '../../pty-driver/src/contributions.js';

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function fixture(installed = true) {
  const directory = await mkdtemp(join(tmpdir(), 'dutydeck-traex-discovery-'));
  directories.push(directory);
  const command = join(directory, 'traex');
  if (installed) await writeFile(command, `#!/bin/sh\necho "$*" >> '${command}.log'\necho 'TRAE discovery fixture 1.0'\n`, { mode: 0o755 });
  vi.stubEnv('PATH', directory);
  vi.stubEnv('CODEX_PATH', undefined);
  vi.resetModules();
  return { directory, command, ...(await import('./index.js')) };
}

it('discovers a separate native ACP entry alongside the terminal and probes their shared CLI once', async () => {
  const h = await fixture();
  const { config } = await h.loadConfigWithDiagnosticsAsync({ DUTYDECK_DEFAULT_CWD: h.directory }, PTY_AGENT_CONTRIBUTIONS);
  const terminal = config.agents.find(agent => agent.id === 'traex');
  const acp = config.agents.find(agent => agent.id === 'traex-acp');
  expect(terminal).toMatchObject({ command: 'traex', args: [], protocol: 'pty-cli', builtin: true });
  expect(acp).toMatchObject({ name: 'TRAE (ACP)', command: 'traex', args: ['acp', 'serve'], protocol: 'acp', builtin: true,
    permissionMode: 'ask', cwd: h.directory, version: 'TRAE discovery fixture 1.0' });
  expect(toPublicAgent(acp!)).toMatchObject({ id: 'traex-acp', protocol: 'acp', remoteApproval: true });
  expect(h.agentProbeTarget(acp!)).toEqual({ command: 'traex', execute: true });
  expect((await readFile(`${h.command}.log`, 'utf8')).trim().split('\n')).toEqual(['--version']);
});

it('does not register the native ACP entry when the Traex executable is missing', async () => {
  const h = await fixture(false);
  const config = h.loadConfig({}, PTY_AGENT_CONTRIBUTIONS);
  expect(config.agents.some(agent => agent.id === 'traex' || agent.id === 'traex-acp')).toBe(false);
});

it('reserves the builtin ACP entry against plugin replacement and preserves an explicit user override', async () => {
  const h = await fixture();
  const replacement = agentConfigSchema.parse({ id: 'traex-acp', name: 'Custom TRAE', command: process.execPath,
    args: ['custom-acp.mjs'], protocol: 'acp', permissionMode: 'deny-all' });
  const plugin = h.loadConfig({}, PTY_AGENT_CONTRIBUTIONS, [replacement]);
  expect(plugin.agents.find(agent => agent.id === 'traex-acp')).toMatchObject({ command: 'traex', args: ['acp', 'serve'], builtin: true });
  const explicit = h.loadConfig({ DUTYDECK_AGENTS_JSON: JSON.stringify([replacement]) }, PTY_AGENT_CONTRIBUTIONS, [replacement]);
  expect(explicit.agents.find(agent => agent.id === 'traex-acp')).toMatchObject({ ...replacement, builtin: false });
  expect(explicit.agents.find(agent => agent.id === 'traex')).toMatchObject({ command: 'traex', protocol: 'pty-cli', builtin: true });
});
