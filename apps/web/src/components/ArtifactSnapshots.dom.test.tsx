import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ArtifactSnapshot, EventArtifactReference } from '@dutydeck/shared';
import { api, artifactSnapshotsApi, setShareToken } from '../api';
import { SessionArtifacts } from './SessionArtifacts';

const ref: EventArtifactReference = { taskId: 'task', attemptId: 'attempt', eventId: 'event', sequence: 1, partIndex: 0, uri: 'file:///work/report.html', revision: 'event:event:1:0', status: 'recorded', source: 'structured_tool_result' };
const snapshot: ArtifactSnapshot = { version: 1, id: 'a'.repeat(64), sessionId: 'session', taskId: ref.taskId, attemptId: ref.attemptId, eventId: ref.eventId, sequence: ref.sequence, partIndex: ref.partIndex, revision: ref.revision, size: 25, sha256: 'b'.repeat(64), capturedAt: '2026-10-28T00:00:00.000Z', mimeType: 'text/plain', name: 'report.html' };
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); setShareToken(undefined); });
function history() {
  vi.spyOn(api, 'sessionHistory').mockResolvedValue({ turns: [{ id: 'turn', taskId: ref.taskId, attemptId: ref.attemptId, firstSequence: 1, lastSequence: 2, timestamp: '', status: 'completed', prompt: { text: 'Create report', truncated: false }, output: { text: '', truncated: false }, toolCount: 1, artifactReferences: [ref, { ...ref, partIndex: -1, eventId: 'private', uri: 'dutydeck-result:private', source: 'attachment_receipt', status: 'delivered' }] }], highWaterMark: 2, liveAfter: 2 });
}
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><SessionArtifacts sessionId="session"/></QueryClientProvider>);
}
it('captures only when clicked, previews escaped text and downloads immutable bytes while keeping the exact source link', async () => {
  history();
  let saved: ArtifactSnapshot[] = [];
  vi.spyOn(artifactSnapshotsApi, 'list').mockImplementation(async () => ({ snapshots: saved }));
  const capture = vi.spyOn(artifactSnapshotsApi, 'capture').mockImplementation(async () => { saved = [snapshot]; return snapshot; });
  vi.spyOn(artifactSnapshotsApi, 'preview').mockResolvedValue({ snapshot, text: '<script>window.pwned=true</script><svg onload="alert(1)"></svg>', truncated: true });
  const download = vi.spyOn(artifactSnapshotsApi, 'download').mockResolvedValue(new Blob(['immutable snapshot']));
  const NativeURL = URL;
  const createObjectURL = vi.fn(() => 'blob:immutable'); const revokeObjectURL = vi.fn();
  vi.stubGlobal('URL', class extends NativeURL { static createObjectURL = createObjectURL; static revokeObjectURL = revokeObjectURL; });
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  const source = vi.fn(); window.addEventListener('dutydeck:show-history-turn', source);
  try {
    const { container } = mount();
    await screen.findByText('Create report · 2 项');
    expect(capture).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Create report · 2 项'));
    expect(screen.getAllByRole('button', { name: '保存当前文件快照' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '保存当前文件快照' }));
    expect(await screen.findByText('report.html · 25 字节')).toBeTruthy();
    expect(capture).toHaveBeenCalledWith('session', { taskId: 'task', attemptId: 'attempt', eventId: 'event', sequence: 1, partIndex: 0, revision: 'event:event:1:0' });
    expect(screen.getByText(/这是点击保存时的内容/)).toBeTruthy(); expect(screen.getByText(`SHA-256 ${snapshot.sha256}`)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '查看快照文本' }));
    expect(await screen.findByText('<script>window.pwned=true</script><svg onload="alert(1)"></svg>')).toBeTruthy();
    expect(container.querySelector('script,svg,iframe,img')).toBeNull();
    expect(screen.getByText(/仅预览前 16,384 个字符/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '下载已保存快照' }));
    await waitFor(() => expect(download).toHaveBeenCalledWith('session', snapshot.id));
    await waitFor(() => expect(click).toHaveBeenCalledOnce()); expect(createObjectURL).toHaveBeenCalledOnce(); expect(revokeObjectURL).toHaveBeenCalledWith('blob:immutable');
    fireEvent.click(screen.getAllByRole('button', { name: '查看来源记录' }).at(-1)!);
    expect((source.mock.calls[0]![0] as CustomEvent).detail).toEqual({ taskId: 'task', attemptId: 'attempt', eventId: 'event', sequence: 1 });
  } finally { window.removeEventListener('dutydeck:show-history-turn', source); }
});

it('shows capture, preview and download errors without removing the recorded source', async () => {
  history(); vi.spyOn(artifactSnapshotsApi, 'list').mockResolvedValue({ snapshots: [snapshot] });
  vi.spyOn(artifactSnapshotsApi, 'capture').mockRejectedValue(new Error('来源版本已变化'));
  vi.spyOn(artifactSnapshotsApi, 'preview').mockRejectedValue(new Error('摘要不匹配'));
  vi.spyOn(artifactSnapshotsApi, 'download').mockRejectedValue(new Error('权限已撤销'));
  mount(); fireEvent.click(await screen.findByText('Create report · 2 项'));
  fireEvent.click(screen.getByRole('button', { name: '保存当前文件快照' })); expect(await screen.findByText('快照保存失败：来源版本已变化')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '查看快照文本' })); expect(await screen.findByText('快照读取失败：摘要不匹配')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '下载已保存快照' })); expect(await screen.findByText('快照下载失败：权限已撤销')).toBeTruthy();
  expect(screen.getAllByRole('button', { name: '查看来源记录' }).length).toBe(3);
});

it('keeps share viewers on source evidence without exposing snapshot controls or listing snapshots', async () => {
  history(); setShareToken('share-capability'); const list = vi.spyOn(artifactSnapshotsApi, 'list');
  mount(); fireEvent.click(await screen.findByText('Create report · 2 项'));
  expect(screen.queryByRole('button', { name: '保存当前文件快照' })).toBeNull(); expect(screen.queryByRole('button', { name: '下载已保存快照' })).toBeNull();
  expect(list).not.toHaveBeenCalled(); expect(screen.getAllByRole('button', { name: '查看来源记录' }).length).toBe(2);
});
