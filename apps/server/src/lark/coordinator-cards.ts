import { createHash } from 'node:crypto';
import { isLarkTurnMemoryElement, renderLarkTurnMemoryElements } from './memory-view.js';
import type { ChannelMapping, PublicSessionSchedule, Session, VerificationResponse } from '@dutydeck/shared';
import { RuntimeError } from '@dutydeck/shared';
import { readLarkConfig, type StoredLarkConfig } from './config.js';
import { inferLarkVerificationCommand, larkInsideGitRepository, larkPendingVerificationKey, larkVerificationBase, larkVerificationOutcome, larkVerificationRepairNotice, larkVerificationRepairPrompt, larkWorkspaceChanged, maxLarkPendingVerifications, mutateLarkPendingVerifications, parseLarkPendingVerifications, shouldAutoVerifyLarkTurn, type LarkAutoVerificationProgress, type LarkPendingVerification } from './auto-verification.js';
import { renderLarkVerificationElement, LARK_VERIFICATION_ELEMENT_ID, type LarkCardElement } from './card-renderer.js';
import { isLarkCardActionAvailable, isLarkCardFollowUpPrompt, larkCardActionLabel, larkCardFollowUpPrompt, type LarkCardActionState, type LarkCardActionValue, type LarkCardCapabilities } from './card-actions.js';
import { larkCommandEcho } from './commands.js';
import { isFileResultDelivery, reactionDedupeKey, reactionEmojiForAcceptance, type ReactionRecord } from './reaction-records.js';
import { appendLarkTaskSteps, larkTaskAgentGuid } from './task-agent.js';
import { findPersistedLarkSession, larkGroupKey, larkSessionConfigKey } from './session-resolver.js';
import type { LarkMessageEvent } from './listener.js';
import type { LarkTaskState, LarkTask, PersistedLarkCardTask } from './coordinator.js';
import { larkCardChannel, withoutLeadingBotMention, larkTaskTitle, larkScopeContinuesFor, sendTaskCard } from './coordinator-core.js';
import { LarkCoordinatorCore } from './coordinator-core.js';

// 飞书消息协调器 · 卡片生命周期：卡片映射的持久化与还原、结果卡的重绘与卡上操作、置顶、
// 自动验证与本轮记忆在结果卡上的呈现。

/** 重复请求判定用的请求原文：去掉开头的 @机器人，合并空白。 */
const larkRequestText = (prompt: string, botName?: string) => withoutLeadingBotMention(prompt, botName).replace(/\s+/g, ' ');
/** 同一发起人在同一个聊天里多久之内发过同一句话，才算重复请求。 */
const repeatedRequestWindowMs = 14 * 24 * 60 * 60 * 1000;
/** 北京时间的 HH:MM，秒数直接舍去。 */
const shanghaiClock = (at: number) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
const resultActionDigest = (...parts: Array<string | number>) => createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 32);
/**
 * 续问按钮的去重认领：同一张结果卡（任务 + 轮次）上的同一个按钮只提交一轮，落库后重启仍成立。阶段与转交认领同一套：
 * claimed 是正在代发并登记（boot 不是本进程，说明上个进程半路退出，下一次点击接手）；submitted 是代发的消息已登记进
 * inbox，之后的点击只回执；failed 可以再点。message_id 是代发出去的那条消息，登记前先记下：接手时沿用它，已登记的不再提交。
 */
const followUpClaimKey = (appId: string, digest: string) => `lark.result_follow_up.${appId}.${digest}`;
type LarkFollowUpClaim = { boot: string; phase: 'claimed' | 'submitted' | 'failed'; operator_open_id: string; claimed_at: string; message_id?: string };
/**
 * 「每天自动执行」的登记：同一张结果卡只建一个计划，渲染端也靠它把按钮画成「已设为…」。阶段同上：claimed 是正在建，
 * created 是计划已建好并启用，failed 可以再点。schedule_id 在计划落库之前就记下：接手时先按它找回计划补完启用，找不到再建。
 */
const dailyScheduleKey = (appId: string, digest: string) => `lark.result_schedule.${appId}.${digest}`;
type LarkDailyScheduleRecord = { boot: string; phase: 'claimed' | 'created' | 'failed'; operator_open_id: string; time: string; schedule_id?: string };
/** 候选验证命令每个工作区只提议一次：键按 App + 工作区，值是提议它的那张结果卡（任务 + 轮次）。 */
const verificationSuggestionKey = (appId: string, workspace: string) => `lark.verification_suggestion.${appId}.${resultActionDigest(workspace)}`;
/** 结果卡续问行回调的服务端目标：全部取自持久化映射，卡片上只信 task_id 与 turn 用来定位。 */
type LarkResultActionTarget = {
  current: StoredLarkConfig; config: StoredLarkConfig; mapping: ChannelMapping; saved: PersistedLarkCardTask;
  task: LarkTask; operator: string; scopeId: string; resultMessageId: string;
};

export abstract class LarkCoordinatorCards extends LarkCoordinatorCore {
  protected async observeLiveWaiters(task: LarkTask) {
    const context = this.interactionContext(task);
    if (!context || !this.workflows) return;
    await this.workflows.reconcile(context.appId, context.taskId);
    for (const permission of await this.runtime.getPendingPermissions?.(context.sessionId) ?? []) {
      await this.workflows.observe(context, { id: permission.id, sessionId: context.sessionId, sequence: 0,
        timestamp: new Date().toISOString(), type: 'permission_request', data: permission }, this.workflowObserveOptions(task));
    }
    for (const ask of this.workflowOptions.broker?.listPending(context.sessionId) ?? []) {
      await this.workflows.observe(context, { id: ask.id, sessionId: context.sessionId, sequence: 0,
        timestamp: new Date().toISOString(), type: 'text', data: { relay: 'ask', askId: ask.id } }, this.workflowObserveOptions(task));
    }
  }

  protected async saveCardTask(task: LarkTask, state = task.state) {
    await this.persistCardTask(task, state);
    // 任务通道派来的任务：同一处状态汇聚点顺带把进度写成飞书任务记录。
    await this.writeLarkTaskStep(task, state);
  }

  private async persistCardTask(task: LarkTask, state: LarkTaskState) {
    // 静默进展下没有过程卡，映射仍然要落库：没有它，重启后这条任务就彻底失联。
    if (!this.cardMappings || !task.sessionId || !task.startedAt) return;
    const extra: PersistedLarkCardTask = {
      app_id: task.config.appId,
      sender_open_id: task.event.senderOpenId,
      ...(task.event.senderType ? { sender_type: task.event.senderType } : {}),
      thread_id: task.event.threadId,
      scope_id: task.scopeId,
      chat_id: task.event.chatId,
      ...(task.cardMessageId ? { card_message_id: task.cardMessageId } : {}),
      ...(task.runtimeTaskId ? { runtime_task_id: task.runtimeTaskId } : {}),
      task_name: larkTaskTitle(task.prompt, task.config.name),
      prompt: task.prompt,
      ...(task.retryMaterialPrompt ? { retry_material_prompt: task.retryMaterialPrompt } : {}),
      state,
      chat_type: task.event.chatType,
      turn: task.turn,
      ...(task.finalMessageId
        ? { final_message_id: task.finalMessageId, final_delivery_state: 'delivered' as const }
        : task.finalDeliveryState === 'reaction' ? { final_delivery_state: 'reaction' as const } : {}),
      ...(task.finalAttachmentMessageId ? { final_attachment_message_id: task.finalAttachmentMessageId } : {}),
      ...(task.finalElements ? { final_elements: task.finalElements } : {}),
      ...(task.finalCardInput ? { final_card_input: task.finalCardInput } : {}),
      ...(task.progressFrozen ? { progress_frozen: true } : {}),
      ...(task.lastSuccessfulElements?.length ? { last_successful_elements: task.lastSuccessfulElements } : {}),
      // 没有进展也写这个键（序列化时省略）：同一轮合并写时要能清掉旧的进展。
      verification_auto: task.autoVerification,
      ...(task.event.chatType === 'group' ? {
        reply_message_id: task.event.messageId,
        ...(task.event.threadId?.trim() ? { reply_in_thread: true } : {})
      } : {}),
      started_at: task.startedAt
    };
    const channel = larkCardChannel(task.config.appId);
    const row = { id: `${channel}:${task.id}`, channel, externalId: task.id, sessionId: task.sessionId,
      createdAt: new Date(task.startedAt).toISOString() };
    // 合并必须和写入基于同一次读：对账（reconciler.ts）用 compareAndSetExtra 写同一条
    // 记录，「读—改—写」会把它先写进去的字段整条丢掉。冲突时重读重算，而不是覆盖。
    for (let attempt = 0; ; attempt++) {
      let current: { sessionId: string; extra?: string | null } | undefined;
      try { current = await this.cardMappings.get(channel, task.id); }
      catch { /* 读不到就整体覆写：至少保证当前轮次可恢复 */ }
      const merged = this.mergeCardTaskExtra(current?.extra, extra, task.turn, current?.sessionId === task.sessionId);
      // 新建记录、换了会话（/new 之后 sessionId 变了）、或存储没有 CAS（测试替身）时
      // 只能整行落库——compareAndSetExtra 写不了 extra 以外的列。
      if (!current || current.sessionId !== task.sessionId || typeof this.cardMappings.compareAndSetExtra !== 'function' || attempt >= 5) {
        if (attempt >= 5) this.log.warn({ taskId: task.id, turn: task.turn }, '飞书卡片映射并发写冲突反复失败，改为整行覆写');
        await this.cardMappings.save({ ...row, extra: JSON.stringify(merged) });
        return;
      }
      if (await this.cardMappings.compareAndSetExtra(row.id, current.extra, JSON.stringify(merged))) return;
    }
  }

  /**
   * 同一轮次内按合并写。LarkTask 带不回持久化记录里的全部字段：重启后重建的任务
   * （restoreVerifyCardAction）只带回一个子集，result_feedback_state 更是根本不在任务上。
   * 整体覆写会在「重启后点运行验证」这一步把附件绑定、验收状态与冻结标记一起抹掉，
   * ✅ 再也打不到那条文件消息上，对账也会开始反复重绘已终态的卡。
   * 轮次推进时不合并：新一轮本来就要清掉上一轮的卡片归属与终态。同一会话里的新一轮（重试）只把
   * 上一轮的卡片消息 ID 记进 earlier_message_ids（最多留 20 个），旧卡上的「查看详情」仍能认回这条任务；
   * 换了会话（转到新会话中执行）时上一轮的卡由转交认领认回原会话，这里不记。
   */
  private mergeCardTaskExtra(previous: string | null | undefined, extra: PersistedLarkCardTask, turn: number, sameSession: boolean): PersistedLarkCardTask {
    try {
      const parsed = previous ? JSON.parse(previous) as PersistedLarkCardTask : undefined;
      if (parsed && (parsed.turn ?? 0) === turn) return { ...parsed, ...extra };
      const earlier = [...parsed?.earlier_message_ids ?? [], ...(sameSession ? [parsed?.card_message_id, parsed?.final_message_id] : [])]
        .filter((id): id is string => Boolean(id)).slice(-20);
      if (earlier.length) return { ...extra, earlier_message_ids: earlier };
    } catch { /* 记录损坏时按整体覆写处理 */ }
    return extra;
  }

  /**
   * 从持久化记录重建一份足够渲染结果卡的任务视图。
   * 重启后的「运行验证」与验收刷新都从这里取能力与状态，两条路径因此不会给出不同答案。
   * 带全字段是硬要求：少带一个，saveCardTask 写回时那个字段就会从记录里消失。
   */
  protected restoredCardTask(config: StoredLarkConfig, mapping: { externalId: string; sessionId: string }, saved: PersistedLarkCardTask): LarkTask {
    return {
      id: mapping.externalId, group: { tail: Promise.resolve() }, config, state: saved.state,
      turn: saved.turn ?? 0, epoch: 0, scopeId: saved.scope_id ?? '', prompt: saved.prompt,
      resources: [], events: [], sessionId: mapping.sessionId, startedAt: saved.started_at,
      ...(saved.runtime_task_id ? { runtimeTaskId: saved.runtime_task_id } : {}),
      ...(saved.card_message_id ? { cardMessageId: saved.card_message_id } : {}),
      ...(saved.final_message_id ? { finalMessageId: saved.final_message_id } : {}),
      ...(saved.final_delivery_state ? { finalDeliveryState: saved.final_delivery_state } : {}),
      ...(saved.final_attachment_message_id ? { finalAttachmentMessageId: saved.final_attachment_message_id } : {}),
      ...(saved.final_card_input ? { finalCardInput: saved.final_card_input } : {}),
      ...(saved.progress_frozen ? { progressFrozen: true } : {}),
      ...(saved.last_successful_elements ? { lastSuccessfulElements: saved.last_successful_elements } : {}),
      ...(saved.verification_auto ? { autoVerification: saved.verification_auto } : {}),
      finalElements: saved.final_elements ?? [],
      event: { messageId: mapping.externalId, chatId: saved.chat_id, chatType: saved.chat_type ?? 'group', messageType: 'text',
        content: '', mentions: [], senderOpenId: saved.sender_open_id,
        ...(saved.sender_type ? { senderType: saved.sender_type } : {}),
        ...(saved.thread_id ? { threadId: saved.thread_id } : {}) }
    };
  }

  protected async refreshResultFeedback(config: StoredLarkConfig, requestId: string) {
    const record = (await this.workflows?.list(config.appId))?.find(item => item.id === requestId && item.kind === 'result');
    if (!record?.cardId) return;
    const mapping = (await this.cardMappings?.list(larkCardChannel(config.appId)))?.find(item => item.externalId === record.event.messageId);
    if (!mapping) return;
    const saved = JSON.parse(mapping.extra ?? '{}') as PersistedLarkCardTask;
    if (saved.state !== 'completed' || saved.final_delivery_state !== 'delivered'
      || saved.final_message_id !== record.cardId || saved.runtime_task_id !== record.taskId || saved.turn !== record.turn) return;
    // S4：文件型结果先补验收 reaction，再做「状态未变」短路——重启对账靠这个顺序补偿漏写。
    await this.addAcceptanceReaction(config, saved, record);
    if (saved.result_feedback_state === record.state) return;
    const resultElements = saved.final_elements ?? (saved.final_message_id === saved.card_message_id ? saved.last_successful_elements : undefined);
    if (!resultElements) {
      // File results cannot be PATCHed; the reply receipt and task dashboard
      // show acceptance while the original file and process stay unchanged.
      await this.cardMappings!.save({ ...mapping, extra: JSON.stringify({ ...saved, result_feedback_state: record.state }) });
      return;
    }
    // 验证状态行与「运行验证」按钮必须同源。这里若不重算，就会用回落的默认能力表
    // （canVerify 未声明 = 不给按钮）覆盖整卡，而 elements 里「可点『运行验证』执行。」
    // 那句是渲染时写死进 markdown 的：按钮没了，文字还在指一条不存在的路。
    const restored = this.restoredCardTask(config, mapping, saved);
    const verification = await this.verificationView(restored, config, saved.state as LarkCardActionState);
    const elements = [
      ...resultElements.filter(item => !['workflow_accept', 'workflow_changes', 'workflow_result_status', LARK_VERIFICATION_ELEMENT_ID].includes(String(item.element_id))),
      ...(verification.element ? [verification.element] : []),
      ...await this.workflows!.result(record, record.cardId, saved.final_attachment_message_id ? [saved.final_attachment_message_id] : undefined)];
    await this.service.update({ cardKind: 'result', messageId: record.cardId, taskId: mapping.externalId, taskName: saved.task_name, state: 'completed', readOnly: true, elements,
      capabilities: { ...this.capabilitiesForTask(restored), ...verification.capabilities, ...await this.resultActionCapabilities(restored, config, saved.state) },
      agentName: await this.resolveAgentName(config), turn: saved.turn });
    const current = (await this.cardMappings!.list(larkCardChannel(config.appId))).find(item => item.id === mapping.id);
    if (current?.extra !== mapping.extra) return;
    await this.cardMappings!.save({ ...mapping, extra: JSON.stringify({ ...saved, result_feedback_state: record.state, final_elements: elements }) });
  }

  /**
   * S4：文件型结果被验收（通过/需修改）后，对原文件消息补一枚 ✅/⌨️ reaction。
   * 先查 kv 幂等键再调平台再 CAS 落库；重启对账会反复进入本方法，命中即返，绝不重复打表情。
   * reaction 不承担通知职责，任何失败只 warn，不影响验收落库与卡片刷新。
   */
  private async addAcceptanceReaction(
    config: StoredLarkConfig,
    saved: PersistedLarkCardTask,
    record: { cardId?: string; state: string }
  ) {
    if (!this.workflowOptions.store) return;
    if (record.state !== 'accepted' && record.state !== 'needs_changes') return;
    // 新结果给附件加 reaction；旧的纯文件结果仍通过无内联元素识别。
    if (!saved.final_attachment_message_id && !isFileResultDelivery({ elements: saved.final_elements })) return;
    if (!saved.final_message_id || saved.final_message_id === saved.card_message_id || !record.cardId) return;
    const emojiType = reactionEmojiForAcceptance(record.state === 'accepted' ? 'accept' : 'changes');
    if (!emojiType) return;
    const fileMessageId = saved.final_attachment_message_id ?? record.cardId;
    const key = reactionDedupeKey(config.appId, fileMessageId, emojiType);
    try {
      if (await this.workflowOptions.store.get(key)) return;
      const result = await this.service.addReaction(fileMessageId, emojiType);
      const payload = {
        messageId: result.messageId,
        emojiType,
        reactionId: result.reactionId,
        createdAt: new Date().toISOString()
      } satisfies ReactionRecord;
      // 并发两条决议链路时 INSERT OR IGNORE 保证只有一条落库；未抢到也不撤销已加表情。
      await this.workflowOptions.store.compareAndSet?.(key, undefined, JSON.stringify(payload));
    } catch (error) {
      this.log.warn({ error, key }, '文件结果验收 reaction 写入失败，不影响验收状态');
    }
  }

  /** 状态流转写回飞书任务记录的文案；没有对应说法的中间态不写。 */
  private static readonly taskStepContent: Partial<Record<LarkTaskState, string>> = {
    queued: 'Dutydeck 已接单，排队等待执行。',
    running: 'Dutydeck 正在执行。',
    completed: 'Dutydeck 执行完成，结果已发到飞书会话。',
    failed: 'Dutydeck 执行失败，详情见飞书会话里的结果卡。',
    interrupted: 'Dutydeck 执行已中断。',
    cancelled: 'Dutydeck 任务已取消。'
  };

  /**
   * 把本轮状态写成飞书任务记录，在飞书任务界面直接可见。
   * 只对任务通道派来的任务生效（合成 messageId 才解得出 guid），聊天消息一条都不写。
   * 同一轮同一状态只写一次；写失败撤回本地标记，下一次状态保存会重试。
   */
  private async writeLarkTaskStep(task: LarkTask, state: LarkTaskState) {
    const taskGuid = larkTaskAgentGuid(task.event.messageId);
    const content = LarkCoordinatorCards.taskStepContent[state];
    if (!taskGuid || !content) return;
    const key = `${taskGuid}:${task.turn}:${state}`;
    if (this.writtenTaskSteps.has(key)) return;
    this.writtenTaskSteps.add(key);
    if (this.writtenTaskSteps.size > 5_000) this.writtenTaskSteps.delete(this.writtenTaskSteps.values().next().value!);
    try {
      await appendLarkTaskSteps({ client: this.service, taskGuid, steps: [{ content }], idempotentKey: key.slice(0, 64) });
    } catch (error) {
      this.writtenTaskSteps.delete(key);
      this.log.warn({ error, taskGuid, state }, '飞书任务记录写入失败，不影响任务执行');
    }
  }

  /**
   * 长任务的进度卡置顶。默认关闭；开启后跑过 pinAfterMs 才置顶，短任务不打扰会话列表。
   * 置顶与撤销都由 LarkPinManager 兜底，失败只记日志，绝不影响任务本身。
   */
  protected async pinLongRunningCard(task: LarkTask) {
    if (!this.pins || task.config.pinLongTasks !== true || !task.cardMessageId || !task.startedAt) return;
    if (Date.now() - task.startedAt < (task.config.pinAfterMs ?? 10 * 60 * 1000)) return;
    await this.pins.pin(task.cardMessageId, { appId: task.config.appId, taskId: task.id, chatId: task.event.chatId });
  }

  /** 终态撤销置顶：与开关无关，开关关掉之后仍然要把已经置顶的卡撤下来。 */
  protected async unpinTaskCard(task: LarkTask) {
    if (!this.pins || !task.cardMessageId || !this.pins.isPinned(task.cardMessageId)) return;
    await this.pins.unpin(task.cardMessageId, { appId: task.config.appId });
  }

  /**
   * 从 runtime 实际能力 + 任务当前状态派生按钮能力，供渲染端与回调端共用。
   * 每一项都对应 handleAction 里真实的执行前置条件，因此界面上出现的按钮
   * 一定能被执行——这是「不发死按钮」的唯一保证方式。
   */
  protected capabilitiesForTask(task: LarkTask): LarkCardCapabilities {
    const webBaseUrl = task.config.webBaseUrl?.trim().replace(/\/$/, '');
    return {
      // 与 handleAction 的 cancel 分支前置条件逐项对齐。
      canCancelQueued: Boolean(this.runtime.cancelQueued && task.sessionId && task.runtimeTaskId),
      canInterrupt: typeof this.runtime.interrupt === 'function' && Boolean(task.sessionId),
      canRetry: task.retryable !== false,
      // requestUpdate 在轮次结束时被清空，因此已结束的轮次不会出现「刷新」。
      canRefresh: typeof task.requestUpdate === 'function',
      ...(webBaseUrl
        ? { webUrl: `${webBaseUrl}/sessions${task.sessionId ? `/${encodeURIComponent(task.sessionId)}` : ''}` }
        : {}),
      // 与 handleDetailLogin 的前置条件对齐：登录链接要绑定会话，还没有会话的轮次保持原链接。
      ...(this.workflowOptions.loginLinks && task.sessionId ? { detailLogin: true } : {})
    };
  }

  /**
   * 结果卡续问行的能力：一键续问与「每天 HH:MM 自动执行」。结果卡投递、对账补发、验证与验收重绘
   * 和回调端都从这里取，渲染出的按钮与后端接受的点击因此是同一个判断。只有已完成的卡才有续问行。
   */
  protected async resultActionCapabilities(task: LarkTask, config: StoredLarkConfig, state: string): Promise<Pick<LarkCardCapabilities, 'canFollowUp' | 'dailySchedule'>> {
    if (state !== 'completed') return {};
    let continues = false;
    try { continues = await this.continuesSession(task, config); }
    catch (error) { this.log.warn({ error, taskId: task.id }, '确认会话能否续聊失败，本卡不给续问按钮'); }
    if (!continues) return {};
    const dailySchedule = await this.dailyScheduleView(task, config).catch(error => {
      this.log.warn({ error, taskId: task.id }, '判定重复请求失败，本卡不提议定时');
      return undefined;
    });
    return {
      // 续问要先落去重键、再由机器人在原位置代发这句话，缺持久化存储或回复接口就不给按钮。
      ...(this.inbox && typeof this.service.replyText === 'function' ? { canFollowUp: true } : {}),
      ...(dailySchedule ? { dailySchedule } : {})
    };
  }

  /**
   * 这张卡所属的会话此刻还能不能接着问：会话还在、没被 /new 结束，而且正是在原位置再发一句时
   * 会复用的那一条。配置变了会换新会话，那时「重新说一遍上面的结论」就没有上文了。
   */
  private async continuesSession(task: LarkTask, config: StoredLarkConfig) {
    if (!task.sessionId || !task.scopeId) return false;
    const session = await this.runtime.getSession(task.sessionId);
    if (!session || ['failed', 'stopped'].includes(session.state) || session.archivedAt) return false;
    const group = this.groups.get(larkGroupKey(task.event, task.scopeId, config.appId));
    if (group?.retiredSessionIds?.has(session.id)) return false;
    // 与 resolveLarkSession 同一个优先级：内存绑定优先，缺失时按持久化会话定位。
    if (group?.sessionId && !group.retiredSessionIds?.has(group.sessionId)) {
      return group.sessionId === session.id && Boolean(config.managedGroup || group.sessionConfigKey === larkSessionConfigKey(config));
    }
    return (await findPersistedLarkSession(this.runtime, config, task.event.chatId, task.event.chatType, task.scopeId, this.cardMappings))?.id === session.id;
  }

  /**
   * 重复请求时提议「每天 HH:MM 自动执行」：同一发起人在同一个聊天里、14 天内已有别的任务发过
   * 规范化后相同的请求，且这个话题还没有同样内容的已启用计划。时刻取本次任务的开始时间（北京时间）。
   * 这张卡已经建过计划、计划仍启用时返回 scheduled，按钮画成「已设为…」。
   * 是否重复请求只在投递结果卡时扫一次卡片映射，结论随 final_card_input 落库；之后的重绘与回调都读这个结论，不再扫描。
   */
  private async dailyScheduleView(task: LarkTask, config: StoredLarkConfig): Promise<LarkCardCapabilities['dailySchedule']> {
    const automation = this.workflowOptions.automation;
    const store = this.workflowOptions.store;
    const requester = task.event.senderOpenId;
    const startedAt = task.startedAt;
    if (!automation || !store?.compareAndSet || !this.cardMappings || !task.sessionId || !startedAt || !requester) return undefined;
    const request = larkRequestText(task.prompt, config.name);
    if (!request || isLarkCardFollowUpPrompt(task.prompt)) return undefined;
    const raw = await store.get(dailyScheduleKey(config.appId, resultActionDigest(task.id, task.turn)));
    const record = raw ? JSON.parse(raw) as LarkDailyScheduleRecord : undefined;
    if (record?.phase !== 'created') {
      const repeated = task.finalCardInput
        ? Boolean((task.finalCardInput.capabilities as LarkCardCapabilities | undefined)?.dailySchedule)
        : (await this.cardMappings.list(larkCardChannel(config.appId))).some(mapping => {
          if (mapping.externalId === task.id) return false;
          try {
            const other = JSON.parse(mapping.extra ?? '{}') as PersistedLarkCardTask;
            return other.app_id === config.appId && other.chat_id === task.event.chatId && other.sender_open_id === requester
              && other.started_at <= startedAt && startedAt - other.started_at <= repeatedRequestWindowMs
              && larkRequestText(other.prompt ?? '', config.name) === request;
          } catch { return false; }
        });
      if (!repeated) return undefined;
    }
    const schedules = (await automation.listBySession(task.sessionId, requester)).schedules;
    if (record?.phase === 'created') {
      return schedules.some(item => item.id === record.schedule_id && item.enabled) ? { time: record.time, scheduled: true } : undefined;
    }
    // 上个进程为这张卡建到一半的计划不算「已有同样内容的计划」：再点一次会接手把它补完。
    if (schedules.some(item => item.enabled && item.id !== record?.schedule_id && larkRequestText(item.prompt, config.name) === request)) return undefined;
    return { time: shanghaiClock(startedAt), scheduled: false };
  }

  /**
   * 续问行回调的目标。卡片上的值不可信：value 里的 task_id 只用来找持久化映射，随后核对被点的
   * 正是这一轮已经交付的结果卡；会话、群、话题与发起人一律取自服务端记录。
   */
  private async resultActionTarget(parsed: LarkCardActionValue, operatorOpenId?: string, context?: { messageId?: string; chatId?: string }): Promise<LarkResultActionTarget | { toast: { type: string; content: string } }> {
    const store = this.workflowOptions.store;
    if (!this.reconcileConfig || !this.cardMappings || !store?.compareAndSet || !operatorOpenId || !context?.messageId || !context.chatId) {
      return { toast: { type: 'error', content: '卡片身份不完整或已失效。' } };
    }
    const current = await readLarkConfig(store, this.reconcileConfig.appId);
    if (!current?.listening) return { toast: { type: 'warning', content: '机器人已停用，无法执行此操作' } };
    const mapping = await this.cardMappings.get(larkCardChannel(current.appId), parsed.taskId);
    const saved = mapping?.extra ? JSON.parse(mapping.extra) as PersistedLarkCardTask : undefined;
    if (!mapping || !saved || saved.app_id !== current.appId || saved.chat_id !== context.chatId || saved.final_message_id !== context.messageId
      || saved.state !== 'completed' || saved.final_delivery_state !== 'delivered' || !saved.scope_id) {
      return { toast: { type: 'warning', content: '此卡当前不可操作，请直接 @我 提问。' } };
    }
    if (parsed.turn !== saved.turn) return { toast: { type: 'warning', content: '任务已开始新一轮，请在最新的卡片上操作' } };
    const config = saved.chat_type === 'group' && this.groupManager ? await this.groupManager.resolved(current, saved.chat_id) : current;
    return { current, config, mapping, saved, task: this.restoredCardTask(config, mapping, saved), operator: operatorOpenId,
      scopeId: saved.scope_id, resultMessageId: context.messageId };
  }

  /**
   * 续问与定时的权限，返回拒绝理由。续问与在原话题里发一条消息完全一致：群策略 task.create、
   * 执行策略、部署白名单；定时与在原话题里发 /schedule 相同：再加命令白名单与任务操作权。
   * 两者都受续聊规则约束。handle、runTurn 与 SessionAutomationService 之后还会各自再判一遍。
   */
  private async resultActionDenied(target: LarkResultActionTarget, kind: 'follow_up' | 'schedule'): Promise<string | undefined> {
    const { config, saved, operator } = target;
    if (!larkScopeContinuesFor(target.scopeId, operator)) {
      return kind === 'follow_up' ? '这个会话只接发起人本人的追问，你可以直接 @我 提问。' : '这个会话只有发起人本人能设置定时任务。';
    }
    if (saved.chat_type === 'group' && this.groupManager) {
      // 被点的结果卡已核对过 chat 与 message_id，操作人就在这个群里：与收到一条群消息同一口径。
      const entry = await this.groupManager.authorize(config.appId, saved.chat_id, operator, 'task.create', undefined, { memberObserved: true });
      if (entry && !entry.allowed) return entry.code === 'talk_required' ? '当前账号没有此群的任务访问权限。' : entry.reason;
      if (kind === 'schedule') {
        const command = await this.groupManager.authorize(config.appId, saved.chat_id, operator, 'task.view_result');
        if (command && !command.allowed) return '当前账号不在机器人白名单中，无法执行 /schedule。';
      }
    }
    try { await this.requireExecution('listener', 'task.create'); }
    catch (error) { return error instanceof Error ? error.message : '机器人尚未获得运行权限。'; }
    if (kind === 'schedule') {
      return await this.isOperatorAllowed(config, operator, saved.chat_id, target.mapping.sessionId) ? undefined : '当前账号没有操作此任务的权限。';
    }
    return config.managedGroup || await this.isStaticOperatorAllowed(config, operator, saved.chat_id) ? undefined : '当前账号不在机器人白名单中，无法执行此操作';
  }

  /**
   * 一键续问：等同于操作人在原话题里回复一条固定文本。飞书回复接口只认真实消息，而任务的过程卡、
   * 结果投递与重启恢复都锚在「发起请求的那条消息」上，所以先由机器人在结果卡下代发这段话，
   * 再把它当作操作人的消息交给 handle，唤醒、授权、排队与会话复用全部走原路。
   * 请求原文与所属 scope 预先写进 inbox：handle 不会按代发消息的形态重新解析它，续问一定回到这张卡的会话。
   */
  protected async submitResultFollowUp(parsed: LarkCardActionValue, operatorOpenId?: string, context?: { messageId?: string; chatId?: string }) {
    try {
      const target = await this.resultActionTarget(parsed, operatorOpenId, context);
      if ('toast' in target) return target.toast;
      const { current, config, saved, task, operator } = target;
      const denied = await this.resultActionDenied(target, 'follow_up');
      if (denied) return { type: 'warning', content: denied };
      const capabilities = { ...this.capabilitiesForTask(task), ...await this.resultActionCapabilities(task, config, 'completed') };
      if (!this.inbox || !isLarkCardActionAvailable(parsed.action, { state: 'completed', taskId: task.id, turn: task.turn, readOnly: true, capabilities })) {
        return { type: 'warning', content: '这个会话已结束或已换成新会话，无法接着问；请直接 @我 提问。' };
      }
      const store = this.workflowOptions.store!;
      const label = larkCardActionLabel(parsed.action, capabilities)!;
      const prompt = larkCardFollowUpPrompt(parsed.action)!;
      const digest = resultActionDigest(task.id, task.turn, parsed.action);
      const key = followUpClaimKey(config.appId, digest);
      const duplicate = { type: 'warning', content: `「${label}」已经提交过，请看下方的新一轮结果。` };
      const busy = { type: 'warning', content: `「${label}」正在提交，请勿重复点击。` };
      const raw = await store.get(key);
      const previous = raw ? JSON.parse(raw) as LarkFollowUpClaim : undefined;
      // 重复点击、回调重投、重启后再点都落在这里：本进程正在做的只回执，上个进程留下的未完成认领由这次点击接手。
      if (previous?.phase === 'submitted') return duplicate;
      if (previous?.phase === 'claimed' && previous.boot === this.relaunchBoot) return busy;
      // 代发的消息已经登记进 inbox：重启恢复会接着处理它，这里只补记阶段，不提交第二次。
      if (previous?.message_id && await store.get(`lark.inbox.${config.appId}.${previous.message_id}`)) {
        await store.compareAndSet!(key, raw, JSON.stringify({ ...previous, phase: 'submitted' }));
        return duplicate;
      }
      let claim: LarkFollowUpClaim = { boot: this.relaunchBoot, phase: 'claimed', operator_open_id: operator, claimed_at: new Date().toISOString(),
        ...(previous?.message_id ? { message_id: previous.message_id } : {}) };
      if (!await store.compareAndSet!(key, raw, JSON.stringify(claim))) return busy;
      let event: LarkMessageEvent;
      let seeded: boolean;
      try {
        // 上次已代发、没来得及登记的，沿用那条消息，不发第二条。
        if (!claim.message_id) {
          const echo = await this.service.replyText({ messageId: target.resultMessageId, ...(saved.thread_id ? { replyInThread: true } : {}),
            text: `「${label}」${prompt}`, idempotencyKey: `followup_${digest}` });
          const sent: LarkFollowUpClaim = { ...claim, message_id: echo.messageId };
          if (!await store.compareAndSet!(key, JSON.stringify(claim), JSON.stringify(sent))) throw new Error('续问认领已被接手。');
          claim = sent;
        }
        event = {
          messageId: claim.message_id!, chatId: saved.chat_id, chatType: saved.chat_type ?? 'group',
          ...(saved.thread_id ? { threadId: saved.thread_id } : {}), createTime: String(Date.now()),
          messageType: 'text', content: JSON.stringify({ text: `@_user_1 ${prompt}` }), senderOpenId: operator, senderType: 'user',
          // 按钮本身就是对机器人说话：带上 @机器人，唤醒走显式 @ 的原路，不必为 mentionPolicy 特判。
          mentions: [{ key: '@_user_1', name: config.name?.trim() || 'Dutydeck', ...(this.botOpenId ? { openId: this.botOpenId } : {}), mentionedType: 'bot' }]
        };
        seeded = await this.inbox.seed(config.appId, event, { prompt, scopeId: target.scopeId, resources: [] });
      } catch (error) {
        // 没能登记成待处理消息：认领记为失败，用户能再点一次。已代发的消息号留在认领里，重点时沿用。
        await store.compareAndSet!(key, JSON.stringify(claim), JSON.stringify({ ...claim, phase: 'failed' })).catch(() => undefined);
        throw error;
      }
      await store.compareAndSet!(key, JSON.stringify(claim), JSON.stringify({ ...claim, phase: 'submitted' }))
        .catch(error => this.log.warn({ error, key }, '续问已登记，去重记录未更新'));
      if (!seeded) return duplicate;
      void this.handle(event, current).catch(error => this.log.error({ error, messageId: event.messageId }, '处理结果卡续问失败'));
      return { type: 'success', content: `已提交「${label}」，新一轮结果稍后发在下方。` };
    } catch (error) {
      this.log.warn({ error, taskId: parsed.taskId, action: parsed.action }, '提交结果卡续问失败');
      return { type: 'error', content: '提交失败，请稍后重试。' };
    }
  }

  /**
   * 「每天 HH:MM 自动执行」：在这张卡所属的会话里用 cron 建一个每天执行同一请求的计划并启用，
   * 回报位置是原话题（与 /schedule 一样写 automation.delivery-target.*）。同一张卡只建一次：
   * 登记键先认领再建计划，建好后重绘结果卡，按钮改为「已设为…」。
   * 回调要在 3 秒内返回：同步只做本地的建计划、启用与登记，重绘结果卡和发回执要调飞书接口，放后台。
   */
  protected async scheduleResultDaily(parsed: LarkCardActionValue, operatorOpenId?: string, context?: { messageId?: string; chatId?: string }) {
    try {
      const target = await this.resultActionTarget(parsed, operatorOpenId, context);
      if ('toast' in target) return target.toast;
      const { config, mapping, saved, task, operator } = target;
      const automation = this.workflowOptions.automation;
      if (!automation) return { type: 'warning', content: '当前服务未接入定时任务。' };
      const denied = await this.resultActionDenied(target, 'schedule');
      if (denied) return { type: 'warning', content: denied };
      const actions = await this.resultActionCapabilities(task, config, 'completed');
      const view = actions.dailySchedule;
      if (view?.scheduled) return { type: 'success', content: `已设为每天 ${view.time} 自动执行。` };
      if (!view || !isLarkCardActionAvailable('schedule_daily', { state: 'completed', taskId: task.id, turn: task.turn, readOnly: true,
        capabilities: { ...this.capabilitiesForTask(task), ...actions } })) {
        return { type: 'warning', content: '这个话题已有同样内容的计划，或会话已结束，无法再设置。' };
      }
      const store = this.workflowOptions.store!;
      const digest = resultActionDigest(task.id, task.turn);
      const key = dailyScheduleKey(config.appId, digest);
      const busy = { type: 'warning', content: '定时任务正在设置，请勿重复点击。' };
      const raw = await store.get(key);
      const previous = raw ? JSON.parse(raw) as LarkDailyScheduleRecord : undefined;
      // 本进程正在建的只回执；上个进程留下的未完成认领由这次点击接手（已建好的在上面按 scheduled 回执过了）。
      if (previous?.phase === 'claimed' && previous.boot === this.relaunchBoot) return busy;
      let claim: LarkDailyScheduleRecord = { boot: this.relaunchBoot, phase: 'claimed', operator_open_id: operator, time: view.time,
        ...(previous?.schedule_id ? { schedule_id: previous.schedule_id } : {}) };
      if (!await store.compareAndSet!(key, raw, JSON.stringify(claim))) return busy;
      let schedule: PublicSessionSchedule;
      try {
        const prompt = withoutLeadingBotMention(saved.prompt, config.name);
        const [hour, minute] = view.time.split(':').map(Number);
        // 上个进程为这张卡建到一半的计划按记下的编号找回来补完；计划编号随操作人变，换人接手时不能靠 createSchedule 的幂等键。
        const started = claim.schedule_id
          ? (await automation.listBySession(mapping.sessionId, operator)).schedules.find(item => item.id === claim.schedule_id) : undefined;
        schedule = started ?? await automation.createSchedule(mapping.sessionId, {
          name: prompt.slice(0, 100), prompt, trigger: { kind: 'cron', expression: `${minute} ${hour} * * *` },
          timezone: 'Asia/Shanghai', dstPolicy: { gap: 'skip', overlap: 'first' }, condition: { kind: 'always' }
        }, operator, {
          key: `${config.appId}:${task.id}:${task.turn}:daily`,
          prepareDelivery: async automationId => {
            // 计划落库之前先记下编号：此后进程退出，下一次点击据此找回这条计划，而不是再建一条。
            const recorded: LarkDailyScheduleRecord = { ...claim, schedule_id: automationId };
            if (!await store.compareAndSet!(key, JSON.stringify(claim), JSON.stringify(recorded))) throw new Error('定时任务的登记已被接手。');
            claim = recorded;
            await store.compareAndSet!(`automation.delivery-target.${automationId}`, undefined, JSON.stringify({ appId: config.appId, chatId: saved.chat_id, replyMessageId: task.id, replyInThread: saved.chat_type === 'group' }));
          }
        });
        if (!schedule.enabled) schedule = await automation.updateSchedule(mapping.sessionId, schedule.id, { expectedRevision: schedule.revision, enabled: true }, operator);
        await store.set(key, JSON.stringify({ ...claim, phase: 'created', schedule_id: schedule.id } satisfies LarkDailyScheduleRecord));
      } catch (error) {
        await store.compareAndSet!(key, JSON.stringify(claim), JSON.stringify({ ...claim, phase: 'failed' } satisfies LarkDailyScheduleRecord)).catch(() => undefined);
        this.log.warn({ error, taskId: task.id }, '设置每天自动执行失败');
        return { type: 'error', content: `设置失败：${error instanceof Error ? error.message : String(error)}` };
      }
      // 原样重绘同一张结果卡：验证状态行按最新记录重算，续问行里的定时按钮改为「已设为…」。
      if (saved.final_elements?.length) {
        void this.refreshResultVerification(task, config).catch(error => this.log.warn({ error, taskId: task.id }, '定时任务已建好，结果卡按钮未能更新'));
      }
      const nextDue = schedule.nextDueAt
        ? `${new Date(schedule.nextDueAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}（北京时间）` : '未排定';
      void sendTaskCard(this.service, { ...task.event, messageId: target.resultMessageId }, {
        state: 'completed', readOnly: true, retryable: false, taskId: task.id, taskName: '定时任务',
        markdown: `**已设为每天 ${view.time} 自动执行「${larkCommandEcho(schedule.name, 100)}」。**\n\n下一次：${nextDue}\n\n停用：\`/schedule disable ${schedule.id}\``,
        idempotencyKey: `daily_${digest}`
      }, this.log).catch(error => this.log.warn({ error, taskId: task.id }, '定时任务已建好，回执发送失败'));
      return { type: 'success', content: `已设为每天 ${view.time} 自动执行。` };
    } catch (error) {
      this.log.warn({ error, taskId: parsed.taskId }, '设置每天自动执行失败');
      return { type: 'error', content: '设置失败，请稍后重试。' };
    }
  }

  /** 改写这个机器人待收尾的自动验证（见 mutateLarkPendingVerifications）；超出上限丢掉的最旧条目记日志。 */
  protected async mutatePendingVerifications(appId: string, mutation: (entries: LarkPendingVerification[]) => LarkPendingVerification[] | undefined) {
    if (!this.workflowOptions.store) return;
    const dropped = await mutateLarkPendingVerifications(this.workflowOptions.store, appId, mutation);
    if (dropped.length) this.log.warn({ appId, dropped: dropped.map(item => item.task_id) }, `待收尾的自动验证超过 ${maxLarkPendingVerifications} 条，丢掉最旧的`);
  }

  /** 这个任务的自动验证已收尾：移出待收尾，登记的返修轮次随之作废。 */
  protected settlePendingVerification(appId: string, taskId: string) {
    return this.mutatePendingVerifications(appId, entries => entries.some(item => item.task_id === taskId) ? entries.filter(item => item.task_id !== taskId) : undefined);
  }

  /**
   * 结果卡的验证状态：没配验证命令时整行不渲染、按钮也不给——不能暗示一个不存在的能力；
   * 唯一例外是工作区第一次跑完任务时带上推断出的候选命令，只提议保存，不给「运行验证」。
   * canRun 与 canVerify 是同一个判断，渲染端与回调端因此不可能给出不同答案。
   */
  protected async verificationView(task: LarkTask, config: StoredLarkConfig, state: LarkCardActionState): Promise<{ element?: LarkCardElement; canRun: boolean; capabilities: Pick<LarkCardCapabilities, 'canVerify' | 'verificationSuggestion'> }> {
    const command = config.verificationCommand?.trim();
    if (!command) {
      const suggestion = state === 'completed' ? await this.verificationSuggestion(task, config).catch(error => {
        this.log.warn({ error, taskId: task.id }, '推断候选验证命令失败，结果卡不提议');
        return undefined;
      }) : undefined;
      const element = renderLarkVerificationElement({ suggestion });
      return { ...(element ? { element } : {}), canRun: false, capabilities: suggestion ? { verificationSuggestion: suggestion } : {} };
    }
    let latest: VerificationResponse | undefined;
    if (task.sessionId && this.runtime.getVerifications) {
      try { latest = (await this.runtime.getVerifications(task.sessionId))[0]; }
      catch (error) { this.log.warn({ error, taskId: task.id }, '读取验证记录失败，结果卡按未验证呈现'); }
    }
    const note = task.autoVerification;
    const auto = note && note.turn === task.turn && (note.phase === 'running' || note.record_id === latest?.id) ? note : undefined;
    // 只有「现有记录不能证明当前代码」时才给按钮：已验证且未失效的卡再跑一次没有意义，
    // 正在跑的也不能再起一个（runtime 会直接回 VERIFICATION_IN_PROGRESS；自动验证还没落记录时看 auto），
    // 已发回返修的也不给：返修那一轮正占着会话，修完会自己重新验证。
    const capable = Boolean(this.runtime.runVerification && task.sessionId && auto?.phase !== 'running' && auto?.phase !== 'repairing'
      && latest?.status !== 'running' && (!latest || latest.stale || latest.status !== 'passed'));
    // 最终仍由 card-actions 的能力表拍板（例如 cancelled 的卡不给验证入口）。
    // 文案里的「可点运行验证」必须与按钮同生同灭，否则就是在指一条不存在的路。
    const canRun = capable && isLarkCardActionAvailable('verify', {
      state, taskId: task.id, turn: task.turn, readOnly: true,
      ...(task.retryable !== undefined ? { retryable: task.retryable } : {}),
      capabilities: { ...this.capabilitiesForTask(task), canVerify: capable }
    });
    return { element: renderLarkVerificationElement({ command, latest, canRun, ...(auto ? { auto } : {}) }), canRun, capabilities: { canVerify: canRun } };
  }

  /** 验证跑完后原样重绘同一张结果卡，只整行替换验证状态，不改写已交付的结论。 */
  protected async refreshResultVerification(task: LarkTask, config: StoredLarkConfig) {
    if (!task.finalCardInput || !task.finalMessageId || !task.finalElements) return;
    const verification = await this.verificationView(task, config, String(task.finalCardInput.state) as LarkCardActionState);
    const elements = [
      ...task.finalElements.filter(item => item.element_id !== LARK_VERIFICATION_ELEMENT_ID),
      ...(verification.element ? [verification.element] : [])
    ];
    await this.service.update({
      ...task.finalCardInput, messageId: task.finalMessageId, elements,
      capabilities: { ...this.capabilitiesForTask(task), ...verification.capabilities,
        ...await this.resultActionCapabilities(task, config, String(task.finalCardInput.state)) }
    });
    task.finalElements = elements;
    // 落库，让重启后再看到这张收据的人读到的也是刷新后的结论。
    await this.saveCardTask(task).catch(error => this.log.warn({ error, taskId: task.id }, '验证状态已更新到卡片，持久化待对账补齐'));
  }

  /** 结果卡上的「本轮记忆」区；关闭记忆、没有记录或读取失败时不渲染，不影响结果交付。 */
  protected async turnMemoryElements(config: StoredLarkConfig, sessionId?: string, runtimeTaskId?: string) {
    if (config.memoryEnabled === false || !this.memory || !sessionId || !runtimeTaskId) return [];
    const view = await this.memory.turn(sessionId, runtimeTaskId).catch(error => {
      this.log.warn({ error, runtimeTaskId }, '读取本轮会话记忆失败，结果卡不列本轮记忆');
      return undefined;
    });
    return view ? renderLarkTurnMemoryElements(view) : [];
  }

  /**
   * 删掉一条记忆后重绘结果卡上的「本轮记忆」区，其余内容原样保留；卡片不在内存里（例如重启之后）时不重绘。
   * 验证状态行与能力表按当前记录重算、验证行原地替换：交付之后验证重绘过的话，交付时的能力表已经和验证行对不上。
   */
  protected async refreshResultMemory(task: LarkTask, config: StoredLarkConfig) {
    if (!task.finalCardInput || !task.finalMessageId || !task.finalElements) return;
    const state = String(task.finalCardInput.state);
    const memory = await this.turnMemoryElements(config, task.sessionId, task.runtimeTaskId);
    const verification = await this.verificationView(task, config, state as LarkCardActionState);
    const kept = task.finalElements.filter(item => !isLarkTurnMemoryElement(item));
    const row = kept.findIndex(item => item.element_id === LARK_VERIFICATION_ELEMENT_ID);
    if (row >= 0) kept.splice(row, 1, ...(verification.element ? [verification.element] : []));
    // 交付时没有验证行、现在有了（例如之后才配了验证命令）：按交付时的位置补在本轮记忆区前面。
    const added = row < 0 && verification.element ? [verification.element] : [];
    const mention = kept.findIndex(item => item.element_id === 'group_mention');
    const elements = mention < 0 ? [...kept, ...added, ...memory] : [...kept.slice(0, mention), ...added, ...memory, ...kept.slice(mention)];
    await this.service.update({ ...task.finalCardInput, messageId: task.finalMessageId, elements,
      capabilities: { ...this.capabilitiesForTask(task), ...verification.capabilities, ...await this.resultActionCapabilities(task, config, state) } });
    task.finalElements = elements;
    await this.saveCardTask(task).catch(error => this.log.warn({ error, taskId: task.id }, '结果卡的本轮记忆已更新，持久化待对账补齐'));
  }

  /**
   * 没配验证命令的机器人，在工作区第一次有任务跑完时提议一个候选命令（只读基准上的项目文件推断）。
   * 每个工作区只推断一次：登记键先认领再推断，之后的结果卡只读一次登记键，不再起 git 进程。
   * 结论随 final_card_input 落库，之后的重绘与回调都读这个结论。
   */
  private async verificationSuggestion(task: LarkTask, config: StoredLarkConfig): Promise<string | undefined> {
    if (task.finalCardInput) return (task.finalCardInput.capabilities as LarkCardCapabilities | undefined)?.verificationSuggestion;
    const store = this.workflowOptions.store;
    if (!store?.compareAndSet || !task.sessionId || !this.runtime.runVerification) return undefined;
    const session = await this.runtime.getSession(task.sessionId);
    if (!session?.cwd || !larkInsideGitRepository(session.cwd)) return undefined;
    const workspace = await this.runtime.getWorkspace?.(task.sessionId);
    const key = verificationSuggestionKey(config.appId, workspace?.sourceCwd ?? session.cwd);
    const owner = `${task.id}:${task.turn}`;
    if (!await store.compareAndSet(key, undefined, owner) && await store.get(key) !== owner) return undefined;
    const base = await larkVerificationBase(session.cwd, workspace);
    return base ? await inferLarkVerificationCommand(session.cwd, base) : undefined;
  }

  /**
   * 共享目录在本轮开始时的代码指纹，与验证记录同一套算法。只有配了验证命令的机器人才读：读指纹要把整个仓库读一遍；
   * worktree 按派生它的 commit 判断，不需要。读不出来返回 undefined，本轮结束后就不自动验证。
   */
  protected async sharedWorkspaceFingerprint(task: LarkTask, session: Session): Promise<string | undefined> {
    if (!task.config.verificationCommand?.trim() || !this.runtime.runVerification || !this.runtime.getCodeFingerprint
      || !session.cwd || !larkInsideGitRepository(session.cwd)) return undefined;
    try {
      if ((await this.runtime.getWorkspace?.(session.id))?.mode === 'worktree') return undefined;
      return await this.runtime.getCodeFingerprint(session.id);
    } catch (error) {
      this.log.warn({ error, taskId: task.id }, '读取本轮开始时的代码指纹失败，本轮结束后不自动验证');
      return undefined;
    }
  }

  /**
   * 本轮结束后要不要自动验证（判定见 shouldAutoVerifyLarkTurn）。「本轮改了代码」：worktree 看相对派生它的 commit
   * 有没有改动；共享目录只比较本轮前后的代码指纹——用户主目录里常有没推送的提交，相对默认分支比较会让只提问的一轮
   * 也跑一遍验证命令。要跑时先占住验证入口、登记为待收尾，结果卡按「验证执行中」交付。
   */
  protected async planAutoVerification(task: LarkTask, codeBefore: string | undefined): Promise<{ command: string; turn: number; recordId?: string } | undefined> {
    const command = task.config.verificationCommand?.trim();
    if (!command || !task.sessionId || !this.workflowOptions.store || !this.runtime.runVerification || !this.runtime.getVerifications || this.verifyInFlight.has(task.id)) return undefined;
    try {
      const session = await this.runtime.getSession(task.sessionId);
      if (!session?.cwd) return undefined;
      const workspace = await this.runtime.getWorkspace?.(task.sessionId);
      let changed: boolean;
      if (workspace?.mode === 'worktree') {
        const base = await larkVerificationBase(session.cwd, workspace);
        changed = Boolean(base && await larkWorkspaceChanged(session.cwd, base));
      } else changed = Boolean(codeBefore && this.runtime.getCodeFingerprint && codeBefore !== await this.runtime.getCodeFingerprint(task.sessionId));
      // 没改代码就不必读记录：读记录要给整个仓库算一次指纹。
      const latest = changed ? (await this.runtime.getVerifications(task.sessionId))[0] : undefined;
      if (!shouldAutoVerifyLarkTurn({ state: task.state, command, changed, latest })) return undefined;
      this.verifyInFlight.add(task.id);
      const progress = { turn: task.turn, ...(latest ? { record_id: latest.id } : {}) };
      task.autoVerification = { ...progress, phase: 'running' };
      await this.mutatePendingVerifications(task.config.appId, entries => {
        const previous = entries.find(item => item.task_id === task.id);
        return [...entries.filter(item => item.task_id !== task.id), { ...previous, task_id: task.id, running: { ...progress, boot: this.relaunchBoot } }];
      }).catch(error => this.log.warn({ error, taskId: task.id }, '自动验证登记待收尾失败，重启后这张卡不会自动收尾'));
      return { command, turn: task.turn, ...(latest ? { recordId: latest.id } : {}) };
    } catch (error) {
      this.log.warn({ error, taskId: task.id }, '判定本轮有没有改代码失败，不自动验证');
      return undefined;
    }
  }

  /**
   * 自动验证：真实执行验证命令，完成后原样重绘结果卡。代码的失败把截断后的输出作为一轮返修发回 Agent，
   * 同一条请求最多返修两轮；验证工具本身出错记为未通过，不发回返修。调用方 fire-and-forget，这里不抛出。
   */
  protected async runAutoVerification(task: LarkTask, plan: { command: string; turn: number; recordId?: string }) {
    let note: LarkAutoVerificationProgress | undefined;
    let refreshed = false;
    const refresh = async () => {
      // 进程已停：待收尾原样留给重启后的收尾（执行中会被改成被中断），卡片也不在这里重绘。
      if (this.stopped) return;
      // 已开新一轮的，旧一轮的卡片不再重绘，只移出待收尾。
      if (task.turn === plan.turn) {
        task.autoVerification = note;
        await this.refreshResultVerification(task, task.config).catch(error => this.log.warn({ error, taskId: task.id }, '自动验证结果未能更新到结果卡'));
        // 被打断的仍留在待收尾里：停服务时这次重绘可能送不到，下次启动再重绘一次。
        if (note?.phase === 'interrupted') return;
      }
      await this.settlePendingVerification(task.config.appId, task.id)
        .catch(error => this.log.warn({ error, taskId: task.id }, '自动验证已收尾，移出待收尾失败'));
    };
    try {
      let record: VerificationResponse | undefined;
      let failure: unknown;
      // 任务完成事件发出后运行时还要收尾一小段队列，这期间会话短暂忙；一直忙说明有别的任务在排队，这次跳过。
      for (let attempt = 1; ; attempt++) {
        // 带上发起人：管理群的执行授权要求验证也有可核验的发起人。
        try { record = await this.runtime.runVerification!(task.sessionId!, { command: plan.command }, task.event.senderOpenId); break; }
        catch (error) {
          failure = error;
          if (!(error instanceof RuntimeError && error.code === 'SESSION_BUSY') || attempt >= 20 || this.stopped || task.turn !== plan.turn) break;
          await new Promise(resolve => setTimeout(resolve, 250));
        }
      }
      if (this.stopped || task.turn !== plan.turn) return;
      const recordId = record?.id ?? plan.recordId;
      const tracked = { turn: plan.turn, ...(recordId ? { record_id: recordId } : {}) };
      if (!record && failure instanceof RuntimeError && (failure.code === 'SESSION_BUSY' || failure.code === 'VERIFICATION_IN_PROGRESS')) {
        note = { ...tracked, phase: 'skipped' };
        return;
      }
      // 被服务重启或会话停止打断：没有结论，不算代码的失败，也不返修。
      if (record?.status === 'interrupted') {
        note = { ...tracked, phase: 'interrupted' };
        return;
      }
      if (!record) this.log.warn({ error: failure, taskId: task.id }, '自动验证没能执行，结果卡记为验证未通过');
      const outcome = larkVerificationOutcome(record, await this.verificationRepairRounds(task));
      if (outcome.kind === 'infrastructure') {
        note = { ...tracked, phase: 'infrastructure', ...(record ? {} : { error: failure instanceof Error ? failure.message : String(failure) }) };
      } else if (outcome.kind === 'exhausted') note = { ...tracked, phase: 'exhausted' };
      else if (outcome.kind === 'repair') {
        // 先把卡刷成「已发回返修」再派发：返修那一轮一开跑就会改代码，之后再刷，这条失败记录只能显示成已过期。
        note = { ...tracked, phase: 'repairing', round: outcome.round };
        await refresh();
        refreshed = true;
        const sent = await this.submitVerificationRepair(task, record!, outcome.round).catch(error => {
          this.log.warn({ error, taskId: task.id }, '验证未通过，发回 Agent 返修失败');
          return false;
        });
        if (!sent) { note = undefined; refreshed = false; }
      }
    } catch (error) {
      this.log.warn({ error, taskId: task.id }, '自动验证失败，结果卡按最新记录呈现');
    } finally {
      // 先把卡刷成最新结论再放开入口，与手动运行验证同一个顺序。
      if (!refreshed) await refresh();
      this.verifyInFlight.delete(task.id);
    }
  }

  /** 这一轮是第几轮返修：代发返修消息时登记过就是那一轮，否则是用户的原始请求，还没返修过。 */
  private async verificationRepairRounds(task: LarkTask) {
    const raw = await this.workflowOptions.store?.get(larkPendingVerificationKey(task.config.appId));
    return Number(parseLarkPendingVerifications(raw).find(item => item.task_id === task.id)?.repair_round) || 0;
  }

  /**
   * 验证未通过时的一轮返修，等同于发起人在原位置回复「按失败输出修复」：机器人先在结果卡下代发一句说明，
   * 再把它当作发起人的消息交给 handle，唤醒、授权、排队与会话复用全部走原路。失败输出只进 Agent 的请求，
   * 不贴进群里。缺持久化存储、回复接口或能续聊的发起人时不返修，返回 false。
   */
  private async submitVerificationRepair(task: LarkTask, record: VerificationResponse, round: number): Promise<boolean> {
    const store = this.workflowOptions.store;
    const requester = task.event.senderOpenId;
    if (!this.inbox || !store || typeof this.service.replyText !== 'function' || !requester || !larkScopeContinuesFor(task.scopeId, requester)) return false;
    const notice = larkVerificationRepairNotice(round);
    const echo = await this.service.replyText({ messageId: task.finalMessageId ?? task.event.messageId, ...(task.event.threadId ? { replyInThread: true } : {}),
      text: notice, idempotencyKey: `verify_fix_${resultActionDigest(task.id, task.turn, record.id)}` });
    // 先登记轮次再交给 handle：那一轮跑完再验证时必须读得到自己是第几轮。
    await this.mutatePendingVerifications(task.config.appId, entries => [...entries.filter(item => item.task_id !== echo.messageId), { task_id: echo.messageId, repair_round: round }]);
    const event: LarkMessageEvent = {
      messageId: echo.messageId, chatId: task.event.chatId, chatType: task.event.chatType,
      ...(task.event.threadId ? { threadId: task.event.threadId } : {}), createTime: String(Date.now()),
      messageType: 'text', content: JSON.stringify({ text: `@_user_1 ${notice}` }), senderOpenId: requester, senderType: task.event.senderType ?? 'user',
      mentions: [{ key: '@_user_1', name: task.config.name?.trim() || 'Dutydeck', ...(this.botOpenId ? { openId: this.botOpenId } : {}), mentionedType: 'bot' }]
    };
    if (!await this.inbox.seed(task.config.appId, event, { prompt: larkVerificationRepairPrompt(record, round), scopeId: task.scopeId, resources: [] })) return false;
    void this.handle(event, task.config).catch(error => this.log.error({ error, messageId: event.messageId }, '处理验证返修失败'));
    return true;
  }

  // 由上层实现、在本层调用。
  abstract handle(event: LarkMessageEvent, config: StoredLarkConfig, recovering?: boolean, adopted?: boolean): Promise<void>;
}
