import { afterEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { startLocalServer } from './service.js';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRepositories, assertBotProcessStartup } from '@dutydeck/storage';

const directories: string[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  await Promise.all(directories.map(async directory => { await mkdir(join(directory, 'gate'), { recursive: true }); await writeFile(join(directory, 'gate/release'), '1'); }));
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
async function shard(appId: string) {
  const directory = await mkdtemp(join(tmpdir(), 'dutydeck-bot-process-')); directories.push(directory);
  const database = join(directory, 'dutydeck.db');
  const repos = createRepositories(database, { newDatabaseAuthority: 'ledger_v1' });
  await repos.config.set('lark.bots', JSON.stringify([{ appId, appSecret: 'fake-secret', listening: false }]));
  await repos.config.set('dutydeck.bot_process', JSON.stringify({ version: 1, appId })); repos.close();
  return { directory, database, appId, port: await port() };
}
async function boot(config: Awaited<ReturnType<typeof shard>>, gated = false) {
  const agent = { id: 'fake-agent', name: 'Fake agent', command: process.execPath, args: [resolve('tests/fixtures/process-driver-turn-agent.mjs')], protocol: 'pipe', cwd: config.directory, env: { turn_agent_submission_log: join(config.directory, 'submissions.jsonl'), ...(gated ? { turn_agent_gate_dir: join(config.directory, 'gate') } : {}) }, permissionMode: 'full-trust', timeout: 30, capabilities: { pause: false, resume: true }, builtin: false };
  const child = fork(resolve('tests/fixtures/bot-process-runtime.mts'), [], {
    cwd: config.directory,
    execArgv: ['--conditions=development', '--import', resolve('node_modules/tsx/dist/loader.mjs')],
    env: { ...process.env, HOME: config.directory, DUTYDECK_DATABASE_URL: config.database, DUTYDECK_BOT_APP_ID: config.appId, DUTYDECK_DEFAULT_CWD: config.directory, DUTYDECK_HOST: '127.0.0.1', DUTYDECK_PORT: String(config.port), DUTYDECK_AUTH: 'false', DUTYDECK_DISABLE_LARK_LISTENER: 'true', DUTYDECK_AGENTS_JSON: JSON.stringify([agent]) },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc']
  });
  children.push(child);
  let errors = ''; child.stderr?.on('data', chunk => { errors += chunk; });
  const ready = await Promise.race([once(child, 'message').then(([message]) => message), once(child, 'exit').then(() => { throw new Error(errors); })]);
  expect(ready).toEqual({ ready: true, pid: child.pid }); return child;
}
async function task(child: ChildProcess) {
  const result = once(child, 'message'); child.send({ command: 'task' });
  expect((await result)[0]).toEqual({ task: 'completed', pid: child.pid });
}
it('isolates real runtimes and databases across SIGKILL and independent recovery', async () => {
  const a = await shard('cli_a'), b = await shard('cli_b');
  const processA = await boot(a), processB = await boot(b, true); const bPid = processB.pid;
  await task(processA);
  const runningB = task(processB);
  await expect.poll(async () => access(join(b.directory, 'gate/entered')).then(() => true, () => false), { timeout: 5_000 }).toBe(true);
  const dbB = new Database(b.database, { readonly: true });
  const attempts = () => dbB.prepare('SELECT id, task_id, state, submission_id FROM task_attempts ORDER BY id').all() as Array<{ id: string; task_id: string; state: string; submission_id: string }>;
  try {
    const before = attempts(); expect(before).toHaveLength(1); expect(before[0]?.state).toBe('active');
    const exited = once(processA, 'exit'); processA.kill('SIGKILL'); await exited;
    expect(processB.pid).toBe(bPid); process.kill(bPid!, 0);
    expect(attempts()).toEqual(before);
    await writeFile(join(b.directory, 'gate/release'), '1'); await runningB;
    expect(attempts()).toEqual([{ ...before[0], state: 'settled' }]);
    expect((await readFile(join(b.directory, 'submissions.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(1);
  } finally { dbB.close(); }
  const recovered = await boot(a); expect(recovered.pid).not.toBe(processA.pid);
  await Promise.all([task(recovered), task(processB)]);
}, 45_000);

it('rejects wrong app IDs and migrated source before acquiring a runtime claim', async () => {
  const config = await shard('cli_a');
  expect(() => assertBotProcessStartup(config.database, 'cli_b')).toThrow('BOT_PROCESS_SCOPE');
  const repos = createRepositories(config.database);
  await repos.config.set('dutydeck.bot_process_migration', JSON.stringify({ version: 1, outputDirectory: '/tmp/split', migratedAt: new Date().toISOString() })); repos.close();
  expect(() => assertBotProcessStartup(config.database)).toThrow('source database has been migrated');
  const check = createRepositories(config.database, { mode: 'runtime' }); check.close();
});

it.each([{ bots: [{ appId: 'cli_a' }, { appId: 'cli_b' }] }, { bots: [{ appId: 'cli_a' }, { appId: 'cli_a' }] }])('refuses corrupted multi-bot partitions before server initialization', async ({ bots }) => {
  const config = await shard('cli_a');
  const db = new Database(config.database);
  db.prepare('UPDATE configs SET value = ? WHERE key = ?').run(JSON.stringify(bots), 'lark.bots'); db.close();
  await expect(startLocalServer({ env: { ...process.env, DUTYDECK_DATABASE_URL: config.database, DUTYDECK_AUTH: 'false', DUTYDECK_HOST: '127.0.0.1', DUTYDECK_BOT_APP_ID: 'cli_a' } })).rejects.toThrow('BOT_PROCESS_SCOPE');
  const repos = createRepositories(config.database, { mode: 'runtime' }); repos.close();
});
