import type { Agent, RunSummary, Session } from '../api';
import { fallbackRunTitle } from '../run-summary';
import { sidebarStatusVisual } from './ui';

export type SessionRowProps = { session: Session; summary?: RunSummary; agent?: Agent; botName?: string; active: boolean; onClick(): void };

/**
 * 侧栏的一条任务。**它是导航项，不是决策行。**
 *
 * ## 为什么只剩圆点和标题
 *
 * 这一行原先有 7 个信息槽位：状态点、状态词、任务标题、Agent 名、飞书来源、
 * 待执行条数、更新时间、runId。除了标题和圆点，其余 6 项主区的任务行**逐项都有，
 * 而且更完整**（主区还多给工作区名和失败原因）。桌面端 ≥768px 侧栏恒常可见，
 * 于是同一条任务的同一批字段在一屏内横向并排出现两次——实测 18 条任务时，
 * 侧栏 248px 宽塞进 822 个字符，讲的全是右边已经讲过的事。
 *
 * 现在的分工是：**侧栏回答「有哪些任务、我在哪一条」，主区回答「这条任务怎么了」**。
 * 前者只需要认出目标 + 一眼看出是否异常，后者才需要状态词、身份、时间和原因。
 *
 * ## 状态词与身份没有消失，只是不再占视觉宽度
 *
 * 两个 `sr-only` span 把它们留在可访问树里：读屏用户仍然听到「已归档」「失败」和
 * Agent 名，圆点对他们本来就是 aria-hidden 的装饰。规范 §5.3「文本状态徽标，不只是
 * 一个彩色圆点」是对**主区决策行**的要求，§5.3.1 已显式写明不适用于侧栏导航项。
 *
 * 这两个 span 都不能顺手删掉，也不要把它们改回可见文字：
 *
 * · 状态词那个（带 `status.textClass`）——SessionRow.dom.test.tsx 的前 5 条用例读它，
 *   守的是「文案 / 文字色 / 圆点色 / 呼吸动画四样东西出自同一个判断」。那组断言存在的
 *   起因是归档的失败任务曾显示成「已归档」+ 失败红。判断仍然只有一处
 *   （ui.tsx:sidebarStatusVisual → effectiveStatus），这次只是让其中一样不再占像素。
 * · 身份那个——§7.3 禁止把信息只放在 hover tooltip 中。`title` 属性里也有一份，但那是
 *   给鼠标用户的补充，键盘与读屏用户拿不到 hover。后 4 条用例守这件事。
 */
export function SessionRow({ session, summary, agent, botName, active, onClick }: SessionRowProps) {
  // 文案、文字色、圆点色、是否呼吸全部来自同一个判断，见 ui.tsx:sidebarStatusVisual。
  const status = sidebarStatusVisual(session);
  const title = summary?.prompt ?? fallbackRunTitle(session.source);
  /*
    身份不能只靠可见文字。视觉上这行只有标题，但读屏用户需要知道「这是哪条任务、
    它什么状态、属于哪个 Agent」——后两项现在不可见了，所以进下面的 sr-only span，
    并在 title 属性里给鼠标用户备一份。botName 只在飞书来源时才有意义，没有就不提。

    e2e 旅程 6/11 用 `nav.getByRole('button', { name: /ALPHA_MARKER/ })` 按名取行，
    prompt 必须留在可及名里（sr-only 的内容也算），这里靠标题本身满足。
  */
  const identity = session.archivedAt
    ? `${agent?.name ?? session.agentId} · 只读`
    : `${agent?.name ?? session.agentId}${session.source === 'lark' ? ` · ${botName ?? '飞书'}` : ''}`;
  return <button
    onClick={onClick}
    aria-current={active ? 'true' : undefined}
    title={`${title}｜${status.label}｜${identity}`}
    /*
      单行高度 36px（body 22 + py-1.5×2）。触控目标：契约 §9 要求 ≥40px，
      这里刻意用 min-h-10（40px）而不是让内容决定高度——36px 的行在移动抽屉里
      是可点目标，shell.spec.ts:264 那条用例会量它的两个方向。
      40px 落在 §3 的 31–47px 档 → rounded-md（10px）。原先两行 52px 取 rounded-lg，
      行变矮了圆角必须跟着降档，否则 14px 半径在 40px 高的行上会显得过圆。

      选中态的左侧色条仍走 shadow-row-active 这一档（tailwind.config 里单列，
      因为它是「选中」的视觉承载而不是分层阴影）。
    */
    className={`ui-session-row group relative mb-0.5 flex min-h-10 w-full items-center gap-2 rounded-md border px-2.5 text-left transition-[background-color,border-color,box-shadow,transform] duration-fast active:scale-[.99] ${active ? 'border-sidebar-border bg-sidebar-active shadow-row-active' : 'border-transparent hover:border-sidebar-border hover:bg-sidebar-hover'}`}
  >
    <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${status.pulse ? 'ui-status-pulse' : ''} ${status.dotClass}`}/>
    <span className={`min-w-0 flex-1 truncate text-body ${active ? 'font-medium text-sidebar-text-strong' : 'text-sidebar-text'}`}>{title}</span>
    {/*
      状态词留在可访问树，不占视觉宽度。SessionRow.dom.test 的 5 条用例读的就是这个
      span，`status.textClass` 也必须留着——它和圆点色出自同一个判断，删掉文字色就等于
      让那组「四样东西同源」的断言只剩三样可查。
    */}
    <span className={`sr-only ${status.textClass}`}>{status.label}</span>
    {/*
      身份（Agent、飞书来源、只读）同样进可访问树，与状态词分开一个 span 便于读屏断句。
      它不能只待在 title 属性里：§7.3 明文禁止把信息只放在 hover tooltip 中，而这一行
      的 Agent 名视觉上已经撤了。title 属性是鼠标用户的补充，不是唯一载体。
    */}
    <span className="sr-only">{identity}</span>
  </button>;
}
