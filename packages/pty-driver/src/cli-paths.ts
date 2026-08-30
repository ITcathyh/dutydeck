/**
 * CLI data-directory resolution — one place per CLI, shared by the transcript
 * tailers (transcript/) and the session-id resolvers (session-id/).
 *
 * Every helper reads its environment variable at CALL time, never at module
 * load: tests and re-exec'd child processes set these after import, and a
 * value frozen at load would silently resolve to the wrong home.
 *
 * WHOSE ENVIRONMENT (read this before adding a caller)
 * ----------------------------------------------------
 * These variables locate the DATA the bridged CLI writes, so the only correct
 * environment is the one the CLI CHILD PROCESS actually received —
 * `PtyCliDriver.spawnEnv()`, i.e. the daemon's env minus the stripped
 * credentials plus `agent.env`. The daemon's own `process.env` is merely the
 * default for callers that have no child (tests, one-off tooling).
 *
 * Two real failure modes when the two diverge, both observed end-to-end:
 *   1. The daemon runs with `CLAUDE_CONFIG_DIR` set. The driver strips
 *      `CLAUDE_*` from the child, so the CLI writes `~/.claude` while a
 *      daemon-env tailer watches `$CLAUDE_CONFIG_DIR` — the transcript is
 *      never seen and the turn is reported as "no final output".
 *   2. `agent.env` sets `CODEX_HOME` / `CLAUDE_CONFIG_DIR` / `HOME` (the
 *      supported way to isolate accounts or sandboxes). The CLI writes there;
 *      a daemon-env tailer looks somewhere else entirely.
 *
 * Hence every helper takes an explicit `env`, defaulting to `process.env` so
 * existing callers keep working when the two environments agree.
 */
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** An environment to resolve paths against — `process.env` or a child's. */
export type CliPathEnv = Record<string, string | undefined>;

/**
 * The home directory `env` implies.
 *
 * `homedir()` consults the daemon's own `$HOME` (POSIX) or the password
 * database, which is wrong for a child whose `agent.env` moved `HOME` — a
 * sandboxed CLI writes `$HOME/.claude` under the NEW home. Falls back to
 * `homedir()` when the env carries no home, which is also what makes the
 * `process.env` default byte-identical to the previous behaviour.
 */
function homeOf(env: CliPathEnv): string {
  const configured = (env.HOME ?? env.USERPROFILE)?.trim();
  return configured ? configured : homedir();
}

/** Expand a leading `~` to the home directory `env` implies. */
export function expandHome(p: string, env: CliPathEnv = process.env): string {
  return p.startsWith('~') ? join(homeOf(env), p.slice(1)) : p;
}

/** Claude Code data root: $CLAUDE_CONFIG_DIR when set, else ~/.claude. */
export function claudeDataDir(env: CliPathEnv = process.env): string {
  const configured = env.CLAUDE_CONFIG_DIR?.trim();
  return configured ? expandHome(configured, env) : join(homeOf(env), '.claude');
}

/** Codex data root: $CODEX_HOME when set, else ~/.codex. */
export function codexHome(env: CliPathEnv = process.env): string {
  const configured = env.CODEX_HOME?.trim();
  return configured ? expandHome(configured, env) : join(homeOf(env), '.codex');
}

/** TRAE CLI data root: $TRAE_HOME when set, else ~/.trae. Note that TRAE nests
 *  everything one level deeper than Codex, under `cli/`. */
export function traeHome(env: CliPathEnv = process.env): string {
  const configured = env.TRAE_HOME?.trim();
  return configured ? expandHome(configured, env) : join(homeOf(env), '.trae');
}

/** Grok Build data root: $GROK_HOME when set, else ~/.grok. */
export function grokHome(env: CliPathEnv = process.env): string {
  const configured = env.GROK_HOME?.trim();
  return configured ? expandHome(configured, env) : join(homeOf(env), '.grok');
}

/** OpenCode data root: follows $XDG_DATA_HOME, else ~/.local/share/opencode. */
export function opencodeDataRoot(env: CliPathEnv = process.env): string {
  const xdg = env.XDG_DATA_HOME?.trim();
  const base = xdg ? expandHome(xdg, env) : join(homeOf(env), '.local', 'share');
  return join(base, 'opencode');
}

/** OpenCode's single global SQLite database (all projects share one file). */
export function opencodeDbPath(env: CliPathEnv = process.env): string {
  return join(opencodeDataRoot(env), 'opencode.db');
}

/**
 * cwd → the path Claude Code keys its project dir by: the REALPATH (symlinks
 * resolved), falling back to a lexical resolve only when the path isn't on
 * disk. Claude keys projects by realpath, so a symlinked cwd (e.g. /home/x →
 * /data00/home/x) must resolve to the same string the CLI used — a lexical
 * resolve() would point at a project key Claude never writes to.
 */
export function realCwd(cwd: string, env: CliPathEnv = process.env): string {
  const expanded = expandHome(cwd, env);
  try { return realpathSync(expanded); } catch { return resolve(expanded); }
}

/** `<claudeDataDir>/projects/<projectKey>` for a working directory. */
export function claudeProjectDir(cwd: string, env: CliPathEnv = process.env): string {
  const projectKey = realCwd(cwd, env).replace(/[^A-Za-z0-9-]/g, '-');
  return join(claudeDataDir(env), 'projects', projectKey);
}

/** `<codexHome>/sessions` — the YYYY/MM/DD rollout tree. */
export function codexSessionsRoot(env: CliPathEnv = process.env): string {
  return join(codexHome(env), 'sessions');
}

/** `<codexHome>/history.jsonl` — the global submit log, one
 *  `{session_id, ts, text}` line per user submit across every codex session. */
export function codexHistoryPath(env: CliPathEnv = process.env): string {
  return join(codexHome(env), 'history.jsonl');
}

/** `<traeHome>/cli/sessions` — same YYYY/MM/DD rollout layout as Codex. */
export function traeSessionsRoot(env: CliPathEnv = process.env): string {
  return join(traeHome(env), 'cli', 'sessions');
}

/** `<traeHome>/cli/history.jsonl` — byte-compatible with Codex's history. */
export function traeHistoryPath(env: CliPathEnv = process.env): string {
  return join(traeHome(env), 'cli', 'history.jsonl');
}

/** `<grokHome>/sessions` — one bucket directory per working directory. */
export function grokSessionsRoot(env: CliPathEnv = process.env): string {
  return join(grokHome(env), 'sessions');
}

/**
 * Resolve Grok's on-disk sessions bucket for `cwd`.
 *
 * Grok normally names the bucket `encodeURIComponent(cwd)`. When that name
 * would exceed 255 bytes it falls back to a slug+hash name and records the
 * real path in a `.cwd` file inside the bucket, so a long or CJK working
 * directory is only findable by reading those markers.
 *
 * Returns the preferred encoded path when nothing exists yet — Grok creates
 * it on first submit for short paths.
 */
export function resolveGrokCwdBucketDir(cwd: string, env: CliPathEnv = process.env): string {
  const root = grokSessionsRoot(env);
  const preferred = join(root, encodeURIComponent(cwd));
  if (existsSync(preferred)) return preferred;
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return preferred;
  }
  for (const name of names) {
    if (name.endsWith('.sqlite') || name.endsWith('.lock')) continue;
    const marker = join(root, name, '.cwd');
    try {
      const raw = readFileSync(marker, 'utf8').replace(/\r?\n$/, '');
      if (raw === cwd || raw.trim() === cwd) return join(root, name);
    } catch {
      // No marker / unreadable — not this bucket.
    }
  }
  return preferred;
}

/** Bucket-level submit log: one `{timestamp, session_id, prompt, is_bash}`
 *  line per submit, written at submit time even while a turn is running. */
export function grokPromptHistoryPath(cwd: string, env: CliPathEnv = process.env): string {
  return join(resolveGrokCwdBucketDir(cwd, env), 'prompt_history.jsonl');
}

/** `<bucket>/<cliSessionId>/updates.jsonl` — Grok's per-session ACP stream. */
export function grokUpdatesPath(
  cliSessionId: string,
  cwd: string,
  env: CliPathEnv = process.env,
): string {
  return join(resolveGrokCwdBucketDir(cwd, env), cliSessionId, 'updates.jsonl');
}
