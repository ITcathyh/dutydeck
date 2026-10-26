import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AutomationRunDetail as RunDetail } from '@dutydeck/shared';
import { api, ApiError, type Session } from '../api';
import { setInstance } from '../instance';
import redactedAutomationReport from '../fixtures/automation-report.redacted.md?raw';
import { AutomationRunDetail } from './AutomationRunDetail';

const time = '2026-10-22T00:00:00Z';
const session: Session = { id: 'execution', agentId: 'a', cwd: '/frozen', state: 'idle', runId: 'run', createdAt: time, updatedAt: time };
const detail: RunDetail = {
  schedule: { schemaVersion: 1, id: 'p', sessionId: 's', revision: 6, generation: 4, name: '周报', prompt: 'new input', trigger: { kind: 'interval', everySeconds: 3600, anchorAt: time }, timezone: 'Asia/Shanghai', dstPolicy: { gap: 'skip', overlap: 'first' }, condition: { kind: 'always' }, enabled: true, createdAt: time, updatedAt: time },
  occurrence: { schemaVersion: 2, id: 'old-run', revision: 1, sessionId: 's', scheduleId: 'p', generation: 2, scheduledForUtc: time, conditionStatus: 'passed', runStatus: 'completed', taskId: 't', runtimeAttemptId: 'attempt-original', result: { version: 1, taskId: 't', attemptId: 'attempt-original', settlementId: 'settlement', throughSequence: 10, outcome: 'completed', output: { text: redactedAutomationReport, digest: 'a'.repeat(64) } }, delivery: { status: 'delivered', attempts: 1, updatedAt: time }, createdAt: time, updatedAt: time },
  input: { prompt: 'frozen old input', cwd: '/frozen', agentId: 'a' }, attempts: [], times: { scheduledForUtc: time, discoveredAt: time, deliveryUpdatedAt: time }, executionSessionId: 'execution', sourceSessionId: 's'
};
const clients: QueryClient[] = [];
afterEach(() => { cleanup(); setInstance(undefined); clients.forEach(client => client.clear()); clients.length = 0; vi.restoreAllMocks(); });
function mount(value = detail) {
  const read = vi.spyOn(api, 'automationRun').mockResolvedValue(value);
  vi.spyOn(api, 'session').mockResolvedValue(session);
  vi.spyOn(api, 'tasks').mockResolvedValue([]);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client);
  const view = render(<QueryClientProvider client={client}><AutomationRunDetail sessionId="s" scheduleId="p" occurrenceId="old-run"/></QueryClientProvider>);
  return { read, client, view };
}
describe('one automation run', () => {
  it('renders the exact frozen result, semantic table, missing stages and copyable raw output', async () => {
    const { read } = mount();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await screen.findByRole('region', { name: '单次运行详情' });
    expect(read).toHaveBeenCalledExactlyOnceWith('s', 'p', 'old-run');
    expect(screen.getByText(/配置版本 2 · 当前计划版本 4/)).toBeTruthy();
    expect(screen.getByRole('table').querySelector('thead th')?.textContent).toBe('项目');
    expect(screen.getAllByText('未记录').length).toBeGreaterThanOrEqual(3);
    await userEvent.click(screen.getByText('本轮冻结的执行输入'));
    expect(screen.getByText('frozen old input')).toBeTruthy();
    expect(screen.queryByText('new input')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: '复制结果原文' }));
    await screen.findByText('原文已复制');
    expect(writeText).toHaveBeenCalledWith(detail.occurrence.result!.output.text);
    expect(screen.getByRole('link', { name: '打开执行任务查看过程证据' }).getAttribute('href')).toBe('/sessions/execution');
  });
  it('does not fetch another run or show cached output after permission is revoked', async () => {
    const { read, client } = mount();
    await screen.findByRole('table');
    read.mockRejectedValue(new ApiError('revoked', 'FORBIDDEN', 403));
    await client.invalidateQueries({ queryKey: ['automation-run'] });
    await screen.findByText('本次运行读取失败：revoked');
    expect(screen.queryByRole('table')).toBeNull();
    expect(read.mock.calls.every(args => args[2] === 'old-run')).toBe(true);
  });
  it('keeps the original unknown fact and exposes only the exact task recovery panel without replay', async () => {
    const value: RunDetail = { ...detail, occurrence: { ...detail.occurrence, result: undefined, runStatus: 'blocked', blockReason: 'reconcile_required' } };
    mount(value);
    vi.spyOn(api, 'tasks').mockResolvedValue([{ id: 't', sessionId: 'execution', prompt: 'old', status: 'reconcile_required', createdAt: time, updatedAt: time }, { id: 'other', sessionId: 'execution', prompt: 'other', status: 'reconcile_required', createdAt: time, updatedAt: time }]);
    vi.spyOn(api, 'unknownTasks').mockResolvedValue([
      { taskId: 't', status: 'reconcile_required', actionable: true, kind: 'attempt', target: 'attempt-original', submission: 'intent_recorded', reasonCode: 'DRIVER_RESULT_UNKNOWN', prompt: 'old', factLines: ['已提交，无法证明是否完成'] },
      { taskId: 'other', status: 'reconcile_required', actionable: true, kind: 'attempt', target: 'other-attempt', submission: 'intent_recorded', reasonCode: 'DRIVER_RESULT_UNKNOWN', prompt: 'other', factLines: ['other fact'] }
    ]);
    const replay = vi.spyOn(api, 'resolveUnknownTask');
    await screen.findByRole('region', { name: '结果未知：old' });
    expect(screen.queryByRole('region', { name: '结果未知：other' })).toBeNull();
    expect(screen.getByText(/结果未知不能视为未执行/)).toBeTruthy();
    expect(replay).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: '重新执行' }));
    expect(await screen.findByRole('alertdialog', { name: '确认重新执行？' })).toBeTruthy();
    expect(replay).not.toHaveBeenCalled();
  });

  it('shows audited manual successors without rewriting the original unknown execution', async () => {
    mount({ ...detail, occurrence: { ...detail.occurrence, result: { ...detail.occurrence.result!, attemptId: 'successor' } }, attempts: [
      { taskId: 't', attemptId: 'attempt-original', number: 1, state: 'settled', outcome: 'unknown', createdAt: time, updatedAt: time, decision: { decisionId: 'decision-1', actor: { kind: 'installation_owner', id: 'installation_owner' }, action: 'retry', evidenceRefs: ['inspected-original-output'] } },
      { taskId: 't', attemptId: 'successor', number: 2, state: 'settled', outcome: 'completed', createdAt: time, updatedAt: time, manualRetry: { causeAttemptId: 'attempt-original', decisionId: 'decision-1' } }
    ] });
    await screen.findByRole('table');
    await userEvent.click(screen.getByText('执行尝试与恢复关系（2）'));
    expect(screen.getByText(/原始尝试.*结果未知/)).toBeTruthy();
    expect(screen.getByText(/人工明确重试的后继 · 来源尝试 attempt-original · 决策 decision-1/)).toBeTruthy();
    expect(screen.getByText(/后继结果不证明原始尝试未执行/)).toBeTruthy();
    expect(screen.getByText(/操作者 工作台所有者/)).toBeTruthy();
  });


  it('separates active execution from queue acceptance without inventing missing stage timestamps', async () => {
    mount({ ...detail, occurrence: { ...detail.occurrence, runStatus: 'accepted', result: undefined, delivery: { ...detail.occurrence.delivery, status: 'pending' } }, attempts: [
      { taskId: 't', attemptId: 'attempt-original', number: 1, state: 'active', createdAt: time, updatedAt: time }
    ] });
    await screen.findByText(/正在执行 · 条件：已满足 · 等待投递/);
    expect(screen.getAllByText('未记录').length).toBeGreaterThanOrEqual(3);
    expect(screen.queryByRole('button', { name: '重新执行' })).toBeNull();
  });

  it('keeps the owning instance in links and cache identity', async () => {
    setInstance('bot');
    const { client } = mount();
    await screen.findByRole('table');
    expect(screen.getByRole('link', { name: '打开执行任务查看过程证据' }).getAttribute('href')).toBe('/instances/bot/sessions/execution');
    expect(client.getQueryCache().findAll({ queryKey: ['automation-run', 'bot', 's', 'p', 'old-run'] })).toHaveLength(1);
  });
});
