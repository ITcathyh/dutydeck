import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepositories } from '@dutydeck/storage';
import { RuntimeError } from '@dutydeck/shared';
import type { AgentConfig, AgentEvent, ChannelMappingRepository, PolicyAction, Session, TaskRecord } from '@dutydeck/shared';
import { larkBotsConfigKey, type StoredLarkConfig } from './config.js';
import { LarkMessageCoordinator, type PersistedLarkCardTask } from './coordinator.js';
import { LarkTaskInbox } from './task-inbox.js';
import { LarkGroupManager } from './group-management.js';
import { explicitFinalContext, sendExplicitFinal } from './explicit-final.js';
import { larkCardChannel } from './coordinator-core.js';
import type { LarkMessageEvent } from './listener.js';
import { larkSessionConfigKey, larkSourceId } from './session-resolver.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const baseConfig = (workspace: string, patch: Partial<StoredLarkConfig> = {}): StoredLarkConfig => ({
  appId: 'cli_new_session', appSecret: 'secret', workspace, defaultAgentId: 'codex',
  defaultModel: 'gpt-default', defaultReasoningEffort: 'medium',
  fullTrustConfirmed: true, listening: true, preInjectPrompt: '',
  groupToolsEnabled: false, groupToolsAllowSend: false,
  pushIntervalMs: 1_000, hideTraceOnComplete: false,
  allowedUsers: [], allowedEmails: [], allowedBots: [], peerBotsAllowed: false,
  highRiskAllowedUsers: [], highRiskAllowedEmails: [], highRiskPattern: 'rm\\b', riskControlMode: 'off',
  ...patch
});

const agent = (id = 'codex'): AgentConfig => ({
  id, name: id === 'codex' ? 'Codex' : 'Riff', command: process.execPath, args: [], protocol: 'pty-cli',
  cwd: '/tmp', env: {}, permissionMode: 'full-trust', timeout: 10,
  capabilities: { pause: false, resume: true }, builtin: false
});

const dm = (messageId: string, text: string): LarkMessageEvent => ({
  messageId, chatId: 'ou_alice', chatType: 'p2p', messageType: 'text',
  content: JSON.stringify({ text }), senderOpenId: 'ou_alice', senderType: 'user', mentions: []
});

const groupMessage = (messageId: string, text: string): LarkMessageEvent => ({
  messageId, chatId: 'oc_managed', chatType: 'group', threadId: 'omt_topic', rootId: 'om_root',
  messageType: 'text', content: JSON.stringify({ text: `@_user_1 ${text}` }),
  senderOpenId: 'ou_alice', senderType: 'user',
  mentions: [{ key: '@_user_1', name: 'Dutydeck', openId: 'ou_bot', mentionedType: 'bot' }]
});

function persistentRuntime(options: {
  agents?: AgentConfig[];
  startGate?: Promise<void>;
  initialSessions?: Session[];
} = {}) {
  const sessions = [...(options.initialSessions ?? [])];
  const tasks = new Map<string, TaskRecord[]>();
  let counter = sessions.length;
  const runtime = {
    start: vi.fn(async (input: any) => {
      if (options.startGate) await options.startGate;
      const number = ++counter;
      const session: Session = {
        id: `ses_${number}`, agentId: input.agentId, state: 'idle', cwd: input.cwd ?? '/tmp',
        model: input.model, reasoningEffort: input.reasoningEffort,
        permissionMode: input.permissionMode, protocol: 'pty-cli', source: input.source, sourceId: input.sourceId,
        runId: `run_${number}`, createdAt: new Date(1_700_000_000_000 + number).toISOString(),
        updatedAt: new Date(1_700_000_000_000 + number).toISOString()
      };
      sessions.push(session);
      return { ...session };
    }),
    listAgents: vi.fn(async () => options.agents ?? [agent()]),
    listSessions: vi.fn(async () => sessions.map(session => ({ ...session }))),
    getSession: vi.fn(async (id: string) => {
      const session = sessions.find(item => item.id === id);
      return session ? { ...session } : undefined;
    }),
    stop: vi.fn(async (id: string) => {
      const session = sessions.find(item => item.id === id);
      if (session) session.state = 'stopped';
    }),
    send: vi.fn(async () => {}),
    interrupt: vi.fn(async () => {}),
    cancelQueued: vi.fn(async () => {}),
    getTasks: vi.fn(async (id: string) => (tasks.get(id) ?? []).map(task => ({ ...task }))),
    subscribe: vi.fn((_sessionId: string, _callback: (event: AgentEvent) => void) => vi.fn())
  };
  return { runtime, sessions };
}

function cardService() {
  let card = 0;
  const create = async () => ({ messageId: `om_card_${++card}` });
  return {
    addReaction: vi.fn(async () => ({ reactionId: 'reaction-1' })),
    deleteReaction: vi.fn(async () => {}),
    send: vi.fn(create), reply: vi.fn(create), update: vi.fn(async (input: any) => ({ messageId: input.messageId })),
    getUserEmails: vi.fn(async () => []),
    listChatMembers: vi.fn(async () => ({ items: [{ memberId: 'ou_alice' }], hasMore: false })),
    listChatMessages: vi.fn(async () => ({ items: [], hasMore: false })),
    getMessage: vi.fn(async (id: string) => ({
      messageId: id, chatId: 'ou_alice', messageType: 'text', rawContent: JSON.stringify({ text: 'quoted' }),
      sender: { type: 'user' }, mentions: []
    })),
    getMessageItems: vi.fn(async () => [])
  };
}

const silentLog = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

async function harness(options: {
  config?: StoredLarkConfig;
  runtime?: ReturnType<typeof persistentRuntime>['runtime'];
  mappings?: ChannelMappingRepository;
  groupManager?: unknown;
  executionPolicy?: unknown;
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dutydeck-lark-new-session-'));
  const defaults = join(directory, 'defaults');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(defaults));
  const config = options.config ?? baseConfig(defaults);
  const repos = createRepositories(join(directory, 'state.db'));
  await repos.config.set(larkBotsConfigKey, JSON.stringify([config]));
  const ownedRuntime = options.runtime ? undefined : persistentRuntime();
  const runtime = options.runtime ?? ownedRuntime!.runtime;
  const service = cardService();
  const mappings = options.mappings ?? repos.channelMappings;
  const createCoordinator = () => new LarkMessageCoordinator(
    runtime as any, service as any, silentLog(), Math.random, 'ou_bot', undefined,
    mappings, async () => 'group', options.executionPolicy as any, options.groupManager as any, { store: repos.config }
  );
  cleanups.push(async () => { repos.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, config, repos, runtime, service, mappings, createCoordinator };
}

const sentPrompt = (runtime: { send: ReturnType<typeof vi.fn> }, index: number) => runtime.send.mock.calls[index]?.[1];

describe('Lark /new first-turn launch options', () => {
  it('passes exact overrides, persists the binding, and reuses it after follow-up and coordinator rebuild', async () => {
    const h = await harness();
    const override = join(h.directory, 'override');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(override));
    const canonical = await realpath(override);
    const coordinator = h.createCoordinator();

    await coordinator.handle(dm('om_old', 'old task'), h.config);
    await vi.waitFor(() => expect(h.runtime.send).toHaveBeenCalledOnce());
    await coordinator.handle(dm('om_override', `/new --cwd ${override} --model gpt-5.5 --effort high -- run checks`), h.config);
    await vi.waitFor(() => expect(h.runtime.send).toHaveBeenCalledTimes(2));

    expect(h.runtime.stop).toHaveBeenCalledWith('ses_1', { kind: 'channel', id: 'ou_alice', appId: 'cli_new_session' });
    expect(h.runtime.start).toHaveBeenNthCalledWith(2, {
      agentId: 'codex', cwd: canonical, model: 'gpt-5.5', reasoningEffort: 'high',
      permissionMode: 'full-trust', source: 'lark', sourceId: 'cli_new_session:ou_alice:p2p'
    });
    expect(sentPrompt(h.runtime, 1)).toBe('run checks');
    const sourceId = larkSourceId(h.config, 'ou_alice', 'p2p', 'p2p');
    expect(await h.repos.channelMappings.get(`lark-launch:${h.config.appId}`, sourceId)).toMatchObject({
      id: `lark-launch:${sourceId}`, channel: `lark-launch:${h.config.appId}`,
      externalId: sourceId, sessionId: 'ses_2', extra: JSON.stringify({ baseConfigKey: larkSessionConfigKey(h.config), explicitAgent: true })
    });

    await coordinator.handle(dm('om_followup', 'same session'), h.config);
    await vi.waitFor(() => expect(h.runtime.send).toHaveBeenCalledTimes(3));
    expect(h.runtime.start).toHaveBeenCalledTimes(2);
    expect(h.runtime.send.mock.calls[2]?.[0]).toBe('ses_2');

    await h.createCoordinator().handle(dm('om_rebuilt', 'after rebuild'), h.config);
    await vi.waitFor(() => expect(h.runtime.send).toHaveBeenCalledTimes(4));
    expect(h.runtime.start).toHaveBeenCalledTimes(2);
    expect(h.runtime.send.mock.calls[3]?.[0]).toBe('ses_2');
    await h.createCoordinator().handle(dm('om_status_override', '/status'), h.config);
    expect(h.service.send).toHaveBeenCalledWith(expect.objectContaining({
      markdown: expect.stringContaining('**模型**：gpt-5.5\n\n**推理强度**：high')
    }));
    expect(h.runtime.start).toHaveBeenCalledTimes(2);
    expect(h.runtime.send).toHaveBeenCalledTimes(4);
  });

  it('links a retired worktree to the existing protected preview and cleanup UI', async () => {
    const h = await harness(); h.config.webBaseUrl = 'https://dutydeck.example';
    await h.repos.config.set(larkBotsConfigKey, JSON.stringify([h.config]));
    (h.runtime as any).getWorkspace = vi.fn(async () => ({ mode: 'worktree', path: '/tmp/owned-worktree' }));
    const coordinator = h.createCoordinator();
    await coordinator.handle(dm('om_start_cleanup', 'task'), h.config);
    await vi.waitFor(() => expect(h.runtime.send).toHaveBeenCalledOnce());
    await coordinator.handle(dm('om_end_cleanup', '/new'), h.config);
    await vi.waitFor(() => expect(h.service.send).toHaveBeenCalledWith(expect.objectContaining({ taskName: '/new 已受理', markdown: expect.stringContaining('[检查并清理 worktree](https://dutydeck.example/sessions/ses_1?panel=workspace)') })));
    expect(h.runtime.stop).toHaveBeenCalledOnce();
    expect(JSON.stringify(h.service.send.mock.calls)).toContain('工作目录');
  });

  it('keeps legacy /new goal semantics and makes bare /new return the next turn to bot defaults', async () => {
    const h = await harness();
    const coordinator = h.createCoordinator();

    await coordinator.handle(dm('om_legacy', '/new legacy goal with spaces'), h.config);
    await vi.waitFor(() => expect(h.runtime.send).toHaveBeenCalledOnce());
    expect(h.runtime.start).toHaveBeenCalledWith(expect.objectContaining({
      cwd: h.config.workspace, model: 'gpt-default', reasoningEffort: 'medium'
    }));
    expect(sentPrompt(h.runtime, 0)).toBe('legacy goal with spaces');

    await coordinator.handle(dm('om_bare', '/new'), h.config);
    await vi.waitFor(() => expect(h.service.send).toHaveBeenCalledWith(expect.objectContaining({ taskName: '/new 已受理' })));
    expect(h.runtime.stop).toHaveBeenCalledWith('ses_1', { kind: 'channel', id: 'ou_alice', appId: 'cli_new_session' });
    await coordinator.handle(dm('om_default', 'use defaults'), h.config);
    await vi.waitFor(() => expect(h.runtime.send).toHaveBeenCalledTimes(2));
    expect(h.runtime.start).toHaveBeenNthCalledWith(2, expect.objectContaining({
      cwd: h.config.workspace, model: 'gpt-default', reasoningEffort: 'medium'
    }));
    expect(sentPrompt(h.runtime, 1)).toBe('use defaults');
  });

  it('opens a /new --handoff session whose first prompt carries the recorded handoff, without asking a model', async () => {
    const h = await harness();
    const git = (...args: string[]) => execFileSync('git', args, { cwd: h.config.workspace, stdio: 'pipe' });
    git('init', '-q', '-b', 'main');
    await writeFile(join(h.config.workspace, 'app.ts'), 'v1');
    git('add', '.');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'init');
    await writeFile(join(h.config.workspace, 'app.ts'), 'v2');
    const head = git('rev-parse', '--short', 'HEAD').toString().trim();
    const coordinator = h.createCoordinator();
    await coordinator.handle(dm('om_old', 'old task'), h.config);
    await vi.waitFor(() => expect(h.runtime.send).toHaveBeenCalledOnce());

    // The first failure is older than the three quoted turns; its source must remain locatable.
    const at = (index: number) => new Date(1_700_000_100_000 + index * 1_000).toISOString();
    const tasks = [1, 2, 3, 4].map(index => ({ id: `task_${index}`, sessionId: 'ses_1', prompt: `第 ${index} 轮任务`, status: index === 1 || index === 3 ? 'failed' : 'completed', currentAttemptId: `attempt_${index}`, createdAt: at(index * 10), updatedAt: at(index * 10 + 5) }));
    let sequence = 0;
    const events: AgentEvent[] = tasks.flatMap(task => {
      const index = Number(task.id.slice(-1));
      const item = (type: AgentEvent['type'], data: unknown): AgentEvent => ({ id: `evt_${++sequence}`, sessionId: 'ses_1', sequence, type, data, timestamp: at(index * 10 + 1) });
      return [
        item('text', { role: 'user', taskId: task.id, text: task.prompt }),
        index === 3 ? item('error', { message: '第 3 轮的失败原因' }) : item('text', { role: 'assistant', text: `第 ${index} 轮结论` }),
        item('task', { task: { ...task } })
      ];
    });
    h.runtime.getTasks.mockImplementation(async (id: string) => id === 'ses_1' ? tasks.map(task => ({ ...task })) : []);
    Object.assign(h.runtime, { getRecentEvents: vi.fn(async () => events) });

    const native = await (coordinator as any).newSessionHandoff(h.config, dm('native', ''), 'ses_1', tasks, '', true);
    expect(native).toContain(`分支 main · HEAD ${head}\n   M app.ts`);
    expect(native).not.toContain('第 2 轮结论');
    expect((h.runtime as any).getRecentEvents).not.toHaveBeenCalled();

    await coordinator.handle(dm('om_handoff', '/new --handoff 先补 登录重试 的测试'), h.config);
    await vi.waitFor(() => expect(h.runtime.send).toHaveBeenCalledTimes(2));
    expect(h.runtime.stop).toHaveBeenCalledWith('ses_1', { kind: 'channel', id: 'ou_alice', appId: 'cli_new_session' });
    expect(h.runtime.send.mock.calls[1]?.[0]).toBe('ses_2');
    expect(sentPrompt(h.runtime, 1)).toBe('交接到新会话');
    const firstTurn = String(h.runtime.send.mock.calls[1]?.[2]);
    expect(firstTurn).toContain('[Dutydeck 会话交接]');
    expect(firstTurn).toContain('旧会话：ses_1');
    expect(firstTurn).toContain('原目标：第 1 轮任务');
    expect(firstTurn).toContain('task=task_1 attempt=attempt_1 status=failed · 第 1 轮任务');
    expect(firstTurn).not.toContain('第 1 轮结论');
    expect(firstTurn).toContain('来源 task=task_4 attempt=attempt_4');
    expect(firstTurn).toContain('history show <taskId>');
    expect((h.runtime as any).getRecentEvents).toHaveBeenCalledWith('ses_1', 1500);
    expect(firstTurn).toContain('1. 第 2 轮任务（已完成）\n   第 2 轮结论');
    expect(firstTurn).toContain('2. 第 3 轮任务（失败）\n   第 3 轮的失败原因');
    expect(firstTurn).toContain('3. 第 4 轮任务（已完成）\n   第 4 轮结论');
    expect(firstTurn).toContain(`分支 main · HEAD ${head}\n   M app.ts`);
    expect(firstTurn).toContain('用户备注：先补 登录重试 的测试');
    expect(firstTurn).toContain('等待用户的下一条指令');
    // The old session got no extra turn: the handoff is assembled from records only.
    expect(h.runtime.send.mock.calls.filter(call => call[0] === 'ses_1')).toHaveLength(1);

    // With a task, the task is the first request; outside a git repository the snapshot is just absent.
    const other = await harness();
    const second = other.createCoordinator();
    await second.handle(dm('om_other_old', 'old task'), other.config);
    await vi.waitFor(() => expect(other.runtime.send).toHaveBeenCalledOnce());
    await second.handle(dm('om_other_handoff', '/new --handoff 备注 x -- 继续修复'), other.config);
    await vi.waitFor(() => expect(other.runtime.send).toHaveBeenCalledTimes(2));
    expect(sentPrompt(other.runtime, 1)).toBe('继续修复');
    const withTask = String(other.runtime.send.mock.calls[1]?.[2]);
    expect(withTask).toContain('[Dutydeck 会话交接]');
    expect(withTask).toContain('不是 git 仓库或读取失败');
    expect(withTask).toContain('用户备注：备注 x');
    expect(withTask.endsWith('[交接结束]\n\n继续修复')).toBe(true);
  });

  it('quotes a delivered explicit final instead of the turn\'s bare acknowledgement text', async () => {
    const h = await harness();
    const coordinator = h.createCoordinator();
    await coordinator.handle(dm('om_old', 'old task'), h.config);
    await vi.waitFor(() => expect(h.runtime.send).toHaveBeenCalledOnce());

    const at = (index: number) => new Date(1_700_000_100_000 + index * 1_000).toISOString();
    const tasks = [
      { id: 'task_final', sessionId: 'ses_1', prompt: '写周报', status: 'completed', currentAttemptId: 'att_final', createdAt: at(10), updatedAt: at(15) },
      { id: 'task_plain', sessionId: 'ses_1', prompt: '查日志', status: 'completed', currentAttemptId: 'att_plain', createdAt: at(20), updatedAt: at(25) }
    ];
    let sequence = 0;
    const item = (type: AgentEvent['type'], data: unknown): AgentEvent => ({ id: `evt_${++sequence}`, sessionId: 'ses_1', sequence, type, data, timestamp: at(sequence) });
    const events: AgentEvent[] = [
      item('text', { role: 'user', taskId: 'task_final', text: '写周报' }), item('text', { role: 'assistant', text: '已发送' }), item('task', { task: tasks[0] }),
      item('text', { role: 'user', taskId: 'task_plain', text: '查日志' }), item('text', { role: 'assistant', text: '日志里没有报错' }), item('task', { task: tasks[1] })
    ];
    h.runtime.getTasks.mockImplementation(async (id: string) => id === 'ses_1' ? tasks.map(task => ({ ...task })) : []);
    Object.assign(h.runtime, { getRecentEvents: vi.fn(async () => events) });
    // Both turns have a card; only the first delivered its answer through group send --final.
    for (const [task, messageId] of [[tasks[0]!, 'om_final_card'], [tasks[1]!, 'om_plain_card']] as const) {
      const saved: PersistedLarkCardTask = { app_id: h.config.appId, chat_id: 'ou_alice', chat_type: 'p2p', runtime_task_id: task.id,
        task_name: task.prompt, prompt: task.prompt, state: 'completed', started_at: Date.parse(task.createdAt), turn: 1,
        card_message_id: messageId, final_message_id: `${messageId}_result`, final_delivery_state: 'delivered' };
      await h.repos.channelMappings.save({ id: `card_${task.id}`, channel: larkCardChannel(h.config.appId), externalId: messageId, sessionId: 'ses_1', extra: JSON.stringify(saved), createdAt: task.createdAt });
      if (task.id === 'task_final') {
        const row = (await h.repos.channelMappings.list(larkCardChannel(h.config.appId))).find(mapping => mapping.externalId === messageId)!;
        await sendExplicitFinal(h.repos.config, h.service as any, explicitFinalContext(row, saved, task.currentAttemptId)!, '周报结论：三项都已完成，下周跟进发布。');
      }
    }

    await coordinator.handle(dm('om_handoff', '/new --handoff'), h.config);
    await vi.waitFor(() => expect(h.runtime.send).toHaveBeenCalledTimes(2));
    const firstTurn = String(h.runtime.send.mock.calls[1]?.[2]);
    expect(firstTurn).toContain('1. 写周报（已完成）\n   周报结论：三项都已完成，下周跟进发布。');
    expect(firstTurn).not.toContain('已发送');
    expect(firstTurn).toContain('2. 查日志（已完成）\n   日志里没有报错');
  });

  it('rejects malformed and adapter-unsupported options before stopping the old session', async () => {
    const runtimeState = persistentRuntime({ agents: [agent('riff')] });
    const directory = await mkdtemp(join(tmpdir(), 'dutydeck-lark-new-config-'));
    const config = baseConfig(directory, { defaultAgentId: 'riff', defaultModel: undefined, defaultReasoningEffort: undefined });
    const h = await harness({ config, runtime: runtimeState.runtime });
    const coordinator = h.createCoordinator();
    await coordinator.handle(dm('om_old', 'keep this session'), config);
    await vi.waitFor(() => expect(h.runtime.send).toHaveBeenCalledOnce());

    await coordinator.handle(dm('om_bad_syntax', '/new --unknown value -- must not run'), config);
    await coordinator.handle(dm('om_bad_model', '/new --model custom-model -- must not run'), config);
    await vi.waitFor(() => expect(h.service.send.mock.calls
      .filter(([input]: any[]) => input.state === 'failed')).toHaveLength(2));

    expect(h.runtime.stop).not.toHaveBeenCalled();
    expect(h.runtime.start).toHaveBeenCalledOnce();
    expect(h.runtime.send).toHaveBeenCalledOnce();
    const failures = h.service.send.mock.calls.map(([input]: any[]) => input)
      .filter((input: any) => input.state === 'failed');
    expect(failures).toHaveLength(2);
    expect(failures.map((input: any) => input.markdown).join('\n')).toContain('首轮参数格式不正确');
    expect(failures.map((input: any) => input.markdown).join('\n')).toContain('不支持指定模型');
    await rm(directory, { recursive: true, force: true });
  });

  it('updates an override binding through default B, then stops B and starts changed default C after rebuild', async () => {
    const h = await harness();
    const override = join(h.directory, 'override-a');
    const changedDefault = join(h.directory, 'default-c');
    await import('node:fs/promises').then(({ mkdir }) => Promise.all([mkdir(override), mkdir(changedDefault)]));
    const coordinator = h.createCoordinator();

    await coordinator.handle(dm('om_a', `/new --cwd ${override} --model gpt-a --effort high -- A`), h.config);
    await vi.waitFor(() => expect(h.runtime.send).toHaveBeenCalledOnce());
    await coordinator.handle(dm('om_reset', '/new'), h.config);
    await vi.waitFor(() => expect(h.runtime.stop).toHaveBeenCalledWith('ses_1', { kind: 'channel', id: 'ou_alice', appId: 'cli_new_session' }));
    await coordinator.handle(dm('om_b', 'B'), h.config);
    await vi.waitFor(() => expect(h.runtime.send).toHaveBeenCalledTimes(2));
    const sourceId = larkSourceId(h.config, 'ou_alice', 'p2p', 'p2p');
    expect((await h.repos.channelMappings.get(`lark-launch:${h.config.appId}`, sourceId))?.sessionId).toBe('ses_2');

    const configC = { ...h.config, workspace: changedDefault, defaultModel: 'gpt-c', defaultReasoningEffort: 'low' };
    await h.repos.config.set(larkBotsConfigKey, JSON.stringify([configC]));
    await h.createCoordinator().handle(dm('om_c', 'C'), configC);
    await vi.waitFor(() => expect(h.runtime.send).toHaveBeenCalledTimes(3));
    expect(h.runtime.stop).toHaveBeenCalledWith('ses_2');
    expect(h.runtime.start).toHaveBeenNthCalledWith(3, expect.objectContaining({
      cwd: changedDefault, model: 'gpt-c', reasoningEffort: 'low'
    }));
    expect(h.runtime.send.mock.calls[2]?.[0]).toBe('ses_3');
    expect((await h.repos.channelMappings.get(`lark-launch:${h.config.appId}`, sourceId))?.sessionId).toBe('ses_3');
  });

  it('requires both cwd and model grants in a managed group before retiring its session', async () => {
    const decisions = new Map<PolicyAction, boolean>();
    const authorize = vi.fn(async (_appId: string, _chatId: string, _actor: string | undefined, action: PolicyAction) => ({
      action, allowed: decisions.get(action) ?? true, code: `${action}_decision`, reason: `${action} denied`, source: 'group_policy' as const
    }));
    let effective!: StoredLarkConfig;
    const groupManager = {
      resolved: vi.fn(async () => effective), ownsTopic: vi.fn(async () => false), authorize,
      recordRun: vi.fn(async () => {})
    };
    const h = await harness({ groupManager });
    effective = { ...h.config, managedGroup: { bindingId: 'binding-1', revision: 1 } };
    const override = join(h.directory, 'managed-override');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(override));
    const coordinator = h.createCoordinator();
    await coordinator.handle(groupMessage('om_old', 'old group task'), h.config);
    await vi.waitFor(() => expect(h.runtime.send).toHaveBeenCalledOnce());

    decisions.set('run.change_cwd', false);
    await coordinator.handle(groupMessage('om_deny_cwd', `/new --cwd ${override} -- cwd denied`), h.config);
    decisions.set('run.change_cwd', true);
    decisions.set('run.change_model', false);
    await coordinator.handle(groupMessage('om_deny_model', '/new --model gpt-5.5 -- model denied'), h.config);
    await vi.waitFor(() => expect(h.service.reply.mock.calls
      .filter(([input]: any[]) => input.state === 'failed')).toHaveLength(2));
    expect(h.runtime.stop).not.toHaveBeenCalled();
    expect(h.runtime.send).toHaveBeenCalledOnce();

    decisions.set('run.change_model', true);
    await coordinator.handle(groupMessage('om_allow', `/new --cwd ${override} --model gpt-5.5 --effort high -- allowed`), h.config);
    await vi.waitFor(() => expect(h.runtime.send).toHaveBeenCalledTimes(2));
    expect(authorize.mock.calls.some((call: any[]) => call[3] === 'run.change_cwd')).toBe(true);
    expect(authorize.mock.calls.some((call: any[]) => call[3] === 'run.change_model')).toBe(true);
    expect(h.runtime.stop).toHaveBeenCalledWith('ses_1', { kind: 'channel', id: 'ou_alice', appId: 'cli_new_session' });
  });

  it('applies non-managed execution-policy gates for cwd and model before retiring the old session', async () => {
    let denied: PolicyAction | undefined;
    const authorize = vi.fn(async (boundary: 'listener' | 'session' | 'high_risk', action: PolicyAction) => ({
      action, allowed: action !== denied, code: `${action}_decision`, reason: `${action} denied`, source: 'integration' as const
    }));
    const executionPolicy = { integrationMode: 'legacy_unmanaged' as const, authorize };
    const h = await harness({ executionPolicy });
    const override = join(h.directory, 'policy-override');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(override));
    const coordinator = h.createCoordinator();
    await coordinator.handle(dm('om_policy_old', 'keep old session'), h.config);
    await vi.waitFor(() => expect(h.runtime.send).toHaveBeenCalledOnce());

    denied = 'run.change_cwd';
    await coordinator.handle(dm('om_policy_cwd', `/new --cwd ${override} -- denied cwd`), h.config);
    denied = 'run.change_model';
    await coordinator.handle(dm('om_policy_model', '/new --model gpt-5.5 -- denied model'), h.config);
    await vi.waitFor(() => expect(h.service.send.mock.calls
      .filter(([input]: any[]) => input.state === 'failed')).toHaveLength(2));

    expect(authorize).toHaveBeenCalledWith('session', 'run.change_cwd');
    expect(authorize).toHaveBeenCalledWith('session', 'run.change_model');
    expect(h.runtime.stop).not.toHaveBeenCalled();
    expect(h.runtime.start).toHaveBeenCalledOnce();
    expect(h.runtime.send).toHaveBeenCalledOnce();
  });

  it('recovers a received override by reusing a started session and repairing its missing launch binding', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dutydeck-lark-started-unbound-'));
    const override = join(directory, 'override');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(override));
    const config = baseConfig(directory);
    const sourceId = larkSourceId(config, 'ou_alice', 'p2p', 'p2p');
    const started: Session = {
      id: 'ses_started', agentId: 'codex', state: 'idle', cwd: override, model: 'gpt-5.5', reasoningEffort: 'high',
      permissionMode: 'full-trust', protocol: 'pty-cli', source: 'lark', sourceId,
      runId: 'run_started', createdAt: '2026-09-12T00:00:00.000Z', updatedAt: '2026-09-12T00:00:00.000Z'
    };
    const runtimeState = persistentRuntime({ initialSessions: [started] });
    const h = await harness({ config, runtime: runtimeState.runtime });
    const event = dm('om_recover_unbound', '/new --model ignored -- original event is not reparsed');
    await h.repos.config.set(`lark.inbox.${config.appId}.${event.messageId}`, JSON.stringify({
      appId: config.appId, event, boot: 'old-boot', state: 'received',
      request: { prompt: 'recover goal', scopeId: 'p2p', resources: [], launchOptions: { cwd: override, model: 'gpt-5.5', reasoningEffort: 'high' } }
    }));

    await h.createCoordinator().handle(event, config, true);
    await vi.waitFor(() => expect(h.runtime.send).toHaveBeenCalledOnce());
    expect(h.runtime.start).not.toHaveBeenCalled();
    expect(h.runtime.stop).not.toHaveBeenCalled();
    expect(h.runtime.send.mock.calls[0]?.[0]).toBe('ses_started');
    expect(sentPrompt(h.runtime, 0)).toBe('recover goal');
    expect(await h.repos.channelMappings.get(`lark-launch:${config.appId}`, sourceId)).toMatchObject({
      sessionId: 'ses_started', extra: JSON.stringify({ baseConfigKey: larkSessionConfigKey(config), explicitAgent: true })
    });
    await rm(directory, { recursive: true, force: true });
  });

  it('stops a newly started session and never sends when saving its launch binding fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dutydeck-lark-save-failure-'));
    const config = baseConfig(directory);
    const repos = createRepositories(join(directory, 'state.db'));
    const mappings: ChannelMappingRepository = {
      get: repos.channelMappings.get.bind(repos.channelMappings),
      list: repos.channelMappings.list.bind(repos.channelMappings),
      save: vi.fn(async mapping => {
        if (mapping.channel.startsWith('lark-launch:')) throw new Error('synthetic mapping failure');
        await repos.channelMappings.save(mapping);
      })
    };
    const runtimeState = persistentRuntime();
    const h = await harness({ config, runtime: runtimeState.runtime, mappings });
    await h.createCoordinator().handle(dm('om_save_failure', '/new --model gpt-5.5 -- goal'), config);
    await vi.waitFor(() => expect(h.runtime.stop).toHaveBeenCalledWith('ses_1'));

    expect(h.runtime.start).toHaveBeenCalledOnce();
    expect(h.runtime.send).not.toHaveBeenCalled();
    expect(runtimeState.sessions[0]?.state).toBe('stopped');
    expect(h.service.send).toHaveBeenCalledWith(expect.objectContaining({
      state: 'failed', markdown: expect.stringContaining('synthetic mapping failure')
    }));
    repos.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('does not send a recovered old prompt when /new arrives while its session start is pending', async () => {
    let releaseStart!: () => void;
    const startGate = new Promise<void>(resolve => { releaseStart = resolve; });
    const runtimeState = persistentRuntime({ startGate });
    const h = await harness({ runtime: runtimeState.runtime });
    const override = join(h.directory, 'pending-override');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(override));
    const recoveredEvent = dm('om_recover_pending', '/new --model ignored -- original event is not reparsed');
    await h.repos.config.set(`lark.inbox.${h.config.appId}.${recoveredEvent.messageId}`, JSON.stringify({
      appId: h.config.appId, event: recoveredEvent, boot: 'old-boot', state: 'received',
      request: { prompt: 'stale recovered goal', scopeId: 'p2p', resources: [], launchOptions: { cwd: override, model: 'gpt-5.5', reasoningEffort: 'high' } }
    }));
    const coordinator = h.createCoordinator();
    await coordinator.handle(recoveredEvent, h.config, true);
    await vi.waitFor(() => expect(h.runtime.start).toHaveBeenCalledOnce());

    const reset = coordinator.handle(dm('om_new_during_start', '/new'), h.config);
    // First list is the recovering turn's lookup. The new command lists once to
    // locate the bound session and once more after incrementing the group epoch.
    await vi.waitFor(() => expect(h.runtime.listSessions.mock.calls.length).toBeGreaterThanOrEqual(3));
    const reopened = createRepositories(join(h.directory, 'state.db'));
    try {
      expect(await new LarkTaskInbox(reopened.config).recoverable(h.config.appId)).toEqual([]);
    } finally { reopened.close(); }
    releaseStart();
    await reset;
    await vi.waitFor(() => expect(h.runtime.stop).toHaveBeenCalledWith('ses_1'));
    expect(h.runtime.send).not.toHaveBeenCalled();
    await h.createCoordinator().handle(recoveredEvent, h.config, true);
    expect(h.runtime.start).toHaveBeenCalledOnce();
  });
});


describe('managed first-turn recovery authorization', () => {
  const scenarios = [
    { name: 'cwd', action: 'run.change_cwd', flags: (directory: string) => `--cwd ${directory}`, options: (directory: string) => ({ cwd: directory }) },
    { name: 'agent', action: 'run.change_agent', flags: () => '--agent riff', options: () => ({ agentId: 'riff' }) },
    { name: 'model', action: 'run.change_model', flags: () => '--model gpt-5.5', options: () => ({ model: 'gpt-5.5' }) },
    { name: 'effort', action: 'run.change_model', flags: () => '--effort high', options: () => ({ reasoningEffort: 'high' }) }
  ] as const;
  const settled = async (coordinator: LarkMessageCoordinator) => {
    await Promise.all([...(coordinator as any).groups.values()].map((group: any) => group.tail));
  };
  const managedHarness = async () => {
    const h = await harness();
    const agents = [agent(), agent('riff')];
    for (const item of agents) await h.repos.agents.save(item);
    h.runtime.listAgents.mockResolvedValue(agents);
    const manager = new LarkGroupManager(h.repos, { client: config => ({
      getBotInfo: async () => ({ appName: config.appId, openId: 'ou_bot' }),
      checkApplicationIdentity: async () => ({ verified: true, reportedAppId: config.appId, tenantKey: 'test-tenant' }),
      listChats: async () => ({ items: [{ chatId: 'oc_managed', name: 'Managed', external: false }], hasMore: false }),
      listChatMembers: async () => ({ items: [{ memberId: 'ou_alice', openId: 'ou_alice', name: 'Alice', memberType: 'user' }], hasMore: false, securityLimited: false }),
      getUserEmails: async () => []
    }) as any });
    await manager.sync(h.config.appId);
    const group = await manager.save(h.config.appId, 'oc_managed', { expectedRevision: 0, patch: {} });
    const actor = (await manager.members(h.config.appId, 'oc_managed')).members[0]!;
    const admin = await h.repos.roleAssignments.create({ id: 'test_admin', channelBotId: group.channelBotId!, groupBindingId: group.binding!.id,
      principalId: actor.principalId, role: 'admin', operateScope: 'none' });
    const authorization = vi.spyOn(manager, 'authorize');
    const dispatch = vi.fn(async (sessionId: string, prompt: string, _mode: string, _agentPrompt: string, _risk: unknown, actorId?: string) => {
      const commit = await manager.prepareTurn(sessionId, actorId); await commit?.();
      return { id: 'task_managed', sessionId, prompt, status: 'queued', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    });
    Object.assign(h.runtime, { dispatch });
    const coordinate = () => {
      const coordinator = new LarkMessageCoordinator(h.runtime as any, h.service as any, silentLog(), Math.random, 'ou_bot', undefined,
        h.repos.channelMappings, async () => 'group', undefined, manager, { store: h.repos.config });
      cleanups.push(async () => coordinator.stop());
      return coordinator;
    };
    const revoke = async () => {
      await h.repos.roleAssignments.update(admin.id, { expectedRevision: admin.revision, state: 'revoked' });
      expect(await manager.authorize(h.config.appId, 'oc_managed', 'ou_alice', 'task.create')).toMatchObject({ allowed: true });
    };
    return { ...h, manager, authorization, dispatch, coordinate, revoke };
  };

  it.each(scenarios)('rechecks a persisted $name override after its managed admin grant is revoked', async scenario => {
    const h = await managedHarness();
    expect(await h.manager.authorize(h.config.appId, 'oc_managed', 'ou_alice', scenario.action)).toMatchObject({ allowed: true, source: 'admin' });
    h.runtime.start.mockRejectedValueOnce(new RuntimeError('RUNTIME_SHUTTING_DOWN', 'shutdown before session creation', 503));
    const event = groupMessage(`om_restore_${scenario.name}`, `/new ${scenario.flags(h.config.workspace!)} -- saved goal`);
    const first = h.coordinate();
    await first.handle(event, h.config); await settled(first);
    expect(h.runtime.start).toHaveBeenCalledOnce();
    expect(h.runtime.send).not.toHaveBeenCalled();
    expect(h.dispatch).not.toHaveBeenCalled();
    const inbox = new LarkTaskInbox(h.repos.config);
    expect(await inbox.lookup(h.config.appId, event.messageId)).toMatchObject({ state: 'received',
      request: { prompt: 'saved goal', launchOptions: scenario.options(h.config.workspace!) } });
    expect((await inbox.lookup(h.config.appId, event.messageId))?.sessionId).toBeUndefined();
    first.stop();
    await h.revoke();
    expect(await h.manager.authorize(h.config.appId, 'oc_managed', 'ou_alice', scenario.action)).toMatchObject({ allowed: false, code: 'admin_required' });
    h.authorization.mockClear(); h.runtime.start.mockClear();
    const recovered = h.coordinate();
    await recovered.initializeWorkflows(h.config); await settled(recovered);
    expect(h.authorization.mock.calls.map(call => call[3])).toContain(scenario.action);
    expect(h.runtime.start).not.toHaveBeenCalled();
    expect(h.runtime.send).not.toHaveBeenCalled();
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(await inbox.lookup(h.config.appId, event.messageId)).toMatchObject({ state: 'failed' });
    expect(h.service.reply).toHaveBeenCalledWith(expect.objectContaining({ state: 'failed', markdown: expect.stringContaining('This action requires owner/admin authority') }));
  });

  it.each(['started', 'bound'] as const)('reuses a %s session without rechecking its launch options', async stage => {
    const h = await managedHarness();
    const event = groupMessage('om_existing_restore', '/new --model gpt-5.5 -- saved goal');
    if (stage === 'started') {
      const start = h.runtime.start.getMockImplementation()!;
      h.runtime.start.mockImplementationOnce(async input => {
        await start(input);
        throw new RuntimeError('RUNTIME_SHUTTING_DOWN', 'shutdown after session creation', 503);
      });
    } else h.service.reply.mockRejectedValueOnce(new Error('temporary card failure'));
    const first = h.coordinate();
    await first.handle(event, h.config); await settled(first);
    expect(h.runtime.start).toHaveBeenCalledOnce();
    expect(h.runtime.send).not.toHaveBeenCalled();
    expect(h.dispatch).not.toHaveBeenCalled();
    const inbox = new LarkTaskInbox(h.repos.config);
    expect(await inbox.lookup(h.config.appId, event.messageId)).toMatchObject({ state: 'received', request: { launchOptions: { model: 'gpt-5.5' } } });
    expect((await inbox.lookup(h.config.appId, event.messageId))?.sessionId).toBe(stage === 'started' ? undefined : 'ses_1');
    first.stop(); await h.revoke(); h.authorization.mockClear();
    const recovered = h.coordinate();
    await recovered.initializeWorkflows(h.config); await settled(recovered);
    expect(h.runtime.start).toHaveBeenCalledOnce();
    expect(h.dispatch).toHaveBeenCalledOnce();
    expect(h.dispatch.mock.calls[0]?.[0]).toBe('ses_1');
    expect(h.authorization.mock.calls.map(call => call[3])).not.toContain('run.change_model');
    expect(await inbox.lookup(h.config.appId, event.messageId)).toMatchObject({ state: 'accepted', sessionId: 'ses_1' });
    // An accepted queued task is reattached, without resubmitting or changing its launch options.
    Object.assign(h.runtime, { getRecentEvents: vi.fn(async () => []) });
    h.runtime.getTasks.mockResolvedValue([{ id: 'task_managed', sessionId: 'ses_1', prompt: 'saved goal', status: 'queued',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }]);
    recovered.stop(); h.dispatch.mockClear(); h.authorization.mockClear(); h.runtime.subscribe.mockClear();
    const accepted = h.coordinate();
    await accepted.initializeWorkflows(h.config); await settled(accepted);
    expect(h.runtime.subscribe).toHaveBeenCalledOnce();
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.authorization.mock.calls.map(call => call[3])).not.toContain('run.change_model');
  });
});

describe('durable pre-dispatch rejection', () => {
  it('keeps lifecycle shutdown pending for recovery', async () => {
    const h = await harness();
    h.runtime.start.mockRejectedValueOnce(new RuntimeError('RUNTIME_SHUTTING_DOWN', 'shutting down', 503));
    const event = dm('om_shutdown_recovery', 'resume after shutdown');
    await h.createCoordinator().handle(event, h.config);
    await vi.waitFor(() => expect(h.runtime.start).toHaveBeenCalledOnce());
    const recovered = h.createCoordinator();
    await recovered.initializeWorkflows(h.config);
    await vi.waitFor(() => expect(h.runtime.send).toHaveBeenCalledWith(expect.any(String), 'resume after shutdown', expect.any(String)));
    expect(h.runtime.start).toHaveBeenCalledTimes(2);
  });

  it('does not dispatch after /new during the auto-verification fingerprint read', async () => {
    const state = persistentRuntime();
    const runtime = Object.assign(state.runtime, { dispatch: vi.fn(async () => ({ id: 'task_a', status: 'queued' })) });
    const h = await harness({ runtime });
    const coordinator = h.createCoordinator();
    let release!: () => void;
    const gate = new Promise<undefined>(resolve => { release = () => resolve(undefined); });
    const fingerprint = vi.spyOn(coordinator as any, 'sharedWorkspaceFingerprint').mockImplementation(() => gate);
    try {
      await coordinator.handle(dm('om_fingerprint', 'must not dispatch'), h.config);
      await vi.waitFor(() => expect(fingerprint).toHaveBeenCalledOnce());
      await coordinator.handle(dm('om_reset_fingerprint', '/new'), h.config);
      expect(await new LarkTaskInbox(h.repos.config).recoverable(h.config.appId)).toEqual([]);
      release();
      await vi.waitFor(() => expect(h.service.send).toHaveBeenCalledWith(expect.objectContaining({ cardKind: 'result', state: 'interrupted' })));
      expect(runtime.dispatch).not.toHaveBeenCalled();
      await h.createCoordinator().initializeWorkflows(h.config);
      expect(runtime.dispatch).not.toHaveBeenCalled();
    } finally { release(); }
  });

  it.each(['allowlist', 'email', 'startup', 'policy'] as const)('does not replay a %s rejection after permissions recover', async reason => {
    let denied = reason === 'policy';
    const executionPolicy = { integrationMode: 'legacy_unmanaged', authorize: async (_boundary: string, action: PolicyAction) => ({
      action, allowed: !denied || _boundary !== 'session', code: 'denied', reason: 'revoked', source: 'integration'
    }) };
    const h = await harness({ executionPolicy });
    const config = { ...h.config,
      ...(reason === 'allowlist' ? { allowedUsers: [{ openId: 'ou_other', name: 'Other' }] } : {}),
      ...(reason === 'email' ? { allowedEmails: ['alice@example.com'] } : {})
    };
    await h.repos.config.set(larkBotsConfigKey, JSON.stringify([config]));
    if (reason === 'startup') h.runtime.start.mockRejectedValueOnce(new Error('startup rejected'));
    const event = dm(`om_reject_${reason}`, 'must not replay');
    await h.createCoordinator().handle(event, config);
    await vi.waitFor(() => expect(h.service.send).toHaveBeenCalledWith(expect.objectContaining({ state: 'failed' })));
    const reopened = createRepositories(join(h.directory, 'state.db'));
    try {
      expect(await new LarkTaskInbox(reopened.config).recoverable(config.appId)).toEqual([]);
    } finally { reopened.close(); }
    denied = false;
    await h.repos.config.set(larkBotsConfigKey, JSON.stringify([h.config]));
    await h.createCoordinator().handle(event, h.config, true);
    expect(h.runtime.send).not.toHaveBeenCalled();
  });


});


describe('dispatch terminal event isolation', () => {
  it.each([false, true])('freezes the completed turn while recovery lookup is pending (stop: %s)', async stop => {
    let receive!: (event: AgentEvent) => void;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const state = persistentRuntime();
    const task = { id: 'task_a', sessionId: 'ses_1', prompt: 'A', status: 'running', queuedAhead: 0,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    const runtime = Object.assign(state.runtime, {
      dispatch: vi.fn(async () => task),
      getTaskRecovery: vi.fn(async () => { await gate; return undefined; })
    });
    runtime.subscribe.mockImplementation((_sessionId: string, callback: (event: AgentEvent) => void) => { receive = callback; return vi.fn(); });
    const h = await harness({ runtime });
    const coordinator = h.createCoordinator();
    await coordinator.handle(dm('om_isolation', 'A'), h.config);
    await vi.waitFor(() => expect(runtime.dispatch).toHaveBeenCalledOnce());
    await vi.waitFor(async () => expect(JSON.parse((await h.repos.config.get(`lark.inbox.${h.config.appId}.om_isolation`))!).state).toBe('accepted'));
    let sequence = 0;
    const emit = (type: AgentEvent['type'], data: unknown, taskId?: string) => receive({ id: `ev_${++sequence}`, sequence,
      timestamp: new Date().toISOString(), sessionId: 'ses_1', type, data, ...(taskId ? { taskId } : {}) });
    emit('task', { task });
    emit('text', { text: 'A answer' }, 'task_a');
    emit('text', { text: 'foreign active answer' }, 'task_b');
    emit('task', { task: { ...task, status: 'completed' } });
    await vi.waitFor(() => expect(runtime.getTaskRecovery).toHaveBeenCalled());
    // Runtime can start the next task while the previous terminal delivery awaits storage.
    emit('text', { text: 'B answer after A finished' });
    emit('task', { task });
    if (stop) coordinator.stop();
    release();
    if (stop) {
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(h.service.send.mock.calls.filter(([input]: any[]) => input.cardKind === 'result')).toEqual([]);
    } else {
      await vi.waitFor(() => expect(h.service.send).toHaveBeenCalledWith(expect.objectContaining({ cardKind: 'result' })));
      const result = h.service.send.mock.calls.map(([input]: any[]) => input).find(input => input.cardKind === 'result');
      expect(JSON.stringify(result)).toContain('A answer');
      expect(JSON.stringify(result)).not.toContain('foreign active answer');
      expect(JSON.stringify(result)).not.toContain('B answer');
      coordinator.stop();
    }
  });
});

describe('handoff evidence boundaries', () => {
  it.each([
    { appId: 'other_app', chatId: 'ou_alice', chatType: 'p2p' },
    { appId: 'cli_new_session', chatId: 'oc_other', chatType: 'group' },
    { appId: 'cli_new_session', chatId: 'ou_alice', chatType: 'group' }
  ])('rejects a foreign session before reading any evidence: %j', async origin => {
    const h = await harness();
    h.runtime.getSession.mockResolvedValue({ id: 'foreign', source: 'lark', sourceId: `${origin.appId}:${origin.chatId}:${origin.chatType}`, cwd: h.config.workspace } as Session);
    const getRecentEvents = vi.fn(async () => []);
    Object.assign(h.runtime, { getRecentEvents });
    const coordinator = h.createCoordinator();
    await expect((coordinator as any).newSessionHandoff(h.config, dm('command', ''), 'foreign', [], ''))
      .rejects.toThrow('无法核实交接来源');
    expect(getRecentEvents).not.toHaveBeenCalled();
  });

  it('does not include a task whose result permission is denied', async () => {
    const h = await harness();
    const coordinator = h.createCoordinator();
    await coordinator.handle(dm('old', 'old task'), h.config);
    await vi.waitFor(() => expect(h.runtime.send).toHaveBeenCalledOnce());
    const tasks = [{ id: 'private_task', sessionId: 'ses_1', prompt: 'private task text', status: 'failed', createdAt: '2026-01-01', updatedAt: '2026-01-01' }];
    const allowed = vi.spyOn(coordinator as any, 'isTaskOperatorAllowed').mockResolvedValue(false);
    const text = await (coordinator as any).newSessionHandoff(h.config, dm('command', ''), 'ses_1', tasks, '');
    expect(allowed).toHaveBeenCalledWith(h.config, expect.anything(), tasks[0], 'task.view_result');
    expect(text).not.toContain('private_task');
    expect(text).not.toContain('private task text');
  });

  it('reuses the frozen persisted handoff on retry after coordinator rebuild and changed history', async () => {
    const h = await harness();
    const first = h.createCoordinator();
    await first.handle(dm('old', 'old task'), h.config);
    await vi.waitFor(() => expect(h.runtime.send).toHaveBeenCalledOnce());
    const task = { id: 'retry_task', sessionId: 'ses_1', prompt: 'continue', status: 'failed', currentAttemptId: 'attempt_frozen', createdAt: '2026-01-01', updatedAt: '2026-01-01' };
    const frozen = await (first as any).newSessionHandoff(h.config, dm('command', ''), 'ses_1', [task], 'frozen note');
    const material = `${frozen}\n\ncontinue`;
    const saved: PersistedLarkCardTask = { app_id: h.config.appId, chat_id: 'ou_alice', chat_type: 'p2p', runtime_task_id: task.id,
      task_name: 'continue', prompt: 'continue', retry_material_prompt: material, state: 'failed', started_at: 1, turn: 1, card_message_id: 'old_card' };
    await h.repos.channelMappings.save({ id: 'retry_mapping', channel: larkCardChannel(h.config.appId), externalId: 'old_card', sessionId: 'ses_1', extra: JSON.stringify(saved), createdAt: task.createdAt });
    h.runtime.getTasks.mockResolvedValue([task]);
    const getRecentEvents = vi.fn(async () => [{ id: 'changed', sessionId: 'ses_1', sequence: 999, timestamp: '2026-10-28', type: 'text', data: { role: 'assistant', text: 'changed result' } }]);
    Object.assign(h.runtime, { getRecentEvents });
    const rebuilt = h.createCoordinator();
    const regenerate = vi.spyOn(rebuilt as any, 'newSessionHandoff');
    await rebuilt.handle(dm('retry', '/retry'), h.config);
    await vi.waitFor(() => expect(h.runtime.send).toHaveBeenCalledTimes(2));
    expect(sentPrompt(h.runtime, 1)).toBe('continue');
    expect(h.runtime.send.mock.calls[1]?.[2]).toContain(material);
    expect(regenerate).not.toHaveBeenCalled();
    expect(h.runtime.send.mock.calls[1]?.[2]).not.toContain('changed result');
    expect(JSON.parse((await h.repos.channelMappings.get(larkCardChannel(h.config.appId), 'old_card'))!.extra!).retry_material_prompt).toBe(material);
  });
});


it('does not attribute an earlier attempt to the current one, including when the current boundary is missing', async () => {
  const h = await harness();
  const coordinator = h.createCoordinator();
  await coordinator.handle(dm('old', 'old task'), h.config);
  await vi.waitFor(() => expect(h.runtime.send).toHaveBeenCalledOnce());
  const task = { id: 'retried_task', sessionId: 'ses_1', prompt: 'check current result', status: 'completed', currentAttemptId: 'attempt_new', createdAt: '2026-01-01', updatedAt: '2026-01-01' };
  const events: AgentEvent[] = [];
  const append = (attemptId: string, type: AgentEvent['type'], data: unknown) => events.push({ id: `evt_${events.length}`, sequence: events.length + 1, sessionId: 'ses_1', taskId: task.id, attemptId, timestamp: '2026-01-01', type, data });
  append('attempt_old', 'text', { role: 'user', taskId: task.id, text: 'old input' });
  append('attempt_old', 'text', { role: 'assistant', text: 'old successful claim' });
  append('attempt_old', 'task', { task: { ...task, status: 'failed', currentAttemptId: 'attempt_old' } });
  Object.assign(h.runtime, { getRecentEvents: vi.fn(async () => events) });
  const missing = await (coordinator as any).newSessionHandoff(h.config, dm('handoff', ''), 'ses_1', [task], '');
  expect(missing).not.toContain('old successful claim');
  expect(missing).toContain('来源 task=retried_task attempt=attempt_new');
  expect(missing).toContain('事件窗口不完整或读取失败');
  append('attempt_new', 'text', { role: 'user', taskId: task.id, text: 'current input' });
  append('attempt_new', 'text', { role: 'assistant', text: 'current result' });
  append('attempt_new', 'task', { task });
  const current = await (coordinator as any).newSessionHandoff(h.config, dm('handoff', ''), 'ses_1', [task], '');
  expect(current).toContain('current result');
  expect(current).not.toContain('old successful claim');
});
