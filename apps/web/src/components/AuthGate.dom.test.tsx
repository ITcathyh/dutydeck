// @vitest-environment jsdom
import { createRequire } from 'node:module';
import { URL as NodeURL } from 'node:url';
import { AUTH_COOKIE_NAME, hashPassword, registerBrowserAuthRoutes } from '../../../server/src/auth/auth';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { api, ApiError, UNAUTHORIZED_EVENT } from '../api';
import { AuthGate, RemoteAccessLogout } from './AuthGate';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('AuthGate', () => {
  it('keeps local access frictionless', async () => {
    vi.spyOn(api, 'authStatus').mockResolvedValue({ authenticated: true, required: false });
    render(<AuthGate><RemoteAccessLogout/><div>工作台内容</div></AuthGate>);
    expect(await screen.findByText('工作台内容')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '退出远程访问' })).toBeNull();
  });

  it('logs a remote browser in without retaining the token in the rendered UI', async () => {
    vi.spyOn(api, 'authStatus').mockResolvedValue({ authenticated: false, required: true });
    const login = vi.spyOn(api, 'login').mockResolvedValue({ authenticated: true, required: true });
    render(<AuthGate><RemoteAccessLogout/><div>远程工作台</div></AuthGate>);
    const input = await screen.findByLabelText('访问令牌');
    await userEvent.type(input, 'remote-secret');
    await userEvent.click(screen.getByRole('button', { name: '连接工作台' }));
    expect(login).toHaveBeenCalledWith('remote-secret');
    expect(await screen.findByText('远程工作台')).toBeTruthy();
    expect(document.body.textContent).not.toContain('remote-secret');
    expect(screen.getByRole('button', { name: '退出远程访问' })).toBeTruthy();
  });

  it('设了访问密码时用密码登录，密码原样提交', async () => {
    vi.spyOn(api, 'authStatus').mockResolvedValue({ authenticated: false, required: true, password: true });
    const passwordLogin = vi.spyOn(api, 'passwordLogin').mockResolvedValue({ authenticated: true, required: true, password: true });
    const login = vi.spyOn(api, 'login');
    render(<AuthGate><div>远程工作台</div></AuthGate>);
    await userEvent.type(await screen.findByLabelText('访问密码'), ' my pass ');
    await userEvent.click(screen.getByRole('button', { name: '连接工作台' }));
    expect(passwordLogin).toHaveBeenCalledWith(' my pass ');
    expect(login).not.toHaveBeenCalled();
    expect(await screen.findByText('远程工作台')).toBeTruthy();
    expect(document.body.textContent).not.toContain('my pass');
  });

  it('密码错误和限流给出不同提示，失效后回到密码登录', async () => {
    vi.spyOn(api, 'authStatus').mockResolvedValue({ authenticated: false, required: true, password: true });
    vi.spyOn(api, 'passwordLogin')
      .mockRejectedValueOnce(new ApiError('Invalid credentials', 'UNAUTHORIZED', 401))
      .mockRejectedValueOnce(new ApiError('登录失败次数过多，请 60 秒后再试', 'LOGIN_RATE_LIMITED', 429))
      .mockResolvedValueOnce({ authenticated: true, required: true, password: true });
    render(<AuthGate><div>受保护内容</div></AuthGate>);
    const input = await screen.findByLabelText('访问密码');
    await userEvent.type(input, 'wrong pass');
    await userEvent.click(screen.getByRole('button', { name: '连接工作台' }));
    expect(await screen.findByText('访问密码不正确。')).toBeTruthy();
    await userEvent.type(screen.getByLabelText('访问密码'), 'x');
    await userEvent.click(screen.getByRole('button', { name: '连接工作台' }));
    expect(await screen.findByText('登录失败次数过多，请 60 秒后再试')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '连接工作台' }));
    expect(await screen.findByText('受保护内容')).toBeTruthy();
    window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    expect(await screen.findByLabelText('访问密码')).toBeTruthy();
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
    render(<AuthGate><RemoteAccessLogout/><div>受保护内容</div></AuthGate>);
    await userEvent.click(await screen.findByRole('button', { name: '退出远程访问' }));
    expect(logout).toHaveBeenCalledOnce();
    expect(await screen.findByLabelText('访问令牌')).toBeTruthy();
  });
});


it('keeps password login after logout using real backend routes and browser API requests', async () => {
  // Resolve the server's own dependency and exercise its auth routes without opening a socket.
  const Fastify = createRequire(new NodeURL('../../../server/package.json', import.meta.url).href)('fastify');
  const app: Parameters<typeof registerBrowserAuthRoutes>[0] = Fastify();
  const password = 'dashboard pass';
  const passwordHash = await hashPassword(password);
  registerBrowserAuthRoutes(app, { localOnly: false, mode: 'token', getToken: async () => 'different-access-token', getPasswordHash: async () => passwordHash });
  const remote = { remoteAddress: '203.0.113.7' } as const;
  try {
    const initialLogin = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password }, ...remote });
    expect(initialLogin.statusCode).toBe(200);
    let cookie = String(initialLogin.headers['set-cookie']).split(';')[0]!;
    const requests: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ url, body });
      const result = await app.inject({ method: init?.method === 'POST' ? 'POST' : 'GET', url, headers: { cookie }, ...(body ? { payload: body } : {}), ...remote });
      if (result.headers['set-cookie']) cookie = String(result.headers['set-cookie']).split(';')[0]!;
      return new Response(result.body, { status: result.statusCode, headers: { 'content-type': 'application/json' } });
    }));
    const tokenLogin = vi.spyOn(api, 'login');
    const passwordLogin = vi.spyOn(api, 'passwordLogin');
    render(<AuthGate><RemoteAccessLogout/><div>密码工作台</div></AuthGate>);
    await userEvent.click(await screen.findByRole('button', { name: '退出远程访问' }));
    expect(cookie).toBe(`${AUTH_COOKIE_NAME}=`);
    expect(screen.queryByText('密码工作台')).toBeNull();
    const input = await screen.findByLabelText('访问密码');
    expect(screen.queryByLabelText('访问令牌')).toBeNull();
    await userEvent.type(input, password);
    await userEvent.click(screen.getByRole('button', { name: '连接工作台' }));
    expect(await screen.findByText('密码工作台')).toBeTruthy();
    expect(passwordLogin).toHaveBeenCalledWith(password);
    expect(tokenLogin).not.toHaveBeenCalled();
    expect(requests.filter(request => request.url === '/api/auth/login')).toEqual([{ url: '/api/auth/login', body: { password } }]);
    expect((await app.inject({ method: 'GET', url: '/api/auth/status', headers: { cookie }, ...remote })).json()).toEqual({ authenticated: true, required: true, password: true });
  } finally { await app.close(); }
});
