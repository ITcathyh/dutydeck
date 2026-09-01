import { useEffect, useState } from 'react';

/**
 * 订阅一条 media query，返回它当前是否命中。
 *
 * 合并 App.tsx 与 SessionList.tsx 两份逐字重复的 matchMedia 订阅。两处都踩过
 * 同一个坑：jsdom 与 SSR 下 window / window.matchMedia 可能不存在，直接调用会抛。
 * 这里统一按「读不到就当不命中」处理，并且首帧同步取值——用 useEffect 里才第一次
 * setState 会让移动端首屏先按桌面布局渲染一帧。
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => matchQuery(query));
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [query]);
  return matches;
}

function matchQuery(query: string): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try { return window.matchMedia(query).matches; }
  catch { return false; }
}
