import { afterEach, expect, it } from 'vitest';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const directories: string[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  await Promise.all(children.splice(0).map(async child => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
  }));
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});
async function port() {
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const value = (probe.address() as { port: number }).port;
  await new Promise<void>(resolve => probe.close(() => resolve())); return value;
}

it('logs one startup phase summary after the server starts listening', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dutydeck-startup-timing-')); directories.push(directory);
  // 测试环境（NODE_ENV=test）关闭了 Fastify 日志，这里用生产配置起真实 CLI 读它的日志输出。
  const { NODE_ENV: _nodeEnv, ...env } = process.env;
  const child = fork(resolve('apps/server/src/cli.ts'), ['--local-only', '--port', String(await port()), '--no-lark-listen'], {
    cwd: directory,
    execArgv: ['--conditions=development', '--import', resolve('node_modules/tsx/dist/loader.mjs')],
    env: { ...env, HOME: directory, DUTYDECK_DATABASE_URL: join(directory, 'dutydeck.db'), DUTYDECK_DEFAULT_CWD: directory, DUTYDECK_DAEMON_DIR: join(directory, '.dutydeck/daemon'), DUTYDECK_AGENTS_JSON: '[]' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });
  children.push(child);
  let output = '';
  const summary = await new Promise<Record<string, unknown>>((resolveSummary, reject) => {
    child.stdout!.on('data', chunk => {
      output += chunk;
      for (const line of output.split('\n')) {
        if (!line.includes('启动各阶段耗时')) continue;
        const entry = JSON.parse(line) as { msg: string; startupMs: Record<string, unknown> };
        if (entry.msg === '启动各阶段耗时') resolveSummary(entry.startupMs);
      }
    });
    child.once('exit', code => reject(new Error(`CLI exited with ${code} before the startup summary:\n${output}`)));
  });
  expect(Object.keys(summary)).toEqual(['boot', 'plugins', 'config', 'database', 'migrate', 'wiring', 'insight', 'integrations', 'relay', 'agentDefaults', 'agents', 'sessions', 'routes', 'listen', 'total']);
  for (const value of Object.values(summary)) expect(Number.isInteger(value) && (value as number) >= 0).toBe(true);
  expect(summary.migrate).toBeGreaterThan(0); // 新库要跑迁移，迁移耗时单独记，不算进 database
  const phases = Object.entries(summary).filter(([name]) => name !== 'total').reduce((sum, [, value]) => sum + (value as number), 0);
  // 各阶段首尾相接，加起来应等于总耗时（每段各自取整，允许少量误差）。
  expect(Math.abs(phases - (summary.total as number))).toBeLessThanOrEqual(15);
  expect(output.indexOf('Server listening')).toBeLessThan(output.indexOf('启动各阶段耗时'));
}, 60_000);
