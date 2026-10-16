import { execFile } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

it.skipIf(process.platform === 'win32')('never probes Seed or Relay by default, but preserves explicit custom registration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dutydeck-agent-discovery-'));
  const probes = join(directory, 'probes.jsonl');
  try {
    for (const name of ['seed', 'relay']) {
      const file = join(directory, name);
      await writeFile(file, `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(probes)}, JSON.stringify(process.argv.slice(2)) + '\\n');\nconsole.log('fixture 1.0');\n`);
      await chmod(file, 0o700);
    }
    const script = `
      import { existsSync } from 'node:fs';
      const { loadConfigWithDiagnostics } = await import(${JSON.stringify(new URL('../../config/src/index.ts', import.meta.url).href)});
      const { PTY_AGENT_CONTRIBUTIONS } = await import(${JSON.stringify(new URL('./contributions.ts', import.meta.url).href)});
      const defaults = loadConfigWithDiagnostics({}, PTY_AGENT_CONTRIBUTIONS).config.agents;
      const defaultProbed = existsSync(${JSON.stringify(probes)});
      const agents = ['seed', 'relay'].map(id => ({ id, name: id, command: id, protocol: 'pty-cli', adapterId: id }));
      const configured = loadConfigWithDiagnostics({ DUTYDECK_AGENTS_JSON: JSON.stringify(agents) }, PTY_AGENT_CONTRIBUTIONS).config.agents;
      console.log(JSON.stringify({ defaults, defaultProbed, configured, configuredProbed: existsSync(${JSON.stringify(probes)}) }));
    `;
    const { stdout } = await promisify(execFile)(process.execPath, ['--conditions=development', '--import', 'tsx', '--input-type=module', '--eval', script], {
      env: { PATH: directory, HOME: directory, NODE_ENV: 'test' }
    });
    const result = JSON.parse(stdout);
    expect(result.defaults).toEqual([]);
    expect(result.defaultProbed).toBe(false);
    expect(result.configuredProbed).toBe(false);
    expect(result.configured).toEqual(['seed', 'relay'].map(id => expect.objectContaining({ id, command: id, adapterId: id, builtin: false })));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
