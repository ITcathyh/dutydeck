import { useState, type ReactNode } from 'react';

export function OptionalModelOverrides({ initiallyExpanded, children }: { initiallyExpanded: boolean; children: ReactNode }) {
  const [expanded, setExpanded] = useState(initiallyExpanded);
  return <details open={expanded} onToggle={event => setExpanded(event.currentTarget.open)} className="space-y-3 rounded-md border border-subtle p-3">
    <summary className="cursor-pointer text-caption font-medium text-secondary"><span>可选：分别设置群判定和回复模型</span><span className="ml-2 font-normal text-subtle">留空沿用原有模型</span></summary>
    <p className="text-caption text-subtle">不设置时沿用原有模型：优先记忆模型，再使用默认模型。展开此处不会更改配置。</p>
    {children}
  </details>;
}
