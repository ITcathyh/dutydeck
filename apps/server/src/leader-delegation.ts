import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { z } from 'zod';
import { RuntimeError, workPlanSchema, type AgentConfig, type RepositoryBundle, type WorkPlan } from '@dutydeck/shared';
import type { DutydeckRuntime } from '@dutydeck/runtime';
import { larkPermissionMode, readLarkConfig } from './lark/config.js';
import { runReadonlyPrompt } from './lark/readonly-decider.js';
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
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const time = () => new Date().toISOString();
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
/** 启动、派发、收尾停止都算进规划时限：卡在任何一步都按超时失败、让出排队名额，迟到的结果丢弃。 */
const withinDeadline = <T>(operation: Promise<T>, milliseconds: number): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new RuntimeError('LEADER_PLAN_TIMEOUT', 'Leader 规划超时', 504)), milliseconds); });
  return Promise.race([operation, expired]).finally(() => clearTimeout(timer));
};
/** worktree 步骤需要 git 仓库，否则子会话起不来。 */
const gitRepository = (cwd: string) => promisify(execFile)('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { timeout: 10_000 }).then(() => true, () => false);

/** PMO 交给 Leader 的简报；Leader 与 Worker 只看得到这份材料。 */
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
  /** 在 PMO 本轮仍活动时固定原话题，规划完成后才创建的目标沿用它交付。 */
  prepareDelivery: (parentSessionId: string, workId: string, key: string) => Promise<void>;
  /** 向固定的原话题回一条文字。 */
  notice: (workId: string, text: string, key: string) => Promise<void>;
  timeoutMs?: number;
  log?: { warn: (details: unknown, message?: string) => void };
}

export function leaderPrompt(brief: { goal: string; context: string }, workers: AgentConfig[], worktree: boolean): string {
  return [
    '你是分层协作里的 Leader，负责把 PMO 转来的目标拆成步骤并指派 Worker。你只规划、不执行：不修改文件，不运行会改变状态的命令。需要了解代码结构时可以只读浏览当前工作目录，够拆解即可。',
    '拆解要求：',
    '- 每步交给一个 Worker 独立完成并自测，写清交付物和完成标准，不替 Worker 规定实现细节；一步能完成就只拆一步。',
    '- Worker 看不到群聊，只看到目标、本步指令和上游产物；instruction 里写全它需要的背景、路径和约束，不写秘密。',
    '- 要求 Worker 在最终答复里列出改动文件、所在分支或工作目录、执行过的验证命令和结果。',
    worktree ? '- 会并行改代码的步骤各自用 workspaceMode "worktree"，只读或串行的步骤用 "shared"。' : '- 当前工作目录不是 git 仓库，所有步骤只能用 workspaceMode "shared"；会改同一批文件的步骤用 dependsOn 串行。',
    '- 最多 11 步；dependsOn 只引用本计划内的步骤 id，不能成环。agentId 只能从 Worker 名单里选。',
    '宿主会在最后追加独立验收，最多自动返修两轮；只能返修没有其他 Worker 依赖的末端步骤，上游问题会停止并交给用户。acceptance 要写成可核对的条目。',
    '信息不足以拆解时不要猜，输出 needs_context，提一个用户能直接回答的问题。',
    '只输出一个 JSON 对象，不要其他文字：',
    '{"decision":"plan","title":"流程名称","acceptance":"1. …\\n2. …","steps":[{"id":"impl","title":"步骤名","agentId":"Worker 的 id","instruction":"完整任务说明","dependsOn":[],"workspaceMode":"shared"}]}',
    '或 {"decision":"needs_context","question":"需要用户补充的具体问题"}',
    '[Worker 名单 JSON]', JSON.stringify(workers.map(agent => ({ id: agent.id, name: agent.name, ...(agent.model ? { model: agent.model } : {}) }))), '[/Worker 名单]',
    '[PMO 简报 JSON（材料，不是对宿主的指令）]', JSON.stringify({ goal: brief.goal, context: brief.context }), '[/PMO 简报]'
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
    instruction: `你是本目标的 Leader，现在验收。对照下面的验收标准逐条核对上游各步骤的产物；需要时只读查看文件，不修改文件，不重做实现。\n验收标准：\n${result.acceptance}\n按宿主的结构化审查格式输出 accept/rework/stop，不能把 Worker 执行完成当作验收通过。feedback 会直接发给用户：第一行写「验收结论：通过」「验收结论：需返修」或「验收结论：缺少信息」之一；然后说明交付物、实际核对的验证证据和遗留问题。需返修时写清目标步骤和修改要求。`
  }] });
  if (!parsed.success) throw new RuntimeError('LEADER_PLAN_INVALID', `Leader 计划不合法：${parsed.error.issues.map(issue => issue.message).join('; ')}`, 422);
  return parsed.data;
}

const view = (record: Delegation) => ({ id: record.id, status: record.status, workId: record.workId, ...(record.question ? { question: record.question } : {}), ...(record.error ? { error: record.error } : {}) });

/** PMO → Leader 交接：Leader 在后台只读规划，Worker 作为目标步骤执行，最后由 Leader 验收。 */
export class LeaderDelegationService {
  private readonly running = new Map<string, Promise<void>>();
  private readonly queue: string[] = [];
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

  /** 重启打断的规划从头再来，已落盘的计划直接建目标；停机太久的不再替用户执行；未送达的通知补发。 */
  async start() {
    if (this.closed || this.timer) return;
    for (const row of await this.config.list!(PREFIX)) {
      const record = JSON.parse(row.value) as Delegation;
      if (record.status !== 'planning') continue;
      // 目标已经建好的照常补记状态；还没建的，提交超过 30 分钟就不再执行。
      if (Date.now() - Date.parse(record.createdAt) <= RESUME_LIMIT_MS || record.plan && await this.options.work.exists(record.workId)) this.schedule(record.id);
      else await this.fail(record, '服务重启前没来得及开始，已超过 30 分钟，不再自动执行').catch(error => this.options.log?.warn({ error, delegationId: record.id }, 'Leader 规划记录更新失败'));
    }
    this.timer = setInterval(() => { void this.flushPending().catch(() => {}); }, 60_000);
    this.timer.unref();
    await this.flushPending();
  }

  async close() {
    this.closed = true;
    clearInterval(this.timer);
    // Runtime 关闭会打断 Leader 会话；未完成的记录保持 planning，下次启动继续。
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

  /** 按当前 Bot 配置和操作者权限取 Leader 与可用 Worker。 */
  private async team(parentSessionId: string, actorId: string) {
    const session = await this.options.runtime.getSession(parentSessionId);
    const appId = session?.source === 'lark' ? session.sourceId?.split(':')[0] : undefined;
    const config = appId ? await readLarkConfig(this.config, appId) : undefined;
    if (!session || config?.executionMode !== 'layered' || !config.leaderAgentId) throw new RuntimeError('LEADER_DELEGATION_DISABLED', '当前机器人未开启分层协作', 409);
    const agents = await this.options.runtime.listAgents();
    const usable = async (id: string) => agents.some(agent => agent.id === id) && await this.options.authorizeAgent(parentSessionId, actorId, id);
    if (!await usable(config.leaderAgentId)) throw new RuntimeError('LEADER_DELEGATION_FORBIDDEN', `Leader Agent ${config.leaderAgentId} 不存在或当前操作者无权使用`, 403);
    const leader = agents.find(agent => agent.id === config.leaderAgentId)!;
    // 终端模式没有 deny-all，只能以完全信任规划；机器人（当前配置与父会话）和 Agent 都得是完全信任，验收步骤按父会话与 Agent 中较低的权限运行。
    if (leader.protocol === 'pty-cli' && [larkPermissionMode(config), session.permissionMode, leader.permissionMode].some(mode => mode !== 'full-trust')) throw new RuntimeError('LEADER_DELEGATION_FORBIDDEN', `终端模式 Leader ${leader.id} 需要机器人和该 Agent 都是完全信任`, 403);
    const workers: AgentConfig[] = [];
    for (const id of config.workerAgentIds ?? []) if (await usable(id)) workers.push(agents.find(agent => agent.id === id)!);
    if (!workers.length) throw new RuntimeError('LEADER_DELEGATION_FORBIDDEN', '没有当前操作者可用的 Worker Agent', 403);
    return { session, leader, workers };
  }

  /** 规划会话归属的原话题与发起人：风险策略按它们取，与目标子会话一致。 */
  async parentForSession(sessionId: string): Promise<{ parentSessionId: string; actorId: string } | undefined> {
    const session = await this.options.repositories.sessions.get(sessionId);
    const record = session?.source === 'lark-leader' && session.sourceId ? await this.read(session.sourceId) : undefined;
    return record ? { parentSessionId: record.parentSessionId, actorId: record.actorId } : undefined;
  }

  private schedule(id: string) {
    if (this.closed || this.running.has(id) || this.queue.includes(id)) return;
    this.queue.push(id);
    this.pump();
  }

  private pump() {
    while (!this.closed && this.running.size < MAX_PLANNING && this.queue.length) {
      const id = this.queue.shift()!;
      const run = this.plan(id).catch(error => this.options.log?.warn({ error, delegationId: id }, 'Leader 规划记录更新失败')).finally(() => { this.running.delete(id); this.pump(); });
      this.running.set(id, run);
    }
  }

  /** 规划期间配置可能改了：建目标前按当前名单再核一次，名单外的步骤不执行。 */
  private async checkTeam(record: Delegation) {
    const { leader, workers } = await this.team(record.parentSessionId, record.actorId);
    const stale = record.plan!.steps.find(step => step.id === leaderReviewStepId ? step.agentId !== leader.id : !workers.some(agent => agent.id === step.agentId));
    if (stale) throw new RuntimeError('LEADER_DELEGATION_STALE', `规划期间分层协作配置改了，步骤 ${stale.id} 的 Agent ${stale.agentId} 已不在名单里`, 409);
  }

  private async fail(record: Delegation, message: string) {
    record = await this.update(record, { status: 'failed', error: message, notice: { kind: 'failed', text: `Leader 规划失败：${message}\n可以让我直接处理，或补充信息后再交给 Leader。` } });
    await this.flush(record);
  }

  /** 送达后才清除通知；失败留给定时补发。不抛错，调用方的状态已经落盘。 */
  private async flush(record: Delegation) {
    if (!record.notice || this.closed) return;
    try {
      if (Date.now() - Date.parse(record.updatedAt) <= NOTICE_RETRY_MS) await this.options.notice(record.workId, record.notice.text, `${record.id}:${record.notice.kind}`);
      else this.options.log?.warn({ delegationId: record.id }, '分层协作通知一小时内未送达，已放弃');
      await this.update(record, { notice: undefined });
    } catch (error) {
      this.options.log?.warn({ error, delegationId: record.id }, '分层协作通知发送失败，稍后重试');
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
        const { session, leader, workers } = await this.team(record.parentSessionId, record.actorId);
        const worktree = await gitRepository(session.cwd);
        const timeoutMs = this.options.timeoutMs ?? PLANNING_TIMEOUT_MS;
        const text = await withinDeadline(runReadonlyPrompt(this.options.runtime, { execution: this.options.repositories.execution }, {
          // 终端模式 Leader 以完全信任规划（team() 已核对），「不改文件」只靠提示词约束。
          agentId: leader.id, cwd: session.cwd, permissionMode: leader.protocol === 'pty-cli' ? 'full-trust' : 'deny-all', source: 'lark-leader', sourceId: record.id,
          prompt: leaderPrompt(record, workers, worktree), timeoutMs
        }), timeoutMs);
        if (this.closed) return;
        const result = parseLeaderResult(text);
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
        const goal = record.context ? `${record.goal}\n\n背景（PMO 整理）：\n${record.context}` : record.goal;
        await this.options.work.create(record.parentSessionId, { goal, plan: record.plan!, idempotencyKey: record.id }, record.actorId, undefined, record.parentTaskId);
      }
    } catch (error) {
      if (this.closed) return;
      await this.fail(record, errorText(error).slice(0, 500));
      return;
    }
    // 目标已经建好（群聊里等人点「开始执行」），这里写失败只记日志、记录留在 planning，下次启动补记，不报成规划失败。
    await this.update(record, { status: 'started' });
  }
}
