import { createHash } from 'node:crypto';
import { createWorkbenchFetch } from '../workbench-fetch.js';
import { RuntimeError, type AcceptedTask, type RepositoryBundle, type WorkItem, type WorkPlan } from '@dutydeck/shared';
import type { DutydeckRuntime } from '@dutydeck/runtime';
import type { WorkItemService } from '../work-items.js';
import { leaderReviewStepId, leaderReviewTitle } from '../leader-delegation.js';
import type { WorkItemInteractions, WorkItemRequest } from '../work-item-interactions.js';
import { readLarkConfig, type StoredLarkConfig } from './config.js';
import { createLarkCardService, type LarkCardService } from './service.js';
import { patchLarkCard, sendLarkResult } from './result-delivery.js';
import type { LarkMessageEvent } from './listener.js';
import type { PersistedLarkCardTask } from './coordinator.js';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const originKey = (sessionId: string, key: string) => `workbench.origin.${digest(`${sessionId}\0${key}`)}`;
interface Target { appId: string; chatId: string; replyMessageId: string; replyInThread: boolean }
const labels: Record<string, string> = { awaiting_confirmation: '待确认', pending: '待执行', running: '执行中', waiting: '待你补充', completed: '已完成', failed: '执行失败', blocked: '需要处理', cancelling: '正在停止', cancelled: '已取消', skipped: '已跳过' };

// 只有这些焦点态允许触发新消息；running/pending 等正常流转只允许 PATCH。
// completed 不在此列：目标完成卡走独立的 deliver 通道，notify 对 completed 直接跳过。
const focusStatuses = new Set(['awaiting_confirmation', 'waiting', 'blocked', 'failed']);
const focusOf = (status: string) => focusStatuses.has(status) ? status : '';

/**
 * N2 缺陷守卫：亮屏指纹只包含焦点态（waiting/blocked/failed）与待决请求身份，
 * 不含 running/completed 等正常流转状态与错误全文。running→completed、错误文案变化
 * 都必须得到同一指纹，从而只 PATCH 不推新卡；进入 waiting / 新待决请求才换新指纹。
 */
export function workNoticeFingerprint(item: WorkItem, requests: WorkItemRequest[] = []) {
  return digest(JSON.stringify([
    focusOf(item.status),
    item.steps.map(step => [step.id, focusOf(step.status)]),
    requests.map(request => [request.stepId, request.requestId, request.kind])
  ]));
}

function workHasFocus(item: WorkItem, requests: WorkItemRequest[]) {
  return focusStatuses.has(item.status)
    || item.steps.some(step => focusStatuses.has(step.status))
    || requests.length > 0;
}

/**
 * 亮屏剧集键的取值。终态 `sent` / `patched` 一旦写下就永不重抢，重试不会把已经发出的卡再发一遍。
 * 两个可重抢的中间态都带「第几次尝试 + 什么时候可以再抢」：
 *   sending:<次数>:<租约到期>  已认领、发送在途。租约是崩溃护栏——守护进程在认领与发送之间
 *                              退出时，键不会永久停在「在途」把待确认闸门静默掉。
 *   failed:<次数>:<可重试时刻> 发送真的失败了。退避后下一轮心跳重抢重发。
 * 预览卡本身就是那道人工闸门，静默丢掉它比多发一张卡更糟；但 1 秒心跳会重入 notify，
 * 所以重试必须退避，不能把一次发送失败放大成每秒一次的飞书请求。
 */
const NOTICE_SEND_LEASE_MS = 30_000;
const NOTICE_RETRY_BASE_MS = 2_000;
const NOTICE_RETRY_MAX_MS = 60_000;
const noticeSending = (attempts: number, now: number) => `sending:${attempts}:${now + NOTICE_SEND_LEASE_MS}`;
const noticeRetry = (attempts: number, now: number) =>
  `failed:${attempts}:${now + Math.min(NOTICE_RETRY_MAX_MS, NOTICE_RETRY_BASE_MS * 2 ** (attempts - 1))}`;
const parseNoticeClaim = (value: string | undefined) => {
  const match = /^(?:sending|failed):(\d+):(\d+)$/.exec(value ?? '');
  return match ? { attempts: Number(match[1]), readyAt: Number(match[2]) } : undefined;
};

export interface WorkItemElementOptions {
  /** agentId → 显示名（来自 runtime.listAgents）；缺失或与 id 相同则只显示 agentId。 */
  agentNames?: Record<string, string>;
}

/**
 * 验收状态标签：
 * 1. 有 reviewPolicy 时以持久结构化 review 结果为准，已完成的目标仅在 accept 时使用默认完成标签，否则显示「验收待核对」；未完成的目标沿用当前状态。
 * 2. 无 reviewPolicy 的历史分层协作目标按输出文本推断：匹配末尾「验收结论：通过/需返修/缺少信息」，未通过或无法识别时显示对应核对提示。
 */
export function reviewStatusLabel(item: WorkItem): string | undefined {
  if (item.status !== 'completed') return undefined;
  const output = item.plan.steps.find(step => step.id === item.plan.outputStepId);
  if (output?.reviewPolicy) {
    const step = item.steps.find(s => s.id === item.plan.outputStepId);
    const lastAttempt = step?.attempts.at(-1);
    return lastAttempt?.review?.decision === 'accept' ? undefined : '验收待核对';
  }
  if (output?.id !== leaderReviewStepId || output.title !== leaderReviewTitle) return undefined;
  const verdict = [...(item.output?.text ?? '').matchAll(/^[ \t]*验收结论：\s*(通过|需返修|缺少信息)/gm)].at(-1)?.[1];
  return verdict === '通过' ? undefined : `验收${verdict ?? '待核对'}`;
}

export const larkConsultUsage = '用法：/work consult [--agents A,B] -- <问题> 或 /work consult <问题>';

export function parseLarkConsultCommand(input: string, allowedAgents?: string[]): { goal: string; agents?: [string, string] } {
  const body = input.trim();
  if (!body) throw new RuntimeError('WORK_ITEM_GOAL_REQUIRED', larkConsultUsage, 400);
  if (!body.startsWith('--')) return { goal: body };

  let remaining = body;
  let agents: [string, string] | undefined;
  const invalid = (msg?: string) => new RuntimeError('WORK_ITEM_CONSULT_USAGE', msg ?? larkConsultUsage, 400);
  const token = () => {
    const match = /^(?:"([^"]*)"|'([^']*)'|([^\s"']+))(?=\s|$)/u.exec(remaining);
    if (!match) throw invalid();
    remaining = remaining.slice(match[0].length).trimStart();
    return match[1] ?? match[2] ?? match[3]!;
  };

  while (remaining) {
    const flag = token();
    if (flag === '--') {
      const goal = remaining.trim();
      if (!goal) throw new RuntimeError('WORK_ITEM_GOAL_REQUIRED', larkConsultUsage, 400);
      return { goal, ...(agents ? { agents } : {}) };
    }
    if (flag === '--agents') {
      if (agents !== undefined) throw invalid('重复指定了 --agents 选项');
      if (!remaining) throw invalid();
      const rawVal = token();
      if (!rawVal.trim() || rawVal.startsWith('--')) throw invalid();
      const parts = rawVal.split(',').map(s => s.trim()).filter(Boolean);
      if (parts.length !== 2) {
        throw new RuntimeError('WORK_ITEM_CONSULT_AGENTS_INVALID', '--agents 必须指定两个逗号分隔的 Agent 编号，如 --agents A,B', 400);
      }
      if (parts[0] === parts[1]) {
        throw new RuntimeError('WORK_ITEM_CONSULT_AGENTS_DUPLICATE', '会诊需要指定两个不同的 Agent', 400);
      }
      const agentPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
      if (!agentPattern.test(parts[0]!) || !agentPattern.test(parts[1]!)) {
        throw new RuntimeError('WORK_ITEM_CONSULT_AGENTS_INVALID', 'Agent 编号格式不正确', 400);
      }
      if (allowedAgents) {
        if (!allowedAgents.includes(parts[0]!)) {
          throw new RuntimeError('WORK_ITEM_AGENT_NOT_FOUND', `Agent「${parts[0]}」不存在或不可用`, 404);
        }
        if (!allowedAgents.includes(parts[1]!)) {
          throw new RuntimeError('WORK_ITEM_AGENT_NOT_FOUND', `Agent「${parts[1]}」不存在或不可用`, 404);
        }
      }
      agents = [parts[0]!, parts[1]!];
    } else {
      throw invalid(`未知选项：${flag}。${larkConsultUsage}`);
    }
  }
  throw invalid();
}

export function consultWorkPlan(agents: [string, string]): WorkPlan {
  if (agents.length < 2 || !agents[0] || !agents[1]) {
    throw new RuntimeError('WORK_ITEM_CONSULT_AGENTS_REQUIRED', '会诊需要提供两个 Agent', 400);
  }
  if (agents[0] === agents[1]) {
    throw new RuntimeError('WORK_ITEM_CONSULT_AGENTS_DUPLICATE', '会诊需要指定两个不同的 Agent', 400);
  }
  return {
    title: '多 Agent 会诊',
    outputStepId: 'merge',
    steps: [
      {
        id: 'a',
        title: '独立调查（A）',
        kind: 'agent',
        agentId: agents[0],
        instruction: '围绕目标问题独立调查，输出结论和关键证据。明确未验证的事实，最终回答须包含完整调查结果。',
        dependsOn: [],
        workspaceMode: 'shared'
      },
      {
        id: 'b',
        title: '独立调查（B）',
        kind: 'agent',
        agentId: agents[1],
        instruction: '围绕同一个问题独立调查，与其它调查并行且互不依赖，不参考其它步骤的输出。输出结论和关键证据，明确未验证的事实，最终回答须包含完整调查结果。',
        dependsOn: [],
        workspaceMode: 'shared'
      },
      {
        id: 'merge',
        title: '合并会诊结论',
        kind: 'agent',
        agentId: agents[0],
        instruction: '综合两个独立步骤的成果，读取两份结果，输出一份合并结论。结构固定为：\n1. 一句话结论；\n2. 一致点；\n3. 分歧点（每条写出双方的说法和各自的证据，能判断谁更可信就说明理由）；\n4. 建议下一步。\n\n最终回答须严格按此结构输出完整合并报告。',
        dependsOn: ['a', 'b'],
        workspaceMode: 'shared'
      }
    ]
  };
}

export function resolveConsultAgents(
  requestedAgents: [string, string] | undefined,
  allowedAgents: string[],
  defaultAgentId?: string
): { chosen?: [string, string]; unavailableReason?: string } {
  if (allowedAgents.length < 2) {
    return { unavailableReason: '当前可用 Agent 不足两个，无法发起多 Agent 会诊。' };
  }

  if (requestedAgents) {
    const [agentA, agentB] = requestedAgents;
    if (agentA === agentB) {
      throw new RuntimeError('WORK_ITEM_CONSULT_AGENTS_DUPLICATE', '会诊需要指定两个不同的 Agent', 400);
    }
    if (!allowedAgents.includes(agentA)) {
      throw new RuntimeError('WORK_ITEM_AGENT_NOT_FOUND', `Agent「${agentA}」不存在或不可用`, 404);
    }
    if (!allowedAgents.includes(agentB)) {
      throw new RuntimeError('WORK_ITEM_AGENT_NOT_FOUND', `Agent「${agentB}」不存在或不可用`, 404);
    }
    return { chosen: [agentA, agentB] };
  }

  const agentA = defaultAgentId && allowedAgents.includes(defaultAgentId) ? defaultAgentId : undefined;
  if (!agentA) {
    return { unavailableReason: '当前机器人未配置有效默认 Agent，无法发起多 Agent 会诊。' };
  }

  const agentB = allowedAgents.find(id => id !== agentA);
  if (!agentB) {
    return { unavailableReason: '当前可用 Agent 不足两个，无法发起多 Agent 会诊。' };
  }

  return { chosen: [agentA, agentB] };
}

export function researchWorkPlan(agents: string[]): WorkPlan {
  if (!agents.length) throw new RuntimeError('WORK_ITEM_NO_AGENT', '请先配置一个 Agent', 409);
  return {
    title: '研究与交叉核查', outputStepId: 'report', steps: [
      { id: 'research', title: '调研事实与可行方案', kind: 'agent', agentId: agents[0], instruction: '围绕目标独立研究，列出方案、证据与来源。只阅读和分析，明确未验证的事实；最终回答须包含完整研究结果。', dependsOn: [], workspaceMode: 'shared' },
      { id: 'challenge', title: '独立核查与风险分析', kind: 'agent', agentId: agents[1] ?? agents[0], instruction: '独立核查目标中的假设，研究替代方案、风险与反例。只阅读和分析，提供可核查来源，最终回答须包含完整结果。', dependsOn: [], workspaceMode: 'shared' },
      { id: 'report', title: '比较证据并交付报告', kind: 'agent', agentId: agents[2] ?? agents[0], instruction: '综合两个独立步骤的成果，解释分歧，给出有证据的结论和可执行建议。保留来源和验证限制，输出完整报告。若目标要求写入指定文档，仅在有相应工具与授权时写入并返回链接；写入失败需明确说明。', dependsOn: ['research', 'challenge'], workspaceMode: 'shared' }
    ]
  };
}

/**
 * 人手发起的编排：每个分号段落是一个并行步骤，最后自动追加一步汇总。
 * 步数上限交给 workPlanSchema（最多 12 步），这里只在用户侧先给出可读的报错。
 */
export function composeWorkPlan(segments: string[], agents: string[]): WorkPlan {
  if (!agents.length) throw new RuntimeError('WORK_ITEM_NO_AGENT', '请先配置一个 Agent', 409);
  if (segments.length < 2) throw new RuntimeError('WORK_ITEM_PLAN_STEPS_REQUIRED', '用法：`/work plan 第一步；第二步`。用「；」分隔要分头推进的步骤，汇总步骤会自动追加。', 400);
  if (segments.length > 11) throw new RuntimeError('WORK_ITEM_PLAN_TOO_MANY', '最多 11 个分头步骤，汇总步骤会自动追加。', 400);
  // 步骤指令要留出下面追加的提示；超长在这里说清楚，别让 workPlanSchema 抛出整串校验 JSON。
  if (segments.some(value => value.length > 30_000)) throw new RuntimeError('WORK_ITEM_PLAN_STEP_TOO_LONG', '单个步骤描述过长，请拆短后重试。', 400);
  // 按码点截断，避免 emoji 被切成半个代理项。
  const title = (value: string) => [...value].slice(0, 40).join('');
  const steps = segments.map((instruction, index) => ({
    id: `step${index + 1}`, title: title(instruction), kind: 'agent' as const, agentId: agents[index % agents.length]!,
    instruction: `${instruction}\n\n只完成这一步，输出完整成果与可核查来源，明确未验证的部分。本步与其它步骤并行运行且共用同一工作区，不要同时改动同一批文件。`,
    dependsOn: [] as string[], workspaceMode: 'shared' as const
  }));
  return {
    title: title(segments[0]!), outputStepId: 'report',
    steps: [...steps, { id: 'report', title: '汇总并交付', kind: 'agent', agentId: agents[0]!, dependsOn: steps.map(step => step.id), workspaceMode: 'shared',
      instruction: '综合上游各步骤的成果，解释分歧，输出完整可交付结论。保留来源与未验证之处。' }]
  };
}

export function workItemElements(item: WorkItem, requests: WorkItemRequest[] = [], options: WorkItemElementOptions = {}) {
  const action = (operation: string, label: string, extra = {}) => ({
    tag: 'button', text: { tag: 'plain_text', content: label }, type: ['show', 'confirm'].includes(operation) ? 'primary' : 'default',
    behaviors: [{ type: 'callback', value: { dutydeck_work_item: operation, work_id: item.id, parent_session_id: item.parentSessionId, revision: item.revision, ...extra } }]
  });
  // S5：卡面显示 agent 名称而不是裸 agentId；名称与 id 不同时把 id 留作灰色副文案，便于排查。
  const agentLine = (agentId?: string) => {
    if (!agentId) return '';
    const name = options.agentNames?.[agentId]?.trim();
    return name && name !== agentId ? ` · ${name}（${agentId}）` : ` · ${agentId}`;
  };
  // JSON 2.0 表单：输入框 + 提交按钮，路由字段在按钮 value 里，回答文本经 event.action.form_value 落回
  // （listener 侧合入接线见集成清单）；卡片同时保留文字命令兜底，未接线时命令仍可用。
  const answerForm = (name: string, placeholder: string, submitLabel: string, value: Record<string, unknown>) => ({
    tag: 'form', name, direction: 'vertical', vertical_spacing: '8px', margin: '4px 0px', elements: [
      { tag: 'input', name: 'answer', required: true, width: 'fill', placeholder: { tag: 'plain_text', content: placeholder } },
      { tag: 'button', name: `${name}_submit`, type: 'primary', text: { tag: 'plain_text', content: submitLabel },
        form_action_type: 'submit', behaviors: [{ type: 'callback', value }] }
    ]
  });
  const elements: Array<Record<string, any>> = [
    { tag: 'markdown', content: `**${reviewStatusLabel(item) ?? labels[item.status] ?? item.status} · ${item.title}**\n\n${item.goal.slice(0, 2000)}` }
  ];
  // 闸门：确认前只展示计划本身（分工、依赖、工作区），不展示执行期的重试/回答入口。
  if (item.status === 'awaiting_confirmation') {
    const titles = new Map(item.plan.steps.map(definition => [definition.id, definition.title]));
    elements.push({ tag: 'markdown', content: '以下步骤尚未开始执行，确认后才会派发。' });
    item.plan.steps.forEach((definition, index) => {
      const facts = [
        ...(definition.kind === 'wait' ? ['等待你补充'] : [agentLine(definition.agentId).replace(/^ · /, ''), definition.workspaceMode === 'worktree' ? '独立 worktree' : '共享工作区']),
        definition.dependsOn.length ? `依赖：${definition.dependsOn.map(id => titles.get(id) ?? id).join('、')}` : '无依赖',
        ...(definition.when ? [`仅当「${titles.get(definition.when.stepId) ?? definition.when.stepId}」回答「${definition.when.equals}」`] : [])
      ];
      elements.push({ tag: 'markdown', content: `**${index + 1}. ${definition.title}**\n${facts.join(' · ')}\n${definition.instruction.slice(0, 600)}` });
    });
    elements.push(action('confirm', '开始执行'), action('cancel', '取消计划'), action('show', '刷新目标'));
    return elements;
  }
  for (const step of item.steps) {
    const definition = item.plan.steps.find(value => value.id === step.id)!;
    const attempt = step.attempts.at(-1);
    elements.push({ tag: 'markdown', content: `**${labels[step.status]} · ${definition.title}**${agentLine(definition.agentId)}\n${attempt?.error?.slice(0, 1200) ?? ''}${step.status === 'waiting' ? `\n${definition.instruction}\n\n回复：\`/work answer ${item.id} ${step.id} 你的回答\`` : ''}` });
    if (step.status === 'running') elements.push({ tag: 'markdown', content: `如 CLI 等待终端确认：\`/work terminal ${item.id} ${step.id}\`` });
    if (step.status === 'waiting') elements.push(
      answerForm(`work_answer_${item.id}_${step.id}`, '输入回答内容', `提交回答：${definition.title}`,
        { dutydeck_work_item: 'answer', work_id: item.id, parent_session_id: item.parentSessionId, revision: item.revision, step_id: step.id }),
      action('retry', `重试：${definition.title}`, { step_id: step.id }));
    if (step.status === 'failed' && item.status === 'failed') elements.push(action('retry', `重试：${definition.title}`, { step_id: step.id }));
  }
  for (const request of requests) {
    elements.push({ tag: 'markdown', content: `**${request.kind === 'permission' ? '工具授权' : 'Agent 提问'} · ${request.stepId}**\n${request.text.slice(0, 4000)}` });
    const extra = { step_id: request.stepId, request_id: request.requestId, task_id: request.taskId, request_kind: request.kind };
    if (request.kind === 'permission') elements.push(action('respond', '批准本次调用', { ...extra, answer: 'approve' }), action('respond', '拒绝本次调用', { ...extra, answer: 'reject' }));
    else {
      elements.push({ tag: 'markdown', content: `回复：\`/work respond ${item.id} ${request.stepId} ${request.requestId} 你的回答\`` });
      elements.push(answerForm(`work_respond_${item.id}_${request.stepId}_${request.requestId}`, '输入回答内容', '提交回答',
        { dutydeck_work_item: 'respond', work_id: item.id, parent_session_id: item.parentSessionId, revision: item.revision, ...extra }));
    }
  }
  if (item.error) elements.push({ tag: 'markdown', content: item.error.slice(0, 2000) });
  if (item.output) elements.push({ tag: 'markdown', element_id: 'final_output', content: item.output.text });
  elements.push(action('show', '刷新目标'));
  if (['running', 'waiting', 'failed', 'blocked'].includes(item.status)) elements.push(action('cancel', '停止全部步骤'));
  return elements;
}

export class LarkWorkbench {
  private readonly http = createWorkbenchFetch();
  private closed = false;
  close() { this.closed = true; this.http.close(); }
  private assertOpen() { if (this.closed) throw new RuntimeError('WORKBENCH_CLOSED', '工作台已关闭', 503); }

  constructor(private readonly repos: RepositoryBundle, private readonly runtime: DutydeckRuntime,
    private readonly work: () => WorkItemService, private readonly interactions: () => WorkItemInteractions,
    private readonly authorize: (sessionId: string, actorId?: string) => Promise<boolean>,
    private readonly options: { env?: NodeJS.ProcessEnv; authorizeAgent?: (sessionId: string, actorId: string, agentId: string) => Promise<boolean>; client?: (config: StoredLarkConfig) => LarkCardService; log: { warn: (...args: any[]) => void } }) {}

  private client(config: StoredLarkConfig) { this.assertOpen(); return this.options.client?.(config) ?? createLarkCardService(this.options.env ?? process.env, this.http.fetch, config); }

  async recordOrigin(sessionId: string, key: string, event: LarkMessageEvent, config: StoredLarkConfig) {
    const target: Target = { appId: config.appId, chatId: event.chatId, replyMessageId: event.messageId, replyInThread: event.chatType === 'group' };
    const savedKey = originKey(sessionId, key);
    const encoded = JSON.stringify(target);
    if (!this.repos.config.compareAndSet) throw new RuntimeError('WORK_ITEM_STORAGE_REQUIRED', '目标需要支持原子写入的存储', 503);
    const old = await this.repos.config.get(savedKey);
    if (old && old !== encoded) throw new RuntimeError('WORK_ITEM_ORIGIN_CONFLICT', '此请求已关联另一条消息', 409);
    if (!old && !await this.repos.config.compareAndSet(savedKey, undefined, encoded)) {
      if (await this.repos.config.get(savedKey) !== encoded) throw new RuntimeError('WORK_ITEM_ORIGIN_CONFLICT', '此请求已关联另一条消息', 409);
    }
  }

  async prepareDelivery(sessionId: string, workId: string, key: string) {
    const session = await this.runtime.getSession(sessionId);
    if (session?.source !== 'lark') return;
    const [appId, chatId] = session.sourceId?.split(':') ?? [];
    const storedKey = `workbench.target.${workId}`;
    if (await this.repos.config.get(storedKey)) return;
    let target: Target | undefined = JSON.parse(await this.repos.config.get(originKey(sessionId, key)) ?? 'null') ?? undefined;
    if (!target) {
      const active = this.runtime.getActiveTaskContext(sessionId);
      const taskId = active?.taskId;
      const cards = (await this.repos.channelMappings.list(`lark-card:${appId}`)).filter(value => value.sessionId === sessionId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      for (const card of cards) {
        let saved: PersistedLarkCardTask;
        try { saved = JSON.parse(card.extra ?? 'null'); } catch { continue; }
        if (!saved || saved.app_id !== appId || saved.chat_id !== chatId || !saved.reply_message_id) continue;
        if (saved.scope_id && session.sourceId && !session.sourceId.endsWith(`:${saved.scope_id}`) && session.sourceId !== `${appId}:${chatId}:${saved.scope_id}`) continue;
        if (taskId) {
          if (saved.runtime_task_id) {
            if (saved.runtime_task_id !== taskId) continue;
          } else {
            let accepted: AcceptedTask | undefined;
            try {
              accepted = this.repos.execution.getAcceptedTask(taskId);
            } catch {
              continue;
            }
            const req = accepted?.request;
            if (!req) continue;
            if (req.sessionId !== sessionId) continue;
            if (req.namespace !== 'runtime') continue;
            if (req.key !== `lark:${appId}:${card.externalId}:${saved.turn}`) continue;
            if (req.actor.kind !== 'channel' || req.actor.appId !== appId || (saved.sender_open_id && req.actor.id !== saved.sender_open_id)) continue;
          }
        }
        target = { appId: appId!, chatId: chatId!, replyMessageId: saved.reply_message_id, replyInThread: saved.reply_in_thread === true };
        break;
      }
    }
    if (!target && !this.runtime.getActiveTaskContext(sessionId)) {
      const previous = (await this.repos.channelMappings.list(`lark-work-card:${appId}`)).filter(card => card.sessionId === sessionId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      for (const card of previous) {
        let workId: string | undefined;
        try { workId = JSON.parse(card.extra ?? 'null')?.workId; } catch { continue; }
        if (!workId) continue;
        const saved = await this.repos.config.get(`workbench.target.${workId}`);
        if (saved) { target = JSON.parse(saved) as Target; break; }
      }
    }
    if (!target || target.appId !== appId || target.chatId !== chatId || !this.repos.config.compareAndSet) throw new RuntimeError('WORK_ITEM_ORIGIN_MISSING', '无法确认原话题的交付位置，请从飞书发起目标', 409);
    await this.repos.config.compareAndSet(storedKey, undefined, JSON.stringify(target));
  }

  private async agentNames() {
    const agents = await this.runtime.listAgents();
    return Object.fromEntries(agents.map(agent => [agent.id, agent.name]).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && Boolean(entry[1].trim())));
  }

  private cardState(item: WorkItem) {
    return item.status === 'completed' ? 'completed' as const
      : ['failed', 'blocked'].includes(item.status) ? 'failed' as const
      : item.status === 'cancelled' ? 'interrupted' as const
      : 'running' as const;
  }

  private async cardInput(item: WorkItem, config: StoredLarkConfig, requests: WorkItemRequest[]) {
    return {
      state: this.cardState(item),
      // 待确认不是「执行中」：换标题、去掉转圈图标、转成停下来等人的色带，卡头别和卡身说反话。
      ...(item.status === 'awaiting_confirmation' ? { statusLabel: '待确认', awaitingHuman: true } : {}),
      ...(reviewStatusLabel(item) ? { statusLabel: reviewStatusLabel(item) } : {}),
      readOnly: true, retryable: false, taskId: item.id, taskName: item.title, sessionId: item.parentSessionId,
      // S7：有配置就透传 Web 出口，未配置时 buildLarkCard 不渲染，不做公网兜底。
      webBaseUrl: config.webBaseUrl, elements: workItemElements(item, requests, { agentNames: await this.agentNames() })
    };
  }

  private workMappingId(appId: string, messageId: string) { return `workcard_${digest(`${appId}\0${messageId}`)}`; }

  private async saveWorkMapping(appId: string, messageId: string, item: WorkItem, chatId: string) {
    // extra 同步存 messageId：回调虽然能用 context.messageId 反查，重启对账与 PATCH 回退需要它自描述。
    await this.repos.channelMappings.save({ id: this.workMappingId(appId, messageId), channel: `lark-work-card:${appId}`, externalId: messageId,
      sessionId: item.parentSessionId, createdAt: new Date().toISOString(), extra: JSON.stringify({ workId: item.id, chatId, revision: item.revision, messageId }) });
  }

  private async send(item: WorkItem, target: Target, config: StoredLarkConfig, key: string, requests: WorkItemRequest[] = []) {
    const result = await sendLarkResult(this.client(config), target, { ...(await this.cardInput(item, config, requests)), idempotencyKey: key }, this.options.log);
    this.assertOpen();
    await this.saveWorkMapping(config.appId, result.messageId, item, target.chatId);
  }

  /** PATCH 指定消息整卡覆盖；不可 PATCH（超长结果/平台失败）时返回 false 交调用方回退发新卡。 */
  private async patchWorkCard(item: WorkItem, chatId: string, config: StoredLarkConfig, messageId: string, requests: WorkItemRequest[]) {
    const patched = await patchLarkCard(this.client(config), { messageId }, await this.cardInput(item, config, requests), this.options.log);
    if (!patched) return false;
    this.assertOpen();
    await this.saveWorkMapping(config.appId, patched.messageId, item, chatId);
    return true;
  }

  /** 找到该目标最近一张工作台卡并原位 PATCH；没有可覆盖的卡时静默跳过。 */
  private async patchLatestCard(item: WorkItem, config: StoredLarkConfig, requests: WorkItemRequest[]) {
    const cards = (await this.repos.channelMappings.list(`lark-work-card:${config.appId}`))
      .filter(card => card.sessionId === item.parentSessionId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    for (const card of cards) {
      let saved: { workId?: string; chatId?: string } | null;
      try { saved = JSON.parse(card.extra ?? 'null'); } catch { continue; }
      if (saved?.workId !== item.id) continue;
      await this.patchWorkCard(item, saved.chatId ?? card.externalId, config, card.externalId, requests);
      return;
    }
  }

  async deliver(item: WorkItem) {
    const encoded = await this.repos.config.get(`workbench.target.${item.id}`);
    if (!encoded) {
      if ((await this.runtime.getSession(item.parentSessionId))?.source === 'lark') throw new RuntimeError('WORK_ITEM_ORIGIN_MISSING', '目标的交付位置不可用', 409);
      return;
    }
    const target = JSON.parse(encoded) as Target;
    const config = await readLarkConfig(this.repos.config, target.appId);
    if (!config) throw new RuntimeError('WORK_ITEM_BOT_MISSING', '原机器人配置已不可用', 409);
    await this.send(item, target, config, `work_${digest(`${item.id}\0${item.output?.digest}`).slice(0, 40)}`);
  }

  /** 分层协作的文字进展，回复到该目标固定的原话题；目标未固定交付位置时不发。 */
  async notice(workId: string, text: string, key: string) {
    const encoded = await this.repos.config.get(`workbench.target.${workId}`);
    if (!encoded) return;
    const target = JSON.parse(encoded) as Target;
    const config = await readLarkConfig(this.repos.config, target.appId);
    if (!config) return;
    await this.client(config).replyText({ messageId: target.replyMessageId, replyInThread: target.replyInThread, text, idempotencyKey: `dlg_${digest(key).slice(0, 40)}` });
  }

  /**
   * 抢一条亮屏剧集：键不存在，或上一次认领的租约/退避已到期，才算抢到。
   * 抢到的一方负责发；没抢到的一方只原位 PATCH，不推新消息。
   */
  private async claimNotice(key: string): Promise<{ claimed: boolean; attempts: number }> {
    const now = Date.now();
    if (await this.repos.config.compareAndSet!(key, undefined, noticeSending(1, now))) return { claimed: true, attempts: 1 };
    const current = await this.repos.config.get(key);
    const pending = parseNoticeClaim(current);
    // sent / patched 解析不出来，到点前的 sending / failed 也不放行：两者都不该重发。
    if (!pending || now < pending.readyAt) return { claimed: false, attempts: 0 };
    const attempts = pending.attempts + 1;
    return { claimed: await this.repos.config.compareAndSet!(key, current!, noticeSending(attempts, now)), attempts };
  }

  /** 发出去了才把剧集键落成终态；失败置回带退避的可重试态，让下一轮心跳能把这张卡补出来。 */
  private async deliverNotice(key: string, attempts: number, send: () => Promise<void>) {
    try {
      await send();
    } catch (error) {
      await this.repos.config.set(key, noticeRetry(attempts, Date.now()))
        .catch(writeError => this.options.log.warn({ error: writeError, key }, '目标卡片剧集键回退失败'));
      throw error;
    }
    await this.repos.config.set(key, 'sent');
  }

  async notify(item: WorkItem, actorId: string) {
    this.assertOpen();
    if (!await this.authorize(item.parentSessionId, actorId)) return;
    this.assertOpen();
    const current = await this.work().get(item.parentSessionId, item.id, actorId);
    this.assertOpen();
    if (['cancelling', 'cancelled', 'completed'].includes(current.status)) return;
    const requests = await this.interactions().list(item.parentSessionId, item.id, actorId);
    this.assertOpen();
    if (item.status === 'running' && !item.steps.some(step => step.status === 'waiting') && !requests.length) return;
    const encoded = await this.repos.config.get(`workbench.target.${item.id}`);
    if (!encoded) return;
    const target = JSON.parse(encoded) as Target;
    const config = await readLarkConfig(this.repos.config, target.appId);
    if (!config) return;
    const fingerprint = workNoticeFingerprint(current, requests);
    const key = `workbench.notice.${current.id}.${fingerprint}`;
    const focused = workHasFocus(current, requests);
    // 剧集键必须先抢再发，且与命令侧（command 的 previewKey）用同一把锁：
    // 「读—发—写」之间隔着授权、取目标、读配置和一次真实的飞书往返，1 秒心跳的
    // notify 与刚落库的命令会双双读到空键，群里就会出现两张一模一样的待确认卡。
    const claim = await this.claimNotice(key);
    if (!claim.claimed) {
      // N2：同一焦点剧集内（含 running→completed、错误文案变化）只原位 PATCH，不推新消息。
      await this.patchLatestCard(current, config, requests)
        .catch(error => this.options.log.warn({ error, workId: current.id }, '目标卡片 PATCH 失败'));
      return;
    }
    if (focused) {
      // 进入 waiting/blocked/failed 或出现新待决请求才允许亮屏。
      await this.deliverNotice(key, claim.attempts, async () => {
        await this.send(current, target, config, `work_${digest(key).slice(0, 40)}`, requests);
        this.assertOpen();
      });
    } else {
      // 离开焦点（如 waiting 已被回答）：只 PATCH 不亮屏，剧集键落终态，后续不再重复判断。
      await this.patchLatestCard(current, config, requests)
        .catch(error => this.options.log.warn({ error, workId: current.id }, '目标卡片 PATCH 失败'));
      await this.repos.config.set(key, 'patched');
    }
  }

  /** 本话题里该操作者可用的 Agent，机器人默认 Agent 排在最前。 */
  private async allowedAgents(sessionId: string, actorId: string, config: StoredLarkConfig) {
    const agents = await this.runtime.listAgents();
    const allowed = (await Promise.all(agents.map(async agent => !this.options.authorizeAgent || await this.options.authorizeAgent(sessionId, actorId, agent.id) ? agent.id : undefined))).filter((id): id is string => Boolean(id));
    return [...(config.defaultAgentId && allowed.includes(config.defaultAgentId) ? [config.defaultAgentId] : []), ...allowed.filter(id => id !== config.defaultAgentId)];
  }

  async command(sessionId: string, argsText: string, event: LarkMessageEvent, config: StoredLarkConfig) {
    const actorId = event.senderOpenId;
    if (!actorId || !await this.authorize(sessionId, actorId)) throw new RuntimeError('WORK_ITEM_FORBIDDEN', '当前账号无权操作此目标', 403);
    const [action, id, ...rest] = argsText.trim().split(/\s+/).filter(Boolean);
    const target: Target = { appId: config.appId, chatId: event.chatId, replyMessageId: event.messageId, replyInThread: event.chatType === 'group' };
    let item: WorkItem | undefined;
    let text: string | undefined;
    let previewKey: string | undefined;
    if (action === 'consult') {
      const consultArgs = argsText.replace(/^consult\s*/i, '');
      const allowed = await this.allowedAgents(sessionId, actorId, config);
      const parsed = parseLarkConsultCommand(consultArgs, allowed);
      const resolved = resolveConsultAgents(parsed.agents, allowed, config.defaultAgentId);
      if (resolved.unavailableReason || !resolved.chosen) {
        const list = allowed.length ? allowed.map(id => `• ${id}`).join('\n') : '（暂无可用 Agent）';
        text = `${resolved.unavailableReason ?? '当前可用 Agent 不足两个，无法发起多 Agent 会诊。'}\n\n当前可用 Agent 列表：\n${list}\n\n${larkConsultUsage}`;
      } else {
        await this.recordOrigin(sessionId, event.messageId, event, config);
        const plan = consultWorkPlan(resolved.chosen);
        item = await this.work().create(sessionId, { goal: parsed.goal, plan, idempotencyKey: event.messageId }, actorId, false);
      }
    } else if (action === 'research') {
      const goal = argsText.replace(/^research\s*/i, '').trim();
      if (!goal) throw new RuntimeError('WORK_ITEM_GOAL_REQUIRED', '用法：/work research 研究目标', 400);
      await this.recordOrigin(sessionId, event.messageId, event, config);
      // 人手输入的固定模板，本人即发起人，直接执行不再加确认闸门。
      item = await this.work().create(sessionId, { goal, plan: researchWorkPlan(await this.allowedAgents(sessionId, actorId, config)), idempotencyKey: event.messageId }, actorId, false);
    } else if (action === 'plan') {
      const goal = argsText.replace(/^plan\s*/i, '').trim();
      const segments = goal.split(/[;；\n]+/).map(value => value.trim()).filter(Boolean);
      const plan = composeWorkPlan(segments, await this.allowedAgents(sessionId, actorId, config));
      await this.recordOrigin(sessionId, event.messageId, event, config);
      // 人手起的编排也先出预览卡：步骤是自动拼的，确认前不派发。
      item = await this.work().create(sessionId, { goal, plan, idempotencyKey: event.messageId }, actorId, true);
      // 这张待确认卡与 1 秒心跳里的 notify 争同一条剧集；用 CAS 定谁发，群里只会出现一张。
      previewKey = `workbench.notice.${item.id}.${workNoticeFingerprint(item, [])}`;
    } else if (action === 'run' && id && rest.length >= 2) {
      const version = Number(rest[0]);
      if (!Number.isInteger(version) || version < 1) throw new RuntimeError('WORK_ITEM_TEMPLATE_VERSION', '请指定流程版本号', 400);
      await this.recordOrigin(sessionId, event.messageId, event, config);
      item = await this.work().runTemplate(sessionId, id, version, rest.slice(1).join(' '), event.messageId, actorId, false);
    } else if (action === 'templates') {
      const templates = await this.work().listTemplates(sessionId, actorId);
      text = templates.map(value => `**${value.name} · v${value.version}**\n\`/work run ${value.id} ${value.version} 新目标\``).join('\n\n') || '尚无流程。完成一个目标后，可用 /work save 目标编号 流程名称 保存。';
    } else if (id && ['terminal', 'input', 'key'].includes(action!)) {
      if (action === 'terminal') {
        const view = await this.interactions().terminal(sessionId, id, rest[0] ?? '', actorId);
        text = `**步骤终端 · ${view.stepId}**\n\n${view.screen.replace(/`/g, 'ˋ')}\n\n发送一行文字：\n\`/work input ${id} ${view.stepId} ${view.taskId} 你的回答\`\n\n发送按键：\n\`/work key ${id} ${view.stepId} ${view.taskId} enter\`\n支持 enter / up / down / left / right / tab / escape / ctrl_c。`;
      } else {
        await this.interactions().terminalInput(sessionId, id, { stepId: rest[0], taskId: rest[1], ...(action === 'input' ? { text: rest.slice(2).join(' ') } : { key: rest[2] }) }, actorId);
        text = `已向当前步骤发送${action === 'input' ? '文字' : '按键'}。\n\n\`/work terminal ${id} ${rest[0]}\``;
      }
    } else if (id && ['show', 'confirm', 'cancel', 'retry', 'answer', 'save', 'requests', 'respond'].includes(action!)) {
      item = await this.work().get(sessionId, id, actorId);
      if (action === 'confirm') item = await this.work().confirm(sessionId, id, item.revision, actorId);
      if (action === 'cancel') item = await this.work().cancel(sessionId, id, item.revision, actorId);
      if (action === 'retry') item = await this.work().retryStep(sessionId, id, rest[0] ?? '', item.revision, actorId);
      if (action === 'answer') item = await this.work().answer(sessionId, id, rest[0] ?? '', rest.slice(1).join(' '), item.revision, actorId);
      if (action === 'save') {
        const template = await this.work().saveTemplate(sessionId, id, rest.join(' '), actorId);
        text = `已保存「${template.name}」v${template.version}。\n\n\`/work run ${template.id} ${template.version} 新目标\``;
      }
      if (action === 'respond') {
        const request = (await this.interactions().list(sessionId, id, actorId)).find(request => request.stepId === rest[0] && request.requestId === rest[1]);
        if (!request) throw new RuntimeError('WORK_ITEM_REQUEST_EXPIRED', '原问题已结束或不存在', 409);
        await this.interactions().respond(sessionId, id, { stepId: request.stepId, taskId: request.taskId, requestId: request.requestId, kind: request.kind, answer: rest.slice(2).join(' ') }, actorId);
        item = await this.work().get(sessionId, id, actorId);
      }
    } else if (!action) {
      const items = await this.work().listBySession(sessionId, actorId);
      text = '**Dutydeck 工作台**\n\n直接描述目标，让 Dutydeck 安排步骤、选择 Agent 并交付成果。\n\n' + (items.slice(0, 8).map(value => `**${labels[value.status]} · ${value.title}**\n\`/work show ${value.id}\``).join('\n\n') || '此话题暂无目标。') + '\n\n双 Agent 会诊：`/work consult [--agents A,B] -- <问题>`\n快速开始：`/work research 研究目标`\n自己编排：`/work plan 第一步；第二步`（先出待确认卡）\n常用流程：`/work templates`\n定时与 CI：`/schedule`、`/ci`';
    } else throw new RuntimeError('WORK_ITEM_COMMAND_INVALID', '用法：/work；/work consult [--agents A,B] -- <问题>；/work research 目标；/work plan 用分号分隔的多个步骤；/work show 编号；/work templates；/work run 流程编号 版本 目标；/work save 目标编号 名称；/work answer 目标编号 步骤编号 回答', 400);
    if (text) {
      await sendLarkResult(this.client(config), target, { state: 'completed', readOnly: true, retryable: false, taskId: event.messageId, taskName: 'Dutydeck 工作台',
        elements: [{ tag: 'markdown', element_id: 'final_output', content: text }], idempotencyKey: `work_${digest(event.messageId).slice(0, 40)}` }, this.options.log);
    } else if (item) {
      const current = item;
      // 没抢到说明 notify 已经把同一张待确认卡推进话题，这里不再重复推送；
      // 抢到了就负责发，发失败要把键置回可重试，别让待确认闸门静默消失（与 notify 同一套）。
      const claim = previewKey ? await this.claimNotice(previewKey) : undefined;
      if (claim && !claim.claimed) return;
      const requests = await this.interactions().list(sessionId, current.id, actorId);
      // 待确认卡的幂等键取剧集键，与 notify 侧完全一致：租约只挡得住「持有者崩了」，
      // 挡不住「持有者还在发」——一次撞上频控退避的发送可以超过租约，另一条路径就会
      // 合法地抢到锁再发一次。同一个幂等键让飞书把第二次收拢掉，群里仍只有一张。
      const send = () => this.send(current, target, config, `work_${digest(previewKey ?? event.messageId).slice(0, 40)}`, requests);
      if (previewKey && claim) await this.deliverNotice(previewKey, claim.attempts, send);
      else await send();
    }
  }

  async callback(value: Record<string, any>, actorId: string | undefined, context: { messageId?: string; chatId?: string }, config: StoredLarkConfig) {
    if (!actorId || !context.messageId || !context.chatId) throw new RuntimeError('WORK_ITEM_CALLBACK_INVALID', '卡片身份不完整', 403);
    const mapping = await this.repos.channelMappings.get(`lark-work-card:${config.appId}`, context.messageId);
    const saved = mapping?.extra ? JSON.parse(mapping.extra) : undefined;
    // chat/work/session 不一致是伪造或串话题，硬失败；revision 不一致只是卡片过期，走刷新不拦操作判定。
    if (!mapping || !saved || saved.chatId !== context.chatId || saved.workId !== value.work_id || mapping.sessionId !== value.parent_session_id)
      throw new RuntimeError('WORK_ITEM_CALLBACK_INVALID', '卡片已过期或不属于此话题', 409);
    if (!await this.authorize(mapping.sessionId, actorId)) throw new RuntimeError('WORK_ITEM_FORBIDDEN', '当前账号无权操作此目标', 403);
    const item = await this.work().get(mapping.sessionId, saved.workId, actorId);
    const operation = value.dutydeck_work_item;
    const stale = saved.revision !== value.revision;
    let toast = '目标状态已更新';
    if (stale) {
      // revision CAS 失败：别人已经推进过目标，本次点击不再落操作，直接把最新状态发回话题。
      toast = '目标状态已变化，已刷新最新卡片';
    } else if (operation === 'confirm') {
      await this.work().confirm(mapping.sessionId, item.id, Number(value.revision), actorId);
      toast = '计划已确认，开始执行';
    } else if (operation === 'cancel') {
      await this.work().cancel(mapping.sessionId, item.id, Number(value.revision), actorId);
    } else if (operation === 'retry') {
      await this.work().retryStep(mapping.sessionId, item.id, String(value.step_id), Number(value.revision), actorId);
    } else if (operation === 'answer') {
      // 自由文本来自 JSON 2.0 表单的 form_value（listener 合入接线见集成清单）；未合入时 fail-closed。
      const answer = this.formAnswer(value);
      if (!answer) throw new RuntimeError('WORK_ITEM_ANSWER_REQUIRED', '请填写回答内容，或引用本卡片用 /work answer 文字命令回复', 400);
      await this.work().answer(mapping.sessionId, item.id, String(value.step_id), answer, Number(value.revision), actorId);
    } else if (operation === 'respond') {
      const answer = value.request_kind === 'permission' ? String(value.answer ?? '') : this.formAnswer(value);
      await this.interactions().respond(mapping.sessionId, item.id, { stepId: value.step_id, taskId: value.task_id, requestId: value.request_id, kind: value.request_kind, answer }, actorId);
    } else if (operation !== 'show') {
      throw new RuntimeError('WORK_ITEM_CALLBACK_INVALID', '无法识别目标操作', 400);
    }
    const updated = await this.work().get(mapping.sessionId, item.id, actorId);
    const requests = await this.interactions().list(mapping.sessionId, item.id, actorId);
    const target: Target = { appId: config.appId, chatId: context.chatId, replyMessageId: context.messageId, replyInThread: true };
    const fallbackKey = `work_${digest(`${context.messageId}\0${updated.revision}\0${JSON.stringify(value)}`).slice(0, 40)}`;
    // 先让回调在 3 秒 SLA 内回 toast；PATCH 与回退新发在后台完成，失败只告警不改变 toast 语义。
    void (async () => {
      if (!stale && await this.patchWorkCard(updated, context.chatId!, config, context.messageId!, requests)) return;
      await this.send(updated, target, config, fallbackKey, requests);
    })().catch(error => this.options.log.warn({ error, workId: updated.id }, '目标卡片刷新失败'));
    return toast;
  }

  private formAnswer(value: Record<string, any>) {
    const answer = value.form_value?.answer ?? value.answer;
    return typeof answer === 'string' ? answer.trim() : '';
  }
}
