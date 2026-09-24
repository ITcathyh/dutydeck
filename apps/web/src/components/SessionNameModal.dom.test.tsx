// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, type Session } from '../api';
import { SessionNameModal } from './SessionNameModal';

const sampleSession = (overrides: Partial<Session> = {}): Session => ({
  id: 'ses-1',
  agentId: 'codex',
  state: 'idle',
  cwd: '/repo/dutydeck',
  runId: 'run-1',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  ...overrides
});

function renderModal({
  open = true,
  session = sampleSession(),
  onClose = vi.fn(),
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
}: {
  open?: boolean;
  session?: Session | null;
  onClose?(): void;
  client?: QueryClient;
} = {}) {
  client.setQueryData<Session[]>(['sessions'], [session ?? sampleSession(), sampleSession({ id: 'ses-2', name: '另一会话' })]);
  const view = render(
    <QueryClientProvider client={client}>
      <SessionNameModal open={open} session={session} onClose={onClose} />
    </QueryClientProvider>
  );
  return { ...view, client, onClose };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SessionNameModal 结构与交互规范', () => {
  it('渲染 Dialog label「重命名会话」，说明文案与指定 aria-label 的 Input', () => {
    renderModal({ session: sampleSession({ name: '当前名称' }) });
    expect(screen.getByRole('dialog', { name: '重命名会话' })).toBeTruthy();
    expect(screen.getByText('名称用于识别会话，不会修改原始对话。')).toBeTruthy();

    const input = screen.getByRole('textbox', { name: '会话名称' }) as HTMLInputElement;
    expect(input.value).toBe('当前名称');
    expect(input.maxLength).toBe(80);
  });

  it('初始未命名会话时保存与恢复默认名称均 disabled', () => {
    renderModal({ session: sampleSession({ name: undefined }) });
    const input = screen.getByRole('textbox', { name: '会话名称' }) as HTMLInputElement;
    expect(input.value).toBe('');
    expect((screen.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '恢复默认名称' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('已有名称且未修改时保存 disabled，恢复默认名称 enabled', () => {
    renderModal({ session: sampleSession({ name: '现有名称' }) });
    expect((screen.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '恢复默认名称' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('输入纯空白时保存 disabled', async () => {
    const user = userEvent.setup();
    renderModal({ session: sampleSession({ name: undefined }) });
    const input = screen.getByRole('textbox', { name: '会话名称' });
    await user.type(input, '    ');
    expect((screen.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('取消操作关闭弹窗且不调用 API', async () => {
    const user = userEvent.setup();
    const setSessionNameSpy = vi.spyOn(api, 'setSessionName');
    const onClose = vi.fn();
    renderModal({ onClose });

    await user.click(screen.getByRole('button', { name: '取消' }));
    expect(setSessionNameSpy).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('保存时自动 trim、调用 cancelQueries、更新 sessions 缓存的目标 name 并关窗', async () => {
    const user = userEvent.setup();
    const updatedSession: Session = sampleSession({ name: '新改的会话名' });
    const setSessionNameSpy = vi.spyOn(api, 'setSessionName').mockResolvedValue(updatedSession);
    const onClose = vi.fn();
    const client = new QueryClient();
    const cancelQueriesSpy = vi.spyOn(client, 'cancelQueries');

    renderModal({ session: sampleSession({ name: undefined }), onClose, client });

    const input = screen.getByRole('textbox', { name: '会话名称' });
    await user.type(input, '  新改的会话名  ');
    await user.click(screen.getByRole('button', { name: '保存' }));

    expect(setSessionNameSpy).toHaveBeenCalledWith('ses-1', '新改的会话名');
    expect(cancelQueriesSpy).toHaveBeenCalledTimes(2);
    expect(cancelQueriesSpy).toHaveBeenCalledWith({ queryKey: ['sessions'] });

    const cached = client.getQueryData<Session[]>(['sessions']);
    expect(cached?.find(s => s.id === 'ses-1')?.name).toBe('新改的会话名');
    expect(cached?.find(s => s.id === 'ses-2')?.name).toBe('另一会话');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('点击恢复默认名称发送 null、清除缓存中目标的 name 并关窗', async () => {
    const user = userEvent.setup();
    const clearedSession: Session = sampleSession({ name: undefined });
    const setSessionNameSpy = vi.spyOn(api, 'setSessionName').mockResolvedValue(clearedSession);
    const onClose = vi.fn();
    const client = new QueryClient();

    renderModal({ session: sampleSession({ name: '待清除的名字' }), onClose, client });

    await user.click(screen.getByRole('button', { name: '恢复默认名称' }));
    expect(setSessionNameSpy).toHaveBeenCalledWith('ses-1', null);

    const cached = client.getQueryData<Session[]>(['sessions']);
    expect(cached?.find(s => s.id === 'ses-1')?.name).toBeUndefined();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('按 Enter 可提交保存，未变时按 Enter 不触发保存', async () => {
    const user = userEvent.setup();
    const setSessionNameSpy = vi.spyOn(api, 'setSessionName').mockResolvedValue(sampleSession({ name: '回车保存' }));
    renderModal({ session: sampleSession({ name: undefined }) });

    const input = screen.getByRole('textbox', { name: '会话名称' });
    await user.type(input, '{Enter}');
    expect(setSessionNameSpy).not.toHaveBeenCalled();

    await user.type(input, '回车保存{Enter}');
    expect(setSessionNameSpy).toHaveBeenCalledWith('ses-1', '回车保存');
  });

  it('接口调用失败展示 Banner、保留用户输入且不关窗', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'setSessionName').mockRejectedValue(new Error('网络超时，修改失败'));
    const onClose = vi.fn();
    renderModal({ session: sampleSession({ name: undefined }), onClose });

    const input = screen.getByRole('textbox', { name: '会话名称' }) as HTMLInputElement;
    await user.type(input, '失败尝试');
    await user.click(screen.getByRole('button', { name: '保存' }));

    expect(await screen.findByText('网络超时，修改失败')).toBeTruthy();
    expect(input.value).toBe('失败尝试');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('pending 期间禁用所有操作控件，防止重复提交与关闭', async () => {
    const user = userEvent.setup();
    let resolveApi: (value: Session) => void = () => {};
    const pendingPromise = new Promise<Session>(resolve => {
      resolveApi = resolve;
    });
    const setSessionNameSpy = vi.spyOn(api, 'setSessionName').mockReturnValue(pendingPromise);

    renderModal({ session: sampleSession({ name: '旧名字' }) });
    const input = screen.getByRole('textbox', { name: '会话名称' });
    await user.clear(input);
    await user.type(input, '新名字');

    const saveBtn = screen.getByRole('button', { name: '保存' }) as HTMLButtonElement;
    await user.click(saveBtn);
    expect(setSessionNameSpy).toHaveBeenCalledTimes(1);

    // pending 期间控件应全禁用
    expect(saveBtn.disabled).toBe(true);
    expect((screen.getByRole('button', { name: '恢复默认名称' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '取消' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '关闭' }) as HTMLButtonElement).disabled).toBe(true);
    expect((input as HTMLInputElement).disabled).toBe(true);

    // 重复点击保存不产生多余请求
    await user.click(saveBtn);
    expect(setSessionNameSpy).toHaveBeenCalledTimes(1);

    // 按 Escape 不退出
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog', { name: '重命名会话' })).toBeTruthy();

    // 完成 API 调用
    await act(async () => {
      resolveApi(sampleSession({ name: '新名字' }));
    });
  });
});
