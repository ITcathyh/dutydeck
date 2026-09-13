import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  connectLarkOpenPlatformSession,
  defaultOpenPlatformSessionFilePath,
  readOpenPlatformSessionCookies,
  safeOpenPlatformError,
  writeOpenPlatformSessionCookies,
  type StoredOpenPlatformCookie,
} from './open-platform-session.js';

const temporaryDirectories: string[] = [];
const temporaryDirectory = () => {
  const path = mkdtempSync(join(tmpdir(), 'dutydeck-open-platform-'));
  temporaryDirectories.push(path);
  return path;
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const cookie = (overrides: Partial<StoredOpenPlatformCookie> = {}): StoredOpenPlatformCookie => ({
  name: 'session',
  value: 'private-cookie-value',
  domain: '.feishu.cn',
  path: '/',
  secure: true,
  httpOnly: true,
  hostOnly: false,
  ...overrides,
});

const consoleHtml = (csrf = 'private-csrf-value') => `
  <script>
    window.csrfToken = "${csrf}";
    window.user = {"id":"user-private-id","name":"Alice","email":"alice@example.com","tenantId":"tenant-private-id","tenantDisplayName":{"value":"Acme"}};
  </script>`;

describe('Open Platform session cache', () => {
  it('uses the Dutydeck-specific default path and writes an atomic private cache', () => {
    const home = temporaryDirectory();
    expect(defaultOpenPlatformSessionFilePath(home)).toBe(join(home, '.dutydeck', 'feishu-open-platform-session.json'));

    const file = defaultOpenPlatformSessionFilePath(home);
    writeOpenPlatformSessionCookies(file, [cookie()]);

    expect(statSync(join(home, '.dutydeck')).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readOpenPlatformSessionCookies(file)).toEqual([cookie()]);
    expect(readFileSync(file, 'utf8')).not.toContain('csrf');
    expect(readFileSync(file, 'utf8')).not.toContain('secret');
  });

  it('reuses a valid cache, follows trusted console redirects and rejects foreign-domain Set-Cookie', async () => {
    const file = join(temporaryDirectory(), 'session.json');
    writeOpenPlatformSessionCookies(file, [cookie()]);
    const requests: Array<{ url: string; cookie: string | null }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      requests.push({ url, cookie: headers.get('cookie') });
      if (url === 'https://open.feishu.cn/app') {
        return new Response(null, {
          status: 302,
          headers: {
            location: 'https://open.larkoffice.com/app',
            'set-cookie': 'console_session=redirect-cookie; Domain=.larkoffice.com; Path=/; Secure; HttpOnly',
          },
        });
      }
      if (url === 'https://open.larkoffice.com/app') return new Response(consoleHtml(), { status: 200 });
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch;

    const connected = await connectLarkOpenPlatformSession({ sessionFilePath: file, fetchImpl });

    expect(connected.source).toBe('cache');
    expect(connected.client.apiOrigin).toBe('https://open.larkoffice.com');
    expect(connected.owner).toMatchObject({ userName: 'Alice', tenantName: 'Acme' });
    expect(requests[0]?.cookie).toContain('session=private-cookie-value');
    expect(requests[1]?.cookie).toBeNull();
    expect(readFileSync(file, 'utf8')).not.toContain('redirect-cookie');
    expect(fetchImpl.mock.calls.some(([url]) => String(url).includes('/accounts/qrlogin/'))).toBe(false);
  });

  it('falls back from an invalid cache to QR login and reports scan state without persisting QR payload', async () => {
    const file = join(temporaryDirectory(), 'session.json');
    writeOpenPlatformSessionCookies(file, [cookie({ value: 'expired-cache-cookie' })]);
    const updates: Array<{ qrPayload: string; status: string }> = [];
    let consoleReads = 0;
    let polls = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === 'https://open.feishu.cn/app') {
        consoleReads += 1;
        return consoleReads === 1
          ? new Response('<html>login</html>', { status: 200 })
          : new Response(consoleHtml(), { status: 200 });
      }
      if (url.includes('/accounts/qrlogin/init')) {
        return Response.json({ code: 0, data: { step_info: { token: 'qr-login-payload-token' } } }, {
          headers: { 'x-flow-key': 'flow-private-key' },
        });
      }
      if (url.includes('/accounts/qrlogin/polling')) {
        polls += 1;
        return Response.json(polls === 1
          ? { code: 0, data: { step_info: { status: 2 } } }
          : { code: 0, data: { next_step: 'enter_app', step_info: { status: 3, cross_login_uri: 'https://passport.feishu.cn/cross' } } });
      }
      if (url === 'https://passport.feishu.cn/cross') {
        return new Response('', {
          status: 200,
          headers: { 'set-cookie': 'session=fresh-cookie; Domain=.feishu.cn; Path=/; Secure; HttpOnly' },
        });
      }
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch;

    const connected = await connectLarkOpenPlatformSession({
      sessionFilePath: file,
      fetchImpl,
      pollIntervalMs: 0,
      maxWaitMs: 1_000,
      onQrUpdate: update => { updates.push(update); },
    });

    expect(connected.source).toBe('qr_login');
    expect(updates.map(update => update.status)).toEqual(['waiting_for_scan', 'scan_confirmed']);
    expect(updates[0]?.qrPayload).toContain('qr-login-payload-token');
    expect(readFileSync(file, 'utf8')).not.toContain('qr-login-payload-token');
    expect(readOpenPlatformSessionCookies(file)?.map(item => item.value)).toContain('fresh-cookie');
  });

  it('fails closed after a fresh login when owner identity is unreadable', async () => {
    const file = join(temporaryDirectory(), 'session.json');
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/accounts/qrlogin/init')) {
        return Response.json({ code: 0, data: { step_info: { token: 'qr-token' } } }, {
          headers: { 'x-flow-key': 'flow-key' },
        });
      }
      if (url.includes('/accounts/qrlogin/polling')) {
        return Response.json({ code: 0, data: { next_step: 'enter_app', step_info: { status: 3 } } });
      }
      if (url === 'https://open.feishu.cn/app') {
        return new Response('<script>window.csrfToken="csrf-but-no-owner";</script>', { status: 200 });
      }
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch;

    await expect(connectLarkOpenPlatformSession({
      sessionFilePath: file,
      fetchImpl,
      pollIntervalMs: 0,
    })).rejects.toThrow('为避免配置到错误企业');
    expect(readOpenPlatformSessionCookies(file)).toBeNull();
  });

  it('recomputes the QR wait budget after a slow poll before sleeping', async () => {
    vi.useFakeTimers();
    try {
      const file = join(temporaryDirectory(), 'session.json');
      let polls = 0;
      const fetchImpl = vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes('/accounts/qrlogin/init')) {
          return Response.json({ code: 0, data: { step_info: { token: 'qr-token' } } }, {
            headers: { 'x-flow-key': 'flow-key' },
          });
        }
        if (url.includes('/accounts/qrlogin/polling')) {
          polls += 1;
          await new Promise(resolve => setTimeout(resolve, 15));
          return Response.json({ code: 0, data: { step_info: { status: 1 } } });
        }
        throw new Error(`unexpected ${url}`);
      }) as typeof fetch;
      const outcome = connectLarkOpenPlatformSession({
        sessionFilePath: file,
        fetchImpl,
        forceLogin: true,
        maxWaitMs: 20,
        pollIntervalMs: 100,
      }).then(() => undefined, error => error);

      await vi.advanceTimersByTimeAsync(20);
      await expect(outcome).resolves.toMatchObject({ message: '等待飞书扫码超时' });
      expect(polls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Open Platform client error safety', () => {
  it('redacts cookies, CSRF and secrets from HTTP/body errors', async () => {
    const file = join(temporaryDirectory(), 'session.json');
    writeOpenPlatformSessionCookies(file, [cookie()]);
    const secret = 'secret-value-abcdefghijklmnopqrstuvwxyz';
    const csrf = 'csrf-value-abcdefghijklmnopqrstuvwxyz';
    const echoedCookie = 'cookie-value-abcdefghijklmnopqrstuvwxyz';
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === 'https://open.feishu.cn/app') return new Response(consoleHtml(csrf), { status: 200 });
      if (url.endsWith('/developers/v1/test')) {
        return Response.json({ code: 19, msg: `app_secret=${secret} csrf_token=${csrf} cookie=${echoedCookie}` });
      }
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch;
    const connected = await connectLarkOpenPlatformSession({ sessionFilePath: file, fetchImpl });

    let message = '';
    try {
      await connected.client.postJson('/developers/v1/test', {});
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('code=19');
    expect(message).not.toContain(secret);
    expect(message).not.toContain(csrf);
    expect(message).not.toContain(echoedCookie);
    expect(safeOpenPlatformError(new Error(`authorization: Bearer ${secret}`))).not.toContain(secret);
  });

  it('aborts a hanging external request at the configured single-request timeout', async () => {
    const file = join(temporaryDirectory(), 'session.json');
    const fetchImpl = vi.fn((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    })) as typeof fetch;

    await expect(connectLarkOpenPlatformSession({
      sessionFilePath: file,
      fetchImpl,
      forceLogin: true,
      requestTimeoutMs: 10,
    })).rejects.toThrow('开放平台请求超时');
    expect(fetchImpl.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('fails closed instead of following a console write redirect to another origin', async () => {
    const file = join(temporaryDirectory(), 'session.json');
    writeOpenPlatformSessionCookies(file, [cookie()]);
    const requests: Array<{ url: string; csrf: string | null }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, csrf: new Headers(init?.headers).get('x-csrf-token') });
      if (url === 'https://open.feishu.cn/app') return new Response(consoleHtml(), { status: 200 });
      if (url === 'https://open.feishu.cn/developers/v1/test') {
        return new Response(null, { status: 302, headers: { location: 'https://attacker.example/collect' } });
      }
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch;
    const connected = await connectLarkOpenPlatformSession({ sessionFilePath: file, fetchImpl });

    await expect(connected.client.postJson('/developers/v1/test', {})).rejects.toThrow('跨站跳转');
    expect(requests).toHaveLength(2);
    expect(requests[1]?.csrf).toBe('private-csrf-value');
    expect(requests.some(request => request.url.includes('attacker.example'))).toBe(false);
  });

  it('redacts short JSON-form credentials', () => {
    const redacted = safeOpenPlatformError(new Error('{"cookie":"abc","csrf_token":"xyz","token":"123"}'));
    expect(redacted).not.toContain('abc');
    expect(redacted).not.toContain('xyz');
    expect(redacted).not.toContain('123');
  });
});

it('posts multipart with authenticated console headers and a browser-generated boundary', async () => {
  const file = join(temporaryDirectory(), 'session.json');
  writeOpenPlatformSessionCookies(file, [cookie()]);
  let request: RequestInit | undefined;
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).endsWith('/app')) return new Response(consoleHtml());
    request = init;
    return Response.json({ code: 0, data: { url: 'https://example.invalid/icon' } });
  }) as typeof fetch;
  const { client } = await connectLarkOpenPlatformSession({ sessionFilePath: file, fetchImpl });
  const form = new FormData();
  form.append('file', new Blob(['fixture'], { type: 'image/png' }), 'icon.png');
  expect(await client.postForm('/developers/v1/app/upload/image', form)).toMatchObject({ code: 0 });
  expect(request?.body).toBe(form);
  const headers = new Headers(request?.headers);
  expect(headers.get('content-type')).toBeNull();
  expect(headers.get('x-csrf-token')).toBe('private-csrf-value');
  expect(headers.get('cookie')).toContain('private-cookie-value');
  expect(headers.get('origin')).toBe('https://open.feishu.cn');
  await expect(client.postForm('https://evil.invalid/upload', form)).rejects.toThrow('仅允许');
  await expect(client.postForm('/developers/v1/../upload', form)).rejects.toThrow('仅允许');
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});

it.each([503, 404])('preserves HTTP %s classification for external-write retry decisions', async status => {
  const file = join(temporaryDirectory(), 'session.json');
  writeOpenPlatformSessionCookies(file, [cookie()]);
  const fetchImpl = vi.fn(async (input: string | URL | Request) => String(input).endsWith('/app')
    ? new Response(consoleHtml()) : Response.json({ code: 1, msg: 'rejected' }, { status })) as typeof fetch;
  const { client } = await connectLarkOpenPlatformSession({ sessionFilePath: file, fetchImpl });
  await expect(client.postJson('/developers/v1/manifest/upsert_by_template', {})).rejects.toMatchObject({ statusCode: status });
});
