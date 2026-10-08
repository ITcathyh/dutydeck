import { expect, it } from 'vitest';
import type { AgentEvent } from '@dutydeck/shared';
import { eventsForRuntimeTask, loadLarkTaskEvents } from './card-renderer.js';

const at = '2026-10-08T07:44:07.000Z';
const task = (id: string, status: string): AgentEvent => ({ type: 'task', data: { task: { id, status } }, timestamp: at } as AgentEvent);

it('提交前就失败的轮次只取它自己的事件，不把以前的轮次当成这一轮', () => {
  const events = [
    task('task_old', 'running'),
    { type: 'text', data: { text: '上一轮的问题', role: 'user', taskId: 'task_old' }, timestamp: at },
    { type: 'tool_call', data: { id: 'call_1', name: 'Bash', input: { command: 'ls' } }, timestamp: at },
    { type: 'text', data: { text: '上一轮的答案' }, timestamp: at },
    task('task_old', 'completed'),
    task('task_new', 'queued'),
    task('task_new', 'running'),
    { type: 'error', data: { message: 'ACP_LAUNCHER_VERSION_CHANGED: 旧会话启动器版本变化' }, timestamp: at },
    task('task_new', 'failed')
  ] as AgentEvent[];
  expect(eventsForRuntimeTask(events, 'task_new')).toEqual([events[7]]);
  expect(eventsForRuntimeTask(events, 'task_old').map(event => event.type)).toEqual(['tool_call', 'text']);
});

it('长回答把用户原话挤出最近窗口时继续往前取，不把回答结束后的「运行中」当成这一轮的起点', async () => {
  const answer = Array.from({ length: 30 }, (_, index) => ({ type: 'text', data: { text: `第 ${index} 段` }, timestamp: at }));
  const events = [
    task('task_long', 'running'),
    { type: 'text', data: { text: '问题', role: 'user', taskId: 'task_long' }, timestamp: at },
    task('task_long', 'running'),
    ...answer,
    task('task_long', 'running'),
    task('task_long', 'completed')
  ] as AgentEvent[];
  const runtime = { getRecentEvents: async (_id: string, limit: number) => events.slice(-limit) };
  expect((await loadLarkTaskEvents(runtime, 'ses_long', 'task_long', 10)).filter(event => event.type === 'text')).toHaveLength(30);
});
