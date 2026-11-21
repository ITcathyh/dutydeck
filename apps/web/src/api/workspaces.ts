import type { WorkspaceApprovalRule, WorkspaceOrganizationSnapshot } from '@dutydeck/shared';
import { json, send } from './client';

export const workspaceApprovalRulesApi = {
  list: () => json<{ rules: WorkspaceApprovalRule[] }>('/api/workspace-approval-rules', { cache: 'no-store' }),
  remove: (id: string) => json<{ removed: string }>(`/api/workspace-approval-rules/${encodeURIComponent(id)}`, { method: 'DELETE' }),
};

export const workspaceRequests = {
  workspaceGroups: () => json<WorkspaceOrganizationSnapshot>('/api/workspace-groups'),
  createWorkspaceGroup: (name: string) => send<WorkspaceOrganizationSnapshot>('POST', '/api/workspace-groups', { name }),
  renameWorkspaceGroup: (id: string, name: string) => send<WorkspaceOrganizationSnapshot>('PATCH', `/api/workspace-groups/${encodeURIComponent(id)}`, { name }),
  deleteWorkspaceGroup: (id: string) => json<WorkspaceOrganizationSnapshot>(`/api/workspace-groups/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  assignWorkspaceGroups: (input: { groupId: string | null; sessionIds?: string[]; directories?: string[] }) => send<WorkspaceOrganizationSnapshot>('PUT', '/api/workspace-groups/assignments', input),
};
