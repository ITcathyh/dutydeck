import type { DockEvent } from './api';
import type { EventWindow } from './event-history';

const rawText = (events: DockEvent[]) => events.filter(event => event.type === 'raw_terminal').map(event => event.raw ?? event.data.text).join('');

/** Reuse the log for unrelated events. New raw output is eagerly joined so
 * opening the panel still receives a complete string ready for display. */
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
