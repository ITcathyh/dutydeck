import { afterEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeTranscriptTailer, claudePendingBackgroundWork } from './claude.js';

// Verbatim records from a Claude Code 2.1.280 session that launched one
// background Agent; see driver-background.test.ts for how it was captured.
const records = readFileSync(new URL('../fixtures/claude-background-agent/transcript.jsonl', import.meta.url), 'utf8')
  .trimEnd().split('\n');

describe('claudePendingBackgroundWork', () => {
  it('reads the pending count only from main-thread turn_duration records', () => {
    const counts = records.map(line => claudePendingBackgroundWork(JSON.parse(line)));
    // Turn 1 ends with nothing pending, turn 2 while its agent runs, then the
    // follow-up turn the completion notification started.
    expect(counts.filter(count => count !== undefined)).toEqual([0, 1, 0]);
    const pending = JSON.parse(records.find(line => line.includes('"pendingBackgroundAgentCount"'))!);
    expect(claudePendingBackgroundWork({ ...pending, isSidechain: true })).toBeUndefined();
    expect(claudePendingBackgroundWork({ ...pending, subtype: 'compact_boundary' })).toBeUndefined();
    expect(claudePendingBackgroundWork({ ...pending, pendingWorkflowCount: 2 })).toBe(3);
    expect(claudePendingBackgroundWork({ ...pending, pendingBackgroundAgentCount: '1' })).toBe(0);
  });
});

describe('ClaudeTranscriptTailer background work', () => {
  let directory: string | undefined;
  afterEach(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });

  it('reports what the latest turn ended with until a new prompt resets it', () => {
    directory = mkdtempSync(join(tmpdir(), 'dutydeck-claude-background-'));
    const path = join(directory, 'session.jsonl');
    writeFileSync(path, '');
    const tailer = new ClaudeTranscriptTailer({ cwd: directory, transcriptPath: path });
    const append = (lines: string[]) => { appendFileSync(path, lines.map(line => `${line}\n`).join('')); tailer.flush(); };
    const pendingAt = records.findIndex(line => line.includes('"pendingBackgroundAgentCount"'));
    tailer.start();
    try {
      append(records.slice(0, pendingAt));
      expect(tailer.pendingBackgroundWork()).toBe(0);
      append([records[pendingAt]!]);
      expect(tailer.pendingBackgroundWork()).toBe(1);
      tailer.resetBackgroundWork();
      expect(tailer.pendingBackgroundWork()).toBe(0);
      append([records[pendingAt]!]);
      append(records.slice(pendingAt + 1));
      expect(tailer.pendingBackgroundWork()).toBe(0);
    } finally {
      tailer.stop();
    }
  });
});
