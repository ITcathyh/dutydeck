/**
 * CLI data-directory resolution — one place per CLI, shared by the transcript
 * tailers (transcript/) and the session-id resolvers (session-id/).
 *
 * Every helper reads its environment variable at CALL time, never at module
 * load: tests and re-exec'd child processes set these after import, and a
 * value frozen at load would silently resolve to the wrong home.
 */
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** Expand a leading `~` to the user's home directory. */
export function expandHome(p: string): string {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p;
}

/** Claude Code data root: $CLAUDE_CONFIG_DIR when set, else ~/.claude. */
export function claudeDataDir(): string {
  const configured = process.env.CLAUDE_CONFIG_DIR?.trim();
  return configured ? expandHome(configured) : join(homedir(), '.claude');
}

/** Codex data root: $CODEX_HOME when set, else ~/.codex. */
export function codexHome(): string {
  const configured = process.env.CODEX_HOME?.trim();
  return configured ? expandHome(configured) : join(homedir(), '.codex');
}

/** TRAE CLI data root: $TRAE_HOME when set, else ~/.trae. Note that TRAE nests
 *  everything one level deeper than Codex, under `cli/`. */
export function traeHome(): string {
  const configured = process.env.TRAE_HOME?.trim();
  return configured ? expandHome(configured) : join(homedir(), '.trae');
}

/** Grok Build data root: $GROK_HOME when set, else ~/.grok. */
export function grokHome(): string {
  const configured = process.env.GROK_HOME?.trim();
  return configured ? expandHome(configured) : join(homedir(), '.grok');
}

/** OpenCode data root: follows $XDG_DATA_HOME, else ~/.local/share/opencode. */
export function opencodeDataRoot(): string {
  const xdg = process.env.XDG_DATA_HOME?.trim();
  const base = xdg ? expandHome(xdg) : join(homedir(), '.local', 'share');
  return join(base, 'opencode');
}

/** OpenCode's single global SQLite database (all projects share one file). */
export function opencodeDbPath(): string {
  return join(opencodeDataRoot(), 'opencode.db');
}

/**
 * cwd → the path Claude Code keys its project dir by: the REALPATH (symlinks
 * resolved), falling back to a lexical resolve only when the path isn't on
 * disk. Claude keys projects by realpath, so a symlinked cwd (e.g. /home/x →
 * /data00/home/x) must resolve to the same string the CLI used — a lexical
 * resolve() would point at a project key Claude never writes to.
 */
export function realCwd(cwd: string): string {
  const expanded = expandHome(cwd);
  try { return realpathSync(expanded); } catch { return resolve(expanded); }
}

/** `<claudeDataDir>/projects/<projectKey>` for a working directory. */
export function claudeProjectDir(cwd: string): string {
  const projectKey = realCwd(cwd).replace(/[^A-Za-z0-9-]/g, '-');
  return join(claudeDataDir(), 'projects', projectKey);
}

/** `<codexHome>/sessions` — the YYYY/MM/DD rollout tree. */
export function codexSessionsRoot(): string {
  return join(codexHome(), 'sessions');
}

/** `<codexHome>/history.jsonl` — the global submit log, one
 *  `{session_id, ts, text}` line per user submit across every codex session. */
export function codexHistoryPath(): string {
  return join(codexHome(), 'history.jsonl');
}

/** `<traeHome>/cli/sessions` — same YYYY/MM/DD rollout layout as Codex. */
export function traeSessionsRoot(): string {
  return join(traeHome(), 'cli', 'sessions');
}

/** `<traeHome>/cli/history.jsonl` — byte-compatible with Codex's history. */
export function traeHistoryPath(): string {
  return join(traeHome(), 'cli', 'history.jsonl');
}

/** `<grokHome>/sessions` — one bucket directory per working directory. */
export function grokSessionsRoot(): string {
  return join(grokHome(), 'sessions');
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
export function resolveGrokCwdBucketDir(cwd: string): string {
  const root = grokSessionsRoot();
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
export function grokPromptHistoryPath(cwd: string): string {
  return join(resolveGrokCwdBucketDir(cwd), 'prompt_history.jsonl');
}

/** `<bucket>/<cliSessionId>/updates.jsonl` — Grok's per-session ACP stream. */
export function grokUpdatesPath(cliSessionId: string, cwd: string): string {
  return join(resolveGrokCwdBucketDir(cwd), cliSessionId, 'updates.jsonl');
}
