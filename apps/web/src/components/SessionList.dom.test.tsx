import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunSummary, Session } from '../api';
import { workbenchViewLabels, workbenchViewOrder } from '../workspace-model';
import { SessionList, type SessionListProps } from './SessionList';

const baseProps: SessionListProps = { open: false, onClose: () => {}, sessions: [], summaries: {}, sessionsLoading: false, agents: [], larkBots: [], view: 'all', onSelect: () => {}, onNewSession: () => {}, onOpenControlCenter: () => {}, onOpenLarkSetup: () => {}, onOpenGroups: () => {}, onOpenSchedules: () => {} };
const originalMatchMedia = window.matchMedia;

afterEach(() => { vi.restoreAllMocks(); Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: originalMatchMedia }); });

describe('SessionList mobile accessibility', () => {
  it('移动侧栏关闭时 inert 且从可访问树隐藏，打开后恢复', () => {
    const matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() });
    Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: matchMedia });
    const { container, rerender } = render(<SessionList {...baseProps}/>);
    const aside = container.querySelector('aside')!;
    expect(aside.hasAttribute('inert')).toBe(true);
    expect(aside.getAttribute('aria-hidden')).toBe('true');
    rerender(<SessionList {...baseProps} open/>);
    expect(aside.hasAttribute('inert')).toBe(false);
    expect(aside.hasAttribute('aria-hidden')).toBe(false);
  });

  /**
   * 侧栏只回答「按目录找任务」，状态筛选是总览页的职责。
   *
   * 侧栏在桌面端恒常可见（md:static），此前它自带一份 7 项状态导航，
   * 于是同一屏上必然出现两份筛选，且两份的口径还各自漂移。
   * 这条用例守的是「状态筛选在侧栏里不存在」，防止它再长回来。
   */
  it('侧栏只做工作区导航，不再重复渲染状态筛选', () => {
    const makeSession = (id: string, state: string): Session => ({ id, agentId: 'codex', state, cwd: `/repo/${id}`, runId: `run-${id}`, createdAt: '', updatedAt: '' });
    render(<SessionList {...baseProps} open sessions={[makeSession('alpha', 'failed'), makeSession('beta', 'thinking')]}/>);
    expect(screen.queryByRole('navigation', { name: '任务视图' })).toBeNull();
    for (const label of [...workbenchViewOrder.map(view => workbenchViewLabels[view]), '有排队的运行', '失败']) {
      expect(screen.queryByRole('button', { name: new RegExp(`^${label}`) })).toBeNull();
    }
    // 「绑定 Bot」也从侧栏移除：飞书入口只在总览页与设置里各留一处。
    expect(screen.queryByRole('button', { name: /绑定 Bot/ })).toBeNull();
    // 工作区分组仍然列任务，这是侧栏保留的那条检索路径。
    expect(screen.getByText('工作区')).toBeTruthy();
    for (const name of ['alpha', 'beta']) expect(screen.getByText(name)).toBeTruthy();
  });

  it('创建任务按钮在 Agent 未就绪时不谎报，加载完成后才给出真实去向', async () => {
    const user = userEvent.setup();
    const onNewSession = vi.fn(); const onOpenControlCenter = vi.fn();
    const { rerender } = render(<SessionList {...baseProps} open agentsLoading onNewSession={onNewSession} onOpenControlCenter={onOpenControlCenter}/>);
    const detecting = screen.getByRole('button', { name: '正在检测 Agent…' });
    expect(detecting.hasAttribute('disabled')).toBe(true);

    // 加载完仍然没有 Agent：按钮如实改口，去向是「准备 Agent」而不是创建任务。
    rerender(<SessionList {...baseProps} open agents={[]} onNewSession={onNewSession} onOpenControlCenter={onOpenControlCenter}/>);
    await user.click(screen.getByRole('button', { name: '准备 Agent' }));
    expect(onOpenControlCenter).toHaveBeenCalledTimes(1);
    expect(onNewSession).not.toHaveBeenCalled();

    rerender(<SessionList {...baseProps} open agents={[{ id: 'codex', name: 'Codex', protocol: 'acp', permissionMode: 'full-trust' }]} onNewSession={onNewSession} onOpenControlCenter={onOpenControlCenter}/>);
    await user.click(screen.getByRole('button', { name: '创建任务' }));
    expect(onNewSession).toHaveBeenCalledTimes(1);
  });

  it('归档视图只展示已归档任务', () => {
    const makeSession = (id: string, archivedAt?: string): Session => ({ id, agentId: 'codex', state: 'completed', cwd: `/repo/${id}`, runId: `run-${id}`, createdAt: '', updatedAt: '', ...(archivedAt ? { archivedAt } : {}) });
    render(<SessionList {...baseProps} open view="archived" sessions={[makeSession('current'), makeSession('history', '2026-08-30T00:00:00Z')]}/>);
    expect(screen.getByText('history')).toBeTruthy();
    expect(screen.queryByText('current')).toBeNull();
  });

  it('以设置与接入承载低频配置，并明确受信开发机模式', async () => {
    const onOpenControlCenter = vi.fn();
    render(<SessionList {...baseProps} open authRequired={false} onOpenControlCenter={onOpenControlCenter}/>);
    await userEvent.click(screen.getByRole('button', { name: /Agent 与设置/ }));
    expect(onOpenControlCenter).toHaveBeenCalledOnce();
    expect(screen.getByText(/受信开发机模式 · 无需 token/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /开启监听/ })).toBeNull();
  });
});

/**
 * 工作区分组的折叠。
 *
 * 起因：18 条任务全部平铺时，侧栏 248px 宽塞进 822 个字符，讲的全是主区已经讲过
 * 且更完整的事（桌面端两者同屏）。折叠让默认只剩「目录名 + 条数」。
 *
 * 但折叠本身也能变成负担，所以默认规则有三条边界，各在下面有一条用例：
 * 单任务的组折叠起来一行也不省、只多一次点击；当前打开任务藏进折叠区等于没有选中态；
 * 只剩一个工作区时折叠后侧栏只有一行组头，像是没有任务。
 */
describe('SessionList 工作区折叠', () => {
  const makeSession = (id: string, workspace: string): Session => ({ id, agentId: 'codex', state: 'idle', cwd: `/repo/${workspace}`, runId: `run-${id}`, createdAt: '', updatedAt: '' });
  const twoInAlpha = [makeSession('a1', 'alpha'), makeSession('a2', 'alpha'), makeSession('b1', 'beta')];
  // summaries 走真实类型而不是 `as never`：后者会让下面的 rerender 里那个 spread
  // 失去对象类型，`tsc -b` 报 TS2698。vitest 不做类型检查，只有 build 会拦。
  const summary = (id: string, prompt: string): RunSummary => ({ sessionId: id, taskId: `task-${id}`, prompt, status: 'idle', queuedCount: 0, updatedAt: '' });
  const summaries: Record<string, RunSummary> = { a1: summary('a1', '任务 A1'), a2: summary('a2', '任务 A2'), b1: summary('b1', '任务 B1') };

  it('多任务的组默认折叠，任务行不进 DOM；组头给出条数', () => {
    render(<SessionList {...baseProps} open sessions={twoInAlpha} summaries={summaries}/>);
    const header = screen.getByRole('button', { name: /^alpha/ });
    expect(header.getAttribute('aria-expanded')).toBe('false');
    // 断言「不在 DOM」而不是「不可见」：折叠是条件渲染，若改成 CSS 隐藏，读屏和
    // Tab 顺序里仍然躺着 18 条任务，降噪只对眼睛生效。
    expect(screen.queryByRole('button', { name: /任务 A1/ })).toBeNull();
    expect(header.textContent).toContain('2');
  });

  it('只有一条任务的组默认展开：折叠它一行也不省，只多一次点击', () => {
    render(<SessionList {...baseProps} open sessions={twoInAlpha} summaries={summaries}/>);
    expect(screen.getByRole('button', { name: /^beta/ }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('button', { name: /任务 B1/ })).toBeTruthy();
  });

  it('只有一个工作区时默认展开，不让侧栏只剩一行组头', () => {
    render(<SessionList {...baseProps} open sessions={twoInAlpha.slice(0, 2)} summaries={summaries}/>);
    expect(screen.getByRole('button', { name: /^alpha/ }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('button', { name: /任务 A1/ })).toBeTruthy();
  });

  it('当前打开任务所在的组默认展开，否则选中态藏进折叠区等于没有选中态', () => {
    render(<SessionList {...baseProps} open sessions={twoInAlpha} summaries={summaries} activeSessionId="a2"/>);
    expect(screen.getByRole('button', { name: /^alpha/ }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('button', { name: /任务 A2/ }).getAttribute('aria-current')).toBe('true');
  });

  it('点组头展开与收起，且用户的选择压过默认规则', async () => {
    const user = userEvent.setup();
    render(<SessionList {...baseProps} open sessions={twoInAlpha} summaries={summaries}/>);
    await user.click(screen.getByRole('button', { name: /^alpha/ }));
    expect(screen.getByRole('button', { name: /任务 A1/ })).toBeTruthy();
    // 单任务组默认展开，但用户手动收起后必须保持收起，不被默认规则夺回。
    await user.click(screen.getByRole('button', { name: /^beta/ }));
    expect(screen.getByRole('button', { name: /^beta/ }).getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('button', { name: /任务 B1/ })).toBeNull();
  });

  /**
   * 折叠状态只记「用户改过的那些」，不预填完整表。
   *
   * 预填会让 sessions 每次刷新（15 秒一次 refetch）都重算出一张新表，用户展开过的
   * 组随之收起。这条用例用 rerender 模拟那次刷新：新任务进来了，展开态必须还在。
   */
  it('任务列表刷新后不把用户展开的组重新收起', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<SessionList {...baseProps} open sessions={twoInAlpha} summaries={summaries}/>);
    await user.click(screen.getByRole('button', { name: /^alpha/ }));
    expect(screen.getByRole('button', { name: /任务 A1/ })).toBeTruthy();
    rerender(<SessionList {...baseProps} open sessions={[...twoInAlpha, makeSession('a3', 'alpha')]} summaries={{ ...summaries, a3: summary('a3', '任务 A3') }}/>);
    expect(screen.getByRole('button', { name: /^alpha/ }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('button', { name: /任务 A3/ })).toBeTruthy();
  });
});

/**
 * 独立 worktree 任务的项目聚合。
 *
 * 同一源仓库（workspaceSourceCwd）的两个任务，实际执行目录分别是
 * ~/.dutydeck/workspaces/ses_one 与 ses_two。若侧栏按执行目录分组，
 * 这两个任务会被显示成两个 ses_* 「项目」，项目导航失去意义。
 * 这里守的是：组按源目录聚合、组头标题与 title 显示源目录、展开后两条真实任务都在，
 * 且点击任务仍按真实 session id 选中。
 */
describe('SessionList 同源 worktree 项目聚合', () => {
  const worktreeSession = (id: string, source: string): Session => ({
    id,
    agentId: 'codex',
    state: 'idle',
    cwd: `/home/u/.dutydeck/workspaces/${id}`,
    workspaceMode: 'worktree',
    workspaceSourceCwd: source,
    runId: `run-${id}`,
    createdAt: '',
    updatedAt: ''
  });

  it('同源两个 worktree 归一个 project 组，两条任务都按真实 id 可选', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const sessions = [worktreeSession('ses_one', '/repo/project'), worktreeSession('ses_two', '/repo/project/')];
    const summaries: Record<string, RunSummary> = {
      ses_one: { sessionId: 'ses_one', taskId: 't1', prompt: '任务一', status: 'idle', queuedCount: 0, updatedAt: '' },
      ses_two: { sessionId: 'ses_two', taskId: 't2', prompt: '任务二', status: 'idle', queuedCount: 0, updatedAt: '' }
    };
    render(<SessionList {...baseProps} open sessions={sessions} summaries={summaries} onSelect={onSelect}/>);
    // 只有一个组，标题与 title 都指向源项目，而不是 ses_one / ses_two。
    const header = screen.getByRole('button', { name: /^project/ });
    expect(header.getAttribute('title')).toBe('/repo/project');
    expect(header.textContent).toContain('2');
    expect(screen.queryByRole('button', { name: /^ses_one/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^ses_two/ })).toBeNull();
    // 只剩一个工作区时默认展开，不必先点组头。
    expect(header.getAttribute('aria-expanded')).toBe('true');
    const first = screen.getByRole('button', { name: /任务一/ });
    const second = screen.getByRole('button', { name: /任务二/ });
    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    await user.click(second);
    expect(onSelect).toHaveBeenCalledWith('ses_two');
  });

  it('不同源目录的 worktree 仍分成不同项目组', () => {
    render(<SessionList {...baseProps} open sessions={[worktreeSession('ses_one', '/repo/alpha'), worktreeSession('ses_two', '/repo/beta')]}/>);
    expect(screen.getByRole('button', { name: /^alpha/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^beta/ })).toBeTruthy();
  });
});

/**
 * 侧栏底部功能导航。
 *
 * 重做前整个侧栏只有三个可见字符串，一半的目的地（群与权限、定时任务）只能靠
 * 三层点击或深链到达，而其中一颗按钮在数据为空时根本不渲染。这组用例守的是
 * 「这些入口存在、可点、且不说谎」。
 */
describe('SessionList 功能导航区', () => {
  it('把原先只能深链或三层点击才能到的目的地做成常驻入口', async () => {
    const user = userEvent.setup();
    const onOpenLarkSetup = vi.fn(); const onOpenGroups = vi.fn(); const onOpenSchedules = vi.fn();
    render(<SessionList {...baseProps} open onOpenLarkSetup={onOpenLarkSetup} onOpenGroups={onOpenGroups} onOpenSchedules={onOpenSchedules}/>);
    await user.click(screen.getByRole('button', { name: /飞书接入/ }));
    expect(onOpenLarkSetup).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('button', { name: /群与权限/ }));
    expect(onOpenGroups).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('button', { name: /定时任务/ }));
    expect(onOpenSchedules).toHaveBeenCalledOnce();
  });

  /**
   * 硬约束：导航项不得声称它不做的功能。
   *
   * 群与权限的 `runtimeWired` 在 api.ts 里是字面量 `false`——不是「暂未完成」
   * 而是类型层面写死的。本仓有过 /help 承诺「可用命令列表」却没有列表的教训，
   * composer-commands.ts 也记着两条因为空承诺被删掉的命令。这条用例把限制钉进
   * 可及名：措辞可以改，但「进去之后拿不到运行时」这件事必须在点进去之前就
   * 说清楚。
   *
   * 定时任务入口是真实 session 自动化总览：任务内计划会按时运行，只有导入定义
   * 是草稿，所以 hint 只说「任务执行计划与草稿」，不把整个入口统称「不会自动执行」。
   */
  it('群与权限如实标注运行时限制；定时任务只标注导入草稿，不统称不执行', () => {
    render(<SessionList {...baseProps} open/>);
    expect(screen.getByRole('button', { name: /群与权限.*尚未接入运行时/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /定时任务.*任务执行计划与草稿/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /定时任务.*不会自动执行/ })).toBeNull();
  });

  it('飞书入口按真实状态如实改口，拒绝虚假声明', () => {
    const { rerender } = render(<SessionList {...baseProps} open/>);
    expect(screen.getByRole('button', { name: /飞书接入.*尚未配置机器人/ })).toBeTruthy();
    // 只有 appId 但未配置完成（setupComplete: false）
    rerender(<SessionList {...baseProps} open larkBots={[{ appId: 'cli_a', name: '值班机器人', setupComplete: false } as never]}/>);
    expect(screen.getByRole('button', { name: /飞书接入.*配置未完成/ })).toBeTruthy();
    // 完整就绪并启动监听
    rerender(<SessionList {...baseProps} open larkBots={[{ appId: 'cli_a', name: '值班机器人', setupComplete: true, listening: true, activeListening: true } as never]}/>);
    expect(screen.getByRole('button', { name: /飞书接入.*1 个机器人 · 监听已启动/ })).toBeTruthy();
    // 本次禁用监听
    rerender(<SessionList {...baseProps} open larkListeningDisabled larkBots={[{ appId: 'cli_a', name: '值班机器人', setupComplete: true, listening: true, activeListening: true } as never]}/>);
    expect(screen.getByRole('button', { name: /飞书接入.*本次启动禁用监听/ })).toBeTruthy();
  });

  /**
   * 侧栏与总览页协作卡片同屏（桌面端 ≥768px），所以「读不到」这一态必须两处一致。
   */
  it('飞书接入状态未就绪时不谎报「尚未配置」，与总览页说法一致', () => {
    render(<SessionList {...baseProps} open larkBotsLoading/>);
    expect(screen.getByRole('button', { name: /飞书接入.*正在读取接入状态/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /尚未配置机器人/ })).toBeNull();
  });

  /**
   * 分组必须是「真 heading + 可点条目」的结构，不是平铺。
   *
   * 视觉验收脚本认的是 nav/section/ul 容器里的 h2/h3/h4/[role=heading]——裸 <span>
   * 标题不计入分组。平铺 4 个链接读不出层次，分组才是这块导航的价值（按业务域划分各组导航）。
   * 这条用例在 e2e 之外再守一次，因为 e2e 要起浏览器。
   */
  it('导航是分组结构：每组都有真 heading 和至少一个条目', () => {
    const { container } = render(<SessionList {...baseProps} open/>);
    const groups = [...container.querySelectorAll('nav')].map(nav => ({
      heading: nav.querySelector('h2,h3,h4,[role="heading"]')?.textContent?.trim() ?? '',
      items: nav.querySelectorAll('button').length
    }));
    expect(groups.length).toBeGreaterThanOrEqual(2);
    for (const group of groups) {
      expect(group.heading).not.toBe('');
      expect(group.items).toBeGreaterThan(0);
    }
    // 每个 <nav> 都要有可及名，否则读屏会连报数个无名「导航」地标。
    for (const nav of container.querySelectorAll('nav')) expect(nav.getAttribute('aria-labelledby')).toBeTruthy();
  });

  /**
   * 触控目标（契约 §9）：移动端侧栏是 fixed 抽屉，这里全是触控。
   * 导航项高度需满足移动端触控要求（不采用过窄的 36px 档位）。
   */
  it('导航项满足触控下限，且键盘可达', async () => {
    render(<SessionList {...baseProps} open/>);
    for (const name of [/飞书接入/, /群与权限/, /定时任务/]) {
      const item = screen.getByRole('button', { name });
      expect(item.className).toMatch(/\bmin-h-12\b/);
      // 原生 <button> 天然可 Tab 到；这里守的是没人给它加 tabIndex={-1}。
      expect(item.getAttribute('tabindex')).toBeNull();
    }
    // focus 环走 index.css 的全局 button:focus-visible，所以组件不得覆盖 outline。
    expect(screen.getByRole('button', { name: /定时任务/ }).className).not.toMatch(/outline-none/);
    await userEvent.tab();
    expect(document.activeElement).toBeTruthy();
  });

  /**
   * 侧栏不得长出第二份状态筛选（与总览页正交）。上面那条老用例守的是旧的 7 项
   * 筛选不复活；这条守的是新导航区不把「已归档」这类状态视图混进来——它是总览页
   * 的筛选（数字键 5），放进侧栏就等于在侧栏里重建了状态筛选。
   */
  it('功能导航不混入状态视图', () => {
    const { container } = render(<SessionList {...baseProps} open/>);
    for (const nav of container.querySelectorAll('nav')) {
      for (const view of workbenchViewOrder) expect(nav.textContent).not.toContain(workbenchViewLabels[view]);
    }
  });
});
