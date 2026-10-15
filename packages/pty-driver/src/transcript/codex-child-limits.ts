/** Read-only diagnostics for children explicitly started by the active Codex turn. */
import { constants, fstatSync, openSync, closeSync, readSync, opendirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { NormalizedDriverEvent } from '@dutydeck/shared';
import { nativeTaskError } from './native-turn.js';

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export const childDiagnosticLimits = { intervalMs: 2_000, children: 32, queries: 4, entries: 512, fileBytes: 64 * 1024, tickMs: 10, lookupMs: 120_000 } as const;
type Child = { id: string; activityId: string; startedAt: number; observedAt: number; path?: string;
  offset: number; ordinal: number; ownFrom?: number; inode?: string; turnId?: string; done?: boolean };

export class CodexChildLimits {
  private parent?: string;
  private turn?: string;
  private readonly children = new Map<string, Child>();
  private nextPoll = 0;
  private pollIndex = 0;
  /** Measured I/O bounds for the most recent poll. */
  lastPoll = { queries: 0, entries: 0, bytes: 0 };
  constructor(private readonly root: string) {}
  reset(): void { this.parent = undefined; this.newInput(); }
  newInput(): void { this.turn = undefined; this.children.clear(); this.nextPoll = 0; this.pollIndex = 0; }

  observe(entry: any, baseline: boolean | undefined, activeTurn: string | undefined): void {
    const p = entry?.payload;
    if (entry?.type === 'session_meta' && typeof p?.id === 'string' && uuid.test(p.id)) {
      if (this.parent && this.parent !== p.id) this.newInput();
      this.parent = p.id;
    }
    if (baseline || !activeTurn || !this.parent) return;
    if (this.turn !== activeTurn) { this.newInput(); this.turn = activeTurn; }
    const item = p?.item;
    if (entry.type !== 'event_msg' || p.type !== 'item_completed' || p.thread_id !== this.parent || p.turn_id !== activeTurn
      || item?.type !== 'SubAgentActivity' || item.kind !== 'started' || typeof item.id !== 'string' || !item.id || item.id.length > 256
      || typeof item.agent_thread_id !== 'string' || !uuid.test(item.agent_thread_id) || item.agent_thread_id === this.parent) return;
    const startedAt = Number.isSafeInteger(p.started_at_ms) ? p.started_at_ms : NaN;
    if (!Number.isFinite(startedAt) || this.children.has(item.agent_thread_id) || this.children.size >= childDiagnosticLimits.children) return;
    this.children.set(item.agent_thread_id, { id: item.agent_thread_id, activityId: item.id, startedAt, observedAt: Date.now(), offset: 0, ordinal: 0 });
  }

  poll(activeTurn: string | undefined): NormalizedDriverEvent[] {
    if (!activeTurn || activeTurn !== this.turn || !this.parent || !this.children.size || Date.now() < this.nextPoll) return [];
    this.nextPoll = Date.now() + childDiagnosticLimits.intervalMs;
    const budget = this.lastPoll = { queries: 0, entries: 0, bytes: 0 };
    const deadline = performance.now() + childDiagnosticLimits.tickMs;
    const events: NormalizedDriverEvent[] = [];
    const pending = [...this.children.values()].filter(child => !child.done);
    for (let index = 0; index < pending.length; index++) {
      const child = pending[(this.pollIndex + index) % pending.length]!;
      if (budget.queries >= childDiagnosticLimits.queries || performance.now() >= deadline) break;
      budget.queries++;
      if (!child.path) {
        if (Date.now() - child.observedAt > childDiagnosticLimits.lookupMs) { child.done = true; continue; }
        child.path = this.find(child, budget, deadline);
      }
      if (!child.path || performance.now() >= deadline) continue;
      const diagnostic = this.read(child, budget, deadline);
      if (diagnostic) events.push(diagnostic);
    }
    if (pending.length) this.pollIndex = (this.pollIndex + budget.queries) % pending.length;
    return events;
  }

  private find(child: Child, budget: { entries: number }, deadline: number): string | undefined {
    // Codex stores rollouts by creation date. Never recursively scan HOME.
    const dirs = new Set([0, -86_400_000, 86_400_000].map(delta => {
      const date = new Date(child.startedAt + delta);
      return join(this.root, String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0'));
    }));
    for (const dir of dirs) {
      if (budget.entries >= childDiagnosticLimits.entries || performance.now() >= deadline) return;
      let handle: ReturnType<typeof opendirSync>;
      try { handle = opendirSync(dir); } catch { continue; }
      try {
        for (;;) {
          if (budget.entries >= childDiagnosticLimits.entries || performance.now() >= deadline) return;
          const entry = handle.readSync(); if (!entry) break;
          budget.entries++;
          if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith(`-${child.id}.jsonl`)) return join(dir, entry.name);
        }
      } finally { handle.closeSync(); }
    }
  }

  private read(child: Child, budget: { bytes: number }, deadline: number): NormalizedDriverEvent | undefined {
    let fd: number | undefined;
    try {
      fd = openSync(child.path!, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = fstatSync(fd), inode = `${stat.dev}:${stat.ino}`;
      if (!stat.isFile() || child.inode && child.inode !== inode || stat.size < child.offset) { child.done = true; return; }
      child.inode = inode;
      const length = Math.min(childDiagnosticLimits.fileBytes, stat.size - child.offset);
      if (length <= 0) return;
      const data = Buffer.alloc(length), read = readSync(fd, data, 0, length, child.offset);
      budget.bytes += read;
      const boundary = data.lastIndexOf(0x0a, read - 1);
      if (boundary < 0) { if (read === childDiagnosticLimits.fileBytes) child.done = true; return; }
      const lines = data.subarray(0, boundary + 1).toString('utf8').split('\n').slice(0, -1);
      for (const line of lines) {
        if (performance.now() >= deadline) return;
        child.offset += Buffer.byteLength(line, 'utf8') + 1;
        if (!line.trim()) continue;
        const ordinal = child.ordinal++;
        let entry: any;
        try { entry = JSON.parse(line); } catch { if (ordinal === 0) child.done = true; continue; }
        const p = entry?.payload;
        if (ordinal === 0) {
          const spawn = p?.source?.subagent?.thread_spawn;
          if (entry.type !== 'session_meta' || p?.id !== child.id || p.parent_thread_id !== this.parent
            || spawn?.parent_thread_id !== undefined && spawn.parent_thread_id !== this.parent
            || p.forked_from_id !== undefined && p.forked_from_id !== this.parent) { child.done = true; return; }
          if (p.forked_from_id && (!Number.isSafeInteger(p.subagent_history_start_ordinal) || p.subagent_history_start_ordinal < 0)) { child.done = true; return; }
          child.ownFrom = p.forked_from_id ? Math.max(1, p.subagent_history_start_ordinal) : 1;
          continue;
        }
        if (child.done || ordinal < (child.ownFrom ?? Infinity) || entry.type !== 'event_msg' || !p
          || p.thread_id !== undefined && p.thread_id !== child.id) continue;
        const turnId = typeof p.turn_id === 'string' && p.turn_id.length <= 256 ? p.turn_id : undefined;
        if (['task_started', 'turn_started'].includes(p.type) && turnId
          && typeof entry.timestamp === 'string' && Date.parse(entry.timestamp) >= child.startedAt) child.turnId = turnId;
        if (p.type !== 'task_complete' || !child.turnId || turnId !== child.turnId) continue;
        child.done = true;
        const failure = nativeTaskError(p.error), code = failure?.data.code;
        if (code !== 'usage_limit_exceeded' && code !== 'rate_limit') return;
        const sourceId = createHash('sha256').update(JSON.stringify(['codex-child-limit', this.parent, this.turn, child.id, turnId])).digest('hex');
        const state = code === 'usage_limit_exceeded' ? 'child_quota' : 'child_rate_limit';
        // Observation only: tool_result would replace the parent's final activity.
        return { type: 'status', sourceId, data: {
          id: `child_diagnostic_${sourceId}`, activityId: child.activityId, name: '子任务额度诊断', status: 'failed', code,
          state, diagnostic: state,
          parentThreadId: this.parent, parentTurnId: this.turn, childThreadId: child.id, childTurnId: turnId,
          output: code === 'usage_limit_exceeded' ? '子任务用量额度耗尽，父任务继续执行。' : '子任务触发请求限流，父任务继续执行。'
        } };
      }
    } catch { /* Missing/unreadable child files never fail the parent. */ }
    finally { if (fd !== undefined) closeSync(fd); }
  }
}
