import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as LarkSdk from '@larksuiteoapi/node-sdk';
import { createRepositories } from '@dutydeck/storage';
import { LarkLongConnectionListener, LarkMessageCoordinator } from './listener.js';
import { parseLarkEventHandlers, type LarkEventHandler } from './event-pipeline.js';
import { readLarkConfig, saveLarkConfig, type StoredLarkConfig } from './config.js';

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
const click = (value: unknown = { owner: 'sample-service', action: 'ack' }, id = 'ev_card') => ({
  schema: '2.0', header: { event_id: id, event_type: 'card.action.trigger', app_id: 'untrusted-app' },
  event: { token: 'callback-token', operator: { open_id: 'ou_operator' }, context: { open_message_id: 'om_card', open_chat_id: 'oc_chat' },
    action: { tag: 'button', value, form_value: { answer: 'keep me' } } }
});
const message = () => ({ schema: '2.0', header: { event_id: 'ev_message', event_type: 'im.message.receive_v1', app_id: 'untrusted-app' },
  event: { sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' },
    message: { message_id: 'om_message', chat_id: 'oc_dm', chat_type: 'p2p', message_type: 'text', content: '{"text":"hello"}', mentions: [] } } });
const handler = (id: string, url: string, patch: Partial<LarkEventHandler> = {}): LarkEventHandler => ({
  id, eventTypes: ['card.action.trigger'], url, token: `secret-${id}`, ...patch
});
const reply = (response: ServerResponse, body: unknown, status = 200) => {
  response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body));
};
async function stub(handle: (request: IncomingMessage, response: ServerResponse, body: any) => void) {
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    handle(request, response, JSON.parse(raw));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/events`;
}
async function harness(eventHandlers: LarkEventHandler[]) {
  const config = { appId: 'cli_trusted', appSecret: 'fake', listening: true, permissionMode: 'ask', preInjectPrompt: '', eventHandlers } as StoredLarkConfig;
  const repos = createRepositories(':memory:'); cleanups.push(() => repos.close());
  const receive = vi.spyOn(LarkMessageCoordinator.prototype, 'receive').mockResolvedValue();
  const handleAction = vi.spyOn(LarkMessageCoordinator.prototype, 'handleAction').mockResolvedValue({ type: 'success', content: '内置动作已执行。' });
  const remoteWrites: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const target = String(input);
    if (target.includes('/tenant_access_token/')) return new Response(JSON.stringify({ code: 0, tenant_access_token: 'fake', expire: 7200 }));
    if (target.includes('/bot/v3/info')) return new Response(JSON.stringify({ code: 0, bot: { open_id: 'ou_bot' } }));
    if (target.includes('/open-apis/')) { remoteWrites.push(target); return new Response(JSON.stringify({ code: 0, data: { message_id: 'om_welcome' } })); }
    return fetch(input, init);
  };
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const connection = new LarkLongConnectionListener(log, { fetcher, welcomeStore: repos.config,
    runtime: { listSessions: async () => [], subscribe: () => () => {} } as any });
  await connection.start(config); cleanups.push(() => connection.stop());
  return { connection, config, handleAction, receive, remoteWrites, log, invoke: (event = click()) => sdk.dispatcher!.invoke(event, { needCheck: false }),
    invokeMessage: () => sdk.dispatcher!.invoke(message(), { needCheck: false }) };
}

describe('ordered event pipeline through the real SDK and HTTP', () => {
  it('executes in registration order, preserves complete events and trusted identity, and stops before later handlers and built-ins', async () => {
    const requests: any[] = [];
    const url = await stub((request, response, body) => {
      requests.push({ authorization: request.headers.authorization, body });
      reply(response, { event_id: body.event.event_id, decision: body.handler_id === 'observer' ? 'continue' : 'stop',
        ...(body.handler_id === 'receiver' ? { toast: { type: 'success', content: '受理完毕' } } : {}) }, 202);
    });
    const h = await harness([handler('observer', url), handler('receiver', url), handler('later', url)]);
    expect(await h.invoke()).toEqual({ toast: { type: 'success', content: '受理完毕' } });
    expect(requests.map(request => request.body.handler_id)).toEqual(['observer', 'receiver']);
    expect(requests[0]).toMatchObject({ authorization: 'Bearer secret-observer', body: { version: 1, app_id: 'cli_trusted', handler_id: 'observer', event_type: 'card.action.trigger',
      event: { ...click().event, event_id: 'ev_card', app_id: 'untrusted-app', schema: '2.0' } } });
    expect(h.handleAction).not.toHaveBeenCalled(); expect(h.receive).not.toHaveBeenCalled();
    const audits = h.log.info.mock.calls.filter(([, text]) => text === '飞书外部事件处理');
    expect(audits.map(([details]) => details)).toEqual([
      { eventType: 'card.action.trigger', handlerId: 'observer', eventId: 'ev_card', result: 'continue' },
      { eventType: 'card.action.trigger', handlerId: 'receiver', eventId: 'ev_card', result: 'stop' }
    ]);
    expect(JSON.stringify(audits)).not.toContain('secret'); expect(JSON.stringify(audits)).not.toContain('callback-token');
  });

  it('runs all matching handlers before built-ins and ignores continue toasts', async () => {
    const calls: string[] = [];
    const url = await stub((_request, response, body) => { calls.push(body.handler_id); reply(response, { event_id: body.event.event_id, decision: 'continue', toast: { type: 'info', content: '仅观察' } }); });
    const h = await harness([handler('first', url), handler('second', url)]);
    h.handleAction.mockImplementation(async () => { expect(calls).toEqual(['first', 'second']); return { type: 'success', content: '内置动作已执行。' }; });
    expect(await h.invoke()).toEqual({ toast: { type: 'success', content: '内置动作已执行。' } });
    expect(h.handleAction).toHaveBeenCalledOnce();
  });

  it('matches owners and ownerless legacy actions, leaves unmatched ownerless cards alone, and rejects unknown owners', async () => {
    const calls: any[] = [];
    const url = await stub((_request, response, body) => { calls.push(body); reply(response, { event_id: body.event.event_id, decision: 'stop' }); });
    const h = await harness([handler('scoped', url, { owner: 'sample-service', legacyActions: ['ack'] })]);
    await h.invoke(); await h.invoke(click(JSON.stringify({ action: 'ack' }), 'ev_legacy'));
    await h.invoke(click({ action: 'other' }, 'ev_unmatched'));
    expect(await h.invoke(click({ owner: 'unknown', action: 'ack' }))).toMatchObject({ toast: { type: 'error' } });
    expect(calls).toHaveLength(2); expect(h.handleAction).toHaveBeenCalledOnce();
  });

  it('keeps every built-in marker out of catch-all handlers and rejects mixed ownership', async () => {
    const called = vi.fn();
    const url = await stub((_request, response, body) => { called(); reply(response, { event_id: body.event.event_id, decision: 'stop' }); });
    const h = await harness([handler('catch-all', url)]);
    const values = [{ task_id: 't', action: 'cancel' }, { taskId: 't', action: 'retry' }, { dutydeck_confirm: 'confirm' }, { dutydeck_help_page: '1' }, { dockmux_workflow: 'approve' }];
    for (const [index, value] of values.entries()) await h.invoke(click(value, `ev_builtin_${index}`));
    await h.invoke(click(values[0], 'ev_builtin_0'));
    for (const value of values) expect(await h.invoke(click({ ...value, owner: 'sample-service' }))).toMatchObject({ toast: { type: 'error' } });
    expect(called).not.toHaveBeenCalled(); expect(h.handleAction).toHaveBeenCalledTimes(values.length);
  });

  it('continues an ordinary message to receive and welcome, but stop suppresses both and later handlers', async () => {
    const calls: any[] = [];
    let decision = 'stop';
    const url = await stub((_request, response, body) => { calls.push(body); reply(response, { event_id: body.event.event_id, decision, toast: { type: 'info', content: '忽略消息toast' } }); });
    const h = await harness([handler('messages', url, { eventTypes: ['im.message.receive_v1'] }), handler('later', url, { eventTypes: ['im.message.receive_v1'] })]);
    await h.invokeMessage(); await new Promise(resolve => setImmediate(resolve));
    expect(calls).toHaveLength(1); expect(h.receive).not.toHaveBeenCalled(); expect(h.remoteWrites).toHaveLength(0);
    expect(calls[0]).toMatchObject({ event_type: 'im.message.receive_v1', event: { ...message().event, event_id: 'ev_message' } });
    decision = 'continue'; await h.invokeMessage();
    expect(h.receive).toHaveBeenCalledOnce(); await vi.waitFor(() => expect(h.remoteWrites).toHaveLength(1));
  });

  it('propagates message receiver failure through the SDK instead of ACKing and starting built-ins', async () => {
    const url = await stub((_request, response) => reply(response, {}, 503));
    const h = await harness([handler('messages', url, { eventTypes: ['im.message.receive_v1'] })]);
    await expect(h.invokeMessage()).rejects.toMatchObject({ code: 'LARK_EVENT_HANDLER_FAILED' });
    expect(h.receive).not.toHaveBeenCalled(); expect(h.remoteWrites).toHaveLength(0);
  });

  it('the real WebSocket SDK emits a 500 receipt for message failure without local redelivery', async () => {
    const requests = vi.fn();
    const url = await stub((_request, response) => { requests(); reply(response, {}, 503); });
    const h = await harness([handler('messages', url, { eventTypes: ['im.message.receive_v1'] })]);
    const actual = await vi.importActual<typeof LarkSdk>('@larksuiteoapi/node-sdk');
    const client = new actual.WSClient({ appId: h.config.appId, appSecret: 'fake', loggerLevel: actual.LoggerLevel.error,
      logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), trace: vi.fn() } }) as any;
    cleanups.push(() => client.close());
    client.eventDispatcher = sdk.dispatcher;
    vi.spyOn(client.dataCache, 'mergeData').mockReturnValue(message());
    const send = vi.spyOn(client, 'sendMessage').mockImplementation(() => {});
    await client.handleEventData({ headers: [{ key: 'type', value: 'event' }, { key: 'message_id', value: 'wire_message' },
      { key: 'sum', value: '1' }, { key: 'seq', value: '0' }], payload: new Uint8Array() });
    expect(send).toHaveBeenCalledOnce();
    expect(JSON.parse(new TextDecoder().decode((send.mock.calls[0]![0] as any).payload))).toEqual({ code: 500 });
    await new Promise(resolve => setImmediate(resolve));
    expect(requests).toHaveBeenCalledOnce(); expect(h.receive).not.toHaveBeenCalled(); expect(h.remoteWrites).toHaveLength(0);
  });

  it('preserves original card handling when only message handlers are registered', async () => {
    const called = vi.fn(); const url = await stub((_request, response) => { called(); reply(response, {}); });
    const h = await harness([handler('messages', url, { eventTypes: ['im.message.receive_v1'] })]);
    await h.invoke(click({ owner: 'unknown', action: 'ack' }));
    await h.invoke(click({ owner: 'unknown', task_id: 't', action: 'cancel' }, 'ev_builtin'));
    expect(called).not.toHaveBeenCalled(); expect(h.handleAction).toHaveBeenCalledTimes(2);
  });

  it('delegates replay deduplication to each receiver and preserves the stop decision', async () => {
    const seen = new Set<string>(); const executions: string[] = []; let calls = 0;
    const url = await stub((_request, response, body) => {
      calls++; const key = [body.app_id, body.handler_id, body.event.event_id].join(':');
      const duplicate = seen.has(key); if (!duplicate) { seen.add(key); executions.push(key); }
      reply(response, { event_id: body.event.event_id, decision: body.handler_id === 'observer' ? 'continue' : 'stop', status: duplicate ? 'duplicate' : 'accepted' }, duplicate ? 200 : 202);
    });
    const h = await harness([handler('observer', url), handler('receiver', url)]);
    await h.invoke(); await h.invoke();
    expect(calls).toBe(4); expect(executions).toEqual(['cli_trusted:observer:ev_card', 'cli_trusted:receiver:ev_card']); expect(h.handleAction).not.toHaveBeenCalled();
  });

  it.each([
    [401, { event_id: 'ev_card', decision: 'stop' }], [204, {}], [200, { event_id: 'wrong', decision: 'stop' }],
    [202, { decision: 'continue' }], [200, { event_id: 'ev_card' }], [200, { event_id: 'ev_card', decision: 'unknown' }],
    [200, { event_id: 'ev_card', decision: 'stop', toast: { type: 'danger', content: 'invalid' } }],
    [200, { event_id: 'ev_card', decision: 'continue', toast: { type: 'success', content: '' } }],
    [200, { event_id: 'ev_card', decision: 'stop', toast: { type: ['success'], content: 'invalid' } }], [200, 'not-json']
  ])('stops on HTTP %s / invalid receipt %j and does not run later handlers or built-ins', async (status, receipt) => {
    const calls: string[] = [];
    const url = await stub((_request, response, body) => { calls.push(body.handler_id); if (receipt === 'not-json') { response.writeHead(status); response.end('not-json'); } else reply(response, receipt, status); });
    const h = await harness([handler('first', url), handler('later', url)]);
    expect(await h.invoke()).toMatchObject({ toast: { type: 'error' } });
    expect(calls).toEqual(['first']); expect(h.handleAction).not.toHaveBeenCalled();
  });

  it('rejects missing event IDs without sending a request', async () => {
    const calls = vi.fn(); const url = await stub((_request, response) => { calls(); reply(response, {}); });
    const h = await harness([handler('first', url)]);
    expect(await h.invoke(click(undefined, ''))).toMatchObject({ toast: { type: 'error', content: expect.stringContaining('event_id') } });
    expect(calls).not.toHaveBeenCalled(); expect(h.handleAction).not.toHaveBeenCalled();
  });

  it('refuses redirects without leaking credentials or reaching later handlers', async () => {
    const leaked = vi.fn(); const target = await stub((_request, response) => { leaked(); reply(response, {}); });
    const url = await stub((_request, response) => { response.writeHead(307, { Location: target }); response.end(); });
    const h = await harness([handler('first', url), handler('later', target)]);
    expect(await h.invoke()).toMatchObject({ toast: { type: 'error' } }); expect(leaked).not.toHaveBeenCalled(); expect(h.handleAction).not.toHaveBeenCalled();
  });

  it.each(['headers', 'body'] as const)('shares a two-second deadline across handlers including stalled %s', async phase => {
    const calls: string[] = [];
    const url = await stub((_request, response, body) => {
      calls.push(body.handler_id);
      if (body.handler_id === 'first') {
        const timer = setTimeout(() => reply(response, { event_id: body.event.event_id, decision: 'continue' }), 1_100);
        cleanups.push(() => clearTimeout(timer));
      } else if (phase === 'body') { response.writeHead(200, { 'Content-Type': 'application/json' }); response.write('{'); }
    });
    const h = await harness([handler('first', url), handler('second', url), handler('later', url)]);
    const started = performance.now();
    expect(await h.invoke()).toMatchObject({ toast: { type: 'warning', content: expect.stringContaining('结果待确认') } });
    const elapsed = performance.now() - started;
    expect(elapsed).toBeGreaterThan(1_800); expect(elapsed).toBeLessThan(2_800);
    expect(calls).toEqual(['first', 'second']); expect(h.handleAction).not.toHaveBeenCalled();
  });

  it('updates handlers and credentials without reconnecting', async () => {
    const calls: any[] = [];
    const url = await stub((request, response, body) => { calls.push({ id: body.handler_id, token: request.headers.authorization }); reply(response, { event_id: body.event.event_id, decision: 'stop' }); });
    const h = await harness([handler('first', url)]); const dispatcher = sdk.dispatcher;
    await h.invoke(); await h.connection.start({ ...h.config, eventHandlers: [handler('new', url)] }); await h.invoke();
    expect(sdk.dispatcher).toBe(dispatcher); expect(calls).toEqual([{ id: 'first', token: 'Bearer secret-first' }, { id: 'new', token: 'Bearer secret-new' }]);
  });
});

it('validates handler IDs, types, card filters and credentials at configuration boundaries', () => {
  const item = handler('one', 'http://127.0.0.1:1/events');
  for (const invalid of [{ ...item, id: '' }, { ...item, eventTypes: [] }, { ...item, eventTypes: ['unknown'] },
    { ...item, token: 'bad\r\ntoken' }, { ...item, url: 'http://remote.example' }, { ...item, owner: '' },
    { ...item, legacyActions: ['cancel'] }, { ...item, eventTypes: ['im.message.receive_v1'], owner: 'service' },
    { ...item, eventTypes: ['im.message.receive_v1'], legacyActions: [] }]) expect(() => parseLarkEventHandlers([invalid])).toThrow();
  expect(() => parseLarkEventHandlers([item, item])).toThrow();
  expect(parseLarkEventHandlers(null)).toBeUndefined(); expect(parseLarkEventHandlers([])).toEqual([]);
  expect(parseLarkEventHandlers([{ ...item, token: undefined }], [item])).toEqual([item]);
  expect(() => parseLarkEventHandlers([{ ...item, token: undefined, url: 'https://new.example/' }], [item])).toThrow('token');
});

it('rejects new/legacy conflicts, permits atomic migration, and blocks corrupt persisted handlers before networking', async () => {
  const repos = createRepositories(':memory:'); cleanups.push(() => repos.close());
  const legacy = { owner: 'sample-service', url: 'http://127.0.0.1:1/events', token: 'secret' };
  const item = handler('new', legacy.url, { owner: legacy.owner });
  await saveLarkConfig(repos.config, undefined, { appId: 'cli_config', appSecret: 'fake', permissionMode: 'ask', cardActionForwarding: legacy });
  await expect(saveLarkConfig(repos.config, undefined, { originalAppId: 'cli_config', eventHandlers: [item] })).rejects.toMatchObject({ code: 'INVALID_LARK_CONFIG' });
  await saveLarkConfig(repos.config, undefined, { originalAppId: 'cli_config', eventHandlers: [item], cardActionForwarding: null });
  expect(await readLarkConfig(repos.config, 'cli_config')).toMatchObject({ eventHandlers: [item] });
  expect(await readLarkConfig(repos.config, 'cli_config')).not.toHaveProperty('cardActionForwarding');
  await repos.config.set('lark.bots', JSON.stringify([{ appId: 'cli_bad', appSecret: 'fake', listening: true, eventHandlers: [{ ...item, url: 'http://remote.example' }] }]));
  const config = (await readLarkConfig(repos.config, 'cli_bad'))!;
  expect(config.eventHandlersError).not.toContain(item.token);
  const fetcher = vi.fn(async () => { throw new Error('Unexpected network'); });
  const connection = new LarkLongConnectionListener({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }, { fetcher });
  await expect(connection.start(config)).rejects.toMatchObject({ code: 'INVALID_LARK_CONFIG' });
  expect(fetcher).not.toHaveBeenCalled(); expect(connection.listening).toBe(false);
});

it('reopens persistent handler credentials after database restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dutydeck-event-handlers-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const database = join(directory, 'test.sqlite');
  const item = handler('persistent', 'http://127.0.0.1:1/events', { owner: 'sample-service' });
  const first = createRepositories(database);
  try { await saveLarkConfig(first.config, undefined, { appId: 'cli_persistent', appSecret: 'fake', permissionMode: 'ask', eventHandlers: [item] }); }
  finally { first.close(); }
  const reopened = createRepositories(database);
  try {
    expect(await readLarkConfig(reopened.config, 'cli_persistent')).toMatchObject({ eventHandlers: [item] });
    await saveLarkConfig(reopened.config, undefined, { originalAppId: 'cli_persistent', eventHandlers: null });
  } finally { reopened.close(); }
  const disabled = createRepositories(database);
  try { expect(await readLarkConfig(disabled.config, 'cli_persistent')).not.toHaveProperty('eventHandlers'); }
  finally { disabled.close(); }
});
