import type { AgentWeight } from './configuration-primitives.js';
import type { RiskControlMode } from './bot-configuration.js';

/** 飞书机器人配置的跨端契约：服务端存储形态、保存请求体与对外投影。 */

export const larkEventTypes = ['card.action.trigger', 'im.message.receive_v1'] as const;
export type LarkEventType = typeof larkEventTypes[number];
export interface LarkEventHandler {
  id: string;
  eventTypes: LarkEventType[];
  url: string;
  token: string;
  owner?: string;
  legacyActions?: string[];
}
export interface CardActionForwarding {
  owner: string;
  url: string;
  token: string;
  legacyActions?: string[];
}
export interface LarkAllowedUser {
  openId: string;
  name: string;
}
export type LarkGroupMemoryScope = 'shared' | 'per-group';
/** 群聊里 Claude 自带的 auto memory：'inherit' 沿用 Claude 自己的设置（默认，即历史行为）；'off' 在群聊的 Claude 家族会话里关闭。 */
export type LarkClaudeAutoMemory = 'inherit' | 'off';

export interface LarkCardLink { label: string; url: string; android_url?: string; ios_url?: string; pc_url?: string }

export interface StoredLarkConfig {
  cardLinks?: LarkCardLink[];
  eventHandlers?: LarkEventHandler[];
  eventHandlersError?: string;
  cardActionForwarding?: CardActionForwarding;
  cardActionForwardingError?: string;
  welcomeEnabled?: boolean;
  revision?: number;
  mentionPolicy?: 'always' | 'topic' | 'never' | 'ambient';
  defaultGroupParticipation?: 'off' | 'observe' | 'selective' | 'eager';
  /** Runtime-only resolved group context; never serialized in the Bot configuration. */
  managedGroup?: { bindingId: string; revision: number; principalId?: string };
  appId: string;
  appSecret: string;
  name?: string;
  workspace?: string;
  /**
   * `/new --cwd <别名>` 的「别名 → 服务器绝对路径」表。缺省或空表时 --cwd 的行为完全不变，
   * 仍然只接受绝对路径；别名命中后走的也是同一套目录存在性与权限校验。
   */
  workspaceAliases?: Record<string, string>;
  webBaseUrl?: string;
  /**
   * 配置向导里答了「手机打不开 Web 地址」。此时不保存 webBaseUrl，卡片上就没有「查看详情」和其他 Web 出口；
   * 只在为 false 时出现。
   */
  webMobileReachable?: false;
  defaultAgentId?: string;
  fallbackAgentId?: string;
  fallbackModel?: string;
  defaultAgentWeights?: AgentWeight[];
  defaultModel?: string;
  defaultReasoningEffort?: string;
  /** Explicit consent for unattended Lark sessions to run in full-trust mode. */
  fullTrustConfirmed?: boolean;
  permissionMode?: 'ask' | 'approve-reads' | 'full-trust';
  /**
   * 私聊路由模式：'chat' 整段 DM 共用一个会话；'thread' 每条顶层 DM 开一个新话题。
   * 缺省（旧配置无此字段）由 runtime 按 'chat' 处理。
   */
  p2pMode?: 'chat' | 'thread';
  idleCompactEnabled?: boolean;
  idleCompactHours?: number;
  /**
   * 普通群回复模式：'chat'/'shared' 全群一个会话；'new-topic' 每条顶层 @ 一个话题；
   * 'chat-topic' 顶层平铺、群内原生话题各自独立。缺省由 runtime 决定，不在此落默认值。
   */
  groupReplyMode?: 'chat' | 'shared' | 'new-topic' | 'chat-topic';
  /** Legacy stored environment retained for import compatibility; not injected or exposed publicly. */
  env?: Record<string, string>;
  /** Legacy stored commands retained for import compatibility; not executed or exposed publicly. */
  startupCommands?: string[];
  /**
   * 租户品牌：'feishu'（open.feishu.cn）或 'lark'（open.larksuite.com），决定 SDK domain。
   * 缺省由 runtime 按 'feishu' 处理。
   */
  brand?: 'feishu' | 'lark';
  /**
   * 自定义展示名（备注名），纯展示字段，不影响路由与进程身份。trim 后空串 → undefined。
   */
  displayName?: string;
  /**
   * 角色名称（纯展示与提示词），如「告警值班」。trim 后空串 → undefined。
   */
  roleTitle?: string;
  /**
   * 负责范围，如「报警和告警排查」。trim 后空串 → undefined。
   */
  roleScope?: string;
  preInjectPrompt: string;
  listening: boolean;
  groupToolsEnabled: boolean;
  groupToolsAllowSend: boolean;
  /** 会话记忆开关，Tag 模式缺省开启，其余缺省关闭；false 时不注入记忆，命令与工具不可用。 */
  memoryEnabled?: boolean;
  /** 后台自动提取与整理开关，默认开启；false 时只有 /memory consolidate 能手动触发。 */
  memoryAutoExtract?: boolean;
  /** 群聊记忆范围：'shared' 本机器人所在各群共用一个池（默认，历史行为）；'per-group' 每个群各自一个池。切换不迁移数据。 */
  groupMemoryScope?: LarkGroupMemoryScope;
  /** Claude 自带的 auto memory 按工作目录保存，不受 groupMemoryScope 约束。缺省 'inherit'；'off' 只作用于开启会话记忆的机器人的群聊 Claude 家族会话。 */
  claudeAutoMemory?: LarkClaudeAutoMemory;
  /** 跑提取与整理的 Agent；缺省沿用 defaultAgentId。 */
  memoryAgentId?: string;
  /** 跑提取与整理的模型；缺省沿用 defaultModel。 */
  memoryModel?: string;
  /** 群判定独立选型；缺省沿用 memory，再回落 default。 */
  decisionAgentId?: string;
  decisionModel?: string;
  busyTriage?: boolean;
  /** 防止机器人互相对话的回合门禁，默认关闭。 */
  botLoopGuard?: boolean;
  /** 群回复独立选型；缺省沿用 memory，再回落 default。 */
  responseAgentId?: string;
  responseModel?: string;
  /** Optional final-answer wording pass; absent/false preserves the original. */
  replyPolishEnabled?: boolean;
  replyPolishAgentId?: string;
  replyPolishModel?: string;
  /** Editing deadline in milliseconds; absent uses 60 seconds. */
  replyPolishTimeoutMs?: number;
  /** 执行方式，缺省 single；layered 时默认 Agent 当 PMO，把执行类任务交给 Leader 拆解、Worker 执行。 */
  executionMode?: 'single' | 'layered';
  /** layered 下负责拆解与验收的 Agent。 */
  leaderAgentId?: string;
  /** layered 下 Leader 可以指派的 Worker Agent。 */
  workerAgentIds?: string[];
  /** layered 下 Leader 的指引技能：技能名、`插件名/技能名` 或 SKILL.md 绝对路径；缺省用宿主内置规则。 */
  leaderSkill?: string;
  /** 结构化问答卡片总开关，默认开启；显式 false 使用文字选项与引用回复。 */
  structuredAskCards: boolean;
  /** P0-4 群内卡片 @ 发起人总开关，默认开启；开启后群内结果卡卡尾 @ 发起人，审批/提问卡卡首 @。 */
  groupCardMention: boolean;
  /**
   * 平台验证命令：在会话工作目录真实执行，记录退出码、有限输出与代码指纹。
   * 未配置时结果卡不提验证，也不给「运行验证」按钮——不能暗示一个不存在的能力。
   */
  verificationCommand?: string;
  /**
   * 长时间无人处理的审批/提问卡是否发飞书应用内加急，默认关闭：加急是收件人手机上的
   * 强提醒横幅，升级不能替用户打开它。
   */
  urgentEnabled: boolean;
  /** 卡片发出多久仍无人处理才加急（毫秒），缺省由 workflow-urgent 按 10 分钟处理。 */
  urgentThresholdMs?: number;
  /** 每个群每小时最多加急几次，缺省由 workflow-urgent 按 3 次处理。 */
  urgentMaxPerHourPerChat?: number;
  /**
   * 提醒分档（见 notify-tier）：需要你操作 / 完成两档是否 @ 发起人，缺省开启；信息档永不 @。
   * 需要先开 groupCardMention。normalizeStoredConfig 总是落成显式布尔。
   */
  notifyMentionAction?: boolean;
  notifyMentionDone?: boolean;
  /** 免打扰时段 HH:MM-HH:MM（daemon 本地时区，可跨零点）；缺省不启用。时段内只有「需要你操作」仍 @，加急推迟到时段结束。 */
  notifyQuietHours?: string;
  /** 长任务进度卡是否自动置顶，默认关闭：置顶会改写群成员的会话列表。 */
  pinLongTasks: boolean;
  /** 任务跑多久算长任务（毫秒），缺省按 10 分钟处理。 */
  pinAfterMs?: number;
  pushIntervalMs: number;
  traceLimit?: number;
  hideTraceOnComplete: boolean;
  /**
   * 精简过程卡，默认开启。normalizeStoredConfig 总是落成显式布尔；渲染层只在显式 true 时
   * 精简，缺省（旧配置读入未归一化的路径、旧测试直接构造的 config）按完整记录处理。
   * 精简模式下 hideTraceOnComplete 对过程卡不再生效（各阶段退化为一行标题 markdown）。
   */
  compactTrace?: boolean;
  /** 卡片标题栏显示 Agent 简称，默认关闭。 */
  showAgentName?: boolean;
  /** 完成时只对触发消息贴表情，不再发结果卡，默认关闭。可被群级 presentationOverride 覆盖。 */
  completionReactionOnly: boolean;
  /** 中间进展完全静默，只保留最终结果，默认关闭。可被群级 presentationOverride 覆盖。 */
  silentProgress: boolean;
  /** ADHD 友好输出，默认关闭；打开后每轮飞书任务在用户请求前注入 larkAdhdModePrompt。 */
  adhdMode?: boolean;
  allowedUsers: LarkAllowedUser[];
  allowedEmails: string[];
  allowedBots: LarkAllowedUser[];
  peerBotsAllowed: boolean;
  highRiskAllowedUsers: LarkAllowedUser[];
  highRiskAllowedEmails: string[];
  highRiskPattern: string;
  riskControlMode: RiskControlMode;
}

/** 保存时可传 null 清回默认值的字段。 */
type LarkConfigClearableFields = 'groupReplyMode' | 'urgentThresholdMs' | 'urgentMaxPerHourPerChat' | 'pinAfterMs' | 'traceLimit' | 'replyPolishTimeoutMs';

/**
 * 保存请求体：字段与 StoredLarkConfig 同名同型，未提供时保留原值；以下是与存储形态不同的部分。
 * groupReplyMode 传 null 恢复自动选择；urgentThresholdMs（≥ 60000）、urgentMaxPerHourPerChat（≥ 1 的整数）、
 * pinAfterMs（≥ 1000）、traceLimit、replyPolishTimeoutMs 传 null 清回模块默认。字符串字段归一化时 trim，空白串视为清除或未配置。
 */
export interface SaveLarkConfigInput extends Partial<Omit<StoredLarkConfig, 'eventHandlers' | 'eventHandlersError' | 'cardActionForwarding' | 'cardActionForwardingError' | 'revision' | 'managedGroup' | 'webMobileReachable' | LarkConfigClearableFields>> {
  eventHandlers?: Array<Omit<LarkEventHandler, 'token'> & { token?: string }> | null;
  cardActionForwarding?: CardActionForwarding | null;
  expectedRevision?: number;
  stage?: 'lark' | 'agent';
  originalAppId?: string;
  /** 手机能否打开 webBaseUrl；false 时不保存地址，卡片不显示「查看详情」。未提供时沿用既有答案 */
  webMobileReachable?: boolean;
  groupReplyMode?: StoredLarkConfig['groupReplyMode'] | null;
  urgentThresholdMs?: number | null;
  urgentMaxPerHourPerChat?: number | null;
  pinAfterMs?: number | null;
  traceLimit?: number | null;
  replyPolishTimeoutMs?: number | null;
  allowedBotNames?: string[];
  /** @deprecated Compatibility-only input for clients predating riskControlMode. */
  gateEnabled?: boolean;
  /** @deprecated Compatibility-only input for clients predating riskControlMode. */
  softGateEnabled?: boolean;
  /** @deprecated Compatibility-only input for clients predating riskControlMode. */
  hardGateEnabled?: boolean;
  /** @deprecated Ignored compatibility-only input. */
  hookTrustConfirmed?: boolean;
}

export interface PublicLarkConfig {
  cardLinks?: LarkCardLink[];
  eventHandlers?: Array<Omit<LarkEventHandler, 'token'>>;
  eventHandlersError?: string;
  cardActionForwarding?: Omit<CardActionForwarding, 'token'>;
  cardActionForwardingError?: string;
  welcomeEnabled: boolean;
  revision: number;
  mentionPolicy?: StoredLarkConfig['mentionPolicy'];
  defaultGroupParticipation?: StoredLarkConfig['defaultGroupParticipation'];
  configured: true;
  appId: string;
  name: string;
  tabLabel: string;
  setupComplete: boolean;
  workspace?: string;
  /** `/new --cwd <别名>` 的别名表；没有别名时整个字段缺席。 */
  workspaceAliases?: Record<string, string>;
  webBaseUrl?: string;
  webMobileReachable?: false;
  defaultAgentId?: string;
  fallbackAgentId?: string;
  fallbackModel?: string;
  defaultAgentWeights?: AgentWeight[];
  defaultModel?: string;
  defaultReasoningEffort?: string;
  fullTrustConfirmed: boolean;
  permissionMode?: 'ask' | 'approve-reads' | 'full-trust';
  p2pMode?: 'chat' | 'thread';
  idleCompactEnabled?: boolean;
  idleCompactHours?: number;
  groupReplyMode?: 'chat' | 'shared' | 'new-topic' | 'chat-topic';
  brand?: 'feishu' | 'lark';
  displayName?: string;
  roleTitle?: string;
  roleScope?: string;
  preInjectPrompt: string;
  listening: boolean;
  activeListening: boolean;
  groupToolsEnabled: boolean;
  groupToolsAllowSend: boolean;
  memoryEnabled: boolean;
  memoryAutoExtract: boolean;
  groupMemoryScope: LarkGroupMemoryScope;
  claudeAutoMemory: LarkClaudeAutoMemory;
  memoryAgentId?: string;
  memoryModel?: string;
  decisionAgentId?: string;
  decisionModel?: string;
  busyTriage?: boolean;
  botLoopGuard: boolean;
  responseAgentId?: string;
  responseModel?: string;
  /** Optional final-answer wording pass; absent/false preserves the original. */
  replyPolishEnabled?: boolean;
  replyPolishAgentId?: string;
  replyPolishModel?: string;
  /** Editing deadline in milliseconds; absent uses 60 seconds. */
  replyPolishTimeoutMs?: number;
  executionMode: NonNullable<StoredLarkConfig['executionMode']>;
  leaderAgentId?: string;
  workerAgentIds: string[];
  leaderSkill?: string;
  structuredAskCards: boolean;
  groupCardMention: boolean;
  /** 平台验证命令；未配置时飞书结果卡不提验证，也不给「运行验证」按钮。 */
  verificationCommand?: string;
  urgentEnabled: boolean;
  urgentThresholdMs?: number;
  urgentMaxPerHourPerChat?: number;
  notifyMentionAction: boolean;
  notifyMentionDone: boolean;
  notifyQuietHours?: string;
  pinLongTasks: boolean;
  pinAfterMs?: number;
  pushIntervalMs: number;
  traceLimit?: number;
  hideTraceOnComplete: boolean;
  /** 精简过程卡，默认开启；旧服务端/未归一化配置缺省时按开启处理。 */
  compactTrace: boolean;
  showAgentName: boolean;
  completionReactionOnly: boolean;
  silentProgress: boolean;
  adhdMode: boolean;
  allowedUsers: LarkAllowedUser[];
  allowedEmails: string[];
  allowedBots: LarkAllowedUser[];
  peerBotsAllowed: boolean;
  highRiskAllowedUsers: LarkAllowedUser[];
  highRiskAllowedEmails: string[];
  highRiskPattern: string;
  riskControlMode: RiskControlMode;
}

export interface PublicLarkConfigCollection {
  configured: boolean;
  bots: PublicLarkConfig[];
  listeningDisabled: boolean;
}
