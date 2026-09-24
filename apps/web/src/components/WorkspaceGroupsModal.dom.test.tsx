// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { api, type RunSummary, type Session, type WorkspaceOrganizationSnapshot } from '../api';
import { WorkspaceGroupsModal } from './WorkspaceGroupsModal';

const sessions: Session[] = [
  { id: 'sess-a', agentId: 'a', state: 'running', cwd: '/repo/proj-a', runId: 'r1', createdAt: '', updatedAt: '' },
  { id: 'sess-b', agentId: 'a', state: 'idle', cwd: '/repo/proj-b', workspaceSourceCwd: '/repo/proj-a', runId: 'r2', createdAt: '', updatedAt: '', archivedAt: '2026-09-01T00:00:00Z' }
];
const summaries: Record<string, RunSummary> = {
  'sess-a': { sessionId: 'sess-a', taskId: 't1', prompt: '修复登录 bug', status: 'running', queuedCount: 0, updatedAt: '' }
};

function snapshot(partial?: Partial<WorkspaceOrganizationSnapshot['organization']>): WorkspaceOrganizationSnapshot {
  return {
    organization: { groups: [], directoryGroups: {}, sessionGroups: {}, ...partial },
    workspaces: []
  };
}

type ModalProps = Parameters<typeof WorkspaceGroupsModal>[0];

function renderModal(props: Partial<ModalProps> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const onRetry = vi.fn();
  const onClose = vi.fn();
  const merged: ModalProps = {
    open: true,
    onClose,
    snapshot: snapshot(),
    loading: false,
    sessions,
    summaries,
    onRetry,
    ...props
  };
  const tree = render(<QueryClientProvider client={client}><WorkspaceGroupsModal {...merged}/></QueryClientProvider>);
  const rerenderWith = (next: Partial<ModalProps>) => tree.rerender(
    <QueryClientProvider client={client}><WorkspaceGroupsModal {...{ ...merged, ...next }}/></QueryClientProvider>
  );
  return { ...tree, rerenderWith, onRetry, onClose, client };
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('WorkspaceGroupsModal 自定义组管理', () => {
  it('创建分组：调用 API、清空输入、用返回 snapshot 更新查询缓存', async () => {
    const user = userEvent.setup();
    const next = snapshot({ groups: [{ id: 'wg_1', name: '前端组' }] });
    const create = vi.spyOn(api, 'createWorkspaceGroup').mockResolvedValue(next);
    const { client, rerenderWith } = renderModal();

    await user.type(screen.getByLabelText('新分组名称'), '前端组');
    await user.click(screen.getByRole('button', { name: '创建分组' }));

    await waitFor(() => expect(create).toHaveBeenCalledWith('前端组'));
    expect(client.getQueryData(['workspace-groups'])).toEqual(next);
    // App 的 useQuery 观察到缓存更新后会把新 snapshot 透传给 Modal。
    rerenderWith({ snapshot: next });
    expect(await screen.findByLabelText('重命名分组 前端组')).toBeTruthy();
    expect((screen.getByLabelText('新分组名称') as HTMLInputElement).value).toBe('');
  });

  it('改名：保存后调用 renameWorkspaceGroup，且输入草稿不被 snapshot 刷新覆盖', async () => {
    const user = userEvent.setup();
    const renamed = snapshot({ groups: [{ id: 'wg_1', name: '新名字' }] });
    const rename = vi.spyOn(api, 'renameWorkspaceGroup').mockResolvedValue(renamed);
    const { rerenderWith } = renderModal({ snapshot: snapshot({ groups: [{ id: 'wg_1', name: '前端组' }] }) });

    const input = screen.getByLabelText('重命名分组 前端组') as HTMLInputElement;
    await user.clear(input);
    await user.type(input, '新名字');
    // 定时刷新推来一版同名 snapshot，草稿不应被重置。
    rerenderWith({ snapshot: snapshot({ groups: [{ id: 'wg_1', name: '前端组' }] }) });
    expect((screen.getByLabelText('重命名分组 前端组') as HTMLInputElement).value).toBe('新名字');

    await user.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(rename).toHaveBeenCalledWith('wg_1', '新名字'));
  });

  it('删除分组：先出现内联确认，确认后才调用 deleteWorkspaceGroup', async () => {
    const user = userEvent.setup();
    const remove = vi.spyOn(api, 'deleteWorkspaceGroup').mockResolvedValue(snapshot());
    renderModal({ snapshot: snapshot({ groups: [{ id: 'wg_1', name: '前端组' }] }) });

    await user.click(screen.getByRole('button', { name: '删除分组 前端组' }));
    expect(screen.getByText(/按剩余目录规则重新分组/)).toBeTruthy();
    expect(remove).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '确认删除' }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith('wg_1'));
  });
});

describe('WorkspaceGroupsModal 目录规则', () => {
  it('目录行合并 session 源目录与已有规则目录（含无任务的未来规则），切换即下发 assign', async () => {
    const user = userEvent.setup();
    const next = snapshot({
      groups: [{ id: 'wg_1', name: '前端组' }],
      directoryGroups: { '/repo/empty': 'wg_1' }
    });
    const assign = vi.spyOn(api, 'assignWorkspaceGroups').mockResolvedValue(next);
    const { rerenderWith } = renderModal({ snapshot: snapshot({ groups: [{ id: 'wg_1', name: '前端组' }] }) });

    // sess-b 的 workspaceSourceCwd 与 sess-a 同源，去重后目录规则只有一条 /repo/proj-a。
    expect(screen.getByLabelText('目录规则 /repo/proj-a')).toBeTruthy();
    expect(screen.queryByLabelText('目录规则 /repo/proj-b')).toBeNull();

    await user.selectOptions(screen.getByLabelText('目录规则 /repo/proj-a'), 'wg_1');
    await waitFor(() => expect(assign).toHaveBeenCalledWith({ directories: ['/repo/proj-a'], groupId: 'wg_1' }));

    // App 的 useQuery 观察到缓存更新后透传新 snapshot；其中有一条当前无任务的目录规则，也要显示。
    rerenderWith({ snapshot: next });
    expect(screen.getByLabelText('目录规则 /repo/empty')).toBeTruthy();

    await user.selectOptions(screen.getByLabelText('目录规则 /repo/proj-a'), '');
    await waitFor(() => expect(assign).toHaveBeenLastCalledWith({ directories: ['/repo/proj-a'], groupId: null }));
  });
});

describe('WorkspaceGroupsModal 批量任务整理', () => {
  it('勾选任务后批量移动到自定义组，成功后清空选择', async () => {
    const user = userEvent.setup();
    const next = snapshot({
      groups: [{ id: 'wg_1', name: '前端组' }],
      sessionGroups: { 'sess-a': 'wg_1' }
    });
    const assign = vi.spyOn(api, 'assignWorkspaceGroups').mockResolvedValue(next);
    renderModal({ snapshot: snapshot({ groups: [{ id: 'wg_1', name: '前端组' }] }) });

    // 展示 summary prompt、归档标记与完整源目录；无 summary 的任务回退展示 session id。
    expect(screen.getByText('修复登录 bug')).toBeTruthy();
    expect(screen.getByText('已归档')).toBeTruthy();
    expect(screen.getByText('sess-b')).toBeTruthy();

    await user.click(screen.getByLabelText('选择任务 sess-a'));
    await user.selectOptions(screen.getByLabelText('批量目标分组'), 'wg_1');
    await user.click(screen.getByRole('button', { name: /应用到所选任务/ }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith({ groupId: 'wg_1', sessionIds: ['sess-a'] }));
    await waitFor(() => expect((screen.getByLabelText('选择任务 sess-a') as HTMLInputElement).checked).toBe(false));
  });

  it('全选后选择「恢复目录规则」下发 groupId=null 清空覆盖', async () => {
    const user = userEvent.setup();
    const assign = vi.spyOn(api, 'assignWorkspaceGroups').mockResolvedValue(snapshot());
    renderModal();

    await user.click(screen.getByRole('checkbox', { name: '全选' }));
    // 目标下拉保持默认空值即「恢复目录规则」。
    await user.click(screen.getByRole('button', { name: /应用到所选任务/ }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith({ groupId: null, sessionIds: ['sess-a', 'sess-b'] }));
  });

  it('任务有自定义名称时优先展示自定义名称', () => {
    renderModal({
      sessions: [{ ...sessions[0], name: '自定义分组任务' }],
      summaries: { 'sess-a': { sessionId: 'sess-a', taskId: 't1', prompt: '原始指令', status: 'completed', queuedCount: 0, updatedAt: '' } }
    });
    expect(screen.getByText('自定义分组任务')).toBeTruthy();
  });
});

describe('WorkspaceGroupsModal 失败与加载态', () => {
  it('写操作失败显示错误 Banner，且不关闭弹窗', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'createWorkspaceGroup').mockRejectedValue(new Error('网络错误'));
    const { onClose } = renderModal();

    await user.type(screen.getByLabelText('新分组名称'), '前端组');
    await user.click(screen.getByRole('button', { name: '创建分组' }));
    expect(await screen.findByText('网络错误')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('读取失败且无 snapshot 时不启用编辑，展示重试按钮', () => {
    const onRetry = vi.fn();
    renderModal({ snapshot: undefined, loading: false, error: new Error('加载失败'), onRetry });

    expect(screen.queryByLabelText('新分组名称')).toBeNull();
    const retry = screen.getByRole('button', { name: '重试' });
    retry.click();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('首次加载无 snapshot 时显示 loading', () => {
    renderModal({ snapshot: undefined, loading: true });
    expect(screen.getByText('正在读取分组配置…')).toBeTruthy();
  });
});
