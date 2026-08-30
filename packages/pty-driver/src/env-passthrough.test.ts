/**
 * Env passthrough: the transcript tailer and the session-id lookup must read
 * the environment the CLI CHILD got, not the daemon's.
 *
 * WHY THIS FILE EXISTS (a real end-to-end failure, not a hypothetical)
 * --------------------------------------------------------------------
 * `mergedEnv` deliberately strips `ANTHROPIC_*` / `CLAUDE_*` from the child:
 * those are the daemon's own credentials. But `CLAUDE_CONFIG_DIR` is not a
 * credential, it is a LOCATION, and stripping it moves the CLI's transcript
 * without telling the tailer:
 *
 *   daemon: CLAUDE_CONFIG_DIR=/some/dir   → tailer watched /some/dir
 *   child:  (stripped)                    → claude wrote $HOME/.claude
 *
 * Observed against the real `claude` binary: the screen showed a complete
 * answer while the event stream carried `error{"Agent 未返回最终输出"}` and the
 * task was marked failed — the runtime never saw an assistant text event
 * because the tailer was watching the wrong tree.
 *
 * The mirror case is `agent.env` (dockmux's supported way to isolate accounts
 * and sandboxes, and what scripts/e2e-smoke.mjs itself uses): the child writes
 * where `agent.env` says, the daemon-env tailer looks somewhere else.
 *
 * The tests below drive BOTH directions through the real driver with a real
 * PTY and a fake CLI that resolves its data dir exactly the way a real CLI
 * does — from its OWN environment. Every one of them is hermetic: `HOME`,
 * `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and `XDG_DATA_HOME` are all temp dirs, so
 * nothing ever reads or writes the developer's real `~/.claude`, `~/.codex`
 * or `~/.local/share/opencode`.
 *
 * Run: npx vitest run packages/pty-driver/src/env-passthrough.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentConfig, NormalizedDriverEvent } from '@dockmux/shared';
import type { CliAdapter, PtyLike } from '@dockmux/cli-adapters';
import { PtyBackend } from '@dockmux/session-backends';
import { PtyCliDriver } from './driver.js';
import { buildSessionMarker, resolveCliSessionId } from './session-id/index.js';
import { readOpenCodeSessionId } from './session-id/opencode.js';
import { claudeDataDir, claudeProjectDir, codexHome, opencodeDbPath, type CliPathEnv } from './cli-paths.js';
import { resolveClaudeTranscriptPath } from './transcript/claude.js';
import { createTranscriptTailer } from './transcript/index.js';
import { ClaudeTranscriptTailer } from './transcript/claude.js';

const SESSION_ID = 'ses_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const SESSION_UUID = SESSION_ID.replace(/^ses_/, '');

let tempRoots: string[] = [];
const savedEnv: Record<string, string | undefined> = {};

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `dockmux-env-${prefix}-`));
  tempRoots.push(dir);
  return dir;
}

function setEnv(key: string, value: string): void {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  process.env[key] = value;
}

function unsetEnv(key: string): void {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  delete process.env[key];
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

async function waitForAssert<T>(fn: () => T, timeoutMs = 20_000, intervalMs = 100): Promise<T> {
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

function agentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: 'mock-agent',
    name: 'Mock Agent',
    command: process.execPath,
    args: [],
    protocol: 'pty-cli',
    env: {},
    permissionMode: 'full-trust',
    timeout: 600,
    capabilities: { pause: false, resume: true },
    builtin: false,
    ...overrides,
  } as AgentConfig;
}

/**
 * A fake `claude` that resolves its data dir THE WAY A REAL CLI DOES: from its
 * own environment (`$CLAUDE_CONFIG_DIR`, else `$HOME/.claude`), never from a
 * path handed to it. That is what makes these tests meaningful — the child and
 * the tailer must independently agree on one directory.
 *
 * It also creates the transcript AT STARTUP, like the real CLI does, rather
 * than on the first answer: the tailer starts reading at a file's END so it
 * never replays history, so a transcript that springs into existence with the
 * answer already inside it would be skipped. That is a property of the tailer,
 * not of this bug, and modelling the real CLI keeps it out of the way.
 */
const MOCK_CLAUDE_SOURCE = `
import { appendFileSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const dataDir = process.env.CLAUDE_CONFIG_DIR?.trim()
  || join(process.env.HOME || homedir(), '.claude');
const sessionArg = process.argv[process.argv.indexOf('--session-id') + 1];
const projectKey = realpathSync(process.cwd()).replace(/[^A-Za-z0-9-]/g, '-');
const dir = join(dataDir, 'projects', projectKey);
mkdirSync(dir, { recursive: true });
const file = join(dir, (sessionArg || 'mock') + '.jsonl');
const write = entry => appendFileSync(file, JSON.stringify(entry) + '\\n');
// Session-start record, written before any turn — this is what the tailer
// latches onto, exactly as with a real claude session.
writeFileSync(file, JSON.stringify({ type: 'mode', mode: 'normal', sessionId: sessionArg }) + '\\n');

process.stdout.write('Mock Claude\\r\\n\\u276f ');
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  if (!/[\\r\\n]/.test(buffer)) return;
  const prompt = buffer.replace(/\\u001b\\[20[01]~/g, '').replace(/[\\r\\n]+/g, ' ').trim();
  buffer = '';
  if (!prompt) return;
  setTimeout(() => {
    write({ type: 'user', sessionId: sessionArg, message: { role: 'user', content: prompt } });
    write({ type: 'assistant', sessionId: sessionArg,
      message: { role: 'assistant', content: [{ type: 'text', text: 'ANSWER_FROM_TRANSCRIPT' }] } });
    process.stdout.write('\\r\\n\\u2733 Worked for 1s\\r\\n\\u276f ');
  }, 150);
});
process.stdin.resume();
`;

/** An adapter that IS claude-code as far as the registries are concerned. */
function claudeLikeAdapter(fixturePath: string, id = 'claude-code'): CliAdapter {
  return {
    id,
    capabilities: { resume: true },
    buildArgs: ({ sessionId }) => [fixturePath, '--session-id', sessionId.replace(/^ses_/, '')],
    writeInput: (backend: PtyLike, prompt: string) => {
      backend.write(prompt.replace(/\n/g, ' ') + '\r');
    },
    completionPattern: /✳ Worked for \d+s/,
    readyPattern: /❯/,
  };
}

function textEvents(events: NormalizedDriverEvent[]): string[] {
  return events.filter(e => e.type === 'text').map(e => String(e.data.text));
}

/**
 * Wait until the CLI has created its transcript AND the tailer has had time to
 * latch onto it.
 *
 * A directory-resolved tailer starts reading at the file's END so it never
 * replays history, and it only latches on a poll tick. Send a prompt the
 * instant the driver starts and the whole session — file creation plus the
 * answer — can land inside one 300ms window, so the tailer latches past the
 * answer and sees nothing. A real CLI writes its transcript at session start
 * and answers seconds later, so this reproduces the real ordering instead of
 * a race that only a zero-latency fake can hit.
 */
async function awaitTranscriptLatched(cwd: string, env: CliPathEnv): Promise<void> {
  await waitForAssert(() => {
    expect(resolveClaudeTranscriptPath(cwd, env), 'CLI never created its transcript').toBeDefined();
  });
  await new Promise(resolve => setTimeout(resolve, 800));   // > 2 poll intervals
}

// ─── cli-paths: the helpers themselves ─────────────────────────────────────

describe('cli-paths helpers read the env they are given', () => {
  it('resolves against an explicit env, not process.env', () => {
    setEnv('CLAUDE_CONFIG_DIR', '/daemon/claude');
    setEnv('CODEX_HOME', '/daemon/codex');
    setEnv('XDG_DATA_HOME', '/daemon/xdg');

    const childEnv = {
      CLAUDE_CONFIG_DIR: '/child/claude',
      CODEX_HOME: '/child/codex',
      XDG_DATA_HOME: '/child/xdg',
    };

    expect(claudeDataDir(childEnv)).toBe('/child/claude');
    expect(codexHome(childEnv)).toBe('/child/codex');
    expect(opencodeDbPath(childEnv)).toBe('/child/xdg/opencode/opencode.db');
  });

  it('falls back to the env\'s own HOME when the CLI var is absent (the stripped-child case)', () => {
    // Exactly what the child sees after mergedEnv removes CLAUDE_*: no
    // CLAUDE_CONFIG_DIR at all, so the CLI writes $HOME/.claude — and $HOME
    // may itself have been moved by agent.env for sandbox isolation.
    setEnv('CLAUDE_CONFIG_DIR', '/daemon/claude');
    const childEnv = { HOME: '/child/home' };

    expect(claudeDataDir(childEnv)).toBe('/child/home/.claude');
    expect(codexHome(childEnv)).toBe('/child/home/.codex');
    expect(opencodeDbPath(childEnv)).toBe('/child/home/.local/share/opencode/opencode.db');
  });

  it('still defaults to process.env when no env is passed (existing callers unchanged)', () => {
    setEnv('CLAUDE_CONFIG_DIR', '/daemon/claude');
    expect(claudeDataDir()).toBe('/daemon/claude');
    expect(claudeProjectDir('/repo')).toBe('/daemon/claude/projects/-repo');
  });

  it('reads at CALL time, so a later env change is picked up', () => {
    setEnv('CLAUDE_CONFIG_DIR', '/first');
    expect(claudeDataDir()).toBe('/first');
    setEnv('CLAUDE_CONFIG_DIR', '/second');
    expect(claudeDataDir()).toBe('/second');
  });
});

// ─── transcript resolution with a divergent env ────────────────────────────

describe('transcript path resolution follows the child env', () => {
  it('finds the transcript under the CHILD dir while the daemon points elsewhere', () => {
    const daemonDir = makeTempDir('daemon-claude');
    const childDir = makeTempDir('child-claude');
    const cwd = makeTempDir('cwd');
    setEnv('CLAUDE_CONFIG_DIR', daemonDir);

    // Only the child's tree has the transcript.
    const projectDir = join(childDir, 'projects', cwd.replace(/[^A-Za-z0-9-]/g, '-'));
    mkdirSync(projectDir, { recursive: true });
    const file = join(projectDir, `${SESSION_UUID}.jsonl`);
    writeFileSync(file, JSON.stringify({ type: 'mode', sessionId: SESSION_UUID }) + '\n', 'utf8');

    expect(resolveClaudeTranscriptPath(cwd, { CLAUDE_CONFIG_DIR: childDir })).toBe(file);
    // And the daemon's own env genuinely resolves somewhere else — otherwise
    // the assertion above would pass for the wrong reason.
    expect(resolveClaudeTranscriptPath(cwd)).toBeUndefined();
  });
});

// ─── driver end-to-end: direction 1 (daemon set it, child got it stripped) ──

describe('PtyCliDriver transcript tailer uses the spawned child env', () => {
  it('direction 1: daemon has CLAUDE_CONFIG_DIR, child is stripped and writes $HOME/.claude', async () => {
    // The exact real-machine failure. mergedEnv removes CLAUDE_CONFIG_DIR from
    // the child, so the CLI falls back to its home — which agent.env has moved
    // to a temp dir here, keeping the test off the real ~/.claude.
    const daemonDir = makeTempDir('daemon-claude');
    const childHome = makeTempDir('child-home');
    const cwd = makeTempDir('cwd');
    const fixturePath = join(cwd, 'mock-claude.mjs');
    writeFileSync(fixturePath, MOCK_CLAUDE_SOURCE, 'utf8');

    setEnv('CLAUDE_CONFIG_DIR', daemonDir);   // the daemon's own data dir

    const events: NormalizedDriverEvent[] = [];
    const driver = new PtyCliDriver({
      agent: agentConfig({ cwd, env: { HOME: childHome } }),
      adapter: claudeLikeAdapter(fixturePath),
      backend: new PtyBackend(),
      onEvent: e => events.push(e),
      onExit: () => {},
      sessionId: SESSION_ID,
    });

    await driver.start();
    await awaitTranscriptLatched(cwd, { HOME: childHome });
    await driver.send('probe');
    await waitForAssert(() => {
      expect(textEvents(events)).toContain('ANSWER_FROM_TRANSCRIPT');
    });

    // The CLI really did write under the CHILD's home, not the daemon's dir —
    // proving the tailer had to follow the child to find anything.
    expect(resolveClaudeTranscriptPath(cwd, { HOME: childHome })).toBeDefined();
    expect(resolveClaudeTranscriptPath(cwd, { CLAUDE_CONFIG_DIR: daemonDir })).toBeUndefined();

    await driver.stop();
  }, 40_000);

  it('direction 2: agent.env sets CLAUDE_CONFIG_DIR and the tailer follows it there', async () => {
    // agent.env is dockmux's supported multi-account / sandbox channel (and
    // what e2e-smoke uses). The child writes where it says; a daemon-env
    // tailer would watch the daemon's dir and see nothing.
    const daemonDir = makeTempDir('daemon-claude');
    const childDir = makeTempDir('child-claude');
    const cwd = makeTempDir('cwd');
    const fixturePath = join(cwd, 'mock-claude.mjs');
    writeFileSync(fixturePath, MOCK_CLAUDE_SOURCE, 'utf8');

    setEnv('CLAUDE_CONFIG_DIR', daemonDir);

    const events: NormalizedDriverEvent[] = [];
    const driver = new PtyCliDriver({
      agent: agentConfig({ cwd, env: { CLAUDE_CONFIG_DIR: childDir } }),
      adapter: claudeLikeAdapter(fixturePath),
      backend: new PtyBackend(),
      onEvent: e => events.push(e),
      onExit: () => {},
      sessionId: SESSION_ID,
    });

    await driver.start();
    await awaitTranscriptLatched(cwd, { CLAUDE_CONFIG_DIR: childDir });
    await driver.send('probe');
    await waitForAssert(() => {
      expect(textEvents(events)).toContain('ANSWER_FROM_TRANSCRIPT');
    });

    expect(resolveClaudeTranscriptPath(cwd, { CLAUDE_CONFIG_DIR: childDir })).toBeDefined();
    expect(resolveClaudeTranscriptPath(cwd, { CLAUDE_CONFIG_DIR: daemonDir })).toBeUndefined();

    await driver.stop();
  }, 40_000);
});

// ─── driver end-to-end: session-id reverse lookup ──────────────────────────

describe('PtyCliDriver session-id lookup uses the spawned child env', () => {
  it('resolves codex\'s id from the CHILD CODEX_HOME, not the daemon\'s decoy', async () => {
    // A DECOY under the daemon's CODEX_HOME carrying the same marker: an
    // implementation that ignores the child env resolves the decoy id, so this
    // catches "wrong answer", not merely "no answer".
    const daemonHome = makeTempDir('daemon-codex');
    const childHome = makeTempDir('child-codex');
    const cwd = makeTempDir('cwd');
    const fixturePath = join(cwd, 'mock-cli.mjs');
    writeFileSync(fixturePath, "process.stdout.write('MOCK READY\\n'); setInterval(() => {}, 1000);\n", 'utf8');

    const marker = buildSessionMarker(SESSION_ID);
    const decoyId = '01a02e6e-dead-beef-0000-000000000000';
    const trueId = '01a02e6e-8e60-74a0-9293-3eeb2f2ba5b5';
    writeFileSync(join(daemonHome, 'history.jsonl'),
      JSON.stringify({ session_id: decoyId, ts: 1, text: `${marker}\nfrom the daemon dir` }) + '\n', 'utf8');
    writeFileSync(join(childHome, 'history.jsonl'),
      JSON.stringify({ session_id: trueId, ts: 1, text: `${marker}\nfrom the child dir` }) + '\n', 'utf8');

    setEnv('CODEX_HOME', daemonHome);

    const resumeIds: string[] = [];
    const adapter: CliAdapter = {
      id: 'codex',
      capabilities: { resume: true },
      buildArgs: ctx => {
        if (ctx.resume && ctx.resumeSessionId !== undefined) resumeIds.push(ctx.resumeSessionId);
        return [fixturePath];
      },
      buildResumeCommand: (id: string) => ['--resume', id],
      writeInput: (backend: PtyLike, prompt: string) => { backend.write(prompt + '\n'); },
      completionPattern: /MOCK DONE/,
    };

    const driver = new PtyCliDriver({
      agent: agentConfig({ cwd, env: { CODEX_HOME: childHome } }),
      adapter,
      backend: new PtyBackend(),
      onEvent: () => {},
      onExit: () => {},
      sessionId: SESSION_ID,
    });

    await driver.start();
    await driver.resume();

    expect(driver.getCliSessionId()).toBe(trueId);
    expect(resumeIds).toEqual([trueId]);

    await driver.stop();
  }, 40_000);

  it('claude lookup honours an explicit env (registry level)', () => {
    const daemonDir = makeTempDir('daemon-claude');
    const childDir = makeTempDir('child-claude');
    const cwd = makeTempDir('cwd');
    setEnv('CLAUDE_CONFIG_DIR', daemonDir);

    const key = cwd.replace(/[^A-Za-z0-9-]/g, '-');
    const decoyId = 'dddddddd-0000-0000-0000-00000000dec0';
    const trueId = 'aaaaaaaa-0000-0000-0000-00000000true';
    for (const [root, id] of [[daemonDir, decoyId], [childDir, trueId]] as const) {
      const dir = join(root, 'projects', key);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${id}.jsonl`),
        JSON.stringify({
          type: 'user', sessionId: id,
          message: { role: 'user', content: `${buildSessionMarker(SESSION_ID)}\nhi` },
        }) + '\n', 'utf8');
    }

    expect(resolveCliSessionId('claude-code', {
      sessionId: SESSION_ID, cwd, env: { CLAUDE_CONFIG_DIR: childDir },
    })).toBe(trueId);
    // Without an env it still reads process.env — the unchanged default.
    expect(resolveCliSessionId('claude-code', { sessionId: SESSION_ID, cwd })).toBe(decoyId);
  });

  it('opencode lookup follows the child XDG_DATA_HOME', () => {
    const daemonXdg = makeTempDir('daemon-xdg');
    const childXdg = makeTempDir('child-xdg');
    setEnv('XDG_DATA_HOME', daemonXdg);

    const decoyId = 'ses_daemonDecoy1';
    const trueId = 'ses_childTrue99';
    buildOpenCodeV1Db(prepareDb(daemonXdg), [
      { sessionId: decoyId, messageId: 'm1', text: buildSessionMarker(SESSION_ID), timeCreated: 1 },
    ]);
    buildOpenCodeV1Db(prepareDb(childXdg), [
      { sessionId: trueId, messageId: 'm1', text: buildSessionMarker(SESSION_ID), timeCreated: 1 },
    ]);

    expect(resolveCliSessionId('opencode', {
      sessionId: SESSION_ID, cwd: '/repo', env: { XDG_DATA_HOME: childXdg },
    })).toBe(trueId);
    expect(resolveCliSessionId('opencode', { sessionId: SESSION_ID, cwd: '/repo' })).toBe(decoyId);
  });
});

// ─── adapter aliases: seed / relay / opencode2 ─────────────────────────────

/** `<xdg>/opencode/opencode.db`, directory created. */
function prepareDb(xdgRoot: string): string {
  const dir = join(xdgRoot, 'opencode');
  mkdirSync(dir, { recursive: true });
  return join(dir, 'opencode.db');
}

interface DbRow { sessionId: string; messageId: string; text: string; timeCreated: number }

function openDb(dbPath: string) {
  const require = createRequire(import.meta.url);
  const { DatabaseSync } = require('node:sqlite') as {
    DatabaseSync: new (path: string) => {
      exec(sql: string): void;
      prepare(sql: string): { run(...p: unknown[]): unknown };
      close(): void;
    };
  };
  return new DatabaseSync(dbPath);
}

/** OpenCode 1.x tables: part JOIN message, role inside the message blob. */
function buildOpenCodeV1Db(dbPath: string, rows: DbRow[]): void {
  const db = openDb(dbPath);
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

/** OpenCode 2.x tables: session_message types its own rows, text at $.text. */
function buildOpenCodeV2Db(dbPath: string, rows: DbRow[]): void {
  const db = openDb(dbPath);
  try {
    db.exec(`
      CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT, title TEXT,
        parent_id TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER);
      CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT,
        data TEXT, time_created INTEGER);
    `);
    const insSession = db.prepare('INSERT OR IGNORE INTO session_v2 (id, directory, time_created, time_updated) VALUES (?, ?, ?, ?)');
    const insMessage = db.prepare('INSERT INTO session_message (id, session_id, type, data, time_created) VALUES (?, ?, ?, ?, ?)');
    for (const row of rows) {
      insSession.run(row.sessionId, '/repo', row.timeCreated, row.timeCreated);
      insMessage.run(row.messageId, row.sessionId, 'user',
        JSON.stringify({ text: row.text }), row.timeCreated);
    }
  } finally {
    db.close();
  }
}

describe('claude-code forks (seed / relay) share its transcript + lookup', () => {
  it.each(['claude-code', 'seed', 'relay'])('%s gets a Claude transcript tailer', id => {
    const cwd = makeTempDir('cwd');
    expect(createTranscriptTailer(id, { cwd })).toBeInstanceOf(ClaudeTranscriptTailer);
  });

  it.each(['claude-code', 'seed', 'relay'])('%s resolves a session id from a Claude jsonl tree', id => {
    // The fork's own data root is pinned through agent.env (Seed's
    // `<pkg>/.claude-runtime`, Relay's `~/.relay`); here that arrives as the
    // child env, which is precisely the mechanism that makes one shared
    // resolver correct for all three.
    const forkRoot = makeTempDir(`${id}-root`);
    const cwd = makeTempDir('cwd');
    const cliId = 'aaaaaaaa-1111-2222-3333-444444444444';
    const dir = join(forkRoot, 'projects', cwd.replace(/[^A-Za-z0-9-]/g, '-'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${cliId}.jsonl`),
      JSON.stringify({
        type: 'user', sessionId: cliId,
        message: { role: 'user', content: `${buildSessionMarker(SESSION_ID)}\nwork` },
      }) + '\n', 'utf8');

    expect(resolveCliSessionId(id, {
      sessionId: SESSION_ID, cwd, env: { CLAUDE_CONFIG_DIR: forkRoot },
    })).toBe(cliId);
  });

  it('a fork pointed at its OWN root does not read Claude Code\'s tree', () => {
    // The forks differ from claude-code in exactly one respect: where the tree
    // is rooted. Whoever spawns them must say so; if the roots were conflated,
    // a session would resume into the other CLI's conversation.
    const claudeRoot = makeTempDir('claude-root');
    const relayRoot = makeTempDir('relay-root');
    const cwd = makeTempDir('cwd');
    const claudeOnlyId = 'cccccccc-1111-2222-3333-444444444444';
    const dir = join(claudeRoot, 'projects', cwd.replace(/[^A-Za-z0-9-]/g, '-'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${claudeOnlyId}.jsonl`),
      JSON.stringify({
        type: 'user', sessionId: claudeOnlyId,
        message: { role: 'user', content: `${buildSessionMarker(SESSION_ID)}\nwork` },
      }) + '\n', 'utf8');

    expect(resolveCliSessionId('relay', {
      sessionId: SESSION_ID, cwd, env: { CLAUDE_CONFIG_DIR: relayRoot },
    })).toBeUndefined();
  });
});

describe('opencode2 session-id lookup (V2 table space)', () => {
  it('resolves from the V2 tables', () => {
    const xdg = makeTempDir('oc2-xdg');
    const cliId = 'ses_v2Session01';
    buildOpenCodeV2Db(prepareDb(xdg), [
      { sessionId: cliId, messageId: 'm1', text: buildSessionMarker(SESSION_ID), timeCreated: 1 },
    ]);

    expect(resolveCliSessionId('opencode2', {
      sessionId: SESSION_ID, cwd: '/repo', env: { XDG_DATA_HOME: xdg },
    })).toBe(cliId);
  });

  it('does NOT cross generations: V1 rows stay invisible to opencode2 and vice versa', () => {
    // opencode and opencode2 share one database file but not one schema; when
    // opencode2 takes over, the V1 tables are frozen rather than migrated. A
    // cross-generation fallback would resume into a session minted by the
    // other CLI generation — worse than not resuming at all.
    const v1Xdg = makeTempDir('v1-xdg');
    const v2Xdg = makeTempDir('v2-xdg');
    buildOpenCodeV1Db(prepareDb(v1Xdg), [
      { sessionId: 'ses_onlyInV1x', messageId: 'm1', text: buildSessionMarker(SESSION_ID), timeCreated: 1 },
    ]);
    buildOpenCodeV2Db(prepareDb(v2Xdg), [
      { sessionId: 'ses_onlyInV2x', messageId: 'm1', text: buildSessionMarker(SESSION_ID), timeCreated: 1 },
    ]);

    expect(resolveCliSessionId('opencode2', {
      sessionId: SESSION_ID, cwd: '/repo', env: { XDG_DATA_HOME: v1Xdg },
    })).toBeUndefined();
    expect(resolveCliSessionId('opencode', {
      sessionId: SESSION_ID, cwd: '/repo', env: { XDG_DATA_HOME: v2Xdg },
    })).toBeUndefined();
  });

  it('readOpenCodeSessionId defaults to the V1 dialect', () => {
    const xdg = makeTempDir('oc-default');
    const dbPath = prepareDb(xdg);
    buildOpenCodeV1Db(dbPath, [
      { sessionId: 'ses_defaultV1', messageId: 'm1', text: buildSessionMarker(SESSION_ID), timeCreated: 1 },
    ]);
    expect(readOpenCodeSessionId(dbPath, SESSION_ID)).toBe('ses_defaultV1');
  });
});

// ─── the daemon-env default must survive ───────────────────────────────────

describe('omitting env keeps the previous behaviour', () => {
  it('a tailer built with no env still resolves through process.env', () => {
    const dir = makeTempDir('daemon-claude');
    const cwd = makeTempDir('cwd');
    setEnv('CLAUDE_CONFIG_DIR', dir);
    unsetEnv('CODEX_HOME');

    const projectDir = join(dir, 'projects', cwd.replace(/[^A-Za-z0-9-]/g, '-'));
    mkdirSync(projectDir, { recursive: true });
    const file = join(projectDir, 'x.jsonl');
    writeFileSync(file, '', 'utf8');

    expect(resolveClaudeTranscriptPath(cwd)).toBe(file);
  });
});
