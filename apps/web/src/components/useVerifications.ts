import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';

/** 有验证正在运行时跟进进度的轮询间隔。 */
export const RUNNING_VERIFICATION_POLL_MS = 5_000;
/** 没有运行中的验证时的低频刷新：仓库变了，「代码已变化」最多晚这么久出现。 */
export const IDLE_VERIFICATION_POLL_MS = 60_000;

/**
 * 会话的验证记录。服务端每次读取都要核对仓库当前的代码指纹（过期提示据此给出），
 * 所以只在有验证正在运行（或本页刚发起验证）时每 5 秒读；其余时间 60 秒一次，
 * 另外在窗口重新获得焦点或页面重新可见时立刻读一次。
 */
export function useVerifications(sessionId: string, options: { active?: boolean } = {}) {
  const active = options.active === true;
  const query = useQuery({
    queryKey: ['verifications', sessionId],
    queryFn: () => api.verifications(sessionId),
    refetchInterval: current => active || current.state.data?.some(record => record.status === 'running')
      ? RUNNING_VERIFICATION_POLL_MS : IDLE_VERIFICATION_POLL_MS,
    // 焦点与可见性在下面自己处理：React Query 只听 visibilitychange，在两个都可见的窗口间切换时不会刷新。
    refetchOnWindowFocus: false
  });
  const { refetch } = query;
  useEffect(() => {
    // 已在读取中就不再重开一次（cancelRefetch: false），焦点和可见性同时触发时只读一次。
    const refresh = () => { if (document.visibilityState === 'visible') void refetch({ cancelRefetch: false }); };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [refetch]);
  return query;
}
