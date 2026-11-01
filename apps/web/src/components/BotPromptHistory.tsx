import { useId, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, type LarkConfig } from '../api';
import { Banner, Button, Dialog, Select } from './primitives';
import { ConfirmDialog } from './ConfirmDialog';

export function BotPromptHistory({ appId, revision, disabled, onRollback }: {
  appId: string; revision: number; disabled?: boolean; onRollback(data: LarkConfig): void;
}) {
  const historyId = useId();
  const [open, setOpen] = useState(false);
  const [a, setA] = useState(0), [b, setB] = useState(0);
  const [confirm, setConfirm] = useState<number>();
  const history = useQuery({ queryKey: ['bot-prompt-history', appId], queryFn: () => api.botPromptHistory(appId), enabled: open });
  const diff = useQuery({ queryKey: ['bot-prompt-diff', appId, a, b], queryFn: () => api.botPromptDiff(appId, a, b), enabled: open && a > 0 && b > 0 });
  const show = useQuery({ queryKey: ['bot-prompt-show', appId, b], queryFn: () => api.botPromptShow(appId, b), enabled: open && b > 0 });
  const rollback = useMutation({ mutationFn: (version: number) => api.botPromptRollback(appId, version, revision), onSuccess: data => {
    onRollback(data); setConfirm(undefined); setOpen(false); void history.refetch();
  } });
  const versions = history.data?.versions ?? [];
  const sourceLabels = { web: '网页', cli: '命令行', agent: 'Agent', backfill: '回填', rollback: '回退' };
  const error = history.error ?? diff.error ?? show.error;
  return <>
    <Button onClick={() => setOpen(true)}>历史版本</Button>
    <Dialog open={open} onClose={() => { if (!rollback.isPending) setOpen(false); }} label="提示词历史版本" size="lg">
      <Dialog.Body>
        <h3>提示词历史版本</h3>
        {history.isLoading && <p>正在读取…</p>}
        {error && <Banner tone="danger">{error.message}</Banner>}
        {history.isSuccess && !versions.length && <p>暂无历史版本。</p>}
        <ul>{versions.slice().reverse().map(item => <li key={item.version}>
          <span>版本 {item.version}{item.current ? '（当前）' : ''} · {item.savedAt} · {sourceLabels[item.source]} · {item.characters} 字 · {item.sha256.slice(0, 8)}</span>
          <Button onClick={() => setB(item.version)}>查看版本 {item.version}</Button>
          <Button disabled={disabled || rollback.isPending} onClick={() => { rollback.reset(); setConfirm(item.version); }}>回退到版本 {item.version}</Button>
        </li>)}</ul>
        {history.data?.unrecordedUsages?.map(usage => <p key={usage.taskId}>任务 {usage.taskId} · {usage.label}</p>)}
        {disabled && <p>请先保存或放弃当前编辑，再回退版本。</p>}
        <div className="flex gap-2">
          <label htmlFor={historyId + '-a'}>原版本<Select id={historyId + '-a'} aria-label="原版本" value={a || ''} onChange={event => setA(Number(event.target.value))}>
            <option value="">选择版本</option>{versions.map(item => <option key={item.version} value={item.version}>{item.version}</option>)}
          </Select></label>
          <label htmlFor={historyId + '-b'}>对比版本<Select id={historyId + '-b'} aria-label="对比版本" value={b || ''} onChange={event => setB(Number(event.target.value))}>
            <option value="">选择版本</option>{versions.map(item => <option key={item.version} value={item.version}>{item.version}</option>)}
          </Select></label>
        </div>
        {show.data && <pre aria-label="版本全文" className="whitespace-pre-wrap">{show.data.text}</pre>}
        {diff.data && <pre aria-label="版本差异" className="whitespace-pre-wrap">{diff.data.diff}</pre>}
      </Dialog.Body>
      <Dialog.Footer><Button disabled={rollback.isPending} onClick={() => setOpen(false)}>关闭</Button></Dialog.Footer>
    </Dialog>
    <ConfirmDialog open={confirm !== undefined} title="确认回退提示词" description={`将版本 ${confirm ?? ''} 的全文保存为新版本，之后的新轮次会使用它。`}
      confirmLabel="确认回退" busy={rollback.isPending} error={rollback.error?.message}
      onCancel={() => { if (!rollback.isPending) setConfirm(undefined); }} onConfirm={() => { if (confirm !== undefined) rollback.mutate(confirm); }}/>
  </>;
}
