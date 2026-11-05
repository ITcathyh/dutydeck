// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { api, type BotPromptHistory as History, type LarkConfig } from '../api';
import { BotPromptHistory } from './BotPromptHistory';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const history: History = { revision: 4, versions: [
  { schemaVersion: 1, appId: 'app', version: 1, source: 'backfill', savedAt: '2026-11-01T00:00:00.000Z', sha256: 'a'.repeat(64), characters: 2, current: false },
  { schemaVersion: 1, appId: 'app', version: 2, source: 'web', savedAt: '2026-11-01T01:00:00.000Z', sha256: 'b'.repeat(64), characters: 2, current: true }
] };
function mount(disabled = false) {
  const onRollback = vi.fn(), user = userEvent.setup({ delay: null });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><BotPromptHistory appId="app" revision={4} disabled={disabled} onRollback={onRollback}/></QueryClientProvider>);
  vi.spyOn(api, 'botPromptHistory').mockResolvedValue(history);
  vi.spyOn(api, 'botPromptShow').mockResolvedValue({ ...history.versions[0]!, text: '旧文' });
  vi.spyOn(api, 'botPromptDiff').mockResolvedValue({ diff: '-旧文\n+新文' });
  return { onRollback, user };
}
it('loads versions, displays text and line diff, and requires confirmation before rollback', async () => {
  const { onRollback, user } = mount();
  const data = { configured: true, bots: [], listeningDisabled: false } as LarkConfig;
  const rollback = vi.spyOn(api, 'botPromptRollback').mockResolvedValue(data);
  await user.click(screen.getByText('历史版本'));
  await screen.findByText(/版本 2（当前）/);
  await user.click(screen.getByText('查看版本 1'));
  expect((await screen.findByLabelText('版本全文')).textContent).toContain('旧文');
  await user.selectOptions(screen.getByLabelText('原版本'), '2');
  expect((await screen.findByLabelText('版本差异')).textContent).toContain('-旧文');
  await user.click(screen.getByText('回退到版本 1'));
  expect(rollback).not.toHaveBeenCalled();
  await user.click(screen.getByText('取消'));
  expect(rollback).not.toHaveBeenCalled();
  await user.click(screen.getByText('回退到版本 1'));
  await user.click(screen.getByText('确认回退'));
  await waitFor(() => expect(rollback).toHaveBeenCalledWith('app', 1, 4));
  expect(onRollback).toHaveBeenCalledWith(data);
});
it('keeps the original revision on conflict and shows the server error', async () => {
  const { onRollback, user } = mount();
  const rollback = vi.spyOn(api, 'botPromptRollback').mockRejectedValue(new Error('此 Bot 已被修改，请刷新。'));
  await user.click(screen.getByText('历史版本'));
  await user.click(await screen.findByText('回退到版本 1'));
  await user.click(screen.getByText('确认回退'));
  await screen.findByText('此 Bot 已被修改，请刷新。');
  expect(rollback).toHaveBeenCalledWith('app', 1, 4);
  expect(onRollback).not.toHaveBeenCalled();
});
it('allows viewing history but disables rollback while the parent has unsaved edits', async () => {
  const { user } = mount(true);
  await user.click(screen.getByText('历史版本'));
  expect((await screen.findByText('回退到版本 1')).hasAttribute('disabled')).toBe(true);
  expect(screen.getByText('请先保存或放弃当前编辑，再回退版本。')).toBeTruthy();
});

it('shows an unknown-version task as 未记录版本', async () => {
  const { user } = mount();
  vi.mocked(api.botPromptHistory).mockResolvedValue({ ...history, unrecordedUsages: [{ taskId: 'task-unknown', label: '未记录版本' }] });
  await user.click(screen.getByText('历史版本'));
  expect((await screen.findByText('任务 task-unknown · 未记录版本')).textContent).toBe('任务 task-unknown · 未记录版本');
});
