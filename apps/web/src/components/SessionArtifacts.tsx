import { useState } from 'react';
import type { ArtifactSnapshot, EventArtifactReference } from '@dutydeck/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, artifactSnapshotsApi, hasShareToken } from '../api';
import { Banner, Button, Spinner } from './primitives';

function SnapshotCard({ snapshot }: { snapshot: ArtifactSnapshot }) {
  const [open, setOpen] = useState(false);
  const preview = useQuery({ queryKey: ['artifact-preview', snapshot.sessionId, snapshot.id], queryFn: () => artifactSnapshotsApi.preview(snapshot.sessionId, snapshot.id), enabled: open });
  const download = useMutation({ mutationFn: async () => {
    const blob = await artifactSnapshotsApi.download(snapshot.sessionId, snapshot.id);
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a'); link.href = url; link.download = snapshot.name;
    document.body.appendChild(link);
    try { link.click(); } finally { link.remove(); URL.revokeObjectURL(url); }
  } });
  return <article className="space-y-2 rounded border border-default p-3 text-caption" aria-label={`快照 ${snapshot.name}`}>
    <p className="font-medium">{snapshot.name} · {snapshot.size} 字节</p>
    <p className="break-all font-mono text-subtle">SHA-256 {snapshot.sha256}</p>
    <p className="text-secondary">保存时间：{new Date(snapshot.capturedAt).toLocaleString()}。这是点击保存时的内容，不证明原轮次的文件内容。</p>
    <div className="flex gap-2"><Button variant="ghost" onClick={() => setOpen(value => !value)} aria-expanded={open}>查看快照文本</Button><Button variant="ghost" onClick={() => download.mutate()} disabled={download.isPending}>下载已保存快照</Button><SourceButton reference={snapshot}/></div>
    {open && preview.isPending && <Spinner label="读取快照文本"/>}
    {preview.error && <Banner tone="danger">快照读取失败：{preview.error.message}</Banner>}
    {open && preview.data && (preview.data.text !== undefined ? <><pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-3">{preview.data.text}</pre>{preview.data.truncated && <p>仅预览前 16,384 个字符；下载可获取完整快照。</p>}</> : <p>此快照不是 UTF-8 文本，请下载查看。</p>)}
    {download.error && <Banner tone="danger">快照下载失败：{download.error.message}</Banner>}
  </article>;
}
function SourceButton({ reference }: { reference: Pick<EventArtifactReference, 'taskId' | 'attemptId' | 'eventId' | 'sequence'> }) {
  return <Button variant="ghost" onClick={() => window.dispatchEvent(new CustomEvent('dutydeck:show-history-turn', { detail: { taskId: reference.taskId, attemptId: reference.attemptId, eventId: reference.eventId, sequence: reference.sequence } }))}>查看来源记录</Button>;
}

export function SessionArtifacts({ sessionId }: { sessionId: string }) {
  const client = useQueryClient();
  const shared = hasShareToken();
  const snapshots = useQuery({ queryKey: ['artifact-snapshots', sessionId], queryFn: () => artifactSnapshotsApi.list(sessionId), enabled: !shared });
  const capture = useMutation({ mutationFn: (ref: EventArtifactReference) => artifactSnapshotsApi.capture(sessionId, { taskId: ref.taskId, attemptId: ref.attemptId, eventId: ref.eventId, sequence: ref.sequence, partIndex: ref.partIndex, revision: ref.revision }), onSuccess: () => client.invalidateQueries({ queryKey: ['artifact-snapshots', sessionId] }) });
  const history = useQuery({ queryKey: ['history-outline', sessionId], queryFn: ({ signal }) => api.sessionHistory(sessionId, signal), refetchInterval: 10_000 });
  const turns = history.data?.turns.filter(turn => turn.artifactReferences.length) ?? [];
  return <section className="space-y-2" aria-label="每轮产物引用">
    <h3 className="text-body font-semibold">每轮产物引用</h3>
    <p className="text-caption text-secondary">从成功工具结果或 Agent 的结构化附件记录引用。引用对应当时的记录，不证明路径当前内容相同，也不授予下载权限。</p>
    {history.isPending && <Spinner label="读取产物引用"/>}
    {history.error && <Banner tone="danger">产物引用读取失败：{history.error.message}</Banner>}
    {!history.isPending && !history.error && !turns.length && <p className="text-caption text-subtle">尚无已记录的结构化产物；普通文本中的文件名不作为交付证据。</p>}
    {!shared && <p className="text-caption text-secondary">点击“保存当前文件快照”只读取此会话工作目录内当前文件（最多 20 MiB）；保存后内容固定，后续查看和下载仍需会话权限。</p>}
    {capture.error && <Banner tone="danger">快照保存失败：{capture.error.message}</Banner>}
    {[...turns].reverse().map(turn => <details key={turn.id} className="rounded-lg border border-default p-3">
      <summary className="cursor-pointer text-caption">{turn.prompt.text || '这一轮'} · {turn.artifactReferences.length} 项</summary>
      {turn.artifactReferencesTruncated && <p className="mt-2 text-caption text-warning">这里只列出部分产物引用；查看来源记录可读取这一轮的完整事件。</p>}
      {turn.artifactReferences.map(ref => <div key={`${ref.eventId}:${ref.partIndex}`} className="mt-3 space-y-1 break-all text-caption">
        <p className="font-medium text-primary">{ref.name || ref.uri || '内嵌图片'} · {ref.status === 'delivered' ? '交付回执已确认' : '已记录引用'}</p>
        {ref.name && ref.uri && <p className="font-mono text-subtle">{ref.uri}</p>}
        <p className="text-secondary">{ref.source === 'structured_tool_result' ? '成功工具结果' : ref.source === 'assistant_attachment' ? 'Agent 附件' : '附件交付回执'}{ref.mimeType ? ` · ${ref.mimeType}` : ''}</p>
        <p className="font-mono text-subtle">轮次 {ref.taskId} · 尝试 {ref.attemptId}<br/>记录 #{ref.sequence} · 版本 {ref.revision}</p>
        <div className="flex flex-wrap gap-2"><SourceButton reference={ref}/>{!shared && ref.uri && ref.source !== 'attachment_receipt' && (!/^[a-z][a-z0-9+.-]*:/i.test(ref.uri) || ref.uri.startsWith('file:')) && <Button variant="ghost" onClick={() => capture.mutate(ref)} disabled={capture.isPending}>保存当前文件快照</Button>}</div>
      </div>)}
    </details>)}
    {!shared && snapshots.error && <Banner tone="danger">快照列表读取失败：{snapshots.error.message}</Banner>}
    {!shared && Boolean(snapshots.data?.snapshots.length) && <section aria-label="已保存产物快照" className="space-y-2"><h4 className="text-body font-semibold">已保存产物快照</h4>{snapshots.data?.snapshots.map(snapshot => <SnapshotCard key={snapshot.id} snapshot={snapshot}/>)}</section>}
  </section>;
}
