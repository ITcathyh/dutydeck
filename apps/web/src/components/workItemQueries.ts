import { useQuery } from '@tanstack/react-query';
import type { WorkItem } from '@dutydeck/shared';
import { api } from '../api';

export const workStatusLabels: Record<string, string> = { pending: '待执行', preparing: '准备中', accepted: '执行端已接收', running: '执行中', waiting: '等待回答', completed: '已完成', failed: '失败', interrupted: '已中断', skipped: '已跳过', cancelling: '正在取消', cancelled: '已取消', blocked: '需要处理' };

export function useWorkItems(sessionId: string, enabled = true) {
  return useQuery({ queryKey: ['work-items', sessionId], queryFn: () => api.workItems(sessionId), enabled, staleTime: 5_000, refetchInterval: enabled ? 5_000 : false });
}

export function useWorkItemRequests(sessionId: string, item: WorkItem | undefined, enabled = true) {
  const active = enabled && Boolean(item?.steps.some(step => step.status === 'running'));
  return useQuery({ queryKey: ['work-item-requests', sessionId, item?.id], queryFn: () => api.workItemRequests(sessionId, item!.id), enabled: active, staleTime: 5_000, refetchInterval: active ? 5_000 : false });
}
