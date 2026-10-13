// 「查看改动」在飞书里的两头：结果卡上的改动摘要行，和分享链接上提交的行评论变成原话题里的确认卡。
// 真实 DutydeckRuntime + SQLite + 真实 git 仓库，飞书接口用替身。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { createRepositories } from '@dutydeck/storage';
import { DutydeckRuntime, type AgentDriver } from '@dutydeck/runtime';
import type { AgentConfig } from '@dutydeck/shared';
import { LarkMessageCoordinator, type PersistedLarkCardTask } from './coordinator.js';
import { larkBotsConfigKey, readLarkConfig, type StoredLarkConfig } from './config.js';
import type { LarkMessageEvent } from './listener.js';
import { buildLarkCard } from './service.js';
import { LarkConfirmCards } from './confirm-cards.js';
import { setLarkTurnDiffSigner } from './detail-link.js';
import { larkTurnDiffElement, requestLarkTurnDiffReview } from './turn-diff.js';
import { buildTurnDiffReviewPrompt, createTurnDiffObserver } from '../turn-diff.js';

const run = promisify(execFile);
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const event = (id: string, text: string): LarkMessageEvent => ({
  messageId: id, chatId: 'oc_group', chatType: 'group', threadId: 'omt_topic', rootId: 'om_root',
  senderOpenId: 'ou_alice', senderType: 'user', messageType: 'text', content: JSON.stringify({ text: `@_user_1 ${text}` }),
  mentions: [{ key: '@_user_1', name: 'Dock', openId: 'ou_bot' }]
});

async function harness() {
  const cwd = await mkdtemp(join(tmpdir(), 'dutydeck-lark-turn-diff-'));
  await run('git', ['init', '-b', 'main'], { cwd });
  await writeFile(join(cwd, 'app.ts'), 'export const a = 1;\n');
  await run('git', ['add', '.'], { cwd });
  await run('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-m', 'init'], { cwd });
  const state = await mkdtemp(join(tmpdir(), 'dutydeck-lark-turn-diff-state-'));
  const repos = createRepositories(join(state, 'state.db'), { newDatabaseAuthority: 'ledger_v1' });
  const prompts: string[] = [];
  const runtime = new DutydeckRuntime(repos, {
    probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }),
    observeTurn: createTurnDiffObserver(repos.config),
    driverFactory: (_config, _protocol, emit) => ({
      start: async () => {}, resume: async () => {}, stop: async () => {}, interrupt: async () => {}, isStopped: async () => true,
      send: async prompt => {
        prompts.push(typeof prompt === 'string' ? prompt : JSON.stringify(prompt));
        await writeFile(join(cwd, 'app.ts'), `export const a = ${prompts.length + 1};\nexport const b = ${prompts.length};\n`);
        emit({ type: 'text', data: { text: `第 ${prompts.length} 轮改好了` } });
        emit({ type: 'completed', data: { stopReason: 'end_turn' } });
      }
    } satisfies AgentDriver)
  });
  const agent: AgentConfig = { id: 'mock', name: 'Mock', command: process.execPath, args: [], protocol: 'acp', cwd, env: {},
    permissionMode: 'ask', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };
  await runtime.initialize([agent]);
  const config: StoredLarkConfig = { appId: 'cli_turn_diff', appSecret: 'fake-secret', name: 'Dock', workspace: cwd, defaultAgentId: 'mock',
    permissionMode: 'ask', listening: true, fullTrustConfirmed: true, preInjectPrompt: '', structuredAskCards: false,
    groupCardMention: false, groupToolsEnabled: false, groupToolsAllowSend: false, pushIntervalMs: 1_000, hideTraceOnComplete: false,
    completionReactionOnly: false, silentProgress: false, urgentEnabled: false, pinLongTasks: false, webBaseUrl: 'https://dock.example',
    allowedUsers: [{ openId: 'ou_alice', name: 'Alice' }] as any, allowedEmails: [], allowedBots: [], peerBotsAllowed: false,
    highRiskAllowedUsers: [], highRiskAllowedEmails: [], highRiskPattern: 'dangerous', riskControlMode: 'off' };
  await repos.config.set(larkBotsConfigKey, JSON.stringify([config]));

  let nextMessage = 0;
  const cards = new Map<string, any>();
  const createCard = async (input: any) => { const id = `om_card_${++nextMessage}`; cards.set(id, input); return { messageId: id }; };
  const service = {
    send: vi.fn(createCard), reply: vi.fn(createCard),
    replyText: vi.fn(async () => ({ messageId: `om_echo_${++nextMessage}` })),
    uploadFile: vi.fn(async () => 'file_1'), replyFile: vi.fn(createCard), sendFile: vi.fn(createCard),
    update: vi.fn(async (input: any) => { cards.set(input.messageId, input); return { messageId: input.messageId }; }),
    addReaction: vi.fn(async (messageId: string, emojiType = 'OK') => ({ messageId, reactionId: `r_${messageId}_${emojiType}` })),
    deleteReaction: vi.fn(async () => {}), getUserEmails: vi.fn(async () => [] as string[]),
    listChatMembers: vi.fn(async () => ({ items: [{ memberId: 'ou_alice' }, { memberId: 'ou_mallory' }], hasMore: false })),
    listChatMessages: vi.fn(async () => ({ items: [] as any[], hasMore: false })),
    getMessageItems: vi.fn(async () => [] as any[])
  };
  const confirmations = new LarkConfirmCards({ repository: repos.collaboration, readConfig: appId => readLarkConfig(repos.config, appId), serviceFor: () => service as any });
  const participation = { confirmations, mode: async () => 'off', handle: async () => ({ handled: false, enabled: false }), guardBotTurn: async () => undefined,
    taskContext: async () => undefined, instructions: async () => '', describe: async () => undefined } as any;
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const coordinator = new LarkMessageCoordinator(runtime, service as any, log, Math.random, 'ou_bot',
    undefined, repos.channelMappings, async () => 'group', undefined, undefined, { store: repos.config, participation });
  await coordinator.initializeWorkflows(config);
  await coordinator.startReconciliation(config, 60_000);
  const disposeSigner = setLarkTurnDiffSigner((sessionId, taskId) => `signed-${sessionId}-${taskId}`);
  cleanups.push(async () => {
    disposeSigner(); coordinator.stop(); await runtime.shutdown(); repos.close();
    await rm(cwd, { recursive: true, force: true }); await rm(state, { recursive: true, force: true });
  });
  const persisted = async (taskId: string) => {
    const mapping = await repos.channelMappings.get(`lark-card:${config.appId}`, taskId);
    return { sessionId: mapping!.sessionId, ...JSON.parse(mapping!.extra!) as PersistedLarkCardTask };
  };
  const result = (taskId: string) => vi.waitFor(async () => {
    const saved = await persisted(taskId);
    expect(saved.final_message_id).toBeTruthy();
    return saved;
  }, { timeout: 10_000 });
  return { repos, config, service, cards, prompts, coordinator, confirmations, persisted, result };
}

const findElement = (node: unknown, id: string): Record<string, any> | undefined => {
  if (Array.isArray(node)) { for (const item of node) { const found = findElement(item, id); if (found) return found; } return undefined; }
  if (!node || typeof node !== 'object') return undefined;
  const record = node as Record<string, any>;
  if (record.element_id === id) return record;
  for (const value of Object.values(record)) { const found = findElement(value, id); if (found) return found; }
  return undefined;
};

describe('飞书里的「查看改动」', () => {
  it('结果卡在 git 状态行之前加一行改动摘要和查看改动链接；没有改动时不显示', () => {
    const record = { version: 1 as const, sessionId: 'ses_1', taskId: 'task_1', gitDir: '/repo/.git', before: 'a', after: 'b', startedAt: '', summary: { files: 3, additions: 42, deletions: 7 } };
    const dispose = setLarkTurnDiffSigner(() => 'token123');
    try {
      expect(larkTurnDiffElement(record, 'https://dock.example')).toMatchInlineSnapshot(`
        {
          "content": "改动 3 个文件 +42 −7 · [查看改动](https://dock.example/diff/ses_1/task_1#token123)",
          "element_id": "turn_diff",
          "tag": "markdown",
        }
      `);
    } finally { dispose(); }
    expect(larkTurnDiffElement(record)?.content).toBe('改动 3 个文件 +42 −7');
    expect(larkTurnDiffElement({ ...record, summary: { files: 0, additions: 0, deletions: 0 } }, 'https://dock.example')).toBeUndefined();
    expect(larkTurnDiffElement(undefined, 'https://dock.example')).toBeUndefined();
  });

  it('真实一轮改了文件：结果卡带摘要；分享链接的评论在原话题发确认卡，无权限的人点被拒，有权限的人点了只派发一次', async () => {
    const h = await harness();
    await h.coordinator.handle(event('om_1', '把 a 改成 2'), h.config);
    const saved = await h.result('om_1');
    const resultCard = buildLarkCard(h.cards.get(saved.final_message_id!));
    expect(findElement(resultCard, 'turn_diff')?.content).toBe(`改动 1 个文件 +2 −1 · [查看改动](https://dock.example/diff/${saved.sessionId}/${saved.runtime_task_id}#signed-${saved.sessionId}-${saved.runtime_task_id})`);

    const comments = [{ path: 'app.ts', side: 'new' as const, line: 1, code: '+export const a = 2;', comment: '为什么是 2？[点我](https://evil.example) ```' }];
    expect(await requestLarkTurnDiffReview({ configs: h.repos.config, mappings: h.repos.channelMappings, confirmations: h.confirmations },
      { sessionId: 'ses_unknown', taskId: 'task_x', comments, prompt: 'x' })).toBe('no_origin');
    const prompt = buildTurnDiffReviewPrompt(comments, { untrusted: true });
    expect(await requestLarkTurnDiffReview({ configs: h.repos.config, mappings: h.repos.channelMappings, confirmations: h.confirmations },
      { sessionId: saved.sessionId, taskId: saved.runtime_task_id!, comments, prompt })).toBe('sent');
    const reviewCall = h.service.reply.mock.calls.map(call => call[0]).find(input => input.taskName === '代码评审意见（1 条）')!;
    expect(reviewCall).toMatchObject({ messageId: saved.final_message_id, replyInThread: true });
    const reviewCardId = [...h.cards].find(([, input]) => input === reviewCall)![0];
    const body = findElement(buildLarkCard(reviewCall), 'confirm_body')!.content as string;
    // 评论放在代码块里，反引号换掉，跑不出代码块。
    expect(body).toContain('```\napp.ts\n+export const a = 2;\n\n意见：为什么是 2？[点我](https://evil.example) ˋˋˋ\n```');
    const button = findElement(buildLarkCard(reviewCall), 'confirm_confirm')!;
    expect(button.text.content).toBe('交给 Agent 修改');
    const value = button.behaviors[0].value;

    const denied = await h.coordinator.handleAction(value, 'ou_mallory', { messageId: reviewCardId, chatId: 'oc_group' });
    expect(denied).toMatchObject({ type: 'warning', content: '只有发起人或有权限的人能把评审意见交给 Agent。' });
    expect(h.prompts).toHaveLength(1);

    const accepted = await h.coordinator.handleAction(value, 'ou_alice', { messageId: reviewCardId, chatId: 'oc_group' });
    expect(accepted).toMatchObject({ type: 'success', content: '已交给 Agent 修改，新一轮的进度和结果会发在这张卡下面。' });
    expect(await h.coordinator.handleAction(value, 'ou_alice', { messageId: reviewCardId, chatId: 'oc_group' })).toMatchObject({ content: '这张卡已经处理过了。' });
    await vi.waitFor(() => expect(h.prompts).toHaveLength(2), { timeout: 10_000 });
    expect(h.prompts[1]).toContain('提交人身份没有核实');
    expect(h.prompts[1]).toContain('<review_comments>');
    // 新一轮挂在确认卡下面。
    const next = await h.result(reviewCardId);
    expect(next.sessionId).toBe(saved.sessionId);
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(h.prompts).toHaveLength(2);
  });
});
