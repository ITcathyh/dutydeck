import { createHash, randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import {
  botAppIdOfSession,
  installationOwnerTaskActor,
  parseLarkSourceId,
  RuntimeError,
  type PermissionRequestData,
  type PromptPart,
  type PublicTaskRecord,
  type Session,
  type TaskRequestV1,
  type VerificationResponse
} from '@dutydeck/shared';
import type { DutydeckRuntime } from '@dutydeck/runtime';
import { assemblePrompt } from '../prompt-context.js';
import type { PrepareSkillPromptResult } from '../skill-delivery.js';
import type { PluginHookBus } from './hooks.js';
import type { PluginToolIdentity, PluginCommandIdentity } from '@dutydeck/shared';
import { TriggerTemplateUnavailableError, type TriggerAccepted, type TriggerDispatch } from './triggers.js';
import type { WorkItemService } from '../work-items.js';
import { scopeApplies } from './scope.js';

/** 触发器开的会话：sourceId 为 `<appId>:<chatId>:plugin:<插件>:<触发器>`。 */
export const PLUGIN_TRIGGER_SOURCE = 'plugin_trigger';

/** 群协作判定、回复生成、记忆整理与文字优化后台会话：hook 照常运行，但只能拒绝，不能改写 prompt，也不能代为批准工具调用。 */
const backgroundSources = new Set(['lark-decision', 'lark-response', 'lark-memory', 'lark-reply-polish']);

export function sessionHookContext(session: Pick<Session, 'id' | 'cwd' | 'source' | 'sourceId'>) {
  const appId = botAppIdOfSession(session);
  // 记忆会话 sourceId 的第二段是记忆池，不一定是群 id。
  const chatId = appId && session.source !== 'lark-memory' ? parseLarkSourceId(session.sourceId).chatId : undefined;
  return { sessionId: session.id, ...(session.cwd ? { cwd: session.cwd } : {}), ...(appId ? { botAppId: appId } : {}), ...(chatId ? { chatId } : {}) };
}

function bindingRevisionOf(deliveries: Array<{ binding?: { revision: number } }> | undefined): number | undefined {
  const revisions = [...new Set((deliveries ?? []).map(item => item.binding?.revision).filter((value): value is number => value !== undefined))];
  return revisions.length === 1 ? revisions[0] : undefined;
}

function actorOfSession(session: Pick<Session, 'id' | 'cwd' | 'source' | 'sourceId'>): { kind: 'installation_owner'; id: 'installation_owner' } | { kind: 'channel'; id: string; appId: string } | { kind: 'unspecified' } {
  if (session.source === PLUGIN_TRIGGER_SOURCE) return { kind: 'installation_owner', id: 'installation_owner' };
  const context = sessionHookContext(session);
  return context.botAppId && context.chatId ? { kind: 'channel', id: context.chatId, appId: context.botAppId } : { kind: 'unspecified' };
}

const denied = (reason: string | undefined) => new RuntimeError('PLUGIN_HOOK_DENIED', reason ?? '插件 hook 拒绝了这次操作', 403);

/**
 * 把插件 hook 接到现有流程的几个入口。没有对应事件的 hook 时每个方法都直接返回，行为与未装插件一致。
 * - task.received：新任务接收前（runtime admitTask），deny 拒收；
 * - task.beforeRun：任务 prompt 冻结前（prepareTaskPrompt），deny 拒收，additionalContext 追加、updatedPrompt 替换；后台会话只认 deny；
 * - permission.request：待审批工具调用进入人工审批前，allow/deny 直接代为决定；后台会话只认 deny；
 * - task.completed / verification.completed：结算后通知，结果不影响流程；
 * - notify：Dutydeck 主动推送（CI 通知、触发器结果）前，deny 不发。
 */
export class PluginRuntimeHooks {
  constructor(private readonly hooks: PluginHookBus, private readonly log?: { warn(data: Record<string, unknown>, message: string): void }) {}

  has(event: Parameters<PluginHookBus['has']>[0]) { return this.hooks.has(event); }

  private eventId() { return `evt_${randomUUID().replaceAll('-', '')}`; }

  async taskReceived(session: Session, request: TaskRequestV1): Promise<void> {
    if (!this.hooks.has('task.received')) return;
    const result = await this.hooks.run('task.received', { eventId: this.eventId(), actor: request.actor, ...sessionHookContext(session), payload: {
      source: session.source ?? 'web', namespace: request.namespace, key: request.key, prompt: request.prompt, mode: request.mode, actor: request.actor.kind
    } }, session.source ?? 'web');
    if (result.decision === 'deny') throw denied(result.reason);
  }

  async beforeRun(session: Session, prepared: PrepareSkillPromptResult, policyVersion?: 'legacy-v1' | 'optimized-v1'): Promise<PrepareSkillPromptResult> {
    if (!this.hooks.has('task.beforeRun')) return prepared;
    const beforeRunRevision = bindingRevisionOf(prepared.skillDeliveries);
    const result = await this.hooks.run('task.beforeRun', { eventId: this.eventId(), actor: actorOfSession(session), ...(beforeRunRevision === undefined ? {} : { bindingRevision: beforeRunRevision }), ...sessionHookContext(session), payload: {
      source: session.source ?? 'web', prompt: prepared.agentPrompt, skills: prepared.skillDeliveries.map(skill => skill.name)
    } }, session.source ?? 'web');
    if (result.decision === 'deny') throw denied(result.reason);
    if (!result.updatedPrompt && !result.additionalContext.length) return prepared;
    if (backgroundSources.has(session.source ?? '')) {
      this.log?.warn({ sessionId: session.id, source: session.source, plugins: result.outcomes.map(outcome => outcome.plugin) }, '插件对后台会话的改写已忽略');
      return prepared;
    }
    const context = result.additionalContext.length ? `\n\n${result.additionalContext.join('\n\n')}` : '';
    const agentPrompt = `${result.updatedPrompt ?? prepared.agentPrompt}${context}`;
    for (const part of prepared.promptParts ?? []) if (part.trustScope === 'required_scenario_skill' && !agentPrompt.includes(part.content)) throw new RuntimeError('REQUIRED_SKILL_REPLACED', 'Hook removed required frozen scenario SOP', 409);
    const skillDeliveries = prepared.skillDeliveries.map((skill, index) => {
      const content = prepared.deliveryTexts?.[index];
      const included = content !== undefined && agentPrompt.includes(content);
      if (!included && skill.required) throw new RuntimeError('REQUIRED_SKILL_REPLACED', `Hook removed required SOP ${skill.ref ?? skill.name}`, 409);
      return { ...skill, status: included ? 'included' as const : 'replaced' as const };
    });
    if (!prepared.promptParts) return { ...prepared, agentPrompt, skillDeliveries };
    const parts: PromptPart[] = [
      ...(result.updatedPrompt ? [{ kind: 'user_request' as const, trustScope: 'plugin_hook', content: result.updatedPrompt }] : prepared.promptParts),
      ...(context ? [{ kind: 'dynamic_context' as const, trustScope: 'plugin_hook', content: context }] : [])
    ];
    return { ...prepared, agentPrompt, skillDeliveries, promptParts: parts, promptDiagnostics: assemblePrompt(parts, agentPrompt, policyVersion).diagnostics };
  }

  async reviewPermission(session: Session, request: PermissionRequestData): Promise<'allow' | 'deny' | undefined> {
    const result = await this.hooks.run('permission.request', { eventId: this.eventId(), actor: actorOfSession(session), ...sessionHookContext(session), payload: { ...request } }, request.title ?? '');
    if (result.decision === 'allow' && backgroundSources.has(session.source ?? '')) {
      this.log?.warn({ sessionId: session.id, source: session.source, plugins: result.outcomes.map(outcome => outcome.plugin) }, '插件对后台会话的批准已忽略');
      return undefined;
    }
    return result.decision === 'allow' || result.decision === 'deny' ? result.decision : undefined;
  }

  async taskCompleted(session: Session, task: PublicTaskRecord): Promise<void> {
    if (!this.hooks.has('task.completed')) return;
    const completedRevision = bindingRevisionOf(task.skillDeliveries);
    await this.hooks.run('task.completed', { eventId: this.eventId(), actor: actorOfSession(session), ...(completedRevision === undefined ? {} : { bindingRevision: completedRevision }), ...sessionHookContext(session), taskId: task.id, ...(task.currentAttemptId ? { attemptId: task.currentAttemptId } : {}), payload: { status: task.status, prompt: task.prompt, source: session.source ?? 'web' } }, task.status);
  }

  async verificationCompleted(session: Session, result: VerificationResponse): Promise<void> {
    if (!this.hooks.has('verification.completed')) return;
    await this.hooks.run('verification.completed', { eventId: this.eventId(), actor: actorOfSession(session), ...sessionHookContext(session), ...(result.taskId ? { taskId: result.taskId } : {}), payload: { ...result, source: session.source ?? 'web' } as Record<string, unknown> }, String((result as { status?: unknown }).status ?? ''));
  }

  /** 返回 false 表示有插件拒绝这次推送。 */
  async notify(context: { sessionId?: string; botAppId?: string; chatId?: string; cwd?: string }, kind: string, payload: Record<string, unknown>): Promise<boolean> {
    if (!this.hooks.has('notify')) return true;
    const result = await this.hooks.run('notify', { eventId: this.eventId(), actor: { kind: 'unspecified' }, ...context, payload: { kind, ...payload } }, kind);
    return result.decision !== 'deny';
  }

  /** Synchronous tool gate. Identity is supplied by the host authority and never read from plugin output. */
  async toolBeforeCall(identity: PluginToolIdentity | PluginCommandIdentity, payload: Record<string, unknown>, bindingRevision?: number): Promise<'allow' | 'deny' | undefined> {
    if (!this.hooks.has('tool.beforeCall')) return undefined;
    const result = await this.hooks.run('tool.beforeCall', {
      eventId: 'kind' in identity ? identity.eventId : this.eventId(), ...(bindingRevision === undefined ? {} : { bindingRevision }), ...('kind' in identity ? {} : { sessionId: identity.sessionId, taskId: identity.taskId, attemptId: identity.attemptId }), cwd: identity.cwd,
      ...(identity.botAppId ? { botAppId: identity.botAppId } : {}), ...(identity.chatId ? { chatId: identity.chatId } : {}),
      actor: identity.actor, payload: { actor: identity.actor, channel: identity.channel, ...payload }
    }, String(payload.tool ?? ''));
    return result.decision === 'deny' ? 'deny' : result.decision === 'allow' ? 'allow' : undefined;
  }

  async deliveryCompleted(identity: PluginToolIdentity, payload: Record<string, unknown>, bindingRevision?: number): Promise<void> {
    if (!this.hooks.has('delivery.completed')) return;
    await this.hooks.run('delivery.completed', {
      eventId: this.eventId(), ...(bindingRevision === undefined ? {} : { bindingRevision }), sessionId: identity.sessionId, taskId: identity.taskId, attemptId: identity.attemptId, cwd: identity.cwd,
      ...(identity.botAppId ? { botAppId: identity.botAppId } : {}), ...(identity.chatId ? { chatId: identity.chatId } : {}),
      actor: identity.actor, payload: { actor: identity.actor, channel: identity.channel, ...payload }
    }, String(payload.kind ?? ''));
  }
}

export interface TriggerBot { appId: string; workspace?: string; defaultAgentId?: string; permissionMode?: 'ask' | 'approve-reads' | 'full-trust'; fullTrustConfirmed?: boolean }

/**
 * 触发器的注入式投递：在目标机器人的工作区里为这个触发器开会话（new）或沿用它上一次的会话（reuse），
 * 以安装者身份派发任务；结果由 {@link triggerResultText} 在结算后发回目标群。
 * 触发器会话与群里人发起的会话互不复用。
 */
export function createTriggerDispatcher(deps: {
  runtime: Pick<DutydeckRuntime, 'start' | 'dispatch' | 'listSessions'> & Partial<Pick<DutydeckRuntime, 'cancelQueued' | 'getSession'>>;
  readBot(appId: string): Promise<TriggerBot | undefined>;
  fallbackAgentId(): string | undefined;
  /** 启动工作项模板；没有时声明了 workTemplate 的触发器不可用。 */
  work?(): Pick<WorkItemService, 'runTemplate'>;
}) {
  return async (request: TriggerDispatch): Promise<TriggerAccepted> => {
    const bot = await deps.readBot(request.target.botAppId);
    if (!bot) throw new Error(`机器人 ${request.target.botAppId} 未配置`);
    if (request.workTemplate) return runTriggerTemplate(deps, request as TriggerDispatch & { workTemplate: NonNullable<TriggerDispatch['workTemplate']> }, bot.appId);
    const sourceId = `${bot.appId}:${request.target.chatId}:plugin:${request.plugin}:${request.triggerId}`;
    let session: Session | undefined;
    if (request.target.session === 'reuse') {
      session = (await deps.runtime.listSessions())
        .filter(session => session.source === PLUGIN_TRIGGER_SOURCE && session.sourceId === sourceId && !session.archivedAt && !['stopped', 'failed'].includes(session.state))
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    }
    let cwd = session ? session.cwd : bot.workspace;
    let scope = request.scope;
    if (scope.startsWith('workspace:')) {
      try {
        // 两端都按真实路径比较；把已核准的目录交给 runtime，避免再次解析原来的符号链接。
        const root = await realpath(scope.slice('workspace:'.length));
        cwd = cwd ? await realpath(cwd) : undefined;
        scope = `workspace:${root}`;
      } catch {
        throw new Error(`插件 ${request.plugin} 的作用域或目标会话工作区无法解析`);
      }
    }
    if (!scopeApplies(scope, { botAppId: bot.appId, ...(cwd ? { cwd } : {}) })) {
      throw new Error(`插件 ${request.plugin} 的作用域不允许在目标会话工作区执行`);
    }
    let sessionId = session?.id;
    if (!sessionId) {
      const agentId = bot.defaultAgentId ?? deps.fallbackAgentId();
      if (!agentId) throw new Error('没有可用的 Agent');
      const permissionMode = bot.permissionMode === 'full-trust' && !bot.fullTrustConfirmed ? undefined : bot.permissionMode;
      sessionId = (await deps.runtime.start({ agentId, ...(cwd ? { cwd } : {}), source: PLUGIN_TRIGGER_SOURCE, sourceId, ...(permissionMode ? { permissionMode } : {}) })).id;
    }
    const task = await deps.runtime.dispatch(sessionId, request.prompt!, 'queue', request.prompt!, undefined, installationOwnerTaskActor, `plugin-trigger:${request.key}`);
    return { sessionId, taskId: task.id };
  };
}

/**
 * 在模板所在会话里按模板启动工作项，身份与普通触发器任务相同（安装者）。模板所在会话必须是触发器目标机器人和群的飞书会话，
 * 插件作用域按该会话的机器人与工作区核对；是否要人工确认沿用工作项的默认判定（飞书群里要确认）。
 * 工作项编号由派发键决定，同一事件重试拿回同一个工作项。
 */
async function runTriggerTemplate(deps: Parameters<typeof createTriggerDispatcher>[0], request: TriggerDispatch & { workTemplate: NonNullable<TriggerDispatch['workTemplate']> }, botAppId: string): Promise<TriggerAccepted> {
  const unavailable = (cause: string, message: string) => new TriggerTemplateUnavailableError(cause, message);
  const { session: sessionId, id, version, goal } = request.workTemplate;
  const work = deps.work?.();
  if (!work || !deps.runtime.getSession) throw unavailable('WORK_ITEMS_UNAVAILABLE', '当前实例不能启动工作项模板');
  const parsedVersion = typeof version === 'number' ? version : /^[1-9][0-9]{0,8}$/.test(version.trim()) ? Number(version.trim()) : undefined;
  if (!parsedVersion) throw unavailable('WORK_TEMPLATE_VERSION_INVALID', `工作项模板版本 ${version} 不是正整数`);
  const session = await deps.runtime.getSession(sessionId);
  if (!session) throw unavailable('WORK_TEMPLATE_SESSION_NOT_FOUND', `模板所在会话 ${sessionId} 不存在`);
  const source = parseLarkSourceId(session.sourceId);
  if (session.source !== 'lark' || source.appId !== botAppId || source.chatId !== request.target.chatId) {
    throw unavailable('WORK_TEMPLATE_TARGET_MISMATCH', `模板所在会话 ${sessionId} 不是机器人 ${botAppId} 在 ${request.target.chatId} 里的飞书会话`);
  }
  let cwd: string | undefined = session.cwd;
  let scope = request.scope;
  if (scope.startsWith('workspace:')) {
    try { scope = `workspace:${await realpath(scope.slice('workspace:'.length))}`; cwd = await realpath(session.cwd); }
    catch { throw unavailable('PLUGIN_SCOPE_UNRESOLVED', `插件 ${request.plugin} 的作用域或模板所在会话工作区无法解析`); }
  }
  if (!scopeApplies(scope, { botAppId, cwd })) throw unavailable('PLUGIN_SCOPE_MISMATCH', `插件 ${request.plugin} 的作用域不允许在模板所在会话执行`);
  if (goal.trim().length > 32_000) throw unavailable('WORK_TEMPLATE_GOAL_TOO_LONG', '渲染后的目标超过 32000 字符');
  const idempotencyKey = `plugin-trigger:${createHash('sha256').update(request.key).digest('hex').slice(0, 40)}`;
  try {
    // 触发器启动的工作项不归属父会话此刻正在跑的那一轮（用量与风险策略都不沿用）。
    const item = await work.runTemplate(sessionId, id, parsedVersion, goal, idempotencyKey, installationOwnerTaskActor, undefined, true);
    return { sessionId, workItemId: item.id, awaitingConfirmation: item.status === 'awaiting_confirmation' };
  } catch (error) {
    // 模板缺失、无权、会话不可运行或交付位置无法确认都是配置问题，不是投递暂时失败。
    if (error instanceof RuntimeError && error.statusCode < 500) throw unavailable(error.code, error.code === 'WORK_TEMPLATE_NOT_FOUND' ? `工作项模板 ${id} 的版本 ${parsedVersion} 不存在或已不可用（会话 ${sessionId}）` : error.message);
    throw error;
  }
}

const resultLimit = 8_000;
export function triggerResultText(session: Pick<Session, 'sourceId'>, task: PublicTaskRecord, output: string | undefined): { chatId: string; appId: string; text: string; idempotencyKey: string } | undefined {
  const { appId, chatId, chatType, scope } = parseLarkSourceId(session.sourceId);
  if (!appId || !chatId || chatType !== 'plugin') return undefined;
  const [plugin, trigger] = scope;
  const body = output?.trim() ? output.trim() : task.status === 'completed' ? '（没有输出）' : `任务${task.status === 'failed' ? '失败' : '未完成'}（${task.status}）`;
  const clipped = body.length > resultLimit ? `${body.slice(0, resultLimit)}\n…（已截断，完整结果见 Dutydeck 会话）` : body;
  return { appId, chatId, text: `【插件 ${plugin} · 触发器 ${trigger}】\n${clipped}`, idempotencyKey: `plugin_${createHash('sha256').update(task.id).digest('hex').slice(0, 40)}` };
}
