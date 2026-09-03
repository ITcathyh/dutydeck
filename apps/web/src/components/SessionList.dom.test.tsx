import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../api';
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
   * 群与权限的 `runtimeWired`、定时任务的 `executorWired` 在 api.ts 里都是字面量
   * `false`——不是「暂未完成」而是类型层面写死的。本仓有过 /help 承诺「可用命令
   * 列表」却没有列表的教训，composer-commands.ts 也记着两条因为空承诺被删掉的命令。
   * 这条用例把限制钉进可及名：措辞可以改，但「进去之后拿不到运行时」这件事必须
   * 在点进去之前就说清楚。
   */
  it('对只有草稿态的目的地如实标注限制，不做成空承诺', () => {
    render(<SessionList {...baseProps} open/>);
    expect(screen.getByRole('button', { name: /群与权限.*尚未接入运行时/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /定时任务.*不会自动执行/ })).toBeTruthy();
  });

  it('飞书入口按已绑定数量如实改口', () => {
    const { rerender } = render(<SessionList {...baseProps} open/>);
    expect(screen.getByRole('button', { name: /飞书接入.*尚未绑定机器人/ })).toBeTruthy();
    rerender(<SessionList {...baseProps} open larkBots={[{ appId: 'cli_a', name: '值班机器人' } as never]}/>);
    expect(screen.getByRole('button', { name: /飞书接入.*1 个机器人已绑定/ })).toBeTruthy();
  });

  /**
   * 分组必须是「真 heading + 可点条目」的结构，不是平铺。
   *
   * 视觉验收脚本认的是 nav/section/ul 容器里的 h2/h3/h4/[role=heading]——裸 <span>
   * 标题不计入分组。平铺 4 个链接读不出层次，分组才是这块导航的价值（botmux 19 项
   * 分 5 组，anatomy §A2）。这条用例在 e2e 之外再守一次，因为 e2e 要起浏览器。
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
   * botmux 的 36px 导航项档位刻意不引进——它是纯桌面英文界面。
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
