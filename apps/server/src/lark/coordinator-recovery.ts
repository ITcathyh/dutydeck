import { randomUUID } from 'node:crypto';
import { describeLarkTaskRecovery, larkRecoveryRetainedNote } from './task-recovery.js';
import type { LarkInboxRecord } from './task-inbox.js';
import type { LarkLaunchOptions } from './new-session.js';
import type { AgentEvent, ChannelMapping, Session, TaskRecord } from '@dutydeck/shared';
import { larkPermissionMode, readLarkConfig, type StoredLarkConfig } from './config.js';
import { larkPendingVerificationKey, parseLarkPendingVerifications } from './auto-verification.js';
import { LarkServiceError } from './service.js';
import { eventsForRuntimeTask } from './card-renderer.js';
import { performLarkCardReconcile, type LarkInterruptedTurn } from './reconciler.js';
import {
  isRestartInterruption,
  larkHeldWebNote,
  larkLastActivityAt,
  larkRedispatchedCardMarkdown,
  larkRedispatchLimit,
  larkRedispatchMaxAgeMs,
  larkRedispatchWebNote,
  larkReplayUnsafeReason,
  type LarkHeldCause
} from './turn-redispatch.js';
import { isLarkCardActionAvailable, larkRelaunchLabels, type LarkCardActionState } from './card-actions.js';
import { larkGroupKey, listPersistedLarkSessions, resolveLarkSession } from './session-resolver.js';
import type { LarkMessageEvent } from './listener.js';
import type { LarkGroup, LarkTask, PersistedLarkCardTask } from './coordinator.js';
import { larkCardChannel, type LarkRelaunchAction, type LarkRelaunchClaim, relaunchRetainedKey, larkScopeContinuesFor, sendTaskCard } from './coordinator-core.js';
import { LarkCoordinatorCards } from './coordinator-cards.js';

// 飞书消息协调器 · 恢复与对账：卡片终态对账、重启后收尾自动验证、从持久化的卡片映射恢复卡上操作、
// 「在新会话中执行」的转交，以及服务重启切断那一轮的重投。

const redispatchKey = (appId: string, taskId: string, turn: number) => `lark.redispatch.${appId}.${taskId}.${turn}`;
/** 与 `dutydeck recovery` 同一个身份：重投前把旧一轮记为结果未知是安装者级的账本决定。 */
const larkRecoveryOwner = { kind: 'installation_owner', id: 'installation_owner' } as const;

export abstract class LarkCoordinatorRecovery extends LarkCoordinatorCards {
  private async reconciledResult(mapping: { externalId: string; sessionId: string }, saved: PersistedLarkCardTask, cardId: string) {
    if (!this.workflows || !saved.sender_open_id || !saved.runtime_task_id || !saved.turn) return [];
    return this.workflows.result({ appId: saved.app_id, sessionId: mapping.sessionId, taskId: saved.runtime_task_id, turn: saved.turn,
      event: { messageId: mapping.externalId, chatId: saved.chat_id, chatType: saved.chat_type ?? 'group', senderOpenId: saved.sender_open_id,
        threadId: saved.thread_id, messageType: 'text', content: JSON.stringify({ text: saved.prompt }), mentions: [] } }, cardId, saved.final_attachment_message_id ? [saved.final_attachment_message_id] : undefined);
  }

  private async performReconcile(config: StoredLarkConfig) {
    if (!this.cardMappings) return 0;
    let unresolved = await performLarkCardReconcile({
      runtime: this.runtime,
      service: this.service,
      cardMappings: this.cardMappings,
      log: this.log,
      config,
      channel: larkCardChannel(config.appId),
      deliveryStore: this.workflowOptions.store,
      relaunchReady: (taskId, status, turn) => this.relaunchReady(config.appId, taskId, status, turn),
      interruptedTurn: (mapping, saved, runtimeTask) => this.redispatchInterruptedTurn(config, mapping, saved, runtimeTask),
      ...(this.workflowOptions.loginLinks ? { detailLogin: true } : {}),
      // 呈现开关可以按群覆盖，对账必须按记录所属会话解析后再决定怎么补发，
      // 否则重启后群里的静默/只贴表情配置全部失效。解析失败退回 Bot 级配置。
      resolveConfig: async saved => {
        if (saved.chat_type !== 'group' || !this.groupManager) return config;
        try { return await this.groupManager.resolved(config, saved.chat_id); }
        catch (error) {
          this.log.warn({ error, chatId: saved.chat_id }, '对账解析群级呈现配置失败，按 Bot 级配置补发');
          return config;
        }
      },
      resultElements: (mapping, saved, cardId) => this.reconciledResult(mapping, saved, cardId),
      terminalDecoration: async (mapping, saved, effective) => {
        const restored = this.restoredCardTask(effective, mapping, saved);
        const verification = await this.verificationView(restored, effective, saved.state as LarkCardActionState);
        return { elements: verification.element ? [verification.element] : [],
          cardInput: { capabilities: { ...this.capabilitiesForTask(restored), ...verification.capabilities, ...await this.resultActionCapabilities(restored, effective, saved.state) } } };
      }
    });
    unresolved += await this.workflows?.reconcile(config.appId) ?? 0;
    for (const record of await this.workflows?.list(config.appId) ?? []) {
      if (record.kind !== 'result' || !['accepted', 'needs_changes'].includes(record.state)) continue;
      try { await this.refreshResultFeedback(config, record.id); }
      catch (error) { unresolved++; this.log.warn({ error, requestId: record.id }, '验收状态刷新待重试'); }
    }
    return unresolved;
  }

  reconcile(config: StoredLarkConfig) {
    this.reconcileConfig = config;
    if (this.reconcileRun) return this.reconcileRun;
    const run = this.performReconcile(config).finally(() => {
      if (this.reconcileRun === run) this.reconcileRun = undefined;
    });
    this.reconcileRun = run;
    return run;
  }

  protected scheduleReconcile() {
    if (this.stopped || this.reconcileTimer || !this.reconcileConfig) return;
    this.reconcileTimer = setTimeout(() => {
      this.reconcileTimer = undefined;
      const config = this.reconcileConfig;
      if (!config || this.stopped) return;
      void this.reconcile(config).then(unresolved => {
        if (unresolved > 0) this.scheduleReconcile();
      }).catch(error => {
        this.log.warn({ error, appId: config.appId }, '飞书卡片周期对账失败，稍后重试');
        this.scheduleReconcile();
      });
    }, this.reconcileIntervalMs);
    this.reconcileTimer.unref();
  }

  async startReconciliation(config: StoredLarkConfig, intervalMs = 5_000) {
    this.reconcileConfig = config;
    this.applyReminderSettings(config);
    this.reconcileIntervalMs = Math.max(50, intervalMs);
    if (this.reconcileTimer) { clearTimeout(this.reconcileTimer); this.reconcileTimer = undefined; }
    // 僵尸置顶的唯一收敛点：崩在长任务中间的置顶卡只有启动对账能撤下来。
    // 与开关无关——把开关关掉的人期待的正是「以前置顶的都撤掉」。
    await this.pins?.reconcile({ appId: config.appId, activeTaskIds: [...this.tasks.keys()] })
      .catch(error => this.log.warn({ error, appId: config.appId }, '飞书置顶对账失败，不影响任务执行'));
    this.scheduleTaskAgentPoll(config);
    const unresolved = await this.reconcile(config);
    if (unresolved > 0) this.scheduleReconcile();
    return unresolved;
  }

  /**
   * 上一个进程退出时还在「验证执行中」（或刚被打断、没来得及重绘）的结果卡：运行时已把那条验证记录记为中断
   * （或还没来得及落记录），不会再有进程回来重绘这些卡。这里把进展改成「验证被中断」并重绘，卡上随之给出「运行验证」。
   * 旧进程其实已经验证完、只是没来得及重绘的，去掉进展，卡片按那条记录呈现。重绘过的移出待收尾。
   */
  protected async recoverAutoVerifications(config: StoredLarkConfig) {
    const store = this.workflowOptions.store;
    if (!store || !this.cardMappings) return;
    const settled = new Set<string>();
    for (const entry of parseLarkPendingVerifications(await store.get(larkPendingVerificationKey(config.appId)))) {
      const running = entry.running;
      if (!running || running.boot === this.relaunchBoot) continue;
      try {
        const mapping = await this.cardMappings.get(larkCardChannel(config.appId), entry.task_id);
        const latest = mapping ? (await this.runtime.getVerifications?.(mapping.sessionId))?.[0] : undefined;
        // 运行时启动时已把上个进程遗留的执行中记录改成中断；还在执行中，说明是本进程换了监听，验证其实还在跑。
        if (latest?.status === 'running') continue;
        const saved = mapping?.extra ? JSON.parse(mapping.extra) as PersistedLarkCardTask : undefined;
        if (mapping && saved?.final_card_input && (saved.turn ?? 0) === running.turn) {
          const effective = saved.chat_type === 'group' && this.groupManager
            ? await this.groupManager.resolved(config, saved.chat_id).catch(() => config) : config;
          const task = this.restoredCardTask(effective, mapping, saved);
          const finished = latest && latest.id !== running.record_id && latest.status !== 'interrupted';
          task.autoVerification = finished ? undefined : { turn: running.turn, phase: 'interrupted', ...(latest ? { record_id: latest.id } : {}) };
          await this.refreshResultVerification(task, effective);
        }
        settled.add(entry.task_id);
      } catch (error) {
        this.log.warn({ error, taskId: entry.task_id }, '重启后收尾自动验证失败，结果卡等下次重绘');
      }
    }
    if (settled.size) await this.mutatePendingVerifications(config.appId, entries => entries.filter(item => !settled.has(item.task_id)));
  }

  protected async restoreQueuedCardAction(taskId: string, turn: number | undefined, context?: { messageId?: string; chatId?: string }): Promise<LarkTask | undefined> {
    const config = this.reconcileConfig;
    if (!config || !context?.messageId || !context.chatId) return;
    const mapping = await this.cardMappings?.get(larkCardChannel(config.appId), taskId);
    if (!mapping?.extra) return;
    const saved = JSON.parse(mapping.extra) as PersistedLarkCardTask;
    if (saved.app_id !== config.appId || saved.chat_id !== context.chatId || saved.card_message_id !== context.messageId
      || !saved.sender_open_id || !saved.runtime_task_id || (turn !== undefined && turn !== (saved.turn ?? 0))) return;
    const target = (await this.runtime.getTasks?.(mapping.sessionId))?.find(task => task.id === saved.runtime_task_id);
    if (target?.status !== 'queued') return;
    return { id: taskId, group: { tail: Promise.resolve() }, config, state: 'queued', turn: saved.turn ?? 0, epoch: 0,
      scopeId: saved.scope_id ?? '', prompt: saved.prompt, resources: [], events: [], sessionId: mapping.sessionId,
      runtimeTaskId: target.id, cardMessageId: saved.card_message_id, startedAt: saved.started_at,
      event: { messageId: taskId, chatId: saved.chat_id, chatType: saved.chat_type ?? 'group', messageType: 'text',
        content: '', mentions: [], senderOpenId: saved.sender_open_id, ...(saved.thread_id ? { threadId: saved.thread_id } : {}) },
      requestUpdate: async () => { await this.performReconcile(config); } };
  }

  /**
   * 结果卡是聊天记录里长期存在的收据，会活过守护进程；而回调只能在内存里找任务。
   * 「运行验证」是闭集里第一个画在这种卡上的操作，所以它必须能从持久化的卡片映射
   * 重建任务，否则重启后按钮还在、点了却只回一句和验证无关的提示——那正是死按钮。
   */
  protected async restoreVerifyCardAction(taskId: string, turn: number | undefined, context?: { messageId?: string; chatId?: string }): Promise<LarkTask | undefined> {
    const config = this.reconcileConfig;
    if (!config || !context?.messageId || !context.chatId) return;
    const mapping = await this.cardMappings?.get(larkCardChannel(config.appId), taskId);
    if (!mapping?.extra) return;
    const saved = JSON.parse(mapping.extra) as PersistedLarkCardTask;
    if (saved.app_id !== config.appId || saved.chat_id !== context.chatId || saved.final_message_id !== context.messageId
      || !saved.final_card_input || (turn !== undefined && turn !== (saved.turn ?? 0))) return;
    return this.restoredCardTask(config, { externalId: taskId, sessionId: mapping.sessionId }, saved);
  }

  /**
   * 「在新会话中执行 / 重新执行」的前置能力，渲染端（进度卡、对账）与回调端共用。
   * 只执行一次靠持久化认领与卡片映射 CAS，重放原请求靠入站记录；排队任务另需能取消。
   */
  private relaunchSupported(status: string) {
    return Boolean(this.inbox && this.workflowOptions.store?.compareAndSet && typeof this.cardMappings?.compareAndSetExtra === 'function'
      && this.runtime.getTasks && this.runtime.getTaskRecovery && (status !== 'queued' || this.runtime.cancelQueued));
  }

  /**
   * 转交的原任务、会话与原文，渲染端与回调端共用：卡上画出按钮的条件就是回调受理的条件。
   * 一律从卡片映射与入站记录读：映射要有原任务、原文和有人能续聊的 scope，入站记录要已受理、与映射同会话同群。
   * 旧版遗留任务、入站记录待对账的任务都不满足，卡上就不给按钮。
   */
  private async relaunchSource(appId: string, taskId: string, turn: number) {
    const mapping = await this.cardMappings?.get(larkCardChannel(appId), taskId);
    const saved = mapping?.extra ? JSON.parse(mapping.extra) as PersistedLarkCardTask : undefined;
    if (!mapping || !saved || saved.app_id !== appId || !saved.card_message_id || !saved.runtime_task_id || !saved.prompt?.trim()
      || !saved.scope_id || saved.scope_id.startsWith('message:') || (saved.turn ?? 0) !== turn) return undefined;
    const raw = await this.workflowOptions.store?.get(`lark.inbox.${appId}.${taskId}`);
    const inbox = raw ? JSON.parse(raw) as LarkInboxRecord : undefined;
    if (!inbox || inbox.state !== 'accepted' || inbox.sessionId !== mapping.sessionId || inbox.event.chatId !== saved.chat_id) return undefined;
    return { mapping, saved, inbox };
  }

  /** 渲染端：这张卡此刻能不能画转交按钮。读不到就不画，不因此打断心跳或对账。 */
  protected async relaunchReady(appId: string, taskId: string, status: string, turn: number) {
    return this.relaunchSupported(status) && Boolean(await this.relaunchSource(appId, taskId, turn).catch(() => undefined));
  }

  /**
   * 转交时要作废的会话：之前转交已保留给管理员的，或者有任务卡住的（执行资源未确认停止，或待核对且管理员还没核对）。
   * 资源阻塞是会话级的，查任意一条任务即可；待核对按任务逐条看。
   */
  protected async relaunchBlockedSession(appId: string, sessionId: string) {
    if (await this.workflowOptions.store!.get(relaunchRetainedKey(appId, sessionId))) return true;
    const tasks = await this.runtime.getTasks!(sessionId);
    for (const task of [tasks[0], ...tasks.filter(item => ['reconcile_required', 'legacy_unresolved'].includes(item.status))]) {
      if (task && (await describeLarkTaskRecovery(this.runtime, sessionId, task.id, task.status)).blocked) return true;
    }
    return false;
  }

  /**
   * 卡住的任务在新会话中执行（P0-1）。旧执行不在飞书里处理：旧会话、它的阻塞和待核对任务原样留给管理员；
   * 排队受阻的请求先取消（它从未开始执行），需要核对的任务不改状态，然后在同一话题新建会话执行原请求，
   * 之后话题续聊进入新会话。
   *
   * 回调值只用来定位 message_id 与轮次，任务、会话、原文一律从卡片映射与入站记录读取。
   * 回调要在 3 秒内返回：这里只做门禁与认领，转交本身由 performRelaunch 在后台完成。
   */
  protected async relaunchCardAction(action: LarkRelaunchAction, taskId: string, turn: number | undefined, operatorOpenId?: string,
    context?: { messageId?: string; chatId?: string }) {
    const store = this.workflowOptions.store;
    const appId = this.reconcileConfig?.appId;
    if (!operatorOpenId || !context?.messageId || !context.chatId || !appId || !store?.compareAndSet || !this.cardMappings || !this.inbox || turn === undefined) {
      return { type: 'warning', content: '此卡当前不可操作，请回原话题发送 /status 查看任务' };
    }
    try {
      const config = await readLarkConfig(store, appId);
      if (!config?.listening) return { type: 'warning', content: '机器人已停用，无法执行此操作' };
      const claimKey = `lark.relaunch.${appId}.${taskId}.${turn}`;
      const raw = await store.get(claimKey);
      const claim = raw ? JSON.parse(raw) as LarkRelaunchClaim : undefined;
      // 重复点击、重复投递、重启后的重复回调都落在这里：只回执，不会第二次执行。
      if (claim && (claim.phase === 'moved' || claim.phase === 'claimed' && claim.boot === this.relaunchBoot)) {
        if (claim.chatId !== context.chatId) return { type: 'warning', content: '此卡已失效，请在最新的任务卡上操作' };
        if (claim.phase === 'claimed') return { type: 'warning', content: '正在转到新会话，请勿重复点击' };
        // 旧卡上次没能更新时，由这次点击收尾。
        void this.markRelaunchedCard(config, claim).catch(error => this.log.warn({ error, taskId }, '旧任务卡未能更新为已转到新会话'));
        return { type: 'success', content: '已在新会话中执行，进度见话题里的新任务卡' };
      }
      // 与渲染端同一个判定：卡上画不出按钮的任务，这里也不受理。
      const source = await this.relaunchSource(appId, taskId, turn);
      if (!source || source.saved.chat_id !== context.chatId || source.saved.card_message_id !== context.messageId) {
        return { type: 'warning', content: '此卡已失效，请在最新的任务卡上操作' };
      }
      const { mapping, saved, inbox } = source;
      const oldTask = (await this.runtime.getTasks?.(mapping.sessionId))?.find(item => item.id === saved.runtime_task_id);
      if (!oldTask) return { type: 'warning', content: '原任务记录不存在，请重新发送这条请求' };
      // 上一次转交取消了排队任务之后才中断：认领还在，接着做完，而不是把用户挡在一个死按钮前。
      const alreadyCancelled = Boolean(claim) && action === 'run_in_new_session' && oldTask.status === 'cancelled';
      if (!alreadyCancelled) {
        // 与渲染端同一个判断：状态、阻塞与能力都按账本现读，卡上不会画的按钮，这里也不接受。
        const recovery = await describeLarkTaskRecovery(this.runtime, mapping.sessionId, oldTask.id, oldTask.status, undefined,
          { relaunch: this.relaunchSupported(oldTask.status) });
        if (!isLarkCardActionAvailable(action, { state: oldTask.status as LarkCardActionState, taskId, turn: saved.turn ?? 0,
          capabilities: { canCancelQueued: false, canInterrupt: false, canRetry: false, canRefresh: false, canRelaunch: recovery.relaunch } })) {
          return { type: 'warning', content: '这条任务现在不需要转到新会话，请发送 /status 查看最新状态' };
        }
      }
      // 按发送人隔离的会话只接发起人本人的消息（与续聊同一条规则）：别人既不能替发起人转交，也不能换成自己的身份在这个会话里执行原文。
      if (!larkScopeContinuesFor(saved.scope_id!, operatorOpenId)) {
        return { type: 'warning', content: '这个会话按发起人隔离，只有发起人本人可以转到新会话，未执行' };
      }
      const chatType = saved.chat_type ?? 'group';
      const effective = chatType === 'group' && this.groupManager ? await this.groupManager.resolved(config, saved.chat_id) : config;
      // 与「在这个话题里发一条新消息」同一套入口检查；托管群另需 /new 对当前会话的操作权，取消排队任务还要有取消权。
      if (!await this.currentAccess(effective, saved.chat_id, chatType, operatorOpenId, 'task.create', undefined, operatorOpenId)
        || effective.managedGroup && !await this.isOperatorAllowed(effective, operatorOpenId, saved.chat_id, mapping.sessionId)
        || action === 'run_in_new_session' && !alreadyCancelled
          && !await this.isOperatorAllowed(effective, operatorOpenId, saved.chat_id, mapping.sessionId, saved.sender_open_id)) {
        return { type: 'warning', content: '当前账号没有在这个话题发起任务的权限，未执行' };
      }
      await this.requireExecution('listener', 'task.create');
      await this.requireExecution('session', 'task.create');
      // 执行身份照重试，换成点击人。
      if (!this.foreignActionConfirmed(operatorOpenId, saved.sender_open_id, `${taskId}|${turn}|${action}`)) {
        return { type: 'warning', content: '该任务由他人发起，再次点击同一按钮以确认操作' };
      }
      const next: LarkRelaunchClaim = { id: randomUUID(), boot: this.relaunchBoot, phase: 'claimed', action, appId, taskId,
        turn, chatId: saved.chat_id, cardMessageId: context.messageId, taskName: saved.task_name,
        sessionId: mapping.sessionId, runtimeTaskId: oldTask.id, operatorOpenId };
      if (!await store.compareAndSet(claimKey, raw, JSON.stringify(next))) return { type: 'warning', content: '正在转到新会话，请勿重复点击' };
      this.performRelaunch(config, effective, claimKey, next, saved, inbox.event, alreadyCancelled);
      return { type: 'success', content: '正在转到新会话，话题里会出现新的任务卡' };
    } catch (error) {
      this.log.warn({ error, taskId, action }, '受理转到新会话失败');
      return { type: 'warning', content: error instanceof LarkServiceError ? error.message : '暂时无法转到新会话，请稍后重试' };
    }
  }

  /**
   * 转交的后台部分。顺序就是安全性：先建新会话，再取消旧排队任务，最后把原请求交给入站记录。
   * 新会话建不出来时旧任务一个字没动；入站记录接手之后，中途重启也由它按同一个派发幂等键续做。
   */
  private performRelaunch(config: StoredLarkConfig, effective: StoredLarkConfig, claimKey: string, claim: LarkRelaunchClaim,
    saved: PersistedLarkCardTask, event: LarkMessageEvent, alreadyCancelled: boolean) {
    const store = this.workflowOptions.store!;
    const scopeId = saved.scope_id!;
    const chatType = saved.chat_type ?? 'group';
    const groupKey = larkGroupKey(event, scopeId, claim.appId);
    const group = this.groups.get(groupKey) ?? { tail: Promise.resolve() };
    this.groups.set(groupKey, group);
    group.tail = group.tail.then(async () => {
      const retired = (group.retiredSessionIds ??= new Set());
      const previous = this.tasks.get(claim.taskId);
      // 在原会话重投：旧一轮已记为结果未知，原会话照常用，不作废任何会话。
      const resumed = claim.redispatch?.resumed === true;
      let retiring: string[] = [];
      const blocked = new Set(resumed ? [] : [claim.sessionId]);
      let session: Session | undefined;
      let created: Session | undefined;
      let inbox: LarkInboxRecord | undefined;
      let materialPrompt: string | undefined;
      let silenced = false;
      let cancelled = alreadyCancelled;
      try {
        // 对账按一轮开始时的快照工作：旧任务取消之后，它会把「已取消」补发成结果卡。
        // 先打标记、再等在途的那一轮对账结束，之后开始的对账都会跳过这一轮。
        // 重投由重投记录挡住对账，不打转交标记：半路重启时对账还要读得到这一轮，才能接着做完。
        if (!claim.redispatch) await this.setRelaunchPending(claim, true);
        await this.reconcileRun?.catch(() => undefined);
        // 只作废卡住的会话，且不停止它们：被阻塞的旧会话本来也停不下来。本话题里正常的会话
        // （例如上一次转交建出来的）照常复用，这条请求排在它已有的任务后面。
        const persisted = resumed ? [] : await listPersistedLarkSessions(this.runtime, effective, saved.chat_id, chatType, scopeId, this.cardMappings);
        for (const item of persisted) {
          if (!['failed', 'stopped'].includes(item.state) && !retired.has(item.id) && await this.relaunchBlockedSession(claim.appId, item.id)) blocked.add(item.id);
        }
        retiring = [...blocked].filter(id => !retired.has(id));
        for (const id of retiring) retired.add(id);
        if (group.sessionId && retired.has(group.sessionId)) { group.sessionId = undefined; group.sessionConfigKey = undefined; }
        const bound = group.sessionId;
        session = resumed ? await this.runtime.getSession(claim.sessionId) : await this.sessionFor(group, effective, saved.chat_id, chatType, scopeId);
        if (!session) throw new Error('原会话已不存在。');
        if (!resumed && session.id !== bound && !persisted.some(item => item.id === session!.id)) created = session;
        const raw = await store.get(`lark.inbox.${claim.appId}.${claim.taskId}`);
        inbox = raw ? await this.inbox!.adoptAccepted(JSON.parse(raw) as LarkInboxRecord) : undefined;
        if (!inbox) throw new Error('原请求记录已被其他流程接手。');
        // 旧轮次的订阅与心跳就此作废：取消事件回来时，不能再给旧卡补一张「已取消」。
        if (previous) { previous.turn += 1; silenced = true; }
        if (claim.action === 'run_in_new_session' && !cancelled) {
          await this.runtime.cancelQueued!(claim.sessionId, claim.runtimeTaskId, claim.operatorOpenId);
          cancelled = true;
        }
        // 以点击人身份重新发起，与 /new -- <原文> 一致：不沿用原会话的首轮参数，上下文按新会话重新读取。
        // 自动重投没有点击人，沿用原请求的身份；在原会话重投时原样交回上一轮给 Agent 的材料。
        const relaunchEvent = claim.redispatch?.auto ? inbox.event : { ...inbox.event, senderOpenId: claim.operatorOpenId, senderType: 'user', senderAppId: undefined };
        materialPrompt = resumed ? saved.retry_material_prompt : undefined;
        await this.inbox!.update(inbox, { event: relaunchEvent, state: 'received', turn: claim.turn + 1, sessionId: session.id,
          cardId: undefined, taskId: undefined, materials: undefined,
          redispatch: claim.redispatch && { count: claim.redispatch.count, resumed, auto: claim.redispatch.auto },
          request: { prompt: saved.prompt, scopeId, resources: inbox.request?.resources ?? [], ...(materialPrompt ? { materialPrompt } : {}) } });
      } catch (error) {
        this.log.warn({ error, taskId: claim.taskId }, '转到新会话失败，已回滚');
        if (!cancelled) {
          // 旧任务没动：收走这次新建的会话（复用的已有会话照常留着），话题照旧回到原来的会话，旧轮次恢复接收事件。
          const unused = created;
          if (unused) {
            retired.add(unused.id);
            if (group.sessionId === unused.id) { group.sessionId = undefined; group.sessionConfigKey = undefined; }
            void Promise.resolve(this.runtime.stop?.(unused.id, { kind: 'channel', id: claim.operatorOpenId, appId: claim.appId }))
              .catch(stopError => this.log.warn({ error: stopError, sessionId: unused.id }, '停止未用上的新会话失败'));
          }
          for (const id of retiring) retired.delete(id);
          if (silenced) previous!.turn -= 1;
        }
        // 原排队请求已取消时留着转交标记：对账不会把旧卡改成「已取消」，旧卡上的按钮再点一次就接着做完。
        if (!cancelled) await this.setRelaunchPending(claim, false).catch(() => undefined);
        await store.compareAndSet!(claimKey, JSON.stringify(claim), JSON.stringify({ ...claim, phase: 'failed' })).catch(() => undefined);
        const reason = error instanceof Error ? error.message : String(error);
        await sendTaskCard(this.service, event, {
          state: 'failed', readOnly: true, retryable: false, taskId: claim.taskId, taskName: claim.redispatch ? '重投没有成功' : '未能在新会话中执行',
          markdown: claim.redispatch
            ? `**服务重启后重投没有成功。**\n\n${reason}\n\n这一轮的执行结果仍未知，可以发送 \`/status\` 查看任务，或重新发送这条请求。`
            : `${cancelled ? '**原排队请求已取消，但新会话没有开始执行。**' : '**未能在新会话中执行，原任务没有改动。**'}\n\n${reason}\n\n`
            + `可以稍后在原任务卡上再点一次「${larkRelaunchLabels[claim.action]}」，或发送 \`/status\` 查看任务。`,
          idempotencyKey: `relaunch_failed_${claim.id}`.slice(0, 50),
          ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {})
        }, this.log).catch(sendError => this.log.warn({ error: sendError, taskId: claim.taskId }, '发送转到新会话失败回执失败'));
        return;
      }
      // 旧会话保留给管理员核对：之后 /new 不去停它，再次转交也不选回它。
      for (const id of blocked) {
        await store.set(relaunchRetainedKey(claim.appId, id), JSON.stringify({ task_id: claim.taskId, new_session_id: session.id }))
          .catch(error => this.log.warn({ error, sessionId: id }, '旧会话的保留标记未能落库'));
      }
      const moved: LarkRelaunchClaim = { ...claim, phase: 'moved', newSessionId: session.id };
      if (!await store.compareAndSet!(claimKey, JSON.stringify(claim), JSON.stringify(moved))) {
        this.log.warn({ taskId: claim.taskId }, '转到新会话的认领记录未能更新，入站记录已接手执行');
      }
      await this.markRelaunchedCard(config, moved).catch(error => this.log.warn({ error, taskId: claim.taskId }, '旧任务卡未能更新为已转到新会话，下次点击时收尾'));
      const task: LarkTask = { id: claim.taskId, group, event: inbox.event, prompt: saved.prompt, resources: inbox.request?.resources ?? [], inbox,
        config: effective, state: 'queued', events: [], turn: claim.turn, scopeId, epoch: group.epoch ?? 0,
        ...(inbox.redispatch ? { redispatch: inbox.redispatch } : {}), ...(materialPrompt ? { retryMaterialPrompt: materialPrompt } : {}) };
      this.tasks.delete(task.id);
      this.tasks.set(task.id, task);
      await this.runTurn(task);
    }).catch(error => this.log.error({ error, taskId: claim.taskId }, '在新会话中执行原请求失败'));
  }

  /** 在这一轮的卡片映射上打上/撤掉「正在转到新会话」。只动同一轮：新一轮落库会整行替换，标记随之消失。 */
  private async setRelaunchPending(claim: LarkRelaunchClaim, pending: boolean) {
    const channel = larkCardChannel(claim.appId);
    for (let attempt = 0; attempt < 5; attempt++) {
      const current = await this.cardMappings!.get(channel, claim.taskId);
      const saved = current?.extra ? JSON.parse(current.extra) as PersistedLarkCardTask : undefined;
      if (!current || !saved || (saved.turn ?? 0) !== claim.turn || Boolean(saved.relaunch_pending) === pending) return;
      const next: PersistedLarkCardTask = { ...saved };
      if (pending) next.relaunch_pending = true;
      else delete next.relaunch_pending;
      if (await this.cardMappings!.compareAndSetExtra(current.id, current.extra, JSON.stringify(next))) return;
    }
    throw new Error('卡片映射并发写冲突，未能标记转到新会话。');
  }

  /**
   * 旧卡收尾：写明已转到新会话并去掉按钮。页脚详情仍指向原会话，那里留着给管理员核对的原任务。
   * 重启切断那一轮的重投与放弃也在这里收尾；静默进展下没有过程卡，无卡可改。
   */
  private async markRelaunchedCard(config: StoredLarkConfig, claim: LarkRelaunchClaim) {
    if (!claim.cardMessageId) return;
    const rerun = claim.action === 'rerun_in_new_session';
    const label = claim.phase === 'abandoned' ? '已放弃' : claim.redispatch ? '结果未知' : rerun ? '已在新会话中重新执行' : '已在新会话中执行';
    const detail = rerun
      ? '原任务的执行结果仍未确认；原请求已在本话题的新会话中重新执行'
      : '这条请求没有在原会话执行：排队任务已取消，原文已在本话题的新会话中提交';
    const webBaseUrl = config.webBaseUrl?.trim().replace(/\/$/, '');
    await this.service.update({
      cardKind: 'process', messageId: claim.cardMessageId, taskId: claim.taskId, taskName: claim.taskName, turn: claim.turn,
      sessionId: claim.sessionId, state: rerun ? 'reconcile_required' : 'cancelled', statusLabel: label, readOnly: true,
      // 页脚「查看详情」与 capabilitiesForTask 一致：要求登录时是登录回调，否则是直链；两者都指向原会话。
      capabilities: { canCancelQueued: false, canInterrupt: false, canRetry: false, canRefresh: false,
        ...(webBaseUrl ? { webUrl: `${webBaseUrl}/sessions/${encodeURIComponent(claim.sessionId)}` } : {}),
        ...(this.workflowOptions.loginLinks ? { detailLogin: true } : {}) },
      agentName: await this.resolveAgentName(config), permissionMode: larkPermissionMode(config),
      ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}),
      markdown: claim.phase === 'abandoned' ? `**${label}**\n\n这一轮不再执行，执行结果仍未知。\n\n${larkRecoveryRetainedNote(config.webBaseUrl)}`
        : claim.redispatch ? larkRedispatchedCardMarkdown(claim.redispatch, larkRecoveryRetainedNote(config.webBaseUrl))
        : `**${label}**\n\n${detail}，进度见新的任务卡；之后本话题的消息也进入新会话。\n\n${larkRecoveryRetainedNote(config.webBaseUrl)}`
    });
  }

  /**
   * 服务重启切断的一轮（原因码为结果未知）：对账遇到「需要核对」的一轮先问这里。
   *
   * - 原执行进程没确认停止（会话有资源阻塞或停止阻塞）时它可能还在跑：不重投，照旧留给人核对。
   * - 这一轮已记录的操作里有可能对外生效的（replay_unsafe）、最后一次活动距今超过 larkRedispatchMaxAgeMs（或取不到时间），
   *   或已自动重投满 larkRedispatchLimit 次：停下，卡上给「重新执行」「放弃」。
   * - 其余自动从入站记录重投：原会话还在就把旧一轮记为结果未知、在原会话续做；原会话已结束则走转交流程开新会话。
   *
   * 重投记录按 App + 原消息 + 轮次落库（redispatchKey），并发的对账、重启后的对账与按钮点击读到的都是这一条。
   */
  private async redispatchInterruptedTurn(config: StoredLarkConfig, mapping: ChannelMapping, saved: PersistedLarkCardTask, runtimeTask: TaskRecord): Promise<LarkInterruptedTurn | undefined> {
    const store = this.workflowOptions.store;
    if (!store?.compareAndSet || !this.inbox || !this.runtime.inspectExecutionRecovery || !this.runtime.confirmExecutionRecovery || !this.runtime.getEvents) return undefined;
    const turn = saved.turn ?? 0;
    const key = redispatchKey(config.appId, mapping.externalId, turn);
    const raw = await store.get(key);
    const record = raw ? JSON.parse(raw) as LarkRelaunchClaim : undefined;
    if (record?.phase === 'held') return { kind: 'hold', ...record.redispatch! };
    if (record?.phase === 'failed') return undefined;
    if (record?.phase === 'claimed' && record.boot !== this.relaunchBoot) {
      // 上一个进程半路退出：入站记录还停在这一轮就由本进程接着做完；已经交出去的，由它的重放接着执行。
      const inbox = await this.redispatchInbox(config.appId, mapping, saved);
      const next: LarkRelaunchClaim = inbox ? { ...record, boot: this.relaunchBoot } : { ...record, phase: 'moved' };
      if (await store.compareAndSet(key, raw, JSON.stringify(next)) && inbox) await this.continueRedispatch(config, key, next, saved, inbox);
      return { kind: 'handled' };
    }
    if (record) return { kind: 'handled' };
    const inbox = await this.redispatchInbox(config.appId, mapping, saved);
    if (!inbox) return undefined;
    const inspection = await this.runtime.inspectExecutionRecovery(mapping.sessionId, larkRecoveryOwner);
    const attempt = inspection.tasks.find(item => item.taskId === runtimeTask.id)?.attempt;
    if (attempt?.state !== 'reconcile_required' || !isRestartInterruption(attempt.reconcileReason?.code)) return undefined;
    if (inspection.blockers.length || inspection.stopBlock) return undefined;
    const count = inbox.redispatch?.count ?? 0;
    let unsafeReason: string | undefined;
    let own: AgentEvent[] = [];
    try {
      const events = await this.runtime.getEvents(mapping.sessionId);
      own = events.filter(event => event.attemptId === attempt.attemptId);
      // 没有按执行记账的旧事件退回按任务切片：切不出来时整段都算进来，只会更保守。
      unsafeReason = larkReplayUnsafeReason(own.length ? own : eventsForRuntimeTask(events, runtimeTask.id).filter(event => !event.taskId || event.taskId === runtimeTask.id));
    } catch (error) {
      this.log.warn({ error, taskId: mapping.externalId }, '读取被切断那一轮的执行记录失败，按可能有外部副作用处理');
      unsafeReason = '的执行记录读取失败';
    }
    const lastActivity = larkLastActivityAt(own, attempt.createdAt);
    const stale = lastActivity === undefined ? 'unknown' : Date.now() - lastActivity > larkRedispatchMaxAgeMs ? 'old' : undefined;
    const cause: LarkHeldCause = { count, ...(unsafeReason ? { unsafeReason } : {}), ...(stale ? { stale } : {}) };
    const base: LarkRelaunchClaim = { id: randomUUID(), boot: this.relaunchBoot, phase: 'held', action: 'rerun_in_new_session', appId: config.appId,
      taskId: mapping.externalId, turn, chatId: saved.chat_id, cardMessageId: saved.card_message_id ?? '', taskName: saved.task_name,
      sessionId: mapping.sessionId, runtimeTaskId: runtimeTask.id, operatorOpenId: saved.sender_open_id ?? '',
      redispatch: { ...cause, resumed: false, auto: true } };
    if (unsafeReason || stale || count >= larkRedispatchLimit) {
      if (await store.compareAndSet(key, undefined, JSON.stringify(base))) await this.publishRedispatchNote(mapping.sessionId, larkHeldWebNote(cause));
      return { kind: 'hold', ...cause };
    }
    await this.startRedispatch(config, key, undefined, base, saved, inbox, { count: count + 1, auto: true });
    return { kind: 'handled' };
  }

  /** 重投的原请求：映射要有原任务、原文和有人能续聊的 scope，入站记录要已受理、与映射同会话同群同轮次。 */
  private async redispatchInbox(appId: string, mapping: ChannelMapping, saved: PersistedLarkCardTask) {
    if (saved.app_id !== appId || !saved.runtime_task_id || !saved.prompt?.trim() || !saved.scope_id || saved.scope_id.startsWith('message:')) return undefined;
    const raw = await this.workflowOptions.store!.get(`lark.inbox.${appId}.${mapping.externalId}`);
    const inbox = raw ? JSON.parse(raw) as LarkInboxRecord : undefined;
    return inbox?.state === 'accepted' && inbox.sessionId === mapping.sessionId && inbox.event.chatId === saved.chat_id
      && (inbox.turn ?? 0) === (saved.turn ?? 0) ? inbox : undefined;
  }

  /**
   * 认领这一轮的重投并开始。原会话没归档、没停止就在原会话续做，Agent 接着原来的上下文；否则开新会话。
   * previousRaw 是认领前的记录（自动重投时没有，点「重新执行」时是停下的那条）；被别人抢先认领时返回 false。
   */
  private async startRedispatch(config: StoredLarkConfig, key: string, previousRaw: string | undefined, base: LarkRelaunchClaim,
    saved: PersistedLarkCardTask, inbox: LarkInboxRecord, next: { count: number; auto: boolean; operatorOpenId?: string }) {
    const session = await this.runtime.getSession(base.sessionId);
    const resumed = Boolean(session && !session.archivedAt && session.state !== 'stopped');
    const claim: LarkRelaunchClaim = { ...base, id: randomUUID(), boot: this.relaunchBoot, phase: 'claimed',
      ...(next.operatorOpenId ? { operatorOpenId: next.operatorOpenId } : {}), redispatch: { count: next.count, resumed, auto: next.auto } };
    if (!await this.workflowOptions.store!.compareAndSet!(key, previousRaw, JSON.stringify(claim))) return false;
    // 先写说明再动账本：旧一轮记为结果未知之后，排在后面的任务会马上开跑，那时写的说明会记进它的输出。
    await this.publishRedispatchNote(base.sessionId, larkRedispatchWebNote(claim.redispatch!));
    await this.continueRedispatch(config, key, claim, saved, inbox);
    return true;
  }

  /** 在原会话续做先把旧一轮记为结果未知（记不上就改开新会话），然后交给转交流程从入站记录重投。 */
  private async continueRedispatch(config: StoredLarkConfig, key: string, claim: LarkRelaunchClaim, saved: PersistedLarkCardTask, inbox: LarkInboxRecord) {
    let current = claim;
    if (claim.redispatch!.resumed) {
      try { await this.settleInterruptedAttempt(claim.sessionId, claim.runtimeTaskId, `lark_redispatch:${claim.taskId}:${claim.turn}`, 'lark_restart_redispatch'); }
      catch (error) {
        this.log.warn({ error, taskId: claim.taskId }, '旧一轮未能记为结果未知，改在新会话中重投');
        current = { ...claim, redispatch: { ...claim.redispatch!, resumed: false } };
        if (!await this.workflowOptions.store!.compareAndSet!(key, JSON.stringify(claim), JSON.stringify(current))) return;
      }
    }
    const chatType = saved.chat_type ?? 'group';
    const effective = chatType === 'group' && this.groupManager ? await this.groupManager.resolved(config, saved.chat_id) : config;
    this.performRelaunch(config, effective, key, current, saved, inbox.event, false);
  }

  /** 把旧一轮记为结果未知（不是失败），原会话的队列随之放行。同一 decisionId 重复记只回放。 */
  private async settleInterruptedAttempt(sessionId: string, taskId: string, decisionId: string, evidence: string) {
    const inspection = await this.runtime.inspectExecutionRecovery!(sessionId, larkRecoveryOwner);
    const attempt = inspection.tasks.find(item => item.taskId === taskId)?.attempt;
    if (!attempt) throw new Error('原任务记录不存在。');
    if (attempt.state === 'settled') return;
    await this.runtime.confirmExecutionRecovery!(sessionId, { runId: inspection.runId, taskId, attemptId: attempt.attemptId, expectedRevision: attempt.revision,
      decisionId, action: 'confirm_result', outcome: 'unknown', evidenceRefs: [evidence], resourceChecks: inspection.resourceChecks }, larkRecoveryOwner);
  }

  /** 原会话时间线上的说明，Web 上能看到重投次数与原因。写不进去只留日志，不影响重投本身。 */
  private async publishRedispatchNote(sessionId: string, text: string) {
    try { await this.runtime.publishSessionEvent?.(sessionId, 'text', { text: `\n\n${text}`, source: 'lark_redispatch' }); }
    catch (error) { this.log.warn({ error, sessionId }, '重启恢复说明未能写进会话时间线'); }
  }

  /**
   * 「重新执行」「放弃」：停在结果未知的那一轮。回调值只用来定位原消息与轮次，任务、会话与原文一律从重投记录、卡片映射与入站记录读。
   * 门禁与「在新会话中重新执行」同一套：发起人隔离、入口权限、托管群操作权、他人任务二次确认；放弃另需操作这条任务的权限（与取消同口径）。
   */
  protected async interruptedTurnAction(action: 'replay_turn' | 'abandon_turn', taskId: string, turn: number | undefined, operatorOpenId?: string,
    context?: { messageId?: string; chatId?: string }) {
    const store = this.workflowOptions.store;
    const appId = this.reconcileConfig?.appId;
    if (!operatorOpenId || !context?.messageId || !context.chatId || !appId || !store?.compareAndSet || !this.cardMappings || !this.inbox || turn === undefined) {
      return { type: 'warning', content: '此卡当前不可操作，请回原话题发送 /status 查看任务' };
    }
    try {
      const config = await readLarkConfig(store, appId);
      if (!config?.listening) return { type: 'warning', content: '机器人已停用，无法执行此操作' };
      const key = redispatchKey(appId, taskId, turn);
      const raw = await store.get(key);
      const record = raw ? JSON.parse(raw) as LarkRelaunchClaim : undefined;
      const mapping = await this.cardMappings.get(larkCardChannel(appId), taskId);
      const saved = mapping?.extra ? JSON.parse(mapping.extra) as PersistedLarkCardTask : undefined;
      if (!raw || !record?.redispatch || !mapping || !saved || record.chatId !== context.chatId || saved.card_message_id !== context.messageId || (saved.turn ?? 0) !== turn) {
        return { type: 'warning', content: '此卡已失效，请在最新的任务卡上操作' };
      }
      if (record.phase === 'abandoned') return { type: 'success', content: '已放弃这一轮，不再执行' };
      if (record.phase !== 'held') return { type: 'warning', content: record.phase === 'claimed' ? '正在重新执行，请勿重复点击' : '这一轮已经处理过，请发送 /status 查看最新状态' };
      const inbox = await this.redispatchInbox(appId, mapping, saved);
      if (!inbox) return { type: 'warning', content: '此卡已失效，请在最新的任务卡上操作' };
      if (!larkScopeContinuesFor(saved.scope_id!, operatorOpenId)) return { type: 'warning', content: '这个会话按发起人隔离，只有发起人本人可以操作，未执行' };
      const chatType = saved.chat_type ?? 'group';
      const effective = chatType === 'group' && this.groupManager ? await this.groupManager.resolved(config, saved.chat_id) : config;
      if (!await this.currentAccess(effective, saved.chat_id, chatType, operatorOpenId, 'task.create', undefined, operatorOpenId)
        || effective.managedGroup && !await this.isOperatorAllowed(effective, operatorOpenId, saved.chat_id, mapping.sessionId)
        || action === 'abandon_turn' && !await this.isOperatorAllowed(effective, operatorOpenId, saved.chat_id, mapping.sessionId, saved.sender_open_id)) {
        return { type: 'warning', content: '当前账号没有在这个话题操作这条任务的权限，未执行' };
      }
      if (action === 'replay_turn') {
        await this.requireExecution('listener', 'task.create');
        await this.requireExecution('session', 'task.create');
      }
      if (!this.foreignActionConfirmed(operatorOpenId, saved.sender_open_id, `${taskId}|${turn}|${action}`)) {
        return { type: 'warning', content: '该任务由他人发起，再次点击同一按钮以确认操作' };
      }
      if (action === 'replay_turn') {
        return await this.startRedispatch(config, key, raw, record, saved, inbox, { count: record.redispatch.count + 1, auto: false, operatorOpenId })
          ? { type: 'success', content: '正在重新执行，话题里会出现新的任务卡' } : { type: 'warning', content: '正在重新执行，请勿重复点击' };
      }
      const abandoned: LarkRelaunchClaim = { ...record, phase: 'abandoned', operatorOpenId };
      if (!await store.compareAndSet(key, raw, JSON.stringify(abandoned))) return { type: 'warning', content: '这一轮正在处理，请发送 /status 查看最新状态' };
      // 记为结果未知后原会话照常接后面的消息；执行资源未确认停止时记不上，原任务留给管理员核对。
      await this.settleInterruptedAttempt(mapping.sessionId, record.runtimeTaskId, `lark_abandon:${taskId}:${turn}`, 'lark_abandon')
        .catch(error => this.log.warn({ error, taskId }, '放弃的一轮未能记为结果未知'));
      void this.markRelaunchedCard(config, abandoned).catch(error => this.log.warn({ error, taskId }, '放弃后的任务卡未能更新'));
      return { type: 'success', content: '已放弃这一轮，不再执行' };
    } catch (error) {
      this.log.warn({ error, taskId, action }, '处理重启切断那一轮的操作失败');
      return { type: 'warning', content: error instanceof LarkServiceError ? error.message : '暂时无法处理，请稍后重试' };
    }
  }

  // 由上层实现、在本层调用。
  protected abstract scheduleTaskAgentPoll(config: StoredLarkConfig): void;
  protected abstract sessionFor(group: LarkGroup, config: StoredLarkConfig, chatId: string, chatType: LarkMessageEvent['chatType'], scopeId: string, launchOptions?: LarkLaunchOptions): ReturnType<typeof resolveLarkSession>;
  protected abstract runTurn(task: LarkTask): Promise<void>;
}
