// 结果卡标注验证状态的回归。
//
// 「它说做完了，其实没做完」是这类产品最常见的失望，而平台验证是可核对的反证：
// 命令在目标目录真实执行，留下退出码、有限输出、时间与代码指纹，Agent 自述测试通过
// 不会产生任何验证记录。此前这件事在飞书侧一个字都没有。
//
// 最容易写错的一点是 stale：代码在验证之后变过的记录必须显示为失效，绝不能显示成已验证。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRepositories } from '@dutydeck/storage';
import { DutydeckRuntime, type AgentDriver } from '@dutydeck/runtime';
import type { AgentConfig, VerificationResponse } from '@dutydeck/shared';
import { LarkMessageCoordinator } from './coordinator.js';
import { larkBotsConfigKey, type StoredLarkConfig } from './config.js';
import type { LarkMessageEvent } from './listener.js';
import { buildLarkCard } from './service.js';
import { LARK_VERIFICATION_ELEMENT_ID, renderLarkVerificationElement } from './card-renderer.js';
import { availableLarkCardActions, larkCardActionBudget } from './card-actions.js';

const record = (patch: Partial<VerificationResponse> = {}): VerificationResponse => ({
  schemaVersion: 1, revision: 1, id: 'v1', sessionId: 's1', command: 'pnpm test', cwd: '/tmp',
  status: 'passed', startedAt: '2026-09-18T10:00:00.000Z', completedAt: '2026-09-18T10:03:00.000Z',
  exitCode: 0, output: 'ok', outputTruncated: false,
  beforeFingerprint: 'abcdef1234567890', afterFingerprint: 'abcdef1234567890', stale: false, ...patch
});

describe('验证状态行渲染', () => {
  it('没有配置验证命令时整行不渲染', () => {
    expect(renderLarkVerificationElement({ latest: record() })).toBeUndefined();
    expect(renderLarkVerificationElement({ command: '   ', latest: record() })).toBeUndefined();
  });

  it('没有验证记录时明说未验证，并说明 Agent 自述不产生记录', () => {
    const element = renderLarkVerificationElement({ command: 'pnpm test', canRun: true })!;
    expect(element.element_id).toBe(LARK_VERIFICATION_ELEMENT_ID);
    expect(element.content).toContain('未验证');
    expect(element.content).toContain('Agent 自述测试通过不产生验证记录');
    expect(element.content).toContain('运行验证');
  });

  it('已验证给出退出码、代码指纹前若干位和验证时间', () => {
    const element = renderLarkVerificationElement({ command: 'pnpm test', latest: record() })!;
    expect(element.content).toContain('已验证');
    expect(element.content).toContain('退出码 0');
    expect(element.content).toContain('代码指纹 abcdef123456');
    expect(element.content).toContain('2026-09-18 10:03 UTC');
  });

  it('代码变化导致记录失效时必须显示为失效，绝不显示成已验证', () => {
    for (const staleReason of ['code_changed', 'changed_during_run', 'current_fingerprint_unavailable', 'record_fingerprint_missing'] as const) {
      const element = renderLarkVerificationElement({ command: 'pnpm test', latest: record({ stale: true, staleReason }) })!;
      expect(element.content, staleReason).toContain('验证已失效');
      expect(element.content, staleReason).not.toContain('已验证　');
      expect(element.content.replace('验证已失效', ''), staleReason).not.toContain('已验证');
    }
  });

  it('验证失败与验证中各自如实呈现，不冒充已验证', () => {
    const failed = renderLarkVerificationElement({ command: 'pnpm test', latest: record({ status: 'failed', exitCode: 1 }) })!;
    expect(failed.content).toContain('验证失败');
    expect(failed.content).toContain('退出码 1');
    expect(failed.content).not.toContain('已验证');
    const running = renderLarkVerificationElement({ command: 'pnpm test', latest: record({ status: 'running', stale: true, staleReason: 'record_fingerprint_missing' }) })!;
    expect(running.content).toContain('验证执行中');
    expect(running.content).not.toContain('已验证');
  });
});

describe('运行验证按钮的闭集与只读收据规则', () => {
  const capabilities = { canCancelQueued: true, canInterrupt: true, canRetry: true, canRefresh: true };
  const collectButtons = (node: unknown, found: string[] = []): string[] => {
    if (Array.isArray(node)) node.forEach(item => collectButtons(item, found));
    else if (node && typeof node === 'object') {
      const item = node as Record<string, unknown>;
      if (item.tag === 'button') found.push(String(item.element_id ?? '(unnamed)'));
      Object.values(item).forEach(value => collectButtons(value, found));
    }
    return found;
  };

  it('只读收据上只出现运行验证，其余四个改写状态的操作依旧被挡住', () => {
    const context = { state: 'completed' as const, taskId: 't1', turn: 1, readOnly: true, capabilities: { ...capabilities, canVerify: true } };
    expect(availableLarkCardActions(context)).toEqual(['verify']);
    expect(availableLarkCardActions({ ...context, state: 'failed' })).toEqual(['verify']);
    // 能力未声明（旧调用点）时按钮不渲染：没配验证命令的工作区不能看到这个入口。
    expect(availableLarkCardActions({ ...context, capabilities })).toEqual([]);
  });

  it('整卡装配后只读结果卡上出现且仅出现运行验证按钮，并留在按钮预算内', () => {
    const card = buildLarkCard({
      cardKind: 'result', state: 'completed', taskId: 't1', turn: 1, readOnly: true,
      capabilities: { ...capabilities, canVerify: true }
    });
    expect(collectButtons(card)).toEqual(['verify']);
    expect(collectButtons(card).length).toBeLessThanOrEqual(larkCardActionBudget.maxButtons);
    expect(collectButtons(buildLarkCard({ cardKind: 'result', state: 'completed', taskId: 't1', turn: 1, readOnly: true, capabilities }))).toEqual([]);
  });

  it('排队、执行中与已取消都不给运行验证', () => {
    // 排队/执行中：验证要求会话空闲，runtime 会直接回 SESSION_BUSY。
    // 已取消：任务没跑过，没有需要验证的改动。
    for (const state of ['queued', 'running', 'cancelled'] as const) {
      expect(availableLarkCardActions({ state, taskId: 't1', turn: 1, capabilities: { ...capabilities, canVerify: true } }), state).not.toContain('verify');
    }
  });

  it('命令与错误原文进入群聊前先脱敏', () => {
    const element = renderLarkVerificationElement({
      command: 'pnpm test --token abcdef123456',
      latest: record({ status: 'failed', exitCode: 1, error: 'Authorization: Bearer sk-live-xyz 被拒绝' })
    })!;
    expect(element.content).not.toContain('abcdef123456');
    expect(element.content).not.toContain('sk-live-xyz');
    expect(element.content).toContain('[REDACTED]');
  });

  it('按钮不渲染时文案不得指一条不存在的路', () => {
    const element = renderLarkVerificationElement({ command: 'pnpm test', canRun: false })!;
    expect(element.content).toContain('未验证');
    expect(element.content).not.toContain('运行验证');
  });
});

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const event = (id: string, text = '改一下登录逻辑'): LarkMessageEvent => ({
  messageId: id, chatId: 'oc_group', chatType: 'group', threadId: 'omt_topic', rootId: 'om_root',
  senderOpenId: 'ou_alice', senderType: 'user', messageType: 'text', content: JSON.stringify({ text }),
  mentions: [{ key: '@_user_1', name: 'Dock', openId: 'ou_bot' }]
});

async function harness(options: { verificationCommand?: string; verifications?: VerificationResponse[] } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'dutydeck-lark-verify-'));
  const repos = createRepositories(join(cwd, 'state.db'), { newDatabaseAuthority: 'ledger_v1' });
  const runtime = new DutydeckRuntime(repos, {
    probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }),
    driverFactory: (_config, _protocol, emit) => {
      const driver: AgentDriver = {
        start: async () => {}, resume: async () => {}, stop: async () => {}, interrupt: async () => {},
        send: async () => {
          emit({ type: 'text', data: { text: '登录逻辑已改好' } });
          emit({ type: 'completed', data: { stopReason: 'end_turn' } });
        }
      };
      return driver;
    }
  });
  const agent: AgentConfig = { id: 'mock', name: 'Mock', command: process.execPath, args: [], protocol: 'acp', cwd, env: {},
    permissionMode: 'ask', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };
  await runtime.initialize([agent]);
  // 真实 runtime 的验证需要 Linux + git 仓 + 真跑命令；这里只桩掉这两个方法，
  // 其余（会话、任务、事件、持久化）全部走真实链路。
  let stored = options.verifications ?? [];
  const getVerifications = vi.fn(async () => stored);
  const runVerification = vi.fn(async (_id: string, input: { command: string }) => {
    const result = record({ command: input.command, id: `v_${stored.length + 1}` });
    stored = [result, ...stored];
    return result;
  });
  (runtime as any).getVerifications = getVerifications;
  (runtime as any).runVerification = runVerification;

  const config: StoredLarkConfig = { appId: 'cli_verify', appSecret: 'fake-secret', workspace: cwd, defaultAgentId: 'mock',
    permissionMode: 'ask', listening: true, fullTrustConfirmed: true, preInjectPrompt: '', structuredAskCards: false,
    groupCardMention: false, groupToolsEnabled: false, groupToolsAllowSend: false, pushIntervalMs: 1_000, hideTraceOnComplete: false,
    allowedUsers: [], allowedEmails: [], allowedBots: [], peerBotsAllowed: false,
    highRiskAllowedUsers: [], highRiskAllowedEmails: [], highRiskPattern: 'dangerous', riskControlMode: 'off',
    ...(options.verificationCommand ? { verificationCommand: options.verificationCommand } : {}) };
  await repos.config.set(larkBotsConfigKey, JSON.stringify([config]));

  let nextCard = 0;
  const cards = new Map<string, any>();
  const createCard = async (input: any) => { const id = `om_card_${++nextCard}`; cards.set(id, input); return { messageId: id }; };
  const service = {
    send: vi.fn(createCard), reply: vi.fn(createCard),
    uploadFile: vi.fn(async () => 'file_1'), replyFile: vi.fn(createCard), sendFile: vi.fn(createCard),
    update: vi.fn(async (input: any) => { cards.set(input.messageId, input); return { messageId: input.messageId }; }),
    addReaction: vi.fn(async (messageId: string, emojiType = 'OK') => ({ messageId, reactionId: `r_${messageId}_${emojiType}` })),
    deleteReaction: vi.fn(async () => {}), getUserEmails: vi.fn(async () => [] as string[]),
    listChatMembers: vi.fn(async () => ({ items: [{ memberId: 'ou_alice' }], hasMore: false })),
    listChatMessages: vi.fn(async () => ({ items: [] as any[], hasMore: false })),
    getMessageItems: vi.fn(async () => [] as any[])
  };
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const createCoordinator = () => new LarkMessageCoordinator(runtime, service as any, log, Math.random, 'ou_bot',
    undefined, repos.channelMappings, async () => 'group', undefined, undefined, { store: repos.config });
  const coordinator = createCoordinator();
  await coordinator.initializeWorkflows(config);
  cleanups.push(async () => { coordinator.stop(); await runtime.shutdown(); repos.close(); await rm(cwd, { recursive: true, force: true }); });

  const resultCard = async () => vi.waitFor(() => {
    const input = [...cards.values()].find(card => card.cardKind === 'result' && card.readOnly);
    expect(input).toBeTruthy();
    return input;
  }, { timeout: 10_000 });
  return { repos, runtime, config, coordinator, createCoordinator, service, cards, log, getVerifications, runVerification, resultCard };
}

const callbackValues = (node: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] => {
  if (Array.isArray(node)) node.forEach(item => callbackValues(item, out));
  else if (node && typeof node === 'object') {
    const item = node as Record<string, any>;
    for (const behavior of item.behaviors ?? []) if (behavior?.type === 'callback' && behavior.value) out.push(behavior.value);
    Object.values(item).forEach(value => { if (value && typeof value === 'object') callbackValues(value, out); });
  }
  return out;
};
const verificationLine = (card: any) =>
  (card.elements as any[]).find(element => element.element_id === LARK_VERIFICATION_ELEMENT_ID);

describe('coordinator 把验证状态带上结果卡', () => {
  it('没配验证命令时结果卡既没有这一行也没有按钮', async () => {
    const h = await harness();
    await h.coordinator.handle(event('om_1'), h.config);
    const card = await h.resultCard();
    expect(verificationLine(card)).toBeUndefined();
    expect(callbackValues(buildLarkCard(card)).map(value => value.action)).not.toContain('verify');
    expect(h.getVerifications).not.toHaveBeenCalled();
  });

  it('未验证时结果卡写明未验证并给出运行验证按钮，点击后真的跑验证并回写同一张卡', async () => {
    const h = await harness({ verificationCommand: 'pnpm test' });
    await h.coordinator.handle(event('om_1'), h.config);
    const card = await h.resultCard();
    expect(verificationLine(card).content).toContain('未验证');
    // 整卡装配之后这一行必须还在：布局层会重排并裁剪元素，只断言输入不能证明用户看得见。
    const built = buildLarkCard(card);
    expect(JSON.stringify(built)).toContain('未验证');
    const verify = callbackValues(built).find(value => value.action === 'verify');
    expect(verify).toBeTruthy();

    const response = await h.coordinator.handleAction(verify, 'ou_alice', { messageId: 'om_card_2', chatId: 'oc_group' });
    expect(response).toMatchObject({ type: 'success' });
    await vi.waitFor(() => expect(h.runVerification).toHaveBeenCalledWith(expect.any(String), { command: 'pnpm test' }));
    // 完成后原样重绘同一张结果卡，只换掉验证状态行。
    await vi.waitFor(() => {
      const patched = h.service.update.mock.calls.map(([input]) => input)
        .filter(input => input.cardKind === 'result' && verificationLine(input));
      expect(patched.at(-1)!.elements.find((element: any) => element.element_id === LARK_VERIFICATION_ELEMENT_ID).content).toContain('已验证');
      expect(patched.at(-1)!.elements.some((element: any) => element.element_id === 'final_output')).toBe(true);
    }, { timeout: 10_000 });
  });

  it('守护进程重启后按钮仍然可用：结果卡是活得比进程久的收据，不能留死按钮', async () => {
    const h = await harness({ verificationCommand: 'pnpm test' });
    await h.coordinator.handle(event('om_1'), h.config);
    const card = await h.resultCard();
    const verify = callbackValues(buildLarkCard(card)).find(value => value.action === 'verify')!;
    const finalMessageId = [...h.cards.entries()].find(([, input]) => input === card)![0];

    // 进程重启：内存里的任务全丢，只剩持久化的卡片映射。
    h.coordinator.stop();
    const restarted = h.createCoordinator();
    await restarted.initializeWorkflows(h.config);
    const response = await restarted.handleAction(verify, 'ou_alice', { messageId: finalMessageId, chatId: 'oc_group' });
    expect(response).toMatchObject({ type: 'success' });
    await vi.waitFor(() => expect(h.runVerification).toHaveBeenCalledWith(expect.any(String), { command: 'pnpm test' }));
    await vi.waitFor(() => {
      const patched = h.service.update.mock.calls.map(([input]) => input).filter(input => input.messageId === finalMessageId);
      expect(patched.at(-1)!.elements.find((element: any) => element.element_id === LARK_VERIFICATION_ELEMENT_ID).content).toContain('已验证');
    }, { timeout: 10_000 });
    restarted.stop();
  });

  it('已有记录因代码变化失效时，结果卡显示失效而不是已验证，并仍给出重新验证入口', async () => {
    const h = await harness({ verificationCommand: 'pnpm test', verifications: [record({ stale: true, staleReason: 'code_changed' })] });
    await h.coordinator.handle(event('om_1'), h.config);
    const card = await h.resultCard();
    const line = verificationLine(card);
    expect(line.content).toContain('验证已失效');
    expect(line.content.replace('验证已失效', '')).not.toContain('已验证');
    expect(callbackValues(buildLarkCard(card)).map(value => value.action)).toContain('verify');
  });

  it('记录能证明当前代码时不再给按钮，只留可核对的已验证结论', async () => {
    const h = await harness({ verificationCommand: 'pnpm test', verifications: [record()] });
    await h.coordinator.handle(event('om_1'), h.config);
    const card = await h.resultCard();
    expect(verificationLine(card).content).toContain('已验证');
    expect(callbackValues(buildLarkCard(card)).map(value => value.action)).not.toContain('verify');
  });
});
