import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import { SessionArtifacts } from './SessionArtifacts';

describe('per-turn artifact references', () => {
  it('keeps recorded versus delivered evidence distinct and opens the exact source event', async () => {
    const refs = [{ taskId: 'task', attemptId: 'attempt', eventId: 'event', sequence: 5, partIndex: 0, uri: 'file:///work/report.html', revision: 'event:event:5:0', status: 'recorded' as const, source: 'structured_tool_result' as const }, { taskId: 'task', attemptId: 'attempt', eventId: 'receipt', sequence: 6, partIndex: -1, uri: 'dutydeck-result:private', revision: 'event:receipt:6:receipt', status: 'delivered' as const, source: 'attachment_receipt' as const }];
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
    } finally { window.removeEventListener('dutydeck:show-history-turn', source); history.mockRestore(); queryClient.clear(); }
  });
});
