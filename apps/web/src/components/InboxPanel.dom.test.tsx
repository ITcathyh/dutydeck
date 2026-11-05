import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, type InboxAction, type InboxItem } from '../api';
import { InboxPanel } from './InboxPanel';

const act = (id: InboxAction['id'], path: string, body: Record<string, unknown> = {}): InboxAction => ({ id, label: ({ approve: '批准', reject: '拒绝', confirm: '确认开始', cancel: '取消', discard: '放弃修订' } as Record<string, string>)[id] ?? id, type: 'api', method: 'POST', path, body });
const open: InboxAction = { id: 'open', label: '查看', type: 'open' };
const base = { createdAt: '2026-11-05T00:00:00Z', waitingMs: 12 * 60_000, sessionTitle: '发版', workspace: 'repo' };
const permission = (n: number): InboxItem => ({ ...base, id: `permission:s${n}:p${n}`, kind: 'permission', sessionId: `s${n}`, title: `权限 ${n}`, actions: [act('approve', `/p/${n}`, { approved: true }), { ...act('reject', `/p/${n}`, { approved: false }), reasonMaxLength: 1000 }, open] });
const work = (n: number): InboxItem => ({ ...base, id: `work_item_confirm:s1:w${n}`, kind: 'work_item_confirm', sessionId: 's1', title: `工作项 ${n}`, revision: 3, actions: [act('confirm', `/w/${n}/confirm`, { expectedRevision: 3 }), act('cancel', `/w/${n}/cancel`, { expectedRevision: 3 }), open] });
const revision = (n: number): InboxItem => ({ ...base, id: `work_item_revision:s1:w${n}`, kind: 'work_item_revision', sessionId: 's1', title: `修订 ${n}`, revision: 3, actions: [act('confirm', `/w/${n}/confirm`, { expectedRevision: 3 }), act('discard', `/w/${n}/revision/discard`, { expectedRevision: 3 }), open] });
const result: InboxItem = { ...base, id: 'result_acceptance:s1:t1', kind: 'result_acceptance', sessionId: 's1', title: '修复登录', actions: [{ id: 'lark_card', label: '请在飞书卡片上处理', type: 'lark_card' }, open] };
const props = { loading: false, call: vi.fn(async () => ({})), onOpen: vi.fn() };

describe('InboxPanel', () => {
  it('没有条目时不占位；读取失败时给重试并说明任务列表仍可用', async () => {
    const { container, rerender } = render(<InboxPanel {...props} items={[]}/>);
    expect(container.textContent).toBe('');
    const onRetry = vi.fn();
    rerender(<InboxPanel {...props} items={[]} failed onRetry={onRetry}/>);
    expect(screen.getByText('无法读取待处理汇总')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(onRetry).toHaveBeenCalled();
  });

  it('按类型分组展示标题、所属会话、等待时长与各类计数；只能在飞书处理的条目显示说明而不是按钮', () => {
    render(<InboxPanel {...props} items={[permission(1), work(1), result]}/>);
    expect(screen.getByText('权限审批 1 · 工作项待确认 1 · 结果待验收 1')).toBeTruthy();
    expect(screen.getAllByText(/发版 · repo · 已等待 12 分钟/).length).toBe(3);
    expect(screen.getByText('请在飞书卡片上处理')).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: '选择：修复登录' })).toBeNull();
    expect(screen.getByRole('checkbox', { name: '选择：权限 1' })).toBeTruthy();
  });

  it('单条动作调用原接口，成功后提示已处理并通知上层刷新；「查看」跳到会话', async () => {
    const user = userEvent.setup(); const call = vi.fn(async () => ({})); const onSettled = vi.fn(); const onOpen = vi.fn();
    render(<InboxPanel {...props} call={call} onSettled={onSettled} onOpen={onOpen} items={[work(1)]}/>);
    await user.click(screen.getByRole('button', { name: '确认开始' }));
    expect(call).toHaveBeenCalledWith(expect.objectContaining({ path: '/w/1/confirm', body: { expectedRevision: 3 } }));
    expect(await screen.findByText('已处理')).toBeTruthy();
    expect(onSettled).toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '查看' }));
    expect(onOpen).toHaveBeenCalledWith('s1');
  });

  it('对象已变化时原接口拒绝旧决定，行内显示已失效而不是失败', async () => {
    const call = vi.fn(async () => { throw new ApiError('Work item changed; refresh before continuing', 'WORK_ITEM_CONFLICT', 409); });
    render(<InboxPanel {...props} call={call} items={[work(1)]}/>);
    await userEvent.click(screen.getByRole('button', { name: '确认开始' }));
    expect(await screen.findByText(/已失效：Work item changed/)).toBeTruthy();
  });

  it('拒绝可附原因：直接拒绝的请求体不变；「拒绝并说明」填写后把原因合入请求体，输入框有标签与长度上限', async () => {
    const user = userEvent.setup(); const call = vi.fn(async (_action: InboxAction) => ({}));
    render(<InboxPanel {...props} call={call} items={[permission(1), permission(2)]}/>);
    await user.click(screen.getAllByRole('button', { name: '拒绝' })[0]!);
    expect(call.mock.calls[0]![0].body).toStrictEqual({ approved: false });
    const explain = screen.getAllByRole('button', { name: '拒绝并说明' })[1]!;
    expect(explain.getAttribute('aria-expanded')).toBe('false');
    await user.click(explain);
    expect(explain.getAttribute('aria-expanded')).toBe('true');
    const box = screen.getByLabelText('拒绝原因') as HTMLTextAreaElement;
    expect(box.maxLength).toBe(1000);
    expect(box.placeholder).toBe('原因会记录在审批历史；终端模式的 Agent 会收到原因，ACP 模式的 Agent 只知道被拒绝。');
    const submit = screen.getByRole('button', { name: '提交拒绝' });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    await user.type(box, '  改用 pnpm ');
    await user.click(submit);
    expect(call.mock.calls[1]![0]).toMatchObject({ path: '/p/2', body: { approved: false, reason: '改用 pnpm' } });
    expect(await screen.findAllByText('已处理')).toHaveLength(2);
    expect(screen.queryByLabelText('拒绝原因')).toBeNull();
  });

  it('多选同类后需二次确认才批量执行，逐项显示成功、已失效与失败', async () => {
    const user = userEvent.setup();
    const call = vi.fn(async (action: InboxAction) => {
      if (action.path === '/p/2') throw new ApiError('gone', 'PERMISSION_NOT_FOUND', 404);
      if (action.path === '/p/3') throw new ApiError('无权拒绝', 'POLICY_DENIED', 403);
      return {};
    });
    render(<InboxPanel {...props} call={call} items={[permission(1), permission(2), permission(3)]}/>);
    await user.click(screen.getByRole('checkbox', { name: '全选权限审批' }));
    expect(screen.getByText('已选 3 项')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '批量批准' })).toBeNull();
    await user.click(screen.getByRole('button', { name: '批量拒绝' }));
    expect(call).not.toHaveBeenCalled();
    expect(screen.getByText('确认对 3 项执行「拒绝」？')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '确认执行' }));
    expect(await screen.findByText('拒绝：成功 1 项，已失效 1 项，失败 1 项。')).toBeTruthy();
    expect(call.mock.calls.map(([action]) => (action as InboxAction).body)).toStrictEqual([{ approved: false }, { approved: false }, { approved: false }]);
    expect(screen.getByText(/已失效：gone/)).toBeTruthy();
    expect(screen.getByText(/失败：无权拒绝/)).toBeTruthy();
  });

  it('必须先看内容的条目（工作项首次确认）没有勾选框，只能逐项点按钮；修订只批量放弃', async () => {
    const user = userEvent.setup(); const call = vi.fn(async (_action: InboxAction) => ({}));
    render(<InboxPanel {...props} call={call} items={[work(1), revision(1), revision(2)]}/>);
    expect(screen.queryByRole('checkbox', { name: '选择：工作项 1' })).toBeNull();
    await user.click(screen.getByRole('checkbox', { name: '全选工作项计划修订待确认' }));
    expect(screen.getByRole('button', { name: '批量放弃修订' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '批量确认开始' })).toBeNull();
    await user.click(screen.getByRole('button', { name: '批量放弃修订' }));
    await user.click(screen.getByRole('button', { name: '确认执行' }));
    expect(call.mock.calls.map(([action]) => action.path)).toEqual(['/w/1/revision/discard', '/w/2/revision/discard']);
  });

  it('混选不同类型时不出现批量按钮并提示只支持同类', async () => {
    const user = userEvent.setup();
    render(<InboxPanel {...props} items={[permission(1), revision(1)]}/>);
    await user.click(screen.getByRole('checkbox', { name: '选择：权限 1' }));
    await user.click(screen.getByRole('checkbox', { name: '选择：修订 1' }));
    expect(screen.getByText('批量处理只支持同一类型，请只选择同类条目。')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /批量/ })).toBeNull();
  });

  it('条目超过 8 条先折叠；条目被服务端移除后选择自动清掉', async () => {
    const user = userEvent.setup();
    const many = Array.from({ length: 10 }, (_, index) => permission(index + 1));
    const { rerender } = render(<InboxPanel {...props} items={many}/>);
    expect(screen.queryByText('权限 9')).toBeNull();
    await user.click(screen.getByRole('button', { name: '展开全部 10 项' }));
    expect(screen.getByText('权限 10')).toBeTruthy();
    await user.click(screen.getByRole('checkbox', { name: '选择：权限 10' }));
    expect(screen.getByText('已选 1 项')).toBeTruthy();
    rerender(<InboxPanel {...props} items={many.slice(0, 9)}/>);
    expect(screen.queryByRole('toolbar', { name: '批量处理' })).toBeNull();
    expect(within(document.body).queryByText('已选 1 项')).toBeNull();
  });
});
