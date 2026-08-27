/**
 * Claude Code transcript tailer.
 *
 * Claude stores sessions at <dataDir>/projects/<projectKey>/<sessionId>.jsonl
 * where dataDir = $CLAUDE_CONFIG_DIR (or ~/.claude) and projectKey = the
 * REALPATH of cwd with every non-[A-Za-z0-9-] char replaced by '-' (ported
 * from botmux transcript-resolver.ts, including the realpath-not-lexical
 * rule: a symlinked cwd must resolve to the same key the CLI used).
 *
 * Entry mapping (per dockmux driver contract):
 *   assistant message.content[]:
 *     thinking block  → { type:'thinking',  data:{ text } }
 *     text block      → { type:'text',      data:{ text } }
 *     tool_use block  → { type:'tool_call', data:{ id, name, input, status:'running' } }
 *   user message.content[]:
 *     tool_result     → { type:'tool_result', data:{ id, status, output } }
 *
 * Sidechain (Task tool internals) and API-error assistant lines are skipped —
 * they are not model output.
 */
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { NormalizedDriverEvent } from '@dockmux/shared';
import { JsonlTailer, type TranscriptEventSource } from './tail.js';

function expandHome(p: string): string {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p;
}

/** Claude data root: $CLAUDE_CONFIG_DIR when set, else ~/.claude. Read
 *  dynamically so tests / child processes that set the env after module
 *  load still resolve correctly. */
function claudeDataDir(): string {
  const configured = process.env.CLAUDE_CONFIG_DIR?.trim();
  return configured ? expandHome(configured) : join(homedir(), '.claude');
}

/** cwd → the path Claude keys its project dir by: the REALPATH (symlinks
 *  resolved), falling back to a lexical resolve only when the path isn't on
 *  disk. Claude keys projects by realpath, so a symlinked cwd must resolve
 *  to the same string the CLI used. */
function realCwd(cwd: string): string {
  const expanded = expandHome(cwd);
  try { return realpathSync(expanded); } catch { return resolve(expanded); }
}

/** Newest *.jsonl (by mtime) in a Claude project dir, or undefined. Ported
 *  from botmux's findLatestJsonl (no acceptCandidate — the dockmux tailer
 *  owns the whole session and has no sibling-pane trust set to enforce). */
function findLatestJsonl(dir: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return undefined;
  }
  let latest: string | undefined;
  let latestMtime = -Infinity;
  for (const name of entries) {
    if (!name.endsWith('.jsonl')) continue;
    const full = join(dir, name);
    try {
      const st = statSync(full);
      if (st.isFile() && st.mtimeMs > latestMtime) {
        latestMtime = st.mtimeMs;
        latest = full;
      }
    } catch {
      // File disappeared between readdir and stat — ignore.
    }
  }
  return latest;
}

/** Locate the newest Claude transcript jsonl for a cwd. */
export function resolveClaudeTranscriptPath(cwd: string): string | undefined {
  const projectKey = realCwd(cwd).replace(/[^A-Za-z0-9-]/g, '-');
  const projectDir = join(claudeDataDir(), 'projects', projectKey);
  return findLatestJsonl(projectDir);
}

/** Flatten a tool_result block's content (string, or array of text blocks)
 *  to a display string. Non-text blocks (images) are skipped. */
function stringifyToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b: any) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b: any) => b.text)
    .join('\n');
}

/** Map one parsed Claude transcript entry to normalized events. Exported
 *  for direct unit testing. */
export function mapClaudeEntry(entry: any): NormalizedDriverEvent[] | undefined {
  if (!entry || typeof entry !== 'object') return undefined;
  if (entry.isSidechain === true) return undefined;
  const role = entry.message?.role ?? entry.type;

  if (role === 'assistant') {
    // API-error lines are execution metadata, not model answers.
    if (entry.isApiErrorMessage === true) return undefined;
    const content = entry.message?.content;
    if (typeof content === 'string') {
      return content.length > 0 ? [{ type: 'text', data: { text: content } }] : undefined;
    }
    if (!Array.isArray(content)) return undefined;
    const events: NormalizedDriverEvent[] = [];
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.length > 0) {
        events.push({ type: 'thinking', data: { text: block.thinking } });
      } else if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
        events.push({ type: 'text', data: { text: block.text } });
      } else if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
        events.push({
          type: 'tool_call',
          data: {
            id: block.id,
            name: block.name,
            ...(block.input !== undefined ? { input: block.input } : {}),
            status: 'running',
          },
        });
      }
    }
    return events.length > 0 ? events : undefined;
  }

  if (role === 'user') {
    const content = entry.message?.content;
    if (!Array.isArray(content)) return undefined;
    const events: NormalizedDriverEvent[] = [];
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        events.push({
          type: 'tool_result',
          data: {
            id: block.tool_use_id,
            status: block.is_error ? 'failed' : 'completed',
            output: stringifyToolResultContent(block.content),
          },
        });
      }
    }
    return events.length > 0 ? events : undefined;
  }

  return undefined;
}

export interface ClaudeTranscriptTailerOptions {
  cwd: string;
  /** Explicit transcript path. When given, directory scanning and file
   *  switching are disabled — handy for tests and for callers that already
   *  resolved the session file. */
  transcriptPath?: string;
  /** Poll interval in ms (default 300). */
  pollIntervalMs?: number;
}

export class ClaudeTranscriptTailer implements TranscriptEventSource {
  private readonly tailer: JsonlTailer;

  constructor(opts: ClaudeTranscriptTailerOptions) {
    const explicit = opts.transcriptPath;
    this.tailer = new JsonlTailer({
      resolvePath: explicit
        ? () => explicit
        : () => resolveClaudeTranscriptPath(opts.cwd),
      mapEntry: mapClaudeEntry,
      pollIntervalMs: opts.pollIntervalMs,
      watchForSwitch: !explicit,
    });
  }

  start(): void { this.tailer.start(); }
  stop(): void { this.tailer.stop(); }
  onEvent(cb: (e: NormalizedDriverEvent) => void): void { this.tailer.onEvent(cb); }
}
