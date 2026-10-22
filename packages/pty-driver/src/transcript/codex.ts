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
import { existsSync, opendirSync, realpathSync, statSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { createRequire } from 'node:module';
import { codexRateLimits, contextUsage, type NormalizedDriverEvent, type SessionUsageSnapshot } from '@dutydeck/shared';
import { codexHistoryPath, codexSessionsRoot, type CliPathEnv } from '../cli-paths.js';
import { readHead, walkFiles } from '../session-id/fs-scan.js';
import { resolveCliSessionId } from '../session-id/index.js';
import { JsonlTailer, type TranscriptCursor, type TranscriptEventSource } from './tail.js';
import { readNativeTranscriptUsage } from './session-usage.js';
import { codexInputText } from './input-receipt.js';
import { CodexToolProjection, mapCodexCompletedTool } from './codex-tools.js';
import { CodexInputReceipt } from './codex-input-receipt.js';
import { CodexChildLimits, childDiagnosticLimits } from './codex-child-limits.js';
import { NativeTurn, nativeTaskError } from './native-turn.js';

const SESSION_SCAN_MAX_DEPTH = 3;
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

/** A generation is accepted only after its complete first record identifies
 * the already-bound native session. Copied/touched old files are not newer. */
const CODEX_GENERATION_RE = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:_([0-9a-f-]{36}))?\.jsonl$/i;
const SESSION_META_BYTES = 1024 * 1024;
function rolloutHeader(path: string): { id?: string; complete: boolean } {
  const head = readHead(path, SESSION_META_BYTES), newline = head.indexOf('\n');
  if (newline < 0) return { complete: false };
  try {
    const entry = JSON.parse(head.slice(0, newline));
    const id = entry?.type === 'session_meta' ? entry.payload?.id ?? entry.payload?.session_id : undefined;
    return { complete: true, ...(typeof id === 'string' ? { id } : {}) };
  } catch { return { complete: false }; }
}
function insideRoot(root: string, path: string): boolean {
  try {
    const rel = relative(realpathSync(root), realpathSync(path));
    return !!rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) && statSync(path).isFile();
  } catch { return false; }
}
function matchesRollout(root: string, path: string, sid: string, requireMeta = false): boolean {
  if (!insideRoot(root, path)) return false;
  const name = basename(path), parsed = CODEX_GENERATION_RE.exec(name);
  if (parsed && parsed[1]!.toLowerCase() !== sid.toLowerCase()) return false;
  const header = rolloutHeader(path);
  if (header.id && header.id !== sid) return false;
  if (requireMeta || parsed?.[2]) return header.complete && header.id === sid;
  return name.endsWith(`-${sid}.jsonl`) || header.id === sid;
}
function indexedRollout(root: string, sid: string): string | undefined {
  const path = join(dirname(root), 'state_5.sqlite');
  if (!existsSync(path)) return undefined;
  let db: { prepare(sql: string): { get(id: string): unknown }; close(): void } | undefined;
  try {
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
    db = new DatabaseSync(path, { readOnly: true });
    const row = db!.prepare('SELECT rollout_path FROM threads WHERE id = ?').get(sid) as { rollout_path?: unknown } | undefined;
    return typeof row?.rollout_path === 'string' && isAbsolute(row.rollout_path) && matchesRollout(root, row.rollout_path, sid, true) ? row.rollout_path : undefined;
  } catch { return undefined; }
  finally { db?.close(); }
}

/** Native index first, otherwise filename creation order within this session.
 * The scan and metadata reads are bounded; mtime never promotes an old copy. */
export function findRolloutBySessionId(
  sessionsRoot: string,
  cliSessionId: string,
  maxCandidates = MAX_ROLLOUT_CANDIDATES,
  requireMeta = false,
): string | undefined {
  if (!existsSync(sessionsRoot)) return undefined;
  const indexed = indexedRollout(sessionsRoot, cliSessionId);
  if (indexed) return indexed;
  const candidates = walkFiles(sessionsRoot, {
    maxDepth: SESSION_SCAN_MAX_DEPTH,
    accept: name => name.startsWith('rollout-') && name.endsWith('.jsonl'),
  }).sort((a, b) => basename(b.path).localeCompare(basename(a.path)));
  // Bound expensive head reads, but do not let unrelated sessions crowd out
  // this session's named generations before applying the candidate limit.
  const named = candidates.filter(candidate => candidate.path.endsWith(`-${cliSessionId}.jsonl`)
    || CODEX_GENERATION_RE.exec(basename(candidate.path))?.[1]?.toLowerCase() === cliSessionId.toLowerCase());
  for (const candidate of named.slice(0, maxCandidates)) {
    if (matchesRollout(sessionsRoot, candidate.path, cliSessionId, requireMeta)) return candidate.path;
  }
  for (const candidate of candidates.slice(0, maxCandidates)) {
    if (matchesRollout(sessionsRoot, candidate.path, cliSessionId, true)) return candidate.path;
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

  if (entry.type === 'event_msg' && p.type === 'item_completed') return mapCodexCompletedTool(p.item);

  if (entry.type === 'event_msg' && p.type === 'token_count') {
    const observedAt = typeof entry.timestamp === 'string' ? entry.timestamp : new Date().toISOString();
    const context = contextUsage(p.info?.last_token_usage?.total_tokens, p.info?.model_context_window, observedAt);
    const rateLimits = codexRateLimits(p.rate_limits, observedAt);
    return context || rateLimits ? [{ type: 'status', data: { state: 'usage', ...(context ? { used: context.used, size: context.size } : {}), ...(rateLimits ? { rateLimits } : {}) } }] : undefined;
  }

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
    const error = nativeTaskError(p.error, true);
    const events: NormalizedDriverEvent[] = [];
    if (typeof p.last_agent_message === 'string' && p.last_agent_message.length > 0) events.push({ type: 'text', data: { text: p.last_agent_message } });
    if (error) events.push(error);
    return events.length ? events : undefined;
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
  readonly requiresTurnTerminal = true;
  private readonly tailer: JsonlTailer;
  private readonly turn = new NativeTurn(true);
  private readonly inputReceipt?: CodexInputReceipt;
  private readonly children: CodexChildLimits;
  private childTimer?: NodeJS.Timeout;
  private readonly childCallbacks = new Set<(event: NormalizedDriverEvent) => void>();

  constructor(opts: CodexTranscriptTailerOptions) {
    const root = codexSessionsRoot(opts.env);
    this.children = new CodexChildLimits(root);
    let cliSessionId: string | undefined;
    const nativeId = () => cliSessionId ??= opts.sessionId ? resolveCliSessionId('codex', { sessionId: opts.sessionId, cwd: opts.cwd, env: opts.env }) : undefined;
    if (opts.sessionId) this.inputReceipt = new CodexInputReceipt(codexHistoryPath(opts.env), nativeId, text => this.turn.bindHistory(text));
    const explicit = opts.transcriptPath;
    let resolved: string | undefined, refreshAt = 0;
    const resolveActive = () => {
      if (!nativeId()) return undefined;
      if (Date.now() >= refreshAt || !resolved || !existsSync(resolved)) {
        // Initial legacy canonical files may be name-bound. Filter every
        // handoff candidate by complete same-ID meta, so an unfinished newer
        // canonical file cannot hide the next verified generation.
        resolved = findRolloutBySessionId(root, nativeId()!, MAX_ROLLOUT_CANDIDATES, !!resolved) ?? resolved;
        refreshAt = Date.now() + 1_000;
      }
      return resolved;
    };
    let replayTurn: string | undefined;
    const projection = new CodexToolProjection(mapCodexEntry);
    this.tailer = new JsonlTailer({
      resolvePath: explicit
        ? () => explicit
        : opts.sessionId
          ? resolveActive
          : () => resolveCodexRolloutPath(opts.cwd, opts.env),
      followGenerations: !explicit && !!opts.sessionId,
      generationScope: nativeId,
      generationRecordKey: (entry, raw) => {
        if (entry.type === 'session_meta') replayTurn = undefined;
        if (entry.type === 'event_msg' && ['task_started', 'turn_started'].includes(entry.payload?.type)) replayTurn = entry.payload.turn_id;
        // Legacy user, assistant and tool records can omit timestamp and
        // turn_id. Identical content in a later turn is still new activity.
        return entry.type === 'session_meta' ? raw : `${entry.payload?.turn_id ?? replayTurn ?? ''}\0${raw}`;
      },
      validateRestorePath: path => !explicit && !!nativeId() && matchesRollout(root, path, nativeId()!),
      mapEntry: (entry, baseline) => {
        const bound = this.turn.observe(entry, baseline);
        this.children.observe(entry, baseline, this.turn.activeTurnId());
        if (!baseline && this.turn.requiresBinding() && !bound) return mapCodexEntry(entry)?.filter(event => event.type === 'status');
        const events = projection.map(entry);
        return events?.filter(event => event.type !== 'error');
      },
      onInputReceipt: entry => this.turn.bind(entry),
      resetMapping: () => { projection.reset(); this.turn.reset(); this.children.reset(); },
      inputText: codexInputText,
      deduplicateTools: true,
      pollIntervalMs: opts.pollIntervalMs,
      // Re-resolving each tick is what lets the tailer attach late: the
      // rollout appears a beat after spawn. Once bound, only generations
      // verified against that native session can replace the active file.
      watchForSwitch: !explicit,
    });
  }

  start(): void {
    this.inputReceipt?.start(); this.tailer.start();
    this.childTimer ??= setInterval(() => { void this.flush().catch(() => {}); }, childDiagnosticLimits.intervalMs);
    this.childTimer.unref();
  }
  private publishChildDiagnostics(): void {
    for (const event of this.children.poll(this.turn.activeTurnId())) for (const cb of this.childCallbacks) cb(event);
  }
  async flush(): Promise<void> { await Promise.all([this.tailer.flush(), this.inputReceipt?.flush()]); this.publishChildDiagnostics(); }
  checkpoint(): TranscriptCursor { return this.tailer.checkpoint(); }
  restore(cursor: TranscriptCursor): void { this.tailer.restore(cursor); this.turn.restore(); }
  stop(): void { if (this.childTimer) clearInterval(this.childTimer); this.childTimer = undefined; this.inputReceipt?.stop(); this.tailer.stop(); }
  onEvent(cb: (e: NormalizedDriverEvent) => void): void { this.tailer.onEvent(cb); this.childCallbacks.add(cb); }
  onProgress(cb: () => void): void { this.tailer.onProgress(cb); }
  hasTurnTerminal(): boolean { return this.turn.hasTerminal(); }
  hasRecoveredInput(): boolean { return this.turn.hasRecoveredInput(); }
  takeTurnError(): NormalizedDriverEvent | undefined { return this.turn.takeError(); }
  takeInputError(): NormalizedDriverEvent | undefined { return this.turn.takeError(); }
  takeInputCancellation(): boolean { return this.turn.takeCancellation(); }
  waitForInput(prompt: string, signal: AbortSignal): Promise<void> {
    this.children.newInput();
    this.turn.arm(signal);
    return this.inputReceipt ? this.inputReceipt.waitForInput(this.tailer, prompt, signal) : this.tailer.waitForInput(prompt, signal);
  }
}

const usagePaths = new Map<string, string>();
/** Read only the named native session. Repeated polling reads appended bytes only. */
export async function readCodexSessionUsage(nativeSessionId: string, env: CliPathEnv, cwd: string): Promise<SessionUsageSnapshot | undefined> {
  const root = codexSessionsRoot(env);
  const key = `${root}\0${nativeSessionId}\0${cwd}`;
  let path = usagePaths.get(key);
  if (path && !existsSync(path)) { usagePaths.delete(key); path = undefined; }
  path ??= findRolloutBySessionId(root, nativeSessionId, Infinity);
  if (!path) return undefined;
  usagePaths.delete(key); usagePaths.set(key, path);
  if (usagePaths.size > 32) usagePaths.delete(usagePaths.keys().next().value!);
  return readNativeTranscriptUsage({ client: 'codex', path, dataRoot: root, nativeSessionId, cwd });
}
