import { createHash } from 'node:crypto';
import { describeLarkTaskRecovery, larkContinuePrompt, larkRecoveryRetainedNote, larkReliability } from './task-recovery.js';
import { deadlineText, type LarkInteraction } from './workflow-interactions.js';
import type { LarkInboxAdoption, LarkInboxRecord } from './task-inbox.js';
import { isLarkFirstCardUndelivered } from './task-inbox.js';
import { parseLarkNewSession } from './new-session.js';
import { formatLarkHandoff, larkHandoffAck, larkHandoffTitle } from './handoff.js';
import { explicitFinalContext, readExplicitFinal } from './explicit-final.js';
import { redactTraceText } from './secret-redaction.js';
import { readGitSnapshot } from './git-status.js';
import { buildLarkTaskDashboard, type LarkTaskDashboardEntry } from './task-dashboard.js';
import { isLarkGroupMemoryPool, isLarkMemoryId, isLarkMemoryIgnoreRuleId, larkMemoryLimits, larkMemoryScope, renderLarkMemoryList, renderLarkMemoryStatusLine } from './memory.js';
import type { PolicyAction, Session, TaskRecord } from '@dutydeck/shared';
import { executeScheduleCommand } from './schedule-command.js';
import { larkExecutionIdentity, larkMemoryEnabled, larkPermissionMode, readLarkConfig, saveLarkConfig, type StoredLarkConfig } from './config.js';
import type { LarkMessageResource } from './message-content.js';
import { LarkServiceError } from './service.js';
import { isLarkDeterministicFailure } from './api-gate.js';
import { larkRecoveryNoticeExpired, larkRedispatchMaxAgeMs } from './turn-redispatch.js';
import { eventsForRuntimeTask, loadLarkTaskWindow, renderLarkResultElements, steeringOutcomeText, renderLarkRecordExport, terminalTaskStates, type LarkCardElement } from './card-renderer.js';
import { sendLarkFile } from './result-delivery.js';
import { larkResultDeliveryIssues } from './reconciler.js';
import { larkSessionDetailUrl } from './detail-link.js';
import { isLarkCardActionAvailable, parseLarkCardActionValue } from './card-actions.js';
import {
  larkAgentAvailabilityLine,
  larkCommandCapabilities,
  larkCommandEcho,
  larkHelpCardTitle,
  parseLarkHelpPageValue,
  parseSlashCommand,
  resolveLarkCommand,
  renderLarkCommandHelp,
  routeLarkCommand,
  type LarkCommandRoute
} from './commands.js';
import { escapeLarkPromptEcho, renderQueueSummary, QUEUE_SUMMARY_MAX_ITEMS } from './queue-summary.js';
import { senderGroupMention } from './card-mentions.js';
import { claimLarkTaskDispatches, larkTaskAgentGuid, releaseLarkTaskClaim } from './task-agent.js';
import { buildRepairConfirmCard, parseRepairCardActionValue, renderRepairResultCard, runOpenPlatformRepair } from './repair.js';
import { connectLarkOpenPlatformSession } from './open-platform-session.js';
import { findLarkThreadContinuation, larkGroupKey, larkSessionConfigKey, parsePrompt, resolveLarkScopeId } from './session-resolver.js';
import type { LarkMessageEvent } from './listener.js';
import type { LarkGroup, LarkTask, PersistedLarkCardTask } from './coordinator.js';
import { type LarkCommandPrompt, larkCardChannel, type LarkRelaunchClaim, larkTaskTitle, sendTaskCard } from './coordinator-core.js';
import { LarkCoordinatorDispatch } from './coordinator-dispatch.js';

// 飞书消息协调器 · 入站唤醒：入站消息与卡片回调的入口和路由、聊天命令与 /status、
// 工作流与问答回复、群参与认领，以及飞书任务的认领。

/**
 * /status 的执行身份说明。机器人干活用的是**部署这台机器的人**的身份：worktree 只隔离
 * 可写目录，不隔离宿主凭据、文件系统与网络（README「远程浏览器访问」一节同一口径）。
 * 别人在群里使唤它，实际就是拿部署者的权限在跑，这件事必须写在状态里，而不是靠人推断。
 */
/** 生效的群访问口径的人话说明，/grant、/revoke 的回执用它写清「改之前/改之后谁能用」。 */
const describeLarkAccess = (mode: 'owner_only' | 'allowlist' | 'all_chat_members' | 'disabled') =>
  ({ owner_only: '仅机器人管理员可用', allowlist: '仅名单内成员可用', all_chat_members: '全部群成员可用', disabled: '本群已停用' })[mode];

/** 私信里的登录卡：一句说明、链接按钮、一句使用限制。登录链接只出现在这张卡上。 */
const larkDetailLoginElements = (url: string): LarkCardElement[] => [
  { tag: 'markdown', content: '点击下方按钮登录 Dutydeck Web，并打开这个任务的会话页。', margin: '0px' },
  { tag: 'button', text: { tag: 'plain_text', content: '打开任务详情' }, type: 'primary', behaviors: [{ type: 'open_url', default_url: url }], margin: '0px' },
  { tag: 'markdown', content: "<font color='grey'>10 分钟内有效、只能用一次，不要转发。</font>", text_size: 'notation', margin: '0px' }
];

/** 私信里的只读详情卡：和新卡页脚「查看详情」是同一个分享链接 */
const larkSessionShareElements = (url: string): LarkCardElement[] => [
  { tag: 'markdown', content: '点击下方按钮打开这个任务的只读详情页，不用登录。', margin: '0px' },
  { tag: 'button', text: { tag: 'plain_text', content: '打开任务详情' }, type: 'primary', behaviors: [{ type: 'open_url', default_url: url }], margin: '0px' },
  { tag: 'markdown', content: "<font color='grey'>只能查看这一个任务；管理员轮换分享密钥后失效。</font>", text_size: 'notation', margin: '0px' }
];

/** 首张进度卡没送达时，进程内重试整条入站处理的等待时间。 */
const larkUndeliveredRetryDelaysMs = [30_000, 120_000];
/** 启动恢复一条入站消息瞬时失败后的重试间隔：30 秒起翻倍，最长 5 分钟；记录过了恢复年龄上限就不再重试。 */
const larkInboundRecoveryDelayMs = (attempt: number) => Math.min(30_000 * 2 ** (attempt - 1), 300_000);
/** 过期提问的文字回复：附上原问题，作为一条新消息交给 Agent。不是这种情况返回 undefined。 */
const expiredAskPrompt = (error: unknown, answer: string) =>
  error instanceof LarkServiceError && error.code === 'LARK_ASK_EXPIRED' && typeof error.details?.question === 'string'
    ? `[你之前的提问] ${error.details.question}\n[用户的回复] ${answer}` : undefined;

const larkExecutionIdentityLine = () =>
  `**执行身份**：\`${larkCommandEcho(larkExecutionIdentity(), 128)}\`（部署这台 Dutydeck 的系统账号）。任务以它运行，能用到它的文件、凭据与网络；独立工作目录只隔离可写目录，不隔离这些。`;

/** C2：机器人话题里的短控制语。 */
const larkControlPhrases = new Map<string, 'continue' | 'stop' | 'restart'>([
  ['继续', 'continue'], ['接着做', 'continue'], ['接着来', 'continue'],
  ['停', 'stop'], ['停一下', 'stop'], ['先停', 'stop'], ['别做了', 'stop'], ['停止', 'stop'],
  ['重来', 'restart'], ['重新做', 'restart'], ['再来一次', 'restart']
]);

/** 去掉 @、空白和标点后整条消息（不超过 6 个字）就是一句控制语时返回它的意图，否则是普通消息。 */
export function larkControlPhrase(prompt: string) {
  const text = prompt.replace(/@\S+/g, '').replace(/[\s\p{P}\p{S}]/gu, '');
  return text.length <= 6 ? larkControlPhrases.get(text) : undefined;
}

export abstract class LarkCoordinatorInbound extends LarkCoordinatorDispatch {
  async initializeWorkflows(config: StoredLarkConfig) {
    this.reconcileConfig = config;
    this.applyReminderSettings(config);
    await this.workflows?.initialize(config.appId);
    await this.recoverAutoVerifications(config).catch(error => this.log.warn({ error, appId: config.appId }, '重启后收尾自动验证失败'));
    await this.inbox?.pruneIgnored(config.appId);
    // 入站恢复仍在监听建连之前、逐条完成：上次没处理完的旧请求先排进各自会话的队列，建连后新到的消息
    // （包括 /new）排在它们后面，不会反过来插队。单条记录失败只影响这一条，不让初始化抛出、不阻止建连；
    // 瞬时失败的记录交还后在后台重试，不占着建连。
    for (const record of await this.inbox?.orphanedCommands(config.appId) ?? []) {
      try {
        await this.inbox!.update(record, { state: 'failed', error: '重启后无法确认命令是否完成；如未生效，请重新发送。' });
        const actor = record.event.senderOpenId;
        // 旧命令（larkRecoveryNoticeExpired）只记失败，不在群里回复。
        const receivedAt = Number(record.event.createTime) || Date.parse(record.receivedAt ?? '');
        if (actor && !larkRecoveryNoticeExpired(receivedAt) && await this.currentAccess(config, record.event.chatId, record.event.chatType, actor, 'task.view_result')) {
          await this.workflowReply(record.event, config, '重启后无法确认这条命令是否完成。如结果未生效，请重新发送该命令。', { failed: true }).catch(error => this.log.warn({ error }, '命令恢复回执发送失败'));
        }
      } catch (error) {
        this.log.warn({ error, messageId: record.event.messageId }, '重启后收尾命令记录失败，跳过这一条');
      }
    }
    for (const record of await this.inbox?.recoverable(config.appId) ?? []) await this.recoverInbound(record, config);
    // Queued Runtime tasks can start before the Feishu listener. Reattach their
    // original cards and query live waiters as well as subscribing to future events.
    if (!this.workflows || !this.runtime.getTasks) return;
    for (const mapping of await this.cardMappings?.list(larkCardChannel(config.appId)) ?? []) {
      if (this.tasks.has(mapping.externalId)) continue;
      try {
        const saved = JSON.parse(mapping.extra ?? '{}') as PersistedLarkCardTask;
        if (!saved.runtime_task_id || !saved.scope_id || !saved.sender_open_id) continue;
        const runtimeTask = (await this.runtime.getTasks(mapping.sessionId)).find(task => task.id === saved.runtime_task_id);
        if (!runtimeTask || !['running', 'queued'].includes(runtimeTask.status)) continue;
        const raw = await this.workflowOptions.store!.get(`lark.inbox.${config.appId}.${mapping.externalId}`);
        if (!raw) continue;
        const stored = JSON.parse(raw) as LarkInboxRecord;
        if (stored.state !== 'accepted' || stored.sessionId !== mapping.sessionId || stored.event.chatId !== saved.chat_id) continue;
        const adopted = await this.inbox!.adoptAccepted(stored);
        if (!adopted) continue;
        const effective = stored.event.chatType === 'group' && this.groupManager ? await this.groupManager.resolved(config, saved.chat_id) : config;
        const key = larkGroupKey(stored.event, saved.scope_id, config.appId);
        const group = this.groups.get(key) ?? { tail: Promise.resolve() };
        this.groups.set(key, group);
        const task: LarkTask = { id: mapping.externalId, event: stored.event, config: effective, prompt: saved.prompt, resources: [],
          group, inbox: adopted, state: 'queued', events: [], turn: (saved.turn ?? 1) - 1, scopeId: saved.scope_id, epoch: group.epoch ?? 0,
          retryMaterialPrompt: saved.retry_material_prompt, sessionId: mapping.sessionId, cardMessageId: saved.card_message_id,
          runtimeTaskId: runtimeTask.id, startedAt: saved.started_at, lastSuccessfulElements: saved.last_successful_elements,
          progressFrozen: saved.progress_frozen, resumeTask: runtimeTask, restoring: true };
        this.tasks.set(task.id, task);
        this.handledMessages.add(task.id);
        group.tail = group.tail.then(() => this.runTurn(task)).catch(error => this.log.error({ error, taskId: task.id }, '恢复飞书任务交互失败'));
      } catch (error) {
        this.log.warn({ error, messageId: mapping.externalId }, '重启后接回飞书任务卡失败，跳过这一条');
      }
    }
  }

  /** 启动恢复里瞬时失败、正在等待重试的入站消息，按消息记已重试次数。 */
  private readonly inboundRecoveryRetries = new Map<string, number>();

  /**
   * 恢复一条上次没处理完的入站消息。handle 会重新检查当前配置和成员身份，凭据从不重放。
   * - 超过恢复年龄上限：unrouted 静默 ignored；已 received 标 failed，给仍有权限的发送人
   *   提示重新发送；旧消息（larkRecoveryNoticeExpired）不回。
   * - 平台明确拒绝（机器人不在群里、群已解散、没有权限）：标 failed 并写原因，重试也不会成功。
   * - 网络、5xx、超时这类瞬时失败：交还记录，退避后在后台重试，不丢；过了年龄上限按上一条收口。
   */
  private async recoverInbound(record: LarkInboxRecord, config: StoredLarkConfig) {
    if (this.stopped) return;
    const messageId = record.event.messageId;
    const receivedAt = record.state === 'unrouted' ? Date.parse(record.receivedAt ?? '') : Number(record.event.createTime) || Date.parse(record.receivedAt ?? '');
    if (Date.now() - receivedAt > larkRedispatchMaxAgeMs) {
      this.inboundRecoveryRetries.delete(messageId);
      const hours = larkRedispatchMaxAgeMs / 3_600_000;
      try {
        if (record.state === 'unrouted') {
          await this.inbox!.update(record, { state: 'ignored' });
          this.scheduleIgnoredPrune(config.appId);
          return;
        }
        await this.inbox!.update(record, { state: 'failed', error: `重启后超过 ${hours} 小时仍未执行，不再自动执行。` });
        const actor = record.event.senderOpenId;
        if (actor && !larkRecoveryNoticeExpired(receivedAt) && await this.currentAccess(config, record.event.chatId, record.event.chatType, actor, 'task.view_result')) {
          await this.workflowReply(record.event, config, `服务重启后，这条请求已超过 ${hours} 小时没有执行，不会再自动执行。如仍需要，请重新发送。`,
            { failed: true, taskName: '请求未执行' });
        }
      } catch (error) {
        this.log.warn({ error, messageId }, '过期的入站记录收尾失败');
      }
      return;
    }
    try {
      if (record.state === 'unrouted') await this.routeCaptured(record, config);
      else await this.handle(record.event, config, true);
      this.inboundRecoveryRetries.delete(messageId);
      return;
    } catch (error) {
      try {
        // 失败可能发生在路由或认领前后：仅交还库中仍待处理的 unrouted/received。
        const current = await this.inbox!.reload(record);
        if (current?.state !== 'received' && current?.state !== 'unrouted') return;
        const reason = error instanceof Error ? error.message : String(error);
        if (isLarkDeterministicFailure(error)) {
          this.inboundRecoveryRetries.delete(messageId);
          await this.inbox!.update(current, { state: 'failed', error: reason });
          this.log.warn({ error, messageId }, '重启恢复的入站消息被飞书明确拒绝，已标记失败');
          return;
        }
        const released = await this.inbox!.release(current);
        if (!released) return;
        const attempt = (this.inboundRecoveryRetries.get(messageId) ?? 0) + 1;
        this.inboundRecoveryRetries.set(messageId, attempt);
        const delayMs = larkInboundRecoveryDelayMs(attempt);
        const cancel = () => { clearTimeout(timer); this.turnCleanups.delete(cancel); };
        const timer = setTimeout(() => {
          cancel();
          void this.enqueueInbound(released.event.chatId, async () => {
            if (this.stopped) return;
            const latest = await this.inbox!.reload(released);
            // 等待期间被别的路径认领（例如同一条消息被再次推送）或已收口：不再重试。
            if (this.stopped || (latest?.state !== 'received' && latest?.state !== 'unrouted') || latest.boot) return;
            this.handledMessages.delete(messageId);
            await this.recoverInbound(latest, config);
          }).catch(retryError => this.log.error({ error: retryError, messageId }, '重试恢复入站消息失败'));
        }, delayMs);
        timer.unref?.();
        this.turnCleanups.add(cancel);
        this.log.warn({ error, messageId, attempt, retryInMs: delayMs }, '重启恢复入站消息暂时失败，稍后重试');
      } catch (settleError) {
        this.log.error({ error: settleError, cause: error, messageId }, '重启恢复入站消息失败后收口出错');
      }
    }
  }

  /**
   * 任务操作类命令的回执。
   *
   * `failed` 必须由调用方按语义传：这里原先写死 `state: 'completed'`，于是拒绝、报错和
   * 「命令可能没生效」的警告都顶着绿色色带和「已完成」发出去——读者看到的颜色和文字
   * 说的是相反的事。同文件的 replyCard 一直是按语义分的（见其 options.failed）。
   */
  private async workflowReply(
    event: LarkMessageEvent, config: StoredLarkConfig, markdown: string,
    options: { elements?: LarkCardElement[]; failed?: boolean; taskName?: string } = {}
  ) {
    return sendTaskCard(this.service, event, {
      taskId: event.messageId, taskName: options.taskName ?? '任务操作',
      state: options.failed ? 'failed' : 'completed', readOnly: true,
      permissionMode: larkPermissionMode(config), markdown, ...(options.elements ? { elements: options.elements } : {}),
      idempotencyKey: `workflow_reply_${event.messageId}`.slice(0, 50) }, this.log);
  }

  private async taskDashboard(event: LarkMessageEvent, config: StoredLarkConfig, page: number) {
    if (!event.senderOpenId) throw new LarkServiceError('LARK_IDENTITY_REQUIRED', '缺少当前成员身份。', 403);
    const entries: LarkTaskDashboardEntry[] = [];
    const interactions = await this.workflows?.list(config.appId) ?? [];
    // Agent 显示名只查一次；查不到名字就退化成 agentId，绝不留空让读者猜是谁在跑。
    const agentNames = new Map((await this.runtime.listAgents?.().catch(() => []) ?? []).map(agent => [agent.id, agent.name] as const));
    for (const mapping of await this.cardMappings?.list(larkCardChannel(config.appId)) ?? []) {
      const saved = JSON.parse(mapping.extra ?? '{}') as PersistedLarkCardTask;
      if (saved.app_id !== config.appId || !saved.runtime_task_id) continue;
      if (event.chatType === 'group' ? saved.chat_id !== event.chatId : saved.sender_open_id !== event.senderOpenId) continue;
      if (saved.chat_type !== 'group' && saved.chat_id !== event.chatId) continue;
      try {
        if (!await this.currentAccess(config, saved.chat_id, saved.chat_type ?? 'group', event.senderOpenId, 'task.view_result', mapping.sessionId)) continue;
      } catch { continue; }
      const session = await this.runtime.getSession(mapping.sessionId);
      const task = (await this.runtime.getTasks?.(mapping.sessionId))?.find(task => task.id === saved.runtime_task_id);
      if (!session || !task) continue;
      const pending = interactions.find(item => item.taskId === task.id && item.state === 'pending' && item.kind !== 'result' && item.boot === this.workflows?.boot);
      const result = interactions.find(item => item.taskId === task.id && item.kind === 'result');
      const host = config.brand === 'lark' ? 'applink.larksuite.com' : 'applink.feishu.cn';
      const url = new URL(`https://${host}/client/${saved.thread_id ? 'thread' : 'chat'}/open`);
      if (saved.thread_id) {
        for (const key of ['open_chat_id', 'openchatid']) url.searchParams.set(key, saved.chat_id);
        for (const key of ['open_thread_id', 'openthreadid']) url.searchParams.set(key, saved.thread_id);
        url.searchParams.set('thread_position', '-1');
      } else url.searchParams.set('openChatId', saved.chat_id);
      // 行内操作只认本进程内存里的活任务：重启后 tasks Map 为空，渲染不出按钮
      // （actionTaskId 缺省），避免发出主控无法定位的死按钮；slash 命令仍是兜底入口。
      const liveTask = this.tasks.get(mapping.externalId);
      const recovery = ['queued', 'reconcile_required', 'legacy_unresolved'].includes(task.status)
        ? await describeLarkTaskRecovery(this.runtime, mapping.sessionId, task.id, task.status) : undefined;
      entries.push({ taskId: task.id, title: saved.task_name, workspace: session.cwd, agent: agentNames.get(session.agentId) ?? session.agentId, status: pending && task.status === 'running'
        ? pending.kind === 'ask' ? 'waiting_for_answer' : 'waiting_for_permission' : task.status, updatedAt: task.updatedAt, url: url.toString(),
        ...(recovery ? { detail: recovery.markdown, blocked: recovery.blocked } : {}),
        ...(liveTask ? {
          actionTaskId: mapping.externalId,
          turn: liveTask.turn,
          ...(liveTask.retryable === false ? { retryable: false } : {})
        } : {}),
        ...(pending && pending.kind === 'permission' && task.status === 'running'
          ? {
              pendingApproval: {
                requestId: pending.id,
                generation: pending.boot,
                commandSummary: pending.question,
                chatId: pending.event.chatId
              }
            }
          : {}),
        ...(result && ['pending', 'accepted', 'needs_changes'].includes(result.state) ? { feedback: result.state as 'pending' | 'accepted' | 'needs_changes' } : {}) });
    }
    return buildLarkTaskDashboard(entries, page, undefined, event.chatId).elements;
  }

  private async routeWorkflow(event: LarkMessageEvent, config: StoredLarkConfig, prompt: string, scope: { id: string; prompt?: string }): Promise<boolean> {
    if (!this.workflows) return false;
    const parsed = parseSlashCommand(prompt);
    const quoted = await this.workflows.quoted(config.appId, event);
    const names = ['tasks', 'answer', 'approve', 'reject'];
    if (!quoted && (!parsed || !names.includes(parsed.name))) return false;
    if (event.senderType === 'app' || event.senderType === 'bot') {
      await this.workflowReply(event, config, '任务操作需由人类成员发起。', { failed: true }); return true;
    }
    try {
      if (parsed?.name === 'tasks') {
        const card = await this.workflowReply(event, config, '', { taskName: '任务导航', elements: await this.taskDashboard(event, config, Number(parsed.args[0] ?? 1)) });
        await this.workflowOptions.store?.set(`lark.task_dashboard.${config.appId}.${card.messageId}`, JSON.stringify({
          messageId: event.messageId, chatId: event.chatId, chatType: event.chatType,
          senderOpenId: event.senderOpenId, messageType: 'text', content: '', mentions: []
        } satisfies LarkMessageEvent));
        return true;
      }
      if (quoted?.kind === 'result' && prompt.trim() === '验收通过') {
        const result = await this.workflows.respond({ appId: config.appId, chatId: event.chatId, actorId: event.senderOpenId, requestId: quoted.id, action: 'accept' });
        await this.refreshResultFeedback(config, quoted.id).catch(error => this.log.warn({ error }, '验收已记录，卡片刷新失败'));
        await this.workflowReply(event, config, result);
        return true;
      }
      if (quoted?.kind === 'result' && (!parsed || !names.includes(parsed.name))) {
        if (!event.senderOpenId || !await this.authorizeInteraction(quoted, event.senderOpenId, 'run.interrupt')) throw new LarkServiceError('LARK_INTERACTION_DENIED', '当前账号无权修改此任务。', 403);
        const mapping = (await this.cardMappings!.list(larkCardChannel(config.appId))).find(item => item.externalId === quoted.event.messageId)!;
        const saved = JSON.parse(mapping.extra!) as PersistedLarkCardTask;
        if (!saved.scope_id) throw new LarkServiceError('LARK_CONTEXT_MISSING', '原任务上下文不可恢复，请发送新的任务目标。', 409);
        if (quoted.state === 'pending') {
          await this.workflows!.respond({ appId: config.appId, chatId: event.chatId, actorId: event.senderOpenId, requestId: quoted.id, action: 'changes' });
          await this.refreshResultFeedback(config, quoted.id).catch(error => this.log.warn({ error }, '修改要求已记录，卡片刷新失败'));
        }
        // A follow-up after acceptance is a new task in the same context; the
        // accepted result remains an accurate record of the previous version.
        scope.id = saved.scope_id;
        return false;
      }
      const action = parsed && ['answer', 'approve', 'reject'].includes(parsed.name) ? parsed.name as 'answer' | 'approve' | 'reject' : 'answer';
      if (quoted && quoted.kind !== 'ask' && action === 'answer') throw new LarkServiceError('LARK_APPROVAL_EXPLICIT', '审批请使用按钮或明确的 /approve、/reject 命令。', 400);
      // 显式编号优先，其次回落到被引用的那张卡。请求编号不再印在卡片正文里
      // （审批卡下方就是按钮，编号对能点按钮的人是噪声），所以「引用那张卡 + /approve」
      // 必须能走通——否则删掉编号就等于删掉了按钮失灵时的唯一备用路径。
      const requestId = (parsed && names.includes(parsed.name) ? parsed.args[0] : undefined) ?? quoted?.id;
      if (!requestId) throw new LarkServiceError('LARK_REQUEST_REQUIRED', '请回复要处理的那张卡片，或直接用卡片上的按钮。', 400);
      const answer = parsed?.name === 'answer' ? parsed.argsText.slice(parsed.args[0]?.length ?? 0).trim() : prompt;
      let result: string;
      try { result = await this.workflows.respond({ appId: config.appId, chatId: event.chatId, actorId: event.senderOpenId, requestId, action, answer }); }
      catch (error) {
        const handover = expiredAskPrompt(error, answer);
        if (!handover) throw error;
        // 过期提问的回复回到原提问所在的会话，作为一条新消息交给 Agent。
        scope.prompt = handover;
        if (quoted) scope.id = await resolveLarkScopeId(quoted.event, config, this.chatModeResolver);
        return false;
      }
      await this.workflowReply(event, config, result);
    } catch (error) {
      await this.workflowReply(event, config, error instanceof Error ? error.message : String(error), { failed: true });
    }
    return true;
  }

  private async pendingAskCandidates(event: LarkMessageEvent, config: StoredLarkConfig, scopeId: string): Promise<LarkInteraction[]> {
    const candidates: LarkInteraction[] = [];
    let continued: Promise<string | undefined> | undefined;
    for (const record of await this.workflows?.pendingAsks(config.appId) ?? []) {
      // 话题续接了发起人顶层任务的会话：那个会话里等着的提问，也收本人在这个话题里的回答。
      continued ??= this.threadContinuation(event, config, scopeId).then(session => session?.id);
      if (record.sessionId === await continued && record.event.chatId === event.chatId && record.event.senderOpenId === event.senderOpenId) { candidates.push(record); continue; }
      if (record.event.threadId && event.threadId && record.event.threadId !== event.threadId) continue;
      const originalRoot = record.event.rootId ?? (record.event.threadId ? record.event.messageId : undefined);
      const replyRoot = event.rootId ?? (event.threadId ? event.messageId : undefined);
      if (originalRoot !== replyRoot) continue;
      if (record.event.chatId === event.chatId && record.event.senderOpenId === event.senderOpenId
        && await resolveLarkScopeId(record.event, config, this.chatModeResolver) === scopeId) candidates.push(record);
    }
    return candidates;
  }

  /**
   * 群参与开启时，这轮对话的根消息由同一用户发出，这条回复针对根消息或本机器人的消息、没有 @ 任何人，
   * 且对应会话仍在进行：它是在继续和机器人对话，不必再 @。回复其他人的消息保持原有路由。
   */
  private async continuesOwnRequest(event: LarkMessageEvent, config: StoredLarkConfig, durable = false): Promise<boolean> {
    const rootId = event.rootId?.trim();
    const parentId = event.parentId?.trim();
    if (event.chatType !== 'group' || event.senderType !== 'user' || !event.senderOpenId || !rootId || rootId === event.messageId
      || event.mentions.length || !this.botOpenId || !this.groupManager) return false;
    try {
      if (await this.workflowOptions.participation!.mode({ appId: config.appId, chatId: event.chatId }) === 'off') return false;
      const scopeId = await resolveLarkScopeId(event, config, this.chatModeResolver);
      // 续接了发起人顶层会话的话题没有自己的会话，按它续接的那个会话算。
      if (!await this.groupManager.hasActiveSession(config, event, scopeId) && !await this.threadContinuation(event, config, scopeId)) return false;
      const root = await this.service.getMessage(rootId);
      if (root.messageId !== rootId || root.chatId !== event.chatId || root.deleted || root.sender.type !== 'user' || root.sender.id !== event.senderOpenId) return false;
      // 话题会话本身证明机器人接过这个话题；普通群按人归属的会话证明不了，根消息必须是 @ 本机器人的请求。
      // 消息读取接口把被 @ 的机器人报成 app_id，实时事件里才是 open_id，两种都认。
      if (!event.threadId?.trim() && !root.mentions.some(mention => mention.id === this.botOpenId || mention.idType === 'app_id' && mention.id === config.appId)) return false;
      if (!parentId || parentId === rootId) return true;
      const parent = await this.service.getMessage(parentId);
      return parent.messageId === parentId && parent.chatId === event.chatId && !parent.deleted
        && ['app', 'bot'].includes(parent.sender.type ?? '') && (parent.sender.id === config.appId || parent.sender.id === this.botOpenId);
    } catch (error) { if (durable) throw error; return false; }
  }

  /** 查不到或查询出错都当作不续接，按原逻辑新建会话。 */
  private async threadContinuation(event: LarkMessageEvent, config: StoredLarkConfig, scopeId: string) {
    try { return await findLarkThreadContinuation(this.runtime, config, event, scopeId, this.cardMappings); }
    catch (error) {
      this.log.warn({ error, chatId: event.chatId, messageId: event.messageId }, '查询话题续接的会话失败，按新话题处理');
      return undefined;
    }
  }

  private async continuesPendingAsk(event: LarkMessageEvent, config: StoredLarkConfig, durable = false): Promise<boolean> {
    if (!this.workflows || !event.senderOpenId || event.senderType !== 'user' || !['text', 'post', 'rich_text'].includes(event.messageType)
      || event.parentId && (!event.threadId || event.parentId !== event.rootId)) return false;
    try {
      const { prompt, resources } = await parsePrompt(event, this.botOpenId);
      if (!prompt.trim() || resources.length || parseSlashCommand(prompt)) return false;
      const scopeId = await resolveLarkScopeId(event, config, this.chatModeResolver);
      return (await this.pendingAskCandidates(event, config, scopeId)).some(record => this.workflows!.acceptsReply(record, prompt));
    } catch (error) { if (durable) throw error; return false; }
  }

  private async routePendingAsk(event: LarkMessageEvent, config: StoredLarkConfig, prompt: string, resources: LarkMessageResource[], scope: { id: string; prompt?: string }, inbox: LarkInboxRecord | undefined, recovering: boolean): Promise<boolean> {
    if (!this.workflows || !event.senderOpenId || event.senderType !== 'user' || !['text', 'post', 'rich_text'].includes(event.messageType)
      || !prompt.trim() || resources.length || parseSlashCommand(prompt)
      // Ordinary topic replies point at the topic root. A different parent
      // is an explicit quote and must retain its existing routing semantics.
      || event.parentId && (!event.threadId || event.parentId !== event.rootId)) return false;
    let requestId = inbox?.workflowRequestId;
    if (!requestId) {
      // Recovery must not reinterpret an old message as a reply to a new ask.
      if (recovering) return false;
      // 带选项的提问只认对得上某个选项的回复，其余文字按普通消息处理。
      const candidates = (await this.pendingAskCandidates(event, config, scope.id)).filter(record => this.workflows!.acceptsReply(record, prompt));
      if (!candidates.length) return false;
      if (candidates.length > 1) {
        if (inbox) await this.inbox!.update(inbox, { state: 'command' });
        await this.workflowReply(event, config, '当前有多个问题等待回答，请引用要回答的提问卡片回复。');
        return true;
      }
      requestId = candidates[0]!.id;
      // Pin the waiter before answering: if acknowledgement fails or the
      // daemon restarts, this message can never answer a later question.
      if (inbox) await this.inbox!.update(inbox, { workflowRequestId: requestId });
    }
    try {
      const result = await this.workflows.respond({ appId: config.appId, chatId: event.chatId, actorId: event.senderOpenId, requestId, action: 'answer', answer: prompt });
      await this.workflowReply(event, config, result);
    } catch (error) {
      const handover = expiredAskPrompt(error, prompt);
      if (handover) { scope.prompt = handover; return false; }
      await this.workflowReply(event, config, error instanceof Error ? error.message : String(error), { failed: true });
    }
    return true;
  }

  protected scheduleTaskAgentPoll(config: StoredLarkConfig) {
    if (this.stopped || this.taskAgentTimer) return;
    this.taskAgentTimer = setTimeout(() => {
      this.taskAgentTimer = undefined;
      if (this.stopped) return;
      void this.pollLarkTaskDispatches(config)
        .catch(error => this.log.warn({ error, appId: config.appId }, '飞书任务智能体通道轮询失败，下一轮重试'))
        .finally(() => this.scheduleTaskAgentPoll(config));
    }, this.taskAgentIntervalMs);
    this.taskAgentTimer.unref();
  }

  /**
   * 拉取分配给本机器人的飞书任务并逐条交给消息入口。返回本轮真正派出去的条数。
   *
   * 认领与交接必须成对：claimLarkTaskDispatches 先把任务在账本上认领下来，交接抛错时
   * 这里把尚未进入持久化 inbox 的认领退回；进程中断的遗留认领由下一进程接手。
   */
  async pollLarkTaskDispatches(config: StoredLarkConfig): Promise<number> {
    const store = this.workflowOptions.store;
    if (this.stopped || !store) return 0;
    if (this.taskAgentRun) return this.taskAgentRun;
    const run = (async () => {
      const intake = await claimLarkTaskDispatches({
        appId: config.appId, client: this.service, store, botConfig: config, log: this.log,
        hasHandoff: dispatch => store.get(`lark.inbox.${config.appId}.${dispatch.event.messageId}`).then(Boolean)
      });
      if (intake.status !== 'ready') return 0;
      let dispatched = 0;
      try {
        for (const dispatch of intake.dispatches) {
          if (this.stopped) break;
          try {
            await this.handle(dispatch.event, config);
            if (await store.get(`lark.inbox.${config.appId}.${dispatch.event.messageId}`)) dispatched++;
          } catch (error) {
            this.log.warn({ error, taskGuid: dispatch.taskGuid }, '飞书任务交接失败，未入站任务等待下一轮重派');
          }
        }
      } finally {
        // The inbox owns handed-off tasks, including received tasks awaiting recovery.
        // Release every remaining claim on stop, early handle return, or failure.
        for (const dispatch of intake.dispatches) {
          if (await store.get(`lark.inbox.${config.appId}.${dispatch.event.messageId}`)) continue;
          await releaseLarkTaskClaim(store, dispatch.ledgerKey, dispatch.claimValue)
            .catch(error => this.log.error({ error, taskGuid: dispatch.taskGuid }, '退回飞书任务认领失败'));
        }
      }
      return dispatched;
    })().finally(() => { if (this.taskAgentRun === run) this.taskAgentRun = undefined; });
    this.taskAgentRun = run;
    return run;
  }

  /**
   * task.task.update_user_access_v2（含 task_assignees_update）事件入口：立即走一次与
   * 定时轮询完全相同的认领流程，不必等下一轮轮询。幂等性由 claimLarkTaskDispatches 的
   * ledger CAS 与 taskAgentRun 的在途合并共同保证——重复事件、事件与轮询并发都只会认领
   * 一次。通道未激活时 pollLarkTaskDispatches 内部直接返回 0，无需在此重复判定。
   * 不 await：事件回调不能被一次交接拖死，失败由保留的定时轮询兜底重试。
   */
  handleTaskAssigneesUpdate(config: StoredLarkConfig): void {
    void this.pollLarkTaskDispatches(config)
      .then(dispatched => {
        if (dispatched > 0) this.log.info({ appId: config.appId, dispatched }, '飞书任务指派人变更事件触发即时认领');
      })
      .catch(error => this.log.warn({ error, appId: config.appId }, '飞书任务事件触发认领失败，等待轮询兜底'));
  }

  private async rejectIncoming(event: LarkMessageEvent, config: StoredLarkConfig, reason: string, explicit: boolean) {
    if (!explicit || this.handledMessages.has(event.messageId)) return;
    this.handledMessages.add(event.messageId);
    if (this.handledMessages.size > 5_000) this.handledMessages.delete(this.handledMessages.values().next().value!);
    const inbox = await this.inbox?.claim(config.appId, event, true);
    if (this.inbox && !inbox) return;
    await sendTaskCard(this.service, event, {
      state: 'failed', readOnly: true, retryable: false, taskId: event.messageId, taskName: '请求未执行',
      markdown: `**请求未执行，Agent 尚未启动。**\n\n${reason}\n\n请联系此机器人的管理员检查群配置、运行权限和你的访问授权，确认生效后重新发送。`,
      idempotencyKey: `input_denied_${event.messageId}`.slice(0, 50)
    }, this.log).catch(error => this.log.warn({ error, messageId: event.messageId }, '发送未执行回执失败'));
    if (inbox) await this.inbox!.update(inbox, { state: 'failed', error: reason });
  }

  /** 群参与判定为 act、或告警订阅起初筛时，按发送者本人的显式请求走同一条授权、领取与执行路径。 */
  adopt(event: LarkMessageEvent, config: StoredLarkConfig) {
    // 只有内部 dispatcher 的告警派生可改变执行身份/话题，正文始终沿用持久原文。
    const adoption: LarkInboxAdoption | undefined = event.triage ? {
      senderOpenId: event.senderOpenId, senderType: event.senderType, triage: event.triage,
      rootId: event.rootId, threadId: event.threadId, parentId: event.parentId
    } : undefined;
    return this.handle(event, config, false, true, undefined, undefined, adoption);
  }

  private readonly intakeTails = new Map<string, Promise<void>>();
  private ignoredPrunePending = false;

  /** SDK 只等待本地接收。同群路由保持接收顺序，其他群不受慢权限查询影响。 */
  async receive(event: LarkMessageEvent, config: StoredLarkConfig) {
    if (!this.inbox) {
      void this.handle(event, config).catch(error => this.log.error({ error, messageId: event.messageId }, '处理飞书消息事件失败'));
      return;
    }
    const record = await this.inbox.capture(config.appId, event);
    if (!record) return;
    void this.enqueueInbound(record.event.chatId, () => this.recoverInbound(record, config))
      .catch(error => this.log.error({ error, messageId: event.messageId }, '处理已接收的飞书消息失败'));
  }

  private enqueueInbound(chatId: string, operation: () => Promise<void>) {
    const prior = this.intakeTails.get(chatId) ?? Promise.resolve();
    const next = prior.then(() => new Promise<void>(resolve => setImmediate(resolve))).then(operation);
    const settled = next.catch(() => {});
    this.intakeTails.set(chatId, settled);
    void settled.then(() => { if (this.intakeTails.get(chatId) === settled) this.intakeTails.delete(chatId); });
    return next;
  }

  handleEdited(event: LarkMessageEvent, config: StoredLarkConfig) {
    return this.enqueueInbound(event.chatId, async () => {
      await this.inbox?.reopenIgnored(config.appId, event);
      const record = await this.inbox?.capture(config.appId, event);
      if (record) return this.recoverInbound(record, config);
      return this.handle(event, config);
    });
  }

  private async routeCaptured(record: LarkInboxRecord, config: StoredLarkConfig) {
    if (this.stopped) return;
    const owned = await this.inbox!.ownUnrouted(record);
    if (!owned) return;
    // 尚未路由的记录重新走正常唤醒和当前权限；既不 adopt，也不跳过 live ask/request continuation。
    await this.handle(owned.event, config, false, false, undefined, owned);
    if (this.stopped) return;
    const current = await this.inbox!.reload(record);
    if (current?.state !== 'unrouted') return;
    await this.inbox!.update(current, { state: 'ignored' });
    this.scheduleIgnoredPrune(config.appId);
  }

  private scheduleIgnoredPrune(appId: string) {
    if (this.ignoredPrunePending) return;
    this.ignoredPrunePending = true;
    const cancel = () => { clearTimeout(timer); this.ignoredPrunePending = false; this.turnCleanups.delete(cancel); };
    const timer = setTimeout(() => {
      this.turnCleanups.delete(cancel);
      void this.inbox!.pruneIgnored(appId)
        .catch(error => this.log.warn({ error }, '清理已忽略的飞书入站记录失败'))
        .finally(() => { this.ignoredPrunePending = false; });
    }, 30_000);
    timer.unref?.();
    this.turnCleanups.add(cancel);
  }

  /** retrying：首卡重试重新走入站处理时传入原任务，按它触发时的 epoch 判断 /new。 */
  async handle(event: LarkMessageEvent, config: StoredLarkConfig, recovering = false, adopted = false, retrying?: LarkTask, captured?: LarkInboxRecord, adoption?: LarkInboxAdoption) {
    const persisted = captured ?? await this.inbox?.lookup(config.appId, event.messageId);
    if (persisted) {
      if (persisted.state !== 'received' && !((captured || adopted) && persisted.state === 'unrouted') && !(adopted && persisted.state === 'ignored')) return;
      event = persisted.event;
    }
    if (adoption) event = { ...event, ...adoption };
    // 告警初筛的消息已由群参与观察和判过，这里不再观察、不过机器人回合门禁（订阅自带去重和每小时上限）；
    // 发起人不是这条消息的发送者，要按群成员重新确认。重启恢复时同样按受理处理。
    const triage = adoption || persisted?.state === 'received' ? event.triage : undefined;
    if (triage) adopted = true;
    if (this.workflowOptions.store) {
      const current = await readLarkConfig(this.workflowOptions.store, config.appId);
      if (!current?.listening) return;
      config = current;
    }
    const quotedWorkflow = await this.workflows?.quoted(config.appId, event);
    const mentionsBot = this.botOpenId ? event.mentions.some(mention => mention.openId === this.botOpenId) : event.mentions.some(mention => mention.mentionedType === 'bot');
    if (this.stopped) return;
    const botSender = event.senderType === 'app' || event.senderType === 'bot';
    const explicit = !botSender && (event.chatType === 'p2p' || mentionsBot || Boolean(quotedWorkflow) || adopted);
    let helpOnly = false;
    let recognizedCommand = false;
    try {
      const parsed = parseSlashCommand((await parsePrompt(event, this.botOpenId)).prompt);
      helpOnly = parsed?.name === 'help';
      recognizedCommand = Boolean(parsed && resolveLarkCommand(parsed));
    } catch { /* normal parser reports malformed content below */ }
    const entryAction: PolicyAction = helpOnly ? 'task.view_result' : 'task.create';
    try {
      if (event.chatType === 'group' && this.groupManager) config = await this.groupManager.resolved(config, event.chatId);
    } catch (error) {
      if (captured && !isLarkDeterministicFailure(error) && (error as { code?: string })?.code !== 'LARK_GROUP_NOT_APPLIED') throw error;
      await this.rejectIncoming(event, config, error instanceof Error ? error.message : '群配置尚未生效。', explicit);
      return;
    }
    const mentionPolicy = config.mentionPolicy ?? 'always';
    const topicScope = mentionPolicy === 'topic' && this.groupManager ? await resolveLarkScopeId(event, config, this.chatModeResolver) : undefined;
    // 续接了发起人顶层会话的话题没有自己的会话，续接的会话还在就同样算机器人接过的话题。
    const continuedTopic = topicScope && this.groupManager
      ? await this.groupManager.ownsTopic(config, event, topicScope) || Boolean(await this.threadContinuation(event, config, topicScope)) : false;
    // ambient 与 never 的区别在这里：ambient 在消息指名了别人时让路，只接没有指名任何人的消息。
    // 本分支已排除 mentionsBot，所以此处出现的任何 mention 都是「点了别人」。
    const ambientOpen = mentionPolicy === 'ambient' && !event.mentions.length;
    const legacyWake = Boolean(quotedWorkflow) || event.chatType === 'p2p' || (event.chatType === 'group' && (mentionsBot || !botSender && (continuedTopic || mentionPolicy === 'never' || ambientOpen)));
    // Known commands retain their existing wake and authorization rules; unknown /paths remain material.
    const commandInteraction = !botSender && recognizedCommand && legacyWake;
    // Observation precedes wake filtering and every visible acknowledgement.
    // 发起人在同一话题里直接回复仍在等待的提问就是在作答，不依赖群参与开关。
    const pendingAskContinuation = Boolean(!recovering && !explicit && await this.continuesPendingAsk(event, config, Boolean(captured)));
    const requestContinuation = Boolean(this.workflowOptions.participation && !recovering && !explicit && !pendingAskContinuation && await this.continuesOwnRequest(event, config, Boolean(captured)));
    const addressed = explicit || requestContinuation;
    // 话题内免 @ 续聊也算在叫它，可以直接改档或问「为什么没回」；是否接手仍按下方原规则。
    const topicContinuation = Boolean(continuedTopic) && !botSender;
    const participation = triage ? undefined : await this.workflowOptions.participation?.handle(event, config, { explicit: addressed || pendingAskContinuation || commandInteraction, botOpenId: this.botOpenId,
      addressed: (addressed || topicContinuation) && !recognizedCommand && !recovering, ownedTopic: topicContinuation });
    if (this.handledMessages.has(event.messageId)) return;
    // 改档短语、「为什么没回」已由群参与直接回应；「没问你」这类纠正只记录，不当成新请求。
    if (participation?.handled) return;
    // 定向机器人交接仍走下方循环门禁和访问授权，不作为人类显式指令或主动判定。
    if (participation?.enabled && !addressed && !pendingAskContinuation && !commandInteraction && !(botSender && legacyWake)) return;
    const shouldWake = legacyWake || adopted || pendingAskContinuation || Boolean(participation?.enabled && requestContinuation);
    // 机器人互相 @ 的硬门禁。legacyWake 的 mentionsBot / quotedWorkflow 两支都不受 !botSender
    // 约束，访问控制在没配成员名单时又对机器人一律放行，所以刷屏回路只能在这里封口。
    // 判定失败按挡下处理：门禁读不到状态时放行等于把回路重新打开。
    // 被挡下的回合只留门禁记录，绝不向群里发消息——那本身就是噪音。
    if (shouldWake && event.chatType === 'group' && this.workflowOptions.participation && !triage) {
      let botTurnGate: string | undefined;
      try {
        botTurnGate = await this.workflowOptions.participation.guardBotTurn(event, config, { botOpenId: this.botOpenId });
      } catch (error) {
        if (captured) throw error;
        botTurnGate = '机器人回合门禁判定失败';
        this.log.warn({ error, chatId: event.chatId, messageId: event.messageId }, '机器人回合门禁判定失败，本轮不响应');
      }
      if (botTurnGate) {
        this.log.info({ chatId: event.chatId, messageId: event.messageId, reason: botTurnGate }, '机器人触发的回合已被门禁挡下');
        return;
      }
    }
    if (shouldWake && event.chatType === 'group' && this.groupManager) {
      const decision = await this.groupManager.authorize(config.appId, event.chatId, event.senderOpenId, entryAction, undefined, { memberObserved: !recovering && !triage });
      if (decision && !decision.allowed) {
        await this.rejectIncoming(event, config, decision.code === 'talk_required' ? '当前账号没有此群的任务访问权限。' : decision.reason, addressed);
        return;
      }
    }
    if (this.stopped || !shouldWake || this.handledMessages.has(event.messageId)) return;
    if (recovering && (!event.senderOpenId || !await this.currentAccess(config, event.chatId, event.chatType, event.senderOpenId, entryAction, undefined, event.senderOpenId))) return;
    try { if (!helpOnly) await this.requireExecution('listener', 'task.create'); }
    catch (error) {
      if (captured && !isLarkDeterministicFailure(error)) throw error;
      await this.rejectIncoming(event, config, error instanceof Error ? error.message : '机器人尚未获得运行权限。', addressed);
      return;
    }
    const inbox = await this.inbox?.claim(config.appId, event, adopted, adoption);
    if (this.inbox && !inbox) return;
    if (inbox) event = inbox.event;
    // 原任务还留在 tasks 里，/new 按它作废入站记录：新认领要立刻交给它，否则 CAS 对不上。
    if (retrying && inbox) retrying.inbox = inbox;
    // 先标记已处理，避免异步解析期间同一条消息被重复入队。
    this.handledMessages.add(event.messageId);
    if (this.handledMessages.size > 5_000) this.handledMessages.delete(this.handledMessages.values().next().value!);
    // 事件接入后立即给出稳定、单义的接收确认。解析、附件下载和会话路由均可能较慢，
    // 不应让用户在这些步骤中面对无反馈的聊天界面。
    // 任务通道派来的是合成事件，背后没有真实消息：给它贴表情必然失败，
    // 每条任务留一条 warn 就是纯噪声，因此在调用前跳过。
    let acknowledgementReactionId: string | undefined;
    if (!larkTaskAgentGuid(event.messageId)) {
      try {
        acknowledgementReactionId = (await this.service.addReaction(event.messageId, 'OK')).reactionId;
      } catch (error) {
        this.log.warn({ error, messageId: event.messageId }, '发送飞书确认表情失败，继续处理消息');
      }
    }
    let prompt: string;
    let resources: LarkMessageResource[];
    let scopeId: string;
    try {
      ({ prompt, resources } = await parsePrompt(event, this.botOpenId));
      // 路由解析（话题群种子 / 普通群回复模式 / legacy）与 group key 共用同一 scopeId，
      // 保证同一会话的消息串行化到同一个 group。
      scopeId = await resolveLarkScopeId(event, config, this.chatModeResolver);
    } catch (error) {
      this.log.warn({ error, chatId: event.chatId, messageId: event.messageId }, '解析飞书消息失败，已向用户回执');
      // P0-4：解析失败回执是独立新消息，群聊开启时与其他失败回执同口径 @ 发起人；私聊不 @。
      const parseFailMention = senderGroupMention(config.groupCardMention, event);
      await sendTaskCard(this.service, event, {
        state: 'failed', retryable: false, readOnly: true,
        taskId: event.messageId, taskName: '消息接收失败',
        markdown: `${parseFailMention ? `${parseFailMention}\n\n` : ''}**消息未能解析，Agent 尚未执行。**\n\n${error instanceof Error ? error.message : String(error)}\n\n请检查消息内容或附件后重新发送。`,
        idempotencyKey: `parse_failed_${event.messageId}`.slice(0, 50),
        ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {})
      }, this.log).catch(cardError => this.log.error({ error: cardError, messageId: event.messageId }, '发送飞书解析失败回执失败'));
      if (acknowledgementReactionId) await this.service.deleteReaction(event.messageId, acknowledgementReactionId).catch(() => undefined);
      if (inbox) await this.inbox!.update(inbox, { state: 'failed', error: '消息解析失败' });
      return;
    }
    if (triage) prompt = `${triage}\n${prompt}`;
    if (inbox?.request) { prompt = inbox.request.prompt; resources = inbox.request.resources; scopeId = inbox.request.scopeId; }
    // 这条曾并入前一条排队消息：先按合并意图收口，决定执行合并后的原文还是自己的原文（见 resumeMergedInbox）。
    if (inbox?.request && inbox.mergeFrom) prompt = await this.resumeMergedInbox(inbox);
    const workflowScope: { id: string; prompt?: string } = { id: scopeId };
    if (!inbox?.request && (await this.routeWorkflow(event, config, prompt, workflowScope)
      || await this.routePendingAsk(event, config, prompt, resources, workflowScope, inbox, recovering))) {
      if (inbox) await this.inbox!.update(inbox, { state: 'accepted' });
      if (acknowledgementReactionId) await this.service.deleteReaction(event.messageId, acknowledgementReactionId).catch(() => undefined);
      return;
    }
    scopeId = workflowScope.id;
    if (workflowScope.prompt) prompt = workflowScope.prompt;
    // 聊天内斜杠命令：必须在解析之后（拿到剥离 @机器人 的纯文本）、建任务之前。
    // 命令不是 Agent 任务，不应占用一次 Agent 轮次，也不应留下进度卡。
    // 未识别的 /xxx 会被归一化成普通文字继续走建任务流程（用户发路径不该收到失败回执）。
    // group 必须先于命令路由取出：/new 要在这个 group 上登记「已结束的会话」，
    // 之后同一 group 的消息（包括本条 /new 自带的任务内容）才不会把旧上下文绑回来。
    const groupKey = larkGroupKey(event, scopeId, config.appId);
    const group = this.groups.get(groupKey) ?? { tail: Promise.resolve() };
    this.groups.set(groupKey, group);
    // 话题续接发起人的顶层任务时，先把内存绑定指向那个会话：命令和后续消息都按它处理。
    if (!group.sessionId) {
      const continued = await this.threadContinuation(event, config, scopeId);
      if (continued && !group.retiredSessionIds?.has(continued.id)) { group.sessionId = continued.id; group.sessionConfigKey = larkSessionConfigKey(config); }
    }
    if (inbox && !inbox.request && parseSlashCommand(prompt)) await this.inbox!.update(inbox, { state: 'command' });
    let commandRoute = inbox?.request ? undefined : await this.routeChatCommand(event, config, prompt, group, scopeId, acknowledgementReactionId);
    // C2：机器人话题里的「继续」「停」「重来」先按控制处理，不适用时照常当普通消息。
    const control = !inbox?.request && commandRoute === undefined ? larkControlPhrase(prompt) : undefined;
    if (control) commandRoute = await this.routeControlPhrase(control, event, config, prompt, group, scopeId, acknowledgementReactionId);
    if (commandRoute === 'handled') {
      if (inbox) await this.inbox!.update(inbox, { state: 'accepted' });
      return;
    }
    let retryMaterialPrompt = inbox?.request?.materialPrompt;
    let launchOptions = inbox?.request?.launchOptions;
    let commandEpoch: number | undefined;
    if (typeof commandRoute === 'string') prompt = commandRoute;
    else if (commandRoute) { prompt = commandRoute.prompt; retryMaterialPrompt = commandRoute.materialPrompt; launchOptions = commandRoute.launchOptions; commandEpoch = commandRoute.epoch; }
    if (inbox && !inbox.request) await this.inbox!.update(inbox, { state: 'received', request: { prompt, scopeId, resources, ...(retryMaterialPrompt ? { materialPrompt: retryMaterialPrompt } : {}), ...(launchOptions ? { launchOptions } : {}) } });
    // 首卡重试从触发到这里有多步异步操作，期间用户可能发了 /new。
    if (retrying && (retrying.epoch !== (group.epoch ?? 0) || (inbox?.sessionId && group.retiredSessionIds?.has(inbox.sessionId)))) {
      if (inbox?.state === 'received') await this.inbox!.update(inbox, { state: 'failed', error: '请求在执行前被 /new 作废' });
      if (acknowledgementReactionId) await this.service.deleteReaction(event.messageId, acknowledgementReactionId).catch(() => undefined);
      return;
    }
    // 空 @ 消息（仅 @ 机器人无文字）仍需创建任务，由 runTurn 拉取聊天记录做兜底意图判断。
    const task: LarkTask = { id: event.messageId, group, event, prompt, resources, inbox, retryMaterialPrompt, launchOptions, ...(inbox?.cardId ? { cardMessageId: inbox.cardId } : {}), ...(inbox?.redispatch ? { redispatch: inbox.redispatch } : {}), ...(commandRoute && typeof commandRoute !== 'string' && commandRoute.suggestion ? { commandSuggestion: commandRoute.suggestion } : {}), ...(commandRoute && typeof commandRoute !== 'string' && commandRoute.steer ? { steer: true } : {}), config, state: 'queued', events: [], restoring: recovering, turn: (inbox?.turn ?? 1) - 1, scopeId, epoch: commandEpoch ?? retrying?.epoch ?? group.epoch ?? 0, acknowledgementReactionId };
    this.tasks.set(task.id, task);
    if (this.tasks.size > 5_000) this.tasks.delete(this.tasks.keys().next().value!);
    group.tail = group.tail.then(() => this.runTurn(task)).catch(async error => {
      this.log.error({ error, chatId: event.chatId, messageId: event.messageId }, '处理飞书唤醒消息失败');
      // runTurn 在首张卡片送达前抛出（附件下载、空 @ 兜底、卡片发送本身失败）时，
      // OK reaction 会永远留在原消息上：用户看到「已接收」却永远等不到进度卡，
      // 正是设计契约禁止的两个竞争状态并存。此处兜底撤销，保证回执不会悬挂。
      await this.clearAcknowledgementReaction(task);
      if (inbox?.state === 'received' && !task.runtimeTaskId && isLarkFirstCardUndelivered(error)) {
        await this.retryUndeliveredInbound(task, inbox, config, recovering, adopted, error);
        return;
      }
      if (inbox?.state === 'received') await this.inbox!.update(inbox, { state: 'failed', error: error instanceof Error ? error.message : String(error) });
    });
  }

  /** 首卡没送达的请求已经重试了几次，按「消息:轮次」记。 */
  private readonly undeliveredRetries = new Map<string, number>();
  /** 排定了重试、正在等待的请求，按消息记；/new 用它撤销同一会话里的重试。 */
  private readonly undeliveredPending = new Map<string, { task: LarkTask; cancel: () => void }>();

  /**
   * 首张进度卡没送达、runtime 还没接到任务：飞书抖动或限流时这条请求会悄悄丢掉。
   * 进程内 30 秒、2 分钟后各重试一次整条入站处理，首卡幂等键不变，不会重复发卡。
   * 等待期间入站记录保持 received 并交还认领，进程先退出的话重启恢复照常接手。
   * 两次都没送达时尽量回一条纯文本，再标 failed。
   */
  private async retryUndeliveredInbound(task: LarkTask, inbox: LarkInboxRecord, config: StoredLarkConfig, recovering: boolean, adopted: boolean, error: unknown) {
    if (this.stopped) return;
    const key = `${task.id}:${task.turn}`;
    const attempt = this.undeliveredRetries.get(key) ?? 0;
    const delayMs = larkUndeliveredRetryDelaysMs[attempt];
    if (delayMs === undefined) {
      this.undeliveredRetries.delete(key);
      if (typeof this.service.replyText === 'function') {
        await this.service.replyText({ messageId: task.event.messageId, ...(task.event.threadId ? { replyInThread: true } : {}), text: '这条请求没有执行，请重发。', idempotencyKey: `request_not_run_${task.id}`.slice(0, 50) })
          .catch(replyError => this.log.warn({ error: replyError, messageId: task.id }, '发送「请求没有执行」提示失败'));
      }
      await this.inbox!.update(inbox, { state: 'failed', error: error instanceof Error ? error.message : String(error) })
        .catch(updateError => this.log.error({ error: updateError, messageId: task.id }, '标记入站请求失败出错'));
      return;
    }
    const released = await this.inbox!.release(inbox).catch(() => undefined);
    // 记录已被改动，说明别的路径接手了这条消息。
    if (!released) return;
    // 任务上持有的认领要换成交还后的这份：等待期间 /new 按它把记录标成不再执行，旧对象的 CAS 会失败。
    task.inbox = released;
    this.undeliveredRetries.set(key, attempt + 1);
    const failedAt = Date.now();
    const cancel = () => {
      clearTimeout(timer);
      this.turnCleanups.delete(cancel);
      this.undeliveredPending.delete(task.id);
    };
    const timer = setTimeout(() => {
      cancel();
      void this.runUndeliveredRetry(task, released, config, recovering, adopted, failedAt)
        .catch(retryError => this.log.error({ error: retryError, messageId: task.id }, '重试飞书入站请求失败'));
    }, delayMs);
    timer.unref?.();
    this.turnCleanups.add(cancel);
    this.undeliveredPending.set(task.id, { task, cancel });
    this.log.warn({ error, messageId: task.id, attempt: attempt + 1, retryInMs: delayMs }, '首张进度卡没送达，稍后重试这条请求');
  }

  /** /new 结束了这个会话：撤销其中等待重试的请求。入站记录由 /new 作废待执行请求时一并标成不再执行。 */
  private cancelUndeliveredRetries(group: LarkGroup) {
    for (const { task, cancel } of [...this.undeliveredPending.values()]) {
      if (task.group !== group) continue;
      cancel();
      this.undeliveredRetries.delete(`${task.id}:${task.turn}`);
    }
  }

  private async runUndeliveredRetry(task: LarkTask, released: LarkInboxRecord, config: StoredLarkConfig, recovering: boolean, adopted: boolean, failedAt: number) {
    if (this.stopped) return;
    const key = `${task.id}:${task.turn}`;
    // 等待期间会话被 /new 作废：旧请求不再执行。
    const sessionId = released.sessionId;
    if (task.epoch !== (task.group.epoch ?? 0) || (sessionId && task.group.retiredSessionIds?.has(sessionId))) {
      this.undeliveredRetries.delete(key);
      if (await this.inbox!.unclaimed(released)) await this.inbox!.update(released, { state: 'failed', error: '请求在执行前被 /new 作废' });
      return;
    }
    // 等待期间已被别的路径接手（例如重启恢复，或同一条消息被再次推送），或已不是 received，不再重试。
    if (!await this.inbox!.unclaimed(released)) {
      this.undeliveredRetries.delete(key);
      return;
    }
    // 用户已经用新消息重发了同一条请求：旧的这条不再执行，免得同一件事做两遍。
    // 只认两条都是纯文本（没有图片、附件，也不是引用回复）、新的一条已被接收的情形；
    // 图片、文件的文字摘要都一样，看不出是不是同一个请求。
    const plainText = (item: LarkTask) => item.event.messageType === 'text' && !item.event.parentId && !item.inbox?.request?.resources.length;
    const resent = plainText(task) && [...this.tasks.values()].some(other => other.id !== task.id && other.group === task.group
      && other.event.senderOpenId === task.event.senderOpenId && other.prompt === task.prompt && (other.startedAt ?? 0) >= failedAt
      && plainText(other) && (other.inbox?.state === 'accepted' || Boolean(other.runtimeTaskId)));
    if (resent) {
      this.undeliveredRetries.delete(key);
      await this.inbox!.update(released, { state: 'failed', error: '用户已重新发送同一请求' });
      return;
    }
    this.handledMessages.delete(task.id);
    await this.handle(released.event, config, recovering, adopted, task);
  }

  /**
   * 聊天内斜杠命令路由。
   *
   * 返回值：
   * - `'handled'`  —— 命令已自行回执（/help、拒绝、不可用、已执行），调用方直接结束
   * - `string`     —— 未识别的 /xxx，已归一化为普通文字，调用方用它继续建任务
   * - `undefined`  —— 不是命令，调用方按原流程继续
   *
   * 权限沿用既有白名单机制（isOperatorAllowed），不新造权限系统；
   * 能力则从真实 runtime 探测，缺能力的命令只会收敛成 unavailable 回执，不会产生 intent。
   */
  /** /help 首屏与翻页回调重建同一能力屏，两处口径必须一致，集中在此。 */
  private larkRouteCapabilities() {
    return {
      ...larkCommandCapabilities(this.runtime),
      // 只有 automation 不算可用：GitHub 令牌或 Codebase webhook 至少配一个，否则 /ci 回「未配置」。
      ci: Boolean(this.workflowOptions.automation && (this.workflowOptions.automation.githubConfigured || this.workflowOptions.automation.codebase)),
      schedule: Boolean(this.workflowOptions.automation),
      work: Boolean(this.workflowOptions.workbench),
      tasks: Boolean(this.workflows && this.cardMappings && this.runtime.getTasks),
      answer: Boolean(this.workflows && this.workflowOptions.broker),
      approval: Boolean(this.workflows && this.runtime.resolvePermission && this.runtime.getPendingPermissions),
      memory: Boolean(this.workflowOptions.memory),
      groupPolicy: Boolean(this.groupManager)
    };
  }

  private async routeChatCommand(
    event: LarkMessageEvent,
    config: StoredLarkConfig,
    prompt: string,
    group: LarkGroup,
    scopeId: string,
    acknowledgementReactionId?: string
  ): Promise<'handled' | string | LarkCommandPrompt | undefined> {
    if (!parseSlashCommand(prompt)) return undefined;
    const botSender = event.senderType === 'app' || event.senderType === 'bot';
    const allowlisted = await this.commandAllowlisted(config, event.chatType, event.chatId, event.senderOpenId, group.sessionId);
    const route = routeLarkCommand(prompt, {
      capabilities: this.larkRouteCapabilities(),
      operator: { kind: botSender ? 'bot' : 'user', allowlisted }
    });
    if (route.kind === 'not_a_command') return undefined;
    // 未识别命令交回主流程当普通请求处理，命令层已做归一化防止再被当成内置命令。
    // S3：近似匹配时 suggestion 随对象带回，只上卡面，promptText 仍是唯一进 agent 的原文。
    if (route.kind === 'unknown_command') {
      return route.suggestion ? { prompt: route.promptText, suggestion: route.suggestion } : route.promptText;
    }

    // 命令回执一律是只读卡片：它不是任务，没有进度可承诺，也不该提供操作按钮。
    const replyCard = async (
      taskName: string,
      markdown: string,
      options: { elements?: LarkCardElement[]; failed?: boolean } = {}
    ) => {
      const card = await sendTaskCard(this.service, event, {
        state: options.failed ? 'failed' : 'completed', readOnly: true, retryable: false,
        taskId: event.messageId, taskName,
        markdown,
        ...(options.elements?.length ? { elements: options.elements } : {}),
        idempotencyKey: `cmd_${route.command}_${event.messageId}`.slice(0, 50),
        ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {})
      }, this.log).catch(error => { this.log.error({ error, messageId: event.messageId, command: route.command }, '发送飞书命令回执失败'); return undefined; });
      // reaction 是「请求已接入」的回执，命令回执落地后必须撤销，避免两个状态并存。
      if (acknowledgementReactionId) {
        await this.service.deleteReaction(event.messageId, acknowledgementReactionId).catch(() => undefined);
      }
      return card;
    };

    if (route.kind === 'correction') {
      await replyCard('命令未执行', route.text);
      return 'handled';
    }
    if (route.kind === 'reply') {
      await replyCard(larkHelpCardTitle, route.text, { elements: route.elements });
      return 'handled';
    }
    if (route.kind === 'denied' || route.kind === 'unavailable') {
      await replyCard(`/${route.command} 未执行`, route.reason, { failed: true });
      this.log.info({ messageId: event.messageId, command: route.command, kind: route.kind }, '飞书命令未执行');
      return 'handled';
    }
    return await this.executeChatCommandIntent(route, event, config, group, scopeId, replyCard, acknowledgementReactionId);
  }

  /**
   * C2：机器人自己的话题里（已有会话）的短控制语。返回 'handled' 表示已回执；返回请求表示接着走建任务链路
   * （授权、风险检查照常）；undefined 表示当普通消息。
   * - 停：同 /cancel。
   * - 继续：前面有结果未知、挡着话题的一轮，就按没做完处理，在原对话接着做；上一轮被中断、无进展超时停下或被自动结束的，
   *   也在原对话接着做。Agent 收到的是按原因写的接续说明，不是原请求。其余当普通消息。
   * - 重来：停在结果未知、等人选的那一轮同卡上「重新执行」（只限发起人本人）；上一轮失败、中断或取消同 /retry。其余当普通消息。
   */
  private async routeControlPhrase(kind: 'continue' | 'stop' | 'restart', event: LarkMessageEvent, config: StoredLarkConfig, prompt: string,
    group: LarkGroup, scopeId: string, acknowledgementReactionId?: string): Promise<'handled' | LarkCommandPrompt | undefined> {
    const boundSessionId = group.sessionId && !group.retiredSessionIds?.has(group.sessionId) ? group.sessionId : undefined;
    const sessionId = boundSessionId ?? (await this.findScopeSession(config, event, scopeId, group).catch(() => undefined))?.id;
    if (!sessionId || !this.runtime.getTasks) return undefined;
    if (kind === 'stop') return await this.routeChatCommand(event, config, '/cancel', group, scopeId, acknowledgementReactionId) === 'handled' ? 'handled' : undefined;
    const confirm = (text: string) => this.service.replyText({ messageId: event.messageId, ...(event.threadId?.trim() ? { replyInThread: true } : {}),
      text, idempotencyKey: `control_${event.messageId}`.slice(0, 50) }).catch(error => this.log.warn({ error, messageId: event.messageId }, '控制语回执发送失败'));
    const tasks = await this.runtime.getTasks(sessionId);
    const unresolved = this.runtime.inspectExecutionRecovery ? await this.unresolvedTurns(sessionId) : [];
    const last = tasks.at(-1);
    try {
      if (kind === 'continue') {
        if (unresolved.length) {
          if (!await this.isOperatorAllowed(config, event.senderOpenId, event.chatId, sessionId)) return undefined;
          let cause = {};
          for (const task of unresolved) cause = await this.closeUnresolvedTurn(config, sessionId, task.id);
          await confirm('好，上一轮按没做完处理，接着在原对话里做。');
          return { prompt, materialPrompt: larkContinuePrompt(cause) };
        }
        if (!last || !['failed', 'interrupted'].includes(last.status)) return undefined;
        const cause = await this.runtimeTaskContinueCause(config.appId, last);
        if (last.status === 'failed' && !cause) return undefined;
        await confirm('好，接着上一轮做。');
        return { prompt, materialPrompt: larkContinuePrompt(cause ?? {}) };
      }
      if (unresolved.length) {
        const { mapping, saved } = await this.cardTaskFor(config.appId, sessionId, unresolved.at(-1)!.id);
        if (!mapping || !saved?.card_message_id || saved.sender_open_id !== event.senderOpenId) return undefined;
        const result = await this.interruptedTurnAction('replay_turn', mapping.externalId, saved.turn ?? 0, event.senderOpenId, { messageId: saved.card_message_id, chatId: saved.chat_id });
        if (result.type !== 'success') return undefined;
        await confirm('好，重新执行上一条请求。');
        if (acknowledgementReactionId) await this.service.deleteReaction(event.messageId, acknowledgementReactionId).catch(() => undefined);
        return 'handled';
      }
      if (!last || !['failed', 'interrupted', 'cancelled'].includes(last.status)) return undefined;
      const retry = await this.routeChatCommand(event, config, '/retry', group, scopeId, acknowledgementReactionId);
      if (retry === 'handled' || retry === undefined) return retry;
      await confirm('好，重新执行上一条请求。');
      return typeof retry === 'string' ? { prompt: retry } : retry;
    } catch (error) {
      // 那一轮还没停稳等原因收不了口：当普通消息排队，排队卡上会写清楚并给按钮。
      this.log.warn({ error, sessionId, kind }, '控制语未能按控制处理，按普通消息处理');
      return undefined;
    }
  }

  /**
   * 命令层白名单门：群聊按群策略的 task.view_result，策略缺席时与私聊一样按机器人白名单。
   * 聊天命令与结果卡上的删记忆按钮共用这一个判断，两处对同一个人不会给出不同答案。
   */
  private async commandAllowlisted(config: StoredLarkConfig, chatType: string, chatId: string, operatorOpenId: string | undefined, sessionId?: string) {
    const access = chatType === 'group' ? await this.groupManager?.authorize(config.appId, chatId, operatorOpenId, 'task.view_result') : undefined;
    return access?.allowed ?? await this.isOperatorAllowed(config, operatorOpenId, chatId, sessionId);
  }

  /**
   * 执行已授权的命令意图。全部复用既有机制：
   * /status 读持久化会话与排队任务；/cancel 与 /retry 直接走 handleAction 的同源分支；
   * /new 结束当前上下文，让下一条消息重新建会话。
   *
   * 返回 `'handled'` 表示命令已自行回执；返回字符串表示命令之后还带着一条任务内容
   * （`/new 跑一遍回归`），调用方要用它继续走完整的建任务链路——授权、风险检查、
   * 附件处理、幂等、卡片与队列一个都不能少，绝不在命令分支里直接发 prompt。
   */
  private async executeChatCommandIntent(
    route: Extract<LarkCommandRoute, { kind: 'intent' }>,
    event: LarkMessageEvent,
    config: StoredLarkConfig,
    group: LarkGroup,
    scopeId: string,
    replyCard: (taskName: string, markdown: string, options?: { elements?: LarkCardElement[]; failed?: boolean }) => Promise<{ messageId: string } | undefined>,
    acknowledgementReactionId?: string
  ): Promise<'handled' | string | LarkCommandPrompt> {
    // 最近一轮任务：/cancel 与 /retry 需要它，按插入顺序取该 group 的最后一个任务。
    const latestTask = [...this.tasks.values()].reverse().find(task => task.group === group);

    try {
      // 命令与普通消息共用同一条会话定位：内存绑定优先（同一进程内最新），
      // 缺失时回落到持久化查询，这样 coordinator 重建后命令仍能找到本上下文的会话。
      // 查询失败必须让命令整体失败：把它当成「没有会话」会让 /status 谎称尚未创建、
      // 让 /new 在没停掉任何东西的情况下回一句「已受理」，甚至直接派发新任务。
      const boundSessionId = group.sessionId && !group.retiredSessionIds?.has(group.sessionId) ? group.sessionId : undefined;
      const sessionId = boundSessionId ?? (await this.findScopeSession(config, event, scopeId, group))?.id;
      if (config.managedGroup && route.command === 'new' && !await this.isOperatorAllowed(config, event.senderOpenId, event.chatId, sessionId)) {
        await replyCard(`/${route.command} 未执行`, '当前账号没有操作此任务的权限。', { failed: true });
        return 'handled';
      }

      if (route.command === 'repair') {
        // 安装级发布动作：发卡前就按 high_risk/静态白名单口径拦一道，无权成员看不到确认卡。
        const repairAuth = await this.isRepairOperatorAllowed(config, event.senderOpenId, event.chatId);
        if (!repairAuth.allowed) {
          const reason = repairAuth.reason === 'unconfigured'
            ? '未配置操作白名单时，飞书里不能执行 /repair，请在 Web 上操作。'
            : '当前账号无权执行应用修复：需要安装管理员权限。';
          await replyCard('/repair 未执行', reason, { failed: true });
          return 'handled';
        }
        // 只发二次确认卡；真正的发布动作只能由确认卡回调触发（handleAction 的 dutydeck_repair 分支）。
        const card = buildRepairConfirmCard(config.appId);
        await replyCard(card.title, card.markdown, { elements: card.elements });
        return 'handled';
      }

      if (route.command === 'work') {
        const workbench = this.workflowOptions.workbench;
        if (!workbench) throw new Error('当前服务尚未接入目标工作台。');
        if (!sessionId && !route.args.length) {
          await replyCard('Dutydeck 工作台', '在此话题描述目标，或发送 `/work research 研究目标`，Dutydeck 会分配两个独立分析步骤并汇总成果。已有目标可用 `/work` 查看，常用流程可用 `/work templates` 查看。');
          return 'handled';
        }
        const parentSessionId = sessionId ?? (await this.sessionFor(group, config, event.chatId, event.chatType, scopeId)).id;
        await workbench.command(parentSessionId, route.argsText, event, config);
        if (acknowledgementReactionId) await this.service.deleteReaction(event.messageId, acknowledgementReactionId).catch(() => undefined);
        return 'handled';
      }
      if (route.command === 'schedule') {
        const automation = this.workflowOptions.automation;
        if (!automation) throw new Error('当前服务未接入定时任务。');
        if (!event.senderOpenId || !await this.isOperatorAllowed(config, event.senderOpenId, event.chatId, sessionId)) throw new Error('当前账号没有操作此任务的权限。');
        if (!sessionId && !route.args.length) {
          await replyCard('定时任务', '此话题暂无计划。发送 `/schedule every 分钟 指令` 创建停用的计划，再按回执核对并启用。');
          return 'handled';
        }
        const parentSessionId = sessionId ?? (await this.sessionFor(group, config, event.chatId, event.chatType, scopeId)).id;
        await replyCard('定时任务', await executeScheduleCommand(automation, this.workflowOptions.store, parentSessionId, route.argsText, event, config));
        return 'handled';
      }
      if (route.command === 'ci') {
        const automation = this.workflowOptions.automation;
        if (!automation || !sessionId) throw new Error('当前话题还没有可用的工作项，请先发送任务。');
        if (!event.senderOpenId || !await this.isOperatorAllowed(config, event.senderOpenId, event.chatId, sessionId)) throw new Error('当前账号没有操作此任务的权限。');
        const [action, argument, ...extra] = route.args;
        const codebase = automation.codebase;
        // origin 是 Codebase 仓库时走 webhook 订阅；否则回落到原有的 GitHub Actions 轮询。
        const codebaseItem = (action === 'wait' || action === 'fix') && !argument && codebase
          ? await codebase.subscribe(sessionId, { autoFix: action === 'fix' }, event.senderOpenId) : undefined;
        if (codebaseItem) {
          await replyCard('等待 Codebase 流水线', `已等待 ${codebaseItem.repository} 的 ${codebaseItem.branch} 在提交 ${codebaseItem.headSha.slice(0, 12)} 上的流水线结果。\n\n`
            + `${codebaseItem.autoFix ? '失败时自动交给 Agent 修复' : '失败时发送失败卡，可点「交给 Agent 修」'}：最多 3 轮；同一错误出现 2 次、每轮改动超过 10 个文件或 300 行、head SHA 变化时停下。\n\n`
            + `截止：${codebaseItem.expiresAt}\n取消：/ci cancel ${codebaseItem.id}`);
        } else if (action === 'fix') {
          throw new Error(codebase ? '/ci fix 只支持 Codebase 仓库：当前工作区的 origin 不是 code.byted.org。' : '/ci fix 需要先配置 Codebase webhook（DUTYDECK_CODEBASE_WEBHOOK_SECRET）。');
        } else if (action === 'wait' && !extra.length) {
          const item = await automation.subscribeCi(sessionId, argument ? { workflow: argument } : {}, event.senderOpenId);
          await replyCard('等待 GitHub Actions', `已等待 ${item.repository.slug} 的提交 ${item.headSha.slice(0, 12)}。\n\n截止：${item.expiresAt}\n取消：/ci cancel ${item.id}`);
        } else if (action === 'cancel' && argument && !extra.length) {
          if (codebase && argument.startsWith('cbci_')) await codebase.cancel(sessionId, argument);
          else {
            const items = await automation.listBySession(sessionId, event.senderOpenId);
            const item = items.subscriptions.find(value => value.id === argument);
            if (!item) throw new Error('此工作项中找不到该等待记录。');
            await automation.cancelCi(sessionId, item.id, { expectedRevision: item.revision }, event.senderOpenId);
          }
          await replyCard('已取消 CI 等待', '尚未开始的自动续作不会再执行。已经运行的任务可通过 /cancel 中断。');
        } else if (!action) {
          const items = await automation.listBySession(sessionId, event.senderOpenId);
          const labels: Record<string, string> = { waiting: '等待中', dispatching: '提交中', accepted: '续作已接收', completed: '续作已结束', cancelled: '已取消', expired: '已过期', stale_head: '提交已变化', session_inactive: '会话已结束', revoked: '权限已撤销', error: '查询失败' };
          const codebaseLabels: Record<string, string> = { waiting: '等待中', failed: '失败待修复', running: '处理中', passed: '已通过', stopped: '已停止', closed: 'MR 已结束', cancelled: '已取消', expired: '已过期' };
          const codebaseLines = (await codebase?.listBySession(sessionId) ?? []).slice(-10)
            .map(item => `${codebaseLabels[item.status] ?? item.status} · ${item.repository} · ${item.branch} · ${item.headSha.slice(0, 12)} · 已修复 ${item.rounds}/3 轮\n${item.reason ?? ''}\n/ci cancel ${item.id}`);
          await replyCard('CI 等待记录', [...items.subscriptions.slice(0, 10).map(item => `${labels[item.status] ?? item.status} · ${item.repository.slug} · ${item.headSha.slice(0, 12)}\n${item.error ?? ''}\n/ci cancel ${item.id}`), ...codebaseLines].join('\n\n') || '尚无等待记录。发送 /ci wait [工作流文件名或 ID] 等待当前提交。');
        } else throw new Error('用法：/ci、/ci wait [工作流文件名或 ID]、/ci fix、/ci cancel 等待编号');
        return 'handled';
      }
      if (route.command === 'status') {
        const participation = event.chatType === 'group'
          ? await this.workflowOptions.participation?.describe({ appId: config.appId, chatId: event.chatId }).catch(() => undefined) : undefined;
        const usage = await this.workflowOptions.usage?.describe(config.appId, event.chatType === 'group' ? event.chatId : undefined).catch(() => undefined);
        // 当前一轮停在审批上、后面还有指令排队时给一个拒绝入口：按钮与 /tasks 行内审批同形，
        // 登记成任务导航卡后由 respond 照常做鉴权和一次性决议。
        const approval = sessionId ? (await this.approvalBlock(config.appId, sessionId))?.record : undefined;
        const memoryApi = this.workflowOptions.memory;
        const memoryLine = memoryApi && larkMemoryEnabled(config)
          ? await (memoryApi.pipeline ?? memoryApi.store).status(larkMemoryScope(config.appId, event.chatId, event.chatType)).then(renderLarkMemoryStatusLine).catch(() => undefined) : undefined;
        const status = [await this.describeChatStatus(config, sessionId, latestTask), participation, usage, memoryLine].filter(Boolean).join('\n\n');
        // 卡片带了 elements 就不再渲染 markdown 正文，正文要作为第一个元素放在按钮前面。
        const card = await replyCard('任务状态', status,
          approval ? { elements: [{ tag: 'markdown', element_id: 'status_body', content: status, text_align: 'left', text_size: 'normal_v2', margin: '0px' },
            { tag: 'button', element_id: 'status_reject_approval', type: 'danger', text: { tag: 'plain_text', content: '拒绝这条审批' },
              behaviors: [{ type: 'callback', value: { dutydeck_workflow: 'reject', request_id: approval.id, generation: approval.boot } }] }] } : {});
        if (card && approval) {
          await this.workflowOptions.store?.set(`lark.task_dashboard.${config.appId}.${card.messageId}`, JSON.stringify({
            messageId: event.messageId, chatId: event.chatId, chatType: event.chatType,
            senderOpenId: event.senderOpenId, messageType: 'text', content: '', mentions: []
          } satisfies LarkMessageEvent));
        }
        return 'handled';
      }
      if (route.command === 'agents') {
        const agents = await this.runtime.listAgents!();
        if (!agents.length) {
          await replyCard('本机可用 Agent', '**这台机器还没有配置任何 Agent。**\n\n请先在 Dutydeck Web 添加 Agent。');
          return 'handled';
        }
        const lines = agents.map(agent => {
          // 版本只来自 Agent 配置里探测到的值；探测不到就说探测不到，不拿命令名冒充版本。
          const version = agent.version?.trim() ? `版本 ${larkCommandEcho(agent.version, 40)}` : '版本未探测到';
          const current = agent.id === config.defaultAgentId ? ' · **本机器人当前默认**' : '';
          return `**${larkCommandEcho(agent.name, 64)}**（\`${larkCommandEcho(agent.id, 64)}\`）\n${version}${current}`;
        });
        await replyCard('本机可用 Agent', lines.join('\n\n'));
        return 'handled';
      }
      if (route.command === 'queue') {
        if (!sessionId) throw new Error('当前话题还没有会话，也就没有待执行的指令。');
        // 编号口径与心跳里的排队摘要同源（runtime.getTasks 里 status=queued 的那些，按收到顺序）。
        const queued = (await this.runtime.getTasks!(sessionId)).filter(task => task.status === 'queued');
        const [action, argument, ...extra] = route.args;
        if (!action) {
          const summary = renderQueueSummary(queued, { blockedByApproval: queued.length > 0 && (await this.runtime.getPendingPermissions?.(sessionId) ?? []).length > 0 });
          // 摘要为卡片预算只列前几条，编号却一直有效：不写这句，第 6 条以后就成了看不见也够不着的死区。
          const hidden = queued.length > QUEUE_SUMMARY_MAX_ITEMS ? `上面只列出前 ${QUEUE_SUMMARY_MAX_ITEMS} 条，编号 ${QUEUE_SUMMARY_MAX_ITEMS + 1}-${queued.length} 同样可用。` : '';
          await replyCard('待执行指令', summary
            ? `${summary}\n\n编号按收到顺序，共 ${queued.length} 条。${hidden}取消：\`/queue cancel <编号>\`；提到队首：\`/queue top <编号>\`${this.runtime.injectQueued ? '；立即插话：`/queue steer <编号>`' : ''}。`
            : '**当前没有待执行的指令。**');
          return 'handled';
        }
        if (action !== 'cancel' && action !== 'top' && action !== 'steer' || !argument || extra.length) {
          throw new Error('用法：`/queue`、`/queue cancel <编号>`、`/queue top <编号>`、`/queue steer <编号>`');
        }
        const index = Number(argument);
        if (!Number.isInteger(index) || index < 1 || index > queued.length) {
          await replyCard('/queue 未执行', `**编号超出范围：当前有 ${queued.length} 条待执行指令。**\n\n发送 \`/queue\` 查看最新编号。`, { failed: true });
          return 'handled';
        }
        const target = queued[index - 1]!;
        const policy: PolicyAction = action === 'cancel' ? 'queue.cancel' : 'queue.promote';
        if (!await this.isTaskOperatorAllowed(config, event, { id: target.id, sessionId }, policy)) {
          await replyCard('/queue 未执行', '当前账号没有操作这条排队指令的权限。', { failed: true });
          return 'handled';
        }
        if (action === 'cancel') {
          if (!this.runtime.cancelQueued) throw new Error('当前 Dutydeck 运行时无法取消排队任务，请前往 Dutydeck Web 处理。');
          await this.runtime.cancelQueued(sessionId, target.id, event.senderOpenId);
          await replyCard('已取消排队指令', `**第 ${index} 条待执行指令不会再执行。**\n\n${escapeLarkPromptEcho(larkCommandEcho(target.prompt, 120))}`);
        } else if (action === 'steer') {
          if (!this.runtime.injectQueued) throw new Error('当前 Dutydeck 运行时不支持插话，可用 `/queue top <编号>` 提到队首。');
          // 插话会改变正在执行的那一轮，与提到队首同一道中断门。
          const denial = await this.currentTurnInterruptDenial(config, event, sessionId);
          if (denial) {
            await replyCard('/queue 未执行', `**插话会改变当前正在执行的那一轮，而那一轮不是你的任务。**\n\n${denial}这条指令仍在排队。`, { failed: true });
            return 'handled';
          }
          const steering = await this.runtime.injectQueued(sessionId, target.id, event.senderOpenId);
          const echo = escapeLarkPromptEcho(larkCommandEcho(target.prompt, 120));
          if (steering.task.status === 'reconcile_required') await replyCard('/queue 插话结果未知', `**这条指令可能已送达，请联系 Dutydeck 管理员核对后处理。当前不会自动重发。**\n\n${echo}`, { failed: true });
          else if (steering.outcome === 'injected' || steering.outcome === 'startedNewTurn') await replyCard('已插话', `**${steeringOutcomeText(steering.outcome)}**\n\n${echo}`);
          else if (steering.task.status !== 'queued') await replyCard('/queue 状态已变化', `**这条指令已不在队列中，请通过 \`/status\` 核对最新执行记录。**\n\n${echo}`, { failed: true });
          else await replyCard('/queue 未插话', `**${steeringOutcomeText(steering.outcome)}第 ${index} 条指令仍在排队，顺序没有改动。**\n\n要尽快执行可用 \`/queue top ${index}\` 提到队首。\n\n${echo}`, { failed: true });
        } else {
          if (!this.runtime.steerQueued) throw new Error('当前 Dutydeck 运行时无法调整队列顺序，请前往 Dutydeck Web 处理。');
          const denial = await this.currentTurnInterruptDenial(config, event, sessionId);
          if (denial) {
            await replyCard('/queue 未执行', `**提到队首会中断当前正在执行的那一轮，而那一轮不是你的任务。**\n\n${denial}队列顺序没有改动。`, { failed: true });
            return 'handled';
          }
          await this.runtime.steerQueued(sessionId, target.id, event.senderOpenId);
          for (const task of this.tasks.values()) if (task.runtimeTaskId === target.id) task.promoted = true;
          await replyCard('已提到队首', `**第 ${index} 条待执行指令已排到队首，当前这一轮会被中断。**\n\n${escapeLarkPromptEcho(larkCommandEcho(target.prompt, 120))}`);
        }
        return 'handled';
      }
      if (route.command === 'steer') {
        if (!route.argsText) {
          await replyCard('/steer 未执行', '**用法：`/steer <内容>`**\n\n例如：`/steer 先跑一遍测试再改`。', { failed: true });
          return 'handled';
        }
        // 提到队首会中断当前这一轮，因此必须先过与 /cancel 同一道中断门；
        // 否则只有 own_runs 权限的成员能用一条 /steer 打断别人的任务，而 /cancel 会拒绝他。
        const denial = sessionId ? await this.currentTurnInterruptDenial(config, event, sessionId) : undefined;
        if (denial) {
          await replyCard('/steer 未执行', `**当前正在执行的是他人的任务，你没有中断它的权限。**\n\n${denial}直接把这条内容作为普通消息发出来，它会排到队尾执行。`, { failed: true });
          return 'handled';
        }
        // 内容仍走完整建任务链路（授权、风险检查、附件、卡片一个都不能少）；
        // 派发拿到 runtime task id 之后先试插话，不支持再降级为队首提升，结果如实写在这张卡上。
        return { prompt: route.argsText, steer: true };
      }
      if (route.command === 'grant' || route.command === 'revoke') {
        return await this.executeGrantCommand(route.command, event, config, route.argsText, replyCard);
      }
      // 记忆命令的授权就是命令层的白名单门（发言人能在本聊天用命令，就能维护本聊天可见的记忆），
      // 作用域由当前聊天决定：群聊是本机器人的群共享池，私聊是自己的池；不接受参数指定别的聊天。
      if (route.command === 'remember' || route.command === 'memory' || route.command === 'forget') {
        if (!larkMemoryEnabled(config)) {
          await replyCard(`/${route.command} 未执行`, '本机器人已关闭会话记忆。', { failed: true });
          return 'handled';
        }
        const memory = this.memory!;
        const scope = larkMemoryScope(config.appId, event.chatId, event.chatType);
        const shared = isLarkGroupMemoryPool(scope);
        if (route.command === 'memory') {
          if (route.args[0] === 'consolidate') {
            // /memory 整体是只读命令，但 consolidate 会改写账本：这里单独挡住机器人发送者，
            // 与 /remember、/forget 的 mutating 口径一致。
            if (event.senderType === 'app' || event.senderType === 'bot') {
              await replyCard('/memory consolidate 未执行', '机器人发送者不能整理本聊天的记忆。', { failed: true });
              return 'handled';
            }
            const pipeline = this.workflowOptions.memory?.pipeline;
            if (!pipeline) {
              await replyCard('/memory consolidate 未执行', '整理功能未启用。', { failed: true });
              return 'handled';
            }
            const outcome = await pipeline.requestConsolidation(scope, { ...(event.senderOpenId ? { actorId: event.senderOpenId } : {}) });
            if (outcome === 'started') await replyCard('会话记忆整理', '**已开始整理，完成后 `/memory` 可见。**');
            else if (outcome === 'running') await replyCard('/memory consolidate 未执行', '**整理正在进行中。**', { failed: true });
            else await replyCard('/memory consolidate 未执行', '本机器人已关闭会话记忆。', { failed: true });
            return 'handled';
          }
          if (route.args[0] === 'ignore') {
            // 「不许记」规则跟记忆池走：群聊里对本机器人所在各群都生效。增删改写的是约束，与 consolidate 一样挡住机器人发送者。
            const [, action, id, ...extra] = route.args;
            const where = shared ? '本机器人所在各群共享' : '本聊天';
            if (!action || (action === 'list' && !id)) {
              const rules = await memory.listIgnoreRules(scope);
              await replyCard('不许记规则', rules.length
                ? `**${where}的「不许记」规则（${rules.length} 条）**\n\n${rules.map(rule => `- \`${rule.id}\` · ${larkCommandEcho(rule.text, 200)}`).join('\n')}\n\n新增：\`/memory ignore <一句话描述>\`；删除：\`/memory ignore remove <编号>\``
                : '**还没有「不许记」规则。**\n\n发送 `/memory ignore <一句话描述>` 添加，例如 `/memory ignore 不要记任何人的薪资`。后台提取会把规则当作约束，写入前再按规则过滤一次。');
              return 'handled';
            }
            if (event.senderType === 'app' || event.senderType === 'bot') {
              await replyCard('/memory ignore 未执行', '机器人发送者不能修改「不许记」规则。', { failed: true });
              return 'handled';
            }
            if (action === 'remove') {
              if (!isLarkMemoryIgnoreRuleId(id) || extra.length) {
                await replyCard('/memory ignore 未执行', '**用法：`/memory ignore remove <规则编号>`**\n\n编号形如 `ign_1a2b3c4d`，发送 `/memory ignore list` 查看。', { failed: true });
                return 'handled';
              }
              const removed = await memory.removeIgnoreRule(scope, id);
              if (!removed) {
                await replyCard('/memory ignore 未执行', `**${where}没有编号为 \`${id}\` 的「不许记」规则。**\n\n发送 \`/memory ignore list\` 查看。`, { failed: true });
                return 'handled';
              }
              await replyCard('已删除不许记规则', `**已删除规则 \`${removed.id}\`。**\n\n${larkCommandEcho(removed.text, 200)}\n\n之后的后台提取不再受这条规则约束。`);
              return 'handled';
            }
            const rule = await memory.addIgnoreRule(scope, { text: route.argsText.replace(/^ignore\s*/i, ''), chatId: event.chatId,
              ...(event.senderOpenId ? { createdBy: event.senderOpenId } : {}) });
            await replyCard('已添加不许记规则', `**已添加规则 \`${rule.id}\`${shared ? '（对本机器人所在各群都生效）' : ''}。**\n\n${larkCommandEcho(rule.text, 200)}\n\n之后的后台提取不会记下与它相关的内容；已有的记忆不受影响，可用 \`/forget <编号>\` 删除。查看：\`/memory ignore list\`；删除：\`/memory ignore remove ${rule.id}\`。`);
            return 'handled';
          }
          let page: number | undefined;
          if (route.args.length > 0) {
            page = Number(route.args[0]);
            if (!Number.isInteger(page) || page < 1) {
              await replyCard('/memory 未执行', '**用法：`/memory [页码]`、`/memory consolidate` 或 `/memory ignore <描述>`**', { failed: true });
              return 'handled';
            }
          }
          const pipeline = this.workflowOptions.memory?.pipeline;
          const [byTopic, state, status] = await Promise.all([
            memory.byTopic(scope),
            memory.getState(scope),
            pipeline ? pipeline.status(scope) : memory.status(scope)
          ]);
          const result = renderLarkMemoryList(byTopic, state, { page, shared, currentChatId: event.chatId, status });
          if (page !== undefined && page > result.totalPages) {
            await replyCard('/memory 未执行', `**页码超出范围，共 ${result.totalPages} 页。**\n\n发送 \`/memory 1\` 查看第一页。`, { failed: true });
            return 'handled';
          }
          await replyCard('会话记忆', result.text);
          return 'handled';
        }
        if (route.command === 'remember') {
          if (!route.argsText) {
            await replyCard('/remember 未执行', '**用法：`/remember <要记住的内容>`**\n\n例如：`/remember 这个群的回复统一用中文`。', { failed: true });
            return 'handled';
          }
          const entry = await memory.add(scope, { content: route.argsText, source: 'user', topic: 'general', chatId: event.chatId,
            ...(event.senderOpenId ? { createdBy: event.senderOpenId } : {}), messageId: event.messageId });
          await replyCard('已记住', shared
            ? `**已保存为群共享记忆 \`${entry.id}\`。**\n\n${larkCommandEcho(entry.content, 200)}\n\n之后本机器人所在各群的每轮任务都会带给 Agent（在其他群里作为背景）。查看：\`/memory\`；删除：\`/forget ${entry.id}\`。`
            : `**已保存为本聊天记忆 \`${entry.id}\`。**\n\n${larkCommandEcho(entry.content, 200)}\n\n之后本聊天的每轮任务都会带给 Agent。查看：\`/memory\`；删除：\`/forget ${entry.id}\`。`);
          return 'handled';
        }
        const [id, ...extra] = route.args;
        if (!isLarkMemoryId(id) || extra.length) {
          await replyCard('/forget 未执行', '**用法：`/forget <记忆编号>`**\n\n编号形如 `mem_1a2b3c4d`，发送 `/memory` 查看。', { failed: true });
          return 'handled';
        }
        const removed = await memory.remove(scope, id, event.senderOpenId);
        if (!removed) {
          await replyCard('/forget 未执行', `**${shared ? '群共享记忆' : '本聊天'}没有编号为 \`${id}\` 的记忆。**\n\n发送 \`/memory\` 查看当前记忆。`, { failed: true });
          return 'handled';
        }
        await replyCard('已忘记', `**已删除记忆 \`${removed.id}\`。**\n\n${larkCommandEcho(removed.content, 200)}\n\n之后的任务不再带上这条记忆。`);
        return 'handled';
      }
      if (route.command === 'cancel') {
        // /cancel（/stop）动两样：正在执行的那一轮（中断口径：发起人和管理员），以及发送人自己在本会话的排队项。
        // 别人的排队指令不动；判据来自 runtime 的真实任务状态，重建之后内存是空的也一样。
        const runtimeTasks = sessionId && this.runtime.getTasks ? await this.runtime.getTasks(sessionId) : undefined;
        const running = runtimeTasks?.find(task => task.status === 'running');
        // 内存里的这一轮持有 requestUpdate，能把进度卡就地收敛成取消收据；runtime 没有任务记录时只能靠它。
        const liveTurn = [...this.tasks.values()].reverse().find(task => task.group === group && task.state === 'running'
          && (runtimeTasks ? Boolean(running) && (!task.runtimeTaskId || task.runtimeTaskId === running!.id) : true));
        // 私聊里只有这一个人能发消息：找不到记录的任务也是他发起的。
        const requesterOf = async (id: string) => (await this.larkTaskOrigin(config, event.chatId, { id, sessionId: sessionId! }))?.requester
          ?? (event.chatType === 'p2p' ? event.senderOpenId : undefined);
        const ownQueued = runtimeTasks
          ? (await Promise.all(runtimeTasks.filter(task => task.status === 'queued').map(async task => ({ task, requester: await requesterOf(task.id) }))))
            .filter(item => item.requester && item.requester === event.senderOpenId).map(item => ({ id: item.task.id, sessionId: item.task.sessionId }))
          : [...this.tasks.values()].filter(task => task.group === group && task.state === 'queued' && task.sessionId && task.runtimeTaskId && task.event.senderOpenId === event.senderOpenId)
            .map(task => ({ id: task.runtimeTaskId!, sessionId: task.sessionId! }));
        // 先取消排队、再中断：先中断的话，下一条排队可能立刻开跑，就取消不掉了。
        // 内存里的排队卡就地改成已取消，不再另发一张「已取消」结果卡：这张回执已经说了。
        let cancelled = 0;
        for (const item of this.runtime.cancelQueued ? ownQueued : []) {
          const live = [...this.tasks.values()].find(task => task.runtimeTaskId === item.id && task.state === 'queued');
          if (live ? await this.absorbQueuedTask(live, '**已取消**\n\n这条请求不会再执行。', '已取消', event.senderOpenId)
            : await this.runtime.cancelQueued!(item.sessionId, item.id, event.senderOpenId).then(() => true, error => {
              this.log.warn({ error, runtimeTaskId: item.id }, '/cancel 取消排队任务失败'); return false;
            })) cancelled++;
        }
        const cancelledText = `已取消你的 ${cancelled} 条排队`;
        if (!running && !liveTurn) {
          if (cancelled) await replyCard('/cancel 已受理', `**${cancelledText}。**\n\n这些请求不会再执行。`);
          else if (ownQueued.length) await replyCard('/cancel 未执行', '**你的排队请求没能取消，可能已经开始执行。**\n\n发送 `/status` 查看最新状态。', { failed: true });
          else await replyCard('/cancel 未执行', '**当前没有正在执行的一轮，也没有你排队的请求。**\n\n发送新的请求即可开始一轮执行。', { failed: true });
          return 'handled';
        }
        const runningOrigin = running && !liveTurn ? await this.larkTaskOrigin(config, event.chatId, { id: running.id, sessionId: sessionId! }) : undefined;
        const title = escapeLarkPromptEcho(larkCommandEcho(liveTurn ? larkTaskTitle(liveTurn.prompt, config.name) : runningOrigin?.title ?? larkTaskTitle(running!.prompt, config.name), 40));
        const requester = liveTurn?.event.senderOpenId ?? (running ? await requesterOf(running.id) : undefined);
        if (!await this.isInterruptOperatorAllowed(config, event.senderOpenId, event.chatId, sessionId ?? liveTurn?.sessionId, requester)) {
          const denial = this.requesterOnlyReason(config, requester, '中断正在执行的这一轮', true);
          if (cancelled) await replyCard('/cancel 已受理', `**${cancelledText}。**\n\n没有中断『${title}』：${denial}`);
          else await replyCard('/cancel 未执行', `**没有中断『${title}』。**\n\n${denial}`, { failed: true });
          return 'handled';
        }
        // 停止原语必须真的被调用；调不动就说调不动，不发一句空口「已受理」。
        const result = liveTurn
          ? await this.handleAction({ action: 'interrupt', task_id: liveTurn.id, turn: String(liveTurn.turn) }, event.senderOpenId)
          : await this.runtime.interrupt(sessionId!, running!.id, event.senderOpenId).then(() => ({ type: 'success', content: '' }));
        if (result?.type === 'success') {
          await replyCard('/cancel 已受理', `**已请求中断『${title}』${cancelled ? `，并${cancelledText.slice(1)}` : ''}。**\n\n任务停止后会更新原任务卡。`);
        } else if (cancelled) {
          await replyCard('/cancel 已受理', `**${cancelledText}。**\n\n中断『${title}』没有执行：${result?.content ?? '停止请求未完成'}`);
        } else {
          await replyCard('/cancel 未执行', `**${result?.content ?? '停止请求未完成'}**`, { failed: true });
        }
        return 'handled';
      }
      if (route.command === 'retry') {
        // /retry 一律是一个新任务，绝不复用旧 task 的 event/config——旧 handleAction 会
        // 沿用原发起人的身份与当时的配置，让「Alice 有高危授权、Bob 点重试」变成
        // Bob 借 Alice 的权限执行。恢复出原 prompt 后交给正常建任务链路，由当前
        // event.senderOpenId 与当前 config 重新过授权与风险检查。
        const runtimeTasks = sessionId && this.runtime.getTasks ? await this.runtime.getTasks(sessionId) : undefined;
        const target = this.pickRetryableRuntimeTask(runtimeTasks);
        // runtime 有这个会话的任务记录时一律以它为准；只有完全没有记录（旧运行时没有
        // getTasks，或这一轮还没落库）才回落到内存里的这一轮，且同样只取 prompt。
        const memoryTask = !runtimeTasks?.length && latestTask && ['failed', 'interrupted', 'cancelled'].includes(latestTask.state)
          ? latestTask
          : undefined;
        if (!target && !memoryTask) {
          await replyCard('/retry 未执行', '**只有失败、已中断或已取消的任务可以重试。**\n\n当前没有可重试的任务，请直接发送新的请求。', { failed: true });
          return 'handled';
        }
        const retryAllowed = target ? await this.isTaskOperatorAllowed(config, event, target)
          : await this.isOperatorAllowed(config, event.senderOpenId, event.chatId, memoryTask?.sessionId, memoryTask?.event.senderOpenId);
        if (!retryAllowed) {
          await replyCard('/retry 未执行', '当前账号没有操作此任务的权限。', { failed: true });
          return 'handled';
        }
        // 原请求只认本 App channel 里、app_id/chat_id 与 runtime_task_id 都对得上的那条记录；
        // 恢复不出来就直说，绝不拿别处或相邻一轮的 prompt 凑一个「看起来能跑」的重试。
        const restored = target
          ? await this.restoreRetryPrompt(config, event, target)
          : memoryTask?.prompt?.trim() ? { prompt: memoryTask.prompt, materialPrompt: memoryTask.retryMaterialPrompt ?? memoryTask.prompt } : undefined;
        if (!restored) {
          await replyCard('/retry 未执行', '**找不到这一轮的原始请求内容，无法重试。**\n\n请重新发送你的请求。', { failed: true });
          return 'handled';
        }
        return restored;
      }
      if (route.command === 'new') {
        // /new 会停掉正在执行的那一轮：那一轮是别人的时，与进度卡「中断」同一口径拒绝。
        const denial = sessionId ? await this.currentTurnInterruptDenial(config, event, sessionId) : undefined;
        if (denial) {
          await replyCard('/new 未执行', `**/new 会中断正在执行的那一轮，而那一轮不是你的任务。**\n\n${denial}`, { failed: true });
          return 'handled';
        }
        // 任务内容随 /new 一起到达时，本条消息既要结束旧上下文、又要派发新任务。
        const request = parseLarkNewSession(route.argsText);
        const beforeValidation = group.epoch ?? 0;
        if (request.launchOptions) request.launchOptions = await this.validateNewSession(config, event, request.launchOptions);
        if (beforeValidation !== (group.epoch ?? 0)) throw new Error('已有更新的 /new 请求，请在新上下文中重新发送。');
        // 回执要写清 /new 停掉了什么：正在执行的那一轮、排队的条数、随旧会话停用的定时计划。先记下，停掉之后就读不到了。
        const before = sessionId && this.runtime.getTasks ? await this.runtime.getTasks(sessionId).catch(() => []) : [];
        const running = before.find(task => task.status === 'running');
        const runningOrigin = running ? await this.larkTaskOrigin(config, event.chatId, { id: running.id, sessionId: sessionId! }) : undefined;
        const queuedCount = before.filter(task => task.status === 'queued').length;
        const schedules = sessionId && this.workflowOptions.automation
          ? (await this.workflowOptions.automation.listBySession(sessionId, event.senderOpenId).catch(() => undefined))?.schedules.filter(item => item.enabled) ?? [] : [];
        // 交接要在结束旧会话之前读：结束之后它的任务和工作目录就不再归这个聊天。
        const handoff = request.handoff ? await this.newSessionHandoff(config, event, sessionId, before, request.handoff.note) : undefined;
        this.cancelUndeliveredRetries(group);
        const retirement = this.retireScopeSession(group, config, event, scopeId);
        const epoch = group.epoch;
        const { retired, retained } = await retirement;
        const goal = request.prompt;
        if (handoff) {
          // 交接前缀只进 Agent 的首轮 prompt，卡片标题仍是任务本身；没给任务时首轮只确认接手。
          return { prompt: goal || larkHandoffTitle, materialPrompt: `${handoff}\n\n${goal || larkHandoffAck}`,
            ...(request.launchOptions ? { launchOptions: request.launchOptions } : {}), epoch };
        }
        if (goal) {
          // reaction 仍挂在原消息上，交给随后的建任务链路按正常节奏撤销——
          // 这里不发命令回执，因为用户马上会收到这条新任务的进度卡。
          return { ...request, epoch };
        }
        const minutes = running ? Math.floor((Date.now() - (runningOrigin?.startedAt ?? Date.parse(running.createdAt))) / 60_000) : 0;
        const stopped = [
          running ? `已中断『${escapeLarkPromptEcho(larkCommandEcho(runningOrigin?.title ?? larkTaskTitle(running.prompt, config.name), 40))}』（${minutes >= 1 ? `已运行 ${minutes} 分钟` : '已运行不到 1 分钟'}）${queuedCount ? `，取消 ${queuedCount} 条排队` : ''}。`
            : queuedCount ? `已取消 ${queuedCount} 条排队。` : '',
          schedules.length ? `以下定时计划随旧会话停用：${schedules.map(item => escapeLarkPromptEcho(larkCommandEcho(item.name, 40))).join('、')}` : ''
        ].filter(Boolean).map(line => `${line}\n\n`).join('');
        await replyCard(
          '/new 已受理',
          retained
            ? `**下一条消息将开启全新上下文。**\n\n原会话的执行进程尚未确认停止，没有结束它，之后的消息也不再进入它。${larkRecoveryRetainedNote(config.webBaseUrl)}`
            : retired
            ? `**已结束当前会话，下一条消息将开启全新上下文。**\n\n${stopped}历史记录仍可在 Dutydeck Web 查看。`
            : '**当前没有已绑定的会话，下一条消息会直接开启新会话。**'
        );
        return 'handled';
      }
    } catch (error) {
      this.log.warn({ error, command: route.command, messageId: event.messageId }, '执行飞书聊天命令失败');
      await replyCard(`/${route.command} 执行失败`, `**命令未能完成。**\n\n${error instanceof Error ? error.message : String(error)}\n\n可稍后重试，或前往 Dutydeck Web 处理。`, { failed: true });
    }
    return 'handled';
  }

  /**
   * `/new --handoff` 的交接前缀：最近 3 轮已结束任务的标题与结果摘录（已交付的显式最终答复优先，否则与结果卡同一口径；已脱敏）、
   * 旧会话链接、工作目录 git 快照和备注。只读执行记录，不调用模型；读不到的部分缺省，不让 /new 失败。
   */
  private async newSessionHandoff(config: StoredLarkConfig, event: LarkMessageEvent, sessionId: string | undefined, tasks: TaskRecord[], note: string) {
    const recent = tasks.filter(task => terminalTaskStates.has(task.status))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt)).slice(-3);
    const window = sessionId && recent.length && (this.runtime.getRecentEvents || this.runtime.getEvents)
      ? await loadLarkTaskWindow(this.runtime, sessionId, recent[0]!.id, 500).catch(() => []) : [];
    const store = this.workflowOptions.store;
    const cards = store && sessionId && recent.length ? await this.cardMappings?.list(larkCardChannel(config.appId)).catch(() => undefined) : undefined;
    // 用 group send --final 交付过答复的轮次，结论在那条记录里，助手文本往往只剩一句确认。
    // 取法同 agent-tools 的 taskAnswer：本聊天里唯一对得上的卡片映射还原 scope，只认已交付的记录。
    const explicitFinal = async (task: TaskRecord) => {
      const matches = (cards ?? []).flatMap(row => {
        try {
          const saved = JSON.parse(row.extra ?? '{}') as PersistedLarkCardTask;
          return row.sessionId === sessionId && saved.runtime_task_id === task.id && saved.chat_id === event.chatId ? [{ row, saved }] : [];
        } catch { return []; }
      });
      const context = matches.length === 1 ? explicitFinalContext(matches[0]!.row, matches[0]!.saved, task.currentAttemptId) : undefined;
      const content = store && context ? (await readExplicitFinal(store, context).catch(() => undefined))?.trim() : undefined;
      return content ? redactTraceText(content) : undefined;
    };
    const turns = await Promise.all(recent.map(async task => {
      const title = (await this.larkTaskOrigin(config, event.chatId, { id: task.id, sessionId: sessionId! }).catch(() => undefined))?.title
        ?? larkTaskTitle(task.prompt, config.name);
      // 窗口里没有这一轮的起点时 eventsForRuntimeTask 会退回整段窗口，那不是这一轮的结果。
      const started = window.some(item => item.type === 'text' && (item.data as any)?.role === 'user' && (item.data as any)?.taskId === task.id);
      const elements = started ? renderLarkResultElements(eventsForRuntimeTask(window, task.id)) : [];
      const result = await explicitFinal(task)
        ?? elements.find(element => element.element_id === 'final_output')?.content
        ?? elements.find(element => String(element.element_id ?? '').startsWith('execution_alert_'))?.content;
      return { title, status: task.status, ...(typeof result === 'string' ? { result } : {}) };
    }));
    const cwd = (sessionId ? (await this.runtime.getSession(sessionId).catch(() => undefined))?.cwd : undefined) ?? config.workspace;
    return formatLarkHandoff({
      ...(sessionId ? { sessionId, ...(config.webBaseUrl ? { sessionUrl: `${config.webBaseUrl}/sessions/${encodeURIComponent(sessionId)}` } : {}) } : {}),
      turns, note, ...(cwd ? { cwd, git: await readGitSnapshot(cwd) } : {})
    });
  }

  /**
   * 在聊天里改本群的对话授权。唯一写入路径仍是 LarkGroupManager.save（与 Web 的 PUT 同一条），
   * 本方法只负责：定位当前授权 → 过授权门 → 把 @ 到的人解析成 principal → 算出新的 accessOverride。
   *
   * 三条硬规则：
   * 1. 群没有同步/绑定就直说没有可改的授权，绝不替用户新建一份群配置；
   * 2. 带参数（含 @）却解析不出群成员时整条命令失败，绝不静默按「放开全员」处理；
   * 3. 回执必须写出改完之后谁能用，而不是只说一句「已更新」。
   */
  private async executeGrantCommand(
    command: 'grant' | 'revoke',
    event: LarkMessageEvent,
    config: StoredLarkConfig,
    argsText: string,
    replyCard: (taskName: string, markdown: string, options?: { elements?: LarkCardElement[]; failed?: boolean }) => Promise<unknown>
  ): Promise<'handled'> {
    const manager = this.groupManager;
    if (!manager || event.chatType !== 'group') throw new Error('只有群聊里才有可修改的对话授权。');
    const state = await manager.groupAccess(config.appId, event.chatId);
    if (!state) throw new Error('本群还没有在 Dutydeck 中同步群配置，聊天里没有可修改的授权。请管理员先在 Dutydeck Web 同步此机器人的群聊。');
    if (!await this.isGrantOperatorAllowed(config, event.senderOpenId, event.chatId, command === 'grant' ? 'grant.create' : 'grant.revoke')) {
      await replyCard(`/${command} 未执行`, '当前账号没有修改本群授权的权限：需要本机器人的管理员，或已被授予高风险操作权限的群成员。', { failed: true });
      return 'handled';
    }
    // 目标成员只认真实的飞书提及（带 open_id），机器人自己的提及不算目标。
    const mentioned = event.mentions.filter(mention => mention.openId && mention.openId !== this.botOpenId);
    if (!mentioned.length && argsText) {
      throw new Error('请用 @ 选中要操作的群成员，例如 `/grant @张三`。纯文字的名字解析不出群成员身份。');
    }
    const targets: string[] = [];
    const unresolved: string[] = [];
    for (const mention of mentioned) {
      const principal = await manager.resolveGroupPrincipal(config.appId, event.chatId, mention.openId!);
      if (principal) targets.push(principal);
      else unresolved.push(mention.name || mention.openId!);
    }
    if (unresolved.length) {
      throw new Error(`这些成员解析不到本群身份，本次授权没有做任何修改：${unresolved.map(name => larkCommandEcho(name, 40)).join('、')}。请确认他们仍在本群中。`);
    }
    // 基准只取**本群自己**的名单。继承来的机器人默认名单不是本群的 principal，
    // 把它抄进群覆盖会写进一批没登记过身份的 principal，被 save 的作用域校验直接打回。
    const own = state.override.mode === 'allowlist' ? state.override.principalIds : undefined;
    if (command === 'revoke' && targets.length && !own) {
      throw new Error(`本群现在不是按名单授权（当前：${describeLarkAccess(state.effective.mode)}），没有可移除的名单。要整体收回请直接发送 \`/revoke\`；要改成名单请先用 \`/grant @成员\` 建立。`);
    }
    const next = targets.length
      ? (() => {
        const list = new Set(own ?? []);
        for (const id of targets) command === 'grant' ? list.add(id) : list.delete(id);
        return list.size
          ? { mode: 'allowlist' as const, principalIds: [...list] }
          : { mode: 'owner_only' as const, principalIds: [] };
      })()
      : command === 'grant'
        ? { mode: 'all_chat_members' as const, principalIds: [] }
        : { mode: 'owner_only' as const, principalIds: [] };
    await manager.save(config.appId, event.chatId, { expectedRevision: state.revision, patch: { accessOverride: next } });
    const summary = next.mode === 'all_chat_members' ? '本群所有成员都可以使用本机器人'
      : next.mode === 'allowlist' ? `仅名单内 ${next.principalIds.length} 人可以使用本机器人`
        : '仅本机器人的管理员可以使用';
    // 建了本群自己的名单就必须写出改之前是什么。从「继承机器人默认」切到群名单时，
    // 原先按机器人默认（allowedUsers / allowedEmails）放行的人会一起失效——
    // 这一步恰恰是用户最容易没想到的，必须显式说出来，不能只报改完的结果。
    const narrowed = next.mode !== 'allowlist' || state.override.mode === 'allowlist' ? ''
      : state.override.mode === 'inherit'
        ? `\n\n此前本群继承机器人默认授权（${describeLarkAccess(state.effective.mode)}），现在改为本群自己的名单：原先按机器人默认放行的成员不再自动可用。`
        : `\n\n此前本群是「${describeLarkAccess(state.effective.mode)}」，现在改为本群自己的名单。`;
    const oncall = state.oncall ? '\n\n本群仍处于值班模式：值班期间所有群成员都能使用，名单要等关闭值班后才生效。' : '';
    // 「谁能用」不止这一条口径：Web 上单独授予过 can_talk / can_operate 角色的成员
    // 不受群 access 影响，回执不能把结论说成排他的。
    await replyCard(`/${command} 已生效`, `**本群授权已改为：${summary}。**${narrowed}${oncall}\n\n在 Dutydeck Web 上单独授予过角色的成员不受本命令影响，需要到 Web 上撤销。`);
    return 'handled';
  }

  /**
   * 汇总会话/Agent/工作区/排队状态，口径与 Web 保持一致：运行数与待执行指令数分开。
   *
   * 有实际会话时以**会话自己的** agentId / cwd 为准：配置可能在会话创建之后被改过，
   * 照着配置写会告诉用户一个它其实没在用的 Agent。配置与会话不一致时两者都列出来。
   */
  /** /status 的 Agent 状态行（A1）。不可用标记超过 5 分钟先复查一次（不调模型）。 */
  private async agentAvailabilityLine(agentId: string) {
    const reliability = larkReliability(this.runtime);
    if (!reliability.getAgentAvailability) return undefined;
    let mark = reliability.getAgentAvailability(agentId);
    if (mark && Date.now() - Date.parse(mark.at) > 5 * 60_000 && reliability.checkAgentAvailability) mark = await reliability.checkAgentAvailability(agentId).catch(() => mark);
    return larkAgentAvailabilityLine(mark);
  }

  private async describeChatStatus(config: StoredLarkConfig, sessionId?: string, latestTask?: LarkTask): Promise<string> {
    const lines: string[] = [];
    const configuredAgent = config.defaultAgentId ?? 'Dutydeck';
    if (!sessionId) {
      lines.push(`**Agent**：${larkCommandEcho(configuredAgent, 64)}`);
      const availability = config.defaultAgentId ? await this.agentAvailabilityLine(config.defaultAgentId) : undefined;
      if (availability) lines.push(availability);
      if (config.workspace) lines.push(`**工作区**：${larkCommandEcho(config.workspace, 160)}`);
      lines.push(larkExecutionIdentityLine());
      lines.push('这条消息不在已有任务话题中。请回原话题查询，或发送 `/tasks` 查看任务。');
      return lines.join('\n\n');
    }
    let session: Session | undefined;
    let sessionError = false;
    try {
      session = await this.runtime.getSession(sessionId);
    } catch (error) {
      this.log.warn({ error, sessionId }, '读取会话状态失败');
      sessionError = true;
    }
    lines.push(`**Agent**：${larkCommandEcho(session?.agentId ?? configuredAgent, 64)}`);
    const statusAgentId = session?.agentId ?? config.defaultAgentId;
    const availability = statusAgentId ? await this.agentAvailabilityLine(statusAgentId) : undefined;
    if (availability) lines.push(availability);
    if (session && session.agentId !== config.defaultAgentId) {
      lines.push(`**配置的 Agent**：${larkCommandEcho(configuredAgent, 64)}（下一个新会话生效）`);
    }
    const workspace = session?.cwd ?? config.workspace;
    if (workspace) lines.push(`**工作区**：${larkCommandEcho(workspace, 160)}`);
    if (session?.model) lines.push(`**模型**：${larkCommandEcho(session.model, 128)}`);
    if (session?.reasoningEffort) lines.push(`**推理强度**：${larkCommandEcho(session.reasoningEffort, 32)}`);
    if (session && config.workspace && session.cwd !== config.workspace) {
      lines.push(`**配置的工作区**：${larkCommandEcho(config.workspace, 160)}（下一个新会话生效）`);
    }
    lines.push(`**会话**：\`${larkCommandEcho(sessionId, 64)}\``);
    lines.push(larkExecutionIdentityLine());
    if (sessionError) lines.push('**运行状态**：读取失败，请前往 Dutydeck Web 查看。');
    else if (session) lines.push(`**运行状态**：${larkCommandEcho(session.state, 32)}`);
    else lines.push('**运行状态**：会话记录已不存在，发送新的请求会开启新会话。');
    if (this.runtime.getTasks) {
      try {
        const tasks = await this.runtime.getTasks(sessionId);
        const queued = tasks.filter(task => task.status === 'queued').length;
        const running = tasks.filter(task => task.status === 'running').length;
        // 排队运行数与待执行指令数是两个口径，必须分开表达，不混用。
        const unresolved = tasks.filter(task => ['reconcile_required', 'legacy_unresolved'].includes(task.status));
        const approval = queued ? await this.approvalBlock(config.appId, sessionId) : undefined;
        lines.push(`**执行中的运行**：${running} 个　**待执行指令**：${queued} 条${approval ? '（被审批阻塞）' : ''}　**需要核对**：${unresolved.length} 条`);
        if (approval) {
          const deadline = approval.record?.expiresAt ? `，${deadlineText(approval.record.expiresAt)}截止，到时仍未处理将自动拒绝` : '';
          lines.push(`**被审批阻塞**：当前一轮在等审批${deadline}。后面 ${queued} 条指令要等它处理完才会执行。${approval.record
            ? '不需要这一步时，可以点下方「拒绝这条审批」放行队列。' : '请在审批卡或 Dutydeck Web 上处理这条审批。'}`);
        }
        for (const task of [...unresolved, ...tasks.filter(task => task.status === 'queued')].slice(0, 3)) {
          const recovery = await describeLarkTaskRecovery(this.runtime, sessionId, task.id, task.status);
          lines.push(`${larkCommandEcho(task.prompt, 80)}\n\n${approval && task.status === 'queued' && !recovery.blocked
            ? '**被审批阻塞**\n\n前一轮在等审批，处理完后才会执行。' : recovery.markdown}`);
        }
      } catch (error) {
        this.log.warn({ error, sessionId }, '读取任务队列失败');
      }
    }
    // 结果没送达的轮次：任务本身已经结束，只是结论没能发到飞书，读者在群里看不到它。
    try {
      const issues = larkResultDeliveryIssues((await this.cardMappings?.list(larkCardChannel(config.appId)) ?? []).filter(mapping => mapping.sessionId === sessionId));
      for (const issue of issues.slice(0, 3)) {
        const reason = larkCommandEcho(issue.error ?? '未记录', 200);
        lines.push(issue.state === 'failed'
          ? `**结果未送达**：「${larkCommandEcho(issue.taskName, 80)}」的结果没有确认送达飞书，不会再自动重发。原因：${reason}`
          : `**结果投递重试中**：「${larkCommandEcho(issue.taskName, 80)}」的结果第 ${issue.attempts} 次发送失败，稍后自动重发。原因：${reason}`);
      }
    } catch (error) {
      this.log.warn({ error, sessionId }, '读取结果投递状态失败');
    }
    if (latestTask) lines.push(`**最近一轮**：${larkCommandEcho(latestTask.state, 32)}`);
    return lines.join('\n\n');
  }

  /**
   * 当前一轮停在执行端审批上、同一会话后面还有指令排队时，这些指令都被这条审批挡住。
   * record 是本进程发出的审批卡记录（卡片尚未送达或审批只在 Web 上时没有），供「拒绝这条审批」入口使用。
   */
  protected async approvalBlock(appId: string, sessionId: string) {
    if (!(await this.runtime.getTasks?.(sessionId))?.some(task => task.status === 'queued')) return undefined;
    const permissions = await this.runtime.getPendingPermissions?.(sessionId) ?? [];
    if (!permissions.length) return undefined;
    const record = (await this.workflows?.list(appId))?.find(item => item.kind === 'permission' && item.state === 'pending' && item.sessionId === sessionId
      && item.boot === this.workflows?.boot && permissions.some(permission => permission.id === item.nativeId));
    return { record };
  }

  /**
   * 「查看详情」回调（仅 Web 要求登录时渲染）：管理员收到一条私信，内含绑定该会话的一次性登录链接。
   * 一键登录停用（没有 loginLinks）后新卡不再渲染这个按钮，但已经发出的旧卡上还有：这时私信的是这个
   * 会话的只读分享链接，和新卡页脚同一个链接。新卡页脚群里谁都能看到，所以这条路不走管理员门。
   *
   * 回调里不信任卡片上的任何值：会话按平台给出的 open_message_id 从卡片账本里查，账本记录必须属于
   * 当前机器人和当前群。旧卡同样受理（查看详情只读）：重试旧卡跳到任务现在所在的会话，转交旧卡跳原会话。
   * target 只用来定位转交认领，会话一律取持久化记录。
   * 链接只发到点击人的单聊，群里不出现；也不写日志——下面记录的错误只含飞书返回码。
   */
  private async handleDetailLogin(operatorOpenId?: string, context?: { messageId?: string; chatId?: string }, target?: { taskId: string; turn?: number }) {
    const links = this.workflowOptions.loginLinks;
    if (!operatorOpenId || !context?.messageId || !context.chatId || !this.reconcileConfig || !this.cardMappings || !this.workflowOptions.store) {
      return { type: 'error', content: '详情入口已失效，请在最新的任务卡片上操作。' };
    }
    try {
      const config = await readLarkConfig(this.workflowOptions.store, this.reconcileConfig.appId);
      if (!config?.listening) return { type: 'warning', content: '机器人已停用，无法打开详情。' };
      const webBaseUrl = config.webBaseUrl?.trim().replace(/\/$/, '');
      let card: { externalId: string; sessionId: string; saved: PersistedLarkCardTask } | undefined;
      for (const mapping of await this.cardMappings.list(larkCardChannel(config.appId))) {
        let saved: PersistedLarkCardTask;
        try { saved = JSON.parse(mapping.extra ?? '{}') as PersistedLarkCardTask; }
        catch { continue; }
        if (saved.app_id !== config.appId || saved.chat_id !== context.chatId
          || ![saved.card_message_id, saved.final_message_id, ...saved.earlier_message_ids ?? []].includes(context.messageId)) continue;
        card = { externalId: mapping.externalId, sessionId: mapping.sessionId, saved };
        break;
      }
      // 转交旧卡：映射已移到新一轮，按回调里的任务与轮次读转交认领。claim.sessionId 是原会话，
      // 与 markRelaunchedCard 给这张旧卡的页脚会话一致。
      if (!card && target?.turn !== undefined) {
        const raw = await this.workflowOptions.store.get(`lark.relaunch.${config.appId}.${target.taskId}.${target.turn}`);
        const claim = raw ? JSON.parse(raw) as LarkRelaunchClaim : undefined;
        if (claim?.phase === 'moved' && claim.cardMessageId === context.messageId && claim.chatId === context.chatId) {
          card = { externalId: claim.taskId, sessionId: claim.sessionId, saved: { app_id: claim.appId, chat_id: claim.chatId, turn: claim.turn,
            state: claim.action === 'rerun_in_new_session' ? 'reconcile_required' : 'cancelled' } as PersistedLarkCardTask };
        }
      }
      // 与渲染端同一个判断：卡上出现「查看详情」按钮的条件，就是这里受理的条件。
      if (!card || !webBaseUrl || !isLarkCardActionAvailable('detail', {
        state: card.saved.state, taskId: card.externalId, turn: card.saved.turn ?? 0,
        capabilities: { canCancelQueued: false, canInterrupt: false, canRetry: false, canRefresh: false, detailLogin: true, webUrl: `${webBaseUrl}/sessions/${encodeURIComponent(card.sessionId)}` }
      })) {
        return { type: 'warning', content: '找不到这张卡片对应的任务记录，无法打开详情。' };
      }
      // 登录链接兑换后等同登录，与 /repair 同一道安装级门；谁能拿到链接完全由这道门决定。
      if (links && !await this.isInstallationOperatorAllowed(config, operatorOpenId, context.chatId)) {
        return { type: 'warning', content: 'Web 详情仅机器人管理员可打开；完整执行记录可点「导出执行记录」获取' };
      }
      const elements = links
        ? larkDetailLoginElements(`${webBaseUrl}/api/auth/link?code=${links.issue(card.sessionId)}`)
        : larkSessionShareElements(larkSessionDetailUrl(webBaseUrl, card.sessionId));
      try {
        await this.service.send({ receiveId: operatorOpenId, receiveIdType: 'open_id', taskName: links ? '登录 Dutydeck Web' : '任务详情', state: 'completed', readOnly: true,
          permissionMode: larkPermissionMode(config), elements });
      } catch (error) {
        const upstreamCode = error instanceof LarkServiceError ? Number(error.details?.upstreamCode) : undefined;
        this.log.warn({ upstreamCode, messageId: context.messageId }, '私信 Web 登录链接失败');
        // 230013：点击人不在应用可用范围内，机器人无法与其单聊。
        return { type: 'error', content: upstreamCode === 230013
          ? '私信发送失败：你不在机器人应用的可用范围内，请联系管理员把你加入可用范围。链接没有发出。'
          : `私信发送失败（飞书返回码 ${Number.isFinite(upstreamCode) ? upstreamCode : '未知'}），链接没有发出，请稍后重试。` };
      }
      return { type: 'success', content: links ? '已私信你一个 10 分钟内有效的登录链接' : '已私信你这个任务的只读详情链接' };
    } catch (error) {
      this.log.warn({ error, messageId: context.messageId }, '受理查看详情失败');
      return { type: 'error', content: '暂时无法打开详情，请稍后重试。' };
    }
  }

  /**
   * /repair 后台执行体：卡片回调在全部门禁通过后 3 秒内返回，真正的开放平台发布与结果卡
   * PATCH 在这里完成。任何失败都如实落到卡片，绝不抛出（调用方 fire-and-forget）。
   */
  private async executeRepairFlight(config: StoredLarkConfig, appId: string, messageId: string) {
    try {
      await this.service.update({
        messageId, taskId: messageId, taskName: '/repair 正在执行',
        state: 'running', readOnly: true, permissionMode: larkPermissionMode(config),
        markdown: '**正在执行修复**\n\n正在连接飞书开放平台，增量补齐权限、事件订阅与卡片回调；完成后会在本卡回报结果，请勿重复触发。'
      }).catch(error => this.log.warn({ error }, 'PATCH /repair 进行中状态失败'));
      // 缓存登录态命中时不进入扫码等待；缓存失效又无人扫码时，用有界等待快速失败，
      // 让结果卡回报「登录态过期」而不是长时间悬挂。
      const result = await runOpenPlatformRepair(
        {
          connectClient: async () => connectLarkOpenPlatformSession({ maxWaitMs: 30_000 }),
          // 斜杠命令走 tenant_access_token，而 this.service 正是本机器人的客户端。
          // 回调门禁已保证被修复的就是本应用（见上方 appId 比对）；万一不是，宁可交给
          // repair 的 env 回落去判，也绝不拿另一个应用的 token 去写命令菜单。
          ...(appId === config.appId ? { slashCommandClient: this.service } : {})
        },
        { appId, confirmed: true }
      );
      const rendered = renderRepairResultCard(result);
      const state = result.status === 'failed' ? 'failed' as const : 'completed' as const;
      await this.service.update({
        messageId, taskId: messageId, taskName: rendered.title,
        state, readOnly: true, permissionMode: larkPermissionMode(config),
        markdown: rendered.markdown, ...(rendered.elements.length ? { elements: rendered.elements } : {})
      });
    } catch (error) {
      this.log.warn({ error }, '后台执行 /repair 失败');
      await this.service.update({
        messageId, taskId: messageId, taskName: '/repair 修复失败',
        state: 'failed', readOnly: true, permissionMode: larkPermissionMode(config),
        markdown: '修复执行失败，请稍后重试；本次未完成发布。'
      }).catch(() => undefined);
    }
  }

  async handleAction(value: unknown, operatorOpenId?: string, context?: { messageId?: string; chatId?: string; actionTag?: string; option?: string }) {
    const workflow = value as Record<string, unknown> | null;
    // 群级变更确认卡（如参与强度）：改什么、谁发起都以存档的确认单为准，谁能确认由各种类自己校验。
    if (workflow && typeof workflow === 'object' && 'dutydeck_confirm' in workflow) {
      const participation = this.workflowOptions.participation;
      const result = participation && this.reconcileConfig ? await participation.confirmations.handle(this.reconcileConfig.appId, value, operatorOpenId, context) : undefined;
      return result ?? { type: 'warning', content: '这张确认卡已失效。' };
    }
    if (workflow && workflow.dutydeck_export_trace === 'download') {
      if (!operatorOpenId || !context?.messageId || !context.chatId || !this.reconcileConfig || !this.cardMappings || !this.runtime.getEvents) {
        return { type: 'error', content: '记录入口已失效，请在原任务卡上操作。' };
      }
      try {
        const config = await readLarkConfig(this.workflowOptions.store, this.reconcileConfig.appId);
        if (!config?.listening) return { type: 'warning', content: '机器人已停用，无法导出记录。' };
        const mapping = (await this.cardMappings.list(larkCardChannel(config.appId))).find(item => item.externalId === workflow.task_id);
        const saved = mapping?.extra ? JSON.parse(mapping.extra) as PersistedLarkCardTask : undefined;
        if (!mapping || !saved?.runtime_task_id || saved.app_id !== config.appId || saved.chat_id !== context.chatId
          || ![saved.card_message_id, saved.final_message_id].includes(context.messageId)
          || saved.chat_type !== 'group' && saved.sender_open_id !== operatorOpenId
          || String(saved.turn) !== workflow.turn
          || !await this.currentAccess(config, saved.chat_id, saved.chat_type ?? 'group', operatorOpenId, 'task.view_result', mapping.sessionId, saved.sender_open_id)) {
          return { type: 'warning', content: '当前账号无权导出此任务记录，或卡片已失效。' };
        }
        const task = (await this.runtime.getTasks?.(mapping.sessionId))?.find(item => item.id === saved.runtime_task_id);
        if (!task) return { type: 'warning', content: '原任务记录不存在，无法导出。' };
        if (task.status === 'queued' || task.status === 'cancelled') {
          return { type: 'warning', content: '任务尚未执行，暂无执行记录可导出。' };
        }
        // The platform callback has a short deadline. Authorize first, then
        // deliver to the persisted chat/topic, never to callback-supplied IDs.
        void (async () => {
          try {
            const events = await this.runtime.getEvents!(mapping.sessionId);
            const start = events.findIndex(item => item.type === 'text' && (item.data as any)?.role === 'user' && (item.data as any)?.taskId === task.id);
            if (start < 0) throw new Error('原任务记录不完整，无法安全限定导出范围。');
            // Stop at the next user task as well as the terminal event: an
            // incomplete old turn must not export a later user's records.
            const end = events.findIndex((item, index) => index > start && (item.type === 'text' && (item.data as any)?.role === 'user'
              || item.type === 'task' && (item.data as any)?.task?.id === task.id && ['completed', 'failed', 'cancelled', 'interrupted'].includes((item.data as any)?.task?.status)));
            const text = renderLarkRecordExport(events.slice(start + 1, end < 0 ? undefined : end));
            const current = await readLarkConfig(this.workflowOptions.store, config.appId);
            if (!current?.listening || !await this.currentAccess(current, saved.chat_id, saved.chat_type ?? 'group', operatorOpenId, 'task.view_result', mapping.sessionId, saved.sender_open_id)) return;
            const key = `trace_${createHash('sha256').update([config.appId, task.id, text].join('\0')).digest('hex').slice(0, 40)}`;
            await sendLarkFile(this.service, { chatId: saved.chat_id,
              replyMessageId: saved.reply_message_id ?? saved.card_message_id, replyInThread: saved.reply_in_thread }, {
              data: Buffer.from(text, 'utf8'), filename: '公开执行记录.md', idempotencyKey: key
            }, this.log, this.workflowOptions.store);
          } catch (error) {
            this.log.warn({ error, taskId: task.id }, '导出执行记录失败');
            await sendTaskCard(this.service, { messageId: saved.card_message_id ?? task.id, chatId: saved.chat_id,
              chatType: saved.chat_type ?? 'group', threadId: saved.thread_id, messageType: 'text', content: '', mentions: [] }, {
              state: 'failed', readOnly: true, taskName: '记录未能导出',
              markdown: '未能获取或发送本轮完整公开记录，请稍后重试。'
            }, this.log).catch(() => undefined);
          }
        })();
        return { type: 'success', content: '正在导出公开执行记录，文件将发送到原任务会话。' };
      } catch (error) {
        this.log.warn({ error }, '受理记录导出失败');
        return { type: 'error', content: '暂时无法导出，请稍后重试。' };
      }
    }
    // P0-6：/repair 确认卡回调。发布飞书应用版本不可撤销，确认按钮是逐次显式确认的唯一载体；
    // 这里再串应用、门禁、人类校验三道，测试只能注入 mock client，开发/测试绝不真实发布。
    if (workflow && typeof workflow === 'object' && 'dutydeck_repair' in workflow) {
      const parsedRepair = parseRepairCardActionValue(value);
      if (!parsedRepair) return { type: 'error', content: '修复操作无法识别，请重新发送 /repair。' };
      if (!this.reconcileConfig || parsedRepair.appId !== this.reconcileConfig.appId) {
        return { type: 'error', content: '确认卡与当前飞书应用不匹配，请重新发送 /repair。' };
      }
      if (!context?.messageId || !context.chatId || !operatorOpenId) {
        return { type: 'error', content: '修复确认已失效，请重新发送 /repair。' };
      }
      try {
        const config = await readLarkConfig(this.workflowOptions.store, this.reconcileConfig.appId);
        if (!config?.listening) return { type: 'warning', content: '机器人已停用，无法执行修复。' };
        // /repair 发布的是整个飞书应用的新版本，属安装级动作，必须走 high_risk 门或部署静态
        // 白名单，不能复用「操作本人任务」的 own_runs 授权（开放发言群的普通成员也有后者）。
        const repairAuth = await this.isRepairOperatorAllowed(config, operatorOpenId, context.chatId);
        if (!repairAuth.allowed) {
          const content = repairAuth.reason === 'unconfigured'
            ? '未配置操作白名单时，飞书里不能执行 /repair，请在 Web 上操作。'
            : '当前账号无权执行 /repair：需要安装管理员权限。';
          return { type: 'warning', content };
        }
        // 卡片回调不携带发送者类型：bot 没有邮箱（平台 230001），借此把协作 bot 挡在发布动作外。
        const emails = await this.service.getUserEmails(operatorOpenId).catch(() => [] as string[]);
        if (!emails.length) return { type: 'warning', content: '/repair 只能由人类成员执行。' };
        // 发布链路含十余个开放平台串行写请求、耗时必然超过卡片回调 3 秒 SLA。
        // 所有门禁在此之前同步完成；通过后把发布与结果卡 PATCH 放到后台，回调立即回执。
        const flightKey = `${parsedRepair.appId}:${context.messageId}`;
        if (this.repairInFlight.has(flightKey)) {
          return { type: 'warning', content: '修复正在执行中，完成后会更新这张卡片，请勿重复点击。' };
        }
        this.repairInFlight.add(flightKey);
        void this.executeRepairFlight(config, parsedRepair.appId, context.messageId)
          .finally(() => this.repairInFlight.delete(flightKey));
        return { type: 'success', content: '已开始执行修复，完成后会更新这张卡片，请勿重复点击。' };
      } catch (error) {
        this.log.warn({ error }, '受理 /repair 失败');
        return { type: 'error', content: '修复操作受理失败，请稍后重试；本次未完成发布。' };
      }
    }
    // 定时结果卡「停用此计划」按钮回调：与 /schedule disable <编号> 完全一致的权限校验与执行逻辑。
    if (workflow && typeof workflow === 'object' && typeof workflow.dutydeck_schedule_disable === 'string') {
      const scheduleId = workflow.dutydeck_schedule_disable.trim();
      if (!scheduleId || !context?.chatId || !operatorOpenId || !this.reconcileConfig || !this.workflowOptions.store) {
        return { type: 'error', content: '卡片已失效，无法停用计划。' };
      }
      const automation = this.workflowOptions.automation;
      if (!automation) return { type: 'error', content: '当前服务尚未接入定时任务。' };
      const scheduleRecord = await automation.getSchedule(scheduleId);
      if (!scheduleRecord) return { type: 'warning', content: '当前话题没有此计划' };

      // 核对回调所在的卡片、聊天是否和计划冻结的投递位置一致，防止跨会话停用他人的计划
      const rawTarget = await this.workflowOptions.store.get(`automation.delivery-target.${scheduleId}`);
      type DeliveryTarget = { appId: string; chatId: string; replyMessageId?: string; messageId?: string; replyInThread?: boolean };
      let target: DeliveryTarget | null = null;
      try { target = JSON.parse(rawTarget ?? 'null'); } catch {}
      if (!target || target.appId !== this.reconcileConfig.appId || target.chatId !== context.chatId) {
        return { type: 'warning', content: '这张卡不属于这个计划，无法停用。' };
      }
      if (context.messageId && target.messageId && target.messageId !== context.messageId) {
        return { type: 'warning', content: '这张卡不属于这个计划，无法停用。' };
      }

      const config = await readLarkConfig(this.workflowOptions.store, this.reconcileConfig.appId);
      if (!config?.listening) return { type: 'warning', content: '机器人已停用，无法执行此操作。' };
      if (!await this.isOperatorAllowed(config, operatorOpenId, context.chatId, scheduleRecord.sessionId)) {
        return { type: 'warning', content: '当前账号没有操作此任务的权限。' };
      }
      try {
        const dummyEvent: LarkMessageEvent = {
          messageId: context.messageId ?? '',
          chatId: context.chatId,
          chatType: context.chatId.startsWith('oc_') ? 'group' : 'p2p',
          senderOpenId: operatorOpenId,
          messageType: 'text',
          content: '',
          mentions: []
        };
        const content = await executeScheduleCommand(
          automation,
          this.workflowOptions.store,
          scheduleRecord.sessionId,
          `disable ${scheduleId}`,
          dummyEvent,
          config
        );
        return { type: 'success', content };
      } catch (error) {
        return { type: 'warning', content: error instanceof Error ? error.message : String(error) };
      }
    }
    // 结果卡「本轮记忆」的删除按钮：与 /forget 同一道命令层白名单门，只接受这一轮列出过的条目。
    // 记忆池与会话取自派发时的记录，聊天以平台回调给的为准，不信 value 里的任何聊天标识。
    if (workflow && typeof workflow === 'object' && 'dutydeck_memory_forget' in workflow) {
      const memoryId = workflow.dutydeck_memory_forget;
      const turnTaskId = typeof workflow.task_id === 'string' ? workflow.task_id : '';
      const turnSessionId = typeof workflow.session_id === 'string' ? workflow.session_id : '';
      if (!isLarkMemoryId(memoryId) || !turnTaskId || !turnSessionId) return { type: 'error', content: '无法识别要删除的记忆。' };
      if (!context?.chatId || !operatorOpenId || !this.reconcileConfig || !this.memory || !this.workflowOptions.store) {
        return { type: 'error', content: '删除入口已失效，请发送 /memory 查看，再用 /forget <编号> 删除。' };
      }
      try {
        const config = await readLarkConfig(this.workflowOptions.store, this.reconcileConfig.appId);
        if (!config?.listening) return { type: 'warning', content: '机器人已停用，无法删除记忆。' };
        if (!larkMemoryEnabled(config)) return { type: 'warning', content: '本机器人已关闭会话记忆。' };
        const turn = await this.memory.turn(turnSessionId, turnTaskId);
        if (!turn) return { type: 'warning', content: `这张卡片的记忆记录已过期（每个会话只保留最近 ${larkMemoryLimits.turnsPerSession} 轮），请发送 /memory 查看，再用 /forget <编号> 删除。` };
        if (turn.record.appId !== config.appId || turn.record.chatId !== context.chatId
          || ![...turn.injected, ...turn.written].some(entry => entry.id === memoryId)) {
          return { type: 'warning', content: '这条记忆不属于本卡片对应的任务，请发送 /memory 查看。' };
        }
        if (!await this.commandAllowlisted(config, turn.shared ? 'group' : 'p2p', context.chatId, operatorOpenId, turn.record.sessionId)) {
          return { type: 'warning', content: '当前账号不在机器人白名单中，无法删除记忆。' };
        }
        const removed = await this.memory.remove(turn.scope, memoryId, operatorOpenId);
        const task = [...this.tasks.values()].find(item => item.runtimeTaskId === turnTaskId);
        if (task) await this.refreshResultMemory(task, config).catch(error => this.log.warn({ error, taskId: task.id }, '记忆已删除，结果卡刷新失败'));
        return removed
          ? { type: 'success', content: `已删除记忆 ${memoryId}，之后的任务不再带上这条记忆。` }
          : { type: 'warning', content: `记忆 ${memoryId} 已经删除过了。` };
      } catch (error) {
        this.log.warn({ error }, '删除结果卡上的记忆失败');
        return { type: 'error', content: '删除失败，请稍后重试，或发送 /forget <编号>。' };
      }
    }
    // S2：/help 只读翻页。帮助内容与用户身份无关，无需持久化原消息；门禁与 /help 命令同权。
    if (workflow && typeof workflow === 'object' && 'dutydeck_help_page' in workflow) {
      const pageValue = parseLarkHelpPageValue(value);
      if (!pageValue) return { type: 'error', content: '无法识别帮助页码。' };
      if (!context?.messageId || !context.chatId || !operatorOpenId || !this.reconcileConfig || !this.workflowOptions.store) {
        return { type: 'error', content: '帮助卡片已失效，请重新发送 /help。' };
      }
      try {
        const config = await readLarkConfig(this.workflowOptions.store, this.reconcileConfig.appId);
        if (!config?.listening) return { type: 'warning', content: '机器人已停用，无法查看命令帮助。' };
        if (!await this.isOperatorAllowed(config, operatorOpenId, context.chatId)) {
          return { type: 'warning', content: '当前账号无权使用命令帮助。' };
        }
        const help = renderLarkCommandHelp(this.larkRouteCapabilities(), { page: pageValue.page });
        await this.service.update({ messageId: context.messageId, taskId: context.messageId, taskName: help.title,
          state: 'completed', readOnly: true, permissionMode: larkPermissionMode(config), markdown: help.text, elements: help.elements });
        return { type: 'success', content: `帮助第 ${help.page}/${help.totalPages} 页。` };
      } catch (error) {
        this.log.warn({ error }, '翻页命令帮助失败');
        return { type: 'error', content: '翻页失败，请稍后重试或重新发送 /help。' };
      }
    }
    if (workflow && typeof workflow === 'object' && 'dutydeck_task_dashboard' in workflow) {
      if (workflow.dutydeck_task_dashboard !== 'page' || typeof workflow.page !== 'number'
        || !Number.isSafeInteger(workflow.page) || workflow.page < 1) return { type: 'error', content: '无法识别任务列表页码。' };
      if (!context?.messageId || !context.chatId || !operatorOpenId || !this.reconcileConfig || !this.workflowOptions.store) {
        return { type: 'error', content: '任务列表已失效，请重新发送 /tasks。' };
      }
      try {
        const saved = await this.workflowOptions.store.get(`lark.task_dashboard.${this.reconcileConfig.appId}.${context.messageId}`);
        if (!saved) return { type: 'warning', content: '任务列表已失效，请重新发送 /tasks。' };
        const event = JSON.parse(saved) as LarkMessageEvent;
        if (event.chatId !== context.chatId || event.senderOpenId !== operatorOpenId) {
          return { type: 'warning', content: '请发送 /tasks 查看你自己的任务列表。' };
        }
        const config = await readLarkConfig(this.workflowOptions.store, this.reconcileConfig.appId);
        if (!config?.listening) return { type: 'warning', content: '机器人已停用，无法刷新任务列表。' };
        const elements = await this.taskDashboard(event, config, workflow.page);
        await this.service.update({ messageId: context.messageId, taskId: event.messageId, taskName: '任务导航',
          state: 'completed', readOnly: true, permissionMode: larkPermissionMode(config), elements });
        return { type: 'success', content: '任务列表已更新。' };
      } catch (error) {
        this.log.warn({ error }, '刷新任务列表失败');
        return { type: 'error', content: '刷新失败，请稍后重试或重新发送 /tasks。' };
      }
    }
    // CI 失败卡「交给 Agent 修」：与 /ci 命令同一道权限门，卡片须是该订阅最新发出的失败卡。
    if (workflow && typeof workflow.dutydeck_ci_fix === 'string') {
      const codebase = this.workflowOptions.automation?.codebase;
      if (!codebase || !this.reconcileConfig || !context?.messageId || !context.chatId || !operatorOpenId || typeof workflow.failure !== 'string') {
        return { type: 'error', content: 'CI 失败卡已失效，请发送 /ci 查看最新状态。' };
      }
      try {
        const config = await readLarkConfig(this.workflowOptions.store, this.reconcileConfig.appId);
        if (!config?.listening) return { type: 'warning', content: '机器人已停用，无法开始修复。' };
        const subscription = await codebase.get(workflow.dutydeck_ci_fix);
        const session = subscription ? await this.runtime.getSession(subscription.sessionId) : undefined;
        const [appId, chatId] = session?.source === 'lark' ? session.sourceId?.split(':') ?? [] : [];
        if (!subscription || appId !== config.appId || chatId !== context.chatId) return { type: 'warning', content: '这张 CI 失败卡不属于当前会话。' };
        if (!await this.isOperatorAllowed(config, operatorOpenId, context.chatId, subscription.sessionId)) return { type: 'warning', content: '当前账号没有操作此任务的权限。' };
        return { type: 'success', content: await codebase.requestFix(subscription.id, { failureKey: workflow.failure, cardMessageId: context.messageId }, operatorOpenId) };
      } catch (error) { return { type: 'error', content: error instanceof Error ? error.message : String(error) }; }
    }
    // 定时委托的确认卡 / 产出卡按钮（确认、取消、暂停、恢复、停止）；权限与状态判断都在 mandateCards 内。
    if (workflow && typeof workflow.dutydeck_mandate === 'string') {
      const cards = this.workflowOptions.automation?.mandateCards;
      if (!cards || !this.reconcileConfig) return { type: 'error', content: '这张卡片已失效。' };
      try { return { type: 'success', content: await cards.callback(this.reconcileConfig.appId, workflow, operatorOpenId, { messageId: context?.messageId, chatId: context?.chatId }) }; }
      catch (error) { return { type: 'error', content: error instanceof Error ? error.message : String(error) }; }
    }
    if (workflow && typeof workflow.dutydeck_work_item === 'string') {
      if (!this.workflowOptions.workbench || !this.reconcileConfig || !context) return { type: 'error', content: '目标卡片已失效。' };
      try { return { type: 'success', content: await this.workflowOptions.workbench.callback(workflow, operatorOpenId, context, this.reconcileConfig) }; }
      catch (error) { return { type: 'error', content: error instanceof Error ? error.message : String(error) }; }
    }
    // 排队卡上的「允许本次」「拒绝」：按钮值与审批卡同形，剥掉另带的两个字段后照常交给下面的审批分支。
    // 另带的字段只用来核对，关联哪条排队任务按这张卡在服务端查（见 respondFromQueuedCard）。
    if (workflow && typeof workflow.dutydeck_queued_task === 'string') {
      const { dutydeck_queued_task: queuedTaskId, queued_turn: queuedTurn, ...approval } = workflow;
      return this.respondFromQueuedCard({ taskId: queuedTaskId, turn: queuedTurn }, approval, operatorOpenId, context?.messageId,
        (): Promise<{ type: string; content: string }> => this.handleAction(approval, operatorOpenId, context));
    }
    // 按钮的 callback value 存在飞书服务器上，不在本地：改名前发出的审批卡带的是
    // dockmux_workflow，升级后仍挂在群里等人点。两个键都认，老卡片才不会变成死按钮。
    const workflowAction = workflow && typeof workflow.dutydeck_workflow === 'string'
      ? workflow.dutydeck_workflow
      : workflow && typeof workflow.dockmux_workflow === 'string' ? workflow.dockmux_workflow : undefined;
    if (workflow && workflowAction !== undefined) {
      if (!this.workflows || !context?.messageId || !context.chatId || !this.reconcileConfig) return { type: 'error', content: '卡片身份不完整或已失效。' };
      const action = workflowAction;
      if (!['approve', 'reject', 'accept', 'changes', 'answer', 'allow_session'].includes(action)) return { type: 'error', content: '无法识别任务操作。' };
      // P0-1：overflow 菜单只承载唯一的回调选项（审批行的「拒绝」），其余点选一律拒绝，
      // 防止共用 behaviors.value 被误当成任意动作执行。
      if (context.actionTag === 'overflow' && !(action === 'reject' && context.option === 'reject')) {
        return { type: 'error', content: '该菜单不支持此操作。' };
      }
      try {
        const requestId = String(workflow.request_id ?? '');
        // 区分原审批卡回调与 /tasks 行内审批：后者记录的 cardId 是另一张审批卡，
        // 走斜杠形态（不做 cardId/generation 回调校验），但世代必须与渲染时一致。
        // 决议的一次性 CAS、liveness、授权仍全部由 respond 内部保证，不存在旁路。
        const record = (await this.workflows.list(this.reconcileConfig.appId)).find(item => item.id === requestId);
        const fromDashboard = !record?.cardId || record.cardId !== context.messageId;
        // 非原审批卡的回调只可能来自已登记的 /tasks 卡：行内按钮的 value 与原卡按钮同形，
        // 不验卡来源就等于接受任意 messageId 上的伪造回调。kv 在发送 /tasks 时持久化。
        if (fromDashboard) {
          const dashboardOrigin = await this.workflowOptions.store?.get(
            `lark.task_dashboard.${this.reconcileConfig.appId}.${context.messageId}`);
          if (!dashboardOrigin) return { type: 'error', content: '请在最新的审批卡片或 /tasks 卡片上操作。' };
        }
        if (fromDashboard && String(workflow.generation ?? '') !== record?.boot) {
          return { type: 'warning', content: '审批已失效，请刷新 /tasks 后重试。' };
        }
        let answer: { answer?: string; selected?: string[] } = {};
        if (action === 'answer') {
          if (workflow.multiple === true) {
            // 多选值由平台放在 form_value.answer（string[]）；容忍单值形态，过滤去重在 respond 内。
            const raw = (workflow.form_value as { answer?: unknown } | undefined)?.answer;
            answer = { selected: Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [] };
          } else {
            // 单选按钮直接带 answer；自由文本 input 的提交值在 form_value.answer。
            const formAnswer = (workflow.form_value as { answer?: unknown } | undefined)?.answer;
            answer = { answer: typeof workflow.answer === 'string' ? workflow.answer
              : typeof formAnswer === 'string' ? formAnswer : '' };
          }
        }
        const content = await this.workflows.respond({ appId: this.reconcileConfig.appId, chatId: context.chatId,
          actorId: operatorOpenId, requestId, action: action as 'answer' | 'approve' | 'reject' | 'accept' | 'changes' | 'allow_session',
          ...(fromDashboard ? {} : { cardId: context.messageId, generation: String(workflow.generation ?? ''), callback: true }),
          ...answer });
        if (action === 'accept' || action === 'changes') await this.refreshResultFeedback(this.reconcileConfig, requestId).catch(error => this.log.warn({ error }, '验收已记录，卡片刷新失败'));
        return { type: 'success', content };
      } catch (error) { return { type: 'error', content: error instanceof Error ? error.message : String(error) }; }
    }
    // 解析交给 card-actions.ts 的共享解析器：渲染端与回调端共用一套形状校验，
    // 不存在「一端认、另一端不认」的权限缝隙。同时兼容线上遗留的 {action, task_id}。
    const parsed = parseLarkCardActionValue(value);
    if (!parsed) return { type: 'error', content: '无法识别卡片操作' };
    // 结果卡续问行：任务从持久化映射取，不依赖内存里还有没有这条任务，重启后照样能点。
    if (parsed.action === 'ask_plain' || parsed.action === 'ask_reply' || parsed.action === 'ask_detail') return this.submitResultFollowUp(parsed, operatorOpenId, context);
    if (parsed.action === 'schedule_daily') return this.scheduleResultDaily(parsed, operatorOpenId, context);
    // 查看详情只读账本、不碰内存任务：重启后老卡片上的按钮同样可用。
    if (parsed.action === 'detail') return this.handleDetailLogin(operatorOpenId, context, parsed);
    const action = parsed.action;
    const taskId = parsed.taskId;
    if (action === 'run_in_new_session' || action === 'rerun_in_new_session') return this.relaunchCardAction(action, taskId, parsed.turn, operatorOpenId, context);
    if (action === 'replay_turn' || action === 'abandon_turn') return this.interruptedTurnAction(action, taskId, parsed.turn, operatorOpenId, context);
    if (action === 'continue_in_place') return this.continueInPlaceAction(taskId, parsed.turn, operatorOpenId, context);
    const task = this.tasks.get(taskId) ?? (action === 'cancel'
      ? await this.restoreQueuedCardAction(taskId, parsed.turn, context)
      : action === 'verify' || action === 'use_verification_command' ? await this.restoreVerifyCardAction(taskId, parsed.turn, context) : undefined);
    // 结果卡活过服务重启，「重试」回调却只在内存里找任务；/retry 和「重来」从持久化记录恢复原请求，重启后照样可用。
    if (!task) return { type: 'warning', content: action === 'retry' ? '这张卡上的「重试」已失效，请在原话题里说「重来」或发送 /retry 重新执行' : '此卡当前不可操作，请回原话题发送 /status 或 /cancel 查看和处理任务' };

    /**
     * 这次点击属于哪一轮。
     *
     * 卡片按钮带 turn；遗留卡片没有，按当前轮处理（旧行为）。之后的每个 await 都要重判：
     * 取消/中断是 detached 的，await runtime.interrupt / cancelQueued 期间用户可能已经
     * /retry 开了新一轮——那时 task 上的 state、events、requestUpdate 都属于新一轮，
     * 旧点击的续跑再写就会把新一轮打回 interrupted、或把旧错误推进新卡。
     */
    const actionTurn = parsed.turn ?? task.turn ?? 0;
    const actionStale = () => (task.turn ?? 0) !== actionTurn;
    if (actionStale()) return { type: 'warning', content: '任务已开始新一轮，请在最新的卡片上操作' };

    // 中断按钮单独校验发起人/管理员；其他操作沿用机器人访问权限。
    const currentConfig = this.workflowOptions.store ? await readLarkConfig(this.workflowOptions.store, task.config.appId) : task.config;
    if (!currentConfig || (this.workflowOptions.store && !currentConfig.listening)) return { type: 'warning', content: '机器人已停用，无法执行此操作' };
    const effectiveConfig = task.event.chatType === 'group' && this.groupManager ? await this.groupManager.resolved(currentConfig, task.event.chatId) : currentConfig;
    const allowed = action === 'interrupt'
      ? await this.isInterruptOperatorAllowed(effectiveConfig, operatorOpenId, task.event.chatId, task.sessionId, task.event.senderOpenId)
      : await this.isOperatorAllowed(effectiveConfig, operatorOpenId, task.event.chatId, task.sessionId, task.event.senderOpenId);
    // 拒绝说明写真实原因：点的是别人的任务时是「只有发起人和管理员能操作」，只有白名单挡住时才说白名单。
    if (!allowed) {
      return { type: 'warning', content: action === 'interrupt'
        ? this.requesterOnlyReason(effectiveConfig, task.event.senderOpenId, '中断正在执行的这一轮', true)
        : operatorOpenId && operatorOpenId !== task.event.senderOpenId
          && (effectiveConfig.managedGroup || await this.isStaticOperatorAllowed(effectiveConfig, operatorOpenId, task.event.chatId))
          ? this.requesterOnlyReason(effectiveConfig, task.event.senderOpenId, '操作这条任务')
          : '当前账号不在机器人白名单中，无法执行此操作' };
    }
    // 鉴权本身是异步的，期间同样可能翻页。
    if (actionStale()) return { type: 'warning', content: '任务已开始新一轮，请在最新的卡片上操作' };

    // 刷新：卡片心跳受频率限制（含 per-app 限流），用户看到的可能是滞后画面。
    // 这里强制重绘一次当前状态，不改变任务状态机，因此对终态卡片无意义（按钮也不渲染）。
    if (action === 'refresh') {
      if (!isLarkCardActionAvailable('refresh', {
        state: task.state, taskId: task.id, turn: task.turn,
        ...(task.retryable !== undefined ? { retryable: task.retryable } : {}),
        capabilities: this.capabilitiesForTask(task)
      })) {
        return { type: 'warning', content: '当前状态无法刷新，任务已结束或心跳已停止' };
      }
      try {
        await task.requestUpdate?.(task.state === 'queued' ? 'queued' : 'running', false);
        return { type: 'success', content: '已拉取最新状态' };
      } catch (error) {
        this.log.warn({ error, taskId }, '刷新飞书卡片失败');
        return { type: 'error', content: '刷新失败，请稍后重试或前往 Dutydeck Web 查看' };
      }
    }

    // 排队卡的「中断当前这一轮，先做这条」「插进当前这一轮」：与 /steer 同一段逻辑，只是分别只做提升或只做插话。
    // 按钮可用与否按此刻的队列重算（与渲染同一个判断）；会动正在执行的那一轮，所以另过一道中断门。
    // 插话可能要等 Agent 回应，超出卡片回调时限：门禁同步走完，执行放后台，结果写回这张排队卡。
    if (action === 'steer_promote' || action === 'steer_inject') {
      const sessionId = task.sessionId;
      const runtimeTaskId = task.runtimeTaskId;
      if (!sessionId || !runtimeTaskId || !isLarkCardActionAvailable(action, {
        state: task.state, taskId: task.id, turn: task.turn,
        capabilities: { ...this.capabilitiesForTask(task), ...(await this.queuedSteerCapabilities(task)) }
      })) {
        return { type: 'warning', content: '这条已不在紧挨着当前这一轮的位置，无法插队；请发送 /status 查看最新状态' };
      }
      const actor = { ...task.event, senderOpenId: operatorOpenId };
      const denial = await this.currentTurnInterruptDenial(effectiveConfig, actor, sessionId);
      if (denial) return { type: 'warning', content: denial };
      void (async () => {
        const steering = await this.steerQueuedTurn(effectiveConfig, actor, sessionId, { id: runtimeTaskId, status: 'queued' }, action === 'steer_inject' ? 'inject' : 'promote')
          .catch(error => { this.log.warn({ error, taskId }, '排队卡插队失败'); return { steered: undefined, note: '插队没有成功：这条内容按正常顺序排队。' }; });
        if (actionStale()) return;
        if (steering.steered) task.steered = steering.steered;
        task.steerNote = steering.note;
        if (action === 'steer_promote') task.promoted = true;
        await task.requestUpdate?.(task.state === 'running' ? 'running' : 'queued').catch(() => undefined);
      })();
      return { type: 'success', content: action === 'steer_inject' ? '正在把这条插进当前这一轮' : '正在把这条提到队首' };
    }

    // 使用推断出的验证命令：只把命令存进机器人配置并重绘这张卡，卡上已交付的结论不变。
    // 命令取自落库的卡片入参，不信回调里的值；改机器人配置按 channel_bot.update 再判一次权限。
    if (action === 'use_verification_command') {
      const command = (await this.verificationView(task, effectiveConfig, task.state)).capabilities.verificationSuggestion;
      if (!command) return { type: 'warning', content: '这个机器人已经配置了验证命令，或这张卡没有可用的候选命令。' };
      if (!await this.isOperatorAllowed(effectiveConfig, operatorOpenId, task.event.chatId, task.sessionId, task.event.senderOpenId, 'channel_bot.update')) {
        return { type: 'warning', content: '当前账号没有修改机器人配置的权限。' };
      }
      try {
        await saveLarkConfig(this.workflowOptions.store, undefined, { originalAppId: currentConfig.appId, expectedRevision: currentConfig.revision ?? 1, verificationCommand: command });
      } catch (error) {
        this.log.warn({ error, taskId }, '保存验证命令失败');
        return { type: 'error', content: '保存失败：机器人配置可能刚被修改过，请稍后重试或在 Web 端配置。' };
      }
      void this.refreshResultVerification(task, { ...effectiveConfig, verificationCommand: command })
        .catch(error => this.log.warn({ error, taskId }, '验证命令已保存，结果卡未能更新'));
      return { type: 'success', content: '已保存验证命令，之后改了代码会自动验证。' };
    }

    // 运行验证：只读收据上唯一允许的操作。它在工作目录执行管理员配置的验证命令，
    // 新增一条带退出码与代码指纹的独立记录，卡上已交付的结论一个字都不改。
    // 命令必然超出卡片回调 3 秒 SLA，所以门禁同步走完、执行放后台，完成后重绘同一张卡。
    if (action === 'verify') {
      // 与渲染端同一个判断：verificationView 内部就走 isLarkCardActionAvailable，
      // 所以「界面上出现的按钮」与「后端接受的回调」严格等价，不存在死按钮也不存在旁路。
      if (!(await this.verificationView(task, effectiveConfig, task.state)).canRun) {
        return { type: 'warning', content: '当前没有可运行的验证命令，或这份验证记录已能证明当前代码。' };
      }
      if (this.verifyInFlight.has(task.id)) {
        return { type: 'warning', content: '验证正在执行中，完成后会更新这张卡片，请勿重复点击。' };
      }
      this.verifyInFlight.add(task.id);
      const command = effectiveConfig.verificationCommand!.trim();
      void (async () => {
        // 带上点击人：管理群的执行授权要求验证有可核验的发起人。
        try { await this.runtime.runVerification!(task.sessionId!, { command }, operatorOpenId); }
        catch (error) { this.log.warn({ error, taskId: task.id }, '运行验证失败，卡片按最新记录呈现'); }
        finally {
          // 先把卡刷成最新结论再放开重入：否则这段空档里的第二次点击会再起一个真实进程。
          await this.refreshResultVerification(task, effectiveConfig)
            .catch(error => this.log.warn({ error, taskId: task.id }, '验证结果未能更新到结果卡'));
          this.verifyInFlight.delete(task.id);
        }
      })();
      return { type: 'success', content: '已开始运行验证，完成后会更新这张卡片。' };
    }

    // 旧版排队卡片会发 interrupt，仍按安全的单轮次取消处理，不中断当前运行任务。
    // P0-1：有权限取消/中断/重试他人发起的任务时，要求二次点击确认。
    // 键绑定 操作人+任务+轮次+动作，60 秒内同一按钮第二次点击才真正执行，过期需重新确认。
    if (operatorOpenId && task.event.senderOpenId && operatorOpenId !== task.event.senderOpenId
      && (action === 'cancel' || action === 'interrupt' || action === 'retry')) {
      const now = Date.now();
      for (const [key, expiresAt] of this.foreignActionConfirmations) {
        if (expiresAt <= now) this.foreignActionConfirmations.delete(key);
      }
      const confirmationKey = `${operatorOpenId}|${taskId}|${actionTurn}|${action}`;
      if ((this.foreignActionConfirmations.get(confirmationKey) ?? 0) > now) {
        this.foreignActionConfirmations.delete(confirmationKey);
      } else {
        this.foreignActionConfirmations.set(confirmationKey, now + 60_000);
        return { type: 'warning', content: '该任务由他人发起，再次点击同一按钮以确认操作' };
      }
    }

    if (action === 'cancel' || (action === 'interrupt' && task.state === 'queued')) {
      if (task.state !== 'queued') return { type: 'warning', content: '任务已不在排队中' };
      if (!task.sessionId || !task.runtimeTaskId || !this.runtime.cancelQueued) return { type: 'warning', content: '排队任务当前不可取消' };
      task.state = 'interrupting';
      const sessionId = task.sessionId;
      const runtimeTaskId = task.runtimeTaskId;
      const cancelQueued = this.runtime.cancelQueued.bind(this.runtime);
      void (async () => {
        try {
          await cancelQueued(sessionId, runtimeTaskId, operatorOpenId);
          // 取消这一轮的排队期间可能已经 /retry 开了新一轮：旧点击不得改写新一轮状态，
          // 也不得触发新卡重绘。这一轮的实际终态由它自己的事件流负责。
          if (actionStale()) {
            this.log.info({ taskId, turn: actionTurn }, '排队取消完成时任务已进入新一轮，跳过旧轮次的状态改写');
            return;
          }
          task.state = 'cancelled';
          await task.requestUpdate?.('cancelled', false);
        } catch (error) {
          // 排队任务可能在点击时已转为运行态；绝不回退中断 Session，交由任务事件流对账实际状态。
          this.log.warn({ error, taskId, sessionId, runtimeTaskId }, '取消飞书排队任务失败');
          if (actionStale()) return;
          if (task.state === 'interrupting') task.state = 'queued';
          this.pushTaskError(task, `取消排队任务失败：${error instanceof Error ? error.message : String(error)}`);
          await task.requestUpdate?.(task.state === 'running' ? 'running' : 'queued', false).catch(() => undefined);
        }
      })();
      return { type: 'success', content: '正在取消排队任务' };
    }

    if (action === 'interrupt') {
      if (!task.sessionId || task.state !== 'running') return { type: 'warning', content: '任务当前不可中断' };
      const runtimeTaskId = task.runtimeTaskId;
      if (this.runtime.dispatch && !runtimeTaskId) return { type: 'warning', content: '任务尚未完成接收，请稍后再试' };
      task.state = 'interrupting';
      task.interruptRequested = true;
      const sessionId = task.sessionId;
      void (async () => {
        try {
          if (runtimeTaskId) await this.runtime.interrupt(sessionId, runtimeTaskId, operatorOpenId);
          else await this.runtime.interrupt(sessionId, undefined, operatorOpenId);
          // 中断返回时可能已经 /retry：新一轮正在跑，旧点击不能把它标成 interrupted。
          if (actionStale()) {
            this.log.info({ taskId, turn: actionTurn }, '中断完成时任务已进入新一轮，跳过旧轮次的状态改写');
            return;
          }
          // The signal is only an intent. Runtime's task event supplies the
          // confirmed terminal state; do not publish a cancellation receipt yet.
          await task.requestUpdate?.('running', false);
        } catch (error) {
          this.log.warn({ error, taskId, sessionId }, '中断飞书任务失败');
          if (actionStale()) return;
          task.state = 'running';
          task.interruptRequested = false;
          this.pushTaskError(task, `中断任务失败：${error instanceof Error ? error.message : String(error)}`);
          await task.requestUpdate?.('running', false).catch(() => undefined);
        }
      })();
      return { type: 'success', content: '正在取消任务' };
    }

    if (action === 'retry') {
      if (task.state !== 'failed' && task.state !== 'interrupted' && task.state !== 'cancelled') return { type: 'warning', content: '只有失败、已中断或已取消的任务可以重试' };
      if (!operatorOpenId) return { type: 'warning', content: '缺少操作人身份，无法重试' };
      const retryEvent = { ...task.event, senderOpenId: operatorOpenId, senderType: 'user', senderAppId: undefined };
      const previousState = task.state;
      task.state = 'queued';
      try {
        if (task.inbox) await this.inbox!.update(task.inbox, { event: retryEvent, state: 'received', turn: task.turn + 1, cardId: undefined, taskId: undefined, materials: undefined,
          ...(task.inbox.request ? { request: { ...task.inbox.request, materialPrompt: task.retryMaterialPrompt ?? task.prompt } } : {}) });
      } catch (error) {
        if (!actionStale()) task.state = previousState;
        return { type: 'warning', content: error instanceof Error ? error.message : '重试记录保存失败，请稍后重试' };
      }
      if (actionStale()) return { type: 'warning', content: '任务已开始新一轮，请在最新的卡片上操作' };
      task.event = retryEvent;
      task.config = effectiveConfig;
      // 生命周期字段在 runTurn 递增 turn 后再重置，避免上一轮在途的
      // 过程更新或结果发送把旧消息 ID 写进新一轮。
      task.group.tail = task.group.tail.then(() => this.runTurn(task)).catch(error => {
        this.log.error({ error, chatId: task.event.chatId, messageId: task.event.messageId }, '重试飞书任务失败');
        this.pushTaskError(task, `重试任务失败：${error instanceof Error ? error.message : String(error)}`);
        task.state = 'failed';
        task.requestUpdate?.('failed', false).catch(() => undefined);
      });
      return { type: 'success', content: '已开始重试' };
    }

    return { type: 'error', content: '不支持的卡片操作' };
  }
}
