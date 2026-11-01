import { useEffect, useState } from 'react';
import { api, type MatterDetail } from '../api';
import { Button, Dialog, StatusBadge } from './primitives';

export function MatterDetails({ id, onClose, onSelect }: { id: string; onClose(): void; onSelect(id: string): void }) {
  const [matter, setMatter] = useState<MatterDetail>();
  const [error, setError] = useState(false);
  useEffect(() => { let active = true; void api.matter(id).then(value => { if (active) setMatter(value); }, () => { if (active) setError(true); }); return () => { active = false; }; }, [id]);
  return <Dialog open onClose={onClose} label="事项详情">
    <Dialog.Header><h2 className="text-title font-semibold">{matter?.title ?? '事项详情'}</h2><Button variant="ghost" onClick={onClose}>关闭</Button></Dialog.Header>
    <Dialog.Body>
      {!matter ? <p>{error ? '事项读取失败，请关闭后重试。' : '正在读取事项…'}</p> : <div className="space-y-4">
        <p>状态：{({ open: '进行中', done: '已完成', cancelled: '已取消' })[matter.status]}</p>
        <section><h3 className="font-medium">关联会话</h3>{matter.sessions.map(session => <div key={session.id} className="flex items-center gap-2 py-2"><StatusBadge session={session}/><Button variant="ghost" onClick={() => { onClose(); onSelect(session.id); }}>{session.name || session.agentId} · {session.id}</Button></div>)}</section>
        <section><h3 className="font-medium">定时计划</h3>{matter.schedules.length ? matter.schedules.map(schedule => <p key={schedule.id}>{schedule.name} · {schedule.enabled ? '已启用' : '已停用'}</p>) : <p>暂无计划</p>}</section>
        {matter.originUrl && <a href={matter.originUrl} target="_blank" rel="noreferrer" className="text-action">打开来源消息</a>}
      </div>}
    </Dialog.Body>
  </Dialog>;
}
