/**
 * Zellij backend tests.
 *
 * The pure helpers (session-list parsing, KDL escaping, layout building, ps
 * parsing, version comparison) run everywhere. The live-session suite is gated
 * on a working zellij >= 0.44, exactly like the tmux suite gates on isTmuxAvailable().
 */
import { describe, expect, it, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import {
  ZellijBackend,
  isZellijAvailable,
  zellijClientEnv,
  parseZellijVersion,
  isZellijVersionSupported,
  parseZellijSessions,
  parseZellijServerProcs,
  parseChildPids,
  buildZellijLayout,
  kdlString,
  normaliseCaptureLineEndings,
  ZELLIJ_CONFIG_KDL,
} from './zellij-backend.js';

/** Poll a predicate until true or timeout (same rationale as pty-backend.test.ts:
 *  a fully concurrent suite sees multi-second scheduling jitter). */
function waitFor(predicate: () => boolean, timeoutMs = 30000, intervalMs = 100): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      try {
        if (predicate()) return resolve();
      } catch { /* keep polling */ }
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor timeout'));
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

/** Poll an assertion until it passes. Assertion semantics are unchanged — the
 *  same expect() calls run, retried to absorb load-induced timing jitter. */
async function waitForAssert<T>(fn: () => T, timeoutMs = 30000, intervalMs = 100): Promise<T> {
  const start = Date.now();
  let lastError: unknown;
  for (;;) {
    try {
      return fn();
    } catch (err) {
      lastError = err;
      if (Date.now() - start > timeoutMs) throw lastError;
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
  }
}

describe('zellij pure helpers', () => {
  describe('parseZellijSessions', () => {
    it('takes the first token of each line', () => {
      expect(parseZellijSessions('alpha [Created 2m ago]\nbeta [Created 5s ago]\n'))
        .toEqual(['alpha', 'beta']);
    });

    it('filters EXITED corpses — attaching to one would find no CLI', () => {
      const out = [
        'live-one [Created 1m ago]',
        'dead-one [Created 9m ago] (EXITED - attach to resurrect)',
        '',
      ].join('\n');
      expect(parseZellijSessions(out)).toEqual(['live-one']);
    });

    it('returns an empty list for empty output', () => {
      expect(parseZellijSessions('')).toEqual([]);
      expect(parseZellijSessions('\n  \n')).toEqual([]);
    });
  });

  describe('kdlString', () => {
    it('escapes backslashes and double quotes', () => {
      expect(kdlString('plain')).toBe('"plain"');
      expect(kdlString('say "hi"')).toBe('"say \\"hi\\""');
      expect(kdlString('back\\slash')).toBe('"back\\\\slash"');
      // Backslash escaping must run before quote escaping, or the emitted
      // escape for a quote gets double-escaped.
      expect(kdlString('a\\"b')).toBe('"a\\\\\\"b"');
    });

    it('leaves spaces and shell metacharacters alone (execvp argv, not a shell)', () => {
      expect(kdlString('a b; rm -rf /')).toBe('"a b; rm -rf /"');
      expect(kdlString('$HOME `id`')).toBe('"$HOME `id`"');
    });
  });

  describe('buildZellijLayout', () => {
    const opts = {
      cwd: '/work/dir',
      cols: 80,
      rows: 24,
      env: { FOO: 'bar' },
      injectEnv: { SECRET: 'shh' },
    };

    it('puts env in a per-process env prefix, never a zellij-level setting', () => {
      const layout = buildZellijLayout('mycli', ['--flag'], opts);
      expect(layout).toContain('FOO=bar');
      expect(layout).toContain('SECRET=shh');
      expect(layout).toContain('/usr/bin/env');
      expect(layout).toContain('mycli');
      expect(layout).toContain('--flag');
      // No zellij `env`/`session` global config directive carries the values.
      expect(layout).not.toMatch(/^\s*env\s/m);
    });

    it('cds into cwd and execs, so the CLI is the server child', () => {
      const layout = buildZellijLayout('mycli', [], opts);
      expect(layout).toContain("cd '/work/dir'");
      expect(layout).toContain('exec ');
      expect(layout).toContain('close_on_exit=true');
    });

    it('shell-escapes values so a quote cannot break out of the sh fragment', () => {
      const evil = "'; touch /tmp/dockmux-zellij-pwned; '";
      const layout = buildZellijLayout('mycli', [], { ...opts, env: { EVIL: evil } });
      // The payload survives verbatim, but only INSIDE a quoted word: every
      // embedded ' is closed-escaped-reopened. Note the sh escaping is itself
      // KDL-escaped on the way out, so the backslashes appear doubled here.
      expect(layout).toContain("'EVIL='\\\\''; touch /tmp/dockmux-zellij-pwned; '\\\\'''");

      // Prove it: pull the sh fragment back out of the KDL and run it with a
      // printer in place of the CLI.
      const probe = buildZellijLayout('/bin/sh', ['-c', 'printf "[%s]" "$EVIL"'], {
        ...opts,
        cwd: tmpdir(),
        env: { EVIL: evil },
        injectEnv: {},
      });
      const argsLine = probe.split('\n').find(l => l.trimStart().startsWith('args'))!;
      // Undo the KDL string encoding to recover the literal sh script.
      const kdl = argsLine.slice(argsLine.indexOf('"-c"') + 5).trim();
      const script = kdl.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      const r = spawnSync('/bin/sh', ['-c', script], { encoding: 'utf-8', timeout: 10000 });
      expect(r.stdout).toBe(`[${evil}]`);
      expect(existsSync('/tmp/dockmux-zellij-pwned')).toBe(false);
    });

    it('escapes the sh fragment for KDL so embedded quotes stay inside the string', () => {
      const layout = buildZellijLayout('mycli', ['say "hi"'], opts);
      // Every literal double quote from the payload is KDL-escaped.
      const argsLine = layout.split('\n').find(l => l.includes('args'))!;
      expect(argsLine).toContain('\\"');
    });

    it('injectEnv is emitted after env so it wins on a key collision', () => {
      const layout = buildZellijLayout('mycli', [], {
        ...opts,
        env: { SHARED: 'from-base' },
        injectEnv: { SHARED: 'from-inject' },
      });
      expect(layout.indexOf('SHARED=from-base')).toBeLessThan(layout.indexOf('SHARED=from-inject'));
    });
  });

  describe('config', () => {
    it('locks the session and clears keybinds so the pty is a transparent pipe', () => {
      // Without both, zellij intercepts Ctrl-C / arrows as its own shortcuts.
      expect(ZELLIJ_CONFIG_KDL).toContain('default_mode "locked"');
      expect(ZELLIJ_CONFIG_KDL).toContain('clear-defaults=true');
      expect(ZELLIJ_CONFIG_KDL).toContain('pane_frames false');
    });
  });

  describe('zellijClientEnv', () => {
    it('drops ZELLIJ/ZELLIJ_SESSION_NAME so commands cannot target a parent session', () => {
      const saved = { z: process.env.ZELLIJ, n: process.env.ZELLIJ_SESSION_NAME };
      process.env.ZELLIJ = '0';
      process.env.ZELLIJ_SESSION_NAME = 'parent';
      try {
        const env = zellijClientEnv();
        expect(env.ZELLIJ).toBeUndefined();
        expect(env.ZELLIJ_SESSION_NAME).toBeUndefined();
        expect(env.PATH).toBe(process.env.PATH);
      } finally {
        if (saved.z === undefined) delete process.env.ZELLIJ; else process.env.ZELLIJ = saved.z;
        if (saved.n === undefined) delete process.env.ZELLIJ_SESSION_NAME; else process.env.ZELLIJ_SESSION_NAME = saved.n;
      }
    });

    it('is an allowlist, so session env cannot leak into the zellij server', () => {
      const saved = process.env.MY_SESSION_SECRET;
      process.env.MY_SESSION_SECRET = 'leaked';
      try {
        expect(zellijClientEnv().MY_SESSION_SECRET).toBeUndefined();
      } finally {
        if (saved === undefined) delete process.env.MY_SESSION_SECRET;
        else process.env.MY_SESSION_SECRET = saved;
      }
    });
  });

  describe('version gating', () => {
    it('parses a version banner', () => {
      expect(parseZellijVersion('zellij 0.44.1')).toEqual({ major: 0, minor: 44, patch: 1 });
      expect(parseZellijVersion('nonsense')).toBeUndefined();
    });

    it('requires >= 0.44.0 (dump-screen --ansi / list-panes --json landed there)', () => {
      expect(isZellijVersionSupported({ major: 0, minor: 44, patch: 0 })).toBe(true);
      expect(isZellijVersionSupported({ major: 0, minor: 44, patch: 1 })).toBe(true);
      expect(isZellijVersionSupported({ major: 0, minor: 45, patch: 0 })).toBe(true);
      expect(isZellijVersionSupported({ major: 1, minor: 0, patch: 0 })).toBe(true);
      expect(isZellijVersionSupported({ major: 0, minor: 43, patch: 9 })).toBe(false);
      expect(isZellijVersionSupported({ major: 0, minor: 40, patch: 0 })).toBe(false);
    });
  });

  describe('ps parsing', () => {
    it('extracts zellij server pid + socket path from argv', () => {
      const ps = [
        ' 1234 /usr/bin/zellij --server /run/user/1000/zellij/0.44.1/my-session',
        ' 5678 /usr/bin/some-other-thing --server /x/y',
        ' 9999 zellij --server /run/user/1000/zellij/0.44.1/other',
      ].join('\n');
      expect(parseZellijServerProcs(ps)).toEqual([
        { pid: 1234, socketPath: '/run/user/1000/zellij/0.44.1/my-session' },
        { pid: 9999, socketPath: '/run/user/1000/zellij/0.44.1/other' },
      ]);
    });

    it('finds non-zellij children of a server pid (the exec-ed CLI)', () => {
      const ps = [
        ' 100 1 systemd',
        ' 200 100 zellij',
        ' 300 200 mycli',
        ' 400 200 zellij',
        ' 500 999 unrelated',
      ].join('\n');
      expect(parseChildPids(ps, 200)).toEqual([300]);
      expect(parseChildPids(ps, 999)).toEqual([500]);
      expect(parseChildPids(ps, 12345)).toEqual([]);
    });
  });

  it('normalises bare LF to CRLF so a terminal does not staircase', () => {
    expect(normaliseCaptureLineEndings('a\nb\nc')).toBe('a\r\nb\r\nc');
    // Already-CRLF text must not be doubled.
    expect(normaliseCaptureLineEndings('a\r\nb')).toBe('a\r\nb');
  });
});

// Live-session tests need a working zellij >= 0.44 (absent on most dev boxes).
const zellijDescribe = isZellijAvailable() ? describe : describe.skip;

zellijDescribe('ZellijBackend (live)', () => {
  const sessions: string[] = [];
  let backend: ZellijBackend | null = null;

  const newSessionName = () =>
    `dockmux-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  afterEach(() => {
    backend?.kill();
    backend = null;
    for (const s of sessions) ZellijBackend.killSession(s);
    sessions.length = 0;
  });

  it('spawns, streams output, reports pid, and destroys the session on kill', async () => {
    const name = newSessionName();
    sessions.push(name);
    expect(ZellijBackend.probeSession(name)).toBe('missing');

    backend = new ZellijBackend(name);
    const received: string[] = [];
    backend.spawn('/bin/sh', ['-c', 'echo ZELLIJ-READY; sleep 30'], {
      cwd: tmpdir(),
      cols: 100,
      rows: 30,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
    });
    backend.onData(d => received.push(d));

    await waitFor(() => received.join('').includes('ZELLIJ-READY'));
    await waitForAssert(() => {
      expect(ZellijBackend.probeSession(name)).toBe('exists');
    });
    await waitForAssert(() => {
      expect(backend!.getPid()).toBeGreaterThan(0);
    });
    expect(backend.getPaneSize()).toEqual({ cols: 100, rows: 30 });

    backend.kill();
    await waitFor(() => ZellijBackend.probeSession(name) === 'missing', 30000);
  }, 120000);

  it('injects env into the CLI without leaking it into the zellij server', async () => {
    const name = newSessionName();
    sessions.push(name);
    backend = new ZellijBackend(name);
    const received: string[] = [];
    backend.spawn('/bin/sh', ['-c', 'echo "VAR=${MY_TEST_VAR} INJECT=${MY_INJECT_VAR}"; sleep 30'], {
      cwd: tmpdir(),
      cols: 80,
      rows: 24,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', MY_TEST_VAR: 'secret123' },
      injectEnv: { MY_INJECT_VAR: 'inject456' },
    });
    backend.onData(d => received.push(d));
    await waitFor(() => received.join('').includes('VAR=secret123 INJECT=inject456'));
  }, 120000);

  it('detach() leaves the session alive; a fresh backend reattaches to it', async () => {
    const name = newSessionName();
    sessions.push(name);
    const first = new ZellijBackend(name);
    backend = first;
    const received: string[] = [];
    first.spawn('/bin/sh', ['-c', 'echo ZELLIJ-PERSIST; sleep 60'], {
      cwd: tmpdir(),
      cols: 80,
      rows: 24,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
    });
    first.onData(d => received.push(d));
    await waitFor(() => received.join('').includes('ZELLIJ-PERSIST'));

    // detach: the pty client dies, the zellij session and its CLI survive.
    first.detach();
    await waitForAssert(() => {
      expect(ZellijBackend.probeSession(name)).toBe('exists');
    });

    // A fresh backend rejoins via `zellij attach` — no second CLI is started.
    const second = new ZellijBackend(name);
    second.spawn('/bin/sh', ['-c', 'true'], {
      cwd: tmpdir(),
      cols: 80,
      rows: 24,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
    });
    backend = second;
    expect(second.isReattach).toBe(true);
    await waitForAssert(() => {
      expect(ZellijBackend.probeSession(name)).toBe('exists');
    });
  }, 120000);
});
