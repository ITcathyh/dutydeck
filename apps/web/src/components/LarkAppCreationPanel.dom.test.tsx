// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, type LarkAppCreationJob } from '../api';
import { LarkAppCreationPanel } from './LarkAppCreationPanel';

const pendingKey = 'dutydeck:lark-app-creation';
const id = '10000000-0000-4000-8000-000000000001';
const waiting = (requestId = id): LarkAppCreationJob => ({
  id: requestId, name: '研发助手', status: 'waiting_for_scan',
  qrDataUrl: 'data:image/png;base64,qr', retryable: false,
  createdAt: '2026-09-13T00:00:00.000Z', updatedAt: '2026-09-13T00:00:00.000Z',
});
function renderPanel(onCreated = vi.fn(async (_appId: string) => {})) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const busy = vi.fn();
  const rendered = render(<QueryClientProvider client={client}><LarkAppCreationPanel onCreated={onCreated} onBusyChange={busy}/></QueryClientProvider>);
  return { ...rendered, client, onCreated, busy };
}
afterEach(() => { cleanup(); sessionStorage.clear(); vi.restoreAllMocks(); });

describe('one-click Lark app creation', () => {
  it('waits for Chinese input composition to finish before treating Enter as create', async () => {
    const start = vi.spyOn(api, 'createLarkApp').mockImplementation(async input => waiting(input.requestId));
    vi.spyOn(api, 'larkAppCreationJob').mockImplementation(async requestId => waiting(requestId));
    renderPanel();
    const input = screen.getByLabelText('新机器人名称');
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });
    expect(start).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(start).toHaveBeenCalledOnce());
  });

  it('starts only on click, shows the QR, and opens the saved Bot after completion', async () => {
    const user = userEvent.setup();
    const start = vi.spyOn(api, 'createLarkApp').mockImplementation(async input => waiting(input.requestId));
    vi.spyOn(api, 'larkAppCreationJob').mockImplementation(async requestId => waiting(requestId));
    const { client, onCreated } = renderPanel();
    expect(start).not.toHaveBeenCalled();
    await user.clear(screen.getByLabelText('新机器人名称'));
    await user.type(screen.getByLabelText('新机器人名称'), '研发助手');
    await user.click(screen.getByRole('button', { name: '创建机器人' }));
    expect(await screen.findByAltText('创建机器人：飞书登录二维码')).toBeTruthy();
    expect(start).toHaveBeenCalledOnce();
    const request = start.mock.calls[0]![0];
    expect(request).toEqual({ requestId: expect.stringMatching(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/), name: '研发助手', forceLogin: false });
    expect(screen.queryByRole('button', { name: '创建机器人' })).toBeNull();
    expect(JSON.parse(sessionStorage.getItem(pendingKey)!)).toEqual(request);
    await act(async () => { client.setQueryData(['lark-app-creation', request.requestId], { ...waiting(request.requestId), status: 'completed', appId: 'cli_created', botSaved: true }); });
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('cli_created', true));
    await waitFor(() => expect(sessionStorage.getItem(pendingKey)).toBeNull());
    expect(onCreated).toHaveBeenCalledOnce();
    expect(document.body.textContent).not.toContain('appSecret');
  });

  it('reconnects with the same request ID when the start response was lost', async () => {
    const user = userEvent.setup();
    const start = vi.spyOn(api, 'createLarkApp').mockRejectedValueOnce(new Error('response lost')).mockImplementation(async input => waiting(input.requestId));
    vi.spyOn(api, 'larkAppCreationJob').mockRejectedValue(new Error('temporarily unavailable'));
    renderPanel();
    await user.click(screen.getByRole('button', { name: '创建机器人' }));
    await user.click(await screen.findByRole('button', { name: '重新连接' }));
    await screen.findByAltText('创建机器人：飞书登录二维码');
    expect(start).toHaveBeenCalledTimes(2);
    expect(start.mock.calls[1]![0]).toEqual(start.mock.calls[0]![0]);
  });

  it('restores polling after reopening without submitting another create or cancelling the job', async () => {
    sessionStorage.setItem(pendingKey, JSON.stringify({ requestId: id, name: '研发助手' }));
    const start = vi.spyOn(api, 'createLarkApp');
    const cancel = vi.spyOn(api, 'cancelLarkAppCreation');
    const poll = vi.spyOn(api, 'larkAppCreationJob').mockResolvedValue(waiting());
    const { unmount } = renderPanel();
    await screen.findByAltText('创建机器人：飞书登录二维码');
    expect(poll).toHaveBeenCalledWith(id);
    unmount();
    expect(start).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(pendingKey)).not.toBeNull();
  });

  it('keeps a created app on failure and offers its saved Bot instead of creating again', async () => {
    const user = userEvent.setup();
    sessionStorage.setItem(pendingKey, JSON.stringify({ requestId: id, name: '研发助手' }));
    const start = vi.spyOn(api, 'createLarkApp');
    const retry = vi.spyOn(api, 'retryLarkAppCreation');
    vi.spyOn(api, 'larkAppCreationJob').mockResolvedValue({ ...waiting(), status: 'failed', appId: 'cli_existing', botSaved: true, retryable: false, error: '发布结果尚未确认' });
    const { onCreated } = renderPanel();
    await user.click(await screen.findByRole('button', { name: '继续配置已创建的机器人' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('cli_existing', false));
    expect(screen.queryByRole('button', { name: '重试本次创建' })).toBeNull();
    expect(start).not.toHaveBeenCalled();
    expect(retry).not.toHaveBeenCalled();
  });

  it('retries a safe failure using the existing job', async () => {
    const user = userEvent.setup();
    sessionStorage.setItem(pendingKey, JSON.stringify({ requestId: id, name: '研发助手' }));
    const start = vi.spyOn(api, 'createLarkApp');
    vi.spyOn(api, 'larkAppCreationJob').mockResolvedValue({ ...waiting(), status: 'failed', appId: 'cli_existing', retryable: true, error: '凭据暂时不可读' });
    const retry = vi.spyOn(api, 'retryLarkAppCreation').mockResolvedValue(waiting());
    renderPanel();
    await user.click(await screen.findByRole('button', { name: '重试本次创建' }));
    expect(retry).toHaveBeenCalledWith(id, false);
    expect(start).not.toHaveBeenCalled();
  });

  it('shows submitted review without a retry or new-create action and permits Agent setup', async () => {
    const user = userEvent.setup();
    sessionStorage.setItem(pendingKey, JSON.stringify({ requestId: id, name: '研发助手' }));
    const start = vi.spyOn(api, 'createLarkApp');
    const retry = vi.spyOn(api, 'retryLarkAppCreation');
    vi.spyOn(api, 'larkAppCreationJob').mockResolvedValue({ ...waiting(), status: 'pending_review', appId: 'cli_existing', botSaved: true });
    const { onCreated, busy } = renderPanel();
    await screen.findByText(/正在等待飞书管理员审核/);
    expect(screen.getByRole('link', { name: '查看审核进度' }).getAttribute('href')).toBe('https://open.larkoffice.com/app/cli_existing');
    expect(screen.queryByRole('button', { name: '重试本次创建' })).toBeNull();
    expect(screen.queryByRole('button', { name: '已核对，开始新的创建' })).toBeNull();
    await waitFor(() => expect(busy).toHaveBeenLastCalledWith(false));
    await user.click(screen.getByRole('button', { name: '继续配置已创建的机器人' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('cli_existing', true, true));
    expect(start).not.toHaveBeenCalled();
    expect(retry).not.toHaveBeenCalled();
  });

  it('cancels a waiting QR and does not let an older poll restore it', async () => {
    const user = userEvent.setup();
    sessionStorage.setItem(pendingKey, JSON.stringify({ requestId: id, name: '研发助手' }));
    let release!: (job: LarkAppCreationJob) => void;
    const poll = vi.spyOn(api, 'larkAppCreationJob').mockResolvedValueOnce(waiting()).mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const cancel = vi.spyOn(api, 'cancelLarkAppCreation').mockResolvedValue({ ...waiting(), status: 'cancelled' });
    const { client } = renderPanel();
    await screen.findByAltText('创建机器人：飞书登录二维码');
    void client.invalidateQueries({ queryKey: ['lark-app-creation', id] });
    await waitFor(() => expect(poll).toHaveBeenCalledTimes(2));
    await user.click(screen.getByRole('button', { name: '取消创建' }));
    await screen.findByText('已取消创建，尚未创建飞书应用。');
    await act(async () => { release(waiting()); });
    expect(cancel).toHaveBeenCalledWith(id);
    expect(screen.queryByAltText('创建机器人：飞书登录二维码')).toBeNull();
    expect(screen.getByText('已取消创建，尚未创建飞书应用。')).toBeTruthy();
  });
});

it('allows choosing another account before creation and keeps that choice on reconnect', async () => {
  const start = vi.spyOn(api, 'createLarkApp').mockRejectedValueOnce(new Error('response lost')).mockImplementation(async input => waiting(input.requestId));
  vi.spyOn(api, 'larkAppCreationJob').mockRejectedValue(new Error('temporarily unavailable'));
  renderPanel();
  fireEvent.click(screen.getByRole('checkbox', { name: '使用其他账号，重新扫码登录' }));
  fireEvent.click(screen.getByRole('button', { name: '创建机器人' }));
  fireEvent.click(await screen.findByRole('button', { name: '重新连接' }));
  await waitFor(() => expect(start).toHaveBeenCalledTimes(2));
  expect(start.mock.calls[0]![0]).toMatchObject({ forceLogin: true });
  expect(start.mock.calls[1]![0]).toEqual(start.mock.calls[0]![0]);
});

it('can request a fresh scan only for a safe retry of the same job', async () => {
  sessionStorage.setItem(pendingKey, JSON.stringify({ requestId: id, name: '研发助手' }));
  const start = vi.spyOn(api, 'createLarkApp');
  vi.spyOn(api, 'larkAppCreationJob').mockResolvedValue({ ...waiting(), status: 'failed', appId: 'cli_existing', retryable: true });
  const retry = vi.spyOn(api, 'retryLarkAppCreation').mockResolvedValue(waiting());
  renderPanel();
  fireEvent.click(await screen.findByRole('button', { name: '重新扫码后重试' }));
  await waitFor(() => expect(retry).toHaveBeenCalledWith(id, true));
  expect(start).not.toHaveBeenCalled();
});
