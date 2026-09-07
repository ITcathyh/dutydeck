import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, type Agent, type LarkBotConfig, type ManagedGroup } from '../api';
import type { GroupBinding, RoleAssignment } from '@dockmux/shared';
import { resetDrafts } from '../draft-store';
import { GroupManagement } from './GroupManagement';

// 草稿是模块级 store（切走视图也要留住），用例之间必须显式清空，否则互相串。
beforeEach(() => resetDrafts());
afterEach(() => { vi.restoreAllMocks(); resetDrafts(); });

const makeBot = (appId: string, name: string, workspace: string): LarkBotConfig => ({
  configured: true,
  appId,
  name,
  tabLabel: name,
  setupComplete: true,
  workspace,
  defaultAgentId: 'codex',
  defaultModel: 'gpt-4o',
  fullTrustConfirmed: true,
  preInjectPrompt: '',
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
  revision: 1,
  p2pMode: 'chat',
  groupReplyMode: 'chat',
  mentionPolicy: 'always'
});

const makeBinding = (overrides: Partial<GroupBinding> = {}): GroupBinding => ({
  schemaVersion: 1,
  id: 'binding_1',
  revision: 2,
  channelBotId: 'channel_bot_1',
  externalChatId: 'oc_chat_1',
  state: 'staged',
  oncall: false,
  agentOverride: { mode: 'inherit' },
  workspaceOverride: { mode: 'inherit' },
  modelOverride: { mode: 'inherit' },
  reasoningOverride: { mode: 'inherit' },
  rolePolicyOverride: { mode: 'inherit' },
  routingOverride: { groupReplyMode: { mode: 'inherit' }, mentionPolicy: { mode: 'inherit' } },
  accessOverride: { mode: 'inherit', principalIds: [] },
  groupToolsOverride: { read: 'inherit', discover: 'inherit', send: 'inherit' },
  presentationOverride: { mode: 'inherit' },
  reviewReasons: [],
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  ...overrides
});

const makeRole = (): RoleAssignment => ({
  schemaVersion: 1,
  id: 'role_1',
  revision: 1,
  channelBotId: 'channel_bot_1',
  groupBindingId: 'binding_1',
  principalId: 'principal_alice',
  role: 'can_talk',
  operateScope: 'none',
  actionGates: { terminalWrite: false, highRisk: false, groupToolsSend: false },
  state: 'active',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z'
});

const mockGroups: ManagedGroup[] = [
  {
    key: 'key_project',
    chatId: 'oc_chat_1',
    name: '研发项目群',
    bots: [
      {
        appId: 'cli_dev',
        channelBotId: 'channel_bot_1',
        binding: makeBinding(),
        membership: 'member',
        validity: 'valid',
        applied: true,
        roles: [makeRole()]
      },
      {
        appId: 'cli_review',
        membership: 'unknown',
        validity: 'unknown',
        applied: false,
        roles: []
      }
    ]
  },
  {
    key: 'key_oncall',
    chatId: 'oc_chat_2',
    name: '值班群',
    bots: [
      {
        appId: 'cli_dev',
        channelBotId: 'channel_bot_1',
        membership: 'member',
        validity: 'valid',
        applied: true,
        roles: []
      }
    ]
  }
];

const mockAgents: Agent[] = [
  { id: 'codex', name: 'Codex', protocol: 'acp', permissionMode: 'ask' },
  { id: 'claude', name: 'Claude Code', protocol: 'pty-cli', permissionMode: 'ask' }
];

function renderWithClient(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function stubBaseQueries() {
  vi.spyOn(api, 'larkConfig').mockResolvedValue({
    configured: true,
    bots: [makeBot('cli_dev', '开发助手', '/data/dev'), makeBot('cli_review', '评审助手', '/data/review')],
    listeningDisabled: false
  });
  vi.spyOn(api, 'agentModels').mockResolvedValue({ models: [{ id: 'gpt-4o', name: 'GPT-4o' }], reasoningEfforts: [] });
}

describe('GroupManagement', () => {
  it('列出群聊，并在群详情展示所有已知 Bot 及其继承或覆盖状态', async () => {
    stubBaseQueries();
    vi.spyOn(api, 'managementGroups').mockResolvedValue({ groups: mockGroups });

    renderWithClient(
      <GroupManagement
        selectedChatId="oc_chat_1"
        onSelectGroup={() => {}}
        onNavigateToBot={() => {}}
        agents={mockAgents}
      />
    );

    await waitFor(() => expect(screen.getByRole('heading', { name: '研发项目群' })).toBeTruthy());

    // 两个 Bot 都要展示
    expect(screen.getByText('开发助手')).toBeTruthy();
    expect(screen.getByText('评审助手')).toBeTruthy();

    // 覆盖 / 继承状态
    expect(screen.getByText('已生效')).toBeTruthy();
    expect(screen.getAllByText('继承 Bot 默认').length).toBeGreaterThan(0);
  });

  it('群列表读取失败时展示错误与重试，而不是空列表', async () => {
    stubBaseQueries();
    vi.spyOn(api, 'managementGroups').mockRejectedValue(new Error('群聊接口暂时不可用'));

    renderWithClient(
      <GroupManagement onSelectGroup={() => {}} onNavigateToBot={() => {}} agents={mockAgents} />
    );

    await waitFor(() => {
      expect(screen.getByText(/加载群列表失败：群聊接口暂时不可用/)).toBeTruthy();
    });
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
  });

  it('群列表为空时提供同步入口，点击调用 syncGroups', async () => {
    const user = userEvent.setup();
    stubBaseQueries();
    vi.spyOn(api, 'managementGroups').mockResolvedValue({ groups: [] });
    const syncSpy = vi.spyOn(api, 'syncGroups').mockResolvedValue({ groups: [] });

    renderWithClient(
      <GroupManagement onSelectGroup={() => {}} onNavigateToBot={() => {}} agents={mockAgents} />
    );

    await waitFor(() => expect(screen.getByText('暂未发现任何飞书群聊')).toBeTruthy());
    await user.click(screen.getByRole('button', { name: /立即同步群聊/ }));
    /*
      必须同步**全部**已配置 Bot。只同步当前那个有死结：第二个 Bot 还没出现在
      群列表里，用户就选不到它，也就永远同步不了它。
    */
    await waitFor(() => expect(syncSpy).toHaveBeenCalledWith('cli_dev'));
    await waitFor(() => expect(syncSpy).toHaveBeenCalledWith('cli_review'));
    expect(syncSpy).toHaveBeenCalledTimes(2);
  });

  it('切换目录为本群单独设置后保存，patch 带 workspaceOverride 与 expectedRevision', async () => {
    const user = userEvent.setup();
    stubBaseQueries();
    vi.spyOn(api, 'managementGroups').mockResolvedValue({ groups: mockGroups });
    const saveSpy = vi.spyOn(api, 'updateGroupBotBinding').mockResolvedValue(mockGroups[0].bots[0]);

    renderWithClient(
      <GroupManagement
        selectedChatId="oc_chat_1"
        selectedAppId="cli_dev"
        onSelectGroup={() => {}}
        onNavigateToBot={() => {}}
        agents={mockAgents}
      />
    );

    await waitFor(() => expect(screen.getByText(/正在配置/)).toBeTruthy());

    // 工作目录切成本群单独设置
    const workspaceRadios = screen.getAllByRole('radio', { name: '本群单独设置' });
    // [0] Agent, [1] workspace
    await user.click(workspaceRadios[1]);

    const dirInput = screen.getByPlaceholderText('例如 /data/projects/oncall');
    await user.type(dirInput, '/data/projects/oncall');

    await user.click(screen.getByRole('button', { name: '保存配置' }));

    await waitFor(() => {
      expect(saveSpy).toHaveBeenCalledWith(
        'cli_dev',
        'oc_chat_1',
        expect.objectContaining({
          expectedRevision: 2,
          patch: expect.objectContaining({
            workspaceOverride: { mode: 'set', value: '/data/projects/oncall' }
          })
        })
      );
    });
  });

  it('清空模型与继承是不同状态，清空提交 mode:clear', async () => {
    const user = userEvent.setup();
    stubBaseQueries();
    vi.spyOn(api, 'managementGroups').mockResolvedValue({ groups: mockGroups });
    const saveSpy = vi.spyOn(api, 'updateGroupBotBinding').mockResolvedValue(mockGroups[0].bots[0]);

    renderWithClient(
      <GroupManagement
        selectedChatId="oc_chat_1"
        selectedAppId="cli_dev"
        onSelectGroup={() => {}}
        onNavigateToBot={() => {}}
        agents={mockAgents}
      />
    );

    await waitFor(() => expect(screen.getByText(/正在配置/)).toBeTruthy());

    await user.click(screen.getByRole('radio', { name: /使用 Agent 默认/ }));
    await user.click(screen.getByRole('button', { name: '保存配置' }));

    await waitFor(() => {
      expect(saveSpy).toHaveBeenCalledWith(
        'cli_dev',
        'oc_chat_1',
        expect.objectContaining({
          patch: expect.objectContaining({ modelOverride: { mode: 'clear' } })
        })
      );
    });
  });

  it('撤销成员授权与行为字段在同一次事务提交', async () => {
    const user = userEvent.setup();
    stubBaseQueries();
    vi.spyOn(api, 'managementGroups').mockResolvedValue({ groups: mockGroups });
    vi.spyOn(api, 'groupMembers').mockResolvedValue({ members: [] });
    const saveSpy = vi.spyOn(api, 'updateGroupBotBinding').mockResolvedValue(mockGroups[0].bots[0]);

    renderWithClient(
      <GroupManagement
        selectedChatId="oc_chat_1"
        selectedAppId="cli_dev"
        onSelectGroup={() => {}}
        onNavigateToBot={() => {}}
        agents={mockAgents}
      />
    );

    await waitFor(() => expect(screen.getByText(/正在配置/)).toBeTruthy());

    // 展开角色授权区
    await user.click(screen.getByRole('button', { name: /成员使用与操作授权/ }));
    expect(screen.getByText('principal_alice')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: '撤销授权' }));
    expect(screen.getByText(/更新授权：role_1 -> revoked/)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: '保存配置' }));

    await waitFor(() => {
      expect(saveSpy).toHaveBeenCalledWith(
        'cli_dev',
        'oc_chat_1',
        expect.objectContaining({
          roleChanges: [
            { kind: 'update', id: 'role_1', expectedRevision: 1, patch: { state: 'revoked' } }
          ]
        })
      );
    });
  });

  it('保存冲突返回 409 时展示冲突并保留草稿', async () => {
    const user = userEvent.setup();
    stubBaseQueries();
    vi.spyOn(api, 'managementGroups').mockResolvedValue({ groups: mockGroups });
    vi.spyOn(api, 'updateGroupBotBinding').mockRejectedValue(
      new ApiError('群绑定版本已过期', 'REVISION_CONFLICT', 409, { revision: 3 })
    );

    renderWithClient(
      <GroupManagement
        selectedChatId="oc_chat_1"
        selectedAppId="cli_dev"
        onSelectGroup={() => {}}
        onNavigateToBot={() => {}}
        agents={mockAgents}
      />
    );

    await waitFor(() => expect(screen.getByText(/正在配置/)).toBeTruthy());

    await user.click(screen.getByRole('radio', { name: /使用 Agent 默认/ }));
    await user.click(screen.getByRole('button', { name: '保存配置' }));

    await waitFor(() => {
      expect(screen.getByText(/别人刚改过这个群的设置/)).toBeTruthy();
      expect(screen.getByText(/群绑定版本已过期/)).toBeTruthy();
    });

    // 草稿仍在（清空选项仍被选中，保存按钮仍可用）
    expect((screen.getByRole('radio', { name: /使用 Agent 默认/ }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('button', { name: '保存配置' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('切换正在编辑的 Bot 时保留另一个 Bot 的草稿', async () => {
    const user = userEvent.setup();
    stubBaseQueries();
    vi.spyOn(api, 'managementGroups').mockResolvedValue({ groups: mockGroups });

    renderWithClient(
      <GroupManagement
        selectedChatId="oc_chat_1"
        selectedAppId="cli_dev"
        onSelectGroup={() => {}}
        onNavigateToBot={() => {}}
        agents={mockAgents}
      />
    );

    await waitFor(() => expect(screen.getByText(/正在配置/)).toBeTruthy());

    await user.click(screen.getByRole('radio', { name: /使用 Agent 默认/ }));
    expect(screen.getByText(/有未保存的修改/)).toBeTruthy();

    // 切到另一个 Bot
    const configButtons = screen.getAllByRole('button', { name: '配置' });
    await user.click(configButtons[0]);
    await waitFor(() => expect(screen.getByText(/研发项目群 \/ 评审助手/)).toBeTruthy());
    expect(screen.getByText(/已保存/)).toBeTruthy();

    // 切回原 Bot，草稿仍在
    await user.click(screen.getAllByRole('button', { name: '配置' })[0]);
    await waitFor(() => expect(screen.getByText(/研发项目群 \/ 开发助手/)).toBeTruthy());
    expect(screen.getByText(/有未保存的修改/)).toBeTruthy();
  });
});

/*
  控制器复核提出的五点，逐条守一次。每条对应一个真实会出错的场景，
  不是把已有断言换个说法再写一遍。
*/
describe('GroupManagement 访问范围、角色边界与跨租户隔离', () => {
  it('访问范围可选继承/全员/指定成员/停用，指定成员从 members API 取 principal 并进 patch', async () => {
    const user = userEvent.setup();
    stubBaseQueries();
    vi.spyOn(api, 'managementGroups').mockResolvedValue({ groups: mockGroups });
    vi.spyOn(api, 'groupMembers').mockResolvedValue({
      members: [
        { principalId: 'principal_alice', openId: 'ou_alice', name: '爱丽丝' },
        { principalId: 'principal_bob', openId: 'ou_bob', name: '鲍勃' }
      ]
    });
    const saveSpy = vi.spyOn(api, 'updateGroupBotBinding').mockResolvedValue(mockGroups[0].bots[0]);

    renderWithClient(
      <GroupManagement selectedChatId="oc_chat_1" selectedAppId="cli_dev" onSelectGroup={() => {}} onNavigateToBot={() => {}} agents={mockAgents}/>
    );
    await waitFor(() => expect(screen.getByText(/正在配置/)).toBeTruthy());

    const accessSelect = screen.getByLabelText('访问范围') as HTMLSelectElement;
    // 四档都必须在，且 oncall / 角色不能替代它。
    const optionValues = [...accessSelect.options].map(o => o.value);
    expect(optionValues).toEqual(expect.arrayContaining(['inherit', 'all_chat_members', 'allowlist', 'owner_only', 'disabled']));

    await user.selectOptions(accessSelect, 'allowlist');
    // 空名单要明说保存会被拒，而不是让用户提交后才知道。
    expect(screen.getByText(/名单为空时保存会被拒绝/)).toBeTruthy();

    // principal 来自 members API，用户看到的是人名不是不透明 ID。
    await waitFor(() => expect(screen.getByLabelText('添加群成员')).toBeTruthy());
    await user.selectOptions(screen.getByLabelText('添加群成员'), 'principal_bob');
    expect(screen.getByText('鲍勃')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: '保存配置' }));
    await waitFor(() => {
      expect(saveSpy).toHaveBeenCalledWith('cli_dev', 'oc_chat_1', expect.objectContaining({
        patch: expect.objectContaining({ accessOverride: { mode: 'allowlist', principalIds: ['principal_bob'] } })
      }));
    });
  });

  it('切回非 allowlist 时不再发送 principalIds', async () => {
    const user = userEvent.setup();
    stubBaseQueries();
    vi.spyOn(api, 'managementGroups').mockResolvedValue({ groups: mockGroups });
    vi.spyOn(api, 'groupMembers').mockResolvedValue({ members: [{ principalId: 'principal_alice', openId: 'ou_alice', name: '爱丽丝' }] });
    const saveSpy = vi.spyOn(api, 'updateGroupBotBinding').mockResolvedValue(mockGroups[0].bots[0]);

    renderWithClient(
      <GroupManagement selectedChatId="oc_chat_1" selectedAppId="cli_dev" onSelectGroup={() => {}} onNavigateToBot={() => {}} agents={mockAgents}/>
    );
    await waitFor(() => expect(screen.getByText(/正在配置/)).toBeTruthy());

    const accessSelect = screen.getByLabelText('访问范围');
    await user.selectOptions(accessSelect, 'allowlist');
    await waitFor(() => expect(screen.getByLabelText('添加群成员')).toBeTruthy());
    await user.selectOptions(screen.getByLabelText('添加群成员'), 'principal_alice');
    // 又改主意，改成全员可用：名单不能跟着一起提交上去。
    await user.selectOptions(accessSelect, 'all_chat_members');

    await user.click(screen.getByRole('button', { name: '保存配置' }));
    await waitFor(() => {
      expect(saveSpy).toHaveBeenCalledWith('cli_dev', 'oc_chat_1', expect.objectContaining({
        patch: expect.objectContaining({ accessOverride: { mode: 'all_chat_members', principalIds: [] } })
      }));
    });
  });

  it('群角色编辑器不提供 admin 与 bot_runs，只到本群范围', async () => {
    const user = userEvent.setup();
    stubBaseQueries();
    vi.spyOn(api, 'managementGroups').mockResolvedValue({ groups: mockGroups });
    vi.spyOn(api, 'groupMembers').mockResolvedValue({ members: [{ principalId: 'principal_alice', openId: 'ou_alice', name: '爱丽丝' }] });

    renderWithClient(
      <GroupManagement selectedChatId="oc_chat_1" selectedAppId="cli_dev" onSelectGroup={() => {}} onNavigateToBot={() => {}} agents={mockAgents}/>
    );
    await waitFor(() => expect(screen.getByText(/正在配置/)).toBeTruthy());
    await user.click(screen.getByRole('button', { name: /成员使用与操作授权/ }));

    const kindSelect = screen.getByLabelText('权限') as HTMLSelectElement;
    // admin 是跨群授权，从「配置这一个群」里授出去会溢出到别的群。
    expect([...kindSelect.options].map(o => o.value)).toEqual(['can_talk', 'can_operate']);

    await user.selectOptions(kindSelect, 'can_operate');
    const scopeSelect = screen.getByLabelText('范围') as HTMLSelectElement;
    // bot_runs 会让这个人能操作该 Bot 在所有群里的任务，同样溢出。
    expect([...scopeSelect.options].map(o => o.value)).toEqual(['own_runs', 'group_runs']);
  });

  it('新增角色提交 can_operate 时带本群范围，不带 bot_runs', async () => {
    const user = userEvent.setup();
    stubBaseQueries();
    vi.spyOn(api, 'managementGroups').mockResolvedValue({ groups: mockGroups });
    vi.spyOn(api, 'groupMembers').mockResolvedValue({ members: [{ principalId: 'principal_bob', openId: 'ou_bob', name: '鲍勃' }] });
    const saveSpy = vi.spyOn(api, 'updateGroupBotBinding').mockResolvedValue(mockGroups[0].bots[0]);

    renderWithClient(
      <GroupManagement selectedChatId="oc_chat_1" selectedAppId="cli_dev" onSelectGroup={() => {}} onNavigateToBot={() => {}} agents={mockAgents}/>
    );
    await waitFor(() => expect(screen.getByText(/正在配置/)).toBeTruthy());
    await user.click(screen.getByRole('button', { name: /成员使用与操作授权/ }));

    await waitFor(() => expect(screen.getByLabelText('成员')).toBeTruthy());
    await user.selectOptions(screen.getByLabelText('成员'), 'principal_bob');
    await user.selectOptions(screen.getByLabelText('权限'), 'can_operate');
    await user.selectOptions(screen.getByLabelText('范围'), 'group_runs');
    await user.click(screen.getByRole('button', { name: /添加/ }));

    await user.click(screen.getByRole('button', { name: '保存配置' }));
    await waitFor(() => {
      expect(saveSpy).toHaveBeenCalledWith('cli_dev', 'oc_chat_1', expect.objectContaining({
        roleChanges: [{
          kind: 'create',
          principalId: 'principal_bob',
          role: 'can_operate',
          operateScope: 'group_runs',
          actionGates: { terminalWrite: false, highRisk: false, groupToolsSend: false }
        }]
      }));
    });
  });

  it('跨租户同 chatId 的两个群按 appId 收窄，不落到首项', async () => {
    stubBaseQueries();
    // 同一个 chatId 在两个租户下各有一份，服务端用不同的 key 区分。
    vi.spyOn(api, 'managementGroups').mockResolvedValue({ groups: [
      { key: 'tenant_a:oc_dup', chatId: 'oc_dup', name: '租户 A 的群', bots: [{ appId: 'cli_dev', membership: 'member', validity: 'valid', applied: true, roles: [] }] },
      { key: 'tenant_b:oc_dup', chatId: 'oc_dup', name: '租户 B 的群', bots: [{ appId: 'cli_review', membership: 'member', validity: 'valid', applied: true, roles: [] }] }
    ] });

    renderWithClient(
      <GroupManagement selectedChatId="oc_dup" selectedAppId="cli_review" onSelectGroup={() => {}} onNavigateToBot={() => {}} agents={mockAgents}/>
    );

    // 选中的必须是含 cli_review 的那一个（租户 B），不是列表首项。
    await waitFor(() => expect(screen.getByRole('heading', { name: '租户 B 的群' })).toBeTruthy());
    expect(screen.queryByRole('heading', { name: '租户 A 的群' })).toBeNull();
  });

  it('effective 未解析时说「按现有默认行为」，不谎称某个具体模式已生效', async () => {
    stubBaseQueries();
    // 服务端没解析出群级取值：value 缺失、source 为 unconfigured。
    vi.spyOn(api, 'managementGroups').mockResolvedValue({ groups: [{
      key: 'k_legacy',
      chatId: 'oc_legacy',
      name: '遗留行为群',
      bots: [{
        appId: 'cli_dev',
        membership: 'member',
        validity: 'valid',
        applied: true,
        roles: [],
        effective: {
          agent: { value: undefined, source: 'unconfigured' },
          workspace: { value: undefined, source: 'unconfigured' },
          model: { value: undefined, source: 'unconfigured' },
          reasoningEffort: { value: undefined, source: 'unconfigured' },
          rolePolicyRef: { value: undefined, source: 'unconfigured' },
          routing: {
            groupReplyMode: { value: undefined, source: 'unconfigured' },
            mentionPolicy: { value: undefined, source: 'unconfigured' }
          },
          access: { mode: 'owner_only', principalIds: [], source: 'bot_default' },
          groupTools: {
            read: { allowed: false, source: 'bot_default', requested: false },
            discover: { allowed: false, source: 'bot_default', requested: false },
            send: { allowed: false, source: 'bot_default', requested: false }
          },
          talkGrant: 'owner_only',
          explanations: []
        } as never
      }]
    }] });

    renderWithClient(
      <GroupManagement selectedChatId="oc_legacy" selectedAppId="cli_dev" onSelectGroup={() => {}} onNavigateToBot={() => {}} agents={mockAgents}/>
    );
    await waitFor(() => expect(screen.getByText(/正在配置/)).toBeTruthy());

    // 「当前生效」两行都必须说现有默认行为，不能显示 chat / chat-topic / always。
    const effectiveNotes = screen.getAllByText('当前生效：按现有默认行为');
    expect(effectiveNotes.length).toBe(2);
    expect(screen.queryByText('当前生效：chat-topic')).toBeNull();
    expect(screen.queryByText('当前生效：always')).toBeNull();
  });
});

/*
  响应式与布局纪律。

  验收要求「桌面 list/detail、窄屏单列、无横向溢出、无嵌套弹窗」。这几条在 jsdom
  里量不到真实像素，所以断言的是产生这些行为的类名契约与 DOM 结构——它们是
  Playwright 视觉验收之前的第一道防线，不是替代品。
*/
describe('GroupManagement 布局与响应式', () => {
  it('桌面 list/detail 两栏，窄屏各自单列：选中群后列表让位给详情', async () => {
    stubBaseQueries();
    vi.spyOn(api, 'managementGroups').mockResolvedValue({ groups: mockGroups });
    const { container } = renderWithClient(
      <GroupManagement selectedChatId="oc_chat_1" selectedAppId="cli_dev" onSelectGroup={() => {}} onNavigateToBot={() => {}} agents={mockAgents}/>
    );
    await waitFor(() => expect(screen.getByRole('heading', { name: '研发项目群' })).toBeTruthy());

    const aside = container.querySelector('aside')!;
    const main = container.querySelector('main')!;
    // 选中了群：窄屏只显示详情（列表 hidden），md 以上两栏并存。
    expect(aside.className).toContain('hidden');
    expect(aside.className).toContain('md:flex');
    expect(main.className).toContain('flex');
    // 窄屏必须有回列表的路，否则用户进了详情就出不来。
    expect(screen.getByRole('button', { name: /返回群聊列表/ })).toBeTruthy();
  });

  it('未选中群时窄屏显示列表，详情区不抢占', async () => {
    stubBaseQueries();
    vi.spyOn(api, 'managementGroups').mockResolvedValue({ groups: [] });
    const { container } = renderWithClient(
      <GroupManagement onSelectGroup={() => {}} onNavigateToBot={() => {}} agents={mockAgents}/>
    );
    await waitFor(() => expect(screen.getByText('暂未发现任何飞书群聊')).toBeTruthy());

    const aside = container.querySelector('aside')!;
    const main = container.querySelector('main')!;
    expect(aside.className).not.toContain('hidden');
    expect(main.className).toContain('hidden md:flex');
  });

  it('编辑器在页面内展开，不是叠在群列表上的第二层弹窗', async () => {
    stubBaseQueries();
    vi.spyOn(api, 'managementGroups').mockResolvedValue({ groups: mockGroups });
    renderWithClient(
      <GroupManagement selectedChatId="oc_chat_1" selectedAppId="cli_dev" onSelectGroup={() => {}} onNavigateToBot={() => {}} agents={mockAgents}/>
    );
    await waitFor(() => expect(screen.getByText(/正在配置/)).toBeTruthy());
    // 群内 Bot 编辑器不得是 dialog：验收明写「不做嵌套弹窗」。
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('可滚动区不产生横向溢出：主区只允许纵向滚动', async () => {
    stubBaseQueries();
    vi.spyOn(api, 'managementGroups').mockResolvedValue({ groups: mockGroups });
    const { container } = renderWithClient(
      <GroupManagement selectedChatId="oc_chat_1" selectedAppId="cli_dev" onSelectGroup={() => {}} onNavigateToBot={() => {}} agents={mockAgents}/>
    );
    await waitFor(() => expect(screen.getByText(/正在配置/)).toBeTruthy());

    const main = container.querySelector('main')!;
    expect(main.className).toContain('overflow-y-auto');
    expect(main.className).not.toContain('overflow-x-auto');
    // 群列表与详情的容器都不得出现 overflow-x-scroll / w-max 这类横向逃逸写法。
    for (const node of container.querySelectorAll('div,aside,main,section')) {
      expect(node.className).not.toMatch(/overflow-x-(auto|scroll)|\bw-max\b/);
    }
  });
});

describe('GroupManagement 同步与选中的真实行为', () => {
  it('某个 Bot 同步失败时点名它，成功的部分仍然刷新可见', async () => {
    const user = userEvent.setup();
    stubBaseQueries();
    vi.spyOn(api, 'managementGroups').mockResolvedValue({ groups: [] });
    const syncSpy = vi.spyOn(api, 'syncGroups').mockImplementation(async (appId: string) => {
      if (appId === 'cli_review') throw new Error('凭据已失效');
      return { groups: [] };
    });

    renderWithClient(
      <GroupManagement onSelectGroup={() => {}} onNavigateToBot={() => {}} agents={mockAgents}/>
    );
    await waitFor(() => expect(screen.getByText('暂未发现任何飞书群聊')).toBeTruthy());
    await user.click(screen.getByRole('button', { name: /立即同步群聊/ }));

    // 一个失败不该让另一个也不跑。
    await waitFor(() => expect(syncSpy).toHaveBeenCalledTimes(2));
    // 结果要点名是哪个 Bot 失败，不能笼统说「同步失败」。
    await waitFor(() => expect(screen.getByText(/评审助手：凭据已失效/)).toBeTruthy());
    expect(screen.getByText(/1 个机器人同步成功，1 个失败/)).toBeTruthy();
  });

  it('群内切换 Bot 会更新 URL，刷新后仍停在这个 Bot', async () => {
    const user = userEvent.setup();
    stubBaseQueries();
    vi.spyOn(api, 'managementGroups').mockResolvedValue({ groups: mockGroups });
    const onSelectGroup = vi.fn();

    renderWithClient(
      <GroupManagement selectedChatId="oc_chat_1" selectedAppId="cli_dev" onSelectGroup={onSelectGroup} onNavigateToBot={() => {}} agents={mockAgents}/>
    );
    await waitFor(() => expect(screen.getByText(/研发项目群 \/ 开发助手/)).toBeTruthy());

    // 切到群里的另一个 Bot：必须带 appId 写进 URL，否则刷新后落回第一个。
    await user.click(screen.getByRole('button', { name: '配置' }));
    expect(onSelectGroup).toHaveBeenCalledWith('oc_chat_1', 'cli_review');
  });

  it('没有选中群时不自动选首项，窄屏才退得回列表', async () => {
    stubBaseQueries();
    vi.spyOn(api, 'managementGroups').mockResolvedValue({ groups: mockGroups });

    renderWithClient(
      <GroupManagement onSelectGroup={() => {}} onNavigateToBot={() => {}} agents={mockAgents}/>
    );
    // 列表里有群，但详情区是空态，不是自动选中的第一个群。
    await waitFor(() => expect(screen.getByText('未选择群聊')).toBeTruthy());
    expect(screen.queryByRole('heading', { name: '研发项目群' })).toBeNull();
  });
});

/*
  保存请求在飞的时候切换对象 / 继续编辑。

  回调若读闭包里的 draftKey，A 的成功会去清 B 的草稿、A 的 409 会贴到 B 的编辑器上。
  用真实 deferred promise 把请求停在半空，断言落在「回调执行时当前对象已经不是提交
  对象」这一刻。
*/
describe('GroupManagement 保存期间切换对象与继续编辑', () => {
  /** 受控选择：真实 App 靠 URL 驱动，这里用一层 state 复现同样的切换。 */
  function Harness() {
    const [sel, setSel] = useState<{ chatId: string; appId?: string }>({ chatId: 'oc_chat_1', appId: 'cli_dev' });
    return <GroupManagement
      selectedChatId={sel.chatId}
      selectedAppId={sel.appId}
      onSelectGroup={(chatId, appId) => setSel({ chatId, appId })}
      onNavigateToBot={() => {}}
      agents={mockAgents}
    />;
  }

  it('保存 A 群期间切到 B 群：A 成功不清 B 的草稿', async () => {
    const user = userEvent.setup();
    stubBaseQueries();
    vi.spyOn(api, 'managementGroups').mockResolvedValue({ groups: mockGroups });
    let resolveSave!: (value: ManagedGroup['bots'][number]) => void;
    vi.spyOn(api, 'updateGroupBotBinding').mockImplementation(
      () => new Promise<ManagedGroup['bots'][number]>(resolve => { resolveSave = resolve; })
    );

    renderWithClient(<Harness/>);
    await waitFor(() => expect(screen.getByText(/研发项目群 \/ 开发助手/)).toBeTruthy());

    // 改 A 群并提交，请求停在半空。
    await user.click(screen.getByRole('radio', { name: '使用 Agent 默认' }));
    await user.click(screen.getByRole('button', { name: '保存配置' }));

    // 切到值班群，给它也留一份草稿。
    await user.click(screen.getByRole('button', { name: /值班群/ }));
    await waitFor(() => expect(screen.getByText(/值班群 \/ 开发助手/)).toBeTruthy());
    await user.click(screen.getByRole('radio', { name: '使用 Agent 默认' }));
    expect(screen.getByText(/有未保存的修改/)).toBeTruthy();

    // A 群的请求这时才回来。
    resolveSave({ ...mockGroups[0].bots[0], binding: makeBinding({ revision: 3, modelOverride: { mode: 'clear' } }) });

    // 值班群的草稿必须原样还在——它从来没有被提交过。
    await waitFor(() => expect(screen.getByText(/值班群 \/ 开发助手/)).toBeTruthy());
    expect((screen.getByRole('radio', { name: '使用 Agent 默认' }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText(/有未保存的修改/)).toBeTruthy();
  });

  it('保存 A 群期间切到 B 群：A 的 409 不贴到 B 的编辑器上', async () => {
    const user = userEvent.setup();
    stubBaseQueries();
    vi.spyOn(api, 'managementGroups').mockResolvedValue({ groups: mockGroups });
    let rejectSave!: (reason: unknown) => void;
    vi.spyOn(api, 'updateGroupBotBinding').mockImplementation(
      () => new Promise<ManagedGroup['bots'][number]>((_resolve, reject) => { rejectSave = reject; })
    );

    renderWithClient(<Harness/>);
    await waitFor(() => expect(screen.getByText(/研发项目群 \/ 开发助手/)).toBeTruthy());
    await user.click(screen.getByRole('radio', { name: '使用 Agent 默认' }));
    await user.click(screen.getByRole('button', { name: '保存配置' }));

    await user.click(screen.getByRole('button', { name: /值班群/ }));
    await waitFor(() => expect(screen.getByText(/值班群 \/ 开发助手/)).toBeTruthy());

    rejectSave(new ApiError('群绑定版本已过期', 'REVISION_CONFLICT', 409, { revision: 3 }));

    // 值班群上不该出现冲突提示；冲突属于研发项目群。
    await waitFor(() => expect(screen.getByText(/值班群 \/ 开发助手/)).toBeTruthy());
    expect(screen.queryByText(/别人刚改过这个群的设置/)).toBeNull();

    // 切回去才看得到，草稿也还在。
    await user.click(screen.getByRole('button', { name: /研发项目群/ }));
    await waitFor(() => expect(screen.getByText(/别人刚改过这个群的设置/)).toBeTruthy());
    expect((screen.getByRole('radio', { name: '使用 Agent 默认' }) as HTMLInputElement).checked).toBe(true);
  });

  it('保存期间继续编辑同一个群：新改动保留，基准换成刚保存的版本', async () => {
    const user = userEvent.setup();
    stubBaseQueries();
    vi.spyOn(api, 'managementGroups').mockResolvedValue({ groups: mockGroups });
    vi.spyOn(api, 'groupMembers').mockResolvedValue({ members: [{ principalId: 'principal_alice', openId: 'ou_alice', name: 'Alice' }], hasMore: false });
    let resolveFirst!: (value: ManagedGroup['bots'][number]) => void;
    const saveSpy = vi.spyOn(api, 'updateGroupBotBinding').mockImplementationOnce(
      () => new Promise<ManagedGroup['bots'][number]>(resolve => { resolveFirst = resolve; })
    );

    renderWithClient(<Harness/>);
    await waitFor(() => expect(screen.getByText(/研发项目群 \/ 开发助手/)).toBeTruthy());

    await user.click(screen.getByRole('radio', { name: '使用 Agent 默认' }));
    await user.click(screen.getByRole('button', { name: /成员使用与操作授权/ }));
    await user.selectOptions(await screen.findByRole('combobox', { name: '成员' }), 'principal_alice');
    await user.click(screen.getByRole('button', { name: '添加' }));
    await user.click(screen.getByRole('button', { name: '保存配置' }));
    await waitFor(() => expect(saveSpy).toHaveBeenCalledWith('cli_dev', 'oc_chat_1', expect.objectContaining({ expectedRevision: 2 })));

    // 请求还没回来，用户继续改（本群单独开 oncall）。
    await user.click(screen.getByRole('button', { name: /群工具与值班设置/ }));
    await user.click(screen.getByRole('checkbox', { name: /启用本群 Oncall 模式/ }));

    // 服务端把 revision 推到 3。
    resolveFirst({ ...mockGroups[0].bots[0], binding: makeBinding({ revision: 3, modelOverride: { mode: 'clear' } }) });

    // 等待期间改的东西不能被抹掉。
    await waitFor(() => expect(screen.getByText(/有未保存的修改/)).toBeTruthy());
    expect((screen.getByRole('checkbox', { name: /启用本群 Oncall 模式/ }) as HTMLInputElement).checked).toBe(true);

    // 再存一次：expectedRevision 必须是 3，不是 2。
    saveSpy.mockResolvedValueOnce({ ...mockGroups[0].bots[0], binding: makeBinding({ revision: 4 }) });
    await user.click(screen.getByRole('button', { name: '保存配置' }));
    await waitFor(() => expect(saveSpy).toHaveBeenLastCalledWith('cli_dev', 'oc_chat_1', expect.objectContaining({
      expectedRevision: 3,
      roleChanges: undefined,
      patch: expect.objectContaining({ oncall: true })
    })));
  });
});
