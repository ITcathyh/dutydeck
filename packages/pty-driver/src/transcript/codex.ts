/**
 * Codex rollout tailer.
 *
 * Codex stores each session's transcript at
 *   <CODEX_HOME>/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<cliSessionId>.jsonl
 * (CODEX_HOME defaults to ~/.codex) and creates the file lazily on the first
 * user submit. The tree is GLOBAL — the path encodes no cwd — so concurrent
 * sessions from unrelated projects all live in it together. Resolution is
 * therefore by session id whenever the caller supplies one (see
 * resolveCodexRolloutPath); the newest-by-mtime scan remains only for callers
 * with no session in mind, where a single running session makes it unambiguous.
 *
 * Entry mapping (per dutydeck driver contract; see THIRD_PARTY_NOTICES.md):
 *   response_item reasoning                       → thinking
 *   response_item function_call / custom_tool_call
 *     / local_shell_call / web_search_call        → tool_call (status 'running')
 *   response_item function_call_output
 *     / custom_tool_call_output                   → tool_result
 *   response_item message role=assistant
 *     phase 'final' | 'final_answer'              → text (older schema)
 *   event_msg task_complete.last_agent_message    → text (modern schema,
 *                                                   sole final-answer source)
 */
import { existsSync, opendirSync, statSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { join } from 'node:path';
import type { NormalizedDriverEvent } from '@dutydeck/shared';
import { codexSessionsRoot, type CliPathEnv } from '../cli-paths.js';
import { byMtimeDesc, parseJsonlObjects, readHead, walkFiles } from '../session-id/fs-scan.js';
import { resolveCliSessionId } from '../session-id/index.js';
import { JsonlTailer, type TranscriptCursor, type TranscriptEventSource } from './tail.js';

const SESSION_SCAN_MAX_DEPTH = 3;
/** Head window per rollout candidate — session_meta rides the first record.
 *  Matches session-id/codex.ts. */
const ROLLOUT_HEAD_BYTES = 256 * 1024;
/** Newest-first cap on rollout candidates examined. */
const MAX_ROLLOUT_CANDIDATES = 60;

/** Newest rollout-*.jsonl under a Codex-dialect sessions root (by mtime), or
 *  undefined. Iterative depth-limited walk; symlinked dirs are not followed.
 *  Shared with the TRAE tailer, whose root is <TRAE_HOME>/cli/sessions. */
export function resolveNewestRollout(sessionsRoot: string): string | undefined {
  if (!existsSync(sessionsRoot)) return undefined;
  let rootStat;
  try {
    rootStat = statSync(sessionsRoot);
  } catch {
    return undefined;
  }
  if (!rootStat.isDirectory()) return undefined;

  let latest: string | undefined;
  let latestMtime = -Infinity;
  const stack: Array<{ dir: string; depth: number }> = [{ dir: sessionsRoot, depth: 0 }];
  while (stack.length > 0) {
    const { dir, depth } = stack.pop()!;
    let directory: ReturnType<typeof opendirSync>;
    try {
      directory = opendirSync(dir);
    } catch {
      continue;
    }
    try {
      let entry: Dirent | null;
      while ((entry = directory.readSync()) !== null) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (depth < SESSION_SCAN_MAX_DEPTH) stack.push({ dir: full, depth: depth + 1 });
        } else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
          try {
            const st = statSync(full);
            if (st.isFile() && st.mtimeMs > latestMtime) {
              latestMtime = st.mtimeMs;
              latest = full;
            }
          } catch {
            // Vanished between readdir and stat — ignore.
          }
        }
      }
    } finally {
      try { directory.closeSync(); } catch { /* already closed */ }
    }
  }
  return latest;
}

/**
 * The rollout file belonging to one CLI session id, searched newest-first.
 *
 * Codex names rollouts `rollout-<ts>-<uuid>.jsonl` and also records
 * `session_meta.session_id` in the head, so either can identify the file. The
 * filename is checked first because it costs no read.
 */
export function findRolloutBySessionId(
  sessionsRoot: string,
  cliSessionId: string,
): string | undefined {
  if (!existsSync(sessionsRoot)) return undefined;
  const candidates = walkFiles(sessionsRoot, {
    maxDepth: SESSION_SCAN_MAX_DEPTH,
    accept: name => name.startsWith('rollout-') && name.endsWith('.jsonl'),
  }).sort(byMtimeDesc).slice(0, MAX_ROLLOUT_CANDIDATES);
  for (const candidate of candidates) {
    if (candidate.path.includes(cliSessionId)) return candidate.path;
    for (const entry of parseJsonlObjects(readHead(candidate.path, ROLLOUT_HEAD_BYTES))) {
      if (entry?.type !== 'session_meta') continue;
      if (entry.payload?.session_id === cliSessionId) return candidate.path;
      break; // session_meta is the head record; past it there is nothing to learn.
    }
  }
  return undefined;
}

/**
 * Locate the Codex rollout jsonl for a session.
 *
 * With `sessionId`, the CLI's own id is recovered first (Codex mints it and
 * never accepts ours, so `session-id/codex.ts` reads it out of history.jsonl /
 * the rollout head) and the matching rollout is then addressed directly.
 * That matters because the rollout root is GLOBAL — not even cwd-scoped — so
 * every concurrent Codex session in every project competes to be "newest",
 * and an mtime pick can attach a rollout from an unrelated repo.
 *
 * Without `sessionId` it falls back to the newest rollout, which is only
 * unambiguous when a single Codex session is running (tooling / tests).
 *
 * `cwd` is unused by the recency path (rollout paths do not encode it) and is
 * kept for API symmetry; the scoped path passes it on so `session_meta.cwd`
 * can gate the marker match. `env` must be the environment the CLI child
 * received (see cli-paths.ts).
 */
export function resolveCodexRolloutPath(
  cwd?: string,
  env?: CliPathEnv,
  sessionId?: string,
): string | undefined {
  const root = codexSessionsRoot(env);
  if (sessionId && cwd) {
    const cliSessionId = resolveCliSessionId('codex', { sessionId, cwd, env });
    return cliSessionId ? findRolloutBySessionId(root, cliSessionId) : undefined;
  }
  return resolveNewestRollout(root);
}

/** Parse a JSON-encoded arguments string when parseable, else return the
 *  raw string (and undefined for undefined input). */
function parseMaybeJson(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** Codex shell outputs are usually a JSON string `{"output":"…","metadata":…}`;
 *  unwrap to the inner output when that shape parses, otherwise show the raw
 *  string (custom tools / newer formats). */
function stringifyCodexToolOutput(output: unknown): string {
  if (typeof output !== 'string') {
    try { return output === undefined ? '' : JSON.stringify(output); } catch { return ''; }
  }
  if (output.startsWith('{')) {
    try {
      const parsed = JSON.parse(output);
      if (parsed && typeof parsed === 'object' && typeof parsed.output === 'string') return parsed.output;
    } catch {
      // Not the wrapped shape — fall through to raw.
    }
  }
  return output;
}

function joinOutputText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === 'object'
      && (block as any).type === 'output_text'
      && typeof (block as any).text === 'string') {
      parts.push((block as any).text);
    }
  }
  return parts.join('');
}

/** Map one parsed Codex rollout entry to normalized events. Exported for
 *  direct unit testing. */
export function mapCodexEntry(entry: any): NormalizedDriverEvent[] | undefined {
  if (!entry || typeof entry !== 'object') return undefined;
  const p = entry.payload;
  if (!p || typeof p !== 'object') return undefined;

  if (entry.type === 'response_item') {
    // Reasoning summary → thinking. Prefer summary[] (what the TUI shows),
    // fall back to raw content[] reasoning_text.
    if (p.type === 'reasoning') {
      const texts: string[] = [];
      for (const b of Array.isArray(p.summary) ? p.summary : []) {
        if (b?.type === 'summary_text' && typeof b.text === 'string' && b.text.length > 0) texts.push(b.text);
      }
      if (texts.length === 0) {
        for (const b of Array.isArray(p.content) ? p.content : []) {
          if ((b?.type === 'reasoning_text' || b?.type === 'text') && typeof b.text === 'string' && b.text.length > 0) {
            texts.push(b.text);
          }
        }
      }
      return texts.length > 0 ? [{ type: 'thinking', data: { text: texts.join('\n\n') } }] : undefined;
    }

    if (p.type === 'function_call' && typeof p.name === 'string') {
      const id = typeof p.call_id === 'string' && p.call_id ? p.call_id
        : (typeof p.id === 'string' ? p.id : '');
      if (!id) return undefined;
      const input = parseMaybeJson(p.arguments);
      return [{
        type: 'tool_call',
        data: { id, name: p.name, ...(input !== undefined ? { input } : {}), status: 'running' },
      }];
    }

    if (p.type === 'custom_tool_call' && typeof p.name === 'string'
      && typeof p.call_id === 'string' && p.call_id) {
      const input = parseMaybeJson(p.input);
      return [{
        type: 'tool_call',
        data: { id: p.call_id, name: p.name, ...(input !== undefined ? { input } : {}), status: 'running' },
      }];
    }

    if (p.type === 'local_shell_call') {
      const id = typeof p.call_id === 'string' && p.call_id ? p.call_id
        : (typeof p.id === 'string' ? p.id : '');
      if (!id) return undefined;
      return [{
        type: 'tool_call',
        data: { id, name: 'shell', ...(p.action !== undefined ? { input: p.action } : {}), status: 'running' },
      }];
    }

    if (p.type === 'web_search_call') {
      const id = typeof p.call_id === 'string' && p.call_id ? p.call_id
        : (typeof p.id === 'string' ? p.id : '');
      if (!id) return undefined;
      return [{
        type: 'tool_call',
        data: { id, name: 'web_search', ...(p.action !== undefined ? { input: p.action } : {}), status: 'running' },
      }];
    }

    if ((p.type === 'function_call_output' || p.type === 'custom_tool_call_output')
      && typeof p.call_id === 'string' && p.call_id) {
      const output = stringifyCodexToolOutput(p.output);
      return [{
        type: 'tool_result',
        data: { id: p.call_id, status: 'completed', output },
      }];
    }

    // Older codex schemas tagged the final assistant message with a phase.
    // Newer codex dropped it (mid-turn and final messages are identical),
    // so only an explicit final phase is safe to emit as text here.
    if (p.type === 'message' && p.role === 'assistant') {
      const phase = typeof p.phase === 'string' ? p.phase : '';
      if (phase !== 'final' && phase !== 'final_answer') return undefined;
      const text = joinOutputText(p.content);
      return text.length > 0 ? [{ type: 'text', data: { text } }] : undefined;
    }

    return undefined;
  }

  if (entry.type === 'event_msg' && p.type === 'task_complete') {
    // Modern schema: the sole final-answer source. Fires once per turn.
    return typeof p.last_agent_message === 'string' && p.last_agent_message.length > 0
      ? [{ type: 'text', data: { text: p.last_agent_message } }]
      : undefined;
  }

  return undefined;
}

export interface CodexTranscriptTailerOptions {
  cwd: string;
  /** Explicit rollout path. When given, directory scanning and file
   *  switching are disabled. */
  transcriptPath?: string;
  /** dutydeck's session id. Required for correctness whenever more than one
   *  Codex session may be running — the rollout root is global, so without it
   *  resolution falls back to "newest rollout anywhere" and can attach a
   *  rollout from an unrelated project. See resolveCodexRolloutPath. */
  sessionId?: string;
  /** Poll interval in ms (default 300). */
  pollIntervalMs?: number;
  /** The environment the CLI child was spawned with (defaults to process.env);
   *  `$CODEX_HOME` from `agent.env` only exists there. */
  env?: CliPathEnv;
}

export class CodexTranscriptTailer implements TranscriptEventSource {
  private readonly tailer: JsonlTailer;

  constructor(opts: CodexTranscriptTailerOptions) {
    const explicit = opts.transcriptPath;
    // Memoise the session-scoped resolution: JsonlTailer re-resolves every
    // ~300ms tick, and recovering the CLI's own session id means reading
    // history/rollout heads. The rollout path never changes once found, so
    // resolve until it succeeds and then hold the answer. See the Claude
    // tailer for the full reasoning.
    let resolved: string | undefined;
    const resolveOnce = () => (resolved ??= resolveCodexRolloutPath(opts.cwd, opts.env, opts.sessionId));
    this.tailer = new JsonlTailer({
      resolvePath: explicit
        ? () => explicit
        : opts.sessionId
          ? resolveOnce
          : () => resolveCodexRolloutPath(opts.cwd, opts.env),
      mapEntry: mapCodexEntry,
      pollIntervalMs: opts.pollIntervalMs,
      // Re-resolving each tick is what lets the tailer attach late: the
      // rollout appears a beat after spawn, and the CLI's id is only
      // recoverable once history.jsonl carries our marker. With a sessionId
      // every resolution names the same session, so this cannot drift onto a
      // concurrent session's rollout. See the Claude tailer for the tradeoff.
      watchForSwitch: !explicit,
    });
  }

  start(): void { this.tailer.start(); }
  flush(): void { this.tailer.flush(); }
  checkpoint(): TranscriptCursor { return this.tailer.checkpoint(); }
  restore(cursor: TranscriptCursor): void { this.tailer.restore(cursor); }
  stop(): void { this.tailer.stop(); }
  onEvent(cb: (e: NormalizedDriverEvent) => void): void { this.tailer.onEvent(cb); }
}
