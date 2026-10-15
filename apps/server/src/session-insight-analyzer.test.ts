import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { analyzeFilesResultSchema, SESSION_INSIGHT_LIMITS, type AnalyzeFileInput, type AnalyzeFilesRequest, type InsightClient, type StreamIdentity } from '@dutydeck/shared';
import { analyzeSessionInsightFiles } from './session-insight-analyzer.js';
const fixtures = resolve('tests/fixtures/session-insight');
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function input(path: string, client: InsightClient, expectedNativeSessionId: string, expectedStream: StreamIdentity = { kind: 'main', nativeAgentId: null }): Promise<AnalyzeFileInput> {
  const bytes = await readFile(path);
  return { path, client, sourceKey: path.split('/').slice(-2).join(':'), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), expectedNativeSessionId, expectedStream };
}
function request(files: AnalyzeFileInput[], maxTraceEvents: number = 20_000): AnalyzeFilesRequest {
  return { schemaVersion: 1, requestId: randomUUID(), files, limits: { maxLineBytes: SESSION_INSIGHT_LIMITS.maxLineBytes, maxTraceEvents } };
}
async function synthetic(lines: unknown[], client: InsightClient = 'codex', newline = true): Promise<AnalyzeFileInput> {
  const directory = await mkdtemp(join(tmpdir(), 'insight-ts-')); directories.push(directory);
  const path = join(directory, 'session.jsonl');
  await writeFile(path, lines.map(line => typeof line === 'string' ? line : JSON.stringify(line)).join('\n') + (newline ? '\n' : ''));
  return input(path, client, 'session');
}
const at = (second: number) => new Date(Date.UTC(2026, 9, 3, 9, 0, second)).toISOString();
const meta = { type: 'session_meta', timestamp: at(0), payload: { id: 'session' } };
const counter = (value: Record<string, unknown>, second = 1) => ({ type: 'event_msg', timestamp: at(second), payload: { type: 'token_count', info: { total_token_usage: value } } });
const zero = { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0 };
const claude = (id: string | undefined, usage: Record<string, unknown> | undefined, second = 1) => ({ type: 'assistant', sessionId: 'session', isSidechain: false, uuid: `record-${id}-${second}`, timestamp: at(second), message: { id, role: 'assistant', content: [{ type: 'text', text: 'answer' }], usage } });
async function analyze(file: AnalyzeFileInput) {
  const result = await analyzeSessionInsightFiles(request([file]));
  expect(analyzeFilesResultSchema.safeParse(result).success).toBe(true);
  return result.files[0]!;
}

describe('TypeScript session insight analyzer', () => {
  it.each([
    ['codex', 'codex', '01a0ffa7-270b-72f1-be55-21dde8e42935', 92353, 3, 1],
    ['traex', 'traex', '01a0ffa6-a71d-79b3-9a87-d386f1808e41', 36849, 4, 1],
    ['claude-main', 'claude', '0192e000-7a3b-7000-8000-000000000001', null, 1, 0],
    ['claude-subagent', 'claude', '0192e000-7a3b-7000-8000-000000000001', null, 2, 0]
  ] as const)('analyzes real native %s with observed token and tool evidence', async (name, client, session, total, tools, failures) => {
    const stream: StreamIdentity = name === 'claude-subagent' ? { kind: 'subagent', nativeAgentId: 'a01e15e2adc99f940' } : { kind: 'main', nativeAgentId: null };
    const result = await analyze(await input(join(fixtures, 'real-native', `${name}.jsonl`), client, session, stream));
    expect(result.status).toBe('ok');
    expect(result.metrics.rawTotal.value).toBe(total);
    expect(result.metrics.toolCalls.value).toBe(tools);
    expect(result.metrics.toolFailures.value).toBe(failures);
    expect(result.trace.some(event => event.kind === 'token_sample')).toBe(true);
    if (failures) expect(result.trace.some(event => event.kind === 'tool_result' && event.resultStatus === 'failure')).toBe(true);
    if (client === 'claude') {
      expect(result.metrics.inputUncached.value).toBe(name === 'claude-main' ? 26501 : 27471);
      expect(result.metrics.output.value).toBe(name === 'claude-main' ? 828 : 959);
      expect(result.metrics.reasoningOutput.value).toBeNull();
      expect(result.metrics.contextWindow.value).toBeNull();
      expect(result.pulseBuckets.reduce((sum, bucket) => sum + (bucket.tokens.inputUncached.value ?? 0), 0)).toBe(result.metrics.inputUncached.value);
    } else {
      expect(result.metrics.totalTracked.value).toBeNull();
      expect(result.metrics.totalTracked.status).toBe('partial');
    }
  });

  it.each([
    ['cumulative-100-to-150', 'synthetic-codex-100-150', 165, 55, 'partial'],
    ['reset-150-to-10-no-reset', 'synthetic-codex-no-reset', 15, null, 'conflict'],
    ['reset-150-to-10-with-reset', 'synthetic-codex-with-reset', 15, 15, 'partial']
  ] as const)('preserves unknown cumulative baseline and reset semantics: %s', async (name, session, rawTotal, delta, outputStatus) => {
    const result = await analyze(await input(join(fixtures, 'synthetic', `${name}.jsonl`), 'codex', session));
    expect(result.metrics.rawTotal.value).toBe(rawTotal);
    expect(result.metrics.output.status).toBe(outputStatus);
    const samples = result.trace.filter(event => event.kind === 'token_sample');
    expect(samples[0]!.rawUsage?.observedDelta).toBeNull();
    expect(samples.at(-1)!.rawUsage?.observedDelta).toBe(delta);
  });

  it.each([
    ['claude-two-messages', 'claude-two-msg-session', 120, 35],
    ['claude-same-message-dedup', 'claude-dedup-session', 100, 40]
  ] as const)('deduplicates native Claude message snapshots: %s', async (name, session, tokens, output) => {
    const result = await analyze(await input(join(fixtures, 'synthetic', `${name}.jsonl`), 'claude', session));
    expect(result.metrics.inputUncached.value).toBe(tokens);
    expect(result.metrics.output.value).toBe(output);
    expect(result.metrics.cacheRead.value).toBeNull();
    expect(result.metrics.totalTracked.value).toBeNull();
    expect(result.pulseBuckets.reduce((sum, bucket) => sum + (bucket.tokens.inputUncached.value ?? 0), 0)).toBe(tokens);
  });

  it('only derives Codex mutually exclusive buckets with a proven zero baseline', async () => {
    const result = await analyze(await synthetic([meta, counter(zero), counter({ ...zero, input_tokens: 100, cached_input_tokens: 80, output_tokens: 10, total_tokens: 110 }, 2)]));
    expect(result.metrics.inputUncached.value).toBe(20);
    expect(result.metrics.totalTracked.value).toBe(110);
    expect(result.metrics.rawInput.value).toBe(100);
    expect(result.metrics.cacheWrite.value).toBe(0);
    expect(result.pulseBuckets.reduce((sum, bucket) => sum + (bucket.tokens.total.value ?? 0), 0)).toBe(110);
  });
  it('keeps TraeX normalization unverified while exposing actual raw counters', async () => {
    const result = await analyze(await synthetic([meta, counter(zero), counter({ ...zero, input_tokens: 100, cached_input_tokens: 80, output_tokens: 10, total_tokens: 110 }, 2)], 'traex'));
    expect(result.metrics.rawTotal.value).toBe(110);
    for (const name of ['inputUncached', 'cacheRead', 'cacheWrite', 'output', 'totalTracked'] as const) {
      expect(result.metrics[name]).toMatchObject({ value: null, status: 'partial' });
    }
  });
  it('does not treat compaction or nonzero cache writes as proven accounting', async () => {
    const result = await analyze(await synthetic([meta, counter({ ...zero, input_tokens: 100, total_tokens: 100 }), { timestamp: at(2), type: 'event_msg', payload: { type: 'context_compacted' } }, counter({ ...zero, input_tokens: 10, total_tokens: 10 }, 3)]));
    expect(result.metrics.inputUncached.status).toBe('conflict');
    expect(result.metrics.rawInput.value).toBe(10);
    const write = await analyze(await synthetic([meta, counter(zero), counter({ ...zero, input_tokens: 10, cache_write_input_tokens: 2, total_tokens: 10 }, 2)]));
    expect(write.metrics.totalTracked).toMatchObject({ value: null, status: 'partial', reasonCodes: ['CACHE_WRITE_UNVERIFIED'] });
  });
  it('arms every counter reset independently, including before the first value', async () => {
    const reset = { timestamp: at(1), type: 'event_msg', payload: { type: 'session_reset' } };
    const first = await analyze(await synthetic([meta, reset, counter({ input_tokens: 100 }, 2), counter({ input_tokens: 200, output_tokens: 5 }, 3)]));
    expect(first.metrics.output.value).toBe(5);
    expect(first.trace.filter(event => event.kind === 'token_sample').at(-1)?.rawUsage?.baselineStatus).toBe('epoch_reset');
    const later = await analyze(await synthetic([meta, counter(zero), reset, counter({ input_tokens: 100 }, 2), counter({ input_tokens: 200, output_tokens: 5 }, 3)]));
    expect(later.metrics.output.status).toBe('partial');
    expect(later.trace.filter(event => event.kind === 'token_sample').at(-1)?.tokens?.output).toBe(5);
  });
  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '20', null])('rejects invalid token value %s without fabricating zero', async value => {
    const result = await analyze(await synthetic([meta, counter(zero), counter({ ...zero, input_tokens: value }, 2)]));
    expect(result.metrics.inputUncached).toMatchObject({ value: null, status: 'conflict' });
    expect(result.metrics.rawInput.value).toBe(0);
    expect(result.pulseBuckets.some(bucket => bucket.tokens.inputUncached.status === 'conflict')).toBe(true);
  });
  it('makes Claude decreasing snapshots and total overflow conflicting', async () => {
    const decrease = await analyze(await synthetic([claude('m1', { input_tokens: 100, output_tokens: 20 }), claude('m1', { input_tokens: 90, output_tokens: 30 }, 2)], 'claude'));
    expect(decrease.metrics.inputUncached).toMatchObject({ value: null, status: 'conflict' });
    const overflow = await analyze(await synthetic([claude('m1', { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 0 }), claude('m2', { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 0 })], 'claude'));
    expect(overflow.metrics.inputUncached).toMatchObject({ value: null, status: 'conflict', reasonCodes: ['INTEGER_OVERFLOW'] });
    expect(overflow.pulseBuckets[0]!.tokens.inputUncached.status).toBe('conflict');
  });
  it('counts missing Claude usage and message identity as incomplete evidence', async () => {
    const result = await analyze(await synthetic([claude('m1', { input_tokens: 10, output_tokens: 5 }), claude('m2', { input_tokens: 10 }, 2)], 'claude'));
    expect(result.metrics.output).toMatchObject({ value: null, status: 'partial', evidenceCount: 1, missingCount: 1 });
    const missingUsage = await analyze(await synthetic([claude('m1', { input_tokens: 10 }), claude('m2', undefined, 2)], 'claude'));
    expect(missingUsage.metrics.inputUncached.status).toBe('partial');
    const anonymous = await analyze(await synthetic([claude(undefined, { input_tokens: 10 })], 'claude'));
    expect(anonymous.metrics.inputUncached).toMatchObject({ value: null, status: 'partial' });
  });
  it('positions deduped Claude usage only at its final evidence time', async () => {
    const result = await analyze(await synthetic([claude('m1', { input_tokens: 10, output_tokens: 1 }), claude('m1', { input_tokens: 10, output_tokens: 2 }, 3_600)], 'claude'));
    expect(result.pulseBuckets).toHaveLength(1);
    expect(Date.parse(result.pulseBuckets[0]!.startAt)).toBeGreaterThan(Date.parse(at(1_800)));
    const timeless = claude('m1', { input_tokens: 10, output_tokens: 3 }, 7_200) as Record<string, unknown>;
    delete timeless.timestamp;
    const final = await analyze(await synthetic([claude('m1', { input_tokens: 10, output_tokens: 1 }), timeless], 'claude'));
    expect(final.metrics.output.value).toBe(3);
    expect(final.pulseBuckets).toEqual([]);
  });

  it('rejects hash, size and native/stream identity mismatches per file', async () => {
    const file = await synthetic([meta, counter(zero)]);
    for (const [override, code] of [[{ sha256: '0'.repeat(64) }, 'hash_mismatch'], [{ bytes: file.bytes + 1 }, 'file_size_mismatch'], [{ expectedNativeSessionId: 'wrong' }, 'native_id_mismatch']] as const) {
      expect((await analyze({ ...file, ...override })).errorCode).toBe(code);
    }
    const child = await synthetic([claude('m1', { input_tokens: 1 })], 'claude');
    expect((await analyze({ ...child, expectedStream: { kind: 'subagent', nativeAgentId: 'worker' } })).errorCode).toBe('stream_identity_mismatch');
  });
  it('rejects missing identity and never discovers neighboring files', async () => {
    const file = await synthetic([counter(zero)]);
    await writeFile(join(file.path, '..', 'neighbor.jsonl'), JSON.stringify(meta) + '\n');
    const result = await analyze(file);
    expect(result).toMatchObject({ status: 'error', errorCode: 'missing_native_session_id', trace: [] });
  });
  it('enforces aggregate bytes, strict request shape and duplicate source identity', async () => {
    const file = await synthetic([meta]);
    await expect(analyzeSessionInsightFiles(request([{ ...file, bytes: SESSION_INSIGHT_LIMITS.maxTotalSnapshotBytes + 1 }]))).rejects.toThrow();
    await expect(analyzeSessionInsightFiles(request([file, { ...file, expectedNativeSessionId: 'different' }]))).rejects.toThrow('source_conflict');
    expect((await analyzeSessionInsightFiles(request([file, file]))).files).toHaveLength(1);
    await expect(analyzeSessionInsightFiles({ ...request([file]), unexpected: true } as AnalyzeFilesRequest)).rejects.toThrow();
  });

  it('ignores unterminated final JSON, blank separators and oversized lines with accurate byte offsets', async () => {
    const final = await analyze(await synthetic([meta, counter(zero)], 'codex', false));
    expect(final.status).toBe('partial');
    expect(final.coverage).toMatchObject({ rawLines: 1, parsedLines: 1, ignoredLines: 1, tokenSamplesAvailable: 0 });
    const file = await synthetic([meta, '', 'x'.repeat(2_000), 'malformed', { timestamp: at(2), type: 'event_msg', payload: { type: 'agent_message', message: 'answer' } }]);
    const req = request([file]); req.limits.maxLineBytes = 1024;
    const result = (await analyzeSessionInsightFiles(req)).files[0]!;
    expect(result.coverage).toMatchObject({ rawLines: 3, parsedLines: 2, errorLines: 1, ignoredLines: 1 });
    const event = result.trace.find(event => event.kind === 'agent_message')!;
    const content = await readFile(file.path);
    expect(content.subarray(event.byteOffset).toString()).toContain('"message":"answer"');
    expect(event.lineNumber).toBe(5);
  });
  it('caps UTF-8 excerpts by bytes while preserving complete code points', async () => {
    const result = await analyze(await synthetic([meta, { type: 'event_msg', timestamp: at(1), payload: { type: 'agent_message', message: '中🚀'.repeat(2_000) } }]));
    const value = result.trace.find(event => event.kind === 'agent_message')!.outputExcerpt!;
    expect(Buffer.byteLength(value)).toBeLessThanOrEqual(4096);
    expect(value).not.toContain('\ufffd');
    expect(value.length).toBeGreaterThan(1000);
  });
  it('shares trace retention independently of input order and retains late failure and large token evidence', async () => {
    const records: unknown[] = [meta, counter(zero)];
    for (let index = 0; index < 150; index++) records.push({ timestamp: at(index + 2), type: 'event_msg', payload: { type: 'agent_message', message: `message ${index}` } });
    records.push({ timestamp: at(200), type: 'response_item', payload: { type: 'function_call', call_id: 'failed-call', name: 'exec', arguments: '{}' } });
    records.push({ timestamp: at(210), type: 'response_item', payload: { type: 'function_call_output', call_id: 'failed-call', output: '{"exit_code":1}' } });
    records.push(counter({ ...zero, input_tokens: 10_000, total_tokens: 10_000 }, 220));
    const first = { ...await synthetic(records), sourceKey: 'a' }, last = { ...await synthetic([meta, counter(zero)]), sourceKey: 'z' };
    const forward = await analyzeSessionInsightFiles(request([first, last], 40));
    const backward = await analyzeSessionInsightFiles(request([last, first], 40));
    expect(forward.files).toEqual(backward.files);
    expect(forward.files.reduce((sum, file) => sum + file.trace.length, 0)).toBeLessThanOrEqual(40);
    const events = forward.files[0]!.trace;
    expect(events.some(event => event.resultStatus === 'failure')).toBe(true);
    expect(events.some(event => event.rawUsage?.observedDelta === 10_000)).toBe(true);
    expect(events.some(event => event.durationMs?.value === 10_000)).toBe(true);
    expect(forward.files[1]!.coverage).toMatchObject({ retainedTraceCount: 0, omittedTraceCount: 1 });
    expect(forward.files[1]!.coverage.omittedTraceByCategory).toEqual({ token_sample: 1 });
  });
  it('releases trace budget for a source whose identity fails later', async () => {
    const bad = { ...await synthetic([meta, { timestamp: at(1), type: 'event_msg', payload: { type: 'agent_message', message: 'bad' } }, { ...meta, payload: { id: 'different' } }]), sourceKey: 'a' };
    const good = { ...await synthetic([meta, counter(zero)]), sourceKey: 'z' };
    const result = await analyzeSessionInsightFiles(request([bad, good], 1));
    expect(result.files[0]!.status).toBe('error');
    expect(result.files[1]!.trace).toHaveLength(1);
  });
  it.each([
    ['upstream-sanitized', 'claude-main', 'claude', 'claude-root', null, 2, 1, 1],
    ['upstream-sanitized', 'claude-subagent-worker', 'claude', 'claude-root', 'worker-agent', 0, 0, 0],
    ['upstream-sanitized', 'codex-legacy', 'codex', 'codex-legacy-root', null, 1, 0, 0],
    ['upstream-sanitized', 'codex-modern', 'codex', 'codex-modern-root', null, 1, 0, 1],
    ['upstream-sanitized', 'traex-legacy', 'traex', 'traex-legacy-root', null, 1, 0, 0],
    ['upstream-sanitized', 'traex-modern', 'traex', 'traex-modern-root', null, 1, 0, 2],
    ['synthetic', 'claude-main', 'claude', 'claude-shared-session', null, 1, 0, 0],
    ['synthetic', 'claude-subagent', 'claude', 'claude-shared-session', 'subagent-worker-1', 0, 0, 0],
    ['synthetic', 'traex-special-tools', 'traex', 'traex-special-tools-session', null, 2, 0, 0]
  ] as const)('covers checked-in %s/%s tool and compaction dialects', async (directory, name, client, session, agent, calls, failures, compactions) => {
    const stream: StreamIdentity = agent ? { kind: 'subagent', nativeAgentId: agent } : { kind: 'main', nativeAgentId: null };
    const result = await analyze(await input(join(fixtures, directory, `${name}.jsonl`), client, session, stream));
    expect(result.status).toBe(name === 'claude-main' && directory === 'upstream-sanitized' ? 'partial' : 'ok');
    expect(result.metrics.toolCalls.value).toBe(calls);
    expect(result.metrics.toolFailures.value).toBe(failures);
    expect(result.metrics.compactionCount.value).toBe(compactions);
    if (name === 'traex-special-tools') {
      expect(result.metrics.subagentCount.value).toBe(1);
      expect(result.trace.some(event => event.kind === 'mutation_append')).toBe(true);
    }
    if (name === 'traex-modern') expect(result.metrics.pairedToolDurationMs.value).toBe(1000);
    if (name === 'claude-main' && directory === 'upstream-sanitized') expect(result.trace.filter(event => event.kind === 'tool_call')).toHaveLength(3);
  });
  it.each(['codex', 'claude', 'traex'] as const)('rejects identity-free pty projection %s without inventing source identity', async client => {
    const result = await analyze(await input(join(fixtures, 'pty-driver-dialects', `${client}.jsonl`), client, 'unverified'));
    expect(result.status).toBe('error');
    expect(result.errorCode).toBe('missing_native_session_id');
    expect(result.metrics.rawTotal.value).toBeNull();
  });
  it('uses the original five-minute idle gap threshold', async () => {
    const message = (second: number) => ({ type: 'event_msg', timestamp: at(second), payload: { type: 'agent_message', message: 'answer' } });
    const result = await analyze(await synthetic([meta, message(60), message(360), message(661)]));
    expect(result.metrics.elapsedDurationMs.value).toBe(661_000);
    expect(result.metrics.idleDurationMs.value).toBe(301_000);
    expect(result.metrics.activeDurationMs.value).toBe(360_000);
  });
  it('requires explicit sidechain proof for a requested Claude subagent', async () => {
    const record = { ...claude('m1', { input_tokens: 1 }), agentId: 'worker' } as Record<string, unknown>;
    delete record.isSidechain;
    const file = await synthetic([record], 'claude');
    const result = await analyze({ ...file, expectedStream: { kind: 'subagent', nativeAgentId: 'worker' } });
    expect(result.errorCode).toBe('stream_identity_mismatch');
  });
  it('keeps anonymous tool failure rate partial', async () => {
    const result = await analyze(await synthetic([meta, { type: 'response_item', timestamp: at(1), payload: { type: 'function_call_output', output: '{"exit_code":1}' } }]));
    expect(result.metrics.toolCalls.status).toBe('partial');
    expect(result.metrics.toolFailureRate).toMatchObject({ value: 1, status: 'partial', quality: 'derived', reasonCodes: ['ANONYMOUS_TOOL_CALLS'] });
  });
  it('warns on unrecognized payload shape without counting it as malformed JSON', async () => {
    const file = await synthetic([meta, { type: 'event_msg', timestamp: at(1), payload: 'not-an-object' }]);
    const result = await analyzeSessionInsightFiles(request([file]));
    expect(result.files[0]!.status).toBe('ok');
    expect(result.files[0]!.coverage).toMatchObject({ parsedLines: 2, errorLines: 0 });
    expect(result.warnings).toContainEqual({ code: 'unknown_event', count: 1, samples: [] });
  });
  it('rejects token literals whose fractional spelling rounds to a safe integer', async () => {
    const file = await synthetic([meta, '{"type":"event_msg","timestamp":"2026-10-03T09:00:01Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":9007199254740990.1,"cached_input_tokens":0}}}}']);
    expect((await analyze(file)).metrics.inputUncached.status).toBe('conflict');
  });
  it('includes missing usage messages in the pulse denominator', async () => {
    const result = await analyze(await synthetic([claude('m1', { input_tokens: 10, output_tokens: 10 }), claude('m2', undefined)], 'claude'));
    expect(result.metrics.inputUncached).toMatchObject({ value: null, status: 'partial', evidenceCount: 1, missingCount: 1 });
    expect(result.pulseBuckets).toHaveLength(1);
    expect(result.pulseBuckets[0]).toMatchObject({ sampleCount: 2, tokens: { inputUncached: { value: null, status: 'partial', evidenceCount: 1, missingCount: 1 } } });
  });
  it('gives distinct raw snapshots unique event identifiers even if native UUIDs repeat', async () => {
    const first = claude('m1', { input_tokens: 10, output_tokens: 1 });
    const second = { ...claude('m1', { input_tokens: 10, output_tokens: 2 }, 2), uuid: first.uuid };
    const result = await analyze(await synthetic([first, second], 'claude'));
    const events = result.trace.filter(event => event.kind === 'token_sample');
    expect(events).toHaveLength(2);
    expect(new Set(events.map(event => event.eventId)).size).toBe(2);
    expect(result.metrics.output.value).toBe(2);
  });

  it('uses positive native millisecond event timestamps and treats zero as absent', async () => {
    const result = await analyze(await synthetic([
      meta,
      { type: 'event_msg', timestamp: at(5), payload: { type: 'item_completed', started_at_ms: 0, completed_at_ms: 0, item: { type: 'AgentMessage', id: 'answer', content: 'reply' } } },
      { type: 'event_msg', timestamp: at(6), payload: { type: 'sub_agent_activity', event_id: 'child', kind: 'started', occurred_at_ms: Date.parse(at(4)) } },
      { type: 'event_msg', timestamp: at(7), payload: { type: 'exec_command_end', call_id: 'tool', completed_at_ms: Date.parse(at(3)), exit_code: 0 } }
    ]));
    expect(result.trace.find(event => event.kind === 'agent_message')!.timestamp).toBe(at(5));
    expect(result.trace.find(event => event.kind === 'subagent_start')!.timestamp).toBe(at(4));
    expect(result.trace.find(event => event.kind === 'tool_result')!.timestamp).toBe(at(3));
    expect(result.trace.every(event => !event.timestamp?.startsWith('1970'))).toBe(true);
  });

  it('keeps first-invalid Claude usage conflicting in its known-time pulse bucket', async () => {
    const result = await analyze(await synthetic([claude('m1', { input_tokens: 10, output_tokens: 10 }), claude('m2', { input_tokens: -1, output_tokens: 10 })], 'claude'));
    expect(result.metrics.inputUncached.status).toBe('conflict');
    expect(result.pulseBuckets).toHaveLength(1);
    expect(result.pulseBuckets[0]).toMatchObject({ sampleCount: 2, tokens: { inputUncached: { value: null, status: 'conflict' } } });
  });
  it('keeps anonymous message pulse quality partial with file accounting', async () => {
    const result = await analyze(await synthetic([claude(undefined, { input_tokens: 10, output_tokens: 10 })], 'claude'));
    expect(result.metrics.inputUncached.status).toBe('partial');
    expect(result.pulseBuckets[0]!.tokens.inputUncached).toMatchObject({ value: null, status: 'partial', reasonCodes: ['MESSAGE_IDENTITY_UNVERIFIED'] });
  });
  it('bounds pulse aggregates independently of retained trace events', async () => {
    const lines = [meta, counter(zero)];
    for (let index = 1; index < 1_500; index++) lines.push(counter({ ...zero, input_tokens: index, total_tokens: index }, index + 1));
    const file = await synthetic(lines);
    const result = (await analyzeSessionInsightFiles(request([file], 1))).files[0]!;
    expect(result.trace).toHaveLength(1);
    expect(result.pulseBuckets.length).toBeLessThanOrEqual(1_000);
    expect(result.metrics.totalTracked.value).toBe(1_499);
    expect(result.pulseBuckets.reduce((sum, bucket) => sum + (bucket.tokens.total.value ?? 0), 0)).toBe(1_499);
  });
  it('preserves repeated native tool call evidence without duplicating cardinality', async () => {
    const call = (second: number) => ({ timestamp: at(second), type: 'response_item', payload: { type: 'function_call', call_id: 'call', name: 'exec', arguments: '{}' } });
    const result = await analyze(await synthetic([meta, call(1), call(2)]));
    expect(result.metrics.toolCalls.value).toBe(1);
    const events = result.trace.filter(event => event.kind === 'tool_call');
    expect(events).toHaveLength(2);
    expect(new Set(result.trace.map(event => event.eventId)).size).toBe(result.trace.length);
  });

  it('keeps each repeated tool result raw evidence while aggregating the first endpoint', async () => {
    const result = await analyze(await synthetic([
      meta,
      { timestamp: at(1), type: 'response_item', payload: { type: 'function_call', call_id: 'call', name: 'exec', arguments: '{}' } },
      { timestamp: at(2), type: 'response_item', payload: { type: 'function_call_output', call_id: 'call', output: '{"exit_code":1,"text":"first"}' } },
      { timestamp: at(3), type: 'response_item', payload: { type: 'function_call_output', call_id: 'call', output: '{"exit_code":0,"text":"second"}' } }
    ]));
    const events = result.trace.filter(event => event.kind === 'tool_result');
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ timestamp: at(2), outputExcerpt: '{"exit_code":1,"text":"first"}', resultStatus: 'failure', durationMs: { value: 1000 } });
    expect(events[1]).toMatchObject({ timestamp: at(3), outputExcerpt: '{"exit_code":0,"text":"second"}', resultStatus: 'success', durationMs: { value: 2000 } });
    expect(result.metrics.pairedToolDurationMs.value).toBe(1000);
    expect(result.metrics.toolCalls.value).toBe(1);
    expect(result.metrics.toolFailures.value).toBe(1);
  });

});
