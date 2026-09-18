import type { LucideIcon } from 'lucide-react';

export type SidebarNavItem = {
  id: string;
  /** 可见标签，也是可及名的开头。测试按名字取这些按钮。 */
  label: string;
  /**
   * 第二行。**这一行不是装饰，是本组件存在的前提**——见下面「诚实标注」一节。
   * 它进可及名（在 button 内部），所以读屏用户和视觉用户拿到的是同一句话。
   */
  hint: string;
  Icon: LucideIcon;
  /**
   * 当前项。只有「切换主区视图」的项能传：它切完之后自己仍然可见，
   * 选中态才有人看得见（见下面「选中态只属于主区导航」一节）。
   */
  active?: boolean;
  onClick(): void;
};

export type SidebarNavGroup = { id: string; title: string; items: SidebarNavItem[] };

export type SidebarNavProps = { groups: SidebarNavGroup[] };

/**
 * 侧栏底部功能导航。
 *
 * ## 为什么要有它
 *
 * 重做前整个侧栏只有三个可见字符串（「工作区」「Agent 与设置」「本机运行 · ACPX 0.13」）。
 * 清点下来，dutydeck 一半的目的地根本没有常驻入口：
 *
 * - `?panel=groups`（群与权限）埋在三层点击之下：侧栏「Agent 与设置」→ 左侧分区
 *   「群与权限」→「查看群配置」，而最后那颗按钮在 `cells.length === 0` 时**根本不渲染**
 *   （ControlCenterModal.tsx 的三元分支）。没有快捷键，命令面板里也没有。
 * - `?panel=automation`（定时任务）同样三层深，同样无快捷键、无命令。它的服务端
 *   甚至硬编码返回一条 blocker `schedule_ui_entry_unwired`，字面意思就是「共享 UI
 *   外壳缺一个导航入口」。这个组件就是那个入口。
 * - 设置页的 lark / groups / automation 三个 section 只有深链能到——代码里所有
 *   `openSettings()` 调用都写死 `'agents'`。
 *
 * 所以这里的四项不是「把已有按钮再抄一遍」，每一项都是在补一条原先只能靠深链、
 * 键盘或三层点击才能走通的路。已经有常驻入口的东西刻意不放进来（理由见下）。
 *
 * ## 诚实标注：hint 是硬约束不是文案润色
 *
 * 本仓有过「/help 描述为『查看键盘快捷键与可用命令』但实际没有命令列表」的教训，
 * `composer-commands.ts` 的头注释里还记着两条因为承诺不存在的能力而被删掉的命令
 * （`/goal`、`/fast`）。导航项比斜杠命令更危险：它常驻可见，是用户对「这个产品能
 * 做什么」的第一印象。
 *
 * 这里两项通往的面板**当前不具备它名字暗示的能力**，而且不是暂时的：
 *
 * - 群与权限：`FoundationCapability.runtimeWired` 的类型是字面量 `false`
 *   （api.ts），服务端恒挂 blocker `production_execution_unwired`。它只能编辑
 *   离线策略草稿。
 * - 定时任务：`ScheduleCapability.executorWired` 同样是字面量 `false`。没有 timer，
 *   不会创建真实 Run。
 *
 * 于是 hint 写死这两条限制，且**逐字沿用目标面板自己的说法**（「尚未接入运行时」
 * 「不会自动执行」）。不另造一套措辞是刻意的：两处各写各的，早晚漂移成互相矛盾，
 * 那正是本轮重做要消灭的病。
 *
 * ## 选中态只属于主区导航
 *
 * 「机器人」「群聊」两项切换的是主区视图，切完之后侧栏还在，所以它们必须有
 * aria-current——用户点完看不到自己在哪，会反复点同一项确认。
 *
 * 打开浮层的那几项仍然不做选中态：浮层是 Dialog portal + 遮罩，打开的一瞬间
 * 侧栏就在 scrim 之下，一个只在不可见时才为真的「当前项」是纯粹的噪音。
 * 所以 active 是可选的，由调用方按「这一项切不切主区」来决定传不传。
 */
export function SidebarNav({ groups }: SidebarNavProps) {
  return <div className="shrink-0 px-2.5 pb-1.5">
    {groups.map(group => <nav key={group.id} aria-labelledby={`sidebar-nav-${group.id}`} className="mt-2 first:mt-0">
      {/*
        组标题必须是真 heading：视觉验收脚本认的是
        h2/h3/h4/[role=heading]/legend/.nav-group-title，裸 <span> 不计入分组——
        「只有条目没标题」是平铺不是分组，而按业务域分组才是这块导航的价值所在。
      */}
      <h2 id={`sidebar-nav-${group.id}`} className="px-2 pb-1 pt-1.5 text-meta font-semibold tracking-[.08em] text-sidebar-text-muted">{group.title}</h2>
      {group.items.map(item => <button
        key={item.id}
        type="button"
        onClick={item.onClick}
        aria-current={item.active ? 'page' : undefined}
        /*
          高 48px（两行：body 22 + caption 18 + py），按契约 §3「半径 ≈ 高度/3.5」
          取 rounded-lg（14px），与同为多行的 SessionRow 一致。

          触控目标 §9 要求 ≥40px，48px 有余量——不采用过窄的 36px 档位，
          确保在移动端 (<md) 作为抽屉展开时符合触控标准。

          不写 focus-visible:outline-none。index.css 给所有 button 定义了
          2px 实心 focus 环，覆盖掉它就要在这里重新造一个等价物；nav 容器的
          px-2.5 已经给 outline-offset 留够了余量，不会被 aside 的 overflow-hidden 裁掉。
        */
        className={`group flex min-h-12 w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors duration-fast ease-out ${item.active ? 'bg-sidebar-hover' : 'hover:bg-sidebar-hover'}`}
      >
        <item.Icon aria-hidden="true" size={16} className="shrink-0 text-sidebar-accent"/>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-body font-medium text-sidebar-text transition-colors duration-fast ease-out group-hover:text-sidebar-text-strong">{item.label}</span>
          <span className="block truncate text-caption text-sidebar-text-muted">{item.hint}</span>
        </span>
      </button>)}
    </nav>)}
  </div>;
}
