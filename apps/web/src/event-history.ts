import { api, type DockEvent, type HistoryOutline, type HistoryTurnSummary } from './api';

export const EVENT_PAGE_SIZE = 200;
/** Completed turns summarized up front on the workbench, and per page when earlier turns scroll into view. */
export const HISTORY_TURN_PAGE_SIZE = 50;
/** Range reads return only once complete, so use the server's largest page (EVENT_WINDOW_MAX_LIMIT). */
export const HISTORY_RANGE_PAGE_SIZE = 1000;
export type EventWindow = {
  events: DockEvent[];
  outline?: HistoryOutline;
  highWaterMark?: number;
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

export function mergeLiveEvent(current: EventWindow | undefined, event: DockEvent): EventWindow {
  return mergeReconciledEvents(current, [event]);
}

/** One copy for an entire page/frame, preserving unchanged event references. */
export function mergeReconciledEvents(current: EventWindow | undefined, incoming: DockEvent[]): EventWindow {
  if (!current) return createEventWindow(incoming);
  if (!incoming.length) return current;
  // SSE batches and API pages are already ordered and unique in the normal
  // path. Keep that path linear and reserve Map+sort for recovery/malformed
  // input where deduplication and ordering are actually needed.
  let ordered = true;
  for (let index = 1; index < incoming.length; index++) {
    if (!(incoming[index - 1]!.sequence < incoming[index]!.sequence)) {
      ordered = false;
      break;
    }
  }
  const page = ordered
    ? incoming.slice()
    : [...new Map(incoming.map(event => [event.sequence, event])).values()].sort((a, b) => a.sequence - b.sequence);
  if (page[0]!.sequence > (current.events.at(-1)?.sequence ?? -Infinity)) {
    return { ...current, events: current.events.concat(page), previousEvents: current.events, changes: page };
  }
  if (page.at(-1)!.sequence < (current.events[0]?.sequence ?? Infinity)) {
    return { ...current, events: page.concat(current.events), previousEvents: current.events, changes: page };
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

export const newestSequence = (window: EventWindow | undefined) => Math.max(window?.highWaterMark ?? 0, window?.events.at(-1)?.sequence ?? 0);

/**
 * Details are canonical, bounded requests; summaries never enter this event array.
 * Each page is every stored record after the cursor, so a short page ends the range. Holes
 * left by pruned raw terminal output are kept as holes; completeness is checked at the end.
 */
export async function loadHistoryRange(sessionId: string, after: number, through?: number, signal?: AbortSignal): Promise<DockEvent[]> {
  const events: DockEvent[] = [];
  let cursor = after;
  while (true) {
    signal?.throwIfAborted();
    const page = await api.events(sessionId, { after: cursor, ...(through !== undefined ? { before: through + 1 } : {}), limit: HISTORY_RANGE_PAGE_SIZE, direction: 'forward' }, signal);
    signal?.throwIfAborted();
    if (!page.length) break;
    for (const event of page) {
      if (!(event.sequence > cursor && (through === undefined || event.sequence <= through))) throw new Error('分页结果异常，请重试读取');
      events.push(event); cursor = event.sequence;
    }
    if (through !== undefined && cursor >= through) break;
    if (page.length < HISTORY_RANGE_PAGE_SIZE) break;
  }
  if (through !== undefined && cursor < through) throw new Error('记录尚未读取完整，请重试');
  return events;
}

/** A complete read vouches for its own range, pruned holes included; live events after it must continue without a hole. */
export function completeEventHistory(complete: DockEvent[] | undefined, live: DockEvent[]): DockEvent[] | undefined {
  if (!complete) return undefined;
  const through = complete.at(-1)?.sequence ?? 0;
  const events: DockEvent[] = [];
  for (const event of mergeReconciledEvents(createEventWindow(complete), live).events) {
    if (event.sequence > through && event.sequence !== (events.at(-1)?.sequence ?? 0) + 1) break;
    events.push(event);
  }
  return events;
}

/**
 * Same result as completeEventHistory, but a live window that only grew past the merged tail
 * appends that contiguous tail instead of rebuilding the whole history. The returned window
 * carries previousEvents/changes so downstream projectors can stay incremental too.
 */
export function createCompleteHistoryProjector() {
  let complete: DockEvent[] | undefined;
  let live: DockEvent[] | undefined;
  let result: EventWindow | undefined;
  return (nextComplete: DockEvent[] | undefined, liveWindow: EventWindow | undefined): EventWindow | undefined => {
    const nextLive = liveWindow?.events ?? [];
    if (!nextComplete) { complete = live = result = undefined; return undefined; }
    if (result && nextComplete === complete && nextLive === live) return result;
    const tail = result?.events.at(-1)?.sequence ?? 0;
    const appendOnly = result && nextComplete === complete && liveWindow?.previousEvents === live
      && liveWindow?.changes?.length && liveWindow.changes.every(event => event.sequence > tail);
    complete = nextComplete; live = nextLive;
    if (!appendOnly) return result = { events: completeEventHistory(nextComplete, nextLive)! };
    let start = nextLive.length;
    while (start > 0 && nextLive[start - 1]!.sequence > tail) start--;
    const appended: DockEvent[] = [];
    for (let index = start, expected = tail + 1; index < nextLive.length && nextLive[index]!.sequence === expected; index++, expected++) appended.push(nextLive[index]!);
    if (!appended.length) return result;
    return result = { events: result!.events.concat(appended), previousEvents: result!.events, changes: appended };
  };
}

export const loadTurnHistory = (sessionId: string, turn: HistoryTurnSummary, signal?: AbortSignal) =>
  loadHistoryRange(sessionId, turn.firstSequence - 1, turn.lastSequence, signal);

export async function loadProjectedHistory(sessionId: string, outline: HistoryOutline, signal?: AbortSignal): Promise<EventWindow> {
  const events = await loadHistoryRange(sessionId, outline.liveAfter, undefined, signal);
  if ((events.at(-1)?.sequence ?? outline.liveAfter) < outline.highWaterMark) throw new Error('活动记录尚未追平历史水位，请重试');
  return { ...createEventWindow(events), outline, highWaterMark: Math.max(outline.highWaterMark, events.at(-1)?.sequence ?? 0) };
}
