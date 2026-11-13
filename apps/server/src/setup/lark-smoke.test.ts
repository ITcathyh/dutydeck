import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { once } from 'node:events';
import type { StoredLarkConfig } from '@dutydeck/shared';
import { createRepositories } from '@dutydeck/storage';
import { larkBotsConfigKey } from '../lark/config.js';
import { __testOnly_resetLarkGate } from '../lark/api-gate.js';
import { offerLarkSetupSmoke, type LarkSmokeEvent } from './lark-smoke.js';
import { LarkSmokeCleanupError } from './lark-smoke-listener.js';
import type { Prompter } from './prompts.js';

const daemonProbe = vi.hoisted(() => ({ statuses: ['stale'] as string[], calls: 0 }));
vi.mock('../daemon/command.js', () => ({
  daemonStatus: () => {
    const status = daemonProbe.statuses[Math.min(daemonProbe.calls, daemonProbe.statuses.length - 1)] ?? 'stale';
    daemonProbe.calls += 1;
    return { processStatus: status };
  }
}));

const bot = { appId: 'cli_smoke', appSecret: 'secret_fixture', listening: true } as StoredLarkConfig;
const temporaryDirectories: string[] = [];
const validEvent = (uuid = 'uuid_fixed'): LarkSmokeEvent => ({
  messageId: 'om_inbound', chatType: 'p2p', senderType: 'user',
  content: `{"text":"verification ${uuid}"}`
});

function prompter(answer = true): Prompter {
  return {
    interactive: true,
    ask: vi.fn(),
    choose: vi.fn(),
    confirm: vi.fn(async () => answer),
    secret: vi.fn(),
    close: vi.fn()
  };
}

function options(overrides: Record<string, unknown> = {}) {
  return {
    database: '/tmp/synthetic-smoke.db', appId: bot.appId,
    interactive: true, prompter: prompter(), timeoutMs: 60_000,
    ...overrides
  };
}

function smoke(overrides: Record<string, unknown> = {}, dependencies: NonNullable<Parameters<typeof offerLarkSetupSmoke>[1]> = {}) {
  return offerLarkSetupSmoke(options(overrides), {
    acquireRuntime: () => ({ close() {} }),
    ...dependencies
  });
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function withLarkStub(run: (fixture: {
  requests: Array<{ method?: string; path: string; authorization?: string; body: any }>;
  unexpected: string[];
}) => Promise<void>): Promise<void> {
  const tokenPath = '/open-apis/auth/v3/tenant_access_token/internal/';
  const replyPath = '/open-apis/im/v1/messages/om_inbound/reply';
  const requests: Array<{ method?: string; path: string; authorization?: string; body: any }> = [];
  const unexpected: string[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://fixture.invalid');
      if (request.method !== 'POST' || (url.pathname !== tokenPath && url.pathname !== replyPath)) {
        unexpected.push(`${request.method} ${url.pathname}${url.search}`);
        request.resume();
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ code: 404, msg: 'unexpected fixture path' }));
        return;
      }
      let body: unknown;
      try { body = await readJsonBody(request); }
      catch {
        request.socket.destroy();
        return;
      }
      requests.push({
        method: request.method, path: url.pathname, body,
        ...(request.headers.authorization ? { authorization: request.headers.authorization } : {})
      });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(url.pathname === tokenPath
        ? { code: 0, tenant_access_token: 'fixture-tenant-token', expire: 7200 }
        : { code: 0, data: { message_id: 'om_reply', chat_id: 'oc_dm' } }));
    })().catch(() => { request.socket.destroy(); });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No loopback address for the Lark stub');
  vi.stubEnv('LARK_OPEN_API_BASE_URL', `http://127.0.0.1:${address.port}`);
  vi.stubEnv('LARK_API_QPS', '1000');
  vi.stubEnv('LARK_API_BURST', '1000');
  vi.stubEnv('LARK_API_RETRY_MAX_ATTEMPTS', '0');
  try { await run({ requests, unexpected }); }
  finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

beforeEach(() => {
  daemonProbe.statuses = ['stale'];
  daemonProbe.calls = 0;
  __testOnly_resetLarkGate();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  __testOnly_resetLarkGate();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('offerLarkSetupSmoke', () => {
  it('defaults to No and does not display a code, start listening or reply after refusal', async () => {
    const startListener = vi.fn(async () => vi.fn());
    const reply = vi.fn();
    const onVerificationCode = vi.fn();
    const prompt = prompter(false);
    const close = vi.fn();
    const acquireRuntime = vi.fn(() => ({ close }));
    const result = await smoke({ prompter: prompt, onVerificationCode }, {
      loadBot: async () => bot, acquireRuntime, startListener, reply
    });
    expect(result.status).toBe('skipped');
    expect(result.message).toContain('未发送任何消息');
    expect(prompt.confirm).toHaveBeenCalledWith(expect.objectContaining({
      defaultValue: false, dangerous: true, question: expect.stringContaining('私聊机器人')
    }));
    expect(acquireRuntime).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(onVerificationCode).not.toHaveBeenCalled();
    expect(startListener).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
  });

  it.each([
    ['--yes', { interactive: true, assumeYes: true }],
    ['non-interactive', { interactive: false }],
    ['JSON', { interactive: true, json: true }]
  ])('makes no identity request, listener or outbound request for %s', async (_name, override) => {
    await withLarkStub(async ({ requests, unexpected }) => {
      const prompt = prompter();
      const loadBot = vi.fn(async () => bot);
      const startListener = vi.fn();
      const reply = vi.fn();
      const onVerificationCode = vi.fn();
      const result = await smoke({ ...override, prompter: prompt, onVerificationCode }, { loadBot, startListener, reply });
      expect(result.status).toBe('skipped');
      expect(prompt.confirm).not.toHaveBeenCalled();
      expect(loadBot).not.toHaveBeenCalled();
      expect(startListener).not.toHaveBeenCalled();
      expect(reply).not.toHaveBeenCalled();
      expect(onVerificationCode).not.toHaveBeenCalled();
      expect(daemonProbe.calls).toBe(0);
      expect(requests).toEqual([]);
      expect(unexpected).toEqual([]);
    });
  });

  it.each(['verified', 'unverifiable'])('fails closed before prompting when daemon status is %s', async status => {
    daemonProbe.statuses = [status];
    const prompt = prompter();
    const startListener = vi.fn();
    const reply = vi.fn();
    const result = await smoke({ prompter: prompt }, { loadBot: async () => bot, startListener, reply });
    expect(result.status).toBe('unavailable');
    expect(result.message).toContain('分流正常消息');
    expect(result.message).toContain('停止同库服务后再试');
    expect(prompt.confirm).not.toHaveBeenCalled();
    expect(startListener).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
  });

  it('fails closed before prompting when the runtime lease cannot be acquired', async () => {
    const prompt = prompter();
    const loadBot = vi.fn(async () => bot);
    const startListener = vi.fn();
    const reply = vi.fn();
    const result = await smoke({ prompter: prompt }, {
      loadBot, startListener, reply,
      acquireRuntime: () => { throw new Error('synthetic runtime busy'); }
    });
    expect(result.status).toBe('unavailable');
    expect(result.message).toContain('runtime');
    expect(prompt.confirm).not.toHaveBeenCalled();
    expect(loadBot).not.toHaveBeenCalled();
    expect(startListener).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
  });

  it('releases the preflight lease and refuses when reacquisition fails after confirmation', async () => {
    const prompt = prompter();
    const startListener = vi.fn();
    const reply = vi.fn();
    const close = vi.fn();
    const acquireRuntime = vi.fn()
      .mockImplementationOnce(() => ({ close }))
      .mockImplementationOnce(() => { throw new Error('synthetic runtime busy'); });
    const result = await smoke({ prompter: prompt }, {
      loadBot: async () => bot, acquireRuntime, startListener, reply
    });
    expect(result.status).toBe('unavailable');
    expect(acquireRuntime).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledOnce();
    expect(prompt.confirm).toHaveBeenCalledOnce();
    expect(startListener).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
  });

  it('fails closed for a real runtime lease without any listener status during root service startup', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dutydeck-lark-smoke-'));
    temporaryDirectories.push(directory);
    const database = join(directory, 'state.db');
    const seed = createRepositories(database);
    try { await seed.config.set(larkBotsConfigKey, JSON.stringify([bot])); }
    finally { seed.close(); }
    const rootService = createRepositories(database, { mode: 'runtime' });
    const prompt = prompter();
    const startListener = vi.fn();
    const reply = vi.fn();
    let result;
    try { result = await offerLarkSetupSmoke(options({ database, prompter: prompt }), { startListener, reply }); }
    finally { rootService.close(); }
    expect(result.status).toBe('unavailable');
    expect(result.message).toContain('同库服务');
    expect(daemonProbe.calls).toBe(1);
    expect(prompt.confirm).not.toHaveBeenCalled();
    expect(startListener).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
  });

  it('does not offer the smoke without a usable saved bot', async () => {
    const prompt = prompter();
    const result = await smoke({ prompter: prompt }, { loadBot: async () => undefined, reply: vi.fn() });
    expect(result.status).toBe('unavailable');
    expect(prompt.confirm).not.toHaveBeenCalled();
  });

  it('starts listening, displays one UUID, accepts its user p2p message and replies with the same UUID', async () => {
    const order: string[] = [];
    let onEvent: ((event: LarkSmokeEvent) => void) | undefined;
    let held = false;
    const close = vi.fn(() => {
      expect(held).toBe(true);
      held = false;
      order.push('release');
    });
    const acquireRuntime = vi.fn(() => {
      held = true;
      return { close };
    });
    const stop = vi.fn(() => {
      expect(held).toBe(true);
      order.push('stop');
    });
    const reply = vi.fn(async (_bot, input: { messageId: string; uuid: string }) => {
      expect(held).toBe(true);
      order.push('reply');
      expect(input).toEqual({ messageId: 'om_inbound', uuid: 'uuid_fixed' });
      return { messageId: 'om_reply' };
    });
    const onVerificationCode = vi.fn((uuid: string) => {
      expect(held).toBe(true);
      order.push('code');
      queueMicrotask(() => onEvent?.(validEvent(uuid)));
    });
    const result = await smoke({ onVerificationCode }, {
      loadBot: async () => bot,
      acquireRuntime,
      startListener: async (_bot, receive) => {
        expect(held).toBe(true);
        order.push('start');
        onEvent = receive;
        return stop;
      },
      reply,
      uuid: () => 'uuid_fixed'
    });
    expect(result.status).toBe('verified');
    expect(result.message).toContain('入站');
    expect(result.message).toContain('出站已发送');
    expect(result.message).toContain('请在飞书确认收到');
    expect(result.message).not.toContain('已收到');
    expect(onVerificationCode).toHaveBeenCalledOnce();
    expect(reply).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(acquireRuntime).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(2);
    expect(held).toBe(false);
    expect(order).toEqual(['release', 'start', 'code', 'reply', 'stop', 'release']);
  });

  it('allows first setup with the default runtime lease and releases it after verification', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dutydeck-lark-smoke-'));
    temporaryDirectories.push(directory);
    const database = join(directory, 'state.db');
    const seed = createRepositories(database);
    try { await seed.config.set(larkBotsConfigKey, JSON.stringify([bot])); }
    finally { seed.close(); }
    const expectRuntimeBusy = () => {
      expect(() => {
        const concurrent = createRepositories(database, { mode: 'runtime' });
        concurrent.close();
      }).toThrow();
    };
    let onEvent: ((event: LarkSmokeEvent) => void) | undefined;
    const stop = vi.fn(() => { expectRuntimeBusy(); });
    const reply = vi.fn(async () => {
      expectRuntimeBusy();
      return { messageId: 'om_reply' };
    });
    const result = await offerLarkSetupSmoke(options({
      database,
      onVerificationCode: (uuid: string) => queueMicrotask(() => onEvent?.(validEvent(uuid)))
    }), {
      startListener: async (_bot, receive) => {
        expectRuntimeBusy();
        onEvent = receive;
        return stop;
      },
      reply
    });
    expect(result.status).toBe('verified');
    expect(reply).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
    const reopened = createRepositories(database, { mode: 'runtime' });
    reopened.close();
  });

  it('waits for the whole temporary listener cleanup before releasing the runtime lease', async () => {
    let finishStop!: () => void;
    const stopping = new Promise<void>(resolve => { finishStop = resolve; });
    const order: string[] = [];
    const close = vi.fn(() => { order.push('runtime.close'); });
    const stop = vi.fn(async () => {
      order.push('listener-and-loopback.stop.begin');
      await stopping;
      order.push('listener-and-loopback.stop.end');
    });
    let onEvent: ((event: LarkSmokeEvent) => void) | undefined;
    const pending = smoke({
      onVerificationCode: (uuid: string) => queueMicrotask(() => onEvent?.(validEvent(uuid)))
    }, {
      loadBot: async () => bot,
      acquireRuntime: () => ({ close }),
      startListener: async (_bot, receive) => { onEvent = receive; return stop; },
      reply: async () => ({ messageId: 'om_reply' })
    });
    await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
    const closesBeforeStopFinished = close.mock.calls.length;
    finishStop();
    expect((await pending).status).toBe('verified');
    expect(closesBeforeStopFinished).toBe(1);
    expect(order).toEqual([
      'runtime.close', 'listener-and-loopback.stop.begin', 'listener-and-loopback.stop.end', 'runtime.close'
    ]);
  });

  it('retains the runtime lease when final transport cleanup cannot be confirmed', async () => {
    const close = vi.fn();
    let onEvent: ((event: LarkSmokeEvent) => void) | undefined;
    const result = await smoke({
      onVerificationCode: (uuid: string) => queueMicrotask(() => onEvent?.(validEvent(uuid)))
    }, {
      loadBot: async () => bot,
      acquireRuntime: () => ({ close }),
      startListener: async (_bot, receive) => {
        onEvent = receive;
        return async () => { throw new Error('synthetic unconfirmed transport close'); };
      },
      reply: async () => ({ messageId: 'om_reply' })
    });
    expect(result.status).toBe('unavailable');
    expect(result.message).toContain('保留 runtime');
    expect(close).toHaveBeenCalledOnce();
  });

  it('reports send failure after inbound passed without sending another proactive message', async () => {
    const stop = vi.fn();
    const close = vi.fn();
    let onEvent: ((event: LarkSmokeEvent) => void) | undefined;
    const reply = vi.fn(async () => { throw new Error('synthetic reply result unknown'); });
    const result = await smoke({
      onVerificationCode: (uuid: string) => queueMicrotask(() => onEvent?.(validEvent(uuid)))
    }, {
      loadBot: async () => bot,
      acquireRuntime: () => ({ close }),
      startListener: async (_bot, receive) => { onEvent = receive; return stop; },
      reply
    });
    expect(result.status).toBe('send_failed');
    expect(result.message).toContain('入站验证已通过');
    expect(result.message).toContain('出站未验证');
    expect(result.message).toContain('未另行发送');
    expect(reply).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledTimes(2);
    expect(stop.mock.invocationCallOrder[0]).toBeLessThan(close.mock.invocationCallOrder[1]!);
  });

  it('times out without sending anything when no valid private message arrives', async () => {
    vi.useFakeTimers();
    const stop = vi.fn();
    const close = vi.fn();
    const reply = vi.fn();
    const onVerificationCode = vi.fn();
    const pending = smoke({ onVerificationCode }, {
      loadBot: async () => bot,
      acquireRuntime: () => ({ close }),
      startListener: async () => stop,
      reply,
      uuid: () => 'uuid_fixed'
    });
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await pending;
    expect(result.status).toBe('inbound_unverified');
    expect(result.message).toContain('未收到有效私聊');
    expect(result.message).toContain('未发送任何消息');
    expect(onVerificationCode).toHaveBeenCalledWith('uuid_fixed');
    expect(reply).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledTimes(2);
    expect(stop.mock.invocationCallOrder[0]).toBeLessThan(close.mock.invocationCallOrder[1]!);
  });

  it.each([
    ['a group message with the right code', (uuid: string) => ({ ...validEvent(uuid), chatType: 'group' })],
    ['the wrong code', () => validEvent('wrong_uuid')],
    ['a bot message with the right code', (uuid: string) => ({ ...validEvent(uuid), senderType: 'app' })],
    ['a valid message without messageId', (uuid: string) => ({ ...validEvent(uuid), messageId: undefined })]
  ])('does not reply to %s', async (_name, makeEvent) => {
    vi.useFakeTimers();
    let onEvent: ((event: LarkSmokeEvent) => void) | undefined;
    const reply = vi.fn();
    const pending = smoke({
      onVerificationCode: (uuid: string) => queueMicrotask(() => onEvent?.(makeEvent(uuid)))
    }, {
      loadBot: async () => bot,
      startListener: async (_bot, receive) => { onEvent = receive; return vi.fn(); },
      reply
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await pending).status).toBe('inbound_unverified');
    expect(reply).not.toHaveBeenCalled();
  });

  it('settles duplicate deliveries with exactly one reply', async () => {
    let onEvent: ((event: LarkSmokeEvent) => void) | undefined;
    const reply = vi.fn(async () => ({ messageId: 'om_reply' }));
    const result = await smoke({
      onVerificationCode: (uuid: string) => queueMicrotask(() => {
        onEvent?.(validEvent(uuid));
        onEvent?.(validEvent(uuid));
        onEvent?.(validEvent(uuid));
        onEvent?.({ ...validEvent(uuid), messageId: 'om_another' });
      })
    }, {
      loadBot: async () => bot,
      startListener: async (_bot, receive) => { onEvent = receive; return vi.fn(); },
      reply
    });
    expect(result.status).toBe('verified');
    expect(reply).toHaveBeenCalledTimes(1);
  });

  it('uses only tenant token and the real message reply endpoint in the default implementation', async () => {
    await withLarkStub(async ({ requests, unexpected }) => {
      let onEvent: ((event: LarkSmokeEvent) => void) | undefined;
      const stop = vi.fn();
      const result = await smoke({
        onVerificationCode: (uuid: string) => queueMicrotask(() => onEvent?.(validEvent(uuid)))
      }, {
        loadBot: async () => bot,
        startListener: async (_bot, receive) => { onEvent = receive; return stop; },
        uuid: () => 'uuid_fixed'
      });
      expect(result.status).toBe('verified');
      expect(stop).toHaveBeenCalledOnce();
      expect(requests.map(({ method, path }) => ({ method, path }))).toEqual([
        { method: 'POST', path: '/open-apis/auth/v3/tenant_access_token/internal/' },
        { method: 'POST', path: '/open-apis/im/v1/messages/om_inbound/reply' }
      ]);
      expect(requests[0]?.body).toEqual({ app_id: bot.appId, app_secret: bot.appSecret });
      expect(requests[1]?.authorization).toBe('Bearer fixture-tenant-token');
      expect(requests[1]?.body.uuid).toBe('uuid_fixed');
      expect(JSON.parse(requests[1]?.body.content).text).toContain('uuid_fixed');
      expect(unexpected).toEqual([]);
      expect(JSON.stringify(requests)).not.toContain('/application/v6/applications/');
      expect(JSON.stringify(requests)).not.toContain('receive_id_type=open_id');
    });
  });

  it('cleans up and does not reply if the listener cannot start', async () => {
    const reply = vi.fn();
    const close = vi.fn();
    const onVerificationCode = vi.fn();
    const result = await smoke({ onVerificationCode }, {
      loadBot: async () => bot,
      acquireRuntime: () => ({ close }),
      startListener: async () => { throw new Error('synthetic listener failure'); },
      reply
    });
    expect(result.status).toBe('unavailable');
    expect(result.message).toContain('监听');
    expect(result.message).toContain('未发送任何消息');
    expect(onVerificationCode).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(2);
  });

  it('retains the runtime and loopback when listener startup cleanup is unconfirmed', async () => {
    const reply = vi.fn();
    const close = vi.fn();
    const result = await smoke({}, {
      loadBot: async () => bot,
      acquireRuntime: () => ({ close }),
      startListener: async () => { throw new LarkSmokeCleanupError(new Error('synthetic cleanup failure')); },
      reply
    });
    expect(result.status).toBe('unavailable');
    expect(result.message).toContain('保留 runtime');
    expect(reply).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });
});
