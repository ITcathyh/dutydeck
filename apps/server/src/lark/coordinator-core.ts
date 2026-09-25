import type { LarkGroupParticipation } from './group-participation.js';
import { randomUUID } from 'node:crypto';
import type { RelayAskBroker } from '@dutydeck/relay';
import { LarkWorkflowInteractions, type LarkInteraction, type LarkInteractionContext } from './workflow-interactions.js';
import { LarkTaskInbox } from './task-inbox.js';
import type { LarkLaunchOptions } from './new-session.js';
import { LarkMemoryStore } from './memory.js';
import { LarkMemoryProjection } from './memory-view.js';
import type { LarkMemoryPipeline } from './memory-pipeline.js';
import type { LarkGroupManager } from './group-management.js';
import type { ChannelMappingRepository, ConfigRepository, PolicyAction, PolicyDecision } from '@dutydeck/shared';
import { readLarkConfig, type StoredLarkConfig } from './config.js';
import { LarkServiceError, type LarkCardService } from './service.js';
import type { LarkHeldCause, LarkRedispatchInfo } from './turn-redispatch.js';
import { isBotSenderType, isGroupChat } from './card-mentions.js';
import { LarkPinManager } from './pin-manager.js';
import type { LoginLinkStore } from '../auth/auth.js';
import { larkReplyContext, type LarkChatModeResolver } from './session-resolver.js';
import type { ListenerLog, LarkMessageEvent, LarkRuntime } from './listener.js';
import type { LarkGroup, LarkTask, PersistedLarkCardTask } from './coordinator.js';

// 飞书消息协调器 · 公共层：实例状态与构造、各层共用的权限判定和工具函数。分层说明见 coordinator.ts。

export type LarkCommandPrompt = { prompt: string; suggestion?: string; materialPrompt?: string; launchOptions?: LarkLaunchOptions; epoch?: number; steer?: boolean };

export const larkCardChannel = (appId: string) => `lark-card:${appId}`;
export type LarkRelaunchAction = 'run_in_new_session' | 'rerun_in_new_session';
/**
 * 「在新会话中执行」的持久化认领，键按 App + 原消息 + 轮次：重复点击、重复投递、重启后的重复回调读到的都是这一条。
 * claimed：正在转交（boot 不是本进程，说明上一个进程半路退出，下一次点击可以接手）；
 * moved：原请求已交给入站记录在新会话中执行，之后的点击只回执；failed：已回滚，可以再点。
 *
 * 服务重启切断那一轮的重投（redispatchInterruptedTurn）复用同一形状，存在 redispatchKey 下并带 redispatch：
 * held：停下等人在卡上选「重新执行」「放弃」；abandoned：点了「放弃」。静默进展下没有过程卡，cardMessageId 为空串。
 */
export type LarkRelaunchClaim = {
  id: string; boot: string; phase: 'claimed' | 'moved' | 'failed' | 'held' | 'abandoned'; action: LarkRelaunchAction;
  appId: string; taskId: string; turn: number; chatId: string; cardMessageId: string; taskName: string;
  sessionId: string; runtimeTaskId: string; operatorOpenId: string; newSessionId?: string;
  redispatch?: LarkRedispatchInfo & Omit<LarkHeldCause, 'count'>;
};
/**
 * 转交或 /new 时作废、留给管理员核对的旧会话。它的执行进程未确认停止：/new 不去停它，续聊与之后的转交都不再选回它。
 * 键按 App + 会话落库，重启后仍成立；判断只看键在不在，值只是来源记录。
 */
export const relaunchRetainedPrefix = (appId: string) => `lark.relaunch_retained.${appId}.`;
export const relaunchRetainedKey = (appId: string, sessionId: string) => relaunchRetainedPrefix(appId) + sessionId;
/** 去掉开头对本机器人的 @（可能连着好几个）。卡片标题与重复请求判定共用。 */
export const withoutLeadingBotMention = (prompt: string, botName?: string) => {
  const mention = botName?.trim() ? `@${botName.trim()}` : '';
  let text = prompt.trim();
  // 名字后面必须是空白或结尾：@bdev-flashy 不是在 @ bdev-flash。
  while (mention && text.startsWith(mention) && !/^\S/.test(text.slice(mention.length))) text = text.slice(mention.length).trimStart();
  return text;
};
/**
 * 卡片标题：去掉开头对本机器人的 @。卡片回复在原消息下面，标题第一眼读到机器人自己的名字
 * 是噪声；@ 别的机器人是原话的一部分，保留。
 */
export const larkTaskTitle = (prompt: string, botName?: string) => (withoutLeadingBotMention(prompt, botName) || prompt.trim()).slice(0, 80);
/**
 * 续聊规则与在原位置发言一致：按发送人隔离的会话（user:）只有发起人本人发言才会回到它；
 * 话题、整群与私聊会话由在原位置发言的人共用。message: 是缺身份时的一次性会话，谁也续不上。
 */
export const larkScopeContinuesFor = (scopeId: string, operatorOpenId: string) =>
  scopeId.startsWith('user:') ? scopeId === `user:${operatorOpenId}` : !scopeId.startsWith('message:');

// 群消息统一回复触发消息；话题消息显式 reply_in_thread，避免卡片脱离提问人的话题。
export async function sendTaskCard(
  service: Pick<LarkCardService, 'send' | 'reply'>,
  event: LarkMessageEvent,
  input: Omit<Parameters<LarkCardService['send']>[0], 'chatId'>,
  log?: { warn: (...args: any[]) => void }
) {
  const executionInput = { permissionMode: 'full-trust' as const, ...input };
  if (event.chatType === 'group' && typeof service.reply === 'function') {
    try {
      return await service.reply({ ...larkReplyContext(event), ...executionInput });
    } catch (error) {
      // 回复触发消息失败（例如消息已被删除）时，回退为群内发送，保证卡片仍能送达。
      log?.warn({ error, messageId: event.messageId, chatId: event.chatId }, '回复卡片失败，回退为群内发送');
      return await service.send({ chatId: event.chatId, ...executionInput });
    }
  }
  return await service.send({ chatId: event.chatId, ...executionInput });
}

export abstract class LarkCoordinatorCore {
  protected readonly groups = new Map<string, LarkGroup>();
  protected readonly tasks = new Map<string, LarkTask>();
  protected readonly handledMessages = new Set<string>();
  protected reconcileTimer?: NodeJS.Timeout;
  protected reconcileRun?: Promise<number>;
  protected reconcileConfig?: StoredLarkConfig;
  protected reconcileIntervalMs = 5_000;
  protected stopped = false;
  protected readonly turnCleanups = new Set<() => void>();
  /** P0-1：他人任务取消/中断/重试的二次确认键 → 过期时间戳（60s），惰性清理。 */
  protected readonly foreignActionConfirmations = new Map<string, number>();
  protected readonly workflows?: LarkWorkflowInteractions;
  protected readonly inbox?: LarkTaskInbox;
  /** 长任务进度卡置顶。默认关闭（见 config.pinLongTasks），但对账在关闭后仍要能撤掉僵尸置顶。 */
  protected readonly pins?: LarkPinManager;
  protected taskAgentTimer?: NodeJS.Timeout;
  protected taskAgentRun?: Promise<number>;
  /** 已写回飞书任务记录的 `${guid}:${turn}:${state}`，避免同一状态被心跳重复写。 */
  protected readonly writtenTaskSteps = new Set<string>();
  /** 会话记忆：与 inbox / workflows 共用 workflowStore，缺存储时三条记忆命令收敛为 unavailable，也不注入。 */
  protected readonly memory?: LarkMemoryStore;
  /** 本进程的转交世代：认领上的 boot 不是它，说明那次转交随上一个进程中断了。 */
  protected readonly relaunchBoot = randomUUID();

  constructor(
    protected readonly runtime: LarkRuntime,
    protected readonly service: LarkCardService,
    protected readonly log: ListenerLog,
    private readonly _random: () => number = Math.random,
    protected readonly botOpenId?: string,
    protected readonly peerBotAuthorized?: (chatId: string, senderOpenId: string) => Promise<boolean>,
    protected readonly cardMappings?: ChannelMappingRepository,
    protected readonly chatModeResolver?: LarkChatModeResolver,
    private readonly executionPolicy?: {
      integrationMode: 'legacy_unmanaged';
      authorize(boundary: 'listener' | 'session' | 'high_risk', action: PolicyAction): Promise<PolicyDecision>;
    },
    protected readonly groupManager?: LarkGroupManager,
    protected readonly workflowOptions: {
      participation?: LarkGroupParticipation;
      usage?: Pick<import('../usage-ledger.js').UsageLedger, 'describe'>;
      store?: ConfigRepository;
      broker?: RelayAskBroker;
      automation?: import('../session-automation.js').SessionAutomationService;
      workbench?: import('./workbench.js').LarkWorkbench;
      memory?: {
        store: LarkMemoryStore;
        projection: LarkMemoryProjection;
        command?: string;
        pipeline?: LarkMemoryPipeline;
      };
      /** Web 要求登录时提供；「查看详情」据此改为给管理员私信一次性登录链接。 */
      loginLinks?: Pick<LoginLinkStore, 'issue'>;
    } = {},
  ) {
    this.memory = workflowOptions.memory?.store;
    if (workflowOptions.store) {
      this.inbox = new LarkTaskInbox(workflowOptions.store);
      this.workflows = new LarkWorkflowInteractions(workflowOptions.store, runtime, service, workflowOptions.broker,
        (record, actor, action) => this.authorizeInteraction(record, actor, action));
      // 置顶记录必须持久化：进程崩在长任务中间时，只有账本能让重启后的对账认出僵尸置顶。
      this.pins = new LarkPinManager(service, { store: workflowOptions.store, log: this.log });
    }
  }

  /**
   * 加急与置顶的开关都在 Bot 配置里，而构造协调器时还读不到配置，
   * 所以在每次拿到配置的入口（初始化与对账启动）按当前配置重新落一次。
   * 两项默认关闭：加急是收件人手机上的强提醒横幅，置顶会改写群成员的会话列表，
   * 升级本身不能替用户打开任何一个。
   */
  protected applyReminderSettings(config: StoredLarkConfig) {
    this.workflows?.configureUrgent(config.urgentEnabled === true
      ? {
        enabled: true,
        ...(config.urgentThresholdMs !== undefined ? { thresholdMs: config.urgentThresholdMs } : {}),
        ...(config.urgentMaxPerHourPerChat !== undefined ? { maxPerHourPerChat: config.urgentMaxPerHourPerChat } : {})
      }
      : false);
  }

  /** 结构化问答/群 @ 等 observe 渲染开关统一取自任务配置，三处 observe 调用共用同一口径。 */
  protected workflowObserveOptions(task: LarkTask) {
    return {
      structuredAskCards: task.config.structuredAskCards !== false,
      ...(task.config.webBaseUrl ? { webBaseUrl: task.config.webBaseUrl } : {}),
      groupMention: task.config.groupCardMention === true && isGroupChat(task.event.chatType) && !isBotSenderType(task.event.senderType)
    };
  }

  protected async currentAccess(config: StoredLarkConfig, chatId: string, chatType: string, actor: string, action: PolicyAction, sessionId?: string, requester?: string) {
    const managed = chatType === 'group' ? await this.groupManager?.authorize(config.appId, chatId, actor, action, sessionId,
      { ...(requester ? { taskRequesterOpenId: requester } : {}) }) : undefined;
    if (managed) return managed.allowed;
    if (!await this.isOperatorAllowed(config, actor)) return false;
    if (chatType === 'group') {
      let pageToken: string | undefined;
      let member = false;
      for (let page = 0; page < 20; page++) {
        const result = await this.service.listChatMembers({ chatId, pageSize: 100, ...(pageToken ? { pageToken } : {}) });
        if (result.items.some(item => item.memberId === actor)) { member = true; break; }
        if (!result.hasMore || !result.pageToken) break;
        pageToken = result.pageToken;
      }
      if (!member) return false;
    }
    if (action === 'task.view_result') return true;
    if (!requester || requester !== actor) return false;
    if (action !== 'high_risk.execute') return true;
    const users = config.highRiskAllowedUsers ?? [];
    const emails = config.highRiskAllowedEmails ?? [];
    if (users.length) return users.some(user => user.openId === actor);
    return !emails.length || (await this.service.getUserEmails(actor)).some(email => emails.includes(email));
  }

  protected async authorizeInteraction(record: LarkInteraction, actor: string, action: PolicyAction) {
    const config = await readLarkConfig(this.workflowOptions.store, record.appId);
    if (!config?.listening || !record.event.senderOpenId) return false;
    const mapping = (await this.cardMappings?.list(larkCardChannel(record.appId)))?.find(item => item.externalId === record.event.messageId);
    if (!mapping || mapping.sessionId !== record.sessionId) return false;
    const saved = JSON.parse(mapping.extra ?? '{}') as PersistedLarkCardTask;
    if (saved.app_id !== record.appId || saved.chat_id !== record.event.chatId || saved.runtime_task_id !== record.taskId
      || saved.turn !== record.turn || saved.sender_open_id !== record.event.senderOpenId) return false;
    const task = (await this.runtime.getTasks?.(record.sessionId))?.find(item => item.id === record.taskId);
    if (!task || (record.kind === 'result' ? task.status !== 'completed' : task.status !== 'running')) return false;
    return this.currentAccess(config, saved.chat_id, record.event.chatType, actor, action, record.sessionId, saved.sender_open_id);
  }

  protected interactionContext(task: LarkTask): LarkInteractionContext | undefined {
    return task.sessionId && task.runtimeTaskId ? { appId: task.config.appId, sessionId: task.sessionId,
      taskId: task.runtimeTaskId, turn: task.turn, event: task.event } : undefined;
  }

  protected async requireExecution(boundary: 'listener' | 'session' | 'high_risk', action: PolicyAction) {
    if (!this.executionPolicy) return;
    const decision = await this.executionPolicy.authorize(boundary, action);
    if (!decision.allowed) {
      throw new LarkServiceError('LARK_EXECUTION_POLICY_DENIED', decision.reason, 403, {
        policyCode: decision.code,
        boundary,
        integrationMode: this.executionPolicy.integrationMode,
      });
    }
  }

  /** 执行宿主名不进持久化，每次渲染时重新解析：Agent 可能被改名或删除，卡上应显示当前的名字。 */
  protected async resolveAgentName(config: StoredLarkConfig) {
    try {
      return (await this.runtime.listAgents?.())?.find(agent => agent.id === config.defaultAgentId)?.name ?? config.defaultAgentId ?? 'Dutydeck';
    } catch (error) {
      this.log.warn({ error, agentId: config.defaultAgentId }, '读取 Agent 展示名失败，使用 Agent ID 渲染卡片');
      return config.defaultAgentId ?? 'Dutydeck';
    }
  }

  /**
   * 飞书任务智能体通道的轮询周期。
   *
   * 60 秒：派活是人的动作，任务界面上指派一条任务到机器人接单之间隔一分钟，与这条通道
   * 的使用节奏相称；聊天入口本来就是实时的，这条是补充入口，不必也不该按秒抢。代价这边，
   * 每轮最多一次列表请求（只有翻页才追加），对租户级限流可以忽略。通道关闭时
   * claimLarkTaskDispatches 在三道门里直接返回，一个请求都不会发出去，定时器空转而已。
   */
  protected readonly taskAgentIntervalMs = 60_000;

  /**
   * 修改本群授权（/grant、/revoke）的鉴权。
   *
   * - 托管群：先按 grant.create / grant.revoke 策略动作判定（owner 或 admin 角色）。
   *   本部署形态下 admin 角色只能由安装管理员在 Web 授予，因此未通过时回落到与 /repair
   *   同一道安装级门（high_risk.execute）——改「谁能使唤机器人」至少和跑一条高风险命令同级。
   * - 非托管群：回落部署级静态白名单，与该形态下其他管理动作口径一致。
   */
  protected async isGrantOperatorAllowed(config: StoredLarkConfig, operatorOpenId: string | undefined, chatId: string, action: PolicyAction): Promise<boolean> {
    if (!operatorOpenId) return false;
    const decision = await this.groupManager?.authorize(config.appId, chatId, operatorOpenId, action);
    if (decision?.allowed) return true;
    return this.isInstallationOperatorAllowed(config, operatorOpenId, chatId);
  }

  /**
   * 卡片操作人的访问权限校验，与 runTurn 中「谁可以使用 Agent」的配置保持一致：
   * - 未配置白名单时所有人均可操作
   * - 配置了 allowedUsers 时按 openId 匹配
   * - 仅配置 allowedEmails 时拉取操作人邮箱匹配
   */
  protected async isTaskOperatorAllowed(config: StoredLarkConfig, event: LarkMessageEvent, target: { id: string; sessionId: string }, action: PolicyAction = 'run.interrupt') {
    let requester = [...this.tasks.values()].find(task => task.runtimeTaskId === target.id && task.sessionId === target.sessionId
      && task.config.appId === config.appId && task.event.chatId === event.chatId)?.event.senderOpenId;
    if (!requester) {
      for (const mapping of await this.cardMappings?.list(larkCardChannel(config.appId)) ?? []) {
        if (mapping.sessionId !== target.sessionId) continue;
        const saved = JSON.parse(mapping.extra ?? '{}') as PersistedLarkCardTask;
        if (saved.app_id === config.appId && saved.chat_id === event.chatId && saved.runtime_task_id === target.id) {
          requester = saved.sender_open_id;
          break;
        }
      }
    }
    // Historical records without a requester cannot establish own_runs authority.
    if (config.managedGroup && !requester) return false;
    return this.isOperatorAllowed(config, event.senderOpenId, event.chatId, target.sessionId, requester, action);
  }

  /** action 默认 run.interrupt（既有口径）；队列操作传 queue.cancel / queue.promote，走同一套判定。 */
  protected async isOperatorAllowed(config: StoredLarkConfig, operatorOpenId?: string, chatId?: string, sessionId?: string, taskRequesterOpenId?: string, action: PolicyAction = 'run.interrupt'): Promise<boolean> {
    if (this.groupManager && chatId) {
      const decision = await this.groupManager.authorize(config.appId, chatId, operatorOpenId, action, sessionId, { taskRequesterOpenId });
      if (decision) return decision.allowed;
    }
    return this.isStaticOperatorAllowed(config, operatorOpenId, chatId);
  }

  /**
   * 部署级静态白名单口径（不经过托管群策略）：allowedUsers/allowedEmails/allowedBots。
   * 未配置任何白名单时维持「不限制」的既有默认；bot 身份（230001）按 peer bot 门处理。
   */
  protected async isStaticOperatorAllowed(config: StoredLarkConfig, operatorOpenId?: string, chatId?: string): Promise<boolean> {
    const allowedUsers = config.allowedUsers ?? [];
    const allowedEmails = config.allowedEmails ?? [];
    const allowedBots = config.allowedBots ?? [];
    const peerBotsAllowed = config.peerBotsAllowed !== false;
    const accessRestricted = allowedUsers.length > 0 || allowedEmails.length > 0;
    if (!accessRestricted) return true;
    if (!operatorOpenId) return false;
    if (allowedUsers.some(user => user.openId === operatorOpenId)) return true;
    if (allowedBots.some(bot => bot.openId === operatorOpenId)) return true;
    try {
      const emails = await this.service.getUserEmails(operatorOpenId);
      return emails.some(email => allowedEmails.includes(email));
    } catch (error) {
      // 通讯录 API 找不到该 open_id 对应的用户（Feishu 错误码 230001），
      // 说明操作人是机器人——bot 不在企业通讯录中。
      // 白名单为"所有人"时已在上方放行；白名单受限则需校验是否为 peer bot 或已加入机器人白名单。
      const upstreamCode = error instanceof LarkServiceError ? Number(error.details?.upstreamCode) : undefined;
      if (upstreamCode === 230001) {
        return Boolean(peerBotsAllowed && config.groupToolsEnabled && chatId && await this.peerBotAuthorized?.(chatId, operatorOpenId));
      }
      this.log.warn({ error, operatorOpenId, upstreamCode }, '获取卡片操作人邮箱失败，按无权限处理');
      return false;
    }
  }

  /**
   * 安装级管理动作（当前仅 /repair 发布飞书应用版本，不可撤销、作用于整个应用而非单个任务）
   * 的鉴权。绝不能复用 run.interrupt 的 own_runs 语义：托管群开放模式下任何能发言的成员
   * 都有「操作本人任务」权，但那不构成发布应用的授权。
   *
   * - 托管群：必须通过 high_risk.execute 门（安装 owner，或被显式授予 highRisk 角色）；
   *   普通 can_talk / own_runs 成员拒绝，即使静态白名单为空。
   * - 非托管群（策略无绑定、authorize 返回 undefined）：回落部署级静态白名单，
   *   与该部署形态下任务操作的既有口径一致。
   */
  protected async isInstallationOperatorAllowed(config: StoredLarkConfig, operatorOpenId?: string, chatId?: string): Promise<boolean> {
    if (!operatorOpenId) return false;
    if (this.groupManager && chatId) {
      const decision = await this.groupManager.authorize(config.appId, chatId, operatorOpenId, 'high_risk.execute');
      if (decision) return decision.allowed;
    }
    return this.isStaticOperatorAllowed(config, operatorOpenId, chatId);
  }

  /**
   * 撤销「请求已接入」的 OK reaction。
   * 设计契约（见 docs/interaction-design-2026-08-30.md §4.1）：reaction 只是回执，
   * 进度卡或失败回执一旦送达就必须移除，不允许 reaction 与卡片两个状态并存。
   * 撤销失败只记日志、不阻断任务执行；reactionId 先清空再调用，保证幂等——
   * 重复调用（正常路径 + 异常兜底）不会重复打 OpenAPI。
   */
  protected async clearAcknowledgementReaction(task: LarkTask) {
    const reactionId = task.acknowledgementReactionId;
    task.acknowledgementReactionId = undefined;
    if (!reactionId) return;
    try { await this.service.deleteReaction(task.event.messageId, reactionId); }
    catch (error) { this.log.warn({ error, messageId: task.event.messageId, reactionId }, '撤销飞书确认表情失败'); }
  }

  protected pushTaskError(task: LarkTask, message: string) {
    task.events.push({
      id: `lark-action-error-${task.id}-${Date.now()}`,
      sessionId: task.sessionId ?? '',
      sequence: Number.MAX_SAFE_INTEGER,
      type: 'error',
      timestamp: new Date().toISOString(),
      data: { message }
    });
  }

  /** 同一个任务的验证正在跑；重复点击只回提示，不再起第二个进程。 */
  protected readonly verifyInFlight = new Set<string>();

  /** 正在后台执行 /repair 的「应用:确认卡消息」，防止同一张确认卡被重复点击触发多次发布。 */
  protected repairInFlight = new Set<string>();

  /** 他人发起的任务与取消、重试他人任务同一口径：60 秒内再点一次同一按钮才执行。 */
  protected foreignActionConfirmed(operatorOpenId: string, requesterOpenId: string | undefined, target: string) {
    if (!requesterOpenId || operatorOpenId === requesterOpenId) return true;
    const now = Date.now();
    for (const [key, expiresAt] of this.foreignActionConfirmations) {
      if (expiresAt <= now) this.foreignActionConfirmations.delete(key);
    }
    const confirmationKey = `${operatorOpenId}|${target}`;
    if ((this.foreignActionConfirmations.get(confirmationKey) ?? 0) > now) {
      this.foreignActionConfirmations.delete(confirmationKey);
      return true;
    }
    this.foreignActionConfirmations.set(confirmationKey, now + 60_000);
    return false;
  }

  stop() {
    this.stopped = true;
    this.workflows?.close();
    for (const cleanup of this.turnCleanups) cleanup();
    if (this.reconcileTimer) clearTimeout(this.reconcileTimer);
    this.reconcileTimer = undefined;
    if (this.taskAgentTimer) clearTimeout(this.taskAgentTimer);
    this.taskAgentTimer = undefined;
    this.reconcileConfig = undefined;
    this.groups.clear();
    this.tasks.clear();
    this.handledMessages.clear();
  }
}
