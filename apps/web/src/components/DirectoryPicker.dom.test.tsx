import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, type SystemDirectoriesResult } from '../api';
import { DirectoryPicker } from './DirectoryPicker';

afterEach(() => vi.restoreAllMocks());

const mockDirData: SystemDirectoriesResult = {
  path: '/home/user/projects',
  parent: '/home/user',
  roots: ['/home/user', '/data00'],
  host: 'local-test-host',
  entries: [
    { name: 'app-frontend', path: '/home/user/projects/app-frontend' },
    { name: 'app-backend', path: '/home/user/projects/app-backend' }
  ]
};

function renderWithClient(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe('DirectoryPicker', () => {
  it('支持直接手动输入路径', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithClient(<DirectoryPicker value="/data" onChange={onChange} />);

    const input = screen.getByPlaceholderText(/请输入或选择目录路径/);
    await user.type(input, '/my-project');
    expect(onChange).toHaveBeenCalled();
  });

  it('点击浏览打开服务器目录浏览器，选择子目录并确认', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const spy = vi.spyOn(api, 'systemDirectories').mockResolvedValue(mockDirData);

    renderWithClient(<DirectoryPicker value="/home/user/projects" onChange={onChange} />);

    const browseBtn = screen.getByRole('button', { name: /浏览/ });
    await user.click(browseBtn);

    expect(screen.getByRole('dialog', { name: '选择服务器目录' })).toBeTruthy();
    await waitFor(() => expect(spy).toHaveBeenCalledWith('/home/user/projects'));

    // 查看子目录条目
    expect(screen.getByText('app-frontend')).toBeTruthy();
    expect(screen.getByText('app-backend')).toBeTruthy();
    expect(screen.getByText('local-test-host')).toBeTruthy();

    // 点击确认当前目录
    const selectCurrentBtn = screen.getByRole('button', { name: /选择此目录/ });
    await user.click(selectCurrentBtn);

    expect(onChange).toHaveBeenCalledWith('/home/user/projects');
    expect(screen.queryByRole('dialog', { name: '选择服务器目录' })).toBeNull();
  });

  it('支持返回上一级和根目录跳转', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const spy = vi.spyOn(api, 'systemDirectories').mockImplementation(async (path?: string) => {
      if (path === '/home/user') {
        return {
          path: '/home/user',
          parent: '/home',
          roots: ['/home/user', '/data00'],
          host: 'local-test-host',
          entries: [{ name: 'projects', path: '/home/user/projects' }]
        };
      }
      return mockDirData;
    });

    renderWithClient(<DirectoryPicker value="/home/user/projects" onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: /浏览/ }));

    await waitFor(() => expect(screen.getByText('app-frontend')).toBeTruthy());

    // 点击返回上一级
    const parentBtn = screen.getByRole('button', { name: /返回上一级/ });
    await user.click(parentBtn);

    await waitFor(() => expect(spy).toHaveBeenCalledWith('/home/user'));
    expect(screen.getByText('projects')).toBeTruthy();
  });

  it('加载失败时展示错误提示与重试按钮', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'systemDirectories').mockRejectedValue(new Error('Permission denied'));

    renderWithClient(<DirectoryPicker value="/restricted" onChange={() => {}} />);
    await user.click(screen.getByRole('button', { name: /浏览/ }));

    await waitFor(() => {
      expect(screen.getByText(/无法读取目录：Permission denied/)).toBeTruthy();
    });
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
  });
});

/*
  只有服务端成功返回的目录才可选。

  原先按钮读的是 `currentData?.path ?? browsingPath`：403/404 时 currentData 为空，
  browsingPath 仍是用户输入的那串字符，于是一个不存在或没权限的目录被当成「已选好」
  写回表单，真正的失败要等到 Agent 启动时才暴露。
*/
describe('DirectoryPicker 只允许选已确认的目录', () => {
  it('目录读取失败时按钮禁用，点击不会写回任何路径', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    vi.spyOn(api, 'systemDirectories').mockRejectedValue(new Error('Permission denied'));

    renderWithClient(<DirectoryPicker value="/restricted/secret" onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: /浏览/ }));
    await waitFor(() => expect(screen.getByText(/无法读取目录：Permission denied/)).toBeTruthy());

    const selectBtn = screen.getByRole('button', { name: /选择此目录/ }) as HTMLButtonElement;
    expect(selectBtn.disabled).toBe(true);
    await user.click(selectBtn);
    expect(onChange).not.toHaveBeenCalled();
    // 失败时对话框留在原地，用户还能重试或换个目录，而不是被静默关掉。
    expect(screen.getByRole('dialog', { name: '选择服务器目录' })).toBeTruthy();
  });

  it('请求还在飞的时候不能选，返回成功后才放行且用服务端确认的路径', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    let release!: (value: SystemDirectoriesResult) => void;
    vi.spyOn(api, 'systemDirectories').mockImplementation(
      () => new Promise<SystemDirectoriesResult>(resolve => { release = resolve; })
    );

    renderWithClient(<DirectoryPicker value="/home/user/projects" onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: /浏览/ }));

    // 加载中：browsingPath 还没有任何人确认过。
    const selectBtn = screen.getByRole('button', { name: /选择此目录/ }) as HTMLButtonElement;
    expect(selectBtn.disabled).toBe(true);
    await user.click(selectBtn);
    expect(onChange).not.toHaveBeenCalled();

    // 服务端返回的是规范化后的路径（realpath），写回的必须是它，不是用户敲的那串。
    release({ ...mockDirData, path: '/home/user/projects-real' });
    await waitFor(() => expect((screen.getByRole('button', { name: /选择此目录/ }) as HTMLButtonElement).disabled).toBe(false));
    await user.click(screen.getByRole('button', { name: /选择此目录/ }));
    expect(onChange).toHaveBeenCalledWith('/home/user/projects-real');
  });
});
