import { Square } from 'lucide-react';
import type { TimelineEvent } from '../timeline';

export function PermissionCard({ event }: { event: TimelineEvent }) {
  return <div className="ui-timeline-item my-4 rounded-xl border border-orange-200 bg-orange-50 px-4 py-3.5">
    <div className="flex items-start gap-3"><div className="mt-0.5 grid h-7 w-7 place-items-center rounded-lg bg-orange-100 text-orange-700"><Square size={13}/></div><div className="min-w-0 flex-1"><div className="text-sm font-semibold text-zinc-900">操作已拦截</div><p className="mt-1 text-sm leading-6 text-zinc-600">{event.data.title}</p>
      <div className="mt-2 text-xs font-medium text-zinc-500">{event.data.status === 'pending' ? '历史授权请求已失效；当前版本固定使用完全访问' : event.data.status}</div>
    </div></div>
  </div>;
}
