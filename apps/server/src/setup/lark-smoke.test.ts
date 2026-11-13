import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { StoredLarkConfig } from '@dutydeck/shared';
import { createRepositories } from '@dutydeck/storage';
import { larkBotsConfigKey } from '../lark/config.js';
import { offerLarkSetupSmoke, type LarkSmokeEvent } from './lark-smoke.js';
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
const ownerEvent: LarkSmokeEvent = {
  eventId: 'event_owner', messageId: 'message_owner', chatId: 'oc_dm', chatType: 'p2p',
  parentId: 'om_test_card', senderOpenId: 'ou_owner', senderType: 'user', content: '{"text":"done"}'
};

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
    database: '/tmp/synthetic-smoke.db', appId: bot.appId, ownerOpenId: 'ou_owner',
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

beforeEach(() => {
  daemonProbe.statuses = ['stale'];
  daemonProbe.calls = 0;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('offerLarkSetupSmoke', () => {
  it('defaults to No and does not start listening or send after refusal', async () => {
    const startListener = vi.fn(async () => vi.fn());
    const sendCard = vi.fn();
    const prompt = prompter(false);
    const close = vi.fn();
    const acquireRuntime = vi.fn(() => ({ close }));
    const result = await smoke({ prompter: prompt }, {
      loadBot: async () => bot, acquireRuntime, startListener, sendCard
    });
    expect(result.status).toBe('skipped');
    expect(prompt.confirm).toHaveBeenCalledWith(expect.objectContaining({ defaultValue: false, dangerous: true }));
    expect(acquireRuntime).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(startListener).not.toHaveBeenCalled();
    expect(sendCard).not.toHaveBeenCalled();
  });

  it.each([
    ['--yes', { interactive: true, assumeYes: true }],
    ['non-interactive', { interactive: false }],
    ['JSON', { interactive: false, json: true }]
  ])('does not prompt or send for %s', async (_name, override) => {
    const prompt = prompter();
    const loadBot = vi.fn(async () => bot);
    const sendCard = vi.fn();
    const result = await smoke({ ...override, prompter: prompt }, { loadBot, sendCard });
    expect(result.status).toBe('skipped');
    expect(prompt.confirm).not.toHaveBeenCalled();
    expect(loadBot).not.toHaveBeenCalled();
    expect(sendCard).not.toHaveBeenCalled();
  });

  it.each(['verified', 'unverifiable'])('fails closed before prompting when daemon status is %s', async status => {
    vi.useFakeTimers();
    daemonProbe.statuses = [status];
    const prompt = prompter();
    const startListener = vi.fn(async () => vi.fn());
    const sendCard = vi.fn();
    const pending = smoke({ prompter: prompt }, {
      loadBot: async () => bot, startListener, sendCard
    });
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await pending;
    expect(result.status).toBe('unavailable');
    expect(result.message).toContain('分流正常消息');
    expect(result.message).toContain('停止同库服务后再试');
    expect(prompt.confirm).not.toHaveBeenCalled();
    expect(startListener).not.toHaveBeenCalled();
    expect(sendCard).not.toHaveBeenCalled();
  });

  it('fails closed before prompting when the runtime lease cannot be acquired', async () => {
    const prompt = prompter();
    const loadBot = vi.fn(async () => bot);
    const startListener = vi.fn(async () => vi.fn());
    const sendCard = vi.fn();
    const acquireRuntime = vi.fn(() => { throw new Error('synthetic runtime busy'); });
    const result = await smoke({ prompter: prompt }, { loadBot, acquireRuntime, startListener, sendCard });
    expect(result.status).toBe('unavailable');
    expect(result.message).toContain('runtime');
    expect(prompt.confirm).not.toHaveBeenCalled();
    expect(loadBot).not.toHaveBeenCalled();
    expect(startListener).not.toHaveBeenCalled();
    expect(sendCard).not.toHaveBeenCalled();
  });

  it('releases the preflight lease and refuses when reacquisition fails after confirmation', async () => {
    const prompt = prompter();
    const startListener = vi.fn(async () => vi.fn());
    const sendCard = vi.fn();
    const close = vi.fn();
    const acquireRuntime = vi.fn()
      .mockImplementationOnce(() => ({ close }))
      .mockImplementationOnce(() => { throw new Error('synthetic runtime busy'); });
    const result = await smoke({ prompter: prompt }, {
      loadBot: async () => bot, acquireRuntime, startListener, sendCard
    });
    expect(result.status).toBe('unavailable');
    expect(acquireRuntime).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledOnce();
    expect(prompt.confirm).toHaveBeenCalledOnce();
    expect(startListener).not.toHaveBeenCalled();
    expect(sendCard).not.toHaveBeenCalled();
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
    const startListener = vi.fn(async () => vi.fn());
    const sendCard = vi.fn();
    let result;
    try {
      result = await offerLarkSetupSmoke(options({ database, prompter: prompt }), { startListener, sendCard });
    } finally { rootService.close(); }
    expect(result.status).toBe('unavailable');
    expect(result.message).toContain('同库服务');
    expect(daemonProbe.calls).toBe(1);
    expect(prompt.confirm).not.toHaveBeenCalled();
    expect(startListener).not.toHaveBeenCalled();
    expect(sendCard).not.toHaveBeenCalled();
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
    const sendCard = vi.fn(async () => {
      expectRuntimeBusy();
      onEvent?.(ownerEvent);
      return { messageId: 'om_test_card', chatId: 'oc_dm' };
    });
    const result = await offerLarkSetupSmoke(options({ database }), {
      startListener: async (_bot, receive) => {
        expectRuntimeBusy();
        onEvent = receive;
        return stop;
      },
      sendCard
    });
    expect(result.status).toBe('verified');
    expect(sendCard).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
    const reopened = createRepositories(database, { mode: 'runtime' });
    reopened.close();
  });

  it('does not offer the smoke for an explicitly supplied non-open ID', async () => {
    const prompt = prompter();
    const sendCard = vi.fn();
    const startListener = vi.fn(async () => vi.fn());
    const result = await smoke({ ownerOpenId: 'generic-console-user-id', prompter: prompt }, {
      loadBot: async () => bot, startListener, sendCard
    });
    expect(result.status).toBe('unavailable');
    expect(result.message).toContain('所有者');
    expect(prompt.confirm).not.toHaveBeenCalled();
    expect(startListener).not.toHaveBeenCalled();
    expect(sendCard).not.toHaveBeenCalled();
  });

  it('does not offer the smoke without a usable saved bot', async () => {
    const prompt = prompter();
    const result = await smoke({ prompter: prompt }, {
      loadBot: async () => undefined, sendCard: vi.fn()
    });
    expect(result.status).toBe('unavailable');
    expect(prompt.confirm).not.toHaveBeenCalled();
  });

  it('starts listening before sending one UUID card and verifies the owner p2p reply', async () => {
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
    const sendCard = vi.fn(async (_bot, input: { uuid: string; ownerOpenId: string }) => {
      expect(held).toBe(true);
      order.push('send');
      expect(input.uuid).toBe('uuid_fixed');
      expect(input.ownerOpenId).toBe('ou_owner');
      onEvent?.(ownerEvent);
      return { messageId: 'om_test_card', chatId: 'oc_dm' };
    });
    const result = await smoke({}, {
      loadBot: async () => bot,
      acquireRuntime,
      startListener: async (_bot, receive) => {
        expect(held).toBe(true);
        order.push('start');
        onEvent = receive;
        return stop;
      },
      sendCard,
      uuid: () => 'uuid_fixed'
    });
    expect(result.status).toBe('verified');
    expect(result.message).toContain('端到端');
    expect(sendCard).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(acquireRuntime).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(2);
    expect(held).toBe(false);
    expect(order).toEqual(['release', 'start', 'send', 'stop', 'release']);
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
    const pending = smoke({}, {
      loadBot: async () => bot,
      acquireRuntime: () => ({ close }),
      startListener: async (_bot, receive) => { onEvent = receive; return stop; },
      sendCard: async () => {
        onEvent?.(ownerEvent);
        return { messageId: 'om_test_card', chatId: 'oc_dm' };
      }
    });
    await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
    const closesBeforeStopFinished = close.mock.calls.length;
    finishStop();
    expect((await pending).status).toBe('verified');
    expect(closesBeforeStopFinished).toBe(1); // Only the preflight lease has closed.
    expect(order).toEqual([
      'runtime.close', 'listener-and-loopback.stop.begin', 'listener-and-loopback.stop.end', 'runtime.close'
    ]);
  });

  it('retains the runtime lease when final transport cleanup cannot be confirmed', async () => {
    const close = vi.fn();
    let onEvent: ((event: LarkSmokeEvent) => void) | undefined;
    const result = await smoke({}, {
      loadBot: async () => bot,
      acquireRuntime: () => ({ close }),
      startListener: async (_bot, receive) => {
        onEvent = receive;
        return async () => { throw new Error('synthetic unconfirmed transport close'); };
      },
      sendCard: async () => {
        onEvent?.(ownerEvent);
        return { messageId: 'om_test_card', chatId: 'oc_dm' };
      }
    });
    expect(result.status).toBe('unavailable');
    expect(result.message).toContain('保留 runtime');
    // Only the preflight lease closed; the lease used by the listener is retained.
    expect(close).toHaveBeenCalledOnce();
  });

  it('reports send failure without claiming inbound or end-to-end verification', async () => {
    const stop = vi.fn();
    const close = vi.fn();
    const acquireRuntime = vi.fn(() => ({ close }));
    let onEvent: ((event: LarkSmokeEvent) => void) | undefined;
    const result = await smoke({}, {
      loadBot: async () => bot,
      acquireRuntime,
      startListener: async (_bot, receive) => { onEvent = receive; return stop; },
      sendCard: async () => { onEvent?.(ownerEvent); throw new Error('synthetic send failure'); }
    });
    expect(result.status).toBe('send_failed');
    expect(result.message).toContain('发送');
    expect(result.message).toContain('入站未验证');
    expect(result.message).not.toContain('端到端通过');
    expect(stop).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledTimes(2);
    expect(stop.mock.invocationCallOrder[0]).toBeLessThan(close.mock.invocationCallOrder[1]!);
  });

  it('marks a successful send without a reply as inbound unverified after the bounded wait', async () => {
    vi.useFakeTimers();
    const stop = vi.fn();
    const close = vi.fn();
    const acquireRuntime = vi.fn(() => ({ close }));
    const pending = smoke({}, {
      loadBot: async () => bot,
      acquireRuntime,
      startListener: async () => stop,
      sendCard: async () => ({ messageId: 'om_test_card', chatId: 'oc_dm' })
    });
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await pending;
    expect(result.status).toBe('inbound_unverified');
    expect(result.message).toContain('入站未验证');
    expect(result.message).not.toContain('端到端通过');
    expect(stop).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledTimes(2);
    expect(stop.mock.invocationCallOrder[0]).toBeLessThan(close.mock.invocationCallOrder[1]!);
  });

  it('does not verify an unrelated owner private message', async () => {
    vi.useFakeTimers();
    let onEvent: ((event: LarkSmokeEvent) => void) | undefined;
    const pending = smoke({}, {
      loadBot: async () => bot,
      startListener: async (_bot, receive) => { onEvent = receive; return vi.fn(); },
      sendCard: async () => {
        onEvent?.({ ...ownerEvent, eventId: 'old_owner', messageId: 'old_owner', parentId: 'om_old', content: '{"text":"unrelated"}' });
        return { messageId: 'om_test_card', chatId: 'oc_dm' };
      }
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await pending).status).toBe('inbound_unverified');
  });

  it('verifies a UUID-bearing owner reply delivered while send is completing', async () => {
    let onEvent: ((event: LarkSmokeEvent) => void) | undefined;
    const result = await smoke({}, {
      loadBot: async () => bot,
      startListener: async (_bot, receive) => { onEvent = receive; return vi.fn(); },
      sendCard: async () => {
        onEvent?.({ ...ownerEvent, parentId: undefined, rootId: undefined, content: '{"text":"reply uuid_fixed"}' });
        return { messageId: 'om_test_card', chatId: 'oc_dm' };
      },
      uuid: () => 'uuid_fixed'
    });
    expect(result.status).toBe('verified');
  });

  it('ignores another user, a group message and a bot sender', async () => {
    vi.useFakeTimers();
    let onEvent: ((event: LarkSmokeEvent) => void) | undefined;
    const pending = smoke({}, {
      loadBot: async () => bot,
      startListener: async (_bot, receive) => { onEvent = receive; return vi.fn(); },
      sendCard: async () => {
        onEvent?.({ ...ownerEvent, eventId: 'other_user', messageId: 'other_user', senderOpenId: 'ou_other' });
        onEvent?.({ ...ownerEvent, eventId: 'group', messageId: 'group', chatType: 'group' });
        onEvent?.({ ...ownerEvent, eventId: 'bot', messageId: 'bot', senderType: 'app' });
        return { messageId: 'om_test_card', chatId: 'oc_dm' };
      }
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await pending).status).toBe('inbound_unverified');
  });

  it('accepts the owner after another user and settles duplicate deliveries only once', async () => {
    let onEvent: ((event: LarkSmokeEvent) => void) | undefined;
    const stop = vi.fn();
    const sendCard = vi.fn(async () => {
      onEvent?.({ ...ownerEvent, eventId: 'other', messageId: 'other', senderOpenId: 'ou_other' });
      onEvent?.(ownerEvent);
      onEvent?.(ownerEvent);
      onEvent?.({ ...ownerEvent, eventId: 'same_message_redelivered' });
      return { messageId: 'om_test_card', chatId: 'oc_dm' };
    });
    const result = await smoke({}, {
      loadBot: async () => bot,
      startListener: async (_bot, receive) => { onEvent = receive; return stop; },
      sendCard
    });
    expect(result.status).toBe('verified');
    expect(sendCard).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
  });

  it('uses the environment base URL for owner, token and send requests in the default implementation', async () => {
    const requests: string[] = [];
    let onEvent: ((event: LarkSmokeEvent) => void) | undefined;
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://fixture.invalid');
      const json = (body: unknown) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(body));
      };
      request.resume();
      if (request.method === 'POST' && url.pathname === '/open-apis/auth/v3/tenant_access_token/internal/') {
        requests.push(`${url.pathname}${url.search}`);
        json({ code: 0, tenant_access_token: 'fixture-token', expire: 7200 });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/open-apis/application/v6/applications/cli_smoke') {
        requests.push(`${url.pathname}${url.search}`);
        json({ code: 0, data: { app: { app_id: 'cli_smoke', owner: { type: 2, owner_id: 'ou_owner' } } } });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/open-apis/im/v1/messages') {
        requests.push(`${url.pathname}${url.search}`);
        json({ code: 0, data: { message_id: 'om_test_card', chat_id: 'oc_dm' } });
        onEvent?.(ownerEvent);
        return;
      }
      response.writeHead(404).end();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No loopback address for the Lark stub');
    vi.stubEnv('LARK_OPEN_API_BASE_URL', `http://127.0.0.1:${address.port}`);
    vi.stubEnv('LARK_API_QPS', '1000');
    vi.stubEnv('LARK_API_BURST', '1000');
    vi.stubEnv('LARK_API_RETRY_MAX_ATTEMPTS', '0');
    try {
      const stop = vi.fn();
      const result = await smoke({ ownerOpenId: undefined }, {
        loadBot: async () => bot,
        startListener: async (_bot, receive) => { onEvent = receive; return stop; }
      });
      expect(result.status).toBe('verified');
      expect(stop).toHaveBeenCalledOnce();
      expect(requests).toEqual([
        '/open-apis/auth/v3/tenant_access_token/internal/',
        '/open-apis/application/v6/applications/cli_smoke?lang=zh_cn&user_id_type=open_id',
        '/open-apis/auth/v3/tenant_access_token/internal/',
        '/open-apis/im/v1/messages?receive_id_type=open_id'
      ]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('cleans up and does not send if the listener cannot start', async () => {
    const sendCard = vi.fn();
    const close = vi.fn();
    const acquireRuntime = vi.fn(() => ({ close }));
    const result = await smoke({}, {
      loadBot: async () => bot,
      acquireRuntime,
      startListener: async () => { throw new Error('synthetic listener failure'); },
      sendCard
    });
    expect(result.status).toBe('unavailable');
    expect(result.message).toContain('监听');
    expect(sendCard).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(2);
  });
});
