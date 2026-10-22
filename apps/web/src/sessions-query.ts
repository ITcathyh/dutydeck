import type { QueryClient } from '@tanstack/react-query';
import { api, type DockEvent, type Session } from './api';
import { applyStatusEvent } from './sse';

const statusFields = ['state', 'updatedAt', 'model', 'reasoningEffort'] as const;
type StatusField = typeof statusFields[number];
type StatusObserver = (session: Session, fields: Set<StatusField>) => void;
// Contains callbacks only while GETs are in flight, removed on completion or abort.
const inFlight = new WeakMap<QueryClient, Set<StatusObserver>>();

// A frame can reduce A → B → A to one cache write. Report explicit status fields
// before structural sharing erases those intermediate metadata updates.
export function recordSessionStatusUpdates(client: QueryClient, session: Session, events: DockEvent[]): void {
  const observers = inFlight.get(client);
  if (!observers?.size) return;
  const fields = new Set<StatusField>();
  for (const event of events) {
    if (applyStatusEvent(session, event) === session) continue;
    fields.add('state');
    if (event.timestamp) fields.add('updatedAt');
    if (typeof event.data.model === 'string') fields.add('model');
    if (typeof event.data.reasoningEffort === 'string') fields.add('reasoningEffort');
  }
  if (fields.size) for (const observe of observers) observe(session, fields);
}

// Each request tracks touched fields, including round trips to their initial
// values. GET still owns list membership, run changes and unrelated metadata.
export async function loadSessions(client: QueryClient, signal: AbortSignal): Promise<Session[]> {
  signal.throwIfAborted();
  const before = new Map(client.getQueryData<Session[]>(['sessions'])?.map(session => [session.id, session]));
  let previous = before;
  const changes = new Map<string, Set<StatusField>>();
  const observe: StatusObserver = (session, fields) => {
    if (session.runId !== before.get(session.id)?.runId) return;
    const touched = changes.get(session.id) ?? new Set<StatusField>();
    for (const field of fields) touched.add(field);
    changes.set(session.id, touched);
  };
  const observers = inFlight.get(client) ?? new Set<StatusObserver>();
  observers.add(observe);
  inFlight.set(client, observers);
  // Model/effort mutation responses also write full sessions outside the stream.
  const unsubscribe = client.getQueryCache().subscribe(event => {
    if (event.type !== 'updated' || event.action.type !== 'success' || !event.action.manual || event.query.queryKey.length !== 1 || event.query.queryKey[0] !== 'sessions') return;
    const rows = event.query.state.data as Session[] | undefined;
    const next = new Map(rows?.map(session => [session.id, session]));
    for (const session of rows ?? []) {
      const old = previous.get(session.id);
      if (old && old.runId === session.runId && old !== session) observe(session, new Set(statusFields.filter(field => old[field] !== session[field])));
    }
    previous = next;
  });
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    unsubscribe();
    observers.delete(observe);
    if (!observers.size) inFlight.delete(client);
    changes.clear();
    before.clear();
    previous.clear();
  };
  signal.addEventListener('abort', stop, { once: true });
  try {
    const snapshot = await api.sessions(signal);
    signal.throwIfAborted();
    const current = new Map(client.getQueryData<Session[]>(['sessions'])?.map(session => [session.id, session]));
    return snapshot.map(session => {
      const live = current.get(session.id);
      const fields = changes.get(session.id);
      if (!live || !fields?.size || live.runId !== session.runId || live.runId !== before.get(session.id)?.runId) return session;
      // updatedAt is a wall clock, not a strict revision. Only use it to accept a
      // clearly later snapshot; equal timestamps favor the in-flight live update.
      if (Date.parse(session.updatedAt) > Date.parse(live.updatedAt)) return session;
      const merged = { ...session };
      for (const field of fields) Object.assign(merged, { [field]: live[field] });
      return merged;
    });
  } finally {
    signal.removeEventListener('abort', stop);
    stop();
  }
}
