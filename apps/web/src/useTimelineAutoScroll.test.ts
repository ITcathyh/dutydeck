import { describe, expect, it } from 'vitest';
import { isNearScrollBottom } from './useTimelineAutoScroll';

describe('timeline auto-scroll', () => {
  it('follows while the viewport is at or near the latest content', () => {
    expect(isNearScrollBottom({ scrollHeight: 1_000, scrollTop: 600, clientHeight: 400 })).toBe(true);
    expect(isNearScrollBottom({ scrollHeight: 1_000, scrollTop: 540, clientHeight: 400 })).toBe(true);
  });

  it('stops following after the user scrolls far enough into history', () => {
    expect(isNearScrollBottom({ scrollHeight: 1_000, scrollTop: 500, clientHeight: 400 })).toBe(false);
  });
});

