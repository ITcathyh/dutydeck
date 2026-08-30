import { Check, LoaderCircle, ShieldAlert, X } from 'lucide-react';
import type { TimelineEvent } from '../timeline';

const resolvedLabels: Record<string, string> = { approved: '已允许', rejected: '已拒绝', cancelled: '已取消', expired: '已失效' };

export function PermissionCard({ event, resolving = false, onResolve }: { event: TimelineEvent; resolving?: boolean; onResolve?(permissionId: string, approved: boolean): void }) {
  const permissionId = String(event.data.id ?? event.id);
  const pending = event.data.status === 'pending';
  return <aside aria-label="权限审批" className="ui-timeline-item my-4 rounded-xl border border-orange-200 bg-orange-50 px-4 py-3.5">
    <div className="flex items-start gap-3"><div className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-orange-100 text-orange-700"><ShieldAlert size={15}/></div><div className="min-w-0 flex-1"><div className="text-sm font-semibold text-zinc-900">需要操作授权</div><p className="mt-1 text-sm leading-6 text-zinc-700">{event.data.title || event.data.description || 'Agent 请求执行受控操作'}</p>
      {pending && onResolve ? <div className="mt-3 flex items-center gap-2"><button type="button" disabled={resolving} onClick={() => onResolve(permissionId, true)} className="flex h-8 items-center gap-1.5 rounded-lg bg-slate-900 px-3 text-[11px] font-semibold text-white hover:bg-slate-700 disabled:opacity-50">{resolving ? <LoaderCircle size={12} className="animate-spin"/> : <Check size={12}/>}允许</button><button type="button" disabled={resolving} onClick={() => onResolve(permissionId, false)} className="flex h-8 items-center gap-1.5 rounded-lg border border-orange-300 bg-white px-3 text-[11px] font-semibold text-orange-800 hover:bg-orange-100 disabled:opacity-50"><X size={12}/>拒绝</button></div> : <div className="mt-2 text-xs font-medium text-zinc-500">{pending ? '等待当前操作者处理' : resolvedLabels[event.data.status] ?? event.data.status ?? '已处理'}</div>}
    </div></div>
  </aside>;
}
