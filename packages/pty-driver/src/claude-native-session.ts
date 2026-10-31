// Claude PID-state contract: botmux f54efb8b889 / 17296ac7fba (MIT); see THIRD_PARTY_NOTICES.md.
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { descendantPids, type PhysicalProcessIdentity, type ProcessProbe } from '@dutydeck/session-backends';
import type { DriverTranscriptSourceObservation } from '@dutydeck/shared';
import { claudeDataDir, claudeProjectDir, type CliPathEnv } from './cli-paths.js';
import { parseJsonlObjects, readHead, readTail } from './session-id/fs-scan.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export const CLAUDE_PROCESS_PROOF = 'pty-claude-process-v1:';
export interface ClaudeNativeSession {
  nativeSessionId: string; path: string; dataRoot: string; cwd: string; resumable: boolean; identityProof: string;
}
function regular(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    const stat = lstatSync(path);
    return stat.isFile() && stat.uid === process.getuid?.() && realpathSync(path) === path ? stat : undefined;
  } catch { return undefined; }
}
function fileProof(id: string, path: string, root: string, cwd: string): string | undefined {
  const stat = regular(path);
  return stat ? CLAUDE_PROCESS_PROOF + createHash('sha256').update(JSON.stringify([id, path, root, cwd, stat.dev, stat.ino])).digest('hex') : undefined;
}
/** Content, not a filename or metadata-only placeholder, makes a cold resume usable. */
export function claudeHasConversation(path: string, id: string, cwd: string): boolean {
  if (!regular(path)) return false;
  try {
    for (const entry of parseJsonlObjects(readHead(path, 256 * 1024) + '\n' + readTail(path, 256 * 1024))) {
      if (entry.isSidechain || entry.sessionId !== id || !['user', 'assistant'].includes(entry.type)) continue;
      if (entry.cwd && realpathSync(entry.cwd) !== cwd) continue;
      const content = entry.message?.content;
      if (typeof content === 'string' ? content.trim().length > 0 : Array.isArray(content) && content.length > 0) return true;
    }
  } catch { /* Unreadable content is not a resume target. */ }
  return false;
}
/** Revalidate a durable, runtime-fenced observation before a cold launch. */
export function claudeResumeFromObservation(source: DriverTranscriptSourceObservation, cwd: string, env: CliPathEnv): string | undefined {
  try {
    const id = source.nativeSessionId;
    if (source.client !== 'claude' || source.proofKind !== 'launch_observed' || !id || !UUID.test(id)) return;
    const root = realpathSync(claudeDataDir(env)), realCwd = realpathSync(cwd);
    const path = join(claudeProjectDir(realCwd, { CLAUDE_CONFIG_DIR: root }), `${id}.jsonl`);
    if (source.dataRoot !== root || source.cwd !== realCwd || source.verifiedPath !== path
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
  private readonly cwd: string;
  private readonly dataRoot: string;
  constructor(identity: PhysicalProcessIdentity, cwd: string, env: CliPathEnv, private readonly probe: ProcessProbe) {
    this.root = identity;
    this.cwd = realpathSync(cwd);
    this.dataRoot = realpathSync(claudeDataDir(env));
  }
  resolve(forceDiscovery = false): ClaudeNativeSession | undefined {
    if (process.platform !== 'linux' || this.probe.observe(this.root) !== 'alive') return;
    try {
      if (!this.cli && !forceDiscovery && Date.now() < this.nextDiscoveryAt) return;
      if (!this.cli) this.nextDiscoveryAt = Date.now() + 5_000;
      const pids = this.cli ? [this.cli.pid] : descendantPids([this.root.pid]);
      const matches: Array<{ identity: PhysicalProcessIdentity; state: any }> = [];
      for (const pid of pids) {
        try {
          const identity = this.cli ?? this.probe.identify(pid);
          if (this.probe.observe(identity) !== 'alive') continue;
          // A cached PID must still descend from the backend, not merely live.
          let ancestor = pid;
          for (let depth = 0; ancestor !== this.root.pid && depth < 64; depth++) {
            const raw = readFileSync(`/proc/${ancestor}/stat`, 'utf8');
            ancestor = Number(raw.slice(raw.lastIndexOf(')') + 2).split(' ')[1]);
            if (ancestor <= 1) break;
          }
          if (ancestor !== this.root.pid || realpathSync(`/proc/${pid}/cwd`) !== this.cwd) continue;
          const childEnv: CliPathEnv = {};
          for (const pair of readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')) {
            const split = pair.indexOf('=');
            if (split > 0 && ['HOME', 'CLAUDE_CONFIG_DIR'].includes(pair.slice(0, split))) childEnv[pair.slice(0, split)] = pair.slice(split + 1);
          }
          if (realpathSync(claudeDataDir(childEnv)) !== this.dataRoot) continue;
          const statePath = join(this.dataRoot, 'sessions', `${pid}.json`);
          const stat = regular(statePath);
          if (!stat || stat.size > 16 * 1024) continue;
          const state = JSON.parse(readFileSync(statePath, 'utf8'));
          if (state.pid !== pid || state.procStart !== identity.start || !UUID.test(state.sessionId ?? '')
            || realpathSync(state.cwd) !== this.cwd || this.probe.observe(identity) !== 'alive') continue;
          matches.push({ identity, state });
        } catch { /* Partial native rewrites retry on the next poll. */ }
      }
      if (matches.length !== 1) return;
      const { identity, state } = matches[0]!;
      this.cli = identity;
      const path = join(claudeProjectDir(this.cwd, { CLAUDE_CONFIG_DIR: this.dataRoot }), `${state.sessionId}.jsonl`);
      const proof = fileProof(state.sessionId, path, this.dataRoot, this.cwd);
      const stat = regular(path);
      const key = JSON.stringify([path, stat?.dev, stat?.ino, stat?.size, stat?.mtimeMs]);
      if (key !== this.conversation?.key) this.conversation = { key, value: !!proof && claudeHasConversation(path, state.sessionId, this.cwd) };
      return { nativeSessionId: state.sessionId, path, dataRoot: this.dataRoot, cwd: this.cwd,
        resumable: this.conversation!.value,
        identityProof: proof ?? CLAUDE_PROCESS_PROOF + 'pending' };
    } catch { return undefined; }
  }
}
