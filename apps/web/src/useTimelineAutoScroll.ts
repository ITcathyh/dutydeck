import { useEffect, useLayoutEffect, useRef, useState } from 'react';

export type ScrollMetrics = Pick<HTMLElement, 'scrollHeight' | 'scrollTop' | 'clientHeight'>;

export const isNearScrollBottom = (metrics: ScrollMetrics, threshold = 64) =>
  metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= threshold;

export function useTimelineAutoScroll(scopeKey: string | undefined, contentVersion: unknown, activityVersion: unknown, options: { initialFollowing?: boolean; enabled?: boolean } = {}) {
  const { initialFollowing = true, enabled = true } = options;
  const containerRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(initialFollowing);
  const [isFollowing, setIsFollowing] = useState(initialFollowing);

  const updateFollowing = (next: boolean) => {
    if (followingRef.current === next) return;
    followingRef.current = next;
    setIsFollowing(next);
  };

  const followContentResize = () => {
    const container = containerRef.current;
    if (container && enabled && followingRef.current) container.scrollTop = container.scrollHeight;
  };

  useLayoutEffect(() => {
    followingRef.current = initialFollowing;
    setIsFollowing(initialFollowing);
    const frame = requestAnimationFrame(followContentResize);
    return () => cancelAnimationFrame(frame);
  }, [scopeKey]);

  useEffect(() => {
    if (!enabled || !followingRef.current) return;
    const frame = requestAnimationFrame(followContentResize);
    return () => cancelAnimationFrame(frame);
  }, [contentVersion, activityVersion, enabled]);

  const onScroll = () => {
    const container = containerRef.current;
    if (container && enabled) updateFollowing(isNearScrollBottom(container));
  };

  const scrollToBottom = () => {
    const container = containerRef.current;
    updateFollowing(true);
    if (container) container.scrollTop = container.scrollHeight;
  };

  return { containerRef, isFollowing, onScroll, scrollToBottom, followContentResize, stopFollowing: () => updateFollowing(false) };
}
