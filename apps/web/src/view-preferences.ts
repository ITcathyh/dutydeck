import { useState } from 'react';
import { currentInstance } from './instance';

export const viewPreferenceKey = (name: string, instance = currentInstance()) => `dutydeck:view:v1:${instance ?? '@local'}:${name}`;
export const taskReadingScopeKey = (sessionId: string, instance = currentInstance()) => `${instance ?? '@local'}:${sessionId}`;

export function useViewPreference<T>(name: string, initial: T, valid: (value: unknown) => value is T) {
  const key = viewPreferenceKey(name);
  const [value, setValue] = useState<T>(() => {
    try { const stored: unknown = JSON.parse(localStorage.getItem(key) ?? 'null'); return valid(stored) ? stored : initial; }
    catch { return initial; }
  });
  const update = (next: T | ((current: T) => T)) => {
    setValue(current => {
      const resolved = typeof next === 'function' ? (next as (current: T) => T)(current) : next;
      try { localStorage.setItem(key, JSON.stringify(resolved)); } catch { /* Preferences still work for this tab. */ }
      return resolved;
    });
  };
  return [value, update] as const;
}
