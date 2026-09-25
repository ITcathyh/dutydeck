import { useLayoutEffect, useRef, useState } from 'react';
import type { TimelineEvent } from '../timeline';
import { MarkdownContent } from '../MarkdownContent';
import { Banner } from './primitives';
import { ToolCard } from './ToolCard';
import { PermissionCard } from './PermissionCard';

/*
  用户气泡取 rounded-lg：单行实测 46px（py-3 上下 24 + text-body 行高 22），
  按契约 §3 的「半径 ≈ 高度 / 3.5」理论值 13.1px，最贴近 lg（14px）。
  rounded-br-sm 保留：右下角收窄是「这句话出自你」的方向感，不是尺度取档。

  底色用 action-soft 而不是 inverse：inverse 在浅色下是深藏青整块，深色主题下反成亮块，
  两种主题里都是全屏最重的元素，压过了 Agent 的回答。

  飞书转来的指令常有十几行，超过 max-h-40 时先折叠，末尾渐隐并给「展开全文」。
  jsdom 里 scrollHeight 恒为 0，所以测试环境永远不折叠，不影响按文本查找。
*/
function UserMessage({ text, steered = false }: { text: string; steered?: boolean }) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (body) setOverflowing(body.scrollHeight > body.clientHeight + 1);
  }, [text]);
  const collapsed = overflowing && !expanded;
  return <div className="ui-timeline-item my-6 flex justify-end"><div className="max-w-[84%] rounded-lg rounded-br-sm border border-action-soft-hover bg-action-soft px-4 py-3 text-body text-primary sm:max-w-[78%]">
    {steered && <div className="mb-1 text-caption text-subtle">插话到当前这一轮</div>}
    <div ref={bodyRef} className={expanded ? undefined : `max-h-40 overflow-hidden ${collapsed ? 'ui-fade-bottom' : ''}`}><MarkdownContent>{text}</MarkdownContent></div>
    {overflowing && <button type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)} className="mt-1 min-h-8 text-caption font-medium text-link hover:underline">{expanded ? '收起' : '展开全文'}</button>}
  </div></div>;
}

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
  if (user) return <UserMessage text={event.data.text ?? ''} steered={Boolean(event.data.steering)}/>;
  if (final) return <article aria-label={`${assistantLabel} 最终输出`} className="assistant-output markdown ui-timeline-item my-4 max-w-[78ch] text-body text-primary"><MarkdownContent>{event.data.text ?? ''}</MarkdownContent></article>;
  return <article className="assistant-output markdown ui-timeline-item my-5 max-w-[78ch] text-body text-primary"><MarkdownContent>{event.data.text ?? ''}</MarkdownContent></article>;
}
