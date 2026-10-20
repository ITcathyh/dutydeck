import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import { DutydeckRuntime } from '@dutydeck/runtime';
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
