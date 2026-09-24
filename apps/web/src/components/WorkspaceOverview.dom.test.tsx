import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Agent, LarkBotConfig, Session } from '../api';
import { attentionReasonForSession, nextActionForState, workbenchViewLabels, workbenchViewOrder } from '../workspace-model';
import { WorkspaceOverview } from './WorkspaceOverview';

const agents: Agent[] = [{ id: 'codex', name: 'Codex', protocol: 'acp', permissionMode: 'full-trust' }];
const session = (id: string, cwd: string, state: string): Session => ({ id, cwd, state, agentId: 'codex', runId: `run-${id}`, createdAt: `2026-08-2${id}T00:00:00Z`, updatedAt: `2026-08-2${id}T00:00:00Z` });
// 完整就绪的 Bot：setupComplete + listening + activeListening 三者齐备才是「监听已启动」。
const makeSimpleBot = (overrides: Partial<LarkBotConfig> = {}): LarkBotConfig => ({
  configured: true,
  appId: 'cli_bot_1',
  name: '研发助理',
  tabLabel: '助理',
  setupComplete: true,
  listening: true,
  activeListening: true,
  fullTrustConfirmed: true,
  preInjectPrompt: '',
  groupToolsEnabled: true,
  groupToolsAllowSend: false,
  pushIntervalMs: 2000,
  hideTraceOnComplete: true,
  allowedUsers: [],
  allowedEmails: [],
  allowedBots: [],
  peerBotsAllowed: false,
  highRiskAllowedUsers: [],
  highRiskAllowedEmails: [],
  highRiskPattern: '',
  riskControlMode: 'guidance',
  ...overrides
});
const baseProps = { sessions: [], summaries: {}, agents, loading: false, larkBots: [] as LarkBotConfig[], view: 'all' as const, onViewChange: () => {}, onSelect: () => {}, onCreate: () => {}, onOpenAgentSetup: () => {}, onOpenLarkSetup: () => {} };

describe('WorkspaceOverview 批量清理选择', () => {
  const sessions = [session('1', '/repo/done', 'completed'), session('2', '/repo/busy', 'thinking'), { ...session('3', '/repo/managed', 'completed'), source: 'work_item' }, { ...session('4', '/repo/archived', 'completed'), archivedAt: '2026-09-12T00:00:00Z' }];

  it('全选只包含当前筛选下的可清理任务，勾选不会打开详情', async () => {
    const user = userEvent.setup();
    const onBulkArchive = vi.fn(); const onSelect = vi.fn();
    render(<WorkspaceOverview {...baseProps} sessions={sessions} view="completed" onBulkArchive={onBulkArchive} onSelect={onSelect}/>);
    await user.click(screen.getByRole('button', { name: '批量清理' }));
    expect(screen.getByRole('button', { name: '清理所选任务' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('checkbox', { name: '选择任务：managed' }).hasAttribute('disabled')).toBe(true);
    await user.click(screen.getByRole('checkbox', { name: '全选当前视图' }));
    expect(screen.getByText('已选 1 个任务')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '清理所选任务' }));
    expect(onBulkArchive).toHaveBeenCalledWith(['1']);
    expect(onSelect).not.toHaveBeenCalled();
    await user.click(screen.getByRole('checkbox', { name: '全选当前视图' }));
    expect(screen.getByRole('button', { name: '清理所选任务' }).hasAttribute('disabled')).toBe(true);
  });

  it('支持单选与半选；刷新不自动勾选新任务，已归档项从选择中移除', async () => {
    const user = userEvent.setup(); const onBulkArchive = vi.fn();
    const { rerender } = render(<WorkspaceOverview {...baseProps} sessions={sessions} onBulkArchive={onBulkArchive}/>);
    await user.click(screen.getByRole('button', { name: '批量清理' }));
    await user.click(screen.getByRole('checkbox', { name: '选择任务：done' }));
    expect((screen.getByRole('checkbox', { name: '全选当前视图' }) as HTMLInputElement).indeterminate).toBe(true);
    const refreshed = [...sessions.map(item => item.id === '1' ? { ...item, archivedAt: '2026-09-12T01:00:00Z' } : item), session('5', '/repo/new', 'completed')];
    rerender(<WorkspaceOverview {...baseProps} sessions={refreshed} onBulkArchive={onBulkArchive}/>);
    expect(screen.getByText('已选 0 个任务')).toBeTruthy();
    expect((screen.getByRole('checkbox', { name: '选择任务：new' }) as HTMLInputElement).checked).toBe(false);
    expect(screen.getByRole('button', { name: '清理所选任务' }).hasAttribute('disabled')).toBe(true);
  });

  it('切换筛选或退出多选会清空选择，已归档视图不提供清理入口', async () => {
    const user = userEvent.setup(); const onBulkArchive = vi.fn();
    const { rerender } = render(<WorkspaceOverview {...baseProps} sessions={sessions} onBulkArchive={onBulkArchive}/>);
    await user.click(screen.getByRole('button', { name: '批量清理' }));
    await user.click(screen.getByRole('checkbox', { name: '全选当前视图' }));
    rerender(<WorkspaceOverview {...baseProps} sessions={sessions} view="completed" onBulkArchive={onBulkArchive}/>);
    expect(screen.queryByRole('checkbox')).toBeNull();
    await user.click(screen.getByRole('button', { name: '批量清理' }));
    expect(screen.getByText('已选 0 个任务')).toBeTruthy();
    await user.click(screen.getByRole('checkbox', { name: '全选当前视图' }));
    await user.click(screen.getByRole('button', { name: '退出多选' }));
    await user.click(screen.getByRole('button', { name: '批量清理' }));
    expect(screen.getByText('已选 0 个任务')).toBeTruthy();
    rerender(<WorkspaceOverview {...baseProps} sessions={sessions} view="archived" onBulkArchive={onBulkArchive}/>);
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByRole('button', { name: '批量清理' })).toBeNull();
  });
});

describe('WorkspaceOverview', () => {
  it('does not claim work is in progress when both tasks and Agents are empty', () => {
    render(<WorkspaceOverview {...baseProps} sessions={[]} agents={[]}/>);
    expect(screen.getByText('还没有任务。先准备 Agent，再创建第一个任务。')).toBeTruthy();
    expect(document.body.textContent).not.toContain('继续跟进进行中的任务');
  });

  it('展示现有 Session 数据的工作区与状态投影', () => {
    const archived = { ...session('6', '/repo/archive', 'completed'), archivedAt: '2026-08-30T00:00:00Z' };
    render(<WorkspaceOverview sessions={[session('1', '/repo/dutydeck', 'thinking'), session('2', '/repo/dutydeck', 'created'), session('3', '/repo/api', 'idle'), session('4', '/repo/api', 'failed'), session('5', '/repo/web', 'completed'), archived]} summaries={{ '1': { sessionId: '1', taskId: 't1', prompt: '优化工作台', status: 'running', queuedCount: 0, updatedAt: '' }, '2': { sessionId: '2', taskId: 't2', prompt: '等待调度', status: 'queued', queuedCount: 1, updatedAt: '' } }} agents={agents} loading={false} larkBots={[makeSimpleBot()]} view="all" onViewChange={() => {}} onSelect={() => {}} onCreate={() => {}} onOpenAgentSetup={() => {}} onOpenLarkSetup={() => {}}/>);
    const filters = screen.getByRole('region', { name: '任务筛选' });
    // 筛选芯片就是 workbenchViewOrder 这一份常量，标签改文案不需要动这里。
    expect(workbenchViewOrder.map(view => within(filters).getByRole('button', { name: new RegExp(workbenchViewLabels[view]) }))).toHaveLength(5);
    expect(filters.textContent).toContain('总览5');
    // 失败并入「待你处理」：idle 的 3 与 failed 的 4，共 2 条。
    expect(filters.textContent).toContain('待你处理2');
    // 进行中同时含 thinking 的 1 与「created 但排了 1 条指令」的 2：
    // 排队中也算系统已承诺推进，芯片与分区用的是同一个判据（interaction-design §1）。
    expect(filters.textContent).toContain('进行中2');
    expect(filters.textContent).toContain('已完成1');
    expect(filters.textContent).toContain('已归档1');
    // 「有排队的任务」不再是可点击视图，待执行指令总数只作为说明性标签出现。
    expect(within(filters).queryByRole('button', { name: /有排队的运行|失败/ })).toBeNull();
    expect(filters.textContent).toContain('另有待执行指令 1 条');
    expect(screen.getByText('优化工作台')).toBeTruthy();
    expect(screen.getByText('1 个机器人 · 监听已启动')).toBeTruthy();
  });

  it('创建、选择任务与打开飞书均保持可达', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn(); const onSelect = vi.fn(); const onOpenLarkSetup = vi.fn(); const onViewChange = vi.fn();
    render(<WorkspaceOverview sessions={[session('1', '/repo/dutydeck', 'idle')]} summaries={{ '1': { sessionId: '1', taskId: 't1', prompt: '优化工作台', status: 'queued', queuedCount: 1, updatedAt: '' } }} agents={agents} loading={false} larkBots={[]} view="all" onViewChange={onViewChange} onSelect={onSelect} onCreate={onCreate} onOpenAgentSetup={() => {}} onOpenLarkSetup={onOpenLarkSetup}/>);
    await user.click(screen.getByRole('button', { name: /创建任务/ }));
    await user.click(screen.getByRole('button', { name: /优化工作台/ }));
    await user.click(screen.getByRole('button', { name: /已归档/ }));
    await user.click(screen.getByRole('button', { name: /绑定飞书 Bot/ }));
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith('1');
    expect(onViewChange).toHaveBeenCalledWith('archived');
    expect(onOpenLarkSetup).toHaveBeenCalledTimes(1);
  });

  it('按已选状态过滤跨工作区任务，并让长任务目标保留完整 title', () => {
    const longGoal = '修复登录超时并补齐覆盖所有回归路径的端到端测试与性能验证';
    render(<WorkspaceOverview sessions={[session('1', '/repo/run', 'thinking'), session('2', '/repo/queue', 'failed')]} summaries={{ '1': { sessionId: '1', taskId: 't1', prompt: '运行中的任务', status: 'running', queuedCount: 0, updatedAt: '' }, '2': { sessionId: '2', taskId: 't2', prompt: longGoal, status: 'failed', queuedCount: 0, updatedAt: '' } }} agents={agents} loading={false} larkBots={[]} view="attention" onViewChange={() => {}} onSelect={() => {}} onCreate={() => {}} onOpenAgentSetup={() => {}} onOpenLarkSetup={() => {}}/>);
    expect(screen.getByTitle(longGoal)).toBeTruthy();
    expect(screen.queryByText('运行中的任务')).toBeNull();
  });

  it('进行中的任务有后续排队指令时，任务行按指令数标注待执行', () => {
    render(<WorkspaceOverview sessions={[session('1', '/repo/run', 'thinking')]} summaries={{ '1': { sessionId: '1', taskId: 't1', prompt: '运行中且排了两条', status: 'running', queuedCount: 2, updatedAt: '' } }} agents={agents} loading={false} larkBots={[]} view="active" onViewChange={() => {}} onSelect={() => {}} onCreate={() => {}} onOpenAgentSetup={() => {}} onOpenLarkSetup={() => {}}/>);
    expect(screen.getByRole('button', { name: /运行中且排了两条.*待执行指令 2 条/ })).toBeTruthy();
    expect(screen.getByRole('region', { name: '任务筛选' }).textContent).toContain('另有待执行指令 2 条');
  });

  it('默认将待处理与失败任务置顶，并给出可行动原因与更新时间', () => {
    const { container } = render(<WorkspaceOverview sessions={[session('5', '/repo/recent', 'completed'), session('4', '/repo/run', 'thinking'), session('3', '/repo/fail', 'failed'), session('2', '/repo/auth', 'waiting_for_permission')]} summaries={{}} agents={agents} loading={false} larkBots={[]} view="all" onViewChange={() => {}} onSelect={() => {}} onCreate={() => {}} onOpenAgentSetup={() => {}} onOpenLarkSetup={() => {}}/>);
    const taskList = screen.getByRole('region', { name: '任务列表' });
    expect(within(taskList).getAllByRole('heading', { level: 2 }).map(node => node.textContent)).toEqual(['待你处理', '进行中', '已完成']);
    expect(screen.getByText(nextActionForState('waiting_for_permission'))).toBeTruthy();
    expect(screen.getByText(nextActionForState('failed'))).toBeTruthy();
    expect(container.querySelectorAll('[data-task-priority="attention"]')).toHaveLength(2);
    expect(container.querySelector('[data-task-priority="attention"]')?.textContent).toContain('更新于');
    expect(screen.getByRole('button', { name: /等待授权.*需要你授权/ })).toBeTruthy();
  });

  it('过滤视图展示全部匹配任务，不截断最近六条', () => {
    const sessions = Array.from({ length: 8 }, (_, index) => session(String(index + 1), `/repo/${index + 1}`, 'thinking'));
    render(<WorkspaceOverview sessions={sessions} summaries={Object.fromEntries(sessions.map(item => [item.id, { sessionId: item.id, taskId: `t${item.id}`, prompt: `任务 ${item.id}`, status: 'running', queuedCount: 0, updatedAt: item.updatedAt }]))} agents={agents} loading={false} larkBots={[]} view="active" onViewChange={() => {}} onSelect={() => {}} onCreate={() => {}} onOpenAgentSetup={() => {}} onOpenLarkSetup={() => {}}/>);
    for (const item of sessions) expect(screen.getByText(`任务 ${item.id}`)).toBeTruthy();
    expect(screen.getByRole('region', { name: '任务列表' }).querySelectorAll('[data-task-priority]')).toHaveLength(8);
  });

  // 契约 §9 要求主要交互的触控高度 ≥40px。两个入口现在用两种方式表达同一条下限：
  // 「创建任务」走 Button 原语，它把 md 档写成固定 `h-10`（恰好 40px）；筛选芯片
  // 仍是原生 button，用 `min-h-10` 保留纵向增长空间（芯片文案换行时不能被压扁）。
  // 断言接受两种写法，但不接受任何更矮的档位——`h-8` / `min-h-8` 一样会挂。
  const meetsTouchTarget = (node: HTMLElement) => /(?:^|\s)(?:min-)?h-10(?:\s|$)/.test(node.className);

  it('主操作与状态筛选提供至少 40px 触控目标', () => {
    render(<WorkspaceOverview sessions={[]} summaries={{}} agents={agents} loading={false} larkBots={[]} view="all" onViewChange={() => {}} onSelect={() => {}} onCreate={() => {}} onOpenAgentSetup={() => {}} onOpenLarkSetup={() => {}}/>);
    expect(meetsTouchTarget(screen.getByRole('button', { name: '创建任务' }))).toBe(true);
    expect(meetsTouchTarget(screen.getByRole('button', { name: /总览 0/ }))).toBe(true);
  });

  it('待处理任务优先展示经脱敏的 Runtime 错误摘要', () => {
    const failed = { ...session('1', '/repo/error', 'idle'), error: '连接本地进程失败\nAuthorization: Bearer should-not-render' };
    render(<WorkspaceOverview sessions={[failed]} summaries={{}} agents={agents} loading={false} larkBots={[]} view="all" onViewChange={() => {}} onSelect={() => {}} onCreate={() => {}} onOpenAgentSetup={() => {}} onOpenLarkSetup={() => {}}/>);
    expect(screen.getByText('任务异常：连接本地进程失败 Authorization: [已隐藏]；打开详情查看')).toBeTruthy();
    expect(screen.getByText(attentionReasonForSession(failed))).toBeTruthy();
    expect(screen.queryByText(/should-not-render/)).toBeNull();
    expect(screen.queryByText(nextActionForState('idle'))).toBeNull();
  });

  it('在 App 的主内容内使用有名区域，不再嵌套 main landmark', () => {
    const { container } = render(<WorkspaceOverview sessions={[]} summaries={{}} agents={agents} loading={false} larkBots={[]} view="all" onViewChange={() => {}} onSelect={() => {}} onCreate={() => {}} onOpenAgentSetup={() => {}} onOpenLarkSetup={() => {}}/>);
    expect(container.querySelector('main')).toBeNull();
    expect(screen.getByRole('region', { name: '今天需要推进什么？' })).toBeTruthy();
  });

  it('Agent 尚未加载完时不谎报「先准备 Agent」，改为说明正在检测', () => {
    render(<WorkspaceOverview {...baseProps} sessions={[]} agents={[]} agentsLoading/>);
    expect(screen.getByText('正在同步任务状态…')).toBeTruthy();
    expect(screen.queryByText('还没有任务。先准备 Agent，再创建第一个任务。')).toBeNull();
    const cta = screen.getByRole('button', { name: '正在检测 Agent…' });
    expect(cta.hasAttribute('disabled')).toBe(true);
  });

  it('Agent 加载中时任务列表展示骨架，而不是先闪一次空状态', () => {
    const { container } = render(<WorkspaceOverview {...baseProps} sessions={[]} agents={[]} agentsLoading/>);
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
    expect(screen.queryByText('先准备一个可用 Agent')).toBeNull();
  });

  it('飞书接入状态未就绪时不谎报「尚未接入机器人」', () => {
    render(<WorkspaceOverview {...baseProps} sessions={[]} larkBots={[]} larkBotsLoading/>);
    expect(screen.getByText('正在读取接入状态…')).toBeTruthy();
    expect(screen.queryByText('尚未接入机器人')).toBeNull();
  });

  // 第三个分区的 key 是 workbenchTaskSection 的兜底分支 recent，但穷举 11 个状态 ×
  // queuedCount 有无后只有「completed 且无排队指令」会落进来，所以它就是筛选芯片
  // 「已完成」那一批，标题也必须写「已完成」——叫「最近」时用户按芯片名找不到分区。
  // 副标题说的「没有后续排队指令」不是废话：completed 排了指令就归「进行中」，
  // 这条用例把文案和实际归类绑在一起。
  it('第三个分区标题与「已完成」芯片同名，副标题说明它只装已交付且无排队指令的任务', () => {
    const sessions = [session('1', '/repo/done', 'completed'), session('2', '/repo/more', 'completed')];
    render(<WorkspaceOverview {...baseProps} sessions={sessions} summaries={{ '1': { sessionId: '1', taskId: 't1', prompt: '已交付', status: 'completed', queuedCount: 0, updatedAt: '' }, '2': { sessionId: '2', taskId: 't2', prompt: '交付后又排了一条', status: 'completed', queuedCount: 1, updatedAt: '' } }}/>);
    expect(screen.queryByRole('region', { name: '最近' })).toBeNull();
    const done = screen.getByRole('region', { name: '已完成' });
    expect(within(done).getByText('已交付且没有后续排队指令的任务')).toBeTruthy();
    // 分区 key 保持 recent：它是内部标识，taskSectionRank 与 data-task-priority 都用它。
    expect(done.querySelectorAll('[data-task-priority="recent"]')).toHaveLength(1);
    // 副标题的「没有后续排队指令」必须与归类一致：排了指令的那条不在这个分区里。
    expect(within(done).getByText('已交付')).toBeTruthy();
    expect(within(done).queryByText('交付后又排了一条')).toBeNull();
    expect(within(screen.getByRole('region', { name: '进行中' })).getByText('交付后又排了一条')).toBeTruthy();
  });

  // 任务行的状态徽标走 effectiveStatus(session).label，不再自己判 archivedAt。
  // 一条在 thinking 时被归档的任务，state 永远停在 'thinking'：徽标必须写「已归档」，
  // 否则会告诉用户它还在跑。删掉 effectiveStatus 的归档分支时这条要挂。
  it('归档 + thinking：任务行徽标写「已归档」，不谎报仍在思考', () => {
    const archived = { ...session('1', '/repo/archive', 'thinking'), archivedAt: '2026-08-30T00:00:00Z' };
    render(<WorkspaceOverview {...baseProps} sessions={[archived]} summaries={{ '1': { sessionId: '1', taskId: 't1', prompt: '归档时还在思考', status: 'running', queuedCount: 0, updatedAt: '' } }} view="archived"/>);
    const row = screen.getByRole('button', { name: /归档时还在思考/ });
    expect(row.textContent).toContain('已归档');
    expect(row.textContent).not.toContain('思考中');
  });

  /*
    「当前视图没有任务」是好消息，不是失败。契约 §10 给 EmptyState 定了三档 tone，
    并明写 positive「不得用灰色失望感呈现」——把「你已经处理完了」画成灰色空盒子，
    是在为一件好事道歉。

    这条守的是 tone 选择本身：positive 档会渲染绿勾图标（EmptyState 在 tone=positive
    且调用方没传 icon 时的默认），neutral 档不会。改成 neutral 立刻挂。
  */
  it('筛不出结果时用 positive 空态，不把「没有待办」画成灰色失望感', () => {
    const { container } = render(<WorkspaceOverview {...baseProps} sessions={[session('1', '/repo/done', 'completed')]} view="attention"/>);
    expect(screen.getByText('当前视图没有任务')).toBeTruthy();
    const glyph = container.querySelector('.ui-empty-state span');
    expect(glyph?.className).toContain('text-success');
    expect(glyph?.className).not.toContain('text-subtle');
  });

  /*
    首次使用（无任务 + 无 Bot，也就是全新装完打开的样子）曾同屏渲染两颗可及名
    逐字相同的「绑定飞书 Bot」：一颗在 TaskListEmpty 的 guide 分支里，一颗在右栏
    协作卡片里（后者恒渲染）。于是 getByRole 抛 found multiple elements——
    与 TopBar.tsx:64-69、App.tsx:301-308 记录的是同一类故障。

    它一直没被发现，是因为现有用例全都恰好绕开了这个组合：别的用例要么传了
    session（guide 分支不渲染），要么只用 getByText 取文本而不按 role 取按钮。
    所以这条用例用 getAllBy* 精确断言数量，而不是 getBy*——后者在「只有一颗」时
    固然能过，但在退化成两颗时给出的是一条看不出所以然的报错。
  */
  it('首次使用时「绑定飞书 Bot」只有一个入口，不与协作卡片重名', () => {
    render(<WorkspaceOverview {...baseProps} sessions={[]} larkBots={[]}/>);
    expect(screen.getAllByRole('button', { name: '绑定飞书 Bot' })).toHaveLength(1);
    // 主 CTA 仍在：规范 §5.1 要求页首有唯一强主 CTA。
    expect(screen.getByRole('button', { name: '创建第一个任务' })).toBeTruthy();
  });

  it('数据就绪后仍然如实展示空状态', () => {
    render(<WorkspaceOverview {...baseProps} sessions={[]} agents={[]}/>);
    expect(screen.getByText('还没有任务。先准备 Agent，再创建第一个任务。')).toBeTruthy();
    expect(screen.getByText('尚未配置机器人')).toBeTruthy();
  });

  describe('实际字段驱动的飞书 Bot 状态与引导回归', () => {
    const makeBot = makeSimpleBot;

    it('无 Bot 时：展示未配置引导，说明在飞书私聊/群聊@bot使用，主操作为绑定飞书 Bot', async () => {
      const user = userEvent.setup();
      const onOpenLarkSetup = vi.fn();
      render(<WorkspaceOverview {...baseProps} larkBots={[]} onOpenLarkSetup={onOpenLarkSetup} />);
      const aside = screen.getByRole('complementary', { name: '协作入口' });
      expect(within(aside).getByText('尚未配置机器人')).toBeTruthy();
      expect(within(aside).getByText(/私聊发目标/)).toBeTruthy();
      expect(within(aside).getByText(/群聊 @机器人/)).toBeTruthy();
      expect(within(aside).getByText('/help')).toBeTruthy();
      const bindBtn = within(aside).getByRole('button', { name: '绑定飞书 Bot' });
      await user.click(bindBtn);
      expect(onOpenLarkSetup).toHaveBeenCalledOnce();
    });

    it('配置未完成（setupComplete=false）：提示配置未完成与准确原因', () => {
      render(<WorkspaceOverview {...baseProps} larkBots={[makeBot({ setupComplete: false })]} />);
      expect(screen.getByText('配置未完成')).toBeTruthy();
      expect(screen.getByText('尚未选择默认 Agent 或确认执行权限')).toBeTruthy();
      expect(screen.queryByText(/监听已启动/)).toBeNull();
    });

    it('本实例 listening=false：只提示当前服务的监听状态', () => {
      render(<WorkspaceOverview {...baseProps} larkBots={[makeBot({ listening: false })]} />);
      expect(screen.getByText('本实例未开启监听')).toBeTruthy();
      expect(screen.getByText('当前服务未开启此机器人的监听；若已在其他实例运行，请到对应实例查看')).toBeTruthy();
    });

    it('本次启动禁用监听（larkListeningDisabled=true）：优先展示本次启动禁用监听', () => {
      render(<WorkspaceOverview {...baseProps} larkBots={[makeBot()]} larkListeningDisabled />);
      expect(screen.getByText('本次启动禁用监听')).toBeTruthy();
      expect(screen.getByText('服务端启动参数已禁用监听')).toBeTruthy();
    });

    it('期望监听但长连接未就绪（listening=true, activeListening=false）：提示监听尚未启动', () => {
      render(<WorkspaceOverview {...baseProps} larkBots={[makeBot({ activeListening: false })]} />);
      expect(screen.getByText('监听尚未启动')).toBeTruthy();
      expect(screen.getByText('已配置监听，但服务监听尚未启动')).toBeTruthy();
    });

    it('正常机器人只展示监听摘要，管理入口进入已有机器人页面', async () => {
      const onManageBots = vi.fn(); const onOpenLarkSetup = vi.fn();
      render(<WorkspaceOverview {...baseProps} larkBots={Array.from({ length: 4 }, (_, i) => makeBot({ appId: `cli_${i}`, name: `机器人${i}` }))} onManageBots={onManageBots} onOpenLarkSetup={onOpenLarkSetup}/>);
      expect(screen.getByText('4 个机器人 · 监听已启动')).toBeTruthy();
      expect(screen.queryByText('机器人0')).toBeNull();
      expect(screen.queryByText(/消息已送达/)).toBeNull();
      expect(screen.queryByText(/需要检查/)).toBeNull();
      await userEvent.click(screen.getByRole('button', { name: '管理飞书 Bot' }));
      expect(onManageBots).toHaveBeenCalledOnce();
      expect(onOpenLarkSetup).not.toHaveBeenCalled();
    });

    it('多 Bot 混合状态：综合概括如实展示，异常可展开且不重复列正常机器人', async () => {
      render(<WorkspaceOverview {...baseProps} larkBots={[
        makeBot({ appId: 'bot_active', name: '在线Bot' }),
        makeBot({ appId: 'bot_paused', name: '暂停Bot', listening: false })
      ]} />);
      expect(screen.getByText('2 个机器人 · 1 个监听中')).toBeTruthy();
      expect(screen.queryByText('在线Bot')).toBeNull();
      const details = screen.getByText('暂停Bot').closest('details')!;
      expect(details.open).toBe(false);
      await userEvent.click(screen.getByText('1 个机器人需要检查'));
      expect(details.open).toBe(true);
      expect(screen.getByText('暂停Bot')).toBeTruthy();
    });

    it('状态读取失败不沿用缓存宣布正常，也不误读为尚未配置', async () => {
      const onRetryLarkBots = vi.fn();
      render(<WorkspaceOverview {...baseProps} larkBots={[makeBot()]} larkBotsFailed onRetryLarkBots={onRetryLarkBots}/>);
      expect(screen.getByText('1 个机器人 · 状态未确认')).toBeTruthy();
      expect(screen.queryByText(/监听已启动/)).toBeNull();
      expect(screen.queryByText('尚未配置机器人')).toBeNull();
      await userEvent.click(screen.getByRole('button', { name: '重试' }));
      expect(onRetryLarkBots).toHaveBeenCalledOnce();
    });

    it('加载中状态：展示骨架屏与读取中提示，不谎报尚未配置', () => {
      render(<WorkspaceOverview {...baseProps} larkBots={[]} larkBotsLoading />);
      expect(screen.getByText('正在读取接入状态…')).toBeTruthy();
      expect(screen.queryByText('尚未配置机器人')).toBeNull();
    });

    it('缺失可用 Agent 时：展示准备 Agent 引导入口，但不妨碍用户配置 Bot', async () => {
      const user = userEvent.setup();
      const onOpenAgentSetup = vi.fn();
      const onOpenLarkSetup = vi.fn();
      render(<WorkspaceOverview {...baseProps} agents={[]} larkBots={[]} onOpenAgentSetup={onOpenAgentSetup} onOpenLarkSetup={onOpenLarkSetup} />);
      const aside = screen.getByRole('complementary', { name: '协作入口' });
      expect(within(aside).getByText(/尚未检测到本机可用 Agent/)).toBeTruthy();
      await user.click(within(aside).getByRole('button', { name: '准备 Agent' }));
      expect(onOpenAgentSetup).toHaveBeenCalledOnce();
      await user.click(within(aside).getByRole('button', { name: '绑定飞书 Bot' }));
      expect(onOpenLarkSetup).toHaveBeenCalledOnce();
    });

    it('Web 创建任务次操作依然可用', async () => {
      const user = userEvent.setup();
      const onCreate = vi.fn();
      render(<WorkspaceOverview {...baseProps} onCreate={onCreate} />);
      await user.click(screen.getByRole('button', { name: '创建任务' }));
      expect(onCreate).toHaveBeenCalledOnce();
    });
  });
});
