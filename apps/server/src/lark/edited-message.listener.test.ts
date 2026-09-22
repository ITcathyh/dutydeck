import { afterEach, describe, expect, it, vi } from 'vitest';
import { LarkLongConnectionListener, LarkMessageCoordinator } from './listener.js';
import type { StoredLarkConfig } from './config.js';

const sdk = vi.hoisted(() => ({ handlers: {} as Record<string, (event: any) => unknown> }));
vi.mock('@larksuiteoapi/node-sdk', () => ({
  LoggerLevel: { warn: 'warn' },
  EventDispatcher: class {
    register(handlers: typeof sdk.handlers) { sdk.handlers = handlers; return this; }
  },
  WSClient: class {
    constructor(private options: { onReady: () => void }) {}
    async start() { this.options.onReady(); }
    close() {}
  }
}));

const config: StoredLarkConfig = {
  appId: 'cli_edited_listener', appSecret: 'synthetic', workspace: '/tmp', defaultAgentId: 'codex',
  fullTrustConfirmed: true, listening: true, preInjectPrompt: '', groupToolsEnabled: false, groupToolsAllowSend: false,
  pushIntervalMs: 1000, hideTraceOnComplete: false, allowedUsers: [], allowedEmails: [], highRiskAllowedUsers: [],
  highRiskAllowedEmails: [], highRiskPattern: 'rm\\b', riskControlMode: 'off'
};
const detail = (patch: Record<string, unknown> = {}) => ({
  message_id: 'om_edit', chat_id: 'oc_authoritative', msg_type: 'text', create_time: '1700000000000',
  sender: { id: 'ou_original', id_type: 'open_id', sender_type: 'user' },
  body: { content: '{"text":"<p>@_user_1 authoritative</p>"}' },
  mentions: [{ id: 'ou_bot', id_type: 'open_id', key: '@_user_1', name: 'Dutydeck' }],
  thread_id: 'omt_thread', root_id: 'om_root', parent_id: 'om_parent', ...patch
});
const notification = { operator_id: { open_id: 'ou_editor' }, sender: { sender_id: { open_id: 'ou_forged' } },
  message: { message_id: 'om_edit', chat_id: 'oc_forged', content: '{"text":"forged"}', mentions: [] } };
const listeners: LarkLongConnectionListener[] = [];
afterEach(() => { listeners.splice(0).forEach(listener => listener.stop()); vi.restoreAllMocks(); });

async function harness(items = [detail()], mode: 'topic' | 'group' | 'p2p' = 'topic') {
  const handle = vi.spyOn(LarkMessageCoordinator.prototype, 'handle').mockResolvedValue();
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const resolveMode = vi.fn(async () => mode);
  let readError = false;
  const fetcher = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    let data: unknown;
    if (url.includes('/tenant_access_token/')) data = { code: 0, tenant_access_token: 'synthetic', expire: 7200 };
    else if (url.includes('/bot/v3/info')) data = { code: 0, bot: { open_id: 'ou_bot' } };
    else if (url.includes('/im/v1/messages/')) data = readError ? { code: 99991672, msg: 'permission denied' } : { code: 0, data: { items } };
    else throw new Error(`Unexpected fake HTTP request: ${url}`);
    return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
  });
  const listener = new LarkLongConnectionListener(log, {
    runtime: {} as any, fetcher: fetcher as typeof fetch, chatModeResolver: resolveMode,
    env: { LARK_API_RETRY_MAX_ATTEMPTS: '0' }
  });
  listeners.push(listener);
  await listener.start(config);
  const update = sdk.handlers['im.message.updated_v1']!;
  expect(update).toBeTypeOf('function');
  return { listener, update, handle, fetcher, log, resolveMode, denyRead: () => { readError = true; } };
}

describe('registered im.message.updated_v1 handler', () => {
  it.each(['topic', 'group', 'p2p'] as const)('uses authoritative detail and original author for %s, and reads current config', async mode => {
    const h = await harness([detail()], mode);
    const latest = { ...config, preInjectPrompt: 'new policy' };
    await h.listener.start(latest);
    await h.update(notification);
    expect(h.fetcher.mock.calls.some(([url]) => String(url).includes('/im/v1/messages/om_edit?user_id_type=open_id&'))).toBe(true);
    expect(h.resolveMode).toHaveBeenCalledWith(config.appId, 'oc_authoritative');
    expect(h.handle).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      messageId: 'om_edit', chatId: 'oc_authoritative', chatType: mode === 'p2p' ? 'p2p' : 'group',
      senderOpenId: 'ou_original', senderType: 'user', content: '{"text":"@_user_1 authoritative"}',
      threadId: 'omt_thread', rootId: 'om_root', parentId: 'om_parent',
      mentions: [{ key: '@_user_1', name: 'Dutydeck', openId: 'ou_bot' }]
    }), latest);
  });

  it.each([
    ['deleted', { deleted: true }],
    ['bot author', { sender: { id: 'ou_original', id_type: 'open_id', sender_type: 'app' } }],
    ['wrong sender ID domain', { sender: { id: 'ou_original', id_type: 'user_id', sender_type: 'user' } }],
    ['no bot mention', { mentions: [] }],
    ['wrong mention ID domain', { mentions: [{ id: 'ou_bot', id_type: 'union_id' }] }],
    ['wrong message ID', { message_id: 'om_other' }],
    ['missing chat', { chat_id: undefined }]
  ])('ignores %s despite a forged event mention', async (_name, patch) => {
    const h = await harness([detail(patch)]);
    await h.update({ ...notification, message: { ...notification.message, mentions: [{ id: { open_id: 'ou_bot' } }] } });
    expect(h.handle).not.toHaveBeenCalled();
    expect(h.resolveMode).not.toHaveBeenCalled();
  });

  it.each(['no detail', 'read denied', 'chat lookup rejected'] as const)('contains %s failures without dispatching or rejecting the event handler', async reason => {
    const h = await harness(reason === 'no detail' ? [] : [detail()]);
    if (reason === 'read denied') h.denyRead();
    if (reason === 'chat lookup rejected') h.resolveMode.mockRejectedValueOnce(new Error('chat denied'));
    await expect(h.update(notification)).resolves.toBeUndefined();
    expect(h.handle).not.toHaveBeenCalled();
    expect(h.log.warn).toHaveBeenCalled();
  });

  it('contains coordinator rejection and logs it', async () => {
    const h = await harness();
    h.handle.mockRejectedValueOnce(new Error('coordinator denied'));
    await expect(h.update(notification)).resolves.toBeUndefined();
    expect(h.log.error).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'om_edit' }), expect.any(String));
  });

  it('ignores notifications without a message ID before any detail request', async () => {
    const h = await harness();
    const before = h.fetcher.mock.calls.length;
    expect(h.update({ operator_id: { open_id: 'ou_editor' } })).toBeUndefined();
    expect(h.fetcher).toHaveBeenCalledTimes(before);
    expect(h.handle).not.toHaveBeenCalled();
  });
});
