/**
 * Grok Build transcript tailer (ACP `session/update` stream).
 *
 * Grok writes an append-only JSON-RPC notification log per session:
 *   $GROK_HOME/sessions/<bucket>/<cliSessionId>/updates.jsonl
 * where <bucket> is `encodeURIComponent(cwd)` (or a slug+hash directory with
 * a `.cwd` marker when the encoded name would exceed 255 bytes).
 *
 * Each line is `{jsonrpc, method:'session/update', params:{sessionId, update}}`.
 * Older/namespaced builds use `method:'_x.ai/session/update'` and some put the
 * update at the top level, so the reader accepts `params.update ?? update`.
 *
 * Why this CLI is worth a real parser: unlike the JSONL transcripts, Grok's
 * stream is ACP-shaped, so it carries thinking AND tool calls AND tool results
 * with stable ids — the richest structured source after Claude, for zero
 * native dependencies.
 *
 * Mapping (ACP kinds → dockmux driver contract):
 *   agent_thought_chunk → thinking  ({ content: {type:'text', text} })
 *   agent_message_chunk → text      (same ContentChunk shape)
 *   tool_call           → tool_call     (toolCallId / title / rawInput / status)
 *   tool_call_update    → tool_call or tool_result, by terminal status
 *   user_message_chunk  → skipped: it is the prompt WE sent, echoing it back
 *                         would duplicate the user's own message.
 *   turn_completed      → skipped as an event: the driver owns turn
 *                         boundaries (idle detector + the one-completed-per-
 *                         send latch). Emitting a second `completed` here
 *                         would break that invariant.
 *
 * `content` on a chunk is a SINGLE ContentBlock object, while `content` on a
 * tool call is an ARRAY of ToolCallContent — a genuine asymmetry in ACP, not
 * a typo. Both forms are handled where they legally appear.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { NormalizedDriverEvent } from '@dockmux/shared';
import { grokUpdatesPath, resolveGrokCwdBucketDir, type CliPathEnv } from '../cli-paths.js';
import { resolveCliSessionId } from '../session-id/index.js';
import { JsonlTailer, type TranscriptCursor, type TranscriptEventSource } from './tail.js';

/** ACP tool status → dockmux status. `in_progress` is the spec spelling;
 *  `running` is accepted defensively (dockmux's own internal name). */
const TOOL_STATUS: Record<string, 'pending' | 'running' | 'completed' | 'failed'> = {
  pending: 'pending',
  in_progress: 'running',
  running: 'running',
  completed: 'completed',
  failed: 'failed',
};

/**
 * Grok's `<bucket>/<sessionId>/updates.jsonl` for a working directory.
 *
 * With `sessionId`, resolution is session-scoped and therefore correct when
 * several dockmux sessions share a cwd: the bucket is cwd-keyed, so all of
 * them live side by side under it, and an mtime pick among them returns a
 * sibling's stream as readily as this session's. The two-step mirrors
 * session-id/grok.ts — the id dockmux pinned via `--session-id`, then the
 * bucket's prompt_history marker scan for when Grok minted its own.
 *
 * Without `sessionId` it falls back to the mtime pick, which is only
 * unambiguous when one session owns the cwd (tooling / tests).
 *
 * `env` must be the environment the CLI child received (see cli-paths.ts).
 */
export function resolveGrokUpdatesPath(
  cwd: string,
  env?: CliPathEnv,
  sessionId?: string,
): string | undefined {
  if (sessionId) {
    const cliSessionId = resolveCliSessionId('grok', { sessionId, cwd, env });
    if (!cliSessionId) return undefined;
    const path = grokUpdatesPath(cliSessionId, cwd, env);
    return existsSync(path) ? path : undefined;
  }
  const bucket = resolveGrokCwdBucketDir(cwd, env);
  if (!existsSync(bucket)) return undefined;
  let names: string[];
  try {
    names = readdirSync(bucket);
  } catch {
    return undefined;
  }
  let latest: string | undefined;
  let latestMtime = -Infinity;
  for (const name of names) {
    if (name.endsWith('.sqlite') || name.endsWith('.lock') || name.startsWith('.')) continue;
    const candidate = join(bucket, name, 'updates.jsonl');
    try {
      const st = statSync(candidate);
      if (st.isFile() && st.mtimeMs > latestMtime) {
        latestMtime = st.mtimeMs;
        latest = candidate;
      }
    } catch {
      // Not a session directory (or no stream yet) — skip.
    }
  }
  return latest;
}

/** Text of an ACP ContentBlock. Only `type:'text'` carries text; image /
 *  audio / resource blocks have no textual form and yield ''. A bare string
 *  is tolerated (older Grok builds wrote content as a plain string). */
function contentBlockText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!content || typeof content !== 'object') return '';
  const c = content as { type?: unknown; text?: unknown };
  return typeof c.text === 'string' ? c.text : '';
}

/** Flatten a ToolCallContent[] to a display string. The `content` variant
 *  nests a ContentBlock one level deeper (`{type:'content', content:{…}}`);
 *  `diff` and `terminal` variants have no plain-text form and are skipped. */
function toolCallContentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    const it = item as { type?: unknown; content?: unknown; text?: unknown };
    if (it.type === 'content') {
      const text = contentBlockText(it.content);
      if (text) parts.push(text);
    } else if (typeof it.text === 'string' && it.text.length > 0) {
      parts.push(it.text);
    }
  }
  return parts.join('\n');
}

/** Best textual rendering of a tool's output: the structured content array
 *  when present, else the raw output stringified. */
function toolOutput(update: any): string {
  const fromContent = toolCallContentText(update?.content);
  if (fromContent) return fromContent;
  const raw = update?.rawOutput;
  if (raw === undefined) return '';
  if (typeof raw === 'string') return raw;
  try { return JSON.stringify(raw); } catch { return ''; }
}

/** Map one parsed Grok updates.jsonl line to normalized events. Exported for
 *  direct unit testing. */
export function mapGrokEntry(entry: any): NormalizedDriverEvent[] | undefined {
  if (!entry || typeof entry !== 'object') return undefined;
  const update = entry.params?.update ?? entry.update;
  if (!update || typeof update !== 'object') return undefined;
  const kind = update.sessionUpdate;

  if (kind === 'agent_thought_chunk') {
    const text = contentBlockText(update.content);
    return text.length > 0 ? [{ type: 'thinking', data: { text } }] : undefined;
  }

  if (kind === 'agent_message_chunk') {
    const text = contentBlockText(update.content);
    return text.length > 0 ? [{ type: 'text', data: { text } }] : undefined;
  }

  if (kind === 'tool_call' || kind === 'tool_call_update') {
    const id = typeof update.toolCallId === 'string' ? update.toolCallId : '';
    if (!id) return undefined;
    // A bare `tool_call` with no status is in flight; ACP says a creation
    // event defaults to pending/in_progress, never to a result.
    const status = TOOL_STATUS[update.status as string] ?? 'running';
    if (status === 'completed' || status === 'failed') {
      return [{
        type: 'tool_result',
        data: {
          id,
          ...(typeof update.title === 'string' ? { name: update.title } : {}),
          status,
          output: toolOutput(update),
        },
      }];
    }
    // Grok labels tools with `title`; `name` is the (experimental)
    // programmatic id and is preferred only when no title is present.
    const name = typeof update.title === 'string' && update.title
      ? update.title
      : (typeof update.name === 'string' && update.name ? update.name : 'tool');
    return [{
      type: 'tool_call',
      data: {
        id,
        name,
        ...(update.rawInput !== undefined ? { input: update.rawInput } : {}),
        status,
      },
    }];
  }

  // user_message_chunk / turn_completed / plan / mode updates: see header.
  return undefined;
}

export interface GrokTranscriptTailerOptions {
  cwd: string;
  /** Explicit updates.jsonl path. When given, directory scanning and file
   *  switching are disabled. */
  transcriptPath?: string;
  /** dockmux's session id. Required for correctness whenever more than one
   *  session may share `cwd` — the bucket is cwd-keyed, so without it
   *  resolution falls back to "newest session directory" and can attach a
   *  sibling's stream. See resolveGrokUpdatesPath. */
  sessionId?: string;
  /** Poll interval in ms (default 300). */
  pollIntervalMs?: number;
  /** The environment the CLI child was spawned with (defaults to process.env);
   *  `$GROK_HOME` from `agent.env` only exists there. */
  env?: CliPathEnv;
}

export class GrokTranscriptTailer implements TranscriptEventSource {
  private readonly tailer: JsonlTailer;

  constructor(opts: GrokTranscriptTailerOptions) {
    const explicit = opts.transcriptPath;
    // Memoise the session-scoped resolution: JsonlTailer re-resolves every
    // ~300ms tick, and recovering the CLI's own session id means reading
    // history/rollout heads. The updates stream path never changes once found, so
    // resolve until it succeeds and then hold the answer. See the Claude
    // tailer for the full reasoning.
    let resolved: string | undefined;
    const resolveOnce = () => (resolved ??= resolveGrokUpdatesPath(opts.cwd, opts.env, opts.sessionId));
    this.tailer = new JsonlTailer({
      resolvePath: explicit
        ? () => explicit
        : opts.sessionId
          ? resolveOnce
          : () => resolveGrokUpdatesPath(opts.cwd, opts.env),
      mapEntry: mapGrokEntry,
      pollIntervalMs: opts.pollIntervalMs,
      // Re-resolving each tick is what lets the tailer attach late: the
      // stream does not exist on the first ticks, and a refused
      // `--session-id` is only found by the marker scan afterwards. With a
      // sessionId every resolution names the same session, so this cannot
      // drift onto a sibling's stream. See the Claude tailer for the tradeoff.
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
