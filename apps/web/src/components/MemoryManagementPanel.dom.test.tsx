import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryManagementPanel } from './MemoryManagementPanel';
import { api, ApiError, type MemoryPoolView, type Session } from '../api';
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const session: Session = { id: 's1', agentId: 'a', cwd: '/project', state: 'created', runId: 'r', createdAt: '', updatedAt: '' };
const pool: MemoryPoolView = { scope: '机器人共享群池', fingerprint: 'read-version', historyNotice: '最多保留100条删除记录，过期历史不可用', entries: [{ id: 'mem_00000001', content: '原记忆', topic: 'general', source: 'user', createdAt: '', origin: { label: '来源不可访问或历史记录不可用' } }] };
function mount(source?: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryManagementPanel session={{ ...session, source }}/></QueryClientProvider>);
}
it('opens without turn history, searches the selected Lark pool and preserves the draft on conflicts', async () => {
  const user = userEvent.setup();
  const read = vi.spyOn(api, 'memoryPool').mockResolvedValue(pool);
  const revise = vi.spyOn(api, 'reviseMemoryPool').mockRejectedValue(new ApiError('版本冲突，请重新加载', 'MEMORY_CONCURRENT_CHANGE', 409));
  mount('lark');
  expect(read).not.toHaveBeenCalled(); await user.click(screen.getByRole('button', { name: '管理记忆' }));
  await screen.findByText('原记忆');
  expect(screen.queryByRole('link', { name: '来源不可访问或历史记录不可用' })).toBeNull();
  await user.type(screen.getByRole('textbox', { name: '搜索记忆' }), '记忆');
  await waitFor(() => expect(read).toHaveBeenLastCalledWith('s1', '记忆'));
  await user.click(screen.getByRole('button', { name: '修订' }));
  await user.clear(screen.getByRole('textbox', { name: '记忆正文' })); await user.type(screen.getByRole('textbox', { name: '记忆正文' }), '人工修订草稿');
  await user.click(screen.getByRole('button', { name: '保存修订' }));
  await screen.findByRole('alert');
  expect(revise).toHaveBeenCalledWith('s1', 'mem_00000001', { content: '人工修订草稿', topic: 'general', expectedFingerprint: 'read-version' });
  expect((screen.getByRole('textbox', { name: '记忆正文' }) as HTMLTextAreaElement).value).toBe('人工修订草稿');
  read.mockResolvedValue({ ...pool, fingerprint: 'new-version', entries: [{ ...pool.entries[0]!, content: '别人已保存的内容' }] });
  await user.click(screen.getByRole('button', { name: '重新加载' })); await screen.findByText('别人已保存的内容');
  expect((screen.getByRole('textbox', { name: '记忆正文' }) as HTMLTextAreaElement).value).toBe('人工修订草稿');
});
it('requires explicit project selection and binding; creating or viewing never silently binds the session', async () => {
  const user = userEvent.setup();
  vi.spyOn(api, 'projectMemories').mockResolvedValue({ projects: [{ id: 'proj_a', name: '项目A', enabled: true }] });
  vi.spyOn(api, 'projectMemoryBinding').mockResolvedValue({ projectId: null });
  const read = vi.spyOn(api, 'projectMemory').mockResolvedValue({ ...pool, id: 'proj_a', name: '项目A', enabled: true });
  const bind = vi.spyOn(api, 'bindProjectMemory').mockResolvedValue({});
  vi.spyOn(api, 'createProjectMemory').mockResolvedValue({ project: { id: 'proj_b', name: '项目B', enabled: true } });
  const enabled = vi.spyOn(api, 'setProjectMemoryEnabled').mockResolvedValue({});
  mount(); await user.click(screen.getByRole('button', { name: '管理记忆' }));
  await screen.findByRole('option', { name: '项目A' });
  expect(read).not.toHaveBeenCalled(); expect(bind).not.toHaveBeenCalled();
  await user.selectOptions(screen.getByRole('combobox', { name: '查看项目记忆' }), 'proj_a'); await screen.findByText('原记忆');
  expect(bind).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: '绑定所选项目' })); await waitFor(() => expect(bind).toHaveBeenCalledWith('s1', 'proj_a'));
  await user.click(screen.getByRole('button', { name: '关闭项目记忆' })); await waitFor(() => expect(enabled).toHaveBeenCalledWith('proj_a', false));
  await user.type(screen.getByRole('textbox', { name: '新项目记忆名称' }), '项目B'); await user.click(screen.getByRole('button', { name: '创建项目记忆' }));
  await waitFor(() => expect(api.createProjectMemory).toHaveBeenCalledWith('项目B'));
  expect(bind).toHaveBeenCalledTimes(1);
});
it('never offers project memory to managed Lark background or work item sessions', () => {
  for (const source of ['work_item', 'lark-memory', 'schedule']) {
    const view = mount(source); expect(screen.queryByRole('button', { name: '管理记忆' })).toBeNull(); view.unmount();
  }
});
