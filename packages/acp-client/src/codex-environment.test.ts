import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, delimiter, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { createRuntimeStore } from 'acpx/runtime';
import { AcpxAdapter } from './index.js';

afterEach(() => vi.unstubAllEnvs());

it.each(['path', 'agent', 'parent'])('uses the user Codex across real ACP launches and resume (path source: %s)', async source => {
  const cwd = await mkdtemp(join(tmpdir(), 'dd-codex-environment-'));
  const bin = join(cwd, 'user bin'), nextBin = join(cwd, 'next bin'), bundled = join(cwd, 'bundled');
  await mkdir(bin); await mkdir(nextBin); await mkdir(bundled);
  const output = join(cwd, 'versions.jsonl');
  const executable = join(bin, 'codex');
  const launcher = resolve('packages/acp-client/agents/launcher-process.mjs');
  const fixture = resolve('tests/fixtures/mock-acp-agent.mjs');
  const npx = join(bin, 'npx');
  await writeFile(npx, `#!${process.execPath}\nconst {launchAgent}=await import(${JSON.stringify(launcher)});launchAgent(process.env.CODEX_PATH||'codex',['app-server'],{...process.env,PATH:${JSON.stringify(bundled + delimiter)}+process.env.PATH});\n`);
  await chmod(npx, 0o755);
  await writeFile(join(bundled, 'codex'), `#!${process.execPath}\nthrow new Error('bundled Codex must not run');\n`);
  await chmod(join(bundled, 'codex'), 0o755);
  const config = {
    id: 'codex', name: 'Codex', command: npx, args: ['-y', '@agentclientprotocol/codex-acp@^1.1.5'],
    protocol: 'acp' as const, cwd, env: { probe_output: output, ...(source === 'agent' ? { CODEX_PATH: executable } : {}) },
    permissionMode: 'ask' as const, timeout: 10, capabilities: { pause: false, resume: true }, builtin: true
  };
  vi.stubEnv('PATH', source === 'path' ? bin : dirname(process.execPath));
  vi.stubEnv('CODEX_PATH', source === 'parent' ? executable : undefined);
  vi.stubEnv('CODEX_HOME', join(cwd, 'user config'));
  const store = createRuntimeStore({ stateDir: join(cwd, '.dutydeck', 'acpx') });
  let adapter: AcpxAdapter | undefined;
  let nativeId: string | undefined;
  try {
    for (const version of ['user-v1', 'user-v2']) {
      const selected = source === 'path' && version === 'user-v2' ? join(nextBin, 'codex') : executable;
      if (source === 'path') vi.stubEnv('PATH', dirname(selected));
      await writeFile(selected, `#!${process.execPath}\nimport {appendFileSync} from 'node:fs';appendFileSync(process.env.probe_output,JSON.stringify({version:${JSON.stringify(version)},executable:process.env.CODEX_PATH,configHome:process.env.CODEX_HOME})+'\\n');await import(${JSON.stringify(fixture)});\n`);
      await chmod(selected, 0o755);
      const events: any[] = [];
      adapter = new AcpxAdapter(config, { sessionKey: 'user-codex-persistent', onEvent: event => events.push(event) });
      await adapter.start(); await adapter.send('hello'); await adapter.stop();
      expect(events.some(event => event.type === 'text' && event.data.text.includes('Mock reply'))).toBe(true);
      const record = (await store.load('user-codex-persistent'))!;
      const env = record.acpx?.session_options?.env ?? {};
      expect(Object.keys(env).every(key => /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(key))).toBe(true);
      expect(env).not.toHaveProperty('CODEX_PATH');
      if (nativeId) expect(record.acpSessionId).toBe(nativeId);
      else nativeId = record.acpSessionId;
    }
    const reports = (await readFile(output, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(reports).toEqual(['user-v1', 'user-v2'].map(version => ({ version,
      executable: source === 'path' && version === 'user-v2' ? join(nextBin, 'codex') : executable,
      configHome: join(cwd, 'user config') })));
    expect(process.env.CODEX_PATH).toBe(source === 'parent' ? executable : undefined);
  } finally { await adapter?.stop(); await rm(cwd, { recursive: true, force: true }); }
});

it('reports a missing user Codex before starting the bundled executable', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dd-missing-codex-'));
  vi.stubEnv('PATH', cwd); vi.stubEnv('CODEX_PATH', undefined);
  const adapter = new AcpxAdapter({
    id: 'codex', name: 'Codex', command: process.execPath, args: [resolve('tests/fixtures/mock-acp-agent.mjs')],
    protocol: 'acp', cwd, env: {}, permissionMode: 'ask', timeout: 10, capabilities: { pause: false, resume: true }, builtin: true
  }, { sessionKey: 'missing-user-codex', onEvent() {} });
  try { await expect(adapter.start()).rejects.toThrow('CODEX_CLI_NOT_FOUND'); }
  finally { await adapter.stop(); await rm(cwd, { recursive: true, force: true }); }
});
