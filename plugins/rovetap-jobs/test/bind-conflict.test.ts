// Reproduces the host overlap case: two generations of the plugin service
// contend for the same fixed loopback port. The generation that loses the
// exclusive bind must have NO business side effects — it must not recover or
// rewrite in-flight state, must not send anything, and must not publish a
// discovery file. The real-process case starts from service/main.mjs.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, writeFile, readFile, mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createService } from '../service/main.mjs';
import { startFakeLark, APP, CHAT, BOSS, TOKEN, type FakeLark } from './helpers/harness';

const PLUGIN_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const MAIN = join(PLUGIN_ROOT, 'service', 'main.mjs');
const SOURCE_KEY = `lark/${APP}/om_conflict`;

let dir = '';
let child: ChildProcess | undefined;
let holder: Server | undefined;
let lark: FakeLark | undefined;

afterEach(async () => {
  if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  if (holder) await new Promise<void>((r) => holder!.close(() => r()));
  if (lark) await lark.close();
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = '';
  child = undefined;
  holder = undefined;
  lark = undefined;
});

function waitForExit(proc: ChildProcess, timeoutMs: number): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      resolve({ code: proc.exitCode, signal: proc.signalCode });
      return;
    }
    const timer = setTimeout(() => reject(new Error('process did not exit within timeout')), timeoutMs);
    proc.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
}

describe('rovetap-jobs fixed-port bind conflict (real main.mjs process)', () => {
  it('losing process exits at bind without recovering state, sending replies, or writing discovery', async () => {
    dir = await mkdtemp(join(tmpdir(), 'rvj-bind-conflict-'));
    lark = await startFakeLark();

    // The incumbent generation exclusively owns the fixed port.
    holder = createServer((_req, res) => res.end());
    await new Promise<void>((r) => holder!.listen(0, '127.0.0.1', r));
    const address = holder.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    expect(port).toBeGreaterThan(0);

    // Seed an interrupted submit with an in-flight ('sending') receipt. Old
    // startup recovered these BEFORE binding, deterministically rewriting the
    // file (sending -> pending, submitting -> unknown).
    const dataDir = join(dir, 'data');
    await mkdir(dataDir, { recursive: true });
    const state = {
      version: 1,
      events: {},
      messageIndex: {},
      jobs: {
        [SOURCE_KEY]: {
          sourceKey: SOURCE_KEY,
          stage: 'submitting',
          replies: {
            accepted: { uuid: 'fixed-conflict-uuid', status: 'sending', attempts: 1 },
          },
        },
      },
    };
    const stateFile = join(dataDir, 'rovetap-jobs-state.json');
    const rawState = JSON.stringify(state, null, 2);
    await writeFile(stateFile, rawState);

    const config = {
      dataDir,
      appId: APP,
      handlerToken: TOKEN,
      allowedChatIds: [CHAT],
      commanderOpenIds: [BOSS],
      listen: { host: '127.0.0.1', port, path: '/lark/events' },
      lark: { appId: APP, appSecret: 'test-secret', baseUrl: lark.baseUrl },
      reply: { mode: 'lark-api' },
      // Complete required startup config so the loser reaches bind and fails
      // with EADDRINUSE rather than config validation.
      pairfob: { bin: process.execPath, project: 'rovetap', tokenFile: join(dir, 'project.token') },
      // No tick should run before the bind failure tears the process down.
      pollMs: 60_000,
    };
    const configPath = join(dir, 'config.json');
    await writeFile(configPath, JSON.stringify(config));
    await writeFile(config.pairfob.tokenFile, 'test-project-token');

    let stderr = '';
    child = spawn(process.execPath, [MAIN, '--config', configPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });

    const exit = await waitForExit(child, 10_000).catch((error) => {
      throw new Error(`${error.message}; stderr=${stderr}`);
    });
    expect(exit.code, `stderr=${stderr}`).toBe(1);
    expect(stderr).toMatch(/EADDRINUSE/);

    // In-flight state was neither recovered nor rewritten by the loser.
    await expect(readFile(stateFile, 'utf8')).resolves.toBe(rawState);
    const persisted = JSON.parse(await readFile(stateFile, 'utf8'));
    expect(persisted.jobs[SOURCE_KEY].stage).toBe('submitting');
    expect(persisted.jobs[SOURCE_KEY].replies.accepted.status).toBe('sending');

    // Loser never published discovery for its (non-)listener.
    expect(existsSync(join(dataDir, 'service.json'))).toBe(false);

    // Loser never reached outbound delivery.
    expect(lark.replies).toHaveLength(0);
    expect(lark.requests.filter((r) => r.path.endsWith('/reply'))).toHaveLength(0);
  }, 20_000);
});

describe('createService bind-first ordering', () => {
  it('rejects at EADDRINUSE before mkdir/store/worker initialization', async () => {
    dir = await mkdtemp(join(tmpdir(), 'rvj-bind-unit-'));
    holder = createServer((_req, res) => res.end());
    await new Promise<void>((r) => holder!.listen(0, '127.0.0.1', r));
    const address = holder.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const dataDir = join(dir, 'not-created-by-loser');
    const config = {
      dataDir,
      listen: { host: '127.0.0.1', port, path: '/lark/events' },
    };
    const store = { mutate: vi.fn(), close: vi.fn() };
    const worker = {
      recoverInFlightReplies: vi.fn(async () => {}),
      start: vi.fn(),
      stop: vi.fn(async () => {}),
    };

    await expect(createService(config as any, {
      store: store as any,
      worker: worker as any,
      lark: {} as any,
      sender: {} as any,
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    })).rejects.toMatchObject({ code: 'EADDRINUSE' });

    expect(worker.recoverInFlightReplies).not.toHaveBeenCalled();
    expect(worker.start).not.toHaveBeenCalled();
    expect(store.mutate).not.toHaveBeenCalled();
    // Bind must even precede the data-dir creation.
    await expect(stat(dataDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
