// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError, foundationApi, type FoundationCapability, type GroupMatrix } from '../api';
import { GroupPolicyModal } from './GroupPolicyModal';
import type { GroupBinding } from '@dockmux/shared';

const timestamp = '2026-08-30T00:00:00.000Z';
const binding: GroupBinding = {
  schemaVersion: 1, id: 'binding-ui', revision: 1, channelBotId: 'bot-ui', externalChatId: 'chat-ui', state: 'staged', oncall: true,
  agentOverride: { mode: 'inherit' }, workspaceOverride: { mode: 'inherit' }, modelOverride: { mode: 'inherit' }, reasoningOverride: { mode: 'inherit' }, rolePolicyOverride: { mode: 'inherit' },
  routingOverride: { groupReplyMode: { mode: 'set', value: 'chat-topic' }, mentionPolicy: { mode: 'set', value: 'topic' } },
  accessOverride: { mode: 'inherit', principalIds: [] }, groupToolsOverride: { read: 'inherit', discover: 'deny', send: 'allow' }, presentationOverride: { mode: 'inherit' }, reviewReasons: [], createdAt: timestamp, updatedAt: timestamp
};
const ready: FoundationCapability = { schemaVersion: 1, repositoriesWired: true, permissionEvaluatorWired: true, secretInspectorWired: true, runtimeWired: false, writesEnabled: true, readiness: 'offline_management_ready', blockers: [{ code: 'production_execution_unwired', message: '生产消息与执行入口尚未接入', action: '等待 WP1b 执行入口接线' }] };
const matrix: GroupMatrix = {
  capabilities: ready,
  bots: [{
    bot: { schemaVersion: 1, id: 'bot-ui', revision: 1, channel: 'lark', externalAppId: 'cli_ui', displayName: 'UI Bot', brand: 'feishu', state: 'staged', desiredListenerState: 'disabled', fullTrustConfirmed: false, createdAt: timestamp, updatedAt: timestamp, credentialStatus: 'missing', blockerCodes: ['channel_bot_credential_required', 'channel_bot_activation_unavailable'] },
    cells: [{
      externalChatId: 'chat-ui', remoteFact: { schemaVersion: 1, id: 'fact-ui', revision: 1, channelBotId: 'bot-ui', externalChatId: 'chat-ui', membershipState: 'member', chatType: 'topic_group', displayName: '研发群', observedAt: timestamp, lastSuccessAt: timestamp, expiresAt: '2026-08-30T00:15:00.000Z', createdAt: timestamp, updatedAt: timestamp }, desiredPolicy: binding,
      effectiveSummary: { agent: { value: 'codex', source: 'bot_default' }, workspace: { value: undefined, source: 'unconfigured' }, model: { value: undefined, source: 'unconfigured' }, reasoningEffort: { value: undefined, source: 'unconfigured' }, rolePolicyRef: { value: undefined, source: 'unconfigured' }, routing: { groupReplyMode: { value: 'chat-topic', source: 'group_override' }, mentionPolicy: { value: 'topic', source: 'group_override' } }, access: { mode: 'owner_only', principalIds: [], source: 'bot_default' }, groupTools: { read: { allowed: true, requested: true, source: 'bot_default' }, discover: { allowed: false, requested: false, source: 'group_override' }, send: { allowed: false, requested: true, source: 'bot_ceiling' } }, talkGrant: 'oncall_chat_members', explanations: [] },
      permissionSummary: { talkSource: 'oncall_chat_members', canTalkAssignments: 0, canOperateAssignments: 1, adminAssignments: 0, independentGates: { terminalWrite: false, highRisk: false, groupToolsSend: false } }, severity: 'blocked', blockers: [{ code: 'channel_bot_credential_required', action: '配置 SecretRef 引用' }], primaryAction: { id: 'review_effective_config', label: '查看有效配置' }
    }]
  }]
};

function renderModal() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><GroupPolicyModal open onClose={() => {}}/></QueryClientProvider>);
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('GroupPolicyModal disabled management journey', () => {
  it('shows machine-readable runtime dependency as an actionable disabled state', async () => {
    vi.spyOn(foundationApi, 'capabilities').mockResolvedValue({ schemaVersion: 1, repositoriesWired: false, permissionEvaluatorWired: false, secretInspectorWired: false, runtimeWired: false, writesEnabled: false, readiness: 'repository_unwired', blockers: [{ code: 'foundation_repository_unwired', message: '群策略仓储尚未接入运行时', action: '由 WP1b 注入 RepositoryBundle' }] });
    const matrixSpy = vi.spyOn(foundationApi, 'groupMatrix');
    renderModal();
    expect(await screen.findByText('尚未接入运行时')).toBeTruthy();
    expect(screen.getByText('群策略仓储尚未接入运行时')).toBeTruthy();
    expect(screen.getByText(/完成 WP1b repository wiring/)).toBeTruthy();
    expect(matrixSpy).not.toHaveBeenCalled();
  });

  it('renders missing credential and permission reasons without an activation control', async () => {
    vi.spyOn(foundationApi, 'capabilities').mockResolvedValue({ ...ready, permissionEvaluatorWired: false, writesEnabled: false, readiness: 'permission_unwired', blockers: [{ code: 'permission_evaluator_unwired', message: '管理权限解析尚未接入运行时', action: '由 WP1b 注入 owner/admin principal resolver' }] });
    vi.spyOn(foundationApi, 'groupMatrix').mockResolvedValue({ ...matrix, capabilities: { ...ready, permissionEvaluatorWired: false, writesEnabled: false, readiness: 'permission_unwired' } });
    vi.spyOn(foundationApi, 'secretRefs').mockResolvedValue({ secretRefs: [] });
    renderModal();
    expect(await screen.findByText('UI Bot')).toBeTruthy();
    expect(screen.getByText(/Bot 保持禁用/)).toBeTruthy();
    expect(screen.getByText(/缺少 owner\/admin 权限解析/)).toBeTruthy();
    expect((screen.getByRole('button', { name: '编辑群策略' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: /开启监听|启用 Bot|接管消息/ })).toBeNull();
  });

  it('preserves the draft and offers rebase when CAS reports a revision conflict', async () => {
    vi.spyOn(foundationApi, 'capabilities').mockResolvedValue(ready);
    vi.spyOn(foundationApi, 'groupMatrix').mockResolvedValue(matrix);
    vi.spyOn(foundationApi, 'secretRefs').mockResolvedValue({ secretRefs: [] });
    const current = { ...binding, revision: 2, state: 'disabled' as const };
    const update = vi.spyOn(foundationApi, 'updateGroupBinding').mockRejectedValueOnce(new ApiError('stale revision', 'FOUNDATION_REVISION_CONFLICT', 409, current)).mockResolvedValueOnce({ ...current, revision: 3 });
    renderModal();
    await userEvent.click(await screen.findByRole('button', { name: '编辑群策略' }));
    const oncall = screen.getByRole('checkbox');
    await userEvent.click(oncall);
    expect((oncall as HTMLInputElement).checked).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: '保存禁用态策略' }));
    expect(await screen.findByText(/配置已被其他修改覆盖/)).toBeTruthy();
    expect((oncall as HTMLInputElement).checked).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: /基于新版本重试/ }));
    await userEvent.click(screen.getByRole('button', { name: '保存禁用态策略' }));
    await waitFor(() => expect(update).toHaveBeenLastCalledWith('binding-ui', expect.objectContaining({ expectedRevision: 2, oncall: false })));
  });

  it('selects only metadata-visible SecretRefs and never offers a credential test or value input', async () => {
    vi.spyOn(foundationApi, 'capabilities').mockResolvedValue(ready);
    vi.spyOn(foundationApi, 'groupMatrix').mockResolvedValue(matrix);
    vi.spyOn(foundationApi, 'secretRefs').mockResolvedValue({ secretRefs: [{ schemaVersion: 1, id: 'lark-safe-ref', revision: 2, kind: 'lark_app_secret', provider: 'local-file-v1', referenceKey: 'opaque.reference', status: 'configured', availability: 'available', createdAt: timestamp, updatedAt: timestamp }] });
    const update = vi.spyOn(foundationApi, 'updateChannelBot').mockResolvedValue({ ...matrix.bots[0]!.bot, revision: 2, selectedSecretRefId: 'lark-safe-ref', credentialStatus: 'configured' });
    renderModal();
    const select = await screen.findByRole('combobox', { name: 'UI Bot SecretRef' });
    await userEvent.selectOptions(select, 'lark-safe-ref');
    await userEvent.click(screen.getByRole('button', { name: '保存引用' }));
    await waitFor(() => expect(update).toHaveBeenCalledWith('bot-ui', { expectedRevision: 1, credentialRef: 'lark-safe-ref' }));
    expect(screen.queryByRole('textbox', { name: /secret|凭据值/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /测试凭据|开启监听|启用 Bot/ })).toBeNull();
    expect(document.body.textContent).not.toContain('SECRET_VALUE_CANARY');
  });

  it('preserves the SecretRef selection and rebases it after a ChannelBot CAS conflict', async () => {
    vi.spyOn(foundationApi, 'capabilities').mockResolvedValue(ready);
    vi.spyOn(foundationApi, 'groupMatrix').mockResolvedValue(matrix);
    vi.spyOn(foundationApi, 'secretRefs').mockResolvedValue({ secretRefs: [{ schemaVersion: 1, id: 'lark-safe-ref', revision: 2, kind: 'lark_app_secret', provider: 'local-file-v1', referenceKey: 'opaque.reference', status: 'configured', availability: 'available', createdAt: timestamp, updatedAt: timestamp }] });
    const current = { ...matrix.bots[0]!.bot, revision: 2 };
    const update = vi.spyOn(foundationApi, 'updateChannelBot').mockRejectedValueOnce(new ApiError('stale revision', 'FOUNDATION_REVISION_CONFLICT', 409, current)).mockResolvedValueOnce({ ...current, revision: 3, selectedSecretRefId: 'lark-safe-ref', credentialStatus: 'configured' });
    renderModal();
    const select = await screen.findByRole('combobox', { name: 'UI Bot SecretRef' });
    await userEvent.selectOptions(select, 'lark-safe-ref');
    await userEvent.click(screen.getByRole('button', { name: '保存引用' }));
    expect(await screen.findByText(/Bot 配置已变化到 revision 2/)).toBeTruthy();
    expect((select as HTMLSelectElement).value).toBe('lark-safe-ref');
    await userEvent.click(screen.getByRole('button', { name: /基于新版本重试/ }));
    await waitFor(() => expect(update).toHaveBeenLastCalledWith('bot-ui', { expectedRevision: 2, credentialRef: 'lark-safe-ref' }));
  });

  it('creates a missing GroupBinding as a staged inherited policy', async () => {
    vi.spyOn(foundationApi, 'capabilities').mockResolvedValue(ready);
    vi.spyOn(foundationApi, 'groupMatrix').mockResolvedValue({ ...matrix, bots: [{ ...matrix.bots[0]!, cells: [{ ...matrix.bots[0]!.cells[0]!, desiredPolicy: undefined }] }] });
    vi.spyOn(foundationApi, 'secretRefs').mockResolvedValue({ secretRefs: [] });
    const create = vi.spyOn(foundationApi, 'createGroupBinding').mockResolvedValue(binding);
    renderModal();
    await userEvent.click(await screen.findByRole('button', { name: '配置此群' }));
    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(create.mock.calls[0]![0]).toMatchObject({ channelBotId: 'bot-ui', externalChatId: 'chat-ui' });
    expect(JSON.stringify(create.mock.calls[0]![0])).not.toMatch(/enabled|listener|secret/i);
  });
});
