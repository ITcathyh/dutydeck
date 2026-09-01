import { Check, ShieldAlert, X } from 'lucide-react';
import type { TimelineEvent } from '../timeline';
import { Button } from './primitives';

const resolvedLabels: Record<string, string> = { approved: '已允许', rejected: '已拒绝', cancelled: '已取消', expired: '已失效' };

export function PermissionCard({ event, resolving = false, onResolve }: { event: TimelineEvent; resolving?: boolean; onResolve?(permissionId: string, approved: boolean): void }) {
  const permissionId = String(event.data.id ?? event.id);
  const pending = event.data.status === 'pending';
  // 外壳是契约 §5 白名单第 5 类：状态语义色软底卡片配同色外圈。高度远超 48px，圆角取 rounded-lg。
  return <aside aria-label="权限审批" className="ui-timeline-item my-4 rounded-lg border border-warning-border bg-warning-soft px-4 py-3.5">
    <div className="flex items-start gap-3"><div className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-md bg-warning-border text-warning"><ShieldAlert size={15}/></div><div className="min-w-0 flex-1"><div className="text-body font-semibold text-primary">需要操作授权</div><p className="mt-1 text-body leading-6 text-secondary">{event.data.title || event.data.description || 'Agent 请求执行受控操作'}</p>
      {/*
        全站风险最高的两个按钮曾是触控目标最小的（h-8 = 32px）。改用 Button 默认 md 档 40px。
        「允许」的 loading 由原语渲染 Spinner 并置 aria-busy，不再手写转圈图标切换。
        「拒绝」需要 warning 语义描边，Button 没有 warning variant（签名冻结），用 className 覆盖。
      */}
      {pending && onResolve ? <div className="mt-3 flex flex-wrap items-center gap-2"><Button variant="secondary" tone="inverse" loading={resolving} onClick={() => onResolve(permissionId, true)} icon={<Check size={14}/>}>允许</Button><Button variant="secondary" disabled={resolving} onClick={() => onResolve(permissionId, false)} icon={<X size={14}/>} className="border-warning-border text-warning hover:bg-warning-soft">拒绝</Button></div> : <div className="mt-2 text-caption font-medium text-subtle">{pending ? '等待当前操作者处理' : resolvedLabels[event.data.status] ?? event.data.status ?? '已处理'}</div>}
    </div></div>
  </aside>;
}
