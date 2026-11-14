import { afterEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeTranscriptTailer } from './claude.js';
import { ClaudeBackgroundTasks } from './claude-background.js';
import type { TranscriptPosition } from './tail.js';

const agentId = 'agent-1';
const at = (second: number | undefined) => second === undefined ? undefined : new Date(Date.parse('2026-11-11T20:00:00.000Z') + second * 1000).toISOString();
const position = (offset: number, path = 'main.jsonl'): TranscriptPosition => ({ path, offset, dev: 1, ino: 1, epoch: 0 });
let toolSequence = 0;

function toolRecords(name: string, result: any, second: number | undefined, id = `tool-${++toolSequence}`) {
  return [
    { type: 'assistant', uuid: `${id}-call`, timestamp: at(second), message: { role: 'assistant', content: [{ type: 'tool_use', id, name }] } },
    { type: 'user', uuid: `${id}-result`, timestamp: at(second), toolUseResult: result, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: '' }] } },
  ];
}
const launchRecords = (second: number | undefined = 0) => toolRecords('Agent', { isAsync: true, agentId }, second, 'agent-launch');
const resumeRecords = (second: number | undefined, field: 'resumedAgentId' | 'revivedAgentId' = 'resumedAgentId') =>
  toolRecords('SendMessage', { success: true, [field]: agentId }, second);
const noticeRecord = (second: number | undefined, toolUseId = 'agent-launch', result?: string) => ({
  type: 'queue-operation', operation: 'enqueue', timestamp: at(second),
  content: `<task-notification><task-id>${agentId}</task-id><tool-use-id>${toolUseId}</tool-use-id><status>completed</status>${result === undefined ? '' : `<result>${result}</result>`}</task-notification>`,
});
const mainEndRecords = (second: number) => [
  { type: 'assistant', uuid: `main-end-${second}`, timestamp: at(second), message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'waiting' }] } },
  { type: 'system', subtype: 'turn_duration', uuid: `main-duration-${second}`, timestamp: at(second) },
];
const jsonl = (entries: any[]) => entries.map(entry => JSON.stringify(entry) + '\n').join('');

function directFixture() {
  const tracker = new ClaudeBackgroundTasks();
  const positions = new Map<any, TranscriptPosition>();
  let offset = 0;
  const feed = (entries: any[]) => {
    for (const entry of entries) {
      const current = position(++offset);
      positions.set(entry, current);
      tracker.observe(entry, current);
    }
  };
  return { tracker, feed, replay: (entry: any) => tracker.observe(entry, positions.get(entry)) };
}

describe('ClaudeBackgroundTasks resumed agent generations', () => {
  it.each(['resumedAgentId', 'revivedAgentId'] as const)('counts a %s run until its own completion', field => {
    const fixture = directFixture();
    fixture.feed(launchRecords(0));
    expect(fixture.tracker.snapshot().count).toBe(1);
    fixture.feed([noticeRecord(10)]);
    expect(fixture.tracker.snapshot().count).toBe(0);
    fixture.feed(resumeRecords(20, field));
    expect(fixture.tracker.snapshot().count).toBe(1);
    expect(fixture.tracker.snapshot().tasks[0]).toMatchObject({ id: agentId, toolUseId: 'agent-launch', kind: 'agent', state: 'running' });
    fixture.feed([noticeRecord(30)]);
    expect(fixture.tracker.snapshot().count).toBe(0);
  });

  it('uses the notification timestamp rather than read order for a late old completion', () => {
    const fixture = directFixture();
    fixture.feed(launchRecords(0));
    fixture.feed([noticeRecord(10)]);
    fixture.feed(resumeRecords(20));
    fixture.feed([noticeRecord(10)]);
    expect(fixture.tracker.snapshot().count).toBe(1);
    fixture.feed([noticeRecord(30)]);
    expect(fixture.tracker.snapshot().count).toBe(0);
  });

  it('does not revive at the same timestamp as the latest completion', () => {
    const fixture = directFixture();
    fixture.feed(launchRecords(0));
    fixture.feed([noticeRecord(10)]);
    fixture.feed(resumeRecords(10));
    expect(fixture.tracker.snapshot().count).toBe(0);
  });

  it.each([{ stoppedAt: 10, resumedAt: undefined }, { stoppedAt: undefined, resumedAt: 20 }])(
    'does not guess a generation when a timestamp is missing: %j', ({ stoppedAt, resumedAt }) => {
      const fixture = directFixture();
      fixture.feed(launchRecords(0));
      fixture.feed([noticeRecord(stoppedAt)]);
      fixture.feed(resumeRecords(resumedAt));
      expect(fixture.tracker.snapshot().count).toBe(0);
    },
  );

  it('moves the current generation start on a second resume while work is still running', () => {
    const fixture = directFixture();
    fixture.feed(launchRecords(0));
    fixture.feed([noticeRecord(10)]);
    fixture.feed(resumeRecords(20));
    fixture.feed(resumeRecords(30));
    fixture.feed([noticeRecord(25)]);
    expect(fixture.tracker.snapshot().count).toBe(1);
    fixture.feed([noticeRecord(40)]);
    expect(fixture.tracker.snapshot().count).toBe(0);
  });

  it.each([{ label: 'missing', oldNoticeAt: undefined }, { label: 'equal to the new start', oldNoticeAt: 20 }])(
    'does not clear a resumed generation when an old completion has a $label timestamp', ({ oldNoticeAt }) => {
      const fixture = directFixture();
      fixture.feed(launchRecords(0));
      fixture.feed([noticeRecord(10)]);
      fixture.feed(resumeRecords(20));
      fixture.feed([noticeRecord(oldNoticeAt)]);
      expect(fixture.tracker.snapshot().count).toBe(1);
    },
  );

  it('settles an older active generation without clearing a newer one', () => {
    const fixture = directFixture();
    fixture.feed(launchRecords(0));
    fixture.feed([noticeRecord(10)]);
    fixture.feed(resumeRecords(20));
    fixture.feed(resumeRecords(30));
    fixture.feed([noticeRecord(35)]);
    expect(fixture.tracker.snapshot().count).toBe(1);
    fixture.feed([noticeRecord(40)]);
    expect(fixture.tracker.snapshot().count).toBe(0);
  });

  it('does not settle two generations for one completion replayed at a new position', () => {
    const fixture = directFixture();
    fixture.feed(launchRecords(0));
    fixture.feed([noticeRecord(10)]);
    fixture.feed(resumeRecords(20));
    fixture.feed(resumeRecords(30));
    const completion = noticeRecord(35);
    fixture.feed([completion]);
    expect(fixture.tracker.snapshot().count).toBe(1);
    fixture.tracker.observe(completion, position(1000));
    expect(fixture.tracker.snapshot().count).toBe(1);
    fixture.feed([noticeRecord(40)]);
    expect(fixture.tracker.snapshot().count).toBe(0);
  });

  it('stops every active generation on a successful TaskStop', () => {
    const fixture = directFixture();
    fixture.feed(launchRecords(0));
    fixture.feed([noticeRecord(10)]);
    fixture.feed(resumeRecords(20));
    fixture.feed(resumeRecords(30));
    expect(fixture.tracker.snapshot().count).toBe(1);
    const stoppedNotice = noticeRecord(40);
    stoppedNotice.content = stoppedNotice.content.replace('<status>completed</status>', '<status>stopped</status>');
    fixture.feed([stoppedNotice]);
    expect(fixture.tracker.snapshot().count).toBe(1);
    fixture.feed(toolRecords('TaskStop', { success: true, task_id: agentId, task_type: 'agent' }, 40));
    expect(fixture.tracker.snapshot().count).toBe(0);
    expect(fixture.tracker.snapshot().tasks[0]).toMatchObject({ id: agentId, state: 'stopped' });
  });

  it.each([0, undefined])('settles an initial generation with notification timestamp %s', noticeAt => {
    const fixture = directFixture();
    fixture.feed(launchRecords(0));
    fixture.feed([noticeRecord(noticeAt)]);
    expect(fixture.tracker.snapshot().count).toBe(0);
  });

  it('deduplicates same-generation notices and does not revive from an old resume replay', () => {
    const fixture = directFixture();
    fixture.feed(launchRecords(0));
    fixture.feed([noticeRecord(10)]);
    const resume = resumeRecords(20);
    fixture.feed(resume);
    fixture.feed([noticeRecord(30), noticeRecord(30)]);
    expect(fixture.tracker.snapshot().count).toBe(0);
    fixture.replay(resume[1]);
    fixture.feed(resumeRecords(20));
    expect(fixture.tracker.snapshot().count).toBe(0);
    fixture.feed(resumeRecords(40));
    expect(fixture.tracker.snapshot().count).toBe(1);
  });

  it('makes replay of the original launch position idempotent too', () => {
    const fixture = directFixture();
    const launch = launchRecords(0);
    fixture.feed(launch);
    fixture.feed([noticeRecord(10)]);
    fixture.replay(launch[0]);
    fixture.replay(launch[1]);
    expect(fixture.tracker.snapshot().count).toBe(0);
    expect(fixture.tracker.snapshot().tasks[0]?.state).toBe('completed');
  });

  it('does not treat a failed SendMessage result as a launch receipt', () => {
    const fixture = directFixture();
    fixture.feed(launchRecords(0));
    fixture.feed([noticeRecord(10)]);
    fixture.feed(toolRecords('SendMessage', { success: false, resumedAgentId: agentId }, 20));
    expect(fixture.tracker.snapshot().count).toBe(0);
  });
});

describe('ClaudeTranscriptTailer resumed agent recovery', () => {
  let root: string | undefined;
  let tailer: ClaudeTranscriptTailer | undefined;
  afterEach(() => {
    tailer?.stop();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('restores a resumed run, then does not revive it when baseline replays its later completion', async () => {
    root = mkdtempSync(join(tmpdir(), 'dd-bg-resume-restore-'));
    const path = join(root, 'main.jsonl');
    const running = [...launchRecords(0), noticeRecord(10), ...resumeRecords(20), ...mainEndRecords(21)];
    writeFileSync(path, jsonl(running));
    tailer = new ClaudeTranscriptTailer({ cwd: root, transcriptPath: path });
    tailer.restore({ path, offset: Buffer.byteLength(jsonl(running)) });
    tailer.start();
    await tailer.flush();
    expect(tailer.pendingBackgroundWork()).toBe(1);

    appendFileSync(path, jsonl([noticeRecord(30)]));
    await tailer.flush();
    expect(tailer.pendingBackgroundWork()).toBe(0);
    tailer.stop();

    const complete = [...running, noticeRecord(30)];
    tailer = new ClaudeTranscriptTailer({ cwd: root, transcriptPath: path });
    tailer.restore({ path, offset: Buffer.byteLength(jsonl(complete)) });
    tailer.start();
    await tailer.flush();
    expect(tailer.pendingBackgroundWork()).toBe(0);
  });

  it('keeps a sibling completion with its own timestamp and source position', async () => {
    root = mkdtempSync(join(tmpdir(), 'dd-bg-resume-sibling-'));
    const path = join(root, 'main.jsonl');
    writeFileSync(path, jsonl([...launchRecords(0), noticeRecord(10), ...resumeRecords(20), ...mainEndRecords(21)]));
    tailer = new ClaudeTranscriptTailer({ cwd: root, transcriptPath: path });
    await tailer.flush();
    expect(tailer.pendingBackgroundWork()).toBe(1);

    const sibling = join(root, 'after-clear.jsonl');
    const oldNotice = {
      type: 'attachment', uuid: 'late-old-notice', timestamp: at(10),
      attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: noticeRecord(10).content },
    };
    writeFileSync(sibling, jsonl([oldNotice]));
    await tailer.flush();
    expect(tailer.pendingBackgroundWork()).toBe(1);

    appendFileSync(sibling, jsonl([noticeRecord(30)]));
    await tailer.flush();
    expect(tailer.pendingBackgroundWork()).toBe(0);
  });

  it('settles distinct same-timestamp results but not a mirrored completion replay', async () => {
    root = mkdtempSync(join(tmpdir(), 'dd-bg-resume-distinct-results-'));
    const path = join(root, 'main.jsonl');
    const running = [...launchRecords(0), noticeRecord(10), ...resumeRecords(20), ...resumeRecords(30), ...mainEndRecords(31)];
    writeFileSync(path, jsonl(running));
    tailer = new ClaudeTranscriptTailer({ cwd: root, transcriptPath: path });
    await tailer.flush();
    expect(tailer.pendingBackgroundWork()).toBe(1);

    const first = noticeRecord(35, 'agent-launch', 'first generation result');
    appendFileSync(path, jsonl([first]));
    await tailer.flush();
    expect(tailer.pendingBackgroundWork()).toBe(1);

    const sibling = join(root, 'after-clear.jsonl');
    writeFileSync(sibling, jsonl([first]));
    await tailer.flush();
    expect(tailer.pendingBackgroundWork()).toBe(1);

    appendFileSync(sibling, jsonl([noticeRecord(35, 'agent-launch', 'second generation result')]));
    await tailer.flush();
    expect(tailer.pendingBackgroundWork()).toBe(0);
  });
});
