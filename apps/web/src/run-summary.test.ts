import { describe, expect, it } from 'vitest';
import type { Task } from './api';
import { fallbackRunTitle, RUN_SUMMARY_ENDPOINT, summaryFromTasks } from './run-summary';

const task = (id: string, prompt: string, status: string, createdAt: string): Task => ({ id, sessionId: 's1', prompt, status, createdAt, updatedAt: createdAt });

describe('run summary adapter', () => {
  it('标题只取真实的首个有效任务 prompt', () => {
    expect(summaryFromTasks('s1', [task('2', '追加要求', 'queued', '2026-02-02'), task('1', '修复登录超时', 'completed', '2026-02-01')])).toMatchObject({ prompt: '修复登录超时', queuedCount: 1, updatedAt: '2026-02-02' });
    expect(summaryFromTasks('s1', [task('1', '已取消', 'cancelled', '2026-02-01')])).toBeUndefined();
  });

  it('后端摘要缺失时使用明确降级文案并暴露最小契约地址', () => {
    expect(fallbackRunTitle()).toBe('尚未获取任务目标');
    expect(RUN_SUMMARY_ENDPOINT).toBe('/api/sessions/summaries');
  });
});
