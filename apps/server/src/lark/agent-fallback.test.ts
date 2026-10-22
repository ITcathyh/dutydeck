import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import { claudeApiError } from '../../../../packages/pty-driver/src/transcript/claude.js';
import { RuntimeError, type Session } from '@dutydeck/shared';
import { larkAgentUnavailableReason, larkFallbackHasActivity } from './agent-fallback.js';
import { findPersistedLarkSession, resolveLarkSession, takeLarkNewSessionNote } from './session-resolver.js';
import type { StoredLarkConfig } from './config.js';
import { LarkMessageCoordinator } from './coordinator.js';
import type { LarkGroup } from './coordinator.js';

const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach(clean => clean()); vi.restoreAllMocks(); });

function fixture() {
  const repos = createRepositories(':memory:'); cleanups.push(() => repos.close());
  const config: StoredLarkConfig = { appId: 'app', appSecret: 'fixture', defaultAgentId: 'primary', fallbackAgentId: 'spare', defaultModel: 'primary-model', defaultReasoningEffort: 'high', permissionMode: 'ask' };
  const sessions: Session[] = [];
  const runtime = {
    listAgents: vi.fn(async () => [{ id: 'primary', protocol: 'acp' }, { id: 'spare', protocol: 'acp' }]),
    listSessions: vi.fn(async () => sessions), getSession: vi.fn(async (id: string) => sessions.find(item => item.id === id)),
    start: vi.fn(async (input: any) => {
      if (input.agentId === 'primary') throw new RuntimeError('START_FAILED', 'command missing', 503);
      const session = { ...input, protocol: 'acp', id: `session-${sessions.length}`, runId: 'run', state: 'idle', cwd: '/tmp', createdAt: '2026-01-01', updatedAt: '2026-01-01' } as Session;
      sessions.push(session); return session;
    }), stop: vi.fn(async () => {})
  };
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const resolve = (group: LarkGroup = { tail: Promise.resolve() }, options?: any) => resolveLarkSession(runtime as any, log, group, config, 'chat', 'p2p', 'p2p', repos.channelMappings, options);
  return { repos, config, runtime, sessions, resolve };
}

describe('fallback session resolution', () => {
  it('switches startup failure without carrying the primary model, persists and reuses the fallback', async () => {
    const h = fixture();
    const session = await h.resolve();
    expect(session.agentId).toBe('spare');
    expect(h.runtime.start.mock.calls[1][0]).not.toHaveProperty('model');
    expect(h.runtime.start.mock.calls[1][0]).not.toHaveProperty('reasoningEffort');
    expect(takeLarkNewSessionNote(session)).toContain('command missing');
    expect((await findPersistedLarkSession(h.runtime as any, h.config, 'chat', 'p2p', 'p2p', h.repos.channelMappings))?.id).toBe(session.id);
    expect(await h.resolve()).toBe(session);
    expect(h.runtime.start).toHaveBeenCalledTimes(2);
    h.config.fallbackAgentId = undefined;
    expect(await h.resolve()).toBe(session);
    h.config.fallbackAgentId = 'another-spare';
    expect(await h.resolve()).toBe(session);
    expect(h.runtime.stop).not.toHaveBeenCalled();
  });

  it('uses the fallback directly when a cached login check confirms the primary is unavailable', async () => {
    const h = fixture();
    Object.assign(h.runtime, { getAgentAvailability: (id: string) => id === 'primary' ? { reason: 'signed out' } : undefined,
      checkAgentAvailability: vi.fn(async () => ({ reason: 'signed out' })) });
    expect((await h.resolve()).agentId).toBe('spare');
    expect(h.runtime.start).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ agentId: 'spare' }));
  });

  it('handles a removed primary and validates fallback approval support', async () => {
    const h = fixture();
    h.runtime.listAgents.mockResolvedValue([{ id: 'spare', protocol: 'pty-cli' }]);
    await expect(h.resolve()).rejects.toMatchObject({ code: 'LARK_AGENT_FALLBACK_FAILED', message: expect.stringContaining('飞书无法逐项审批') });
    expect(h.runtime.start).not.toHaveBeenCalled();
  });

  it.each([{ agentId: 'primary' }, { model: 'explicit-model' }, { reasoningEffort: 'low' }, { nativeForkSessionId: 'parent' }])('preserves an explicit launch option %j without switching', async options => {
    const h = fixture();
    await expect(h.resolve(undefined, options)).rejects.toMatchObject({ code: 'START_FAILED' });
    expect(h.runtime.start).toHaveBeenCalledTimes(1);
  });

  it('does not retry the fallback when weight routing already selected it', async () => {
    const h = fixture();
    h.config.defaultAgentWeights = [{ agentId: 'spare', weight: 100 }];
    h.runtime.start.mockRejectedValue(new RuntimeError('START_FAILED', 'spare unavailable', 503));
    await expect(h.resolve()).rejects.toThrow('spare unavailable');
    expect(h.runtime.start).toHaveBeenCalledTimes(1);
  });

  it('returns a fallback startup failure after exactly two attempts', async () => {
    const h = fixture();
    h.runtime.start.mockRejectedValue(new RuntimeError('START_FAILED', 'unavailable', 503));
    await expect(h.resolve()).rejects.toThrow('unavailable');
    expect(h.runtime.start.mock.calls.map(([input]) => input.agentId)).toEqual(['primary', 'spare']);
  });

  it('does not switch for workspace or permission errors', async () => {
    const h = fixture();
    h.runtime.start.mockRejectedValue(new RuntimeError('WORKSPACE_PREPARATION_FAILED', 'invalid cwd', 422));
    await expect(h.resolve()).rejects.toThrow('invalid cwd');
    expect(h.runtime.start).toHaveBeenCalledTimes(1);
  });
});

it.each(['USER_CANCELLED', 'PERMISSION_DENIED', 'WORKSPACE_UNAVAILABLE', 'AGENT_IDLE_TIMEOUT', 'DRIVER_RESULT_UNKNOWN'])('does not classify %s as provider unavailable', code => {
  expect(larkAgentUnavailableReason({ code, message: 'not available' })).toBeUndefined();
});

it('recognizes typed ACP quota failures and keeps terminal status and completion out of activity', () => {
  expect(larkAgentUnavailableReason({ code: 'ACP_PROVIDER_TERMINAL_ERROR', detailCode: 'usage_limit_exceeded', message: 'quota exhausted' })).toBe('quota exhausted');
  expect(larkFallbackHasActivity({ type: 'raw_terminal', data: { text: 'status screen' } } as any)).toBe(false);
  expect(larkFallbackHasActivity({ type: 'completed', data: { stopReason: 'end_turn' } } as any)).toBe(false);
  expect(larkFallbackHasActivity({ type: 'permission_request', data: {} } as any)).toBe(true);
  expect(larkFallbackHasActivity({ type: 'status', data: { state: 'program_status', programState: 'blocked', kind: 'permission' } } as any)).toBe(true);
});


it.each([503, undefined, 400, 403])('classifies the real Claude transcript mapper unknown API error at HTTP %s', apiErrorStatus => {
  const event = claudeApiError({ isApiErrorMessage: true, error: 'unknown', apiErrorStatus,
    message: { content: [{ type: 'text', text: 'API Error: upstream request failed' }] } });
  expect(event?.type).toBe('error');
  expect(Boolean(larkAgentUnavailableReason(event?.data))).toBe(apiErrorStatus === undefined || apiErrorStatus >= 500);
});


it.each(['queued', 'running', 'new-turn', 'cancelled'])('rechecks %s arriving while fallback handoff is being read', async change => {
  const h = fixture();
  const primary = { id: 'primary-session', agentId: 'primary', sourceId: 'app:chat:p2p', cwd: '/tmp' } as Session;
  const group = { tail: Promise.resolve(), sessionId: primary.id, epoch: 0 } as LarkGroup;
  const runtime = { ...h.runtime, getTasks: vi.fn(async () => [{ id: 'failed-task', status: 'failed' }]) };
  const coordinator = new LarkMessageCoordinator(runtime as any, {} as any, { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    Math.random, undefined, undefined, h.repos.channelMappings);
  const task = { id: 'request', group, config: h.config, event: { messageId: 'om_request', chatId: 'chat', chatType: 'p2p' },
    sessionId: primary.id, runtimeTaskId: 'failed-task', turn: 1, epoch: 0, state: 'failed' } as any;
  let entered!: () => void, release!: () => void;
  const reading = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(coordinator as any, 'newSessionHandoff').mockImplementation(async () => { entered(); await gate; return 'handoff'; });
  const recovering = (coordinator as any).recoverFallbackSession(task, primary, 'rate limit', false);
  await reading;
  if (change === 'new-turn') task.turn++;
  else if (change === 'cancelled') task.interruptRequested = true;
  else (coordinator as any).tasks.set('other', { group, state: change });
  release();
  expect(await recovering).toBe(false);
  expect(group.sessionId).toBe(primary.id);
  expect(group.retiredSessionIds?.has(primary.id)).not.toBe(true);
  expect(runtime.start).not.toHaveBeenCalled();
  coordinator.stop();
});

it('conservatively keeps a legacy explicit launch binding pinned to its Agent', async () => {
  const h = fixture();
  const primary = { id: 'primary-session', agentId: 'primary', sourceId: 'app:chat:p2p', cwd: '/tmp' } as Session;
  await h.repos.channelMappings.save({ id: 'binding', channel: 'lark-launch:app', externalId: primary.sourceId!, sessionId: primary.id,
    extra: JSON.stringify({ baseConfigKey: 'legacy' }), createdAt: '2026-01-01' });
  const group = { tail: Promise.resolve(), sessionId: primary.id, epoch: 0 };
  const runtime = { ...h.runtime, getTasks: vi.fn(async () => []) };
  const coordinator = new LarkMessageCoordinator(runtime as any, {} as any, { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    Math.random, undefined, undefined, h.repos.channelMappings);
  const task = { id: 'request', group, config: h.config, event: {}, turn: 1, epoch: 0 };
  expect(await (coordinator as any).recoverFallbackSession(task, primary, 'rate limit', false)).toBe(false);
  expect(runtime.getTasks).not.toHaveBeenCalled();
  expect(runtime.start).not.toHaveBeenCalled();
  coordinator.stop();
});
