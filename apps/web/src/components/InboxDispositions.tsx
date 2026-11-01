import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { Card } from './primitives';
export function InboxDispositions({ appId }: { appId: string }) {
  const [since, setSince] = useState('24h');
  const query = useQuery({ queryKey: ['inbox-dispositions', appId, since], queryFn: () => api.larkInbox(appId, since) });
  return <Card padding="lg"><h3>最近没处理的消息</h3><select aria-label="消息时间范围" value={since} onChange={event => setSince(event.target.value)}>
    <option value="24h">最近 24 小时</option><option value="7d">最近 7 天</option><option value="30d">最近 30 天</option>
  </select>{query.isError ? <p>读取消息失败</p> : query.isPending ? <p>正在读取</p> : !query.data.length ? <p>没有未处理的消息</p> : <ul>{query.data.map(row => <li key={row.messageId}>
    <time>{row.receivedAt}</time> · {row.sender} · {row.snippet}<p>{row.detail}（{row.reason ?? '未记录'}）{row.mergedInto && ` · 合并到 ${row.mergedInto}`}{row.decisionId && ` · 判断 ${row.decisionId}`}</p>
  </li>)}</ul>}</Card>;
}
