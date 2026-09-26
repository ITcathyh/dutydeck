import { api, type DockEvent } from './api';

export const EVENT_PAGE_SIZE = 200;
export type EventWindow = {
  events: DockEvent[];
  hasOlder?: boolean;
  previousEvents?: DockEvent[];
  changes?: DockEvent[];
};

export function createEventWindow(events: DockEvent[], hasOlder = false): EventWindow {
  const bySequence = new Map<number, DockEvent>();
  for (const event of events) bySequence.set(event.sequence, event);
  const sorted = [...bySequence.values()].sort((left, right) => left.sequence - right.sequence);
  return { events: sorted, hasOlder };
}

/** First paint only needs the tail. Earlier pages are fetched when scrolling up. */
export async function loadEventHistory(sessionId: string, signal?: AbortSignal): Promise<EventWindow> {
  signal?.throwIfAborted();
  const page = await api.events(sessionId, { limit: EVENT_PAGE_SIZE, direction: 'backward' }, signal);
  signal?.throwIfAborted();
  return createEventWindow(page, page.length === EVENT_PAGE_SIZE);
}

export function mergeLiveEvent(current: EventWindow | undefined, event: DockEvent): EventWindow {
  return mergeReconciledEvents(current, [event]);
}

/** One copy for an entire page/frame, preserving unchanged event references. */
export function mergeReconciledEvents(current: EventWindow | undefined, incoming: DockEvent[]): EventWindow {
  if (!current) return createEventWindow(incoming);
  if (!incoming.length) return current;
  const additions = new Map<number, DockEvent>();
  for (const event of incoming) additions.set(event.sequence, event);
  const page = [...additions.values()].sort((a, b) => a.sequence - b.sequence);
  if (page[0]!.sequence > (current.events.at(-1)?.sequence ?? -Infinity)) {
    return { ...current, events: current.events.concat(page), previousEvents: current.events, changes: page };
  }
  const events: DockEvent[] = [];
  let index = 0;
  for (const event of current.events) {
    while (index < page.length && page[index]!.sequence < event.sequence) events.push(page[index++]!);
    events.push(page[index]?.sequence === event.sequence ? page[index++]! : event);
  }
  while (index < page.length) events.push(page[index++]!);
  return { ...current, events, previousEvents: current.events, changes: page };
}

export const newestSequence = (window: EventWindow | undefined) => window?.events.at(-1)?.sequence ?? 0;
