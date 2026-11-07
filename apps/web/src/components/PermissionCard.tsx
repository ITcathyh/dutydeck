import { useEffect, useMemo, useRef, useState } from 'react';
import { permissionDisplayText, permissionRejectReasonHint, permissionRejectReasonMaxLength, type PermissionRequestData } from '@dutydeck/shared';
import { Check, MessageSquareX, ShieldAlert, TriangleAlert, X } from 'lucide-react';
import type { TimelineEvent } from '../timeline';
import { hasRisk, riskSegments } from '../permission-risk';
import { Button } from './primitives';

const resolvedLabels: Record<string, string> = { approved: '已允许', rejected: '已拒绝', cancelled: '已取消', expired: '已失效' };

export function PermissionCard({ event, resolving = false, onResolve }: { event: TimelineEvent; resolving?: boolean; onResolve?(permissionId: string, approved: boolean, reason?: string): void | Promise<unknown> }) {
  const permissionId = String(event.data.id ?? event.id);
  const pending = event.data.status === 'pending';
  const submitted = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const [explaining, setExplaining] = useState(false);
  const [reason, setReason] = useState('');
  const wasResolving = useRef(resolving);
  useEffect(() => {
    if (!pending || wasResolving.current && !resolving) {
      submitted.current = false;
      setSubmitting(false);
    }
    wasResolving.current = resolving;
  }, [pending, resolving]);
  useEffect(() => { submitted.current = false; setSubmitting(false); setExplaining(false); setReason(''); }, [permissionId]);
  const decide = (approved: boolean, why?: string) => {
    if (submitted.current || resolving || !pending) return;
    submitted.current = true;
    setSubmitting(true);
    const result = why ? onResolve?.(permissionId, approved, why) : onResolve?.(permissionId, approved);
    if (result) void result.then(() => {}, () => {
      submitted.current = false;
      setSubmitting(false);
    });
  };
  const processing = resolving || submitting;
  const operation = (event.data as PermissionRequestData).operation;
  const command = operation?.source === 'acp_tool_call' && operation.command ? permissionDisplayText(operation.command) : '';
  const segments = useMemo(() => riskSegments(command), [command]);
  const risky = hasRisk(segments);
  const [riskAcknowledged, setRiskAcknowledged] = useState(false);
  useEffect(() => setRiskAcknowledged(false), [permissionId, command]);
  const rejectedReason = event.data.status === 'rejected' ? permissionDisplayText(event.data.reason, [], 300) : '';
  // 飞书审批卡上的工作区规则代为批准时，审批记录带着命中的规则。
  const workspaceRule = event.data.status === 'approved' ? permissionDisplayText(event.data.workspaceRule, [], 300) : '';
  const actionable = pending && Boolean(onResolve);
  // 外壳是契约 §5 白名单第 5 类：状态语义色外圈。待处理时琥珀色眉栏表达「在等你」，处理完退成中性卡片。
  return <aside aria-label="权限审批" className={`ui-timeline-item my-4 overflow-hidden rounded-lg border bg-surface shadow-card ${pending ? 'border-warning-border' : 'border-default'}`}>
    <div className={`flex min-h-9 items-center gap-2 px-4 text-caption font-semibold ${pending ? 'bg-warning-soft text-warning' : 'bg-muted text-secondary'}`}><ShieldAlert size={14} aria-hidden="true"/><span>需要操作授权</span></div>
    <div className="px-4 pb-3.5 pt-3">
      <p className="text-body font-medium leading-6 text-primary">{permissionDisplayText(event.data.title) || 'Agent 请求执行受控操作'}</p>
      {operation?.source === 'acp_tool_call' ? <>
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-caption text-secondary">
          <p>来源：执行端工具请求</p>
          {operation.cwd && <p className="break-all">目录：{permissionDisplayText(operation.cwd)}</p>}
          {operation.resource && <p className="break-all">资源：{permissionDisplayText(operation.resource)}</p>}
        </div>
        {command && <figure className="mt-2.5 overflow-hidden rounded-md border border-subtle bg-muted">
          <figcaption className="px-3 pt-2 text-meta text-subtle">命令（已脱敏）</figcaption>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all px-3 pb-2.5 pt-1 font-mono text-caption leading-5 text-primary"><code>{segments.map((segment, index) => segment.risky
            ? <mark key={index} className="rounded-sm bg-danger-soft px-0.5 font-semibold text-danger">{segment.text}</mark>
            : segment.text)}</code></pre>
        </figure>}
        {risky && <p className="mt-2 flex items-start gap-1.5 text-caption text-danger"><TriangleAlert size={14} aria-hidden="true" className="mt-0.5 shrink-0"/><span>命令里有可能造成破坏的片段（已标出）。这只是界面提醒，请自己核对后再决定。</span></p>}
      </> : <p className="mt-2 text-caption text-subtle">执行端未提供详细操作。</p>}
      <p className="mt-2 text-caption text-subtle">本次选择只处理这一条请求，不改变后续授权方式。</p>
      {actionable && risky && <label className="mt-2.5 flex min-h-11 cursor-pointer md:min-h-10 items-center gap-2 text-body text-primary">
        <input type="checkbox" checked={riskAcknowledged} disabled={processing} onChange={event => setRiskAcknowledged(event.target.checked)} className="h-4 w-4 accent-action"/>
        我已核对标出的片段
      </label>}
      {actionable ? <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button variant="primary" loading={processing} disabled={risky && !riskAcknowledged} onClick={() => decide(true)} icon={<Check size={14}/>}>允许本次</Button>
        <Button variant="secondary" disabled={processing} onClick={() => decide(false)} icon={<X size={14}/>}>拒绝</Button>
        <Button variant="ghost" disabled={processing} aria-expanded={explaining} onClick={() => setExplaining(open => !open)} icon={<MessageSquareX size={14}/>}>拒绝并说明</Button>
      </div> : <div className="mt-2 text-caption font-medium text-secondary">{pending ? '等待当前操作者处理' : workspaceRule ? `按工作区规则自动允许：${workspaceRule}` : `${resolvedLabels[event.data.status] ?? event.data.status ?? '已处理'}${rejectedReason ? `：${rejectedReason}` : ''}`}</div>}
      {actionable && explaining && <div className="mt-2">
        <textarea aria-label="拒绝原因" value={reason} maxLength={permissionRejectReasonMaxLength} disabled={processing} onChange={event => setReason(event.target.value)} placeholder={permissionRejectReasonHint}
          className="min-h-16 w-full resize-y rounded-md border border-default bg-surface px-2.5 py-2 text-body text-primary outline-none placeholder:text-subtle focus-visible:ring-2 focus-visible:ring-focus-ring"/>
        <div className="mt-1.5"><Button variant="secondary" loading={processing} disabled={!reason.trim()} onClick={() => decide(false, reason.trim())} icon={<X size={14}/>}>提交拒绝</Button></div>
      </div>}
      {pending && processing && <p role="status" className="mt-2 text-caption text-secondary">正在提交本次决定，等待服务端确认。</p>}
    </div>
  </aside>;
}
