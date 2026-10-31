import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
});
