import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepositories } from '@dutydeck/storage';
import type { AgentConfig, ChannelMappingRepository, PolicyAction, Session, TaskRecord } from '@dutydeck/shared';
import { larkBotsConfigKey, type StoredLarkConfig } from './config.js';
import { LarkMessageCoordinator } from './coordinator.js';
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
    subscribe: vi.fn(() => vi.fn())
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
      externalId: sourceId, sessionId: 'ses_2', extra: JSON.stringify({ baseConfigKey: larkSessionConfigKey(h.config) })
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
      sessionId: 'ses_started', extra: JSON.stringify({ baseConfigKey: larkSessionConfigKey(config) })
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
    releaseStart();
    await reset;
    await vi.waitFor(() => expect(h.runtime.stop).toHaveBeenCalledWith('ses_1'));
    expect(h.runtime.send).not.toHaveBeenCalled();
  });
});
