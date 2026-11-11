import { useEffect } from 'react';
import { onlineManager, useQuery, useQueryClient } from '@tanstack/react-query';
import type { HistoryTurnSummary } from './api';
import { loadTurnHistory } from './event-history';

/** Only completed, server-backed turn details use this cache; live events keep their own lifetime. */
export function useHistoryDetail(sessionId: string, summary: HistoryTurnSummary | undefined, enabled: boolean) {
  const client = useQueryClient();
  const reading = enabled && Boolean(summary);
  const first = summary?.firstSequence, last = summary?.lastSequence;
  const query = useQuery({
    queryKey: reading ? ['history-detail', sessionId, first, last] : ['history-detail-closed'],
    queryFn: ({ signal }) => loadTurnHistory(sessionId, summary!, signal),
    enabled: reading,
    staleTime: Infinity,
    // Offline details may be the only available copy. Explicitly release online cold details below.
    gcTime: reading ? Infinity : 0
  });

  useEffect(() => {
    let disposed = false;
    const release = () => {
      if (!onlineManager.isOnline()) return;
      for (const detail of client.getQueryCache().findAll({ queryKey: ['history-detail'] })) {
        if (detail.getObserversCount() === 0) client.removeQueries({ queryKey: detail.queryKey, exact: true });
      }
    };
    const unsubscribe = onlineManager.subscribe(online => {
      if (!online) return;
      release();
      if (disposed) unsubscribe();
    });
    // useQuery detaches the old observer when its key changes. Run after that cleanup,
    // including on unmount; removeQueries cancels the query so late responses cannot restore it.
    queueMicrotask(release);
    return () => {
      disposed = true;
      queueMicrotask(() => {
        release();
        // Leaving the page offline must not leave the retained copy resident forever.
        if (onlineManager.isOnline()) unsubscribe();
      });
    };
  }, [client, reading, sessionId, first, last]);

  return query;
}
