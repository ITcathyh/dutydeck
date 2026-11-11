import { describe, expect, it } from 'vitest';
import type { Task } from './api';
import { fallbackRunTitle, RUN_SUMMARY_ENDPOINT, sessionDisplayName, summaryFromTasks } from './run-summary';

const task = (id: string, prompt: string, status: string, createdAt: string): Task => ({ id, sessionId: 's1', prompt, status, createdAt, updatedAt: createdAt });

describe('run summary adapter', () => {
  it('标题只取真实的首个有效任务 prompt', () => {
    expect(summaryFromTasks('s1', [task('2', '追加要求', 'queued', '2026-02-02'), task('1', '修复登录超时', 'completed', '2026-02-01')])).toMatchObject({ prompt: '修复登录超时', queuedCount: 1, updatedAt: '2026-02-02' });
    expect(summaryFromTasks('s1', [task('1', '已取消', 'cancelled', '2026-02-01')])).toBeUndefined();
  });

  it('创建时间相同时保留输入中的首个有效任务，并排除空白和取消任务', () => {
    expect(summaryFromTasks('s1', [
      task('blank', '   ', 'queued', '2026-01-01'),
      task('cancelled', '已取消', 'cancelled', '2026-01-01'),
      task('first', '  首个目标  ', 'completed', '2026-02-01'),
      task('second', '后续目标', 'queued', '2026-02-01')
    ])).toEqual({ sessionId: 's1', taskId: 'first', prompt: '首个目标', status: 'completed', queuedCount: 1, updatedAt: '2026-02-01' });
  });

  it('更新时间为空时退回创建时间，没有有效任务时不生成摘要', () => {
    expect(summaryFromTasks('s1', [
      { ...task('newer', '追加要求', 'queued', '2026-02-02'), updatedAt: '' },
      task('older', '最初目标', 'completed', '2026-02-01')
    ])).toMatchObject({ taskId: 'older', queuedCount: 1, updatedAt: '2026-02-02' });
    expect(summaryFromTasks('s1', [task('empty-time', '目标', 'queued', '')])).toMatchObject({ updatedAt: '' });
    expect(summaryFromTasks('s1', undefined)).toBeUndefined();
    expect(summaryFromTasks('s1', [])).toBeUndefined();
    expect(summaryFromTasks('s1', [task('blank', '   ', 'queued', '')])).toBeUndefined();
  });

  it('非 ISO 时间字符串仍按 localeCompare 选择最早任务和最新时间', () => {
    expect(summaryFromTasks('s1', [
      task('upper', '后续目标', 'queued', 'B'),
      task('lower', '最初目标', 'completed', 'a')
    ])).toMatchObject({ taskId: 'lower', updatedAt: 'B' });
  });

  it('生成摘要不改变原任务顺序或字段', () => {
    const tasks = [
      task('newer', '追加要求', 'queued', '2026-02-02'),
      { ...task('older', '  最初目标  ', 'completed', '2026-02-01'), updatedAt: '2026-02-03' }
    ];
    const original = structuredClone(tasks);
    expect(summaryFromTasks('s1', tasks)).toMatchObject({ taskId: 'older', prompt: '最初目标', updatedAt: '2026-02-03' });
    expect(tasks).toEqual(original);
  });

  it('后端摘要缺失时使用明确降级文案并暴露最小契约地址', () => {
    expect(fallbackRunTitle()).toBe('尚未获取任务目标');
    expect(RUN_SUMMARY_ENDPOINT).toBe('/api/sessions/summaries');
  });

  describe('sessionDisplayName', () => {
    it('优先返回 trim 后的自定义会话名称', () => {
      expect(sessionDisplayName({ name: '  核心重构任务  ' }, '原始任务指令', '兜底标题')).toBe('核心重构任务');
    });

    it('无自定义名称或全为空白时使用原任务 prompt', () => {
      expect(sessionDisplayName({ name: '   ' }, '原始任务指令', '兜底标题')).toBe('原始任务指令');
      expect(sessionDisplayName(undefined, '  修复超时  ', '兜底标题')).toBe('修复超时');
      expect(sessionDisplayName(null, '修复超时', '兜底标题')).toBe('修复超时');
    });

    it('既无自定义名称又无有效 prompt 时使用调用方 fallback', () => {
      expect(sessionDisplayName(undefined, '', '兜底标题')).toBe('兜底标题');
      expect(sessionDisplayName({ name: '' }, '   ', '兜底标题')).toBe('兜底标题');
      expect(sessionDisplayName(null, null, '未命名任务')).toBe('未命名任务');
    });
  });
});
