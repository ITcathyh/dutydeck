export type TimelineReadingAnchor = { id: string; offset: number; eventId?: string; screenOffset?: number };
export type TimelineReadingState = {
  following: boolean;
  scrollTop: number;
  anchor?: TimelineReadingAnchor;
  disclosures: Map<string, boolean>;
  heights: Map<string, number>;
};

// Tab-local reading preferences contain identifiers and geometry, never conversation text.
const storageKey = 'dutydeck:timeline-reading:v1';
const states = new Map<string, TimelineReadingState>();
const limit = 40;
let hydrated = false;

function hydrate() {
  if (hydrated) return;
  hydrated = true;
  window.addEventListener('pagehide', saveTimelineReadingState);
  try {
    const saved: unknown = JSON.parse(sessionStorage.getItem(storageKey) ?? '[]');
    if (!Array.isArray(saved)) return;
    for (const [key, value] of saved.slice(-limit)) {
      if (typeof key !== 'string' || !value || typeof value.following !== 'boolean' || !Number.isFinite(value.scrollTop)) continue;
      const anchor = value.anchor;
      states.set(key, {
        following: value.following, scrollTop: Math.max(0, value.scrollTop),
        anchor: anchor && typeof anchor.id === 'string' && Number.isFinite(anchor.offset)
          ? { id: anchor.id, offset: anchor.offset, ...(typeof anchor.eventId === 'string' ? { eventId: anchor.eventId } : {}), ...(Number.isFinite(anchor.screenOffset) ? { screenOffset: anchor.screenOffset } : {}) } : undefined,
        disclosures: new Map(Array.isArray(value.disclosures) ? value.disclosures.filter((entry: unknown) => Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'boolean').slice(-400) : []),
        heights: new Map()
      });
    }
  } catch { /* Storage can be unavailable; in-memory navigation still works. */ }
}

export function getTimelineReadingState(key: string): TimelineReadingState {
  hydrate();
  const state = states.get(key) ?? { following: true, scrollTop: 0, disclosures: new Map<string, boolean>(), heights: new Map<string, number>() };
  states.delete(key);
  states.set(key, state);
  if (states.size > limit) states.delete(states.keys().next().value!);
  return state;
}

export function saveTimelineReadingState() {
  try {
    sessionStorage.setItem(storageKey, JSON.stringify([...states].map(([key, state]) => [key, {
      following: state.following, scrollTop: state.scrollTop, anchor: state.anchor,
      disclosures: [...state.disclosures].slice(-400)
    }])));
  } catch { /* Preferences are best-effort when browser storage is full/disabled. */ }
}
