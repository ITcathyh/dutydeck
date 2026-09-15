import { useEffect, useRef, useState } from 'react';

export type ScrollMetrics = Pick<HTMLElement, 'scrollHeight' | 'scrollTop' | 'clientHeight'>;

export const isNearScrollBottom = (metrics: ScrollMetrics, threshold = 64) =>
  metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= threshold;

export function useTimelineAutoScroll(scopeKey: string | undefined, contentVersion: unknown, activityVersion: unknown) {
  const containerRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);
  const [isFollowing, setIsFollowing] = useState(true);

  const updateFollowing = (next: boolean) => {
    if (followingRef.current === next) return;
    followingRef.current = next;
    setIsFollowing(next);
  };

  useEffect(() => {
    followingRef.current = true;
    setIsFollowing(true);
    const frame = requestAnimationFrame(() => {
      const container = containerRef.current;
      if (container) container.scrollTop = container.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [scopeKey]);

  useEffect(() => {
    if (!followingRef.current) return;
    const frame = requestAnimationFrame(() => {
      const container = containerRef.current;
      if (container && followingRef.current) container.scrollTop = container.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [contentVersion, activityVersion]);

  const onScroll = () => {
    const container = containerRef.current;
    if (container) updateFollowing(isNearScrollBottom(container));
  };

  const scrollToBottom = () => {
    const container = containerRef.current;
    updateFollowing(true);
    if (container) container.scrollTop = container.scrollHeight;
  };

  const followContentResize = () => {
    const container = containerRef.current;
    if (container && followingRef.current) container.scrollTop = container.scrollHeight;
  };

  return { containerRef, isFollowing, onScroll, scrollToBottom, followContentResize };
}
