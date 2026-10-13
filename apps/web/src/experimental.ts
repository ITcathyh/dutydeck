import { useSyncExternalStore } from 'react';

// 实验功能开关：只保存在当前浏览器（和主题偏好同一做法），默认关闭。
// 控制那些尚未接入运行时、只能保存草稿的入口是否出现。
export const EXPERIMENTAL_STORAGE_KEY = 'dutydeck.experimental';

const listeners = new Set<() => void>();
// 存储不可用（隐私模式）时只在本次会话内生效。
let memoryValue: boolean | undefined;

export function readExperimental(): boolean {
  try {
    return window.localStorage.getItem(EXPERIMENTAL_STORAGE_KEY) === '1';
  } catch { return memoryValue ?? false; }
}

export function writeExperimental(enabled: boolean): void {
  try {
    if (enabled) window.localStorage.setItem(EXPERIMENTAL_STORAGE_KEY, '1');
    else window.localStorage.removeItem(EXPERIMENTAL_STORAGE_KEY);
    memoryValue = undefined;
  } catch { memoryValue = enabled; }
  listeners.forEach(listener => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // 其他标签页改了开关时同步。
  const onStorage = (event: StorageEvent) => { if (event.key === null || event.key === EXPERIMENTAL_STORAGE_KEY) listener(); };
  window.addEventListener('storage', onStorage);
  return () => { listeners.delete(listener); window.removeEventListener('storage', onStorage); };
}

export function useExperimental(): [boolean, (enabled: boolean) => void] {
  const enabled = useSyncExternalStore(subscribe, readExperimental, () => false);
  return [enabled, writeExperimental];
}
