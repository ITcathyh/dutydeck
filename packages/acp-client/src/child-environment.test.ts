import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createRuntimeStore } from 'acpx/runtime';
import { childEnvironment } from '@dutydeck/shared/child-environment';
import { AcpxAdapter, prepareAcpxAgentLaunch } from './index.js';

afterEach(() => vi.unstubAllEnvs());

it.each([false, true])('isolates real persisted ACP launches and resume (uppercase account: %s)', async uppercase => {
  const cwd = await mkdtemp(join(tmpdir(), 'dd-child-acp-'));
  const output = join(cwd, 'env.jsonl');
  const fixture = join(cwd, 'agent.mjs');
  const inherited = {
    BOTMUX_SESSION_ID: 'sentinel-old', BYTEDCLI_USER_CLOUD_JWT: 'sentinel-user',
    LARKSUITE_CLI_USER_ACCESS_TOKEN: 'sentinel-lark', LARK_APP_SECRET: 'sentinel-host',
    DUTYDECK_CODEBASE_WEBHOOK_SECRET: 'sentinel-webhook', dutydeck_group_tools_token: 'sentinel-old-scope',
    dutydeck_relay_token: 'sentinel-old-relay', dutydeck_session_id: 'sentinel-old-session',
    HTTP_PROXY: 'http://sentinel-proxy', NODE_EXTRA_CA_CERTS: '/nonexistent/sentinel-cert',
    HERDR_PANE_ID: 'sentinel:p1', ANTHROPIC_API_KEY: 'sentinel-acp-account'
  };
  for (const [key, value] of Object.entries(inherited)) vi.stubEnv(key, value);
  const keys = [...Object.keys(inherited), 'dutydeck_herdr_session', 'dutydeck_agent_env_file', 'dutydeck_agent_env_digest'];
  await writeFile(fixture, `import {appendFileSync} from 'node:fs';appendFileSync(process.env.env_report_output,JSON.stringify(Object.fromEntries(${JSON.stringify(keys)}.filter(key=>process.env[key]!==undefined).map(key=>[key,process.env[key]])))+'\\n');await import(${JSON.stringify(resolve('tests/fixtures/mock-acp-agent.mjs'))});`);
  const env = {
    env_report_output: output, dutydeck_group_tools_token: 'current-scope',
    dutydeck_relay_token: 'current-relay', dutydeck_herdr_session: 'current-herdr',
    ...(uppercase ? { BYTEDCLI_USER_CLOUD_JWT: 'explicit-account', ANTHROPIC_API_KEY: 'explicit-vendor' } : {})
  };
  const config = { id: 'env-fixture', name: 'Fixture', command: process.execPath, args: [fixture], protocol: 'acp' as const, cwd, env, permissionMode: 'deny-all' as const, timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };
  const sessionKey = `env-persistent-${uppercase}`;
  let adapter: AcpxAdapter | undefined;
  let nativeSessionId: string | undefined;
  try {
    for (let launch = 0; launch < 2; launch++) {
      adapter = new AcpxAdapter(config, { sessionKey, onEvent() {} });
      await adapter.start();
      await adapter.send('hello');
      await adapter.stop();
      const store = createRuntimeStore({ stateDir: join(cwd, '.dutydeck', 'acpx') });
      const record = await store.load(sessionKey);
      const persisted = record?.acpx?.session_options?.env ?? {};
      expect(Object.keys(persisted).every(key => /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(key))).toBe(true);
      expect(JSON.stringify(persisted)).not.toContain('explicit-account');
      expect(persisted.dutydeck_group_tools_token).toBe('current-scope');
      if (launch === 0) {
        nativeSessionId = record!.acpSessionId;
      } else expect(record!.acpSessionId).toBe(nativeSessionId);
    }
    const reports = (await readFile(output, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(reports.length).toBeGreaterThanOrEqual(2);
    for (const report of reports) expect(report).toEqual({
      HTTP_PROXY: inherited.HTTP_PROXY, NODE_EXTRA_CA_CERTS: inherited.NODE_EXTRA_CA_CERTS,
      dutydeck_group_tools_token: 'current-scope', dutydeck_relay_token: 'current-relay', dutydeck_herdr_session: 'current-herdr',
      ANTHROPIC_API_KEY: uppercase ? 'explicit-vendor' : inherited.ANTHROPIC_API_KEY,
      ...(uppercase ? { BYTEDCLI_USER_CLOUD_JWT: 'explicit-account' } : {})
    });
    for (const [key, value] of Object.entries(inherited)) expect(process.env[key]).toBe(value);
  } finally {
    await adapter?.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

it('refuses a persisted bridge from another release before altering its native record', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dd-old-release-acp-'));
  vi.stubEnv('HERDR_PANE_ID', 'sentinel-old-pane');
  const config = { id: 'release-fixture', name: 'Release', command: process.execPath, args: [resolve('tests/fixtures/mock-acp-agent.mjs')], protocol: 'acp' as const, cwd, env: {}, permissionMode: 'deny-all' as const, timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };
  const sessionKey = 'old-release-persistent';
  let adapter: AcpxAdapter | undefined;
  try {
    const store = createRuntimeStore({ stateDir: join(cwd, '.dutydeck', 'acpx') });
    adapter = new AcpxAdapter(config, { sessionKey, onEvent() {} });
    await adapter.start(); await adapter.send('hello'); await adapter.stop();
    const record = (await store.load(sessionKey))!;
    const originalLauncher = record.agentArgv![1]!;
    const oldRelease = join(cwd, 'old-release');
    await mkdir(oldRelease);
    await copyFile(originalLauncher, join(oldRelease, 'env-launcher.mjs'));
    await copyFile(join(dirname(originalLauncher), 'launcher-process.mjs'), join(oldRelease, 'launcher-process.mjs'));
    await copyFile(resolve('packages/shared/runtime/child-environment.mjs'), join(oldRelease, 'child-environment.mjs'));
    record.agentArgv![1] = join(oldRelease, 'env-launcher.mjs');
    record.agentCommand = record.agentCommand.replace(originalLauncher, record.agentArgv![1]!);
    await store.save(record);
    const before = await store.load(sessionKey);
    adapter = new AcpxAdapter(config, { sessionKey, onEvent() {} });
    await expect(adapter.start()).rejects.toThrow('ACP_LAUNCHER_VERSION_CHANGED');
    expect(await store.load(sessionKey)).toEqual(before);
    expect((await store.load(sessionKey))!.acpSessionId).toBe(record.acpSessionId);
    expect((await store.load(sessionKey))!.acpx?.reset_on_next_ensure).toBe(before!.acpx?.reset_on_next_ensure);
  } finally { await adapter?.stop(); await rm(cwd, { recursive: true, force: true }); }
});

it('retains the real empty-bridge native session after the ambient environment becomes clean', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dd-empty-bridge-acp-'));
  const clean = childEnvironment(process.env);
  for (const [key, value] of Object.entries(process.env)) if (clean[key] !== value) vi.stubEnv(key, clean[key]);
  vi.stubEnv('HERDR_PANE_ID', 'sentinel-old-pane');
  const config = { id: 'bridge-fixture', name: 'Bridge', command: process.execPath, args: [resolve('tests/fixtures/mock-acp-agent.mjs')], protocol: 'acp' as const, cwd, env: { dutydeck_group_tools_token: 'current-scope' }, permissionMode: 'deny-all' as const, timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };
  const sessionKey = 'empty-bridge-persistent';
  let adapter: AcpxAdapter | undefined;
  try {
    const store = createRuntimeStore({ stateDir: join(cwd, '.dutydeck', 'acpx') });
    adapter = new AcpxAdapter(config, { sessionKey, onEvent() {} });
    await adapter.start(); await adapter.send('hello'); await adapter.stop();
    const original = (await store.load(sessionKey))!;
    expect(original.agentArgv![1]).toContain('env-launcher.mjs');
    vi.stubEnv('HERDR_PANE_ID', undefined);
    adapter = new AcpxAdapter(config, { sessionKey, onEvent() {} });
    await adapter.start(); await adapter.send('hello again'); await adapter.stop();
    const restored = (await store.load(sessionKey))!;
    expect(restored.agentArgv).toEqual(original.agentArgv);
    expect(restored.acpSessionId).toBe(original.acpSessionId);
    expect(restored.acpx!.session_options!.env).toEqual(original.acpx!.session_options!.env);
  } finally { await adapter?.stop(); await rm(cwd, { recursive: true, force: true }); }
});

it('preserves clean direct ACP argv on resume and refuses a dirty upgrade without dropping context', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dd-clean-direct-acp-'));
  // Make the ambient environment deterministic without writing it in production.
  const clean = childEnvironment(process.env);
  for (const [key, value] of Object.entries(process.env)) if (clean[key] !== value) vi.stubEnv(key, clean[key]);
  const config = { id: 'direct-fixture', name: 'Direct', command: process.execPath, args: [resolve('tests/fixtures/mock-acp-agent.mjs')], protocol: 'acp' as const, cwd, env: { dutydeck_group_tools_token: 'current-scope' }, permissionMode: 'deny-all' as const, timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };
  const sessionKey = 'clean-direct-persistent';
  let adapter: AcpxAdapter | undefined;
  try {
    const launch = prepareAcpxAgentLaunch(config, { sessionKey, runtimeDirectory: join(cwd, 'runtime-env') });
    expect(launch.command).toEqual([config.command, ...config.args]);
    expect(launch.sessionOptions.env).toEqual(config.env);
    launch.cleanup();
    const store = createRuntimeStore({ stateDir: join(cwd, '.dutydeck', 'acpx') });
    let nativeSessionId: string | undefined;
    for (let pass = 0; pass < 2; pass++) {
      adapter = new AcpxAdapter(config, { sessionKey, onEvent() {} });
      await adapter.start(); await adapter.send('hello'); await adapter.stop();
      const record = await store.load(sessionKey);
      expect(record!.agentArgv).toEqual([config.command, ...config.args]);
      expect(record!.acpx!.session_options!.env).toEqual(config.env);
      if (pass === 0) nativeSessionId = record!.acpSessionId;
      else expect(record!.acpSessionId).toBe(nativeSessionId);
    }
    // Direct handles can reconnect for a subsequent turn. Detect environment
    // changes after construction/start before ACPX gets another spawn chance.
    adapter = new AcpxAdapter(config, { sessionKey, onEvent() {} });
    await adapter.start();
    vi.stubEnv('BOTMUX_SESSION_ID', 'sentinel-late-identity');
    await expect(adapter.send('must not be submitted')).rejects.toThrow('ACP_ENVIRONMENT_BOUNDARY_CHANGED');
    expect((await store.load(sessionKey))!.acpSessionId).toBe(nativeSessionId);
    await adapter.stop();
    vi.stubEnv('BOTMUX_SESSION_ID', undefined);
    vi.stubEnv('LARK_APP_SECRET', 'sentinel-dirty-host');
    adapter = new AcpxAdapter(config, { sessionKey, onEvent() {} });
    await expect(adapter.start()).rejects.toThrow('ACP_ENVIRONMENT_BOUNDARY_CHANGED');
    expect((await store.load(sessionKey))!.acpSessionId).toBe(nativeSessionId);
    expect((await store.load(sessionKey))!.agentArgv).toEqual([config.command, ...config.args]);
    expect(process.env.LARK_APP_SECRET).toBe('sentinel-dirty-host');
  } finally { await adapter?.stop(); await rm(cwd, { recursive: true, force: true }); }
});
