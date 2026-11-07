import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepositories } from '@dutydeck/storage';
import { BACKGROUND_FOLLOWUP, type AgentEvent, type Session } from '@dutydeck/shared';
import { LarkMessageCoordinator } from './coordinator.js';
import { larkBotsConfigKey, type StoredLarkConfig } from './config.js';
import type { LarkMessageEvent } from './listener.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const at = '2026-11-07T08:00:00.000Z';
let sequence = 0;
const agentEvent = (type: AgentEvent['type'], data: unknown, taskId?: string): AgentEvent =>
  ({ id: `evt_${++sequence}`, sessionId: 'ses_bg', sequence, type, timestamp: at, data, ...(taskId ? { taskId } : {}) });
const turnAnswer = (taskId?: string) => agentEvent('text', { text: '本轮回答' }, taskId);
const followup = () => agentEvent('text', { text: '后台任务的后续回答', origin: BACKGROUND_FOLLOWUP });
const runLevelTool = () => agentEvent('tool_call', { id: 'call_run_level', name: 'Bash', status: 'completed', input: { command: 'echo run-level-step' } });

const message = (id: string): LarkMessageEvent => ({
  messageId: id, chatId: 'oc_test_group', chatType: 'group', threadId: 'omt_topic', rootId: 'om_root',
  senderOpenId: 'ou_alice', senderType: 'user', messageType: 'text', content: JSON.stringify({ text: '跑一下后台任务' }),
  mentions: [{ key: '@_user_1', name: 'Bot', openId: 'ou_bot' }]
});

async function harness(mode: 'dispatch' | 'send') {
  const directory = await mkdtemp(join(tmpdir(), 'dutydeck-background-followup-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const config: StoredLarkConfig = { appId: 'cli_test', appSecret: 'secret_test', name: 'TestBot', defaultAgentId: 'claude', workspace: directory, fullTrustConfirmed: true, riskControlMode: 'off' };
  const repos = createRepositories(join(directory, 'state.db'));
  cleanups.push(() => repos.close());
  await repos.config.set(larkBotsConfigKey, JSON.stringify([config]));
  const sessions: Session[] = [];
  const listeners = new Set<(event: AgentEvent) => void>();
  const emit = (event: AgentEvent) => { for (const listener of [...listeners]) listener(event); };
  const runtime: Record<string, unknown> = {
    start: vi.fn(async () => {
      const session: Session = { id: 'ses_bg', agentId: 'claude', state: 'idle', cwd: directory, permissionMode: 'full-trust', protocol: 'pty-cli', source: 'lark',
        sourceId: 'cli_test:oc_test_group:thread:om_root', runId: 'run_bg', createdAt: at, updatedAt: at };
      sessions.push(session);
      return session;
    }),
    listAgents: vi.fn(async () => [{ id: 'claude', name: 'Claude' }]),
    listSessions: vi.fn(async () => sessions),
    getSession: vi.fn(async (id: string) => sessions.find(session => session.id === id)),
    stop: vi.fn(async () => {}), interrupt: vi.fn(async () => {}), cancelQueued: vi.fn(async () => {}), getTasks: vi.fn(async () => []),
    subscribe: vi.fn((_id: string, listener: (event: AgentEvent) => void) => { listeners.add(listener); return () => listeners.delete(listener); }),
    send: vi.fn(async () => {
      emit(followup());
      emit(runLevelTool());
      emit(turnAnswer());
      emit(followup());
      return { id: 'task_send', status: 'completed' };
    })
  };
  if (mode === 'dispatch') runtime.dispatch = vi.fn(async () => {
    setTimeout(() => {
      const task = (status: string) => agentEvent('task', { task: { id: 'task_bg', status } }, 'task_bg');
      emit(task('running'));
      emit(followup());
      emit(runLevelTool());
      emit(turnAnswer('task_bg'));
      emit(followup());
      emit(task('completed'));
    }, 0);
    return { id: 'task_bg', sessionId: 'ses_bg', status: 'queued', queuedAhead: 0 };
  });
  let card = 0;
  const create = vi.fn(async (_input: unknown) => ({ messageId: `om_card_${++card}` }));
  const service = {
    addReaction: vi.fn(async () => ({ reactionId: 'reaction-1' })), deleteReaction: vi.fn(async () => {}),
    send: create, reply: create, update: vi.fn(async (input: { messageId: string }) => ({ messageId: input.messageId })),
    getUserEmails: vi.fn(async () => []),
    listChatMembers: vi.fn(async () => ({ items: [{ memberId: 'ou_alice' }], hasMore: false })),
    listChatMessages: vi.fn(async () => ({ items: [], hasMore: false })),
    getMessage: vi.fn(async (id: string) => ({ messageId: id, chatId: 'oc_test_group', messageType: 'text', rawContent: JSON.stringify({ text: 'quoted' }), sender: { type: 'user' }, mentions: [] })),
    getMessageItems: vi.fn(async () => [])
  };
  const coordinator = new LarkMessageCoordinator(runtime as any, service as any, { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, Math.random, 'ou_bot');
  cleanups.push(() => coordinator.stop());
  const calls = () => [...create.mock.calls, ...service.update.mock.calls].map(([input]) => input as { state?: string });
  return { config, coordinator, calls, cards: () => JSON.stringify(calls()) };
}

describe('live Lark card and background follow-ups', () => {
  it.each(['dispatch', 'send'] as const)('keeps follow-ups out of the turn card while other run-level events still append (%s)', async mode => {
    const h = await harness(mode);
    await h.coordinator.handle(message(`om_msg_${mode}`), h.config);
    const terminal = () => JSON.stringify(h.calls().filter(input => input.state === 'completed'));
    await vi.waitFor(() => expect(terminal()).toContain('本轮回答'));
    expect(terminal()).toContain('run-level-step');
    expect(h.cards()).not.toContain('后台任务的后续回答');
  });
});
