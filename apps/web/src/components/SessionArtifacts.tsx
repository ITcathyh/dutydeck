import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { Banner, Button, Spinner } from './primitives';

export function SessionArtifacts({ sessionId }: { sessionId: string }) {
  const history = useQuery({ queryKey: ['history-outline', sessionId], queryFn: ({ signal }) => api.sessionHistory(sessionId, signal), refetchInterval: 10_000 });
  const turns = history.data?.turns.filter(turn => turn.artifactReferences.length) ?? [];
  return <section className="space-y-2" aria-label="每轮产物引用">
    <h3 className="text-body font-semibold">每轮产物引用</h3>
    <p className="text-caption text-secondary">从成功工具结果或 Agent 的结构化附件记录引用。引用对应当时的记录，不证明路径当前内容相同，也不授予下载权限。</p>
    {history.isPending && <Spinner label="读取产物引用"/>}
    {history.error && <Banner tone="danger">产物引用读取失败：{history.error.message}</Banner>}
    {!history.isPending && !history.error && !turns.length && <p className="text-caption text-subtle">尚无已记录的结构化产物；普通文本中的文件名不作为交付证据。</p>}
    {[...turns].reverse().map(turn => <details key={turn.id} className="rounded-lg border border-default p-3">
      <summary className="cursor-pointer text-caption">{turn.prompt.text || '这一轮'} · {turn.artifactReferences.length} 项</summary>
      {turn.artifactReferencesTruncated && <p className="mt-2 text-caption text-warning">这里只列出部分产物引用；查看来源记录可读取这一轮的完整事件。</p>}
      {turn.artifactReferences.map(ref => <div key={`${ref.eventId}:${ref.partIndex}`} className="mt-3 space-y-1 break-all text-caption">
        <p className="font-medium text-primary">{ref.name || ref.uri || '内嵌图片'} · {ref.status === 'delivered' ? '交付回执已确认' : '已记录引用'}</p>
        {ref.name && ref.uri && <p className="font-mono text-subtle">{ref.uri}</p>}
        <p className="text-secondary">{ref.source === 'structured_tool_result' ? '成功工具结果' : ref.source === 'assistant_attachment' ? 'Agent 附件' : '附件交付回执'}{ref.mimeType ? ` · ${ref.mimeType}` : ''}</p>
        <p className="font-mono text-subtle">轮次 {ref.taskId} · 尝试 {ref.attemptId}<br/>记录 #{ref.sequence} · 版本 {ref.revision}</p>
        <Button variant="ghost" onClick={() => window.dispatchEvent(new CustomEvent('dutydeck:show-history-turn', { detail: { taskId: ref.taskId, attemptId: ref.attemptId, eventId: ref.eventId, sequence: ref.sequence } }))}>查看来源记录</Button>
      </div>)}
    </details>)}
  </section>;
}
