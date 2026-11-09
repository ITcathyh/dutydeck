// Claude PID-state contract: botmux f54efb8b889 / 17296ac7fba (MIT); see THIRD_PARTY_NOTICES.md.
import { createHash } from 'node:crypto';
import { closeSync, fstatSync, lstatSync, openSync, readdirSync, readFileSync, readSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { PhysicalProcessIdentity, ProcessProbe } from '@dutydeck/session-backends';
import type { DriverTranscriptSourceObservation } from '@dutydeck/shared';
import { claudeDataDir, claudeProjectDirCandidates, type CliPathEnv } from './cli-paths.js';
import { parseJsonlObjects, readHeadBytes, readTail } from './session-id/fs-scan.js';
import { parseProcStat } from '@dutydeck/shared';

// realpath(3): same canonical path and ENOENT as the JS walk, without its per-component lstat.
const realpath = realpathSync.native;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export const CLAUDE_PROCESS_PROOF = 'pty-claude-process-v1:';
export interface ClaudeNativeSession {
  nativeSessionId: string; path: string; dataRoot: string; cwd: string; resumable: boolean; identityProof: string;
}
function regular(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    const stat = lstatSync(path);
    return stat.isFile() && stat.uid === process.getuid?.() && realpath(path) === path ? stat : undefined;
  } catch { return undefined; }
}
function fileProof(id: string, path: string, root: string, cwd: string): string | undefined {
  const stat = regular(path);
  return stat ? CLAUDE_PROCESS_PROOF + createHash('sha256').update(JSON.stringify([id, path, root, cwd, stat.dev, stat.ino])).digest('hex') : undefined;
}
const CONVERSATION_WINDOW = 256 * 1024;
/** A true result whose first matching entry is a complete line inside the head
 *  window: while bytes [0, end) are unchanged, every entry the scan visits
 *  before it is unchanged too, so only the cwd realpaths can alter the result. */
interface ConversationAnchor { path: string; id: string; dev: number; ino: number; end: number; prefix: Buffer; cwds: string[]; cwd?: string }
/** parse(head + '\n' + tail) in order. Splitting the head at newline bytes
 *  decodes exactly like splitting its UTF-8 string: 0x0a never occurs inside a
 *  multi-byte sequence. Yields the byte end of complete head lines. */
function* conversationEntries(head: Buffer, tail: string): Generator<{ entry: any; end?: number }> {
  let start = 0;
  for (;;) {
    const newline = head.indexOf(0x0a, start);
    const complete = newline >= 0;
    for (const entry of parseJsonlObjects(head.toString('utf8', start, complete ? newline : head.length))) yield { entry, end: complete ? newline + 1 : undefined };
    if (!complete) break;
    start = newline + 1;
  }
  for (const entry of parseJsonlObjects(tail)) yield { entry };
}
function scanConversation(path: string, id: string, cwd: string): { value: boolean; anchor?: ConversationAnchor } {
  if (!regular(path)) return { value: false };
  try {
    const head = readHeadBytes(path, CONVERSATION_WINDOW);
    const cwds: string[] = [];
    for (const { entry, end } of conversationEntries(head?.bytes ?? Buffer.alloc(0), readTail(path, CONVERSATION_WINDOW))) {
      if (entry.isSidechain || entry.sessionId !== id || !['user', 'assistant'].includes(entry.type)) continue;
      if (entry.cwd && realpath(entry.cwd) !== cwd) { if (!cwds.includes(entry.cwd)) cwds.push(entry.cwd); continue; }
      const content = entry.message?.content;
      if (typeof content === 'string' ? content.trim().length > 0 : Array.isArray(content) && content.length > 0) {
        return { value: true, anchor: head && end !== undefined
          ? { path, id, dev: head.dev, ino: head.ino, end, prefix: Buffer.from(head.bytes.subarray(0, end)), cwds, cwd: entry.cwd || undefined }
          : undefined };
      }
      if (entry.cwd && !cwds.includes(entry.cwd)) cwds.push(entry.cwd);
    }
  } catch { /* Unreadable content is not a resume target. */ }
  return { value: false };
}
/** True only when the anchor still proves the full scan would return true. */
function anchoredConversation(anchor: ConversationAnchor, path: string, id: string, cwd: string): boolean {
  if (anchor.path !== path || anchor.id !== id) return false;
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const stat = fstatSync(fd);
    if (stat.dev !== anchor.dev || stat.ino !== anchor.ino || stat.size < anchor.end) return false;
    const bytes = Buffer.alloc(anchor.end);
    if (readSync(fd, bytes, 0, anchor.end, 0) !== anchor.end || !bytes.equals(anchor.prefix)) return false;
    // Earlier entries keep their realpath call: one that now throws ends the scan.
    for (const earlier of anchor.cwds) realpath(earlier);
    return !anchor.cwd || realpath(anchor.cwd) === cwd;
  } catch { return false; } finally { if (fd !== undefined) try { closeSync(fd); } catch { /* best effort */ } }
}
/** Content, not a filename or metadata-only placeholder, makes a cold resume usable. */
export function claudeHasConversation(path: string, id: string, cwd: string): boolean {
  return scanConversation(path, id, cwd).value;
}
/** The session file under each candidate project dir, current key first. */
function sessionFileCandidates(id: string, root: string, cwd: string): string[] {
  return claudeProjectDirCandidates(cwd, { CLAUDE_CONFIG_DIR: root }).map(dir => join(dir, `${id}.jsonl`));
}
/** Revalidate a durable, runtime-fenced observation before a cold launch.
 *  `verifiedPath` may name either candidate dir, so an observation recorded
 *  under the legacy untruncated key keeps resuming. */
export function claudeResumeFromObservation(source: DriverTranscriptSourceObservation, cwd: string, env: CliPathEnv): string | undefined {
  try {
    const id = source.nativeSessionId;
    if (source.client !== 'claude' || source.proofKind !== 'launch_observed' || !id || !UUID.test(id)) return;
    const root = realpath(claudeDataDir(env)), realCwd = realpath(cwd);
    const path = sessionFileCandidates(id, root, realCwd).find(candidate => candidate === source.verifiedPath);
    if (!path || source.dataRoot !== root || source.cwd !== realCwd
      || source.identityProof !== fileProof(id, path, root, realCwd)) return;
    return claudeHasConversation(path, id, realCwd) ? id : undefined;
  } catch { return undefined; }
}

/** Linux native PID state must carry procStart. Older/unverifiable dialects
 * retain marker-based collection; they never authorize a guessed rotation. */
export class ClaudeNativeSessionResolver {
  private readonly root: PhysicalProcessIdentity;
  private cli?: PhysicalProcessIdentity;
  private nextDiscoveryAt = 0;
  private conversation?: { key: string; value: boolean };
  private conversationAnchor?: ConversationAnchor;
  private readonly cwd: string;
  private readonly dataRoot: string;
  constructor(identity: PhysicalProcessIdentity, cwd: string, env: CliPathEnv, private readonly probe: ProcessProbe, private readonly discoveryRetryMs = 5_000) {
    this.root = identity;
    this.cwd = realpath(cwd);
    this.dataRoot = realpath(claudeDataDir(env));
  }
  resolve(forceDiscovery = false): ClaudeNativeSession | undefined {
    if (process.platform !== 'linux' || this.probe.observe(this.root) !== 'alive') return;
    try {
      if (!this.cli && !forceDiscovery && Date.now() < this.nextDiscoveryAt) return;
      if (!this.cli) this.nextDiscoveryAt = Date.now() + this.discoveryRetryMs;
      const pids = this.cli ? [this.cli.pid] : this.statePids();
      const matches: Array<{ identity: PhysicalProcessIdentity; state: any }> = [];
      for (const pid of pids) {
        try {
          const identity = this.cli ?? this.probe.identify(pid);
          if (this.probe.observe(identity) !== 'alive') continue;
          // A cached PID must still descend from the backend, not merely live.
          let ancestor = pid;
          for (let depth = 0; ancestor !== this.root.pid && depth < 64; depth++) {
            ancestor = parseProcStat(readFileSync(`/proc/${ancestor}/stat`, 'utf8')).ppid;
            if (ancestor <= 1) break;
          }
          if (ancestor !== this.root.pid || realpath(`/proc/${pid}/cwd`) !== this.cwd) continue;
          const childEnv: CliPathEnv = {};
          for (const pair of readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')) {
            const split = pair.indexOf('=');
            if (split > 0 && ['HOME', 'CLAUDE_CONFIG_DIR'].includes(pair.slice(0, split))) childEnv[pair.slice(0, split)] = pair.slice(split + 1);
          }
          if (realpath(claudeDataDir(childEnv)) !== this.dataRoot) continue;
          const statePath = join(this.dataRoot, 'sessions', `${pid}.json`);
          const stat = regular(statePath);
          if (!stat || stat.size > 16 * 1024) continue;
          const state = JSON.parse(readFileSync(statePath, 'utf8'));
          if (state.pid !== pid || state.procStart !== identity.start || !UUID.test(state.sessionId ?? '')
            || realpath(state.cwd) !== this.cwd || this.probe.observe(identity) !== 'alive') continue;
          matches.push({ identity, state });
        } catch { /* Partial native rewrites retry on the next poll. */ }
      }
      if (matches.length !== 1) return;
      const { identity, state } = matches[0]!;
      this.cli = identity;
      // A resumed legacy session keeps its file under the untruncated key; a
      // new one appears under the current key. Copies in both cannot be told
      // apart without a durable verifiedPath, so neither is selected.
      const candidates = sessionFileCandidates(state.sessionId, this.dataRoot, this.cwd);
      const present = candidates.filter(candidate => regular(candidate));
      if (present.length > 1) return;
      const path = present[0] ?? candidates[0]!;
      const proof = fileProof(state.sessionId, path, this.dataRoot, this.cwd);
      const stat = regular(path);
      const key = JSON.stringify([path, stat?.dev, stat?.ino, stat?.size, stat?.mtimeMs]);
      if (key !== this.conversation?.key) this.conversation = { key, value: !!proof && this.hasConversation(path, state.sessionId) };
      return { nativeSessionId: state.sessionId, path, dataRoot: this.dataRoot, cwd: this.cwd,
        resumable: this.conversation!.value,
        identityProof: proof ?? CLAUDE_PROCESS_PROOF + 'pending' };
    } catch { return undefined; }
  }
  /** Only a PID with a native state file can match; the ancestor walk proves descent. */
  private statePids(): number[] {
    try {
      return readdirSync(join(this.dataRoot, 'sessions'))
        .filter(name => /^\d+\.json$/.test(name)).map(name => Number(name.slice(0, -5))).filter(pid => Number.isSafeInteger(pid) && pid > 0);
    } catch { return []; }
  }
  /** claudeHasConversation, skipping the 512KB rescan while a head anchor holds. */
  private hasConversation(path: string, id: string): boolean {
    if (!regular(path)) return false;
    if (this.conversationAnchor && anchoredConversation(this.conversationAnchor, path, id, this.cwd)) return true;
    const scan = scanConversation(path, id, this.cwd);
    this.conversationAnchor = scan.anchor;
    return scan.value;
  }
}
