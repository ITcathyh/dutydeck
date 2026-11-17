import { afterEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeBackgroundTasks } from './claude-background.js';
import { ClaudeTranscriptTailer } from './claude.js';
import type { TranscriptPosition } from './tail.js';

const at = (second: number) => new Date(Date.parse('2026-11-15T00:00:00.000Z') + second * 1000).toISOString();
const position = (offset: number, fields: Partial<TranscriptPosition> = {}): TranscriptPosition => ({
  path: 'main.jsonl', dev: 1, ino: 1, epoch: 0, offset, ...fields,
});
const launchRecords = (id = 'agent-1', toolUseId = 'agent-launch') => [
  { type: 'assistant', uuid: `${id}-call`, timestamp: at(0), message: { role: 'assistant', content: [{ type: 'tool_use', id: toolUseId, name: 'Agent' }] } },
  { type: 'user', uuid: `${id}-result`, timestamp: at(0), toolUseResult: { isAsync: true, agentId: id }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: '' }] } },
];
const noticeRecord = (id = 'agent-1', toolUseId = 'agent-launch', second = 2) => ({
  type: 'user', uuid: `notice-${id}`, timestamp: at(second), turnOrigin: 'task_notification',
  message: { role: 'user', content: `<task-notification><task-id>${id}</task-id><tool-use-id>${toolUseId}</tool-use-id><status>completed</status></task-notification>` },
});
const mainEnd = { type: 'system', subtype: 'turn_duration', uuid: 'main-duration', timestamp: at(1) };
const jsonl = (entries: any[]) => entries.map(entry => JSON.stringify(entry) + '\n').join('');

const fixtureLines = readFileSync(new URL('../fixtures/claude-background-tasks/before-clear.jsonl', import.meta.url), 'utf8').trim().split('\n');
let fixtureOffset = 0;
const fixtureRecords = fixtureLines.map(line => {
  const current = position(fixtureOffset);
  fixtureOffset += Buffer.byteLength(line) + 1;
  return { entry: JSON.parse(line), position: current };
});

function observeFixture(live: boolean, replay: boolean) {
  const tracker = new ClaudeBackgroundTasks();
  const changed: boolean[] = [], snapshots: unknown[] = [], events: unknown[] = [];
  const feed = ({ entry, position }: typeof fixtureRecords[number]) => {
    const didChange = tracker.observe(entry, position);
    const snapshot = tracker.snapshot();
    changed.push(didChange);
    snapshots.push(snapshot);
    if (didChange) events.push({ type: 'status', data: snapshot });
  };
  for (const record of live ? fixtureRecords.slice(0, 7) : fixtureRecords) feed(record);
  if (live) for (const record of fixtureRecords.slice(7)) feed(record);
  if (replay) for (const record of fixtureRecords) feed(record);
  return { changed, snapshots, events };
}

describe('ClaudeBackgroundTasks bounded position keys', () => {
  it('preserves real-fixture changes, snapshots and events for baseline, live and replay', () => {
    const baseline = observeFixture(false, false);
    expect(observeFixture(true, false)).toEqual(baseline);
    const replay = observeFixture(true, true);
    expect(replay.changed.slice(0, fixtureRecords.length)).toEqual(baseline.changed);
    expect(replay.snapshots.slice(0, fixtureRecords.length)).toEqual(baseline.snapshots);
    expect(replay.changed.slice(fixtureRecords.length)).toEqual(fixtureRecords.map(() => false));
    expect(replay.snapshots.slice(fixtureRecords.length)).toEqual(fixtureRecords.map(() => baseline.snapshots.at(-1)));
    expect(replay.events).toEqual(baseline.events);
  });

  it.each([
    { label: 'path', fields: { path: 'other.jsonl' } },
    { label: 'device', fields: { dev: 2 } },
    { label: 'inode', fields: { ino: 2 } },
    { label: 'epoch', fields: { epoch: 1 } },
  ])('deduplicates a main replay and accepts a different $label', ({ fields }) => {
    const tracker = new ClaudeBackgroundTasks();
    const launch = launchRecords();
    const positions = [position(0), position(1)];
    tracker.observe(launch[0], positions[0]);
    tracker.observe(launch[1], positions[1]);
    tracker.observe(noticeRecord(), position(2));
    expect(tracker.snapshot().count).toBe(0);
    tracker.observe(launch[0], positions[0]);
    tracker.observe(launch[1], positions[1]);
    expect(tracker.snapshot().count).toBe(0);
    tracker.observe(launch[0], position(0, fields));
    tracker.observe(launch[1], position(1, fields));
    expect(tracker.snapshot().count).toBe(1);
  });

  it('keeps no-position records outside position deduplication', () => {
    const tracker = new ClaudeBackgroundTasks();
    for (const entry of [...launchRecords(), noticeRecord()]) tracker.observe(entry);
    expect(tracker.snapshot().count).toBe(0);
    for (const entry of launchRecords()) tracker.observe(entry);
    expect(tracker.snapshot().count).toBe(1);
  });

  it('keeps sibling content hashing independent from the main namespace', () => {
    const tracker = new ClaudeBackgroundTasks();
    const shared = position(1, { path: 'sibling.jsonl', dev: 2, ino: 2 });
    const firstLaunch = launchRecords();
    tracker.observe(firstLaunch[0], position(0));
    tracker.observe(firstLaunch[1], shared);
    for (const entry of launchRecords('agent-2', 'agent-launch-2')) tracker.observe(entry);
    const first = noticeRecord('agent-1', 'agent-launch', 10);
    expect(tracker.observeLifecycle(first, shared)).toBe(true);
    expect(tracker.snapshot().count).toBe(1);
    expect(tracker.observeLifecycle(first, shared)).toBe(false);
    expect(tracker.snapshot().count).toBe(1);
    expect(tracker.observeLifecycle(noticeRecord('agent-2', 'agent-launch-2', 11), shared)).toBe(true);
    expect(tracker.snapshot().count).toBe(0);
  });
});

describe('ClaudeTranscriptTailer main-file position epochs', () => {
  let root: string | undefined;
  let tailer: ClaudeTranscriptTailer | undefined;
  afterEach(() => {
    tailer?.stop();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('accepts the same launch and notice offsets after detected truncation', async () => {
    root = mkdtempSync(join(tmpdir(), 'dd-bg-position-epoch-'));
    const path = join(root, 'main.jsonl');
    const running = [...launchRecords(), mainEnd];
    const notice = noticeRecord();
    writeFileSync(path, jsonl([...running, notice]));
    tailer = new ClaudeTranscriptTailer({ cwd: root, transcriptPath: path, pollIntervalMs: 60_000 });
    await tailer.flush();
    expect(tailer.pendingBackgroundWork()).toBe(0);

    writeFileSync(path, '');
    await tailer.flush();
    writeFileSync(path, jsonl(running));
    await tailer.flush();
    expect(tailer.pendingBackgroundWork()).toBe(1);
    // Same-width timestamp: this is a new notification at the original offset.
    appendFileSync(path, jsonl([noticeRecord('agent-1', 'agent-launch', 3)]));
    await tailer.flush();
    expect(tailer.pendingBackgroundWork()).toBe(0);
  });
});
