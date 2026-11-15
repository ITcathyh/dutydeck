import { afterEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NormalizedDriverEvent } from '@dutydeck/shared';
import { ClaudeTranscriptTailer } from './claude.js';

const native = 'native-a';
const at = (second: number) => new Date(Date.parse('2026-11-15T00:00:00.000Z') + second * 1000).toISOString();
const noticeText = (id = 'agent-1', toolUseId = 'agent-launch') => `<task-notification><task-id>${id}</task-id>${toolUseId ? `<tool-use-id>${toolUseId}</tool-use-id>` : ''}<status>completed</status></task-notification>`;
const queueNotice = (id = 'agent-1', toolUseId = 'agent-launch') => ({ type: 'queue-operation', operation: 'enqueue', timestamp: at(20), sessionId: native, content: noticeText(id, toolUseId) });
const userNotice = (id = 'agent-1', toolUseId = 'agent-launch') => ({
  type: 'user', uuid: `notice-${id}`, timestamp: at(21), sessionId: native, turnOrigin: 'task_notification',
  message: { role: 'user', content: noticeText(id, toolUseId) },
});
const launchRecords = (id = 'agent-1', toolUseId = 'agent-launch', second = 10) => [
  { type: 'assistant', uuid: `${id}-call`, timestamp: at(second), sessionId: native, message: { role: 'assistant', content: [{ type: 'tool_use', id: toolUseId, name: 'Agent' }] } },
  { type: 'user', uuid: `${id}-result`, timestamp: at(second), sessionId: native, toolUseResult: { isAsync: true, agentId: id }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: '' }] } },
];

describe('ClaudeTranscriptTailer lifecycle-only sibling records', () => {
  let root: string | undefined;
  let tailer: ClaudeTranscriptTailer | undefined;
  let main: string;
  let sibling: string;
  let events: NormalizedDriverEvent[];

  afterEach(() => {
    tailer?.stop();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  async function setup(entries: any[] = []) {
    root = mkdtempSync(join(tmpdir(), 'dd-bg-sibling-lifecycle-'));
    main = join(root, 'main.jsonl');
    sibling = join(root, 'sibling.jsonl');
    writeFileSync(main, entries.map(entry => JSON.stringify(entry) + '\n').join(''));
    events = [];
    tailer = new ClaudeTranscriptTailer({ cwd: root, transcriptPath: main, pollIntervalMs: 60_000 });
    tailer.onEvent(event => events.push(event));
    tailer.start();
    await tailer.flush();
  }

  async function appendMain(...entries: any[]) {
    appendFileSync(main, entries.map(entry => JSON.stringify(entry) + '\n').join(''));
    await tailer!.flush();
  }

  async function appendSibling(...entries: any[]) {
    appendFileSync(sibling, entries.map(entry => JSON.stringify(entry) + '\n').join(''));
    await tailer!.flush();
  }

  it.each(['prompt', 'summary'] as const)('does not let a sibling %s reclaim main input ownership', async kind => {
    await setup([
      { type: 'user', uuid: 'main-input', timestamp: at(0), sessionId: native, turnOrigin: 'human', message: { role: 'user', content: 'wait for this child' } },
      ...launchRecords(),
    ]);
    await appendSibling({
      type: 'user', uuid: `sibling-${kind}`, timestamp: at(15), sessionId: native,
      ...(kind === 'summary' ? { isCompactSummary: true } : { turnOrigin: 'human' }),
      message: { role: 'user', content: `ordinary sibling ${kind} mentioning task-notification` },
    });
    await appendMain(userNotice(), {
      type: 'assistant', uuid: 'main-answer', parentUuid: 'notice-agent-1', timestamp: at(22), sessionId: native,
      message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'main answer' }] },
    });
    const answer = events.find(event => event.type === 'text' && event.data.text === 'main answer');
    expect(answer).toBeDefined();
    expect(answer?.data.origin).toBeUndefined();
  });

  it('does not let sibling assistant prose end the main turn', async () => {
    await setup(launchRecords());
    expect(tailer!.hasIndependentBackgroundWork()).toBe(false);
    await appendSibling({
      type: 'assistant', uuid: 'plain-sibling', timestamp: at(15), sessionId: native,
      message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'ordinary sibling answer' }] },
    });
    expect(tailer!.hasIndependentBackgroundWork()).toBe(false);
    await appendSibling({
      type: 'assistant', uuid: 'keyword-sibling', timestamp: at(16), sessionId: native,
      message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'ordinary prose mentioning task-notification' }] },
    });
    expect(tailer!.hasIndependentBackgroundWork()).toBe(false);
  });

  it('still accepts a valid known task notification with its tool use id', async () => {
    await setup([...launchRecords(), { type: 'system', subtype: 'turn_duration', uuid: 'duration', timestamp: at(11), sessionId: native }]);
    expect(tailer!.pendingBackgroundWork()).toBe(1);
    await appendSibling(userNotice());
    expect(tailer!.pendingBackgroundWork()).toBe(0);
  });

  it('ignores a sibling notification missing its tool use id', async () => {
    await setup([...launchRecords(), { type: 'system', subtype: 'turn_duration', uuid: 'duration', timestamp: at(11), sessionId: native }]);
    await appendSibling(queueNotice('agent-1', ''));
    expect(tailer!.pendingBackgroundWork()).toBe(1);
  });

  it('does not reserve mirror evidence for an unknown sibling task', async () => {
    await setup([...launchRecords(), { type: 'system', subtype: 'turn_duration', uuid: 'duration', timestamp: at(11), sessionId: native }]);
    await appendSibling(queueNotice('unknown-agent', 'unknown-tool'));
    await appendMain(...launchRecords('unknown-agent', 'unknown-tool', 25));
    await appendMain({ ...userNotice('unknown-agent', 'unknown-tool'), timestamp: at(30) });
    expect(tailer!.pendingBackgroundWork()).toBe(1);
    expect(events.filter(event => event.type === 'status').at(-1)?.data.tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'agent-1', state: 'running' }),
      expect.objectContaining({ id: 'unknown-agent', state: 'completed' }),
    ]));
  });
});
