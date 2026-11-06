import { lazy, type ComponentType } from 'react';
import type { TimelineViewProps } from './components/TimelineView';

type TimelineViewModule = { default: ComponentType<TimelineViewProps> };
let loaded: TimelineViewModule | undefined;

/** Starts or joins the timeline chunk download; session links call it while the app boots. */
export const preloadTimelineView = () => import('./components/TimelineView').then(module => loaded = { default: module.TimelineView });

/**
 * The session timeline, kept out of the first-screen chunk. Once its chunk has loaded it mounts
 * without suspending: a lazy component that suspends even for a microtask commits its fallback,
 * and React then holds the revealed content back for up to 300 ms.
 */
export const LazyTimelineView = lazy((): Promise<TimelineViewModule> => loaded
  // A thenable that resolves synchronously lets React.lazy read the module in the same render.
  ? { then: (resolve: (module: TimelineViewModule) => void) => resolve(loaded!) } as unknown as Promise<TimelineViewModule>
  : preloadTimelineView());
