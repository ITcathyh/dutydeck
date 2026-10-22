import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import { DutydeckRuntime } from '@dutydeck/runtime';
import { PTY_AGENT_CONTRIBUTIONS } from '../../pty-driver/src/contributions.js';
import { toPublicAgent } from '@dutydeck/shared';
import { commandExists } from '@dutydeck/transports';

afterEach(() => vi.unstubAllEnvs());

it.each(['override', 'path'])('registers and versions the executable Codex used at launch (%s)', async source => {
  const cwd = await mkdtemp(join(tmpdir(), 'dutydeck-codex-discovery-'));
  const executable = join(cwd, 'codex');
  await writeFile(executable, '#!/bin/sh\necho "Codex discovery fixture 1.0"\n', { mode: 0o755 });
  vi.stubEnv('PATH', source === 'path' ? cwd : '');
  vi.stubEnv('CODEX_PATH', source === 'override' ? executable : undefined);
  vi.resetModules();
  const { loadConfigWithDiagnostics, agentProbeTarget } = await import('./index.js');
  const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' });
  const runtime = new DutydeckRuntime(repos);
  try {
    expect(commandExists('codex')).toBe(source === 'path');
    const { config } = loadConfigWithDiagnostics({ DUTYDECK_DEFAULT_CWD: cwd });
    const discovered = config.agents.find(agent => agent.id === 'codex');
    expect(discovered).toMatchObject({ id: 'codex', protocol: 'acp', builtin: true, version: 'Codex discovery fixture 1.0' });
    expect(agentProbeTarget(discovered!)).toEqual({ command: source === 'override' ? executable : 'codex', execute: true });
    await repos.agents.save({ ...discovered!, version: 'previous-version' });
    await runtime.initialize(config.agents);
    expect(await repos.agents.get('codex')).toMatchObject({ id: 'codex', version: 'Codex discovery fixture 1.0' });
  } finally { await runtime.shutdown(); repos.close(); await rm(cwd, { recursive: true, force: true }); }
});

it('uses an explicit config CODEX_PATH for both terminal entries, their versions and launch command', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dutydeck-codex-terminal-discovery-'));
  const executable = join(cwd, 'custom-codex');
  await writeFile(executable, '#!/bin/sh\necho "Codex terminal fixture 2.0"\n', { mode: 0o755 });
  vi.stubEnv('PATH', '');
  vi.stubEnv('CODEX_PATH', undefined);
  vi.resetModules();
  try {
    const { loadConfig, agentProbeTarget } = await import('./index.js');
    const env = { CODEX_PATH: executable, DUTYDECK_DEFAULT_CWD: cwd };
    const agents = loadConfig(env, PTY_AGENT_CONTRIBUTIONS).agents;
    for (const id of ['codex', 'codex-cli']) {
      expect(agents.find(agent => agent.id === id)).toMatchObject({ protocol: 'pty-cli', command: executable, version: 'Codex terminal fixture 2.0' });
    }
    const acp = agents.find(agent => agent.id === 'codex-acp')!;
    expect(acp).toMatchObject({ name: 'Codex (ACP)', protocol: 'acp', builtin: true, version: 'Codex terminal fixture 2.0' });
    expect(toPublicAgent(acp)).toMatchObject({ remoteApproval: true });
    expect(agentProbeTarget({ ...acp, env: { CODEX_PATH: executable } })).toEqual({ command: executable, execute: true });
    expect(loadConfig({ ...env, CODEX_PATH: '/missing/codex' }, PTY_AGENT_CONTRIBUTIONS).agents.some(agent => ['codex', 'codex-cli', 'codex-acp'].includes(agent.id))).toBe(false);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
