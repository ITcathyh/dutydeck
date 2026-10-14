import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepositories } from '@dutydeck/storage';
import type * as LarkSdk from '@larksuiteoapi/node-sdk';
import { LarkLongConnectionListener, LarkMessageCoordinator } from './listener.js';
import { cardActionRoute, parseCardActionForwarding } from './card-action-forwarding.js';
import { readLarkConfig, saveLarkConfig, type StoredLarkConfig } from './config.js';

// Keep the real SDK parser and dispatcher; only the network connection is isolated.
const sdk = vi.hoisted(() => ({ dispatcher: undefined as LarkSdk.EventDispatcher | undefined }));
vi.mock('@larksuiteoapi/node-sdk', async importOriginal => ({
  ...await importOriginal<typeof LarkSdk>(),
  WSClient: class {
    constructor(private readonly options: { onReady(): void }) {}
    async start({ eventDispatcher }: { eventDispatcher: LarkSdk.EventDispatcher }) { sdk.dispatcher = eventDispatcher; this.options.onReady(); }
    close() {}
  }
}));

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });
const forwarding = { owner: 'sample-service', url: 'http://127.0.0.1:1/callback', token: 'private-forward-token', legacyActions: ['ack', 'investigate'] };
const click = (value: unknown = { owner: forwarding.owner, action: 'ack' }, eventId = 'ev_click') => ({
  schema: '2.0', header: { event_id: eventId, event_type: 'card.action.trigger', app_id: 'untrusted-app' },
  event: { token: 'callback-token', operator: { open_id: 'ou_operator', user_id: 'u1', union_id: 'on1' },
    context: { open_message_id: 'om_card', open_chat_id: 'oc_chat' }, action: { tag: 'button', value, form_value: { text: 'keep me' } } }
});

async function stub(handle: (request: IncomingMessage, response: ServerResponse, body: any) => void) {
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    handle(request, response, JSON.parse(raw));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }));
  const address = server.address() as { port: number };
  return `http://127.0.0.1:${address.port}/callback`;
}
const reply = (response: ServerResponse, status: number, value: unknown) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };

async function listener(url: string) {
  const config = { appId: 'cli_trusted', appSecret: 'fake', listening: true, permissionMode: 'ask', preInjectPrompt: '',
    cardActionForwarding: { ...forwarding, url } } as StoredLarkConfig;
  const handleAction = vi.spyOn(LarkMessageCoordinator.prototype, 'handleAction').mockResolvedValue({ type: 'success', content: '内置动作已执行。' });
  const runtime = { listSessions: vi.fn(async () => []), getSession: vi.fn(), subscribe: vi.fn(() => vi.fn()), send: vi.fn(), dispatch: vi.fn() };
  const fetcher: typeof fetch = async (input, init) => {
    const target = String(input);
    if (target.includes('/tenant_access_token/')) return new Response(JSON.stringify({ code: 0, tenant_access_token: 'fake', expire: 7200 }));
    if (target.includes('/bot/v3/info')) return new Response(JSON.stringify({ code: 0, bot: { open_id: 'ou_bot' } }));
    return fetch(input, init);
  };
  const connection = new LarkLongConnectionListener({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }, { fetcher, runtime: runtime as any });
  await connection.start(config);
  cleanups.push(() => connection.stop());
  return { connection, config, handleAction, runtime, invoke: (event = click()) => sdk.dispatcher!.invoke(event, { needCheck: false }) };
}

describe('card forwarding via the SDK dispatcher and real HTTP', () => {
  it('keeps the complete SDK event and trusted app ID; delegates duplicates to the receiver', async () => {
    const requests: any[] = [];
    const url = await stub((request, response, body) => {
      requests.push({ body, authorization: request.headers.authorization, contentType: request.headers['content-type'] });
      reply(response, requests.length === 1 ? 202 : 200, { status: requests.length === 1 ? 'accepted' : 'duplicate', event_id: body.event.event_id });
    });
    const h = await listener(url);
    expect(await h.invoke()).toMatchObject({ toast: { type: 'success', content: '已受理。' } });
    expect(await h.invoke()).toMatchObject({ toast: { type: 'success', content: expect.stringContaining('已接收') } });
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({ authorization: `Bearer ${forwarding.token}`, contentType: 'application/json',
      body: { version: 1, app_id: 'cli_trusted', event: { ...click().event, event_id: 'ev_click', app_id: 'untrusted-app', schema: '2.0' } } });
    expect(h.handleAction).not.toHaveBeenCalled(); expect(h.runtime.send).not.toHaveBeenCalled(); expect(h.runtime.dispatch).not.toHaveBeenCalled();
  });

  it('routes legacy actions, preserves built-in deduplication, and rejects unknown owners and conflicts', async () => {
    const requests: any[] = [];
    const url = await stub((_request, response, body) => { requests.push(body); reply(response, 202, { status: 'accepted', event_id: body.event.event_id }); });
    const h = await listener(url);
    await h.invoke(click({ action: 'investigate' }, 'ev_legacy'));
    const builtin = click({ action: 'cancel', task_id: 'task1' }, 'ev_builtin');
    expect(await h.invoke(builtin)).toMatchObject({ toast: { content: '内置动作已执行。' } });
    await h.invoke(builtin);
    await h.invoke(click({ dutydeck_confirm: 'confirm' }, 'ev_confirm'));
    await h.invoke(click({ dockmux_workflow: 'approve' }, 'ev_compat'));
    for (const value of [{ owner: 'unknown', action: 'ack' }, { owner: forwarding.owner, taskId: 'task1', action: 'ack' }, { owner: forwarding.owner, dutydeck_confirm: 'confirm' }]) {
      expect(await h.invoke(click(value))).toMatchObject({ toast: { type: 'error' } });
    }
    expect(requests).toHaveLength(1); expect(h.handleAction).toHaveBeenCalledTimes(3);
    await h.connection.start({ ...h.config, cardActionForwarding: undefined });
    expect(await h.invoke(click())).toMatchObject({ toast: { type: 'error' } });
    expect(requests).toHaveLength(1);
  });

  it.each([
    [401, { status: 'accepted', event_id: 'ev_click' }], [204, undefined],
    [200, { status: 'accepted', event_id: 'ev_click' }], [202, { status: 'duplicate', event_id: 'ev_click' }],
    [202, { status: 'accepted', event_id: 'wrong-event' }], [202, { status: 'accepted' }], [202, 'bad json']
  ])('does not accept HTTP %s with invalid receipt %j, and retries the same event on redelivery', async (status, receipt) => {
    let attempts = 0;
    const url = await stub((_request, response, body) => {
      attempts++;
      if (attempts > 1) reply(response, 202, { status: 'accepted', event_id: body.event.event_id });
      else if (receipt === 'bad json') { response.writeHead(status); response.end('not-json'); }
      else reply(response, status, receipt);
    });
    const h = await listener(url);
    expect(await h.invoke()).toMatchObject({ toast: { type: 'error' } });
    expect(await h.invoke()).toMatchObject({ toast: { type: 'success' } });
    expect(attempts).toBe(2); expect(h.handleAction).not.toHaveBeenCalled();
  });

  it('times out within the callback budget without claiming non-execution or automatically retrying', async () => {
    let attempts = 0;
    const url = await stub(() => { attempts++; });
    const h = await listener(url);
    const started = performance.now();
    expect(await h.invoke()).toMatchObject({ toast: { type: 'warning', content: expect.stringContaining('结果待确认') } });
    expect(performance.now() - started).toBeLessThan(2_800);
    expect(attempts).toBe(1); expect(h.handleAction).not.toHaveBeenCalled();
  });

  it('refuses redirects and never sends the token to the redirect target', async () => {
    let leaked = false;
    const target = await stub((_request, response) => { leaked = true; reply(response, 202, {}); });
    const url = await stub((_request, response) => { response.writeHead(307, { Location: target }); response.end(); });
    const h = await listener(url);
    expect(await h.invoke()).toMatchObject({ toast: { type: 'error' } });
    expect(leaked).toBe(false);
  });

  it('rejects a missing event ID before contacting the receiver', async () => {
    let requests = 0;
    const url = await stub((_request, response) => { requests++; reply(response, 202, {}); });
    const h = await listener(url);
    expect(await h.invoke(click(undefined, ''))).toMatchObject({ toast: { type: 'error', content: expect.stringContaining('event_id') } });
    expect(requests).toBe(0); expect(h.handleAction).not.toHaveBeenCalled();
  });
});

it('validates local HTTP/HTTPS destinations and precisely reserves existing built-in actions', () => {
  for (const url of ['http://127.0.0.1:8000/callback', 'http://localhost:8000', 'http://[::1]:8000', 'https://receiver.example/callback']) {
    expect(parseCardActionForwarding({ ...forwarding, url })).toHaveProperty('url');
  }
  for (const url of ['http://example.com', 'http://127.0.0.2', 'ftp://localhost', 'https://user:password@example.com', 'https://example.com/#fragment']) {
    expect(() => parseCardActionForwarding({ ...forwarding, url })).toThrow();
  }
  for (const action of ['cancel', 'retry', 'steer_inject', 'detail', 'resolve_retry', 'dutydeck_custom']) {
    expect(() => parseCardActionForwarding({ ...forwarding, legacyActions: [action] })).toThrow();
  }
  expect(parseCardActionForwarding(null)).toBeUndefined();
  expect(cardActionRoute({ owner: 'unknown', task_id: 't' }, forwarding)).toBe('conflict');
});

it('reloads forwarding credentials after closing and reopening the persistent configuration database', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dutydeck-card-forwarding-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const database = join(directory, 'test.sqlite');
  const first = createRepositories(database);
  try {
    await saveLarkConfig(first.config, undefined, { appId: 'cli_persistent', appSecret: 'fake', permissionMode: 'ask', cardActionForwarding: forwarding });
  } finally { first.close(); }
  const restarted = createRepositories(database);
  try {
    expect(await readLarkConfig(restarted.config, 'cli_persistent')).toMatchObject({ cardActionForwarding: forwarding });
    await saveLarkConfig(restarted.config, undefined, { originalAppId: 'cli_persistent', cardActionForwarding: null });
  } finally { restarted.close(); }
  const disabled = createRepositories(database);
  try { expect(await readLarkConfig(disabled.config, 'cli_persistent')).not.toHaveProperty('cardActionForwarding'); }
  finally { disabled.close(); }
});
