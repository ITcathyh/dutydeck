import { describe, expect, it } from 'vitest';
import type { InboxItem, RunSummary, Session } from '../api';
import { effectiveStatus, resolveStatusText, sidebarStatusVisual } from './ui';

describe('统一状态映射与词汇 resolveStatusText', () => {
  const session = (state: string, archivedAt?: string | null): Session => ({
    id: 's1',
    agentId: 'codex',
    state,
    cwd: '/repo/test',
    runId: 'r1',
    createdAt: '2026-11-08T00:00:00Z',
    updatedAt: '2026-11-08T00:01:00Z',
    archivedAt: archivedAt ?? undefined
  });

  const inboxItem = (kind: InboxItem['kind']): InboxItem => ({
    id: `item:${kind}`,
    kind,
    sessionId: 's1',
    sessionTitle: '测试任务',
    workspace: 'test',
    createdAt: '2026-11-08T00:00:00Z',
    waitingMs: 1000,
    title: '待处理项',
    actions: []
  });

  it('任务运行中状态统一映射为「执行中」', () => {
    for (const state of ['thinking', 'running_tool', 'starting']) {
      expect(resolveStatusText(session(state))).toBe('执行中');
      expect(effectiveStatus(session(state)).label).toBe('执行中');
    }
  });

  it('人机交互等待状态统一映射为「等你审批」「等你回答」', () => {
    expect(resolveStatusText(session('waiting_for_permission'))).toBe('等你审批');
    expect(effectiveStatus(session('waiting_for_permission')).label).toBe('等你审批');

    expect(resolveStatusText(session('waiting_for_answer'))).toBe('等你回答');
    expect(effectiveStatus(session('waiting_for_answer')).label).toBe('等你回答');
  });

  it('结果未知与待决定统一映射为「等你核对」「等你回答」', () => {
    const reconcileSummary: RunSummary = {
      sessionId: 's1',
      taskId: 't1',
      prompt: '指令',
      status: 'reconcile_required',
      queuedCount: 0,
      updatedAt: ''
    };
    expect(resolveStatusText(session('thinking'), reconcileSummary)).toBe('等你核对');
    expect(effectiveStatus(session('thinking'), reconcileSummary).label).toBe('等你核对');

    const waitingReportSummary: RunSummary = {
      sessionId: 's1',
      taskId: 't1',
      prompt: '指令',
      status: 'idle',
      queuedCount: 0,
      updatedAt: '',
      taskReport: { schemaVersion: 1, sessionId: 's1', status: 'waiting', taskId: 't1', question: '请问如何处理？', reportedAt: '' }
    };
    expect(resolveStatusText(session('idle'), waitingReportSummary)).toBe('等你回答');
    expect(effectiveStatus(session('idle'), waitingReportSummary).label).toBe('等你回答');
  });

  it('待办项统一消费同一映射函数', () => {
    expect(resolveStatusText(inboxItem('permission'))).toBe('等你审批');
    expect(resolveStatusText(inboxItem('plan'))).toBe('等你审批');
    expect(resolveStatusText(inboxItem('work_item_request'))).toBe('等你审批');

    expect(resolveStatusText(inboxItem('question'))).toBe('等你回答');
    expect(resolveStatusText(inboxItem('task_report'))).toBe('等你回答');
    expect(resolveStatusText(inboxItem('work_item_answer'))).toBe('等你回答');
    expect(resolveStatusText(inboxItem('pull_request_question'))).toBe('等你回答');

    expect(resolveStatusText(inboxItem('reconcile'))).toBe('等你核对');
    expect(resolveStatusText(inboxItem('work_item_confirm'))).toBe('等你核对');
    expect(resolveStatusText(inboxItem('pull_request_confirm'))).toBe('等你核对');
    expect(resolveStatusText(inboxItem('result_acceptance'))).toBe('等你核对');
  });

  it('终态与归档语义正确表达', () => {
    expect(resolveStatusText(session('completed'))).toBe('已完成');
    expect(resolveStatusText(session('failed'))).toBe('失败');
    expect(resolveStatusText(session('stopped'))).toBe('已停止');
    expect(resolveStatusText(session('interrupted'))).toBe('已中断');

    expect(resolveStatusText(session('thinking', '2026-11-08T00:02:00Z'))).toBe('已归档');
    expect(effectiveStatus(session('thinking', '2026-11-08T00:02:00Z')).label).toBe('已归档');
  });

  it('侧栏状态视觉与有效状态保持一致', () => {
    const visualRunning = sidebarStatusVisual(session('thinking'));
    expect(visualRunning.label).toBe('执行中');
    expect(visualRunning.dotClass).toBe('bg-info-solid');

    const visualAttention = sidebarStatusVisual(session('waiting_for_permission'));
    expect(visualAttention.label).toBe('等你审批');
    expect(visualAttention.dotClass).toBe('bg-attention-solid');
    expect(visualAttention.textClass).toBe('text-warning');
  });
});
