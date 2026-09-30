import type { LarkInboxRecord } from './task-inbox.js';
import type { LarkLaunchOptions } from './new-session.js';
import type { AgentEvent, Session, TaskRecord } from '@dutydeck/shared';
import type { StoredLarkConfig } from './config.js';
import type { LarkAutoVerificationProgress } from './auto-verification.js';
import type { LarkMessageResource } from './message-content.js';
import type { LarkCardElement } from './card-renderer.js';
import type { LarkRedispatchInfo } from './turn-redispatch.js';
import type { LarkMessageEvent } from './listener.js';
import { LarkCoordinatorInbound } from './coordinator-inbound.js';

// 飞书消息协调器（从 listener.ts 拆分）：按群/话题串行化任务轮次、驱动 Agent 会话、
// 渲染并更新服务卡片。卡片终态对账见 reconciler.ts，会话路由见 session-resolver.ts。
// 实现按层拆开、逐层继承：coordinator-core → -cards（卡片生命周期）→ -recovery（恢复与对账）
// → -dispatch（派发）→ -inbound（入站唤醒）；本文件只放公开类型和入口类。

export type LarkGroup = {
  sessionId?: string;
  sessionConfigKey?: string;
  /** Newly created replacement for a maintenance-retired legacy context. */
  legacyUpgradeSessionId?: string;
  tail: Promise<void>;
  /**
   * 被 /new 结束的会话 id。runtime.stop 落库前会话状态仍是 idle，此刻并发到达的消息
   * 会在 listSessions 里重新命中它——记下来才能保证「/new 回执之后不再复用旧上下文」。
   */
  retiredSessionIds?: Set<string>;
  /**
   * 上下文代数，每次 /new 递增。任务在入队时记下当时的代数，runTurn 里对不上就说明
   * 这一轮已经被 /new 作废：附件下载、身份解析、runtime.start 都可能让一条旧消息在
   * /new 之后才走到派发那一步，没有这个标记它就会把旧 prompt 发进已经宣布结束的上下文。
   */
  epoch?: number;
  /**
   * 正在进行的 sessionFor。/new 必须等它（建会话是短操作），才能连同这条刚建出来的
   * 会话一起停掉；但绝不能等 group.tail —— fallback 路径的 tail 要等整轮 send 结束，
   * 把它当锁会让 /new 在长任务期间永远停不下来。
   */
  pendingSession?: Promise<Session | undefined>;
};
export type LarkTaskState = 'queued' | 'running' | 'interrupting' | 'interrupted' | 'completed' | 'failed' | 'cancelled' | 'reconcile_required' | 'legacy_unresolved';
export type LarkTask = {
  id: string;
  group: LarkGroup;
  event: LarkMessageEvent;
  prompt: string;
  resources: LarkMessageResource[];
  inbox?: LarkInboxRecord;
  resumeTask?: TaskRecord;
  retryMaterialPrompt?: string;
  launchOptions?: LarkLaunchOptions;
  restoring?: boolean;
  /** dispatch/send 已开始后，交由运行时核对，不能按未执行请求作废。 */
  submissionStarted?: boolean;
  config: StoredLarkConfig;
  state: LarkTaskState;
  events: AgentEvent[];
  lastSuccessfulElements?: LarkCardElement[];
  sessionId?: string;
  cardMessageId?: string;
  runtimeTaskId?: string;
  startedAt?: number;
  acknowledgementReactionId?: string;
  /** Immutable terminal notification for the current turn. */
  finalMessageId?: string;
  /**
   * 本轮终态是怎么交付的：'delivered' = 发了结果卡；'reaction' = 只贴了完成表情
   * （completionReactionOnly，成功终态专用，此时没有 finalMessageId）；'failed' = 结果卡被平台明确拒收，对账不再补发。
   */
  finalDeliveryState?: 'delivered' | 'reaction' | 'failed';
  finalAttachmentMessageId?: string;
  finalDeliveredTurn?: number;
  finalElements?: LarkCardElement[];
  /** 结果卡的整卡入参（不含 elements / 幂等键），供「运行验证」完成后原样重绘同一张卡。 */
  finalCardInput?: Record<string, unknown>;
  progressFrozen?: boolean;
  interruptRequested?: boolean;
  requestUpdate?: (state: Exclude<LarkTaskState, 'interrupting'>, completed?: boolean) => Promise<void>;
  retryable?: boolean;
  /** 递增的轮次编号，用于防止上一轮的终态回调覆盖重试后的新状态。 */
  turn: number;
  /** 本条消息解析出的会话隔离 scope（与 group key 一致），sessionFor 复用。 */
  scopeId: string;
  /** 入队时所属的上下文代数；与 group.epoch 不符说明本轮已被 /new 作废。 */
  epoch: number;
  /** S3：未知命令近似匹配提示，只渲染在卡片上，绝不进入 agent prompt。 */
  commandSuggestion?: string;
  /** S8：恢复轮次已渲染过 daemon 重启注记，避免同一轮次重复落注记。 */
  replayedNote?: boolean;
  /** 服务重启切断之后的重投（来自入站记录）：Agent prompt 前附说明，卡上带注记。 */
  redispatch?: LarkRedispatchInfo;
  /** /steer：这一轮派发后要立刻提到队首（运行时没有「注入当前轮」的原语，只能降级到队首）。 */
  steer?: boolean;
  /** /steer 的降级结果说明，派发后按真实发生的事写进卡面，绝不预告未发生的成功。 */
  steerNote?: string;
  /** 结果卡上自动验证的进展；验证状态行按它写说明。 */
  autoVerification?: LarkAutoVerificationProgress;
  /** 这一轮已经插话送达，没有自己的轮次：结果卡只写插话结果，不渲染输出。 */
  steered?: string;
  /** 意外新建会话（旧会话已结束或配置已变更）时的首卡注记；/new 主动开的新会话没有。 */
  newSessionNote?: string;
  quoteFailureNote?: string;
  /** 排队时已被提到队首（/queue top、/steer 或排队卡按钮）：不再和后一条合并。 */
  promoted?: boolean;
  /** 排队卡上正显示着的那条审批（记录 id）；审批有了结果，心跳据此把排队卡改回普通说明。 */
  queuedApproval?: string;
  /** 执行卡上正标着「可能卡住」；提示出现或撤销时，心跳据此重绘同一会话的排队卡。 */
  stallNoted?: boolean;
};
export type PersistedLarkCardTask = {
  result_feedback_state?: string;
  retry_material_prompt?: string;
  sender_open_id?: string;
  /** 发送方类型（user / app / bot）。重启后的回执卡靠它决定要不要 @ 回发起人。 */
  sender_type?: string;
  thread_id?: string;
  scope_id?: string;
  app_id: string;
  chat_id: string;
  reply_message_id?: string;
  reply_in_thread?: boolean;
  /** @deprecated 兼容旧记录；历史版本可能错误地写入 omt_* thread_id。 */
  root_message_id?: string;
  /** 静默进展下本轮不发过程卡，这里就没有值；除此之外恒有值。 */
  card_message_id?: string;
  runtime_task_id?: string;
  task_name: string;
  prompt: string;
  state: LarkTaskState;
  started_at: number;
  last_successful_elements?: LarkCardElement[];
  /** Daemon recovery already removed stale in-memory card actions. */
  recovery_read_only?: boolean;
  recovery_status_key?: string;
  /** 这一轮正在转到新会话（在新会话中执行/重新执行）：对账跳过它；新一轮落库时整行替换，标记随之消失。 */
  relaunch_pending?: boolean;
  chat_type?: LarkMessageEvent['chatType'];
  final_message_id?: string;
  final_attachment_message_id?: string;
  /**
   * 'reaction' = 只贴了完成表情、没有结果卡消息，对账据此判定「已交付」。
   * 'failed' = 结果卡被平台明确拒收（不在群里、没有权限、内容被拒等），或瞬时失败自动重试超过 1 小时，对账不再补发。
   */
  final_delivery_state?: 'delivered' | 'reaction' | 'failed';
  /** 结果没送达的原因：failed 时是停止重试的原因，重试中是最近一次失败的原因。送达后清掉。 */
  final_delivery_error?: string;
  /** 结果卡连续瞬时失败的次数、对账下一次重发的时间和第一次失败的时间（毫秒）。送达或判定失败后清掉。 */
  final_delivery_attempts?: number;
  final_delivery_retry_at?: number;
  final_delivery_first_failed_at?: number;
  final_elements?: LarkCardElement[];
  /** 结果卡整卡入参，供重启后的「运行验证」原样重绘同一张收据。 */
  final_card_input?: Record<string, unknown>;
  progress_frozen?: boolean;
  turn?: number;
  /** 同一会话里之前几轮（重试前）的过程卡与结果卡消息 ID，旧卡上的「查看详情」靠它认回这条任务。转到新会话前那一轮的卡不记在这里。 */
  earlier_message_ids?: string[];
  /** 结果卡上自动验证的进展，重绘时验证状态行照它写。 */
  verification_auto?: LarkAutoVerificationProgress;
};
export { larkTaskTitle } from './coordinator-core.js';

export class LarkMessageCoordinator extends LarkCoordinatorInbound {}
