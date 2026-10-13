import { describe, expect, it, vi } from 'vitest';
import type { PublicTaskRecord, Session, TaskRequestV1 } from '@dutydeck/shared';
import { PluginHookBus, type HookRegistration } from './hooks.js';
import { createTriggerDispatcher, PLUGIN_TRIGGER_SOURCE, PluginRuntimeHooks, sessionHookContext, triggerResultText } from './integration.js';

const session = { id: 's1', cwd: '/repo', source: 'lark', sourceId: 'cli_a:oc_b:group' } as Session;
const handler = (event: HookRegistration['event'], output: Record<string, unknown> | (() => never)): HookRegistration =>
  ({ kind: 'handler', plugin: 'p', scope: 'global', event, timeout: 1_000, handler: typeof output === 'function' ? output : () => output });

describe('PluginRuntimeHooks', () => {
  it('passes everything through when no hook is registered', async () => {
    const hooks = new PluginRuntimeHooks(new PluginHookBus([]));
    const prepared = { agentPrompt: 'p', skillDeliveries: [] };
    expect(await hooks.beforeRun(session, prepared)).toBe(prepared);
    await expect(hooks.taskReceived(session, { prompt: 'p', actor: { kind: 'user' } } as unknown as TaskRequestV1)).resolves.toBeUndefined();
    expect(await hooks.notify({}, 'ci_notice', {})).toBe(true);
  });

  it('task.received deny rejects the task with the hook reason', async () => {
    const hooks = new PluginRuntimeHooks(new PluginHookBus([handler('task.received', { decision: 'deny', reason: '值班时间外' })]));
    await expect(hooks.taskReceived(session, { prompt: 'p', actor: { kind: 'user' } } as unknown as TaskRequestV1)).rejects.toMatchObject({ code: 'PLUGIN_HOOK_DENIED', message: '值班时间外', statusCode: 403 });
  });

  it('task.beforeRun rewrites the frozen prompt and its parts', async () => {
    const hooks = new PluginRuntimeHooks(new PluginHookBus([handler('task.beforeRun', { updatedPrompt: 'new prompt', additionalContext: 'oncall: alice' })]));
    const prepared = await hooks.beforeRun(session, { agentPrompt: 'old', skillDeliveries: [], promptParts: [{ kind: 'user_request', trustScope: 'user', content: 'old' }] });
    expect(prepared.agentPrompt).toBe('new prompt\n\noncall: alice');
    expect(prepared.promptParts?.map(part => part.content).join('')).toBe(prepared.agentPrompt);
    expect(prepared.promptDiagnostics?.fallbackReason).toBeUndefined();
  });

  it('maps permission and notify decisions', async () => {
    const hooks = new PluginRuntimeHooks(new PluginHookBus([handler('permission.request', { decision: 'ask' }), handler('notify', { decision: 'deny' })]));
    expect(await hooks.reviewPermission(session, { id: 'x', title: 'Write' } as never)).toBeUndefined();
    expect(await hooks.notify({}, 'ci_notice', {})).toBe(false);
    expect(await new PluginRuntimeHooks(new PluginHookBus([handler('permission.request', { decision: 'allow' })])).reviewPermission(session, { id: 'x' } as never)).toBe('allow');
  });

  it('derives bot and chat for lark and trigger sessions only', () => {
    expect(sessionHookContext(session)).toEqual({ sessionId: 's1', cwd: '/repo', botAppId: 'cli_a', chatId: 'oc_b' });
    expect(sessionHookContext({ ...session, source: 'web', sourceId: 'x:y' })).toEqual({ sessionId: 's1', cwd: '/repo' });
  });
});

describe('trigger delivery', () => {
  const runtime = () => ({
    listSessions: vi.fn(async () => [] as Session[]),
    start: vi.fn(async () => ({ id: 'new-session' }) as Session),
    dispatch: vi.fn(async () => ({ id: 'task-1' }) as PublicTaskRecord)
  });
  const request = { plugin: 'hello', triggerId: 'ping', target: { botAppId: 'cli_a', chatId: 'oc_b', session: 'new' as const }, prompt: 'wrapped', key: 'hello/ping:abc' };

  it('opens a trigger session in the bot workspace and dispatches as the installation owner', async () => {
    const fake = runtime();
    const deliver = createTriggerDispatcher({ runtime: fake, readBot: async () => ({ appId: 'cli_a', workspace: '/repo', defaultAgentId: 'codex', permissionMode: 'full-trust' }), fallbackAgentId: () => 'claude' });
    expect(await deliver(request)).toEqual({ sessionId: 'new-session', taskId: 'task-1' });
    expect(fake.start).toHaveBeenCalledWith({ agentId: 'codex', cwd: '/repo', source: PLUGIN_TRIGGER_SOURCE, sourceId: 'cli_a:oc_b:plugin:hello:ping' });
    expect(fake.dispatch).toHaveBeenCalledWith('new-session', 'wrapped', 'queue', 'wrapped', undefined, 'installation_owner', 'plugin-trigger:hello/ping:abc');
  });

  it('reuses the latest live trigger session and fails for unknown bots', async () => {
    const fake = runtime();
    fake.listSessions.mockResolvedValue([
      { id: 'old', source: PLUGIN_TRIGGER_SOURCE, sourceId: 'cli_a:oc_b:plugin:hello:ping', state: 'idle', updatedAt: '2026-01-01' },
      { id: 'newer', source: PLUGIN_TRIGGER_SOURCE, sourceId: 'cli_a:oc_b:plugin:hello:ping', state: 'idle', updatedAt: '2026-02-01' },
      { id: 'human', source: 'lark', sourceId: 'cli_a:oc_b:group', state: 'idle', updatedAt: '2026-03-01' }
    ] as Session[]);
    const deliver = createTriggerDispatcher({ runtime: fake, readBot: async appId => appId === 'cli_a' ? { appId } : undefined, fallbackAgentId: () => 'claude' });
    expect(await deliver({ ...request, target: { ...request.target, session: 'reuse' } })).toEqual({ sessionId: 'newer', taskId: 'task-1' });
    expect(fake.start).not.toHaveBeenCalled();
    await expect(deliver({ ...request, target: { ...request.target, botAppId: 'cli_x' } })).rejects.toThrow('cli_x');
  });

  it('formats the result text for the target chat', () => {
    const task = { id: 'task-1', status: 'completed' } as PublicTaskRecord;
    expect(triggerResultText({ sourceId: 'cli_a:oc_b:plugin:hello:ping' }, task, ' pong ')).toEqual({ appId: 'cli_a', chatId: 'oc_b', text: '【插件 hello · 触发器 ping】\npong', idempotencyKey: expect.stringMatching(/^plugin_[0-9a-f]{40}$/) });
    expect(triggerResultText({ sourceId: 'cli_a:oc_b:group' }, task, 'x')).toBeUndefined();
    expect(triggerResultText({ sourceId: 'cli_a:oc_b:plugin:hello:ping' }, { ...task, status: 'failed' } as PublicTaskRecord, undefined)?.text).toContain('任务失败');
  });
});
