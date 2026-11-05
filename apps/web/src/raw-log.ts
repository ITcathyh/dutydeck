import type { DockEvent } from './api';
import type { EventWindow } from './event-history';

const rawText = (events: DockEvent[]) => events.filter(event => event.type === 'raw_terminal').map(event => event.raw ?? event.data.text).join('');

/** Whether rawText(events) would be non-empty, without joining the log. */
export const hasRawText = (events: DockEvent[]) => events.some(event => {
  if (event.type !== 'raw_terminal') return false;
  const text = event.raw ?? event.data.text;
  return text !== undefined && text !== null && String(text) !== '';
});

/** Reuse the log for unrelated events; output appended before or after the
 * previous window is joined onto the cached text instead of rebuilding it. */
export function createRawLogProjector() {
  let previous: DockEvent[] | undefined;
  let text = '';
  return (events: DockEvent[], delta?: Pick<EventWindow, 'previousEvents' | 'changes'>) => {
    if (events === previous) return text;
    const changes = delta?.changes;
    if (previous?.length && delta?.previousEvents === previous && changes?.length
      && changes[0]!.sequence > previous.at(-1)!.sequence) {
      const addition = rawText(changes);
      if (addition) text = [text, addition].join('');
    } else if (previous?.length && delta?.previousEvents === previous && changes?.length
      && changes.at(-1)!.sequence < previous[0]!.sequence) {
      const addition = rawText(changes);
      if (addition) text = [addition, text].join('');
    } else text = rawText(events);
    previous = events;
    return text;
  };
}
