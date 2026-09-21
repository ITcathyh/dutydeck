// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  ApiError,
  collaborationApi,
  type CollaborationOverview,
  type CollaborationSettings
} from '../api';
import { CollaborationPanel } from './CollaborationPanel';

const now = '2026-09-18T01:00:00.000Z';

const makeSettings = (overrides: Partial<CollaborationSettings> = {}): CollaborationSettings => ({
  scope: { appId: 'cli_a', chatId: 'oc_a' },
  revision: 1,
  participation: 'off',
  inheritParticipation: false,
  instructions: '',
  notificationsPaused: false,
  maxProactivePerHour: 6,
  retentionDays: 30,
  policyVersion: 'v1',
  updatedAt: now,
  ...overrides
});

const makeOverview = (
  settings = makeSettings(),
  overrides: Partial<CollaborationOverview> = {}
): CollaborationOverview => ({
  snapshot: {
    scope: settings.scope,
    contextRevision: 3,
    settings,
    observations: [],
    followups: [],
    mandates: [],
    bootstrap: { scope: settings.scope, status: 'complete', missing: [], updatedAt: now }
  },
  followups: [],
  mandates: [],
  decisions: [],
  actions: [],
  activities: [],
  feedback: [],
  ...overrides
});

function renderPanel(
  props: { appId: string; chatId: string } = { appId: 'cli_a', chatId: 'oc_a' }
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  });
  return render(
    <QueryClientProvider client={client}>
      <CollaborationPanel {...props} />
    </QueryClientProvider>
  );
}

let getOverview: ReturnType<typeof vi.fn>;

beforeEach(() => {
  getOverview = vi
    .fn()
    .mockImplementation((appId: string) =>
      Promise.resolve(
        makeOverview(
          makeSettings({
            scope: { appId, chatId: appId === 'cli_a' ? 'oc_a' : 'oc_b' },
            instructions: appId === 'cli_a' ? '群A长期指令' : '群B长期指令'
          })
        )
      )
    );
  vi.spyOn(collaborationApi, 'getOverview').mockImplementation(getOverview as never);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('CollaborationPanel scope 隔离与参与模式文案', () => {
  it('切换群时用 key 重建子 panel，query 与设置草稿互不串联', async () => {
    const user = userEvent.setup();
    const { rerender } = renderPanel();
    const inputA = await screen.findByLabelText('长期指令');
    await waitFor(() => expect((inputA as HTMLTextAreaElement).value).toBe('群A长期指令'));
    await user.clear(inputA);
    await user.type(inputA, '群A未保存草稿');

    // 切到另一个群 + 另一个 Bot：草稿必须被丢弃，显示 B 群自己的服务端值。
    rerender(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}
      >
        <CollaborationPanel appId="cli_b" chatId="oc_b" />
      </QueryClientProvider>
    );

    const inputB = await screen.findByLabelText('长期指令');
    await waitFor(() => expect((inputB as HTMLTextAreaElement).value).toBe('群B长期指令'));
    expect(getOverview).toHaveBeenCalledWith('cli_b', 'oc_b');
    expect(getOverview).toHaveBeenCalledWith('cli_a', 'oc_a');
  });

  it('off 参与模式文案展示“沿用原群参与规则”，不写“仅响应@”', async () => {
    renderPanel();
    expect(await screen.findByText('沿用原群参与规则')).toBeTruthy();
    expect(screen.queryByText(/仅响应@/)).toBeNull();
  });
});

describe('协作设置保存与版本冲突', () => {
  it('加载继承模式及生效值，修改指令后保存仍跟随机器人默认', async () => {
    const user = userEvent.setup();
    const settings = makeSettings({ inheritParticipation: true, participation: 'selective' });
    getOverview.mockResolvedValue(makeOverview(settings));
    const update = vi.spyOn(collaborationApi, 'updateSettings').mockResolvedValue({ settings });
    renderPanel();
    const inherit = await screen.findByRole('button', { name: /跟随机器人默认/ });
    expect(inherit.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('当前生效：按需参与 (selective)')).toBeTruthy();
    expect(screen.getByRole('button', { name: /按需参与/ }).getAttribute('aria-pressed')).toBe('false');
    expect((screen.getByRole('button', { name: '保存设置' }) as HTMLButtonElement).disabled).toBe(true);
    await user.type(screen.getByLabelText('长期指令'), '简短回复');
    await user.click(screen.getByRole('button', { name: '保存设置' }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0]![2]).toMatchObject({ inheritParticipation: true, instructions: '简短回复' });
    expect(update.mock.calls[0]![2]).not.toHaveProperty('participation');
  });

  it('显式 off 覆盖继承，恢复继承仅切换标记也可以保存', async () => {
    const user = userEvent.setup();
    const settings = makeSettings({ inheritParticipation: true });
    getOverview.mockResolvedValue(makeOverview(settings));
    const update = vi.spyOn(collaborationApi, 'updateSettings').mockImplementation(async (_app, _chat, body) => {
      const saved = { ...settings, ...body, revision: settings.revision + 1 };
      getOverview.mockResolvedValue(makeOverview(saved));
      return { settings: saved };
    });
    renderPanel();
    await user.click(await screen.findByRole('button', { name: /保持原行为/ }));
    await user.click(screen.getByRole('button', { name: '保存设置' }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0]![2]).toMatchObject({ inheritParticipation: false, participation: 'off' });
    await waitFor(() => expect(screen.getByRole('button', { name: /保持原行为/ }).getAttribute('aria-pressed')).toBe('true'));
    await user.click(screen.getByRole('button', { name: /跟随机器人默认/ }));
    await user.click(screen.getByRole('button', { name: '保存设置' }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
    expect(update.mock.calls[1]![2]).toMatchObject({ expectedRevision: 2, inheritParticipation: true });
    expect(update.mock.calls[1]![2]).not.toHaveProperty('participation');
    await waitFor(() => expect(screen.getByRole('button', { name: /跟随机器人默认/ }).getAttribute('aria-pressed')).toBe('true'));
  });

  it('保存时带当前 expectedRevision，409 冲突保留草稿而不是谎报成功', async () => {
    const user = userEvent.setup();
    const updateSettings = vi
      .spyOn(collaborationApi, 'updateSettings')
      .mockRejectedValueOnce(new ApiError('stale', 'COLLABORATION_REVISION_CONFLICT', 409))
      .mockResolvedValueOnce({
        settings: makeSettings({ revision: 2, instructions: '只观察，不主动发言' })
      });

    renderPanel();
    const input = await screen.findByLabelText('长期指令');
    await waitFor(() => expect((input as HTMLTextAreaElement).value).toBe('群A长期指令'));
    await user.clear(input);
    await user.type(input, '只观察，不主动发言');

    await user.click(screen.getByRole('button', { name: '保存设置' }));

    // 第一次提交基于 revision 1。
    await waitFor(() =>
      expect(updateSettings).toHaveBeenNthCalledWith(
        1,
        'cli_a',
        'oc_a',
        expect.objectContaining({
          expectedRevision: 1,
          instructions: '只观察，不主动发言',
          participation: 'off',
          notificationsPaused: false,
          maxProactivePerHour: 6
        })
      )
    );

    // 冲突横幅出现，草稿文字仍然保留在输入框。
    expect(await screen.findByText(/版本冲突/)).toBeTruthy();
    expect((screen.getByLabelText('长期指令') as HTMLTextAreaElement).value).toBe(
      '只观察，不主动发言'
    );
    expect(screen.queryByText('协作设置已保存。')).toBeNull();

    // 用户确认后再次点击重试，第二次成功。
    await user.click(screen.getByRole('button', { name: '保存设置' }));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('协作设置已保存。')).toBeTruthy();
  });
});

describe('事项 (Followup) 新建、重试与进展编辑', () => {
  it('新建事项失败重试提交相同 id 与深等 payload，steps 包含稳定 id', async () => {
    const user = userEvent.setup();
    const createFollowup = vi
      .spyOn(collaborationApi, 'createFollowup')
      .mockRejectedValueOnce(new Error('网络闪断'))
      .mockResolvedValueOnce({
        followup: {
          id: 'followup_xyz',
          scope: { appId: 'cli_a', chatId: 'oc_a' },
          revision: 1,
          goal: '测试目标',
          status: 'open',
          progress: '准备中',
          steps: [],
          sourceRefs: [],
          taskIds: [],
          externalRefs: [],
          fields: {},
          createdBy: 'user',
          updatedBy: 'user',
          provenance: 'confirmed',
          createdAt: now,
          updatedAt: now
        }
      });

    renderPanel();
    await user.click(await screen.findByRole('tab', { name: /待办事项/ }));
    await user.click(screen.getByRole('button', { name: '新建事项' }));

    await user.type(screen.getByLabelText(/目标/), '整理接口协议');
    await user.type(screen.getByLabelText(/初始进展/), '已阅读文档');

    // 添加一个步骤
    const stepInput = screen.getByPlaceholderText('输入步骤后回车或点添加');
    await user.type(stepInput, '步骤1{Enter}');

    // 第一次提交失败
    await user.click(screen.getByRole('button', { name: '创建事项' }));
    await waitFor(() => expect(createFollowup).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('网络闪断')).toBeTruthy();

    const firstCallPayload = createFollowup.mock.calls[0]![2];
    expect(firstCallPayload.id).toBeTruthy();
    expect(firstCallPayload.steps?.[0]?.id).toBe(`step_${firstCallPayload.id}_1`);

    // 重试提交（按钮文案变为重试创建事项）
    await user.click(screen.getByRole('button', { name: '重试创建事项' }));
    await waitFor(() => expect(createFollowup).toHaveBeenCalledTimes(2));

    const secondCallPayload = createFollowup.mock.calls[1]![2];
    // 两次 payload 必须深等，保证同 id 同 payload 重试不 409、不重复新建
    expect(secondCallPayload).toEqual(firstCallPayload);
  });

  it('编辑已有事项进展并处理 409 冲突保留草稿与重载', async () => {
    const user = userEvent.setup();
    const followupItem = {
      id: 'f1',
      scope: { appId: 'cli_a', chatId: 'oc_a' },
      revision: 2,
      goal: '部署准备',
      status: 'open' as const,
      progress: '旧进展 50%',
      steps: [],
      sourceRefs: [],
      taskIds: [],
      externalRefs: [],
      fields: {},
      createdBy: 'user',
      updatedBy: 'user',
      provenance: 'confirmed' as const,
      createdAt: now,
      updatedAt: now
    };

    getOverview.mockResolvedValue(
      makeOverview(makeSettings(), { followups: [followupItem] })
    );

    const updateFollowup = vi
      .spyOn(collaborationApi, 'updateFollowup')
      .mockRejectedValueOnce(new ApiError('conflict', 'COLLABORATION_REVISION_CONFLICT', 409))
      .mockResolvedValueOnce({
        followup: { ...followupItem, revision: 3, progress: '最新进展 80%' }
      });

    renderPanel();
    await user.click(await screen.findByRole('tab', { name: /待办事项/ }));
    await screen.findByText('部署准备');

    await user.click(screen.getByRole('button', { name: /编辑进展/ }));
    const textarea = screen.getByPlaceholderText('填写事项最新进展情况…');
    expect((textarea as HTMLTextAreaElement).value).toBe('旧进展 50%');

    await user.clear(textarea);
    await user.type(textarea, '最新进展 80%');
    await user.click(screen.getByRole('button', { name: '保存进展' }));

    await waitFor(() =>
      expect(updateFollowup).toHaveBeenNthCalledWith(
        1,
        'cli_a',
        'oc_a',
        'f1',
        expect.objectContaining({ expectedRevision: 2, progress: '最新进展 80%' })
      )
    );

    // 409 冲突展示，草稿保留在文本框中
    expect(await screen.findByText(/更新进展冲突/)).toBeTruthy();
    expect((screen.getByPlaceholderText('填写事项最新进展情况…') as HTMLTextAreaElement).value).toBe(
      '最新进展 80%'
    );

    // 点击「重新读取当前版本」
    await user.click(screen.getByRole('button', { name: '重新读取当前版本' }));
    await waitFor(() => expect(getOverview).toHaveBeenCalledTimes(2));

    // 再次提交成功
    await user.click(screen.getByRole('button', { name: '保存进展' }));
    await waitFor(() => expect(updateFollowup).toHaveBeenCalledTimes(2));
  });
});

describe('委托任务操作 payload、重试、调频改期与时间补秒', () => {
  const activeMandate = {
    id: 'm1',
    scope: { appId: 'cli_a', chatId: 'oc_a' },
    revision: 4,
    goal: '每日巡检',
    status: 'active' as const,
    requesterId: 'alice',
    sourceRefs: [],
    scheduleDefinitionId: 'sched1',
    mode: 'agent' as const,
    prompt: '检查提单',
    condition: 'always' as const,
    deliveryPaused: false,
    catchupPolicy: 'skip' as const,
    schedule: {
      schemaVersion: 1 as const,
      id: 'sched1',
      revision: 1,
      channelBotId: 'cli_a',
      name: '每日巡检计划',
      trigger: { kind: 'interval' as const, everySeconds: 3600, anchorAt: now },
      timezone: 'Asia/Shanghai',
      dstPolicy: { gap: 'skip' as const, overlap: 'first' as const },
      delivery: { mode: 'chat' as const, continuation: 'new_topic' as const, destinationConfigured: true, threadRootConfigured: false },
      workspaceConfigured: false,
      payloadConfigured: false,
      identityConfigured: false,
      secretRefConfigured: false,
      sourceOwnership: 'dutydeck' as const,
      sourceEnabled: true,
      state: 'staged' as const,
      desiredExecutorState: 'disabled' as const,
      currentGeneration: 1,
      createdAt: now,
      updatedAt: now
    },
    createdAt: now,
    updatedAt: now
  };

  it('新建委托失败重试提交深等 payload，含稳定 id 与冻结 anchorAt', async () => {
    const user = userEvent.setup();
    const createMandate = vi
      .spyOn(collaborationApi, 'createMandate')
      .mockRejectedValueOnce(new Error('网关超时'))
      .mockResolvedValueOnce({ mandate: { ...activeMandate, revision: 1 } });

    renderPanel();
    await user.click(await screen.findByRole('tab', { name: /委托任务/ }));
    await user.click(screen.getByRole('button', { name: '新建委托' }));

    await user.type(screen.getByLabelText(/委托目标/), '每周汇总风险');
    await user.clear(screen.getByLabelText(/执行提示词/));
    await user.type(screen.getByLabelText(/执行提示词/), '汇总本周高风险变更');
    await user.clear(screen.getByLabelText(/间隔（分钟/));
    await user.type(screen.getByLabelText(/间隔（分钟/), '30');

    // 第一次提交失败
    await user.click(screen.getByRole('button', { name: '创建委托' }));
    await waitFor(() => expect(createMandate).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('网关超时')).toBeTruthy();

    const firstPayload = createMandate.mock.calls[0]![2];
    expect(firstPayload.id).toBeTruthy();
    expect(firstPayload.trigger.kind).toBe('interval');

    // 重试提交
    await user.click(screen.getByRole('button', { name: '重试创建委托' }));
    await waitFor(() => expect(createMandate).toHaveBeenCalledTimes(2));

    const secondPayload = createMandate.mock.calls[1]![2];
    expect(secondPayload).toEqual(firstPayload);
  });

  it('暂停投递与取消委托发送不同 payload；暂停投递不关闭委托', async () => {
    const user = userEvent.setup();
    getOverview.mockResolvedValue(
      makeOverview(makeSettings(), { mandates: [activeMandate] })
    );
    const updateMandate = vi
      .spyOn(collaborationApi, 'updateMandate')
      .mockResolvedValue({ mandate: { ...activeMandate, revision: 5 } });

    renderPanel();
    await user.click(await screen.findByRole('tab', { name: /委托任务/ }));
    await screen.findByText('每日巡检');

    await user.click(screen.getByRole('button', { name: /暂停投递/ }));
    await waitFor(() =>
      expect(updateMandate).toHaveBeenCalledWith(
        'cli_a',
        'oc_a',
        'm1',
        expect.objectContaining({ expectedRevision: 4, deliveryPaused: true })
      )
    );
    expect(updateMandate.mock.calls[0]![3]).not.toHaveProperty('status');

    await user.click(screen.getByRole('button', { name: /取消委托/ }));
    await waitFor(() =>
      expect(updateMandate).toHaveBeenLastCalledWith(
        'cli_a',
        'oc_a',
        'm1',
        expect.objectContaining({ expectedRevision: 4, status: 'cancelled' })
      )
    );
  });

  it('终态委托不再显示恢复执行或暂停投递按钮', async () => {
    const user = userEvent.setup();
    getOverview.mockResolvedValue(
      makeOverview(makeSettings(), {
        mandates: [{ ...activeMandate, status: 'cancelled' as const }]
      })
    );
    renderPanel();
    await user.click(await screen.findByRole('tab', { name: /委托任务/ }));
    await screen.findByText('每日巡检');
    expect(screen.queryByRole('button', { name: /恢复执行/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /暂停投递/ })).toBeNull();
  });

  it('委托改期/调频支持 interval/at/cron 与时区，datetime-local 自动补秒，支持 409 冲突草稿保留', async () => {
    const user = userEvent.setup();
    getOverview.mockResolvedValue(
      makeOverview(makeSettings(), { mandates: [activeMandate] })
    );
    const updateMandate = vi
      .spyOn(collaborationApi, 'updateMandate')
      .mockRejectedValueOnce(new ApiError('conflict', 'COLLABORATION_REVISION_CONFLICT', 409))
      .mockResolvedValueOnce({ mandate: { ...activeMandate, revision: 5 } });

    renderPanel();
    await user.click(await screen.findByRole('tab', { name: /委托任务/ }));
    await screen.findByText('每日巡检');

    await user.click(screen.getByRole('button', { name: /改期\/调频/ }));
    expect(await screen.findByRole('dialog', { name: /委托改期与调频/ })).toBeTruthy();

    // 切换到单次触发时间 (at)，输入无秒的时间
    await user.selectOptions(screen.getByLabelText('触发方式'), 'at');
    const timeInput = screen.getByLabelText('触发时间');
    await user.type(timeInput, '2026-09-20T14:30');

    await user.click(screen.getByRole('button', { name: '保存计划更新' }));

    await waitFor(() => expect(updateMandate).toHaveBeenCalledTimes(1));
    const patch = updateMandate.mock.calls[0]![3];
    expect(patch.expectedRevision).toBe(4);
    expect(patch.timezone).toBe('Asia/Shanghai');
    expect(patch.trigger).toBeTruthy();
    const trigger = patch.trigger!;
    expect(trigger.kind).toBe('at');
    if (trigger.kind === 'at') {
      // 必须按 schema 自动补齐秒为 2026-09-20T14:30:00
      expect(trigger.localDateTime).toBe('2026-09-20T14:30:00');
    }

    // 冲突横幅出现，保留表单草稿
    expect(await screen.findByText(/委托计划已被他人更新/)).toBeTruthy();
    expect((screen.getByLabelText('触发时间') as HTMLInputElement).value).toBe('2026-09-20T14:30');

    // 重新读取当前版本
    await user.click(screen.getByRole('button', { name: '重新读取当前版本' }));
    await waitFor(() => expect(getOverview).toHaveBeenCalledTimes(2));

    // 再次提交成功
    await user.click(screen.getByRole('button', { name: '保存计划更新' }));
    await waitFor(() => expect(updateMandate).toHaveBeenCalledTimes(2));
  });

  it('改期/调频输入无效分钟数提示错误且可恢复', async () => {
    const user = userEvent.setup();
    getOverview.mockResolvedValue(
      makeOverview(makeSettings(), { mandates: [activeMandate] })
    );

    renderPanel();
    await user.click(await screen.findByRole('tab', { name: /委托任务/ }));
    await user.click(screen.getByRole('button', { name: /改期\/调频/ }));

    const minInput = await screen.findByLabelText(/间隔（分钟/);
    await user.clear(minInput);
    await user.type(minInput, '0');

    await user.click(screen.getByRole('button', { name: '保存计划更新' }));
    expect(await screen.findByText('执行间隔必须至少为 1 分钟')).toBeTruthy();

    // 调整为合法值后错误恢复
    await user.clear(minInput);
    await user.type(minInput, '15');
    expect(screen.queryByText('执行间隔必须至少为 1 分钟')).toBeNull();
  });
});

describe('错误展示与外部动作核对过滤', () => {
  it('GET 返回 403 时显示错误和重试，不显示空白成功', async () => {
    const user = userEvent.setup();
    getOverview.mockRejectedValue(new ApiError('forbidden', 'FORBIDDEN', 403));
    renderPanel();
    expect(await screen.findByText(/权限不足/)).toBeTruthy();
    const retry = screen.getByRole('button', { name: '重试' });
    expect(retry).toBeTruthy();
    expect(screen.queryByLabelText('长期指令')).toBeNull();
    await user.click(retry);
    await waitFor(() => expect(getOverview).toHaveBeenCalledTimes(2));
  });

  it('通知核对和 pending 计数排除 command: 开头及 agent_execution，只统计外部 action', async () => {
    getOverview.mockResolvedValue(
      makeOverview(makeSettings(), {
        actions: [
          {
            id: 'cmd_1',
            scope: { appId: 'cli_a', chatId: 'oc_a' },
            revision: 1,
            kind: 'command:run_session',
            requesterId: 'alice',
            inputDigest: 'dig1',
            payload: {},
            status: 'unknown' as const,
            createdAt: now,
            updatedAt: now
          },
          {
            id: 'internal_exec',
            scope: { appId: 'cli_a', chatId: 'oc_a' },
            revision: 1,
            kind: 'agent_execution',
            requesterId: 'alice',
            inputDigest: 'dig2',
            payload: {},
            status: 'unknown' as const,
            createdAt: now,
            updatedAt: now
          },
          {
            id: 'external_delivery',
            scope: { appId: 'cli_a', chatId: 'oc_a' },
            revision: 1,
            kind: 'schedule_delivery',
            requesterId: 'system',
            inputDigest: 'dig3',
            payload: {},
            status: 'unknown' as const,
            createdAt: now,
            updatedAt: now
          }
        ]
      })
    );
    renderPanel();
    // 只有 1 个外部动作处于 unknown，不能被 command:run_session 和 agent_execution 干扰为 3 个
    expect(await screen.findByText(/有 1 个外部投递结果待人工核对/)).toBeTruthy();
    expect(screen.getByRole('tab', { name: /动作核对 \(1\)/ })).toBeTruthy();
  });

  it('bootstrap 缺失项可见，点击重新补读会调用接口', async () => {
    const user = userEvent.setup();
    getOverview.mockResolvedValue(
      makeOverview(makeSettings(), {
        snapshot: {
          scope: { appId: 'cli_a', chatId: 'oc_a' },
          contextRevision: 3,
          settings: makeSettings(),
          observations: [],
          followups: [],
          mandates: [],
          bootstrap: {
            scope: { appId: 'cli_a', chatId: 'oc_a' },
            status: 'partial',
            missing: ['messages'],
            updatedAt: now
          }
        }
      })
    );
    const bootstrap = vi
      .spyOn(collaborationApi, 'bootstrap')
      .mockResolvedValue({
        bootstrap: {
          scope: { appId: 'cli_a', chatId: 'oc_a' },
          status: 'running',
          missing: ['messages'],
          updatedAt: now
        }
      });
    renderPanel();
    expect(await screen.findByText(/历史上下文存在缺失/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /重新补读历史/ }));
    await waitFor(() => expect(bootstrap).toHaveBeenCalledWith('cli_a', 'oc_a'));
  });
});

describe('决策回放与人工纠正', () => {
  const decision = {
    id: 'dec_1',
    scope: { appId: 'cli_a', chatId: 'oc_a' },
    contextRevision: 3,
    policyVersion: 'v1',
    action: 'reply' as const,
    reason: '被显式 @ 且属于可回答问题',
    evidenceIds: ['obs_1'],
    status: 'sent' as const,
    inputSnapshot: {},
    createdAt: now
  };

  it('回放结果把 missing 单独计数，不计为通过', async () => {
    const user = userEvent.setup();
    getOverview.mockResolvedValue(makeOverview(makeSettings(), { decisions: [decision] }));
    vi.spyOn(collaborationApi, 'replay').mockResolvedValue({
      results: [{ decisionId: 'dec_1', status: 'missing' as const, reason: '上下文已过期' }],
      passed: 0,
      failed: 0,
      missing: 1
    });

    renderPanel();
    await user.click(await screen.findByRole('tab', { name: /决策与回放/ }));
    await user.click(screen.getByRole('button', { name: '回放全部决策' }));

    expect(await screen.findByText('缺失 1')).toBeTruthy();
    expect(screen.getByText('通过 0')).toBeTruthy();
    expect(screen.getByText(/缺失不计为通过/)).toBeTruthy();
  });

  it('人工纠正确认 expectedAction 后提交', async () => {
    const user = userEvent.setup();
    getOverview.mockResolvedValue(makeOverview(makeSettings(), { decisions: [decision] }));
    const addFeedback = vi
      .spyOn(collaborationApi, 'addFeedback')
      .mockImplementation(async (_a, _c, decisionId, body) => ({
        feedback: {
          id: 'fb_1',
          scope: { appId: 'cli_a', chatId: 'oc_a' },
          decisionId,
          actorId: 'me',
          correction: body.correction,
          expectedAction: body.expectedAction,
          createdAt: now
        }
      }));

    renderPanel();
    await user.click(await screen.findByRole('tab', { name: /决策与回放/ }));
    await user.click(screen.getByRole('button', { name: '人工纠正' }));

    await user.type(screen.getByLabelText(/纠正说明/), '这里不该回复');
    await user.selectOptions(screen.getByLabelText('期望动作'), 'silent');
    await user.click(screen.getByRole('button', { name: '提交纠正' }));

    await waitFor(() =>
      expect(addFeedback).toHaveBeenCalledWith(
        'cli_a',
        'oc_a',
        'dec_1',
        expect.objectContaining({ correction: '这里不该回复', expectedAction: 'silent' })
      )
    );
  });
});

describe('并发防护与 deferred 提交不可变快照重试', () => {
  it('Followup pending 期间输入框与取消按钮禁用，第一次失败后重试 deep equal 原不可变快照', async () => {
    const user = userEvent.setup();
    let rejectFirst!: (err: Error) => void;
    let resolveSecond!: (val: unknown) => void;

    const firstPromise = new Promise((_, reject) => {
      rejectFirst = reject;
    });
    const secondPromise = new Promise(resolve => {
      resolveSecond = resolve;
    });

    const createFollowup = vi
      .spyOn(collaborationApi, 'createFollowup')
      .mockImplementationOnce(() => firstPromise as any)
      .mockImplementationOnce(() => secondPromise as any);

    renderPanel();
    await user.click(await screen.findByRole('tab', { name: /待办事项/ }));
    await user.click(screen.getByRole('button', { name: '新建事项' }));

    const goalInput = screen.getByLabelText(/目标/);
    await user.type(goalInput, '不可变目标A');

    // 点击提交发起 deferred 请求
    await user.click(screen.getByRole('button', { name: '创建事项' }));
    await waitFor(() => expect(createFollowup).toHaveBeenCalledTimes(1));

    // 验证 pending 期间输入框和取消按钮被禁用，防止用户篡改输入或覆盖生命周期
    expect(screen.queryByText(/创建请求失败，已冻结/)).toBeNull();
    expect((screen.getByLabelText(/目标/) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '取消' }) as HTMLButtonElement).disabled).toBe(true);

    // 第一次网络请求失败返回
    rejectFirst(new Error('网络中断A'));
    expect(await screen.findByText('网络中断A')).toBeTruthy();

    // 失败后表单依然冻结（防止改动内容后误用旧 id 提交产生永久 409）
    expect((screen.getByLabelText(/目标/) as HTMLInputElement).disabled).toBe(true);

    // 点击重试创建事项
    await user.click(screen.getByRole('button', { name: '重试创建事项' }));
    await waitFor(() => expect(createFollowup).toHaveBeenCalledTimes(2));

    // 核心断言：重试严格使用原冻结快照，两次调用 payload 必须深等（deep equal）
    const firstCallPayload = createFollowup.mock.calls[0]![2];
    const secondCallPayload = createFollowup.mock.calls[1]![2];
    expect(secondCallPayload).toEqual(firstCallPayload);

    // 第二次成功后对话框正确关闭
    resolveSecond({
      followup: {
        id: firstCallPayload.id,
        scope: { appId: 'cli_a', chatId: 'oc_a' },
        revision: 1,
        goal: '不可变目标A',
        status: 'open',
        steps: [],
        sourceRefs: [],
        taskIds: [],
        externalRefs: [],
        fields: {},
        createdBy: 'user',
        updatedBy: 'user',
        provenance: 'confirmed',
        createdAt: now,
        updatedAt: now
      }
    });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '新建待办事项' })).toBeNull());
  });

  it('Mandate pending 期间输入与取消禁用，第一次失败后重试 deep equal 冻结快照', async () => {
    const user = userEvent.setup();
    let rejectFirst!: (err: Error) => void;
    let resolveSecond!: (val: unknown) => void;

    const firstPromise = new Promise((_, reject) => {
      rejectFirst = reject;
    });
    const secondPromise = new Promise(resolve => {
      resolveSecond = resolve;
    });

    const createMandate = vi
      .spyOn(collaborationApi, 'createMandate')
      .mockImplementationOnce(() => firstPromise as any)
      .mockImplementationOnce(() => secondPromise as any);

    renderPanel();
    await user.click(await screen.findByRole('tab', { name: /委托任务/ }));
    await user.click(screen.getByRole('button', { name: '新建委托' }));

    await user.type(screen.getByLabelText(/委托目标/), '不可变巡检目标');
    await user.type(screen.getByLabelText(/执行提示词/), '提示词不可变');

    await user.click(screen.getByRole('button', { name: '创建委托' }));
    await waitFor(() => expect(createMandate).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/创建请求失败，已冻结/)).toBeNull();

    // pending 期间表单与取消按钮被禁用
    expect((screen.getByLabelText(/委托目标/) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '取消' }) as HTMLButtonElement).disabled).toBe(true);

    rejectFirst(new Error('网关超时B'));
    expect(await screen.findByText('网关超时B')).toBeTruthy();

    // 失败后继续保持禁用
    expect((screen.getByLabelText(/委托目标/) as HTMLInputElement).disabled).toBe(true);

    await user.click(screen.getByRole('button', { name: '重试创建委托' }));
    await waitFor(() => expect(createMandate).toHaveBeenCalledTimes(2));

    // 两次调用的 payload 严格深等（相同 id、冻结的 trigger.anchorAt 等）
    expect(createMandate.mock.calls[1]![2]).toEqual(createMandate.mock.calls[0]![2]);

    resolveSecond({
      mandate: {
        id: createMandate.mock.calls[0]![2].id,
        scope: { appId: 'cli_a', chatId: 'oc_a' },
        revision: 1,
        goal: '不可变巡检目标',
        status: 'active',
        requesterId: 'alice',
        sourceRefs: [],
        scheduleDefinitionId: 'sched_new',
        mode: 'agent',
        prompt: '提示词不可变',
        condition: 'always',
        deliveryPaused: false,
        catchupPolicy: 'skip',
        createdAt: now,
        updatedAt: now
      }
    });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '新建委托任务' })).toBeNull());
  });
});



// Editing regressions are separate from the creation-form retry contract above.
describe('编辑草稿版本与改期请求快照', () => {
  const followup = {
    id: 'edit-followup', scope: { appId: 'cli_a', chatId: 'oc_a' }, revision: 2,
    goal: '待编辑事项', status: 'open' as const, progress: '原有进展', steps: [],
    sourceRefs: [], taskIds: [], externalRefs: [], fields: {}, createdBy: 'alice', updatedBy: 'alice',
    provenance: 'confirmed' as const, createdAt: now, updatedAt: now
  };
  const mandate: CollaborationOverview['mandates'][number] = {
    id: 'edit-mandate', scope: { appId: 'cli_a', chatId: 'oc_a' }, revision: 4,
    goal: '待改期委托', status: 'active', requesterId: 'alice', sourceRefs: [], scheduleDefinitionId: 'edit-schedule',
    mode: 'agent', prompt: '整理进展', condition: 'always', deliveryPaused: false, catchupPolicy: 'skip',
    createdAt: now, updatedAt: now,
    schedule: {
      schemaVersion: 1, id: 'edit-schedule', revision: 1, channelBotId: 'cli_a', name: '原计划',
      trigger: { kind: 'interval', everySeconds: 3600, anchorAt: now }, timezone: 'Asia/Shanghai',
      dstPolicy: { gap: 'skip', overlap: 'first' },
      delivery: { mode: 'chat', continuation: 'chat_root', destinationConfigured: true, threadRootConfigured: false },
      workspaceConfigured: false, payloadConfigured: false, identityConfigured: false, secretRefConfigured: false,
      sourceOwnership: 'dutydeck', sourceEnabled: false, state: 'staged', desiredExecutorState: 'disabled', currentGeneration: 1,
      createdAt: now, updatedAt: now
    }
  };
  const renderEditor = () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<QueryClientProvider client={client}><CollaborationPanel appId="cli_a" chatId="oc_a" /></QueryClientProvider>);
    return client;
  };
  const refresh = async (client: QueryClient) => {
    await act(async () => { await client.refetchQueries({ queryKey: ['collaboration-overview', 'cli_a', 'oc_a'] }); });
  };
  afterEach(() => { vi.useRealTimers(); });

  it('清空进展提交空字符串，与真实服务端契约一致', async () => {
    const user = userEvent.setup();
    getOverview.mockResolvedValue(makeOverview(makeSettings(), { followups: [followup] }));
    const update = vi.spyOn(collaborationApi, 'updateFollowup').mockResolvedValue({ followup: { ...followup, revision: 3, progress: '' } });
    renderEditor(); await user.click(await screen.findByRole('tab', { name: /待办事项/ }));
    await user.click(screen.getByRole('button', { name: '编辑进展' }));
    await user.clear(screen.getByPlaceholderText('填写事项最新进展情况…'));
    await user.click(screen.getByRole('button', { name: '保存进展' }));
    await waitFor(() => expect(update).toHaveBeenCalledWith('cli_a', 'oc_a', followup.id, { expectedRevision: 2, progress: '' }));
  });

  it('后台刷新不提高进展草稿版本，显式冲突重载后才可携带新版本保存', async () => {
    const user = userEvent.setup();
    getOverview.mockResolvedValue(makeOverview(makeSettings(), { followups: [followup] }));
    const update = vi.spyOn(collaborationApi, 'updateFollowup')
      .mockRejectedValueOnce(new ApiError('stale', 'COLLABORATION_REVISION_CONFLICT', 409))
      .mockResolvedValueOnce({ followup: { ...followup, revision: 4, progress: '我的草稿' } });
    const client = renderEditor(); await user.click(await screen.findByRole('tab', { name: /待办事项/ }));
    await user.click(screen.getByRole('button', { name: '编辑进展' }));
    const input = screen.getByPlaceholderText('填写事项最新进展情况…');
    await user.clear(input); await user.type(input, '我的草稿');
    getOverview.mockResolvedValue(makeOverview(makeSettings(), { followups: [{ ...followup, revision: 3, progress: '其他人的新进展' }] }));
    await refresh(client);
    expect(await screen.findByText('rev 3')).toBeTruthy(); expect(screen.getByText('基于 rev 2')).toBeTruthy();
    expect((input as HTMLTextAreaElement).value).toBe('我的草稿');
    await user.click(screen.getByRole('button', { name: '保存进展' }));
    expect(await screen.findByText(/更新进展冲突/)).toBeTruthy();
    expect(update.mock.calls[0]![3]).toEqual({ expectedRevision: 2, progress: '我的草稿' });
    expect((screen.getByRole('button', { name: '保存进展' }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole('button', { name: '重新读取当前版本' }));
    await screen.findByText('基于 rev 3');
    expect((input as HTMLTextAreaElement).value).toBe('我的草稿');
    await user.click(screen.getByRole('button', { name: '保存进展' }));
    await waitFor(() => expect(update.mock.calls[1]![3]).toEqual({ expectedRevision: 3, progress: '我的草稿' }));
  });

  it('后台刷新不提高改期草稿版本，显式冲突重载保留参数并更新基准', async () => {
    const user = userEvent.setup();
    getOverview.mockResolvedValue(makeOverview(makeSettings(), { mandates: [mandate] }));
    const update = vi.spyOn(collaborationApi, 'updateMandate')
      .mockRejectedValueOnce(new ApiError('stale', 'COLLABORATION_REVISION_CONFLICT', 409))
      .mockResolvedValueOnce({ mandate: { ...mandate, revision: 6 } });
    const client = renderEditor(); await user.click(await screen.findByRole('tab', { name: /委托任务/ }));
    await user.click(screen.getByRole('button', { name: /改期\/调频/ }));
    const minutes = screen.getByLabelText(/间隔（分钟/);
    await user.clear(minutes); await user.type(minutes, '30');
    getOverview.mockResolvedValue(makeOverview(makeSettings(), { mandates: [{ ...mandate, revision: 5, schedule: { ...mandate.schedule!, trigger: { kind: 'cron', expression: '0 12 * * *' } } }] }));
    await refresh(client);
    await screen.findByText('rev 5');
    expect(screen.getByText(/目标：待改期委托（基于 rev 4）/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '保存计划更新' }));
    expect(await screen.findByText(/委托计划已被他人更新/)).toBeTruthy();
    const first = update.mock.calls[0]![3];
    expect(first).toEqual({ expectedRevision: 4, trigger: { kind: 'interval', everySeconds: 1800, anchorAt: now }, timezone: 'Asia/Shanghai' });
    expect((screen.getByRole('button', { name: '保存计划更新' }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole('button', { name: '重新读取当前版本' }));
    await screen.findByText(/目标：待改期委托（基于 rev 5）/);
    expect((minutes as HTMLInputElement).value).toBe('30');
    await user.click(screen.getByRole('button', { name: '保存计划更新' }));
    await waitFor(() => expect(update.mock.calls[1]![3]).toEqual({ ...first, expectedRevision: 5 }));
  });

  it.each(['cron', 'at'] as const)('%s 改 interval 的未知失败重试冻结完整请求、版本与 anchor，pending 不接受变更', async kind => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-18T10:00:00.000Z'));
    const user = userEvent.setup();
    const original = { ...mandate, schedule: { ...mandate.schedule!, trigger: kind === 'cron' ? { kind: 'cron' as const, expression: '0 9 * * *' } : { kind: 'at' as const, localDateTime: '2026-09-19T09:00:00' } } };
    getOverview.mockResolvedValue(makeOverview(makeSettings(), { mandates: [original] }));
    let rejectFirst!: (error: Error) => void;
    const update = vi.spyOn(collaborationApi, 'updateMandate')
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectFirst = reject; }))
      .mockResolvedValueOnce({ mandate: { ...mandate, revision: 5 } });
    const client = renderEditor(); await user.click(await screen.findByRole('tab', { name: /委托任务/ }));
    await user.click(screen.getByRole('button', { name: /改期\/调频/ }));
    await user.selectOptions(screen.getByLabelText('触发方式'), 'interval');
    const minutes = screen.getByLabelText(/间隔（分钟/), timezone = screen.getByLabelText('时区');
    await user.clear(minutes); await user.type(minutes, '30');
    await user.click(screen.getByRole('button', { name: '保存计划更新' }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(minutes.matches(':disabled')).toBe(true); expect(timezone.matches(':disabled')).toBe(true);
    expect((screen.getByRole('button', { name: '取消' }) as HTMLButtonElement).disabled).toBe(true);
    await user.type(minutes, '99'); await user.click(screen.getByRole('button', { name: '保存计划更新' }));
    expect(update).toHaveBeenCalledTimes(1); expect((minutes as HTMLInputElement).value).toBe('30');
    await act(async () => { rejectFirst(new Error('请求结果未知')); });
    await screen.findByText('请求结果未知');
    expect(minutes.matches(':disabled')).toBe(true);
    const first = update.mock.calls[0]![3];
    expect(first).toMatchObject({ expectedRevision: 4, trigger: { kind: 'interval', everySeconds: 1800, anchorAt: '2026-09-18T10:00:00.000Z' } });
    vi.setSystemTime(new Date('2026-09-18T11:00:00.000Z'));
    getOverview.mockResolvedValue(makeOverview(makeSettings(), { mandates: [{ ...original, revision: 5 }] })); await refresh(client);
    await screen.findByText('rev 5');
    await user.click(screen.getByRole('button', { name: '重试计划更新' }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
    expect(update.mock.calls[1]![3]).toEqual(first);
  });
});
