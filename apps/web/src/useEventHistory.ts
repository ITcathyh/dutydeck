import { eventsQuery } from './queries';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type DockEvent } from './api';
import { loadHistoryRange } from './event-history';

/** `tail` reads summaries of only the newest completed turns plus every turn's place; earlier summaries load per page. */
export function useEventHistory(sessionId: string | undefined, enabled: boolean, tail?: number) {
  const rawRequest = useRef<AbortController | undefined>(undefined);
  const [rawEvents, setRawEvents] = useState<DockEvent[]>();
  const [loadingRaw, setLoadingRaw] = useState(false);
  const [rawError, setRawError] = useState<string>();
  useEffect(() => {
    setRawEvents(undefined); setRawError(undefined); setLoadingRaw(false);
    return () => { rawRequest.current?.abort(); rawRequest.current = undefined; };
  }, [sessionId]);
  const query = useQuery({ ...eventsQuery(sessionId, tail), enabled: enabled && Boolean(sessionId) });
  const loadAll = useCallback(async () => {
    if (!sessionId || rawRequest.current) return;
    const controller = new AbortController(); rawRequest.current = controller;
    setLoadingRaw(true); setRawError(undefined);
    try {
      const { highWaterMark } = await api.sessionHistory(sessionId, controller.signal, { tail: 1 });
      const all = highWaterMark > 0 ? await loadHistoryRange(sessionId, 0, highWaterMark, controller.signal) : [];
      if (!controller.signal.aborted) { setRawEvents(all); return all; }
    } catch (error) {
      if (!controller.signal.aborted) setRawError(error instanceof Error ? error.message : String(error));
    } finally {
      if (rawRequest.current === controller) { rawRequest.current = undefined; setLoadingRaw(false); }
    }
  }, [sessionId]);
  const releaseRaw = useCallback(() => { rawRequest.current?.abort(); rawRequest.current = undefined; setRawEvents(undefined); setLoadingRaw(false); setRawError(undefined); }, []);
  // Earlier turns are already represented by complete outline boundaries. They
  // are fetched as raw events only by an explicit expansion or full-log action.
  return { ...query, loadAll, releaseRaw, rawEvents, loadingRaw, rawError };
}
