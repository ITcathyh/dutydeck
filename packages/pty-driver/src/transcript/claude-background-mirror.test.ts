import { afterEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeBackgroundTasks } from './claude-background.js';
import { ClaudeTranscriptTailer } from './claude.js';
import type { TranscriptPosition } from './tail.js';

const agentId = 'agent-1';
const launchToolId = 'agent-launch';
const native = 'native-a';
const startedAt = Date.parse('2026-11-15T00:00:00.000Z');
const at = (second: number) => new Date(startedAt + second * 1000).toISOString();
const notificationText = (ids = [agentId], toolUseId = launchToolId) => `<task-notification>\n${ids.map(id => `<task-id>${id}</task-id>`).join('\n')}\n<tool-use-id>${toolUseId}</tool-use-id>\n<status>completed</status>\n<result>same generation result</result>\n</task-notification>`;
const queueNotice = (second: number, text = notificationText(), sessionId = native) => ({
  type: 'queue-operation', operation: 'enqueue', timestamp: at(second), sessionId, content: text,
});
const userNotice = (second: number, text = notificationText(), sessionId = native, uuid = `notice-${second}`) => ({
  type: 'user', uuid, timestamp: at(second), sessionId, turnOrigin: 'task_notification',
  message: { role: 'user', content: text },
});
const attachmentNotice = (second: number, text = notificationText(), sessionId = native) => ({
  type: 'attachment', uuid: `attachment-${second}`, timestamp: at(second), sessionId,
  attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: text },
});

let toolSequence = 0;
let positionSequence = 0;
const position = (path = 'main.jsonl'): TranscriptPosition => ({ path, offset: ++positionSequence, dev: 1, ino: 1, epoch: 0 });
function toolRecords(name: string, result: any, second: number, id = `tool-${++toolSequence}`, sessionId = native) {
  return [
    { type: 'assistant', uuid: `${id}-call`, timestamp: at(second), sessionId, message: { role: 'assistant', content: [{ type: 'tool_use', id, name }] } },
    { type: 'user', uuid: `${id}-result`, timestamp: at(second), sessionId, toolUseResult: result, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: '' }] } },
  ];
}
const launchRecords = (second = 0, id = agentId, toolUseId = launchToolId) => toolRecords('Agent', { isAsync: true, agentId: id }, second, toolUseId);
const resumeRecords = (second: number, id = agentId) => toolRecords('SendMessage', { success: true, resumedAgentId: id }, second);

function directFixture() {
  const tracker = new ClaudeBackgroundTasks();
  const feed = (entries: any[], path?: string) => {
    for (const entry of entries) tracker.observe(entry, position(path));
  };
  return { tracker, feed };
}

describe('ClaudeBackgroundTasks queue/user notification mirrors', () => {
  it('settles only one of two generations for the captured queue/user mirror', () => {
    const captured = readFileSync(new URL('../fixtures/claude-background-agent/transcript.jsonl', import.meta.url), 'utf8')
      .trim().split('\n').map(line => JSON.parse(line));
    const queue = { ...captured[8], timestamp: at(20) };
    const user = { ...captured[10], timestamp: at(30) };
    const id = /<task-id>([^<]+)/.exec(queue.content)![1]!;
    const toolUseId = /<tool-use-id>([^<]+)/.exec(queue.content)![1]!;
    const fixture = directFixture();
    fixture.feed(toolRecords('Agent', { isAsync: true, agentId: id }, 0, toolUseId, queue.sessionId));
    fixture.feed(toolRecords('SendMessage', { success: true, resumedAgentId: id }, 10, `resume-${id}`, queue.sessionId));
    expect(fixture.tracker.snapshot().count).toBe(1);
    fixture.feed([queue]);
    expect(fixture.tracker.snapshot().count).toBe(1);
    fixture.feed([user]);
    expect(fixture.tracker.snapshot().count).toBe(1);
  });

  it('does not let an old user mirror settle a generation started after its queue', () => {
    const fixture = directFixture();
    fixture.feed(launchRecords(0));
    fixture.feed([queueNotice(10)]);
    fixture.feed(resumeRecords(20));
    fixture.feed([userNotice(30)]);
    expect(fixture.tracker.snapshot().count).toBe(1);
  });

  it('consumes same-text queue slots in FIFO order without settling a third generation', () => {
    const fixture = directFixture();
    fixture.feed(launchRecords(0));
    fixture.feed(resumeRecords(10));
    fixture.feed([queueNotice(20), queueNotice(30)]);
    fixture.feed(resumeRecords(40));
    fixture.feed([userNotice(50), userNotice(60)]);
    expect(fixture.tracker.snapshot().count).toBe(1);
    fixture.feed([userNotice(70)]);
    expect(fixture.tracker.snapshot().count).toBe(0);
  });

  it('reserves a no-op slot for an old queue before its later user mirror', () => {
    const fixture = directFixture();
    fixture.feed(launchRecords(0));
    fixture.feed([queueNotice(10), userNotice(11)]);
    fixture.feed(resumeRecords(20));
    fixture.feed([queueNotice(10)]);
    expect(fixture.tracker.snapshot().count).toBe(1);
    fixture.feed([userNotice(30)]);
    expect(fixture.tracker.snapshot().count).toBe(1);
  });

  it('reserves a no-op slot when the queue has no active generation', () => {
    const fixture = directFixture();
    fixture.feed(launchRecords(0));
    fixture.feed([queueNotice(10), userNotice(11)]);
    fixture.feed([queueNotice(20)]);
    fixture.feed(resumeRecords(30));
    fixture.feed([userNotice(40)]);
    expect(fixture.tracker.snapshot().count).toBe(1);
  });

  it('reserves no-op slots for an unknown task and a mismatched tool use', () => {
    for (const mismatch of ['task', 'tool'] as const) {
      const fixture = directFixture();
      const text = notificationText([agentId], mismatch === 'tool' ? 'other-tool' : launchToolId);
      fixture.feed([queueNotice(0, text)]);
      fixture.feed(launchRecords(10, agentId, mismatch === 'tool' ? 'other-tool' : launchToolId));
      fixture.feed([userNotice(20, text)]);
      expect(fixture.tracker.snapshot().count).toBe(1);
    }
  });

  it.each(['queue', 'attachment'] as const)('settles only one generation for a %s-to-user mirror', source => {
    const fixture = directFixture();
    fixture.feed(launchRecords(0));
    fixture.feed(resumeRecords(10));
    const first = source === 'queue' ? queueNotice(20) : attachmentNotice(20);
    fixture.feed([first, userNotice(30)]);
    expect(fixture.tracker.snapshot().count).toBe(1);
  });

  it('settles only one generation for a queue-to-attachment mirror', () => {
    const fixture = directFixture();
    fixture.feed(launchRecords(0));
    fixture.feed(resumeRecords(10));
    fixture.feed([queueNotice(20), attachmentNotice(20)]);
    expect(fixture.tracker.snapshot().count).toBe(1);
  });

  it('settles only one generation for reverse user-to-queue records at one timestamp', () => {
    const fixture = directFixture();
    fixture.feed(launchRecords(0));
    fixture.feed(resumeRecords(10));
    fixture.feed([userNotice(20), queueNotice(20)]);
    expect(fixture.tracker.snapshot().count).toBe(1);
  });

  it('settles only one generation for reverse attachment-to-queue records', () => {
    const fixture = directFixture();
    fixture.feed(launchRecords(0));
    fixture.feed(resumeRecords(10));
    fixture.feed([attachmentNotice(20), queueNotice(20)]);
    expect(fixture.tracker.snapshot().count).toBe(1);
  });

  it('shares one occurrence across all three notification shapes', () => {
    const fixture = directFixture();
    fixture.feed(launchRecords(0));
    fixture.feed(resumeRecords(10));
    fixture.feed([queueNotice(20), attachmentNotice(20), userNotice(30)]);
    expect(fixture.tracker.snapshot().count).toBe(1);
  });

  it('filters same-position queue replay without adding another mirror slot', () => {
    const tracker = new ClaudeBackgroundTasks();
    const queuePosition = position();
    for (const entry of [...launchRecords(0), ...resumeRecords(10)]) tracker.observe(entry, position());
    const queue = queueNotice(20);
    tracker.observe(queue, queuePosition);
    tracker.observe(queue, queuePosition);
    tracker.observe(userNotice(30), position());
    expect(tracker.snapshot().count).toBe(1);
    tracker.observe(userNotice(40), position());
    expect(tracker.snapshot().count).toBe(0);
  });

  it('fingerprints a consumed user mirror so a changed-position replay cannot settle', () => {
    const fixture = directFixture();
    fixture.feed(launchRecords(0));
    fixture.feed(resumeRecords(10));
    const user = userNotice(30);
    fixture.feed([queueNotice(20), user]);
    expect(fixture.tracker.snapshot().count).toBe(1);
    fixture.feed([user]);
    expect(fixture.tracker.snapshot().count).toBe(1);
  });

  it('allows a later same-text notification after a unique cross-native mirror', () => {
    const fixture = directFixture();
    fixture.feed(launchRecords(0));
    fixture.feed(resumeRecords(10));
    fixture.feed([queueNotice(20)]);
    fixture.feed([userNotice(40, notificationText(), 'native-b')]);
    expect(fixture.tracker.snapshot().count).toBe(1);
    fixture.feed([userNotice(50)]);
    expect(fixture.tracker.snapshot().count).toBe(0);
  });

  it('creates and consumes independent slots for every task id in one notice', () => {
    const fixture = directFixture();
    const ids = ['agent-1', 'agent-2'];
    const text = notificationText(ids);
    for (const id of ids) fixture.feed(launchRecords(0, id));
    fixture.feed([queueNotice(10, text)]);
    for (const [index, id] of ids.entries()) fixture.feed(resumeRecords(20 + index, id));
    fixture.feed([userNotice(30, text)]);
    expect(fixture.tracker.snapshot().count).toBe(2);
  });

  it('keeps slots across business input and unrelated or nonterminal notices', () => {
    const fixture = directFixture();
    fixture.feed(launchRecords(0));
    fixture.feed(resumeRecords(10));
    fixture.feed([queueNotice(20)]);
    fixture.feed([{
      type: 'queue-operation', operation: 'enqueue', timestamp: at(24), sessionId: native,
      content: '<task-notification><task-id>unrelated</task-id><tool-use-id>other</tool-use-id><summary>progress</summary></task-notification>',
    }, {
      type: 'user', uuid: 'business-input', timestamp: at(25), sessionId: native,
      message: { role: 'user', content: 'continue with another request' },
    }]);
    fixture.feed([userNotice(30)]);
    expect(fixture.tracker.snapshot().count).toBe(1);
  });

  it('pairs old-format records without a shared native session or tool use id', () => {
    for (const missing of ['native', 'tool'] as const) {
      const fixture = directFixture();
      const text = missing === 'tool'
        ? '<task-notification><task-id>agent-1</task-id><status>completed</status><result>same generation result</result></task-notification>'
        : notificationText();
      fixture.feed(launchRecords(0));
      fixture.feed(resumeRecords(10));
      fixture.feed([queueNotice(20, text, missing === 'native' ? '' : native)]);
      fixture.feed([userNotice(30, text)]);
      expect(fixture.tracker.snapshot().count).toBe(1);
    }
  });

  it('pairs a known task across native sessions only when the owner candidate is unique', () => {
    const fixture = directFixture();
    fixture.feed(launchRecords(0));
    fixture.feed(resumeRecords(10));
    fixture.feed([queueNotice(20)]);
    fixture.feed([userNotice(30, notificationText(), 'native-b')]);
    expect(fixture.tracker.snapshot().count).toBe(1);
  });

  it('keeps an ambiguous cross-native candidate running instead of guessing a mirror', () => {
    const fixture = directFixture();
    fixture.feed(launchRecords(0));
    fixture.feed([queueNotice(20), queueNotice(21, notificationText(), 'native-b')]);
    fixture.feed(resumeRecords(30));
    fixture.feed([userNotice(40, notificationText(), 'native-c')]);
    expect(fixture.tracker.snapshot().count).toBe(1);
    fixture.feed([userNotice(50)]);
    expect(fixture.tracker.snapshot().count).toBe(1);
  });

  it('keeps settled evidence with its run across unrelated notification turnover', () => {
    const fixture = directFixture();
    fixture.feed(launchRecords(0));
    fixture.feed(resumeRecords(10));
    const replay = userNotice(30);
    fixture.feed([queueNotice(20), replay]);
    expect(fixture.tracker.snapshot().count).toBe(1);
    const unrelated = notificationText(['unrelated-task'], 'unrelated-tool');
    for (let index = 0; index < 20_001; index++) {
      fixture.feed([queueNotice(100 + index * 2, unrelated), userNotice(101 + index * 2, unrelated)]);
    }
    fixture.tracker.observe(replay, position('replayed.jsonl'));
    expect(fixture.tracker.snapshot().count).toBe(1);
  });

  it('retains prelaunch no-op evidence when unrelated unknown notices reach capacity', () => {
    const fixture = directFixture();
    const firstText = notificationText();
    fixture.feed([queueNotice(20, firstText)]);
    const unrelated = notificationText(['unrelated-task'], 'unrelated-tool');
    for (let index = 0; index < 20_001; index++) fixture.feed([queueNotice(25 + index, unrelated)]);
    fixture.feed(launchRecords(35));
    fixture.feed([userNotice(60, firstText)]);
    expect(fixture.tracker.snapshot().count).toBe(1);
  });

  it('does not permanently fence new user-only completions after unrelated overflow', () => {
    const fixture = directFixture();
    fixture.feed(launchRecords(0));
    fixture.feed(resumeRecords(10));
    const firstText = notificationText();
    fixture.feed([queueNotice(20, firstText)]);
    const unrelated = notificationText(['unrelated-task'], 'unrelated-tool');
    for (let index = 0; index < 20_001; index++) fixture.feed([queueNotice(25 + index, unrelated)]);
    fixture.feed([userNotice(30_000, firstText)]);
    expect(fixture.tracker.snapshot().count).toBe(1);

    const secondText = notificationText(['agent-2']);
    fixture.feed(launchRecords(35, 'agent-2'));
    fixture.feed([queueNotice(40, secondText)]);
    fixture.feed(resumeRecords(50, 'agent-2'));
    fixture.feed([userNotice(60, secondText), userNotice(70, secondText)]);
    expect(fixture.tracker.snapshot().tasks.find(task => task.id === 'agent-2')?.state).toBe('completed');

    fixture.feed(launchRecords(80, 'agent-3'));
    fixture.feed([userNotice(90, notificationText(['agent-3']))]);
    expect(fixture.tracker.snapshot().tasks.find(task => task.id === 'agent-3')?.state).toBe('completed');
  });
});

describe('ClaudeTranscriptTailer sibling notification mirrors', () => {
  let root: string | undefined;
  let tailer: ClaudeTranscriptTailer | undefined;
  afterEach(() => {
    tailer?.stop();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('shares queue/user mirror evidence with the sibling lifecycle path', async () => {
    root = mkdtempSync(join(tmpdir(), 'dd-bg-mirror-sibling-'));
    const main = join(root, 'main.jsonl');
    writeFileSync(main, '');
    tailer = new ClaudeTranscriptTailer({ cwd: root, transcriptPath: main, pollIntervalMs: 60_000 });
    tailer.start();
    const initial = [...launchRecords(0), ...resumeRecords(10),
      { type: 'system', subtype: 'turn_duration', uuid: 'main-duration', timestamp: at(15), sessionId: native }];
    appendFileSync(main, initial.map(entry => JSON.stringify(entry) + '\n').join(''));
    await tailer.flush();
    appendFileSync(main, JSON.stringify(queueNotice(20)) + '\n');
    await tailer.flush();
    expect(tailer.pendingBackgroundWork()).toBe(1);
    writeFileSync(join(root, 'after-clear.jsonl'), JSON.stringify(userNotice(30)) + '\n');
    await tailer.flush();
    expect(tailer.pendingBackgroundWork()).toBe(1);
  });

  it.each([
    { order: 'queue-first', siblingNative: 'native-b' },
    { order: 'user-first', siblingNative: native },
  ] as const)('keeps one resumed generation for $order sibling mirrors', async ({ order, siblingNative }) => {
    const captured = readFileSync(new URL('../fixtures/claude-background-agent/transcript.jsonl', import.meta.url), 'utf8')
      .trim().split('\n').map(line => JSON.parse(line));
    const launchCall = captured[4], launchResult = captured[5], queue = captured[8], user = captured[10];
    const id = /<task-id>([^<]+)/.exec(queue.content)![1]!;
    root = mkdtempSync(join(tmpdir(), 'dd-bg-mirror-order-'));
    const main = join(root, 'main.jsonl');
    const resume = toolRecords('SendMessage', { success: true, resumedAgentId: id }, 10, `resume-${id}`, queue.sessionId);
    for (const entry of resume) entry.timestamp = '2026-09-25T08:34:20.000Z';
    writeFileSync(main, [launchCall, launchResult, ...resume,
      { type: 'system', subtype: 'turn_duration', uuid: 'main-duration', timestamp: at(15), sessionId: queue.sessionId },
    ].map(entry => JSON.stringify(entry) + '\n').join(''));
    tailer = new ClaudeTranscriptTailer({ cwd: root, transcriptPath: main, pollIntervalMs: 60_000 });
    tailer.start();
    await tailer.flush();
    expect(tailer.pendingBackgroundWork()).toBe(1);

    const first = order === 'queue-first' ? queue : user;
    const second = order === 'queue-first' ? { ...user, sessionId: siblingNative } : queue;
    appendFileSync(main, JSON.stringify(first) + '\n');
    writeFileSync(join(root, 'after-clear.jsonl'), JSON.stringify(second) + '\n');
    await tailer.flush();
    expect(tailer.pendingBackgroundWork()).toBe(1);
  });
});
