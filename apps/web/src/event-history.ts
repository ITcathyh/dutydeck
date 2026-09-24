import { api, type DockEvent } from './api';

export const EVENT_PAGE_SIZE = 200;
const HISTORY_PAGE_SIZE = 1_000;

export type EventWindow = {
  events: DockEvent[];
  sequenceIndex: Map<number, number>;
};

const sortedUnique = (events: DockEvent[]) => {
  const bySequence = new Map<number, DockEvent>();
  for (const event of events) bySequence.set(event.sequence, event);
  return [...bySequence.values()].sort((left, right) => left.sequence - right.sequence);
};

const indexEvents = (events: DockEvent[]) => new Map(events.map((event, index) => [event.sequence, index]));

export function createEventWindow(events: DockEvent[]): EventWindow {
  const sorted = sortedUnique(events);
  return { events: sorted, sequenceIndex: indexEvents(sorted) };
}

export async function loadEventHistory(sessionId: string, signal?: AbortSignal): Promise<EventWindow> {
  const events: DockEvent[] = [];
  let before: number | undefined;
  while (true) {
    signal?.throwIfAborted();
    const page = await api.events(sessionId, { before, limit: HISTORY_PAGE_SIZE, direction: 'backward' }, signal);
    events.push(...page);
    if (page.length < HISTORY_PAGE_SIZE) return createEventWindow(events);
    before = page[0]!.sequence;
  }
}

// SSE 热路径按 sequence map O(1) 定位更新，保留已加载的全部历史。
export function mergeLiveEvent(current: EventWindow | undefined, event: DockEvent): EventWindow {
  if (!current) return createEventWindow([event]);
  const existing = current.sequenceIndex.get(event.sequence);
  if (existing !== undefined) {
    const events = [...current.events];
    events[existing] = event;
    return { ...current, events };
  }
  const latest = current.events.at(-1);
  if (!latest || event.sequence > latest.sequence) {
    current.sequenceIndex.set(event.sequence, current.events.length);
    return { ...current, events: [...current.events, event] };
  }
  let low = 0; let high = current.events.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (current.events[middle]!.sequence < event.sequence) low = middle + 1;
    else high = middle;
  }
  const events = [...current.events.slice(0, low), event, ...current.events.slice(low)];
  return { events, sequenceIndex: indexEvents(events) };
}

export function mergeReconciledEvents(current: EventWindow | undefined, events: DockEvent[]): EventWindow {
  let next = current;
  for (const event of events) next = mergeLiveEvent(next, event);
  return next ?? createEventWindow([]);
}

export const newestSequence = (window: EventWindow | undefined) => window?.events.at(-1)?.sequence ?? 0;
