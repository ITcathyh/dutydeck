import { describe, expect, it, vi } from 'vitest';
import type { ChannelMapping, Session } from '@dutydeck/shared';
import type { StoredLarkConfig } from './config.js';
import type { LarkGroup, PersistedLarkCardTask } from './coordinator.js';
import type { LarkMessageEvent } from './listener.js';
import { findLarkThreadContinuation, larkSessionConfigKey, resolveLarkSession, takeLarkNewSessionNote } from './session-resolver.js';

const config: StoredLarkConfig = {
  appId: 'cli_test', appSecret: 'secret', workspace: '/workspace', defaultAgentId: 'codex', fullTrustConfirmed: true, listening: true,
  preInjectPrompt: '', groupToolsEnabled: false, groupToolsAllowSend: false,
  pushIntervalMs: 1_000, hideTraceOnComplete: false, allowedUsers: [], allowedEmails: [], highRiskAllowedUsers: [], highRiskAllowedEmails: [],
  highRiskPattern: 'rm\\b', riskControlMode: 'off'
};
const userSource = 'cli_test:oc_group:group:user:ou_alice';
const session = (overrides: Partial<Session> = {}): Session => ({
  id: 'ses_old', agentId: 'codex', state: 'idle', cwd: '/workspace', permissionMode: 'full-trust', protocol: 'acp',
  source: 'lark', sourceId: userSource, runId: 'run_old', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides
});
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const runtimeWith = (sessions: Session[]) => {
  const fresh = session({ id: 'ses_new', runId: 'run_new' });
  return {
    fresh,
    runtime: {
      listSessions: vi.fn(async () => sessions),
      getSession: vi.fn(async (id: string) => sessions.find(item => item.id === id)),
      getTasks: vi.fn(async () => []),
      stop: vi.fn(async (id: string) => { const item = sessions.find(entry => entry.id === id); if (item) item.state = 'stopped'; }),
      start: vi.fn(async () => fresh)
    }
  };
};

describe('resolveLarkSession 意外新建会话的首卡注记', () => {
  it.each([
    ['进程内绑定的会话 failed', () => [session({ state: 'failed' })], true, '已开新会话（原会话已异常结束）。'],
    ['重启后最近一条会话 failed', () => [session({ state: 'failed' })], false, '已开新会话（原会话已异常结束）。'],
    ['重启后最近一条会话被部署者停止', () => [session({ state: 'stopped' })], false, '已开新会话（原会话已被停止）。'],
    ['重启后旧会话还活着，但默认 Agent 已换', () => [session({ agentId: 'claude' })], false, '已开新会话（机器人配置已变更）。'],
    ['重启后旧会话的审批模式对不上', () => [session({ permissionMode: 'ask' })], false, '已开新会话（机器人配置已变更）。']
  ] as const)('%s', async (_name, sessions, bound, note) => {
    const { runtime, fresh } = runtimeWith(sessions());
    const group: LarkGroup = { tail: Promise.resolve(), ...(bound ? { sessionId: 'ses_old', sessionConfigKey: larkSessionConfigKey(config) } : {}) };
    await expect(resolveLarkSession(runtime as any, log, group, config, 'oc_group', 'group', 'user:ou_alice')).resolves.toBe(fresh);
    expect(takeLarkNewSessionNote(fresh)).toBe(note);
    // 取走即清：同一个 Session 对象不会让后续轮次再带一次。
    expect(takeLarkNewSessionNote(fresh)).toBeUndefined();
  });

  it('进程内绑定的会话因配置变更被停掉时写配置原因', async () => {
    const { runtime, fresh } = runtimeWith([session()]);
    const group: LarkGroup = { tail: Promise.resolve(), sessionId: 'ses_old', sessionConfigKey: larkSessionConfigKey({ ...config, defaultModel: 'old-model' }) };
    await expect(resolveLarkSession(runtime as any, log, group, config, 'oc_group', 'group', 'user:ou_alice')).resolves.toBe(fresh);
    expect(runtime.stop).toHaveBeenCalledWith('ses_old');
    expect(takeLarkNewSessionNote(fresh)).toBe('已开新会话（机器人配置已变更）。');
  });

  it.each([
    ['/new 结束的会话', { retiredSessionIds: new Set(['ses_old']) }, undefined],
    ['/new 带首轮参数', {}, { model: 'gpt-5.5' }],
    ['第一次在这个作用域说话', { empty: true }, undefined]
  ] as const)('%s 不写注记', async (_name, patch, launchOptions) => {
    const { runtime, fresh } = runtimeWith('empty' in patch ? [] : [session({ state: 'stopped' })]);
    const group: LarkGroup = { tail: Promise.resolve(), ...('retiredSessionIds' in patch ? { retiredSessionIds: patch.retiredSessionIds } : {}) };
    const mappings = { get: vi.fn(async () => undefined), list: vi.fn(async () => []), save: vi.fn(async () => {}), compareAndSetExtra: vi.fn() };
    await expect(resolveLarkSession(runtime as any, log, group, config, 'oc_group', 'group', 'user:ou_alice', mappings, launchOptions)).resolves.toBe(fresh);
    expect(takeLarkNewSessionNote(fresh)).toBeUndefined();
  });
});

describe('findLarkThreadContinuation', () => {
  const rootTask = (patch: Partial<PersistedLarkCardTask> = {}): PersistedLarkCardTask => ({
    app_id: 'cli_test', chat_id: 'oc_group', chat_type: 'group', sender_open_id: 'ou_alice', scope_id: 'user:ou_alice',
    task_name: '整理方案', prompt: '整理方案', state: 'completed', started_at: 1, ...patch
  });
  const cardRow = (externalId: string, extra: PersistedLarkCardTask, sessionId = 'ses_old'): ChannelMapping => ({
    id: `lark-card:cli_test:${externalId}`, channel: 'lark-card:cli_test', externalId, sessionId, extra: JSON.stringify(extra), createdAt: '2026-01-01T00:00:00.000Z'
  });
  const mappingsWith = (rows: ChannelMapping[]) => ({
    get: vi.fn(async (channel: string, externalId: string) => rows.find(row => row.channel === channel && row.externalId === externalId)),
    list: vi.fn(async (channel: string) => rows.filter(row => row.channel === channel)),
    save: vi.fn(async () => {}), compareAndSetExtra: vi.fn()
  });
  const reply = (patch: Partial<LarkMessageEvent> = {}): LarkMessageEvent => ({
    messageId: 'om_reply', chatId: 'oc_group', chatType: 'group', messageType: 'text', content: '{"text":"继续"}',
    senderOpenId: 'ou_alice', mentions: [], rootId: 'om_task', threadId: 'omt_task', ...patch
  });
  const find = (sessions: Session[], rows: ChannelMapping[], event = reply(), patch: Partial<StoredLarkConfig> = {}) =>
    findLarkThreadContinuation(runtimeWith(sessions).runtime as any, { ...config, ...patch }, event, `thread:${event.rootId}`, mappingsWith(rows));

  it('发起人在自己顶层任务的话题里回复时返回那条任务的会话', async () => {
    await expect(find([session()], [cardRow('om_task', rootTask())])).resolves.toMatchObject({ id: 'ses_old' });
  });

  it.each([
    ['别人先在话题里说话', [session()], [cardRow('om_task', rootTask())], reply({ senderOpenId: 'ou_bob' }), {}],
    ['根消息没有任务卡', [session()], [], reply(), {}],
    ['根消息本身是话题里的任务', [session()], [cardRow('om_task', rootTask({ thread_id: 'omt_other', scope_id: 'thread:om_other' }))], reply(), {}],
    ['根任务不是按发送人作用域', [session()], [cardRow('om_task', rootTask({ scope_id: 'chat:oc_group' }))], reply(), {}],
    ['话题已有自己的会话', [session(), session({ id: 'ses_thread', sourceId: 'cli_test:oc_group:group:thread:om_task' })], [cardRow('om_task', rootTask())], reply(), {}],
    ['原会话已结束', [session({ state: 'failed' })], [cardRow('om_task', rootTask())], reply(), {}],
    ['机器人换了默认 Agent', [session({ agentId: 'claude' })], [cardRow('om_task', rootTask())], reply(), {}],
    ['审批模式对不上', [session({ permissionMode: 'ask' })], [cardRow('om_task', rootTask())], reply(), {}],
    ['托管群', [session()], [cardRow('om_task', rootTask())], reply(), { managedGroup: true }],
    ['只有 root_id 的引用气泡', [session()], [cardRow('om_task', rootTask())], reply({ threadId: undefined }), {}]
  ] as const)('%s 时不续接', async (_name, sessions, rows, event, patch) => {
    await expect(find([...sessions], [...rows], event, patch)).resolves.toBeUndefined();
  });

  it('发起人续接过的话题里，别人的消息也进这个会话', async () => {
    const rows = [cardRow('om_task', rootTask()), cardRow('om_follow', rootTask({ thread_id: 'omt_task', scope_id: 'thread:om_task' }))];
    await expect(find([session()], rows, reply({ senderOpenId: 'ou_bob' }))).resolves.toMatchObject({ id: 'ses_old' });
  });
});
