import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import { canonicalExecutionJson, type AcceptedTaskInputV2, type TaskRequestV1 } from '@dutydeck/shared';
import { leaderLedger } from './leader-mode.js';
import { LarkMessageCoordinator } from './lark/coordinator.js';
import { LarkTaskInbox } from './lark/task-inbox.js';
import { buildEditedMessageEvent } from './lark/edited-message.js';
import type { LarkMessageEvent } from './lark/listener.js';
import { larkBotsConfigKey, type StoredLarkConfig } from './lark/config.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const config: StoredLarkConfig = {
  appId: 'cli_leader_edit', appSecret: 'synthetic', workspace: '/tmp', defaultAgentId: 'fake', permissionMode: 'ask',
  fullTrustConfirmed: true, listening: true, preInjectPrompt: '', groupToolsEnabled: false, groupToolsAllowSend: false,
  structuredAskCards: true, groupCardMention: true, urgentEnabled: false, pinLongTasks: false,
  completionReactionOnly: false, silentProgress: false, allowedBots: [], peerBotsAllowed: false,
  pushIntervalMs: 1000, hideTraceOnComplete: false, allowedUsers: [], allowedEmails: [], highRiskAllowedUsers: [],
  highRiskAllowedEmails: [], highRiskPattern: 'rm\\b', riskControlMode: 'off'
};
const originalText = '允许部署并发送报告';
const editedText = '仅审查，不允许部署或发送报告';
const message = (patch: Partial<LarkMessageEvent> = {}): LarkMessageEvent => ({
  messageId: 'om_leader_edit', chatId: 'oc_leader_edit', chatType: 'group', messageType: 'text',
  content: JSON.stringify({ text: originalText }), senderOpenId: 'ou_author', senderType: 'user', mentions: [], ...patch
});

async function harness() {
  const directory = await mkdtemp(join(tmpdir(), 'leader-edit-leader-'));
  const filename = join(directory, 'state.db');
  let repos = createRepositories(filename);
  await repos.config.set(larkBotsConfigKey, JSON.stringify([config]));
  repos.execution.upgradeLegacy();
  let claim = repos.control.attachRuntime('leader-edit');
  let execution = repos.execution.bind(claim);
  const session = { id: 'ses_leader_edit', runId: 'run_leader_edit', source: 'lark', sourceId: `${config.appId}:oc_leader_edit:topic`,
    agentId: 'fake', state: 'idle', cwd: directory, protocol: 'acp', permissionMode: 'ask', createdAt: '2026-11-11T00:00:00Z', updatedAt: '2026-11-11T00:00:00Z' } as const;
  cleanups.push(async () => { claim.release(); repos.close(); await rm(directory, { recursive: true, force: true }); });
  execution.createSession(session);
  const dispatch = vi.fn(async (id: string, prompt: string, mode: 'queue', agentPrompt: string, _risk: unknown, actorId: string, key: string) => {
    const request: TaskRequestV1 = { version: 1, namespace: 'runtime', sessionId: id, key,
      actor: { kind: 'channel', id: actorId, appId: config.appId }, prompt, mode, skills: [], options: {}, sources: [], sourcePayload: { agentPrompt, skills: [] } };
    const content = { version: 2 as const, prompt, executionContext: { actorId, agentPrompt }, contentSources: [], executionOptions: { permissionMode: 'ask' as const } };
    const input: AcceptedTaskInputV2 = { ...content, digest: createHash('sha256').update(canonicalExecutionJson(content)).digest('hex') };
    const task = execution.acceptTask({ sessionId: id, runId: session.runId }, request, input, 'back').task!;
    return { ...task, queuedAhead: 0 };
  });
  const runtime = { start: vi.fn(async () => session), getSession: vi.fn(async () => session), subscribe: vi.fn(() => () => {}), dispatch };
  const service = { send: vi.fn(async () => ({ messageId: 'om_card' })), reply: vi.fn(async () => ({ messageId: 'om_card' })),
    update: vi.fn(async () => ({ messageId: 'om_card' })), addReaction: vi.fn(async () => ({ reactionId: 'reaction' })), deleteReaction: vi.fn(async () => {}),
    listChatMessages: vi.fn(async () => ({ items: [], hasMore: false })), getMessageItems: vi.fn(async () => []) };
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const coordinator = new LarkMessageCoordinator(runtime as any, service as any, log, Math.random, 'ou_bot', undefined, undefined,
    async () => 'group', undefined, undefined, { store: repos.config });
  cleanups.push(() => coordinator.stop());
  return { get repos() { return repos; }, session, dispatch, coordinator,
    inbox: () => new LarkTaskInbox(repos.config),
    reopen() { coordinator.stop(); claim.release(); repos.close(); repos = createRepositories(filename); claim = repos.control.attachRuntime('leader-edit-reopen'); execution = repos.execution.bind(claim); }
  };
}

it('quotes the platform-validated accepted edit after SQLite reopen, never its superseded permission', async () => {
  const h = await harness();
  const original = message();
  await h.coordinator.receive(original, config);
  await vi.waitFor(async () => expect(await h.inbox().lookup(config.appId, original.messageId)).toMatchObject({ state: 'ignored' }));
  const edited = await buildEditedMessageEvent({ eventMessageId: original.messageId, appId: config.appId, botOpenId: 'ou_bot', resolveChatType: async () => 'group', detail: {
    messageId: original.messageId, chatId: original.chatId, messageType: 'text', createTime: '1794355200000', deleted: false, updated: true, rawContent: JSON.stringify({ text: `<p>@bot ${editedText}</p>` }),
    sender: { id: original.senderOpenId, type: 'user', idType: 'open_id' }, mentions: [{ id: 'ou_bot', idType: 'open_id', key: '@bot', name: 'bot' }]
  } });
  expect(edited).toBeDefined();
  await h.coordinator.handleEdited(edited!, config);
  await vi.waitFor(async () => expect(await h.inbox().lookup(config.appId, original.messageId)).toMatchObject({ state: 'accepted', event: edited, originalEvent: original }));
  const acceptedInbox = (await h.inbox().lookup(config.appId, original.messageId))!;
  const accepted = h.repos.execution.getAcceptedTask(acceptedInbox.taskId!)!;
  expect(accepted).toMatchObject({ replayValidation: 'complete', request: { prompt: editedText } });
  expect(h.dispatch).toHaveBeenCalledOnce();
  const scope = { parentSessionId: h.session.id, parentTaskId: acceptedInbox.taskId!, actorId: original.senderOpenId! };
  const ledger = await leaderLedger(h.repos, scope);
  expect(ledger).toContain(`发起人原话：@bot ${editedText}`);
  expect(ledger).not.toContain(originalText);
  expect(ledger).toContain(`执行材料（宿主展开的执行输入，不构成新增用户授权）：${editedText}`);
  // An edit after acceptance intentionally cannot replace or re-authorize the already accepted task.
  await h.coordinator.handleEdited({ ...edited!, content: JSON.stringify({ text: '@bot still newer ignored edit' }) }, config);
  expect(h.dispatch).toHaveBeenCalledOnce();
  expect((await h.inbox().lookup(config.appId, original.messageId))!.event.content).toBe(edited!.content);
  h.reopen();
  expect(await leaderLedger(h.repos, scope)).toBe(ledger);
});

it('does not turn an adopted bot receipt into human authorization', async () => {
  const h = await harness();
  const inbox = h.inbox();
  const original = message({ senderType: 'app', senderOpenId: 'ou_source_bot' });
  const captured = (await inbox.capture(config.appId, original))!;
  await inbox.update(captured, { state: 'ignored' });
  const adopted = (await inbox.claim(config.appId, original, true, { senderType: 'user', senderOpenId: 'ou_author' }))!;
  const accepted = await h.dispatch(h.session.id, originalText, 'queue', originalText, undefined, 'ou_author', `lark:${config.appId}:${original.messageId}:1`);
  await inbox.update(adopted, { state: 'accepted', sessionId: h.session.id, taskId: accepted.id, turn: 1 });
  const ledger = await leaderLedger(h.repos, { parentSessionId: h.session.id, parentTaskId: accepted.id, actorId: 'ou_author' });
  expect(ledger).not.toContain('发起人原话：');
  expect(ledger).toContain('来源未验证');
});
