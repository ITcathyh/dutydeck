import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { TimelineEvent } from '../timeline';
import { PermissionCard } from './PermissionCard';

const permission = (status: string): TimelineEvent => ({ id: 'event-1', sequence: 1, type: 'permission_request', timestamp: '', data: { id: 'permission-1', title: '写入配置文件', status } });

describe('PermissionCard', () => {
  it('pending 审批首个决定提交后阻止重复允许与拒绝', async () => {
    const user = userEvent.setup({ delay: null }); const onResolve = vi.fn();
    render(<PermissionCard event={permission('pending')} onResolve={onResolve}/>);
    await user.click(screen.getByRole('button', { name: '允许本次' }));
    await user.click(screen.getByRole('button', { name: '拒绝' }));
    expect(onResolve).toHaveBeenNthCalledWith(1, 'permission-1', true);
    expect(onResolve).toHaveBeenCalledTimes(1);
  });

  it('shows source facts, redacts commands, and makes unknown details explicit', async () => {
    const event = permission('pending');
    event.data.operation = { source: 'acp_tool_call', cwd: '/work/project', resource: '/work/project/file.ts', command: 'pnpm test --token=synthetic-secret' };
    const view = render(<PermissionCard event={event}/>);
    expect(screen.getByText('来源：执行端工具请求')).toBeTruthy();
    expect(screen.getByText('目录：/work/project')).toBeTruthy();
    expect(screen.getByText('资源：/work/project/file.ts')).toBeTruthy();
    await userEvent.setup({ delay: null }).click(screen.getByText('查看命令（已脱敏）'));
    expect(screen.getByText('pnpm test --token=[REDACTED]')).toBeTruthy();
    expect(view.container.textContent).not.toContain('synthetic-secret');
    expect(screen.getByText('本次选择只处理这一条请求，不改变后续授权方式。')).toBeTruthy();
    view.rerender(<PermissionCard event={permission('pending')}/>);
    expect(screen.getByText('执行端未提供详细操作。')).toBeTruthy();
  });

  it('never offers a decision for an expired request', () => {
    render(<PermissionCard event={permission('expired')} onResolve={vi.fn()}/>);
    expect(screen.getByText('已失效')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('resolved 审批只读且不再展示操作', () => {
    render(<PermissionCard event={permission('approved')} onResolve={() => {}}/>);
    expect(screen.getByText('已允许')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('按工作区规则自动允许的记录写明命中的规则；Web 审批卡不提供「本工作区允许」', () => {
    const approved = permission('approved');
    approved.data.workspaceRule = 'pnpm test';
    const view = render(<PermissionCard event={approved}/>);
    expect(screen.getByText('按工作区规则自动允许：pnpm test')).toBeTruthy();
    const pending = permission('pending');
    pending.data.operation = { source: 'acp_tool_call', command: 'pnpm test', commandExact: true };
    view.rerender(<PermissionCard event={pending} onResolve={vi.fn()}/>);
    expect(screen.getAllByRole('button').map(button => button.textContent)).toEqual(['允许本次', '拒绝', '拒绝并说明']);
  });

  // 全站风险最高的两个决策按钮曾是 h-8（32px），低于契约 §9 的 40px 触控目标。
  // 用 Button 默认 md 档后是 h-10；这条守的是别有人把它改回 size="sm"。
  it('允许 / 拒绝的触控目标是 40px，不是 32px', () => {
    render(<PermissionCard event={permission('pending')} onResolve={() => {}}/>);
    for (const name of ['允许本次', '拒绝']) expect(screen.getByRole('button', { name }).className).toContain('h-10');
  });

  // resolving 期间原先是手写转圈图标，现由 Button 的 loading 渲染 Spinner 并置 aria-busy。
  // 两个按钮都必须点不动，否则用户能重复提交同一条授权。
  it('resolving 期间两个按钮都禁用，「允许」标记 aria-busy', () => {
    render(<PermissionCard event={permission('pending')} resolving onResolve={() => {}}/>);
    const approve = screen.getByRole('button', { name: '允许本次' }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    expect(approve.getAttribute('aria-busy')).toBe('true');
    expect((screen.getByRole('button', { name: '拒绝' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

it('失败回执结束提交后允许重试，不把请求显示为已允许', async () => {
  const onResolve = vi.fn();
  const view = render(<PermissionCard event={permission('pending')} onResolve={onResolve}/>);
  await userEvent.setup({ delay: null }).click(screen.getByRole('button', { name: '允许本次' }));
  view.rerender(<PermissionCard event={permission('pending')} resolving onResolve={onResolve}/>);
  view.rerender(<PermissionCard event={permission('pending')} resolving={false} onResolve={onResolve}/>);
  await userEvent.setup({ delay: null }).click(screen.getByRole('button', { name: '拒绝' }));
  expect(onResolve).toHaveBeenLastCalledWith('permission-1', false);
  expect(screen.queryByText('已允许')).toBeNull();
});

it('立即失败的异步请求释放本地锁，且不生成成功回执', async () => {
  const onResolve = vi.fn().mockRejectedValue(new Error('网络失败'));
  render(<PermissionCard event={permission('pending')} onResolve={onResolve}/>);
  await userEvent.setup({ delay: null }).click(screen.getByRole('button', { name: '允许本次' }));
  await waitFor(() => expect((screen.getByRole('button', { name: '允许本次' }) as HTMLButtonElement).disabled).toBe(false));
  await userEvent.setup({ delay: null }).click(screen.getByRole('button', { name: '拒绝' }));
  expect(onResolve).toHaveBeenCalledTimes(2);
  expect(screen.queryByText('已允许')).toBeNull();
});

describe('拒绝并说明', () => {
  it('展开输入框，空白不能提交，提交时把原因交给 onResolve 且之后不能重复提交', async () => {
    const user = userEvent.setup(); const onResolve = vi.fn();
    render(<PermissionCard event={permission('pending')} onResolve={onResolve}/>);
    expect(screen.queryByLabelText('拒绝原因')).toBeNull();
    await user.click(screen.getByRole('button', { name: '拒绝并说明' }));
    const submit = screen.getByRole('button', { name: '提交拒绝' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    await user.type(screen.getByLabelText('拒绝原因'), '   ');
    expect(submit.disabled).toBe(true);
    await user.type(screen.getByLabelText('拒绝原因'), '改用测试库');
    await user.click(submit);
    await user.click(screen.getByRole('button', { name: '提交拒绝' }));
    expect(onResolve).toHaveBeenCalledExactlyOnceWith('permission-1', false, '改用测试库');
  });

  it('原「拒绝」仍一键提交且不带原因，展开输入框不影响它', async () => {
    const user = userEvent.setup(); const onResolve = vi.fn();
    render(<PermissionCard event={permission('pending')} onResolve={onResolve}/>);
    await user.click(screen.getByRole('button', { name: '拒绝并说明' }));
    await user.type(screen.getByLabelText('拒绝原因'), '不应带上');
    await user.click(screen.getByRole('button', { name: '拒绝' }));
    expect(onResolve).toHaveBeenCalledExactlyOnceWith('permission-1', false);
  });

  it('提交失败后保留输入，可再次提交', async () => {
    const user = userEvent.setup(); const onResolve = vi.fn().mockRejectedValueOnce(new Error('网络失败')).mockResolvedValue(undefined);
    render(<PermissionCard event={permission('pending')} onResolve={onResolve}/>);
    await user.click(screen.getByRole('button', { name: '拒绝并说明' }));
    await user.type(screen.getByLabelText('拒绝原因'), '先别动');
    await user.click(screen.getByRole('button', { name: '提交拒绝' }));
    await waitFor(() => expect((screen.getByRole('button', { name: '提交拒绝' }) as HTMLButtonElement).disabled).toBe(false));
    expect((screen.getByLabelText('拒绝原因') as HTMLTextAreaElement).value).toBe('先别动');
    await user.click(screen.getByRole('button', { name: '提交拒绝' }));
    expect(onResolve).toHaveBeenCalledTimes(2);
  });

  it('已拒绝的审批显示脱敏、截断后的原因；没有原因时仍只显示「已拒绝」', () => {
    const rejected = permission('rejected');
    const view = render(<PermissionCard event={rejected}/>);
    expect(view.container.textContent).toContain('已拒绝');
    expect(view.container.textContent).not.toContain('已拒绝：');
    rejected.data.reason = `改用测试库 password=hunter2 ${'长'.repeat(400)}`;
    view.rerender(<PermissionCard event={rejected}/>);
    expect(view.container.textContent).toContain('已拒绝：改用测试库 password=[REDACTED]');
    expect(view.container.textContent).not.toContain('hunter2');
    expect(view.container.textContent!.length).toBeLessThan(600);
    expect(screen.queryByRole('button')).toBeNull();
  });
});
