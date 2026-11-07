import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { api, artifactSnapshotsApi, type HistoryTurnPlace, type HistoryTurnSummary } from '../api';
import { HISTORY_TURN_PAGE_SIZE } from '../event-history';
import { SessionArtifacts } from './SessionArtifacts';

describe('per-turn artifact references', () => {
  it('keeps recorded versus delivered evidence distinct and opens the exact source event', async () => {
    const refs = [{ taskId: 'task', attemptId: 'attempt', eventId: 'event', sequence: 5, partIndex: 0, uri: 'file:///work/report.html', revision: 'event:event:5:0', status: 'recorded' as const, source: 'structured_tool_result' as const }, { taskId: 'task', attemptId: 'attempt', eventId: 'receipt', sequence: 6, partIndex: -1, uri: 'dutydeck-result:private', revision: 'event:receipt:6:receipt', status: 'delivered' as const, source: 'attachment_receipt' as const }];
    const snapshots = vi.spyOn(artifactSnapshotsApi, 'list').mockResolvedValue({ snapshots: [] });
    const history = vi.spyOn(api, 'sessionHistory').mockResolvedValue({ turns: [{ id: 'turn', taskId: 'task', attemptId: 'attempt', firstSequence: 1, lastSequence: 7, timestamp: '', status: 'completed', prompt: { text: 'Create report', truncated: false }, output: { text: '', truncated: false }, toolCount: 1, artifactReferences: refs, artifactReferencesTruncated: true }], highWaterMark: 7, liveAfter: 7 });
    const source = vi.fn(); window.addEventListener('dutydeck:show-history-turn', source);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    try {
      const { container } = render(<QueryClientProvider client={queryClient}><SessionArtifacts sessionId="session"/></QueryClientProvider>);
      expect(await screen.findByText('file:///work/report.html · 已记录引用')).toBeTruthy();
      expect(screen.getByText('dutydeck-result:private · 交付回执已确认')).toBeTruthy();
      expect(container.querySelector('a,img')).toBeNull();
      expect(screen.getByText('这里只列出部分产物引用；查看来源记录可读取这一轮的完整事件。')).toBeTruthy();
      fireEvent.click(screen.getAllByRole('button', { name: '查看来源记录', hidden: true })[0]!);
      expect(source).toHaveBeenCalledOnce();
      expect((source.mock.calls[0]![0] as CustomEvent).detail).toEqual({ taskId: 'task', attemptId: 'attempt', eventId: 'event', sequence: 5 });
    } finally { window.removeEventListener('dutydeck:show-history-turn', source); history.mockRestore(); snapshots.mockRestore(); queryClient.clear(); }
  });

  it('reads only the newest page of turn summaries and loads earlier pages on request', async () => {
    const places = Array.from({ length: 120 }, (_, index): HistoryTurnPlace => [`turn-${index}`, index * 10 + 1, index * 10 + 10, `task-${index}`, `prompt ${index}`]);
    const summary = ([id, first, last, taskId, prompt]: HistoryTurnPlace): HistoryTurnSummary => ({ id, taskId: taskId!, firstSequence: first, lastSequence: last, timestamp: '', status: 'completed', prompt: { text: prompt, truncated: false }, output: { text: '', truncated: false }, toolCount: 0,
      artifactReferences: id === 'turn-60' ? [{ taskId: taskId!, attemptId: 'attempt', eventId: 'event-60', sequence: first, partIndex: 0, uri: 'file:///work/old.txt', revision: `event:event-60:${first}:0`, status: 'recorded', source: 'structured_tool_result' }] : [], artifactReferencesTruncated: false });
    const snapshots = vi.spyOn(artifactSnapshotsApi, 'list').mockResolvedValue({ snapshots: [] });
    const history = vi.spyOn(api, 'sessionHistory').mockResolvedValue({ turns: places.slice(-HISTORY_TURN_PAGE_SIZE).map(summary), places, highWaterMark: 1200, liveAfter: 1200 });
    const pages = vi.spyOn(api, 'sessionHistoryTurns').mockImplementation(async (_id, from, through) => ({ turns: places.filter(place => place[1] >= from && place[2] <= through).map(summary) }));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    try {
      render(<QueryClientProvider client={queryClient}><SessionArtifacts sessionId="session"/></QueryClientProvider>);
      expect(await screen.findByText('已检查最近 50 轮，更早还有 70 轮。')).toBeTruthy();
      expect(history).toHaveBeenCalledWith('session', expect.anything(), { tail: HISTORY_TURN_PAGE_SIZE });
      expect(pages).not.toHaveBeenCalled();
      expect(screen.getByText(/^最近 50 轮尚无已记录的结构化产物/)).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: '检查更早的轮次' }));
      expect(await screen.findByText('prompt 60 · 1 项')).toBeTruthy();
      expect(pages).toHaveBeenCalledOnce();
      expect(pages).toHaveBeenCalledWith('session', 501, 1000, expect.anything());
      expect(screen.getByText('已检查最近 70 轮，更早还有 50 轮。')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: '检查更早的轮次' }));
      await waitFor(() => expect(pages).toHaveBeenCalledWith('session', 1, 500, expect.anything()));
      await waitFor(() => expect(screen.queryByRole('button', { name: '检查更早的轮次' })).toBeNull());
      expect(pages).toHaveBeenCalledTimes(2);
      expect(screen.getByText('prompt 60 · 1 项')).toBeTruthy();
    } finally { history.mockRestore(); pages.mockRestore(); snapshots.mockRestore(); queryClient.clear(); }
  });
});
