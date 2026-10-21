import type { LucideIcon } from 'lucide-react';

export type SidebarNavItem = { id: string; label: string; hint: string; Icon: LucideIcon; active?: boolean; onClick(): void };
export type SidebarNavGroup = { id: string; title: string; items: SidebarNavItem[] };
export type SidebarNavProps = { groups: SidebarNavGroup[]; compact?: boolean };

/** 常驻导航保持一行；能力限制保留在可及名与悬停说明中。 */
export function SidebarNav({ groups, compact = false }: SidebarNavProps) {
  return <div className="shrink-0 px-2.5">
    {groups.map(group => <nav key={group.id} aria-labelledby={`sidebar-nav-${group.id}`} className="mt-2 first:mt-0">
      <h2 id={`sidebar-nav-${group.id}`} className="sr-only">{group.title}</h2>
      {group.items.map(item => <button key={item.id} type="button" onClick={item.onClick} aria-current={item.active ? 'page' : undefined} title={`${item.label} · ${item.hint}`} className={`group flex min-h-10 w-full items-center gap-2.5 rounded-md px-2 text-left transition-colors duration-fast ease-out ${compact ? 'justify-center' : ''} ${item.active ? 'bg-sidebar-active text-sidebar-text-strong' : 'text-sidebar-text hover:bg-sidebar-hover'}`}>
        <item.Icon aria-hidden="true" size={16} className="shrink-0"/>
        <span className={compact ? 'sr-only' : 'min-w-0 flex-1 truncate text-caption'}>{item.label}</span><span className="sr-only">{item.hint}</span>
      </button>)}
    </nav>)}
  </div>;
}
