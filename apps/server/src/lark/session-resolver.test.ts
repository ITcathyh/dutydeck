import { describe, expect, it, vi } from 'vitest';
import type { Session } from '@dockmux/shared';
import type { StoredLarkConfig } from './config.js';
import {
  larkGroupKey,
  larkGroupScopeId,
  larkReplyContext,
  larkSessionConfigKey,
  larkSourceId,
  resolveLarkSession,
  resolveLarkScopeId,
  type LarkChatModeResolver
} from './session-resolver.js';
import type { LarkMessageEvent } from './listener.js';

const baseConfig: StoredLarkConfig = {
  appId: 'cli_test', appSecret: 'secret', workspace: '/workspace', defaultAgentId: 'codex', fullTrustConfirmed: true, listening: true,
  preInjectPrompt: '',
  groupToolsEnabled: false, groupToolsAllowSend: false,
  pushIntervalMs: 1_000, hideTraceOnComplete: false, allowedUsers: [], allowedEmails: [], highRiskAllowedUsers: [], highRiskAllowedEmails: [],
  highRiskPattern: 'rm\\b', riskControlMode: 'off'
};

const groupEvent = (overrides: Partial<LarkMessageEvent> = {}): LarkMessageEvent => ({
  messageId: 'om_1',
  chatId: 'oc_group',
  chatType: 'group',
  messageType: 'text',
  content: '{"text":"@bot 你好"}',
  senderOpenId: 'ou_user',
  mentions: [],
  ...overrides
});

const staticResolver = (mode: 'topic' | 'group' | 'p2p'): LarkChatModeResolver => async () => mode;

describe('resolveLarkScopeId legacy 行为（未配置回复模式）', () => {
  it('群聊有 thread_id 时按 thread_id 隔离（无 resolver 不触发 API）', async () => {
    const scope = await resolveLarkScopeId(groupEvent({ threadId: 'omt_topic' }), baseConfig);
    expect(scope).toBe('thread:omt_topic');
  });

  it('群聊顶层消息按发送人隔离，无 openId 时按消息隔离', async () => {
    expect(await resolveLarkScopeId(groupEvent(), baseConfig)).toBe('user:ou_user');
    expect(await resolveLarkScopeId(groupEvent({ senderOpenId: undefined }), baseConfig)).toBe('message:om_1');
  });

  it('私聊整段一个会话', async () => {
    expect(await resolveLarkScopeId(groupEvent({ chatType: 'p2p', chatId: 'oc_p2p' }), baseConfig)).toBe('p2p');
  });

  it('与同步版 larkGroupScopeId 结果一致', async () => {
    const event = groupEvent({ threadId: 'omt_topic' });
    expect(await resolveLarkScopeId(event, baseConfig)).toBe(larkGroupScopeId(event));
  });
});

describe('resolveLarkScopeId 话题锚点（规则 1/2）', () => {
  it('root_id + thread_id 同时存在时锚到话题根（所有模式一致）', async () => {
    const event = groupEvent({ rootId: 'om_root', threadId: 'omt_topic' });
    expect(await resolveLarkScopeId(event, baseConfig)).toBe('thread:om_root');
    expect(await resolveLarkScopeId(event, { ...baseConfig, groupReplyMode: 'chat' })).toBe('thread:om_root');
    expect(await resolveLarkScopeId(event, { ...baseConfig, groupReplyMode: 'new-topic' })).toBe('thread:om_root');
    expect(await resolveLarkScopeId(event, { ...baseConfig, groupReplyMode: 'chat-topic' }, staticResolver('group'))).toBe('thread:om_root');
  });

  it('只有 root_id（引用气泡）不进 thread scope，按顶层路由', async () => {
    expect(await resolveLarkScopeId(groupEvent({ rootId: 'om_quoted' }), baseConfig)).toBe('user:ou_user');
    expect(await resolveLarkScopeId(groupEvent({ rootId: 'om_quoted' }), { ...baseConfig, groupReplyMode: 'chat' })).toBe('chat:oc_group');
  });

  it('只有 thread_id 时锚点回退 thread_id（老 fixture/quote 气泡）', async () => {
    expect(await resolveLarkScopeId(groupEvent({ threadId: 'omt_legacy' }), baseConfig)).toBe('thread:omt_legacy');
  });
});

describe('resolveLarkScopeId p2pMode（规则 3）', () => {
  it("p2pMode='thread' 时每条顶层 DM 是新话题", async () => {
    const config = { ...baseConfig, p2pMode: 'thread' as const };
    expect(await resolveLarkScopeId(groupEvent({ chatType: 'p2p', chatId: 'oc_dm' }), config)).toBe('thread:om_1');
  });

  it("p2pMode='thread' 时话题回复锚到话题根，thread_id-only 回退 thread_id", async () => {
    const config = { ...baseConfig, p2pMode: 'thread' as const };
    expect(await resolveLarkScopeId(groupEvent({ chatType: 'p2p', rootId: 'om_root', threadId: 'omt_dm_topic' }), config)).toBe('thread:om_root');
    expect(await resolveLarkScopeId(groupEvent({ chatType: 'p2p', threadId: 'omt_dm_topic' }), config)).toBe('thread:omt_dm_topic');
  });

  it("p2pMode='chat' 与未设置一致，整段 DM 一个会话（即使带 thread 字段）", async () => {
    const event = groupEvent({ chatType: 'p2p', rootId: 'om_root', threadId: 'omt_dm_topic' });
    expect(await resolveLarkScopeId(event, { ...baseConfig, p2pMode: 'chat' })).toBe('p2p');
    expect(await resolveLarkScopeId(event, baseConfig)).toBe('p2p');
  });
});

describe('resolveLarkScopeId 话题群种子（规则 4）', () => {
  it('话题群顶层消息（含 thread_id-only 种子）开新话题', async () => {
    const resolver = staticResolver('topic');
    expect(await resolveLarkScopeId(groupEvent(), baseConfig, resolver)).toBe('thread:om_1');
    expect(await resolveLarkScopeId(groupEvent({ threadId: 'omt_seed' }), baseConfig, resolver)).toBe('thread:om_1');
  });

  it('话题群内的真实话题回复仍锚到话题根', async () => {
    expect(await resolveLarkScopeId(groupEvent({ rootId: 'om_root', threadId: 'omt_topic' }), baseConfig, staticResolver('topic'))).toBe('thread:om_root');
  });

  it('普通群（resolver=group）按 groupReplyMode/legacy 路由', async () => {
    expect(await resolveLarkScopeId(groupEvent(), baseConfig, staticResolver('group'))).toBe('user:ou_user');
    expect(await resolveLarkScopeId(groupEvent(), { ...baseConfig, groupReplyMode: 'chat' }, staticResolver('group'))).toBe('chat:oc_group');
  });

  it('resolver 抛异常时降级为普通群路由，不阻塞消息处理', async () => {
    const failing: LarkChatModeResolver = async () => { throw new Error('network down'); };
    expect(await resolveLarkScopeId(groupEvent(), baseConfig, failing)).toBe('user:ou_user');
    expect(await resolveLarkScopeId(groupEvent(), { ...baseConfig, groupReplyMode: 'new-topic' }, failing)).toBe('thread:om_1');
  });
});

describe('resolveLarkScopeId 普通群回复模式（规则 5）', () => {
  it("'new-topic' 顶层 @ 开新话题", async () => {
    expect(await resolveLarkScopeId(groupEvent(), { ...baseConfig, groupReplyMode: 'new-topic' })).toBe('thread:om_1');
  });

  it("'chat' 与 'shared' 顶层全群一个会话", async () => {
    expect(await resolveLarkScopeId(groupEvent(), { ...baseConfig, groupReplyMode: 'chat' })).toBe('chat:oc_group');
    expect(await resolveLarkScopeId(groupEvent(), { ...baseConfig, groupReplyMode: 'shared' })).toBe('chat:oc_group');
  });

  it("'chat-topic' 顶层平铺，但 omt_ 原生话题种子独立会话", async () => {
    const config = { ...baseConfig, groupReplyMode: 'chat-topic' as const };
    expect(await resolveLarkScopeId(groupEvent(), config)).toBe('chat:oc_group');
    expect(await resolveLarkScopeId(groupEvent({ threadId: 'omt_native' }), config)).toBe('thread:om_1');
    // 非 omt_ 的合成 thread_id 仍按顶层平铺
    expect(await resolveLarkScopeId(groupEvent({ threadId: 'synth_thread' }), config)).toBe('chat:oc_group');
  });
});

describe('larkReplyContext / larkSourceId / larkGroupKey', () => {
  it('thread_id 存在时 replyInThread=true，并带入话题根 replyRootId', () => {
    expect(larkReplyContext(groupEvent({ threadId: 'omt_topic' }))).toEqual({ messageId: 'om_1', replyInThread: true });
    expect(larkReplyContext(groupEvent({ rootId: 'om_root', threadId: 'omt_topic' }))).toEqual({ messageId: 'om_1', replyInThread: true, replyRootId: 'om_root' });
    expect(larkReplyContext(groupEvent({ rootId: 'om_root' }))).toEqual({ messageId: 'om_1', replyRootId: 'om_root' });
    expect(larkReplyContext(groupEvent())).toEqual({ messageId: 'om_1' });
  });

  it('sourceId 持久化格式不变：群聊追加 scopeId，私聊不追加', () => {
    expect(larkSourceId(baseConfig, 'oc_group', 'group', 'thread:omt_topic')).toBe('cli_test:oc_group:group:thread:omt_topic');
    expect(larkSourceId(baseConfig, 'oc_dm', 'p2p', 'p2p')).toBe('cli_test:oc_dm:p2p');
  });

  it('groupKey = chatId:scopeId', () => {
    expect(larkGroupKey(groupEvent(), 'thread:omt_topic')).toBe('oc_group:thread:omt_topic');
  });
});

describe('resolveLarkSession permission posture', () => {
  const persisted = (overrides: Partial<Session> = {}): Session => ({
    id: 'ses_restricted', agentId: 'codex', state: 'idle', cwd: '/workspace',
    permissionMode: 'ask', source: 'lark', sourceId: 'cli_test:oc_group:group:user:ou_user',
    runId: 'run_restricted', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  });

  it('拒绝未明示确认 full-trust 的配置且不启动 Agent', async () => {
    const runtime = {
      listSessions: vi.fn(async () => []),
      getSession: vi.fn(),
      stop: vi.fn(),
      start: vi.fn()
    };
    const group = { tail: Promise.resolve() };
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    await expect(resolveLarkSession(runtime as any, log, group as any, { ...baseConfig, fullTrustConfirmed: false }, 'oc_group', 'group', 'user:ou_user')).rejects.toMatchObject({
      code: 'LARK_FULL_TRUST_CONFIRMATION_REQUIRED',
      statusCode: 409
    });
    expect(runtime.listSessions).not.toHaveBeenCalled();
    expect(runtime.start).not.toHaveBeenCalled();
  });

  it('stops a persisted non-full-trust session and creates a new full-trust run', async () => {
    const restricted = persisted();
    const trusted = persisted({ id: 'ses_trusted', runId: 'run_trusted', permissionMode: 'full-trust' });
    const runtime = {
      listSessions: vi.fn(async () => [restricted]),
      getSession: vi.fn(),
      stop: vi.fn(async () => {}),
      start: vi.fn(async () => trusted)
    };
    const group = { tail: Promise.resolve() };
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    await expect(resolveLarkSession(runtime as any, log, group as any, baseConfig, 'oc_group', 'group', 'user:ou_user')).resolves.toBe(trusted);

    expect(runtime.stop).toHaveBeenCalledWith(restricted.id);
    expect(runtime.start).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'codex',
      permissionMode: 'full-trust',
      source: 'lark',
      sourceId: restricted.sourceId
    }));
    expect(group).toMatchObject({ sessionId: trusted.id, sessionConfigKey: larkSessionConfigKey(baseConfig) });
  });
});
