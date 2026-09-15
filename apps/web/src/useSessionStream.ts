import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, type Session } from './api';
import { EVENT_PAGE_SIZE, mergeLiveEvent, mergeReconciledEvents, newestSequence, type EventWindow } from './event-history';
import { SessionStream, applyStatusEvent, type StreamStatus } from './sse';

// 订阅当前任务的 SSE 事件流，把事件 merge 进 TanStack Query 缓存；
// 断线时由 SessionStream 按指数退避自动重连（原生 EventSource 重连会自动带 Last-Event-ID header）
export function useSessionStream(sessionId: string | undefined, runId: string | undefined, enabled: boolean): StreamStatus {
  const qc = useQueryClient();
  const [status, setStatus] = useState<StreamStatus>('connecting');
  const streamRef = useRef<SessionStream | null>(null);

  useEffect(() => {
    if (!sessionId || !enabled) return;
    setStatus('connecting');
    let reconciling = false;
    let desiredTarget: number | undefined;
    const reconcileEvents = (after: number, target?: number) => {
      if (target !== undefined) desiredTarget = Math.max(desiredTarget ?? 0, target);
      if (reconciling) return;
      reconciling = true;
      void (async () => {
        let cursor = after;
        while (true) {
          const missed = await api.events(sessionId, { after: cursor, limit: EVENT_PAGE_SIZE, direction: 'forward' });
          qc.setQueryData<EventWindow>(['events', sessionId], current => mergeReconciledEvents(current, missed));
          const nextCursor = missed.at(-1)?.sequence ?? cursor;
          if (!missed.length || nextCursor <= cursor || missed.length < EVENT_PAGE_SIZE || desiredTarget === undefined || nextCursor >= desiredTarget - 1) break;
          cursor = nextCursor;
        }
      })().catch(() => { /* 下一次 open / gap 会再次校准 */ }).finally(() => { reconciling = false; desiredTarget = undefined; });
    };
    const stream = new SessionStream({
      sessionId,
      getAfter: () => newestSequence(qc.getQueryData<EventWindow>(['events', sessionId])),
      onEvent: event => {
        const current = qc.getQueryData<EventWindow>(['events', sessionId]);
        const newest = newestSequence(current);
        if (newest > 0 && event.sequence > newest + 1) reconcileEvents(newest, event.sequence);
        qc.setQueryData<EventWindow>(['events', sessionId], cached => mergeLiveEvent(cached, event));
        if (event.type === 'status') qc.setQueryData<Session[]>(['sessions'], current => current?.map(session => session.id === sessionId ? applyStatusEvent(session, event) : session));
        if (event.type === 'task') void qc.invalidateQueries({ queryKey: ['tasks', sessionId], exact: true });
      },
      onStatus: next => {
        setStatus(next);
        if (next !== 'open') return;
        reconcileEvents(newestSequence(qc.getQueryData<EventWindow>(['events', sessionId])));
        void qc.refetchQueries({ queryKey: ['tasks', sessionId], exact: true });
        void qc.refetchQueries({ queryKey: ['sessions'], exact: true });
      }
    });
    streamRef.current = stream;
    stream.start();
    return () => { stream.close(); streamRef.current = null; };
  }, [sessionId, runId, enabled, qc]);

  return sessionId && enabled ? status : 'connecting';
}
