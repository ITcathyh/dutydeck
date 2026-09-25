// history list/show 的端到端回归：真实 DutydeckRuntime + SQLite + HTTP 路由。
// mock driver 按 prompt 回答，任务结果经执行账本结算，与线上读取最终回答的路径一致。
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepositories } from '@dutydeck/storage';
import { DutydeckRuntime, type AgentDriver } from '@dutydeck/runtime';
import type { AgentConfig, Session } from '@dutydeck/shared';
import { LarkAgentToolCapabilityRegistry, LarkAgentToolsService } from './agent-tools.js';
import { registerLarkAgentToolRoutes } from './agent-tools-routes.js';
import { larkBotsConfigKey, type StoredLarkConfig } from './config.js';
import { LarkMessageCoordinator } from './coordinator.js';
import { resolveExplicitFinalContext } from './explicit-final.js';
import { readAttemptResult } from '../task-results.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const longAnswer = `开头的中间过程${'过程'.repeat(5_000)}最终结论：采用蓝绿部署`;

async function harness() {
  const cwd = await mkdtemp(join(tmpdir(), 'dutydeck-agent-history-'));
  const repos = createRepositories(join(cwd, 'state.db'), { newDatabaseAuthority: 'ledger_v1' });
  const runtime = new DutydeckRuntime(repos, {
    probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }),
    driverFactory: (_config, _protocol, emit) => ({
      start: async () => {}, resume: async () => {}, stop: async () => {}, interrupt: async () => {},
      send: async prompt => {
        emit({ type: 'text', data: { text: prompt.includes('长回答') ? longAnswer : `回答：${prompt.split('\n').at(-1)}` } });
        emit({ type: 'completed', data: { stopReason: 'end_turn' } });
      }
    } satisfies AgentDriver)
  });
  const agent: AgentConfig = { id: 'mock', name: 'Mock', command: process.execPath, args: [], protocol: 'acp', cwd, env: {}, permissionMode: 'ask', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };
  await runtime.initialize([agent]);
  await repos.config.set(larkBotsConfigKey, JSON.stringify([{ appId: 'cli_hist', appSecret: 'fake', defaultAgentId: 'mock', groupToolsEnabled: true, groupToolsAllowSend: false }]));
  const capabilities = new LarkAgentToolCapabilityRegistry(repos.sessions, 'http://127.0.0.1');
  const tools = new LarkAgentToolsService(capabilities, repos.config, { history: repos, workbenchTask: id => runtime.getActiveTaskContext(id) });
  const app = Fastify();
  await registerLarkAgentToolRoutes(app, tools);
  cleanups.push(async () => { await app.close(); await runtime.shutdown(); repos.close(); await rm(cwd, { recursive: true, force: true }); });

  const run = async (sourceId: string, prompt: string) => {
    const session = await runtime.start({ agentId: 'mock', cwd, source: 'lark', sourceId });
    const { id } = await runtime.dispatch(session.id, prompt, 'queue', `[Dutydeck 群上下文 INJECTED_CONTEXT]\n${prompt}`, undefined, 'ou_alice');
    await vi.waitFor(async () => expect((await runtime.getTasks(session.id)).find(task => task.id === id)?.status).toBe('completed'));
    return { session, taskId: id };
  };
  const get = (session: Session, url: string) => app.inject({ method: 'GET', url: `/api/lark/agent-tools${url}`,
    headers: { authorization: `Bearer ${capabilities.environmentFor(session).dutydeck_group_tools_token}` } });
  return { run, get };
}

describe('history tools over runtime + SQLite', () => {
  it('reads visible requests and settled answers of this chat and rejects other chats with 404', async () => {
    const { run, get } = await harness();
    const deploy = await run('cli_hist:oc_group:group:user:ou_alice', '部署方案讨论');
    const long = await run('cli_hist:oc_group:group:thread:om_root', '请给长回答');
    const other = await run('cli_hist:oc_other:group:user:ou_alice', '其他群的部署方案');
    const background = await run('cli_hist:oc_group:group:collaboration:man_1', '后台委托的部署方案');
    const p2p = await run('cli_hist:oc_p2p:p2p', '私聊的部署方案');

    const listed = await get(deploy.session, '/history');
    expect(listed.statusCode).toBe(200);
    expect(listed.json().tasks.map((item: { taskId: string }) => item.taskId)).toEqual([long.taskId, deploy.taskId]);
    expect(listed.json().tasks[1]).toMatchObject({ status: 'completed', actorId: 'ou_alice', request: '部署方案讨论', answer: '回答：部署方案讨论' });
    expect(listed.body).not.toContain('INJECTED_CONTEXT');

    // 关键词可以只出现在回答里。
    const byAnswer = await get(deploy.session, `/history?query=${encodeURIComponent('蓝绿部署')}`);
    expect(byAnswer.json().tasks.map((item: { taskId: string }) => item.taskId)).toEqual([long.taskId]);

    const shown = await get(deploy.session, `/history/${long.taskId}`);
    expect(shown.statusCode).toBe(200);
    expect(shown.json()).toMatchObject({ taskId: long.taskId, request: '请给长回答', answerClipped: true });
    expect(shown.json().answer.length).toBeLessThanOrEqual(8_000);
    expect(shown.json().answer.endsWith('最终结论：采用蓝绿部署')).toBe(true);

    for (const { taskId } of [other, background, p2p]) {
      const denied = await get(deploy.session, `/history/${taskId}`);
      expect(denied.statusCode).toBe(404);
      expect(denied.json()).toMatchObject({ error: { code: 'HISTORY_TASK_NOT_FOUND' } });
      expect(denied.body).not.toContain('部署方案');
    }
    const fromP2p = await get(p2p.session, `/history/${deploy.taskId}`);
    expect(fromP2p.statusCode).toBe(404);
    expect((await get(p2p.session, '/history')).json().tasks.map((item: { taskId: string }) => item.taskId)).toEqual([p2p.taskId]);
  });
});

const finalAnswer = '最终结论：登录改为短信验证码，旧密码入口保留一个月。';

/** 真实 coordinator 建卡与映射，Agent 用 group send --final 交付答复，transcript 里只回一句确认。 */
async function explicitFinalHarness() {
  const cwd = await mkdtemp(join(tmpdir(), 'dutydeck-history-final-'));
  const repos = createRepositories(join(cwd, 'state.db'), { newDatabaseAuthority: 'ledger_v1' });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const runtime = new DutydeckRuntime(repos, {
    probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }),
    driverFactory: (_config, _protocol, emit, _exit, sessionId) => ({
      start: async () => {}, resume: async () => {}, stop: async () => {}, interrupt: async () => {},
      send: async prompt => {
        if ((await repos.sessions.get(sessionId))?.sourceId?.includes(':thread:')) {
          await gate;
          emit({ type: 'text', data: { text: '已发送答复。' } });
        } else emit({ type: 'text', data: { text: `回答：${prompt.split('\n').at(-1)}` } });
        emit({ type: 'completed', data: { stopReason: 'end_turn' } });
      }
    } satisfies AgentDriver)
  });
  const agent: AgentConfig = { id: 'mock', name: 'Mock', command: process.execPath, args: [], protocol: 'acp', cwd, env: {}, permissionMode: 'ask', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };
  await runtime.initialize([agent]);
  const config: StoredLarkConfig = { appId: 'cli_final', appSecret: 'fake-secret', workspace: cwd, defaultAgentId: 'mock',
    permissionMode: 'ask', listening: true, fullTrustConfirmed: true, preInjectPrompt: '', structuredAskCards: false,
    groupCardMention: false, groupToolsEnabled: true, groupToolsAllowSend: true, pushIntervalMs: 1_000, hideTraceOnComplete: false,
    completionReactionOnly: false, silentProgress: false, urgentEnabled: false, pinLongTasks: false,
    allowedUsers: [], allowedEmails: [], allowedBots: [], peerBotsAllowed: false,
    highRiskAllowedUsers: [], highRiskAllowedEmails: [], highRiskPattern: 'dangerous', riskControlMode: 'off' };
  await repos.config.set(larkBotsConfigKey, JSON.stringify([config]));
  let nextCard = 0;
  const createCard = async () => ({ messageId: `om_card_${++nextCard}` });
  const service = {
    send: vi.fn(createCard), reply: vi.fn(createCard), sendText: vi.fn(createCard), replyText: vi.fn(createCard),
    getBotInfo: vi.fn(async () => ({ appName: 'test', openId: 'ou_bot' })),
    getMessage: vi.fn(async (id: string) => ({ messageId: id, chatId: 'oc_group', threadId: 'omt_topic' })),
    uploadFile: vi.fn(async () => 'file_1'), replyFile: vi.fn(createCard), sendFile: vi.fn(createCard),
    update: vi.fn(async (input: { messageId: string }) => ({ messageId: input.messageId })),
    addReaction: vi.fn(async (messageId: string, emojiType = 'OK') => ({ messageId, reactionId: `r_${messageId}_${emojiType}` })),
    deleteReaction: vi.fn(async () => {}), getUserEmails: vi.fn(async () => [] as string[]),
    listChatMembers: vi.fn(async () => ({ items: [{ memberId: 'ou_alice' }], hasMore: false })),
    listChatMessages: vi.fn(async () => ({ items: [] as unknown[], hasMore: false })),
    getMessageItems: vi.fn(async () => [] as unknown[]),
    pin: vi.fn(async (messageId: string) => ({ messageId })), unpin: vi.fn(async () => {}),
    urgentApp: vi.fn(async () => ({ invalidUserIdList: [] as string[] })), callOpenApi: vi.fn(async () => ({ code: 0, data: {} }))
  };
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const coordinator = new LarkMessageCoordinator(runtime, service as any, log, Math.random, 'ou_bot',
    undefined, repos.channelMappings, async () => 'group', undefined, undefined, { store: repos.config });
  await coordinator.initializeWorkflows(config);
  cleanups.push(async () => { coordinator.stop(); release(); await runtime.shutdown(); repos.close(); await rm(cwd, { recursive: true, force: true }); });

  const channel = `lark-card:${config.appId}`;
  await coordinator.handle({ messageId: 'om_origin', chatId: 'oc_group', chatType: 'group', threadId: 'omt_topic', rootId: 'om_root',
    senderOpenId: 'ou_alice', senderType: 'user', messageType: 'text', content: JSON.stringify({ text: '登录流程该怎么改？' }),
    mentions: [{ key: '@_user_1', name: 'Dock', openId: 'ou_bot' }] }, config);
  const mapping = await vi.waitFor(async () => {
    const [row] = await repos.channelMappings.list(channel);
    expect(row && JSON.parse(row.extra!).runtime_task_id).toBeTruthy();
    return row!;
  });
  const session = (await repos.sessions.get(mapping.sessionId))!;
  const capabilities = new LarkAgentToolCapabilityRegistry(repos.sessions, 'http://localhost', 'fixed-test-secret');
  const token = capabilities.environmentFor(session).dutydeck_group_tools_token!;
  const tools = new LarkAgentToolsService(capabilities, repos.config, {
    authorizeTool: async () => {}, clientFactory: () => service as any, history: repos,
    workbenchTask: id => runtime.getActiveTaskContext(id),
    finalTaskContext: async (binding, task) => resolveExplicitFinalContext(await repos.channelMappings.list(channel), binding, task)
  });
  const active = runtime.getActiveTaskContext(session.id)!;
  await tools.send(token, { content: finalAnswer, final: true, turn: capabilities.finalTurnToken(session.id, active.taskId, active.attemptId!) });
  release();
  await vi.waitFor(async () => expect((await runtime.getTasks(session.id))[0]?.status).toBe('completed'));
  // 同一聊天里另一个没有显式答复的任务。
  const plain = await runtime.start({ agentId: 'mock', cwd, source: 'lark', sourceId: 'cli_final:oc_group:group:user:ou_bob' });
  const { id: plainTaskId } = await runtime.dispatch(plain.id, '普通问题', 'queue', '普通问题', undefined, 'ou_bob');
  await vi.waitFor(async () => expect((await runtime.getTasks(plain.id))[0]?.status).toBe('completed'));
  return { repos, tools, token, finalTaskId: active.taskId, finalSessionId: session.id, finalAttemptId: active.attemptId!, plainTaskId };
}

describe('history answers delivered with group send --final', () => {
  it('returns the explicit final answer instead of the transcript confirmation, and falls back to the transcript otherwise', async () => {
    const h = await explicitFinalHarness();
    // 前提：这一轮的 transcript 里只有确认语。
    const transcript = readAttemptResult(h.repos, h.finalSessionId, h.finalTaskId, h.finalAttemptId);
    expect(transcript.status === 'settled' && transcript.result.output.text).toBe('已发送答复。');

    expect(await h.tools.historyTask(h.token, { taskId: h.finalTaskId })).toMatchObject({ taskId: h.finalTaskId, answer: finalAnswer });
    expect((await h.tools.history(h.token, { query: '短信验证码' })).tasks.map(item => item.taskId)).toEqual([h.finalTaskId]);
    expect((await h.tools.history(h.token, { query: '已发送答复' })).tasks).toEqual([]);

    expect(await h.tools.historyTask(h.token, { taskId: h.plainTaskId })).toMatchObject({ answer: '回答：普通问题' });
    const listed = (await h.tools.history(h.token)).tasks;
    expect(listed.map(item => [item.taskId, item.answer])).toEqual([[h.plainTaskId, '回答：普通问题'], [h.finalTaskId, finalAnswer]]);
  });
});
