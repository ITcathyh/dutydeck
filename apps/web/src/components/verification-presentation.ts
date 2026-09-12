import type { VerificationResponse } from '@dutydeck/shared';

const labels = { running: '验证中', passed: '验证通过', failed: '验证失败', timed_out: '验证超时', interrupted: '验证中断', unverified: '验证结论未确认' };

export function verificationLabel(record: VerificationResponse): string {
  const label = labels[record.status] ?? '验证状态未知';
  if (!record.stale || record.status === 'running') return label;
  const reason = record.staleReason === 'code_changed' ? '代码已变化'
    : record.staleReason === 'changed_during_run' ? '验证期间代码已变化'
    : '无法确认当前版本';
  return `${label} · ${reason}`;
}
