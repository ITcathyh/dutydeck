// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { api, UNAUTHORIZED_EVENT } from '../api';
import { AuthGate } from './AuthGate';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('AuthGate', () => {
  it('keeps local access frictionless', async () => {
    vi.spyOn(api, 'authStatus').mockResolvedValue({ authenticated: true, required: false });
    render(<AuthGate><div>工作台内容</div></AuthGate>);
    expect(await screen.findByText('工作台内容')).toBeTruthy();
    expect(screen.queryByText('退出远程访问')).toBeNull();
  });

  it('logs a remote browser in without retaining the token in the rendered UI', async () => {
    vi.spyOn(api, 'authStatus').mockResolvedValue({ authenticated: false, required: true });
    const login = vi.spyOn(api, 'login').mockResolvedValue({ authenticated: true, required: true });
    render(<AuthGate><div>远程工作台</div></AuthGate>);
    const input = await screen.findByLabelText('访问令牌');
    await userEvent.type(input, 'remote-secret');
    await userEvent.click(screen.getByRole('button', { name: '连接工作台' }));
    expect(login).toHaveBeenCalledWith('remote-secret');
    expect(await screen.findByText('远程工作台')).toBeTruthy();
    expect(document.body.textContent).not.toContain('remote-secret');
    expect(screen.getByRole('button', { name: '退出远程访问' })).toBeTruthy();
  });

  it('returns to login when the server reports a rotated or invalid credential', async () => {
    vi.spyOn(api, 'authStatus').mockResolvedValue({ authenticated: true, required: true });
    render(<AuthGate><div>受保护内容</div></AuthGate>);
    expect(await screen.findByText('受保护内容')).toBeTruthy();
    window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    await waitFor(() => expect(screen.getByRole('heading', { name: '连接到这台 Dutydeck' })).toBeTruthy());
    expect(screen.queryByText('受保护内容')).toBeNull();
  });

  it('clears the remote cookie through logout', async () => {
    vi.spyOn(api, 'authStatus').mockResolvedValue({ authenticated: true, required: true });
    const logout = vi.spyOn(api, 'logout').mockResolvedValue({ authenticated: false, required: true });
    render(<AuthGate><div>受保护内容</div></AuthGate>);
    await userEvent.click(await screen.findByRole('button', { name: '退出远程访问' }));
    expect(logout).toHaveBeenCalledOnce();
    expect(await screen.findByLabelText('访问令牌')).toBeTruthy();
  });
});
