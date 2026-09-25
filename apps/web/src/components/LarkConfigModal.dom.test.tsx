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

function renderModal(config: LarkConfig = collection(), source: 'acp' | 'cli' | 'agent' = 'acp', target?: import('../app-route').LarkSetupTarget) {
  vi.spyOn(api, 'larkConfig').mockResolvedValue(config);
  vi.spyOn(api, 'systemCapabilities').mockResolvedValue({ platform: 'linux', directoryPicker: false, filePicker: false });
  vi.spyOn(api, 'agentModels').mockResolvedValue({ models: [], reasoningEfforts: [], source });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><LarkConfigModal agents={agents} target={target} onClose={() => {}}/></QueryClientProvider>);
}

afterEach(() => { cleanup(); sessionStorage.clear(); vi.restoreAllMocks(); });

describe('LarkConfigModal risk control', () => {
  it('configures the required Lark capabilities without making it another save gate', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'larkConfig').mockResolvedValue({ configured: false, bots: [], listeningDisabled: false });
    vi.spyOn(api, 'systemCapabilities').mockResolvedValue({ platform: 'linux', directoryPicker: false, filePicker: false });
    vi.spyOn(api, 'agentModels').mockResolvedValue({ models: [], reasoningEfforts: [], source: 'acp' });
    vi.spyOn(api, 'saveLarkConfig').mockResolvedValue(collection({ appId: 'cli_auto', setupComplete: false }));
    const startedAt = '2026-08-30T00:00:00.000Z';
    const start = vi.spyOn(api, 'startLarkOpenPlatformSetup').mockResolvedValue({
      id: 'job-ui', appId: 'cli_auto', status: 'waiting_for_scan', createdAt: startedAt, updatedAt: startedAt,
      qrDataUrl: 'data:image/png;base64,qr'
    });
    vi.spyOn(api, 'larkOpenPlatformSetupJob').mockResolvedValue({
      id: 'job-ui', appId: 'cli_auto', status: 'completed', createdAt: startedAt, updatedAt: startedAt,
      accountName: '测试账号', tenantName: '测试企业',
      result: { status: 'ready', scopeCount: 16, eventCount: 1, callbackCount: 1, versionId: 'version-ui' },
      slashCommands: 'skipped_credentials'
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
    expect(screen.getByText(/原生斜杠命令菜单未同步：上次同步时未找到该应用凭据/)).toBeTruthy();
    expect((screen.getByRole('button', { name: '下一步' }) as HTMLButtonElement).disabled).toBe(false);
    await user.click(screen.getByRole('button', { name: '下一步' }));
    await screen.findByText('默认 Agent');
    expect(screen.getAllByText(/原生斜杠命令菜单未同步：上次同步时未找到该应用凭据/)).toHaveLength(1);
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

    await user.click(await screen.findByRole('button', { name: /选择 Agent 并启用/ }));
    expect(await screen.findByText(/已为 codex 配置/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Codex' }));
    await user.click(screen.getByRole('option', { name: 'Claude' }));

    await waitFor(() => expect(hookStatus).toHaveBeenCalledWith('cli_test', 'claude'));
    expect(await screen.findByText('Claude Hook 尚未安装')).toBeTruthy();
    expect(screen.getByRole('button', { name: '配置拦截 Hook' })).toBeTruthy();
  });
});

/*
  🔒 凭据只写不读的回归守卫。

  这不是覆盖率练习：App Secret 一旦回填明文，任何能看到这块屏幕的人（肩窥、
  截图、录屏、共享会议）就拿到了机器人的完整凭据。而「留空 = 保持不变」一旦
  失守，编辑一次工作区就会把 appSecret: '' 覆盖进后端，机器人当场失联。
  两条都必须在 DOM 与请求体两端各钉一颗钉子。
*/
describe('LarkConfigModal 凭据边界', () => {
  it('never rehydrates a stored App Secret into the input', async () => {
    // setupComplete 决定落在哪一步；App Secret 只在第 1 步渲染。
    renderModal(collection({ appId: 'cli_test', setupComplete: true }));
    const secret = await screen.findByPlaceholderText('已保存') as HTMLInputElement;
    // 已有 bot：占位符表明后端存着一份，输入框本身必须是空的、且不可见读。
    expect(secret.value).toBe('');
    expect(secret.type).toBe('password');
    expect(screen.queryByDisplayValue(/secret/i)).toBeNull();
  });

  it('omits the appSecret key entirely when the field is left blank', async () => {
    const user = userEvent.setup();
    const save = vi.spyOn(api, 'saveLarkConfig').mockResolvedValue(collection({ setupComplete: true }));
    renderModal(collection({ appId: 'cli_test', setupComplete: true }));

    await screen.findByPlaceholderText('已保存');
    await user.click(screen.getByRole('button', { name: '下一步' }));

    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    const payload = save.mock.calls[0]![0];
    // 留空 = 保持不变：键根本不进请求体，而不是送一个空串把后端的凭据抹掉。
    expect(payload).not.toHaveProperty('appSecret');
    expect(JSON.stringify(payload)).not.toContain('appSecret');
  });
});

describe('LarkConfigModal 模态外壳契约', () => {
  it('portals the wizard to document.body instead of rendering it in place', async () => {
    vi.spyOn(api, 'larkConfig').mockResolvedValue(collection());
    vi.spyOn(api, 'systemCapabilities').mockResolvedValue({ platform: 'linux', directoryPicker: false, filePicker: false });
    vi.spyOn(api, 'agentModels').mockResolvedValue({ models: [], reasoningEfforts: [], source: 'acp' });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const { container } = render(<QueryClientProvider client={client}><LarkConfigModal agents={agents} onClose={() => {}}/></QueryClientProvider>);

    expect(await screen.findByRole('dialog', { name: '绑定飞书 Bot' })).toBeTruthy();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.body.querySelector('[role="dialog"][aria-modal="true"]')).toBeTruthy();
  });

  it('keeps the wizard open on Escape while a save is in flight', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    vi.spyOn(api, 'larkConfig').mockResolvedValue({ configured: false, bots: [], listeningDisabled: false });
    vi.spyOn(api, 'systemCapabilities').mockResolvedValue({ platform: 'linux', directoryPicker: false, filePicker: false });
    vi.spyOn(api, 'agentModels').mockResolvedValue({ models: [], reasoningEfforts: [], source: 'acp' });
    // 永不 resolve：把向导钉在「验证中」这一帧。
    vi.spyOn(api, 'saveLarkConfig').mockImplementation(() => new Promise(() => {}));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<QueryClientProvider client={client}><LarkConfigModal agents={agents} onClose={onClose}/></QueryClientProvider>);

    await user.type(await screen.findByPlaceholderText('cli_xxx'), 'cli_test');
    await user.type(screen.getByPlaceholderText('输入 App Secret'), 'secret');
    await user.click(screen.getByRole('button', { name: '下一步' }));
    await screen.findByRole('button', { name: '验证中' });

    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: '绑定飞书 Bot' })).toBeTruthy();
  });

  it('lets Escape dismiss only the confirmation while the wizard stays open', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    vi.spyOn(api, 'larkConfig').mockResolvedValue(collection({ appId: 'cli_test', setupComplete: false }));
    vi.spyOn(api, 'systemCapabilities').mockResolvedValue({ platform: 'linux', directoryPicker: false, filePicker: false });
    vi.spyOn(api, 'agentModels').mockResolvedValue({ models: [], reasoningEfforts: [], source: 'acp' });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<QueryClientProvider client={client}><LarkConfigModal agents={agents} onClose={onClose}/></QueryClientProvider>);

    // 草稿未完成 → 关闭请求先弹确认框，而不是直接丢弃。
    await user.click(await screen.findByRole('button', { name: '关闭' }));
    expect(await screen.findByText('稍后再完成配置？')).toBeTruthy();

    // 一次 Escape 只关最上面一层：确认框收起，向导与填了一半的表单必须还在。
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByText('稍后再完成配置？')).toBeNull());
    expect(screen.getByRole('dialog', { name: '更新飞书 Bot：测试机器人' })).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('正则语法错误通过 aria-describedby 关联到输入框，读屏能听到「为什么」无效', async () => {
    /*
      守的是「只有 aria-invalid、没有 aria-describedby」这种半吊子错误提示。

      迁移中一度把错误行手写在 Field 外面（为了塞一个 AlertTriangle 图标），
      结果 Field 不知道有错，textarea 的 aria-describedby 恒为 null：读屏用户
      听得到「无效」，却永远听不到原因。而这里的原因偏偏不可推测——
      「正则语法错误」和「灾难性回溯」（见 high-risk-pattern.test.ts）是两种
      完全不同的修法，猜不出来。图标是眼睛的锚点，不该以牺牲读屏为代价。
    */
    const user = userEvent.setup();
    renderModal(collection({ defaultAgentId: 'codex', fullTrustConfirmed: true, setupComplete: true, riskControlMode: 'guidance' }));

    // 风险控制在第 2 步；setupComplete 的 bot 默认停在第 1 步。
    await user.click(await screen.findByRole('button', { name: /选择 Agent 并启用/ }));
    const pattern = await screen.findByRole('textbox', { name: /高危操作正则表达式/ });
    await user.clear(pattern);
    await user.type(pattern, '(unclosed');

    await waitFor(() => expect(pattern.getAttribute('aria-invalid')).toBe('true'));
    const describedBy = pattern.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    const description = document.getElementById(describedBy!);
    expect(description?.textContent).toContain('语法错误');
    // 错误文本必须即时播报，否则用户改到一半不知道已经修好了没有。
    expect(description?.getAttribute('role')).toBe('alert');
  });

  /*
    activeListening 只是「listener.start() 没抛异常」这一个标记：它不等待 WebSocket
    握手，断连后也不会被置回。所以文案上限是「监听已启动」，不能说「长连接已连接」，
    也不能在本实例未开启监听或本次启动禁用监听时还显示成功态。
  */
  describe('监听状态文案不宣称连接健康', () => {
    const ready = { defaultAgentId: 'codex', fullTrustConfirmed: true, setupComplete: true } as Partial<LarkBotConfig>;

    // 监听开关在第 2 步；setupComplete 的 bot 默认停在第 1 步（同上一条用例的走法）。
    const openStepTwo = async () => {
      await userEvent.setup().click(await screen.findByRole('button', { name: /选择 Agent 并启用/ }));
      return screen.findByRole('switch', { name: '监听飞书消息' });
    };

    it('监听已启动时说「监听已启动，可到飞书发送消息」，不说长连接已连接', async () => {
      renderModal(collection({ ...ready, listening: true, activeListening: true }));
      await openStepTwo();
      expect(screen.getByText('监听已启动，可到飞书发送消息')).toBeTruthy();
      for (const lie of ['长连接已连接', '长连接', '已验证']) {
        expect(document.body.textContent).not.toContain(lie);
      }
    });

    it('本实例未开启监听时不出现成功态文案，Bot 标签也不点亮监听圆点', async () => {
      renderModal(collection({ ...ready, listening: false, activeListening: false }));
      await openStepTwo();
      expect(screen.getByText('保持关闭，仅保存机器人配置')).toBeTruthy();
      expect(document.body.textContent).not.toContain('监听已启动');
      expect(document.body.querySelector('[title="监听已启动"]')).toBeNull();
    });

    /*
      这一条是回归的核心：本次启动禁用监听时，服务端不会 sync，任何 Bot 都收不到消息，
      但 activeListening 仍可能是上一次 sync 留下的 true。此前 Bot 标签只判
      `bot.activeListening` 就点亮成功圆点，等于在整体禁用监听时谎报可用。
    */
    it('本次启动禁用监听时，即使 activeListening 为真也不点亮成功圆点', async () => {
      renderModal({ ...collection({ ...ready, listening: true, activeListening: true }), listeningDisabled: true });
      await openStepTwo();
      expect(screen.getByText(/本次启动已通过 --no-lark-listen 禁用/)).toBeTruthy();
      expect(document.body.querySelector('[title="监听已启动"]')).toBeNull();
      expect(document.body.textContent).not.toContain('监听已启动，可到飞书发送消息');
    });
  });
});


describe('LarkConfigModal ask permission posture', () => {
  it('saves ask without a full-trust confirmation for an ACP Agent', async () => {
    const user = userEvent.setup();
    const save = vi.spyOn(api, 'saveLarkConfig').mockResolvedValue(collection({ defaultAgentId: 'codex', permissionMode: 'ask', setupComplete: true }));
    renderModal();
    await user.click(await screen.findByRole('button', { name: /选择 Agent 并启用/ }));
    await screen.findByText('操作确认方式');
    await user.click(screen.getByRole('button', { name: /完全信任：自动执行操作/ }));
    await user.click(await screen.findByRole('option', { name: /飞书逐项确认/ }));
    expect(screen.queryByRole('checkbox', { name: /确认飞书任务以 full-trust 运行/ })).toBeNull();
    const submit = screen.getByRole('button', { name: '完成配置' }) as HTMLButtonElement;
    await waitFor(() => expect(submit.disabled).toBe(false));
    await user.click(submit);
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ permissionMode: 'ask', fullTrustConfirmed: false })));
  });

  it('does not allow ask to save when the selected Agent is not ACP', async () => {
    const user = userEvent.setup();
    renderModal(collection(), 'cli');
    await user.click(await screen.findByRole('button', { name: /选择 Agent 并启用/ }));
    await screen.findByText('操作确认方式');
    await user.click(screen.getByRole('button', { name: /完全信任：自动执行操作/ }));
    await user.click(await screen.findByRole('option', { name: /飞书逐项确认/ }));
    expect(await screen.findByText(/当前 Agent 尚未确认支持 ACP/)).toBeTruthy();
    await waitFor(() => expect((screen.getByRole('button', { name: '完成配置' }) as HTMLButtonElement).disabled).toBe(true));
  });
});


describe('LarkConfigModal 会话记忆', () => {
  it('默认开启两个开关，关闭总开关后隐藏下属设置', async () => {
    const user = userEvent.setup();
    renderModal();
    await user.click(await screen.findByRole('button', { name: /选择 Agent 并启用/ }));
    await screen.findByText('操作确认方式');

    expect((screen.getByRole('switch', { name: '启用会话记忆' }) as HTMLElement).getAttribute('aria-checked')).toBe('true');
    expect((screen.getByRole('switch', { name: '自动提取与整理' }) as HTMLElement).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText('整理 Agent')).toBeTruthy();
    expect(screen.getByText('各群共享同一份记忆，私聊各自独立；仅作为参考内容注入，不授予操作权限。')).toBeTruthy();

    await user.click(screen.getByRole('switch', { name: '启用会话记忆' }));
    expect(screen.queryByRole('switch', { name: '自动提取与整理' })).toBeNull();
    expect(screen.queryByText('整理 Agent')).toBeNull();
  });

  it('保存时带上四个记忆字段', async () => {
    const user = userEvent.setup();
    const save = vi.spyOn(api, 'saveLarkConfig').mockResolvedValue(collection({ defaultAgentId: 'codex', setupComplete: true }));
    renderModal(collection({ fullTrustConfirmed: true, defaultAgentId: 'codex' }));
    await user.click(await screen.findByRole('button', { name: /选择 Agent 并启用/ }));
    await screen.findByText('操作确认方式');

    await user.click(screen.getByRole('switch', { name: '自动提取与整理' }));
    await user.click(screen.getByRole('button', { name: /沿用机器人默认 Agent/ }));
    await user.click(await screen.findByRole('option', { name: 'Claude' }));
    await user.type(screen.getByPlaceholderText('可选，例如 gpt-4o-mini'), 'gpt-4o-mini');

    const submit = screen.getByRole('button', { name: '完成配置' }) as HTMLButtonElement;
    await waitFor(() => expect(submit.disabled).toBe(false));
    await user.click(submit);
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({
      memoryEnabled: true, memoryAutoExtract: false, memoryAgentId: 'claude', memoryModel: 'gpt-4o-mini'
    })));
  });
});

describe('LarkConfigModal explicit selection', () => {
  it('continues a submitted review directly to Agent settings and preserves the review notice', async () => {
    const id = '10000000-0000-4000-8000-000000000001';
    sessionStorage.setItem('dutydeck:lark-app-creation', JSON.stringify({ requestId: id, name: '测试机器人' }));
    const setup = vi.spyOn(api, 'startLarkOpenPlatformSetup');
    const save = vi.spyOn(api, 'saveLarkConfig');
    vi.spyOn(api, 'larkAppCreationJob').mockResolvedValue({ id, name: '测试机器人', appId: bot.appId, botSaved: true, status: 'pending_review', retryable: false, createdAt: '2026-09-13T00:00:00Z', updatedAt: '2026-09-13T00:00:00Z' });
    renderModal(collection(), 'acp', 'new');
    await userEvent.click(await screen.findByRole('button', { name: '继续配置已创建的机器人' }));
    await screen.findByText('默认 Agent');
    await screen.findByText('应用已提交发布，正在等待飞书管理员审核。可以先保存 Agent 设置，审核通过后生效。');
    expect(screen.queryByText(/自动配置尚未完成/)).toBeNull();
    expect(screen.queryByRole('button', { name: '自动配置' })).toBeNull();
    expect(setup).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it('returns a partially configured created Bot to connection setup with an explicit warning', async () => {
    const id = '10000000-0000-4000-8000-000000000001';
    sessionStorage.setItem('dutydeck:lark-app-creation', JSON.stringify({ requestId: id, name: '测试机器人' }));
    const save = vi.spyOn(api, 'saveLarkConfig');
    vi.spyOn(api, 'larkAppCreationJob').mockResolvedValue({ id, name: '测试机器人', appId: bot.appId, botSaved: true, status: 'failed', retryable: false, error: '发布未完成', createdAt: '2026-09-13T00:00:00Z', updatedAt: '2026-09-13T00:00:00Z' });
    renderModal(collection(), 'acp', 'new');
    await userEvent.click(await screen.findByRole('button', { name: '继续配置已创建的机器人' }));
    await screen.findByText('应用已创建，自动配置尚未完成。请先点击“自动配置”，或到飞书后台核对权限和发布状态。');
    await waitFor(() => expect((screen.getByLabelText('App ID') as HTMLInputElement).value).toBe(bot.appId));
    expect(screen.queryByRole('switch', { name: '监听飞书消息' })).toBeNull();
    expect(save).not.toHaveBeenCalled();
  });

  it('opens the automatically created Bot for Agent setup without copying or submitting its credentials', async () => {
    const user = userEvent.setup();
    const existing = collection({ setupComplete: true });
    const created = { ...bot, appId: 'cli_created', name: '新助手', tabLabel: '新助手' };
    const saved = { ...existing, bots: [...existing.bots, created] };
    const save = vi.spyOn(api, 'saveLarkConfig').mockResolvedValue(saved);
    const start = vi.spyOn(api, 'createLarkApp').mockImplementation(async input => {
      vi.mocked(api.larkConfig).mockResolvedValue(saved);
      return { id: input.requestId, name: input.name, appId: created.appId, botSaved: true, status: 'completed', retryable: false, slashCommands: 'failed', createdAt: '2026-09-13T00:00:00Z', updatedAt: '2026-09-13T00:00:00Z' };
    });
    vi.spyOn(api, 'larkAppCreationJob').mockImplementation(async id => ({ id, name: '新助手', appId: created.appId, botSaved: true, status: 'completed', retryable: false, slashCommands: 'failed', createdAt: '2026-09-13T00:00:00Z', updatedAt: '2026-09-13T00:00:00Z' }));
    renderModal(existing, 'acp', { appId: bot.appId });
    await screen.findByRole('heading', { name: '更新飞书 Bot：测试机器人' });
    await user.click(screen.getByRole('button', { name: '新增机器人' }));
    await user.clear(screen.getByLabelText('新机器人名称'));
    await user.type(screen.getByLabelText('新机器人名称'), '新助手');
    await user.keyboard('{Enter}');
    await screen.findByRole('heading', { name: '更新飞书 Bot：新助手' });
    await screen.findByText('默认 Agent');
    expect(screen.getByText(/原生斜杠命令菜单同步失败/)).toBeTruthy();
    expect(start).toHaveBeenCalledOnce();
    expect(save).not.toHaveBeenCalled();
    expect(screen.getByRole('switch', { name: '监听飞书消息' }).getAttribute('aria-checked')).toBe('true');
    await user.click(screen.getByRole('checkbox', { name: /确认飞书任务以 full-trust 运行/ }));
    await user.click(screen.getByRole('button', { name: '完成配置' }));
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save.mock.calls[0]![0]).toMatchObject({ stage: 'agent', originalAppId: 'cli_created', fullTrustConfirmed: true, listening: true });
    expect(save.mock.calls[0]![0]).not.toHaveProperty('appSecret');
  });

  it('opens and focuses a separate new Bot form when the add button is clicked', async () => {
    const user = userEvent.setup();
    const config = collection({ setupComplete: true });
    const save = vi.spyOn(api, 'saveLarkConfig').mockResolvedValue({ ...config, bots: [...config.bots, { ...bot, appId: 'cli_new' }] });
    renderModal(config, 'acp', { appId: bot.appId });
    await waitFor(() => expect((screen.getByLabelText('App ID') as HTMLInputElement).value).toBe(bot.appId));
    await user.click(screen.getByRole('button', { name: /选择 Agent 并启用/ }));
    await user.click(screen.getByRole('button', { name: '新增机器人' }));

    const appId = await screen.findByLabelText('App ID') as HTMLInputElement;
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('新机器人名称')));
    expect(appId.value).toBe('');
    // 高级设置内还有一条 Web 出口警告 role=status，取回全部状态节点后按文案断言。
    expect(screen.getAllByRole('status').some(el => el.textContent?.includes('正在新增机器人'))).toBe(true);
    expect(screen.getByRole('button', { name: '新增机器人' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByRole('button', { name: '删除配置' })).toBeNull();
    expect((screen.getByRole('button', { name: /选择 Agent 并启用/ }) as HTMLButtonElement).disabled).toBe(true);
    await user.type(appId, 'cli_new');
    await user.type(screen.getByPlaceholderText('输入 App Secret'), 'new-secret');
    await user.click(screen.getByRole('button', { name: '下一步' }));
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save.mock.calls[0]?.[0]).toMatchObject({ stage: 'lark', appId: 'cli_new', appSecret: 'new-secret' });
    expect(save.mock.calls[0]?.[0]).not.toHaveProperty('originalAppId');
  });

  it('新增机器人时 Web 地址沿用已有机器人的地址', async () => {
    const user = userEvent.setup();
    const config = collection({ setupComplete: true, webBaseUrl: 'https://dutydeck.example.com' });
    const save = vi.spyOn(api, 'saveLarkConfig').mockResolvedValue({ ...config, bots: [...config.bots, { ...bot, appId: 'cli_new' }] });
    renderModal(config, 'acp', 'new');
    await user.type(await screen.findByLabelText('App ID'), 'cli_new');
    await user.type(screen.getByPlaceholderText('输入 App Secret'), 'new-secret');
    await user.click(screen.getByRole('button', { name: '下一步' }));
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save.mock.calls[0]?.[0]).toMatchObject({ appId: 'cli_new', webBaseUrl: 'https://dutydeck.example.com' });
  });

  it('focuses the App ID when add is clicked again without discarding the new draft', async () => {
    const user = userEvent.setup();
    renderModal(collection({ setupComplete: true }), 'acp', 'new');
    const appId = await screen.findByLabelText('App ID') as HTMLInputElement;
    await user.type(appId, 'cli_draft');
    await user.type(screen.getByPlaceholderText('输入 App Secret'), 'draft-secret');
    await user.click(screen.getByRole('button', { name: '新增机器人' }));
    await waitFor(() => expect(document.activeElement).toBe(appId));
    expect(appId.value).toBe('cli_draft');
    expect((screen.getByPlaceholderText('输入 App Secret') as HTMLInputElement).value).toBe('draft-secret');
  });

  it('updates the requested third Bot and leaves the first Bot untouched', async () => {
    const bots = Array.from({ length: 4 }, (_, i) => ({ ...bot, appId: `cli_${i}`, name: `机器人${i}`, tabLabel: `机器人${i}`, setupComplete: true }));
    const config = { configured: true, bots, listeningDisabled: false };
    const before = structuredClone(bots[0]);
    const save = vi.spyOn(api, 'saveLarkConfig').mockResolvedValue(config);
    renderModal(config, 'acp', { appId: 'cli_2' });
    await screen.findByRole('heading', { name: '更新飞书 Bot：机器人2' });
    await waitFor(() => expect((screen.getByLabelText('App ID') as HTMLInputElement).value).toBe('cli_2'));
    await userEvent.type(screen.getByPlaceholderText('已保存'), 'replacement-secret');
    await userEvent.click(screen.getByRole('button', { name: '下一步' }));
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ originalAppId: 'cli_2', appId: 'cli_2', appSecret: 'replacement-secret', stage: 'lark' })));
    expect(save).toHaveBeenCalledOnce();
    expect(bots[0]).toEqual(before);
  });

  it('explicit new opens an empty form even when Bots already exist', async () => {
    renderModal(collection({ setupComplete: true }), 'acp', 'new');
    const appId = await screen.findByLabelText('App ID');
    expect((appId as HTMLInputElement).value).toBe('');
    expect(screen.queryByRole('button', { name: '删除配置' })).toBeNull();
    expect(screen.getByRole('heading', { name: '绑定飞书 Bot' })).toBeTruthy();
  });

  it('a removed explicit target never silently edits the first Bot', async () => {
    renderModal(collection({ setupComplete: true }), 'acp', { appId: 'cli_removed' });
    expect(await screen.findByText(/找不到指定机器人/)).toBeTruthy();
    expect(screen.queryByLabelText('App ID')).toBeNull();
    expect((screen.getByRole('button', { name: '下一步' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('switch labels toggle their controls and targets are at least 44px on both axes', async () => {
    renderModal();
    const control = await screen.findByRole('switch', { name: '监听飞书消息' });
    expect(control.className).toContain('min-h-11');
    expect(control.className).toContain('min-w-11');
    expect(control.getAttribute('aria-checked')).toBe('false');
    await userEvent.click(screen.getByText('监听飞书消息', { selector: 'label' }));
    expect(control.getAttribute('aria-checked')).toBe('true');
  });
});

/*
  S7：webBaseUrl 留空或只绑本机/内网时，卡片「查看详情」在手机外网注定打不开，
  设置 UI 必须就地给出警告；公网地址不打扰。分类规则与服务端 config.ts 各钉一份矩阵。
*/
describe('LarkConfigModal S7 Web 出口健康提示', () => {
  const openAdvanced = async () => {
    await userEvent.setup().click(await screen.findByText('访问范围与高级设置（可选）'));
  };

  it('公网 Web 地址不显示警告', async () => {
    renderModal(collection({ setupComplete: true, webBaseUrl: 'https://dutydeck.example.com' }));
    await screen.findByPlaceholderText('已保存');
    await openAdvanced();
    expect(screen.queryByText(/没有网页出口|内网可达|合法的 http\(s\) 链接/)).toBeNull();
  });

  it('内网地址显示“手机外网打不开”警告', async () => {
    renderModal(collection({ setupComplete: true, webBaseUrl: 'http://127.0.0.1:8080' }));
    await screen.findByPlaceholderText('已保存');
    await openAdvanced();
    expect(screen.getByText(/Web 地址只在本机或内网可达/)).toBeTruthy();
  });

  it('清空地址变为未配置警告，输入公网地址后警告消失', async () => {
    const user = userEvent.setup();
    renderModal(collection({ setupComplete: true, webBaseUrl: 'http://127.0.0.1:8080' }));
    await screen.findByPlaceholderText('已保存');
    await openAdvanced();
    const input = screen.getByLabelText('Web 访问地址（可选）') as HTMLInputElement;
    await user.clear(input);
    expect(screen.getByText(/未配置公网 Web 地址/)).toBeTruthy();
    await user.type(input, 'https://dutydeck.example.com');
    expect(screen.queryByText(/没有网页出口|内网可达/)).toBeNull();
  });

  it('历史存储的非 http(s) 补协议产物（第二个 ://）仍给出畸形提示', async () => {
    renderModal(collection({ setupComplete: true, webBaseUrl: 'https://ftp://dutydeck.example.com' }));
    await screen.findByPlaceholderText('已保存');
    await openAdvanced();
    expect(screen.getByText(/不是合法的 http\(s\) 链接/)).toBeTruthy();
  });

  it('参数里自带 URL 的公网地址（第二个 :// 在 query 中）不误报', async () => {
    renderModal(collection({ setupComplete: true, webBaseUrl: 'https://dutydeck.example.com/?redirect=https://other.example.com' }));
    await screen.findByPlaceholderText('已保存');
    await openAdvanced();
    expect(screen.queryByText(/没有网页出口|内网可达|合法的 http\(s\) 链接/)).toBeNull();
  });
});

describe('LarkConfigModal 实验卡片开关', () => {
  it('问答、群提及与精简过程卡默认开启', async () => {
    renderModal(collection({ setupComplete: true }));
    await screen.findByPlaceholderText('已保存');
    await userEvent.setup().click(await screen.findByText('访问范围与高级设置（可选）'));
    const ask = screen.getByRole('switch', { name: '结构化问答卡片（默认开启）' });
    const mention = screen.getByRole('switch', { name: '群卡片 @ 发起人（默认开启）' });
    const compact = screen.getByRole('switch', { name: '精简过程卡（默认开启）' });
    expect(ask.getAttribute('aria-checked')).toBe('true');
    expect(mention.getAttribute('aria-checked')).toBe('true');
    expect(compact.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText(/低版本飞书客户端可能不支持/)).toBeTruthy();
    expect(screen.getByText(/群内结果卡末尾 @ 任务发起人/)).toBeTruthy();
  });

  it('回填服务端已关闭的群提及', async () => {
    renderModal(collection({ setupComplete: true, structuredAskCards: true, groupCardMention: false }));
    await screen.findByPlaceholderText('已保存');
    await userEvent.setup().click(await screen.findByText('访问范围与高级设置（可选）'));
    expect(screen.getByRole('switch', { name: '结构化问答卡片（默认开启）' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('switch', { name: '群卡片 @ 发起人（默认开启）' }).getAttribute('aria-checked')).toBe('false');
  });

  it('切换后随第一步保存写入配置，精简过程卡默认带上且可关闭', async () => {
    const user = userEvent.setup();
    const save = vi.spyOn(api, 'saveLarkConfig').mockResolvedValue(collection({ setupComplete: true }));
    renderModal(collection({ setupComplete: true }));
    await screen.findByPlaceholderText('已保存');
    await user.click(await screen.findByText('访问范围与高级设置（可选）'));
    await user.click(screen.getByRole('switch', { name: '结构化问答卡片（默认开启）' }));
    await user.click(screen.getByRole('switch', { name: '群卡片 @ 发起人（默认开启）' }));
    await user.click(screen.getByRole('switch', { name: '精简过程卡（默认开启）' }));
    await user.click(screen.getByRole('button', { name: '下一步' }));
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save.mock.calls[0]![0]).toMatchObject({ stage: 'lark', structuredAskCards: false, groupCardMention: false, compactTrace: false });
  });
});


describe('LarkConfigModal 工作区别名与验证命令', () => {
  const openAdvanced = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(await screen.findByText('访问范围与高级设置（可选）'));
  };

  it('回填服务端已保存的别名表与验证命令', async () => {
    const user = userEvent.setup();
    renderModal(collection({ setupComplete: true, workspaceAliases: { web: '/srv/web', api: '/srv/api' }, verificationCommand: 'pnpm test' }));
    await screen.findByPlaceholderText('已保存');
    await openAdvanced(user);

    expect((screen.getByLabelText('别名 1') as HTMLInputElement).value).toBe('web');
    expect((screen.getByLabelText('别名 1 的绝对路径') as HTMLInputElement).value).toBe('/srv/web');
    expect((screen.getByLabelText('别名 2') as HTMLInputElement).value).toBe('api');
    expect((screen.getByLabelText('别名 2 的绝对路径') as HTMLInputElement).value).toBe('/srv/api');
    expect((screen.getByLabelText('验证命令（可选）') as HTMLInputElement).value).toBe('pnpm test');
  });

  it('新增一条别名并随第一步保存写入，既有别名不丢', async () => {
    const user = userEvent.setup();
    const save = vi.spyOn(api, 'saveLarkConfig').mockResolvedValue(collection({ setupComplete: true }));
    renderModal(collection({ setupComplete: true, workspaceAliases: { web: '/srv/web' }, verificationCommand: 'pnpm test' }));
    await screen.findByPlaceholderText('已保存');
    await openAdvanced(user);

    await user.click(screen.getByRole('button', { name: '添加别名' }));
    await user.type(screen.getByLabelText('别名 2'), 'api');
    await user.type(screen.getByLabelText('别名 2 的绝对路径'), '/srv/api');
    await user.click(screen.getByRole('button', { name: '下一步' }));

    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save.mock.calls[0]![0]).toMatchObject({
      stage: 'lark',
      workspaceAliases: { web: '/srv/web', api: '/srv/api' },
      verificationCommand: 'pnpm test'
    });
  });

  it('删除别名后保存写入剩下的表', async () => {
    const user = userEvent.setup();
    const save = vi.spyOn(api, 'saveLarkConfig').mockResolvedValue(collection({ setupComplete: true }));
    renderModal(collection({ setupComplete: true, workspaceAliases: { web: '/srv/web', api: '/srv/api' } }));
    await screen.findByPlaceholderText('已保存');
    await openAdvanced(user);

    await user.click(screen.getByRole('button', { name: '删除第 1 个别名' }));
    await user.click(screen.getByRole('button', { name: '下一步' }));

    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save.mock.calls[0]![0]).toMatchObject({ workspaceAliases: { api: '/srv/api' } });
  });

  it('相对路径别名挡住保存并就地说明，改成绝对路径后恢复', async () => {
    const user = userEvent.setup();
    renderModal(collection({ setupComplete: true }));
    await screen.findByPlaceholderText('已保存');
    await openAdvanced(user);

    await user.click(screen.getByRole('button', { name: '添加别名' }));
    await user.type(screen.getByLabelText('别名 1'), 'web');
    await user.type(screen.getByLabelText('别名 1 的绝对路径'), 'srv/web');
    expect(screen.getByText(/别名路径必须以 \/ 开头的绝对路径/)).toBeTruthy();
    expect((screen.getByRole('button', { name: '下一步' }) as HTMLButtonElement).disabled).toBe(true);

    await user.clear(screen.getByLabelText('别名 1 的绝对路径'));
    await user.type(screen.getByLabelText('别名 1 的绝对路径'), '/srv/web');
    expect(screen.queryByText(/别名路径必须以 \/ 开头的绝对路径/)).toBeNull();
    expect((screen.getByRole('button', { name: '下一步' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('清空验证命令后保存送空串，让服务端清掉旧配置', async () => {
    const user = userEvent.setup();
    const save = vi.spyOn(api, 'saveLarkConfig').mockResolvedValue(collection({ setupComplete: true }));
    renderModal(collection({ setupComplete: true, verificationCommand: 'pnpm test' }));
    await screen.findByPlaceholderText('已保存');
    await openAdvanced(user);

    await user.clear(screen.getByLabelText('验证命令（可选）'));
    await user.click(screen.getByRole('button', { name: '下一步' }));

    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save.mock.calls[0]![0]).toMatchObject({ verificationCommand: '' });
  });
});

describe('LarkConfigModal 加急与置顶开关', () => {
  const openAdvanced = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(await screen.findByText('访问范围与高级设置（可选）'));
  };

  it('默认关闭，且关着时不显示阈值输入框', async () => {
    const user = userEvent.setup();
    renderModal(collection({ setupComplete: true }));
    await screen.findByPlaceholderText('已保存');
    await openAdvanced(user);

    expect((screen.getByRole('switch', { name: '长时间没人处理时发加急（默认关闭）' }) as HTMLElement).getAttribute('aria-checked')).toBe('false');
    expect((screen.getByRole('switch', { name: '长任务进度卡置顶（默认关闭）' }) as HTMLElement).getAttribute('aria-checked')).toBe('false');
    expect(screen.queryByLabelText('加急前等待（秒）')).toBeNull();
    expect(screen.queryByLabelText('跑多久算长任务（秒）')).toBeNull();
  });

  it('回填服务端已保存的开关与阈值，毫秒按秒显示', async () => {
    const user = userEvent.setup();
    renderModal(collection({
      setupComplete: true,
      urgentEnabled: true, urgentThresholdMs: 180_000, urgentMaxPerHourPerChat: 2,
      pinLongTasks: true, pinAfterMs: 300_000
    } as Partial<LarkBotConfig>));
    await screen.findByPlaceholderText('已保存');
    await openAdvanced(user);

    expect((screen.getByRole('switch', { name: '长时间没人处理时发加急（默认关闭）' }) as HTMLElement).getAttribute('aria-checked')).toBe('true');
    expect((screen.getByLabelText('加急前等待（秒）') as HTMLInputElement).value).toBe('180');
    expect((screen.getByLabelText('每群每小时最多加急') as HTMLInputElement).value).toBe('2');
    expect((screen.getByLabelText('跑多久算长任务（秒）') as HTMLInputElement).value).toBe('300');
  });

  it('打开开关并填阈值后随第一步保存写入，秒折回毫秒', async () => {
    const user = userEvent.setup();
    const save = vi.spyOn(api, 'saveLarkConfig').mockResolvedValue(collection({ setupComplete: true }));
    renderModal(collection({ setupComplete: true }));
    await screen.findByPlaceholderText('已保存');
    await openAdvanced(user);

    await user.click(screen.getByRole('switch', { name: '长时间没人处理时发加急（默认关闭）' }));
    await user.type(screen.getByLabelText('加急前等待（秒）'), '120');
    await user.type(screen.getByLabelText('每群每小时最多加急'), '2');
    await user.click(screen.getByRole('switch', { name: '长任务进度卡置顶（默认关闭）' }));
    await user.type(screen.getByLabelText('跑多久算长任务（秒）'), '90');
    await user.click(screen.getByRole('button', { name: '下一步' }));

    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save.mock.calls[0]![0]).toMatchObject({
      stage: 'lark', urgentEnabled: true, urgentThresholdMs: 120_000, urgentMaxPerHourPerChat: 2,
      pinLongTasks: true, pinAfterMs: 90_000
    });
  });

  it('清空阈值后送 null，让服务端清回模块默认', async () => {
    const user = userEvent.setup();
    const save = vi.spyOn(api, 'saveLarkConfig').mockResolvedValue(collection({ setupComplete: true }));
    renderModal(collection({ setupComplete: true, urgentEnabled: true, urgentThresholdMs: 180_000 } as Partial<LarkBotConfig>));
    await screen.findByPlaceholderText('已保存');
    await openAdvanced(user);

    await user.clear(screen.getByLabelText('加急前等待（秒）'));
    await user.click(screen.getByRole('button', { name: '下一步' }));

    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save.mock.calls[0]![0]).toMatchObject({ urgentEnabled: true, urgentThresholdMs: null });
  });

  it('低于下限的阈值就地挡住保存，改回合法值后恢复', async () => {
    const user = userEvent.setup();
    renderModal(collection({ setupComplete: true }));
    await screen.findByPlaceholderText('已保存');
    await openAdvanced(user);

    await user.click(screen.getByRole('switch', { name: '长时间没人处理时发加急（默认关闭）' }));
    await user.type(screen.getByLabelText('加急前等待（秒）'), '30');
    expect(screen.getByText(/加急等待时间至少 60 秒/)).toBeTruthy();
    expect((screen.getByRole('button', { name: '下一步' }) as HTMLButtonElement).disabled).toBe(true);

    await user.clear(screen.getByLabelText('加急前等待（秒）'));
    await user.type(screen.getByLabelText('加急前等待（秒）'), '60');
    expect(screen.queryByText(/加急等待时间至少 60 秒/)).toBeNull();
    expect((screen.getByRole('button', { name: '下一步' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('置顶等待时间同样有下限，且与加急的下限不同', async () => {
    const user = userEvent.setup();
    renderModal(collection({ setupComplete: true }));
    await screen.findByPlaceholderText('已保存');
    await openAdvanced(user);

    await user.click(screen.getByRole('switch', { name: '长任务进度卡置顶（默认关闭）' }));
    await user.type(screen.getByLabelText('跑多久算长任务（秒）'), '0');
    expect(screen.getByText(/置顶等待时间至少 1 秒/)).toBeTruthy();
    expect((screen.getByRole('button', { name: '下一步' }) as HTMLButtonElement).disabled).toBe(true);

    // 1 秒对置顶是合法的——它可撤销、终态自动撤，不需要和强提醒一样的下限。
    await user.clear(screen.getByLabelText('跑多久算长任务（秒）'));
    await user.type(screen.getByLabelText('跑多久算长任务（秒）'), '1');
    expect(screen.queryByText(/置顶等待时间至少 1 秒/)).toBeNull();
    expect((screen.getByRole('button', { name: '下一步' }) as HTMLButtonElement).disabled).toBe(false);
  });
});
