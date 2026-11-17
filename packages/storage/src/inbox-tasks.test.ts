import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createRepositories } from './index.js';

it('reads every inbox task as six fields with full prompts, stable ties and external commits', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'inbox-tasks-')), path = join(directory, 'test.db');
  const reader = createRepositories(path), writer = createRepositories(path);
  const at = '2026-11-01T00:00:00.000Z', later = '2026-11-01T00:01:00.000Z';
  const prompt = '开始🙂\n第二行：é\n第三行\t结束';
  try {
    await writer.tasks.save({ id: 'first', sessionId: 's', prompt, status: 'completed', createdAt: at, updatedAt: at, executionContext: { agentPrompt: 'private context' } });
    await writer.tasks.save({ id: 'second', sessionId: 's', prompt: '', status: 'cancelled', createdAt: at, updatedAt: later });
    await writer.tasks.save({ id: 'third', sessionId: 's', prompt: '排队', status: 'queued', createdAt: later, updatedAt: later });
    await writer.tasks.save({ id: 'other', sessionId: 'other', prompt: 'other', status: 'completed', createdAt: at, updatedAt: at });
    const prepare = vi.spyOn(Database.prototype, 'prepare');
    try {
      const expected = [
        { id: 'first', sessionId: 's', prompt, status: 'completed', createdAt: at, updatedAt: at },
        { id: 'second', sessionId: 's', prompt: '', status: 'cancelled', createdAt: at, updatedAt: later },
        { id: 'third', sessionId: 's', prompt: '排队', status: 'queued', createdAt: later, updatedAt: later }
      ];
      expect(await reader.tasks.getInboxTasks!('s')).toEqual(expected);
      expect(await reader.tasks.getInboxTasks!('missing')).toEqual([]);
      const index = prepare.mock.calls.findIndex(([query]) => String(query).includes('FROM tasks WHERE session_id=? ORDER BY created_at'));
      expect(index).toBeGreaterThanOrEqual(0);
      const query = String(prepare.mock.calls[index]![0]);
      expect(query).toContain('SELECT id,session_id AS sessionId,prompt,status,created_at AS createdAt,updated_at AS updatedAt');
      expect(query).not.toContain('execution_context');
      expect(query).not.toMatch(/LIMIT/i);
      await writer.tasks.save({ id: 'external', sessionId: 's', prompt: '外部🙂\n提交', status: 'failed', createdAt: '2026-10-31T00:00:00.000Z', updatedAt: later });
      expect(await reader.tasks.getInboxTasks!('s')).toEqual([
        { id: 'external', sessionId: 's', prompt: '外部🙂\n提交', status: 'failed', createdAt: '2026-10-31T00:00:00.000Z', updatedAt: later },
        ...expected
      ]);
    } finally { prepare.mockRestore(); }
  } finally { reader.close(); writer.close(); rmSync(directory, { recursive: true, force: true }); }
});
