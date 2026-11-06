import { lazy, Suspense } from 'react';
import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { LazyTimelineView, preloadTimelineView } from './timeline-view-loader';

const props = { activeSessionId: 's', eventsLoading: false, timeline: [], timelineSections: [], awaitingAnswer: false, hasOngoingActivity: false, latestUserIndex: -1, activeOutputLabel: 'Codex' };

it('mounts a preloaded timeline without committing its Suspense fallback', async () => {
  await preloadTimelineView();
  // Control: a plain lazy component over the same, already loaded module still suspends once.
  // React then holds the revealed timeline back for up to 300 ms after that fallback.
  const Plain = lazy(() => import('./components/TimelineView').then(module => ({ default: module.TimelineView })));
  const plain = render(<Suspense fallback={<p>plain fallback</p>}><Plain {...props}/></Suspense>);
  expect(screen.getByText('plain fallback')).toBeTruthy();
  plain.unmount();
  render(<Suspense fallback={<p>timeline fallback</p>}><LazyTimelineView {...props}/></Suspense>);
  expect(screen.queryByText('timeline fallback')).toBeNull();
  expect(document.querySelector('[data-timeline-scroll]')).toBeTruthy();
});
