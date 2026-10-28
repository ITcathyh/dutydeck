import { useState } from 'react';
import { copyToClipboard } from '../MarkdownContent';
import { createRawLogProjector } from '../raw-log';
import type { DockEvent } from '../api';
import { Button } from './primitives';

export function RawHistoryContent({ sessionId, text, events, readComplete, loading, error, retry }: { sessionId: string; text: string; events?: DockEvent[]; readComplete(): Promise<DockEvent[] | undefined>; loading: boolean; error?: string; retry(): void }) {
  const [copied, setCopied] = useState<string>();
  const exportEvents = async () => {
    const snapshot = await readComplete();
    if (!snapshot) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `dutydeck-${sessionId}-events.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  return <div className="flex min-h-0 flex-1 flex-col">
    <div className="flex shrink-0 gap-2 border-b border-code-border p-2">
      <Button size="sm" variant="secondary" disabled={!events || loading} onClick={async () => { const snapshot = await readComplete(); if (snapshot) setCopied(await copyToClipboard(createRawLogProjector()(snapshot)) ? '完整原始日志已复制' : '复制失败，请重试'); }}>复制完整原始日志</Button>
      <Button size="sm" variant="secondary" disabled={!events || loading} onClick={exportEvents}>导出全部事件</Button>
      <Button size="sm" variant="secondary" disabled={loading} onClick={retry}>刷新完整记录</Button>
    </div>
    {copied && <p role="status" className="px-4 text-caption">{copied}</p>}
    {loading ? <p role="status" className="p-4">正在读取完整原始记录…</p> : error ? <p role="alert" className="p-4">原始记录加载失败：{error}<Button size="sm" onClick={retry}>重试</Button></p> : <pre tabIndex={0} aria-label="原始日志内容" className="m-0 flex-1 overflow-auto whitespace-pre-wrap border-0 bg-code-surface p-4 font-mono text-meta leading-5 text-code-header-text">{text || '当前任务暂无原始输出。'}</pre>}
  </div>;
}
