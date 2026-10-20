import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { TextDecoder } from 'node:util';
import {
  analyzeFilesRequestSchema,
  SESSION_INSIGHT_LIMITS,
  type AnalyzeFileInput,
  type AnalyzeFilesRequest,
  type AnalyzeFilesResult,
  type EngineVersionInfo,
  type FileAnalysisResult,
  type FileMetrics,
  type TraceEvent,
  type WarningEntry
} from '@dutydeck/shared';
import { metric, object, safeToken, TokenAnalysis, PulseAnalysis, type JsonObject } from './session-insight-analyzer-tokens.js';

export const SESSION_INSIGHT_ENGINE_VERSIONS: EngineVersionInfo = { schemaVersion: 1, engineVersion: 'dutydeck-ts-v1', parserVersion: 'ts-v2', metricVersion: 'v2' };
const metricNames = ['inputUncached', 'cacheRead', 'cacheWrite', 'output', 'reasoningOutput', 'totalTracked', 'rawInput', 'rawOutput', 'rawTotal', 'peakContext', 'contextWindow', 'elapsedDurationMs', 'activeDurationMs', 'idleDurationMs', 'pairedToolDurationMs', 'userTurns', 'assistantTurns', 'toolCalls', 'toolFailures', 'toolSuccesses', 'toolUnknowns', 'toolFailureRate', 'compactionCount', 'subagentCount'] as const;
const string = (value: unknown): string => typeof value === 'string' ? value : '';
const turnId = (payload: JsonObject): string => string(payload.turn_id) || string(object(payload.internal_chat_message_metadata_passthrough).turn_id);
const nativeTimestamp = (value: unknown, fallback: string | null): string | null => safeToken(value) && value > 0 && value <= 8.64e15 ? new Date(value).toISOString() : fallback;
const timestamp = (value: unknown): string | null => typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const text = (value: unknown): string => typeof value === 'string' ? value : Array.isArray(value) ? value.map(item => string(object(item).text)).filter(Boolean).join('\n') : value === undefined ? '' : JSON.stringify(value);
const excerpt = (value: unknown): string | null => {
  const source = text(value).trim();
  if (!source) return null;
  const bytes = Buffer.from(source);
  let end = Math.min(bytes.length, SESSION_INSIGHT_LIMITS.maxExcerptLengthBytes);
  while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8');
};

class Warnings {
  readonly entries = new Map<string, WarningEntry>();
  add(code: string): void { const previous = this.entries.get(code); if (previous) previous.count++; else this.entries.set(code, { code, count: 1, samples: [] }); }
  finish(): WarningEntry[] { return [...this.entries.values()].sort((a, b) => a.code.localeCompare(b.code)); }
}
interface Retained { event: TraceEvent; sequence: number; score: number }
class TraceRetention {
  private sequence = 0;
  private readonly prefix: Retained[] = [];
  private readonly failures: Retained[] = [];
  private readonly slow: Retained[] = [];
  private readonly pulses: Retained[] = [];
  readonly totals = new Map<string, Map<string, number>>();
  constructor(readonly limit: number) {}
  private keep(pool: Retained[], event: Retained, capacity: number): void {
    if (!capacity) return;
    if (pool.length < capacity) pool.push(event);
    else if (event.score > pool[pool.length - 1]!.score) pool[pool.length - 1] = event;
    else return;
    pool.sort((a, b) => b.score - a.score || a.sequence - b.sequence);
  }
  add(event: TraceEvent): void {
    const counts = this.totals.get(event.sourceKey) ?? new Map<string, number>();
    counts.set(event.kind, (counts.get(event.kind) ?? 0) + 1); this.totals.set(event.sourceKey, counts);
    const candidate = { event, sequence: this.sequence++, score: 0 };
    const failureCap = Math.floor(this.limit * .05), slowCap = Math.floor(this.limit * .025), pulseCap = Math.floor(this.limit * .025);
    if (this.prefix.length < this.limit - failureCap - slowCap - pulseCap) this.prefix.push(candidate);
    if (event.resultStatus === 'failure' && this.failures.length < failureCap) this.failures.push(candidate);
    if ((event.durationMs?.value ?? 0) > 0) this.keep(this.slow, { ...candidate, score: event.durationMs!.value! }, slowCap);
    if ((event.rawUsage?.observedDelta ?? 0) > 0) this.keep(this.pulses, { ...candidate, score: event.rawUsage!.observedDelta! }, pulseCap);
  }
  discard(key: string): void {
    for (const pool of [this.prefix, this.failures, this.slow, this.pulses]) {
      for (let index = pool.length - 1; index >= 0; index--) if (pool[index]!.event.sourceKey === key) pool.splice(index, 1);
    }
    this.totals.delete(key);
  }
  finish(files: FileAnalysisResult[]): void {
    const union = new Map<number, TraceEvent>();
    for (const pool of [this.prefix, this.failures, this.slow, this.pulses]) for (const value of pool) union.set(value.sequence, value.event);
    const ordered = [...union].sort(([a], [b]) => a - b).map(([, event]) => event);
    for (const file of files) {
      if (file.status === 'error') continue;
      file.trace = ordered.filter(event => event.sourceKey === file.sourceKey).sort((a, b) => a.lineNumber - b.lineNumber || a.byteOffset - b.byteOffset || a.subeventIndex - b.subeventIndex);
      const omitted = Object.fromEntries(this.totals.get(file.sourceKey) ?? []);
      for (const event of file.trace) omitted[event.kind]!--;
      file.coverage.retainedTraceCount = file.trace.length;
      file.coverage.omittedTraceByCategory = Object.fromEntries(Object.entries(omitted).filter(([, count]) => count > 0));
      file.coverage.omittedTraceCount = Object.values(file.coverage.omittedTraceByCategory).reduce((a, b) => a + b, 0);
    }
  }
}
function emptyResult(input: AnalyzeFileInput, errorCode: string): FileAnalysisResult {
  return { sourceKey: input.sourceKey, client: input.client, sha256: input.sha256, nativeSessionId: null, streamIdentity: input.expectedStream, nativeRunId: null, parentNativeSessionId: null, status: 'error', errorCode, metrics: Object.fromEntries(metricNames.map(name => [name, metric(null, errorCode)])) as FileMetrics, models: [], trace: [], pulseBuckets: [], coverage: { rawLines: 0, parsedLines: 0, ignoredLines: 0, errorLines: 1, timeRange: { start: null, end: null }, missingTimestampCount: 0, disorderedTimestampCount: 0, retainedTraceCount: 0, omittedTraceCount: 0, omittedTraceByCategory: {}, tokenSamplesAvailable: 0, tokenSamplesMissing: 0, subagentDiscovery: 'none', inheritedHistory: 'none' }, relationship: { kind: 'none', parentNativeSessionId: null, parentNativeAgentId: null, evidenceRefs: [] }, aggregation: { eligibility: 'excluded', reasonCodes: [errorCode] } };
}
interface Position { line: number; offset: number; at: string | null; nativeId: string; sub: number }
interface Tool { id: string; native: boolean; name: string; start: string | null; end: string | null; callEvent?: string; resultEvent?: string; position: Position; input: string | null; output: string | null; status: 'success' | 'failure' | 'unknown'; single: boolean }
function outcome(data: JsonObject, defaultSuccess = false): Tool['status'] {
  if (data.is_error === true || data.isError === true || data.success === false) return 'failure';
  if (safeToken(data.exit_code)) return data.exit_code === 0 ? 'success' : 'failure';
  if (typeof data.exit_code === 'number' && Number.isSafeInteger(data.exit_code) && data.exit_code < 0) return 'failure';
  const state = string(data.status).toLowerCase();
  if (['failed', 'failure', 'error'].includes(state)) return 'failure';
  if (['interrupted', 'cancelled', 'canceled', 'aborted'].includes(state)) return 'unknown';
  if (data.is_error === false || data.success === true || ['success', 'completed', 'complete', 'succeeded', 'ok'].includes(state)) return 'success';
  return defaultSuccess ? 'success' : 'unknown';
}

class FileAnalysis {
  readonly result: FileAnalysisResult;
  readonly tokens: TokenAnalysis;
  readonly tools = new Map<string, Tool>();
  readonly models = new Set<string>();
  readonly users = new Set<string>();
  readonly assistants = new Set<string>();
  readonly seenUserRecords = new Set<string>();
  readonly seenBlocks = new Set<string>();
  userAnonymous = 0;
  assistantAnonymous = 0;
  compactions = 0;
  subagents = 0;
  hasIdentity = false;
  error: string | null = null;
  previousTime: number | null = null;
  idle = 0;
  canonical = false;
  currentTurnId = '';
  position: Position = { line: 1, offset: 0, at: null, nativeId: '', sub: 0 };
  constructor(readonly input: AnalyzeFileInput, readonly retention: TraceRetention, readonly warnings: Warnings, readonly canonicalUserTurns: Set<string>) {
    this.result = emptyResult(input, 'missing_native_session_id');
    this.result.status = 'ok'; this.result.errorCode = null; this.result.aggregation = { eligibility: 'eligible', reasonCodes: [] };
    this.result.coverage.errorLines = 0;
    this.tokens = new TokenAnalysis(input.client);
  }
  private event(kind: TraceEvent['kind'], fields: Partial<TraceEvent> = {}, position = this.position): TraceEvent {
    const eventId = `${this.input.sourceKey}:${`${position.nativeId || this.input.sha256.slice(0, 12)}:L${position.line}:B${position.offset}`}:${kind}:${position.sub}`;
    return { eventId, sourceKey: this.input.sourceKey, nativeSessionId: this.input.expectedNativeSessionId, lineNumber: position.line, byteOffset: position.offset, subeventIndex: position.sub, nativeEventId: position.nativeId || null, timestamp: position.at, timeQuality: position.at ? 'observed' : 'unknown', kind, evidenceRefs: [], isSnapshotLocalId: !position.nativeId, ...fields };
  }
  private emit(kind: TraceEvent['kind'], fields: Partial<TraceEvent> = {}, position = this.position): TraceEvent {
    const event = this.event(kind, fields, { ...position, sub: position.sub++ }); this.retention.add(event); return event;
  }
  private identity(id: unknown): void {
    if (typeof id !== 'string' || !id.trim()) return;
    if (id !== this.input.expectedNativeSessionId) this.error = 'native_id_mismatch';
    else { this.hasIdentity = true; this.result.nativeSessionId = id; }
  }
  private time(at: string | null): void {
    const coverage = this.result.coverage;
    if (!at) { coverage.missingTimestampCount++; return; }
    const ms = Date.parse(at);
    if (!coverage.timeRange.start || ms < Date.parse(coverage.timeRange.start)) coverage.timeRange.start = at;
    if (!coverage.timeRange.end || ms > Date.parse(coverage.timeRange.end)) coverage.timeRange.end = at;
    if (this.previousTime !== null && ms < this.previousTime) coverage.disorderedTimestampCount++;
    else { if (this.previousTime !== null && ms - this.previousTime > 300_000) this.idle += ms - this.previousTime; this.previousTime = ms; }
  }
  private model(value: unknown): void { if (typeof value === 'string' && value.trim()) this.models.add(value); }
  private turn(role: 'user' | 'assistant', id: string, content: unknown): void {
    if (role === 'user') { if (id) this.users.add(id); else if (this.input.client !== 'claude') this.users.add(`line:${this.position.line}:${this.position.sub}`); else this.userAnonymous++; this.emit('user_message', { inputExcerpt: excerpt(content) }); }
    else { if (id) this.assistants.add(id); this.emit('agent_message', { outputExcerpt: excerpt(content) }); }
  }
  private call(id: string, name: string, input: unknown, at = this.position.at, single = false): void {
    const actualId = id || `anon-${this.position.line}-${this.position.sub}`;
    const existing = this.tools.get(actualId);
    const event = this.emit('tool_call', { callId: actualId, toolName: name, inputExcerpt: excerpt(input), resultStatus: 'unknown', durationMs: metric(null, 'UNPAIRED_TOOL_CALL') }, { ...this.position, at, sub: this.position.sub++ });
    if (!existing) {
      this.tools.set(actualId, { id: actualId, native: !!id, name, start: at, end: null, position: { ...this.position, at }, input: excerpt(input), output: null, status: 'unknown', callEvent: event.eventId, single });
      if (name.toLowerCase() === 'agent' || name.toLowerCase().includes('subagent')) { this.subagents++; this.result.coverage.subagentDiscovery = 'partial'; }
    } else { existing.name ||= name; existing.start ??= at; existing.callEvent ??= event.eventId; }
  }
  private resolve(id: string, data: JsonObject, content: unknown, at = this.position.at, defaultSuccess = false): void {
    const actualId = id || `anon-result-${this.position.line}-${this.position.sub}`;
    let tool = this.tools.get(actualId);
    if (!tool) { tool = { id: actualId, native: !!id, name: '', start: null, end: at, position: { ...this.position }, input: null, output: null, status: 'unknown', single: false }; this.tools.set(actualId, tool); }
    const status = outcome(data, defaultSuccess);
    if (!tool.resultEvent) tool.status = status;
    tool.end ??= at; tool.output ??= excerpt(content);
    const duration = tool.start && at && Date.parse(at) > Date.parse(tool.start) && !tool.single ? metric(Date.parse(at) - Date.parse(tool.start), undefined, 'available', 1, 0, 'observed') : metric(null, 'UNPAIRED_TOOL_CALL');
    const event = this.emit('tool_result', { callId: actualId, toolName: tool.name || null, resultStatus: status, durationMs: duration, outputExcerpt: excerpt(content), errorExcerpt: status === 'failure' ? excerpt(content) : null, evidenceRefs: tool.callEvent ? [tool.callEvent] : [] }, { ...this.position, at, sub: this.position.sub++ });
    tool.resultEvent ??= event.eventId;
  }
  private completed(payload: JsonObject): void {
    const item = object(payload.item), type = string(item.type), id = string(item.id);
    const start = nativeTimestamp(payload.started_at_ms, this.position.at);
    const end = nativeTimestamp(payload.completed_at_ms, this.position.at);
    const outerPosition = this.position;
    this.position = { ...this.position, nativeId: id, at: type === 'UserMessage' ? start : end };
    this.model(item.model);
    if (type === 'UserMessage') this.turn('user', id, item.content);
    else if (type === 'AgentMessage') this.turn('assistant', id, item.content);
    else if (type === 'Reasoning') this.emit('reasoning');
    else if (type === 'ContextCompaction') { this.compactions++; this.emit('context_compacted'); }
    else if (type === 'SubAgentActivity') this.subagent(string(item.kind));
    else if (['CommandExecution', 'McpToolCall', 'FileChange', 'CollabAgentToolCall', 'TerminalInteraction'].includes(type)) {
      const name = type === 'CommandExecution' ? 'command_execution' : type === 'FileChange' ? 'file_change' : type === 'McpToolCall' ? `${string(item.server)}.${string(item.tool)}` : type;
      this.call(id, name, item.command ?? item.arguments ?? item.changes, start, true);
      this.resolve(id, item, item.stderr || item.aggregated_output || item.formatted_output || item.stdout || item.result || item.output, end);
    } else this.emit('system');
    outerPosition.sub = this.position.sub;
    this.position = outerPosition;
  }
  private subagent(kind: string): void {
    if (kind === 'started') { this.subagents++; this.result.coverage.subagentDiscovery = 'partial'; }
    this.emit(['completed', 'stopped', 'failed', 'interrupted'].includes(kind) ? 'subagent_stop' : 'subagent_start');
  }
  private item(payload: JsonObject): void {
    const type = string(payload.type);
    if (type === 'message' && (payload.role === 'user' || payload.role === 'assistant')) this.turn(payload.role, string(payload.id), payload.content);
    else if (['function_call', 'custom_tool_call'].includes(type)) this.call(string(payload.call_id), string(payload.name) || type, payload.arguments ?? payload.input);
    else if (['function_call_output', 'custom_tool_call_output'].includes(type)) {
      let decoded: JsonObject = {};
      if (typeof payload.output === 'string') { try { decoded = object(JSON.parse(payload.output)); } catch { /* Plain tool output carries no status. */ } }
      this.resolve(string(payload.call_id), { ...decoded, ...payload }, payload.output);
    }
  }
  consume(raw: JsonObject, line: number, offset: number): void {
    this.position = { line, offset, at: timestamp(raw.timestamp), nativeId: string(raw.uuid), sub: 0 };
    this.time(this.position.at);
    if (!this.position.at) this.warnings.add('unknown_timestamp');
    if (this.input.client === 'claude') { this.claude(raw); return; }
    if (raw.type === 'compacted') { this.compactions++; this.emit('context_compacted'); return; }
    if (raw.payload === null || typeof raw.payload !== 'object' || Array.isArray(raw.payload)) { this.warnings.add('unknown_event'); return; }
    const payload = object(raw.payload), type = string(payload.type), kind = string(raw.type);
    this.model(payload.model);
    if (kind === 'session_meta') {
      this.identity(payload.id);
      const source = object(payload.source), subagent = object(source.subagent);
      const fork = object(subagent.thread_fork ?? (source.kind === 'fork' ? source : undefined));
      const forkParent = string(fork.parent_thread_id ?? fork.parent_session_id);
      if (forkParent) {
        this.result.parentNativeSessionId = forkParent;
        this.result.relationship = { kind: 'fork', parentNativeSessionId: forkParent, parentNativeAgentId: null, evidenceRefs: [subagent.thread_fork != null ? 'session_meta:source.subagent.thread_fork' : 'session_meta:source'] };
        this.result.coverage.inheritedHistory = 'detected';
        this.result.aggregation = { eligibility: 'excluded', reasonCodes: ['INHERITED_HISTORY'] };
        return;
      }
      const spawn = object(subagent.thread_spawn);
      if (typeof spawn.parent_thread_id === 'string') {
        this.result.parentNativeSessionId = spawn.parent_thread_id;
        this.result.relationship = { kind: 'child', parentNativeSessionId: spawn.parent_thread_id, parentNativeAgentId: null, evidenceRefs: ['session_meta:source.subagent.thread_spawn'] };
        this.result.aggregation = { eligibility: 'excluded', reasonCodes: ['SUBAGENT_UNVERIFIED_OVERLAP'] };
      }
      return;
    }
    if (kind === 'session_reset' || type === 'session_reset') { this.tokens.reset(); return; }
    if (type === 'token_count') {
      const observation = this.tokens.cumulative(object(payload.info));
      this.emit('token_sample', observation); return;
    }
    if (kind === 'compacted' || ['context_compaction', 'context_compacted', 'compaction'].includes(type)) { this.compactions++; this.emit('context_compacted'); return; }
    if (this.input.client === 'traex' && kind === 'history_mutation') {
      const operation = string(payload.operation);
      if (operation === 'replace') { this.compactions += 2; this.emit('context_compacted'); }
      const completions = Array.isArray(payload.display_completions) ? payload.display_completions : [];
      for (const completion of completions) this.completed(object(completion));
      if (operation === 'append' && Array.isArray(payload.items)) for (const item of payload.items) {
        const value = object(item);
        if (['function_call', 'custom_tool_call', 'function_call_output', 'custom_tool_call_output'].includes(string(value.type))) this.item(value);
      }
      this.emit(operation === 'replace' ? 'mutation_replace' : operation === 'rollback' ? 'mutation_rollback' : 'mutation_append'); return;
    }
    if (this.input.client === 'traex' && kind === 'inter_agent_communication') { this.subagent(string(payload.kind)); return; }
    if (type === 'task_started') this.currentTurnId = turnId(payload);
    if (type === 'item_completed') { this.canonical = true; this.completed(payload); return; }
    if (type === 'user_message' || (kind === 'response_item' && type === 'message' && payload.role === 'user')) {
      const kinds = object(payload.internal_chat_message_metadata_passthrough).content_item_kinds;
      const contextOnly = Array.isArray(kinds) && kinds.length > 0 && kinds.every(kind => typeof kind === 'string' && (kind.startsWith('agents_md.') || kind.startsWith('environments.')));
      if (!contextOnly && !this.canonicalUserTurns.has(turnId(payload) || this.currentTurnId)) this.turn('user', string(payload.id), payload.message ?? payload.content);
      return;
    }
    if (this.canonical && (kind === 'response_item' || ['user_message', 'message', 'reasoning', 'function_call', 'custom_tool_call', 'function_call_output', 'custom_tool_call_output', 'task_started'].includes(type))) return;
    if (type === 'agent_message') this.turn('assistant', '', payload.message ?? payload.text);
    else if (type === 'reasoning' || type === 'agent_reasoning_raw_content') this.emit('reasoning');
    else if (type === 'sub_agent_activity') { this.position.at = nativeTimestamp(payload.occurred_at_ms, this.position.at); this.position.nativeId = string(payload.event_id); this.subagent(string(payload.kind)); }
    else if (['exec_command_end', 'patch_apply_end', 'web_search_end'].includes(type)) this.resolve(string(payload.call_id), payload, payload.stderr || payload.aggregated_output || payload.formatted_output || payload.stdout || payload.output, nativeTimestamp(payload.completed_at_ms, this.position.at), true);
    else this.item(payload);
  }
  private claude(raw: JsonObject): void {
    this.identity(raw.sessionId);
    if ((raw.isSidechain === true) !== (this.input.expectedStream.kind === 'subagent')) this.error = 'stream_identity_mismatch';
    if (this.input.expectedStream.kind === 'subagent' && string(raw.agentId) !== this.input.expectedStream.nativeAgentId) this.error = 'stream_identity_mismatch';
    if (raw.type === 'system' && raw.subtype === 'compact_boundary') { this.compactions++; this.emit('context_compacted'); }
    const message = object(raw.message), id = string(message.id), role = string(message.role);
    const key = id || `anonymous:${this.position.line}`;
    this.model(message.model);
    const blocks = Array.isArray(message.content) ? message.content.map(object) : [];
    if (role === 'user') {
      const identity = id || string(raw.uuid);
      if (identity && this.seenUserRecords.has(identity)) return;
      if (identity) this.seenUserRecords.add(identity);
      const results = blocks.filter(block => block.type === 'tool_result');
      if (!results.length) this.turn('user', identity, message.content);
      for (const block of results) this.resolve(string(block.tool_use_id), { ...object(raw.toolUseResult), ...block }, block.content, this.position.at, true);
      return;
    }
    if (role !== 'assistant') return;
    if (id) this.assistants.add(id); else { this.assistantAnonymous++; this.warnings.add('claude_message_id_missing'); }
    const observation = this.tokens.claude(key, id, object(message.usage), this.position.at);
    if (observation) this.emit('token_sample', observation);
    if (!blocks.length && typeof message.content === 'string') this.emit('agent_message', { outputExcerpt: excerpt(message.content) });
    for (let index = 0; index < blocks.length; index++) {
      const block = blocks[index]!, blockKey = `${string(raw.uuid) || key}:${string(block.type)}:${index}`;
      if (this.seenBlocks.has(blockKey)) continue;
      this.seenBlocks.add(blockKey);
      if (block.type === 'text') this.emit('agent_message', { outputExcerpt: excerpt(block.text) });
      else if (block.type === 'thinking' || block.type === 'redacted_thinking') this.emit('reasoning');
      else if (block.type === 'tool_use') {
        const callId = string(block.id);
        this.call(callId, string(block.name), block.input);
      }
    }
  }
  finish(): FileAnalysisResult {
    const result = this.result, coverage = result.coverage;
    if (!coverage.parsedLines) this.error = 'no_valid_records';
    else if (!this.hasIdentity && !this.error) this.error = 'missing_native_session_id';
    if (this.error) {
      this.retention.discard(this.input.sourceKey);
      const failure = emptyResult(this.input, this.error);
      failure.coverage = { ...failure.coverage, rawLines: coverage.rawLines, parsedLines: coverage.parsedLines, errorLines: coverage.errorLines, ignoredLines: coverage.ignoredLines, missingTimestampCount: coverage.missingTimestampCount, disorderedTimestampCount: coverage.disorderedTimestampCount };
      return failure;
    }
    let pairedDuration = 0, paired = 0, failures = 0, successes = 0, unknown = 0, anonymous = 0;
    for (const tool of this.tools.values()) {
      if (!tool.native) anonymous++;
      if (tool.status === 'success') successes++; else if (tool.status === 'failure') failures++; else unknown++;
      const duration = tool.start && tool.end && !tool.single && Date.parse(tool.end) > Date.parse(tool.start) ? Date.parse(tool.end) - Date.parse(tool.start) : null;
      if (duration !== null) { pairedDuration += duration; paired++; }
      this.emit('tool_summary', { callId: tool.id, toolName: tool.name || null, resultStatus: tool.status, durationMs: metric(duration, duration === null ? 'UNPAIRED_TOOL_CALL' : undefined, undefined, undefined, undefined, duration === null ? 'unknown' : 'observed'), inputExcerpt: tool.input, outputExcerpt: tool.output, evidenceRefs: [tool.callEvent, tool.resultEvent].filter((id): id is string => !!id) }, { ...tool.position, sub: tool.position.sub + 1_000_000 });
    }
    const turns = (set: Set<string>, anon: number) => metric(set.size + anon, anon ? 'ANONYMOUS_TURNS' : undefined, anon ? 'partial' : 'available', set.size, anon, anon ? 'derived' : 'exact');
    const elapsed = coverage.timeRange.start && coverage.timeRange.end ? Date.parse(coverage.timeRange.end) - Date.parse(coverage.timeRange.start) : null;
    const incompleteTime = coverage.missingTimestampCount > 0 || coverage.disorderedTimestampCount > 0;
    result.metrics = { ...this.tokens.metrics(), elapsedDurationMs: metric(elapsed, elapsed === null ? 'NO_VALID_TIMESTAMPS' : undefined, undefined, undefined, undefined, 'observed'), activeDurationMs: metric(incompleteTime || elapsed === null ? null : Math.max(0, elapsed - this.idle), incompleteTime ? 'TIMESTAMP_DISORDERED' : elapsed === null ? 'NO_VALID_TIMESTAMPS' : undefined, undefined, undefined, undefined, 'observed'), idleDurationMs: metric(incompleteTime || elapsed === null ? null : this.idle, incompleteTime ? 'TIMESTAMP_DISORDERED' : elapsed === null ? 'NO_VALID_TIMESTAMPS' : undefined, undefined, undefined, undefined, 'heuristic'), pairedToolDurationMs: metric(paired ? pairedDuration : null, paired ? undefined : 'NO_PAIRED_TOOLS', undefined, undefined, undefined, 'observed'), userTurns: turns(this.users, this.userAnonymous), assistantTurns: turns(this.assistants, this.assistantAnonymous), toolCalls: metric(this.tools.size, anonymous ? 'ANONYMOUS_TOOL_CALLS' : undefined, anonymous ? 'partial' : 'available', this.tools.size - anonymous, anonymous), toolFailures: metric(failures), toolSuccesses: metric(successes), toolUnknowns: metric(unknown), toolFailureRate: metric(successes + failures ? failures / (successes + failures) : null, successes + failures ? anonymous ? 'ANONYMOUS_TOOL_CALLS' : undefined : 'NO_DETERMINABLE_CALLS', successes + failures && anonymous ? 'partial' : undefined, successes + failures, anonymous || (successes + failures ? 0 : 1), anonymous ? 'derived' : successes + failures ? 'exact' : 'unavailable'), compactionCount: metric(this.compactions), subagentCount: metric(this.subagents, this.subagents ? 'SUBAGENT_FILE_UNVERIFIED' : undefined, this.subagents ? 'partial' : 'available') };
    result.models = [...this.models].sort(); coverage.tokenSamplesAvailable = this.tokens.samples;
    return result;
  }
}

// Fixed-size chunks and an explicit byte cap prevent unbounded lines or growing
// snapshots from allocating beyond the request's declared immutable snapshot.
async function readSnapshot(input: AnalyzeFileInput, maxLine: number, consume?: (line: Buffer | null, number: number, offset: number, partial: boolean) => void): Promise<string | null> {
  let file;
  try { file = await open(input.path, constants.O_RDONLY | constants.O_NONBLOCK); } catch { return 'file_not_found'; }
  try {
    const stat = await file.stat();
    if (!stat.isFile()) return 'not_a_regular_file';
    if (stat.size !== input.bytes) return 'file_size_mismatch';
    const hash = createHash('sha256');
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let total = 0, offset = 0, lineNumber = 1, length = 0, tooLong = false;
    let parts: Buffer[] = [];
    while (true) {
      const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > input.bytes) return 'file_size_mismatch';
      hash.update(chunk.subarray(0, bytesRead));
      if (!consume) continue;
      let start = 0;
      for (let cursor = 0; cursor < bytesRead; cursor++) {
        if (chunk[cursor] !== 10) continue;
        const segment = chunk.subarray(start, cursor);
        length += segment.length;
        if (length > maxLine) tooLong = true;
        if (!tooLong) parts.push(Buffer.from(segment));
        consume(tooLong ? null : Buffer.concat(parts), lineNumber++, offset, false);
        offset += length + 1; length = 0; tooLong = false; parts = []; start = cursor + 1;
      }
      if (start < bytesRead) {
        const segment = chunk.subarray(start, bytesRead); length += segment.length;
        if (length > maxLine) { tooLong = true; parts = []; }
        else if (!tooLong) parts.push(Buffer.from(segment));
      }
    }
    if (consume && length > 0) consume(null, lineNumber, offset, true);
    if (total !== input.bytes) return 'file_size_mismatch';
    return hash.digest('hex') === input.sha256 ? null : 'hash_mismatch';
  } catch { return 'read_error'; } finally { await file.close(); }
}
const decoder = new TextDecoder('utf-8', { fatal: true });
function parseLine(line: Buffer): JsonObject {
  // Node's numeric value may round a fractional or out-of-range token literal.
  // Preserve invalid numeric spellings as strings so token validation rejects them.
  const parsed: unknown = JSON.parse(decoder.decode(line), (key: string, value: unknown, context?: { source?: string }) => {
    if (typeof value === 'number' && (key.endsWith('_tokens') || key === 'model_context_window') && context?.source && !/^(0|[1-9]\d*)$/.test(context.source)) return context.source;
    return value;
  });
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('malformed_json');
  return parsed as JsonObject;
}
export async function analyzeSessionInsightFiles(request: AnalyzeFilesRequest): Promise<AnalyzeFilesResult> {
  const parsed = analyzeFilesRequestSchema.parse(request);
  const inputs = new Map<string, AnalyzeFileInput>();
  let totalBytes = 0;
  for (const file of parsed.files) {
    if (!isAbsolute(file.path) || !file.sourceKey.trim() || !file.expectedNativeSessionId.trim()) throw new Error('invalid_analysis_request');
    const existing = inputs.get(file.sourceKey);
    if (existing) {
      if (existing.sha256 !== file.sha256 || existing.client !== file.client || existing.expectedNativeSessionId !== file.expectedNativeSessionId || JSON.stringify(existing.expectedStream) !== JSON.stringify(file.expectedStream)) throw new Error('source_conflict');
      continue;
    }
    totalBytes += file.bytes;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > SESSION_INSIGHT_LIMITS.maxTotalSnapshotBytes) throw new Error('snapshot_byte_budget_exceeded');
    inputs.set(file.sourceKey, file);
  }
  const warnings = new Warnings(), retention = new TraceRetention(parsed.limits.maxTraceEvents);
  const files: FileAnalysisResult[] = [];
  for (const input of [...inputs.values()].sort((a, b) => a.sourceKey.localeCompare(b.sourceKey))) {
    // Select authority before emitting/counting mirrors so record order cannot change user turns.
    const canonicalUserTurns = new Set<string>();
    let currentTurnId = '';
    const verified = await readSnapshot(input, parsed.limits.maxLineBytes, input.client === 'claude' ? undefined : (line, _number, _offset, partial) => {
      if (partial || !line) return;
      let raw: JsonObject;
      try { raw = parseLine(line); } catch { return; }
      const payload = object(raw.payload);
      if (payload.type === 'task_started') currentTurnId = turnId(payload);
      if (payload.type === 'item_completed' && object(payload.item).type === 'UserMessage') canonicalUserTurns.add(turnId(payload) || currentTurnId);
      if (input.client === 'traex' && raw.type === 'history_mutation' && Array.isArray(payload.display_completions)) {
        for (const completion of payload.display_completions) {
          const value = object(completion);
          if (object(value.item).type === 'UserMessage') canonicalUserTurns.add(turnId(value) || currentTurnId);
        }
      }
    });
    if (verified) { files.push(emptyResult(input, verified)); continue; }
    const analysis = new FileAnalysis(input, retention, warnings, canonicalUserTurns);
    const failure = await readSnapshot(input, parsed.limits.maxLineBytes, (line, number, offset, partial) => {
      const coverage = analysis.result.coverage;
      if (partial || !line) { coverage.ignoredLines++; analysis.result.status = 'partial'; warnings.add(partial ? 'truncated_final_line' : 'line_too_long'); return; }
      if (!line.toString('utf8').trim()) return;
      coverage.rawLines++;
      let raw: JsonObject;
      try { raw = parseLine(line); } catch { coverage.errorLines++; analysis.result.status = 'partial'; warnings.add('malformed_json'); return; }
      coverage.parsedLines++;
      analysis.consume(raw, number, offset);
    });
    if (failure) analysis.error = failure;
    const result = analysis.finish();
    if (result.status !== 'error') {
      const pulse = new PulseAnalysis(input.client, result.coverage.timeRange.start, result.coverage.timeRange.end);
      const replay = new TokenAnalysis(input.client);
      const pulseFailure = input.client === 'claude' ? null : await readSnapshot(input, parsed.limits.maxLineBytes, (line, _number, _offset, partial) => {
        if (partial || !line) return;
        let raw: JsonObject;
        try { raw = parseLine(line); } catch { return; }
        const payload = object(raw.payload);
        if (payload.type === 'session_reset' || raw.type === 'session_reset') replay.reset();
        if (payload.type !== 'token_count') return;
        const observation = replay.cumulative(object(payload.info));
        const tokens = observation.tokens;
        const conflicts = Object.fromEntries(Object.entries(replay.counters).flatMap(([key, counter]) => counter.conflict ? [[key, counter.conflict]] : []));
        const values = { input: null, uncached: tokens.inputUncached, cached: tokens.cacheRead, write: tokens.cacheWrite, output: tokens.output, reasoning: tokens.reasoning, total: tokens.total };
        if (!Object.values(values).some(value => value != null) && !Object.keys(conflicts).length) return;
        pulse.add({ at: timestamp(raw.timestamp), values, conflicts });
      });
      if (pulseFailure) { retention.discard(input.sourceKey); files.push(emptyResult(input, pulseFailure)); continue; }
      result.pulseBuckets = input.client === 'claude' ? analysis.tokens.pulse(result.coverage.timeRange.start, result.coverage.timeRange.end) : pulse.finish();
    }
    files.push(result);
  }
  retention.finish(files);
  return { ...SESSION_INSIGHT_ENGINE_VERSIONS, requestId: parsed.requestId, files, warnings: warnings.finish() };
}
