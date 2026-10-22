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
 * Token usage: every assistant line carries message.usage, and one API message is written once per
 * content block with the same message.id and usage, so usage is de-duplicated by message.id and
 * reported once per turn as status/turn_usage (see tallyUsage / takeTurnUsage). Sub-agent (Task,
 * Explore, workflow) messages are billed too. Claude Code 2.1.x keeps them in separate files under
 * <session>/subagents/ (see claude-subagents.ts), older versions as isSidechain lines of the main
 * transcript; both are counted there even though they produce no events.
 *
 * Sidechain (Task tool internals) lines are skipped. API-error assistant lines
 * are not model output either: the tailer holds the latest one back as the
 * turn's failure reason (see claudeApiError / takeTurnError).
 */
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import type { NormalizedDriverEvent } from '@dutydeck/shared';
import { pinnedSessionUuid } from '@dutydeck/cli-adapters';
import { claudeProjectDir, type CliPathEnv } from '../cli-paths.js';
import { byMtimeDesc, parseJsonlObjects, readHead, walkFiles } from '../session-id/fs-scan.js';
import { buildSessionMarker, isUsableMarker } from '../session-id/marker.js';
import { JsonlTailer, type TranscriptCursor, type TranscriptEventSource, type TranscriptPosition } from './tail.js';
import { claudeInputText } from './input-receipt.js';
import { userEntryMentionsMarker } from './claude-content.js';
import { ClaudeSubagentReader } from './claude-subagents.js';
import { ClaudeBackgroundTasks } from './claude-background.js';

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
function findJsonlByMarker(dir: string, sessionId: string): string | undefined {
  if (!isUsableMarker(sessionId)) return undefined;
  const marker = buildSessionMarker(sessionId);
  const candidates = walkFiles(dir, { maxDepth: 0, accept: name => name.endsWith('.jsonl') })
    .sort(byMtimeDesc)
    .slice(0, MAX_MARKER_CANDIDATES);
  for (const candidate of candidates) {
    for (const entry of parseJsonlObjects(readHead(candidate.path, MARKER_HEAD_BYTES))) {
      if (userEntryMentionsMarker(entry, marker)) return candidate.path;
    }
  }
  return undefined;
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
  // Request blobs copy historical messages, not new model/tool activity.
  if (entry.type === 'api-request-blob') return undefined;
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

interface ClaudeMessageUsage { model?: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }
const usageNumber = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
/** Cap on remembered message ids; only guards against re-reading the same records after a restore. */
const REPORTED_USAGE_IDS_MAX = 20_000;

/**
 * Per-message usage of an assistant record, or undefined when it reports none. Provider-synthesised
 * placeholders (`<synthetic>`, API-error lines) made no model call and carry zeros, so they are not usage.
 */
export function claudeMessageUsage(entry: any): ({ id: string } & ClaudeMessageUsage) | undefined {
  if (!entry || typeof entry !== 'object' || entry.type !== 'assistant' || entry.isApiErrorMessage === true) return undefined;
  const message = entry.message;
  const usage = message?.usage;
  if (typeof message?.id !== 'string' || !message.id || !usage || typeof usage !== 'object' || message.model === '<synthetic>') return undefined;
  return {
    id: message.id,
    ...(typeof message.model === 'string' && message.model.trim() ? { model: message.model.trim() } : {}),
    inputTokens: usageNumber(usage.input_tokens), outputTokens: usageNumber(usage.output_tokens),
    cacheReadTokens: usageNumber(usage.cache_read_input_tokens), cacheWriteTokens: usageNumber(usage.cache_creation_input_tokens),
  };
}

/** An assistant record that should carry usage but does not: the sub-agent file is in a shape we do not know. */
function claudeUsageUnreadable(entry: any): boolean {
  if (entry?.type !== 'assistant' || entry.isApiErrorMessage === true || entry.message?.model === '<synthetic>') return false;
  return typeof entry.message?.id !== 'string' || !entry.message.id || !entry.message.usage || typeof entry.message.usage !== 'object';
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
  private backgroundReported = false;
  private readonly backgroundTasks = new ClaudeBackgroundTasks();
  private observedInputId?: string;
  private readonly memoryCalls = new Map<string, string>();
  private readonly backgroundCallbacks = new Set<(event: NormalizedDriverEvent) => void>();
  private readonly backgroundOffsets = new Map<string, { dev: number; ino: number; offset: number }>();
  private backgroundSnapshot = '';
  private backgroundTimer?: NodeJS.Timeout;
  private backgroundGeneration = 0;
  private backgroundStopped = false;
  /** Latest API error of this turn not yet superseded by model output. */
  private turnError: NormalizedDriverEvent | undefined;
  /** Type of this turn's latest model activity, ranked as the runtime ranks it. */
  private lastActivity: NormalizedDriverEvent['type'] | undefined;
  private inputUuid: string | undefined;
  private readonly inputEntries = new Set<string>();
  private inputError: NormalizedDriverEvent | undefined;
  private terminalScope = false;
  private turnTerminal = false;
  /** Learned from both historical and live main-thread records. */
  private durationMarkerSeen = false;
  private readonly durationUuids = new Set<string>();
  private durationComplete = false;
  private inputAssistantSeen = false;
  private terminalRevision = 0;
  private terminalPosition: TranscriptPosition | undefined;
  private recoveredInput = false;
  private readonly terminalUuids = new Set<string>();
  private restoringTurn = false;
  private receiptEntry: unknown;
  /** Usage of the API messages seen since the last takeTurnUsage(), by message.id (insertion order = transcript order). */
  private readonly pendingUsage = new Map<string, ClaudeMessageUsage>();
  private readonly reportedUsageIds = new Set<string>();
  private readonly subagents: ClaudeSubagentReader;
  private subagentsBaselined = false;
  private restored = false;
  /** Some usage of the turn could not be read (sub-agent files), so the reading is a lower bound. */
  private usagePartial = false;

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
    const resolvePath = explicit
      ? () => explicit
      : opts.sessionId
        ? resolveOnce
        : () => resolveClaudeTranscriptPath(opts.cwd, opts.env);
    this.subagents = new ClaudeSubagentReader(resolvePath);
    const memoryRoot = resolve(claudeProjectDir(opts.cwd, opts.env), 'memory') + sep;
    const decorateMemory = (events: NormalizedDriverEvent[] | undefined) => {
      for (const event of events ?? []) {
        if (!['text', 'tool_call', 'tool_result'].includes(event.type) || !this.observedInputId) continue;
        Object.assign(event.data, { nativeSource: 'claude', nativeTurnId: this.observedInputId });
        if (event.type === 'tool_call') {
          const path = event.data.input?.file_path;
          if (['Write', 'Edit'].includes(event.data.name) && typeof path === 'string' && isAbsolute(path) && resolve(path).startsWith(memoryRoot)) {
            this.memoryCalls.set(event.data.id, this.observedInputId);
            event.data.memoryPostprocess = true;
          }
        } else if (event.type === 'tool_result') {
          event.data.memoryPostprocess = event.data.status === 'completed' && this.memoryCalls.get(event.data.id) === this.observedInputId;
          this.memoryCalls.delete(event.data.id);
        }
      }
      return events;
    };
    this.tailer = new JsonlTailer({
      resolvePath,
      baselineMapping: true,
      mapEntry: (entry, baseline, position) => {
        const backgroundChanged = this.backgroundTasks.observe(entry);
        const nativeInput = claudeInputText(entry) !== undefined && entry.isSidechain !== true;
        const notification = entry.turnOrigin === 'task_notification' || entry.origin?.kind === 'task-notification';
        if (nativeInput && !notification) { this.observedInputId = entry.uuid; this.memoryCalls.clear(); this.backgroundReported = false; }
        const reportedBackground = claudePendingBackgroundWork(entry);
        if (reportedBackground !== undefined) {
          this.durationMarkerSeen = true;
          if (typeof entry.uuid === 'string') {
            const replay = this.durationUuids.has(entry.uuid);
            this.durationUuids.add(entry.uuid);
            if (replay && !baseline) return backgroundChanged ? [{ type: 'status', data: this.backgroundTasks.snapshot() }] : undefined;
          }
          this.backgroundReported = true;
          if (baseline) this.backgroundWork = reportedBackground;
        }
        if (baseline) { decorateMemory(mapClaudeEntry(entry)); return undefined; }
        this.tallyUsage(entry);
        const backgroundEvent: NormalizedDriverEvent = { type: 'status', data: this.backgroundTasks.snapshot() };
        if (backgroundChanged) this.backgroundSnapshot = JSON.stringify(backgroundEvent.data);
        // Native background follow-ups belong to their launch, never to the
        // business input that happens to be active when the notice arrives.
        if (this.backgroundTasks.isNotificationContinuation() && this.backgroundWork === 0 && (!this.terminalScope || !!this.inputUuid)) return backgroundChanged ? [backgroundEvent] : undefined;
        // A recovery cursor is captured before submission. Its first fresh
        // business input supplies the same boundary as an exact live receipt.
        if (this.restoringTurn && nativeInput && !notification) {
          this.bindInput(entry); this.restoringTurn = false; this.recoveredInput = true;
        } else if (nativeInput && !notification && entry !== this.receiptEntry) {
          this.terminalScope = false; this.turnTerminal = false; this.recoveredInput = false;
        }
        // A newer human input closes this receipt's output scope. The driver
        // may still be draining its previous screen; never attach the new
        // input's answer or failure to that original Attempt.
        if (this.receiptEntry && !this.terminalScope) {
          this.inputEntries.clear();
          return backgroundChanged ? [backgroundEvent] : undefined;
        }
        if (this.inputUuid && entry.isSidechain !== true && typeof entry.uuid === 'string'
          && (this.inputEntries.has(entry.parentUuid)
            // Some native dialects omit parentUuid on every record. Their
            // physical user boundary scopes output; a parentless duration
            // still needs this input's assistant evidence before it can end it.
            || (this.terminalScope && entry.parentUuid === undefined && this.observedInputId === this.inputUuid
              && (entry.type === 'assistant' || (reportedBackground !== undefined && this.inputAssistantSeen))))) {
          this.inputEntries.add(entry.uuid);
        }
        const pending = claudePendingBackgroundWork(entry);
        if (pending !== undefined) this.backgroundWork = pending;
        const terminal = pending === 0 || (entry.type === 'assistant'
          && ((!this.durationMarkerSeen && ['end_turn', 'stop_sequence'].includes(entry.message?.stop_reason))
            || (entry.message?.model === '<synthetic>' && entry.isApiErrorMessage !== true)));
        const bound = this.terminalScope && entry.isSidechain !== true
          && (this.inputUuid ? this.inputEntries.has(entry.uuid)
            : entry.parentUuid === undefined || this.inputEntries.has(entry.parentUuid));
        // Legacy inputs can lack UUIDs. Keep their fresh non-terminal chain,
        // but never let an unrelated terminal introduce its own ancestry.
        if (this.terminalScope && !this.inputUuid && entry.isSidechain !== true && typeof entry.uuid === 'string' && (!terminal || bound)) {
          this.inputEntries.add(entry.uuid);
        }
        if (bound) {
          if (entry.type === 'assistant') this.inputAssistantSeen = true;
          if (pending !== undefined) this.durationComplete = true;
          else if (entry.type === 'assistant') this.durationComplete = false;
          if (notification || (pending !== undefined && pending > 0)) this.turnTerminal = false;
          else if (terminal) {
            const uuid = typeof entry.uuid === 'string' ? entry.uuid : undefined;
            if (uuid ? !this.terminalUuids.has(uuid) : !this.turnTerminal) {
              this.terminalRevision++; this.terminalPosition = position;
            }
            if (uuid) this.terminalUuids.add(uuid);
            this.turnTerminal = true;
          } else if (entry.type === 'assistant') {
            this.turnTerminal = false;
          }
        }
        const apiError = claudeApiError(entry);
        if (apiError) {
          // In marker dialects a Stop hook can fail after partial text. Keep
          // that failure on this input until its complete turn boundary.
          // Legacy dialects retain their existing last-text compatibility.
          if (!this.inputUuid || this.inputEntries.has(entry.uuid)) {
            this.turnError = !this.durationMarkerSeen && this.lastActivity === 'text' ? undefined : apiError;
            this.inputError = this.inputUuid ? this.turnError : undefined;
          }
          return undefined;
        }
        const events = decorateMemory(mapClaudeEntry(entry));
        const activity = events?.filter(event => ['text', 'thinking', 'tool_call', 'tool_result'].includes(event.type)).at(-1);
        if (activity) {
          // The model carried on, so that error no longer explains the turn's end.
          this.turnError = undefined; this.inputError = undefined;
          this.lastActivity = activity.type;
        }
        return backgroundChanged ? [...events ?? [], backgroundEvent] : events;
      },
      inputText: claudeInputText,
      onInputReceipt: entry => {
        this.bindInput(entry);
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
      resetMapping: () => {
        this.terminalScope = false; this.turnTerminal = false; this.terminalUuids.clear();
        this.terminalPosition = undefined; this.recoveredInput = false;
        this.inputUuid = undefined; this.inputEntries.clear(); this.receiptEntry = undefined; this.restoringTurn = false;
      },
    });
  }

  start(): void {
    this.backgroundStopped = false;
    if (!this.subagentsBaselined) {
      this.subagentsBaselined = true;
      // A restored tailer cannot tell which sub-agent records the recovered turn already wrote.
      this.subagents.baseline(this.restored);
    }
    this.tailer.start();
    this.backgroundSnapshot = JSON.stringify(this.backgroundTasks.snapshot());
    this.backgroundTimer ??= setInterval(() => { this.refreshBackgroundTasks(); }, 1_000);
    this.backgroundTimer.unref();
  }
  async flush(): Promise<void> {
    const generation = this.backgroundGeneration;
    await this.tailer.flush();
    if (generation === this.backgroundGeneration) this.refreshBackgroundTasks();
  }
  private refreshBackgroundTasks(): void {
    if (this.backgroundStopped) return;
    // /clear changes the main transcript. Read only native stop notices for
    // task identities already owned here; never follow another session's text.
    const path = this.tailer.checkpoint().path;
    if (path && this.backgroundTasks.snapshot().count) {
      try {
        for (const name of readdirSync(dirname(path)).filter(name => name.endsWith('.jsonl')).slice(-40)) {
          const sibling = join(dirname(path), name); if (sibling === path) continue;
          const observed = statSync(sibling), old = this.backgroundOffsets.get(sibling);
          if (observed.size > 4 * 1024 * 1024) continue;
          if (old && old.dev === observed.dev && old.ino === observed.ino && old.offset === observed.size) continue;
          const fd = openSync(sibling, 'r');
          let bytes: Buffer, offset: number, stat: ReturnType<typeof fstatSync>;
          try {
            stat = fstatSync(fd);
            if (stat.size > 4 * 1024 * 1024) continue;
            offset = old && old.dev === stat.dev && old.ino === stat.ino && old.offset <= stat.size ? old.offset : 0;
            bytes = Buffer.allocUnsafe(stat.size - offset);
            let read = 0;
            while (read < bytes.length) {
              const count = readSync(fd, bytes, read, bytes.length - read, offset + read);
              if (!count) break;
              read += count;
            }
            // A concurrent truncation invalidates this cursor, including any partial line.
            if (fstatSync(fd).size < stat.size) { this.backgroundOffsets.delete(sibling); continue; }
            bytes = bytes.subarray(0, read);
          } finally { closeSync(fd); }
          const end = bytes.lastIndexOf(10);
          // Only decode complete lines: a split UTF-8 character is reread as bytes next time.
          this.backgroundOffsets.set(sibling, { dev: stat.dev, ino: stat.ino, offset: offset + end + 1 });
          if (end < 0) continue;
          for (const line of bytes.subarray(0, end).toString('utf8').split('\n')) {
            try {
              const entry = JSON.parse(line);
              const content = entry.type === 'queue-operation' && entry.operation === 'enqueue' ? entry.content
                : entry.turnOrigin === 'task_notification' ? entry.message?.content
                : entry.attachment?.commandMode === 'task-notification' ? entry.attachment.prompt : undefined;
              if (typeof content === 'string') this.backgroundTasks.observe({ type: 'queue-operation', operation: 'enqueue', content });
            } catch { /* Unknown records cannot change lifecycle state. */ }
          }
        }
      } catch { /* Clear does not authorize guessing another transcript's output. */ }
    }
    const data = this.backgroundTasks.snapshot(), snapshot = JSON.stringify(data);
    if (data.tasks.length > 0 && snapshot !== this.backgroundSnapshot) {
      this.backgroundSnapshot = snapshot;
      for (const callback of this.backgroundCallbacks) callback({ type: 'status', data });
    }
  }
  checkpoint(): TranscriptCursor { return this.tailer.checkpoint(); }
  restore(cursor: TranscriptCursor): void {
    this.tailer.restore(cursor);
    this.restored = true;
    this.terminalScope = false; this.turnTerminal = false; this.terminalUuids.clear(); this.restoringTurn = true;
  }
  stop(): void { this.backgroundStopped = true; this.backgroundGeneration++; this.backgroundOffsets.clear(); if (this.backgroundTimer) clearInterval(this.backgroundTimer); this.backgroundTimer = undefined; this.tailer.stop(); }
  onEvent(cb: (e: NormalizedDriverEvent) => void): void { this.tailer.onEvent(cb); this.backgroundCallbacks.add(cb); }
  onProgress(cb: () => void): void { this.tailer.onProgress(cb); }
  waitForInput(prompt: string, signal: AbortSignal): Promise<void> {
    this.terminalScope = false; this.turnTerminal = false; this.terminalUuids.clear(); this.restoringTurn = false;
    this.receiptEntry = undefined;
    this.inputUuid = undefined; this.inputEntries.clear(); this.inputError = undefined;
    return this.tailer.waitForInput(prompt, signal);
  }
  pendingBackgroundWork(): number { return Math.max(this.backgroundWork, this.backgroundReported ? this.backgroundTasks.snapshot().count : 0); }
  hasIndependentBackgroundWork(): boolean { return this.backgroundWork === 0 && this.backgroundTasks.independent(); }
  get requiresTurnTerminal(): boolean { return this.durationMarkerSeen && this.terminalScope && !this.durationComplete; }
  hasTurnTerminal(): boolean { return this.turnTerminal; }
  turnTerminalRevision(): number { return this.terminalRevision; }
  captureWatermark(): TranscriptPosition | undefined { return this.tailer.captureWatermark(); }
  hasTurnTerminalAfter(watermark: TranscriptPosition): boolean {
    const terminal = this.terminalPosition, current = this.captureWatermark();
    return this.turnTerminal && !!terminal && !!current
      && [terminal, current].every(position => position.path === watermark.path
        && position.dev === watermark.dev && position.ino === watermark.ino && position.epoch === watermark.epoch
        && position.offset >= watermark.offset);
  }
  hasRecoveredInput(): boolean { return this.recoveredInput && this.terminalScope; }
  private bindInput(entry: any): void {
    this.receiptEntry = entry;
    this.durationComplete = false; this.inputAssistantSeen = false;
    this.terminalPosition = undefined; this.recoveredInput = false;
    this.terminalScope = true; this.turnTerminal = false; this.terminalUuids.clear();
    this.inputUuid = typeof entry.uuid === 'string' ? entry.uuid : undefined;
    this.inputEntries.clear();
    this.lastActivity = undefined; this.turnError = undefined; this.inputError = undefined;
    if (this.inputUuid) this.inputEntries.add(this.inputUuid);
  }
  resetBackgroundWork(): void { this.backgroundWork = 0; this.backgroundReported = false; }
  /** False for a record that should have carried usage but did not. */
  private tallyUsage(entry: any): boolean {
    const usage = claudeMessageUsage(entry);
    if (!usage) return !claudeUsageUnreadable(entry);
    // A message is first written with all-zero usage before its real reading arrives; it counts once it has one,
    // so a turn that ends in between does not report it as zero and then ignore the real reading.
    if (this.reportedUsageIds.has(usage.id) || !(usage.inputTokens || usage.outputTokens || usage.cacheReadTokens || usage.cacheWriteTokens)) return true;
    const previous = this.pendingUsage.get(usage.id);
    // Lines of one message repeat the same usage; a streamed partial line can carry a smaller output count.
    this.pendingUsage.set(usage.id, previous ? {
      model: usage.model ?? previous.model,
      inputTokens: Math.max(previous.inputTokens, usage.inputTokens), outputTokens: Math.max(previous.outputTokens, usage.outputTokens),
      cacheReadTokens: Math.max(previous.cacheReadTokens, usage.cacheReadTokens), cacheWriteTokens: Math.max(previous.cacheWriteTokens, usage.cacheWriteTokens),
    } : usage);
    return true;
  }
  /**
   * Token usage of every API message read since the previous call, as one status/turn_usage reading in the
   * same shape the ACP driver reports (the usageRef is the last message id, so re-reading the same records
   * after a restore is not counted twice). Sub-agent files are read here, so the reading covers what they
   * recorded since the previous call. `breakdown` is the total; when several models took part (a sub-agent on
   * another model) `model` names them together and `byModel` splits the total so each can be priced at its own rate.
   * `partial` is set when part of the usage could not be read (a sub-agent file failed or was not understood).
   * Undefined when the transcript showed no usage: the caller then records the turn as unavailable, never as zero.
   */
  takeTurnUsage(): NormalizedDriverEvent | undefined {
    if (!this.subagents.read(entry => this.tallyUsage(entry))) this.usagePartial = true;
    const partial = this.usagePartial;
    this.usagePartial = false;
    if (!this.pendingUsage.size) return undefined;
    const messages = [...this.pendingUsage.entries()];
    this.pendingUsage.clear();
    for (const [id] of messages) this.reportedUsageIds.add(id);
    while (this.reportedUsageIds.size > REPORTED_USAGE_IDS_MAX) this.reportedUsageIds.delete(this.reportedUsageIds.values().next().value as string);
    const breakdown = (list: ClaudeMessageUsage[]) => {
      const sum = (key: keyof Omit<ClaudeMessageUsage, 'model'>) => list.reduce((total, usage) => total + usage[key], 0);
      return { inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'), cachedReadTokens: sum('cacheReadTokens'), cachedWriteTokens: sum('cacheWriteTokens') };
    };
    const byModel = new Map<string, ClaudeMessageUsage[]>();
    for (const [, usage] of messages) {
      const model = usage.model ?? '', group = byModel.get(model);
      if (group) group.push(usage);
      else byModel.set(model, [usage]);
    }
    const models = [...byModel.keys()].filter(Boolean).sort();
    return {
      type: 'status',
      data: {
        state: 'turn_usage', usageRef: `claude:${messages.at(-1)![0]}`,
        ...(models.length ? { model: models.join(' + ') } : {}),
        breakdown: breakdown(messages.map(([, usage]) => usage)),
        ...(byModel.size > 1 ? { byModel: [...byModel].sort(([a], [b]) => a < b ? -1 : 1).map(([model, list]) => ({ ...(model ? { model } : {}), breakdown: breakdown(list) })) } : {}),
        ...(partial ? { partial: true } : {}),
      },
    };
  }
  takeTurnError(): NormalizedDriverEvent | undefined {
    if (this.requiresTurnTerminal && !this.turnTerminal) return undefined;
    const error = this.turnError;
    this.turnError = undefined; this.inputError = undefined;
    this.lastActivity = undefined;
    if (error) { this.inputUuid = undefined; this.inputEntries.clear(); }
    return error;
  }
  takeInputError(): NormalizedDriverEvent | undefined {
    return this.inputError ? this.takeTurnError() : undefined;
  }
}
