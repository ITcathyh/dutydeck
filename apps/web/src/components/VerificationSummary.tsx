import { useQuery } from '@tanstack/react-query';
import { api, type Session } from '../api';
import { Button } from './primitives';
import { verificationLabel } from './verification-presentation';

export function VerificationSummary({ session, onOpenEvidence }: { session: Session; onOpenEvidence(): void }) {
  const capabilities = useQuery({ queryKey: ['sessionCapabilities', session.id], queryFn: () => api.sessionCapabilities(session.id) });
  const evidence = useQuery({ queryKey: ['verifications', session.id], queryFn: () => api.verifications(session.id), refetchInterval: 5_000 });
  const latest = evidence.data?.[0];
  const unavailable = capabilities.data?.verification === 'unavailable';
  const label = evidence.isLoading ? '正在读取验证状态'
    : evidence.isError ? '验证状态读取失败'
    : latest ? verificationLabel(latest)
    : unavailable ? '平台验证不可用'
    : capabilities.isLoading ? '正在读取验证能力'
    : capabilities.isError ? '验证能力读取失败'
    : capabilities.data?.verification !== 'available' ? '平台验证能力尚未确认'
    : '尚未验证';
  return <aside aria-label="平台验证" className="my-3 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-muted px-4 py-2">
    <div className="min-w-0 text-caption text-secondary"><p role="status">{label}</p>
      {latest && unavailable && <p>平台验证当前不可用，以上为已有记录。</p>}
      {latest && evidence.isError && <p>上次读取：{verificationLabel(latest)}</p>}
      <p className="text-subtle">平台命令验证独立于 Agent 的完成状态。</p>
    </div>
    <Button variant="ghost" onClick={onOpenEvidence}>查看验证证据</Button>
  </aside>;
}
