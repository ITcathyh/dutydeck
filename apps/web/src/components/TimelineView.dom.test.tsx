import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TimelineEvent, TimelineSection } from '../timeline';
import { TimelineView } from './TimelineView';

const event: TimelineEvent = { id: 'e1', sequence: 1, type: 'text', timestamp: '', data: { role: 'assistant', text: '当前结果' } };
const sections: TimelineSection[] = [{ kind: 'event', event, final: true }];

afterEach(() => vi.unstubAllGlobals());

describe('TimelineView bounded history', () => {
  it('存在更早窗口时提供显式加载入口', async () => {
    const user = userEvent.setup(); const onLoadEarlier = vi.fn(async () => {});
    render(<TimelineView activeSessionId="s1" eventsLoading={false} loadingEarlier={false} hasEarlier onLoadEarlier={onLoadEarlier} onResolvePermission={() => {}} timeline={[event]} timelineSections={sections} awaitingAnswer={false} hasOngoingActivity={false} latestUserIndex={-1} activeOutputLabel="Codex"/>);
    await user.click(screen.getByRole('button', { name: '加载更早记录' }));
    expect(onLoadEarlier).toHaveBeenCalledTimes(1);
  });

  it('没有更早窗口时不展示无效操作', () => {
    render(<TimelineView activeSessionId="s1" eventsLoading={false} loadingEarlier={false} hasEarlier={false} onLoadEarlier={async () => {}} onResolvePermission={() => {}} timeline={[event]} timelineSections={sections} awaitingAnswer={false} hasOngoingActivity={false} latestUserIndex={-1} activeOutputLabel="Codex"/>);
    expect(screen.queryByRole('button', { name: '加载更早记录' })).toBeNull();
  });
  it('places goal progress after the latest events and before platform verification', () => {
    render(<TimelineView activeSessionId="s1" eventsLoading={false} loadingEarlier={false} hasEarlier={false} onLoadEarlier={async () => {}} onResolvePermission={() => {}} timeline={[event]} timelineSections={sections} awaitingAnswer={false} hasOngoingActivity={false} latestUserIndex={-1} activeOutputLabel="Codex" renderProgress={() => <p>目标进度占位</p>} footer={<p>平台验证占位</p>}/>);
    const progress = screen.getByText('目标进度占位');
    expect(screen.getByText('当前结果').compareDocumentPosition(progress) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(progress.compareDocumentPosition(screen.getByText('平台验证占位')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('follows asynchronously resized goals only while the user follows the latest content', () => {
    let resize!: () => void;
    vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resize = callback; } observe() {} disconnect() {} });
    const view = render(<TimelineView activeSessionId="s1" eventsLoading={false} loadingEarlier={false} hasEarlier={false} onLoadEarlier={async () => {}} onResolvePermission={() => {}} timeline={[event]} timelineSections={sections} awaitingAnswer={false} hasOngoingActivity={false} latestUserIndex={-1} activeOutputLabel="Codex" renderProgress={() => <p>目标进度占位</p>}/>);
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
