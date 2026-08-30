import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { TimelineEvent, TimelineSection } from '../timeline';
import { TimelineView } from './TimelineView';

const event: TimelineEvent = { id: 'e1', sequence: 1, type: 'text', timestamp: '', data: { role: 'assistant', text: '当前结果' } };
const sections: TimelineSection[] = [{ kind: 'event', event, final: true }];

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
});
