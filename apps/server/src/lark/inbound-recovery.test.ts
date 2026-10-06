import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import { larkBotsConfigKey, type StoredLarkConfig } from './config.js';
import { LarkMessageCoordinator } from './coordinator.js';
import { LarkLongConnectionListener, type LarkMessageEvent } from './listener.js';
import { LarkTaskInbox } from './task-inbox.js';
import { LarkServiceError } from './service.js';

const sdk = vi.hoisted(() => ({ wsStart: vi.fn() }));
vi.mock('@larksuiteoapi/node-sdk', () => ({
  LoggerLevel: { warn: 'warn' },
  EventDispatcher: class { register() { return this; } },
  WSClient: class {
    constructor(private readonly options: { onReady: () => void }) {}
    async start() { sdk.wsStart(); this.options.onReady(); }
    close() {}
  }
}));

const config: StoredLarkConfig = {
  appId: 'cli_recover', appSecret: 'secret', workspace: '/workspace', defaultAgentId: 'codex', fullTrustConfirmed: true, listening: true,
  preInjectPrompt: '', groupToolsEnabled: false, groupToolsAllowSend: false, pushIntervalMs: 1_000, hideTraceOnComplete: false,
  allowedUsers: [], allowedEmails: [], highRiskAllowedUsers: [], highRiskAllowedEmails: [], highRiskPattern: 'rm\\b', riskControlMode: 'off'
};
const groupMessage = (messageId: string, chatId: string, overrides: Partial<LarkMessageEvent> = {}): LarkMessageEvent => ({
  messageId, chatId, chatType: 'group', messageType: 'text', content: JSON.stringify({ text: '@_user_1 看下告警' }), senderOpenId: 'ou_alice',
  createTime: String(Date.now()), mentions: [{ key: '@_user_1', name: 'Dutydeck', openId: 'ou_bot' }], ...overrides
});
const directMessage = (messageId: string, overrides: Partial<LarkMessageEvent> = {}): LarkMessageEvent => ({
  messageId, chatId: 'oc_p2p', chatType: 'p2p', messageType: 'text', content: JSON.stringify({ text: '看下告警' }), senderOpenId: 'ou_alice',
  createTime: String(Date.now()), mentions: [], ...overrides
});
// 与 service.ts request() 的真实错误形态一致。
const membersRejected = () => new LarkServiceError('LARK_OPENAPI_ERROR', 'Lark OpenAPI request failed: Operator can NOT be out of the chat. (code: 232011)', 502,
  { upstreamCode: 232011, upstreamHttpStatus: 400 });
const membersUnavailable = () => new LarkServiceError('LARK_OPENAPI_ERROR', 'Lark OpenAPI request failed: 503 Service Unavailable (code: HTTP_ERROR)', 502,
  { upstreamHttpStatus: 503 });
const allowed = { allowed: true, action: 'task.create', code: 'allowed_member', reason: '', source: 'group' } as const;

const harness = async (records: Array<{ event: LarkMessageEvent; state?: 'command' }>, authorize: (chatId: string) => Promise<unknown>) => {
  const repos = createRepositories(':memory:');
  await repos.config.set(larkBotsConfigKey, JSON.stringify([config]));
  const previous = new LarkTaskInbox(repos.config);
  for (const record of records) {
    const claimed = (await previous.claim(config.appId, record.event))!;
    if (record.state) await previous.update(claimed, { state: record.state });
  }
  const groupManager = { resolved: vi.fn(async (current: StoredLarkConfig) => current), authorize: vi.fn(async (_appId: string, chatId: string) => authorize(chatId)) };
  const service = {
    addReaction: vi.fn(async () => ({ reactionId: 'reaction' })), deleteReaction: vi.fn(async () => {}),
    send: vi.fn(async (_input: any) => ({ messageId: 'om_notice' })), reply: vi.fn(async (_input: any) => ({ messageId: 'om_notice' }))
  };
  const runtime = { getSession: vi.fn(async () => undefined), listSessions: vi.fn(async () => []), subscribe: vi.fn(() => vi.fn()) };
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const coordinator = new LarkMessageCoordinator(runtime as any, service as any, log, Math.random, 'ou_bot',
    undefined, undefined, undefined, undefined, groupManager as any, { store: repos.config });
  const stored = async (messageId: string) => JSON.parse((await repos.config.get(`lark.inbox.${config.appId}.${messageId}`))!);
  return { repos, coordinator, service, groupManager, log, stored, close: () => { coordinator.stop(); repos.close(); } };
};

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('启动恢复入站消息：单条失败不影响初始化和监听建连', () => {
  it('marks a record the platform explicitly rejects as failed and still recovers the others', async () => {
    const runTurn = vi.spyOn(LarkMessageCoordinator.prototype as any, 'runTurn').mockResolvedValue(undefined);
    const h = await harness([{ event: groupMessage('om_a_gone', 'oc_gone') }, { event: directMessage('om_b_ok') }],
      async chatId => { if (chatId === 'oc_gone') throw membersRejected(); return allowed; });
    try {
      await expect(h.coordinator.initializeWorkflows(config)).resolves.toBeUndefined();
      expect(await h.stored('om_a_gone')).toMatchObject({ state: 'failed', error: expect.stringContaining('232011') });
      await vi.waitFor(() => expect(runTurn).toHaveBeenCalledWith(expect.objectContaining({ id: 'om_b_ok' })));
      expect(runTurn).not.toHaveBeenCalledWith(expect.objectContaining({ id: 'om_a_gone' }));
    } finally { h.close(); }
  });

  it('keeps a record that failed transiently and retries it later', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const runTurn = vi.spyOn(LarkMessageCoordinator.prototype as any, 'runTurn').mockResolvedValue(undefined);
    let outage = true;
    const h = await harness([{ event: groupMessage('om_flaky', 'oc_flaky') }], async () => { if (outage) throw membersUnavailable(); return allowed; });
    try {
      await expect(h.coordinator.initializeWorkflows(config)).resolves.toBeUndefined();
      expect(await h.stored('om_flaky')).toMatchObject({ state: 'received' });
      expect(runTurn).not.toHaveBeenCalled();
      outage = false;
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.waitFor(() => expect(runTurn).toHaveBeenCalledWith(expect.objectContaining({ id: 'om_flaky' })));
      expect((await h.stored('om_flaky')).state).toBe('received');
    } finally { h.close(); }
  });

  it('gives up on a record older than the recovery age limit and tells the sender to resend', async () => {
    const runTurn = vi.spyOn(LarkMessageCoordinator.prototype as any, 'runTurn').mockResolvedValue(undefined);
    const h = await harness([{ event: directMessage('om_stale', { createTime: String(Date.now() - 2 * 60 * 60_000) }) }], async () => allowed);
    try {
      await h.coordinator.initializeWorkflows(config);
      expect(await h.stored('om_stale')).toMatchObject({ state: 'failed', error: expect.stringContaining('1 小时') });
      expect(runTurn).not.toHaveBeenCalled();
      expect(h.service.send).toHaveBeenCalledWith(expect.objectContaining({ chatId: 'oc_p2p', state: 'failed', markdown: expect.stringContaining('重新发送') }));
    } finally { h.close(); }
  });

  it('fails a record or orphaned command older than a day without replying in the chat', async () => {
    const runTurn = vi.spyOn(LarkMessageCoordinator.prototype as any, 'runTurn').mockResolvedValue(undefined);
    const dayAgo = String(Date.now() - 25 * 60 * 60_000);
    const h = await harness([{ event: groupMessage('om_old', 'oc_old', { createTime: dayAgo }) },
      { event: groupMessage('om_old_command', 'oc_old', { createTime: dayAgo, content: JSON.stringify({ text: '@_user_1 /status' }) }), state: 'command' }], async () => allowed);
    try {
      await h.coordinator.initializeWorkflows(config);
      expect(await h.stored('om_old')).toMatchObject({ state: 'failed', error: expect.stringContaining('1 小时') });
      expect(await h.stored('om_old_command')).toMatchObject({ state: 'failed' });
      expect(runTurn).not.toHaveBeenCalled();
      expect(h.service.send).not.toHaveBeenCalled();
      expect(h.service.reply).not.toHaveBeenCalled();
    } finally { h.close(); }
  });

  it('does not let an orphaned command receipt that cannot check membership fail initialization', async () => {
    const h = await harness([{ event: groupMessage('om_command', 'oc_down', { content: JSON.stringify({ text: '@_user_1 /status' }) }), state: 'command' }],
      async () => { throw membersUnavailable(); });
    try {
      await expect(h.coordinator.initializeWorkflows(config)).resolves.toBeUndefined();
      expect(await h.stored('om_command')).toMatchObject({ state: 'failed' });
    } finally { h.close(); }
  });

  it('connects the listener even when recovering a stored message fails', async () => {
    sdk.wsStart.mockClear();
    const repos = createRepositories(':memory:');
    await repos.config.set(larkBotsConfigKey, JSON.stringify([config]));
    await new LarkTaskInbox(repos.config).claim(config.appId, groupMessage('om_gone', 'oc_gone'));
    const fetcher = vi.fn(async (url: string | URL) => {
      const target = String(url);
      if (target.includes('/tenant_access_token/')) return Response.json({ code: 0, tenant_access_token: 't', expire: 7200 });
      if (target.includes('/bot/v3/info')) return Response.json({ code: 0, bot: { open_id: 'ou_bot', app_name: 'Dutydeck' } });
      return Response.json({ code: 0, data: { message_id: 'om_x', reaction_id: 'r1' } });
    });
    const groupManager = { resolved: vi.fn(async (current: StoredLarkConfig) => current), authorize: vi.fn(async () => { throw membersRejected(); }) };
    const runtime = { getSession: vi.fn(async () => undefined), listSessions: vi.fn(async () => []), subscribe: vi.fn(() => vi.fn()) };
    const listener = new LarkLongConnectionListener({ info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      { fetcher: fetcher as any, runtime: runtime as any, workflowStore: repos.config, groupManager: groupManager as any, chatModeResolver: async () => 'group' });
    try {
      await expect(listener.start(config)).resolves.toBeUndefined();
      expect(sdk.wsStart).toHaveBeenCalledOnce();
      expect(listener.listening).toBe(true);
      expect(JSON.parse((await repos.config.get(`lark.inbox.${config.appId}.om_gone`))!)).toMatchObject({ state: 'failed' });
    } finally { listener.stop(); repos.close(); }
  });
});
