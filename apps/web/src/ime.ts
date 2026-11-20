import type { CompositionEvent, KeyboardEvent } from 'react';

const compositionEndedAt = new WeakMap<EventTarget, number>();

export const imeCompositionHandlers = {
  onCompositionStart: (event: CompositionEvent) => { compositionEndedAt.delete(event.target); },
  onCompositionEnd: (event: CompositionEvent) => { compositionEndedAt.set(event.target, event.timeStamp); }
};

export function isImeKey(event: KeyboardEvent) {
  // Safari 确认候选词的 keydown 有时只剩 keyCode 229。
  if (event.nativeEvent.isComposing || event.keyCode === 229) return true;
  if (event.key !== 'Enter') return false;
  const endedAt = compositionEndedAt.get(event.target);
  if (endedAt === undefined) return false;
  compositionEndedAt.delete(event.target);
  if (event.timeStamp - endedAt > 100) return false;
  event.preventDefault();
  return true;
}
