import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import type { AgentConfig, AgentDriver, ChannelMapping, Session, TaskRecord } from '@dutydeck/shared';
import { createRepositories } from '@dutydeck/storage';
import { DutydeckRuntime } from '@dutydeck/runtime';
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { larkBotsConfigKey, type StoredLarkConfig } from './config.js';
import { LarkMessageCoordinator, type PersistedLarkCardTask } from './coordinator.js';
import type { LarkMessageEvent } from './listener.js';
import { runDatabaseRetireLegacy } from '../database-cli.js';

/**
 * 进程重启（coordinator 重建）后的飞书日常闭环回归。
 *
 * 这些用例刻意**不复用同一个 coordinator**：每个「重启后」的断言都新建一个
 * LarkMessageCoordinator，只把 runtime 里的持久化会话带过去——这正是 daemon 重启后的
 * 真实状态（内存 groups/tasks 全空，持久化 session 还在）。命令与普通消息必须落到
 * 同一条会话上，否则会出现「/new 说没有绑定会话、下一条消息却复用了旧上下文」这类
 * 自相矛盾的行为。
 */

const config: StoredLarkConfig = {
  appId: 'cli_test', appSecret: 'secret', workspace: '/workspace', defaultAgentId: 'codex',
  fullTrustConfirmed: true, listening: true, preInjectPrompt: '', structuredAskCards: false, groupCardMention: false,
  groupToolsEnabled: false, groupToolsAllowSend: false,
  pushIntervalMs: 1_000, hideTraceOnComplete: false,
  allowedUsers: [], allowedEmails: [], allowedBots: [], peerBotsAllowed: false, highRiskAllowedUsers: [], highRiskAllowedEmails: [],
  highRiskPattern: 'rm\\b', riskControlMode: 'off'
};

/** 跨 coordinator 重建存活的持久化 runtime 替身：sessions 数组即「数据库」。 */
function persistentRuntime(options: { stopGate?: Promise<void>; sendGate?: Promise<void>; startGate?: Promise<void> } = {}) {
  const sessions: Session[] = [];
  const tasks = new Map<string, TaskRecord[]>();
  let counter = 0;
  const runtime = {
    start: vi.fn(async (input: any) => {
      if (options.startGate) await options.startGate;
      counter += 1;
      const session: Session = {
        id: `ses_${counter}`, agentId: input.agentId, state: 'idle', cwd: input.cwd ?? '/tmp',
        permissionMode: input.permissionMode, source: input.source, sourceId: input.sourceId,
        runId: `run_${counter}`, createdAt: new Date(1_700_000_000_000 + counter).toISOString(),
        updatedAt: new Date(1_700_000_000_000 + counter).toISOString()
      };
      sessions.push(session);
      return { ...session };
    }),
    listSessions: vi.fn(async () => sessions.map(session => ({ ...session }))),
    getSession: vi.fn(async (id: string) => {
      const session = sessions.find(item => item.id === id);
      return session ? { ...session } : undefined;
    }),
    stop: vi.fn(async (id: string) => {
      if (options.stopGate) await options.stopGate;
      const session = sessions.find(item => item.id === id);
      if (session) session.state = 'stopped';
    }),
    send: vi.fn(async (..._args: any[]) => { if (options.sendGate) await options.sendGate; }),
    interrupt: vi.fn(async (..._args: any[]) => {}),
    cancelQueued: vi.fn(async (..._args: any[]) => {}),
    getTasks: vi.fn(async (id: string) => (tasks.get(id) ?? []).map(task => ({ ...task }))),
    subscribe: vi.fn(() => vi.fn())
  };
  return { runtime, sessions, tasks };
}

const runtimeTask = (overrides: Partial<TaskRecord> & Pick<TaskRecord, 'id' | 'sessionId' | 'status'>): TaskRecord => ({
  prompt: '原始请求', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:01:00.000Z', ...overrides
});

/** 内存版 ChannelMappingRepository，形状与 SQLite 实现一致。 */
function cardMappingRepository(seed: Array<{ externalId: string; sessionId: string; extra: PersistedLarkCardTask }> = []) {
  const rows = new Map<string, ChannelMapping>();
  for (const item of seed) {
    const channel = `lark-card:${item.extra.app_id}`;
    rows.set(`${channel}:${item.externalId}`, {
      id: `${channel}:${item.externalId}`, channel, externalId: item.externalId,
      sessionId: item.sessionId, extra: JSON.stringify(item.extra), createdAt: '2026-01-01T00:00:00.000Z'
    });
  }
  return {
    rows,
    repository: {
      get: vi.fn(async (channel: string, externalId: string) => rows.get(`${channel}:${externalId}`)),
      list: vi.fn(async (channel: string) => [...rows.values()].filter(row => row.channel === channel)),
      save: vi.fn(async (mapping: ChannelMapping) => { rows.set(mapping.id, mapping); })
    }
  };
}

const persistedCard = (overrides: Partial<PersistedLarkCardTask> = {}): PersistedLarkCardTask => ({
  app_id: 'cli_test', chat_id: 'ou_user_a', card_message_id: 'om_old_card',
  task_name: '原始请求', prompt: '原始请求', state: 'failed', started_at: 1_700_000_000_000,
  chat_type: 'p2p', turn: 1, ...overrides
});

function cardService() {
  return {
    addReaction: vi.fn(async (..._args: any[]) => ({ reactionId: 'reaction-1' })),
    deleteReaction: vi.fn(async (..._args: any[]) => {}),
    send: vi.fn(async (_input: any) => ({ messageId: 'om_card' })),
    update: vi.fn(async (_input: any) => ({ messageId: 'om_card' })),
    getUserEmails: vi.fn(async (..._args: any[]) => ['outsider@example.com'])
  };
}

const silentLog = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

const coordinatorFor = (runtime: unknown, service: unknown, cardMappings?: unknown) =>
  new LarkMessageCoordinator(
    runtime as any, service as any, silentLog(), Math.random, 'ou_bot',
    undefined, cardMappings as any
  );

const dm = (messageId: string, text: string, overrides: Partial<LarkMessageEvent> = {}): LarkMessageEvent => ({
  messageId, chatId: 'ou_user_a', chatType: 'p2p', messageType: 'text',
  content: JSON.stringify({ text }), senderOpenId: 'ou_user_a', mentions: [],
  ...overrides
});

const statusMarkdown = (service: ReturnType<typeof cardService>) =>
  String(service.send.mock.calls.find(([input]: any[]) => input.taskName === '任务状态')?.[0]?.markdown ?? '');

describe('飞书命令在 coordinator 重建后的会话定位', () => {
  it('CI wait/list/cancel reuse the persisted topic session and captured actor', async () => {
    const { runtime } = persistentRuntime();
    const first = coordinatorFor(runtime, cardService());
    await first.handle(dm('om_initial', '先创建工作项'), config);
    await vi.waitFor(() => expect(runtime.send).toHaveBeenCalledOnce());
    const subscription = { id: 'ci_1', revision: 3, repository: { slug: 'owner/repo' }, headSha: 'a'.repeat(40), expiresAt: '2026-09-13T00:00:00.000Z', status: 'waiting' };
    const automation = { subscribeCi: vi.fn(async () => subscription), listBySession: vi.fn(async () => ({ subscriptions: [subscription] })), cancelCi: vi.fn(async () => ({ ...subscription, status: 'cancelled' })) };
    const service = cardService();
    const coordinator = new LarkMessageCoordinator(runtime as any, service as any, silentLog(), Math.random, 'ou_bot', undefined, undefined, undefined, undefined, undefined, { automation: automation as any });
    try {
      await coordinator.handle(dm('om_ci_wait', '/ci wait ci.yml'), config);
      await vi.waitFor(() => expect(automation.subscribeCi).toHaveBeenCalledWith('ses_1', { workflow: 'ci.yml' }, 'ou_user_a'));
      await coordinator.handle(dm('om_ci_list', '/ci'), config);
      await vi.waitFor(() => expect(service.send).toHaveBeenCalledWith(expect.objectContaining({ taskName: 'CI 等待记录', markdown: expect.stringContaining('owner/repo') })));
      await coordinator.handle(dm('om_ci_cancel', '/ci cancel ci_1'), config);
      await vi.waitFor(() => expect(automation.cancelCi).toHaveBeenCalledWith('ses_1', 'ci_1', { expectedRevision: 3 }, 'ou_user_a'));
      expect(runtime.start).toHaveBeenCalledOnce();
      expect(runtime.send).toHaveBeenCalledOnce();
    } finally { first.stop(); coordinator.stop(); }
  });

  it('/status 报告持久化会话的 Agent、工作区与状态，而不是「尚未创建」', async () => {
    const { runtime } = persistentRuntime();
    const first = cardService();
    await coordinatorFor(runtime, first).handle(dm('om_first', '先跑一轮'), config);
    await vi.waitFor(() => expect(runtime.send).toHaveBeenCalledOnce());

    // daemon 重启：内存 groups/tasks 全空，只有持久化会话还在。
    const service = cardService();
    await coordinatorFor(runtime, service).handle(dm('om_status', '/status'), config);

    await vi.waitFor(() => expect(service.send).toHaveBeenCalledWith(expect.objectContaining({ taskName: '任务状态' })));
    const markdown = statusMarkdown(service);
    expect(markdown).toContain('ses_1');
    expect(markdown).toContain('**运行状态**：idle');
    expect(markdown).toContain('/workspace');
    expect(markdown).not.toContain('尚未创建');
    // 只读查询不得创建或停止 Agent。
    expect(runtime.start).toHaveBeenCalledOnce();
    expect(runtime.stop).not.toHaveBeenCalled();
    expect(runtime.send).toHaveBeenCalledOnce();
  });

  it('/status 报告失败会话的真实状态与队列，不假装没有会话', async () => {
    const { runtime, sessions, tasks } = persistentRuntime();
    const first = cardService();
    await coordinatorFor(runtime, first).handle(dm('om_first', '先跑一轮'), config);
    await vi.waitFor(() => expect(runtime.send).toHaveBeenCalledOnce());
    sessions[0]!.state = 'failed';
    tasks.set('ses_1', [runtimeTask({ id: 'rt_1', sessionId: 'ses_1', status: 'running' }), runtimeTask({ id: 'rt_2', sessionId: 'ses_1', status: 'queued' }), runtimeTask({ id: 'rt_3', sessionId: 'ses_1', status: 'queued' })]);

    const service = cardService();
    await coordinatorFor(runtime, service).handle(dm('om_status', '/status'), config);

    await vi.waitFor(() => expect(service.send).toHaveBeenCalledWith(expect.objectContaining({ taskName: '任务状态' })));
    const markdown = statusMarkdown(service);
    expect(markdown).toContain('ses_1');
    expect(markdown).toContain('**运行状态**：failed');
    expect(markdown).toContain('**执行中的运行**：1 个');
    expect(markdown).toContain('**待执行指令**：2 条');
  });

  it('/status 不认领 Web 会话、其他 App 或已归档的旧会话', async () => {
    const { runtime, sessions } = persistentRuntime();
    sessions.push(
      { id: 'ses_web', agentId: 'codex', state: 'idle', cwd: '/workspace', permissionMode: 'full-trust', source: 'web', runId: 'run_web', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
      { id: 'ses_other_app', agentId: 'codex', state: 'idle', cwd: '/workspace', permissionMode: 'full-trust', source: 'lark', sourceId: 'cli_other:ou_user_a:p2p', runId: 'run_other', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
      { id: 'ses_archived', agentId: 'codex', state: 'idle', cwd: '/workspace', permissionMode: 'full-trust', source: 'lark', sourceId: 'cli_test:ou_user_a:p2p', archivedAt: '2026-01-02T00:00:00.000Z', runId: 'run_archived', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }
    );

    const service = cardService();
    await coordinatorFor(runtime, service).handle(dm('om_status', '/status'), config);

    await vi.waitFor(() => expect(service.send).toHaveBeenCalledWith(expect.objectContaining({ taskName: '任务状态' })));
    const markdown = statusMarkdown(service);
    expect(markdown).toContain('请回原话题查询');
    expect(markdown).not.toContain('ses_web');
    expect(markdown).not.toContain('ses_other_app');
    expect(markdown).not.toContain('ses_archived');
  });

  it('/new 在重启后真正停掉持久化会话，下一条普通消息不复用旧上下文', async () => {
    const { runtime } = persistentRuntime();
    await coordinatorFor(runtime, cardService()).handle(dm('om_first', '先跑一轮'), config);
    await vi.waitFor(() => expect(runtime.send).toHaveBeenCalledOnce());

    const service = cardService();
    const restarted = coordinatorFor(runtime, service);
    await restarted.handle(dm('om_new', '/new'), config);

    await vi.waitFor(() => expect(service.send).toHaveBeenCalledWith(expect.objectContaining({ taskName: '/new 已受理' })));
    expect(runtime.stop).toHaveBeenCalledWith('ses_1', { kind: 'channel', id: 'ou_user_a', appId: 'cli_test' });

    await restarted.handle(dm('om_next', '接着做'), config);
    await vi.waitFor(() => expect(runtime.send).toHaveBeenCalledTimes(2));
    expect(runtime.start).toHaveBeenCalledTimes(2);
    expect(runtime.send.mock.calls[1]?.[0]).toBe('ses_2');
  });

  it('an archived migrated topic accepts /new and labels the replacement as a new context', async () => {
    const { runtime, sessions } = persistentRuntime();
    sessions.push({
      id: 'ses_legacy', agentId: 'ccflash', state: 'stopped', cwd: '/old/workspace', permissionMode: 'full-trust',
      source: 'lark', sourceId: 'cli_test:ou_user_a:p2p', archivedAt: '2026-09-15T01:00:00.000Z',
      error: '升级已结束旧会话，历史记录保留；原上下文未自动恢复，请用 /new 新建。',
      runId: 'run_legacy', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-09-15T01:00:00.000Z'
    });
    const service = cardService();
    const restarted = coordinatorFor(runtime, service);
    await restarted.handle(dm('om_new_legacy', '/new'), config);
    await vi.waitFor(() => expect(service.send).toHaveBeenCalledWith(expect.objectContaining({ taskName: '/new 已受理' })));
    expect(runtime.stop).not.toHaveBeenCalled();

    await restarted.handle(dm('om_after_upgrade', '继续处理新目标'), config);
    await vi.waitFor(() => expect(runtime.send).toHaveBeenCalledOnce());
    expect(runtime.start).toHaveBeenCalledOnce();
    expect(runtime.send.mock.calls[0]?.[0]).not.toBe('ses_legacy');
    expect(service.send).toHaveBeenCalledWith(expect.objectContaining({
      state: 'running', markdown: expect.stringContaining('升级后创建的新上下文')
    }));
  });

  it('/new 任务内容在一条消息里完成新建与派发，且只派发一次', async () => {
    const { runtime } = persistentRuntime();
    await coordinatorFor(runtime, cardService()).handle(dm('om_first', '先跑一轮'), config);
    await vi.waitFor(() => expect(runtime.send).toHaveBeenCalledOnce());

    const service = cardService();
    await coordinatorFor(runtime, service).handle(dm('om_new_goal', '/new 跑一遍回归测试'), config);

    await vi.waitFor(() => expect(runtime.send).toHaveBeenCalledTimes(2));
    expect(runtime.stop).toHaveBeenCalledWith('ses_1', { kind: 'channel', id: 'ou_user_a', appId: 'cli_test' });
    // 新任务必须落到新会话，且原文（不含命令名）只派发一次。
    expect(runtime.send.mock.calls[1]?.[0]).toBe('ses_2');
    expect(runtime.send.mock.calls[1]?.[1]).toBe('跑一遍回归测试');
    expect(runtime.send).toHaveBeenCalledTimes(2);
    // 走的是完整任务链路：有进度卡，而不是一张只读命令回执。
    expect(service.send).toHaveBeenCalledWith(expect.objectContaining({ state: 'running', taskName: '跑一遍回归测试' }));
    expect(service.send).not.toHaveBeenCalledWith(expect.objectContaining({ taskName: '/new 已受理' }));
  });

  it('/new 期间到达的并发消息不得把会话绑回旧上下文', async () => {
    let releaseStop!: () => void;
    const stopGate = new Promise<void>(resolve => { releaseStop = resolve; });
    const { runtime } = persistentRuntime({ stopGate });
    await coordinatorFor(runtime, cardService()).handle(dm('om_first', '先跑一轮'), config);
    await vi.waitFor(() => expect(runtime.send).toHaveBeenCalledOnce());

    const service = cardService();
    const restarted = coordinatorFor(runtime, service);
    // /new 的 stop 尚未落库（会话还是 idle），此刻另一条消息已经进入队列。
    const newCommand = restarted.handle(dm('om_new', '/new'), config);
    await vi.waitFor(() => expect(runtime.stop).toHaveBeenCalledWith('ses_1', { kind: 'channel', id: 'ou_user_a', appId: 'cli_test' }));
    const concurrent = restarted.handle(dm('om_concurrent', '同时到达'), config);
    releaseStop();
    await Promise.all([newCommand, concurrent]);

    await vi.waitFor(() => expect(runtime.send).toHaveBeenCalledTimes(2));
    expect(runtime.send.mock.calls[1]?.[0]).toBe('ses_2');
  });

  it('未授权账号的 /new 在重启后同样零副作用', async () => {
    const { runtime } = persistentRuntime();
    await coordinatorFor(runtime, cardService()).handle(dm('om_first', '先跑一轮'), config);
    await vi.waitFor(() => expect(runtime.send).toHaveBeenCalledOnce());

    const service = cardService();
    const restricted = { ...config, allowedEmails: ['allowed@example.com'] };
    await coordinatorFor(runtime, service).handle(dm('om_deny', '/new 偷偷换个会话'), restricted);

    await vi.waitFor(() => expect(service.send).toHaveBeenCalledWith(expect.objectContaining({
      state: 'failed', readOnly: true, markdown: expect.stringContaining('白名单')
    })));
    expect(runtime.stop).not.toHaveBeenCalled();
    expect(runtime.send).toHaveBeenCalledOnce();
  });

  it('同一实例：上一轮 send 还没返回时，/new 在 send 释放前就已停掉旧会话', async () => {
    // 无 dispatch 的 fallback 路径里，group.tail 要等整轮 runtime.send 结束。
    // /new 若把 tail 当锁，长任务期间就永远停不下来——这里用一个不返回的 send 守住这条线：
    // stop 必须发生在 releaseSend 之前。
    let releaseSend!: () => void;
    const sendGate = new Promise<void>(resolve => { releaseSend = resolve; });
    const { runtime } = persistentRuntime({ sendGate });
    const service = cardService();
    const live = coordinatorFor(runtime, service);
    void live.handle(dm('om_long', '跑一个很久的任务'), config);
    await vi.waitFor(() => expect(runtime.send).toHaveBeenCalledOnce());

    await live.handle(dm('om_new', '/new'), config);
    await vi.waitFor(() => expect(service.send).toHaveBeenCalledWith(expect.objectContaining({ taskName: '/new 已受理' })));
    // 关键断言：长任务仍卡在 send 里，/new 已经把旧会话停掉了。
    expect(runtime.send).toHaveBeenCalledOnce();
    expect(runtime.stop).toHaveBeenCalledWith('ses_1', { kind: 'channel', id: 'ou_user_a', appId: 'cli_test' });
    expect(String(service.send.mock.calls.find(([input]: any[]) => input.taskName === '/new 已受理')?.[0]?.markdown ?? ''))
      .toContain('已结束当前会话');

    releaseSend();
    await live.handle(dm('om_next', '接着做'), config);
    await vi.waitFor(() => expect(runtime.send).toHaveBeenCalledTimes(2));
    expect(runtime.send.mock.calls[1]?.[0]).toBe('ses_2');
  });

  it('同一实例：旧任务卡在 start 时 /new 仍结束它，卡住的那一轮不得再派发旧 prompt', async () => {
    let releaseStart!: () => void;
    const startGate = new Promise<void>(resolve => { releaseStart = resolve; });
    const { runtime } = persistentRuntime({ startGate });
    const service = cardService();
    const live = coordinatorFor(runtime, service);
    void live.handle(dm('om_starting', '卡在建会话的旧任务'), config);
    await vi.waitFor(() => expect(runtime.start).toHaveBeenCalledOnce());

    // /new 先接管这个上下文（它自己的会话查询已经跑完），此时旧任务还卡在 start 里。
    const lookups = runtime.listSessions.mock.calls.length;
    const newCommand = live.handle(dm('om_new', '/new'), config);
    await vi.waitFor(() => expect(runtime.listSessions.mock.calls.length).toBeGreaterThan(lookups));
    // /new 允许等这次已知的、短期的 start 落地——但必须真的把它建出来的会话停掉。
    releaseStart();
    await newCommand;

    await vi.waitFor(() => expect(service.send).toHaveBeenCalledWith(expect.objectContaining({ taskName: '/new 已受理' })));
    expect(runtime.stop).toHaveBeenCalledWith('ses_1', { kind: 'channel', id: 'ou_user_a', appId: 'cli_test' });
    expect(String(service.send.mock.calls.find(([input]: any[]) => input.taskName === '/new 已受理')?.[0]?.markdown ?? ''))
      .toContain('已结束当前会话');
    // 被作废的那一轮绝不能把旧 prompt 发进一个用户已经宣布结束的上下文，
    // 而且必须给用户一张回执，不能让 OK 表情悬在那里永远等不到结果。
    await vi.waitFor(() => expect(service.send).toHaveBeenCalledWith(expect.objectContaining({ taskName: '请求未执行' })));
    expect(runtime.send).not.toHaveBeenCalled();

    // 之后的消息只能落在新会话上。
    await live.handle(dm('om_next', '/new 换个上下文重来'), config);
    await vi.waitFor(() => expect(runtime.send).toHaveBeenCalledOnce());
    expect(runtime.send.mock.calls[0]?.[0]).toBe('ses_2');
    expect(runtime.send.mock.calls[0]?.[1]).toBe('换个上下文重来');
  });

  it('会话查询失败时命令明确报错，不谎称没有会话、也不产生任何副作用', async () => {
    // listSessions 挂掉 = 我们不知道有没有会话。此时 /status 不能说「尚未创建」，
    // /new 更不能回「已受理」——那等于在什么都没停掉的情况下宣布已结束旧上下文。
    for (const [text, taskName] of [['/status', '/status 执行失败'], ['/new', '/new 执行失败'], ['/new 顺手跑个任务', '/new 执行失败']] as const) {
      const { runtime } = persistentRuntime();
      runtime.listSessions.mockRejectedValue(new Error('数据库不可用'));
      const service = cardService();
      await coordinatorFor(runtime, service).handle(dm(`om_fail_${taskName}_${text}`, text), config);

      await vi.waitFor(() => expect(service.send).toHaveBeenCalledWith(expect.objectContaining({
        state: 'failed', readOnly: true, taskName
      })));
      const markdown = String(service.send.mock.calls.find(([input]: any[]) => input.taskName === taskName)?.[0]?.markdown ?? '');
      expect(markdown).toContain('数据库不可用');
      expect(markdown).not.toContain('尚未创建');
      // 不确定就什么都别做：不停会话、不建会话、不派发任务。
      expect(runtime.stop).not.toHaveBeenCalled();
      expect(runtime.start).not.toHaveBeenCalled();
      expect(runtime.send).not.toHaveBeenCalled();
    }
  });

  it('/status 展示会话实际使用的 Agent 与工作区，而不是改过之后的配置值', async () => {
    const { runtime } = persistentRuntime();
    const service = cardService();
    // 同一个 coordinator：内存绑定还指着第一轮建的会话，此后配置被改掉。
    // /status 必须报会话真正在跑的那套，并把「配置已改、下个新会话才生效」讲清楚，
    // 否则用户会以为自己的任务正跑在 claude / /another-workspace 上。
    const live = coordinatorFor(runtime, service);
    await live.handle(dm('om_first', '先跑一轮'), config);
    await vi.waitFor(() => expect(runtime.send).toHaveBeenCalledOnce());

    await live.handle(dm('om_status', '/status'), { ...config, defaultAgentId: 'claude', workspace: '/another-workspace' });

    await vi.waitFor(() => expect(service.send).toHaveBeenCalledWith(expect.objectContaining({ taskName: '任务状态' })));
    const markdown = statusMarkdown(service);
    expect(markdown).toContain('**Agent**：codex');
    expect(markdown).toContain('**配置的 Agent**：claude（下一个新会话生效）');
    expect(markdown).toContain('**工作区**：/workspace');
    expect(markdown).toContain('**配置的工作区**：/another-workspace（下一个新会话生效）');
    expect(markdown).toContain('ses_1');
  });

  it('配置换了 Agent 之后，重启的 coordinator 不认领旧 Agent 的会话', async () => {
    const { runtime } = persistentRuntime();
    await coordinatorFor(runtime, cardService()).handle(dm('om_first', '先跑一轮'), config);
    await vi.waitFor(() => expect(runtime.send).toHaveBeenCalledOnce());

    // 重启后只剩持久化查询，而 codex 的会话不属于 claude 配置——诚实说没有会话，
    // 不能把别的 Agent 的上下文认成自己的。
    const service = cardService();
    await coordinatorFor(runtime, service).handle(dm('om_status', '/status'), { ...config, defaultAgentId: 'claude' });

    await vi.waitFor(() => expect(service.send).toHaveBeenCalledWith(expect.objectContaining({ taskName: '任务状态' })));
    const markdown = statusMarkdown(service);
    expect(markdown).toContain('请回原话题查询');
    expect(markdown).not.toContain('ses_1');
  });
});

describe('私聊话题与 App 的持久化隔离', () => {
  const threadConfig = { ...config, p2pMode: 'thread' as const };

  it('p2pMode=thread 时每个私聊话题各自持久化，/status 只看到本话题', async () => {
    const { runtime } = persistentRuntime();
    const seed = coordinatorFor(runtime, cardService());
    await seed.handle(dm('om_topic_a', '话题 A'), threadConfig);
    await vi.waitFor(() => expect(runtime.send).toHaveBeenCalledOnce());
    await seed.handle(dm('om_topic_b', '话题 B'), threadConfig);
    await vi.waitFor(() => expect(runtime.send).toHaveBeenCalledTimes(2));

    // 两个顶层 DM 必须是两条会话，且 sourceId 不同——否则话题 B 会读到话题 A 的上下文。
    expect(runtime.start).toHaveBeenCalledTimes(2);
    expect(runtime.start.mock.calls[0]?.[0].sourceId).toBe('cli_test:ou_user_a:p2p:thread:om_topic_a');
    expect(runtime.start.mock.calls[1]?.[0].sourceId).toBe('cli_test:ou_user_a:p2p:thread:om_topic_b');

    const service = cardService();
    await coordinatorFor(runtime, service).handle(
      dm('om_status_a', '/status', { rootId: 'om_topic_a', threadId: 'omt_a' }),
      threadConfig
    );
    await vi.waitFor(() => expect(service.send).toHaveBeenCalledWith(expect.objectContaining({ taskName: '任务状态' })));
    const markdown = statusMarkdown(service);
    expect(markdown).toContain('ses_1');
    expect(markdown).not.toContain('ses_2');
  });

  it('普通私聊（p2pMode 未设置）保留旧 sourceId 格式', async () => {
    const { runtime } = persistentRuntime();
    await coordinatorFor(runtime, cardService()).handle(dm('om_plain', '你好'), config);
    await vi.waitFor(() => expect(runtime.start).toHaveBeenCalledOnce());
    expect(runtime.start.mock.calls[0]?.[0].sourceId).toBe('cli_test:ou_user_a:p2p');
  });

  it('/new 只结束本 App 的会话，不碰另一个 App 的同一个聊天', async () => {
    const { runtime } = persistentRuntime();
    const otherApp = { ...config, appId: 'cli_other' };
    const seed = coordinatorFor(runtime, cardService());
    await seed.handle(dm('om_a', '本 App'), config);
    await vi.waitFor(() => expect(runtime.send).toHaveBeenCalledOnce());
    await seed.handle(dm('om_b', '另一个 App'), otherApp);
    await vi.waitFor(() => expect(runtime.send).toHaveBeenCalledTimes(2));

    const service = cardService();
    await coordinatorFor(runtime, service).handle(dm('om_new', '/new'), otherApp);
    await vi.waitFor(() => expect(service.send).toHaveBeenCalledWith(expect.objectContaining({ taskName: '/new 已受理' })));
    expect(runtime.stop).toHaveBeenCalledWith('ses_2', { kind: 'channel', id: 'ou_user_a', appId: 'cli_other' });
    expect(runtime.stop).not.toHaveBeenCalledWith('ses_1', { kind: 'channel', id: 'ou_user_a', appId: 'cli_other' });
  });
});

/**
 * /new 必须停掉「下一条普通消息还可能选回来」的全部持久化会话。
 *
 * 不变量：/new 之后，同一 App/chat/scope/config 下不能再有任何一条会话被
 * resolveLarkSession 复用。只停「最近一条」是不够的——最近一条可能已经是 stopped，
 * 而更早那条 idle 会被普通消息重新选中，于是「已结束当前会话」变成一句假话。
 */
describe('/new 结束当前 scope 的全部可复用会话', () => {
  const larkSession = (overrides: Partial<Session> & Pick<Session, 'id'>): Session => ({
    agentId: 'codex', state: 'idle', cwd: '/workspace', permissionMode: 'full-trust',
    source: 'lark', sourceId: 'cli_test:ou_user_a:p2p', runId: `run_${overrides.id}`,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  });

  it('最新一条已 stopped 时，仍要停掉更早那条可复用的 idle 会话', async () => {
    const { runtime, sessions } = persistentRuntime();
    sessions.push(
      larkSession({ id: 'ses_old_idle', createdAt: '2026-01-01T00:00:00.000Z' }),
      larkSession({ id: 'ses_late_stopped', state: 'stopped', createdAt: '2026-01-02T00:00:00.000Z' })
    );

    const service = cardService();
    await coordinatorFor(runtime, service).handle(dm('om_new', '/new'), config);
    await vi.waitFor(() => expect(service.send).toHaveBeenCalledWith(expect.objectContaining({ taskName: '/new 已受理' })));
    expect(runtime.stop).toHaveBeenCalledWith('ses_old_idle', { kind: 'channel', id: 'ou_user_a', appId: 'cli_test' });

    // 「已结束」之后的下一条普通消息必须开新会话，不能选回 ses_old_idle。
    await coordinatorFor(runtime, cardService()).handle(dm('om_next', '下一条'), config);
    await vi.waitFor(() => expect(runtime.start).toHaveBeenCalledOnce());
    expect(runtime.send.mock.calls[0]?.[0]).not.toBe('ses_old_idle');
  });

  it('多条可复用会话全部停掉，/new <目标> 派发到全新会话', async () => {
    const { runtime, sessions } = persistentRuntime();
    sessions.push(
      larkSession({ id: 'ses_a', createdAt: '2026-01-01T00:00:00.000Z' }),
      larkSession({ id: 'ses_b', createdAt: '2026-01-02T00:00:00.000Z' }),
      larkSession({ id: 'ses_c', state: 'stopped', createdAt: '2026-01-03T00:00:00.000Z' })
    );

    await coordinatorFor(runtime, cardService()).handle(dm('om_new', '/new 跑一遍回归'), config);
    await vi.waitFor(() => expect(runtime.send).toHaveBeenCalledOnce());
    for (const id of ['ses_a', 'ses_b']) expect(runtime.stop).toHaveBeenCalledWith(id, { kind: 'channel', id: 'ou_user_a', appId: 'cli_test' });
    expect(runtime.start).toHaveBeenCalledOnce();
    // 目标派发进的是新建的那条，不是任何一条旧会话。
    expect(['ses_a', 'ses_b', 'ses_c']).not.toContain(runtime.send.mock.calls[0]?.[0]);
  });

  it('不碰其他 App / 其他话题 / 已归档的会话', async () => {
    const { runtime, sessions } = persistentRuntime();
    sessions.push(
      larkSession({ id: 'ses_here' }),
      larkSession({ id: 'ses_other_app', sourceId: 'cli_other:ou_user_a:p2p' }),
      larkSession({ id: 'ses_other_chat', sourceId: 'cli_test:ou_user_b:p2p' }),
      larkSession({ id: 'ses_other_topic', sourceId: 'cli_test:oc_group:group:thread:omt_x' }),
      larkSession({ id: 'ses_archived', archivedAt: '2026-01-05T00:00:00.000Z' }),
      larkSession({ id: 'ses_other_agent', agentId: 'claude' }),
      larkSession({ id: 'ses_other_cwd', cwd: '/elsewhere' })
    );

    const service = cardService();
    await coordinatorFor(runtime, service).handle(dm('om_new', '/new'), config);
    await vi.waitFor(() => expect(service.send).toHaveBeenCalledWith(expect.objectContaining({ taskName: '/new 已受理' })));
    expect(runtime.stop).toHaveBeenCalledWith('ses_here', { kind: 'channel', id: 'ou_user_a', appId: 'cli_test' });
    expect(runtime.stop).toHaveBeenCalledTimes(1);
  });

  it('重复 /new 不再重复 stop 已经停下的历史目标', async () => {
    const { runtime, sessions } = persistentRuntime();
    sessions.push(larkSession({ id: 'ses_only' }));

    const group = coordinatorFor(runtime, cardService());
    await group.handle(dm('om_new_1', '/new'), config);
    await vi.waitFor(() => expect(runtime.stop).toHaveBeenCalledWith('ses_only', { kind: 'channel', id: 'ou_user_a', appId: 'cli_test' }));

    runtime.stop.mockClear();
    await group.handle(dm('om_new_2', '/new'), config);
    await vi.waitFor(() => expect(runtime.stop).not.toHaveBeenCalled());
  });

  it('上一次 stop 失败、会话仍活跃时，同一实例的下一次 /new 会重试', async () => {
    const { runtime, sessions } = persistentRuntime();
    sessions.push(larkSession({ id: 'ses_stubborn' }));
    // 第一次 stop 抛错：会话没停下，仍会被普通消息选回来。它已经进了本实例的 retired
    // 集合，如果实现拿「已在集合里」当跳过依据，第二次 /new 就永远停不掉它。
    runtime.stop.mockRejectedValueOnce(new Error('stop 失败'));

    const service = cardService();
    const group = coordinatorFor(runtime, service);
    await group.handle(dm('om_new_1', '/new'), config);
    await vi.waitFor(() => expect(service.send).toHaveBeenCalledWith(expect.objectContaining({ taskName: '/new 执行失败' })));

    // 同一个 coordinator 实例、同一个 group：这才测得到 retired 集合的重试语义。
    await group.handle(dm('om_new_2', '/new'), config);
    await vi.waitFor(() => expect(service.send).toHaveBeenCalledWith(expect.objectContaining({ taskName: '/new 已受理' })));
    expect(runtime.stop).toHaveBeenCalledTimes(2);
    expect(runtime.stop).toHaveBeenNthCalledWith(2, 'ses_stubborn', { kind: 'channel', id: 'ou_user_a', appId: 'cli_test' });
    expect(sessions.find(item => item.id === 'ses_stubborn')?.state).toBe('stopped');
  });

  it('列表读取失败时 /new 明确失败，不当成「没有会话」', async () => {
    const { runtime, sessions } = persistentRuntime();
    sessions.push(larkSession({ id: 'ses_here' }));
    runtime.listSessions.mockRejectedValueOnce(new Error('数据库不可用'));

    const service = cardService();
    await coordinatorFor(runtime, service).handle(dm('om_new', '/new'), config);
    await vi.waitFor(() => expect(service.send).toHaveBeenCalledWith(expect.objectContaining({ taskName: '/new 执行失败' })));
    expect(runtime.stop).not.toHaveBeenCalled();
    expect(runtime.start).not.toHaveBeenCalled();
  });
});

/**
 * 阶段 2：coordinator 重建后的 /cancel 与 /retry。
 *
 * 判据一律来自 runtime.getTasks 的真实任务状态，不依赖重启前留在卡片上的 state；
 * 原 prompt 一律来自当前 App channel 的持久化 mapping，核对 app_id/chat_id 后才用。
 */
describe('/cancel 在 coordinator 重建后', () => {
  const seedSession = async (runtime: any) => {
    await coordinatorFor(runtime, cardService()).handle(dm('om_first', '先跑一轮'), config);
    await vi.waitFor(() => expect(runtime.send).toHaveBeenCalledOnce());
  };

  it('取消当前 scope 的排队任务，走 cancelQueued 而不是空口受理', async () => {
    const { runtime, tasks } = persistentRuntime();
    await seedSession(runtime);
    tasks.set('ses_1', [runtimeTask({ id: 'rt_queued', sessionId: 'ses_1', status: 'queued' })]);

    const service = cardService();
    await coordinatorFor(runtime, service).handle(dm('om_cancel', '/cancel'), config);

    await vi.waitFor(() => expect(runtime.cancelQueued).toHaveBeenCalledWith('ses_1', 'rt_queued', 'ou_user_a'));
    expect(runtime.interrupt).not.toHaveBeenCalled();
    expect(service.send).toHaveBeenCalledWith(expect.objectContaining({ taskName: '/cancel 已受理' }));
  });

  it('中断当前 scope 正在执行的任务，走 interrupt', async () => {
    const { runtime, tasks } = persistentRuntime();
    await seedSession(runtime);
    tasks.set('ses_1', [runtimeTask({ id: 'rt_running', sessionId: 'ses_1', status: 'running' })]);

    const service = cardService();
    await coordinatorFor(runtime, service).handle(dm('om_cancel', '/cancel'), config);

    await vi.waitFor(() => expect(runtime.interrupt).toHaveBeenCalledWith('ses_1', 'rt_running', 'ou_user_a'));
    expect(runtime.cancelQueued).not.toHaveBeenCalled();
    expect(service.send).toHaveBeenCalledWith(expect.objectContaining({ taskName: '/cancel 已受理' }));
  });

  it('没有在跑或排队的任务时诚实回执，不调用任何停止原语', async () => {
    const { runtime, tasks } = persistentRuntime();
    await seedSession(runtime);
    tasks.set('ses_1', [runtimeTask({ id: 'rt_done', sessionId: 'ses_1', status: 'completed' })]);

    const service = cardService();
    await coordinatorFor(runtime, service).handle(dm('om_cancel', '/cancel'), config);

    await vi.waitFor(() => expect(service.send).toHaveBeenCalledWith(expect.objectContaining({
      state: 'failed', taskName: '/cancel 未执行'
    })));
    expect(runtime.interrupt).not.toHaveBeenCalled();
    expect(runtime.cancelQueued).not.toHaveBeenCalled();
  });

  it('不会取消另一个话题的任务', async () => {
    const threadConfig = { ...config, p2pMode: 'thread' as const };
    const { runtime, tasks } = persistentRuntime();
    const seed = coordinatorFor(runtime, cardService());
    await seed.handle(dm('om_topic_a', '话题 A'), threadConfig);
    await vi.waitFor(() => expect(runtime.send).toHaveBeenCalledOnce());
    await seed.handle(dm('om_topic_b', '话题 B'), threadConfig);
    await vi.waitFor(() => expect(runtime.send).toHaveBeenCalledTimes(2));
    // 只有话题 A 有在跑的任务；在话题 B 里发 /cancel 不得动它。
    tasks.set('ses_1', [runtimeTask({ id: 'rt_a', sessionId: 'ses_1', status: 'running' })]);

    const service = cardService();
    await coordinatorFor(runtime, service).handle(
      dm('om_cancel_b', '/cancel', { rootId: 'om_topic_b', threadId: 'omt_b' }),
      threadConfig
    );

    await vi.waitFor(() => expect(service.send).toHaveBeenCalledWith(expect.objectContaining({ taskName: '/cancel 未执行' })));
    expect(runtime.interrupt).not.toHaveBeenCalled();
    expect(runtime.cancelQueued).not.toHaveBeenCalled();
  });

  it('白名单外账号的 /cancel 零副作用', async () => {
    const { runtime, tasks } = persistentRuntime();
    await seedSession(runtime);
    tasks.set('ses_1', [runtimeTask({ id: 'rt_running', sessionId: 'ses_1', status: 'running' })]);

    const service = cardService();
    await coordinatorFor(runtime, service).handle(
      dm('om_cancel', '/cancel'), { ...config, allowedEmails: ['allowed@example.com'] }
    );

    await vi.waitFor(() => expect(service.send).toHaveBeenCalledWith(expect.objectContaining({
      state: 'failed', markdown: expect.stringContaining('白名单')
    })));
    expect(runtime.interrupt).not.toHaveBeenCalled();
    expect(runtime.cancelQueued).not.toHaveBeenCalled();
  });
});

describe('/retry 在 coordinator 重建后', () => {
  const seedSession = async (runtime: any) => {
    await coordinatorFor(runtime, cardService()).handle(dm('om_first', '先跑一轮'), config);
    await vi.waitFor(() => expect(runtime.send).toHaveBeenCalledOnce());
  };

  it('按 mapping 恢复原 prompt，作为一个走完整链路的新任务重发', async () => {
    const { runtime, tasks } = persistentRuntime();
    await seedSession(runtime);
    tasks.set('ses_1', [runtimeTask({ id: 'rt_failed', sessionId: 'ses_1', status: 'failed', prompt: '原始请求' })]);
    const mappings = cardMappingRepository([{
      externalId: 'om_first', sessionId: 'ses_1',
      extra: persistedCard({ runtime_task_id: 'rt_failed', prompt: '原始请求', card_message_id: 'om_old_card' })
    }]);

    const service = cardService();
    await coordinatorFor(runtime, service, mappings.repository).handle(dm('om_retry', '/retry'), config);

    // 新任务真的重新派发，且用的是恢复出来的原 prompt。
    await vi.waitFor(() => expect(runtime.send).toHaveBeenCalledTimes(2));
    expect(runtime.send.mock.calls[1]?.[0]).toBe('ses_1');
    expect(runtime.send.mock.calls[1]?.[1]).toBe('原始请求');
    // 新进度卡是一张新卡；旧卡不得被更新（旧收据不可变）。
    expect(service.send).toHaveBeenCalledWith(expect.objectContaining({ taskName: '原始请求', state: 'running' }));
    for (const [input] of service.update.mock.calls) expect((input as any).messageId).not.toBe('om_old_card');
    // 旧卡的 mapping 不能被新任务覆盖。
    const oldRow = mappings.rows.get('lark-card:cli_test:om_first');
    expect(JSON.parse(String(oldRow?.extra)).card_message_id).toBe('om_old_card');
  });

  it('重试已中断的运行同样成立', async () => {
    const { runtime, tasks } = persistentRuntime();
    await seedSession(runtime);
    tasks.set('ses_1', [runtimeTask({ id: 'rt_int', sessionId: 'ses_1', status: 'interrupted', prompt: '被打断的请求' })]);
    const mappings = cardMappingRepository([{
      externalId: 'om_first', sessionId: 'ses_1',
      extra: persistedCard({ runtime_task_id: 'rt_int', prompt: '被打断的请求', state: 'interrupted' })
    }]);

    const service = cardService();
    await coordinatorFor(runtime, service, mappings.repository).handle(dm('om_retry', '/retry'), config);

    await vi.waitFor(() => expect(runtime.send).toHaveBeenCalledTimes(2));
    expect(runtime.send.mock.calls[1]?.[1]).toBe('被打断的请求');
  });

  it('重试按当前发送人重新算风险：非高危授权者不得继承原发起人的授权', async () => {
    const { runtime, tasks } = persistentRuntime();
    const risky = {
      ...config, riskControlMode: 'enforced' as const,
      highRiskAllowedUsers: [{ openId: 'ou_privileged', name: '有权限的人' }]
    };
    await coordinatorFor(runtime, cardService()).handle(
      dm('om_first', '危险操作', { senderOpenId: 'ou_privileged' }), risky
    );
    await vi.waitFor(() => expect(runtime.send).toHaveBeenCalledOnce());
    expect(runtime.send.mock.calls[0]?.[3]).toMatchObject({ authorized: true });

    tasks.set('ses_1', [runtimeTask({ id: 'rt_failed', sessionId: 'ses_1', status: 'failed', prompt: '危险操作' })]);
    const mappings = cardMappingRepository([{
      externalId: 'om_first', sessionId: 'ses_1',
      extra: persistedCard({ runtime_task_id: 'rt_failed', prompt: '危险操作' })
    }]);

    // 另一个人来重试：必须按他自己的权限重新判定。
    const service = cardService();
    await coordinatorFor(runtime, service, mappings.repository).handle(
      dm('om_retry', '/retry', { senderOpenId: 'ou_plain' }), risky
    );

    await vi.waitFor(() => expect(runtime.send).toHaveBeenCalledTimes(2));
    expect(runtime.send.mock.calls[1]?.[3]).toMatchObject({ authorized: false });
  });

  it('没有失败或中断的运行时诚实回执，不重发任何东西', async () => {
    const { runtime, tasks } = persistentRuntime();
    await seedSession(runtime);
    tasks.set('ses_1', [runtimeTask({ id: 'rt_done', sessionId: 'ses_1', status: 'completed' })]);
    const mappings = cardMappingRepository();

    const service = cardService();
    await coordinatorFor(runtime, service, mappings.repository).handle(dm('om_retry', '/retry'), config);

    await vi.waitFor(() => expect(service.send).toHaveBeenCalledWith(expect.objectContaining({
      state: 'failed', taskName: '/retry 未执行'
    })));
    expect(runtime.send).toHaveBeenCalledOnce();
  });

  it('找不到可恢复的原请求时说清楚，不猜一个 prompt 重发', async () => {
    const { runtime, tasks } = persistentRuntime();
    await seedSession(runtime);
    tasks.set('ses_1', [runtimeTask({ id: 'rt_failed', sessionId: 'ses_1', status: 'failed', prompt: '' })]);
    // mapping 里没有这条 runtime task 的记录。
    const mappings = cardMappingRepository();

    const service = cardService();
    await coordinatorFor(runtime, service, mappings.repository).handle(dm('om_retry', '/retry'), config);

    await vi.waitFor(() => expect(service.send).toHaveBeenCalledWith(expect.objectContaining({
      state: 'failed', taskName: '/retry 未执行', markdown: expect.stringContaining('重新发送')
    })));
    expect(runtime.send).toHaveBeenCalledOnce();
  });

  it('同实例内存分支的 /retry 也按当前发送人重算风险，不沿用原发起人授权', async () => {
    // Alice 有高危授权、任务失败；Bob 只是普通白名单成员。Bob 发 /retry 时
    // 必须按 Bob 自己的权限重新判定——内存里还留着 Alice 的 task 不是继承授权的理由。
    const { runtime } = persistentRuntime();
    const risky = {
      ...config, riskControlMode: 'enforced' as const,
      highRiskAllowedUsers: [{ openId: 'ou_alice', name: 'Alice' }]
    };
    const service = cardService();
    const live = coordinatorFor(runtime, service);
    // 让这一轮真的失败，内存 task 停在 failed。
    runtime.send.mockRejectedValueOnce(new Error('这一轮炸了'));
    await live.handle(dm('om_alice', '危险操作', { senderOpenId: 'ou_alice' }), risky);
    await vi.waitFor(() => expect(runtime.send).toHaveBeenCalledOnce());
    expect(runtime.send.mock.calls[0]?.[3]).toMatchObject({ authorized: true });
    const cardsBefore = service.send.mock.calls.length;
    // Alice 自己那一轮的失败收据已经写完；只看 Bob 发 /retry 之后还动了哪些卡。
    const updatesBefore = service.update.mock.calls.length;

    await live.handle(dm('om_bob_retry', '/retry', { senderOpenId: 'ou_bob' }), risky);

    await vi.waitFor(() => expect(runtime.send).toHaveBeenCalledTimes(2));
    // 关键：按 Bob 重算，不是继承 Alice 的 authorized:true。
    expect(runtime.send.mock.calls[1]?.[3]).toMatchObject({ authorized: false });
    expect(runtime.send.mock.calls[1]?.[1]).toBe('危险操作');
    // 新任务有自己的新卡，没有改写 Alice 那张旧卡。
    expect(service.send.mock.calls.length).toBeGreaterThan(cardsBefore);
    for (const [input] of service.update.mock.calls.slice(updatesBefore)) {
      expect((input as any).taskId).not.toBe('om_alice');
    }
  });

  it('最新一轮已完成时不重试更早的失败请求', async () => {
    // 语义与内存里的 latestTask 一致：只看当前会话**最近**那一轮。
    // reverse().find(failed) 会跳过最新的 completed，把用户早就放下的旧请求重新跑一遍。
    const { runtime, tasks } = persistentRuntime();
    await seedSession(runtime);
    tasks.set('ses_1', [
      runtimeTask({ id: 'rt_old_failed', sessionId: 'ses_1', status: 'failed', prompt: '早就失败的请求' }),
      runtimeTask({ id: 'rt_latest_done', sessionId: 'ses_1', status: 'completed', prompt: '最新已完成' })
    ]);
    const mappings = cardMappingRepository([{
      externalId: 'om_old', sessionId: 'ses_1',
      extra: persistedCard({ runtime_task_id: 'rt_old_failed', prompt: '早就失败的请求' })
    }]);

    const service = cardService();
    await coordinatorFor(runtime, service, mappings.repository).handle(dm('om_retry', '/retry'), config);

    await vi.waitFor(() => expect(service.send).toHaveBeenCalledWith(expect.objectContaining({
      state: 'failed', taskName: '/retry 未执行'
    })));
    expect(runtime.send).toHaveBeenCalledOnce();
    expect(JSON.stringify(runtime.send.mock.calls)).not.toContain('早就失败的请求');
  });

  it('最新一轮仍在执行时不重试更早的失败请求', async () => {
    const { runtime, tasks } = persistentRuntime();
    await seedSession(runtime);
    tasks.set('ses_1', [
      runtimeTask({ id: 'rt_old_failed', sessionId: 'ses_1', status: 'failed', prompt: '早就失败的请求' }),
      runtimeTask({ id: 'rt_running', sessionId: 'ses_1', status: 'running', prompt: '正在跑的请求' })
    ]);
    const mappings = cardMappingRepository([{
      externalId: 'om_old', sessionId: 'ses_1',
      extra: persistedCard({ runtime_task_id: 'rt_old_failed', prompt: '早就失败的请求' })
    }]);

    const service = cardService();
    await coordinatorFor(runtime, service, mappings.repository).handle(dm('om_retry', '/retry'), config);

    await vi.waitFor(() => expect(service.send).toHaveBeenCalledWith(expect.objectContaining({
      state: 'failed', taskName: '/retry 未执行'
    })));
    expect(runtime.send).toHaveBeenCalledOnce();
  });

  it('目标记录缺 runtime_task_id 时，不拿同一会话另一轮的 prompt 顶替', async () => {
    // 同一个 session 跑过两轮、prompt 不同；要重试的那一轮其 mapping 恰好没有
    // runtime_task_id（旧版本记录 / 崩在落盘之前）。此时唯一诚实的答复是「恢复不出来」，
    // 拿相邻那轮的 prompt 重发等于替用户执行了一件他没要求的事。
    const { runtime, tasks } = persistentRuntime();
    await seedSession(runtime);
    tasks.set('ses_1', [
      runtimeTask({ id: 'rt_older', sessionId: 'ses_1', status: 'completed', prompt: '第一轮请求' }),
      runtimeTask({ id: 'rt_target', sessionId: 'ses_1', status: 'failed', prompt: '第二轮请求' })
    ]);
    const mappings = cardMappingRepository([
      // 第一轮：记录完整，但它不是重试目标。
      { externalId: 'om_round_one', sessionId: 'ses_1', extra: persistedCard({ runtime_task_id: 'rt_older', prompt: '第一轮请求', state: 'completed', started_at: 1_700_000_000_000 }) },
      // 第二轮（目标）：缺 runtime_task_id，且是最近的一条。
      { externalId: 'om_round_two', sessionId: 'ses_1', extra: persistedCard({ prompt: '第二轮请求', started_at: 1_700_000_009_999 }) }
    ]);

    const service = cardService();
    await coordinatorFor(runtime, service, mappings.repository).handle(dm('om_retry', '/retry'), config);

    await vi.waitFor(() => expect(service.send).toHaveBeenCalledWith(expect.objectContaining({
      state: 'failed', taskName: '/retry 未执行', markdown: expect.stringContaining('重新发送')
    })));
    // 零新派发，且绝不能把任何一轮的 prompt 当成目标重发。
    expect(runtime.send).toHaveBeenCalledOnce();
    expect(JSON.stringify(runtime.send.mock.calls)).not.toContain('第一轮请求');
    expect(JSON.stringify(runtime.send.mock.calls)).not.toContain('第二轮请求');
  });

  it('不采用其他 App / 其他聊天的 mapping 记录', async () => {
    const { runtime, tasks } = persistentRuntime();
    await seedSession(runtime);
    tasks.set('ses_1', [runtimeTask({ id: 'rt_failed', sessionId: 'ses_1', status: 'failed', prompt: '' })]);
    // 同一个 runtime_task_id，但记录属于另一个 App 与另一个 chat。
    const mappings = cardMappingRepository([
      { externalId: 'om_other_app', sessionId: 'ses_1', extra: persistedCard({ app_id: 'cli_other', runtime_task_id: 'rt_failed', prompt: '别的 App 的请求' }) },
      { externalId: 'om_other_chat', sessionId: 'ses_1', extra: persistedCard({ chat_id: 'oc_other_chat', runtime_task_id: 'rt_failed', prompt: '别的聊天的请求' }) }
    ]);

    const service = cardService();
    await coordinatorFor(runtime, service, mappings.repository).handle(dm('om_retry', '/retry'), config);

    await vi.waitFor(() => expect(service.send).toHaveBeenCalledWith(expect.objectContaining({ taskName: '/retry 未执行' })));
    expect(runtime.send).toHaveBeenCalledOnce();
    expect(JSON.stringify(runtime.send.mock.calls)).not.toContain('别的 App 的请求');
    expect(JSON.stringify(runtime.send.mock.calls)).not.toContain('别的聊天的请求');
  });

  it('白名单外账号的 /retry 零副作用', async () => {
    const { runtime, tasks } = persistentRuntime();
    await seedSession(runtime);
    tasks.set('ses_1', [runtimeTask({ id: 'rt_failed', sessionId: 'ses_1', status: 'failed', prompt: '原始请求' })]);
    const mappings = cardMappingRepository([{
      externalId: 'om_first', sessionId: 'ses_1',
      extra: persistedCard({ runtime_task_id: 'rt_failed', prompt: '原始请求' })
    }]);

    const service = cardService();
    await coordinatorFor(runtime, service, mappings.repository).handle(
      dm('om_retry', '/retry'), { ...config, allowedEmails: ['allowed@example.com'] }
    );

    await vi.waitFor(() => expect(service.send).toHaveBeenCalledWith(expect.objectContaining({
      state: 'failed', markdown: expect.stringContaining('白名单')
    })));
    expect(runtime.send).toHaveBeenCalledOnce();
  });
});

/**
 * 离线集成回归：真实 SQLite repositories + 真实 DutydeckRuntime + 假 driver。
 *
 * 上面那些用例的 runtime 是数组替身，证明不了「命令恢复」在真的持久化层上成立——
 * task 状态由 runtime 自己写库、mapping 由 saveCardTask 自己落盘，两者的字段约定
 * 只有跑一遍真实实现才验得出来。这里全程合成数据、不碰网络、不改 ACPX 环境注入，
 * finally 关库。
 */
describe('SQLite + DutydeckRuntime 的命令恢复集成', () => {
  // command 只是一个永不被执行的占位：下面注入了 driverFactory，AcpxAdapter 不会被构造，
  // 也就不存在启动真实 CLI / ACP provider 的路径。probe 同样是替身，不去探测本机命令。
  const unusedCommand = '/nonexistent/dutydeck-test-agent-never-executed';
  const agentFor = (cwd: string): AgentConfig => ({
    id: 'codex', name: 'Codex', command: unusedCommand, args: [], protocol: 'acp',
    cwd, env: {}, permissionMode: 'ask', timeout: 10,
    capabilities: { pause: false, resume: true }, builtin: false
  });

  /** 假 driver：首轮 send 挂起直到 interrupt 发所属 completed(cancelled) 并让 send 返回（与真实 transport 中断后 turn 收口一致）；之后新轮次正常完成。 */
  function stalledDriver() {
    let emitEvent!: (event: import('@dutydeck/shared').NormalizedDriverEvent) => void;
    let resolveTurn: (() => void) | undefined;
    let interrupted = false;
    const driver: AgentDriver = {
      start: vi.fn(async () => {}),
      send: vi.fn(async () => {
        if (interrupted) {
          emitEvent({ type: 'text', data: { text: '重试结果' } });
          emitEvent({ type: 'completed', data: { stopReason: 'end_turn' } });
          return;
        }
        await new Promise<void>(resolve => { resolveTurn = resolve; });
      }),
      interrupt: vi.fn(async () => { interrupted = true; emitEvent({ type: 'completed', data: { stopReason: 'cancelled' } }); resolveTurn?.(); resolveTurn = undefined; }),
      resume: vi.fn(async () => {}),
      stop: vi.fn(async () => { resolveTurn?.(); resolveTurn = undefined; })
    };
    return { driver, bind: (emit: (event: import('@dutydeck/shared').NormalizedDriverEvent) => void) => { emitEvent = emit; } };
  }

  /** 每张卡片一个可区分的合成 messageId，用来分辨旧卡与重试新卡。 */
  function trackedCardService(prefix: string) {
    let issued = 0;
    return {
      addReaction: vi.fn(async () => ({ reactionId: 'reaction-1' })),
      deleteReaction: vi.fn(async () => {}),
      send: vi.fn(async () => ({ messageId: `${prefix}_card_${++issued}` })),
      update: vi.fn(async (input: any) => ({ messageId: input.messageId })),
      getUserEmails: vi.fn(async () => ['outsider@example.com'])
    };
  }

  it('重建 coordinator 后按库里的真实任务状态中断，并按落盘 mapping 恢复原 prompt 重试', async () => {
    // runtime 会真的 mkdir 会话 cwd，必须用一个可写的临时目录。
    const workspace = await mkdtemp(join(tmpdir(), 'dutydeck-lark-recovery-'));
    const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' });
    const integrationConfig = { ...config, workspace };
    const { driver, bind } = stalledDriver();
    const runtime = new DutydeckRuntime(repos, {
      probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }),
      driverFactory: (_agent, _protocol, emit) => { bind(emit); return driver; }
    });
    try {
      await runtime.initialize([agentFor(workspace)]);
      await repos.config.set(larkBotsConfigKey, JSON.stringify([integrationConfig]));

      const service = trackedCardService('om_first');
      const first = new LarkMessageCoordinator(
        runtime as any, service as any, silentLog(), Math.random, 'ou_bot',
        undefined, repos.channelMappings, undefined, undefined, undefined, { store: repos.config }
      );
      await first.initializeWorkflows(integrationConfig);
      // 一轮真实任务：driver 挂住，任务留在 running，卡片 mapping 落盘。
      void first.handle(dm('om_real', '把回归跑一遍'), integrationConfig);
      await vi.waitFor(async () => {
        const sessions = await repos.sessions.list();
        expect(sessions).toHaveLength(1);
        expect(await repos.tasks.listBySession(sessions[0]!.id)).toHaveLength(1);
      });
      const sessionId = (await repos.sessions.list())[0]!.id;
      await vi.waitFor(async () =>
        expect((await repos.tasks.listBySession(sessionId))[0]?.status).toBe('running'));
      // 中断语义针对的是已提交并挂在 send 中的一轮：必须等到 driver 真实收到 send，
      // 否则任务还停在受控准备阶段，Runtime 会按准备中断回收，验不到提交后中断。
      await vi.waitFor(() => expect(driver.send).toHaveBeenCalled());
      await vi.waitFor(async () =>
        expect(await repos.channelMappings.list('lark-card:cli_test')).not.toHaveLength(0));
      const originalTaskId = (await repos.tasks.listBySession(sessionId))[0]!.id;
      const oldMapping = (await repos.channelMappings.list('lark-card:cli_test'))[0]!;
      const oldCardMessageId = JSON.parse(String(oldMapping.extra)).card_message_id as string;
      expect(oldCardMessageId).toBe('om_first_card_1');

      // daemon 重启：全新 coordinator，只有库里的 session / task / mapping。
      const cancelService = trackedCardService('om_cancel');
      const restarted = new LarkMessageCoordinator(
        runtime as any, cancelService as any, silentLog(), Math.random, 'ou_bot',
        undefined, repos.channelMappings, undefined, undefined, undefined, { store: repos.config }
      );
      await restarted.initializeWorkflows(integrationConfig);
      await restarted.handle(dm('om_cancel', '/cancel'), integrationConfig);
      await vi.waitFor(() => expect(cancelService.send).toHaveBeenCalledWith(
        expect.objectContaining({ taskName: '/cancel 已受理' })));
      await vi.waitFor(() => expect(driver.interrupt).toHaveBeenCalled());
      // 全程只可能用到注入的假 driver：它确实承接了这一轮，真实 CLI/ACP 从未被启动。
      expect(driver.start).toHaveBeenCalled();
      expect(driver.send).toHaveBeenCalled();
      // 中断就该落成 interrupted：放宽到 failed/completed 会让「没真的中断」也蒙混过关。
      await vi.waitFor(async () =>
        expect((await repos.tasks.listBySession(sessionId)).find(task => task.id === originalTaskId)?.status)
          .toBe('interrupted'));

      // 再重建一次，验证 /retry 能从落盘 mapping 里恢复原 prompt 并派发一个新任务。
      const before = (await repos.tasks.listBySession(sessionId)).length;
      const retryService = trackedCardService('om_retry');
      const retrying = new LarkMessageCoordinator(
        runtime as any, retryService as any, silentLog(), Math.random, 'ou_bot',
        undefined, repos.channelMappings, undefined, undefined, undefined, { store: repos.config }
      );
      await retrying.initializeWorkflows(integrationConfig);
      void retrying.handle(dm('om_retry', '/retry'), integrationConfig);
      await vi.waitFor(async () =>
        expect((await repos.tasks.listBySession(sessionId)).length).toBeGreaterThan(before));
      const latest = (await repos.tasks.listBySession(sessionId)).at(-1)!;
      // 新任务用的是原始用户请求，而不是注入过身份的 agentPrompt。
      expect(latest.id).not.toBe(originalTaskId);
      expect(latest.prompt).toBe('把回归跑一遍');
      // 新进度卡是新的一张，旧卡既不被改写、其 mapping 也不被重试覆盖。
      await vi.waitFor(() => expect(retryService.send).toHaveBeenCalledWith(
        expect.objectContaining({ taskName: '把回归跑一遍' })));
      for (const [input] of retryService.update.mock.calls) {
        expect((input as any).messageId).not.toBe(oldCardMessageId);
      }
      await vi.waitFor(async () => {
        const rows = await repos.channelMappings.list('lark-card:cli_test');
        const preserved = rows.find(row => row.id === oldMapping.id);
        // 旧收据原样保留：还指着旧卡、旧 runtime task。
        expect(JSON.parse(String(preserved?.extra)).card_message_id).toBe(oldCardMessageId);
        expect(JSON.parse(String(preserved?.extra)).runtime_task_id).toBe(originalTaskId);
        // 重试写的是另一条 mapping，卡片也是另一张。
        const fresh = rows.find(row => row.id !== oldMapping.id);
        expect(fresh).toBeDefined();
        const freshExtra = JSON.parse(String(fresh?.extra));
        expect(freshExtra.card_message_id).toBe('om_retry_card_1');
        expect(freshExtra.runtime_task_id).toBe(latest.id);
      });
    } finally {
      // 活着的 runtime 必须先停，否则断言失败时会在 driver 仍持有会话的情况下关库。
      await runtime.shutdown().catch(() => undefined);
      repos.close();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('retires a real migrated SQLite topic, then /new creates one fresh session without replaying the old prompt', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dutydeck-lark-legacy-'));
    const database = join(workspace, 'legacy.db');
    const tmuxDirectory = join(workspace, 'tmux');
    const tmuxSocket = join(tmuxDirectory, 'socket');
    await mkdir(tmuxDirectory); await chmod(tmuxDirectory, 0o700);
    let runtime: DutydeckRuntime | undefined;
    let repos: ReturnType<typeof createRepositories> | undefined;
    try {
      const legacy = createRepositories(database);
      const time = '2026-09-15T00:00:00.000Z';
      await legacy.sessions.save({
        id: 'ses_legacy_topic', agentId: 'codex', state: 'completed', cwd: workspace, protocol: 'pty-cli',
        permissionMode: 'full-trust', source: 'lark', sourceId: 'cli_test:ou_user_a:p2p', runId: 'run_legacy_topic',
        createdAt: time, updatedAt: time
      });
      await legacy.tasks.save({ id: 'task_legacy_topic', sessionId: 'ses_legacy_topic', prompt: '旧 prompt 不得重发', status: 'completed',
        executionContext: { agentPrompt: '旧 prompt 不得重发' }, createdAt: time, updatedAt: time });
      legacy.execution.upgradeLegacy(); legacy.close();
      execFileSync('tmux', ['-S', tmuxSocket, 'new-session', '-d', '-s', 'unrelated', 'sleep', '60']);
      await expect(runDatabaseRetireLegacy({ database, hostname: hostname(), uid: process.getuid!(), tmuxSocket }))
        .resolves.toMatchObject({ retired: 1, blocked: 0 });

      repos = createRepositories(database, { mode: 'runtime', upgrade: 'never' });
      let emitEvent!: (event: import('@dutydeck/shared').NormalizedDriverEvent) => void;
      const driver: AgentDriver = {
        start: vi.fn(async () => {}),
        send: vi.fn(async () => { emitEvent({ type: 'text', data: { text: '新结果' } }); emitEvent({ type: 'completed', data: { stopReason: 'end_turn' } }); }),
        interrupt: vi.fn(async () => {}), resume: vi.fn(async () => {}), stop: vi.fn(async () => {})
      };
      runtime = new DutydeckRuntime(repos, {
        probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }),
        driverFactory: (_agent, _protocol, emit) => { emitEvent = emit; return driver; }
      });
      await runtime.initialize([agentFor(workspace)]);
      const integrationConfig = { ...config, workspace };
      await repos.config.set(larkBotsConfigKey, JSON.stringify([integrationConfig]));
      const service = trackedCardService('om_legacy');
      const coordinator = new LarkMessageCoordinator(runtime as any, service as any, silentLog(), Math.random, 'ou_bot',
        undefined, repos.channelMappings, undefined, undefined, undefined, { store: repos.config });
      await coordinator.initializeWorkflows(integrationConfig);
      await coordinator.handle(dm('om_new_legacy_real', '/new'), integrationConfig);
      await vi.waitFor(() => expect(service.send).toHaveBeenCalledWith(expect.objectContaining({ taskName: '/new 已受理' })));
      await coordinator.handle(dm('om_new_goal_real', '执行新目标'), integrationConfig);
      await vi.waitFor(() => expect(service.send).toHaveBeenCalledWith(expect.objectContaining({ taskName: '执行新目标' })));
      await vi.waitFor(async () => {
        const current = (await repos!.sessions.list()).find(item => item.id !== 'ses_legacy_topic');
        expect(current && (await repos!.tasks.listBySession(current.id)).at(-1)?.status).toBe('completed');
      }, { timeout: 5_000 });
      expect(driver.send).toHaveBeenCalledOnce();
      const sessions = await repos.sessions.list();
      const oldSession = sessions.find(item => item.id === 'ses_legacy_topic')!;
      const newSession = sessions.find(item => item.id !== oldSession.id)!;
      expect(oldSession).toMatchObject({ state: 'stopped', archivedAt: expect.any(String), error: expect.stringContaining('原上下文未自动恢复') });
      expect(newSession.id).not.toBe(oldSession.id);
      expect(driver.send).toHaveBeenCalledOnce();
      expect(JSON.stringify(driver.send.mock.calls)).not.toContain('旧 prompt 不得重发');
      expect(service.send).toHaveBeenCalledWith(expect.objectContaining({ markdown: expect.stringContaining('升级后创建的新上下文') }));
      expect((await repos.tasks.listBySession(oldSession.id))[0]?.prompt).toBe('旧 prompt 不得重发');
    } finally {
      await runtime?.shutdown().catch(() => undefined);
      try { repos?.close(); } catch {}
      try { execFileSync('tmux', ['-S', tmuxSocket, 'kill-server'], { stdio: 'ignore' }); } catch {}
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
