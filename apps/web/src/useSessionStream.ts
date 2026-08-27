import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { DockEvent, Session, Task } from './api';
import { SessionStream, applyStatusEvent, maxSequence, mergeDockEvent, upsertTask, type StreamStatus } from './sse';

// 订阅当前会话的 SSE 事件流，把事件 merge 进 TanStack Query 缓存；
// 断线时由 SessionStream 按指数退避自动重连（原生 EventSource 重连会自动带 Last-Event-ID header）
export function useSessionStream(sessionId: string | undefined, runId: string | undefined, enabled: boolean): StreamStatus {
  const qc = useQueryClient();
  const [status, setStatus] = useState<StreamStatus>('connecting');
  const streamRef = useRef<SessionStream | null>(null);

  useEffect(() => {
    if (!sessionId || !enabled) return;
    setStatus('connecting');
    const stream = new SessionStream({
      sessionId,
      getAfter: () => maxSequence(qc.getQueryData<DockEvent[]>(['events', sessionId])),
      onEvent: event => {
        qc.setQueryData<DockEvent[]>(['events', sessionId], current => mergeDockEvent(current, event));
        if (event.type === 'status') qc.setQueryData<Session[]>(['sessions'], current => current?.map(session => session.id === sessionId ? applyStatusEvent(session, event) : session));
        if (event.type === 'task' && event.data.task) qc.setQueryData<Task[]>(['tasks', sessionId], current => upsertTask(current, event.data.task));
      },
      onStatus: setStatus
    });
    streamRef.current = stream;
    stream.start();
    return () => { stream.close(); streamRef.current = null; };
  }, [sessionId, runId, enabled, qc]);

  return sessionId && enabled ? status : 'connecting';
}
