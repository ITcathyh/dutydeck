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
  if (user) return <div className="ui-timeline-item my-6 flex justify-end"><div className="max-w-[84%] rounded-xl rounded-br-sm bg-inverse px-4 py-3 text-body text-on-inverse shadow-card sm:max-w-[78%]"><MarkdownContent>{event.data.text ?? ''}</MarkdownContent></div></div>;
  if (final) return <article aria-label={`${assistantLabel} 最终输出`} className="assistant-output markdown ui-timeline-item my-4 max-w-[78ch] text-body text-primary"><MarkdownContent>{event.data.text ?? ''}</MarkdownContent></article>;
  return <article className="assistant-output markdown ui-timeline-item my-5 max-w-[78ch] text-body text-primary"><MarkdownContent>{event.data.text ?? ''}</MarkdownContent></article>;
}
