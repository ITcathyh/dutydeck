import { CalendarClock, Home, Inbox, ListTodo, Plus } from 'lucide-react';
import type { PrimaryNav } from '../app-route';

const tabs: Array<{ nav: PrimaryNav; label: string; Icon: typeof Home }> = [
  { nav: 'home', label: '总览', Icon: Home },
  { nav: 'tasks', label: '任务', Icon: ListTodo },
  { nav: 'inbox', label: '待办', Icon: Inbox },
  { nav: 'automation', label: '自动化', Icon: CalendarClock }
];

/*
  窄屏列表页的底部导航：一级页面放在拇指够得到的地方，新建任务单独成一枚圆钮。
  只在列表页出现——任务页底部是输入框，两者抢同一块位置；其余入口（群聊、设置、用量）
  仍在顶栏汉堡打开的抽屉里，这里不复制一份。
*/
export function MobileTabBar({ current, onNavigate, onCreateTask, createDisabled = false }: {
  current: PrimaryNav;
  onNavigate(nav: PrimaryNav): void;
  onCreateTask(): void;
  createDisabled?: boolean;
}) {
  return <div className="ui-tabbar pointer-events-none fixed inset-x-0 z-sticky flex items-center gap-2 px-3">
    <nav aria-label="主要页面" className="pointer-events-auto flex min-w-0 flex-1 rounded-full border border-default bg-glass p-1 shadow-shell backdrop-blur-xl">
      {tabs.map(({ nav, label, Icon }) => {
        const active = current === nav;
        return <button key={nav} type="button" aria-current={active ? 'page' : undefined} onClick={() => onNavigate(nav)}
          className={`flex h-12 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-full text-meta font-medium transition-colors duration-fast ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring ${active ? 'bg-action-soft text-primary' : 'text-subtle'}`}>
          <Icon size={19} strokeWidth={active ? 2.2 : 1.8} aria-hidden="true"/>
          <span className="max-w-full truncate">{label}</span>
        </button>;
      })}
    </nav>
    <button type="button" aria-label="新建任务" disabled={createDisabled} onClick={onCreateTask}
      className="pointer-events-auto grid h-14 w-14 shrink-0 place-items-center rounded-full bg-action text-on-action shadow-shell transition-transform duration-fast ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 active:scale-95 disabled:opacity-50">
      <Plus size={22} aria-hidden="true"/>
    </button>
  </div>;
}
