import type { TimelineEvent } from '../timeline';
import { MarkdownContent } from '../MarkdownContent';
import { Banner } from './primitives';
import { ToolCard } from './ToolCard';
import { PermissionCard } from './PermissionCard';

export function TimelineItem({ event, final = false, assistantLabel = 'Agent', onResolvePermission, resolvingPermissionId }: { event: TimelineEvent; final?: boolean; assistantLabel?: string; onResolvePermission?(permissionId: string, approved: boolean): void; resolvingPermissionId?: string }) {
  if (event.type === 'tool_call' || event.type === 'tool_result') return <ToolCard event={event}/>;
  if (event.type === 'permission_request') return <PermissionCard event={event} onResolve={onResolvePermission} resolving={resolvingPermissionId === String(event.data.id ?? event.id)}/>;
  // warning / error 横幅收敛到 Banner 原语：tone 决定配色，role 由 Banner 按语义分流
  // （warning → status 不打断朗读，danger → alert 立刻打断），两者不会混。
  if (event.type === 'warning') return <div className="ui-timeline-item my-4">
    <Banner tone="warning" title={event.data.warningKind === 'skill' ? 'Skill 提示' : 'Agent 警告'}>
      <MarkdownContent>{event.data.text ?? ''}</MarkdownContent>
    </Banner>
  </div>;
  if (event.type === 'error') return <div className="ui-timeline-item my-4">
    <Banner tone="danger" title="Agent 错误">
      <MarkdownContent>{event.data.message ?? 'Agent 运行失败'}</MarkdownContent>
    </Banner>
  </div>;
  // 思考内容归 ActivityPanel 折叠区，不在主时间线重复出现。
  if (event.type === 'thinking') return null;
  const user = event.data.role === 'user';
  /*
    用户气泡取 rounded-lg：单行实测 46px（py-3 上下 24 + text-body 行高 22），
    按契约 §3 的「半径 ≈ 高度 / 3.5」理论值 13.1px，最贴近 lg（14px）。
    此前是 rounded-xl（20px），偏离 6.9px——60 组圆角实测里唯一的真实错档（见 §16）。
    rounded-br-sm 保留：右下角收窄是「这句话出自你」的方向感，不是尺度取档。
  */
  if (user) return <div className="ui-timeline-item my-6 flex justify-end"><div className="max-w-[84%] rounded-lg rounded-br-sm bg-inverse px-4 py-3 text-body text-on-inverse shadow-card sm:max-w-[78%]"><MarkdownContent>{event.data.text ?? ''}</MarkdownContent></div></div>;
  if (final) return <article aria-label={`${assistantLabel} 最终输出`} className="assistant-output markdown ui-timeline-item my-4 max-w-[78ch] text-body text-primary"><MarkdownContent>{event.data.text ?? ''}</MarkdownContent></article>;
  return <article className="assistant-output markdown ui-timeline-item my-5 max-w-[78ch] text-body text-primary"><MarkdownContent>{event.data.text ?? ''}</MarkdownContent></article>;
}
