import { Keyboard, Menu, Search } from 'lucide-react';
import { IconButton, Kbd } from './primitives';
import { DutydeckIcon } from './ui';
import { ThemeToggle } from './ThemeToggle';
import type { ResolvedTheme, ThemePreference } from '../theme';

export type TopBarProps = {
  /** 移动端抽屉触发器。桌面端侧栏常驻，这枚按钮 md:hidden。 */
  onOpenNavigation(): void;
  onGoHome(): void;
  onOpenSearch(): void;
  onOpenShortcuts(): void;
  themePreference: ThemePreference;
  themeResolved: ResolvedTheme;
  onThemeChange(next: ThemePreference): void;
  /** 移动端抽屉打开时，顶栏和主区一起退出可交互树，否则 Tab 会走到遮罩背后。 */
  hidden?: boolean;
};

/*
  全局顶栏。

  ## 为什么需要它

  在此之前 dutydeck 只有「侧栏 + 主区」两栏，全局动作全部寄居在 WorkspaceOverview
  的页首行里。而 WorkspaceOverview 只在没有打开任务时挂载（App.tsx 的 active 分支
  是二选一），于是一旦点进任何一个任务：

  · 外观切换 —— 彻底失联。没有快捷键、没有命令面板项、没有菜单项，是纯粹的死路。
  · 搜索 / 命令面板 —— 只剩 Mod+K 和 /，没有任何可见入口。命令面板又是「设置」
    「飞书」这些命令的唯一发现路径，等于把整个命令面盘藏进了没人知道的按键里。
  · 快捷键帮助 —— 只剩 ? 键；而它在总览页本身就是 hidden sm:inline，移动端从来没有过。

  顶栏是这三者唯一合适的落点：它横跨全宽、不随路由卸载、不随滚动移动。

  ## 为什么只放这四样

  「顶栏里任何按钮不得声称一个它不做的功能」是硬约束，反过来「已经有常驻入口的
  动作不该再复制一份」同样是。故意排除：

  · 创建任务 —— 侧栏常驻按钮 + 总览页主按钮 + 命令面板 + n 键 + /new，已经四五份，
    第六份只是噪音。
  · 设置与接入 —— 侧栏底部常驻（SessionList 的「Agent 与设置」）。
  · 飞书 —— 总览页有协作卡片，命令面板与 g l 也能到。放进来会让右侧挤到五枚控件，
    而它并不像外观切换那样存在「打开任务后完全失联」的问题。

  ## 高度只有一个值

  botmux 的顶栏有个 off-by-4 的历史 bug：--topbar-h(56px) 只被侧栏的 top 消费，
  顶栏自己用的是另一个 --topbar-height(60px)，两值不等（契约 §15）。这里只用
  h-topbar 一个来源，侧栏的让位与顶栏的高度必然对齐。

  分隔线用 border-b border-default，不复刻 botmux 的 ::after 两端淡出渐变线——
  那需要一条 linear-gradient 字面量，而契约禁止组件里出现颜色字面量。
*/
export function TopBar({ onOpenNavigation, onGoHome, onOpenSearch, onOpenShortcuts, themePreference, themeResolved, onThemeChange, hidden }: TopBarProps) {
  return <header
    aria-hidden={hidden || undefined}
    inert={hidden || undefined}
    className="flex h-topbar shrink-0 items-center gap-2 border-b border-default bg-surface px-3 sm:px-5"
  >
    <span className="md:hidden"><IconButton label="打开工作台导航" onClick={onOpenNavigation}><Menu size={17}/></IconButton></span>

    {/*
      品牌位同时是「回到任务中心」。此前全站没有任何可见的回首页控件：侧栏顶部的
      品牌块是个不可点的 div，只有 404 卡片和命令面板里有。

      无障碍名不能直接叫「回到任务中心」——404 与「数据未就绪」两张卡片里已经有
      同名按钮，而那两种状态下顶栏同时在场，重名会让读屏用户和测试都分不清哪个是哪个。
    */}
    <button
      type="button"
      onClick={onGoHome}
      aria-label="Dutydeck 首页，回到任务中心"
      className="flex min-h-10 shrink-0 items-center gap-2 rounded-md px-1.5 transition-colors duration-fast ease-out hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
    >
      <DutydeckIcon className="h-7 w-7 shrink-0"/>
      <span className="hidden text-body font-semibold tracking-[-.025em] text-primary sm:inline">Dutydeck</span>
    </button>

    <div className="ml-auto flex min-w-0 items-center gap-1.5">
      {/*
        搜索框按钮在窄屏收成图标，但 aria-label 恒定写全，无论宽窄读屏拿到的都是
        同一句话——不能让「视觉上省略」变成「无障碍树里也省略」。
      */}
      <button
        type="button"
        onClick={onOpenSearch}
        aria-label="搜索任务目标、工作区或 Agent"
        className="flex min-h-10 min-w-10 items-center justify-center gap-2 rounded-md border-transparent px-2 text-body text-subtle transition-colors duration-fast ease-out hover:bg-hover hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring sm:w-64 sm:justify-start sm:border sm:border-default sm:bg-surface sm:px-3"
      >
        <Search aria-hidden="true" size={15} className="shrink-0"/>
        <span className="hidden min-w-0 flex-1 truncate text-left sm:inline">搜索任务目标、工作区或 Agent</span>
        <span className="hidden shrink-0 sm:inline"><Kbd>Ctrl K</Kbd></span>
      </button>

      <ThemeToggle preference={themePreference} resolved={themeResolved} onChange={onThemeChange}/>

      {/* 帮助在窄屏隐藏：? 键与命令面板都能到，而顶栏在 390px 上放不下第四枚控件。 */}
      <span className="hidden sm:inline"><IconButton label="查看键盘快捷键" onClick={onOpenShortcuts}><Keyboard size={16}/></IconButton></span>
    </div>
  </header>;
}
