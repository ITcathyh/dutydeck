// 改了代码就自动验证的端到端回归：真实 DutydeckRuntime + SQLite + 真实 Git 仓库与真实验证进程，飞书接口用替身。
//
// 1) 本轮改了代码且配了验证命令：轮次结束后自动验证，结果卡标题栏写「运行完成」，验证状态单独一行；
// 2) 没改代码不自动验证；共享目录按本轮前后的代码指纹判断，本地有没推送的提交也不误触发；
// 3) 验证失败把截断后的输出作为一轮返修发回 Agent，最多两轮，之后标「验证未通过」；
// 4) 验证工具本身出错（命令不存在）记为未通过，但不发回返修；
// 5) 没配验证命令时按基准推断候选命令，一键确认后保存到配置，同一工作区只提议一次；
// 6) 自动验证执行中服务重启：重启后卡片改成「验证被中断」并给出「运行验证」；
// 7) 待收尾记录每个机器人一行，任务的验证收尾后移除，不随任务数增长；
// 8) 管理群里自动验证带上发起人身份、手动「运行验证」带上点击人身份，都过得了执行授权。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRepositories } from '@dutydeck/storage';
import { DutydeckRuntime, type AgentDriver } from '@dutydeck/runtime';
import type { AgentConfig } from '@dutydeck/shared';
import { LarkMessageCoordinator, type PersistedLarkCardTask } from './coordinator.js';
import { LarkGroupManager } from './group-management.js';
import { larkBotsConfigKey, readLarkConfig, type StoredLarkConfig } from './config.js';
import type { LarkMessageEvent } from './listener.js';
import { buildLarkCard } from './service.js';
import { LARK_VERIFICATION_ELEMENT_ID } from './card-renderer.js';
import { larkPendingVerificationKey, parseLarkPendingVerifications } from './auto-verification.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
const event = (id: string, text = '改一下登录逻辑'): LarkMessageEvent => ({
  messageId: id, chatId: 'oc_group', chatType: 'group', threadId: 'omt_topic', rootId: 'om_root',
  senderOpenId: 'ou_alice', senderType: 'user', messageType: 'text', content: JSON.stringify({ text: `@_user_1 ${text}` }),
  mentions: [{ key: '@_user_1', name: 'Dock', openId: 'ou_bot' }]
});

/**
 * edit 在 Agent 每一轮执行时调用，round 从 1 开始；不传就是这一轮不改代码。
 * unpushed：仓库有远端，本地还有一个没推送的提交——用户主目录的常见形态。
 * managed：群绑定为管理群，执行授权走真实的 LarkGroupManager.prepareTurn（与 service.ts 的接线一致）。
 */
async function harness(options: { verificationCommand?: string; files?: Record<string, string>; edit?: (repo: string, round: number, prompt: string) => void; unpushed?: boolean; managed?: boolean }) {
  const root = await mkdtemp(join(tmpdir(), 'dutydeck-lark-autoverify-'));
  // 状态库放在仓库外面：它一直在写，放在仓库里会让验证期间的代码指纹对不上。
  const repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Dutydeck Test');
  for (const [path, content] of Object.entries({ 'README.md': 'baseline\n', ...options.files })) writeFileSync(join(repo, path), content);
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'baseline');
  if (options.unpushed) {
    execFileSync('git', ['clone', '-q', '--bare', repo, join(root, 'origin.git')]);
    git(repo, 'remote', 'add', 'origin', join(root, 'origin.git'));
    git(repo, 'fetch', '-q', 'origin');
    git(repo, 'remote', 'set-head', 'origin', '-a');
    writeFileSync(join(repo, 'local.txt'), 'not pushed\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'local only');
  }

  const prompts: string[] = [];
  const agent: AgentConfig = { id: 'mock', name: 'Mock', command: process.execPath, args: [], protocol: 'acp', cwd: repo, env: {},
    permissionMode: 'ask', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };
  const config: StoredLarkConfig = { appId: 'cli_autoverify', appSecret: 'fake-secret', name: 'Dock', workspace: repo, defaultAgentId: 'mock',
    permissionMode: 'ask', listening: true, fullTrustConfirmed: true, preInjectPrompt: '', structuredAskCards: false,
    groupCardMention: false, groupToolsEnabled: false, groupToolsAllowSend: false, pushIntervalMs: 1_000, hideTraceOnComplete: false,
    completionReactionOnly: false, silentProgress: false, urgentEnabled: false, pinLongTasks: false,
    allowedUsers: [], allowedEmails: [], allowedBots: [], peerBotsAllowed: false,
    highRiskAllowedUsers: [], highRiskAllowedEmails: [], highRiskPattern: 'dangerous', riskControlMode: 'off',
    ...(options.verificationCommand ? { verificationCommand: options.verificationCommand } : {}) };

  let nextMessage = 0;
  const cards = new Map<string, any>();
  const echoes: string[] = [];
  const createCard = async (input: any) => { const id = `om_card_${++nextMessage}`; cards.set(id, input); return { messageId: id }; };
  const service = {
    send: vi.fn(createCard), reply: vi.fn(createCard),
    replyText: vi.fn(async (_input: { messageId: string; text: string; replyInThread?: boolean; idempotencyKey?: string }) => {
      const id = `om_echo_${++nextMessage}`;
      echoes.push(id);
      return { messageId: id };
    }),
    uploadFile: vi.fn(async () => 'file_1'), replyFile: vi.fn(createCard), sendFile: vi.fn(createCard),
    update: vi.fn(async (input: any) => { cards.set(input.messageId, input); return { messageId: input.messageId }; }),
    addReaction: vi.fn(async (messageId: string, emojiType = 'OK') => ({ messageId, reactionId: `r_${messageId}_${emojiType}` })),
    deleteReaction: vi.fn(async () => {}), getUserEmails: vi.fn(async () => [] as string[]),
    listChatMembers: vi.fn(async () => ({ items: [{ memberId: 'ou_alice' }], hasMore: false })),
    listChatMessages: vi.fn(async () => ({ items: [] as any[], hasMore: false })),
    getMessageItems: vi.fn(async () => [] as any[])
  };
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  /** 在同一个状态库上起一套运行时与飞书协调器；重启时飞书那一侧（卡片、消息）不变。 */
  const boot = async (first: boolean) => {
    const repos = createRepositories(join(root, 'state.db'), { newDatabaseAuthority: 'ledger_v1' });
    let groups: LarkGroupManager | undefined;
    const runtime = new DutydeckRuntime(repos, {
      ...(options.managed ? { authorizeExecution: (sessionId: string, actorId?: string) => groups!.prepareTurn(sessionId, actorId) } : {}),
      probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }),
      driverFactory: (_config, _protocol, emit) => ({
        start: async () => {}, resume: async () => {}, stop: async () => {}, interrupt: async () => {}, isStopped: async () => true,
        send: async prompt => {
          const text = typeof prompt === 'string' ? prompt : JSON.stringify(prompt);
          prompts.push(text);
          options.edit?.(repo, prompts.length, text);
          emit({ type: 'text', data: { text: `第 ${prompts.length} 轮已改好` } });
          emit({ type: 'completed', data: { stopReason: 'end_turn' } });
        }
      } satisfies AgentDriver)
    });
    await runtime.initialize([agent]);
    const runVerification = vi.spyOn(runtime, 'runVerification');
    if (first) await repos.config.set(larkBotsConfigKey, JSON.stringify([config]));
    if (options.managed) {
      const client = {
        getBotInfo: async () => ({ appName: 'Dock', openId: 'ou_bot' }),
        checkApplicationIdentity: async () => ({ verified: true, reportedAppId: config.appId, tenantKey: 'synthetic-tenant' }),
        listChats: async () => ({ items: [{ chatId: 'oc_group', name: '项目群', external: false }], hasMore: false }),
        listChatMembers: async () => ({ items: [{ memberId: 'ou_alice', openId: 'ou_alice', name: 'alice', memberType: 'user' }], hasMore: false, securityLimited: false }),
        getUserEmails: async () => [] as string[]
      };
      groups = new LarkGroupManager(repos, { now: () => new Date(), client: () => client as any });
      if (first) {
        await groups.sync(config.appId);
        await groups.save(config.appId, 'oc_group', { expectedRevision: 0, patch: { accessOverride: { mode: 'all_chat_members' } } });
      }
    }
    const coordinator = new LarkMessageCoordinator(runtime, service as any, log, Math.random, 'ou_bot',
      undefined, repos.channelMappings, async () => 'group', undefined, groups, { store: repos.config });
    await coordinator.initializeWorkflows(config);
    // 与服务关闭同一组动作：停飞书监听、停运行时（会打断执行中的验证）、关库。
    const close = async () => { coordinator.stop(); await runtime.shutdown(); repos.close(); };
    return { repos, runtime, runVerification, coordinator, close };
  };
  let current = await boot(true);
  cleanups.push(async () => { await current.close(); await rm(root, { recursive: true, force: true }); });
  /** 模拟服务重启：关掉当前这一套，在同一个状态库上重新启动。 */
  const restart = async () => { await current.close(); current = await boot(false); };

  const persisted = async (taskId: string) => {
    const mapping = await current.repos.channelMappings.get(`lark-card:${config.appId}`, taskId);
    return { sessionId: mapping!.sessionId, ...JSON.parse(mapping!.extra!) as PersistedLarkCardTask };
  };
  /** 这条请求（或返修轮次）当前的结果卡入参：结果卡 PATCH 之后 cards 里存的是最新一版。 */
  const resultCard = (taskId: string) => vi.waitFor(async () => {
    const saved = await persisted(taskId);
    expect(saved.final_message_id).toBeTruthy();
    return { saved, card: cards.get(saved.final_message_id!) };
  }, { timeout: 15_000 });
  const verificationLine = async (taskId: string) =>
    String(((await resultCard(taskId)).card.elements as any[]).find(element => element.element_id === LARK_VERIFICATION_ELEMENT_ID)?.content ?? '');
  const settledLine = (taskId: string, text: string) => vi.waitFor(async () => {
    const line = await verificationLine(taskId);
    expect(line).toContain(text);
    return line;
  }, { timeout: 15_000 });
  /** 这个机器人待收尾的自动验证：整行一条记录。 */
  const pending = async () => parseLarkPendingVerifications(await current.repos.config.get(larkPendingVerificationKey(config.appId)));
  const drained = () => vi.waitFor(async () => expect(await pending()).toEqual([]), { timeout: 10_000 });
  return {
    repo, config, service, cards, echoes, prompts, log, persisted, resultCard, verificationLine, settledLine, restart, pending, drained,
    get repos() { return current.repos; }, get runtime() { return current.runtime; },
    get coordinator() { return current.coordinator; }, get runVerification() { return current.runVerification; }
  };
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
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('改了代码就自动验证', () => {
  it('本轮改了代码：轮次结束后自动执行验证命令，结果卡标题栏写运行完成，验证状态单独一行', async () => {
    const h = await harness({ verificationCommand: 'test -f work.txt', edit: repo => writeFileSync(join(repo, 'work.txt'), 'done\n') });
    await h.coordinator.handle(event('om_1'), h.config);
    const line = await h.settledLine('om_1', '验证通过');
    expect(line).toContain('`test -f work.txt` 退出码 0');
    expect(h.runVerification).toHaveBeenCalledTimes(1);
    expect(h.runVerification).toHaveBeenCalledWith(expect.any(String), { command: 'test -f work.txt' }, 'ou_alice');
    const built = buildLarkCard((await h.resultCard('om_1')).card);
    expect(built.header.text_tag_list[0].text.content).toBe('运行完成');
    // 已有记录能证明当前代码：不再给「运行验证」，也不发返修。
    expect(callbackValues(built).map(value => value.action)).not.toContain('verify');
    expect(h.service.replyText).not.toHaveBeenCalled();
    const records = await h.runtime.getVerifications((await h.persisted('om_1')).sessionId);
    expect(records.map(item => item.status)).toEqual(['passed']);
    await h.drained();
  }, 30_000);

  it('本轮没改代码：不自动验证，结果卡写未验证并留手动入口', async () => {
    const h = await harness({ verificationCommand: 'test -f work.txt' });
    await h.coordinator.handle(event('om_1'), h.config);
    await h.resultCard('om_1');
    await pause(500);
    expect(h.runVerification).not.toHaveBeenCalled();
    const line = await h.verificationLine('om_1');
    expect(line).toContain('未验证');
    expect(line).not.toContain('验证通过');
    expect(callbackValues(buildLarkCard((await h.resultCard('om_1')).card)).map(value => value.action)).toContain('verify');
  }, 30_000);

  it('共享目录本地有没推送的提交、本轮没改代码：不自动验证', async () => {
    const h = await harness({ verificationCommand: 'true', unpushed: true });
    // 相对远端默认分支，工作区确有差异：按基准判断就会误触发。
    expect(git(h.repo, 'rev-parse', 'origin/HEAD')).not.toBe(git(h.repo, 'rev-parse', 'HEAD'));
    await h.coordinator.handle(event('om_1', '这段逻辑是做什么的'), h.config);
    await h.resultCard('om_1');
    await pause(500);
    expect(h.runVerification).not.toHaveBeenCalled();
    expect(await h.verificationLine('om_1')).toContain('未验证');
  }, 30_000);

  it('共享目录本地有没推送的提交、本轮改了代码：自动验证', async () => {
    const h = await harness({ verificationCommand: 'test -f work.txt', unpushed: true, edit: repo => writeFileSync(join(repo, 'work.txt'), 'done\n') });
    await h.coordinator.handle(event('om_1'), h.config);
    await h.settledLine('om_1', '验证通过');
    expect(h.runVerification).toHaveBeenCalledTimes(1);
  }, 30_000);

  it('验证失败：截断后的失败输出作为一轮返修发回 Agent，修好后重新验证并通过', async () => {
    const h = await harness({
      verificationCommand: 'test -f fixed.txt || { echo "缺少 fixed.txt"; exit 1; }',
      edit: (repo, round) => writeFileSync(join(repo, round === 1 ? 'work.txt' : 'fixed.txt'), `round ${round}\n`)
    });
    await h.coordinator.handle(event('om_1'), h.config);
    const first = await h.settledLine('om_1', '第 1/2 轮');
    expect(first).toContain('验证未通过');
    expect(first).toContain('退出码 1');
    await vi.waitFor(() => expect(h.prompts).toHaveLength(2), { timeout: 15_000 });
    expect(h.prompts[1]).toContain('验证未通过，自动返修第 1/2 轮');
    expect(h.prompts[1]).toContain('缺少 fixed.txt');
    // 群里只看到一句说明，失败输出不进群。
    expect(h.service.replyText).toHaveBeenCalledTimes(1);
    const notice = h.service.replyText.mock.calls[0]![0];
    expect(notice.text).toContain('自动返修 1/2');
    expect(notice.text).not.toContain('缺少 fixed.txt');
    const repaired = await h.settledLine(h.echoes[0]!, '验证通过');
    expect(repaired).not.toContain('验证未通过');
    const records = await h.runtime.getVerifications((await h.persisted('om_1')).sessionId);
    expect(records.map(item => item.status)).toEqual(['passed', 'failed']);
    // 之后的代码改动让失败那条记录过期：它不能再用来判断当前代码。
    expect(records[1]).toMatchObject({ stale: true, staleReason: 'code_changed' });
    expect(h.service.replyText).toHaveBeenCalledTimes(1);
    await h.drained();
  }, 30_000);

  it('返修两轮仍失败：不再发第三轮，最后一张结果卡标验证未通过', async () => {
    const h = await harness({
      verificationCommand: 'echo "still broken"; exit 1',
      edit: (repo, round) => writeFileSync(join(repo, 'work.txt'), `round ${round}\n`)
    });
    await h.coordinator.handle(event('om_1'), h.config);
    await h.settledLine('om_1', '第 1/2 轮');
    await vi.waitFor(() => expect(h.echoes).toHaveLength(1), { timeout: 15_000 });
    await h.settledLine(h.echoes[0]!, '第 2/2 轮');
    await vi.waitFor(() => expect(h.echoes).toHaveLength(2), { timeout: 15_000 });
    const last = await h.settledLine(h.echoes[1]!, '已自动返修 2 轮仍未通过');
    expect(last).toContain('验证未通过');
    await pause(1_000);
    expect(h.prompts).toHaveLength(3);
    expect(h.runVerification).toHaveBeenCalledTimes(3);
    expect(h.service.replyText).toHaveBeenCalledTimes(2);
    await h.drained();
  }, 45_000);

  it('验证工具本身出错（命令不存在）：记为验证未通过，但不发回 Agent 返修', async () => {
    const h = await harness({ verificationCommand: 'dutydeck-missing-verifier-xyz', edit: repo => writeFileSync(join(repo, 'work.txt'), 'done\n') });
    await h.coordinator.handle(event('om_1'), h.config);
    const line = await h.settledLine('om_1', '没有发回 Agent 返修');
    expect(line).toContain('验证未通过');
    expect(line).toContain('退出码 127');
    await pause(1_000);
    expect(h.service.replyText).not.toHaveBeenCalled();
    expect(h.prompts).toHaveLength(1);
    // 待收尾里已移除，卡上的说明随卡片记录保留，之后重绘仍照它写。
    await h.drained();
    expect((await h.persisted('om_1')).verification_auto).toMatchObject({ phase: 'infrastructure' });
  }, 30_000);

  it('管理群：自动验证带上发起人身份，过得了执行授权并验证通过', async () => {
    const h = await harness({ verificationCommand: 'test -f work.txt', managed: true, edit: repo => writeFileSync(join(repo, 'work.txt'), 'done\n') });
    await h.coordinator.handle(event('om_1'), h.config);
    const line = await h.settledLine('om_1', '验证通过');
    expect(line).not.toContain('没能执行');
    expect(h.runVerification).toHaveBeenCalledWith(expect.any(String), { command: 'test -f work.txt' }, 'ou_alice');
    expect((await h.runtime.getVerifications((await h.persisted('om_1')).sessionId)).map(item => item.status)).toEqual(['passed']);
    await h.drained();
  }, 30_000);

  it('管理群：手动点「运行验证」带上点击人身份，过得了执行授权并执行', async () => {
    const h = await harness({ verificationCommand: 'test -f README.md', managed: true });
    await h.coordinator.handle(event('om_1', '登录逻辑是做什么的'), h.config);
    expect(await h.verificationLine('om_1')).toContain('未验证');
    const { saved, card } = await h.resultCard('om_1');
    const verify = callbackValues(buildLarkCard(card)).find(value => value.action === 'verify');
    expect(verify).toBeTruthy();
    expect(await h.coordinator.handleAction(verify, 'ou_alice', { messageId: saved.final_message_id, chatId: saved.chat_id })).toMatchObject({ type: 'success' });
    const line = await h.settledLine('om_1', '验证通过');
    expect(line).toContain('`test -f README.md` 退出码 0');
    expect(h.runVerification).toHaveBeenCalledWith(expect.any(String), { command: 'test -f README.md' }, 'ou_alice');
    expect((await h.runtime.getVerifications(saved.sessionId)).map(item => item.status)).toEqual(['passed']);
  }, 30_000);

  it('多个任务跑完后，待收尾这一行里不残留', async () => {
    // 第 1 轮改代码且通过；第 2 轮不改代码；第 3 轮把代码改坏、验证失败发回返修；第 4 轮（返修）什么都没改。
    const h = await harness({
      verificationCommand: 'test ! -f broken.txt || { echo "broken"; exit 1; }',
      edit: (repo, round) => {
        if (round === 1) writeFileSync(join(repo, 'work.txt'), 'done\n');
        if (round === 3) writeFileSync(join(repo, 'broken.txt'), 'oops\n');
      }
    });
    await h.coordinator.handle(event('om_1'), h.config);
    await h.settledLine('om_1', '验证通过');
    await h.coordinator.handle(event('om_2', '再看看'), h.config);
    await h.resultCard('om_2');
    await h.coordinator.handle(event('om_3'), h.config);
    await h.settledLine('om_3', '第 1/2 轮');
    await vi.waitFor(() => expect(h.prompts).toHaveLength(4), { timeout: 15_000 });
    await h.resultCard(h.echoes[0]!);
    await h.drained();
    expect(h.runVerification).toHaveBeenCalledTimes(2);
  }, 45_000);
});

describe('没配验证命令时推断候选命令', () => {
  it('只按基准分支推断；同一工作区只提议一次；一键确认后保存到配置并重绘结果卡', async () => {
    const h = await harness({
      files: { 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }) },
      // Agent 在工作区里改了 package.json：推断只读基准，不受它影响。
      edit: repo => writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'true', typecheck: 'true' } }))
    });
    await h.coordinator.handle(event('om_1'), h.config);
    const first = await h.verificationLine('om_1');
    expect(first).toContain('未验证');
    expect(first).toContain('`npm test`');
    expect(first).toContain('使用这个验证命令');
    const firstCard = buildLarkCard((await h.resultCard('om_1')).card);
    const use = callbackValues(firstCard).find(value => value.action === 'use_verification_command');
    expect(use).toBeTruthy();
    expect(callbackValues(firstCard).map(value => value.action)).not.toContain('verify');
    expect(h.runVerification).not.toHaveBeenCalled();

    await h.coordinator.handle(event('om_2', '再看看'), h.config);
    await h.resultCard('om_2');
    expect(await h.verificationLine('om_2')).toBe('');
    expect(callbackValues(buildLarkCard((await h.resultCard('om_2')).card)).map(value => value.action)).not.toContain('use_verification_command');

    const saved = (await h.resultCard('om_1')).saved;
    const response = await h.coordinator.handleAction(use, 'ou_alice', { messageId: saved.final_message_id, chatId: saved.chat_id });
    expect(response).toMatchObject({ type: 'success' });
    expect((await readLarkConfig(h.repos.config, h.config.appId))?.verificationCommand).toBe('npm test');
    const refreshed = await h.settledLine('om_1', '运行验证');
    expect(refreshed).toContain('`npm test`');
    expect(refreshed).not.toContain('使用这个验证命令');
    const actions = callbackValues(buildLarkCard((await h.resultCard('om_1')).card)).map(value => value.action);
    expect(actions).toContain('verify');
    expect(actions).not.toContain('use_verification_command');
    // 已经配了命令，再点旧按钮不会改写配置。
    expect(await h.coordinator.handleAction(use, 'ou_alice', { messageId: saved.final_message_id, chatId: saved.chat_id })).toMatchObject({ type: 'warning' });
  }, 30_000);
});

describe('自动验证进行中服务重启', () => {
  for (const runtimeFirst of [false, true]) {
    it(`重启后把遗留的「验证执行中」改成「验证被中断」并重绘结果卡，给出「运行验证」（${runtimeFirst ? '先停运行时' : '先停飞书监听'}）`, async () => {
      const h = await harness({ verificationCommand: 'sleep 20', edit: repo => writeFileSync(join(repo, 'work.txt'), 'done\n') });
      await h.coordinator.handle(event('om_1'), h.config);
      await h.settledLine('om_1', '验证执行中');
      const sessionId = (await h.persisted('om_1')).sessionId;
      await vi.waitFor(async () => expect((await h.runtime.getVerifications(sessionId))[0]?.status).toBe('running'), { timeout: 15_000 });
      expect((await h.pending()).map(item => item.task_id)).toEqual(['om_1']);
      expect((await h.pending())[0]!.running).toBeTruthy();
      if (runtimeFirst) {
        // 服务关闭时两边并发收尾：运行时先停，飞书侧还在，自动验证自己拿到被打断的记录。
        await h.runtime.shutdown();
        await vi.waitFor(async () => expect((await h.persisted('om_1')).verification_auto).toMatchObject({ phase: 'interrupted' }), { timeout: 10_000 });
        // 被打断的仍留在待收尾里：停服务时那次重绘可能送不到，留给下次启动。
        expect((await h.pending()).map(item => item.task_id)).toEqual(['om_1']);
      }
      await h.restart();
      const line = await h.settledLine('om_1', '验证被中断');
      expect(line).toContain('服务重启');
      expect(line).not.toContain('验证执行中');
      expect(line).toContain('运行验证');
      expect(callbackValues(buildLarkCard((await h.resultCard('om_1')).card)).map(value => value.action)).toContain('verify');
      expect((await h.runtime.getVerifications(sessionId)).map(item => item.status)).toEqual(['interrupted']);
      expect(h.service.replyText).not.toHaveBeenCalled();
      // 重绘过的移出待收尾；卡上的「验证被中断」随卡片记录保留。
      expect(await h.pending()).toEqual([]);
      expect((await h.persisted('om_1')).verification_auto).toMatchObject({ phase: 'interrupted' });
      // 收尾过的卡片不再带给下一次启动：再重启一次不会重绘。
      const updates = h.service.update.mock.calls.length;
      await h.restart();
      await pause(300);
      expect(h.service.update.mock.calls.length).toBe(updates);
    }, 45_000);
  }
});
