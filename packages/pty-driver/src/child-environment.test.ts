import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { HerdrBackend, PtyBackend, TmuxBackend, herdrControlEnvironment } from '@dutydeck/session-backends';
import { childProcessIdentity, observeProcess } from '@dutydeck/storage';
import { PtyCliDriver } from './driver.js';

afterEach(() => vi.unstubAllEnvs());

const cases: Array<['pty' | 'tmux' | 'herdr', boolean]> = [['pty', false], ['tmux', false], ['tmux', true]];
if (process.env.DUTYDECK_TEST_HERDR === 'true') cases.push(['herdr', false]);
it.each(cases)('isolates real %s children, including stale tmux server values (empty PATH: %s)', async (kind, emptyPath) => {
  const cwd = mkdtempSync(join(tmpdir(), 'dd-child-pty-'));
  const herdrSession = `dutydeck-${randomBytes(16).toString('hex')}`;
  vi.stubEnv('TMUX_TMPDIR', cwd);
  const identityBin = join(cwd, 'cli-identity', 'old.bin');
  const inherited = {
    BOTMUX_SESSION_ID: 'sentinel-old-session', BOTMUX_OWNER_OPEN_ID: 'sentinel-owner',
    BOTMUX_IDENTITY_BIN: identityBin, BYTEDCLI_USER_CLOUD_JWT: 'sentinel-user',
    LARKSUITE_CLI_USER_ACCESS_TOKEN: 'sentinel-lark', LARK_APP_SECRET: 'sentinel-host',
    DUTYDECK_CODEBASE_WEBHOOK_SECRET: 'sentinel-webhook', dutydeck_group_tools_token: 'sentinel-old-scope',
    dutydeck_relay_token: 'sentinel-old-relay', dutydeck_session_id: 'sentinel-old-id',
    ANTHROPIC_API_KEY: 'sentinel-daemon-account', HERDR_PANE_ID: 'sentinel:p1',
    HTTP_PROXY: 'http://sentinel-proxy', NODE_EXTRA_CA_CERTS: '/nonexistent/sentinel-cert',
    PATH: `${process.env.PATH}:${join(cwd, "tool path with 'quote'")}:${identityBin}`,
    GIT_ASKPASS: `${identityBin}/askpass`, BASH_ENV: `${identityBin}/bash`, ZDOTDIR: identityBin,
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: 'sentinel-wrapper'
  };
  for (const [key, value] of Object.entries(inherited)) vi.stubEnv(key, value);
  let driver: PtyCliDriver | undefined;
  try {
    if (kind === 'tmux') {
      // Seed a server before sanitizing the child snapshot. These values must
      // stay absent even if the spawning daemon no longer carries them.
      execFileSync('tmux', ['new-session', '-d', '-s', 'env-seed', 'sleep 60']);
      execFileSync('tmux', ['set-environment', '-g', 'DUTYDECK_SERVER_ONLY_SECRET', 'sentinel-tmux-only']);
    }
    const output = join(cwd, 'env.json'), script = join(cwd, 'cli.mjs');
    const keys = [...Object.keys(inherited), 'DUTYDECK_SERVER_ONLY_SECRET', 'dutydeck_herdr_session'];
    const pidFile = join(cwd, 'pid');
    writeFileSync(script, `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(output)},JSON.stringify(Object.fromEntries(${JSON.stringify(keys)}.filter(key=>process.env[key]!==undefined).map(key=>[key,process.env[key]]))));writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.stdout.write('READY\\n');setInterval(()=>{},1000);`);
    const env = { BYTEDCLI_USER_CLOUD_JWT: 'explicit-account', ANTHROPIC_API_KEY: 'explicit-vendor', dutydeck_group_tools_token: 'current-scope', dutydeck_relay_token: 'current-relay', dutydeck_herdr_session: 'current-herdr', ...(emptyPath ? { PATH: '' } : {}) };
    const backend = kind === 'tmux' ? new TmuxBackend(`dd-env-${process.pid}`, { ownerId: 'env-test' })
      : kind === 'herdr' ? new HerdrBackend(herdrSession, { binary: execFileSync('/bin/sh', ['-c', 'command -v herdr'], { encoding: 'utf8' }).trim(), stateFile: join(cwd, 'herdr.json'), ownerId: 'env-test', processProbe: { identify: childProcessIdentity, observe: observeProcess } }) : new PtyBackend();
    driver = new PtyCliDriver({
      agent: { id: 'fixture', name: 'Fixture', command: process.execPath, args: [], protocol: 'pty-cli', cwd, env, permissionMode: 'ask', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false },
      adapter: { id: 'fixture', capabilities: { resume: true }, buildArgs: () => [script], writeInput() {}, completionPattern: /DONE/ },
      backend,
      onEvent() {}, onExit() {}, sessionId: 'ses_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    });
    await driver.start();
    await expect.poll(() => JSON.parse(readFileSync(output, 'utf8'))).toEqual({
      BYTEDCLI_USER_CLOUD_JWT: 'explicit-account', ANTHROPIC_API_KEY: 'explicit-vendor',
      dutydeck_group_tools_token: 'current-scope', dutydeck_relay_token: 'current-relay', dutydeck_herdr_session: 'current-herdr',
      HTTP_PROXY: inherited.HTTP_PROXY, NODE_EXTRA_CA_CERTS: inherited.NODE_EXTRA_CA_CERTS,
      PATH: emptyPath ? '' : inherited.PATH.split(':').filter(value => value !== identityBin).join(':'),
      ...(kind === 'herdr' ? { HERDR_PANE_ID: expect.not.stringMatching(/^sentinel:/) } : {})
    });
    expect(await backend.getPid()).toBe(Number(readFileSync(pidFile, 'utf8')));
    for (const [key, value] of Object.entries(inherited)) expect(process.env[key]).toBe(value);
  } finally {
    await driver?.stop();
    if (kind === 'tmux') execFileSync('tmux', ['kill-server']);
    if (kind === 'herdr') {
      try { execFileSync('herdr', ['session', 'delete', herdrSession, '--json'], { env: herdrControlEnvironment(process.env), stdio: 'pipe' }); } catch { /* owned fixture cleanup */ }
    }
    rmSync(cwd, { recursive: true, force: true });
  }
});
