// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError, scheduleApi, type ScheduleCapability, type ScheduleList } from '../api';
import { ScheduleFoundationPanel } from './ScheduleFoundationPanel';

const timestamp = '2026-08-30T00:00:00.000Z';
const ready: ScheduleCapability = { schemaVersion: 1, repositoriesWired: true, permissionEvaluatorWired: true, writesEnabled: true, executorWired: false, uiEntryReady: false, readiness: 'offline_management_ready', blockers: [{ code: 'schedule_executor_unavailable', message: 'No executor', action: 'Keep disabled' }, { code: 'schedule_ui_entry_unwired', message: 'No UI entry', action: 'Single shell owner mounts it' }] };
const list: ScheduleList = { capabilities: ready, schedules: [{
  definition: { schemaVersion: 1, id: 'schedule-ui', revision: 1, channelBotId: 'bot-ui', name: 'Morning review', trigger: { kind: 'cron', expression: '0 9 * * 1-5' }, timezone: 'Asia/Shanghai', dstPolicy: { gap: 'skip', overlap: 'first' }, delivery: { mode: 'chat', continuation: 'chat_root', destinationConfigured: true, threadRootConfigured: false }, workspaceConfigured: true, payloadConfigured: true, identityConfigured: false, secretRefConfigured: false, sourceOwnership: 'botmux', sourceEnabled: true, state: 'staged', desiredExecutorState: 'disabled', currentGeneration: 1, createdAt: timestamp, updatedAt: timestamp },
  readiness: { executionEligible: false, nextOccurrence: { scheduledForUtc: '2026-08-31T01:00:00.000Z', localLabel: '2026-08-31T09:00:00', timezone: 'Asia/Shanghai', dstResolution: 'exact' }, blockers: [{ code: 'schedule_identity_required', message: 'Identity missing', action: 'Bind identity' }, { code: 'schedule_secret_ref_required', message: 'SecretRef missing', action: 'Bind SecretRef' }, { code: 'schedule_executor_unavailable', message: 'No executor', action: 'Keep disabled' }] }
}] };

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><ScheduleFoundationPanel open onClose={() => {}}/></QueryClientProvider>);
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('ScheduleFoundationPanel offline-only journey', () => {
  it('renders repository wiring as a machine-readable blocked state without loading definitions', async () => {
    vi.spyOn(scheduleApi, 'capabilities').mockResolvedValue({ ...ready, repositoriesWired: false, permissionEvaluatorWired: false, writesEnabled: false, readiness: 'repository_unwired', blockers: [{ code: 'schedule_repository_unwired', message: 'Repository missing', action: 'Inject v13 repositories' }] });
    const listSpy = vi.spyOn(scheduleApi, 'list');
    renderPanel();
    expect(await screen.findByText('Schedule v13 仓储尚未注入')).toBeTruthy();
    expect(screen.getByText('schedule_repository_unwired')).toBeTruthy();
    expect(listSpy).not.toHaveBeenCalled();
  });

  it('shows next trigger, prerequisites and typed Hammer archive without an execution control', async () => {
    vi.spyOn(scheduleApi, 'capabilities').mockResolvedValue(ready);
    vi.spyOn(scheduleApi, 'list').mockResolvedValue(list);
    vi.spyOn(scheduleApi, 'archivedIntegrations').mockResolvedValue({ integrations: [{ schemaVersion: 1, id: 'hammer-ui', revision: 1, channelBotId: 'bot-ui', kind: 'hammer', sourceSystem: 'botmux', sourceEnabled: true, mode: 'full', enforceGates: true, skillsInjection: 'prompt', state: 'archived', executorState: 'unavailable', blockerCode: 'hammer_executor_unavailable', createdAt: timestamp, updatedAt: timestamp }] });
    renderPanel();
    expect(await screen.findByText('Morning review')).toBeTruthy();
    expect(screen.getByText(/2026-08-31T09:00:00/)).toBeTruthy();
    expect(screen.getByText(/schedule_identity_required/)).toBeTruthy();
    expect(await screen.findByText('Hammer · typed archived metadata')).toBeTruthy();
    expect(screen.getByText(/mode full · gates enforced · skills prompt/)).toBeTruthy();
    expect(screen.getByText(/hammer_executor_unavailable · 尚未承接执行器/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /enable|启用|run.now|立即运行|激活/i })).toBeNull();
  });

  it('edits by CAS while preserving staged/disabled state', async () => {
    vi.spyOn(scheduleApi, 'capabilities').mockResolvedValue(ready);
    vi.spyOn(scheduleApi, 'list').mockResolvedValue(list);
    vi.spyOn(scheduleApi, 'archivedIntegrations').mockResolvedValue({ integrations: [] });
    const update = vi.spyOn(scheduleApi, 'update').mockResolvedValue({ ...list.schedules[0]!, definition: { ...list.schedules[0]!.definition, revision: 2, name: 'Edited review', state: 'disabled', currentGeneration: 2 } });
    renderPanel();
    await userEvent.click(await screen.findByRole('button', { name: '编辑禁用态定义' }));
    const name = screen.getByRole('textbox', { name: 'Schedule 名称' });
    await userEvent.clear(name);
    await userEvent.type(name, 'Edited review');
    await userEvent.click(screen.getByRole('button', { name: '保存 staged/disabled 定义' }));
    await waitFor(() => expect(update).toHaveBeenCalledWith('schedule-ui', { expectedRevision: 1, name: 'Edited review', timezone: 'Asia/Shanghai', dstPolicy: { gap: 'skip', overlap: 'first' }, state: 'staged' }));
  });

  it('preserves the Schedule draft and rebases it after a CAS conflict', async () => {
    vi.spyOn(scheduleApi, 'capabilities').mockResolvedValue(ready);
    vi.spyOn(scheduleApi, 'list').mockResolvedValue(list);
    vi.spyOn(scheduleApi, 'archivedIntegrations').mockResolvedValue({ integrations: [] });
    const current = { ...list.schedules[0]!, definition: { ...list.schedules[0]!.definition, revision: 2, name: 'Concurrent edit' } };
    const update = vi.spyOn(scheduleApi, 'update').mockRejectedValueOnce(new ApiError('stale revision', 'SCHEDULE_REVISION_CONFLICT', 409, current)).mockResolvedValueOnce({ ...current, definition: { ...current.definition, revision: 3, name: 'My preserved draft' } });
    renderPanel();
    await userEvent.click(await screen.findByRole('button', { name: '编辑禁用态定义' }));
    const name = screen.getByRole('textbox', { name: 'Schedule 名称' });
    await userEvent.clear(name);
    await userEvent.type(name, 'My preserved draft');
    await userEvent.click(screen.getByRole('button', { name: '保存 staged/disabled 定义' }));
    expect(await screen.findByText(/定义已被其他修改更新/)).toBeTruthy();
    expect((name as HTMLInputElement).value).toBe('My preserved draft');
    await userEvent.click(screen.getByRole('button', { name: /基于新版本重试/ }));
    await userEvent.click(screen.getByRole('button', { name: '保存 staged/disabled 定义' }));
    await waitFor(() => expect(update).toHaveBeenLastCalledWith('schedule-ui', expect.objectContaining({ expectedRevision: 2, name: 'My preserved draft' })));
  });
});
