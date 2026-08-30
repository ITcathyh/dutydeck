import type { DockEvent, EventWindowQuery } from './api';

export const EVENT_PAGE_SIZE = 200;
export const EVENT_RENDER_LIMIT = 800;

export type EventWindow = {
  events: DockEvent[];
  hasEarlier: boolean;
  sequenceIndex: Map<number, number>;
};

const sortedUnique = (events: DockEvent[]) => {
  const bySequence = new Map<number, DockEvent>();
  for (const event of events) bySequence.set(event.sequence, event);
  return [...bySequence.values()].sort((left, right) => left.sequence - right.sequence);
};

const indexEvents = (events: DockEvent[]) => new Map(events.map((event, index) => [event.sequence, index]));

export function createEventWindow(events: DockEvent[], hasEarlier = events.length >= EVENT_PAGE_SIZE): EventWindow {
  const bounded = sortedUnique(events).slice(-EVENT_RENDER_LIMIT);
  return { events: bounded, hasEarlier: hasEarlier && bounded.length < EVENT_RENDER_LIMIT, sequenceIndex: indexEvents(bounded) };
}

export function mergeOlderEvents(current: EventWindow | undefined, older: DockEvent[], pageHasEarlier: boolean): EventWindow {
  if (!current) return createEventWindow(older, pageHasEarlier);
  const merged = sortedUnique([...older, ...current.events]).slice(-EVENT_RENDER_LIMIT);
  const atLocalLimit = merged.length >= EVENT_RENDER_LIMIT;
  return { events: merged, hasEarlier: pageHasEarlier && !atLocalLimit, sequenceIndex: indexEvents(merged) };
}

// SSE 热路径按 sequence map O(1) 定位更新；仅插入和有界淘汰时复制数组。
export function mergeLiveEvent(current: EventWindow | undefined, event: DockEvent): EventWindow {
  if (!current) return createEventWindow([event], false);
  const existing = current.sequenceIndex.get(event.sequence);
  if (existing !== undefined) {
    const events = [...current.events];
    events[existing] = event;
    return { ...current, events };
  }
  const latest = current.events.at(-1);
  if ((!latest || event.sequence > latest.sequence) && current.events.length < EVENT_RENDER_LIMIT) {
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
  if (events.length > EVENT_RENDER_LIMIT) events.splice(0, events.length - EVENT_RENDER_LIMIT);
  return { events, hasEarlier: current.hasEarlier, sequenceIndex: indexEvents(events) };
}

export function mergeReconciledEvents(current: EventWindow | undefined, events: DockEvent[]): EventWindow {
  let next = current;
  for (const event of events) next = mergeLiveEvent(next, event);
  return next ?? createEventWindow([], false);
}

export const oldestSequence = (window: EventWindow | undefined) => window?.events[0]?.sequence;
export const newestSequence = (window: EventWindow | undefined) => window?.events.at(-1)?.sequence ?? 0;
export const initialEventQuery = (): EventWindowQuery => ({ limit: EVENT_PAGE_SIZE, direction: 'backward' });
