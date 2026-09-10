/**
 * Zmx backend tests.
 *
 * The pure helpers (list parsing, bootstrap/attach argv building, history
 * normalisation, version comparison) run everywhere. The live-session suite is
 * gated on a working zmx >= 0.7, like the tmux suite gates on isTmuxAvailable().
 */
import { describe, expect, it, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import {
  ZmxBackend,
  isZmxAvailable,
  zmxControlEnv,
  zmxSessionEnv,
  parseZmxVersion,
  isZmxVersionSupported,
  parseZmxList,
  parseZmxShortList,
  reconcileZmxSessions,
  buildZmxBootstrap,
  buildZmxAttachArgs,
  normaliseZmxHistory,
} from './zmx-backend.js';

/** Poll a predicate until true or timeout (see pty-backend.test.ts for why
 *  polling rather than a fixed sleep: the full concurrent suite is jittery). */
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

describe('zmx pure helpers', () => {
  describe('parseZmxShortList', () => {
    it('reads one bare session name per line', () => {
      expect(parseZmxShortList('alpha\nbeta\ngamma\n')).toEqual({
        sessions: ['alpha', 'beta', 'gamma'],
        malformedLines: [],
      });
    });

    it('tolerates CRLF line endings', () => {
      expect(parseZmxShortList('alpha\r\nbeta\r\n').sessions).toEqual(['alpha', 'beta']);
    });

    it('rejects names with tabs or control chars — impossible in this surface', () => {
      const r = parseZmxShortList('good\nbad\tname\n');
      expect(r.sessions).toEqual(['good']);
      expect(r.malformedLines).toEqual(['bad\tname']);
    });

    it('flags duplicates rather than double-counting them', () => {
      const r = parseZmxShortList('dup\ndup\n');
      expect(r.sessions).toEqual(['dup']);
      expect(r.malformedLines).toEqual(['dup']);
    });
  });

  describe('parseZmxList', () => {
    it('splits healthy (pid=) from unhealthy (err=) rows', () => {
      const out = [
        'name=alpha\tpid=123\tclients=1\tcmd=/bin/sh boot.sh',
        'name=broken\terr=socket unavailable',
      ].join('\n');
      const r = parseZmxList(out);
      expect(r.sessions).toEqual(['alpha']);
      expect(r.unhealthySessions).toEqual(['broken']);
      expect(r.malformedLines).toEqual([]);
    });

    it('skips continuation text after a record has started', () => {
      // cmd= is verbatim argv and may contain literal newlines. Once a record
      // has started, trailing prose is continuation, not a malformed line.
      const out = [
        'name=real\tpid=1\tcmd=/bin/sh -c echo one',
        'trailing junk from a multiline cmd',
      ].join('\n');
      const r = parseZmxList(out);
      expect(r.sessions).toEqual(['real']);
      expect(r.malformedLines).toEqual([]);
    });

    it('reports leading junk before any record as malformed', () => {
      const r = parseZmxList('garbage line\nname=a\tpid=1');
      expect(r.malformedLines).toEqual(['garbage line']);
      expect(r.sessions).toEqual(['a']);
    });

    it('returns empty results for empty output', () => {
      expect(parseZmxList('')).toEqual({ sessions: [], unhealthySessions: [], malformedLines: [] });
    });
  });

  describe('reconcileZmxSessions (the forged-row defence)', () => {
    it('trusts --short for healthy names', () => {
      const r = reconcileZmxSessions(
        { sessions: ['alpha'], malformedLines: [] },
        { sessions: ['alpha'], unhealthySessions: [], malformedLines: [] },
      );
      expect(r).toEqual({ ok: true, sessions: ['alpha'], unhealthySessions: [] });
    });

    it('downgrades a healthy full-list row that --short never saw to UNKNOWN', () => {
      // A crafted cmd= can print a line that parses as a healthy record for any
      // name. Since --short (a real line protocol) did not confirm it, the name
      // must be neither "exists" nor "missing".
      const r = reconcileZmxSessions(
        { sessions: ['real'], malformedLines: [] },
        { sessions: ['real', 'forged'], unhealthySessions: [], malformedLines: [] },
      );
      expect(r).toMatchObject({ ok: true, sessions: ['real'] });
      expect(r.ok && r.unhealthySessions).toContain('forged');
      // Critically, it is NOT reported as a healthy session.
      expect(r.ok && r.sessions).not.toContain('forged');
    });

    it('carries err= rows through as unknown, never as absent', () => {
      const r = reconcileZmxSessions(
        { sessions: [], malformedLines: [] },
        { sessions: [], unhealthySessions: ['broken'], malformedLines: [] },
      );
      expect(r).toEqual({ ok: true, sessions: [], unhealthySessions: ['broken'] });
    });

    it('fails the whole probe on any malformed line', () => {
      expect(reconcileZmxSessions(
        { sessions: [], malformedLines: ['junk'] },
        { sessions: [], unhealthySessions: [], malformedLines: [] },
      )).toEqual({ ok: false });
      expect(reconcileZmxSessions(
        { sessions: [], malformedLines: [] },
        { sessions: [], unhealthySessions: [], malformedLines: ['junk'] },
      )).toEqual({ ok: false });
    });

    it('fails when the two surfaces disagree entirely', () => {
      expect(reconcileZmxSessions(
        { sessions: ['alpha'], malformedLines: [] },
        { sessions: [], unhealthySessions: [], malformedLines: [] },
      )).toEqual({ ok: false });
    });

    it('reports a clean empty listing as authoritative zero sessions', () => {
      expect(reconcileZmxSessions(
        { sessions: [], malformedLines: [] },
        { sessions: [], unhealthySessions: [], malformedLines: [] },
      )).toEqual({ ok: true, sessions: [], unhealthySessions: [] });
    });
  });

  describe('buildZmxBootstrap', () => {
    const opts = {
      cwd: '/work/dir',
      cols: 80,
      rows: 24,
      env: { FOO: 'bar' },
      injectEnv: { SECRET: 'shh' },
    };

    it('injects env via an env(1) prefix on the CLI only', () => {
      const script = buildZmxBootstrap('mycli', ['--flag'], opts);
      expect(script).toContain("'FOO=bar'");
      expect(script).toContain("'SECRET=shh'");
      expect(script).toContain("'/usr/bin/env'");
      expect(script).toContain("'mycli'");
    });

    it('self-deletes so env values do not outlive the launch', () => {
      const script = buildZmxBootstrap('mycli', [], opts);
      expect(script).toContain('rm -f -- "$self"');
      expect(script).toContain('umask 077');
    });

    it('unsets ZMX_SESSION* so a nested zmx cannot target the parent session', () => {
      expect(buildZmxBootstrap('mycli', [], opts)).toContain('unset self ZMX_SESSION ZMX_SESSION_PREFIX');
    });

    it('keeps the PTY root alive after the CLI exits so final history is readable', () => {
      // zmx deletes a session's history the instant its PTY root exits.
      const script = buildZmxBootstrap('mycli', [], opts);
      expect(script).toMatch(/while ! sleep \d+; do :; done/);
      expect(script).not.toMatch(/^exec /m);
    });

    it('shell-escapes values so a quote cannot break out', () => {
      const evil = "'; touch /tmp/dutydeck-pwned; '";
      const script = buildZmxBootstrap('mycli', [], { ...opts, env: { EVIL: evil } });
      // The payload survives verbatim, but only INSIDE a quoted word: every
      // embedded ' is closed-escaped-reopened, so it can never terminate the
      // string and start a new command.
      expect(script).toContain("'EVIL='\\''; touch /tmp/dutydeck-pwned; '\\'''");

      // Prove it by actually running the escaped launch line: replace the CLI
      // with a printer and check the value arrives intact, with no injected
      // command having executed.
      const probe = buildZmxBootstrap('/bin/sh', ['-c', 'printf "[%s]" "$EVIL"'], {
        ...opts,
        cwd: tmpdir(),
        env: { EVIL: evil },
        injectEnv: {},
      // Drop the trailing keep-alive loop so the probe terminates.
      }).replace(/\nwhile ! sleep .*$/, '');
      const r = spawnSync('/bin/sh', ['-c', probe], { encoding: 'utf-8', timeout: 10000 });
      expect(r.stdout).toBe(`[${evil}]`);
      expect(existsSync('/tmp/dutydeck-pwned')).toBe(false);
    });

    it('injectEnv is emitted after env so it wins on a key collision', () => {
      const script = buildZmxBootstrap('mycli', [], {
        ...opts,
        env: { SHARED: 'from-base' },
        injectEnv: { SHARED: 'from-inject' },
      });
      expect(script.indexOf('SHARED=from-base')).toBeLessThan(script.indexOf('SHARED=from-inject'));
    });
  });

  it('creates with `attach`, never `run` (run is an upsert and can hijack a race winner)', () => {
    expect(buildZmxAttachArgs('sess', '/tmp/boot.sh')).toEqual(['attach', 'sess', '/bin/sh', '/tmp/boot.sh']);
  });

  describe('env scrubbing', () => {
    it('is an allowlist, so session env cannot reach the zmx daemon', () => {
      const saved = process.env.MY_SESSION_SECRET;
      process.env.MY_SESSION_SECRET = 'leaked';
      try {
        expect(zmxControlEnv().MY_SESSION_SECRET).toBeUndefined();
      } finally {
        if (saved === undefined) delete process.env.MY_SESSION_SECRET;
        else process.env.MY_SESSION_SECRET = saved;
      }
    });

    it('omits ZMX_SESSION/ZMX_SESSION_PREFIX by construction', () => {
      const saved = { s: process.env.ZMX_SESSION, p: process.env.ZMX_SESSION_PREFIX };
      process.env.ZMX_SESSION = 'parent';
      process.env.ZMX_SESSION_PREFIX = 'pfx';
      try {
        const env = zmxControlEnv();
        expect(env.ZMX_SESSION).toBeUndefined();
        expect(env.ZMX_SESSION_PREFIX).toBeUndefined();
      } finally {
        if (saved.s === undefined) delete process.env.ZMX_SESSION; else process.env.ZMX_SESSION = saved.s;
        if (saved.p === undefined) delete process.env.ZMX_SESSION_PREFIX; else process.env.ZMX_SESSION_PREFIX = saved.p;
      }
    });

    it('pins TERM on the create client — the session PTY inherits it verbatim', () => {
      // zmx sets no TERM of its own; without this every CLI renders colorless.
      expect(zmxSessionEnv().TERM).toBe('xterm-256color');
      expect(zmxControlEnv().TERM).toBeUndefined();
    });
  });

  describe('version gating', () => {
    it('parses the `zmx version` banner (which also prints socket/log dirs)', () => {
      expect(parseZmxVersion('zmx 0.7.1\nsocket_dir /run/user/1000/zmx')).toEqual({ major: 0, minor: 7, patch: 1 });
      expect(parseZmxVersion('nonsense')).toBeUndefined();
    });

    it('requires >= 0.7.0 (older `send` steals leadership and corrupts history)', () => {
      expect(isZmxVersionSupported({ major: 0, minor: 7, patch: 0 })).toBe(true);
      expect(isZmxVersionSupported({ major: 0, minor: 8, patch: 0 })).toBe(true);
      expect(isZmxVersionSupported({ major: 1, minor: 0, patch: 0 })).toBe(true);
      expect(isZmxVersionSupported({ major: 0, minor: 6, patch: 9 })).toBe(false);
    });
  });

  it('normalises history line endings to CRLF without doubling', () => {
    expect(normaliseZmxHistory('a\nb')).toBe('a\r\nb');
    expect(normaliseZmxHistory('a\r\nb')).toBe('a\r\nb');
    expect(normaliseZmxHistory('a\r\r\nb')).toBe('a\r\nb');
  });
});

// Live-session tests need a working zmx >= 0.7 (absent on most dev boxes).
const zmxDescribe = isZmxAvailable() ? describe : describe.skip;

zmxDescribe('ZmxBackend (live)', () => {
  const sessions: string[] = [];
  let backend: ZmxBackend | null = null;

  const newSessionName = () =>
    `dutydeck-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  afterEach(() => {
    backend?.kill();
    backend = null;
    for (const s of sessions) ZmxBackend.killSession(s);
    sessions.length = 0;
  });

  it('spawns, streams history deltas, and destroys the session on kill', async () => {
    const name = newSessionName();
    sessions.push(name);
    expect(ZmxBackend.probeSession(name)).toBe('missing');

    backend = new ZmxBackend(name);
    const received: string[] = [];
    backend.onData(d => received.push(d)); // safe before spawn — callbacks buffer
    backend.spawn('/bin/sh', ['-c', 'echo ZMX-READY; sleep 30'], {
      cwd: tmpdir(),
      cols: 80,
      rows: 24,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
    });

    await waitFor(() => received.join('').includes('ZMX-READY'));
    await waitForAssert(() => {
      expect(ZmxBackend.probeSession(name)).toBe('exists');
    });
    expect(backend.captureCurrentScreen()).toContain('ZMX-READY');

    backend.kill();
    await waitFor(() => ZmxBackend.probeSession(name) === 'missing', 30000);
  }, 120000);

  it('injects env into the CLI without leaking it into the zmx daemon', async () => {
    const name = newSessionName();
    sessions.push(name);
    backend = new ZmxBackend(name);
    const received: string[] = [];
    backend.onData(d => received.push(d));
    backend.spawn('/bin/sh', ['-c', 'echo "VAR=${MY_TEST_VAR} INJECT=${MY_INJECT_VAR}"; sleep 30'], {
      cwd: tmpdir(),
      cols: 80,
      rows: 24,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', MY_TEST_VAR: 'secret123' },
      injectEnv: { MY_INJECT_VAR: 'inject456' },
    });
    await waitFor(() => received.join('').includes('VAR=secret123 INJECT=inject456'));
  }, 120000);

  it('write() reaches the CLI and shows up in the transcript', async () => {
    const name = newSessionName();
    sessions.push(name);
    backend = new ZmxBackend(name);
    const received: string[] = [];
    backend.onData(d => received.push(d));
    backend.spawn('/bin/sh', ['-c', 'read line; echo "GOT:$line"; sleep 30'], {
      cwd: tmpdir(),
      cols: 80,
      rows: 24,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
    });
    await waitForAssert(() => {
      expect(ZmxBackend.probeSession(name)).toBe('exists');
    });
    expect(backend.write('hello-zmx\n')).toBe(true);
    await waitFor(() => received.join('').includes('GOT:hello-zmx'));
  }, 120000);

  it('detach() leaves the session alive; kill() destroys it', async () => {
    const name = newSessionName();
    sessions.push(name);
    const first = new ZmxBackend(name);
    backend = first;
    const received: string[] = [];
    first.onData(d => received.push(d));
    first.spawn('/bin/sh', ['-c', 'echo ZMX-PERSIST; sleep 60'], {
      cwd: tmpdir(),
      cols: 80,
      rows: 24,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
    });
    await waitFor(() => received.join('').includes('ZMX-PERSIST'));

    first.detach();
    await waitForAssert(() => {
      expect(ZmxBackend.probeSession(name)).toBe('exists');
    });
    expect(first.write('x')).toBe(false); // detached backend refuses writes

    // A fresh backend re-observes the surviving session without a second CLI.
    const second = new ZmxBackend(name);
    const reReceived: string[] = [];
    second.onData(d => reReceived.push(d));
    second.spawn('/bin/sh', ['-c', 'true'], {
      cwd: tmpdir(),
      cols: 80,
      rows: 24,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
    });
    backend = second;
    await waitFor(() => reReceived.join('').includes('ZMX-PERSIST'));

    second.kill();
    await waitFor(() => ZmxBackend.probeSession(name) === 'missing', 30000);
  }, 120000);
});
