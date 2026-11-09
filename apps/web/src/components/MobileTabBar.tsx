import { Home, Inbox, ListTodo, MoreHorizontal } from 'lucide-react';
import type { PrimaryNav } from '../app-route';

const tabs: Array<{ nav: PrimaryNav; label: string; Icon: typeof Home }> = [
  { nav: 'home', label: '总览', Icon: Home },
  { nav: 'tasks', label: '任务', Icon: ListTodo },
  { nav: 'inbox', label: '待办', Icon: Inbox },
  { nav: 'more', label: '更多', Icon: MoreHorizontal }
];

/*
  手机端（≤760px）底部 4 个同级目的地：总览、任务、待办、更多。
  遵循 HIG 规范：Tab 只承担同级目的地，新建等动作不塞进 Tab。
  管理类页面（自动化、机器人、群聊等）收进「更多」，切换目的地时激活状态对齐。
*/
export function MobileTabBar({ current, onNavigate, inboxCount = 0 }: {
  current: PrimaryNav;
  onNavigate(nav: PrimaryNav): void;
  inboxCount?: number;
}) {
  const activeNav = ['automation', 'bots', 'groups', 'more'].includes(current) ? 'more' : current;

  return <div className="ui-tabbar pointer-events-none fixed inset-x-0 z-sticky flex items-center justify-center px-4">
    <nav aria-label="主要页面" className="pointer-events-auto flex w-full max-w-md min-w-0 rounded-full border border-default bg-glass p-1 shadow-shell backdrop-blur-xl">
      {tabs.map(({ nav, label, Icon }) => {
        const active = activeNav === nav;
        return <button key={nav} type="button" aria-current={active ? 'page' : undefined} onClick={() => onNavigate(nav)}
          className={`relative flex h-12 min-h-11 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-full text-caption font-medium transition-colors duration-fast ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring ${active ? 'bg-action-soft text-primary font-semibold' : 'text-subtle'}`}>
          <div className="relative flex items-center justify-center">
            <Icon size={19} strokeWidth={active ? 2.2 : 1.8} aria-hidden="true"/>
            {nav === 'inbox' && inboxCount > 0 && <span aria-label={`${inboxCount} 项待办`} className="absolute -top-1 -right-2 flex h-4 min-w-4 items-center justify-center rounded-full bg-warning-solid px-1 text-caption font-bold text-on-action">
              {inboxCount}
            </span>}
          </div>
          <span className="max-w-full truncate">{label}</span>
        </button>;
      })}
    </nav>
  </div>;
}
