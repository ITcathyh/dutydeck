import { createHash } from 'node:crypto';
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
import type { TriggerDispatch } from './triggers.js';

/** 触发器开的会话：sourceId 为 `<appId>:<chatId>:plugin:<插件>:<触发器>`。 */
export const PLUGIN_TRIGGER_SOURCE = 'plugin_trigger';

/** 群协作判定、回复生成、记忆整理三类后台会话：hook 照常运行，但只能拒绝，不能改写 prompt，也不能代为批准工具调用。 */
const backgroundSources = new Set(['lark-decision', 'lark-response', 'lark-memory']);

export function sessionHookContext(session: Pick<Session, 'id' | 'cwd' | 'source' | 'sourceId'>) {
  const appId = botAppIdOfSession(session);
  // 记忆会话 sourceId 的第二段是记忆池，不一定是群 id。
  const chatId = appId && session.source !== 'lark-memory' ? parseLarkSourceId(session.sourceId).chatId : undefined;
  return { sessionId: session.id, ...(session.cwd ? { cwd: session.cwd } : {}), ...(appId ? { botAppId: appId } : {}), ...(chatId ? { chatId } : {}) };
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

  async taskReceived(session: Session, request: TaskRequestV1): Promise<void> {
    if (!this.hooks.has('task.received')) return;
    const result = await this.hooks.run('task.received', { ...sessionHookContext(session), payload: {
      source: session.source ?? 'web', namespace: request.namespace, key: request.key, prompt: request.prompt, mode: request.mode, actor: request.actor.kind
    } }, session.source ?? 'web');
    if (result.decision === 'deny') throw denied(result.reason);
  }

  async beforeRun(session: Session, prepared: PrepareSkillPromptResult, policyVersion?: 'legacy-v1' | 'optimized-v1'): Promise<PrepareSkillPromptResult> {
    if (!this.hooks.has('task.beforeRun')) return prepared;
    const result = await this.hooks.run('task.beforeRun', { ...sessionHookContext(session), payload: {
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
    if (!prepared.promptParts) return { ...prepared, agentPrompt };
    const parts: PromptPart[] = [
      ...(result.updatedPrompt ? [{ kind: 'user_request' as const, trustScope: 'plugin_hook', content: result.updatedPrompt }] : prepared.promptParts),
      ...(context ? [{ kind: 'dynamic_context' as const, trustScope: 'plugin_hook', content: context }] : [])
    ];
    return { ...prepared, agentPrompt, promptParts: parts, promptDiagnostics: assemblePrompt(parts, agentPrompt, policyVersion).diagnostics };
  }

  async reviewPermission(session: Session, request: PermissionRequestData): Promise<'allow' | 'deny' | undefined> {
    const result = await this.hooks.run('permission.request', { ...sessionHookContext(session), payload: { ...request } }, request.title ?? '');
    if (result.decision === 'allow' && backgroundSources.has(session.source ?? '')) {
      this.log?.warn({ sessionId: session.id, source: session.source, plugins: result.outcomes.map(outcome => outcome.plugin) }, '插件对后台会话的批准已忽略');
      return undefined;
    }
    return result.decision === 'allow' || result.decision === 'deny' ? result.decision : undefined;
  }

  async taskCompleted(session: Session, task: PublicTaskRecord): Promise<void> {
    if (!this.hooks.has('task.completed')) return;
    await this.hooks.run('task.completed', { ...sessionHookContext(session), taskId: task.id, payload: { status: task.status, prompt: task.prompt, source: session.source ?? 'web' } }, task.status);
  }

  async verificationCompleted(session: Session, result: VerificationResponse): Promise<void> {
    if (!this.hooks.has('verification.completed')) return;
    await this.hooks.run('verification.completed', { ...sessionHookContext(session), payload: { ...result, source: session.source ?? 'web' } as Record<string, unknown> }, String((result as { status?: unknown }).status ?? ''));
  }

  /** 返回 false 表示有插件拒绝这次推送。 */
  async notify(context: { sessionId?: string; botAppId?: string; chatId?: string; cwd?: string }, kind: string, payload: Record<string, unknown>): Promise<boolean> {
    if (!this.hooks.has('notify')) return true;
    const result = await this.hooks.run('notify', { ...context, payload: { kind, ...payload } }, kind);
    return result.decision !== 'deny';
  }
}

export interface TriggerBot { appId: string; workspace?: string; defaultAgentId?: string; permissionMode?: 'ask' | 'approve-reads' | 'full-trust'; fullTrustConfirmed?: boolean }

/**
 * 触发器的注入式投递：在目标机器人的工作区里为这个触发器开会话（new）或沿用它上一次的会话（reuse），
 * 以安装者身份派发任务；结果由 {@link triggerResultText} 在结算后发回目标群。
 * 触发器会话与群里人发起的会话互不复用。
 */
export function createTriggerDispatcher(deps: {
  runtime: Pick<DutydeckRuntime, 'start' | 'dispatch' | 'listSessions'>;
  readBot(appId: string): Promise<TriggerBot | undefined>;
  fallbackAgentId(): string | undefined;
}) {
  return async (request: TriggerDispatch): Promise<{ sessionId: string; taskId: string }> => {
    const bot = await deps.readBot(request.target.botAppId);
    if (!bot) throw new Error(`机器人 ${request.target.botAppId} 未配置`);
    const sourceId = `${bot.appId}:${request.target.chatId}:plugin:${request.plugin}:${request.triggerId}`;
    let sessionId: string | undefined;
    if (request.target.session === 'reuse') {
      sessionId = (await deps.runtime.listSessions())
        .filter(session => session.source === PLUGIN_TRIGGER_SOURCE && session.sourceId === sourceId && !session.archivedAt && !['stopped', 'failed'].includes(session.state))
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]?.id;
    }
    if (!sessionId) {
      const agentId = bot.defaultAgentId ?? deps.fallbackAgentId();
      if (!agentId) throw new Error('没有可用的 Agent');
      const permissionMode = bot.permissionMode === 'full-trust' && !bot.fullTrustConfirmed ? undefined : bot.permissionMode;
      sessionId = (await deps.runtime.start({ agentId, ...(bot.workspace ? { cwd: bot.workspace } : {}), source: PLUGIN_TRIGGER_SOURCE, sourceId, ...(permissionMode ? { permissionMode } : {}) })).id;
    }
    const task = await deps.runtime.dispatch(sessionId, request.prompt, 'queue', request.prompt, undefined, installationOwnerTaskActor, `plugin-trigger:${request.key}`);
    return { sessionId, taskId: task.id };
  };
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
