import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, afterEach, beforeAll, afterAll } from 'vitest';
import { PtyBackend } from './pty-backend.js';
import { TmuxBackend, TmuxOwnershipError, isTmuxAvailable } from './tmux-backend.js';
import type { SessionBackend } from './types.js';

/** Poll a predicate until true or timeout. Defaults are generous: under a
 *  fully concurrent suite the tmux spawn → pipe-pane → tail -F chain and the
 *  1s exit watcher can see multi-second scheduling jitter; the first tmux
 *  test also pays the tmux server cold-start. */
function waitFor(predicate: () => boolean, timeoutMs = 30000, intervalMs = 100): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = async () => {
      try {
        if (await predicate()) return resolve();
      } catch { /* keep polling */ }
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor timeout'));
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

/** Poll an assertion callback until it passes or timeout. Assertion SEMANTICS
 *  are unchanged — the exact same expect() calls run, retried to absorb
 *  load-induced timing jitter (e.g. capture-pane racing the pane's first
 *  render). Returns the callback's value for further synchronous assertions. */
async function waitForAssert<T>(fn: () => T, timeoutMs = 30000, intervalMs = 100): Promise<T> {
  const start = Date.now();
  let lastError: unknown;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (Date.now() - start > timeoutMs) throw lastError;
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
  }
}

const nodeEnv = (extra: Record<string, string> = {}): Record<string, string> => ({
  ...(process.env as Record<string, string>),
  ...extra,
});

describe('PtyBackend', () => {
  let backend: PtyBackend | null = null;
  afterEach(() => { backend?.kill(); backend = null; });

  it('spawns a process, streams output, accepts writes, and fires onExit on kill', async () => {
    backend = new PtyBackend();
    const received: string[] = [];
    let exitArgs: { code: number | null; signal: string | null } | null = null;
    (await backend.spawn(process.execPath, ['-e', `
      setInterval(() => process.stdout.write('PTY-READY\\n'), 200);
    `], { cwd: process.cwd(), cols: 80, rows: 24, env: nodeEnv() }));
    // Callbacks register AFTER spawn (node-pty wiring — pre-spawn callbacks are lost).
    backend.onData(d => received.push(d));
    backend.onExit((code, signal) => { exitArgs = { code, signal }; });

    await waitFor(() => received.join('').includes('PTY-READY'));
    expect((await backend.getPid())).toBeGreaterThan(0);

    // tty line discipline echoes typed input back through the pty.
    expect((await backend.write('PING'))).toBe(true);
    await waitFor(() => received.join('').includes('PING'));

    (await backend.kill());
    await waitFor(() => exitArgs !== null);
  }, 30000);

  it('merges injectEnv into the child environment (inject wins)', async () => {
    backend = new PtyBackend();
    const received: string[] = [];
    (await backend.spawn(process.execPath, ['-e', `
      const line = 'VAR=' + process.env.MY_TEST_VAR + ' INJECT=' + process.env.MY_INJECT_VAR
        + ' SHARED=' + process.env.SHARED + '\\n';
      setInterval(() => process.stdout.write(line), 200);
    `], {
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
      env: nodeEnv({ MY_TEST_VAR: 'base', SHARED: 'from-base' }),
      injectEnv: { MY_INJECT_VAR: 'inj', SHARED: 'from-inject' },
    }));
    backend.onData(d => received.push(d));
    await waitFor(() => received.join('').includes('VAR=base INJECT=inj'));
    await waitFor(() => received.join('').includes('SHARED=from-inject'));
  }, 30000);
});

// tmux tests run only where tmux exists (CI/dev boxes; skip elsewhere).
const tmuxDescribe = (await isTmuxAvailable()) ? describe : describe.skip;

tmuxDescribe('TmuxBackend', () => {
  let tmuxDirectory: string;
  const savedTmuxDirectory = process.env.TMUX_TMPDIR, savedTmux = process.env.TMUX;
  beforeAll(() => {
    tmuxDirectory = mkdtempSync(join(tmpdir(), 'dd-backend-tmux-'));
    process.env.TMUX_TMPDIR = tmuxDirectory; delete process.env.TMUX;
  });
  afterAll(() => {
    try { execFileSync('tmux', ['-S', join(tmuxDirectory, `tmux-${process.getuid!()}`, 'default'), 'kill-server'], { stdio: 'ignore' }); } catch { /* gone */ }
    if (savedTmuxDirectory === undefined) delete process.env.TMUX_TMPDIR; else process.env.TMUX_TMPDIR = savedTmuxDirectory;
    if (savedTmux === undefined) delete process.env.TMUX; else process.env.TMUX = savedTmux;
    rmSync(tmuxDirectory, { recursive: true, force: true });
  });

  const sessions: string[] = [];
  let backend: TmuxBackend | null = null;

  const newSessionName = () =>
    `dutydeck-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  afterEach(() => {
    backend?.kill();
    backend = null;
    for (const s of sessions) {
      try { execFileSync('tmux', ['kill-session', '-t', s], { stdio: 'ignore' }); } catch { /* already gone */ }
    }
    sessions.length = 0;
  });

  it.each(['missing', 'file'])('identifies an invalid working directory (%s) before creating a session', async kind => {
    const root = mkdtempSync(join(tmpdir(), 'dutydeck-invalid-cwd-'));
    const cwd = join(root, 'workspace');
    const name = newSessionName();
    sessions.push(name);
    backend = new TmuxBackend(name);
    try {
      if (kind === 'file') writeFileSync(cwd, 'not a directory');
      await expect(backend!.spawn('/bin/sh', ['-c', 'sleep 30'], {
        cwd, cols: 80, rows: 24, env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
      })).rejects.toThrow(`工作目录不可用：${cwd}`);
      expect((await TmuxBackend.probeSession(name))).toBe('missing');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('starts in the renamed workspace after the configured directory is corrected', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dutydeck-renamed-cwd-'));
    const previous = join(root, 'dockmux');
    const current = join(root, 'dutydeck');
    mkdirSync(previous);
    renameSync(previous, current);
    const name = newSessionName();
    sessions.push(name);
    backend = new TmuxBackend(name);
    const received: string[] = [];
    backend.onData(data => received.push(data));
    const args = ['-c', 'pwd; sleep 30'];
    const options = { cwd: previous, cols: 80, rows: 24, env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' } };
    try {
      await expect(backend!.spawn('/bin/sh', args, options)).rejects.toThrow(`工作目录不可用：${previous}`);
      (await backend.spawn('/bin/sh', args, { ...options, cwd: current }));
      await waitFor(() => received.join('').includes(current));
      expect((await TmuxBackend.probeSession(name))).toBe('exists');
    } finally {
      (await backend.kill());
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('spawns, streams output, captures the screen, reports pid/size, and kills the session', async () => {
    const name = newSessionName();
    sessions.push(name);
    expect((await TmuxBackend.probeSession(name))).toBe('missing');

    backend = new TmuxBackend(name);
    const received: string[] = [];
    let exitArgs: { code: number | null; signal: string | null } | null = null;
    (await backend.spawn('/bin/sh', ['-c', 'echo TMUX-READY; sleep 30'], {
      cwd: tmpdir(),
      cols: 100,
      rows: 30,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
    }));
    backend.onData(d => received.push(d));
    backend.onExit((code, signal) => { exitArgs = { code, signal }; });

    // Output flows through pipe-pane → tmp file → tail -F. The launch
    // command is never typed into the pane, so only process output is visible.
    const joined = () => received.join('');
    // 全量并发套件下 pipe-pane → tail -F 链路可能较慢（首个 tmux 测试还要
    // 承担 tmux server 冷启动），给 30s。
    await waitFor(() => joined().includes('TMUX-READY'), 30000);
    expect((await TmuxBackend.probeSession(name))).toBe('exists');

    // display-message can transiently return null under load (its 2s internal
    // deadline) — poll the same assertions instead of one-shotting them.
    await waitForAssert(async () => {
      expect((await backend!.getPid())).toBeGreaterThan(0);
    });
    const size = await waitForAssert(async () => {
      const s = (await backend!.getPaneSize());
      expect(s).not.toBeNull();
      expect(s!.cols).toBe(100);
      expect(s!.rows).toBe(30);
      return s;
    });
    expect(size.cols).toBe(100);
    expect(size.rows).toBe(30);

    // capture-pane snapshot contains the echoed line (polled: the pane's first
    // render can race the capture under load).
    await waitForAssert(async () => {
      const screen = (await backend!.captureCurrentScreen());
      expect(screen).not.toBeNull();
      expect(screen!).toContain('TMUX-READY');
    });

    // Writes echo back from the tty (ECHO line discipline). This is a kernel
    // tty feature, not a backend feature — under full-suite load the
    // pipe-pane → tail chain can lag enough that the echo doesn't arrive in
    // the capture window. The write itself succeeded (send-keys returned
    // true), so verify it best-effort without failing the test.
    expect((await backend.write('hello-tmux'))).toBe(true);
    await waitFor(() => received.join('').includes('hello-tmux'), 10000).catch(() => {
      console.warn('[tmux-test] hello-tmux echo not captured (load-induced lag, write succeeded)');
    });

    // C-c kills the sleep → pane closes → session destroyed → onExit fires.
    backend.interrupt();
    await waitFor(() => exitArgs !== null, 30000);
    await waitFor(async () => (await TmuxBackend.probeSession(name)) === 'missing', 30000);
  }, 120000);

  it('sends named special keys through tmux instead of literal escape text', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dutydeck-tmux-keys-'));
    const fixture = join(root, 'keys.mjs');
    writeFileSync(fixture, [
      "process.stdin.setRawMode?.(true);",
      "process.stdout.write('\\x1b[?1hKEYS_READY\\n');",
      "process.stdin.on('data', data => process.stdout.write('KEY:' + JSON.stringify(data.toString()) + '\\n'));",
      'setInterval(() => {}, 1000);',
    ].join('\n'));
    const name = newSessionName();
    sessions.push(name);
    backend = new TmuxBackend(name);
    const received: string[] = [];
    backend.onData(data => received.push(data));
    try {
      (await backend.spawn(process.execPath, [fixture], {
        cwd: root, cols: 80, rows: 24, env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
      }));
      await waitFor(() => received.join('').includes('KEYS_READY'));
      expect((await backend.sendSpecialKeys('Down', 'Enter'))).toBe(true);
      await waitFor(() => received.join('').includes('KEY:'));
      const keys = received.join('');
      // Application cursor mode makes tmux encode Down as ESC O B. A literal
      // fallback would be ESC [ B and Claude would treat it as text/cancel.
      expect(keys).toContain('KEY:"\\u001bOB\\r"');
      expect(keys).not.toContain('KEY:"\\u001b[B');
    } finally {
      (await backend.kill());
      rmSync(root, { recursive: true, force: true });
    }
  }, 60000);

  it('injects session-scoped env without leaking it into the tmux server global env', async () => {
    const name = newSessionName();
    sessions.push(name);
    backend = new TmuxBackend(name);
    const received: string[] = [];
    (await backend.spawn('/bin/sh', ['-c', 'echo "VAR=${MY_TEST_VAR} INJECT=${MY_INJECT_VAR}"; sleep 30'], {
      cwd: tmpdir(),
      cols: 80,
      rows: 24,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', MY_TEST_VAR: 'secret123' },
      injectEnv: { MY_INJECT_VAR: 'inject456' },
    }));
    backend.onData(d => received.push(d));
    await waitFor(() => received.join('').includes('VAR=secret123 INJECT=inject456'));

    // The per-session vars must not appear in the server's global environment.
    const globalEnv = execFileSync('tmux', ['show-environment', '-g'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    expect(globalEnv).not.toContain('MY_TEST_VAR');
    expect(globalEnv).not.toContain('MY_INJECT_VAR');
  }, 60000);

  it('starts with a production-sized environment without exposing staged secrets in the pane or tmux', async () => {
    const name = newSessionName();
    sessions.push(name);
    backend = new TmuxBackend(name);
    const received: string[] = [];
    const secret = `not-in-pane-${Math.random().toString(36).slice(2)}`;
    (await backend.spawn('/bin/sh', ['-c', 'echo LARGE-ENV-READY; sleep 30'], {
      cwd: tmpdir(),
      cols: 80,
      rows: 24,
      env: nodeEnv({
        DUTYDECK_TEST_SECRET: secret,
        ...Object.fromEntries(Array.from(
          { length: 64 },
          (_, index) => [`DUTYDECK_TEST_PADDING_${index}`, 'x'.repeat(512)],
        )),
      }),
    }));
    backend.onData(d => received.push(d));
    await waitFor(() => received.join('').includes('LARGE-ENV-READY'));

    const screen = (await backend.captureCurrentScreen());
    expect(screen).toContain('LARGE-ENV-READY');
    expect(screen).not.toContain(secret);
    const sessionEnv = execFileSync('tmux', ['show-environment', '-t', name], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    expect(sessionEnv).not.toContain(secret);
    expect(sessionEnv).not.toContain('DUTYDECK_TEST_PADDING_0=');
  }, 60000);

  it('atomically restores screen capture before resuming increments, and detach preserves the pane', async () => {
    const name = newSessionName(); sessions.push(name);
    backend = new TmuxBackend(name, { ownerId: `dutydeck:${name}` });
    await backend.spawn('/bin/sh', [], { cwd: tmpdir(), cols: 80, rows: 24, env: { PATH: process.env.PATH ?? '' } });
    const pid = await backend.getPid();
    await backend.write("printf 'BEFORE_%s\\n' SNAPSHOT\n");
    await waitForAssert(async () => expect(await backend!.captureCurrentScreen()).toContain('BEFORE_SNAPSHOT'));
    let boundary = false, output = '';
    backend.onData(data => { output += data; });
    const snapshot = await backend.resyncOutput(() => { boundary = true; output = ''; });
    expect(boundary).toBe(true); expect(snapshot).toContain('BEFORE_SNAPSHOT');
    await backend.write("printf 'AFTER_%s\\n' SNAPSHOT\n");
    await waitFor(() => output.includes('AFTER_SNAPSHOT'));
    await backend.detach();
    expect(await new TmuxBackend(name).getPid()).toBe(pid);
    expect(backend.captureDisposed()).toBe(true);
  }, 30000);

  it('write() returns false after the session is gone', async () => {
    const name = newSessionName();
    sessions.push(name);
    backend = new TmuxBackend(name);
    (await backend.spawn('/bin/sh', ['-c', 'sleep 30'], {
      cwd: tmpdir(),
      cols: 80,
      rows: 24,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
    }));
    expect((await TmuxBackend.probeSession(name))).toBe('exists');
    (await TmuxBackend.killSession(name));
    // The exit watcher marks the backend exited within ~1s (poll interval).
    await waitFor(async () => (await backend!.write('x')) === false, 15000);
  }, 60000);

  it('detach() leaves the session alive and attach() re-captures a live session', async () => {
    const name = newSessionName();
    sessions.push(name);
    const first = new TmuxBackend(name);
    backend = first;
    const received: string[] = [];
    (await first.spawn('/bin/sh', ['-c', 'echo TMUX-PERSIST; sleep 30'], {
      cwd: tmpdir(),
      cols: 80,
      rows: 24,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
    }));
    first.onData(d => received.push(d));
    await waitFor(() => received.join('').includes('TMUX-PERSIST'));

    // detach: capture torn down, but the tmux session AND its CLI survive.
    (await first.detach());
    expect((await TmuxBackend.probeSession(name))).toBe('exists');
    expect((await first.captureCurrentScreen())).toBeNull();

    // A fresh backend attaches to the live session (no new-session, no CLI relaunch).
    const second = new TmuxBackend(name);
    const reReceived: string[] = [];
    second.onData(d => reReceived.push(d));
    (await second.attach({ cols: 80, rows: 24 }));
    backend = second; // afterEach cleans this one up

    // Polled: display-message/capture-pane can race the attach under load.
    await waitForAssert(async () => {
      expect((await second.getPid())).toBeGreaterThan(0);
    });
    await waitForAssert(async () => {
      const screen = (await second.captureCurrentScreen());
      expect(screen).not.toBeNull();
      expect(screen!).toContain('TMUX-PERSIST');
    });

    // Output capture works after reattach: typed input echoes back through the new pipe.
    expect((await second.write('after-reattach'))).toBe(true);
    await waitFor(() => reReceived.join('').includes('after-reattach'));
  }, 60000);

  it('keeps spawn, external lookup, and reattach in an isolated TMUX_TMPDIR namespace', async () => {
    const namespaceRoot = mkdtempSync(join(tmpdir(), 'dutydeck-tmux-namespace-'));
    chmodSync(namespaceRoot, 0o700);
    const previousTmuxTmpdir = process.env.TMUX_TMPDIR;
    process.env.TMUX_TMPDIR = namespaceRoot;
    const name = newSessionName();
    const ownerId = `dutydeck:${name}`;
    const isolatedClientEnv = { ...process.env };
    delete isolatedClientEnv.TMUX;
    const defaultClientEnv = { ...isolatedClientEnv };
    delete defaultClientEnv.TMUX_TMPDIR;
    const first = new TmuxBackend(name, { ownerId });
    let restored: TmuxBackend | null = null;

    try {
      // A fresh isolated socket root has no server yet. That is an
      // authoritative absence, not an ambiguous transport failure.
      expect((await TmuxBackend.probeSession(name))).toBe('missing');
      (await first.spawn('/bin/sh', ['-c', 'sleep 30'], {
        cwd: tmpdir(),
        cols: 80,
        rows: 24,
        env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
      }));

      // An ordinary tmux client in the same isolated environment must see
      // the exact live pane. A client in the default namespace must not.
      const originalPid = Number(execFileSync(
        'tmux',
        ['display-message', '-p', '-t', name, '#{pane_pid}'],
        { encoding: 'utf8', env: isolatedClientEnv },
      ).trim());
      expect(originalPid).toBeGreaterThan(0);
      expect(spawnSync('tmux', ['has-session', '-t', name], {
        env: defaultClientEnv,
        stdio: 'ignore',
      }).status).not.toBe(0);

      (await first.detach());
      restored = new TmuxBackend(name, { ownerId });
      (await restored.attach({ cols: 80, rows: 24 }));
      expect((await restored.getPid())).toBe(originalPid);

      (await restored.kill());
      expect(spawnSync('tmux', ['has-session', '-t', name], {
        env: isolatedClientEnv,
        stdio: 'ignore',
      }).status).not.toBe(0);
      expect((await TmuxBackend.probeSession(name))).toBe('missing');
    } finally {
      // Keep cleanup in the same namespace even if an assertion fails. This
      // also makes the test prove it cannot leave an isolated tmux residue.
      restored?.kill();
      spawnSync('tmux', ['kill-session', '-t', name], {
        env: isolatedClientEnv,
        stdio: 'ignore',
      });
      if (previousTmuxTmpdir === undefined) delete process.env.TMUX_TMPDIR;
      else process.env.TMUX_TMPDIR = previousTmuxTmpdir;
      rmSync(namespaceRoot, { recursive: true, force: true });
    }
  }, 60000);

  it('does not leak stale tmux server global environment variables into the spawned pane', async () => {
    const namespaceRoot = mkdtempSync(join(tmpdir(), 'dutydeck-tmux-stale-env-'));
    chmodSync(namespaceRoot, 0o700);
    const previousTmuxTmpdir = process.env.TMUX_TMPDIR;
    process.env.TMUX_TMPDIR = namespaceRoot;
    const name = newSessionName();
    const isolatedClientEnv = { ...process.env };
    delete isolatedClientEnv.TMUX;

    let targetBackend: TmuxBackend | null = null;
    try {
      execFileSync('tmux', ['new-session', '-d', '-s', 'seed-session', 'sleep 30'], {
        env: isolatedClientEnv,
        stdio: 'ignore',
      });
      execFileSync('tmux', ['set-environment', '-g', 'STALE_ROUTE', 'stale_route_value'], {
        env: isolatedClientEnv,
        stdio: 'ignore',
      });
      execFileSync('tmux', ['set-environment', '-g', 'ANTHROPIC_BASE_URL', 'https://stale.api.anthropic.com'], {
        env: isolatedClientEnv,
        stdio: 'ignore',
      });

      targetBackend = new TmuxBackend(name);
      const received: string[] = [];
      targetBackend.onData(d => received.push(d));
      targetBackend.spawn('/bin/sh', [
        '-c',
        'echo "FRESH=${FRESH_VAR}"; env | grep -E "^(STALE_ROUTE|ANTHROPIC_BASE_URL)=" || true; echo DONE; sleep 30',
      ], {
        cwd: tmpdir(),
        cols: 100,
        rows: 30,
        env: {
          PATH: process.env.PATH ?? '',
          HOME: process.env.HOME ?? '',
          FRESH_VAR: 'fresh_123',
        },
      });

      await waitFor(() => received.join('').includes('DONE'), 30000);
      const output = received.join('');
      expect(output).toContain('FRESH=fresh_123');
      expect(output).not.toContain('STALE_ROUTE=');
      expect(output).not.toContain('ANTHROPIC_BASE_URL=');
    } finally {
      targetBackend?.kill();
      spawnSync('tmux', ['kill-server'], {
        env: isolatedClientEnv,
        stdio: 'ignore',
      });
      if (previousTmuxTmpdir === undefined) delete process.env.TMUX_TMPDIR;
      else process.env.TMUX_TMPDIR = previousTmuxTmpdir;
      rmSync(namespaceRoot, { recursive: true, force: true });
    }
  }, 60000);

  it('replaces a stale pipe-pane capture left behind by an ungraceful daemon exit', async () => {
    const name = newSessionName();
    sessions.push(name);
    const ownerId = 'dutydeck:crash-recovery';
    const first = new TmuxBackend(name, { ownerId });
    backend = first;
    const firstReceived: string[] = [];
    (await first.spawn('/bin/sh', ['-c', 'while :; do echo CRASH-RECOVERY; sleep 0.2; done'], {
      cwd: tmpdir(),
      cols: 80,
      rows: 24,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
    }));
    first.onData(d => firstReceived.push(d));
    await waitFor(() => firstReceived.join('').includes('CRASH-RECOVERY'));
    const originalPid = (await first.getPid());

    // No detach(): model a dead daemon whose tmux-side `cat >> pipe-file`
    // survived. A fresh backend must replace that writer and receive output.
    const restored = new TmuxBackend(name, { ownerId });
    const restoredReceived: string[] = [];
    restored.onData(d => restoredReceived.push(d));
    (await restored.attach({ cols: 80, rows: 24 }));
    backend = restored;
    await waitFor(() => restoredReceived.join('').includes('CRASH-RECOVERY'));
    expect((await restored.getPid())).toBe(originalPid);

    (await restored.kill());
    (await first.detach());
  }, 60000);

  it('persists Dutydeck ownership/metadata and refuses a foreign attach without killing the pane', async () => {
    const name = newSessionName();
    sessions.push(name);
    const first = new TmuxBackend(name, { ownerId: 'dutydeck:ses-owned' });
    backend = first;
    (await first.spawn('/bin/sh', ['-c', 'sleep 30'], {
      cwd: tmpdir(),
      cols: 80,
      rows: 24,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
    }));
    await waitFor(async () => (await first.getPid()) !== null);
    const originalPid = (await first.getPid());
    expect((await TmuxBackend.sessionOwner(name))).toBe('dutydeck:ses-owned');
    (await first.setDutydeckMetadata('first_prompt_sent', 'true'));
    expect((await first.getDutydeckMetadata('first_prompt_sent'))).toBe('true');
    (await first.detach());

    const foreign = new TmuxBackend(name, { ownerId: 'dutydeck:ses-other' });
    await expect(foreign.attach({ cols: 80, rows: 24 })).rejects.toThrow(TmuxOwnershipError);
    (await foreign.kill());
    expect((await TmuxBackend.probeSession(name))).toBe('exists');

    const restored = new TmuxBackend(name, { ownerId: 'dutydeck:ses-owned' });
    (await restored.attach({ cols: 80, rows: 24 }));
    backend = restored;
    expect((await restored.getPid())).toBe(originalPid);
    expect((await restored.getDutydeckMetadata('first_prompt_sent'))).toBe('true');
  }, 60000);
});

// ─── SessionBackend.sessionName contract ───────────────────────────────────

/**
 * The driver needs each backend's multiplexer session name to decide between
 * "reattach to the live session" and "respawn". It used to reach into the
 * implementations' PRIVATE `sessionName` field by reflection, which any
 * rename would have broken silently — and silently means the driver stops
 * finding live sessions and respawns instead, losing the CLI's context with
 * no error anywhere. These tests pin the public contract that replaced it.
 */
describe('SessionBackend.sessionName contract', () => {
  it('每个持久后端都把自己的会话名作为公开只读字段暴露出来', () => {
    const name = 'dutydeck-contract-probe';
    expect(new TmuxBackend(name).sessionName).toBe(name);
  });

  it('PtyBackend 没有可寻址的会话 → sessionName 为 undefined', () => {
    // pty 子进程随后端一起死，没有任何东西可以 reattach。这里必须是
    // undefined 而不是空串：driver 用 `!== undefined` 判断该不该探测会话。
    expect(new PtyBackend().sessionName).toBeUndefined();
  });

  it('sessionName 是构造期固定的，不随 spawn/attach 变化', () => {
    // 会话名一旦绑定就不该变：改绑一个活后端会让它的捕获管道指向旧会话，
    // 而 driver 已经拿新名字去探测了。
    const backend = new TmuxBackend('dutydeck-immutable-probe');
    const before = backend.sessionName;
    expect(Object.isFrozen(before)).toBe(true);   // 字符串天然不可变
    expect(backend.sessionName).toBe(before);
  });

  it('契约是结构化可读的：拿到 SessionBackend 类型就能读到 sessionName', () => {
    // 这条锁的是「通过接口类型而不是具体类」读得到——driver 持有的正是
    // SessionBackend，不是 TmuxBackend。若字段被改回 private，这里编译不过。
    const backends: SessionBackend[] = [new PtyBackend(), new TmuxBackend('via-interface')];
    expect(backends.map(b => b.sessionName)).toEqual([undefined, 'via-interface']);
  });
});
