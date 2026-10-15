/** TraeX legacy/canonical rollout source, including verified resumed segments. */
import type { NormalizedDriverEvent } from '@dutydeck/shared';
import { traeHistoryPath, traeSessionsRoot, type CliPathEnv } from '../cli-paths.js';
import { resolveCliSessionId } from '../session-id/index.js';
import { JsonlTailer, type TranscriptCursor, type TranscriptEventSource } from './tail.js';
import { resolveNewestRollout } from './codex.js';
import { CodexInputReceipt } from './codex-input-receipt.js';
import { CodexToolProjection } from './codex-tools.js';
import { NativeTurn } from './native-turn.js';
import { traexInputText } from './input-receipt.js';
import { nextTraexSegment, traexSegments } from './traex-segments.js';
import { mapTraexRecord, traexEntries, TraexMessageProjection } from './traex-records.js';

export function resolveTraexRolloutPath(cwd?: string, env?: CliPathEnv, sessionId?: string): string | undefined {
  const root = traeSessionsRoot(env);
  if (sessionId && cwd) {
    const id = resolveCliSessionId('traex', { sessionId, cwd, env });
    return id ? nextTraexSegment(root, id) : undefined;
  }
  return resolveNewestRollout(root);
}

export function mapTraexEntry(entry: any): NormalizedDriverEvent[] | undefined {
  // Keep the stateless legacy mapper's public contract; commentary belongs to
  // the stateful source, where phase/mirror identity can be verified.
  if (entry?.type === 'event_msg' && entry.payload?.type === 'agent_message'
    && entry.payload.phase && !['final', 'final_answer'].includes(entry.payload.phase)) return undefined;
  const events = traexEntries(entry).flatMap(record => mapTraexRecord(record) ?? []);
  return events.length ? events : undefined;
}

export interface TraexTranscriptTailerOptions {
  cwd: string;
  transcriptPath?: string;
  sessionId?: string;
  pollIntervalMs?: number;
  env?: CliPathEnv;
}

export class TraexTranscriptTailer implements TranscriptEventSource {
  readonly requiresTurnTerminal = true;
  private readonly tailer: JsonlTailer;
  private readonly inputReceipt?: CodexInputReceipt;
  private readonly turn = new NativeTurn();

  constructor(opts: TraexTranscriptTailerOptions) {
    let threadId: string | undefined;
    const nativeId = () => threadId ??= opts.sessionId ? resolveCliSessionId('traex', { sessionId: opts.sessionId, cwd: opts.cwd, env: opts.env }) : undefined;
    if (opts.sessionId) this.inputReceipt = new CodexInputReceipt(traeHistoryPath(opts.env), nativeId, text => this.turn.bindHistory(text));
    const messages = new TraexMessageProjection();
    const projection = new CodexToolProjection(entry => messages.map(entry));
    const root = traeSessionsRoot(opts.env);
    const explicit = opts.transcriptPath;
    this.tailer = new JsonlTailer({
      resolvePath: current => explicit ?? (opts.sessionId
        ? nativeId() ? nextTraexSegment(root, nativeId()!, current) : undefined
        : resolveTraexRolloutPath(opts.cwd, opts.env)),
      followSegments: !explicit && !!opts.sessionId,
      validateRestorePath: path => !explicit && !!nativeId() && traexSegments(root, nativeId()!).includes(path),
      mapEntry: (entry, baseline) => {
        if (entry?.type === 'session_meta') threadId ??= entry.payload?.id ?? entry.payload?.session_id;
        // Session-bound sources never accept canonical records until their
        // native thread is known. The metadata is read during baselining too.
        if (entry?.type === 'history_mutation' && !nativeId()) return undefined;
        const result: NormalizedDriverEvent[] = [];
        for (const record of traexEntries(entry, nativeId())) {
          const bound = this.turn.observe(record, baseline);
          if (!baseline && this.turn.requiresBinding() && !bound) continue;
          result.push(...(projection.map(record)?.filter(event => event.type !== 'error') ?? []));
        }
        return result.length ? result : undefined;
      },
      resetMapping: () => { projection.reset(); messages.reset(); this.turn.reset(); },
      inputText: entry => entry?.type === 'history_mutation' && !nativeId() ? undefined : traexInputText(entry, nativeId()),
      onInputReceipt: entry => {
        const input = traexEntries(entry, nativeId()).find(record => traexInputText(record) !== undefined);
        if (input) this.turn.bind(input);
      },
      deduplicateTools: true,
      pollIntervalMs: opts.pollIntervalMs,
      watchForSwitch: !explicit,
    });
  }

  start(): void { this.inputReceipt?.start(); this.tailer.start(); }
  async flush(): Promise<void> { await Promise.all([this.tailer.flush(), this.inputReceipt?.flush()]); }
  checkpoint(): TranscriptCursor { return this.tailer.checkpoint(); }
  restore(cursor: TranscriptCursor): void { this.tailer.restore(cursor); this.turn.restore(); }
  stop(): void { this.inputReceipt?.stop(); this.tailer.stop(); }
  onEvent(cb: (e: NormalizedDriverEvent) => void): void { this.tailer.onEvent(cb); }
  onProgress(cb: () => void): void { this.tailer.onProgress(cb); }
  hasTurnTerminal(): boolean { return this.turn.hasTerminal(); }
  takeTurnError(): NormalizedDriverEvent | undefined { return this.turn.takeError(); }
  takeInputError(): NormalizedDriverEvent | undefined { return this.turn.takeError(); }
  takeInputCancellation(): boolean { return this.turn.takeCancellation(); }
  waitForInput(prompt: string, signal: AbortSignal): Promise<void> {
    this.turn.arm(signal);
    return this.inputReceipt ? this.inputReceipt.waitForInput(this.tailer, prompt, signal) : this.tailer.waitForInput(prompt, signal);
  }
}
