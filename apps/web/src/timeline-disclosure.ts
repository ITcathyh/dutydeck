import { createContext, useContext, useLayoutEffect, useState, type SetStateAction } from 'react';

// Virtual rows unmount outside the viewport; keep disclosure choices per session.
export const TimelineDisclosureContext = createContext<Map<string, boolean> | undefined>(undefined);
export function useTimelineDisclosure(key: string, initial: boolean) {
  const choices = useContext(TimelineDisclosureContext);
  const [open, setOpen] = useState(() => choices?.get(key) ?? initial);
  useLayoutEffect(() => { choices?.set(key, open); }, [choices, key, open]);
  return [open, (value: SetStateAction<boolean>) => setOpen(current => {
    const next = typeof value === 'function' ? value(current) : value;
    choices?.set(key, next);
    return next;
  })] as const;
}
