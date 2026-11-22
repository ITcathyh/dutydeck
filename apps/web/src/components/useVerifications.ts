import { verificationsQuery } from '../queries';
import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';

export { RUNNING_VERIFICATION_POLL_MS, IDLE_VERIFICATION_POLL_MS } from '../queries';

/**
 * 会话的验证记录。服务端每次读取都要核对仓库当前的代码指纹（过期提示据此给出），
 * 所以只在有验证正在运行（或本页刚发起验证）时每 5 秒读；其余时间 60 秒一次，
 * 另外在窗口重新获得焦点或页面重新可见时立刻读一次。
 */
export function useVerifications(sessionId: string, options: { active?: boolean } = {}) {
  const active = options.active === true;
  const query = useQuery(verificationsQuery(sessionId, active));
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
