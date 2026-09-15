import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, symlinkSync, linkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import Database from 'better-sqlite3';
import { createRepositories } from './index.js';
import { openDatabaseControl } from './database-control.js';
import { currentProcessIdentity, observeProcess } from './process-identity.js';

const directories: string[] = [];
const children: Array<{ child: ChildProcess; exit: Promise<unknown> }> = [];
afterEach(async () => {
  for (const { child, exit } of children.splice(0)) { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exit; }
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
function file() { const dir = mkdtempSync(join(tmpdir(), 'dutydeck-control-')); directories.push(dir); return join(dir, 'state.sqlite'); }
async function worker(path: string) {
  const child = spawn(process.execPath, ['--conditions=development', '--import', 'tsx', fileURLToPath(new URL('../tests/fixtures/database-control-worker.mts', import.meta.url)), path, join(path, '..')], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const exit = new Promise(resolve => child.once('exit', resolve)); children.push({ child, exit });
  let errorText = ''; child.stderr!.on('data', data => { errorText += data; });
  let ready!: () => void;
  const readyPromise = new Promise<void>(resolve => { ready = resolve; });
  let sequence = 0;
  const calls = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  child.on('message', (message: any) => {
    if (message.event === 'ready') ready();
    const call = calls.get(message.id); if (!call) return;
    calls.delete(message.id); if (message.error) call.reject(new Error(message.error)); else call.resolve(message.value);
  });
  child.on('exit', () => { for (const call of calls.values()) call.reject(new Error(`Worker exited: ${errorText}`)); });
  await Promise.race([readyPromise, exit.then(() => { throw new Error(`Worker failed: ${errorText}`); })]);
  return { child, exit, call(action: string, extra = {}): Promise<any> { return new Promise((resolve, reject) => { const id = ++sequence; calls.set(id, { resolve, reject }); child.send({ id, action, ...extra }); }); } };
}

it('reserves runtime control before repository exposure, while allowing online management', async () => {
  const path = file(), first = createRepositories(path, { mode: 'runtime' });
  const management = createRepositories(path);
  try {
    await management.config.set('online', 'yes'); expect(await first.config.get('online')).toBe('yes');
    expect(() => createRepositories(path, { mode: 'runtime' })).toThrow('DATABASE_RUNTIME_BUSY');
    expect(() => management.control.attachRuntime('other')).toThrow('DATABASE_RUNTIME_BUSY');
    const claim = first.control.attachRuntime('first');
    expect(() => first.close()).toThrow('DATABASE_RUNTIME_STILL_ATTACHED');
    claim.release();
    expect(() => createRepositories(path, { mode: 'runtime' })).toThrow('DATABASE_RUNTIME_BUSY');
    const next = first.control.attachRuntime('next');
    expect(() => claim.assertCurrent()).toThrow('DATABASE_RUNTIME_CLAIM_REVOKED');
    expect(() => claim.release()).toThrow('DATABASE_RUNTIME_CLAIM_REVOKED');
    next.assertCurrent(); next.release();
  } finally { management.close(); first.close(); }
  const replacement = createRepositories(path, { mode: 'runtime' }); replacement.close();
});
it('identifies symlinks as the same database and rejects hard links', () => {
  const path = file(), first = createRepositories(path, { mode: 'runtime' });
  const alias = `${path}.alias`; symlinkSync(path, alias);
  try { expect(() => createRepositories(alias, { mode: 'runtime' })).toThrow('DATABASE_RUNTIME_BUSY'); }
  finally { first.close(); }
  linkSync(path, `${path}.hard`);
  expect(() => createRepositories(path)).toThrow('DATABASE_UNSAFE_FILE');
});
it('requires idle accessors for upgrades and blocks new access during maintenance', () => {
  const path = file(); createRepositories(path).close();
  const reader = createRepositories(path), maintenance = openDatabaseControl(path, {});
  expect(() => maintenance.beginUpgrade()).toThrow('DATABASE_UPGRADE_BUSY');
  reader.close(); maintenance.beginUpgrade();
  expect(() => createRepositories(path)).toThrow('DATABASE_MAINTENANCE');
  maintenance.close();
  expect(() => createRepositories(path, { upgrade: 'never' })).toThrow('DATABASE_MAINTENANCE_RECOVERY_REQUIRED');
  createRepositories(path).close();
  createRepositories(path, { upgrade: 'never' }).close();
});
it('reserves pending migration atomically rather than admitting two upgrading accessors', async () => {
  const path = file();
  const raw = new Database(path); raw.close();
  const a = await worker(path), b = await worker(path);
  const result = await Promise.allSettled([a.call('maintenance'), b.call('maintenance')]);
  expect(result.filter(item => item.status === 'fulfilled')).toHaveLength(1);
  expect(result.filter(item => item.status === 'rejected')).toHaveLength(1);
});
it('distinguishes live, PID reuse, incompatible namespace, and unreadable identity', () => {
  const current = currentProcessIdentity();
  expect(observeProcess(current)).toBe('alive');
  expect(observeProcess({ ...current, start: `${BigInt(current.start) + 1n}` })).toBe('dead');
  expect(observeProcess({ ...current, namespace: 'different' })).toBe('unknown');
  expect(observeProcess({ ...current, host: 'other-host' })).toBe('unknown');
  expect(observeProcess({ ...current, start: '' })).toBe('unknown');
});
it('blocks a live foreign or unreadable access record instead of guessing it died', () => {
  const path = file(); createRepositories(path).close();
  const raw = new Database(path);
  raw.prepare('INSERT INTO dutydeck_access VALUES (?, ?)').run('unknown', JSON.stringify({ ...currentProcessIdentity(), namespace: 'unreadable' }));
  raw.prepare("UPDATE dutydeck_control SET runtime = 'unknown', version = version + 1").run(); raw.close();
  expect(() => createRepositories(path, { mode: 'runtime' })).toThrow('DATABASE_RUNTIME_BUSY');
  const reader = createRepositories(path); reader.close();
});
it('two real Nodes exclude direct Runtime and service before recovery/config writes, including aliases and ports', async () => {
  const path = file(); const a = await worker(path); await a.call('open', { mode: 'runtime' }); await a.call('start');
  const before = await a.call('inspect'); expect(before.tasks[0].status).toBe('running');
  const b = await worker(path); await b.call('open', { mode: 'management' });
  await expect(b.call('initialize')).rejects.toThrow('DATABASE_RUNTIME_BUSY');
  const alias = `${path}.alias`; symlinkSync(path, alias);
  await expect(b.call('service', { path: alias, port: '49217' })).rejects.toThrow('DATABASE_RUNTIME_BUSY');
  await expect(b.call('service', { port: '49218' })).rejects.toThrow('DATABASE_RUNTIME_BUSY');
  expect(await a.call('inspect')).toEqual(before);
  expect(a.child.exitCode).toBeNull();
  await b.call('close'); await a.call('close'); await Promise.all([a.exit, b.exit]);
}, 30_000);
it('reclaims only a precisely dead SIGKILL owner and gates interrupted maintenance', async () => {
  const path = file(); createRepositories(path).close();
  const a = await worker(path); await a.call('open', { mode: 'runtime' });
  a.child.kill('SIGKILL'); await a.exit;
  createRepositories(path, { mode: 'runtime' }).close();
  const b = await worker(path); await b.call('maintenance'); b.child.kill('SIGKILL'); await b.exit;
  expect(() => createRepositories(path, { upgrade: 'never' })).toThrow('DATABASE_MAINTENANCE_RECOVERY_REQUIRED');
  createRepositories(path).close();
  createRepositories(path, { upgrade: 'never' }).close();
});

it('a rejected second Runtime cannot terminate the first Runtime verification process', async () => {
  const path = file(), dir = join(path, '..');
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Control Test']);
  writeFileSync(join(dir, 'tracked'), 'baseline');
  execFileSync('git', ['-C', dir, 'add', 'tracked']);
  execFileSync('git', ['-C', dir, 'commit', '-qm', 'baseline']);
  const a = await worker(path), b = await worker(path);
  try {
    await a.call('open', { mode: 'runtime' }); await a.call('verification');
    let record: any;
    await vi.waitFor(async () => {
      const facts = await a.call('inspect');
      record = facts.config.filter((item: any) => item.key.startsWith('runtime_verification:')).map((item: any) => JSON.parse(item.value))[0];
      expect(record?.processStage).toBe('command_started');
    });
    const current = currentProcessIdentity();
    const identity = { ...current, pid: record.processIdentity.pid, start: record.processIdentity.startTimeTicks };
    expect(observeProcess(identity)).toBe('alive');
    await b.call('open'); await expect(b.call('initialize')).rejects.toThrow('DATABASE_RUNTIME_BUSY');
    expect(observeProcess(identity)).toBe('alive');
    const facts = await a.call('inspect');
    expect(JSON.parse(facts.config.find((item: any) => item.key.includes(record.id)).value).status).toBe('running');
    await a.call('close'); await a.exit;
    expect(observeProcess(identity)).toBe('dead');
  } finally {
    if (a.child.connected) await a.call('close');
    if (b.child.connected) await b.call('close');
    await Promise.all([a.exit, b.exit]);
  }
}, 30_000);

it('gives simultaneous bundles distinct access identities and removes only the closing access', () => {
  const path = file(), a = createRepositories(path), b = createRepositories(path);
  const raw = new Database(path);
  try {
    expect(a.control.accessId).not.toBe(b.control.accessId);
    expect(raw.prepare('SELECT id FROM dutydeck_access').all()).toHaveLength(2);
    a.close();
    expect(raw.prepare('SELECT id FROM dutydeck_access').all()).toEqual([{ id: b.control.accessId }]);
  } finally { raw.close(); a.close(); b.close(); }
});
it('never upgrades on request and rejects incompatible control or future business versions', () => {
  const path = file();
  expect(() => createRepositories(path, { upgrade: 'never' })).toThrow('DATABASE_UPGRADE_REQUIRED');
  createRepositories(path).close();
  const raw = new Database(path);
  raw.prepare('UPDATE dutydeck_control SET protocol = 999').run();
  expect(() => createRepositories(path)).toThrow('DATABASE_CONTROL_VERSION_UNSUPPORTED');
  raw.prepare('UPDATE dutydeck_control SET protocol = 1').run();
  raw.prepare('INSERT INTO schema_migrations VALUES (999, ?)').run(new Date().toISOString());
  expect(() => createRepositories(path)).toThrow('DATABASE_SCHEMA_TOO_NEW');
  raw.close();
});

it('closes a failed business repository construction before releasing its reserved access', () => {
  const path = file(); createRepositories(path).close();
  const raw = new Database(path);
  try {
    raw.exec('ALTER TABLE secret_refs RENAME TO broken_secret_refs');
    expect(() => createRepositories(path, { mode: 'runtime' })).toThrow('no such table: secret_refs');
    expect(raw.prepare('SELECT id FROM dutydeck_access').all()).toEqual([]);
    raw.exec('ALTER TABLE broken_secret_refs RENAME TO secret_refs');
    createRepositories(path, { mode: 'runtime' }).close();
  } finally { raw.close(); }
});

it('retains execution reservation while closing failed-open business connections', () => {
  const path = file(); createRepositories(path).close();
  const raw = new Database(path);
  const close = Database.prototype.close;
  let entered = false;
  const closing = vi.spyOn(Database.prototype, 'close').mockImplementation(function (this: Database.Database) {
    if (!entered) {
      entered = true;
      expect(raw.prepare('SELECT id FROM dutydeck_access').all()).toHaveLength(1);
      expect(() => createRepositories(path, { mode: 'runtime' })).toThrow('DATABASE_RUNTIME_BUSY');
    }
    return close.call(this);
  });
  try {
    raw.exec('ALTER TABLE secret_refs RENAME TO broken_secret_refs');
    expect(() => createRepositories(path, { mode: 'runtime' })).toThrow('no such table: secret_refs');
    expect(entered).toBe(true);
    expect(raw.prepare('SELECT id FROM dutydeck_access').all()).toEqual([]);
  } finally { closing.mockRestore(); raw.close(); }
});
