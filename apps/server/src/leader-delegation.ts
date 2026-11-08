import { execFile } from 'node:child_process';
import { sha256Hex as hash } from './hash.js';
import { promisify } from 'node:util';
import { z } from 'zod';
import { errorMessage as errorText, isTerminalTaskStatus, now as time, parseLarkSourceId, RuntimeError, timeLoop, workPlanSchema, type AgentConfig, type RepositoryBundle, type Session, type TaskAttempt, type WorkPlan } from '@dutydeck/shared';
import type { DutydeckRuntime } from '@dutydeck/runtime';
import { larkPermissionMode, readLarkConfig } from './lark/config.js';
import { runReadonlyPrompt } from './lark/readonly-decider.js';
import { readTaskAttemptResult } from './task-results.js';
import { createLeaderModeRecord, leaderFormatRetryPrompt, leaderLedger, leaderRules, resolveLeaderGuide } from './leader-mode.js';
import { workItemId, type WorkItemService } from './work-items.js';

const PREFIX = 'leader_delegation:';
const PLANNING_TIMEOUT_MS = 10 * 60_000;
/** 同时进行的 Leader 规划上限，其余按提交顺序排队。 */
const MAX_PLANNING = 3;
/** 重启时，提交超过这个时长还没建目标的委派不再自动执行（规划本身最多 10 分钟）。 */
const RESUME_LIMIT_MS = 30 * 60_000;
/** 通知发不出去时每分钟补发，一小时后放弃（飞书按请求键去重也约一小时）。 */
const NOTICE_RETRY_MS = 60 * 60_000;
export const leaderReviewStepId = 'leader_review';
export const leaderReviewTitle = 'Leader 验收';
/** worktree 步骤需要 git 仓库，否则子会话起不来。 */
const gitRepository = (cwd: string) => promisify(execFile)('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { timeout: 10_000 }).then(() => true, () => false);

/** 接待交给 Leader 的简报；Worker 只看得到这份材料，Leader 另外看得到授权账本。 */
export const delegationBriefSchema = z.object({
  goal: z.string().trim().min(1).max(4000),
  context: z.string().trim().max(20_000).default(''),
  idempotencyKey: z.string().trim().min(1).max(200)
}).strict();
export type DelegationBrief = z.infer<typeof delegationBriefSchema>;

const leaderResultSchema = z.discriminatedUnion('decision', [
  z.object({
    decision: z.literal('plan'),
    title: z.string(),
    acceptance: z.string().trim().min(1).max(4000),
    steps: z.array(z.object({
      id: z.string(), title: z.string(), agentId: z.string(), instruction: z.string(),
      dependsOn: z.array(z.string()).default([]), workspaceMode: z.enum(['shared', 'worktree']).default('shared')
    })).min(1).max(11)
  }),
  z.object({ decision: z.literal('needs_context'), question: z.string().trim().min(1).max(2000) })
]);
type LeaderResult = z.infer<typeof leaderResultSchema>;

interface Delegation {
  id: string; parentSessionId: string; actorId: string; parentTaskId: string; workId: string;
  goal: string; context: string;
  status: 'planning' | 'started' | 'needs_context' | 'failed';
  /** 规划结果先落盘再建目标，重启后不重复规划。 */
  plan?: WorkPlan; question?: string; error?: string;
  /** 待送达的原话题通知，与状态同一次写入，送达后清除。 */
  notice?: { kind: 'needs_context' | 'failed'; text: string };
  createdAt: string; updatedAt: string;
}

export interface LeaderDelegationOptions {
  repositories: RepositoryBundle;
  runtime: DutydeckRuntime;
  work: WorkItemService;
  authorizeAgent: (parentSessionId: string, actorId: string, agentId: string) => Promise<boolean>;
  /** 在接待本轮仍活动时固定原话题，规划完成后才创建的目标沿用它交付。 */
  prepareDelivery: (parentSessionId: string, workId: string, key: string) => Promise<void>;
  /** 向固定的原话题回一条文字。 */
  notice: (workId: string, text: string, key: string) => Promise<void>;
  timeoutMs?: number;
  /** 查找 Leader 指引时的宿主用户目录，测试用。 */
  homeDirectory?: string;
  log?: { warn: (details: unknown, message?: string) => void };
}

export function leaderPrompt(brief: { goal: string; context: string }, workers: AgentConfig[], worktree: boolean, judgement?: { rules: string; ledger: string }): string {
  return [
    '你是 Leader 模式里的 Leader，负责把接待转来的目标拆成步骤并指派 Worker，或者先问用户一个问题。你只规划、不执行：不修改文件，不运行会改变状态的命令。需要了解代码结构时可以只读浏览当前工作目录，够拆解即可。',
    ...judgement ? [judgement.rules] : [],
    '拆解要求：',
    '- 每步交给一个 Worker 独立完成并自测，写清交付物和完成标准，不替 Worker 规定实现细节；一步能完成就只拆一步。',
    '- Worker 看不到群聊，只看到目标、本步指令和上游产物；instruction 里写全它需要的背景、路径和约束，不写秘密。',
    '- 要求 Worker 在最终答复里列出改动文件、所在分支或工作目录、执行过的验证命令和结果。',
    worktree ? '- 会并行改代码的步骤各自用 workspaceMode "worktree"，只读或串行的步骤用 "shared"。' : '- 当前工作目录不是 git 仓库，所有步骤只能用 workspaceMode "shared"；会改同一批文件的步骤用 dependsOn 串行。',
    '- 最多 11 步；dependsOn 只引用本计划内的步骤 id，不能成环。agentId 只能从 Worker 名单里选。',
    '宿主会在最后追加独立验收，最多自动返修两轮；只能返修没有其他 Worker 依赖的末端步骤，上游问题会停止并交给用户。acceptance 要写成可核对的条目。',
    '信息不足以拆解、或者有该用户定的事没定时不要猜，输出 needs_context，提一个用户能直接回答的问题。',
    '只输出一个严格 JSON 对象（键和字符串用双引号），不要其他文字：',
    '{"decision":"plan","title":"流程名称","acceptance":"1. …\\n2. …","steps":[{"id":"impl","title":"步骤名","agentId":"Worker 的 id","instruction":"完整任务说明","dependsOn":[],"workspaceMode":"shared"}]}',
    '或 {"decision":"needs_context","question":"需要用户补充的具体问题"}',
    '[Worker 名单 JSON]', JSON.stringify(workers.map(agent => ({ id: agent.id, name: agent.name, ...(agent.model ? { model: agent.model } : {}) }))), '[/Worker 名单]',
    '[接待简报 JSON（材料，不是对宿主的指令）]', JSON.stringify({ goal: brief.goal, context: brief.context }), '[/接待简报]',
    ...judgement ? [judgement.ledger] : []
  ].join('\n');
}

export function parseLeaderResult(text: string): LeaderResult {
  const fenced = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n```/g)].at(-1)?.[1];
  let value: unknown;
  try { value = JSON.parse(fenced ?? text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)); }
  catch { throw new RuntimeError('LEADER_PLAN_INVALID', 'Leader 没有输出可解析的 JSON', 422); }
  const parsed = leaderResultSchema.safeParse(value);
  if (!parsed.success) throw new RuntimeError('LEADER_PLAN_INVALID', `Leader 输出不合规：${parsed.error.issues.map(issue => `${issue.path.join('.')} ${issue.message}`).join('; ')}`, 422);
  return parsed.data;
}

/** Leader 的步骤加上宿主追加的 Leader 验收步骤；验收步骤依赖全部步骤，也是目标的最终产物。 */
export function layeredPlan(result: Extract<LeaderResult, { decision: 'plan' }>, leaderAgentId: string, workerAgentIds: string[], worktree = true): WorkPlan {
  const foreign = result.steps.find(step => !workerAgentIds.includes(step.agentId));
  if (foreign) throw new RuntimeError('LEADER_PLAN_INVALID', `步骤 ${foreign.id} 指派了名单外的 Agent：${foreign.agentId}`, 422);
  const steps = result.steps.map(step => ({ id: step.id, title: step.title, kind: 'agent' as const, agentId: step.agentId, instruction: step.instruction, dependsOn: step.dependsOn, workspaceMode: worktree ? step.workspaceMode : 'shared' as const }));
  const targets = steps.filter(step => !steps.some(other => other.dependsOn.includes(step.id)));
  if (targets.some(step => step.agentId === leaderAgentId)) throw new RuntimeError('LEADER_PLAN_INVALID', '末端执行步骤必须交给与 Leader 不同的 Worker，才能进行独立验收和返修', 422);
  const parsed = workPlanSchema.safeParse({ title: result.title, outputStepId: leaderReviewStepId, steps: [...steps, {
    id: leaderReviewStepId, title: leaderReviewTitle, kind: 'agent', agentId: leaderAgentId, dependsOn: steps.map(step => step.id), workspaceMode: 'shared',
    reviewPolicy: { maxReworkRounds: 2, allowedTargetStepIds: targets.map(step => step.id) },
    instruction: `你是本目标的 Leader，现在验收。对照下面的验收标准逐条核对上游各步骤的产物；需要时只读查看文件，不修改文件，不重做实现。\n验收标准：\n${result.acceptance}\n按宿主的结构化审查格式输出 accept/rework/stop，不能把 Worker 执行完成当作验收通过。feedback 会直接发给用户：第一行写「验收结论：通过」「验收结论：需返修」或「验收结论：缺少信息」之一；然后说明交付物、实际核对的验证证据和遗留问题。需返修时写清目标步骤和修改要求。stop 时接着分三行写「问题：要用户定的事」「建议：你的建议和理由」「不回复时：用户不回复会怎样」。`
  }] });
  if (!parsed.success) throw new RuntimeError('LEADER_PLAN_UNUSABLE', `Leader 计划不合法：${parsed.error.issues.map(issue => issue.message).join('; ')}`, 422);
  return parsed.data;
}

const view = (record: Delegation) => ({ id: record.id, status: record.status, workId: record.workId, ...(record.question ? { question: record.question } : {}), ...(record.error ? { error: record.error } : {}) });

/** 接待 → Leader 交接：Leader 在后台只读规划，Worker 作为目标步骤执行，最后由 Leader 验收。 */
export class LeaderDelegationService {
  private readonly running = new Map<string, Promise<void>>();
  private readonly queue: string[] = [];
  private readonly cleaning = new Map<string, Promise<void>>();
  /** 重启前上一轮 Leader 已经答完的原文，规划时直接沿用，不再问一次。 */
  /** 重启前已完成的规划输出；retried 表示那已经是格式重试的输出，解析失败不再重试。 */
  private readonly adopted = new Map<string, { text: string; retried: boolean }>();
  private readonly shutdown = new AbortController();
  private closed = false;
  private timer?: NodeJS.Timeout;
  constructor(private readonly options: LeaderDelegationOptions) {
    if (!options.repositories.config.compareAndSet || !options.repositories.config.list) throw new Error('Leader delegation requires ConfigRepository CAS and list');
  }
  private get config() { return this.options.repositories.config; }

  async delegate(parentSessionId: string, actorId: string, parentTaskId: string, brief: DelegationBrief) {
    await this.team(parentSessionId, actorId);
    const id = 'delegation_' + hash(JSON.stringify([parentSessionId, actorId, brief.idempotencyKey]));
    const existing = await this.read(id);
    if (existing) return this.replay(existing, brief);
    const workId = workItemId(parentSessionId, actorId, id);
    await this.options.prepareDelivery(parentSessionId, workId, id);
    await createLeaderModeRecord(this.options.repositories, { workId, delegationId: id, parentSessionId, actorId, parentTaskId });
    const record: Delegation = { id, parentSessionId, actorId, parentTaskId, workId, goal: brief.goal, context: brief.context, status: 'planning', createdAt: time(), updatedAt: time() };
    if (!await this.config.compareAndSet!(PREFIX + id, undefined, JSON.stringify(record))) return this.replay((await this.read(id))!, brief);
    this.schedule(id);
    return view(record);
  }

  /** 同一请求键只对应同一份简报；改过的简报要换键，不能静默沿用旧指令。 */
  private replay(existing: Delegation, brief: DelegationBrief) {
    if (existing.goal !== brief.goal || existing.context !== brief.context) throw new RuntimeError('LEADER_DELEGATION_IDEMPOTENCY_CONFLICT', '这个请求键已经用于另一份简报，修改后的简报请换一个 idempotencyKey', 409);
    return view(existing);
  }

  /**
   * 重启打断的规划按账本处理：上一轮已有结果就沿用；提示词可能已送到 Leader 却没有结果的不再重发，记为失败并告知原话题；
   * 确认从未提交的才重新规划。已落盘的计划直接建目标；停机太久的不再替用户执行；未送达的通知补发。
   */
  async start() {
    if (this.closed || this.timer) return;
    let leaderSessions: Session[] | undefined;
    for (const row of await this.config.list!(PREFIX)) {
      const record = JSON.parse(row.value) as Delegation;
      if (record.status !== 'planning') continue;
      const warn = (error: unknown) => this.options.log?.warn({ error, delegationId: record.id }, 'Leader 规划记录更新失败');
      // 过期的记录也要先核对：从未提交的旧规划会话得先停掉，否则它会在没人等结果时自己跑起来。
      let prior: Awaited<ReturnType<LeaderDelegationService['priorPlanning']>> | undefined;
      if (!record.plan) {
        leaderSessions ??= (await this.options.repositories.sessions.list()).filter(session => session.source === 'lark-leader');
        prior = await this.priorPlanning(leaderSessions.filter(session => session.sourceId === record.id)).catch(error => {
          this.options.log?.warn({ error, delegationId: record.id }, '上一轮 Leader 规划核对失败，按结果未知处理');
          return { kind: 'unknown' } as const;
        });
      }
      // 目标已经建好的照常补记状态；还没建的，提交超过 30 分钟就不再执行。
      if (Date.now() - Date.parse(record.createdAt) > RESUME_LIMIT_MS && !(record.plan && await this.options.work.exists(record.workId))) {
        await this.fail(record, '服务重启前没来得及开始，已超过 30 分钟，不再自动执行').catch(warn);
        continue;
      }
      if (prior?.kind === 'unknown') {
        await this.fail(record, '服务重启前已交给 Leader 的规划结果未知，为避免重复执行不再自动重跑').catch(warn);
        continue;
      }
      if (prior?.kind === 'result') this.adopted.set(record.id, { text: prior.text, retried: prior.runs > 1 });
      this.schedule(record.id);
    }
    this.timer = setInterval(() => { void timeLoop('leader-delegation.flush', this.options.log, () => this.flushPending()).catch(() => {}); }, 60_000);
    this.timer.unref();
    await this.flushPending();
  }

  async close() {
    this.closed = true;
    this.shutdown.abort();
    clearInterval(this.timer);
    // Runtime 关闭会打断 Leader 会话；未完成的记录保持 planning，下次启动按账本决定沿用、重跑还是记为失败。
    await Promise.race([Promise.allSettled(this.running.values()), new Promise(resolve => setTimeout(resolve, 1000).unref())]);
  }

  private async read(id: string) {
    const raw = await this.config.get(PREFIX + id);
    return raw ? JSON.parse(raw) as Delegation : undefined;
  }

  private async update(record: Delegation, patch: Partial<Delegation>): Promise<Delegation> {
    const next = { ...record, ...patch, updatedAt: time() };
    if (!await this.config.compareAndSet!(PREFIX + record.id, JSON.stringify(record), JSON.stringify(next))) throw new RuntimeError('LEADER_DELEGATION_CONFLICT', 'Delegation changed concurrently', 409);
    return next;
  }

  /**
   * 重启前同一委派的 Leader 会话。从未提交、还在排队的先停掉，免得重启后没人等结果时自己跑起来；
   * 提示词可能已送到 Leader 的不动，留给人工核对，只有已结算的完成结果可以沿用。
   */
  private async priorPlanning(sessions: Session[]): Promise<{ kind: 'none' } | { kind: 'result'; text: string; runs: number } | { kind: 'unknown' }> {
    const { execution } = this.options.repositories;
    const unsent = (attempt: TaskAttempt) => attempt.submissionState === 'not_submitted' || attempt.state === 'settled' && attempt.settlement?.kind === 'not_submitted';
    let text: string | undefined;
    let runs = 0;
    // 按创建先后看：格式重试的会话在后，最后一份完成的输出才是要用的。
    for (const session of [...sessions].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      const before = execution.getSessionExecutions(session.id);
      if (before.every(item => item.attempts.every(unsent)) && before.some(item => !isTerminalTaskStatus(item.task.status))) {
        await this.options.runtime.stop(session.id, { kind: 'installation_owner', id: 'installation_owner' });
      }
      for (const { task, attempts } of execution.getSessionExecutions(session.id)) {
        if (attempts.every(unsent)) {
          if (isTerminalTaskStatus(task.status)) continue;
          return { kind: 'unknown' };
        }
        const first = attempts.find(attempt => attempt.number === 1);
        const result = task.status === 'completed' && first ? readTaskAttemptResult({ execution }, session.id, task.id, first.attemptId) : undefined;
        if (result?.status !== 'settled' || result.result.outcome !== 'completed') return { kind: 'unknown' };
        text = result.result.output.text;
        runs++;
      }
    }
    return text === undefined ? { kind: 'none' } : { kind: 'result', text, runs };
  }

  /** 按当前 Bot 配置和操作者权限取 Leader 与可用 Worker。 */
  private async team(parentSessionId: string, actorId: string) {
    const session = await this.options.runtime.getSession(parentSessionId);
    const appId = session?.source === 'lark' ? parseLarkSourceId(session.sourceId).appId : undefined;
    const config = appId ? await readLarkConfig(this.config, appId) : undefined;
    if (!session || config?.executionMode !== 'layered' || !config.leaderAgentId) throw new RuntimeError('LEADER_DELEGATION_DISABLED', '当前机器人未开启 Leader 模式', 409);
    const agents = await this.options.runtime.listAgents();
    const usable = async (id: string) => agents.some(agent => agent.id === id) && await this.options.authorizeAgent(parentSessionId, actorId, id);
    if (!await usable(config.leaderAgentId)) throw new RuntimeError('LEADER_DELEGATION_FORBIDDEN', `Leader Agent ${config.leaderAgentId} 不存在或当前操作者无权使用`, 403);
    const leader = agents.find(agent => agent.id === config.leaderAgentId)!;
    // 终端模式没有 deny-all，只能以完全信任规划；机器人（当前配置与父会话）和 Agent 都得是完全信任，验收步骤按父会话与 Agent 中较低的权限运行。
    if (leader.protocol === 'pty-cli' && [larkPermissionMode(config), session.permissionMode, leader.permissionMode].some(mode => mode !== 'full-trust')) throw new RuntimeError('LEADER_DELEGATION_FORBIDDEN', `终端模式 Leader ${leader.id} 需要机器人和该 Agent 都是完全信任`, 403);
    const workers: AgentConfig[] = [];
    for (const id of config.workerAgentIds ?? []) if (await usable(id)) workers.push(agents.find(agent => agent.id === id)!);
    if (!workers.length) throw new RuntimeError('LEADER_DELEGATION_FORBIDDEN', '没有当前操作者可用的 Worker Agent', 403);
    return { session, config, leader, workers };
  }

  /** 规划会话归属的原话题与发起人：风险策略按它们取，与目标子会话一致。 */
  async parentForSession(sessionId: string): Promise<{ parentSessionId: string; actorId: string; parentTaskId: string } | undefined> {
    const session = await this.options.repositories.sessions.get(sessionId);
    const record = session?.source === 'lark-leader' && session.sourceId ? await this.read(session.sourceId) : undefined;
    return record ? { parentSessionId: record.parentSessionId, actorId: record.actorId, parentTaskId: record.parentTaskId } : undefined;
  }

  private schedule(id: string) {
    if (this.closed || this.running.has(id) || this.queue.includes(id)) return;
    this.queue.push(id);
    this.pump();
  }

  /** 规划会话清退前一直占着并发名额；格式重试的会话和前一次的一起算，都清退后才放开。 */
  private holdCleanup(id: string, cleanup: Promise<void>) {
    const held = Promise.all([this.cleaning.get(id), cleanup]).then(() => undefined);
    this.cleaning.set(id, held);
    void held.then(() => { if (this.cleaning.get(id) === held) this.cleaning.delete(id); this.pump(); }, error => {
      this.options.log?.warn({ error, delegationId: id }, 'Leader 规划会话未确认清退，保留并发名额');
    });
  }

  private pump() {
    while (!this.closed && new Set([...this.running.keys(), ...this.cleaning.keys()]).size < MAX_PLANNING && this.queue.length) {
      const id = this.queue.shift()!;
      const run = this.plan(id).catch(error => this.options.log?.warn({ error, delegationId: id }, 'Leader 规划记录更新失败')).finally(() => { this.running.delete(id); this.pump(); });
      this.running.set(id, run);
    }
  }

  /** 规划期间配置可能改了：建目标前按当前名单再核一次，名单外的步骤不执行。 */
  private async checkTeam(record: Delegation) {
    const { leader, workers } = await this.team(record.parentSessionId, record.actorId);
    const stale = record.plan!.steps.find(step => step.id === leaderReviewStepId ? step.agentId !== leader.id : !workers.some(agent => agent.id === step.agentId));
    if (stale) throw new RuntimeError('LEADER_DELEGATION_STALE', `规划期间 Leader 模式配置改了，步骤 ${stale.id} 的 Agent ${stale.agentId} 已不在名单里`, 409);
  }

  /** message 记进 error；notice 是话题里给用户看的话，默认带上 message。 */
  private async fail(record: Delegation, message: string, notice = `Leader 规划失败：${message}\n可以让我直接处理，或补充信息后再交给 Leader。`) {
    record = await this.update(record, { status: 'failed', error: message, notice: { kind: 'failed', text: notice } });
    await this.flush(record);
  }

  /** 送达后才清除通知；失败留给定时补发。不抛错，调用方的状态已经落盘。 */
  private async flush(record: Delegation) {
    if (!record.notice || this.closed) return;
    try {
      if (Date.now() - Date.parse(record.updatedAt) <= NOTICE_RETRY_MS) await this.options.notice(record.workId, record.notice.text, `${record.id}:${record.notice.kind}`);
      else this.options.log?.warn({ delegationId: record.id }, 'Leader 模式通知一小时内未送达，已放弃');
      await this.update(record, { notice: undefined });
    } catch (error) {
      this.options.log?.warn({ error, delegationId: record.id }, 'Leader 模式通知发送失败，稍后重试');
    }
  }

  private async flushPending() {
    for (const row of await this.config.list!(PREFIX)) {
      const record = JSON.parse(row.value) as Delegation;
      if (record.notice && !this.running.has(record.id)) await this.flush(record);
    }
  }

  private async plan(id: string) {
    let record = await this.read(id);
    if (!record || record.status !== 'planning') return;
    try {
      if (!record.plan) {
        const { session, config, leader, workers } = await this.team(record.parentSessionId, record.actorId);
        const worktree = await gitRepository(session.cwd);
        const adopted = this.adopted.get(id);
        this.adopted.delete(id);
        // 指引取不到时这次规划失败并告知原话题，不退回内置规则。接手重启前的输出时只在要重试时才取。
        let judgement: { rules: string; ledger: string } | undefined;
        const current = record;
        const prompt = async () => leaderPrompt(current, workers, worktree, judgement ??= { rules: leaderRules(await resolveLeaderGuide(session, config.leaderSkill, this.options.homeDirectory)), ledger: await leaderLedger(this.options.repositories, current) });
        const timeoutMs = this.options.timeoutMs ?? PLANNING_TIMEOUT_MS;
        const run = (input: string) => runReadonlyPrompt(this.options.runtime, { execution: this.options.repositories.execution }, {
          // 终端模式 Leader 以完全信任规划（team() 已核对），「不改文件」只靠提示词约束。
          agentId: leader.id, cwd: session.cwd, permissionMode: leader.protocol === 'pty-cli' ? 'full-trust' : 'deny-all', source: 'lark-leader', sourceId: current.id,
          prompt: input, timeoutMs, signal: this.shutdown.signal, onCleanup: cleanup => this.holdCleanup(id, cleanup)
        });
        let text = adopted?.text ?? await run(await prompt());
        if (this.closed) return;
        let result: LeaderResult;
        try { result = parseLeaderResult(text); }
        catch (error) {
          // 输出不合规只重试一次，按同样的结论改格式；目标在解析成功后才建，重试不会重复建。
          const retried = (again: unknown) => new RuntimeError('LEADER_PLAN_FORMAT', `重试后仍不合规：${errorText(again)}`, 422);
          if (adopted?.retried) throw retried(error);
          text = await run(leaderFormatRetryPrompt(await prompt(), error, text));
          if (this.closed) return;
          try { result = parseLeaderResult(text); }
          catch (again) { throw retried(again); }
        }
        if (result.decision === 'needs_context') {
          record = await this.update(record, { status: 'needs_context', question: result.question, notice: { kind: 'needs_context', text: `Leader 需要补充信息：${result.question}\n补充后在本话题 @我，我会带上新信息重新交给 Leader。` } });
          await this.flush(record);
          return;
        }
        record = await this.update(record, { plan: layeredPlan(result, leader.id, workers.map(agent => agent.id), worktree) });
      }
      // 目标已经建好（上次在回写状态前中断）就只补记状态：父会话停了或操作者失去权限时再建会被拒，不能报成规划失败。
      if (!await this.options.work.exists(record.workId)) {
        await this.checkTeam(record);
        const goal = record.context ? `${record.goal}\n\n背景（接待整理）：\n${record.context}` : record.goal;
        await this.options.work.create(record.parentSessionId, { goal, plan: record.plan!, idempotencyKey: record.id }, record.actorId, undefined, record.parentTaskId);
      }
    } catch (error) {
      if (this.closed) return;
      const code = error instanceof RuntimeError ? error.code : undefined;
      if (code === 'COLLABORATION_DECISION_TIMEOUT') { await this.fail(record, 'Leader 规划超时'); return; }
      // 解析错误、计划校验和运行错误用户看不懂：话题里说白话，技术原因留在日志和记录的 error。
      const plain = code === 'LEADER_PLAN_FORMAT' ? 'Leader 这次没给出可用的计划（输出格式不对，已重试一次）。'
        : code === 'LEADER_PLAN_UNUSABLE' ? 'Leader 这次的计划不能用（步骤安排不符合要求）。'
        : code === undefined || code.startsWith('COLLABORATION_DECISION_') ? 'Leader 这次没能完成规划（运行出错）。' : undefined;
      if (plain) {
        this.options.log?.warn({ error, delegationId: record.id }, code === 'LEADER_PLAN_FORMAT' ? 'Leader 规划输出不合规，重试后仍不合规' : 'Leader 规划失败');
        await this.fail(record, errorText(error).slice(0, 500), `${plain}请在本话题 @我 重新发起。`);
        return;
      }
      await this.fail(record, errorText(error).slice(0, 500));
      return;
    }
    // 目标已经建好（群聊里等人点「开始执行」），这里写失败只记日志、记录留在 planning，下次启动补记，不报成规划失败。
    await this.update(record, { status: 'started' });
  }
}
