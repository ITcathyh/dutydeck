import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api, type DockEvent, type HistoryTurnSummary, type Task } from '../api';
import { buildTimeline, buildTimelineSections } from '../timeline';
import { TimelineView } from './TimelineView';

const task: Task = { id: 't', sessionId: 'history-ui', prompt: 'canonical instruction', status: 'completed', createdAt: '', updatedAt: '' };
const event = (sequence: number, type: string, data: unknown): DockEvent => ({ id: `source-${sequence}`, taskId: 't', attemptId: 'a', sequence, type, timestamp: '', data });
const canonical: DockEvent[] = [event(1, 'text', { role: 'user', text: 'canonical instruction', taskId: 't' }), event(2, 'tool_call', { id: 'native-tool', name: 'read', input: {} }), event(3, 'tool_result', { id: 'native-tool', status: 'completed', output: 'complete tool body canary' }), ...Array.from({ length: 298 }, (_, index) => event(index + 4, 'text', { text: index === 297 ? 'FINAL END CANARY' : 'x' }))];
const summary: HistoryTurnSummary = { id: 'source-1', taskId: 't', attemptId: 'a', firstSequence: 1, lastSequence: 301, timestamp: '', status: 'completed', prompt: { text: 'canonical instruction', truncated: false }, output: { text: 'bounded preview', truncated: true }, toolCount: 1, artifactReferences: [] };
const props = { activeSessionId: 'history-ui', eventsLoading: false, awaitingAnswer: false, hasOngoingActivity: false, latestUserIndex: -1, activeOutputLabel: 'Codex' };
const originalScroll = Element.prototype.scrollIntoView;
afterEach(() => { vi.restoreAllMocks(); Element.prototype.scrollIntoView = originalScroll; });

it('keeps old bodies unloaded, then renders a full completed final response and reveals the canonical tool source', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const loader = vi.spyOn(api, 'events').mockImplementation(async (_id, query) => { await gate; return canonical.filter(event => event.sequence > query!.after! && event.sequence < query!.before!).slice(0, query!.limit); });
  vi.spyOn(api, 'tasks').mockResolvedValue([task]);
  const scrolled: string[] = [];
  Element.prototype.scrollIntoView = function () { scrolled.push((this as HTMLElement).dataset.timelineEvent ?? ''); };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(<QueryClientProvider client={client}><TimelineView {...props} timeline={[]} timelineSections={[]} historyTurns={[summary]}/></QueryClientProvider>);
  expect(screen.getByText('bounded preview')).toBeTruthy(); expect(loader).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '展开完整记录' }));
  await screen.findByText('正在读取完整记录…');
  expect(screen.getByText('bounded preview')).toBeTruthy();
  await act(async () => release());
  await screen.findByText(/FINAL END CANARY/);
  expect(screen.queryByText('Agent 未返回最终输出。')).toBeNull();
  expect(loader).toHaveBeenCalledTimes(2);
  expect(client.getQueryData(['history-detail', 'history-ui', 1, 301])).toEqual(canonical);
  act(() => window.dispatchEvent(new CustomEvent('dutydeck:show-history-turn', { detail: { taskId: 't', attemptId: 'a', eventId: 'source-3', sequence: 3 } })));
  await waitFor(() => expect(view.container.querySelector('[data-timeline-event="source-2"]')?.textContent).toContain('complete tool body canary'));
  await waitFor(() => expect(scrolled).toContain('source-2'));
  expect(loader).toHaveBeenCalledTimes(2);
  view.unmount(); client.clear();
});

it('reveals a source in the current canonical suffix as well as historical summaries', async () => {
  const timeline = buildTimeline(canonical, [task]);
  const timelineSections = buildTimelineSections(timeline, [task], false);
  Element.prototype.scrollIntoView = vi.fn();
  const view = render(<TimelineView {...props} readingScopeKey="active-source" timeline={timeline} timelineSections={timelineSections} sourceEvents={canonical}/>);
  expect(view.container.querySelector('[data-timeline-event="source-2"]')).toBeNull();
  act(() => window.dispatchEvent(new CustomEvent('dutydeck:show-history-turn', { detail: { taskId: 't', attemptId: 'a', eventId: 'source-3', sequence: 3 } })));
  await waitFor(() => expect(view.container.querySelector('[data-timeline-event="source-2"]')?.textContent).toContain('complete tool body canary'));
});
