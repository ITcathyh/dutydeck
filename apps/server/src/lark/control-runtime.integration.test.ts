import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepositories } from '@dutydeck/storage';
import { DutydeckRuntime } from '@dutydeck/runtime';
import { PtyCliDriver } from '@dutydeck/pty-driver';
import { PtyBackend } from '@dutydeck/session-backends';
import type { AgentConfig } from '@dutydeck/shared';
import { LarkMessageCoordinator } from './coordinator.js';
import type { StoredLarkConfig } from './config.js';
import { buildLarkCard } from './service.js';

const until = async (check: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 600; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('condition not reached');
};
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(options: { physical?: boolean } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'dutydeck-lark-control-'));
  const path = join(cwd, 'state.db');
  const script = join(cwd, 'cli.mjs');
  if (options.physical) await writeFile(script, `
    process.stdin.resume();
    process.stdin.on('data', () => process.stdout.write('\\x1b[2J\\x1b[HWORKING\\n'));
    process.on('SIGINT', () => setTimeout(() => process.stdout.write('\\x1b[2J\\x1b[HREADY\\n'), 50));
  `);
  let closed = false;
  const repos = createRepositories(path, { newDatabaseAuthority: 'ledger_v1' });
  let feed!: (data: string) => void, exit!: (code: number) => void;
  let submissions = 0, interrupts = 0, stopped = false;
  const agent: AgentConfig = { id: 'control-fixture', name: 'Fixture', command: options.physical ? process.execPath : 'unused', args: [], protocol: 'pty-cli', cwd, env: {}, permissionMode: 'full-trust', timeout: 60, capabilities: { pause: false, resume: true }, builtin: false };
  const runtime = new DutydeckRuntime(repos, {
    driverIdleTimeoutMs: 0,
    probe: () => ({ protocol: 'pty-cli', available: true, pause: false, resume: true }),
    driverFactory: (config, _protocol, onEvent, onExit, sessionId) => new PtyCliDriver({ agent: config,
      adapter: { id: 'fixture', capabilities: {}, buildArgs: () => options.physical ? [script] : [], writeInput: backend => { submissions++; if (options.physical) backend.write('work\n'); else feed('\x1b[2J\x1b[HWORKING'); }, readyPattern: /READY/ },
      backend: options.physical ? new PtyBackend() : { kind: 'pty', spawn() {}, write() {}, resize() {}, kill() { stopped = true; exit(0); }, interrupt() { interrupts++; }, onData(cb) { feed = cb; }, onExit(cb) { exit = cb; } }, sessionId, onEvent, onExit })
  });
  await runtime.initialize([agent]);
  const session = await runtime.start({ agentId: agent.id, source: 'lark', sourceId: 'app:oc:thread:root' });
  cleanups.push(async () => { if (!closed) { await runtime.shutdown(); repos.close(); } await rm(cwd, { recursive: true, force: true }); });
  const first = await runtime.dispatch(session.id, 'long operation', 'queue', 'long operation', undefined, 'ou_alice');
  await until(() => submissions === 1);
  const queued = await runtime.dispatch(session.id, 'followup', 'queue', 'followup', undefined, 'ou_alice');
  const action = async (kind: 'cancel' | 'interrupt') => {
    const updates: string[] = [];
    const task: any = { id: 'om_task', turn: 1, state: kind === 'cancel' ? 'queued' : 'running',
      config: { appId: 'app', listening: true }, event: { chatId: 'oc', chatType: 'group', senderOpenId: 'ou_alice' },
      sessionId: session.id, runtimeTaskId: kind === 'cancel' ? queued.id : first.id,
      requestUpdate: async (state: string) => { updates.push(state); } };
    const context: any = { tasks: new Map([['om_task', task]]), workflowOptions: {}, runtime,
      isOperatorAllowed: async () => true, isInterruptOperatorAllowed: async () => true,
      foreignActionConfirmations: new Map(), log: { info() {}, warn() {} }, pushTaskError() {} };
    const result = await LarkMessageCoordinator.prototype.handleAction.call(context, { action: kind, task_id: 'om_task', turn: '1' }, 'ou_alice');
    return { task, updates, result };
  };
  return { runtime, repos, path, agent, session, first, queued, action, close: async () => { await runtime.shutdown(); repos.close(); closed = true; }, feed: (data: string) => feed(data), submissions: () => submissions, interrupts: () => interrupts, stopped: () => stopped };
}

describe('Feishu controls with real Runtime, SQLite and PTY driver', () => {
  it('passes the named operator through queued cancellation and permits retry of that cancelled request', async () => {
    const h = await fixture();
    await h.action('cancel');
    await until(async () => (await h.runtime.getTasks(h.session.id)).at(-1)?.status === 'cancelled');
    const tasks = await h.runtime.getTasks(h.session.id);
    expect((LarkMessageCoordinator.prototype as any).pickRetryableRuntimeTask(tasks)?.id).toBe(h.queued.id);
    expect(h.interrupts()).toBe(0);
    expect(h.submissions()).toBe(1);
  });
  it('keeps interruption pending until a prompt confirms cancellation, then advances the queue', async () => {
    const h = await fixture();
    const action = await h.action('interrupt');
    await until(() => h.interrupts() === 1);
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(action.updates).not.toContain('interrupted');
    expect((await h.runtime.getTasks(h.session.id)).map(task => task.status)).toEqual(['running', 'queued']);
    h.feed('\x1b[2J\x1b[HREADY');
    await until(() => h.submissions() === 2);
    expect((await h.runtime.getTasks(h.session.id))[0]?.status).toBe('interrupted');
  });
  it('confirms Ctrl-C through a real child PTY and starts the next queued task', async () => {
    const h = await fixture({ physical: true });
    // The real child must have installed its signal handler before Ctrl-C.
    await until(async () => (await h.runtime.getEvents(h.session.id)).some(event => event.type === 'raw_terminal' && JSON.stringify(event.data).includes('WORKING')));
    await h.runtime.interrupt(h.session.id, h.first.id, 'ou_alice');
    await until(() => h.submissions() === 2);
    expect((await h.runtime.getTasks(h.session.id)).map(task => task.status)).toEqual(['interrupted', 'running']);
  });
  it('keeps unsafe resources blocked after restart while the named owner can cancel only unsubmitted queued input', async () => {
    const h = await fixture();
    await h.close();
    const repos = createRepositories(h.path, { newDatabaseAuthority: 'ledger_v1' });
    const factory = vi.fn(() => { throw new Error('unknown execution must not be replayed'); });
    const runtime = new DutydeckRuntime(repos, { driverIdleTimeoutMs: 0, driverFactory: factory,
      probe: () => ({ protocol: 'pty-cli', available: true, pause: false, resume: true }) });
    cleanups.push(async () => { await runtime.shutdown(); repos.close(); });
    await runtime.initialize([h.agent]);
    const blockers = (await runtime.getTaskRecovery(h.session.id, h.queued.id)).blockers.map(item => item.code);
    expect(blockers).toEqual(expect.arrayContaining(['DRIVER_RESOURCE_UNSAFE', 'DRIVER_STOP_BLOCKED']));
    expect(factory).not.toHaveBeenCalled();
    const config: StoredLarkConfig = { appId: 'app', appSecret: 'fixture', workspace: h.agent.cwd!, defaultAgentId: h.agent.id,
      fullTrustConfirmed: true, listening: true, preInjectPrompt: '', structuredAskCards: false, groupCardMention: false,
      groupToolsEnabled: false, groupToolsAllowSend: false, pushIntervalMs: 60_000, hideTraceOnComplete: false,
      allowedUsers: [{ openId: 'ou_alice', name: 'Alice' }], allowedEmails: [], allowedBots: [], peerBotsAllowed: false,
      highRiskAllowedUsers: [], highRiskAllowedEmails: [], highRiskPattern: 'danger', riskControlMode: 'off' };
    await repos.channelMappings.save({ id: 'mapping', channel: 'lark-card:app', externalId: 'om_queued', sessionId: h.session.id,
      createdAt: new Date().toISOString(), extra: JSON.stringify({ app_id: 'app', chat_id: 'oc', chat_type: 'group', sender_open_id: 'ou_alice',
        card_message_id: 'om_card', runtime_task_id: h.queued.id, task_name: 'followup', prompt: 'followup', state: 'queued',
        started_at: Date.now() - 60_000, turn: 1, recovery_read_only: true }) });
    const service = { update: vi.fn(async (_input: any) => ({ messageId: 'om_card' })), send: vi.fn(async () => ({ messageId: 'om_result' })),
      reply: vi.fn(async () => ({ messageId: 'om_result' })) };
    const coordinator = new LarkMessageCoordinator(runtime, service as any, { info() {}, warn() {}, error() {} }, Math.random,
      'ou_bot', undefined, repos.channelMappings);
    cleanups.push(async () => { coordinator.stop(); });
    await coordinator.reconcile(config);
    const card = service.update.mock.calls.at(-1)![0] as any;
    expect(card).toMatchObject({ state: 'queued', statusLabel: '排队受阻', readOnly: false });
    expect(card.markdown).toContain('上次停止执行进程未成功');
    expect(card.markdown).toContain('/cancel');
    // 没有入站记录与持久化认领时转不了新会话：不渲染按钮，正文也不提。
    expect(card.capabilities).not.toHaveProperty('canRelaunch');
    expect(card.markdown).not.toContain('在新会话中');
    expect(card.markdown).toContain('管理员可以用 `dutydeck recovery` 命令核对');
    expect(JSON.stringify(buildLarkCard(card))).toContain('排队等待');
    const status = await (coordinator as any).describeChatStatus(config, h.session.id);
    expect(status).toContain('需要核对');
    expect(status).toContain('排队受阻');
    const click = { action: 'cancel', task_id: 'om_queued', turn: '1' };
    expect((await coordinator.handleAction(click, 'ou_other', { messageId: 'om_card', chatId: 'oc' }))?.type).toBe('warning');
    expect((await coordinator.handleAction(click, 'ou_alice', { messageId: 'om_card', chatId: 'wrong_chat' }))?.type).toBe('warning');
    expect((await runtime.getTasks(h.session.id)).at(-1)?.status).toBe('queued');
    expect(await coordinator.handleAction(click, 'ou_alice', { messageId: 'om_card', chatId: 'oc' })).toEqual({ type: 'success', content: '正在取消排队任务' });
    await until(async () => (await runtime.getTasks(h.session.id)).at(-1)?.status === 'cancelled');
    expect((await runtime.getTasks(h.session.id))[0]?.status).toBe('reconcile_required');
    expect(repos.execution.getSessionResourceBlockers(h.session.id).map(item => item.code)).toEqual(expect.arrayContaining(['DRIVER_RESOURCE_UNSAFE', 'DRIVER_STOP_BLOCKED']));
    expect(factory).not.toHaveBeenCalled();
    await expect(runtime.stop(h.session.id, { kind: 'channel', appId: 'app', id: 'ou_alice' })).rejects.toMatchObject({ code: 'SESSION_RESOURCE_BLOCKED' });
    expect((await runtime.getTasks(h.session.id))[0]?.status).toBe('reconcile_required');
    await expect(runtime.cancelQueued(h.session.id, h.first.id, 'ou_alice')).rejects.toBeDefined();
  });
  it('rejects an unnamed stop before touching the process or queued work', async () => {
    const h = await fixture();
    await expect(h.runtime.stop(h.session.id)).rejects.toMatchObject({ code: 'ACTOR_REQUIRED' });
    expect(h.stopped()).toBe(false);
    await expect(h.runtime.stop(h.session.id, { kind: 'channel', appId: 'another-app', id: 'ou_alice' })).rejects.toMatchObject({ code: 'TASK_ACTOR_CONFLICT' });
    expect(h.stopped()).toBe(false);
    expect((await h.runtime.getTasks(h.session.id)).map(task => task.status)).toEqual(['running', 'queued']);
  });

  it('exposes QUEUE_START_CHECK_FAILED when queue list fails, describes recovery without unqualified Web advice, and cancels queued work safely under persistent listing failure', async () => {
    const h = await fixture();
    // Persistent listing failure: drainQueue hits it and latches queueBlocked.
    // The failure stays active through cancellation to verify cancelQueued projection resilience.
    vi.spyOn(h.repos.tasks, 'listQueued').mockImplementation(async () => {
      throw new Error('synthetic persistent queue listing failure');
    });
    // Interrupt the first turn so the runtime settles Attempt 1 and tries to drain the queue.
    await h.runtime.interrupt(h.session.id, h.first.id, 'ou_alice');
    h.feed('\x1b[2J\x1b[HREADY');
    await until(async () => (await h.runtime.getTasks(h.session.id))[0]?.status === 'interrupted');
    await until(async () => {
      const recovery = await h.runtime.getTaskRecovery(h.session.id, h.queued.id).catch(() => undefined);
      return Boolean(recovery?.blockers.some(b => b.code === 'QUEUE_START_CHECK_FAILED'));
    });
    const recovery = await h.runtime.getTaskRecovery(h.session.id, h.queued.id);
    expect(recovery.blockers.map(b => b.code)).toContain('QUEUE_START_CHECK_FAILED');

    const { describeLarkTaskRecovery } = await import('./task-recovery.js');
    const described = await describeLarkTaskRecovery(h.runtime, h.session.id, h.queued.id, 'queued');
    expect(described.label).toBe('排队受阻');
    expect(described.markdown).toContain('任务启动检查未通过');
    expect(described.markdown).not.toContain('可在 Dutydeck Web 查看记录');
    expect(described.markdown).toContain('/cancel');

    // Cancelling the queued task succeeds and persists cancelled even while listQueued continues failing
    const cancelled = await h.runtime.cancelQueued(h.session.id, h.queued.id, 'ou_alice');
    expect(cancelled.status).toBe('cancelled');
    expect((await h.runtime.getTasks(h.session.id)).find(t => t.id === h.queued.id)?.status).toBe('cancelled');
    expect((await h.runtime.getTasks(h.session.id)).find(t => t.id === h.first.id)?.status).toBe('interrupted');
  });

  it('preserves all blocker reasons when QUEUE_START_CHECK_FAILED coexists with resource blockers and never emits dead web navigation', async () => {
    const { describeLarkTaskRecovery } = await import('./task-recovery.js');
    const mockRuntime = {
      getTaskRecovery: async () => ({
        status: 'queued',
        blockers: [{ code: 'DRIVER_RESOURCE_UNSAFE' }, { code: 'QUEUE_START_CHECK_FAILED' }]
      })
    };
    const recovery = await describeLarkTaskRecovery(mockRuntime as any, 's1', 't1', 'queued');
    expect(recovery.label).toBe('排队受阻');
    expect(recovery.markdown).toContain('原执行进程尚未确认安全停止');
    expect(recovery.markdown).toContain('任务启动检查未通过');
    expect(recovery.markdown).not.toContain('Dutydeck Web');
  });
});
