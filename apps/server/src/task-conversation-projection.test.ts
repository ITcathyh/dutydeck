import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { DutydeckRuntime } from '@dutydeck/runtime';
import { createRepositories } from '@dutydeck/storage';
import type { AgentEvent } from '@dutydeck/shared';
import { registerTaskRoutes, taskConversation } from './task-routes.js';

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); vi.restoreAllMocks(); });
const at = (sequence: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, 0, sequence * 1000)).toISOString();
const event = (sessionId: string, sequence: number, type: AgentEvent['type'], data: unknown, taskId?: string, raw?: string): AgentEvent => ({
  id: `${sessionId}-${sequence}`, sessionId, sequence, type, timestamp: at(sequence), data, ...(taskId === undefined ? {} : { taskId }), ...(raw === undefined ? {} : { raw })
});

it('keeps task conversation JSON byte-identical to the full event fallback', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'task-conversation-')); directories.push(directory);
  const path = join(directory, 'test.db'), writer = createRepositories(path), reader = createRepositories(path), sessionId = 's';
  try {
    await writer.tasks.save({ id: 't1', sessionId, prompt: 'first prompt', status: 'completed', createdAt: at(0), updatedAt: at(25) });
    await writer.tasks.save({ id: 't2', sessionId, prompt: 'supplemental prompt', status: 'completed', createdAt: at(23), updatedAt: at(25) });
    const events = [
      event(sessionId, 1, 'task', { task: { id: 't1', prompt: 'first prompt' } }, 't1'),
      event(sessionId, 2, 'text', { text: 'Hel' }, 't1'),
      event(sessionId, 3, 'status', { state: 'thinking' }, 't1', 'x'.repeat(100_000)),
      event(sessionId, 4, 'text', { text: 'lo' }, 't1'),
      event(sessionId, 5, 'status', { state: 'thinking' }, 't2'),
      event(sessionId, 6, 'text', { text: '!' }, 't1'),
      event(sessionId, 7, 'text', { role: 'user', text: 'first prompt', taskId: 't1' }, 't1'),
      event(sessionId, 8, 'tool_call', { id: 'call', name: 'read', status: 'running' }, 't1'),
      event(sessionId, 9, 'raw_terminal', { text: 'private terminal' }, 't1', 'y'.repeat(100_000)),
      event(sessionId, 10, 'tool_result', { id: 'call', output: 'one\ntwo' }, 't1'),
      event(sessionId, 11, 'completed', { text: 'Hello' }, 't1'),
      event(sessionId, 12, 'completed', { text: 'final response' }, 't1'),
      event(sessionId, 13, 'text', { text: 'A' }),
      event(sessionId, 14, 'status', { state: 'idle' }),
      event(sessionId, 15, 'text', { text: 'B' }),
      event(sessionId, 20, 'text', { text: 'C' }),
      event(sessionId, 21, 'text', { text: 'D', taskId: 'data-task' }),
      event(sessionId, 22, 'task', { task: { id: 't2' } }, 't2'),
      event(sessionId, 24, 'text', { text: 'z'.repeat(4100) }, 't2'),
      event(sessionId, 25, 'completed', { text: 'z'.repeat(4100) }, 't2'),
      event(sessionId, 26, 'text', { text: 'audit', audit: 'external_client' }, 't2'),
      event(sessionId, 27, 'thinking', { text: 'private thought' }, 't1'),
      event('null-first', -2, 'text', { text: 'excluded negative' }),
      event('null-first', 0, 'status', { state: 'excluded zero' }),
      event('null-first', 1, 'text', { text: 'A' }),
      event('null-first', 2, 'status', { state: 'idle' }),
      event('null-first', 4, 'text', { text: 'B' })
    ];
    for (const value of events) await writer.events.append(value);
    const prepare = vi.spyOn(Database.prototype, 'prepare');
    const compare = async (id: string) => {
      const tasks = await reader.tasks.listBySession(id), full = await reader.events.list(id), projected = await reader.events.listTaskConversation!(id);
      for (const limit of [1, 3, 40, 200]) {
        const fallback = JSON.stringify(taskConversation(full, tasks, limit));
        const optimized = JSON.stringify(taskConversation(projected, tasks, limit));
        expect(optimized).toBe(fallback);
      }
      return projected;
    };
    const projected = await compare(sessionId);
    expect(projected.map(value => value.type).every(type => ['task', 'text', 'completed', 'tool_call', 'tool_result'].includes(type))).toBe(true);
    expect(projected.every(value => !('raw' in value))).toBe(true);
    const nullPredecessors = await compare('null-first');
    expect(nullPredecessors).toHaveLength(2);
    expect('previousTaskId' in nullPredecessors[0]!).toBe(true);
    expect(nullPredecessors[0]!.previousTaskId).toBeUndefined();
    expect(nullPredecessors[1]!.previousTaskId).toBeNull();

    const index = prepare.mock.calls.findIndex(([query]) => String(query).includes('previous_task'));
    const query = String(prepare.mock.calls[index]?.[0]), database = prepare.mock.contexts[index] as Database.Database;
    const plan = database.prepare('EXPLAIN QUERY PLAN ' + query).all(sessionId) as Array<{ detail: string }>;
    expect(plan.map(row => row.detail).join(' ')).toContain('events_session_seq_type');
    expect(plan.map(row => row.detail).join(' ')).toContain('events_session_seq');
    expect(plan.map(row => row.detail).join(' ')).not.toContain('TEMP B-TREE');
    prepare.mockRestore();

    await writer.events.append(event(sessionId, 28, 'text', { text: 'external commit' }, 't1'));
    await compare(sessionId);

    const tasks = await reader.tasks.listBySession(sessionId), full = await reader.events.list(sessionId), app = Fastify();
    const runtime = { getSession: async () => ({ id: sessionId }), getTasks: async () => tasks,
      getTaskConversationEvents: (id: string) => reader.events.listTaskConversation!(id), getEvents: (id: string) => reader.events.list(id) };
    registerTaskRoutes(app, runtime as any, { authorize: async () => {}, filterViewable: async (_request, sessions) => sessions, can: async () => true, source: async () => undefined });
    try {
      const response = await app.inject('/api/tasks/s?limit=40');
      expect(response.statusCode).toBe(200);
      expect(response.body).toBe(JSON.stringify(taskConversation(full, tasks, 40)));
    } finally { await app.close(); }
  } finally { reader.close(); writer.close(); }
});

it('falls back to getEvents only when a repository has no conversation projection', async () => {
  const full = [event('s', 1, 'status', { state: 'idle' })], projected = [event('s', 1, 'text', { text: 'reply' })];
  const list = vi.fn(async () => full), listTaskConversation = vi.fn(async () => projected);
  const withoutProjection = { repos: { events: { list } }, getEvents: DutydeckRuntime.prototype.getEvents }, withProjection = { repos: { events: { list, listTaskConversation } } };
  expect(await DutydeckRuntime.prototype.getTaskConversationEvents.call(withoutProjection as any, 's')).toBe(full);
  expect(await DutydeckRuntime.prototype.getTaskConversationEvents.call(withProjection as any, 's')).toBe(projected);
  expect(list).toHaveBeenCalledTimes(1);
  expect(listTaskConversation).toHaveBeenCalledWith('s');
});
