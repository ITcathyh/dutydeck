import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepositories } from '@dutydeck/storage';
import { DutydeckRuntime } from '@dutydeck/runtime';
import type { AgentConfig, DriverContext, DriverFactory } from '@dutydeck/shared';
import { LarkMessageCoordinator } from './coordinator.js';
import { larkBotsConfigKey, type StoredLarkConfig } from './config.js';
import type { LarkMessageEvent } from './listener.js';
import { buildLarkCard } from './service.js';

/**
 * 旧会话启动器版本变化（ACP_LAUNCHER_VERSION_CHANGED）发生在任务提交前：
 * 真实 Runtime + SQLite，受控 ACP driver 在 prepareTurn（落「已提交」意图之前）抛错，
 * attempt 结算为 not_submitted/failed。验证结果卡不给「重试」、给 /new 说明，
 * 且普通的提交前失败仍然可重试。
 */

const LAUNCHER_ERROR = 'ACP_LAUNCHER_VERSION_CHANGED: 旧会话启动器版本变化，无法自动核验；原会话记录已保留，发 /new 开新会话后重试。';

const components = (value: any): any[] => {
  if (Array.isArray(value)) return value.flatMap(components);
  if (!value || typeof value !== 'object') return [];
  return [...(typeof value.tag === 'string' ? [value] : []), ...Object.values(value).flatMap(components)];
};
const hasRetryButton = (input: any) => components(buildLarkCard(input)).some(el => el.tag === 'button' && el.element_id === 'retry');

/** 受控 ACP driver：在提交前的 prepareTurn 抛出调用方指定的错误。 */
function controlledFactory(prepareError: Error): DriverFactory {
  const factory: DriverFactory = (configured, _protocol, _onEvent, _onExit, _sessionId, context) => {
    const ctx = context as DriverContext;
    return {
      start: async () => {
        if (ctx.protocol === 'controlled-v1' && ctx.native && !ctx.native.expected) {
          const expected = {
            nativeCreationId: randomUUID(), sessionKey: ctx.native.sessionKey,
            agent: configured.id, command: [process.execPath], cwd: configured.cwd ?? '/tmp', executionDomain: ctx.executionDomain
          };
          ctx.native.reserve(expected);
          ctx.native.confirmed({ ...expected, acpxRecordId: 'acp-record-1', backendSessionId: 'backend-1', defaults: {} });
        }
      },
      // markSubmissionPending 之前的准备阶段抛错：attempt 仍是 not_submitted。
      prepareTurn: async () => { throw prepareError; },
      prepareSubmission: input => ctx.prepareSubmission(input),
      send: async () => {},
      interrupt: async () => {},
      resume: async () => {},
      stop: async () => {},
      isStopped: async () => true,
      configureNative: async request => {
        const prepared = ctx.prepareSubmission({
          taskId: 'configuration', attemptId: 'configuration', submissionId: request.operationId,
          prompt: '', executionOptions: { permissionMode: 'full-trust' as const }
        });
        return { context: prepared.nativeContextRef!, driverInstanceId: ctx.driverInstanceId, operationId: request.operationId, target: request.target, evidence: {} };
      }
    };
  };
  factory.controlledResources = () => true;
  return factory;
}

const groupMessage = (id: string): LarkMessageEvent => ({
  messageId: id, chatId: 'oc_group', chatType: 'group', rootId: 'om_root', threadId: 'omt_topic',
  messageType: 'text', content: JSON.stringify({ text: '@_user_1 跑一下任务' }),
  senderOpenId: 'ou_alice', senderType: 'user',
  mentions: [{ key: '@_user_1', name: 'Dutydeck', openId: 'ou_bot' }]
});

async function setup(prepareError: Error) {
  const cwd = await mkdtemp(join(tmpdir(), 'dd-launcher-changed-'));
  const config: StoredLarkConfig = {
    appId: 'app', appSecret: 'fixture', name: 'Dutydeck', workspace: cwd, defaultAgentId: 'launcher-fixture',
    fullTrustConfirmed: true, listening: true, preInjectPrompt: '', structuredAskCards: false, groupCardMention: false,
    groupToolsEnabled: false, groupToolsAllowSend: false, pushIntervalMs: 60_000, hideTraceOnComplete: false,
    allowedUsers: [{ openId: 'ou_alice', name: 'Alice' }], allowedEmails: [], allowedBots: [], peerBotsAllowed: false,
    highRiskAllowedUsers: [], highRiskAllowedEmails: [], highRiskPattern: 'danger', riskControlMode: 'off'
  };
  const agent: AgentConfig = {
    id: 'launcher-fixture', name: 'Fixture', command: 'unused', args: [], protocol: 'acp', cwd, env: {},
    permissionMode: 'full-trust', timeout: 0, capabilities: { pause: false, resume: true }, builtin: false
  };
  const repos = createRepositories(join(cwd, 'state.db'), { newDatabaseAuthority: 'ledger_v1' });
  await repos.config.set(larkBotsConfigKey, JSON.stringify([config]));

  const issued: any[] = [];
  const service = {
    addReaction: vi.fn(async () => ({ reactionId: 'r1' })),
    deleteReaction: vi.fn(async () => {}),
    reply: vi.fn(async (input: any) => { issued.push(input); return { messageId: `om_reply_${issued.length}` }; }),
    send: vi.fn(async (input: any) => { issued.push(input); return { messageId: `om_send_${issued.length}` }; }),
    replyText: vi.fn(async () => ({ messageId: 'om_text' })),
    update: vi.fn(async (input: any) => ({ messageId: input.messageId })),
    getUserEmails: vi.fn(async () => ['alice@example.com']),
    listChatMembers: vi.fn(async () => ({ items: [{ memberId: 'ou_alice' }], hasMore: false })),
    listChatMessages: vi.fn(async () => ({ items: [], hasMore: false }))
  };

  const factory = controlledFactory(prepareError);
  const runtime = new DutydeckRuntime(repos, {
    driverIdleTimeoutMs: 0,
    probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }),
    driverFactory: factory
  });
  const coordinator = new LarkMessageCoordinator(runtime, service as any, { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
    Math.random, 'ou_bot', undefined, repos.channelMappings, undefined, undefined, undefined, { store: repos.config });
  await runtime.initialize([agent]);
  await coordinator.initializeWorkflows(config);

  const until = async (check: () => boolean | Promise<boolean>) => {
    for (let i = 0; i < 600; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 10)); }
    throw new Error('condition not reached');
  };
  return {
    cwd, config, repos, runtime, coordinator,
    async teardown() { coordinator.stop(); await runtime.shutdown(); repos.close(); await rm(cwd, { recursive: true, force: true }); },
    async runTurn(id: string) {
      await coordinator.handle(groupMessage(id), config);
      // 结果卡自带 sessionId，等它出现后再查 runtime task，避免在会话尚未创建时读取。
      await until(() => issued.some(input => input.cardKind === 'result' && input.taskId === id));
      const resultInput = issued.filter(input => input.cardKind === 'result' && input.taskId === id).at(-1)!;
      await until(async () => (await runtime.getTasks(resultInput.sessionId)).some(task => task.status === 'failed'));
      const task = (await runtime.getTasks(resultInput.sessionId)).find(item => item.status === 'failed')!;
      return { task, sessionId: resultInput.sessionId, resultInput };
    }
  };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

it('启动器版本变化导致的提交前失败：结果卡无重试、给 /new 说明，回调也拒绝在旧会话重试', async () => {
  const h = await setup(new Error(LAUNCHER_ERROR));
  cleanups.push(() => h.teardown());

  const { task, resultInput } = await h.runTurn('om_launcher');

  const execution = h.repos.execution.getTaskExecution(task.id)!;
  expect(execution.currentAttempt?.state).toBe('settled');
  expect(execution.currentAttempt?.outcome).toBe('failed');
  expect(execution.currentAttempt?.submissionState).toBe('not_submitted');

  // 结果卡不提供「重试」，说明改成人话并保留错误码便于排查。
  expect(resultInput.state).toBe('failed');
  expect(resultInput.capabilities.canRetry).toBe(false);
  expect(hasRetryButton(resultInput)).toBe(false);
  const card = JSON.stringify(buildLarkCard(resultInput));
  expect(card).toContain('这个对话的运行环境更新了，旧对话接不上');
  expect(card).toContain('发送 /new 开一个新对话后再发一次请求');
  expect(card).toContain('ACP_LAUNCHER_VERSION_CHANGED');

  // 回调端同样拒绝，不在旧会话上再跑。
  const response = await h.coordinator.handleAction(
    { action: 'retry', task_id: 'om_launcher', turn: String(resultInput.turn) },
    'ou_alice', { messageId: 'om_card', chatId: 'oc_group' }
  );
  expect(response).toMatchObject({ type: 'warning', content: '这个任务不能在当前对话重试，请按卡片上的说明处理' });
});

it('普通的提交前失败仍可重试（防回归）', async () => {
  const h = await setup(new Error('prepare phase blew up'));
  cleanups.push(() => h.teardown());

  const { task, resultInput } = await h.runTurn('om_other');

  const execution = h.repos.execution.getTaskExecution(task.id)!;
  expect(execution.currentAttempt?.submissionState).toBe('not_submitted');
  expect(resultInput.state).toBe('failed');
  expect(resultInput.capabilities.canRetry).toBe(true);
  expect(hasRetryButton(resultInput)).toBe(true);
});
