import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { TimelineEvent } from '../timeline';
import { PermissionCard } from './PermissionCard';

const permission = (status: string): TimelineEvent => ({ id: 'event-1', sequence: 1, type: 'permission_request', timestamp: '', data: { id: 'permission-1', title: '写入配置文件', status } });

describe('PermissionCard', () => {
  it('pending 审批可允许或拒绝', async () => {
    const user = userEvent.setup(); const onResolve = vi.fn();
    render(<PermissionCard event={permission('pending')} onResolve={onResolve}/>);
    await user.click(screen.getByRole('button', { name: '允许' }));
    await user.click(screen.getByRole('button', { name: '拒绝' }));
    expect(onResolve).toHaveBeenNthCalledWith(1, 'permission-1', true);
    expect(onResolve).toHaveBeenNthCalledWith(2, 'permission-1', false);
  });

  it('resolved 审批只读且不再展示操作', () => {
    render(<PermissionCard event={permission('approved')} onResolve={() => {}}/>);
    expect(screen.getByText('已允许')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
