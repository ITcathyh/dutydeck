import type { ReactNode } from 'react';
import type { Agent, PermissionMode, Session } from '../api';

// 展示层术语两级制：一条 Session 对用户叫「任务」，一条 TaskRecord 对用户叫「指令」。
// 「任务运行」「运行」「会话」都不再作为 Session 的叫法出现在界面上。
//
// stateLabels 在 sse.ts 有一份刻意的逐字副本（那里禁止与 components/ 互相 import）。
// 改动这里的任何一个状态词，必须同步 sse.ts:stateLabels。
export const stateLabels: Record<string, string> = {
  created: '已创建', starting: '启动中', idle: '就绪', thinking: '思考中', running_tool: '正在调用工具', waiting_for_permission: '等待授权', interrupting: '正在取消', interrupted: '已取消', completed: '已完成', failed: '失败', stopped: '已停止'
};

/**
 * 权限模式的用户可见名称，全站唯一副本。
 *
 * 这四个词曾在 RunHeader、NewSessionModal、ControlCenterModal 各抄一份，
 * 并且已经抄歪：ask 在前两处是「交互确认」，在设置页却是「操作前确认」——
 * 同一个模式在同一个产品里有两个名字。新增入口一律从这里 import，不要再抄。
 */
export const permissionLabels: Record<PermissionMode, string> = {
  ask: '交互确认',
  'approve-reads': '自动读取',
  'deny-all': '全部拒绝',
  'full-trust': '完全信任'
};
export const stateTone: Record<string, string> = { starting: 'bg-warning-solid', thinking: 'bg-warning-solid', running_tool: 'bg-info-solid', waiting_for_permission: 'bg-attention-solid', failed: 'bg-danger-solid', stopped: 'bg-neutral-solid', interrupted: 'bg-neutral-solid', completed: 'bg-success-solid', idle: 'bg-success-solid' };
export const busyStates = new Set(['starting', 'thinking', 'running_tool', 'waiting_for_permission', 'interrupting']);
export const parseMemberNames = (value: string) => [...new Set(value.split(/[\n,，]/).map(item => item.trim()).filter(Boolean))];

/**
 * 一条任务对用户呈现的**有效状态**：归档优先于运行状态。这是全站唯一的判据。
 *
 * 归档在产品语义上是终态且只读，它必须盖掉 session.state 记下的那个瞬间。
 * 一条在 thinking 时被归档的任务，state 永远停在 'thinking'——谁直接读 state
 * 就会告诉用户「思考中」，还会让圆点一直呼吸，看上去像它仍在跑。
 *
 * 这个函数存在的意义是它只有一份，且**不含任何配色**。「归档优先」「什么算忙」
 * 「什么可恢复」这三条判断曾散在各个展示入口旁边，各自漂移出真实故障：
 *   - 侧栏一行四样东西只有文案判了 archivedAt，归档的失败任务显示成
 *     「已归档」+ 失败红，像归档这个动作本身出错了；
 *   - RunHeader 四处全没判，归档任务的状态条一直播放呼吸动画，下一步提示还在
 *     说「Agent 正在推进」；更严重的是 recoverable 也没判，于是一条已归档的
 *     失败任务显示出可点击的「重新启动」按钮——归档是只读，这是功能缺陷，
 *     不是显示错误。同文件的中断与归档按钮都老实写了 !session.archivedAt，
 *     只有 recoverable 漏了：有人补 guard 时改了两处、漏了第三处，正是
 *     「判断散在调用点旁边」的必然结果。
 *
 * 下次新增任何状态展示入口（第四套色板、移动端摘要、通知文案……），一律从这里
 * 取 label / archived / busy / recoverable，**不要在旁边写 `session.archivedAt ?`**。
 * 要调整归档态的语义，或让别的状态也覆盖运行状态（比如将来加个「已过期」），
 * 只改这个函数。在调用点补条件只是把「N 份不同的判断」变成「N 份相同的判断」，
 * 下次照样各自漂移。
 */
export function effectiveStatus(session: Session): { label: string; archived: boolean; busy: boolean; recoverable: boolean } {
  if (session.archivedAt) return { label: '已归档', archived: true, busy: false, recoverable: false };
  return {
    label: stateLabels[session.state] ?? session.state,
    archived: false,
    busy: busyStates.has(session.state),
    recoverable: session.state === 'failed' || session.state === 'stopped'
  };
}

/**
 * 侧栏一行的状态视觉：文案、文字色、圆点色、圆点是否呼吸。
 *
 * 只负责把 effectiveStatus 的语义映射到侧栏的深色 --sidebar-* 色板，自己不再判
 * archivedAt，也不再判什么算忙。改配色改这里，改语义改 effectiveStatus。
 */
export function sidebarStatusVisual(session: Session): { label: string; textClass: string; dotClass: string; pulse: boolean } {
  const status = effectiveStatus(session);
  if (status.archived) return { label: status.label, textClass: 'text-sidebar-text-muted', dotClass: 'bg-neutral-solid', pulse: false };
  return {
    label: status.label,
    textClass: session.state === 'failed' ? 'text-danger' : session.state === 'waiting_for_permission' ? 'text-warning' : 'text-sidebar-text-muted',
    dotClass: stateTone[session.state] ?? 'bg-neutral-solid',
    pulse: status.busy
  };
}

/**
 * 「创建任务」按钮的文案与去向。
 *
 * 「有没有可用 Agent」曾在四个入口各写一遍三元表达式，其中两个没有考虑
 * agents 还在加载：首屏 agents.data 未到时 agents 为空数组，按钮会显示
 * 「准备 Agent」并把人送去设置页——与 commit 4d9b8c4 修掉的 n 键 bug 同源，
 * 只是发生在渲染层。加载中一律先禁用，不猜。
 */
export function createTaskAffordance({ agents, agentsLoading = false, onCreate, onPrepareAgents }: {
  agents: Agent[];
  agentsLoading?: boolean;
  onCreate(): void;
  onPrepareAgents(): void;
}): { label: string; disabled: boolean; onClick(): void } {
  if (agentsLoading) return { label: '正在检测 Agent…', disabled: true, onClick: () => {} };
  if (!agents.length) return { label: '准备 Agent', disabled: false, onClick: onPrepareAgents };
  return { label: '创建任务', disabled: false, onClick: onCreate };
}

/**
 * 任务详情工具栏里打开浮层的按钮（目标与步骤、工作目录与验证）。
 * 窄屏只留图标，完整文案在 aria-label / title 里，所以自带 min-w-10 守住触控宽度。
 */
export function ToolbarButton({ label, icon, onClick }: { label: string; icon: ReactNode; onClick(): void }) {
  return <button type="button" aria-label={label} title={label} onClick={onClick} className="flex min-h-10 min-w-10 shrink-0 items-center justify-center gap-1.5 rounded-md px-2.5 text-caption font-medium text-secondary transition-colors duration-fast ease-out hover:bg-hover hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring">{icon}<span className="hidden sm:inline">{label}</span></button>;
}

export function DutydeckIcon({ className = '' }: { className?: string }) {
  return <img src="/dutydeck.svg" alt="" aria-hidden="true" className={className}/>;
}
