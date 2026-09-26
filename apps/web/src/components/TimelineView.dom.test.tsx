import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TimelineEvent, TimelineSection } from '../timeline';
import { TimelineView } from './TimelineView';

const event: TimelineEvent = { id: 'e1', sequence: 1, type: 'text', timestamp: '', data: { role: 'assistant', text: '当前结果' } };
const sections: TimelineSection[] = [{ kind: 'event', event, final: true }];

afterEach(() => vi.unstubAllGlobals());

describe('TimelineView complete history', () => {
  it('renders history without a manual pagination button', () => {
    render(<TimelineView activeSessionId="s1" eventsLoading={false} onResolvePermission={() => {}} timeline={[event]} timelineSections={sections} awaitingAnswer={false} hasOngoingActivity={false} latestUserIndex={-1} activeOutputLabel="Codex"/>);
    expect(screen.getByText('当前结果')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '加载更早记录' })).toBeNull();
  });
  it('places goal progress after the latest events and before platform verification', () => {
    render(<TimelineView activeSessionId="s1" eventsLoading={false} onResolvePermission={() => {}} timeline={[event]} timelineSections={sections} awaitingAnswer={false} hasOngoingActivity={false} latestUserIndex={-1} activeOutputLabel="Codex" renderProgress={() => <p>目标进度占位</p>} footer={<p>平台验证占位</p>}/>);
    const progress = screen.getByText('目标进度占位');
    expect(screen.getByText('当前结果').compareDocumentPosition(progress) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(progress.compareDocumentPosition(screen.getByText('平台验证占位')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('follows asynchronously resized goals only while the user follows the latest content', () => {
    let resize!: () => void;
    vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resize = callback; } observe() {} disconnect() {} });
    const view = render(<TimelineView activeSessionId="s1" eventsLoading={false} onResolvePermission={() => {}} timeline={[event]} timelineSections={sections} awaitingAnswer={false} hasOngoingActivity={false} latestUserIndex={-1} activeOutputLabel="Codex" renderProgress={() => <p>目标进度占位</p>}/>);
    const container = view.container.querySelector('.overflow-y-auto') as HTMLElement;
    Object.defineProperties(container, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { value: 300 } });
    act(() => resize());
    expect(container.scrollTop).toBe(1000);
    container.scrollTop = 100;
    fireEvent.scroll(container);
    act(() => resize());
    expect(container.scrollTop).toBe(100);
    expect(screen.getByRole('button', { name: '回到最新消息' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '回到最新消息' }));
    Object.defineProperty(container, 'scrollHeight', { value: 1500 });
    act(() => resize());
    expect(container.scrollTop).toBe(1500);
  });

});

it('bounds rendered turns, restores disclosures after scrolling, and resets a changed session', async () => {
  const history: TimelineEvent[] = Array.from({ length: 100 }, (_, index) => ({ id: `user-${index}`, sequence: index + 1, type: 'text', timestamp: '', data: { role: 'user', text: `prompt ${index}` } }));
  const allSections: TimelineSection[] = history.flatMap((event, index): TimelineSection[] => [
    { kind: 'event', event, final: false },
    { kind: 'activity', id: `activity-${index}`, groups: [{ id: `group-${index}`, label: `phase ${index}`, events: [], startedAt: '' }], hasAnswer: true, taskStatus: 'completed', isLatestTurn: index === 99, startedAt: '' }
  ]);
  const props = { eventsLoading: false, timeline: history, timelineSections: allSections, awaitingAnswer: false, hasOngoingActivity: false, latestUserIndex: 99, activeOutputLabel: 'Codex' };
  const view = render(<TimelineView key="s1" activeSessionId="s1" {...props}/>);
  const container = view.container.querySelector('[data-timeline-scroll]') as HTMLElement;
  Object.defineProperties(container, { scrollHeight: { configurable: true, value: 18000 }, clientHeight: { value: 600 } });
  container.scrollTop = 0; fireEvent.scroll(container);
  expect(screen.getByText('prompt 0')).toBeTruthy();
  expect(view.container.querySelectorAll('[data-timeline-turn]').length).toBeLessThan(20);
  const details = view.container.querySelector('details')!;
  details.open = true; fireEvent(details, new Event('toggle'));
  expect(screen.getByText('phase 0')).toBeTruthy();
  container.scrollTop = 9000; fireEvent.scroll(container);
  expect(screen.queryByText('phase 0')).toBeNull();
  container.scrollTop = 0; fireEvent.scroll(container);
  expect(screen.getByText('phase 0')).toBeTruthy();
  Object.defineProperty(container, 'scrollHeight', { value: 23000 });
  container.scrollTop = 21000; fireEvent.scroll(container);
  expect(view.container.querySelectorAll('[data-timeline-turn]').length).toBeLessThan(20);
  view.rerender(<TimelineView key="s2" activeSessionId="s2" {...props}/>);
  expect(screen.getByText('prompt 99')).toBeTruthy();
  expect(screen.queryByText('phase 0')).toBeNull();
});

it('keeps an expanded single-turn tool mounted when an older fragment is prepended', async () => {
  const tool = (sequence: number): TimelineEvent => ({ id: `tool-${sequence}`, sequence, type: 'tool_result', timestamp: '', data: { id: `tool-${sequence}`, name: `tool ${sequence}`, status: 'completed', output: `output ${sequence}` } });
  const tail = [tool(201), tool(202)];
  const activity = (events: TimelineEvent[]): TimelineSection => ({ kind: 'activity', id: `activity-${events[0]!.id}`, groups: [{ id: `group-${events[0]!.id}`, label: 'tools', events, startedAt: '' }], hasAnswer: true, taskStatus: 'completed', isLatestTurn: true, startedAt: '' });
  const props = { activeSessionId: 'single', eventsLoading: false, awaitingAnswer: false, hasOngoingActivity: false, latestUserIndex: -1, activeOutputLabel: 'Codex' };
  const view = render(<TimelineView {...props} timeline={tail} timelineSections={[activity(tail)]}/>);
  const details = view.container.querySelector('details')!;
  details.open = true; fireEvent(details, new Event('toggle'));
  fireEvent.click(screen.getByText('tools'));
  const firstTool = view.container.querySelector('[data-timeline-event="tool-201"]')!;
  fireEvent.click(firstTool.querySelector('button')!);
  expect(screen.getByText(/output 201/)).toBeTruthy();
  const expanded = view.container.querySelector('[data-timeline-event="tool-201"]');
  const full = [tool(199), tool(200), ...tail];
  view.rerender(<TimelineView {...props} timeline={full} timelineSections={[activity(full)]}/>);
  expect(view.container.querySelector('details')?.open).toBe(true);
  expect(view.container.querySelector('[data-timeline-event="tool-201"]')).toBe(expanded);
  expect(screen.getByText(/output 201/)).toBeTruthy();
});

it('loads older history on upward wheel or touch when the tail has no renderable events', () => {
  const loadOlder = vi.fn(async () => {});
  const view = render(<TimelineView activeSessionId="empty-tail" eventsLoading={false} timeline={[]} timelineSections={[]} awaitingAnswer={false} hasOngoingActivity={false} latestUserIndex={-1} activeOutputLabel="Codex" hasOlder loadOlder={loadOlder}/>);
  const container = view.container.querySelector('[data-timeline-scroll]')!;
  expect(screen.getByText('向上滚动查看更早记录')).toBeTruthy();
  fireEvent.wheel(container, { deltaY: -100 });
  expect(loadOlder).toHaveBeenCalledTimes(1);
  fireEvent.touchStart(container, { touches: [{ clientY: 100 }] });
  fireEvent.touchMove(container, { touches: [{ clientY: 200 }] });
  expect(loadOlder).toHaveBeenCalledTimes(2);
});


it('updates an existing turn and a new live turn without mutating retained sections', () => {
  const user: TimelineEvent = { id: 'user', sequence: 1, type: 'text', timestamp: '', data: { role: 'user', text: 'prompt' } };
  const answer: TimelineEvent = { id: 'answer', sequence: 2, type: 'text', timestamp: '', data: { role: 'assistant', text: 'first answer' } };
  const userSection: TimelineSection = { kind: 'event', event: user, final: false };
  const firstSections: TimelineSection[] = [userSection, { kind: 'event', event: answer, final: true }];
  Object.freeze(firstSections);
  const props = { activeSessionId: 'live', eventsLoading: false, awaitingAnswer: false, hasOngoingActivity: false, latestUserIndex: 0, activeOutputLabel: 'Codex' };
  const view = render(<TimelineView {...props} timeline={[user, answer]} timelineSections={firstSections}/>);
  const changedAnswer = { ...answer, data: { ...answer.data, text: 'updated answer' } };
  const updatedSections: TimelineSection[] = [userSection, { kind: 'event', event: changedAnswer, final: true }];
  view.rerender(<TimelineView {...props} timeline={[user, changedAnswer]} timelineSections={updatedSections}/>);
  expect(screen.getByText('updated answer')).toBeTruthy();
  expect(screen.queryByText('first answer')).toBeNull();
  expect(firstSections[1]).toMatchObject({ event: { data: { text: 'first answer' } } });
  const nextUser = { ...user, id: 'next-user', sequence: 3, data: { role: 'user', text: 'next prompt' } };
  view.rerender(<TimelineView {...props} timeline={[user, changedAnswer, nextUser]} timelineSections={[...updatedSections, { kind: 'event', event: nextUser, final: false }]}/>);
  expect(screen.getByText('updated answer')).toBeTruthy();
  expect(screen.getByText('next prompt')).toBeTruthy();
});
