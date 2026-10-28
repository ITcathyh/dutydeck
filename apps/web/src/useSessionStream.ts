import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, type Session } from './api';
import { EVENT_PAGE_SIZE, mergeReconciledEvents, newestSequence, type EventWindow } from './event-history';
import { Backoff, SessionStream, applyStatusEvent, type StreamStatus } from './sse';
import { recordSessionStatusUpdates } from './sessions-query';

export type SessionSyncState = { transport: StreamStatus; content: 'catching_up' | 'ready' | 'failed'; lastCalibratedAt?: number; retrying?: boolean; retry?(): void };
export const SYNC_RETRY_LIMIT = 5;

// 订阅当前任务的 SSE 事件流，把事件 merge 进 TanStack Query 缓存；
// 断线时由 SessionStream 按指数退避自动重连（原生 EventSource 重连会自动带 Last-Event-ID header）
export function useSessionStream(sessionId: string | undefined, runId: string | undefined, enabled: boolean): SessionSyncState {
  const qc = useQueryClient();
  const [status, setStatus] = useState<SessionSyncState>({ transport: 'connecting', content: 'catching_up' });
  const retryRef = useRef<(() => void) | undefined>(undefined);
  const retry = useCallback(() => retryRef.current?.(), []);
  const recoveryCursors = useRef(new Map<string, number>());

  useEffect(() => {
    if (!sessionId || !enabled) return;
    setStatus({ transport: 'connecting', content: 'catching_up' });
    const controller = new AbortController();
    let frame: number | undefined;
    let pending: import('./api').DockEvent[] = [];
    let received = newestSequence(qc.getQueryData<EventWindow>(['events', sessionId]));
    let refreshingTasks: Promise<void> | undefined;
    let tasksRefreshPending = false;
    let tasksInvalidated = false;
    const refreshTasks = (invalidate = false) => {
      tasksRefreshPending = true;
      tasksInvalidated ||= invalidate;
      if (refreshingTasks) return refreshingTasks;
      refreshingTasks = (async () => {
        try {
          const filters = { queryKey: ['tasks', sessionId], exact: true };
          // Query deduplicates a cold GET even when invalidated. Wait for that
          // snapshot before consuming the demand for a newer authoritative read.
          if (qc.getQueryState(filters.queryKey)?.fetchStatus === 'fetching') {
            await qc.refetchQueries(filters, { cancelRefetch: false });
          }
          while (tasksRefreshPending && !controller.signal.aborted) {
            tasksRefreshPending = false;
            const invalidate = tasksInvalidated;
            tasksInvalidated = false;
            await (invalidate ? qc.invalidateQueries(filters, { cancelRefetch: false }) : qc.refetchQueries(filters, { cancelRefetch: false }));
            if (qc.getQueryState(filters.queryKey)?.status === 'error') throw new Error('Task snapshot refresh failed');
          }
        } finally {
          refreshingTasks = undefined;
        }
      })();
      return refreshingTasks;
    };
    const applyEvents = (batch: import('./api').DockEvent[]) => {
      if (!batch.length) return;
      const cached = qc.getQueryData<EventWindow>(['events', sessionId]);
      let statuses = batch.filter(event => event.type === 'status');
      if (statuses.length) {
        const firstStatus = Math.min(...statuses.map(event => event.sequence));
        // A recovered older status may contain metadata absent from later live statuses.
        statuses = [...statuses, ...(cached?.events.filter(event => event.type === 'status' && event.sequence > firstStatus) ?? [])]
          .sort((a, b) => a.sequence - b.sequence);
      }
      const newTask = batch.some(event => event.type === 'task' && !cached?.events.some(item => item.sequence === event.sequence));
      qc.setQueryData<EventWindow>(['events', sessionId], current => mergeReconciledEvents(current, batch));
      if (statuses.length) qc.setQueryData<Session[]>(['sessions'], current => current?.map(session => {
        if (session.id !== sessionId) return session;
        const updated = statuses.reduce(applyStatusEvent, session);
        recordSessionStatusUpdates(qc, updated, statuses);
        return updated;
      }));
      if (newTask) void refreshTasks(true).catch(() => retryCalibration());
    };
    const flush = () => {
      frame = undefined;
      const batch = pending; pending = [];
      applyEvents(batch);
    };
    let reconciling = false;
    let desiredTarget = 0;
    let recoveryVersion = 0;
    let epoch = 0;
    let snapshotsRequired = false;
    let wasHidden = document.hidden;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let calibrationController: AbortController | undefined;
    const backoff = new Backoff();
    const alive = (generation: number) => !controller.signal.aborted && generation === epoch && !document.hidden;
    const retryCalibration = () => {
      if (controller.signal.aborted || document.hidden || retryTimer !== undefined) return;
      const retrying = backoff.attempt < SYNC_RETRY_LIMIT;
      setStatus(current => ({ ...current, content: 'failed', retrying }));
      if (!retrying) return;
      retryTimer = setTimeout(() => { retryTimer = undefined; calibrate(); }, backoff.next());
    };
    const reconcileEvents = (after: number, target?: number) => {
      recoveryCursors.current.set(sessionId, Math.min(recoveryCursors.current.get(sessionId) ?? after, after));
      desiredTarget = Math.max(desiredTarget, target ?? 0);
      if (backoff.attempt < SYNC_RETRY_LIMIT) calibrate(false);
    };
    const calibrate = (refreshSnapshots = true) => {
      snapshotsRequired ||= refreshSnapshots;
      recoveryVersion += 1;
      if (controller.signal.aborted || document.hidden || reconciling) return;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      retryTimer = undefined;
      reconciling = true;
      const generation = epoch;
      calibrationController = new AbortController();
      const signal = AbortSignal.any([controller.signal, calibrationController.signal]);
      setStatus(current => ({ ...current, content: 'catching_up' }));
      // The cursor describes a contiguous required suffix. Collapsed historical
      // ranges precede it and are intentionally absent from the canonical cache.
      let cursor = recoveryCursors.current.get(sessionId) ?? newestSequence(qc.getQueryData<EventWindow>(['events', sessionId]));
      recoveryCursors.current.set(sessionId, cursor);
      void (async () => {
        while (alive(generation)) {
          let requestVersion = recoveryVersion;
          const takeSnapshots = snapshotsRequired; snapshotsRequired = false;
          const snapshots = takeSnapshots ? Promise.all([
            refreshTasks(),
            qc.refetchQueries({ queryKey: ['sessions'], exact: true }, { throwOnError: true })
          ]) : Promise.resolve();
          // Attach a handler immediately while pages are being read.
          void snapshots.catch(() => {});
          do {
            const pageVersion = recoveryVersion;
            const beforePage = cursor;
            const missed = await api.events(sessionId, { after: cursor, limit: EVENT_PAGE_SIZE, direction: 'forward' }, signal);
            if (!alive(generation)) return;
            let next = cursor;
            for (const event of missed) {
              if (event.sequence !== next + 1) throw new Error('Event history is not contiguous');
              next = event.sequence;
            }
            applyEvents(missed);
            cursor = next;
            recoveryCursors.current.set(sessionId, cursor);
            if (missed.length < EVENT_PAGE_SIZE) {
              if (cursor < desiredTarget) {
                if (cursor > beforePage && pageVersion !== recoveryVersion) continue;
                throw new Error('Event history has not reached the live watermark');
              }
              requestVersion = recoveryVersion;
              break;
            }
          } while (alive(generation));
          await snapshots;
          await refreshingTasks;
          if (!alive(generation)) return;
          for (const key of [['tasks', sessionId], ['sessions']]) {
            if (qc.getQueryState(key)?.status === 'error') throw new Error('Snapshot refresh failed');
          }
          if (requestVersion !== recoveryVersion) continue;
          recoveryCursors.current.delete(sessionId);
          desiredTarget = 0;
          backoff.reset();
          setStatus(current => ({ ...current, content: 'ready', retrying: false, lastCalibratedAt: Date.now() }));
          return;
        }
      })().catch(() => { if (alive(generation)) retryCalibration(); }).finally(() => {
        reconciling = false;
        if (!controller.signal.aborted && generation !== epoch && !document.hidden) calibrate();
      });
    };
    const onVisibility = () => {
      if (wasHidden === document.hidden) return;
      wasHidden = document.hidden;
      epoch += 1;
      calibrationController?.abort();
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      retryTimer = undefined;
      setStatus(current => ({ ...current, content: 'catching_up' }));
      // SessionStream owns the single foreground calibration trigger.
    };
    document.addEventListener('visibilitychange', onVisibility);
    retryRef.current = () => { backoff.reset(); calibrate(); };
    const stream = new SessionStream({
      onReconnect: () => { backoff.reset(); calibrate(); },
      sessionId,
      getAfter: () => recoveryCursors.current.get(sessionId) ?? newestSequence(qc.getQueryData<EventWindow>(['events', sessionId])),
      onEvent: event => {
        const current = qc.getQueryData<EventWindow>(['events', sessionId]);
        const newest = Math.max(received, newestSequence(current));
        received = Math.max(received, event.sequence);
        if (event.sequence > newest + 1) reconcileEvents(newest, event.sequence);
        pending.push(event);
        if (pending.length >= 1_000) { if (frame !== undefined) cancelAnimationFrame(frame); flush(); }
        else if (frame === undefined) frame = requestAnimationFrame(flush);
      },
      onStatus: next => {
        setStatus(current => ({ ...current, transport: next, ...(next !== 'open' ? { content: 'catching_up' as const } : {}) }));
        if (next !== 'open') return;
        backoff.reset(); calibrate();
      }
    });
    stream.start();
    return () => { if (frame !== undefined) cancelAnimationFrame(frame); pending = []; retryRef.current = undefined; controller.abort(); calibrationController?.abort(); if (retryTimer !== undefined) clearTimeout(retryTimer); document.removeEventListener('visibilitychange', onVisibility); stream.close(); };
  }, [sessionId, runId, enabled, qc]);

  return sessionId && enabled ? { ...status, retry } : { transport: 'connecting', content: 'catching_up', retry };
}
