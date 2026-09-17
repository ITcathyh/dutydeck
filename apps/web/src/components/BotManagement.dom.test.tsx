import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, type Agent, type LarkBotConfig, type LarkConfig, type ManagedGroup } from '../api';
import { resetDrafts } from '../draft-store';
import { BotManagement } from './BotManagement';

// 草稿是模块级 store（切走视图也要留住），用例之间必须显式清空，否则互相串。
beforeEach(() => resetDrafts());
afterEach(() => { vi.restoreAllMocks(); resetDrafts(); });

const mockBot: LarkBotConfig = {
  configured: true,
  appId: 'cli_test_1',
  name: '测试助手',
  tabLabel: '测试',
  setupComplete: true,
  workspace: '/data/projects/bot1',
  defaultAgentId: 'codex',
  defaultModel: 'gpt-4o',
  defaultReasoningEffort: 'medium',
  fullTrustConfirmed: true,
  preInjectPrompt: '提示词',
  listening: true,
  activeListening: true,
  groupToolsEnabled: false,
  groupToolsAllowSend: false,
  pushIntervalMs: 1000,
  hideTraceOnComplete: false,
  allowedUsers: [],
  allowedEmails: [],
  allowedBots: [],
  peerBotsAllowed: true,
  highRiskAllowedUsers: [],
  highRiskAllowedEmails: [],
  highRiskPattern: '',
  riskControlMode: 'off',
  revision: 3,
  p2pMode: 'chat',
  groupReplyMode: 'chat',
  mentionPolicy: 'always'
};

const mockAgents: Agent[] = [
  { id: 'codex', name: 'Codex', protocol: 'acp', permissionMode: 'ask' }
];

const mockGroups: ManagedGroup[] = [
  {
    key: 'group_key_1',
    chatId: 'oc_chat_1',
    name: '研发项目群',
    bots: [
      {
        appId: 'cli_test_1',
        membership: 'member',
        validity: 'valid',
        applied: true,
        roles: []
      }
    ]
  }
];

function renderWithClient(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe('BotManagement component', () => {
  it('渲染 Bot 列表并展示选中的 Bot 详情与参与群聊', async () => {
    vi.spyOn(api, 'larkConfig').mockResolvedValue({
      configured: true,
      bots: [mockBot],
      listeningDisabled: false
    });
    vi.spyOn(api, 'managementGroups').mockResolvedValue({
      groups: mockGroups
    });
    vi.spyOn(api, 'agentModels').mockResolvedValue({
      models: [{ id: 'gpt-4o', name: 'GPT-4o' }],
      reasoningEfforts: []
    });

    const onSelectGroup = vi.fn();
    renderWithClient(
      <BotManagement
        selectedAppId="cli_test_1"
        onSelectBot={() => {}}
        onOpenLarkSetup={() => {}}
        onSelectGroup={onSelectGroup}
        agents={mockAgents}
      />
    );

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: '测试助手' })).toBeTruthy();
    });

    expect(screen.getByText('研发项目群')).toBeTruthy();

    // 点击跳转群配置
    const configGroupBtn = screen.getByRole('button', { name: '配置本群' });
    await userEvent.click(configGroupBtn);
    expect(onSelectGroup).toHaveBeenCalledWith('oc_chat_1', 'cli_test_1');
  });

  it('修改配置后保存，带上 expectedRevision', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'larkConfig').mockResolvedValue({
      configured: true,
      bots: [mockBot],
      listeningDisabled: false
    });
    vi.spyOn(api, 'managementGroups').mockResolvedValue({ groups: [] });
    vi.spyOn(api, 'agentModels').mockResolvedValue({ models: [], reasoningEfforts: [] });

    const saveSpy = vi.spyOn(api, 'saveLarkConfig').mockResolvedValue({
      configured: true,
      bots: [{ ...mockBot, revision: 4, workspace: '/new/path' }],
      listeningDisabled: false
    });

    renderWithClient(
      <BotManagement
        selectedAppId="cli_test_1"
        onSelectBot={() => {}}
        onOpenLarkSetup={() => {}}
        onSelectGroup={() => {}}
        agents={mockAgents}
      />
    );

    await waitFor(() => expect(screen.getByRole('heading', { name: '测试助手' })).toBeTruthy());

    // 找到工作目录输入框并修改
    const workspaceInput = screen.getByDisplayValue('/data/projects/bot1');
    await user.clear(workspaceInput);
    await user.type(workspaceInput, '/new/path');

    expect(screen.getByText(/有未保存的修改/)).toBeTruthy();

    const saveBtn = screen.getByRole('button', { name: '保存配置' });
    await user.click(saveBtn);

    await waitFor(() => {
      expect(saveSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          appId: 'cli_test_1',
          workspace: '/new/path',
          expectedRevision: 3
        })
      );
    });
  });

  it('保存发生 409 冲突时展示冲突提示并保留草稿', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'larkConfig').mockResolvedValue({
      configured: true,
      bots: [mockBot],
      listeningDisabled: false
    });
    vi.spyOn(api, 'managementGroups').mockResolvedValue({ groups: [] });
    vi.spyOn(api, 'agentModels').mockResolvedValue({ models: [], reasoningEfforts: [] });

    vi.spyOn(api, 'saveLarkConfig').mockRejectedValue(
      new ApiError('Revision conflict on bots', 'REVISION_CONFLICT', 409, { revision: 4 })
    );

    renderWithClient(
      <BotManagement
        selectedAppId="cli_test_1"
        onSelectBot={() => {}}
        onOpenLarkSetup={() => {}}
        onSelectGroup={() => {}}
        agents={mockAgents}
      />
    );

    await waitFor(() => expect(screen.getByRole('heading', { name: '测试助手' })).toBeTruthy());

    const workspaceInput = screen.getByDisplayValue('/data/projects/bot1');
    await user.type(workspaceInput, '-conflict');

    const saveBtn = screen.getByRole('button', { name: '保存配置' });
    await user.click(saveBtn);

    await waitFor(() => {
      expect(screen.getByText(/别人刚改过这个机器人的配置/)).toBeTruthy();
      expect(screen.getByText(/Revision conflict on bots/)).toBeTruthy();
    });

    // 用户草稿依然在
    expect(screen.getByDisplayValue('/data/projects/bot1-conflict')).toBeTruthy();
  });
});

describe('BotManagement 会话记忆', () => {
  it('旧配置缺字段时默认开启，关闭总开关后隐藏下属设置', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'larkConfig').mockResolvedValue({ configured: true, bots: [mockBot], listeningDisabled: false });
    vi.spyOn(api, 'managementGroups').mockResolvedValue({ groups: [] });
    vi.spyOn(api, 'agentModels').mockResolvedValue({ models: [], reasoningEfforts: [] });

    renderWithClient(
      <BotManagement selectedAppId="cli_test_1" onSelectBot={() => {}} onOpenLarkSetup={() => {}} onSelectGroup={() => {}} agents={mockAgents}/>
    );
    await waitFor(() => expect(screen.getByRole('heading', { name: '测试助手' })).toBeTruthy());

    const enabled = screen.getByRole('checkbox', { name: '启用会话记忆' }) as HTMLInputElement;
    expect(enabled.checked).toBe(true);
    expect((screen.getByRole('checkbox', { name: '自动提取与整理' }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByLabelText('整理 Agent')).toBeTruthy();
    expect(screen.getByText('记忆按聊天隔离，仅作为参考内容注入，不授予操作权限。')).toBeTruthy();
    // 只是默认值，没有改动过，不应该报「有未保存的修改」。
    expect(screen.queryByText(/有未保存的修改/)).toBeNull();

    await user.click(enabled);
    expect(screen.queryByRole('checkbox', { name: '自动提取与整理' })).toBeNull();
    expect(screen.queryByLabelText('整理 Agent')).toBeNull();
    expect(screen.getByText(/有未保存的修改/)).toBeTruthy();
  });

  it('保存时带上四个记忆字段', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'larkConfig').mockResolvedValue({ configured: true, bots: [mockBot], listeningDisabled: false });
    vi.spyOn(api, 'managementGroups').mockResolvedValue({ groups: [] });
    vi.spyOn(api, 'agentModels').mockResolvedValue({ models: [], reasoningEfforts: [] });
    const saveSpy = vi.spyOn(api, 'saveLarkConfig').mockResolvedValue({ configured: true, bots: [{ ...mockBot, revision: 4 }], listeningDisabled: false });

    renderWithClient(
      <BotManagement selectedAppId="cli_test_1" onSelectBot={() => {}} onOpenLarkSetup={() => {}} onSelectGroup={() => {}} agents={mockAgents}/>
    );
    await waitFor(() => expect(screen.getByRole('heading', { name: '测试助手' })).toBeTruthy());

    await user.click(screen.getByRole('checkbox', { name: '自动提取与整理' }));
    await user.selectOptions(screen.getByLabelText('整理 Agent'), 'codex');
    await user.type(screen.getByPlaceholderText('可选，例如 gpt-4o-mini'), 'gpt-4o-mini');
    await user.click(screen.getByRole('button', { name: '保存配置' }));

    await waitFor(() => expect(saveSpy).toHaveBeenCalledWith(expect.objectContaining({
      memoryEnabled: true, memoryAutoExtract: false, memoryAgentId: 'codex', memoryModel: 'gpt-4o-mini'
    })));
  });
});

describe('BotManagement 布局与状态诚实', () => {
  it('桌面 list/detail，窄屏进详情后有返回列表的路', async () => {
    vi.spyOn(api, 'larkConfig').mockResolvedValue({ configured: true, bots: [mockBot], listeningDisabled: false });
    vi.spyOn(api, 'managementGroups').mockResolvedValue({ groups: [] });
    vi.spyOn(api, 'agentModels').mockResolvedValue({ models: [], reasoningEfforts: [] });

    const { container } = renderWithClient(
      <BotManagement selectedAppId="cli_test_1" onSelectBot={() => {}} onOpenLarkSetup={() => {}} onSelectGroup={() => {}} agents={mockAgents}/>
    );
    await waitFor(() => expect(screen.getByRole('heading', { name: '测试助手' })).toBeTruthy());

    const aside = container.querySelector('aside')!;
    expect(aside.className).toContain('hidden');
    expect(aside.className).toContain('md:flex');
    expect(screen.getByRole('button', { name: /返回机器人列表/ })).toBeTruthy();
    // 详情是页面内区域，不是叠在列表上的弹窗（删除确认框未打开时不应有 dialog）。
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('监听状态走 lark-status 统一投影，不自造「已接入」说法', async () => {
    // 配置完成但监听未启动：必须说「监听尚未启动」，不能因为有 Bot 就说在线。
    vi.spyOn(api, 'larkConfig').mockResolvedValue({
      configured: true,
      bots: [{ ...mockBot, listening: true, activeListening: false }],
      listeningDisabled: false
    });
    vi.spyOn(api, 'managementGroups').mockResolvedValue({ groups: [] });
    vi.spyOn(api, 'agentModels').mockResolvedValue({ models: [], reasoningEfforts: [] });

    renderWithClient(
      <BotManagement selectedAppId="cli_test_1" onSelectBot={() => {}} onOpenLarkSetup={() => {}} onSelectGroup={() => {}} agents={mockAgents}/>
    );
    await waitFor(() => expect(screen.getAllByText('监听尚未启动').length).toBeGreaterThan(0));
    expect(screen.queryByText('监听已启动')).toBeNull();
  });

  it('本次启动整体禁用监听时如实标注，不显示为已启动', async () => {
    vi.spyOn(api, 'larkConfig').mockResolvedValue({
      configured: true,
      bots: [mockBot],
      listeningDisabled: true
    });
    vi.spyOn(api, 'managementGroups').mockResolvedValue({ groups: [] });
    vi.spyOn(api, 'agentModels').mockResolvedValue({ models: [], reasoningEfforts: [] });

    renderWithClient(
      <BotManagement selectedAppId="cli_test_1" onSelectBot={() => {}} onOpenLarkSetup={() => {}} onSelectGroup={() => {}} agents={mockAgents} larkListeningDisabled/>
    );
    await waitFor(() => expect(screen.getAllByText('本次启动禁用监听').length).toBeGreaterThan(0));
    expect(screen.queryByText('监听已启动')).toBeNull();
  });
});

/*
  保存请求在飞的时候切换对象 / 继续编辑。

  回调若读闭包里的 activeBot，A 的成功会去清 B 的草稿、A 的 409 会贴到 B 的详情上——
  都是在改一个用户没提交过的对象。这里用真实的 deferred promise 把请求停在半空，
  确保断言落在「回调执行时当前对象已经不是提交对象」这一刻。
*/
describe('BotManagement 保存期间切换对象与继续编辑', () => {
  const botB: LarkBotConfig = { ...mockBot, appId: 'cli_test_2', name: '第二助手', workspace: '/data/projects/bot2', revision: 7 };

  const stubTwoBots = () => {
    vi.spyOn(api, 'larkConfig').mockResolvedValue({ configured: true, bots: [mockBot, botB], listeningDisabled: false });
    vi.spyOn(api, 'managementGroups').mockResolvedValue({ groups: [] });
    vi.spyOn(api, 'agentModels').mockResolvedValue({ models: [], reasoningEfforts: [] });
  };

  /** 受控的 Bot 选择：真实 App 靠 URL 驱动，这里用一层 state 复现同样的切换。 */
  function Harness() {
    const [appId, setAppId] = useState('cli_test_1');
    return <BotManagement selectedAppId={appId} onSelectBot={setAppId} onOpenLarkSetup={() => {}} onSelectGroup={() => {}} agents={mockAgents}/>;
  }

  it('保存 A 期间切到 B：A 成功不清 B 的草稿', async () => {
    const user = userEvent.setup();
    stubTwoBots();
    let resolveSave!: (value: LarkConfig) => void;
    vi.spyOn(api, 'saveLarkConfig').mockImplementation(() => new Promise<LarkConfig>(resolve => { resolveSave = resolve; }));

    renderWithClient(<Harness/>);
    await waitFor(() => expect(screen.getByRole('heading', { name: '测试助手' })).toBeTruthy());

    // 改 A 并提交，请求停在半空。
    await user.type(screen.getByDisplayValue('/data/projects/bot1'), '-a');
    await user.click(screen.getByRole('button', { name: '保存配置' }));

    // 切到 B 并给它也留一份草稿。
    await user.click(screen.getByRole('button', { name: /第二助手/ }));
    await waitFor(() => expect(screen.getByRole('heading', { name: '第二助手' })).toBeTruthy());
    await user.type(screen.getByDisplayValue('/data/projects/bot2'), '-b');
    expect(screen.getByText(/有未保存的修改/)).toBeTruthy();

    // A 的请求这时才回来。
    resolveSave({ configured: true, bots: [{ ...mockBot, revision: 4 }, botB], listeningDisabled: false });

    // B 的草稿必须原样还在——它从来没有被提交过。
    await waitFor(() => expect(screen.getByDisplayValue('/data/projects/bot2-b')).toBeTruthy());
    expect(screen.getByText(/有未保存的修改/)).toBeTruthy();
  });

  it('保存 A 期间切到 B：A 的 409 不贴到 B 的详情上', async () => {
    const user = userEvent.setup();
    stubTwoBots();
    let rejectSave!: (reason: unknown) => void;
    vi.spyOn(api, 'saveLarkConfig').mockImplementation(() => new Promise<LarkConfig>((_resolve, reject) => { rejectSave = reject; }));

    renderWithClient(<Harness/>);
    await waitFor(() => expect(screen.getByRole('heading', { name: '测试助手' })).toBeTruthy());
    await user.type(screen.getByDisplayValue('/data/projects/bot1'), '-a');
    await user.click(screen.getByRole('button', { name: '保存配置' }));

    await user.click(screen.getByRole('button', { name: /第二助手/ }));
    await waitFor(() => expect(screen.getByRole('heading', { name: '第二助手' })).toBeTruthy());

    rejectSave(new ApiError('版本已过期', 'REVISION_CONFLICT', 409, { revision: 4 }));

    // B 上不该出现任何冲突提示；冲突属于 A。
    await waitFor(() => expect(screen.getByRole('heading', { name: '第二助手' })).toBeTruthy());
    expect(screen.queryByText(/别人刚改过这个机器人的配置/)).toBeNull();

    // 切回 A 才看得到那条冲突，草稿也还在。
    await user.click(screen.getByRole('button', { name: /测试助手/ }));
    await waitFor(() => expect(screen.getByText(/别人刚改过这个机器人的配置/)).toBeTruthy());
    expect(screen.getByDisplayValue('/data/projects/bot1-a')).toBeTruthy();
  });

  it('保存期间继续编辑同一个 Bot：新改动保留，基准换成刚保存的版本', async () => {
    const user = userEvent.setup();
    stubTwoBots();
    const saveSpy = vi.spyOn(api, 'saveLarkConfig').mockImplementationOnce(
      () => new Promise<LarkConfig>(resolve => { resolveFirst = resolve; })
    );
    let resolveFirst!: (value: LarkConfig) => void;

    renderWithClient(<Harness/>);
    await waitFor(() => expect(screen.getByRole('heading', { name: '测试助手' })).toBeTruthy());

    await user.type(screen.getByDisplayValue('/data/projects/bot1'), '-first');
    await user.click(screen.getByRole('button', { name: '保存配置' }));
    await waitFor(() => expect(saveSpy).toHaveBeenCalledWith(expect.objectContaining({ workspace: '/data/projects/bot1-first', expectedRevision: 3 })));

    // 请求还没回来，用户继续敲。
    await user.type(screen.getByDisplayValue('/data/projects/bot1-first'), '-more');

    // 服务端把 revision 推到 4。
    resolveFirst({ configured: true, bots: [{ ...mockBot, revision: 4, workspace: '/data/projects/bot1-first' }, botB], listeningDisabled: false });

    // 等待期间敲的字不能被抹掉。
    await waitFor(() => expect(screen.getByDisplayValue('/data/projects/bot1-first-more')).toBeTruthy());
    expect(screen.getByText(/有未保存的修改/)).toBeTruthy();

    // 再存一次：expectedRevision 必须是 4，不是 3——否则会撞出一个本不该有的 409。
    saveSpy.mockResolvedValueOnce({ configured: true, bots: [{ ...mockBot, revision: 5 }, botB], listeningDisabled: false });
    await user.click(screen.getByRole('button', { name: '保存配置' }));
    await waitFor(() => expect(saveSpy).toHaveBeenLastCalledWith(expect.objectContaining({ workspace: '/data/projects/bot1-first-more', expectedRevision: 4 })));
  });
});
