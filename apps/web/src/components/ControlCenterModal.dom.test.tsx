// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { foundationApi, scheduleApi, type FoundationCapability, type GroupMatrix, type LarkBotConfig, type ScheduleCapability } from '../api';
import { ControlCenterModal } from './ControlCenterModal';

const timestamp = '2026-08-30T00:00:00.000Z';
const foundationReady: FoundationCapability = { schemaVersion: 1, repositoriesWired: true, permissionEvaluatorWired: true, secretInspectorWired: true, runtimeWired: false, writesEnabled: true, readiness: 'offline_management_ready', blockers: [{ code: 'production_execution_unwired', message: 'Runtime missing', action: 'Wire later' }] };
const scheduleReady: ScheduleCapability = { schemaVersion: 1, repositoriesWired: true, permissionEvaluatorWired: true, writesEnabled: true, executorWired: false, uiEntryReady: false, readiness: 'offline_management_ready', blockers: [{ code: 'schedule_executor_unavailable', message: 'Executor missing', action: 'Keep disabled' }] };
const matrix: GroupMatrix = { capabilities: foundationReady, bots: [{ bot: { schemaVersion: 1, id: 'bot-ui', revision: 1, channel: 'lark', externalAppId: 'cli_ui', displayName: 'Staged Bot', brand: 'feishu', state: 'staged', desiredListenerState: 'disabled', fullTrustConfirmed: false, createdAt: timestamp, updatedAt: timestamp, credentialStatus: 'missing', blockerCodes: ['channel_bot_credential_required', 'channel_bot_activation_unavailable'] }, cells: [] }] };
const legacyBot = { appId: 'cli_legacy', name: 'Legacy Bot', defaultAgentId: 'codex', setupComplete: true, activeListening: true } as LarkBotConfig;

function mocks(groupMatrix: GroupMatrix = matrix) {
  vi.spyOn(foundationApi, 'capabilities').mockResolvedValue(foundationReady);
  vi.spyOn(foundationApi, 'groupMatrix').mockResolvedValue(groupMatrix);
  vi.spyOn(foundationApi, 'secretRefs').mockResolvedValue({ secretRefs: [] });
  vi.spyOn(scheduleApi, 'capabilities').mockResolvedValue(scheduleReady);
  vi.spyOn(scheduleApi, 'list').mockResolvedValue({ capabilities: scheduleReady, schedules: [] });
}

function renderModal(props: Partial<Parameters<typeof ControlCenterModal>[0]> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const defaults: Parameters<typeof ControlCenterModal>[0] = { open: true, agents: [{ id: 'codex', name: 'Codex', protocol: 'acp', permissionMode: 'ask' }], legacyBots: [], authRequired: false, onClose: () => {}, onCreateTask: () => {}, onOpenLarkSetup: () => {}, onOpenGroups: () => {}, onOpenSchedules: () => {} };
  return render(<QueryClientProvider client={client}><ControlCenterModal {...defaults} {...props}/></QueryClientProvider>);
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('ControlCenterModal information architecture', () => {
  it('closes with Escape so keyboard users are not trapped', async () => {
    mocks();
    const onClose = vi.fn();
    renderModal({ onClose });
    await screen.findByRole('dialog', { name: 'Dockmux 设置与接入' });
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('shows one progressive control shell, trusted-machine context and actionable SecretRef CLI guidance', async () => {
    mocks();
    renderModal({ legacyBots: [legacyBot] });
    expect(await screen.findByRole('dialog', { name: 'Dockmux 设置与接入' })).toBeTruthy();
    for (const label of ['Agent', '飞书 Bot', '群与权限', '自动化']) expect(screen.getByRole('button', { name: new RegExp(label) })).toBeTruthy();
    expect(screen.getByText(/受信开发机模式：/)).toBeTruthy();
    expect(screen.getByText(/1 个已连接/)).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: /secret|凭据值/i })).toBeNull();
    expect(document.body.textContent).not.toContain('SECRET_VALUE_CANARY');
    expect(screen.queryByRole('button', { name: /开启监听|启用 Bot|立即运行|run.now/i })).toBeNull();
  });

  it('creates only a staged ChannelBot identity and never sends a credential value', async () => {
    mocks({ capabilities: foundationReady, bots: [] });
    const create = vi.spyOn(foundationApi, 'createChannelBot').mockResolvedValue(matrix.bots[0]!.bot);
    renderModal({ initialSection: 'lark' });
    await userEvent.click(await screen.findByText('迁移与高级草稿'));
    await userEvent.click(await screen.findByRole('button', { name: '创建 staged Bot' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'ChannelBot 显示名称' }), '研发 Bot');
    await userEvent.type(screen.getByRole('textbox', { name: 'ChannelBot App ID' }), 'cli_safe');
    await userEvent.click(screen.getByRole('button', { name: '保存 staged 草稿' }));
    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    const input = create.mock.calls[0]![0];
    expect(input).toMatchObject({ externalAppId: 'cli_safe', displayName: '研发 Bot', brand: 'feishu' });
    expect(Object.keys(input).sort()).toEqual(['brand', 'displayName', 'externalAppId', 'id']);
    expect(JSON.stringify(input)).not.toMatch(/app.secret|credential|token|value/i);
  });

  it('gives an actionable zero-group path and still routes to automation details', async () => {
    mocks();
    const onOpenLarkSetup = vi.fn(); const onOpenSchedules = vi.fn();
    renderModal({ initialSection: 'groups', onOpenLarkSetup, onOpenSchedules });
    await userEvent.click(await screen.findByRole('button', { name: '检查 Bot 设置' }));
    expect(onOpenLarkSetup).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole('button', { name: /自动化/ }));
    await userEvent.click(await screen.findByRole('button', { name: '编辑与预览自动化' }));
    expect(onOpenSchedules).toHaveBeenCalledOnce();
  });
});
