import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceApprovalRules } from './WorkspaceApprovalRules';

const rule = { id: 'war_1', appId: 'cli_a', workspace: '/work/repo', pattern: 'pnpm test', createdBy: 'ou_alice', createdAt: '2026-11-05T08:00:00.000Z' };
const respond = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const view = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><WorkspaceApprovalRules/></QueryClientProvider>);

afterEach(() => vi.unstubAllGlobals());

describe('WorkspaceApprovalRules', () => {
  it('lists saved rules and revokes one, then reloads the list', async () => {
    let rules = [rule];
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') { rules = []; return respond(200, { removed: 'war_1' }); }
      return respond(200, { rules });
    });
    vi.stubGlobal('fetch', fetcher);
    view();
    const list = await screen.findByRole('list', { name: '工作区审批规则' });
    expect(list.textContent).toContain('pnpm test');
    expect(list.textContent).toContain('/work/repo');
    expect(list.textContent).toContain('ou_alice 于');
    await userEvent.setup({ delay: null }).click(screen.getByRole('button', { name: '撤销 pnpm test（cli_a，/work/repo）' }));
    await waitFor(() => expect(screen.getByText('还没有规则。')).toBeTruthy());
    expect(fetcher).toHaveBeenCalledWith('/api/workspace-approval-rules/war_1', expect.objectContaining({ method: 'DELETE' }));
  });

  it('explains that only the installation owner can see the rules', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond(403, { error: { code: 'APPROVAL_RULES_OWNER_REQUIRED', message: 'no' } })));
    view();
    expect(await screen.findByText('安装管理员登录后才能查看和撤销这些规则。')).toBeTruthy();
  });
});
