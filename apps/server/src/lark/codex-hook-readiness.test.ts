import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { agentConfigSchema } from '@dutydeck/shared';
import { installLarkHook, larkHookStatus } from './security-hooks.js';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'dutydeck-native-hook-')); directories.push(directory);
  const home = join(directory, 'home'), workspace = join(directory, 'workspace');
  await mkdir(home); await mkdir(workspace);
  const agent = agentConfigSchema.parse({ id: 'codex-acp', name: 'Codex (ACP)', command: 'npx', protocol: 'acp', env: { CODEX_PATH: resolve('tests/fixtures/mock-codex-hooks.mjs'), CODEX_HOME: home } });
  const state = (value: unknown) => writeFile(join(home, 'hooks-probe-state.json'), JSON.stringify(value));
  const status = () => larkHookStatus(agent.id, workspace, agent);
  return { directory, home, workspace, agent, state, status };
}

it('requires project loading and trust of the current generated hook, without caching successful checks', async () => {
  const f = await fixture();
  expect(await installLarkHook(f.agent.id, f.workspace, f.agent)).toMatchObject({ installed: true, nativeReady: false, reason: expect.stringContaining('项目信任') });
  await f.state({ projectTrusted: true });
  expect(await f.status()).toMatchObject({ installed: true, nativeReady: false, reason: expect.stringContaining('尚未受信任') });
  await f.state({ projectTrusted: true, hookTrustStatus: 'trusted' });
  expect(await f.status()).toMatchObject({ agentId: 'codex-acp', installed: true, nativeReady: true, trustRequired: false });
  expect(await larkHookStatus('codex', f.workspace, { ...f.agent, id: 'codex' })).toMatchObject({ nativeReady: true });
  await f.state({ projectTrusted: true, hookTrustStatus: 'modified' });
  expect(await f.status()).toMatchObject({ nativeReady: false });
});

it.each([
  { enabled: false }, { emptyHash: true }, { missingHook: true }, { rpcError: true },
  { hookOverride: { command: 'some other command' } }, { hookOverride: { matcher: 'Read' } },
  { hookOverride: { sourcePath: '/wrong/hooks.json' } }, { hookTrustStatus: 'unknown' }
])('fails closed for an unusable native hook: %j', async invalid => {
  const f = await fixture();
  await installLarkHook(f.agent.id, f.workspace, f.agent);
  await f.state({ projectTrusted: true, hookTrustStatus: 'trusted', ...invalid });
  expect(await f.status()).toMatchObject({ installed: true, nativeReady: false });
});

it('accepts the same physical workspace through a symlink and never sends a model request', async () => {
  const f = await fixture();
  const alias = join(f.directory, 'workspace-alias'), report = join(f.directory, 'rpc.jsonl');
  await symlink(f.workspace, alias);
  await f.state({ projectTrusted: true, hookTrustStatus: 'trusted', report });
  expect(await installLarkHook(f.agent.id, alias, f.agent)).toMatchObject({ nativeReady: true });
  const methods = (await readFile(report, 'utf8')).trim().split('\n').map(line => JSON.parse(line).method);
  expect(methods).toEqual(['initialize', 'config/read', 'hooks/list']);
});

it('terminates an unresponsive metadata process at the deadline', async () => {
  const f = await fixture();
  await installLarkHook(f.agent.id, f.workspace, f.agent);
  const report = join(f.directory, 'rpc.jsonl');
  await f.state({ hang: true, report });
  expect(await f.status()).toMatchObject({ installed: true, nativeReady: false, reason: expect.stringContaining('超时') });
  const [{ pid }] = (await readFile(report, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  await expect.poll(() => { try { process.kill(pid, 0); return false; } catch { return true; } }).toBe(true);
});

it.runIf(process.env.DUTYDECK_CODEX_NATIVE_TESTS === 'true')('checks a real Codex project, current hook trust and modified hash without a model turn', async () => {
  const f = await fixture();
  const agent = { ...f.agent, env: { CODEX_PATH: process.env.DUTYDECK_TEST_CODEX_PATH || 'codex', CODEX_HOME: f.home } };
  const status = await installLarkHook(agent.id, f.workspace, agent);
  expect(status).toMatchObject({ installed: true, nativeReady: false, reason: expect.stringContaining('项目信任') });
  const project = `[projects.${JSON.stringify(f.workspace)}]\ntrust_level="trusted"\n`;
  await writeFile(join(f.home, 'config.toml'), project);
  expect(await larkHookStatus(agent.id, f.workspace, agent)).toMatchObject({ nativeReady: false, reason: expect.stringContaining('尚未受信任') });
  // Trust only this generated hook in the isolated test account, using the
  // native key/hash rather than reproducing Codex's hashing implementation.
  const child = spawn(agent.env.CODEX_PATH, ['app-server'], { cwd: f.workspace, env: { ...process.env, ...agent.env }, stdio: ['pipe', 'pipe', 'ignore'] });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let metadata: any;
  try {
    metadata = await new Promise<any>((resolveMetadata, reject) => {
      timer = setTimeout(() => reject(new Error('Native hook metadata timeout')), 5_000);
      child.once('error', reject);
      const send = (id: number, method: string, params: unknown) => child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      createInterface({ input: child.stdout }).on('line', line => {
        const message = JSON.parse(line);
        if (message.error) return reject(new Error(JSON.stringify(message.error)));
        if (message.id === 1) {
          child.stdin.write('{"method":"initialized","params":{}}\n');
          send(2, 'hooks/list', { cwds: [f.workspace] });
        } else if (message.id === 2) resolveMetadata(message.result.data[0].hooks.find((hook: any) => hook.command?.includes('dutydeck-lark-high-risk-guard-codex.mjs')));
      });
      send(1, 'initialize', { clientInfo: { name: 'dutydeck-hook-test', version: '1' }, capabilities: { experimentalApi: true } });
    });
  } finally { clearTimeout(timer); child.kill('SIGKILL'); child.stdin.destroy(); child.stdout.destroy(); }
  expect(metadata.currentHash).toBeTruthy();
  await writeFile(join(f.home, 'config.toml'), `${project}\n[hooks.state.${JSON.stringify(metadata.key)}]\ntrusted_hash=${JSON.stringify(metadata.currentHash)}\n`);
  expect(await larkHookStatus(agent.id, f.workspace, agent)).toMatchObject({ nativeReady: true, trustRequired: false });
  const hooksPath = join(f.workspace, '.codex', 'hooks.json');
  const changed = JSON.parse(await readFile(hooksPath, 'utf8'));
  changed.hooks.PreToolUse[0].hooks[0].statusMessage = 'Changed current hook definition';
  await writeFile(hooksPath, JSON.stringify(changed));
  expect(await larkHookStatus(agent.id, f.workspace, agent)).toMatchObject({ nativeReady: false });
});
