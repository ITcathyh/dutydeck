import { Fragment, useEffect, useId, useMemo, useState } from 'react';
import { inboxKindLabels } from '@dutydeck/shared';
import type { InboxAction, InboxItem } from '../api';
import {
  formatWaiting, inboxBatchActions, inboxKindCounts, isInboxSelectable, runInboxAction, runInboxBatch, type InboxResult
} from '../inbox-model';
import { permissionRejectReasonHint } from './PermissionCard';
import { Badge, Banner, Button, Card, Skeleton } from './primitives';

type InboxPanelProps = {
  items: InboxItem[];
  loading: boolean;
  failed?: boolean;
  onRetry?(): void;
  /** 原样调用条目上的现有接口。 */
  call(action: InboxAction): Promise<unknown>;
  /** 跳到条目所属会话。 */
  onOpen(sessionId: string): void;
  /** 有动作执行过之后让上层重新读取（条目是否仍有效以服务端为准）。 */
  onSettled?(): void;
};

const PREVIEW = 8;
const toneOf = (action: Pick<InboxAction, 'tone'>) => action.tone === 'danger' ? 'danger' as const : action.tone === 'primary' ? 'primary' as const : 'secondary' as const;

function ResultText({ result }: { result: InboxResult }) {
  if (result.state === 'running') return <span className="text-caption text-secondary">处理中…</span>;
  if (result.state === 'ok') return <span className="text-caption font-medium text-success">已处理</span>;
  if (result.state === 'stale') return <span className="text-caption font-medium text-warning" title={result.message}>已失效：{result.message}</span>;
  return <span className="text-caption font-medium text-danger" title={result.message}>失败：{result.message}</span>;
}

export function InboxPanel({ items, loading, failed = false, onRetry, call, onOpen, onSettled }: InboxPanelProps) {
  const [results, setResults] = useState<Record<string, InboxResult>>({});
  const [selected, setSelected] = useState<string[]>([]);
  const [pendingBatch, setPendingBatch] = useState<{ id: InboxAction['id']; label: string }>();
  const [summary, setSummary] = useState<string>();
  const [expanded, setExpanded] = useState(false);
  const [batching, setBatching] = useState(false);
  /** 正在填拒绝原因的条目；同一时间只展开一条。 */
  const [explaining, setExplaining] = useState<{ itemId: string; reason: string }>();
  const reasonIdPrefix = useId();

  // 条目消失（已处理或已失效）后，把它从选择与结果里清掉。
  useEffect(() => {
    const live = new Set(items.map(item => item.id));
    setSelected(current => current.filter(id => live.has(id)));
    setResults(current => Object.fromEntries(Object.entries(current).filter(([id, result]) => live.has(id) || result.state === 'running')));
  }, [items]);

  const selectedItems = useMemo(() => items.filter(item => selected.includes(item.id)), [items, selected]);
  const batchActions = inboxBatchActions(selectedItems);
  const mixed = selectedItems.length > 1 && batchActions.length === 0;
  const visible = expanded ? items : items.slice(0, PREVIEW);
  const setResult = (id: string, result: InboxResult) => setResults(current => ({ ...current, [id]: result }));

  const runOne = async (item: InboxItem, action: InboxAction) => {
    setResult(item.id, { state: 'running' });
    const result = await runInboxAction(action, call);
    setResult(item.id, result);
    if (result.state !== 'failed') setExplaining(current => current?.itemId === item.id ? undefined : current);
    onSettled?.();
  };
  const runBatch = async () => {
    if (!pendingBatch) return;
    const targets = selectedItems; const action = pendingBatch;
    setPendingBatch(undefined); setBatching(true); setSummary(undefined);
    const tally = await runInboxBatch(targets, action.id, call, (item, result) => setResult(item.id, result));
    setBatching(false);
    setSelected([]);
    setSummary(`${action.label}：成功 ${tally.ok} 项${tally.stale ? `，已失效 ${tally.stale} 项` : ''}${tally.failed ? `，失败 ${tally.failed} 项` : ''}。`);
    onSettled?.();
  };
  const toggle = (id: string) => { setSummary(undefined); setPendingBatch(undefined); setSelected(current => current.includes(id) ? current.filter(value => value !== id) : [...current, id]); };

  if (!failed && !loading && items.length === 0) return null;

  return <section aria-label="待你决定" className="mb-7">
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-attention-solid"/>
      <h2 className="text-title font-semibold text-primary">待你决定</h2>
      {!loading && !failed && <span className="text-caption tabular-nums text-subtle">{items.length}</span>}
      {!loading && !failed && <span className="text-caption text-secondary">{inboxKindCounts(items).map(({ kind, count }) => `${inboxKindLabels[kind]} ${count}`).join(' · ')}</span>}
    </div>
    {failed && <Banner tone="warning" title="无法读取待处理汇总" action={onRetry ? { label: '重试', onClick: onRetry } : undefined}>下方任务列表仍可使用。</Banner>}
    {loading && !failed && items.length === 0 && <Card><Skeleton variant="block" lines={2}/></Card>}
    {items.length > 0 && <div className="overflow-hidden rounded-lg border border-default bg-surface">
      {selectedItems.length > 0 && <div role="toolbar" aria-label="批量处理" className="flex flex-wrap items-center gap-2 border-b border-default bg-muted px-4 py-2">
        <span className="text-caption text-secondary" role="status">已选 {selectedItems.length} 项</span>
        {pendingBatch
          ? <>
            <span className="text-caption text-primary">确认对 {selectedItems.length} 项执行「{pendingBatch.label}」？</span>
            <Button size="sm" variant={pendingBatch.id === 'reject' || pendingBatch.id === 'cancel' || pendingBatch.id === 'discard' ? 'danger' : 'primary'} disabled={batching} onClick={() => void runBatch()}>确认执行</Button>
            <Button size="sm" variant="ghost" onClick={() => setPendingBatch(undefined)}>返回</Button>
          </>
          : <>
            {batchActions.map(action => <Button key={action.id} size="sm" variant={toneOf(action)} disabled={batching} onClick={() => setPendingBatch({ id: action.id, label: action.label })}>批量{action.label}</Button>)}
            {mixed && <span className="text-caption text-warning">批量处理只支持同一类型，请只选择同类条目。</span>}
            <Button size="sm" variant="ghost" onClick={() => setSelected([])}>清除选择</Button>
          </>}
      </div>}
      {summary && <div role="status" className="border-b border-default bg-muted px-4 py-2 text-caption text-secondary">{summary}</div>}
      {visible.map((item, index) => {
        const result = results[item.id];
        const selectable = isInboxSelectable(item);
        const previous = visible[index - 1];
        const first = previous?.kind !== item.kind;
        const groupIds = items.filter(candidate => candidate.kind === item.kind && isInboxSelectable(candidate)).map(candidate => candidate.id);
        const groupSelected = groupIds.length > 0 && groupIds.every(id => selected.includes(id));
        const busy = result?.state === 'running' || result?.state === 'ok' || batching;
        const reasonAction = item.actions.find(action => action.type === 'api' && action.reasonMaxLength);
        const reasonOpen = reasonAction && explaining?.itemId === item.id;
        const reasonId = `${reasonIdPrefix}-${index}`;
        return <div key={item.id}>
          {first && <div className="flex items-center gap-2 border-t border-default bg-muted px-4 py-1.5 first:border-t-0">
            {groupIds.length > 1 && <label className="flex min-h-8 cursor-pointer items-center gap-2 text-caption text-secondary">
              <input type="checkbox" aria-label={`全选${inboxKindLabels[item.kind]}`} checked={groupSelected} onChange={() => { setSummary(undefined); setPendingBatch(undefined); setSelected(current => groupSelected ? current.filter(id => !groupIds.includes(id)) : [...new Set([...current, ...groupIds])]); }} className="h-4 w-4 accent-action"/>
            </label>}
            <span className="text-caption font-medium text-secondary">{inboxKindLabels[item.kind]}</span>
          </div>}
          <div className="flex items-start gap-3 border-t border-default px-4 py-3 first:border-t-0" data-inbox-kind={item.kind}>
            {selectable
              ? <input type="checkbox" aria-label={`选择：${item.title}`} checked={selected.includes(item.id)} onChange={() => toggle(item.id)} className="mt-1 h-4 w-4 shrink-0 accent-action"/>
              : <span className="w-4 shrink-0" aria-hidden="true"/>}
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2"><Badge tone="warning">{inboxKindLabels[item.kind]}</Badge><strong className="min-w-0 break-words text-body font-medium text-primary">{item.title}</strong></div>
              {item.detail && <p className="mt-1 break-words text-caption text-secondary">{item.detail}</p>}
              <p className="mt-1 text-caption text-subtle">{item.sessionTitle} · {item.workspace} · 已等待 {formatWaiting(item.waitingMs)}{item.revision !== undefined && typeof item.revision === 'number' ? ` · 版本 ${item.revision}` : ''}</p>
              {result && <p className="mt-1" role="status"><ResultText result={result}/></p>}
              {reasonOpen && <div className="mt-2">
                <label htmlFor={reasonId} className="text-caption font-medium text-secondary">拒绝原因</label>
                <textarea id={reasonId} value={explaining.reason} maxLength={reasonAction.reasonMaxLength} disabled={busy} onChange={event => setExplaining({ itemId: item.id, reason: event.target.value })} placeholder={permissionRejectReasonHint}
                  className="mt-1 min-h-16 w-full resize-y rounded-md border border-default bg-surface px-2.5 py-2 text-body text-primary outline-none placeholder:text-subtle focus-visible:ring-2 focus-visible:ring-focus-ring"/>
                <div className="mt-1.5"><Button size="sm" variant="danger" disabled={busy || !explaining.reason.trim()} onClick={() => void runOne(item, { ...reasonAction, body: { ...reasonAction.body, reason: explaining.reason.trim() } })}>提交拒绝</Button></div>
              </div>}
            </div>
            <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
              {item.actions.map(action => action.type === 'lark_card'
                ? <span key={action.id} className="text-caption text-subtle">{action.label}</span>
                : action.type === 'open'
                  ? <Button key={action.id} size="sm" variant="ghost" onClick={() => onOpen(item.sessionId)}>{action.label}</Button>
                  : <Fragment key={action.id}>
                    <Button size="sm" variant={toneOf(action)} disabled={busy} onClick={() => void runOne(item, action)}>{action.label}</Button>
                    {action === reasonAction && <Button size="sm" variant="secondary" disabled={busy} aria-expanded={Boolean(reasonOpen)} aria-controls={reasonOpen ? reasonId : undefined} onClick={() => setExplaining(reasonOpen ? undefined : { itemId: item.id, reason: '' })}>{action.label}并说明</Button>}
                  </Fragment>)}
            </div>
          </div>
        </div>;
      })}
      {items.length > PREVIEW && <button type="button" onClick={() => setExpanded(value => !value)} className="flex min-h-10 w-full items-center justify-center border-t border-default px-3 py-2 text-caption text-action hover:bg-hover">{expanded ? '收起' : `展开全部 ${items.length} 项`}</button>}
    </div>}
  </section>;
}
