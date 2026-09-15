import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import { createRepositories } from './index.js';

const isSupportedPlatform = process.platform === 'linux' || process.platform === 'darwin';
const suite = isSupportedPlatform ? describe : describe.skip;

suite('Real platform database control integration (Linux / Darwin)', () => {
  const directories: string[] = [];
  const children: Array<{ child: ChildProcess; exit: Promise<unknown> }> = [];

  beforeAll(() => {
    // Log safe platform and architecture summary without sensitive env or credentials
    console.info(`[Platform Integration Summary] OS=${process.platform}, Arch=${process.arch}, Node=${process.version}`);
  });

  afterEach(async () => {
    for (const { child, exit } of children.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
      await exit;
    }
    for (const path of directories.splice(0)) {
      rmSync(path, { recursive: true, force: true });
    }
  });

  function createDatabaseFile(): string {
    const dir = mkdtempSync(join(tmpdir(), 'dutydeck-macos-control-'));
    directories.push(dir);
    return join(dir, 'control-state.sqlite');
  }

  async function spawnWorker(dbPath: string) {
    const workerScript = fileURLToPath(new URL('../tests/macos-control-worker.mts', import.meta.url));
    const child = spawn(
      process.execPath,
      ['--conditions=development', '--import', 'tsx', workerScript],
      {
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        // Explicit conflicting parent locale/TZ to verify tools and identity isolation
        env: {
          ...process.env,
          LC_ALL: 'zh_CN.UTF-8',
          LANG: 'fr_FR.UTF-8',
          TZ: 'Asia/Shanghai',
        },
      }
    );
    const exit = new Promise(resolve => child.once('exit', resolve));
    children.push({ child, exit });

    let errorText = '';
    child.stderr?.on('data', data => {
      errorText += String(data);
    });

    let readyResolve!: () => void;
    const readyPromise = new Promise<void>(resolve => {
      readyResolve = resolve;
    });

    let sequence = 0;
    const pendingCalls = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();

    child.on('message', (message: any) => {
      if (message.event === 'ready') {
        readyResolve();
        return;
      }
      const call = pendingCalls.get(message.id);
      if (!call) return;
      pendingCalls.delete(message.id);
      if (message.error) {
        call.reject(new Error(message.error));
      } else {
        call.resolve(message.value);
      }
    });

    child.on('exit', () => {
      for (const call of pendingCalls.values()) {
        call.reject(new Error(`Worker process exited unexpectedly: ${errorText}`));
      }
    });

    await Promise.race([
      readyPromise,
      exit.then(() => {
        throw new Error(`Worker process failed to start: ${errorText}`);
      }),
    ]);

    return {
      child,
      exit,
      call(action: string, extra: Record<string, any> = {}): Promise<any> {
        return new Promise((resolve, reject) => {
          const id = ++sequence;
          pendingCalls.set(id, { resolve, reject });
          child.send({ id, action, path: dbPath, ...extra });
        });
      },
    };
  }

  it('active runtime control claim blocks another runtime accessor', async () => {
    const dbPath = createDatabaseFile();
    const workerA = await spawnWorker(dbPath);
    await workerA.call('open', { instanceId: 'inst-worker-a' });

    // A second accessor trying to open runtime mode must be rejected with DATABASE_RUNTIME_BUSY
    expect(() => createRepositories(dbPath, { mode: 'runtime' })).toThrow('DATABASE_RUNTIME_BUSY');

    const workerB = await spawnWorker(dbPath);
    await expect(workerB.call('open', { instanceId: 'inst-worker-b' })).rejects.toThrow('DATABASE_RUNTIME_BUSY');

    await workerA.call('close');
  });

  it('normal closure releases runtime claim and allows subsequent opening', async () => {
    const dbPath = createDatabaseFile();
    const workerA = await spawnWorker(dbPath);
    await workerA.call('open', { instanceId: 'inst-worker-a' });
    await workerA.call('close');

    // After normal close, the database must be openable in runtime mode
    const repos = createRepositories(dbPath, { mode: 'runtime' });
    const claim = repos.control.attachRuntime('inst-main');
    claim.release();
    repos.close();
  });

  it('reclaims precisely dead ChildProcess terminated by signal and allows re-opening', async () => {
    const dbPath = createDatabaseFile();
    const workerA = await spawnWorker(dbPath);
    await workerA.call('open', { instanceId: 'inst-worker-a' });

    // Explicitly kill the captured child process and wait for confirmed exit
    // No fixed PID and no whole-machine kill names used
    workerA.child.kill('SIGKILL');
    await workerA.exit;

    // Opening with mode: 'runtime' should observe workerA as dead, reclaim the record, and succeed
    const repos = createRepositories(dbPath, { mode: 'runtime' });
    const claim = repos.control.attachRuntime('inst-recovered');
    claim.release();
    repos.close();
  });
});
