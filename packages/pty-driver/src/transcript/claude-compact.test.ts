import { afterEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NormalizedDriverEvent } from '@dutydeck/shared';
import { ClaudeTranscriptTailer } from './claude.js';

const sessionId = '11111111-1111-4111-8111-111111111111';
const promptId = '22222222-2222-4222-8222-222222222222';
const successFixture = readFileSync(new URL('./fixtures/claude-compact-2.1.220.jsonl', import.meta.url), 'utf8').trim().split('\n').map(line => JSON.parse(line));
const emptyFixture = readFileSync(new URL('./fixtures/claude-compact-empty-2.1.220.jsonl', import.meta.url), 'utf8').trim().split('\n').map(line => JSON.parse(line));
const clone = <T>(value: T): T => structuredClone(value);

function successfulSequence(id = promptId, native = sessionId, suffix = 'current') {
  const [, input, boundary, summary] = clone(successFixture);
  input.parentUuid = `leaf-${suffix}`;
  input.uuid = `input-${suffix}`;
  input.promptId = id;
  input.sessionId = native;
  input.timestamp = new Date().toISOString();
  boundary.logicalParentUuid = input.parentUuid;
  boundary.uuid = `boundary-${suffix}`;
  boundary.sessionId = native;
  summary.parentUuid = boundary.uuid;
  summary.uuid = `summary-${suffix}`;
  summary.promptId = id;
  summary.sessionId = summary.session_id = native;
  return [input, boundary, summary];
}

function emptySequence(id = promptId, native = sessionId, suffix = 'empty') {
  const [, input, command, failure] = clone(emptyFixture);
  input.parentUuid = `leaf-${suffix}`;
  input.uuid = `input-${suffix}`;
  input.promptId = id;
  input.sessionId = native;
  input.timestamp = new Date().toISOString();
  command.parentUuid = input.uuid;
  command.uuid = `command-${suffix}`;
  command.promptId = id;
  command.sessionId = command.session_id = native;
  failure.parentUuid = command.uuid;
  failure.uuid = `failure-${suffix}`;
  failure.sessionId = failure.session_id = native;
  return [input, command, failure];
}

describe('Claude maintenance compaction evidence', () => {
  let directory: string | undefined;
  let tailer: ClaudeTranscriptTailer | undefined;
  let file: string;
  let events: NormalizedDriverEvent[];
  let generation: number;

  afterEach(() => {
    tailer?.stop();
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = undefined;
    tailer = undefined;
  });

  async function setup(baseline: unknown[] = []) {
    directory = mkdtempSync(join(tmpdir(), 'dd-claude-compact-'));
    file = join(directory, 'session.jsonl');
    writeFileSync(file, baseline.map(entry => JSON.stringify(entry) + '\n').join(''));
    events = [];
    generation = 0;
    tailer = new ClaudeTranscriptTailer({ cwd: directory, transcriptPath: file, pollIntervalMs: 60_000 });
    tailer.onEvent(event => events.push(event));
    tailer.start();
    await tailer.flush();
  }

  function arm(native = sessionId, submitted: () => boolean = () => false) {
    const controller = new AbortController();
    const pending = tailer!.waitForCompaction!({
      nativeSessionId: native,
      position: tailer!.captureWatermark!(),
      generation: ++generation,
      signal: controller.signal,
      submitted,
    });
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    void pending.catch(() => {});
    return { pending, controller, settled: () => settled };
  }

  async function append(...entries: unknown[]) {
    appendFileSync(file, entries.map(entry => JSON.stringify(entry) + '\n').join(''));
    await tailer!.flush();
  }

  it('requires the real input, same-session manual boundary, and same-prompt compact summary', async () => {
    await setup([clone(successFixture[0])]);
    const current = arm();
    await append(...successfulSequence());
    await expect(current.pending).resolves.toBe('completed');
    expect(events.filter(event => event.type === 'completed')).toHaveLength(0);
    expect(events.filter(event => event.data?.state === 'compaction').map(event => event.data.phase)).toEqual(['completed']);
  });

  it('returns explicit failure for the real empty-context command result', async () => {
    await setup([clone(emptyFixture[0])]);
    const current = arm();
    await append(...emptySequence());
    await expect(current.pending).resolves.toBe('failed');
    expect(events.filter(event => event.type === 'completed')).toHaveLength(0);
  });

  it('does not accept a replayed baseline input, boundary and summary', async () => {
    await setup([clone(successFixture[0]), ...successfulSequence('old-prompt', sessionId, 'old')]);
    const current = arm();
    const replay = successfulSequence('old-prompt', sessionId, 'old');
    await append(...replay);
    expect(current.settled()).toBe(false);
    current.controller.abort();
    await expect(current.pending).rejects.toThrow();
  });

  it('does not accept spontaneous compaction even when its summary reuses the prompt id', async () => {
    await setup([clone(successFixture[0])]);
    const current = arm();
    const [input, boundary, summary] = successfulSequence();
    boundary.compactMetadata.trigger = 'auto';
    await append(input, boundary, summary);
    expect(current.settled()).toBe(false);
    current.controller.abort();
    await expect(current.pending).rejects.toThrow();
  });

  it.each(['promptId', 'uuid'] as const)('fails immediately when the compact input is missing %s', async missing => {
    await setup([clone(successFixture[0])]);
    const current = arm();
    const [input] = successfulSequence();
    delete input[missing];
    await append(input);
    await expect(current.pending).resolves.toBe('failed');
    expect(current.settled()).toBe(true);
  });

  it('ignores another native session and fails immediately on a later business turn', async () => {
    await setup([clone(successFixture[0])]);
    const foreign = arm();
    await append(...successfulSequence(promptId, 'other-native-session', 'foreign'));
    expect(foreign.settled()).toBe(false);
    foreign.controller.abort();
    await expect(foreign.pending).rejects.toThrow();

    await append({ type: 'mode', mode: 'normal', sessionId, uuid: 'current-leaf', timestamp: new Date().toISOString() });
    const current = arm();
    const [input, boundary, summary] = successfulSequence(promptId, sessionId, 'next');
    await append(input,
      { type: 'user', uuid: 'next-business', parentUuid: input.uuid, promptId: 'next-business-prompt', sessionId, timestamp: new Date().toISOString(), message: { role: 'user', content: 'next business prompt' } },
      boundary, summary);
    await expect(current.pending).resolves.toBe('failed');
    expect(current.settled()).toBe(true);
  });

  it('does not let a late previous-generation boundary complete the next generation', async () => {
    await setup([clone(successFixture[0])]);
    const first = arm();
    const [firstInput, firstBoundary, firstSummary] = successfulSequence('first-prompt', sessionId, 'first');
    await append(firstInput);
    first.controller.abort();
    await expect(first.pending).rejects.toThrow();

    const second = arm();
    await append(firstBoundary, firstSummary);
    expect(second.settled()).toBe(false);
    await append(...successfulSequence('second-prompt', sessionId, 'second'));
    await expect(second.pending).resolves.toBe('completed');
  });

  it('keeps the current boundary valid when an older boundary and summary arrive later', async () => {
    await setup([clone(successFixture[0])]);
    const previous = successfulSequence('previous-prompt', sessionId, 'previous-late');
    const currentSequence = successfulSequence('current-prompt', sessionId, 'current-boundary');
    previous[0].parentUuid = currentSequence[0].parentUuid;
    previous[1].logicalParentUuid = currentSequence[0].parentUuid;
    const first = arm();
    await append(previous[0]);
    first.controller.abort();
    await expect(first.pending).rejects.toThrow();

    const current = arm();
    await append(currentSequence[0], currentSequence[1]);
    await append(previous[1], previous[2]);
    expect(current.settled()).toBe(false);
    await append(currentSequence[2]);
    expect(current.settled()).toBe(true);
    await expect(current.pending).resolves.toBe('completed');
  });

  it('does not let a replayed previous-generation input, boundary and summary complete the next generation', async () => {
    await setup([clone(successFixture[0])]);
    const first = arm();
    const previous = successfulSequence('first-prompt', sessionId, 'first');
    await append(previous[0]);
    first.controller.abort();
    await expect(first.pending).rejects.toThrow();

    const second = arm();
    await append(...previous);
    expect(second.settled()).toBe(false);
    await append(...successfulSequence('second-prompt', sessionId, 'second'));
    await expect(second.pending).resolves.toBe('completed');
  });

  it('rejects a pending generation on reconnect and ignores its late records after rearming', async () => {
    await setup([clone(successFixture[0])]);
    const first = arm();
    const [input, boundary, summary] = successfulSequence('reconnect-prompt', sessionId, 'reconnect');
    await append(input);
    tailer!.stop();
    await expect(first.pending).rejects.toThrow();

    tailer = new ClaudeTranscriptTailer({ cwd: directory!, transcriptPath: file, pollIntervalMs: 60_000 });
    events = [];
    tailer.onEvent(event => events.push(event));
    tailer.start();
    await tailer.flush();
    const second = arm();
    await append(boundary, summary);
    expect(second.settled()).toBe(false);
    second.controller.abort();
    await expect(second.pending).rejects.toThrow();
  });

  it('reserves a late first input chain for the submitted generation that retired unobserved', async () => {
    await setup([clone(successFixture[0])]);
    const first = arm(sessionId, () => true);
    const late = successfulSequence('first-prompt', sessionId, 'first-unobserved');
    late[0].timestamp = new Date(Date.now() - 10).toISOString();
    first.controller.abort();
    await expect(first.pending).rejects.toThrow();

    const second = arm();
    await append(...late);
    expect(second.settled()).toBe(false);
    await append(...successfulSequence('second-prompt', sessionId, 'second-observed'));
    await expect(second.pending).resolves.toBe('completed');
  });

  it('does not reserve the next input for a generation cancelled before submission', async () => {
    await setup([clone(successFixture[0])]);
    const first = arm();
    first.controller.abort();
    await expect(first.pending).rejects.toThrow();

    const second = arm();
    await append(...successfulSequence('second-prompt', sessionId, 'second-after-prewrite-cancel'));
    await expect(second.pending).resolves.toBe('completed');
  });

  it('ignores an explicit failure belonging to another prompt', async () => {
    await setup([clone(emptyFixture[0])]);
    const current = arm();
    const [input, , failure] = emptySequence();
    failure.parentUuid = 'some-other-command';
    await append(input, failure);
    expect(current.settled()).toBe(false);
    current.controller.abort();
    await expect(current.pending).rejects.toThrow();
  });

  it.each([
    { stage: 'input', reason: undefined },
    { stage: 'boundary', reason: new DOMException('Compaction maintenance timed out', 'TimeoutError') },
  ])('keeps late records from a retired $stage-observed generation away from the active one', async ({ stage, reason }) => {
    await setup([clone(successFixture[0])]);
    const first = arm(sessionId, () => true);
    const previous = successfulSequence('retired-prompt', sessionId, `retired-${stage}`);
    await append(previous[0]);
    if (stage === 'boundary') await append(previous[1]);
    first.controller.abort(reason);
    await expect(first.pending).rejects.toThrow();

    const current = arm();
    const command = clone(emptyFixture[2]);
    command.parentUuid = previous[0].uuid;
    command.uuid = `retired-command-${stage}`;
    command.promptId = 'retired-prompt';
    command.sessionId = command.session_id = sessionId;
    command.timestamp = new Date().toISOString();
    const local = clone(emptyFixture[3]);
    local.parentUuid = command.uuid;
    local.uuid = `retired-local-${stage}`;
    local.sessionId = local.session_id = sessionId;
    await append(command, local, previous[1], previous[2], previous[2]);
    expect(current.settled()).toBe(false);

    await append(...successfulSequence('active-prompt', sessionId, `active-${stage}`));
    expect(current.settled()).toBe(true);
    await expect(current.pending).resolves.toBe('completed');
    await expect(first.pending).rejects.toThrow();
  });

  it('does not transfer a retired summary prompt into a generation without its own input', async () => {
    await setup([clone(successFixture[0])]);
    const first = arm(sessionId, () => true);
    const previous = successfulSequence('retired-summary-prompt', sessionId, 'retired-summary');
    previous[0].timestamp = new Date(Date.now() - 10).toISOString();
    first.controller.abort();
    await expect(first.pending).rejects.toThrow();

    const current = arm();
    await append(previous[0], previous[1]);
    previous[2].promptId = 'different-summary-prompt';
    await append(previous[2], previous[2]);
    expect(current.settled()).toBe(false);
    await append(...successfulSequence('own-active-prompt', sessionId, 'own-active'));
    expect(current.settled()).toBe(true);
    await expect(current.pending).resolves.toBe('completed');
  });

  it('uses transcript time to give the active generation its own input before a late retired chain', async () => {
    await setup([clone(successFixture[0])]);
    const first = arm(sessionId, () => true);
    const previous = successfulSequence('older-retired-prompt', sessionId, 'older-retired');
    previous[0].timestamp = new Date(Date.now() - 10).toISOString();
    first.controller.abort();
    await expect(first.pending).rejects.toThrow();

    const current = arm();
    const own = successfulSequence('newer-active-prompt', sessionId, 'newer-active');
    own[0].timestamp = new Date(Date.now() + 10).toISOString();
    await append(own[0]);
    await append(...previous);
    expect(current.settled()).toBe(false);
    await append(own[1], own[2]);
    expect(current.settled()).toBe(true);
    await expect(current.pending).resolves.toBe('completed');
  });

  it('leaves a normal business prompt outside the retired compact chain', async () => {
    await setup([clone(successFixture[0])]);
    const first = arm(sessionId, () => true);
    const previous = successfulSequence('retired-before-business', sessionId, 'retired-before-business');
    await append(previous[0]);
    first.controller.abort();
    await expect(first.pending).rejects.toThrow();

    const current = arm();
    await append({ type: 'user', uuid: 'ordinary-business', parentUuid: previous[0].uuid, promptId: 'ordinary-business-prompt', sessionId, timestamp: new Date().toISOString(), message: { role: 'user', content: 'ordinary business prompt' } });
    await expect(current.pending).resolves.toBe('failed');
    const next = arm();
    await append(...successfulSequence('after-business', sessionId, 'after-business'));
    await expect(next.pending).resolves.toBe('completed');
  });
});
