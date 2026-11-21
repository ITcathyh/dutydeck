import type { SessionAutomationService } from '../../session-automation.js';
import type { UsageLedger } from '../../usage-ledger.js';
import type { LarkCardActionState, LarkCardActionValue, LarkCardCapabilities } from '../card-actions.js';
import type { LarkCardElement, SteeringPermissionStatus } from '../card-renderer.js';
import type { LarkCommandCapabilities } from '../commands.js';
import type { LarkCommandPrompt, LarkRelaunchAction } from '../coordinator-core.js';
import type { LarkGroup, LarkTask } from '../coordinator.js';
import type { LarkGroupManager } from '../group-management.js';
import type { LarkGroupParticipation } from '../group-participation.js';
import type { LarkMessageEvent, LarkRuntime, ListenerLog } from '../listener.js';
import type { LarkMemoryPipeline } from '../memory-pipeline.js';
import type { LarkMemoryStore } from '../memory.js';
import type { LarkLaunchOptions } from '../new-session.js';
import type { LarkCardService, LarkMessageResult } from '../service.js';
import type { LarkChatModeResolver } from '../session-resolver.js';
import type { LarkTaskInbox } from '../task-inbox.js';
import type { LarkWorkbench } from '../workbench.js';
import type { LarkInteraction, LarkWorkflowInteractions } from '../workflow-interactions.js';
import type { ButtonResult, ButtonSource } from './button-context.js';
import type { CommandContext } from './command-context.js';
import type { ChannelMappingRepository, ConfigRepository, PolicyAction, Session, StoredLarkConfig, TaskRecord } from '@dutydeck/shared';

export interface SharedHandlerServices {
  cardMappings: ChannelMappingRepository | undefined;
  currentTurnInterruptDenial(config: StoredLarkConfig, event: LarkMessageEvent, sessionId: string): Promise<string | undefined>;
  groupManager: LarkGroupManager | undefined;
  handleAction(value: unknown, operatorOpenId?: string, context?: ButtonSource): Promise<ButtonResult>;
  inbox: LarkTaskInbox | undefined;
  isDeferredTask(sessionId: string, taskId: string): Promise<boolean>;
  isOperatorAllowed(config: StoredLarkConfig, operatorOpenId?: string, chatId?: string, sessionId?: string, taskRequesterOpenId?: string, action?: PolicyAction): Promise<boolean>;
  isRepairOperatorAllowed(config: StoredLarkConfig, operatorOpenId?: string, chatId?: string): Promise<{ allowed: boolean; reason?: 'managed_group_denied' | 'unconfigured' | 'unauthorized' | undefined }>;
  log: ListenerLog;
  memory: LarkMemoryStore | undefined;
  runtime: LarkRuntime;
  service: LarkCardService;
  tasks: Map<string, LarkTask>;
  automation: SessionAutomationService | undefined;
  participation: LarkGroupParticipation | undefined;
  store: ConfigRepository | undefined;
  workbench: LarkWorkbench | undefined;
}

export interface CommandServices extends SharedHandlerServices {
  absorbQueuedTask(task: LarkTask, markdown: string, statusLabel: string, actorId?: string): Promise<boolean>;
  approvalBlock(appId: string, sessionId: string): Promise<{ record: LarkInteraction | undefined } | undefined>;
  botOpenId: string | undefined;
  cancelPreparingTurns(group: LarkGroup, senderOpenId: string | undefined): Promise<number>;
  cancelUndeliveredRetries(group: LarkGroup): void;
  clearAcknowledgementReaction(task: Pick<LarkTask, 'event' | 'acknowledgement'>): Promise<void>;
  closedScopeSessions(config: StoredLarkConfig, event: LarkMessageEvent, scopeId: string): Promise<{ session: Session; firstTaskId: string; closedAt: string; approximate: boolean; title: string }[]>;
  describeChatStatus(config: StoredLarkConfig, sessionId?: string, latestTask?: LarkTask, chatId?: string): Promise<string>;
  groups: Map<string, LarkGroup>;
  handle(event: LarkMessageEvent, config: StoredLarkConfig, recovering?: boolean, adopted?: boolean): Promise<void>;
  isGrantOperatorAllowed(config: StoredLarkConfig, operatorOpenId: string | undefined, chatId: string, action: PolicyAction): Promise<boolean>;
  isInterruptOperatorAllowed(config: StoredLarkConfig, operatorOpenId: string | undefined, chatId: string, sessionId: string | undefined, taskRequesterOpenId: string | undefined): Promise<boolean>;
  isStaticOperatorAllowed(config: StoredLarkConfig, operatorOpenId?: string, chatId?: string): Promise<boolean>;
  isTaskOperatorAllowed(config: StoredLarkConfig, event: LarkMessageEvent, target: { id: string; sessionId: string }, action?: PolicyAction): Promise<boolean>;
  larkTaskOrigin(config: StoredLarkConfig, chatId: string, target: { id: string; sessionId: string }): Promise<{ requester?: string; title: string; startedAt?: number; confirmation?: boolean } | undefined>;
  newSessionHandoff(config: StoredLarkConfig, event: LarkMessageEvent, sessionId: string | undefined, tasks: TaskRecord[], note: string, nativeContextCopied?: boolean): Promise<string>;
  pickRetryableRuntimeTask(tasks?: TaskRecord[]): TaskRecord | undefined;
  pinSwitchedSession(config: StoredLarkConfig, session: Session): Promise<boolean>;
  preparingTurn(task: LarkTask): boolean;
  replyForkList(config: StoredLarkConfig, event: LarkMessageEvent, sessionId: string | undefined, reply: CommandContext['replyCard']): Promise<void>;
  requesterOnlyReason(config: StoredLarkConfig, requesterOpenId: string | undefined, operation: string, interrupting?: boolean): string;
  requireExecution(boundary: 'listener' | 'session' | 'high_risk', action: PolicyAction): Promise<void>;
  restoreRetryPrompt(config: StoredLarkConfig, event: LarkMessageEvent, target: { id: string; sessionId: string }): Promise<LarkCommandPrompt | undefined>;
  retireScopeSession(group: LarkGroup, config: StoredLarkConfig, event: LarkMessageEvent, scopeId: string): Promise<{ retired: boolean; retained: boolean }>;
  saveTaskDashboardOrigin(config: StoredLarkConfig, card: { messageId: string }, event: LarkMessageEvent): Promise<void> | undefined;
  sessionFor(group: LarkGroup, config: StoredLarkConfig, chatId: string, chatType: string, scopeId: string): Promise<Session>;
  steeringPermissionStatus(sessionId: string, target: { taskId: string; attemptId: string } | undefined, fallbackTarget?: TaskRecord): Promise<SteeringPermissionStatus>;
  taskDisplayPrompt(config: StoredLarkConfig, chatId: string, sessionId: string, task: { id: string; prompt: string }): Promise<string>;
  taskTitle(task: LarkTask, prompt?: string, titleConfig?: StoredLarkConfig): string;
  validateNewSession(config: StoredLarkConfig, event: LarkMessageEvent, options: LarkLaunchOptions): Promise<LarkLaunchOptions>;
  memoryOptions: { store: LarkMemoryStore; pipeline?: LarkMemoryPipeline } | undefined;
  usage: Pick<UsageLedger, 'describe'> | undefined;
}

export interface ButtonServices extends SharedHandlerServices {
  capabilitiesForTask(task: LarkTask): LarkCardCapabilities;
  continueInPlaceAction(taskId: string, turn: number | undefined, operatorOpenId?: string, context?: ButtonSource): Promise<ButtonResult>;
  handleDetailLogin(operator: string | undefined, source: ButtonSource | undefined, target: { taskId: string; turn?: number }): Promise<ButtonResult>;
  interruptedTurnAction(action: 'replay_turn' | 'abandon_turn', taskId: string, turn: number | undefined, operatorOpenId?: string, context?: ButtonSource): Promise<ButtonResult>;
  pushTaskError(task: LarkTask, message: string): void;
  queuedSteerCapabilities(task: LarkTask): Promise<Partial<LarkCardCapabilities>>;
  refreshResultVerification(task: LarkTask, config: StoredLarkConfig): Promise<void>;
  relaunchCardAction(action: LarkRelaunchAction, taskId: string, turn: number | undefined, operatorOpenId?: string, context?: ButtonSource): Promise<ButtonResult>;
  retryInFlight: Set<string>;
  runTurn(task: LarkTask): Promise<void>;
  scheduleResultDaily(parsed: LarkCardActionValue, operatorOpenId?: string, context?: ButtonSource): Promise<ButtonResult>;
  steerQueuedTurn(config: StoredLarkConfig, event: LarkMessageEvent, sessionId: string, target: { id: string; status: string }, mode: 'steer' | 'inject' | 'promote', expectedTarget?: { taskId: string; attemptId?: string } | undefined): Promise<{ steered?: string; note: string }>;
  submitResultFollowUp(parsed: LarkCardActionValue, operatorOpenId?: string, context?: ButtonSource): Promise<ButtonResult>;
  unknownTaskAction(action: 'resolve_retry' | 'resolve_completed' | 'resolve_failed', taskId: string, turn: number | undefined, target: string | undefined, operatorOpenId?: string, context?: ButtonSource): Promise<ButtonResult>;
  verificationView(task: LarkTask, config: StoredLarkConfig, state: LarkCardActionState, changedCode?: boolean): Promise<{ element?: LarkCardElement; canRun: boolean; capabilities: Pick<LarkCardCapabilities, 'canVerify' | 'verificationSuggestion'> }>;
  verifyInFlight: Set<string>;
  commandAllowlisted(config: StoredLarkConfig, chatType: string, chatId: string, operatorOpenId: string | undefined, sessionId?: string): Promise<boolean>;
  currentAccess(config: StoredLarkConfig, chatId: string, chatType: string, actor: string, action: PolicyAction, sessionId?: string, requester?: string): Promise<boolean>;
  executeRepairFlight(config: StoredLarkConfig, appId: string, messageId: string): Promise<void>;
  larkRouteCapabilities(): LarkCommandCapabilities;
  reconcileConfig: StoredLarkConfig | undefined;
  refreshResultFeedback(config: StoredLarkConfig, requestId: string): Promise<void>;
  refreshResultMemory(task: LarkTask, config: StoredLarkConfig): Promise<void>;
  repairInFlight: Set<string>;
  respondFromQueuedCard: (claim: { taskId: unknown; turn: unknown }, approval: Record<string, unknown>, operatorOpenId: string | undefined, cardMessageId: string | undefined, submit: () => Promise<ButtonResult>) => Promise<ButtonResult>;
  taskDashboard(event: LarkMessageEvent, config: StoredLarkConfig, page: number): Promise<Record<string, any>[]>;
  workflows: LarkWorkflowInteractions | undefined;
}

export interface WorkflowServices {
  workflows: LarkWorkflowInteractions;
  chatModeResolver: LarkChatModeResolver | undefined;
  workflowReply(event: LarkMessageEvent, config: StoredLarkConfig, markdown: string, options?: { elements?: LarkCardElement[]; failed?: boolean; taskName?: string }): Promise<LarkMessageResult>;
  saveTaskDashboardOrigin(config: StoredLarkConfig, card: { messageId: string }, event: LarkMessageEvent): Promise<void> | undefined;
  taskDashboard(event: LarkMessageEvent, config: StoredLarkConfig, page: number): Promise<Record<string, any>[]>;
  expiredAskPrompt(error: unknown, answer: string): string | undefined;
}
