/**
 * Tests for the CLI session-id reverse lookup.
 *
 * Everything runs against REAL files in real temp directories, built to the
 * shapes verified on this machine's live CLI data:
 *   - claude   ~/.claude/projects/<key>/<uuid>.jsonl
 *   - codex    ~/.codex/history.jsonl + sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
 *   - traex    ~/.trae/cli/... (same dialect, one level deeper)
 *   - grok     ~/.grok/sessions/<enc-cwd>/{prompt_history.jsonl,<sid>/}
 *   - opencode ~/.local/share/opencode/opencode.db (real SQLite via node:sqlite)
 *
 * Every positive case is paired with a DECOY session written to the same
 * place, because the whole point of the marker anchor is that it survives
 * siblings: a resolver that just picks the newest file passes the positive
 * case and fails these.
 *
 * Run: npx vitest run packages/pty-driver/src/session-id/session-id.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  adapterIdsWithSessionIdLookup,
  buildSessionMarker,
  isUsableMarker,
  MIN_MARKER_SESSION_ID_LENGTH,
  readOpenCodeSessionId,
  resolveCliSessionId,
} from './index.js';

const OUR_SESSION = 'ses_11111111-2222-3333-4444-555555555555';
const OTHER_SESSION = 'ses_99999999-8888-7777-6666-555555555555';
const OUR_UUID = OUR_SESSION.replace(/^ses_/, '');

/** The first prompt the driver actually sends: routing block + marker + text. */
function firstPrompt(sessionId: string, text: string): string {
  return `<dockmux_routing>\n  hints\n</dockmux_routing>\n${buildSessionMarker(sessionId)}\n${text}`;
}

let tempRoots: string[] = [];
const savedEnv: Record<string, string | undefined> = {};

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `dockmux-sid-${prefix}-`));
  tempRoots.push(dir);
  return dir;
}

function setEnv(key: string, value: string): void {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  process.env[key] = value;
}

beforeEach(() => {
  tempRoots = [];
});

afterEach(() => {
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const key of Object.keys(savedEnv)) delete savedEnv[key];
});

function writeJsonl(path: string, entries: unknown[]): void {
  writeFileSync(path, entries.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');
}

// ─── marker ────────────────────────────────────────────────────────────────

describe('session marker', () => {
  it('wraps the session id in a recognizable tag', () => {
    expect(buildSessionMarker(OUR_SESSION)).toBe(`<dockmux_session_id>${OUR_SESSION}</dockmux_session_id>`);
  });

  it('rejects ids too short to be a safe fingerprint', () => {
    expect(isUsableMarker(OUR_SESSION)).toBe(true);
    expect(isUsableMarker('abc')).toBe(false);
    expect(isUsableMarker('')).toBe(false);
    expect(isUsableMarker('x'.repeat(MIN_MARKER_SESSION_ID_LENGTH))).toBe(true);
  });
});

// ─── claude-code ───────────────────────────────────────────────────────────

/** Build a Claude project dir for `cwd` under a fake CLAUDE_CONFIG_DIR. */
function claudeProject(configDir: string, cwd: string): string {
  const key = cwd.replace(/[^A-Za-z0-9-]/g, '-');
  const dir = join(configDir, 'projects', key);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function claudeTranscript(sessionId: string, prompt: string): unknown[] {
  return [
    { type: 'mode', mode: 'normal', sessionId },
    {
      parentUuid: null,
      isSidechain: false,
      type: 'user',
      uuid: 'u-1',
      timestamp: '2026-08-30T01:00:00.000Z',
      cwd: '/repo',
      sessionId,
      version: '2.1.247',
      message: { role: 'user', content: prompt },
    },
    {
      type: 'assistant',
      uuid: 'a-1',
      sessionId,
      message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    },
  ];
}

describe('claude-code session id lookup', () => {
  it('uses the pinned --session-id file when it exists (no scan)', () => {
    const configDir = makeTempDir('claude-cfg');
    const cwd = makeTempDir('claude-cwd');
    setEnv('CLAUDE_CONFIG_DIR', configDir);
    const projectDir = claudeProject(configDir, cwd);
    // Claude accepted our pinned uuid and named the file after it.
    writeJsonl(join(projectDir, `${OUR_UUID}.jsonl`), claudeTranscript(OUR_UUID, 'hi'));

    expect(resolveCliSessionId('claude-code', { sessionId: OUR_SESSION, cwd })).toBe(OUR_UUID);
  });

  it('finds our session by marker when the CLI minted its own id, ignoring a decoy', () => {
    const configDir = makeTempDir('claude-cfg');
    const cwd = makeTempDir('claude-cwd');
    setEnv('CLAUDE_CONFIG_DIR', configDir);
    const projectDir = claudeProject(configDir, cwd);

    const ourCliId = 'aaaaaaaa-0000-0000-0000-000000000001';
    const decoyCliId = 'bbbbbbbb-0000-0000-0000-000000000002';
    writeJsonl(join(projectDir, `${ourCliId}.jsonl`),
      claudeTranscript(ourCliId, firstPrompt(OUR_SESSION, 'do our work')));
    // Decoy: same cwd, DIFFERENT dockmux session, written last so a
    // newest-wins resolver would pick it.
    writeJsonl(join(projectDir, `${decoyCliId}.jsonl`),
      claudeTranscript(decoyCliId, firstPrompt(OTHER_SESSION, 'do their work')));

    expect(resolveCliSessionId('claude-code', { sessionId: OUR_SESSION, cwd })).toBe(ourCliId);
    expect(resolveCliSessionId('claude-code', { sessionId: OTHER_SESSION, cwd })).toBe(decoyCliId);
  });

  it('reads the marker out of array-form message content', () => {
    const configDir = makeTempDir('claude-cfg');
    const cwd = makeTempDir('claude-cwd');
    setEnv('CLAUDE_CONFIG_DIR', configDir);
    const projectDir = claudeProject(configDir, cwd);
    const cliId = 'cccccccc-0000-0000-0000-000000000003';
    writeJsonl(join(projectDir, `${cliId}.jsonl`), [
      {
        type: 'user',
        sessionId: cliId,
        message: {
          role: 'user',
          content: [{ type: 'text', text: firstPrompt(OUR_SESSION, 'array form') }],
        },
      },
    ]);

    expect(resolveCliSessionId('claude-code', { sessionId: OUR_SESSION, cwd })).toBe(cliId);
  });

  it('ignores a sidechain (sub-agent) transcript carrying the marker', () => {
    const configDir = makeTempDir('claude-cfg');
    const cwd = makeTempDir('claude-cwd');
    setEnv('CLAUDE_CONFIG_DIR', configDir);
    const projectDir = claudeProject(configDir, cwd);
    writeJsonl(join(projectDir, 'dddddddd-0000-0000-0000-000000000004.jsonl'), [
      {
        type: 'user',
        isSidechain: true,
        sessionId: 'dddddddd-0000-0000-0000-000000000004',
        message: { role: 'user', content: firstPrompt(OUR_SESSION, 'subagent echo') },
      },
    ]);

    expect(resolveCliSessionId('claude-code', { sessionId: OUR_SESSION, cwd })).toBeUndefined();
  });

  it('returns undefined when the project dir does not exist', () => {
    const configDir = makeTempDir('claude-cfg');
    const cwd = makeTempDir('claude-cwd');
    setEnv('CLAUDE_CONFIG_DIR', configDir);
    expect(resolveCliSessionId('claude-code', { sessionId: OUR_SESSION, cwd })).toBeUndefined();
  });
});

// ─── codex / traex ─────────────────────────────────────────────────────────

interface RolloutOpts {
  sessionId: string;
  cwd: string;
  prompt: string;
}

/** A rollout file in the shape verified against real ~/.codex data:
 *  session_meta head record, then response_item user message. */
function writeRollout(dayDir: string, opts: RolloutOpts): string {
  const path = join(dayDir, `rollout-2026-08-30T01-00-00-${opts.sessionId}.jsonl`);
  writeJsonl(path, [
    {
      timestamp: '2026-08-30T01:00:00.000Z',
      type: 'session_meta',
      payload: {
        session_id: opts.sessionId,
        id: opts.sessionId,
        timestamp: '2026-08-30T01:00:00.000Z',
        cwd: opts.cwd,
        originator: 'codex-tui',
        cli_version: '0.145.0',
        source: 'cli',
      },
    },
    {
      timestamp: '2026-08-30T01:00:01.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        id: 'msg_1',
        role: 'user',
        content: [{ type: 'input_text', text: opts.prompt }],
      },
    },
  ]);
  return path;
}

function codexDayDir(root: string): string {
  const dir = join(root, 'sessions', '2026', '08', '30');
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe.each([
  { adapter: 'codex', envKey: 'CODEX_HOME', sub: '' },
  { adapter: 'traex', envKey: 'TRAE_HOME', sub: 'cli' },
])('$adapter session id lookup', ({ adapter, envKey, sub }) => {
  const ourCliId = '01a02e6e-8e60-74a0-9293-3eeb2f2ba5b5';
  const decoyCliId = '01a02e6e-1111-2222-3333-444444444444';

  function makeHome(): { home: string; root: string; cwd: string } {
    const home = makeTempDir(`${adapter}-home`);
    const cwd = makeTempDir(`${adapter}-cwd`);
    setEnv(envKey, home);
    const root = sub ? join(home, sub) : home;
    mkdirSync(root, { recursive: true });
    return { home, root, cwd };
  }

  it('resolves via history.jsonl, taking the newest line carrying our marker', () => {
    const { root, cwd } = makeHome();
    writeJsonl(join(root, 'history.jsonl'), [
      { session_id: decoyCliId, ts: 1785316592, text: firstPrompt(OTHER_SESSION, 'their work') },
      { session_id: ourCliId, ts: 1785316593, text: firstPrompt(OUR_SESSION, 'our work') },
      // A later submit from the decoy session must not win.
      { session_id: decoyCliId, ts: 1785316594, text: 'follow-up with no marker' },
    ]);

    expect(resolveCliSessionId(adapter, { sessionId: OUR_SESSION, cwd })).toBe(ourCliId);
    expect(resolveCliSessionId(adapter, { sessionId: OTHER_SESSION, cwd })).toBe(decoyCliId);
  });

  it('prefers the newest history line when one session carries the marker twice', () => {
    const { root, cwd } = makeHome();
    const resumedId = '01a02e6e-aaaa-bbbb-cccc-dddddddddddd';
    writeJsonl(join(root, 'history.jsonl'), [
      { session_id: ourCliId, ts: 1, text: firstPrompt(OUR_SESSION, 'first run') },
      { session_id: resumedId, ts: 2, text: firstPrompt(OUR_SESSION, 'after a resume') },
    ]);

    expect(resolveCliSessionId(adapter, { sessionId: OUR_SESSION, cwd })).toBe(resumedId);
  });

  it('falls back to the rollout tree when history.jsonl is absent', () => {
    const { root, cwd } = makeHome();
    const dayDir = codexDayDir(root);
    writeRollout(dayDir, { sessionId: decoyCliId, cwd, prompt: firstPrompt(OTHER_SESSION, 'theirs') });
    writeRollout(dayDir, { sessionId: ourCliId, cwd, prompt: firstPrompt(OUR_SESSION, 'ours') });

    expect(resolveCliSessionId(adapter, { sessionId: OUR_SESSION, cwd })).toBe(ourCliId);
  });

  it('rejects a rollout whose recorded cwd is a different project', () => {
    const { root, cwd } = makeHome();
    const otherCwd = makeTempDir(`${adapter}-othercwd`);
    const dayDir = codexDayDir(root);
    // Same marker, but the session ran somewhere else — cannot be ours.
    writeRollout(dayDir, { sessionId: ourCliId, cwd: otherCwd, prompt: firstPrompt(OUR_SESSION, 'ours') });

    expect(resolveCliSessionId(adapter, { sessionId: OUR_SESSION, cwd })).toBeUndefined();
  });

  it('returns undefined when nothing carries the marker', () => {
    const { root, cwd } = makeHome();
    writeJsonl(join(root, 'history.jsonl'), [
      { session_id: decoyCliId, ts: 1, text: firstPrompt(OTHER_SESSION, 'theirs') },
    ]);

    expect(resolveCliSessionId(adapter, { sessionId: OUR_SESSION, cwd })).toBeUndefined();
  });

  it('survives a truncated / malformed history tail', () => {
    const { root, cwd } = makeHome();
    writeFileSync(join(root, 'history.jsonl'),
      `${JSON.stringify({ session_id: ourCliId, ts: 1, text: firstPrompt(OUR_SESSION, 'ours') })}\n`
      + '{"session_id":"broken","ts":2,"text":"half a li\n',
      'utf8');

    expect(resolveCliSessionId(adapter, { sessionId: OUR_SESSION, cwd })).toBe(ourCliId);
  });
});

// ─── grok ──────────────────────────────────────────────────────────────────

describe('grok session id lookup', () => {
  const ourCliId = '019dd80d-d922-7a11-8339-0208d8c5b4ec';
  const decoyCliId = '019dd80d-1111-2222-3333-444444444444';

  function makeGrokHome(): { home: string; cwd: string; bucket: string } {
    const home = makeTempDir('grok-home');
    const cwd = makeTempDir('grok-cwd');
    setEnv('GROK_HOME', home);
    const bucket = join(home, 'sessions', encodeURIComponent(cwd));
    mkdirSync(bucket, { recursive: true });
    return { home, cwd, bucket };
  }

  it('uses the pinned --session-id directory when Grok accepted it', () => {
    const { cwd, bucket } = makeGrokHome();
    mkdirSync(join(bucket, OUR_SESSION), { recursive: true });

    expect(resolveCliSessionId('grok', { sessionId: OUR_SESSION, cwd })).toBe(OUR_SESSION);
  });

  it('falls back to prompt_history.jsonl, ignoring a concurrent session in the same bucket', () => {
    const { cwd, bucket } = makeGrokHome();
    writeJsonl(join(bucket, 'prompt_history.jsonl'), [
      { timestamp: 1, session_id: decoyCliId, prompt: firstPrompt(OTHER_SESSION, 'theirs'), is_bash: false },
      { timestamp: 2, session_id: ourCliId, prompt: firstPrompt(OUR_SESSION, 'ours'), is_bash: false },
      { timestamp: 3, session_id: decoyCliId, prompt: 'their follow-up', is_bash: false },
    ]);

    expect(resolveCliSessionId('grok', { sessionId: OUR_SESSION, cwd })).toBe(ourCliId);
    expect(resolveCliSessionId('grok', { sessionId: OTHER_SESSION, cwd })).toBe(decoyCliId);
  });

  it('resolves a hashed bucket via its .cwd marker file (long / CJK cwd)', () => {
    const home = makeTempDir('grok-home');
    const cwd = makeTempDir('grok-cwd');
    setEnv('GROK_HOME', home);
    // Grok used a slug+hash bucket name; the real path lives in `.cwd`.
    const hashed = join(home, 'sessions', 'long-path-a1b2c3');
    mkdirSync(hashed, { recursive: true });
    writeFileSync(join(hashed, '.cwd'), `${cwd}\n`, 'utf8');
    writeJsonl(join(hashed, 'prompt_history.jsonl'), [
      { timestamp: 1, session_id: ourCliId, prompt: firstPrompt(OUR_SESSION, 'ours'), is_bash: false },
    ]);

    expect(resolveCliSessionId('grok', { sessionId: OUR_SESSION, cwd })).toBe(ourCliId);
  });

  it('returns undefined when the bucket has no matching submit', () => {
    const { cwd, bucket } = makeGrokHome();
    writeJsonl(join(bucket, 'prompt_history.jsonl'), [
      { timestamp: 1, session_id: decoyCliId, prompt: firstPrompt(OTHER_SESSION, 'theirs'), is_bash: false },
    ]);

    expect(resolveCliSessionId('grok', { sessionId: OUR_SESSION, cwd })).toBeUndefined();
  });
});

// ─── opencode (real SQLite) ────────────────────────────────────────────────

/** Build a real OpenCode V1-schema database with the given user parts. */
function buildOpenCodeDb(
  dbPath: string,
  rows: Array<{ sessionId: string; messageId: string; text: string; timeCreated: number }>,
): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { DatabaseSync } = require('node:sqlite') as {
    DatabaseSync: new (path: string) => {
      exec(sql: string): void;
      prepare(sql: string): { run(...p: unknown[]): unknown };
      close(): void;
    };
  };
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT,
        parent_id TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT,
        data TEXT, time_created INTEGER);
    `);
    const insSession = db.prepare('INSERT OR IGNORE INTO session (id, directory, time_created, time_updated) VALUES (?, ?, ?, ?)');
    const insMessage = db.prepare('INSERT INTO message (id, session_id, data) VALUES (?, ?, ?)');
    const insPart = db.prepare('INSERT INTO part (id, message_id, session_id, data, time_created) VALUES (?, ?, ?, ?, ?)');
    for (const row of rows) {
      insSession.run(row.sessionId, '/repo', row.timeCreated, row.timeCreated);
      insMessage.run(row.messageId, row.sessionId, JSON.stringify({ role: 'user' }));
      insPart.run(`prt_${row.messageId}`, row.messageId, row.sessionId,
        JSON.stringify({ type: 'text', text: row.text }), row.timeCreated);
    }
  } finally {
    db.close();
  }
}

describe('opencode session id lookup', () => {
  const ourCliId = 'ses_8f2a1b0c9d';
  const decoyCliId = 'ses_1a2b3c4d5e';

  it('finds our session id in the part table, ignoring a concurrent session', () => {
    const dir = makeTempDir('opencode');
    const dbPath = join(dir, 'opencode.db');
    buildOpenCodeDb(dbPath, [
      { sessionId: decoyCliId, messageId: 'msg_1', text: firstPrompt(OTHER_SESSION, 'theirs'), timeCreated: 1 },
      { sessionId: ourCliId, messageId: 'msg_2', text: firstPrompt(OUR_SESSION, 'ours'), timeCreated: 2 },
    ]);

    expect(readOpenCodeSessionId(dbPath, OUR_SESSION)).toBe(ourCliId);
    expect(readOpenCodeSessionId(dbPath, OTHER_SESSION)).toBe(decoyCliId);
  });

  it('prefers the newest part when the same marker appears twice (resumed session)', () => {
    const dir = makeTempDir('opencode');
    const dbPath = join(dir, 'opencode.db');
    const resumedId = 'ses_zzzzzzzzzz';
    buildOpenCodeDb(dbPath, [
      { sessionId: ourCliId, messageId: 'msg_1', text: firstPrompt(OUR_SESSION, 'first run'), timeCreated: 1 },
      { sessionId: resumedId, messageId: 'msg_2', text: firstPrompt(OUR_SESSION, 'after resume'), timeCreated: 2 },
    ]);

    expect(readOpenCodeSessionId(dbPath, OUR_SESSION)).toBe(resumedId);
  });

  it('returns undefined for an unknown marker and for a missing database', () => {
    const dir = makeTempDir('opencode');
    const dbPath = join(dir, 'opencode.db');
    buildOpenCodeDb(dbPath, [
      { sessionId: decoyCliId, messageId: 'msg_1', text: firstPrompt(OTHER_SESSION, 'theirs'), timeCreated: 1 },
    ]);

    expect(readOpenCodeSessionId(dbPath, OUR_SESSION)).toBeUndefined();
    expect(readOpenCodeSessionId(join(dir, 'nope.db'), OUR_SESSION)).toBeUndefined();
  });

  it('resolves through the registry using XDG_DATA_HOME', () => {
    const xdg = makeTempDir('opencode-xdg');
    const dataDir = join(xdg, 'opencode');
    mkdirSync(dataDir, { recursive: true });
    setEnv('XDG_DATA_HOME', xdg);
    buildOpenCodeDb(join(dataDir, 'opencode.db'), [
      { sessionId: ourCliId, messageId: 'msg_1', text: firstPrompt(OUR_SESSION, 'ours'), timeCreated: 1 },
    ]);

    expect(resolveCliSessionId('opencode', { sessionId: OUR_SESSION, cwd: '/repo' })).toBe(ourCliId);
  });
});

// ─── registry / degradation ────────────────────────────────────────────────

describe('resolveCliSessionId registry', () => {
  it('covers the CLIs that need reverse lookup', () => {
    expect(adapterIdsWithSessionIdLookup().sort()).toEqual(
      ['claude-code', 'codex', 'grok', 'opencode', 'traex'],
    );
  });

  it('returns undefined for an adapter with no lookup instead of throwing', () => {
    const cwd = makeTempDir('unknown');
    expect(resolveCliSessionId('gemini', { sessionId: OUR_SESSION, cwd })).toBeUndefined();
    expect(resolveCliSessionId('kimi', { sessionId: OUR_SESSION, cwd })).toBeUndefined();
    expect(resolveCliSessionId('not-a-real-cli', { sessionId: OUR_SESSION, cwd })).toBeUndefined();
  });

  it('refuses to fingerprint on a session id too short to be unique', () => {
    const configDir = makeTempDir('claude-cfg');
    const cwd = makeTempDir('claude-cwd');
    setEnv('CLAUDE_CONFIG_DIR', configDir);
    const projectDir = claudeProject(configDir, cwd);
    writeJsonl(join(projectDir, 'eeeeeeee-0000-0000-0000-000000000005.jsonl'), [
      {
        type: 'user',
        sessionId: 'eeeeeeee-0000-0000-0000-000000000005',
        message: { role: 'user', content: 'the prompt mentions abc somewhere' },
      },
    ]);

    expect(resolveCliSessionId('claude-code', { sessionId: 'abc', cwd })).toBeUndefined();
  });

  it('never throws on hostile / unreadable data directories', () => {
    const cwd = makeTempDir('hostile-cwd');
    // Point every CLI home at a FILE, not a directory.
    const notADir = join(makeTempDir('hostile'), 'file');
    writeFileSync(notADir, 'not a directory', 'utf8');
    setEnv('CLAUDE_CONFIG_DIR', notADir);
    setEnv('CODEX_HOME', notADir);
    setEnv('TRAE_HOME', notADir);
    setEnv('GROK_HOME', notADir);
    setEnv('XDG_DATA_HOME', notADir);

    for (const adapter of adapterIdsWithSessionIdLookup()) {
      expect(() => resolveCliSessionId(adapter, { sessionId: OUR_SESSION, cwd })).not.toThrow();
      expect(resolveCliSessionId(adapter, { sessionId: OUR_SESSION, cwd })).toBeUndefined();
    }
  });
});
