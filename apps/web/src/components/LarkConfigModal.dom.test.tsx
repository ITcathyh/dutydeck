// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, type Agent, type LarkBotConfig, type LarkConfig } from '../api';
import { LarkConfigModal } from './LarkConfigModal';

const agents: Agent[] = [
  { id: 'codex', name: 'Codex', protocol: 'acp', permissionMode: 'ask' },
  { id: 'claude', name: 'Claude', protocol: 'acp', permissionMode: 'ask' }
];

const bot: LarkBotConfig = {
  configured: true,
  appId: 'cli_test',
  name: '测试机器人',
  tabLabel: '测试机器人',
  setupComplete: false,
  fullTrustConfirmed: false,
  workspace: '/repo',
  preInjectPrompt: '',
  listening: false,
  activeListening: false,
  groupToolsEnabled: false,
  groupToolsAllowSend: false,
  pushIntervalMs: 1_000,
  traceLimit: 50,
  hideTraceOnComplete: true,
  allowedUsers: [],
  allowedEmails: [],
  allowedBots: [],
  peerBotsAllowed: true,
  highRiskAllowedUsers: [],
  highRiskAllowedEmails: [],
  highRiskPattern: 'rm\\b',
  riskControlMode: 'off'
};

const collection = (overrides: Partial<LarkBotConfig> = {}): LarkConfig => ({
  configured: true,
  bots: [{ ...bot, ...overrides }],
  listeningDisabled: false
});

function renderModal(config: LarkConfig = collection()) {
  vi.spyOn(api, 'larkConfig').mockResolvedValue(config);
  vi.spyOn(api, 'systemCapabilities').mockResolvedValue({ platform: 'linux', directoryPicker: false, filePicker: false });
  vi.spyOn(api, 'agentModels').mockResolvedValue({ models: [], reasoningEfforts: [], source: 'acp' });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><LarkConfigModal agents={agents} onClose={() => {}}/></QueryClientProvider>);
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('LarkConfigModal risk control', () => {
  it('configures the required Lark capabilities without making it another save gate', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'larkConfig').mockResolvedValue({ configured: false, bots: [], listeningDisabled: false });
    vi.spyOn(api, 'systemCapabilities').mockResolvedValue({ platform: 'linux', directoryPicker: false, filePicker: false });
    vi.spyOn(api, 'agentModels').mockResolvedValue({ models: [], reasoningEfforts: [], source: 'acp' });
    const startedAt = '2026-08-30T00:00:00.000Z';
    const start = vi.spyOn(api, 'startLarkOpenPlatformSetup').mockResolvedValue({
      id: 'job-ui', appId: 'cli_auto', status: 'waiting_for_scan', createdAt: startedAt, updatedAt: startedAt,
      qrDataUrl: 'data:image/png;base64,qr'
    });
    vi.spyOn(api, 'larkOpenPlatformSetupJob').mockResolvedValue({
      id: 'job-ui', appId: 'cli_auto', status: 'completed', createdAt: startedAt, updatedAt: startedAt,
      accountName: '测试账号', tenantName: '测试企业',
      result: { status: 'ready', scopeCount: 16, eventCount: 1, callbackCount: 1, versionId: 'version-ui' }
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<QueryClientProvider client={client}><LarkConfigModal agents={agents} onClose={() => {}}/></QueryClientProvider>);

    await user.type(await screen.findByPlaceholderText('cli_xxx'), 'cli_auto');
    await user.type(screen.getByPlaceholderText('输入 App Secret'), 'secret');
    await user.click(screen.getByRole('button', { name: '自动配置' }));

    expect(start).toHaveBeenCalledWith('cli_auto', false);
    expect(await screen.findByText(/已为 测试账号 · 测试企业 完成配置并发布/)).toBeTruthy();
    expect(screen.getByText('16 项权限')).toBeTruthy();
    expect(screen.getByText('1 个事件')).toBeTruthy();
    expect(screen.getByText('1 个回调')).toBeTruthy();
    expect(screen.getByText('版本 version-ui')).toBeTruthy();
    expect((screen.getByRole('button', { name: '下一步' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('retries a failed setup with the cached account unless account switching is explicit', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'larkConfig').mockResolvedValue({ configured: false, bots: [], listeningDisabled: false });
    vi.spyOn(api, 'systemCapabilities').mockResolvedValue({ platform: 'linux', directoryPicker: false, filePicker: false });
    vi.spyOn(api, 'agentModels').mockResolvedValue({ models: [], reasoningEfforts: [], source: 'acp' });
    const startedAt = '2026-08-30T00:00:00.000Z';
    const start = vi.spyOn(api, 'startLarkOpenPlatformSetup').mockResolvedValue({
      id: 'job-retry', appId: 'cli_auto', status: 'failed', createdAt: startedAt, updatedAt: startedAt, error: '发布失败'
    });
    vi.spyOn(api, 'larkOpenPlatformSetupJob').mockResolvedValue({
      id: 'job-retry', appId: 'cli_auto', status: 'failed', createdAt: startedAt, updatedAt: startedAt, error: '发布失败'
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<QueryClientProvider client={client}><LarkConfigModal agents={agents} onClose={() => {}}/></QueryClientProvider>);

    await user.type(await screen.findByPlaceholderText('cli_xxx'), 'cli_auto');
    await user.click(screen.getByRole('button', { name: '自动配置' }));
    expect(await screen.findByText('发布失败')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: '重试' }));
    await user.click(screen.getByRole('button', { name: '更换账号' }));
    expect(start.mock.calls).toEqual([
      ['cli_auto', false],
      ['cli_auto', false],
      ['cli_auto', true]
    ]);
  });

  it('enables listening by default for a new bot and saves it with the single full-trust confirmation', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    vi.spyOn(api, 'larkConfig').mockResolvedValue({ configured: false, bots: [], listeningDisabled: false });
    vi.spyOn(api, 'systemCapabilities').mockResolvedValue({ platform: 'linux', directoryPicker: false, filePicker: false });
    vi.spyOn(api, 'agentModels').mockResolvedValue({ models: [], reasoningEfforts: [], source: 'acp' });
    const save = vi.spyOn(api, 'saveLarkConfig')
      .mockResolvedValueOnce(collection())
      .mockResolvedValueOnce(collection({ defaultAgentId: 'codex', fullTrustConfirmed: true, listening: true, activeListening: true, setupComplete: true }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<QueryClientProvider client={client}><LarkConfigModal agents={agents} onClose={onClose}/></QueryClientProvider>);

    await user.type(await screen.findByPlaceholderText('cli_xxx'), 'cli_test');
    await user.type(screen.getByPlaceholderText('输入 App Secret'), 'secret');
    await user.click(screen.getByRole('button', { name: '下一步' }));

    const listeningSwitch = await screen.findByRole('switch', { name: '监听飞书消息' });
    expect(listeningSwitch.getAttribute('aria-checked')).toBe('true');
    await user.click(screen.getByRole('checkbox', { name: /确认飞书任务以 full-trust 运行/ }));
    await user.click(screen.getByRole('button', { name: '完成配置' }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save.mock.calls[0]?.[0]).not.toHaveProperty('listening');
    expect(save.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
      stage: 'agent',
      originalAppId: 'cli_test',
      defaultAgentId: 'codex',
      fullTrustConfirmed: true,
      listening: true
    }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('shows one three-state selector and configures the hook before enforced mode can be saved', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'larkHookStatus').mockResolvedValue({ agentId: 'codex', supported: true, installed: false, writable: true, trustRequired: false, reason: '尚未安装' });
    const save = vi.spyOn(api, 'saveLarkConfig').mockResolvedValue(collection({ defaultAgentId: 'codex', fullTrustConfirmed: true, setupComplete: true, riskControlMode: 'guidance' }));
    const install = vi.spyOn(api, 'installLarkHook').mockResolvedValue({ agentId: 'codex', supported: true, installed: true, writable: true, trustRequired: false });
    renderModal();

    const selector = await screen.findByRole('combobox', { name: '风险控制' });
    expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual(['关闭', '约束提示', '强制拦截']);
    expect(screen.queryByText('软门禁')).toBeNull();
    expect(screen.queryByText('硬门禁')).toBeNull();
    expect(screen.getAllByRole('checkbox')).toHaveLength(1);
    await user.click(screen.getByRole('checkbox', { name: /确认飞书任务以 full-trust 运行/ }));
    await user.click(screen.getByRole('switch', { name: '监听飞书消息' }));

    await user.selectOptions(selector, 'guidance');
    expect(screen.getByText(/此模式不安装或启用工具调用拦截/)).toBeTruthy();
    await user.selectOptions(selector, 'enforced');
    expect(await screen.findByText('尚未安装')).toBeTruthy();
    const submit = screen.getByRole('button', { name: '完成配置' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    await user.click(screen.getByRole('button', { name: '配置拦截 Hook' }));
    await waitFor(() => expect(install).toHaveBeenCalledWith('cli_test', 'rm\\b'));
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ defaultAgentId: 'codex', fullTrustConfirmed: true, listening: true, riskControlMode: 'guidance' }));
    expect((selector as HTMLSelectElement).value).toBe('enforced');
    await waitFor(() => expect(submit.disabled).toBe(false));
  });

  it('does not lock Agent selection and checks the newly selected Agent hook', async () => {
    const user = userEvent.setup();
    const hookStatus = vi.spyOn(api, 'larkHookStatus').mockImplementation(async (_appId, agentId) => ({
      agentId,
      supported: true,
      installed: agentId === 'codex',
      writable: true,
      trustRequired: false,
      ...(agentId === 'claude' ? { reason: 'Claude Hook 尚未安装' } : {})
    }));
    renderModal(collection({ defaultAgentId: 'codex', fullTrustConfirmed: true, setupComplete: true, riskControlMode: 'enforced' }));

    await user.click(await screen.findByRole('button', { name: /Agent 与风险控制/ }));
    expect(await screen.findByText(/已为 codex 配置/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Codex' }));
    await user.click(screen.getByRole('option', { name: 'Claude' }));

    await waitFor(() => expect(hookStatus).toHaveBeenCalledWith('cli_test', 'claude'));
    expect(await screen.findByText('Claude Hook 尚未安装')).toBeTruthy();
    expect(screen.getByRole('button', { name: '配置拦截 Hook' })).toBeTruthy();
  });
});
