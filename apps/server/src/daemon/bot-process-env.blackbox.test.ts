import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { afterEach, expect, it } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import { renderBotProcessEnv } from '../../../../scripts/split-bot-runtimes.mts';
import { defaultDaemonDir, inspectDaemon, lastDaemonDirPointerFile, readDaemonStatus, writeLastDaemonDir } from './daemon.js';

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const cli = join(workspace, 'apps/server/src/cli.ts');
const loader = join(workspace, 'node_modules/tsx/dist/loader.mjs');
let root: string | undefined;
let env: NodeJS.ProcessEnv;
let shard: string;
function invoke(action: string, args: string[] = []) {
  return spawnSync(process.execPath, ['--conditions=development', '--import', loader, cli, action, ...args, '--json'], {
    cwd: shard, env, encoding: 'utf8', timeout: 25_000
  });
}
afterEach(() => {
  if (!root) return;
  if (inspectDaemon(defaultDaemonDir(shard)).status === 'verified') {
    const stopped = invoke('stop');
    if (stopped.status !== 0 && inspectDaemon(defaultDaemonDir(shard)).status === 'verified') process.kill(readDaemonStatus(defaultDaemonDir(shard))!.pid, 'SIGKILL');
  }
  rmSync(root, { recursive: true, force: true }); root = undefined;
});
it.each([false, true])('starts a partition with explicit production argv=%s without following the main pointer', async explicitArgs => {
  root = mkdtempSync(join(tmpdir(), 'bot-env-start-')); shard = join(root, 'cli_a'); mkdirSync(shard);
  const mainDir = join(root, 'main', '.dutydeck/daemon'); mkdirSync(mainDir, { recursive: true });
  writeLastDaemonDir(mainDir, root);
  const originalPointer = readFileSync(lastDaemonDirPointerFile(root), 'utf8');
  const database = join(shard, 'dutydeck.db');
  const repos = createRepositories(database, { newDatabaseAuthority: 'ledger_v1' });
  await repos.config.set('lark.bots', '[{"appId":"cli_a","appSecret":"fake-secret","listening":false}]');
  await repos.config.set('dutydeck.bot_process', '{"version":1,"appId":"cli_a"}'); repos.close();
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const unit = 'dutydeck-cli-a.service';
  const generatedEnv = renderBotProcessEnv(root, 'cli_a', { database, output: root, cwd: root, basePort: port - 1 }, [{ id: 'bot-cli-a', name: 'A', url: `http://127.0.0.1:${port}` }]);
  writeFileSync(join(shard, '.env'), generatedEnv + '\nDUTYDECK_AUTH=false\nDUTYDECK_AGENTS_JSON=[]\nDUTYDECK_DISABLE_LARK_LISTENER=true\n');
  const bin = join(root, 'bin'); mkdirSync(bin);
  const fakeSystemctl = readFileSync(join(workspace, 'apps/server/src/daemon/fixtures/bot-process-systemctl.mjs'), 'utf8');
  writeFileSync(join(bin, 'systemctl'), `#!${process.execPath}\n${fakeSystemctl}`, { mode: 0o755 });
  const calls = join(root, 'systemctl-calls.jsonl');
  env = { HOME: root, PATH: `${bin}:${process.env.PATH ?? ''}`, TEST_RUNTIME_ROOT: shard, TEST_RUNTIME_UNIT: unit, TEST_RUNTIME_CLI: cli, TEST_TSX_LOADER: loader, TEST_SYSTEMCTL_CALLS: calls, TEST_RUNTIME_EXPLICIT_ARGS: String(explicitArgs) };
  for (let i = 0; i < 2; i++) {
    expect(readDaemonStatus(defaultDaemonDir(shard))).toBeUndefined();
    const started = invoke('start');
    expect(started.status, started.stderr + started.stdout + (existsSync(join(shard, 'fixture-server.log')) ? readFileSync(join(shard, 'fixture-server.log'), 'utf8') : '')).toBe(0);
    expect(JSON.parse(started.stdout)).toMatchObject({ ok: true, running: true });
    expect(readDaemonStatus(defaultDaemonDir(shard))).toMatchObject({ database, botAppId: 'cli_a', botProcess: true, supervisor: 'systemd', systemdUnit: unit, port, agentCwd: root });
    const response = await fetch(`http://127.0.0.1:${port}/api/lark/config`);
    expect(response.status).toBe(200);
    expect((await response.json() as { bots: Array<{ appId: string }> }).bots.map(bot => bot.appId)).toEqual(['cli_a']);
    if (explicitArgs) {
      const before = readDaemonStatus(defaultDaemonDir(shard));
      const refused = invoke('start', ['--foreground', '--database', database, '--cwd', root!, '--port', String(port), '--local-only', '--bot-app-id', 'cli_other']);
      expect(refused.status).not.toBe(0);
      expect(refused.stderr + refused.stdout).toContain('--bot-app-id does not match the database binding');
      expect(readDaemonStatus(defaultDaemonDir(shard))).toEqual(before);
    }
    expect(existsSync(join(shard, '.dutydeck/dutydeck.db'))).toBe(false);
    expect(readFileSync(lastDaemonDirPointerFile(root), 'utf8')).toBe(originalPointer);
    const stopped = invoke('stop'); expect(stopped.status, stopped.stderr + stopped.stdout).toBe(0);
    expect(readDaemonStatus(defaultDaemonDir(shard))).toBeUndefined();
  }
  const operations = readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(operations.every(call => call.unit === unit)).toBe(true);
  expect(operations.filter(call => call.action === 'start')).toHaveLength(2);
  expect(operations.filter(call => call.action === 'stop')).toHaveLength(2);
  expect(readFileSync(lastDaemonDirPointerFile(root), 'utf8')).toBe(originalPointer);
}, 60_000);
