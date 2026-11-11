import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __testOnly_resetLarkGate } from './api-gate.js';
import { runLarkSend } from './cli.js';
import { cardInputFromCli } from './cli.js';

describe('Lark CLI card input', () => {
  it('passes Markdown through with custom agent branding', () => {
    expect(cardInputFromCli('### 业务自定义\n\n🟡 执行中', {
      state: 'running', agentName: 'My Agent', taskName: 'Debug', taskId: '1', elapsedSeconds: '12', readOnly: true
    })).toEqual({
      state: 'running', agentName: 'My Agent', taskName: 'Debug', taskId: '1', elapsedSeconds: 12, readOnly: true,
      markdown: '### 业务自定义\n\n🟡 执行中'
    });
  });

  it('rejects invalid state', () => {
    expect(() => cardInputFromCli('x', { state: 'waiting' })).toThrow(/state must be one of/);
  });
});

describe('open Lark send', () => {
  it('sends a reply with a saved bot, returns its message link and leaves credentials unchanged', async () => {
    const { createRepositories } = await import('@dutydeck/storage');
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { vi } = await import('vitest');
    const { runLarkSend } = await import('./cli.js');
    const dir = await mkdtemp(join(tmpdir(), 'dutydeck-open-send-')); const file = join(dir, 'state.db');
    const repos = createRepositories(file);
    await repos.config.set('lark.bots', JSON.stringify([{ appId: 'cli_example', appSecret: 'placeholder-secret', preInjectPrompt: '', listening: false }]));
    const before = await repos.config.get('lark.bots');
    const fetcher = vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(String(url).includes('tenant_access_token') ? { code: 0, tenant_access_token: 'placeholder-token', expire: 7200 }
      : String(url).includes('message_link') ? { code: 0, data: { message_link: 'https://client.example.test/message' } } : { code: 0, data: { message_id: 'om_example' } })));
    vi.stubGlobal('fetch', fetcher);
    try {
      expect(await runLarkSend('Archive', { app: 'cli_example', database: file, replyTo: 'om_parent', inThread: true, json: true }, {})).toEqual({ message_id: 'om_example', url: 'https://client.example.test/message' });
      const reply = fetcher.mock.calls.find(([url]) => String(url).endsWith('/om_parent/reply'))!;
      expect(JSON.parse(reply[1]!.body as string)).toMatchObject({ reply_in_thread: true, msg_type: 'interactive' });
      expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string)).toEqual({ app_id: 'cli_example', app_secret: 'placeholder-secret' });
      expect(await repos.config.get('lark.bots')).toBe(before);
      await expect(runLarkSend('x', { app: 'missing', database: file }, {})).rejects.toMatchObject({ code: 'not_found' });
    } finally { vi.unstubAllGlobals(); repos.close(); await rm(dir, { recursive: true, force: true }); }
  });
  it('preserves environment sends and validates thread options', async () => {
    const { vi } = await import('vitest'); const { runLarkSend } = await import('./cli.js');
    const fetcher = vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(String(url).includes('tenant_access_token') ? { code: 0, tenant_access_token: 'placeholder-token', expire: 7200 } : { code: 0, data: { message_id: 'om_example' } })));
    vi.stubGlobal('fetch', fetcher);
    try {
      expect(await runLarkSend('Archive', {}, { LARK_APP_ID: 'cli_example', LARK_APP_SECRET: 'placeholder-secret', LARK_CHAT_ID: 'oc_example' })).toMatchObject({ messageId: 'om_example' });
      expect(fetcher.mock.calls.some(([url]) => String(url).includes('/messages?'))).toBe(true);
      await expect(runLarkSend('x', { inThread: true }, {})).rejects.toMatchObject({ code: 'invalid_argument' });
      await expect(runLarkSend('x', { app: 'cli_example', appId: 'other' }, {})).rejects.toMatchObject({ code: 'invalid_argument' });
    } finally { vi.unstubAllGlobals(); }
  });
});


describe('Lark send delivery uncertainty', () => {
  beforeEach(() => { vi.useFakeTimers(); __testOnly_resetLarkGate(); });
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); __testOnly_resetLarkGate(); });
  it.each([['send', 'rejected'], ['reply', 'rejected'], ['send', 'success'], ['reply', 'success']])('remembers uncertain %s attempts until %s', async (kind, ending) => {
    const uuids: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes('tenant_access_token')) return new Response(JSON.stringify({ code: 0, tenant_access_token: 'placeholder-token', expire: 7200 }));
      if (String(url).includes('message_link')) return new Response(JSON.stringify({ code: 0, data: { message_link: 'https://client.example.test/message' } }));
      uuids.push(JSON.parse(init!.body as string).uuid);
      if (uuids.length === 1) throw new TypeError('first delivery receipt lost');
      return ending === 'rejected' ? new Response(JSON.stringify({ code: 99991672, msg: 'forbidden' }), { status: 403 })
        : new Response(JSON.stringify({ code: 0, data: { message_id: 'om_example' } }));
    }));
    const result = runLarkSend('Archive', { json: true, ...(kind === 'reply' ? { replyTo: 'om_example' } : {}) }, {
      LARK_APP_ID: 'cli_history_example', LARK_APP_SECRET: 'placeholder-secret', LARK_CHAT_ID: 'oc_example'
    }).catch(error => error);
    await vi.runAllTimersAsync();
    if (ending === 'rejected') expect(await result).toMatchObject({ code: 'unknown_outcome', exitCode: 5 });
    else expect(await result).toEqual({ message_id: 'om_example', url: 'https://client.example.test/message' });
    expect(uuids).toHaveLength(2); expect(new Set(uuids).size).toBe(1);
  });
  it.each([
    ['send', 'network'], ['reply', 'network'], ['send', 'body'], ['reply', 'body'], ['send', 'json'], ['reply', 'json']
  ])('keeps one UUID across %s retries after a %s failure', async (kind, failure) => {
    const requests: Array<{ uuid?: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes('tenant_access_token')) return new Response(JSON.stringify({ code: 0, tenant_access_token: 'placeholder-token', expire: 7200 }));
      requests.push(JSON.parse(init!.body as string));
      if (failure === 'json') return new Response('Invalid JSON');
      if (failure === 'network') throw new TypeError('response connection was lost');
      return new Response(new ReadableStream({ start(controller) { controller.error(new TypeError('response body was interrupted')); } }));
    }));
    const result = runLarkSend('Archive', { json: true, ...(kind === 'reply' ? { replyTo: 'om_example', inThread: true } : {}) }, {
      LARK_APP_ID: 'cli_retry_example', LARK_APP_SECRET: 'placeholder-secret', LARK_CHAT_ID: 'oc_example', LARK_API_RETRY_MAX_ATTEMPTS: '2'
    }).catch(error => error);
    await vi.runAllTimersAsync();
    const error = await result;
    if (failure === 'network') expect(requests.length).toBeGreaterThan(1);
    else expect(requests).toHaveLength(1);
    expect(requests[0]!.uuid).toMatch(/^[a-f0-9-]{36}$/);
    expect(new Set(requests.map(request => request.uuid)).size).toBe(1);
    expect(error).toMatchObject({ code: 'unknown_outcome', exitCode: 5 });
  });
});
