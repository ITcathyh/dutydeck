import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import { EVENT_PAGE_SIZE, loadEventHistory, mergeReconciledEvents, type EventWindow } from './event-history';

export function useEventHistory(sessionId: string | undefined, enabled: boolean) {
  const qc = useQueryClient();
  const request = useRef<AbortController | undefined>(undefined);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState<string>();
  useEffect(() => { setLoadingOlder(false); setOlderError(undefined); return () => { request.current?.abort(); request.current = undefined; }; }, [sessionId]);
  const query = useQuery({ queryKey: ['events', sessionId], queryFn: async ({ signal }) => {
    const tail = await loadEventHistory(sessionId!, signal);
    const cached = qc.getQueryData<EventWindow>(['events', sessionId]);
    return cached ? mergeReconciledEvents(cached, tail.events) : tail;
  }, enabled: enabled && Boolean(sessionId), staleTime: Infinity, structuralSharing: false });
  const loadOlder = useCallback(async () => {
    if (!sessionId || request.current) return;
    const current = qc.getQueryData<EventWindow>(['events', sessionId]);
    if (!current?.hasOlder || !current.events.length) return;
    const controller = new AbortController();
    request.current = controller;
    setLoadingOlder(true); setOlderError(undefined);
    try {
      const page = await api.events(sessionId, { before: current.events[0]!.sequence, limit: EVENT_PAGE_SIZE, direction: 'backward' }, controller.signal);
      if (controller.signal.aborted) return;
      qc.setQueryData<EventWindow>(['events', sessionId], cached => ({ ...mergeReconciledEvents(cached, page), hasOlder: page.length === EVENT_PAGE_SIZE }));
    } catch (error) {
      if (!controller.signal.aborted) setOlderError(error instanceof Error ? error.message : String(error));
    } finally {
      if (request.current === controller) { request.current = undefined; setLoadingOlder(false); }
    }
  }, [sessionId, qc]);
  useEffect(() => {
    if (!enabled || !query.data?.hasOlder || loadingOlder || olderError) return;
    // Let the tail paint before starting the next serial background page.
    // Only paging progress reschedules this work; live frames cannot starve it.
    let secondFrame: number | undefined;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => { void loadOlder(); });
    });
    return () => { cancelAnimationFrame(firstFrame); if (secondFrame !== undefined) cancelAnimationFrame(secondFrame); };
  }, [enabled, query.data?.hasOlder, query.data?.events[0]?.sequence, loadingOlder, olderError, loadOlder]);
  return { ...query, loadOlder, loadingOlder, olderError };
}
