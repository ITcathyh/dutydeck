import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError, collaborationApi, type CollaborationDuty, type CollaborationScenario } from '../api';
import { GroupDutySettings } from './GroupDutySettings';

const now = '2026-10-31T00:00:00.000Z';
const duty = (revision: number, patch: Partial<CollaborationDuty> = {}): CollaborationDuty => ({ scope: { appId: 'bot', chatId: 'group' }, revision, updatedAt: now, ...patch });
const scenario = (id: string, enabled: boolean, topics: string[] = []): CollaborationScenario => ({
  id, title: id, version: '1.0.0', description: id, mode: 'model',
  params: { topics: { type: 'string_list', label: `${id} 关键字`, maxItems: 10, maxLength: 32, default: [] } },
  binding: { enabled, params: { topics }, packVersion: '1.0.0' }, requiresRequester: false, versionStale: false, plugin: id, builtin: false
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function mount(initial: CollaborationDuty, scenarios: CollaborationScenario[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const onSaved = vi.fn(async () => {});
  const ui = (current: CollaborationDuty, packs: CollaborationScenario[]) => <QueryClientProvider client={client}>
    <GroupDutySettings appId="bot" chatId="group" duty={current} scenarios={packs} onSaved={onSaved}/>
  </QueryClientProvider>;
  const view = render(ui(initial, scenarios));
  // Background refresh (e.g. window focus) passes newer props to the same mounted editor.
  return { refresh: (current: CollaborationDuty, packs: CollaborationScenario[]) => view.rerender(ui(current, packs)), onSaved };
}
const save = () => fireEvent.click(screen.getByRole('button', { name: '保存分工' }));

describe('group duty draft revision', () => {
  it('submits only the edited pack against the revision it was edited from', async () => {
    const update = vi.spyOn(collaborationApi, 'updateDuty').mockResolvedValue({ duty: duty(2) });
    mount(duty(1), [scenario('A', false), scenario('B', false)]);
    fireEvent.click(screen.getByRole('checkbox', { name: 'A A' }));
    save();
    await waitFor(() => expect(update).toHaveBeenCalledWith('bot', 'group', { expectedRevision: 1, scenarios: { A: { enabled: true } } }));
  });

  it('keeps the edit-start revision after a background refresh, so a pack enabled elsewhere is not switched back off', async () => {
    const update = vi.spyOn(collaborationApi, 'updateDuty').mockRejectedValue(new ApiError('群分工已变化，请刷新后再改。', 'COLLABORATION_REVISION_CONFLICT', 409));
    const view = mount(duty(1), [scenario('A', false), scenario('B', false)]);
    fireEvent.click(screen.getByRole('checkbox', { name: 'A A' }));
    view.refresh(duty(2, { scenarios: { B: { enabled: true, params: {}, packVersion: '1.0.0' } } }), [scenario('A', false), scenario('B', true)]);
    save();
    await waitFor(() => expect(update).toHaveBeenCalledOnce());
    expect(update).toHaveBeenCalledWith('bot', 'group', { expectedRevision: 1, scenarios: { A: { enabled: true } } });
    expect(await screen.findByText('群分工已被修改，请放弃修改后重新编辑。')).toBeTruthy();
    // The conflict keeps the user's own edit on screen.
    expect((screen.getByRole('checkbox', { name: 'A A' }) as HTMLInputElement).checked).toBe(true);
  });

  it('does not clear a responder another bot claimed while the user edited a pack', async () => {
    const update = vi.spyOn(collaborationApi, 'updateDuty').mockResolvedValue({ duty: duty(3) });
    const view = mount(duty(1), [scenario('A', false)]);
    fireEvent.click(screen.getByRole('checkbox', { name: 'A A' }));
    view.refresh(duty(2, { responder: { appId: 'cli_other', name: 'Other bot', since: now } }), [scenario('A', false)]);
    save();
    await waitFor(() => expect(update).toHaveBeenCalledOnce());
    expect(update.mock.calls[0]![2]).toEqual({ expectedRevision: 1, scenarios: { A: { enabled: true } } });
  });

  it('compares edited parameters with the values the edit started from', async () => {
    const update = vi.spyOn(collaborationApi, 'updateDuty').mockResolvedValue({ duty: duty(3) });
    const view = mount(duty(1), [scenario('A', true, ['部署']), scenario('B', true, ['发布'])]);
    fireEvent.change(screen.getByLabelText('A 关键字'), { target: { value: '部署, 回滚' } });
    view.refresh(duty(2), [scenario('A', true, ['部署']), scenario('B', true, ['发布', '值班'])]);
    save();
    await waitFor(() => expect(update).toHaveBeenCalledOnce());
    expect(update.mock.calls[0]![2]).toEqual({ expectedRevision: 1, scenarios: { A: { enabled: true, params: { topics: ['部署', '回滚'] } } } });
  });

  it('starts a new edit from the refreshed revision after discarding the stale draft', async () => {
    const update = vi.spyOn(collaborationApi, 'updateDuty').mockResolvedValue({ duty: duty(3) });
    const view = mount(duty(1), [scenario('A', false), scenario('B', false)]);
    fireEvent.click(screen.getByRole('checkbox', { name: 'A A' }));
    view.refresh(duty(2), [scenario('A', false), scenario('B', true)]);
    fireEvent.click(screen.getByRole('button', { name: '放弃修改' }));
    expect((screen.getByRole('checkbox', { name: 'B B' }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: 'A A' }));
    save();
    await waitFor(() => expect(update).toHaveBeenCalledWith('bot', 'group', { expectedRevision: 2, scenarios: { A: { enabled: true } } }));
  });

  it('keeps parameters edited while saving and rebases the next submission on the saved draft', async () => {
    let finish!: () => void;
    let calls = 0;
    let revision = 1;
    let savedTopics: string[] = [];
    const update = vi.spyOn(collaborationApi, 'updateDuty').mockImplementation(async () => {
      calls += 1;
      if (calls === 1) await new Promise<void>(done => { finish = done; });
      revision += 1;
      savedTopics = calls === 1 ? ['部署'] : ['部署', '回滚'];
      return { duty: duty(revision) };
    });
    const view = mount(duty(1), [scenario('A', true)]);
    view.onSaved.mockImplementation(async () => view.refresh(duty(revision), [scenario('A', true, savedTopics)]));
    fireEvent.change(screen.getByLabelText('A 关键字'), { target: { value: '部署' } });
    save();
    await waitFor(() => expect(update).toHaveBeenCalledOnce());
    fireEvent.change(screen.getByLabelText('A 关键字'), { target: { value: '部署, 回滚' } });
    finish();
    await waitFor(() => expect((screen.getByRole('button', { name: '保存分工' }) as HTMLButtonElement).disabled).toBe(false));
    expect((screen.getByLabelText('A 关键字') as HTMLInputElement).value).toBe('部署, 回滚');
    save();
    await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
    expect(update.mock.calls[1]?.[2]).toEqual({ expectedRevision: 2, scenarios: { A: { enabled: true, params: { topics: ['部署', '回滚'] } } } });
    await waitFor(() => expect((screen.getByRole('button', { name: '保存分工' }) as HTMLButtonElement).disabled).toBe(true));
  });
});

it('previews edited parameters before saving and displays the full report', async () => {
  const update = vi.spyOn(collaborationApi, 'updateDuty');
  const preview = vi.spyOn(collaborationApi, 'previewScenario').mockResolvedValue({
    status: 'ok', mode: 'model', limit: 75, matched: 1, skipped: 1, note: '是否回复由模型逐条判断，预演不调用模型。',
    messages: [
      { messageId: 'one', at: now, senderKind: 'human', excerpt: '部署问题', matched: true, reason: 'participation_observes', detail: '通过场景规则' },
      { messageId: 'two', at: now, senderKind: 'bot', excerpt: '部署通知', matched: false, reason: 'bot_message', detail: '模型场景只看真人消息' }
    ]
  });
  mount(duty(1), [scenario('A', false)]);
  fireEvent.change(screen.getByLabelText('A 关键字'), { target: { value: '部署' } });
  fireEvent.change(screen.getByLabelText('预演条数'), { target: { value: '75' } });
  fireEvent.click(screen.getByRole('button', { name: '预演' }));
  expect(await screen.findByText('部署通知')).toBeTruthy();
  expect(screen.getByText('部署问题')).toBeTruthy();
  expect(screen.getByText('是否回复由模型逐条判断，预演不调用模型。')).toBeTruthy();
  expect(preview).toHaveBeenCalledWith('bot', 'group', 'A', { params: { topics: ['部署'] }, limit: 75 });
  expect(update).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('A 关键字'), { target: { value: '发布' } });
  expect(screen.queryByText('部署通知')).toBeNull();
  preview.mockResolvedValue({ status: 'unavailable', message: '无法读取群历史，请检查 im:message:readonly。' });
  fireEvent.click(screen.getByRole('button', { name: '预演' }));
  expect(await screen.findByText('无法读取群历史，请检查 im:message:readonly。')).toBeTruthy();
  expect((screen.getByRole('button', { name: '保存分工' }) as HTMLButtonElement).disabled).toBe(false);
});

it('clears the preview when the responder or another scenario draft changes', async () => {
  const preview = vi.spyOn(collaborationApi, 'previewScenario').mockResolvedValue({
    status: 'ok', mode: 'direct', limit: 50, matched: 1, skipped: 0,
    messages: [{ messageId: 'one', at: now, senderKind: 'bot', excerpt: '部署通知', matched: true, reason: 'participation_observes',
      detail: '这个场景还要经插件判断，预演不调用插件' }]
  });
  mount(duty(1), [scenario('A', false), scenario('B', true)]);
  const runPreview = () => fireEvent.click(screen.getAllByRole('button', { name: '预演' })[0]!);
  runPreview();
  expect(await screen.findByText('部署通知')).toBeTruthy();
  fireEvent.change(screen.getByRole('combobox', { name: '接话人' }), { target: { value: 'self' } });
  expect(screen.queryByText('部署通知')).toBeNull();
  fireEvent.change(screen.getByRole('combobox', { name: '接话人' }), { target: { value: 'none' } });
  expect(screen.queryByText('部署通知')).toBeNull();
  runPreview();
  expect(await screen.findByText('部署通知')).toBeTruthy();

  fireEvent.change(screen.getByLabelText('B 关键字'), { target: { value: '发布' } });
  expect(screen.queryByText('部署通知')).toBeNull();
  runPreview();
  expect(await screen.findByText('接话人和其他场景按已保存的设置计算。')).toBeTruthy();
  expect(screen.queryAllByText(/会接手/)).toHaveLength(0);
  expect(preview).toHaveBeenLastCalledWith('bot', 'group', 'A', { params: { topics: [] }, limit: 50 });
  fireEvent.click(screen.getByRole('button', { name: '放弃修改' }));
  expect(screen.queryByText('部署通知')).toBeNull();
});

it('ignores a preview that returns after a change to a different scenario', async () => {
  let resolve!: (result: Awaited<ReturnType<typeof collaborationApi.previewScenario>>) => void;
  const preview = vi.spyOn(collaborationApi, 'previewScenario').mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  mount(duty(1), [scenario('A', false), scenario('B', true)]);
  fireEvent.click(screen.getAllByRole('button', { name: '预演' })[0]!);
  await waitFor(() => expect(preview).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole('checkbox', { name: 'B B' }));
  await act(async () => resolve({ status: 'unavailable', message: '作废的预演结果' }));
  expect(screen.queryByText('作废的预演结果')).toBeNull();
});
