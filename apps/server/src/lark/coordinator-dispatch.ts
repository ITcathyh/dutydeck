import { completeExplicitFinal, explicitFinalContext, hasExplicitFinal, withExplicitFinalLock } from './explicit-final.js';
import { mergeGroupTaskWatermark } from './group-task-context.js';
import { describeLarkTaskRecovery, notifyLarkTaskRecovery, verifiedLarkRecoveryOutput } from './task-recovery.js';
import { validateLarkLaunchOptions, type LarkLaunchOptions } from './new-session.js';
import { collectLarkTaskContext } from './task-context.js';
import { withLarkContextReadTimeout } from './context-read-timeout.js';
import { isLarkGroupMemoryPool, larkMemoryScope, type LarkMemoryEntry, type LarkMemoryScope } from './memory.js';
import { renderLarkMemoryInjection, renderMemoryIndex } from './memory-view.js';
import type { AgentEvent, PolicyAction, Session, TaskRecord, ToolRiskPolicy } from '@dutydeck/shared';
import { RuntimeError } from '@dutydeck/shared';
import { defaultHighRiskPattern, defaultLarkTraceLimit, larkPermissionMode, readLarkConfigs, type StoredLarkConfig } from './config.js';
import { boundLarkCardElements, larkIdentityPermissionHelp, LarkServiceError, type LarkCardService } from './service.js';
import {
  loadLarkTaskEvents,
  steeringOutcomeText,
  hasUnresolvedToolCalls,
  isLarkCardContentRejected,
  isLarkMessageRateLimit,
  isLarkMessageUnupdatable,
  larkRateLimitBackoffMs,
  patchRejectedCardDelta,
  renderLarkProcessElements,
  renderLarkResultElements,
  type LarkCardElement
} from './card-renderer.js';
import { deliverLarkCompletionReaction, larkResultKey, larkSilentResultAnchor, sendLarkResult } from './result-delivery.js';
import { larkRedispatchAgentNote, larkRedispatchCardNote } from './turn-redispatch.js';
import { larkCommandEcho, parseSlashCommand } from './commands.js';
import { renderQueueSummaryElement, QUEUE_SUMMARY_ELEMENT_ID } from './queue-summary.js';
import { replayedRecoveryNote } from './recovery-notes.js';
import { protocolModeNote } from './protocol-hints.js';
import { senderGroupMention } from './card-mentions.js';
import { larkTaskAgentGuid } from './task-agent.js';
import {
  findPersistedLarkSession,
  listPersistedLarkSessions,
  materializeLarkResources,
  parsePrompt,
  resolveLarkSession
} from './session-resolver.js';
import type { LarkMessageEvent } from './listener.js';
import type { LarkGroup, LarkTaskState, LarkTask, PersistedLarkCardTask } from './coordinator.js';
import { type LarkCommandPrompt, larkCardChannel, relaunchRetainedPrefix, relaunchRetainedKey, larkTaskTitle, sendTaskCard } from './coordinator-core.js';
import { LarkCoordinatorRecovery } from './coordinator-recovery.js';

// 飞书消息协调器 · 派发：为一条请求找到或新建会话、交给 runtime 执行，并跟随这一轮直到终态交付。

/** 空 @ 沿用同一用户上一条请求的时间窗：超过它就不再假定两条消息是同一次求助。 */
const ownRequestAdoptionWindowMs = 10 * 60 * 1000;

export abstract class LarkCoordinatorDispatch extends LarkCoordinatorRecovery {
  /**
   * 「提到队首」会中断当前正在执行的那一轮（runtime 的 promoteQueued 带 interrupt），
   * 所以除了队列自己的 queue.promote，还必须过与 /cancel 同一道 run.interrupt 门。
   * 当前没有正在执行的任务时没有可中断的对象，直接放行。
   */
  protected async canInterruptCurrentTurn(config: StoredLarkConfig, event: LarkMessageEvent, sessionId: string): Promise<boolean> {
    const running = this.runtime.getTasks ? (await this.runtime.getTasks(sessionId)).find(task => task.status === 'running') : undefined;
    return !running || await this.isTaskOperatorAllowed(config, event, { id: running.id, sessionId });
  }

  /**
   * 当前会话里正在排队或执行的那一轮，取最近创建的一条。
   * 判据来自 runtime 的真实任务记录，不看重启前留在卡片上的 state。
   */
  protected async findLiveRuntimeTask(sessionId: string) {
    if (!this.runtime.getTasks) return undefined;
    const tasks = await this.runtime.getTasks(sessionId);
    return [...tasks].reverse().find(task => task.status === 'queued' || task.status === 'running');
  }

  /**
   * 当前会话**最近**那一轮，且它确实是失败或被中断。
   *
   * 刻意不是 `reverse().find(failed)`：那会越过最新的 completed/running/queued，
   * 把用户早就放下的旧请求重新跑一遍。语义与内存里的 latestTask 一致——只看最近一轮，
   * 它不可重试就诚实地说没有可重试的任务。
   */
  protected pickRetryableRuntimeTask(tasks?: TaskRecord[]) {
    const latest = tasks?.at(-1);
    return latest && (latest.status === 'failed' || latest.status === 'interrupted' || latest.status === 'cancelled') ? latest : undefined;
  }

  /**
   * 恢复一轮运行的原始请求文本。
   *
   * 两道硬条件，缺一即失败（fail-closed）：
   * 1. 只在本 App 的卡片 channel 里找，且 app_id / chat_id 与当前命令一致——ou_/oc_
   *    这些 id 在不同 App 下含义不同，拿错一条就会把别的 App、别的聊天的请求重发出去。
   * 2. `runtime_task_id` 必须精确等于重试目标。同一会话里相邻那轮的 prompt 不是这一轮的
   *    prompt，拿它顶替等于替用户执行了一件他没要求的事。
   *
   * prompt 保留原用户目标；retry_material_prompt 单独保存身份/策略注入前的材料与附件说明。
   * 旧记录没有独立材料字段时，沿用当时保存的 prompt。身份与策略在重试时重新生成。
   */
  protected async restoreRetryPrompt(
    config: StoredLarkConfig,
    event: LarkMessageEvent,
    target: { id: string; sessionId: string }
  ): Promise<LarkCommandPrompt | undefined> {
    if (!this.cardMappings) return undefined;
    const mappings = await this.cardMappings.list(larkCardChannel(config.appId));
    for (const mapping of mappings) {
      if (mapping.sessionId !== target.sessionId || !mapping.extra) continue;
      let persisted: PersistedLarkCardTask;
      try { persisted = JSON.parse(mapping.extra) as PersistedLarkCardTask; }
      catch { continue; }
      if (persisted.app_id !== config.appId || persisted.chat_id !== event.chatId) continue;
      if (!persisted.runtime_task_id || persisted.runtime_task_id !== target.id) continue;
      const prompt = typeof persisted.prompt === 'string' ? persisted.prompt.trim() : '';
      if (prompt) return { prompt, materialPrompt: persisted.retry_material_prompt ?? prompt };
    }
    return undefined;
  }

  /**
   * 只读定位当前 App + chat + scope 的持久化会话。
   *
   * 查询失败**不吞**：调用方会把异常变成一条「命令执行失败」的回执。诚实地说不知道，
   * 好过让 /status 谎称没有会话、让 /new 在什么都没停掉的情况下回「已受理」。
   */
  protected async findScopeSession(config: StoredLarkConfig, event: LarkMessageEvent, scopeId: string, group: LarkGroup) {
    const session = await findPersistedLarkSession(this.runtime, config, event.chatId, event.chatType, scopeId, this.cardMappings);
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
  protected async retireScopeSession(group: LarkGroup, config: StoredLarkConfig, event: LarkMessageEvent, scopeId: string) {
    if (!event.senderOpenId) throw new Error('缺少操作人身份，无法重开会话。');
    if (!this.runtime.stop) throw new Error('当前运行时无法结束会话，请前往 Dutydeck Web 处理。');
    group.epoch = (group.epoch ?? 0) + 1;
    // 查询失败不吞：调用方会把异常变成一条「命令执行失败」的回执。
    const persisted = await listPersistedLarkSessions(this.runtime, config, event.chatId, event.chatType, scopeId, this.cardMappings);
    const pendingSessionId = (await group.pendingSession?.catch(() => undefined))?.id;
    const targets = new Set([
      ...persisted.filter(session => !['failed', 'stopped'].includes(session.state)).map(session => session.id),
      pendingSessionId,
      group.sessionId
    ].filter((id): id is string => Boolean(id)));
    // 卡住的会话（转交保留过的，或执行进程未确认停止、有任务待核对的）按转交的口径处理：只登记作废、不去停，写保留标记。
    // stop 停不下它，还会先取消它的排队任务；资源与待核对的任务要原样留给管理员。
    const store = this.workflowOptions.store;
    const retained = new Set<string>();
    if (store && this.runtime.getTasks && this.runtime.getTaskRecovery) {
      for (const id of targets) if (await this.relaunchBlockedSession(config.appId, id)) retained.add(id);
    }
    const retired = (group.retiredSessionIds ??= new Set());
    for (const id of targets) retired.add(id);
    group.sessionId = undefined;
    group.sessionConfigKey = undefined;
    const stopped = new Set<string>();
    try {
      for (const id of targets) {
        if (retained.has(id)) await store!.set(relaunchRetainedKey(config.appId, id), JSON.stringify({ message_id: event.messageId }));
        else await this.runtime.stop(id, { kind: 'channel', id: event.senderOpenId, appId: config.appId });
        stopped.add(id);
      }
    } catch (error) {
      // A rejected stop must remain visible in this scope. In particular, do
      // not silently select a new session around an unconfirmed old process.
      for (const id of targets) if (!stopped.has(id)) retired.delete(id);
      throw error;
    }
    return { retired: targets.size > 0, retained: retained.size > 0 };
  }

  /**
   * 本轮是否已被 /new 作废。作废时给用户一张只读回执说明这条请求没有执行——
   * 静默丢弃会让用户看着一个 OK 表情永远等不到结果。
   * 若作废前已经建出会话，一并交给 /new 停掉，不留游离的新上下文。
   */
  private supersededTurn(task: LarkTask, session?: Session): boolean {
    if (task.epoch === (task.group.epoch ?? 0)) return false;
    if (session) {
      (task.group.retiredSessionIds ??= new Set()).add(session.id);
      if (task.group.sessionId === session.id) { task.group.sessionId = undefined; task.group.sessionConfigKey = undefined; }
      void Promise.resolve(this.runtime.stop?.(session.id)).catch(error =>
        this.log.warn({ error, sessionId: session.id }, '停止被 /new 作废的会话失败'));
    }
    task.state = 'interrupted';
    task.retryable = false;
    this.log.info({ taskId: task.id, chatId: task.event.chatId }, '本轮已被 /new 作废，不再派发');
    void (async () => {
      // P0-4：作废回执是独立新消息，群聊开启时与失败回执同口径 @ 发起人；私聊不 @。
      const mention = senderGroupMention(task.config.groupCardMention, task.event);
      await sendTaskCard(this.service, task.event, {
        state: 'failed', readOnly: true, retryable: false,
        taskId: task.id, taskName: '请求未执行',
        markdown: `${mention ? `${mention}\n\n` : ''}**这条请求没有执行：期间收到了 /new。**\n\n上一个会话已结束，请重新发送这条请求。`,
        idempotencyKey: `superseded_${task.id}`.slice(0, 50),
        ...(task.config.webBaseUrl ? { webBaseUrl: task.config.webBaseUrl } : {})
      }, this.log).catch(error => this.log.error({ error, taskId: task.id }, '发送 /new 作废回执失败'));
      await this.clearAcknowledgementReaction(task);
    })();
    return true;
  }

  protected async validateNewSession(config: StoredLarkConfig, event: LarkMessageEvent, options: LarkLaunchOptions) {
    if (!this.cardMappings) throw new Error('当前运行时不支持保存首轮会话配置。');
    const actions: PolicyAction[] = [...(options.cwd ? ['run.change_cwd' as const] : []), ...(options.model || options.reasoningEffort ? ['run.change_model' as const] : []),
      ...(options.agentId ? ['run.change_agent' as const] : [])];
    for (const action of actions) {
      await this.requireExecution('session', action);
      if (config.managedGroup) {
        const decision = await this.groupManager?.authorize(config.appId, event.chatId, event.senderOpenId, action);
        if (!decision?.allowed) throw new Error(decision?.reason ?? '当前账号没有修改会话目录、Agent 或模型的权限。');
      }
    }
    const agents = await this.runtime.listAgents?.();
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
    for (const row of await this.workflowOptions.store?.list?.(prefix) ?? []) (group.retiredSessionIds ??= new Set()).add(row.key.slice(prefix.length));
  }

  protected async sessionFor(group: LarkGroup, config: StoredLarkConfig, chatId: string, chatType: LarkMessageEvent['chatType'], scopeId: string, launchOptions?: LarkLaunchOptions) {
    // 建会话期间把 promise 挂到 group 上：并发的 /new 需要等它落地，才能把这条
    // 刚建出来的会话一起停掉，而不是让它在 /new 之后变成一个没人管的新上下文。
    const pending = this.skipRetainedSessions(group, config.appId)
      .then(() => resolveLarkSession(this.runtime, this.log, group, config, chatId, chatType, scopeId, this.cardMappings, launchOptions));
    const tracked = pending.catch(() => undefined);
    group.pendingSession = tracked;
    try { return await pending; }
    finally { if (group.pendingSession === tracked) group.pendingSession = undefined; }
  }

  /**
   * 空 @ 若引用同一用户自己的消息，或紧跟在其刚发、机器人尚未回应的请求之后，沿用该请求；否则拉取最近聊天记录辅助澄清。
   */
  private async buildEmptyMessageFallback(event: LarkMessageEvent, appId: string): Promise<string> {
    const referenceId = event.parentId?.trim() || (event.threadId?.trim() ? event.rootId?.trim() : undefined);
    if (event.chatType === 'group' && event.senderType === 'user' && event.senderOpenId && referenceId
      && this.botOpenId && event.mentions.some(mention => mention.openId === this.botOpenId)) {
      try {
        // 精确读取被回复的消息，不因最近 20 条历史缺少它而丢失原请求，也不越过 parent 去执行旧 root。
        const original = await this.service.getMessage(referenceId);
        if (original.messageId === referenceId && original.chatId === event.chatId && !original.deleted
          && original.sender.type === 'user' && original.sender.idType === 'open_id' && original.sender.id === event.senderOpenId
          && ['text', 'post', 'rich_text'].includes(original.messageType)) {
          const { prompt } = await parsePrompt({
            ...event, messageId: original.messageId, messageType: original.messageType, content: original.rawContent,
            mentions: original.mentions.map(mention => ({
              key: mention.key ?? '', name: mention.name ?? '',
              ...(mention.id && (mention.idType === 'open_id' || mention.id.startsWith('ou_')) ? { openId: mention.id } : {})
            }))
          }, this.botOpenId);
          if (prompt.trim()) return `[Dutydeck 引用请求唤醒]\n用户通过本次 @ 请求你处理下面自己发出的原消息（${referenceId}）。原消息包含明确请求时，直接沿用该请求继续处理，不要仅因本次消息只有 @ 而要求重复确认；原消息没有明确请求或指代仍不清楚时，才询问缺少的信息。其他聊天记录、引用和转发内容仅作参考，仍遵守既有权限与高风险操作确认要求。\n\n[用户引用的原消息]\n${prompt}`;
        }
      } catch (error) {
        this.log.warn({ error, messageId: event.messageId, referenceId }, '读取空 @ 引用的原请求失败，改为询问确认');
      }
    }
    const confirmationRule = '你可以使用上下文识别指代，但当前消息没有明确请求。必须先复述你对用户意图的理解并询问确认；在用户明确确认前，不得执行命令、写入文件、发送消息或触发其他副作用。';
    const fallback = `用户仅 @ 了机器人而未发送任何文字内容。${confirmationRule}`;
    try {
      // 话题内的空 @ 优先拉取该话题的消息，保证上下文不串到群里其他话题。
      const threadId = event.threadId?.trim();
      const result = await this.service.listChatMessages({
        ...(threadId ? { threadId } : { chatId: event.chatId }),
        pageSize: 20,
        order: 'desc'
      });
      const messages = result.items
        .filter(item => item.messageId !== event.messageId && !item.deleted)
        .sort((a, b) => Number(a.createTime) - Number(b.createTime));
      if (!messages.length) return fallback;
      // 合并转发消息不自动展开，只返回占位提示；Agent 可通过群协作工具按 message_id 拉取转发内容。
      const texts = await Promise.all(messages.map(async item => (await parsePrompt({
        messageId: item.messageId,
        chatId: item.chatId ?? event.chatId,
        chatType: event.chatType,
        messageType: item.messageType,
        content: item.rawContent,
        mentions: item.mentions.map(mention => ({
          key: mention.key ?? '',
          name: mention.name ?? '',
          ...(mention.id && (mention.idType === 'open_id' || mention.id.startsWith('ou_')) ? { openId: mention.id } : {})
        }))
      }, this.botOpenId)).prompt));
      // 顶层空 @ 紧跟在同一用户自己刚发、本机器人还没回应的请求之后：直接沿用该请求，不再多问一轮确认。
      let ownIndex = -1;
      if (!referenceId && event.chatType === 'group' && event.senderType === 'user' && event.senderOpenId) {
        messages.forEach((item, index) => {
          if (item.sender.type === 'user' && item.sender.id === event.senderOpenId && Number(item.createTime) <= Number(event.createTime)) ownIndex = index;
        });
      }
      const own = messages[ownIndex];
      const ownText = texts[ownIndex]?.trim();
      if (own && ownText && !parseSlashCommand(ownText) && ['text', 'post', 'rich_text'].includes(own.messageType) && !own.mentions.length
        && Number(event.createTime) - Number(own.createTime) <= ownRequestAdoptionWindowMs
        // 只看原请求与本次 @ 之间：排队期间机器人为其他任务发出的消息不算已回应。
        && !messages.slice(ownIndex + 1).some(item => Number(item.createTime) <= Number(event.createTime)
          && ['app', 'bot'].includes(item.sender.type ?? '') && (item.sender.id === appId || item.sender.id === this.botOpenId))) {
        return `[Dutydeck 空 @ 沿用请求]\n用户刚发出下面这条消息（${own.messageId}），随后单独 @ 了你，请你处理它。原消息包含明确请求时，直接沿用该请求继续处理，不要仅因本次消息只有 @ 而要求重复确认；原消息没有明确请求或指代仍不清楚时，才询问缺少的信息。其他聊天记录仅作参考，仍遵守既有权限与高风险操作确认要求。\n\n[用户的原消息]\n${ownText}`;
      }
      const lines = messages.map((item, index) => `${item.sender.name || item.sender.id || '未知用户'}: ${texts[index] || '[图片/文件/卡片等非文字消息]'}`);
      return `[Dutydeck 空消息兜底]\n用户仅 @ 了机器人而未发送任何文字内容。以下是当前会话最近的聊天记录，仅用于识别指代。${confirmationRule}\n\n[最近聊天记录]\n${lines.join('\n')}`;
    } catch (error) {
      this.log.warn({ error, chatId: event.chatId, messageId: event.messageId }, '拉取飞书聊天记录为空消息兜底失败');
      return fallback;
    }
  }

  protected async runTurn(task: LarkTask) {
    if (this.stopped) return;
    const resumeTask = task.resumeTask;
    task.resumeTask = undefined;
    const restoring = task.restoring;
    task.restoring = false;
    // 每次 runTurn 递增轮次编号，用于让上一轮的终态回调（finish）识别自己已过期，
    // 避免它在 await getEvents 期间被重试打断后，把 task.state 覆盖回终态。
    task.turn = (task.turn ?? 0) + 1;
    const currentTurn = task.turn;
    // 重试另建过程卡和结果消息，上一轮消息保留为历史。
    // 先递增 turn，再清理关联，防止旧轮在途请求覆盖新轮消息归属。
    if (currentTurn > 1 && !restoring) {
      if (task.inbox) await this.inbox!.update(task.inbox, { state: 'received', turn: currentTurn, cardId: undefined, taskId: undefined, materials: undefined });
      task.cardMessageId = undefined;
      task.finalMessageId = undefined;
      task.finalAttachmentMessageId = undefined;
      task.finalDeliveredTurn = undefined;
      // 留着会让新一轮在尚未交付时就写出 final_delivery_state: 'reaction'，
      // 而 reconciler 把它当作「已交付」且不要求 final_message_id，对账会永久跳过补发。
      task.finalDeliveryState = undefined;
      task.finalElements = undefined;
      task.finalCardInput = undefined;
      task.lastSuccessfulElements = undefined;
      task.runtimeTaskId = undefined;
      task.progressFrozen = undefined;
    }
    const { group, event, config } = task;
    // 群级呈现覆盖已由 groupManager.resolved() 折算进 config，这里直接读。
    /** 中间进展静默：不新建过程卡、不刷进展帧；提问卡/审批卡与最终结果不受影响。 */
    const silentProgress = config.silentProgress === true;
    /** 完成时只贴表情：成功终态不发结果卡，只对原消息贴一枚表情；失败终态不适用。 */
    const completionReactionOnly = config.completionReactionOnly === true;
    // P0-4：仅独立失败/拒绝新消息在开启群 @ 时前置 @ 发起人；排队卡、心跳、私聊永不经过这里。
    const withGroupMention = (markdown: string): string => {
      const mention = senderGroupMention(config.groupCardMention, event);
      return mention ? `${mention}\n\n${markdown}` : markdown;
    };
    if (!this.workflows && task.resources.length) {
      task.prompt = await materializeLarkResources(event.messageId, task.prompt, task.resources, this.service);
      task.resources = [];
    }
    const cardContext = { agentName: await this.resolveAgentName(config), permissionMode: larkPermissionMode(config), ...(config.workspace ? { workspace: config.workspace } : {}) };
    const clearAcknowledgement = () => this.clearAcknowledgementReaction(task);
    const failContextRead = async (error: unknown, activeSession?: Session) => {
      if (this.stopped || task.turn !== currentTurn || this.supersededTurn(task, activeSession)) return;
      this.log.warn({ error, chatId: event.chatId, messageId: event.messageId }, '执行前读取飞书上下文失败');
      task.state = 'failed'; task.retryable = false; task.startedAt = Date.now();
      const card = await sendTaskCard(this.service, event, { ...cardContext, state: 'failed', retryable: false, readOnly: true,
        taskId: task.id, taskName: '上下文读取失败', markdown: '上下文读取超时或失败，Agent 尚未执行。请稍后重新发送请求。',
        idempotencyKey: `context_failed_${task.id}`.slice(0, 50),
        ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}) }, this.log);
      task.cardMessageId = card.messageId;
      if (task.inbox) await this.inbox!.update(task.inbox, { state: 'failed', error: '上下文读取超时或失败' });
      await clearAcknowledgement();
    };
    // 用户仅 @ 机器人而未发送文字时，拉取最近聊天记录作为上下文，让 Agent 判断用户意图。
    if (!task.prompt.trim()) {
      try { task.prompt = await withLarkContextReadTimeout(this.buildEmptyMessageFallback(event, config.appId), '空 @ 上下文读取'); }
      catch (error) { await failContextRead(error); return; }
    }
    const prompt = task.prompt;
    const taskTitle = larkTaskTitle(prompt, config.name);
    if (task.inbox?.request && task.inbox.request.prompt !== prompt) await this.inbox!.update(task.inbox, { request: { ...task.inbox.request, prompt } });

    let actorEmails: string[] = [];
    const allowedUsers = config.allowedUsers ?? [];
    const allowedEmails = config.allowedEmails ?? [];
    const allowedBots = config.allowedBots ?? [];
    const peerBotsAllowed = config.peerBotsAllowed !== false;
    const highRiskAllowedUsers = config.highRiskAllowedUsers ?? [];
    const highRiskAllowedEmails = config.highRiskAllowedEmails ?? [];
    const highRiskPattern = config.highRiskPattern || defaultHighRiskPattern;
    const riskControlEnabled = config.riskControlMode !== 'off';
    const botSender = event.senderType === 'app' || event.senderType === 'bot';
    let trustedPeerBot = false;
    if (botSender) {
      try {
        trustedPeerBot = Boolean(config.groupToolsEnabled && event.senderOpenId && await this.peerBotAuthorized?.(event.chatId, event.senderOpenId));
      } catch (error) {
        task.state = 'failed'; task.retryable = false; task.startedAt = Date.now();
        const card = await sendTaskCard(this.service, event, { ...cardContext, state: 'failed', retryable: false, taskId: task.id, taskName: 'Agent 协作身份校验失败', markdown: withGroupMention(`**无法验证发起交接的 Agent。**\n\n${error instanceof Error ? error.message : String(error)}`), ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}) }, this.log);
        task.cardMessageId = card.messageId;
        await clearAcknowledgement();
        return;
      }
    } else if ((!allowedUsers.length && allowedEmails.length) || (riskControlEnabled && !highRiskAllowedUsers.length && highRiskAllowedEmails.length)) {
      try {
        if (!event.senderOpenId) throw new Error('消息事件未包含发送人 open_id');
        actorEmails = await this.service.getUserEmails(event.senderOpenId);
        if (!actorEmails.length) throw new LarkServiceError('LARK_SENDER_EMAIL_EMPTY', '飞书没有返回当前发送人的邮箱字段', 409);
      } catch (error) {
        task.state = 'failed'; task.retryable = false; task.startedAt = Date.now();
        const card = await sendTaskCard(this.service, event, { ...cardContext, state: 'failed', retryable: false, taskId: task.id, taskName: '身份解析权限缺失', markdown: withGroupMention(larkIdentityPermissionHelp(error, config.appId)), ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}) }, this.log);
        task.cardMessageId = card.messageId;
        await clearAcknowledgement();
        return;
      }
    }
    const senderOpenId = event.senderOpenId ?? '';
    const allowedUser = allowedUsers.find(user => user.openId === senderOpenId);
    const allowedBot = allowedBots.find(bot => bot.openId === senderOpenId);
    const highRiskAllowedUser = highRiskAllowedUsers.find(user => user.openId === senderOpenId);
    const accessRestricted = allowedUsers.length > 0 || allowedEmails.length > 0;
    const allowed = config.managedGroup ? true : botSender
      ? (!accessRestricted || (peerBotsAllowed && trustedPeerBot) || Boolean(allowedBot))
      : !accessRestricted || (allowedUsers.length ? Boolean(allowedUser) : actorEmails.some(email => allowedEmails.includes(email)));
    if (!allowed) {
      task.state = 'failed'; task.retryable = false; task.startedAt = Date.now();
      const card = await sendTaskCard(this.service, event, { ...cardContext, state: 'failed', retryable: false, taskId: task.id, taskName: '访问被拒绝', markdown: withGroupMention('**当前账号不在机器人白名单中。**\n\n如需使用，请联系机器人管理员添加你。'), ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}) }, this.log);
      task.cardMessageId = card.messageId;
      await clearAcknowledgement();
      return;
    }
    const highRiskAuthorized = botSender
      ? false
      : (!riskControlEnabled || (!highRiskAllowedUsers.length && !highRiskAllowedEmails.length)
          ? allowed
          : highRiskAllowedUsers.length
            ? Boolean(highRiskAllowedUser)
            : actorEmails.some(email => highRiskAllowedEmails.includes(email)));
    const actorEmail = actorEmails[0];
    const riskPolicy: ToolRiskPolicy | undefined = config.riskControlMode === 'enforced' ? {
      enabled: true,
      authorized: highRiskAuthorized,
      pattern: highRiskPattern,
      ...(actorEmail ? { actorEmail } : {}),
      reason: '当前飞书发送人不在高危操作允许名单中'
    } : undefined;
    let session: Session;
    try {
      if (this.groupManager && event.chatType === 'group') {
        const decision = await this.groupManager.authorize(config.appId, event.chatId, event.senderOpenId, 'task.create', group.sessionId);
        if (decision && !decision.allowed) throw new LarkServiceError(decision.code, decision.reason, 403);
      }
      await this.requireExecution('session', 'task.create');
      if (riskPolicy) await this.requireExecution('high_risk', 'high_risk.execute');
      // 附件下载与身份解析都可能很慢，期间用户可能已经 /new。此刻建会话等于把旧请求
      // 送进一个用户已经宣布结束的上下文，还会顺带创建一条新会话污染新上下文。
      if (this.supersededTurn(task)) return;
      if (task.launchOptions && task.restoring && !resumeTask && !task.inbox?.sessionId) task.launchOptions = await this.validateNewSession(config, event, task.launchOptions);
      if (this.supersededTurn(task)) return;
      session = resumeTask ? (await this.runtime.getSession(resumeTask.sessionId))! : task.inbox?.sessionId ? (await this.runtime.getSession(task.inbox.sessionId))! : await this.sessionFor(group, config, event.chatId, event.chatType, task.scopeId, task.launchOptions);
      if (!session) throw new LarkServiceError('LARK_SESSION_MISSING', '原任务会话已不存在，请重新发送目标。', 409);
      // 建会话本身也可能卡住（runtime.start 未返回）。回来后再确认一次，
      // 并把这条会话交给 /new 收走，不留下一个游离的新上下文。
      if (this.supersededTurn(task, session)) return;
    }
    catch (error) {
      // Keep the durable inbox pending for the next daemon; lifecycle shutdown
      // is not an Agent startup failure.
      if (error instanceof RuntimeError && error.code === 'RUNTIME_SHUTTING_DOWN') return;
      task.state = 'failed'; task.startedAt = Date.now();
      const markdown = withGroupMention(`**Agent 启动失败**\n\n${error instanceof Error ? error.message : String(error)}`);
      const card = await sendTaskCard(this.service, event, { ...cardContext, state: 'failed', taskId: task.id, taskName: taskTitle, markdown, ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}) }, this.log);
      task.cardMessageId = card.messageId;
      await clearAcknowledgement();
      return;
    }
    task.sessionId = session.id;
    const legacyUpgradeNote = task.group.legacyUpgradeSessionId === session.id
      ? '这是升级后创建的新上下文；旧会话历史仍可查看，但原上下文未自动恢复。'
      : undefined;
    if (legacyUpgradeNote) task.group.legacyUpgradeSessionId = undefined;
    // P0-7：ask 模式下 pty/pty-cli 任务的工具确认只能在电脑前响应，首卡、排队卡与每帧心跳都如实标注。
    const protocolNote = protocolModeNote(session.protocol, larkPermissionMode(config));
    // S3：未知命令近似提示只追加到卡面，绝不进入 prompt（materialPrompt 保持原文）。
    // S8：replayed 置位后排队 PATCH 也带恢复注记；心跳帧的同名元素在 update() 内另拼。
    // 任务卡住时不写重启注记：它承诺「将继续跟踪执行进度」，卡住的任务没有进度可跟踪。
    const withCardNotes = (markdown: string, blocked = false): string =>
      [markdown, legacyUpgradeNote, protocolNote, task.replayedNote && !blocked ? replayedRecoveryNote() : undefined,
        task.redispatch ? larkRedispatchCardNote(task.redispatch) : undefined, task.steerNote,
        task.commandSuggestion ? `${task.commandSuggestion} 原文仍会作为普通请求执行。` : undefined]
        .filter((part): part is string => Boolean(part)).join('\n\n');
    cardContext.workspace = session.cwd;
    await this.groupManager?.recordRun(session, config, event, task.scopeId);
    let materialPrompt = task.retryMaterialPrompt ?? prompt;
    let contextCommit: (() => Promise<void>) | undefined;
    if (this.workflowOptions.store && !resumeTask) {
      const contextKey = `lark.context.${config.appId}.${session.id}`;
      let snapshot = task.inbox?.materials;
      if (!snapshot) {
        const raw = await this.workflowOptions.store.get(contextKey);
        const previous = raw ? JSON.parse(raw) : {};
        if (task.retryMaterialPrompt) snapshot = { prompt: task.retryMaterialPrompt, ...previous, contextBefore: raw };
        else {
          let context: Awaited<ReturnType<typeof collectLarkTaskContext>>;
          try {
            context = await withLarkContextReadTimeout(collectLarkTaskContext({ event, prompt, resources: task.resources, service: this.service, ...previous }), '话题上下文读取');
          } catch (error) { await failContextRead(error, session); return; }
          if (this.stopped || task.turn !== currentTurn || this.supersededTurn(task, session)) return;
          materialPrompt = context.agentPrompt;
          for (const sourceId of new Set(context.resources.map(resource => resource.sourceMessageId))) {
            materialPrompt = await materializeLarkResources(sourceId, materialPrompt, context.resources.filter(resource => resource.sourceMessageId === sourceId), this.service);
          }
          snapshot = { prompt: materialPrompt, cursor: context.cursor, readMessageIds: context.readMessageIds, contextBefore: raw };
        }
        if (task.inbox) await this.inbox!.update(task.inbox, { sessionId: session.id, materials: snapshot });
      }
      materialPrompt = snapshot!.prompt;
      const acceptedSnapshot = snapshot!;
      contextCommit = async () => {
        const next = JSON.stringify({ cursor: acceptedSnapshot.cursor, readMessageIds: acceptedSnapshot.readMessageIds });
        // A replay may arrive after a later accepted turn. Never roll its cursor back.
        if (await this.workflowOptions.store!.get(contextKey) === next) return;
        await this.workflowOptions.store!.compareAndSet!(contextKey, acceptedSnapshot.contextBefore, next);
      };
    }
    task.retryMaterialPrompt = materialPrompt;
    const initialState = resumeTask?.status === 'running' ? 'running' : this.runtime.dispatch ? 'queued' : 'running';
    task.state = initialState;
    task.events = resumeTask
      ? await loadLarkTaskEvents(this.runtime, session.id, resumeTask.id, Math.max((config.traceLimit ?? defaultLarkTraceLimit) * 30, 500))
      : [];
    if (!resumeTask) task.startedAt = Date.now();
    task.interruptRequested = false;
    // An accepted task keeps its original card and mapping while reattaching.
    if (!resumeTask) {
      const initialElements = boundLarkCardElements(renderLarkProcessElements([], config));
      const initialMarkdown = withCardNotes(initialState === 'queued' ? '任务已接收，正在准备执行…' : '正在思考中…');
      // 首张卡也必须带本轮 turn：它的按钮回调把 turn 写进 value，缺省会渲染成 "0"，
      // 而本轮 turn 从 1 起算——回调随后会被轮次校验当成上一轮的点击拒掉，
      // 直到某次心跳重绘才恢复。UI 不变，只是把回调绑到正确的轮次上。
      // 「正在思考中…」这张卡本身就是一条中间进展消息：静默时既不新建、也不刷已有的那张
      // （重放到一半才打开开关的旧卡仍会在终态被冻结，不会永远停在执行中）。
      if (silentProgress) {
        this.log.info({ taskId: task.id, chatId: event.chatId }, '中间进展静默：本轮不发执行过程卡');
      } else if (task.cardMessageId) {
        await this.service.update({ ...cardContext, cardKind: 'process', messageId: task.cardMessageId, permissionMode: larkPermissionMode(config), state: initialState, statusLabel: initialState === 'queued' ? '已接收' : undefined, taskId: task.id, taskName: taskTitle, markdown: initialMarkdown, sessionId: task.sessionId, turn: currentTurn, ...(task.inbox ? { idempotencyKey: `task_${event.messageId}_${currentTurn}`.slice(0, 50) } : {}), ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}), ...(this.workflowOptions.loginLinks ? { detailLogin: true } : {}) });
      } else {
        const card = await sendTaskCard(this.service, event, { ...cardContext, cardKind: 'process', ...(task.inbox ? { idempotencyKey: `task_${event.messageId}_${currentTurn}`.slice(0, 50) } : {}), state: initialState, statusLabel: initialState === 'queued' ? '已接收' : undefined, readOnly: initialState === 'queued', taskId: task.id, taskName: taskTitle, markdown: initialMarkdown, sessionId: task.sessionId, turn: currentTurn, ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}), ...(this.workflowOptions.loginLinks ? { detailLogin: true } : {}) }, this.log);
        task.cardMessageId = card.messageId;
      }
      task.lastSuccessfulElements = initialElements;
      await this.saveCardTask(task);
      if (task.inbox) await this.inbox!.update(task.inbox, { sessionId: session.id, cardId: task.cardMessageId, turn: currentTurn });
      await clearAcknowledgement();
    }

    let timer: NodeJS.Timeout | undefined;
    let heartbeatActive = false;
    /** 一次卡片更新的真实结果。终态交付只认这里的 delivered，不认「链已 resolve」。 */
    type CardUpdateOutcome = { delivered: boolean; messageId?: string };
    type PendingCardUpdate = {
      input: Parameters<LarkCardService['update']>[0];
      terminal: boolean;
      /** 入队时的轮次；重试开了新一轮之后，这一条必须整条作废，不得再碰上一轮的卡。 */
      turn: number;
      settle: (outcome: CardUpdateOutcome) => void;
    };
    let pendingUpdate: PendingCardUpdate | undefined;
    let updateChain: Promise<void> | undefined;
    let cardRateLimitFailures = 0;
    let cardRateLimitedUntil = 0;
    const flushUpdates = () => {
      if (updateChain) return updateChain;
      updateChain = (async () => {
        while (pendingUpdate) {
          const pending = pendingUpdate;
          pendingUpdate = undefined;
          let lastError: unknown;
          let delivered = false;
          let contentRejected = false;
          const deliveredMessageId = pending.input.messageId;
          // 整条 entry 的处理都包在 try/finally 里：PATCH 成功但落库失败时，
          // 也必须把这条 entry 结算掉。否则调用方的 await 永久挂起，cleanup 不会执行。
          try {
          /**
           * 这一条更新是否还属于当前轮次。
           *
           * 必须在**每次 await 之后**重新判断，不能只在入口判一次：dispatch 模式下
           * executeTask 在 dispatch 建立订阅后就返回，group.tail 随即 resolve，因此
           * 用户点重试时新一轮会立刻开跑并递增 turn——而上一轮的终态 PATCH 可能
           * 还悬在 await 里。等它回来时，task 上的 cardMessageId、lastSuccessfulElements、
           * finalMessageId 已经属于新一轮，旧轮次再写就会污染新一轮的卡片与持久化。
           * 判据用 pending.turn（入队时的轮次），不是现读的 task.turn。
           */
          const stale = () => this.stopped || pending.turn !== task.turn;
          if (stale()) continue;
          // 过程卡已被永久冻结：停止向已确认永久不可更新的卡 PATCH，避免重复浪费 API 调用。
          if (task.progressFrozen && pending.input.messageId === task.cardMessageId) {
            continue;
          }
          // 终态卡片是交付契约的一部分，值得多试几次；运行态心跳丢一帧无所谓。
          // 注意与 api-gate 的分层关系：gate 在 HTTP 层已做 429/5xx 退避重试
          // （默认 3 次），这里是业务层重试。持续 429 时两层会相乘，单次终态更新
          // 最坏可能拉长到分钟级。若线上观察到终态交付过慢，优先下调
          // LARK_API_RETRY_MAX_ATTEMPTS，而不是削减这里的终态重试次数。
          const attempts = pending.terminal ? 3 : 1;
          for (let attempt = 1; attempt <= attempts; attempt++) {
            try {
              await this.service.update(pending.input);
              lastError = undefined;
              delivered = true;
              // 更新本身打在旧卡上无害（那是它自己的卡），但快照属于新一轮，不能覆盖。
              if (pending.input.elements && !stale()) {
                // queue_summary 是该时刻的瞬态队列读数；若冻结进 last_successful_elements，
                // 守护进程重启后 reconciler 会在恢复卡上重放崩溃瞬间的陈旧「排队 N 条」。
                // protocol_hint / recovery_note 是持久事实，保留。
                task.lastSuccessfulElements = (pending.input.elements as LarkCardElement[])
                  .filter(element => element.element_id !== QUEUE_SUMMARY_ELEMENT_ID);
              }
              cardRateLimitFailures = 0;
              cardRateLimitedUntil = 0;
              break;
            } catch (error) {
              lastError = error;
              if (isLarkCardContentRejected(error)) { contentRejected = true; break; }
              if (isLarkMessageUnupdatable(error)) break;
              if (isLarkMessageRateLimit(error)) {
                cardRateLimitFailures += 1;
                cardRateLimitedUntil = Date.now() + larkRateLimitBackoffMs(cardRateLimitFailures);
              }
              this.log.warn({ error, messageId: pending.input.messageId, attempt, attempts }, '更新飞书服务卡片失败');
              // 轮次已翻页：不再为旧卡消耗重试预算，也不再制造新的在途请求。
              if (stale()) break;
              if (attempt < attempts) {
                const retryDelay = isLarkMessageRateLimit(error)
                  ? Math.max(0, cardRateLimitedUntil - Date.now())
                  : attempt * 300;
                await new Promise(resolve => setTimeout(resolve, retryDelay));
              }
            }
          }
          if (stale()) continue;
          // 过程卡内容被拒绝时保留上一次成功内容，结果消息独立交付。
          if (lastError && contentRejected && Array.isArray(task.lastSuccessfulElements) && task.lastSuccessfulElements.length) {
            const patchedElements = patchRejectedCardDelta(task.lastSuccessfulElements, pending.input.elements as LarkCardElement[] | undefined);
            try {
              await this.service.update({ ...pending.input, elements: patchedElements, markdown: undefined });
              delivered = true;
              lastError = undefined;
              if (!stale()) task.lastSuccessfulElements = patchedElements;
              this.log.warn({ messageId: pending.input.messageId, state: pending.input.state }, '飞书卡片增量被拒绝，已保留上次成功内容并原地修补');
            } catch (error) {
              lastError = error;
            }
          }
          if (stale()) continue;
          if (lastError) {
            if (isLarkMessageUnupdatable(lastError)) {
              // 异步失败处理必须捕获并核对当前 card id/轮次，旧卡失败不能冻结新卡/新任务。
              if (!this.stopped && pending.turn === task.turn && pending.input.messageId === task.cardMessageId) {
                task.progressFrozen = true;
                try {
                  await this.saveCardTask(task, pending.input.state ?? task.state);
                } catch (saveError) {
                  this.log.warn({ error: saveError, taskId: task.id, messageId: deliveredMessageId }, '持久化卡片冻结状态失败，等待对账');
                  this.scheduleReconcile();
                }
              } else {
                this.log.info({
                  taskId: task.id,
                  pendingTurn: pending.turn,
                  taskTurn: task.turn,
                  pendingMessageId: pending.input.messageId,
                  currentCardMessageId: task.cardMessageId
                }, '旧轮次或旧卡的不可更新错误，跳过冻结以保护当前卡片');
              }
            } else if (pending.terminal) {
              this.log.warn({ error: lastError, messageId: pending.input.messageId }, '执行过程卡更新失败，等待对账；结果仍将独立交付');
              this.scheduleReconcile();
            }
          }
          if (delivered && pending.input.state) {
            // 旧轮次不得写入新一轮的持久化：mapping 只有一行，写进去就把新一轮的
            // card_message_id / runtime_task_id 覆盖成上一轮的了。
            if (stale()) {
              this.log.info({ taskId: task.id, turn: pending.turn, messageId: deliveredMessageId }, '旧轮次终态已送达，但新一轮已开始，跳过持久化以免覆盖新一轮状态');
              continue;
            }
            if (pending.terminal) task.progressFrozen = true;
            // 落库失败不改变「卡片已经送达用户」这个事实，因此不回退 delivered：
            // 谎称未送达会让对账再交付一次。只补一次对账把持久化补上。
            try {
              await this.saveCardTask(task, pending.input.state);
            } catch (error) {
              this.log.warn({ error, taskId: task.id, messageId: deliveredMessageId }, '飞书卡片状态落库失败，卡片已送达，等待对账补齐持久化');
              this.scheduleReconcile();
            }
          }
          } finally {
            // 无论走哪条分支（含 continue 与异常）都必须结算，否则调用方永久挂起。
            pending.settle({ delivered, ...(delivered ? { messageId: deliveredMessageId } : {}) });
          }
        }
      })().finally(() => {
        updateChain = undefined;
        if (pendingUpdate) void flushUpdates();
      });
      return updateChain;
    };
    /**
     * 本轮是否已经请求过终态。终态一旦入队就固定这一轮的过程卡状态，
     * 之后到达的心跳/排队重绘不得把它挤掉，也不得在它之后再改写卡片。
     */
    let terminalLatched = false;
    /**
     * 入队一次卡片更新，返回的 promise 只在**这一条**更新有结果后才 resolve。
     *
     * 刻意不返回 updateChain：链的 finally 会为后到的 pendingUpdate 再起一次没人 await 的
     * flush，此时 await 旧链拿到的是「上一帧心跳写完了」，而不是「我的终态真的写进去了」。
     * 过程冻结必须以自己那次 PATCH 的真实结果为准，结果消息的交付另行记录。
     */
    const enqueueUpdate = (entry: Omit<PendingCardUpdate, 'settle'>) => {
      // 终态已经在队列里或已经写过：晚到的非终态重绘一律丢弃。
      // 心跳与终态可能同时在途（心跳的 PATCH 正在飞，终态紧接着入队），
      // 若允许覆盖，用户最终看到的会是一张停在「执行中」的卡。
      if (terminalLatched && !entry.terminal) return Promise.resolve({ delivered: false } as CardUpdateOutcome);
      if (entry.terminal) {
        terminalLatched = true;
        // 终态已定，心跳不能再排下一帧。
        heartbeatActive = false;
        if (timer) { clearTimeout(timer); timer = undefined; }
      }
      return new Promise<CardUpdateOutcome>(resolve => {
        // 被顶掉的那条永远不会执行，必须就地了结，否则它的 await 会永久挂起。
        pendingUpdate?.settle({ delivered: false });
        pendingUpdate = { ...entry, settle: resolve };
        void flushUpdates();
      });
    };

    const update = async (state: Exclude<LarkTaskState, 'interrupting'>) => {
      // Runtime running is monotonic for a turn. Late dispatch/cancel bookkeeping may
      // still report queued, but must never repaint an executing card backwards.
      if (state === 'queued' && task.state === 'running') return Promise.resolve({ delivered: false } as CardUpdateOutcome);
      const terminal = state === 'completed' || state === 'failed' || state === 'interrupted' || state === 'cancelled';
      const recovery = task.sessionId && task.runtimeTaskId && ['queued', 'reconcile_required', 'legacy_unresolved'].includes(state)
        ? await describeLarkTaskRecovery(this.runtime, task.sessionId, task.runtimeTaskId, state, undefined,
          { relaunch: await this.relaunchReady(config.appId, task.id, state, task.turn), ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}) }) : undefined;
      const notifyRecovery = async () => {
        if (!recovery?.blocked || !task.sessionId || !task.runtimeTaskId) return undefined;
        // 提醒卡上没有按钮也没有详情链接，正文按不提这两者重新生成。
        const notice = recovery.relaunch || config.webBaseUrl
          ? await describeLarkTaskRecovery(this.runtime, task.sessionId, task.runtimeTaskId, state) : recovery;
        return notifyLarkTaskRecovery({
          service: this.service, store: this.workflowOptions.store, log: this.log, appId: config.appId,
          sessionId: task.sessionId, taskId: task.runtimeTaskId, turn: task.turn, recovery: notice,
          target: { chatId: event.chatId, ...(event.chatType === 'group'
            ? { replyMessageId: event.messageId, replyInThread: Boolean(event.threadId?.trim()) } : {}) }
        });
      };
      if (!task.cardMessageId || (!terminal && (silentProgress || task.progressFrozen))) {
        await notifyRecovery();
        return { delivered: false } as CardUpdateOutcome;
      }
      if (timer) { clearTimeout(timer); timer = undefined; }
      let elements: LarkCardElement[] = boundLarkCardElements(renderLarkProcessElements(task.events, config, terminal));
      if (recovery) elements = [{ tag: 'markdown', element_id: 'task_recovery', content: recovery.markdown }];
      if (!terminal) {
        // 非终态帧固定追加三枚只 PATCH、不新消息的注记元素；终态帧一律不带。
        // 排队摘要读取失败只丢本帧摘要，不影响心跳主链路。
        const frameNotes: LarkCardElement[] = [];
        if (protocolNote) frameNotes.push({ tag: 'markdown', element_id: 'protocol_hint', content: protocolNote, text_size: 'notation', margin: '0px' });
        if (task.replayedNote && !recovery?.blocked) frameNotes.push({ tag: 'markdown', element_id: 'recovery_note', content: replayedRecoveryNote(), text_size: 'notation', margin: '0px' });
        if (task.redispatch) frameNotes.push({ tag: 'markdown', element_id: 'redispatch_note', content: larkRedispatchCardNote(task.redispatch), text_size: 'notation', margin: '0px' });
        // /steer 的降级说明也要跟着心跳走：这一轮没排队直接开跑时没有排队卡，注记只能挂在这里。
        if (task.steerNote) frameNotes.push({ tag: 'markdown', element_id: 'steer_note', content: task.steerNote, text_size: 'notation', margin: '0px' });
        if (task.sessionId && this.runtime.getTasks) {
          try {
            // 排队摘要只数「排在前面的」任务：update('queued') 重绘帧里当前任务自身也是 queued，
            // 不过滤会把自己计入「排队 N 条」，与排队 PATCH 使用的 queuedAhead 口径不一致。
            const queuedTasks = (await this.runtime.getTasks(task.sessionId))
              .filter(item => item.status === 'queued' && item.id !== task.runtimeTaskId);
            // 当前一轮停在审批上时，排队的都要等它处理完，摘要标题写明被审批阻塞。
            const blockedByApproval = queuedTasks.length > 0 && (await this.runtime.getPendingPermissions?.(task.sessionId) ?? []).length > 0;
            const queueSummary = renderQueueSummaryElement(queuedTasks, { blockedByApproval });
            if (queueSummary) frameNotes.push(queueSummary);
          } catch (error) {
            this.log.warn({ error, taskId: task.id }, '读取排队摘要失败，本帧跳过排队摘要');
          }
        }
        if (frameNotes.length) {
          elements = [
            ...elements.filter(element => element.element_id !== 'protocol_hint'
              && element.element_id !== 'recovery_note'
              && element.element_id !== 'redispatch_note'
              && element.element_id !== 'steer_note'
              && element.element_id !== QUEUE_SUMMARY_ELEMENT_ID),
            ...frameNotes
          ];
        }
      }
      const outcome = await enqueueUpdate({
        terminal,
        turn: task.turn,
        input: {
          ...cardContext,
          cardKind: 'process',
          messageId: task.cardMessageId!,
          permissionMode: larkPermissionMode(config),
          state,
          ...(recovery ? { statusLabel: recovery.label } : task.state === 'interrupting' ? { statusLabel: '等待停止确认', actionState: 'interrupting' as const } : {}),
          taskId: task.id,
          taskName: taskTitle,
          elapsedSeconds: (Date.now() - task.startedAt!) / 1_000,
          sessionId: task.sessionId,
          // 按钮能力按 runtime 实际状态注入。终态同样按能力表渲染，而不是一刀切 readOnly：
          // 失败/中断的这张卡就是用户唯一的入口，重试必须留在上面。
          turn: task.turn,
          ...(terminal && task.retryable !== undefined ? { retryable: task.retryable } : {}),
          // 完成后的回执写不写「结果见下条」：只贴表情的模式下不会再发结果消息。
          ...(state === 'completed' && !completionReactionOnly ? { resultFollows: true } : {}),
          capabilities: { ...this.capabilitiesForTask(task), ...(recovery?.relaunch ? { canRelaunch: true } : {}) },
          ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}),
          elements
        }
      });
      if (task.progressFrozen) await notifyRecovery();
      return outcome;
    };
    let terminalDelivery: Promise<void> | undefined;
    let verifiedOutput: AgentEvent | undefined;
    // Freeze the process card, then send one immutable result. Neither operation
    // counts as success for the other; reconciliation retries only the missing part.
    const deliverTerminal = (state: 'completed' | 'failed' | 'interrupted' | 'cancelled', completed = false) => {
      if (task.finalDeliveredTurn === currentTurn && (task.finalMessageId || task.finalDeliveryState === 'reaction')) return Promise.resolve();
      if (terminalDelivery) return terminalDelivery;
      terminalDelivery = withExplicitFinalLock(this.workflowOptions.store, task.runtimeTaskId ?? task.id, async () => {
        await update(state);
        // 终态先撤置顶：轮次校验之后再撤，重试开的新一轮会让上一轮的进度卡永远挂在置顶里。
        await this.unpinTaskCard(task);
        if (this.stopped || task.turn !== currentTurn) return;
        const runtimeTask = state === 'completed' && task.sessionId && task.runtimeTaskId
          ? (await this.runtime.getTasks?.(task.sessionId))?.find(item => item.id === task.runtimeTaskId) : undefined;
        const finalContext = state === 'completed' && task.sessionId ? explicitFinalContext(
          { externalId: task.id, sessionId: task.sessionId }, {
            app_id: config.appId, chat_id: event.chatId, chat_type: event.chatType,
            runtime_task_id: task.runtimeTaskId, task_name: taskTitle, prompt,
            state, started_at: task.startedAt!, turn: currentTurn,
            ...(event.chatType === 'group' ? { reply_message_id: event.messageId, reply_in_thread: Boolean(event.threadId?.trim()) } : {})
          }, runtimeTask?.currentAttemptId) : undefined;
        const explicit = await hasExplicitFinal(this.workflowOptions.store, finalContext);
        // 完成时只贴表情：成功终态改为在原消息上贴一枚表情，不再发结果卡。
        // 只对成功终态生效——失败/中断/取消仍必须发结果卡，一个表情等于把失败藏起来。
        // 任务通道的合成事件没有可贴的原消息，只能照常发结果卡，否则用户什么也收不到。
        if (!explicit && completionReactionOnly && state === 'completed' && !larkTaskAgentGuid(event.messageId)) {
          const reacted = await deliverLarkCompletionReaction(this.service, { appId: config.appId, messageId: event.messageId }, this.log, this.workflowOptions.store);
          if (this.stopped || task.turn !== currentTurn) return;
          // 贴失败就不记「已交付」：这枚表情是用户唯一能看到的完成信号，交给对账重试。
          if (reacted) {
            task.finalDeliveredTurn = currentTurn;
            task.finalDeliveryState = 'reaction';
          } else this.scheduleReconcile();
          await this.saveCardTask(task, state);
          return;
        }
        // 插话送达的这一轮没有自己的输出，也就没有可验收的结果。
        const context = completed && !task.steered ? this.interactionContext(task) : undefined;
        // P0-4：完成/失败/被中断的独立新消息在群聊开启时 @ 发起人；超长结果转文件消息时
        // 长文的 @ 保留在摘要卡，附件不 @；reaction 不承担通知。
        const terminalMention = senderGroupMention(config.groupCardMention, event);
        // 「它说做完了，其实没做完」是这类产品最常见的失望。平台验证是可核对的反证，
        // 但此前只存在于 Web；结果卡上必须把「验证过没有」和 Agent 的自述分开写清楚。
        const verification = await this.verificationView(task, config, state);
        const resultActions = await this.resultActionCapabilities(task, config, state);
        // 取消的任务没有执行过，注入的记忆 Agent 并没有看到。
        const memoryElements = state === 'cancelled' ? [] : await this.turnMemoryElements(config, task.sessionId, task.runtimeTaskId);
        const elements = [
          ...(explicit ? [] : task.steered ? [{ tag: 'markdown', element_id: 'steer_note', content: task.steerNote ?? steeringOutcomeText(task.steered) }] : renderLarkResultElements(verifiedOutput ? [verifiedOutput] : task.events)),
          ...(context && this.workflows ? await this.workflows.result(context, '') : []),
          ...(verification.element ? [verification.element] : []),
          ...memoryElements,
          ...(terminalMention ? [{ tag: 'markdown', element_id: 'group_mention', content: terminalMention }] : [])];
        if (this.stopped || task.turn !== currentTurn) return;
        const resultCardInput = {
          ...cardContext, cardKind: 'result' as const, state, taskId: task.id, taskName: taskTitle,
          sessionId: task.sessionId, turn: currentTurn, readOnly: true,
          elapsedSeconds: (Date.now() - task.startedAt!) / 1_000,
          capabilities: { ...this.capabilitiesForTask(task), ...verification.capabilities, ...resultActions },
          ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {})
        };
        const result = await completeExplicitFinal(this.workflowOptions.store, this.service, finalContext, resultCardInput, elements) ?? await sendLarkResult(this.service, {
          chatId: event.chatId,
          ...(event.chatType === 'group' ? { replyMessageId: event.messageId, replyInThread: Boolean(event.threadId?.trim()) } : {})
        }, { ...resultCardInput, elements, idempotencyKey: larkResultKey(task.cardMessageId ?? larkSilentResultAnchor(task.id, currentTurn)) }, this.log, this.workflowOptions.store);
        if (this.stopped || task.turn !== currentTurn) return;
        task.finalAttachmentMessageId = result.attachmentMessageId;
        task.finalMessageId = result.messageId;
        task.finalDeliveryState = 'delivered';
        task.finalDeliveredTurn = currentTurn;
        task.finalElements = result.elements;
        task.finalCardInput = resultCardInput;
        if (context && this.workflows) await this.workflows.result(context, result.messageId, result.attachmentMessageId ? [result.attachmentMessageId] : undefined).catch(error => {
          this.log.warn({ error, taskId: task.id }, '结果已送达，验收绑定等待对账补齐');
          this.scheduleReconcile();
        });
        if (this.stopped || task.turn !== currentTurn) return;
        await this.saveCardTask(task, state);
        if (context && this.workflows) {
          const feedback = (await this.workflows.list(config.appId)).find(item => item.kind === 'result' && item.taskId === context.taskId && ['accepted', 'needs_changes'].includes(item.state));
          if (feedback) await this.refreshResultFeedback(config, feedback.id);
        }
      }).catch(error => {
        this.log.error({ error, taskId: task.id, state }, '交付飞书执行结果失败，等待对账补偿');
        this.scheduleReconcile();
      }).finally(() => { terminalDelivery = undefined; });
      return terminalDelivery;
    };

    const closeSupersededPreparedTurn = async () => {
      if (task.epoch === (group.epoch ?? 0)) return false;
      this.pushTaskError(task, '这条请求没有执行：期间收到了 /new。请在新会话中重新发送。');
      task.state = 'interrupted'; task.retryable = false;
      await deliverTerminal('interrupted', false);
      if (task.inbox) await this.inbox!.update(task.inbox, { state: 'failed', error: '请求在执行前被 /new 作废' });
      return true;
    };

    const scheduleHeartbeat = () => {
      if (!heartbeatActive || timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        if (!this.stopped && task.turn === currentTurn) {
          void this.observeLiveWaiters(task).catch(error => this.log.warn({ error, taskId: task.id }, '待处理问题卡暂未送达，将随心跳重试'));
          // 跑够长才置顶：短任务不该改写群成员的会话列表。失败已在管理器内兜底。
          void this.pinLongRunningCard(task);
        }
        void update('running').finally(scheduleHeartbeat);
      }, Math.max(config.pushIntervalMs, cardRateLimitedUntil - Date.now()));
    };
    task.requestUpdate = async (state, completed) => {
      if (state === 'completed' || state === 'failed' || state === 'interrupted' || state === 'cancelled') return deliverTerminal(state, completed);
      await update(state);
    };
    const injected: string[] = [];
    injected.push(`[Dutydeck 机器人身份]
- 机器人名称：${config.name ?? config.appId}
- App ID：${config.appId}${session.cwd ? `\n- 工作区：${session.cwd}` : ''}`);
    injected.push('[飞书结果说明] 最终回复第一行用一句不含术语的话给出结论：做事类写完成了什么、还差什么；查问题或分析类写根因或判断。随后按需写影响与现状、用户是否需要处理及怎么做，有交付物再给入口。等待扫码、外部批准或用户操作时明确写出，不把本轮结束写成目标已完成。排查、告警分析、成本或流量归因这类请求，在结论之后附「可直接转发」一段：三到五句写给同事看的话，不含代码路径和命令。技术证据放在最后，无需展开执行日志。');
    // 群上下文按运行时会话增量注入，水位只在确认 prompt 已提交给 Agent 后推进。运行时对外只暴露任务状态：
    // running 在领取时就发，此时可能还在准备、尚未提交；completed / interrupted 只能来自已提交轮次的驱动结果
    // 或人工确认，failed 分不清是否提交过。所以只认这两种终态；其余终态、准备失败或重放旧任务都保留旧水位，
    // 下一轮按旧水位重读，内容只会更多不会漏。
    let groupContextCommit: (() => Promise<unknown>) | undefined;
    const commitGroupContext = async (status: unknown) => {
      const commit = groupContextCommit;
      groupContextCommit = undefined;
      if (status !== 'completed' && status !== 'interrupted') return;
      await commit?.().catch(error => this.log.warn({ error, taskId: task.id, sessionId: session.id }, '群上下文水位推进失败，下一轮按旧水位注入'));
    };
    if (event.chatType === 'group' && this.workflowOptions.participation) {
      try {
        const store = this.workflowOptions.store;
        const watermarkKey = `lark.group-context.${config.appId}.${session.id}`;
        const watermark = await store?.get(watermarkKey);
        const observedContext = await withLarkContextReadTimeout(this.workflowOptions.participation.taskContext({ appId: config.appId, chatId: event.chatId }, { triggerMessageId: event.messageId, watermark, groupTools: config.groupToolsEnabled }), '群上下文读取');
        if (observedContext) {
          injected.push(observedContext.text);
          // 排队的几轮都基于同一个旧水位；后完成的一轮 CAS 失败时读出当前值合并再写，最多 3 次，仍冲突就留日志。
          if (store?.compareAndSet) groupContextCommit = async () => {
            let expected = watermark;
            let next = observedContext.watermark;
            for (let attempt = 0; attempt < 3; attempt++) {
              if (await store.compareAndSet!(watermarkKey, expected, next)) return;
              expected = await store.get(watermarkKey);
              next = mergeGroupTaskWatermark(expected, observedContext.watermark);
              if (next === expected) return;
            }
            throw new Error('群上下文水位写回多次冲突');
          };
        }
        const instructions = await withLarkContextReadTimeout(this.workflowOptions.participation.instructions({ appId: config.appId, chatId: event.chatId }), '群长期指令读取');
        if (instructions.trim()) injected.push(`[Dutydeck 群长期指令 · 管理者配置]\n${instructions.trim()}`);
      } catch (error) {
        if (this.stopped || task.turn !== currentTurn || await closeSupersededPreparedTurn()) return;
        this.log.warn({ error, chatId: event.chatId, messageId: event.messageId }, '执行前读取群上下文失败');
        this.pushTaskError(task, '上下文读取超时或失败，Agent 尚未执行。请稍后重新发送请求。');
        task.state = 'failed'; task.retryable = false;
        await deliverTerminal('failed', false);
        if (task.inbox) await this.inbox!.update(task.inbox, { state: 'failed', error: '上下文读取超时或失败' });
        await clearAcknowledgement();
        return;
      }
    }
    if (this.stopped || task.turn !== currentTurn || await closeSupersededPreparedTurn()) return;
    if (config.preInjectPrompt?.trim()) injected.push(`[Dutydeck 预注入 Prompt]\n${config.preInjectPrompt.trim()}`);
    // 会话记忆随 agentPrompt 一起冻结进任务账本：事后能核对这一轮 Agent 看到的是哪几条记忆。
    // 读取失败只丢本轮注入并留日志，不阻断任务。注入了哪几条另记一份，结果卡与 Web 任务详情据此列出。
    let memoryTurn: { scope: LarkMemoryScope; ids: string[] } | undefined;
    if (config.memoryEnabled !== false && this.workflowOptions.memory) {
      try {
        const { store, projection, command } = this.workflowOptions.memory;
        const scope = larkMemoryScope(config.appId, event.chatId, event.chatType);
        const shared = isLarkGroupMemoryPool(scope);
        // 没有注入任何条目也要记：本轮 Agent 保存的、后台从本轮提取的记忆都按这份记录找到记忆池。
        memoryTurn = { scope, ids: [] };
        const [entries, state] = await withLarkContextReadTimeout(Promise.all([
          store.list(scope),
          store.getState(scope)
        ]), '会话记忆读取');

        let sharedEntries: Array<{ botName: string; entry: LarkMemoryEntry }> | undefined;
        if (event.chatType === 'group' && this.workflowOptions.store) {
          try {
            const allBots = await withLarkContextReadTimeout(
              readLarkConfigs(this.workflowOptions.store, { readOnly: true }),
              '机器人配置读取'
            );
            const peerBots = allBots.filter(b => b.appId !== config.appId && b.memoryEnabled !== false);
            if (peerBots.length > 0) {
              const peerResults = await withLarkContextReadTimeout(
                Promise.all(
                  peerBots.map(async peerBot => {
                    try {
                      // 对端的群共享池里也有它在别的群记下的条目，下面只取本群的。只读：不替对端触发旧账本迁移。
                      const peerList = await store.peek(larkMemoryScope(peerBot.appId, event.chatId, 'group'));
                      const botName = peerBot.name?.trim() || peerBot.displayName?.trim() || peerBot.appId;
                      return { botName, peerList };
                    } catch {
                      return undefined;
                    }
                  })
                ),
                '同群其他机器人记忆读取'
              );
              const seen = new Set(entries.map(e => e.content.trim()));
              const collected: Array<{ botName: string; entry: LarkMemoryEntry }> = [];
              for (const res of peerResults) {
                if (!res) continue;
                for (const item of res.peerList) {
                  if (item.topic !== 'conventions' || item.chatId !== event.chatId) continue;
                  const text = item.content.trim();
                  if (seen.has(text)) continue;
                  seen.add(text);
                  collected.push({ botName: res.botName, entry: item });
                }
              }
              if (collected.length > 0) {
                sharedEntries = collected;
              }
            }
          } catch (peerError) {
            this.log.warn({ error: peerError, chatId: event.chatId }, '读取同群其他机器人偏好失败，跳过共享记忆');
          }
        }

        const index = renderMemoryIndex(entries, state, { ...(shared ? { currentChatId: event.chatId } : {}), sharedEntries });
        const memoryBlock = renderLarkMemoryInjection(index.text, {
          command: command ?? 'dutydeck',
          directory: projection.directoryFor(scope),
          shared
        });
        if (memoryBlock) {
          injected.push(memoryBlock);
          memoryTurn.ids = index.ids;
        }
      } catch (error) {
        this.log.warn({ error, appId: config.appId, chatId: event.chatId, taskId: task.id }, '读取飞书会话记忆失败，本轮不注入记忆');
        injected.push('[Dutydeck 会话记忆状态] 会话记忆读取超时或失败，本轮未注入记忆；不要把未读到的内容判断为不存在。');
      }
    }
    if (event.chatType === 'group' && config.groupToolsEnabled && config.groupToolsAllowSend) {
      injected.push(`[Dutydeck 飞书当前消息 · 系统上下文]
- 当前消息 message_id：${event.messageId}
- 当前消息 thread_id：${event.threadId?.trim() || '事件未提供'}
- 若要延续当前讨论或回答当前提问，使用 group send --reply-to ${event.messageId} --in-thread。
- 若内容是独立公告、新任务或不应归入当前讨论，使用 group send 且不要传 --reply-to/--in-thread。
- reply-to 只能使用 om_* message_id，不能使用 omt_* thread_id。`);
    }
    if (riskControlEnabled && !highRiskAuthorized) injected.push(`[Dutydeck 安全策略 · 自动注入]\n当前飞书发送人不在高危操作允许名单中。禁止执行匹配以下正则的操作，也不要通过脚本、子进程、MCP 或其他等价方式绕过：\n${highRiskPattern}\n如果用户要求此类操作，请明确说明已被 Dutydeck 安全策略阻止。`);
    if (task.redispatch) injected.push(larkRedispatchAgentNote(task.redispatch));
    const agentPrompt = injected.length ? `${injected.join('\n\n')}\n\n[用户请求]\n${materialPrompt}` : materialPrompt;

    if (this.stopped || task.turn !== currentTurn || await closeSupersededPreparedTurn()) return;

    const appendEvent = (agentEvent: AgentEvent) => {
      const previous = task.events.at(-1);
      const data = agentEvent.data as any;
      const previousData = previous?.data as any;
      if (agentEvent.type === 'text' && previous?.type === 'text'
        && (data?.role ?? 'assistant') === (previousData?.role ?? 'assistant')) {
        task.events[task.events.length - 1] = { ...previous, data: { ...previousData, text: `${previousData?.text ?? ''}${data?.text ?? ''}` } };
      } else task.events.push(agentEvent);
      // Bound activity history after merging streamed text, so a long answer
      // also stays complete for runtimes without durable event retrieval.
      const maxBufferedEvents = Math.max((config.traceLimit ?? defaultLarkTraceLimit) * 20, 200);
      if (task.events.length > maxBufferedEvents) task.events = task.events.slice(-maxBufferedEvents);
    };

    if (this.runtime.dispatch) {
      task.state = 'queued';
      let runtimeTaskId: string | undefined;
      /** 共享目录在本轮派发前的代码指纹；本轮结束时与当前指纹比较，判断这一轮有没有改代码。 */
      let codeBefore: string | undefined;
      let active = false;
      let settling = false;
      let settled = false;
      let buffered: AgentEvent[] = [];
      let unsubscribe = () => {};
      const cleanup = () => {
        this.turnCleanups.delete(cleanup);
        heartbeatActive = false;
        if (timer) clearTimeout(timer);
        unsubscribe();
        // 只清自己那一轮的句柄。旧轮次的 cleanup 可能在重试开跑之后才执行
        // （deliverTerminal 的 await 刚回来），此时 requestUpdate 已经属于新一轮，
        // 清掉会让新一轮的刷新/取消变成「任务已结束」——与非 dispatch 分支的 finally 同规则。
        if (task.turn === currentTurn) task.requestUpdate = undefined;
      };
      this.turnCleanups.add(cleanup);
      const finish = (state: 'completed' | 'failed' | 'interrupted' | 'cancelled') => {
        if (settling || settled) return;
        settling = true;
        void commitGroupContext(state);
        heartbeatActive = false;
        void (async () => {
          if (runtimeTaskId && this.runtime.getRecentEvents) {
            try {
              const recentLimit = Math.max((config.traceLimit ?? defaultLarkTraceLimit) * 30, 500);
              const persistedEvents = await loadLarkTaskEvents(this.runtime, session.id, runtimeTaskId, recentLimit);
              // 读事件期间用户可能已经重试；旧轮次不得改写新一轮的事件缓冲。
              if (task.turn !== currentTurn) return;
              task.events = persistedEvents;
            } catch (error) {
              this.log.warn({ error, taskId: task.id, runtimeTaskId }, '读取任务最终事件失败，使用已接收事件生成终态卡片');
            }
          }
          // 若轮次已变（用户点击了重试并启动了新一轮），本轮终态回调不得覆盖新状态。
          if (task.turn !== currentTurn) return;
          verifiedOutput = state === 'completed' && runtimeTaskId
            ? await verifiedLarkRecoveryOutput(this.runtime, session.id, runtimeTaskId, task.events) : undefined;
          const resolvedState = state === 'completed' && !verifiedOutput && hasUnresolvedToolCalls(task.events) ? 'failed' : state;
          if (resolvedState !== state) this.log.warn({ taskId: task.id, runtimeTaskId }, '任务已结束但仍有工具未返回结果，按失败终态处理');
          settled = true;
          active = false;
          task.state = resolvedState;
          if (runtimeTaskId) await this.workflows?.expireTask(config.appId, runtimeTaskId);
          // 本轮改了代码就自动验证：结果卡按「验证执行中」交付，交付之后在后台真实执行验证命令。
          // 插话送达的这一条没有自己的一轮，代码是正在执行的那一轮改的，验证留给那一轮的结果卡。
          const autoVerification = resolvedState === 'completed' && !task.steered ? await this.planAutoVerification(task, codeBefore) : undefined;
          await deliverTerminal(resolvedState, resolvedState === 'completed').finally(cleanup);
          if (autoVerification) void this.runAutoVerification(task, autoVerification);
          // 本轮不自动验证：这个任务若是返修轮次，返修到此为止，登记的轮次移出待收尾。
          else if (config.verificationCommand?.trim() && !this.verifyInFlight.has(task.id)) {
            void this.settlePendingVerification(config.appId, task.id).catch(error => this.log.warn({ error, taskId: task.id }, '移出待收尾的自动验证失败'));
          }
          // 记忆提取排在终态交付之后，且只记真实 dispatch 过的完成轮次；失败只留日志。
          const memoryPipeline = this.workflowOptions.memory?.pipeline;
          if (memoryPipeline && resolvedState === 'completed' && runtimeTaskId) {
            void memoryPipeline.onTurnCompleted(larkMemoryScope(config.appId, event.chatId, event.chatType), { sessionId: session.id, taskId: runtimeTaskId, senderId: event.senderOpenId, senderKind: botSender ? 'bot' : 'human', sourceMessageId: event.messageId })
              .catch(error => this.log.warn({ error, appId: config.appId, chatId: event.chatId, taskId: runtimeTaskId }, '飞书会话记忆后台提取触发失败'));
          }
        })().catch(error => this.log.error({ error, taskId: task.id, runtimeTaskId }, '生成飞书任务终态失败'));
      };
      const receive = (agentEvent: AgentEvent) => {
        // 旧订阅可能在重试之后才送来事件（unsubscribe 发生在 cleanup，而 cleanup 排在
        // 终态交付之后）。这些事件属于上一轮，既不能推进新一轮状态，也不能混进它的缓冲。
        if (this.stopped || task.turn !== currentTurn) return;
        if (agentEvent.type === 'task') {
          const record = (agentEvent.data as any)?.task;
          if (!record || record.id !== runtimeTaskId) return;
          if (record.status === 'running') {
            active = true;
            heartbeatActive = true;
            // runtime 每次修订运行中的任务都会再发一次 running，最后一次紧挨着完成；只在出队时起算用时。
            if (!resumeTask && task.state === 'queued') task.startedAt = Date.now();
            task.state = 'running';
            void update('running').finally(scheduleHeartbeat);
          } else if (record.status === 'reconcile_required' || record.status === 'legacy_unresolved') {
            active = false;
            heartbeatActive = false;
            task.state = record.status;
            void update(record.status)
              .then(() => this.saveCardTask(task, record.status))
              .catch(error => this.log.warn({ error, taskId: task.id, status: record.status }, '更新需要核对状态卡片失败'))
              .finally(() => this.scheduleReconcile());
          } else if (record.status === 'completed' || record.status === 'failed' || record.status === 'interrupted' || record.status === 'cancelled') {
            const steering = (agentEvent.data as any)?.steering;
            if (record.status === 'completed' && steering?.outcome) { task.steered = String(steering.outcome); task.steerNote = steeringOutcomeText(task.steered); }
            finish(record.status);
          }
          return;
        }
        if (!active || settled) return;
        appendEvent(agentEvent);
        const context = this.interactionContext(task);
        if (context) void this.workflows?.observe(context, agentEvent, this.workflowObserveOptions(task)).catch(error => this.log.error({ error, taskId: task.id }, '发送飞书工作请求失败'));
        if (!settling) scheduleHeartbeat();
      };
      unsubscribe = this.runtime.subscribe(session.id, agentEvent => {
        if (!runtimeTaskId) buffered.push(agentEvent);
        else receive(agentEvent);
      });
      try {
        // 重启后接上的任务没有开始时的指纹，共享目录里就不自动验证。
        if (!resumeTask) codeBefore = await this.sharedWorkspaceFingerprint(task, session);
        const runtimeTask = resumeTask
          ? { ...((await this.runtime.getTasks!(session.id)).find(item => item.id === resumeTask!.id) ?? resumeTask), replayed: true, queuedAhead: 0 }
          : task.inbox
          ? await this.runtime.dispatch(session.id, prompt, 'queue', agentPrompt, riskPolicy, event.senderOpenId, `lark:${config.appId}:${event.messageId}:${currentTurn}`)
          : config.managedGroup
          ? await this.runtime.dispatch(session.id, prompt, 'queue', agentPrompt, riskPolicy, event.senderOpenId)
          : riskPolicy
          ? await this.runtime.dispatch(session.id, prompt, 'queue', agentPrompt, riskPolicy)
          : await this.runtime.dispatch(session.id, prompt, 'queue', agentPrompt);
        runtimeTaskId = runtimeTask.id;
        // 重连或按幂等键重放的是早先派发的那条 prompt，本轮新读的群上下文没有交给 Agent。
        if (runtimeTask.replayed) groupContextCommit = undefined;
        // S8：恢复接上的任务只置位一次；之后排队 PATCH 与每一帧非终态心跳都带重启注记。
        if (runtimeTask.replayed) task.replayedNote = true;
        // dispatch 期间用户可能已经重试（group.tail 在 dispatch 建立订阅后就 resolve 了）。
        // 旧轮次不得把自己的 runtime task 写成新一轮的，否则 mapping 里的任务归属就错了。
        if (task.turn !== currentTurn) return;
        task.runtimeTaskId = runtimeTask.id;
        // 重放的是早先那次派发，本轮新读的记忆没有交给 Agent，记录以那一次为准。
        if (memoryTurn && !runtimeTask.replayed) {
          await this.workflowOptions.memory!.store.recordTurn(memoryTurn.scope, { taskId: runtimeTask.id, sessionId: session.id, injected: memoryTurn.ids })
            .catch(error => this.log.warn({ error, runtimeTaskId }, '记录本轮注入的会话记忆失败，结果卡不列本轮记忆'));
        }
        // /steer：先把这条送进正在执行的那一轮（Agent 支持插话时）；送不进去再降级为提到队首。
        // 注记按真实结果写：插话送达、提升成功、提升失败、或本来就没有排队都各说各的，不预告成功。
        if (task.steer) {
          // 前面真的有东西才谈得上插队：只有自己一条时 steerQueued 无事可做，
          // 调了它再把异常写成「提升失败」，会把一个本来正常的情形说成出了问题。
          const ahead = this.runtime.getTasks
            ? (await this.runtime.getTasks(session.id).catch(() => []))
              .filter(item => item.id !== runtimeTask.id && (item.status === 'queued' || item.status === 'running'))
            : [];
          // 派发要花上几秒（附件、建会话），期间正在执行的可能已经换成别人的任务：
          // 插话与提升都会改变那一轮，真正动手前重新过一次中断门，命令层那次检查不能替这一刻背书。
          // 这道门要查通讯录（isMember 会真打飞书接口），抛异常不能连累这条任务：
          // runtime 已经接收它、还会照跑，把它打成 failed 就是发一张与事实相反的终态卡。
          // 插话与提升本身 fail closed：判不了就都不做。
          const allowed = runtimeTask.status === 'queued' && ahead.length > 0 && await this.canInterruptCurrentTurn(config, event, session.id).catch(() => false);
          const running = ahead.some(item => item.status === 'running');
          // 派发到插话之间这几秒，这条可能已经自己开跑或被取消：按它此刻的状态写，不说成插话或提升失败。
          const movedNote = async () => {
            const status = (await this.runtime.getTasks?.(session.id).catch(() => undefined))?.find(item => item.id === runtimeTask.id)?.status;
            return !status || status === 'queued' ? undefined
              : status === 'cancelled' ? '这条内容在插话之前已被取消。' : '这条内容在插话之前已经开始执行，按普通的一轮处理，没有插话。';
          };
          const steering = allowed && running && this.runtime.injectQueued
            ? await this.runtime.injectQueued(session.id, runtimeTask.id, event.senderOpenId).catch(error => {
              if (error instanceof RuntimeError && error.code === 'QUEUED_TASK_NOT_FOUND') return { outcome: 'moved' };
              this.log.warn({ error, runtimeTaskId }, '插话失败，降级为提升队首');
              return { outcome: 'failed' };
            })
            : undefined;
          // 没过中断门时没有尝试插话，原因由下面的门分支写。
          const reason = steering ? steeringOutcomeText(steering.outcome)
            : !this.runtime.injectQueued ? '当前 Agent 不支持插话。' : !running ? '当前没有正在执行的一轮可以插话。' : '';
          if (steering?.outcome === 'injected' || steering?.outcome === 'startedNewTurn') {
            task.steered = steering.outcome;
            task.steerNote = reason;
          } else if (steering?.outcome === 'moved') task.steerNote = await movedNote() ?? `${reason}这条内容按正常顺序排队。`;
          else task.steerNote = runtimeTask.status !== 'queued' || !ahead.length
            ? `${reason}此刻没有别的任务排在前面，这条内容会直接按顺序执行。`
            : !this.runtime.steerQueued
              ? `${reason}运行时也无法调整队列顺序：这条内容按正常顺序排队。`
              : !allowed
                ? `${reason}无法确认你有权中断正在执行的那一轮：这条内容按正常顺序排队。`
                : await this.runtime.steerQueued(session.id, runtimeTask.id, event.senderOpenId)
                .then(() => `${reason}已把这条内容提到队首，当前正在执行的那一轮会被中断。`)
                .catch(async error => {
                  this.log.warn({ error, runtimeTaskId }, '插话降级：提升队首失败，任务按原顺序排队');
                  return await movedNote() ?? `${reason}提升队首也失败了：这条内容按正常顺序排队。`;
                });
        }
        const mappingCommitted = await this.saveCardTask(task, task.state).then(() => true, error => {
          this.log.error({ error, runtimeTaskId }, '任务已接收，卡片映射待重启对账'); return false;
        });
        const contextCommitted = await (contextCommit?.() ?? Promise.resolve()).then(() => true, error => {
          this.log.warn({ error, runtimeTaskId }, '任务已接收，材料水位待重启对账'); return false;
        });
        if (task.inbox && contextCommitted && mappingCommitted) await this.inbox!.update(task.inbox, { state: 'accepted', taskId: runtimeTask.id }).catch(error => this.log.error({ error, runtimeTaskId }, '任务已接收，入站记录待重启对账'));
        if (task.turn !== currentTurn) return;
        // 先提交 queued UI，再消费订阅期间缓存的 running 事件，杜绝 running→queued 闪回。
        if (runtimeTask.status === 'queued' && task.state === 'queued' && !task.steered) {
          const recovery = await describeLarkTaskRecovery(this.runtime, session.id, runtimeTask.id, 'queued', runtimeTask.queuedAhead,
            { relaunch: await this.relaunchReady(config.appId, task.id, 'queued', task.turn), ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}) });
          const queueMarkdown = withCardNotes(recovery.markdown, recovery.blocked);
          // 此时 runtimeTaskId 已就位，取消排队才真正可执行，因此这一版卡片开始提供
          // 「取消」。首张「已接收」卡片刻意不提供（runtimeTaskId 尚未分配，点了必失败）。
          try {
            if (!task.cardMessageId || silentProgress || task.progressFrozen) await update('queued');
            else await this.service.update({ ...cardContext, cardKind: 'process', messageId: task.cardMessageId, permissionMode: larkPermissionMode(config), state: 'queued', statusLabel: recovery.label, taskId: task.id, taskName: taskTitle, markdown: queueMarkdown, sessionId: task.sessionId, turn: task.turn, capabilities: { ...this.capabilitiesForTask(task), ...(recovery.relaunch ? { canRelaunch: true } : {}) }, ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}) });
            await this.saveCardTask(task, 'queued');
          } catch (error) {
            // Runtime already owns this task. A receipt/mapping outage must not
            // discard buffered events or report the accepted execution failed.
            this.log.warn({ error, runtimeTaskId }, '任务已接收，排队卡片待后续更新');
            this.scheduleReconcile();
          }
        }
        for (const agentEvent of buffered) receive(agentEvent);
        buffered = [];
        if (runtimeTask.replayed) {
          receive({ id: `replayed_${runtimeTask.id}`, sessionId: session.id, sequence: 0, timestamp: new Date().toISOString(), type: 'task', data: { task: runtimeTask } });
          if (runtimeTask.status === 'running') await this.observeLiveWaiters(task).catch(error => this.log.error({ error, runtimeTaskId }, '恢复任务待处理问题失败'));
        }
      } catch (error) {
        // dispatch 失败也可能是在重试之后才抛出的；旧轮次不得把新一轮打成 failed。
        if (task.turn !== currentTurn) return;
        if (error instanceof RuntimeError && error.code === 'RUNTIME_SHUTTING_DOWN') { cleanup(); return; }
        task.events.push({ id: `lark-error-${event.messageId}`, sessionId: session.id, sequence: Number.MAX_SAFE_INTEGER, type: 'error', timestamp: new Date().toISOString(), data: { message: error instanceof Error ? error.message : String(error) } });
        task.state = 'failed';
        await deliverTerminal('failed', false);
        cleanup();
      }
      return;
    }

    const unsubscribe = this.runtime.subscribe(session.id, agentEvent => {
      if (this.stopped || task.turn !== currentTurn) return;
      appendEvent(agentEvent);
      scheduleHeartbeat();
    });
    try {
      heartbeatActive = true;
      scheduleHeartbeat();
      let sent: unknown;
      if (config.managedGroup) sent = await this.runtime.send(session.id, prompt, agentPrompt, riskPolicy, event.senderOpenId);
      else if (riskPolicy) sent = await this.runtime.send(session.id, prompt, agentPrompt, riskPolicy);
      else if (agentPrompt === prompt) sent = await this.runtime.send(session.id, prompt);
      else sent = await this.runtime.send(session.id, prompt, agentPrompt);
      // send 在未提交就结束时也会正常返回（status: failed），同样只认结果里的终态。
      await commitGroupContext((sent as { status?: unknown } | undefined)?.status);
      // 若轮次已变（用户在 send 期间点击了重试），本轮不得覆盖新状态。
      if (task.turn !== currentTurn) return;
      if (task.interruptRequested) {
        task.state = 'interrupted';
        await deliverTerminal('interrupted', false);
      } else {
        task.state = 'completed';
        await deliverTerminal('completed', true);
      }
    } catch (error) {
      if (task.turn !== currentTurn) return;
      if (task.interruptRequested) {
        task.state = 'interrupted';
        await deliverTerminal('interrupted', false);
      } else {
        if (!task.events.some(item => item.type === 'error')) task.events.push({ id: `lark-error-${event.messageId}`, sessionId: session.id, sequence: Number.MAX_SAFE_INTEGER, type: 'error', timestamp: new Date().toISOString(), data: { message: error instanceof Error ? error.message : String(error) } });
        task.state = 'failed';
        await deliverTerminal('failed', false);
      }
    } finally {
      heartbeatActive = false;
      if (timer) clearTimeout(timer);
      unsubscribe();
      if (task.turn === currentTurn) task.requestUpdate = undefined;
    }
  }
}
