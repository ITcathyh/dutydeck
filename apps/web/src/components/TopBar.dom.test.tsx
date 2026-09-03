// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TopBar } from './TopBar';

/*
  顶栏的契约测试。

  顶栏是全站唯一不随路由卸载的横向条，外观切换、搜索入口、快捷键帮助三者在它出现
  之前都寄居在 WorkspaceOverview 里——而那个组件只在没打开任务时挂载。所以这里守的
  不只是「渲染出来了」，而是「打开任务后这些入口仍然在」这条可达性。
*/

const noop = () => {};

function renderTopBar(overrides: Partial<Parameters<typeof TopBar>[0]> = {}) {
  const props = {
    onOpenNavigation: noop,
    onGoHome: noop,
    onOpenSearch: noop,
    onOpenShortcuts: noop,
    themePreference: 'system' as const,
    themeResolved: 'light' as const,
    onThemeChange: noop,
    ...overrides
  };
  return render(<TopBar {...props}/>);
}

describe('TopBar 全局入口', () => {
  it('把打开任务后会失联的三个全局入口都常驻在顶栏里', async () => {
    const onOpenSearch = vi.fn();
    const onOpenShortcuts = vi.fn();
    const onThemeChange = vi.fn();
    const user = userEvent.setup();
    renderTopBar({ onOpenSearch, onOpenShortcuts, onThemeChange });

    // 搜索：详情页里此前只剩 Mod+K，没有任何可见入口，而命令面板是「设置」「飞书」的唯一发现路径。
    await user.click(screen.getByRole('button', { name: '搜索任务目标、工作区或 Agent' }));
    expect(onOpenSearch).toHaveBeenCalledTimes(1);

    // 外观：此前打开任务后彻底失联——没有快捷键、没有命令面板项，是纯粹的死路。
    const appearance = screen.getByRole('radiogroup', { name: '界面外观' });
    await user.click(within(appearance).getByRole('radio', { name: /^深色/ }));
    expect(onThemeChange).toHaveBeenCalledWith('dark');

    await user.click(screen.getByRole('button', { name: '查看键盘快捷键' }));
    expect(onOpenShortcuts).toHaveBeenCalledTimes(1);
  });

  it('品牌位是可点的回首页控件，且不与错误卡片里的「回到任务中心」重名', async () => {
    /*
      在此之前全站没有可见的回首页入口：侧栏顶部的品牌块是不可点的 div，
      只有 404 卡片和命令面板里有。

      名字不能直接叫「回到任务中心」——404 与「数据未就绪」两张卡片里已经有同名
      按钮，而那两种状态下顶栏同时在场，重名会让读屏用户与 getByRole 都分不清。
    */
    const onGoHome = vi.fn();
    renderTopBar({ onGoHome });
    await userEvent.click(screen.getByRole('button', { name: 'Dockmux 首页，回到任务中心' }));
    expect(onGoHome).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: '回到任务中心' })).toBeNull();
  });

  it('顶栏高度只走 h-topbar 这一个来源', () => {
    /*
      botmux 的顶栏有个 off-by-4 的历史 bug：--topbar-h(56px) 只被侧栏的 top 消费，
      顶栏自己用的是另一个 --topbar-height(60px)，于是侧栏顶边和顶栏底边差 4px
      （契约 §15）。这里断言顶栏高度只有 token 一个来源，任意值写法会被
      design-consistency.test.ts 拦下，但「换成另一个 token」只有这条能拦。
    */
    const { container } = renderTopBar();
    const header = container.querySelector('header')!;
    expect(header.className).toContain('h-topbar');
    expect(header.className).not.toMatch(/h-\[|min-h-\[|h-14\b|h-15\b/);
  });

  it('窄屏收起视觉文本，但无障碍名恒定写全', () => {
    /*
      搜索与品牌在窄屏只留图标。视觉可以省略，无障碍树不行——否则读屏用户在手机上
      听到的是一个没有名字的按钮。
    */
    renderTopBar();
    const search = screen.getByRole('button', { name: '搜索任务目标、工作区或 Agent' });
    expect(search.getAttribute('aria-label')).toBe('搜索任务目标、工作区或 Agent');
    // 视觉文本带 sm: 前缀的隐藏类，说明它是「窄屏收起」而不是「条件渲染删掉」。
    expect(search.querySelector('span')!.className).toContain('sm:inline');
  });

  it('每个交互元素都能 Tab 到，并且有可见 focus 环', async () => {
    const user = userEvent.setup();
    renderTopBar();
    // md:hidden 的汉堡在 jsdom 里仍然渲染（CSS 不生效），所以它也在 Tab 序列里。
    const interactive = [
      screen.getByRole('button', { name: '打开工作台导航' }),
      screen.getByRole('button', { name: 'Dockmux 首页，回到任务中心' }),
      screen.getByRole('button', { name: '搜索任务目标、工作区或 Agent' }),
      screen.getByRole('button', { name: '查看键盘快捷键' })
    ];
    for (const element of interactive) {
      expect(element.hasAttribute('disabled')).toBe(false);
      expect(element.getAttribute('tabindex')).not.toBe('-1');
      await user.tab();
    }
    // 焦点环靠 focus-visible:ring-*，不能只靠浏览器默认 outline（组件普遍 outline-none）。
    for (const element of interactive) {
      const focusable = element.className.includes('focus-visible:ring') ? element : element.closest('button')!;
      expect(focusable.className).toMatch(/focus-visible:ring-2/);
    }
  });

  it('移动端抽屉打开时整条顶栏退出可交互树', () => {
    /*
      抽屉是 fixed 浮层，顶栏在它下面。不置 inert 的话 Tab 会走到遮罩背后的顶栏上，
      焦点消失在视觉不可达的地方——<main> 已经这么做了，顶栏必须同步，否则等于开了个后门。
    */
    const { container } = renderTopBar({ hidden: true });
    const header = container.querySelector('header')!;
    expect(header.hasAttribute('inert')).toBe(true);
    expect(header.getAttribute('aria-hidden')).toBe('true');
  });

  it('不重复侧栏已经常驻的入口', () => {
    /*
      「创建任务」在侧栏、总览页、命令面板、n 键、/new 里已经有四五份，
      「Agent 与设置」在侧栏底部常驻。顶栏再来一份只是噪音，还会把右侧挤满。
      这条断言防止后来者顺手往顶栏塞按钮。
    */
    renderTopBar();
    expect(screen.queryByRole('button', { name: /创建任务/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /设置/ })).toBeNull();
  });
});
