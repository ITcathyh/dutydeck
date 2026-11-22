import type { ReplyPolish } from './reply-polish.js';
import type { LarkGroupParticipation } from './group-participation.js';
import { randomUUID } from 'node:crypto';
import type { RelayAskBroker } from '@dutydeck/relay';
import type { LarkMemoryStore } from './memory.js';
import type { LarkMemoryPipeline } from './memory-pipeline.js';
import type { LarkGroupManager } from './group-management.js';
import type { ChannelMappingRepository, ConfigRepository, PolicyAction, PolicyDecision } from '@dutydeck/shared';
import type { StoredLarkConfig } from './config.js';
import type { LarkCardService } from './service.js';
import type { LoginLinkStore } from '../auth/auth.js';
import type { LarkChatModeResolver } from './session-resolver.js';
import type { ListenerLog, LarkRuntime } from './listener.js';
import type { LarkGroup, LarkTask } from './coordinator.js';

export class CoordinatorState {
  readonly groups = new Map<string, LarkGroup>();
  readonly tasks = new Map<string, LarkTask>();
  readonly handledMessages = new Set<string>();
  reconcileTimer?: NodeJS.Timeout;
  reconcileRun?: Promise<number>;
  reconcileConfig?: StoredLarkConfig;
  reconcileIntervalMs = 5_000;
  stopped = false;
  readonly turnCleanups = new Set<() => void>();
  /** P0-1：他人任务取消/中断/重试的二次确认键 → 过期时间戳（60s），惰性清理。 */
  readonly foreignActionConfirmations = new Map<string, number>();
  taskAgentTimer?: NodeJS.Timeout;
  taskAgentRun?: Promise<number>;
  /** 已写回飞书任务记录的 `${guid}:${turn}:${state}`，避免同一状态被心跳重复写。 */
  readonly writtenTaskSteps = new Set<string>();
  /** 本进程的转交世代：认领上的 boot 不是它，说明那次转交随上一个进程中断了。 */
  readonly relaunchBoot = randomUUID();

  groupFor(key: string): LarkGroup {
    const group = this.groups.get(key) ?? { tail: Promise.resolve() };
    this.groups.set(key, group);
    return group;
  }

  constructor(
    readonly runtime: LarkRuntime,
    readonly service: LarkCardService,
    readonly log: ListenerLog,
    readonly _random: () => number = Math.random,
    readonly botOpenId: string | undefined,
    readonly peerBotAuthorized: ((chatId: string, senderOpenId: string) => Promise<boolean>) | undefined,
    readonly cardMappings: ChannelMappingRepository,
    readonly chatModeResolver: LarkChatModeResolver | undefined,
    readonly executionPolicy: {
      integrationMode: 'legacy_unmanaged';
      authorize(boundary: 'listener' | 'session' | 'high_risk', action: PolicyAction): Promise<PolicyDecision>;
    } | undefined,
    readonly groupManager: LarkGroupManager | undefined,
    readonly workflowOptions: {
      polishReply?: ReplyPolish;
      participation?: LarkGroupParticipation;
      scheduleRequests?: import('../agent-schedule-request.js').LarkScheduleRequests;
      saveBotConfig?(input: import('./config.js').SaveLarkConfigInput): Promise<unknown>;
      usage?: Pick<import('../usage-ledger.js').UsageLedger, 'describe'>;
      store: ConfigRepository;
      resourceRoot?: string;
      broker?: RelayAskBroker;
      automation?: import('../session-automation.js').SessionAutomationService;
      workbench?: import('./workbench.js').LarkWorkbench;
      memory?: {
        store: LarkMemoryStore;
        pipeline?: LarkMemoryPipeline;
      };
      /** Web 要求登录时提供；「查看详情」据此改为给管理员私信一次性登录链接。 */
      loginLinks?: Pick<LoginLinkStore, 'issue'>;
      /** 按工作区记住的审批规则（审批卡「本工作区允许此类命令」）。 */
      workspaceApprovals?: import('./workflow-interactions.js').LarkWorkspaceApprovals;
      /** 见 LarkWorkflowInteractionsOptions.deferredCloseMs。 */
      deferredCloseMs?: number;
    },
  ) {}

  /**
   * 飞书任务智能体通道的轮询周期。
   *
   * 60 秒：派活是人的动作，任务界面上指派一条任务到机器人接单之间隔一分钟，与这条通道
   * 的使用节奏相称；聊天入口本来就是实时的，这条是补充入口，不必也不该按秒抢。代价这边，
   * 每轮最多一次列表请求（只有翻页才追加），对租户级限流可以忽略。通道关闭时
   * claimLarkTaskDispatches 在三道门里直接返回，一个请求都不会发出去，定时器空转而已。
   */
  readonly taskAgentIntervalMs = 60_000;

  /** 同一个任务的验证正在跑；重复点击只回提示，不再起第二个进程。 */
  readonly verifyInFlight = new Set<string>();

  /** 正在后台执行 /repair 的「应用:确认卡消息」，防止同一张确认卡被重复点击触发多次发布。 */
  repairInFlight = new Set<string>();
}
