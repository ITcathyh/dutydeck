import { create } from 'zustand';
type Store = { activeSessionId?: string; rawVisible: boolean; setActive(id?: string): void; toggleRaw(): void };
export const useDockStore = create<Store>(set => ({ rawVisible: false, setActive: activeSessionId => set({ activeSessionId }), toggleRaw: () => set(s => ({ rawVisible: !s.rawVisible })) }));
