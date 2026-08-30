/**
 * Codex rollout tailer.
 *
 * Codex stores each session's transcript at
 *   <CODEX_HOME>/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<cliSessionId>.jsonl
 * (CODEX_HOME defaults to ~/.codex) and creates the file lazily on the first
 * user submit. The resolver scans the shallow sessions tree (year/month/day,
 * depth 3 — same bound as botmux) and picks the newest rollout file by mtime.
 * Note: codex rollout paths do NOT encode the cwd, so the `cwd` parameter is
 * accepted for API symmetry but unused by the resolver.
 *
 * Entry mapping (per dockmux driver contract; field names from botmux
 * codex-transcript.ts):
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
import type { NormalizedDriverEvent } from '@dockmux/shared';
import { codexSessionsRoot, type CliPathEnv } from '../cli-paths.js';
import { JsonlTailer, type TranscriptEventSource } from './tail.js';

const SESSION_SCAN_MAX_DEPTH = 3;

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

/** Locate the newest Codex rollout jsonl. Codex rollout paths do NOT encode
 *  the cwd, so `cwd` is accepted for API symmetry but unused. `env` must be
 *  the environment the CLI child received (see cli-paths.ts). */
export function resolveCodexRolloutPath(_cwd?: string, env?: CliPathEnv): string | undefined {
  return resolveNewestRollout(codexSessionsRoot(env));
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
    this.tailer = new JsonlTailer({
      resolvePath: explicit
        ? () => explicit
        : () => resolveCodexRolloutPath(opts.cwd, opts.env),
      mapEntry: mapCodexEntry,
      pollIntervalMs: opts.pollIntervalMs,
      watchForSwitch: !explicit,
    });
  }

  start(): void { this.tailer.start(); }
  stop(): void { this.tailer.stop(); }
  onEvent(cb: (e: NormalizedDriverEvent) => void): void { this.tailer.onEvent(cb); }
}
