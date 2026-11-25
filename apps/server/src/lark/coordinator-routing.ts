import type { CoordinatorState } from './coordinator-state.js';
import type { CoordinatorParts } from './coordinator-parts.js';
import { parseLarkSourceId, serialByKey, type PolicyAction, type Session, type TaskRecord } from '@dutydeck/shared';
import { isRunnable } from '../ci-common.js';
import { eventsForRuntimeTask, renderLarkResultElements, terminalTaskStates } from './card-renderer.js';
import { safeLarkWebUrl } from './card-actions.js';
import { larkCommandEcho } from './commands.js';
import { larkPermissionMode, type StoredLarkConfig } from './config.js';
import { larkCardChannel, larkTaskTitle, relaunchRetainedKey, relaunchRetainedPrefix } from './coordinator-core.js';
import type { LarkGroup } from './coordinator.js';
import { explicitFinalContext, readExplicitFinal } from './explicit-final.js';
import { readGitSnapshot } from './git-status.js';
import { formatLarkHandoff, larkHandoffEventLimit, larkHandoffIndexLimit } from './handoff.js';
import type { LarkMessageEvent } from './listener.js';
import { validateLarkLaunchOptions, type LarkLaunchOptions } from './new-session.js';
import { parseCardTask } from './persisted-card-task.js';
import { redactTraceText } from './secret-redaction.js';
import { findPersistedLarkSession, larkSessionConfigKey, larkSessionMatchesScope, larkSourceId, listPersistedLarkSessions, resolveLarkSession } from './session-resolver.js';

interface RoutingDependencies {
  core: Pick<CoordinatorParts['core'], 'isTaskOperatorAllowed' | 'larkTaskOrigin' | 'requireExecution'>;
  reconcile: Pick<CoordinatorParts['reconcile'], 'relaunchBlockedSession'>;
  runner: Pick<CoordinatorParts['runner'], 'failPendingInbox'>;
}

export class LarkSessionRouting {
  constructor(private readonly state: CoordinatorState, private readonly parts: RoutingDependencies) {}

  /** 同一 scope 的启动绑定先读后写串行执行：/new 写事项边界与 /model、/effort 切换后改绑定不能交错，否则后写的一方会抹掉先写的标记。 */
  private readonly launchBindingTails = new Map<string, Promise<unknown>>();

  /**
   * 只读定位当前 App + chat + scope 的持久化会话。
   *
   * 查询失败**不吞**：调用方会把异常变成一条「命令执行失败」的回执。诚实地说不知道，
   * 好过让 /status 谎称没有会话、让 /new 在什么都没停掉的情况下回「已受理」。
   */
  async findScopeSession(config: StoredLarkConfig, event: LarkMessageEvent, scopeId: string, group: LarkGroup) {
    const session = await findPersistedLarkSession(this.state.runtime, config, event.chatId, event.chatType, scopeId, this.state.cardMappings);
    return session && !group.retiredSessionIds?.has(session.id) ? session : undefined;
  }

  /**
   * 结束一个上下文的**全部**可复用会话。
   *
   * 关键不变量：返回之后，同一 App/chat/scope/config 下不能再有任何一条会话被
   * resolveLarkSession 选回来。因此目标是 listPersistedLarkSessions 的全集（与普通消息
   * 同一份 larkSessionMatchesScope 判据），而不是「最近那一条」。
   *
   * 另外三件事缺一不可：
   * 1. 递增 epoch —— 已经在跑、但还没走到派发那一步的旧任务（正在下载附件、解析身份、
   *    或卡在 runtime.start）必须作废，否则它会在「已结束」回执之后把旧 prompt 发出去。
   * 2. 等 pendingSession —— 建会话是短操作。等它落地才能把这条刚建出来的会话一并停掉；
   *    但绝不等 group.tail：fallback 路径的 tail 要等整轮 send 结束，把它当锁会让 /new
   *    在长任务期间永远停不下来。
   * 3. 先登记 retired 再 stop —— runtime.stop 落库前会话状态仍是 idle，
   *    不先登记，stop 期间到达的消息会重新命中它。
   *
   * 只 stop 本轮真正还能被选回来的会话：已经是 failed/stopped 的，resolveLarkSession
   * 本来就不会复用，重复 /new 不该再对它们发一次 stop。反过来，上一次 stop 失败的会话
   * 仍然是活跃状态，于是它自然又出现在本轮目标里——重试不需要额外记账，也不能因为
   * 「已在 retired 集合里」就跳过。
   */
  async retireScopeSession(group: LarkGroup, config: StoredLarkConfig, event: LarkMessageEvent, scopeId: string) {
    if (!event.senderOpenId) throw new Error('缺少操作人身份，无法重开会话。');
    if (!this.state.runtime.stop) throw new Error('当前运行时无法结束会话，请前往 Dutydeck Web 处理。');
    group.epoch = (group.epoch ?? 0) + 1;
    for (const task of this.state.tasks.values()) {
      if (task.group === group && !task.submissionStarted && !task.resumeTask && !task.runtimeTaskId) {
        task.contextReadAbort?.abort(new DOMException('Lark turn was superseded', 'AbortError'));
        // 认领刚换手（首卡重试重新认领、还没交给任务）时 CAS 会失败，不能让 /new 整体失败：
        // epoch 已递增，持有新认领的一方派发前按 epoch 自己作废。其他写入错误照常抛出。
        await this.parts.runner.failPendingInbox(task, '请求在执行前被 /new 作废').catch(error => {
          if (!(error instanceof Error && error.message === 'Lark inbox claim was lost')) throw error;
          this.state.log.warn({ error, taskId: task.id }, '作废待执行请求的入站记录失败，交由持有认领的一方处理');
        });
      }
    }
    // 查询失败不吞：调用方会把异常变成一条「命令执行失败」的回执。
    const persisted = await listPersistedLarkSessions(this.state.runtime, config, event.chatId, event.chatType, scopeId, this.state.cardMappings);
    const pendingSessionId = (await group.pendingSession?.catch(() => undefined))?.id;
    const targets = new Set([
      ...persisted.filter(session => !['failed', 'stopped'].includes(session.state)).map(session => session.id),
      pendingSessionId,
      group.sessionId
    ].filter((id): id is string => Boolean(id)));
    // 卡住的会话（转交保留过的，或执行进程未确认停止、有任务待核对的）按转交的口径处理：只登记作废、不去停，写保留标记。
    // stop 停不下它，还会先取消它的排队任务；资源与待核对的任务要原样留给管理员。
    const store = this.state.workflowOptions.store;
    const retained = new Set<string>();
    for (const id of targets) if (await this.parts.reconcile.relaunchBlockedSession(config.appId, id)) retained.add(id);
    const retired = (group.retiredSessionIds ??= new Set());
    for (const id of targets) retired.add(id);
    group.sessionId = undefined;
    group.sessionConfigKey = undefined;
    const stopped = new Set<string>();
    try {
      for (const id of targets) {
        if (retained.has(id)) await store.set(relaunchRetainedKey(config.appId, id), JSON.stringify({ message_id: event.messageId }));
        else await this.state.runtime.stop(id, { kind: 'channel', id: event.senderOpenId, appId: config.appId });
        stopped.add(id);
      }
    } catch (error) {
      // A rejected stop must remain visible in this scope. In particular, do
      // not silently select a new session around an unconfirmed old process.
      for (const id of targets) if (!stopped.has(id)) retired.delete(id);
      throw error;
    }
    // /new 的边界要跨重启保留；交接请求另有 inbox.lineage 明确继承源事项。
    const boundarySession = [...targets][0] ?? persisted.at(-1)?.id;
    if (boundarySession) try {
      const sourceId = larkSourceId(config, event.chatId, event.chatType, scopeId);
      const mappings = this.state.cardMappings;
      await serialByKey(this.launchBindingTails, sourceId, async () => {
        const binding = await mappings.get(`lark-launch:${config.appId}`, sourceId);
        const extra = binding?.extra ? JSON.parse(binding.extra) : {};
        await mappings.save({ id: `lark-launch:${sourceId}`, channel: `lark-launch:${config.appId}`, externalId: sourceId,
          sessionId: boundarySession, extra: JSON.stringify({ ...extra, matterBoundary: true }), createdAt: new Date().toISOString() });
      });
    } catch (error) { this.state.log.warn({ error }, '保存事项边界失败'); }
    return { retired: targets.size > 0, retained: retained.size > 0 };
  }

  async validateNewSession(config: StoredLarkConfig, event: LarkMessageEvent, options: LarkLaunchOptions) {
    const actions: PolicyAction[] = [...(options.cwd ? ['run.change_cwd' as const] : []), ...(options.model || options.reasoningEffort ? ['run.change_model' as const] : []),
      ...(options.agentId ? ['run.change_agent' as const] : [])];
    for (const action of actions) {
      await this.parts.core.requireExecution('session', action);
      if (config.managedGroup) {
        const decision = await this.state.groupManager?.authorize(config.appId, event.chatId, event.senderOpenId, action);
        if (!decision?.allowed) throw new Error(decision?.reason ?? '当前账号没有修改会话目录、Agent 或模型的权限。');
      }
    }
    const agents = await this.state.runtime.listAgents?.();
    // --agent 换执行者时，模型与推理强度必须按**被请求的** Agent 校验，不能拿机器人默认 Agent 的启动契约去判。
    const requested = options.agentId
      ? agents?.find(item => item.id === options.agentId)
      : agents?.find(item => item.id === config.defaultAgentId);
    if (!requested) {
      if (!options.agentId) throw new Error('机器人尚未配置可用的默认 Agent。');
      const available = (agents ?? []).map(item => item.id).join('、');
      throw new Error(`Dutydeck 上没有可用的 Agent「${larkCommandEcho(options.agentId, 64)}」。${available ? `当前可用：${available}。` : '当前本机没有探测到可用 Agent。'}`);
    }
    // 换了 Agent 就不要再把机器人默认模型当成它的模型基线：两者未必属于同一个供应商。
    const modelBaseline = options.agentId && options.agentId !== config.defaultAgentId ? undefined : config.defaultModel;
    return validateLarkLaunchOptions(options, { ...requested, ...(config.workspace ? { cwd: config.workspace } : {}),
      ...(modelBaseline ? { model: modelBaseline } : {}), permissionMode: larkPermissionMode(config) }, config.workspaceAliases);
  }

  /**
   * 保留给管理员核对的旧会话不再被续聊选回。内存里的作废集合重启就没了，这里按持久化的保留标记补上；
   * 本话题的会话都被跳过时，resolveLarkSession 照常新建会话。
   */
  private async skipRetainedSessions(group: LarkGroup, appId: string) {
    const prefix = relaunchRetainedPrefix(appId);
    for (const row of await this.state.workflowOptions.store.list?.(prefix) ?? []) (group.retiredSessionIds ??= new Set()).add(row.key.slice(prefix.length));
  }

  async sessionFor(group: LarkGroup, config: StoredLarkConfig, chatId: string, chatType: LarkMessageEvent['chatType'], scopeId: string, launchOptions?: LarkLaunchOptions, beforeStart?: () => Promise<LarkLaunchOptions>) {
    // 建会话期间把 promise 挂到 group 上：并发的 /new 需要等它落地，才能把这条
    // 刚建出来的会话一起停掉，而不是让它在 /new 之后变成一个没人管的新上下文。
    const pending = this.skipRetainedSessions(group, config.appId)
      .then(() => resolveLarkSession(this.state.runtime, this.state.log, group, config, chatId, chatType, scopeId, this.state.cardMappings, launchOptions, beforeStart));
    const tracked = pending.catch(() => undefined);
    group.pendingSession = tracked;
    try { return await pending; }
    finally { if (group.pendingSession === tracked) group.pendingSession = undefined; }
  }

  /**
   * 切换后的模型与机器人配置的默认模型不一致时，普通消息的会话匹配（larkSessionMatchesScope）会在重启后认不出这条会话，
   * 悄悄另开新会话。像 /resume 一样写一条持久的启动绑定，让它按会话编号被认回来。返回 false 表示需要绑定却没写成。
   */
  async pinSwitchedSession(config: StoredLarkConfig, session: Session): Promise<boolean> {
    if (!session.sourceId || larkSessionMatchesScope(session, config, session.sourceId)) return true;
    const mappings = this.state.cardMappings, sourceId = session.sourceId;
    try {
      // 与 /new 写事项边界串行：/new 已结束这条会话时不再改绑定，否则会抹掉它刚写的边界。
      return await serialByKey(this.launchBindingTails, sourceId, async () => {
        const live = await this.state.runtime.getSession(session.id);
        if (!isRunnable(live)) return true;
        const channel = `lark-launch:${config.appId}`;
        const binding = await mappings.get(channel, sourceId);
        if (binding?.channel === channel && binding.externalId === sourceId && binding.sessionId === session.id) return true;
        // 旧绑定属于别的会话，它的事项边界等标记不能带到这条会话上；fallback 仍按“非显式指定 Agent”处理。
        await mappings.save({ id: `lark-launch:${sourceId}`, channel, externalId: sourceId, sessionId: session.id,
          extra: JSON.stringify({ baseConfigKey: larkSessionConfigKey(config), explicitAgent: false }), createdAt: new Date().toISOString() });
        return true;
      });
    } catch (error) {
      this.state.log.warn({ error, sessionId: session.id }, '保存切换后的会话绑定失败');
      return false;
    }
  }

  async closedScopeSessions(config: StoredLarkConfig, event: LarkMessageEvent, scopeId: string) {
    const candidates: Array<{ session: Session; firstTaskId: string; closedAt: string; approximate: boolean; title: string }> = [];
    for (const session of await listPersistedLarkSessions(this.state.runtime, config, event.chatId, event.chatType, scopeId, this.state.cardMappings)) {
      if (!['stopped', 'failed'].includes(session.state)) continue;
      const tasks = await this.state.runtime.getTasks?.(session.id) ?? [];
      // Empty command-created sessions have no context to restore.
      const first = [...tasks].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
      const origin = first ? await this.parts.core.larkTaskOrigin(config, event.chatId, { id: first.id, sessionId: session.id }) : undefined;
      if (!first || !origin?.requester || !await this.parts.core.isTaskOperatorAllowed(config, event, { id: first.id, sessionId: session.id }, 'run.resume')) continue;
      const events = await this.state.runtime.getRecentEvents?.(session.id, 500) ?? [];
      const closed = events.filter(item => item.type === 'status' && ['stopped', 'failed'].includes((item.data as { state?: string })?.state ?? ''))
        .sort((a, b) => b.sequence - a.sequence)[0];
      candidates.push({ session, firstTaskId: first.id, closedAt: closed?.timestamp ?? session.updatedAt, approximate: !closed, title: session.name ?? origin.title ?? larkTaskTitle(first.prompt, config.name) });
    }
    candidates.sort((a, b) => b.closedAt.localeCompare(a.closedAt));
    return candidates;
  }

  /** 从当前聊天有权读取的记录冻结交接，不调用模型，不扩展到无界事件历史。 */
  async newSessionHandoff(config: StoredLarkConfig, event: LarkMessageEvent, sessionId: string | undefined, tasks: TaskRecord[], note: string, nativeContextCopied = false) {
    const session = sessionId ? await this.state.runtime.getSession(sessionId) : undefined;
    if (sessionId) {
      const source = session?.sourceId ? parseLarkSourceId(session.sourceId) : undefined;
      if (session?.source !== 'lark' || source?.appId !== config.appId || source.chatId !== event.chatId || source.chatType !== event.chatType)
        throw new Error('无法核实交接来源属于当前机器人和聊天，未读取历史。');
    }
    const sessionUrl = sessionId && config.webBaseUrl ? safeLarkWebUrl(`${config.webBaseUrl.replace(/\/$/, '')}/sessions/${encodeURIComponent(sessionId)}`) : undefined;
    const source = { ...(sessionId ? { sessionId } : {}), ...(sessionUrl ? { sessionUrl } : {}) };
    const cwd = session?.cwd ?? config.workspace;
    if (nativeContextCopied) return formatLarkHandoff({ ...source, turns: [], note: '', nativeContextCopied: true, ...(cwd ? { cwd, git: await readGitSnapshot(cwd) } : {}) });
    const ordered = tasks.filter(task => task.sessionId === sessionId).sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const visible: TaskRecord[] = [];
    for (const task of ordered) {
      if (await this.parts.core.isTaskOperatorAllowed(config, event, task, 'task.view_result')) visible.push(task);
    }
    const recent = visible.filter(task => terminalTaskStates.has(task.status)).slice(-3);
    const other = visible.filter(task => !recent.includes(task));
    const important = (task: TaskRecord) => ['failed', 'interrupted', 'reconcile_required'].includes(task.status) ? 0 : 1;
    const indexed = [...other].sort((left, right) => important(left) - important(right) || left.createdAt.localeCompare(right.createdAt)).slice(0, larkHandoffIndexLimit);
    const window = sessionId && recent.length && this.state.runtime.getRecentEvents
      ? await this.state.runtime.getRecentEvents(sessionId, larkHandoffEventLimit).catch(() => []) : [];
    const store = this.state.workflowOptions.store;
    const cards = sessionId && recent.length ? await this.state.cardMappings.list(larkCardChannel(config.appId)).catch(() => undefined) : undefined;
    const explicitFinal = async (task: TaskRecord) => {
      const matches = (cards ?? []).flatMap(row => {
        try {
          const saved = parseCardTask(row.extra ?? '{}');
          return row.sessionId === sessionId && saved.app_id === config.appId && saved.runtime_task_id === task.id && saved.chat_id === event.chatId && saved.chat_type === event.chatType ? [{ row, saved }] : [];
        } catch { return []; }
      });
      const context = matches.length === 1 ? explicitFinalContext(matches[0]!.row, matches[0]!.saved, task.currentAttemptId) : undefined;
      const content = context ? (await readExplicitFinal(store, context).catch(() => undefined))?.trim() : undefined;
      return content ? redactTraceText(content) : undefined;
    };
    const title = async (task: TaskRecord) => (await this.parts.core.larkTaskOrigin(config, event.chatId, task).catch(() => undefined))?.title ?? larkTaskTitle(task.prompt, config.name);
    const turns = await Promise.all(recent.map(async task => {
      // A missing boundary must not attribute a neighbouring turn's output to this task.
      let start = -1;
      for (let index = 0; index < window.length; index++) {
        const item = window[index]!;
        if (item.type === 'text' && (item.data as any)?.role === 'user' && (item.data as any)?.taskId === task.id
          && (!task.currentAttemptId || !item.attemptId || item.attemptId === task.currentAttemptId)) start = index;
      }
      const next = start >= 0 ? window.findIndex((item, index) => index > start && item.type === 'text' && (item.data as any)?.role === 'user' && (item.data as any)?.taskId !== task.id) : -1;
      const events = start >= 0 ? eventsForRuntimeTask(window.slice(start, next < 0 ? undefined : next), task.id)
        .filter(item => (!item.taskId || item.taskId === task.id) && (!task.currentAttemptId || !item.attemptId || item.attemptId === task.currentAttemptId)) : [];
      const elements = renderLarkResultElements(events);
      const explicit = await explicitFinal(task);
      const result = explicit ?? elements.find(element => element.element_id === 'final_output')?.content
        ?? elements.find(element => String(element.element_id ?? '').startsWith('execution_alert_'))?.content;
      return { title: await title(task), status: task.status, taskId: task.id, attemptId: task.currentAttemptId, events,
        ...(typeof result === 'string' ? { result, resultSource: explicit ? 'explicit_final' as const : elements.some(element => element.element_id === 'final_output') ? 'agent_text' as const : 'execution_alert' as const } : {}) };
    }));
    const index = await Promise.all(indexed.map(async task => ({ title: await title(task), status: task.status, taskId: task.id, attemptId: task.currentAttemptId })));
    return formatLarkHandoff({ ...source, turns, index, taskTotal: visible.length, goal: visible[0]?.prompt, goalSource: visible[0] ? { taskId: visible[0].id, attemptId: visible[0].currentAttemptId } : undefined, note,
      eventsIncomplete: window.length >= larkHandoffEventLimit || turns.some(turn => !turn.events.length),
      ...(cwd ? { cwd, git: await readGitSnapshot(cwd) } : {}) });
  }
}
