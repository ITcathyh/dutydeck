/**
 * Claude Code transcript tailer.
 *
 * Claude stores sessions at <dataDir>/projects/<projectKey>/<sessionId>.jsonl
 * where dataDir = $CLAUDE_CONFIG_DIR (or ~/.claude) and projectKey = the
 * REALPATH of cwd with every non-[A-Za-z0-9-] char replaced by '-'
 * (realpath-not-lexical rule: a symlinked cwd must resolve to the same key the CLI used).
 * Third-party attribution: see THIRD_PARTY_NOTICES.md.
 *
 * Entry mapping (per dutydeck driver contract):
 *   assistant message.content[]:
 *     thinking block  → { type:'thinking',  data:{ text } }
 *     text block      → { type:'text',      data:{ text } }
 *     tool_use block  → { type:'tool_call', data:{ id, name, input, status:'running' } }
 *   user message.content[]:
 *     tool_result     → { type:'tool_result', data:{ id, status, output } }
 *   system turn_duration → no event; feeds pendingBackgroundWork()
 *                          (see claudePendingBackgroundWork)
 *   system compact_boundary → { type:'status', data:{ state:'compaction', phase:'completed' } }
 *
 * Sidechain (Task tool internals) lines are skipped. API-error assistant lines
 * are not model output either: the tailer holds the latest one back as the
 * turn's failure reason (see claudeApiError / takeTurnError).
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { NormalizedDriverEvent } from '@dutydeck/shared';
import { pinnedSessionUuid } from '@dutydeck/cli-adapters';
import { claudeProjectDir, type CliPathEnv } from '../cli-paths.js';
import { byMtimeDesc, parseJsonlObjects, readHead, walkFiles } from '../session-id/fs-scan.js';
import { isUsableMarker } from '../session-id/marker.js';
import { JsonlTailer, type TranscriptCursor, type TranscriptEventSource } from './tail.js';

/** Head window per candidate when scanning for the marker. It rides the FIRST
 *  user prompt, so a small window suffices and a long conversation is never
 *  read in full. Matches session-id/claude.ts. */
const MARKER_HEAD_BYTES = 256 * 1024;
/** Newest-first cap on candidates scanned in one project dir. */
const MAX_MARKER_CANDIDATES = 40;

/** Newest *.jsonl (by mtime) in a Claude project dir, or undefined.
 *
 *  DANGEROUS on its own: the project dir is keyed by cwd ALONE, so every
 *  dutydeck session started in the same repo lands here, and "newest" is then
 *  a sibling's transcript as often as it is ours. Only reachable now when the
 *  caller supplies no session id (tooling / tests). Session-scoped callers go
 *  through resolveClaudeTranscriptPath with a sessionId. */
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

/**
 * Locate the Claude transcript jsonl for a session.
 *
 * `sessionId` is what makes this correct, and omitting it is only safe when
 * the caller genuinely has no session in mind.
 *
 * WHY: the project dir is derived from cwd alone
 * (`projects/<cwd-with-punctuation-replaced>/`), so N dutydeck sessions in one
 * repo write N jsonl files into ONE directory. Picking by mtime therefore
 * picks whoever wrote last — a sibling, most of the time. Observed with three
 * sessions sharing a cwd: two of them replayed the third's answer verbatim
 * and still reported `completed`, and in the tighter race all three saw zero
 * assistant text and were failed as "no final output" while all three
 * on-disk transcripts were perfectly correct.
 *
 * `session-id/claude.ts` already refuses the mtime pick for exactly this
 * reason ("picking the newest jsonl among them would resume a sibling's
 * conversation"). This is the same hazard on the read path, so it takes the
 * same two-step resolution: the id dutydeck pinned via `--session-id`, then
 * the marker scan for when Claude declined that id (a collision makes the CLI
 * mint its own) or when the session was adopted rather than spawned by us.
 *
 * Returns undefined rather than guessing when the session cannot be
 * identified: no transcript means the screen-pattern fallback decides the
 * turn, whereas a wrong transcript puts another session's words in this
 * session's timeline.
 */
export function resolveClaudeTranscriptPath(
  cwd: string,
  env?: CliPathEnv,
  sessionId?: string,
): string | undefined {
  const projectDir = claudeProjectDir(cwd, env);
  if (sessionId) return resolveClaudeSessionTranscript(projectDir, sessionId);
  // No session id (tooling, tests): the historical mtime pick, which is only
  // unambiguous when a single session owns the cwd.
  return findLatestJsonl(projectDir);
}

/** The session's own jsonl inside an already-resolved project dir: pinned id
 *  first, marker scan second, undefined when neither identifies it. */
function resolveClaudeSessionTranscript(projectDir: string, sessionId: string): string | undefined {
  // Fast path: dutydeck pinned the id via `--session-id <uuid>` (see
  // cli-adapters/adapters/claude-family.ts buildArgs) and Claude accepted it,
  // so the filename is the pinned uuid.
  const pinned = pinnedSessionUuid(sessionId);
  if (pinned) {
    const direct = join(projectDir, `${pinned}.jsonl`);
    if (existsSync(direct)) return direct;
  }
  // Scan path: find the transcript whose first user prompt carries our
  // marker. Newest-first only bounds the work — the marker decides which is
  // ours. Same contract as the session-id lookup; see marker.ts.
  return findJsonlByMarker(projectDir, sessionId);
}

/** The jsonl in `dir` whose head carries `marker`, or undefined. */
function findJsonlByMarker(dir: string, marker: string): string | undefined {
  if (!isUsableMarker(marker)) return undefined;
  const candidates = walkFiles(dir, { maxDepth: 0, accept: name => name.endsWith('.jsonl') })
    .sort(byMtimeDesc)
    .slice(0, MAX_MARKER_CANDIDATES);
  for (const candidate of candidates) {
    for (const entry of parseJsonlObjects(readHead(candidate.path, MARKER_HEAD_BYTES))) {
      // Sidechain entries are Task-tool internals, not the session's own prompt.
      if (entry?.isSidechain === true) continue;
      if (entryMentionsMarker(entry, marker)) return candidate.path;
    }
  }
  return undefined;
}

/** Does an entry's text content mention the marker? Handles both the string
 *  and the content-block array form of `message.content`. */
function entryMentionsMarker(entry: any, marker: string): boolean {
  const content = entry?.message?.content;
  if (typeof content === 'string') return content.includes(marker);
  if (!Array.isArray(content)) return false;
  return content.some((block: any) =>
    block && typeof block === 'object' && typeof block.text === 'string' && block.text.includes(marker));
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
    // Claude can persist a provider-generated assistant placeholder when no
    // model call happened. Treat the exact provider model sentinel as a
    // retryable terminal failure; its text is not an assistant reply.
    if (entry.message?.model === '<synthetic>') {
      return [{
        type: 'error',
        data: {
          message: 'Claude 未产生模型回复，请重试此任务。',
          code: 'provider_no_model_reply',
          retryable: true,
        },
      }];
    }
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

  // Context compaction (auto or /compact). Same status shape the ACP driver
  // reports, so the Lark result card can suggest a fresh session.
  if (entry.type === 'system' && entry.subtype === 'compact_boundary') {
    return [{ type: 'status', data: { state: 'compaction', phase: 'completed' } }];
  }

  return undefined;
}

const API_ERROR_RAW_LIMIT = 300;

/** First non-empty line of an API error, with credentials masked and capped at
 *  API_ERROR_RAW_LIMIT characters. Lark redacts again when it renders. */
function apiErrorRawLine(text: string): string {
  const line = (text.split('\n').map(item => item.trim()).find(Boolean) ?? '')
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, '$1[REDACTED]@')
    .replace(/\bbearer\s+[^\s"',;}]+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
    .replace(/((?:api[_-]?key|token|secret|password)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&}]+)/gi, '$1[REDACTED]');
  const chars = Array.from(line);
  return chars.length > API_ERROR_RAW_LIMIT ? `${chars.slice(0, API_ERROR_RAW_LIMIT).join('')}…` : line;
}

const CONFIG_HINT = 'Claude 拒绝了这次请求，模型或请求配置有误，重试无效。请检查 Agent 配置或 /new 的 --model 参数。';

/** One actionable hint per failure the user can do something different about. */
function apiErrorHint(kind: string, status: unknown, text: string): { hint: string; code: string; retryable: boolean } {
  // The body is consulted only for this: context overflow arrives as a plain
  // invalid_request whose remedy (a fresh session) differs from a bad config.
  if (/prompt is too long/i.test(text)) {
    return { code: 'claude_context_too_long', retryable: false,
      hint: '本会话上下文已超出模型上限，重试无效。请用 /new 开新会话（加 --handoff 可带上交接信息）。' };
  }
  const code = `claude_api_${kind}`;
  switch (kind) {
    case 'rate_limit':
    case 'billing_error': {
      const reset = /\bresets?\s+(?:at\s+)?([^·\n]+)/i.exec(text)?.[1]?.trim().replace(/[.。]$/, '');
      return { code, retryable: false,
        hint: `Claude 上游限流或额度已用尽${reset ? `，额度约在 ${reset} 重置` : ''}。请等额度恢复后再重发，或换用其他模型。` };
    }
    case 'authentication_failed':
    case 'oauth_org_not_allowed':
    case 'account_on_hold':
    case 'verification_required':
    case 'cloud_credential_error':
      return { code, retryable: false,
        hint: 'Claude 登录或凭据已失效，重试无效。请到开发机上重新登录 Claude Code（/login），或检查网关凭据。' };
    case 'model_not_found':
    case 'invalid_request':
      return { code, retryable: false, hint: CONFIG_HINT };
    default:
      // unknown / overloaded / server_error, and enum values newer than this
      // list. An unattributed 4xx other than 429 is still the request's fault.
      if (kind === 'unknown' && typeof status === 'number' && status >= 400 && status < 500 && status !== 429) {
        return { code, retryable: false, hint: CONFIG_HINT };
      }
      return { code, retryable: true,
        hint: 'Claude 上游暂时不可用（过载、服务端错误或网络中断），Claude Code 已在内部重试过。请稍后重发。' };
  }
}

/**
 * The failure an API-error line reports, as a displayable error event, or
 * undefined for every other entry. Claude Code writes one after its own
 * retries give up: `isApiErrorMessage: true`, the `error` enum, and the CLI's
 * message as a text block. Whether it becomes the turn's failure is decided by
 * the tailer (a later answer supersedes it), so mapClaudeEntry never emits it.
 */
export function claudeApiError(entry: any): NormalizedDriverEvent | undefined {
  if (!entry || typeof entry !== 'object' || entry.isSidechain === true || entry.isApiErrorMessage !== true) return undefined;
  const content = entry.message?.content;
  const text = typeof content === 'string' ? content : Array.isArray(content)
    ? content.filter((block: any) => block?.type === 'text' && typeof block.text === 'string').map((block: any) => block.text).join('\n')
    : '';
  const { hint, code, retryable } = apiErrorHint(typeof entry.error === 'string' ? entry.error : 'unknown', entry.apiErrorStatus, text);
  const raw = apiErrorRawLine(text);
  return {
    type: 'error',
    data: { message: raw ? `${hint}\n原文：${raw}` : hint, code, retryable },
    ...(typeof entry.uuid === 'string' && entry.uuid ? { sourceId: `claude-api-error:${entry.uuid}` } : {}),
  };
}

/**
 * Background work a main-thread turn ended with. Claude writes a
 * `system/turn_duration` record at every turn end; while sub-agents (or
 * dynamic workflows) it launched in the background are still running, the
 * record carries their count and the screen shows `✻ Waiting for 1 background
 * agent to finish`. Their completion re-wakes the session as a new turn whose
 * own record reports what is left. Undefined for every other entry.
 */
export function claudePendingBackgroundWork(entry: any): number | undefined {
  if (!entry || entry.isSidechain === true || entry.type !== 'system' || entry.subtype !== 'turn_duration') return undefined;
  const count = (value: unknown) => (Number.isSafeInteger(value) && (value as number) > 0 ? value as number : 0);
  return count(entry.pendingBackgroundAgentCount) + count(entry.pendingWorkflowCount);
}

export interface ClaudeTranscriptTailerOptions {
  cwd: string;
  /** Explicit transcript path. When given, directory scanning and file
   *  switching are disabled — handy for tests and for callers that already
   *  resolved the session file. */
  transcriptPath?: string;
  /**
   * dutydeck's session id. Required for correctness whenever more than one
   * session may share `cwd`: without it resolution falls back to "newest
   * jsonl in the project dir", which is a sibling session's transcript as
   * often as it is this one's. See resolveClaudeTranscriptPath.
   */
  sessionId?: string;
  /** Poll interval in ms (default 300). */
  pollIntervalMs?: number;
  /** The environment the CLI child was spawned with. Defaults to the current
   *  process env; the driver passes `spawnEnv()` so a `CLAUDE_CONFIG_DIR` that
   *  only the child sees (or only the daemon sees) resolves correctly. */
  env?: CliPathEnv;
}

export class ClaudeTranscriptTailer implements TranscriptEventSource {
  private readonly tailer: JsonlTailer;
  private backgroundWork = 0;
  /** Latest API error of this turn not yet superseded by model output. */
  private turnError: NormalizedDriverEvent | undefined;
  /** Type of this turn's latest model activity, ranked as the runtime ranks it. */
  private lastActivity: NormalizedDriverEvent['type'] | undefined;

  constructor(opts: ClaudeTranscriptTailerOptions) {
    const explicit = opts.transcriptPath;
    /**
     * Memoise the session-scoped resolution.
     *
     * JsonlTailer calls resolvePath on EVERY tick (~300ms) while
     * watchForSwitch is on. The pinned-id branch is one existsSync, but the
     * marker fallback reads the head of up to 40 files — repeating that 3×/s
     * for the life of a session would be a real cost, and it buys nothing:
     * a session's transcript path does not change once found. So resolve
     * until it succeeds, then hold the answer.
     */
    let resolved: string | undefined;
    const resolveOnce = () => (resolved ??= resolveClaudeTranscriptPath(opts.cwd, opts.env, opts.sessionId));
    this.tailer = new JsonlTailer({
      resolvePath: explicit
        ? () => explicit
        : opts.sessionId
          ? resolveOnce
          : () => resolveClaudeTranscriptPath(opts.cwd, opts.env),
      mapEntry: entry => {
        const pending = claudePendingBackgroundWork(entry);
        if (pending !== undefined) this.backgroundWork = pending;
        const apiError = claudeApiError(entry);
        if (apiError) {
          // Right after a text step the runtime already completes the turn (a
          // stop-hook continuation, or an answer cut short mid-stream), and
          // reporting the error would fail an answer the user has. Otherwise
          // it is the reason the turn ends without final text.
          this.turnError = this.lastActivity === 'text' ? undefined : apiError;
          return undefined;
        }
        const events = mapClaudeEntry(entry);
        const activity = events?.filter(event => ['text', 'thinking', 'tool_call', 'tool_result'].includes(event.type)).at(-1);
        if (activity) {
          // The model carried on, so that error no longer explains the turn's end.
          this.turnError = undefined;
          this.lastActivity = activity.type;
        }
        return events;
      },
      pollIntervalMs: opts.pollIntervalMs,
      /**
       * Re-resolving each tick is what lets the tailer attach late: the jsonl
       * does not exist until Claude's first prompt, and a `--session-id`
       * refusal is only discoverable by the marker scan once that prompt is
       * recorded. With a sessionId the memo above means each tick is free
       * once the file has been found.
       *
       * Session-scoped resolution can only ever return our own file, so this
       * cannot drift onto a sibling's. The tradeoff: if the CLI ever rotates
       * to a NEW transcript mid-session, the memoised file wins and the
       * rotation is not followed. That is the safe side — staying on our own
       * file is at worst incomplete, whereas following recency is confirmed
       * to attach another session's transcript outright. (Whether Claude
       * rotates at all is unverified; do not read this as evidence that it
       * does.)
       */
      watchForSwitch: !explicit,
    });
  }

  start(): void { this.tailer.start(); }
  flush(): Promise<void> { return this.tailer.flush(); }
  checkpoint(): TranscriptCursor { return this.tailer.checkpoint(); }
  restore(cursor: TranscriptCursor): void { this.tailer.restore(cursor); }
  stop(): void { this.tailer.stop(); }
  onEvent(cb: (e: NormalizedDriverEvent) => void): void { this.tailer.onEvent(cb); }
  pendingBackgroundWork(): number { return this.backgroundWork; }
  resetBackgroundWork(): void { this.backgroundWork = 0; }
  takeTurnError(): NormalizedDriverEvent | undefined {
    const error = this.turnError;
    this.turnError = undefined;
    this.lastActivity = undefined;
    return error;
  }
}
