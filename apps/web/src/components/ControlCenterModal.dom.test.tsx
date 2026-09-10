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
const legacyBot = { appId: 'cli_legacy', name: 'Legacy Bot', defaultAgentId: 'codex', setupComplete: true, listening: true, activeListening: true } as LarkBotConfig;

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
    await screen.findByRole('dialog', { name: 'Dutydeck 设置与接入' });
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('shows one progressive control shell, trusted-machine context and actionable SecretRef CLI guidance', async () => {
    mocks();
    renderModal({ legacyBots: [legacyBot] });
    expect(await screen.findByRole('dialog', { name: 'Dutydeck 设置与接入' })).toBeTruthy();
    for (const label of ['Agent', '飞书 Bot', '群与权限', '自动化']) expect(screen.getByRole('button', { name: new RegExp(label) })).toBeTruthy();
    expect(screen.getByText(/受信开发机模式：/)).toBeTruthy();
    // 「已绑定」不是「已连接」：这一格只数 defaultAgentId 指向该 Agent 的 Bot，不读监听状态。
    expect(screen.getByText(/1 个已绑定/)).toBeTruthy();
    expect(screen.queryByText(/1 个已连接/)).toBeNull();
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

  it('portals the dialog to document.body so no ancestor stacking context can clip it', async () => {
    mocks();
    const { container } = renderModal();
    const dialog = await screen.findByRole('dialog', { name: 'Dutydeck 设置与接入' });
    expect(container.contains(dialog)).toBe(false);
    expect(document.body.contains(dialog)).toBe(true);
  });

  it('refuses to close on Escape while a staged ChannelBot write is in flight', async () => {
    mocks({ capabilities: foundationReady, bots: [] });
    // 永不 resolve：制造一个稳定的 isPending 态，模拟「写操作还在路上」。
    vi.spyOn(foundationApi, 'createChannelBot').mockImplementation(() => new Promise(() => {}));
    const onClose = vi.fn();
    renderModal({ initialSection: 'lark', onClose });
    await userEvent.click(await screen.findByText('迁移与高级草稿'));
    await userEvent.click(await screen.findByRole('button', { name: '创建 staged Bot' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'ChannelBot 显示名称' }), '研发 Bot');
    await userEvent.type(screen.getByRole('textbox', { name: 'ChannelBot App ID' }), 'cli_safe');
    await userEvent.click(screen.getByRole('button', { name: '保存 staged 草稿' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '保存 staged 草稿' }).getAttribute('aria-busy')).toBe('true'));
    await userEvent.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Dutydeck 设置与接入' })).toBeTruthy();
  });

  it('binds each visible staged-bot label to its control so clicking the label focuses the input', async () => {
    mocks({ capabilities: foundationReady, bots: [] });
    renderModal({ initialSection: 'lark' });
    await userEvent.click(await screen.findByText('迁移与高级草稿'));
    await userEvent.click(await screen.findByRole('button', { name: '创建 staged Bot' }));
    for (const [visible, accessible] of [['显示名称', 'ChannelBot 显示名称'], ['飞书 App ID', 'ChannelBot App ID']] as const) {
      const label = screen.getByText(visible) as HTMLLabelElement;
      const control = screen.getByRole('textbox', { name: accessible }) as HTMLInputElement;
      expect(label.htmlFor).toBe(control.id);
      expect(control.id).not.toBe('');
      await userEvent.click(label);
      expect(document.activeElement).toBe(control);
    }
    const brand = screen.getByText('品牌') as HTMLLabelElement;
    expect(brand.htmlFor).toBe((screen.getByRole('combobox') as HTMLSelectElement).id);
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

  /*
    「建议下一步」曾按 Bot 条数宣称「N 个飞书 Bot 已可用」，判据只看
    setupComplete && activeListening，于是漏掉两种同样收不到消息的情况：
    用户主动暂停监听、以及本次启动整体禁用监听。两者都有 bots.length > 0。
    现在判据复用 lark-status 的投影，与首页、侧栏同一份。
  */
  describe('建议下一步按真实状态给，不按 Bot 条数', () => {
    it('用户暂停监听时不说「已可用」，而是指出暂停并指向 Bot 设置', async () => {
      mocks();
      const paused = { ...legacyBot, listening: false, activeListening: false } as LarkBotConfig;
      renderModal({ legacyBots: [paused] });
      await screen.findByRole('dialog', { name: 'Dutydeck 设置与接入' });
      expect(screen.getByText('继续设置 Legacy Bot')).toBeTruthy();
      expect(screen.getByText(/用户暂停监听：已在机器人设置中暂停监听。/)).toBeTruthy();
      expect(document.body.textContent).not.toContain('已可用');
      expect(document.body.textContent).not.toContain('监听已启动');
    });

    it('本次启动禁用监听时不说「已可用」，即使 Bot 自身字段全就绪', async () => {
      mocks();
      renderModal({ legacyBots: [legacyBot], larkListeningDisabled: true });
      await screen.findByRole('dialog', { name: 'Dutydeck 设置与接入' });
      expect(screen.getByText('继续设置 Legacy Bot')).toBeTruthy();
      expect(screen.getByText(/本次启动禁用监听：服务端启动参数已禁用监听。/)).toBeTruthy();
      expect(document.body.textContent).not.toContain('已可用');
    });

    it('全部就绪时主建议仍是飞书优先，标题与它真正的动作一致', async () => {
      mocks();
      const onOpenLarkSetup = vi.fn(); const onCreateTask = vi.fn();
      renderModal({ legacyBots: [legacyBot], onOpenLarkSetup, onCreateTask });
      await screen.findByRole('dialog', { name: 'Dutydeck 设置与接入' });
      /*
        标题必须描述这颗按钮真的会做的事。原先叫「到飞书下达任务」，点下去弹的却是
        绑定/管理向导——它不会把用户送到飞书，也不该替用户挑一个 Bot 跳转。
      */
      expect(screen.getByText('管理飞书 Bot')).toBeTruthy();
      expect(screen.queryByText('到飞书下达任务')).toBeNull();
      expect(screen.getByText(/1 个飞书 Bot 监听已启动/)).toBeTruthy();
      // 不得声称消息已送达 / 全部可用，也不暴露字段名。
      for (const lie of ['已可用', '长连接', 'activeListening', '已验证']) {
        expect(document.body.textContent).not.toContain(lie);
      }
      // 主建议走飞书，不退回 Web 创建任务。
      await userEvent.click(screen.getByRole('button', { name: /继续/ }));
      expect(onOpenLarkSetup).toHaveBeenCalledOnce();
      expect(onCreateTask).not.toHaveBeenCalled();
    });

    it('Bot 卡片的就绪判据同源：暂停监听不显示「已连接」', async () => {
      mocks();
      const paused = { ...legacyBot, listening: false, activeListening: false } as LarkBotConfig;
      renderModal({ initialSection: 'lark', legacyBots: [paused] });
      const card = await screen.findByRole('article');
      expect(card.textContent).toContain('用户暂停监听');
      expect(card.textContent).not.toContain('已连接');
      expect(card.textContent).toContain('继续设置');
    });

    /*
      larkConfig 失败/进行中不能落到「还没有飞书 Bot」空态，也不能沿用缓存说就绪。
      失败后 isLoading=false、data=undefined，legacyBots 因此是空数组。
    */
    it('读取失败且无缓存：建议下一步与 Bot 列表都说状态未知，不说「还没有 Bot」', async () => {
      mocks();
      const onRetryLarkBots = vi.fn();
      renderModal({ initialSection: 'lark', legacyBots: [], larkBotsFailed: true, onRetryLarkBots });
      await screen.findByRole('dialog', { name: 'Dutydeck 设置与接入' });
      expect(screen.getByText('重试读取飞书接入状态')).toBeTruthy();
      expect(screen.getAllByText(/无法判断是否已配置机器人/).length).toBeGreaterThan(0);
      expect(screen.queryByText('还没有飞书 Bot')).toBeNull();
      // 设置内可以重试（Banner 上那颗）。
      await userEvent.click(screen.getAllByRole('button', { name: '重试' })[0]!);
      expect(onRetryLarkBots).toHaveBeenCalled();
    });

    it('读取失败但有缓存：Bot 仍列出，状态降级为未确认而不是「监听已启动」', async () => {
      mocks();
      renderModal({ initialSection: 'lark', legacyBots: [legacyBot], larkBotsFailed: true });
      const card = await screen.findByRole('article');
      expect(card.textContent).toContain('状态未确认');
      expect(card.textContent).not.toContain('监听已启动');
      expect(screen.getByText(/下面的机器人状态未确认/)).toBeTruthy();
    });

    it('读取进行中：说正在读取，不谎报还没有 Bot', async () => {
      mocks();
      renderModal({ initialSection: 'lark', legacyBots: [], larkBotsLoading: true });
      await screen.findByRole('dialog', { name: 'Dutydeck 设置与接入' });
      expect(screen.getByText('正在读取飞书接入状态')).toBeTruthy();
      expect(screen.queryByText('还没有飞书 Bot')).toBeNull();
    });
  });
});
