import { parseLarkEventHandlers, validateLarkEventConfiguration, type LarkEventHandler } from './event-pipeline.js';
import { parseCardActionForwarding, type CardActionForwarding } from './card-action-forwarding.js';
import { NEW_BOT_MENTION_POLICY, agentWeightsSchema, type AgentWeight, collaborationParticipationModes, mentionPolicies, resolveParticipation, riskControlModes, supportsRemoteApproval, validateHighRiskPattern, type AgentRepository, type ConfigRepository, type RiskControlMode } from '@dutydeck/shared';
import { isAbsolute } from 'node:path';
import { hostname, userInfo } from 'node:os';
import { LarkServiceError } from './service.js';
import { parseLarkQuietHours } from './notify-tier.js';
import { isLarkGroupMemoryScope, normalizeLarkGroupMemoryScope, type LarkGroupMemoryScope } from './memory.js';

export const larkBotsConfigKey = 'lark.bots';
export const larkCredentialsConfigKey = 'lark.credentials';

export interface LarkAllowedUser {
  openId: string;
  name: string;
}

export { riskControlModes, type RiskControlMode };
export { describeWebBaseUrlReachability, webBaseUrlUnsetMessage, webBaseUrlLocalMessage, webBaseUrlInvalidMessage, type WebBaseUrlReachability } from '@dutydeck/shared';

export interface StoredLarkConfig {
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
  /** 跑提取与整理的 Agent；缺省沿用 defaultAgentId。 */
  memoryAgentId?: string;
  /** 跑提取与整理的模型；缺省沿用 defaultModel。 */
  memoryModel?: string;
  /** 群判定独立选型；缺省沿用 memory，再回落 default。 */
  decisionAgentId?: string;
  decisionModel?: string;
  busyTriage?: boolean;
  /** 群回复独立选型；缺省沿用 memory，再回落 default。 */
  responseAgentId?: string;
  responseModel?: string;
  /** 执行方式，缺省 single；layered 时默认 Agent 当 PMO，把执行类任务交给 Leader 拆解、Worker 执行。 */
  executionMode?: 'single' | 'layered';
  /** layered 下负责拆解与验收的 Agent。 */
  leaderAgentId?: string;
  /** layered 下 Leader 可以指派的 Worker Agent。 */
  workerAgentIds?: string[];
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

/**
 * 机器人执行任务时真正使用的宿主身份：部署这台 Dutydeck 的系统账号。
 * 群里任何人下达的任务都以它运行，因此 /status 必须如实写出来。读取失败时退回占位符，
 * 绝不让一条说明身份的文案自己把命令打挂。
 */
export const larkExecutionIdentity = (): string => {
  try { return `${userInfo().username}@${hostname()}`; }
  catch { return '未知账号@未知主机'; }
};

export const larkPermissionMode = (config: Pick<StoredLarkConfig, 'permissionMode'>) =>
  config.permissionMode === 'ask' || config.permissionMode === 'approve-reads' ? config.permissionMode : 'full-trust' as const;
/**
 * 新建机器人的默认确认方式：所选 Agent 能在飞书逐项审批就默认逐项确认；不能时落成完全信任，
 * 须走完全信任确认后才能保存，不会静默变成一个启动就被拒的逐项确认。还没选 Agent 时按逐项确认。
 * 只用于新建；已有机器人保存过的确认方式不重算。
 */
export const defaultLarkPermissionMode = (agent?: Parameters<typeof supportsRemoteApproval>[0]) =>
  !agent || supportsRemoteApproval(agent) ? 'ask' as const : 'full-trust' as const;
export const larkExecutionConfirmed = (config: Pick<StoredLarkConfig, 'permissionMode' | 'fullTrustConfirmed'>) => larkPermissionMode(config) !== 'full-trust' || config.fullTrustConfirmed === true;

export interface SaveLarkConfigInput {
  eventHandlers?: Array<Omit<LarkEventHandler, 'token'> & { token?: string }> | null;
  cardActionForwarding?: CardActionForwarding | null;
  welcomeEnabled?: boolean;
  expectedRevision?: number;
  mentionPolicy?: StoredLarkConfig['mentionPolicy'];
  defaultGroupParticipation?: StoredLarkConfig['defaultGroupParticipation'];
  stage?: 'lark' | 'agent';
  originalAppId?: string;
  appId?: string;
  appSecret?: string;
  name?: string;
  workspace?: string;
  /** `/new --cwd <别名>` 的别名表；未提供时保留既有别名，传空表示清空。 */
  workspaceAliases?: Record<string, string>;
  webBaseUrl?: string;
  /** 手机能否打开 webBaseUrl；false 时不保存地址，卡片不显示「查看详情」。未提供时沿用既有答案 */
  webMobileReachable?: boolean;
  defaultAgentId?: string;
  fallbackAgentId?: string;
  defaultAgentWeights?: AgentWeight[];
  defaultModel?: string;
  defaultReasoningEffort?: string;
  fullTrustConfirmed?: boolean;
  permissionMode?: 'ask' | 'approve-reads' | 'full-trust';
  /** 私聊路由模式：'chat' 整段 DM 一个会话；'thread' 每条顶层 DM 一个新话题。非法值归一化时丢弃。 */
  p2pMode?: 'chat' | 'thread';
  idleCompactEnabled?: boolean;
  idleCompactHours?: number;
  /** 普通群回复模式：'chat'/'shared' 全群一个会话；'new-topic' 每条顶层 @ 一个话题；'chat-topic' 顶层平铺、群内原生话题各自独立。null 清除显式模式并恢复自动选择；未提供时保留。 */
  groupReplyMode?: 'chat' | 'shared' | 'new-topic' | 'chat-topic' | null;
  /** Legacy stored environment accepted for import compatibility; never returned publicly. */
  env?: Record<string, string>;
  /** Legacy stored commands accepted for import compatibility; never returned publicly. */
  startupCommands?: string[];
  /** 租户品牌：'feishu'（open.feishu.cn）/ 'lark'（open.larksuite.com）。非法值归一化时丢弃。 */
  brand?: 'feishu' | 'lark';
  /** 自定义展示名（纯展示）；归一化时 trim，空白串丢弃。 */
  displayName?: string;
  /** 角色名称；归一化时 trim，空白串丢弃。未提供时保留原值。 */
  roleTitle?: string;
  /** 负责范围；归一化时 trim，空白串丢弃。未提供时保留原值。 */
  roleScope?: string;
  preInjectPrompt?: string;
  listening?: boolean;
  groupToolsEnabled?: boolean;
  groupToolsAllowSend?: boolean;
  memoryEnabled?: boolean;
  memoryAutoExtract?: boolean;
  groupMemoryScope?: LarkGroupMemoryScope;
  memoryAgentId?: string;
  memoryModel?: string;
  decisionAgentId?: string;
  decisionModel?: string;
  busyTriage?: boolean;
  responseAgentId?: string;
  responseModel?: string;
  executionMode?: StoredLarkConfig['executionMode'];
  /** 空白串清除。 */
  leaderAgentId?: string;
  workerAgentIds?: string[];
  /** P0-2 结构化问答卡片总开关；缺省继承当前配置，仍缺省按关闭处理。 */
  structuredAskCards?: boolean;
  /** P0-4 群内卡片 @ 发起人总开关；缺省继承当前配置，仍缺省按开启处理。 */
  groupCardMention?: boolean;
  /** 平台验证命令；缺省继承当前配置，空白串视为未配置。 */
  verificationCommand?: string;
  /** 卡片加急总开关；缺省继承当前配置，仍缺省按关闭处理。 */
  urgentEnabled?: boolean;
  /** 加急超时阈值（毫秒），必须 ≥ 60000；缺省继承当前配置，null 表示清回模块默认。 */
  urgentThresholdMs?: number | null;
  /** 每群每小时加急上限，必须是 ≥ 1 的整数；缺省继承当前配置，null 表示清回模块默认。 */
  urgentMaxPerHourPerChat?: number | null;
  /** 「需要你操作」档是否 @ 发起人；缺省继承当前配置，仍缺省按开启处理。 */
  notifyMentionAction?: boolean;
  /** 「完成」档是否 @ 发起人；缺省继承当前配置，仍缺省按开启处理。 */
  notifyMentionDone?: boolean;
  /** 免打扰时段 HH:MM-HH:MM；缺省继承当前配置，空白串关闭。 */
  notifyQuietHours?: string;
  /** 长任务置顶总开关；缺省继承当前配置，仍缺省按关闭处理。 */
  pinLongTasks?: boolean;
  /** 长任务判定时长（毫秒），必须 ≥ 1000；缺省继承当前配置，null 表示清回模块默认。 */
  pinAfterMs?: number | null;
  pushIntervalMs?: number;
  traceLimit?: number | null;
  hideTraceOnComplete?: boolean;
  /** 精简过程卡；缺省继承当前配置，仍缺省按开启处理。 */
  compactTrace?: boolean;
  /** 卡片标题栏显示 Agent 简称，默认关闭。 */
  showAgentName?: boolean;
  completionReactionOnly?: boolean;
  silentProgress?: boolean;
  adhdMode?: boolean;
  allowedUsers?: LarkAllowedUser[];
  allowedEmails?: string[];
  allowedBots?: LarkAllowedUser[];
  allowedBotNames?: string[];
  peerBotsAllowed?: boolean;
  highRiskAllowedUsers?: LarkAllowedUser[];
  highRiskAllowedEmails?: string[];
  highRiskPattern?: string;
  riskControlMode?: RiskControlMode;
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
  memoryAgentId?: string;
  memoryModel?: string;
  decisionAgentId?: string;
  decisionModel?: string;
  busyTriage?: boolean;
  responseAgentId?: string;
  responseModel?: string;
  executionMode: NonNullable<StoredLarkConfig['executionMode']>;
  leaderAgentId?: string;
  workerAgentIds: string[];
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

export const defaultLarkPushIntervalMs = 1_000;
export const defaultLarkTraceLimit = 50;
export const defaultLarkIdleCompactHours = 24;
export const defaultHighRiskPattern = String.raw`(?:^|[\s;&|])(?:sudo|rm|shred|dd|mkfs|diskutil|launchctl|kill|pkill|lark-?cli|larkcli|bits-?cli|bitscli|bytedcli|ssh|scp|rsync|osascript)\b|\bgit\s+(?:push|reset|clean|checkout)\b|\b(?:npm|pnpm|yarn)\s+(?:publish|unpublish)\b|\bcurl\b[^\n]*(?:-X|--request)\s*(?:POST|PUT|PATCH|DELETE)\b`;

const normalizeEmails = (value: unknown) => [...new Set((Array.isArray(value) ? value : [])
  .map(item => String(item).trim().toLowerCase()).filter(Boolean))];

const normalizeWebBaseUrl = (value: unknown) => {
  const trimmed = String(value ?? '').trim().replace(/\/$/, '');
  if (!trimmed) return undefined;
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
};

const normalizeAllowedUsers = (value: unknown): LarkAllowedUser[] => {
  const users = new Map<string, LarkAllowedUser>();
  for (const item of Array.isArray(value) ? value : []) {
    if (!item || typeof item !== 'object') continue;
    const openId = String((item as Partial<LarkAllowedUser>).openId ?? '').trim();
    if (!openId.startsWith('ou_')) continue;
    const name = String((item as Partial<LarkAllowedUser>).name ?? '').trim() || openId;
    users.set(openId, { openId, name });
  }
  return [...users.values()];
};

/** 只保留指向绝对路径的别名；全部无效时返回 undefined，配置里就不会留下一张空表。 */
const normalizeWorkspaceAliases = (value: unknown): Record<string, string> | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const aliases: Record<string, string> = {};
  for (const [alias, target] of Object.entries(value)) {
    const name = alias.trim();
    const path = typeof target === 'string' ? target.trim() : '';
    if (!name || !path || !isAbsolute(path)) continue;
    aliases[name] = path;
  }
  return Object.keys(aliases).length > 0 ? aliases : undefined;
};

const normalizeP2pMode = (value: unknown): 'chat' | 'thread' | undefined =>
  value === 'chat' || value === 'thread' ? value : undefined;

const normalizeGroupReplyMode = (value: unknown): StoredLarkConfig['groupReplyMode'] =>
  value === 'chat' || value === 'shared' || value === 'new-topic' || value === 'chat-topic' ? value : undefined;

const normalizeDefaultGroupParticipation = (value: unknown): NonNullable<StoredLarkConfig['defaultGroupParticipation']> =>
  value === 'observe' || value === 'selective' || value === 'eager' ? value : 'off';

export const larkMemoryEnabled = (config: Pick<StoredLarkConfig, 'memoryEnabled' | 'defaultGroupParticipation'>): boolean =>
  config.memoryEnabled ?? ['selective', 'eager'].includes(normalizeDefaultGroupParticipation(config.defaultGroupParticipation));

const normalizeBrand = (value: unknown): 'feishu' | 'lark' | undefined =>
  value === 'feishu' || value === 'lark' ? value : undefined;

const normalizeEnv = (value: unknown): Record<string, string> | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const env: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string') env[key] = item;
  }
  return Object.keys(env).length > 0 ? env : undefined;
};

const normalizeStartupCommands = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const commands = value.map(item => String(item).trim()).filter(Boolean);
  return commands.length > 0 ? commands : undefined;
};

/** 加急阈值下限 1 分钟：更短就等于卡片一发出去就推强提醒横幅，那不叫「提醒无人处理」。 */
export const minLarkUrgentThresholdMs = 60_000;
/** 长任务判定下限 1 秒：置顶随时可撤、终态自动撤，不需要和强提醒一样的下限。 */
export const minLarkPinAfterMs = 1_000;

/** 毫秒阈值：非法或低于下限的值整条丢弃，回落各自模块的内置默认。 */
const normalizeDelayMs = (value: unknown, minimum: number): number | undefined => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum ? parsed : undefined;
};

/** 每群每小时加急上限：≥ 1 的整数，其余丢弃回落默认。 */
const normalizeUrgentQuota = (value: unknown): number | undefined => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : undefined;
};

const normalizeDisplayName = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
};

const normalizeRoleField = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
};

const isRiskControlMode = (value: unknown): value is RiskControlMode =>
  riskControlModes.includes(value as RiskControlMode);

type LegacyRiskControlShape = {
  riskControlMode?: unknown;
  gateEnabled?: unknown;
  softGateEnabled?: unknown;
  hardGateEnabled?: unknown;
  hookTrustConfirmed?: unknown;
};

const normalizeRiskControlMode = (value: LegacyRiskControlShape): RiskControlMode => {
  if (isRiskControlMode(value.riskControlMode)) return value.riskControlMode;
  // The old hard/soft flags were subordinate to the legacy master switch.
  // A client disabling that switch could still send stale child flags.
  if (value.gateEnabled === false) return 'off';
  if (value.hardGateEnabled === true) return 'enforced';
  if (value.gateEnabled === true || value.softGateEnabled === true) return 'guidance';
  return 'off';
};

export const resolveRiskControlModeInput = (input: SaveLarkConfigInput, fallback: RiskControlMode = 'off'): RiskControlMode => {
  if (isRiskControlMode(input.riskControlMode)) return input.riskControlMode;
  if (input.riskControlMode !== undefined) {
    throw new LarkServiceError('INVALID_LARK_CONFIG', 'Risk control mode must be off, guidance, or enforced', 400);
  }
  const hasLegacyInput = input.gateEnabled !== undefined
    || input.softGateEnabled !== undefined
    || input.hardGateEnabled !== undefined
    || input.hookTrustConfirmed !== undefined;
  return hasLegacyInput ? normalizeRiskControlMode(input) : fallback;
};

const needsRiskControlMigration = (value: unknown): boolean => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return !isRiskControlMode(record.riskControlMode)
    || ['gateEnabled', 'softGateEnabled', 'hardGateEnabled', 'hookTrustConfirmed'].some(key => key in record);
};

const normalizeAgentIds = (value: unknown): string[] => Array.isArray(value)
  ? [...new Set(value.filter((id): id is string => typeof id === 'string').map(id => id.trim()).filter(Boolean))]
  : [];

// 解析失败的子对象不进运行时/公开视图，但原始值按字段登记并在写回时原样保留，
// 使不相关的写入不会丢掉待修复的配置；新增同类子对象只需在 normalize 里登记一处。
type InvalidLarkField = { raw: unknown; message: string };
const invalidLarkFields = new WeakMap<StoredLarkConfig, Map<string, InvalidLarkField>>();
const invalidEventHandlersMessage = '存储的 eventHandlers 无效；请提交合法配置或 null 后重启监听。';
const invalidForwardingMessage = '存储的 cardActionForwarding 无效；请提交合法配置或 null 后重启监听。';

/** 阻止该 Bot 监听启动的损坏配置错误（任意一个字段，按登记顺序）；无损坏时返回 undefined。 */
export const larkConfigBlockingError = (config: StoredLarkConfig): string | undefined =>
  invalidLarkFields.get(config)?.values().next().value?.message;

const serializeLarkConfigs = (configs: StoredLarkConfig[]) => JSON.stringify(configs.map(stored => {
  const invalid = invalidLarkFields.get(stored);
  if (!invalid) return stored;
  const config: Record<string, unknown> = { ...stored };
  // error 只是运行时视图，原始坏值还原回同名字段后一起写回。
  for (const [field, { raw }] of invalid) {
    delete config[`${field}Error`];
    config[field] = raw;
  }
  return config;
}));

function normalizeStoredConfig(parsed: Partial<StoredLarkConfig> & LegacyRiskControlShape): StoredLarkConfig | undefined {
  if (!parsed.appId || !parsed.appSecret) return undefined;
  const invalidFields = new Map<string, InvalidLarkField>();
  let cardActionForwarding: CardActionForwarding | undefined;
  let cardActionForwardingError: string | undefined;
  try { cardActionForwarding = parseCardActionForwarding(parsed.cardActionForwarding); }
  catch {
    cardActionForwardingError = invalidForwardingMessage;
    invalidFields.set('cardActionForwarding', { raw: parsed.cardActionForwarding, message: invalidForwardingMessage });
  }
  let eventHandlers: LarkEventHandler[] | undefined;
  let eventHandlersError: string | undefined;
  try {
    eventHandlers = parseLarkEventHandlers(parsed.eventHandlers);
    validateLarkEventConfiguration({ eventHandlers, cardActionForwarding });
  } catch {
    eventHandlersError = invalidEventHandlersMessage; eventHandlers = undefined;
    invalidFields.set('eventHandlers', { raw: parsed.eventHandlers, message: invalidEventHandlersMessage });
  }
  const pushIntervalMs = Number(parsed.pushIntervalMs ?? defaultLarkPushIntervalMs);
  const parsedTraceLimit = Number(parsed.traceLimit ?? defaultLarkTraceLimit);
  const traceLimit = Number.isInteger(parsedTraceLimit) && parsedTraceLimit > 0 ? parsedTraceLimit : defaultLarkTraceLimit;
  const p2pMode = normalizeP2pMode(parsed.p2pMode);
  const groupReplyMode = normalizeGroupReplyMode(parsed.groupReplyMode);
  const env = normalizeEnv(parsed.env);
  const startupCommands = normalizeStartupCommands(parsed.startupCommands);
  const brand = normalizeBrand(parsed.brand);
  const displayName = normalizeDisplayName(parsed.displayName);
  const roleTitle = normalizeRoleField(parsed.roleTitle);
  const roleScope = normalizeRoleField(parsed.roleScope);
  const config: StoredLarkConfig = {
    welcomeEnabled: parsed.welcomeEnabled !== false,
    ...(eventHandlersError ? { eventHandlersError } : {}),
    ...(eventHandlers ? { eventHandlers } : {}),
    ...(cardActionForwardingError ? { cardActionForwardingError } : {}),
    ...(cardActionForwarding ? { cardActionForwarding } : {}),
    appId: parsed.appId.trim(),
    revision: Number.isInteger(parsed.revision) && Number(parsed.revision) > 0 ? parsed.revision : 1,
    mentionPolicy: resolveParticipation({ mentionPolicy: parsed.mentionPolicy }).mentionPolicy,
    defaultGroupParticipation: normalizeDefaultGroupParticipation(parsed.defaultGroupParticipation),
    appSecret: parsed.appSecret,
    ...(parsed.name?.trim() ? { name: parsed.name.trim() } : {}),
    ...(parsed.workspace?.trim() ? { workspace: parsed.workspace.trim() } : {}),
    ...(normalizeWorkspaceAliases(parsed.workspaceAliases) ? { workspaceAliases: normalizeWorkspaceAliases(parsed.workspaceAliases)! } : {}),
    ...(parsed.webMobileReachable !== false && normalizeWebBaseUrl(parsed.webBaseUrl) ? { webBaseUrl: normalizeWebBaseUrl(parsed.webBaseUrl) } : {}),
    ...(parsed.webMobileReachable === false ? { webMobileReachable: false as const } : {}),
    ...(parsed.fallbackAgentId ? { fallbackAgentId: parsed.fallbackAgentId } : {}),
    ...(parsed.defaultAgentId ? { defaultAgentId: parsed.defaultAgentId } : {}),
    ...(parsed.defaultAgentWeights ? { defaultAgentWeights: agentWeightsSchema.parse(parsed.defaultAgentWeights) } : {}),
    ...(parsed.defaultModel ? { defaultModel: parsed.defaultModel } : {}),
    ...(parsed.defaultReasoningEffort ? { defaultReasoningEffort: parsed.defaultReasoningEffort } : {}),
    fullTrustConfirmed: parsed.fullTrustConfirmed === true,
    // 没确认过完全信任时：显式写了 full-trust 的原样保留（照旧不能运行，迁移写回时也不丢），
    // 没写权限模式的默认只读自动放行：执行端声明为读取或搜索的操作直接执行，其余照常逐项审批。
    ...(parsed.permissionMode === 'ask' || parsed.permissionMode === 'approve-reads' ? { permissionMode: parsed.permissionMode }
      : parsed.fullTrustConfirmed === true ? {} : { permissionMode: parsed.permissionMode === 'full-trust' ? 'full-trust' as const : 'approve-reads' as const }),
    ...(p2pMode ? { p2pMode } : {}),
    idleCompactEnabled: parsed.idleCompactEnabled !== false,
    idleCompactHours: Number.isSafeInteger(parsed.idleCompactHours) && Number(parsed.idleCompactHours) >= 1 ? parsed.idleCompactHours : defaultLarkIdleCompactHours,
    ...(groupReplyMode ? { groupReplyMode } : {}),
    ...(env ? { env } : {}),
    ...(startupCommands ? { startupCommands } : {}),
    ...(brand ? { brand } : {}),
    ...(displayName ? { displayName } : {}),
    ...(roleTitle ? { roleTitle } : {}),
    ...(roleScope ? { roleScope } : {}),
    preInjectPrompt: String(parsed.preInjectPrompt ?? '').trim(),
    listening: parsed.listening === true,
    groupToolsEnabled: parsed.groupToolsEnabled === true,
    groupToolsAllowSend: parsed.groupToolsEnabled === true && parsed.groupToolsAllowSend === true,
    memoryEnabled: larkMemoryEnabled(parsed),
    memoryAutoExtract: parsed.memoryAutoExtract !== false,
    busyTriage: parsed.busyTriage === true,
    groupMemoryScope: normalizeLarkGroupMemoryScope(parsed.groupMemoryScope),
    ...(parsed.memoryAgentId?.trim() ? { memoryAgentId: parsed.memoryAgentId.trim() } : {}),
    ...(parsed.memoryModel?.trim() ? { memoryModel: parsed.memoryModel.trim() } : {}),
    ...(parsed.decisionAgentId?.trim() ? { decisionAgentId: parsed.decisionAgentId.trim() } : {}),
    ...(parsed.decisionModel?.trim() ? { decisionModel: parsed.decisionModel.trim() } : {}),
    ...(parsed.responseAgentId?.trim() ? { responseAgentId: parsed.responseAgentId.trim() } : {}),
    ...(parsed.responseModel?.trim() ? { responseModel: parsed.responseModel.trim() } : {}),
    ...(parsed.executionMode === 'layered' ? { executionMode: 'layered' as const } : {}),
    ...(parsed.leaderAgentId?.trim() ? { leaderAgentId: parsed.leaderAgentId.trim() } : {}),
    ...(normalizeAgentIds(parsed.workerAgentIds).length ? { workerAgentIds: normalizeAgentIds(parsed.workerAgentIds) } : {}),
    structuredAskCards: parsed.structuredAskCards === undefined || parsed.structuredAskCards === true,
    groupCardMention: parsed.groupCardMention === undefined || parsed.groupCardMention === true,
    ...(parsed.verificationCommand?.trim() ? { verificationCommand: parsed.verificationCommand.trim() } : {}),
    urgentEnabled: parsed.urgentEnabled === true,
    ...(normalizeDelayMs(parsed.urgentThresholdMs, minLarkUrgentThresholdMs) !== undefined ? { urgentThresholdMs: normalizeDelayMs(parsed.urgentThresholdMs, minLarkUrgentThresholdMs)! } : {}),
    ...(normalizeUrgentQuota(parsed.urgentMaxPerHourPerChat) !== undefined ? { urgentMaxPerHourPerChat: normalizeUrgentQuota(parsed.urgentMaxPerHourPerChat)! } : {}),
    notifyMentionAction: parsed.notifyMentionAction !== false,
    notifyMentionDone: parsed.notifyMentionDone !== false,
    ...(parseLarkQuietHours(parsed.notifyQuietHours) ? { notifyQuietHours: parsed.notifyQuietHours!.trim() } : {}),
    pinLongTasks: parsed.pinLongTasks === true,
    ...(normalizeDelayMs(parsed.pinAfterMs, minLarkPinAfterMs) !== undefined ? { pinAfterMs: normalizeDelayMs(parsed.pinAfterMs, minLarkPinAfterMs)! } : {}),
    pushIntervalMs: Number.isInteger(pushIntervalMs) && pushIntervalMs >= 500 && pushIntervalMs <= 20_000 ? pushIntervalMs : defaultLarkPushIntervalMs,
    traceLimit,
    hideTraceOnComplete: parsed.hideTraceOnComplete !== false,
    compactTrace: parsed.compactTrace !== false,
    showAgentName: parsed.showAgentName === true,
    completionReactionOnly: parsed.completionReactionOnly === true,
    silentProgress: parsed.silentProgress === true,
    adhdMode: parsed.adhdMode === true,
    allowedUsers: normalizeAllowedUsers(parsed.allowedUsers),
    allowedEmails: normalizeEmails(parsed.allowedEmails),
    allowedBots: normalizeAllowedUsers(parsed.allowedBots),
    peerBotsAllowed: parsed.peerBotsAllowed !== false,
    highRiskAllowedUsers: normalizeAllowedUsers(parsed.highRiskAllowedUsers),
    highRiskAllowedEmails: normalizeEmails(parsed.highRiskAllowedEmails),
    highRiskPattern: parsed.highRiskPattern?.trim() || defaultHighRiskPattern,
    riskControlMode: normalizeRiskControlMode(parsed)
  };
  if (invalidFields.size) invalidLarkFields.set(config, invalidFields);
  return config;
}

export async function readLarkConfigs(repository?: ConfigRepository, options: { readOnly?: boolean } = {}): Promise<StoredLarkConfig[]> {
  const stored = await repository?.get(larkBotsConfigKey);
  if (stored) {
    try {
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed)) {
        const configs = parsed.map(item => normalizeStoredConfig(item)).filter((item): item is StoredLarkConfig => Boolean(item));
        if (!options.readOnly && parsed.some(needsRiskControlMigration)) {
          if (repository?.compareAndSet) {
            if (!await repository.compareAndSet(larkBotsConfigKey, stored, serializeLarkConfigs(configs))) return readLarkConfigs(repository, options);
          } else await repository?.set(larkBotsConfigKey, serializeLarkConfigs(configs));
        }
        return configs;
      }
    } catch {}
  }
  const legacy = await repository?.get(larkCredentialsConfigKey);
  if (!legacy) return [];
  try {
    const config = normalizeStoredConfig(JSON.parse(legacy));
    if (config && !options.readOnly) {
      if (repository?.compareAndSet) {
        if (!await repository.compareAndSet(larkBotsConfigKey, stored, serializeLarkConfigs([config]))) return readLarkConfigs(repository, options);
      } else await repository?.set(larkBotsConfigKey, serializeLarkConfigs([config]));
    }
    return config ? [config] : [];
  } catch { return []; }
}

export async function readLarkConfig(repository?: ConfigRepository, appId?: string, options: { readOnly?: boolean } = {}): Promise<StoredLarkConfig | undefined> {
  const configs = await readLarkConfigs(repository, options);
  return appId ? configs.find(config => config.appId === appId) : configs[0];
}

export const publicLarkConfig = (config: StoredLarkConfig, activeAppIds: ReadonlySet<string> = new Set(), duplicateNames: ReadonlySet<string> = new Set()): PublicLarkConfig => ({
  ...(config.eventHandlers ? { eventHandlers: config.eventHandlers.map(({ token, ...handler }) => handler) } : {}),
  ...(config.eventHandlersError ? { eventHandlersError: config.eventHandlersError } : {}),
  ...(config.cardActionForwarding ? { cardActionForwarding: { owner: config.cardActionForwarding.owner, url: config.cardActionForwarding.url, ...(config.cardActionForwarding.legacyActions ? { legacyActions: config.cardActionForwarding.legacyActions } : {}) } } : {}),
  welcomeEnabled: config.welcomeEnabled !== false,
  ...(config.cardActionForwardingError ? { cardActionForwardingError: config.cardActionForwardingError } : {}),
  configured: true,
  appId: config.appId,
  revision: config.revision ?? 1,
  mentionPolicy: resolveParticipation({ mentionPolicy: config.mentionPolicy }).mentionPolicy,
  defaultGroupParticipation: normalizeDefaultGroupParticipation(config.defaultGroupParticipation),
  name: config.name ?? config.appId,
  tabLabel: duplicateNames.has((config.name ?? config.appId).toLowerCase()) ? `${config.name ?? config.appId} · ${config.appId}` : config.name ?? config.appId,
  setupComplete: Boolean(config.defaultAgentId && larkExecutionConfirmed(config)),
  ...(config.workspace ? { workspace: config.workspace } : {}),
  ...(config.workspaceAliases ? { workspaceAliases: config.workspaceAliases } : {}),
  ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}),
  ...(config.webMobileReachable === false ? { webMobileReachable: false as const } : {}),
  ...(config.fallbackAgentId ? { fallbackAgentId: config.fallbackAgentId } : {}),
  ...(config.defaultAgentId ? { defaultAgentId: config.defaultAgentId } : {}),
  ...(config.defaultAgentWeights ? { defaultAgentWeights: config.defaultAgentWeights } : {}),
  ...(config.defaultModel ? { defaultModel: config.defaultModel } : {}),
  ...(config.defaultReasoningEffort ? { defaultReasoningEffort: config.defaultReasoningEffort } : {}),
  fullTrustConfirmed: config.fullTrustConfirmed === true,
  permissionMode: larkPermissionMode(config),
  ...(config.p2pMode ? { p2pMode: config.p2pMode } : {}),
  idleCompactEnabled: config.idleCompactEnabled !== false,
  idleCompactHours: config.idleCompactHours ?? defaultLarkIdleCompactHours,
  ...(config.groupReplyMode ? { groupReplyMode: config.groupReplyMode } : {}),
  ...(config.brand ? { brand: config.brand } : {}),
  ...(config.displayName ? { displayName: config.displayName } : {}),
  ...(config.roleTitle ? { roleTitle: config.roleTitle } : {}),
  ...(config.roleScope ? { roleScope: config.roleScope } : {}),
  ...(config.verificationCommand ? { verificationCommand: config.verificationCommand } : {}),
  urgentEnabled: config.urgentEnabled === true,
  ...(config.urgentThresholdMs !== undefined ? { urgentThresholdMs: config.urgentThresholdMs } : {}),
  ...(config.urgentMaxPerHourPerChat !== undefined ? { urgentMaxPerHourPerChat: config.urgentMaxPerHourPerChat } : {}),
  notifyMentionAction: config.notifyMentionAction !== false,
  notifyMentionDone: config.notifyMentionDone !== false,
  ...(parseLarkQuietHours(config.notifyQuietHours) ? { notifyQuietHours: config.notifyQuietHours } : {}),
  pinLongTasks: config.pinLongTasks === true,
  ...(config.pinAfterMs !== undefined ? { pinAfterMs: config.pinAfterMs } : {}),
  preInjectPrompt: config.preInjectPrompt,
  listening: config.listening,
  activeListening: activeAppIds.has(config.appId),
  groupToolsEnabled: config.groupToolsEnabled,
  groupToolsAllowSend: config.groupToolsAllowSend,
  memoryEnabled: larkMemoryEnabled(config),
  memoryAutoExtract: config.memoryAutoExtract !== false,
  busyTriage: config.busyTriage === true,
  groupMemoryScope: normalizeLarkGroupMemoryScope(config.groupMemoryScope),
  ...(config.memoryAgentId ? { memoryAgentId: config.memoryAgentId } : {}),
  ...(config.memoryModel ? { memoryModel: config.memoryModel } : {}),
  ...(config.decisionAgentId ? { decisionAgentId: config.decisionAgentId } : {}),
  ...(config.decisionModel ? { decisionModel: config.decisionModel } : {}),
  ...(config.responseAgentId ? { responseAgentId: config.responseAgentId } : {}),
  ...(config.responseModel ? { responseModel: config.responseModel } : {}),
  executionMode: config.executionMode === 'layered' ? 'layered' : 'single',
  ...(config.leaderAgentId ? { leaderAgentId: config.leaderAgentId } : {}),
  workerAgentIds: config.workerAgentIds ?? [],
  structuredAskCards: config.structuredAskCards !== false,
  groupCardMention: config.groupCardMention === true,
  pushIntervalMs: config.pushIntervalMs,
  traceLimit: config.traceLimit ?? defaultLarkTraceLimit,
  hideTraceOnComplete: config.hideTraceOnComplete,
  compactTrace: config.compactTrace !== false,
  showAgentName: config.showAgentName === true,
  completionReactionOnly: config.completionReactionOnly === true,
  silentProgress: config.silentProgress === true,
  adhdMode: config.adhdMode === true,
  allowedUsers: config.allowedUsers,
  allowedEmails: config.allowedEmails,
  allowedBots: config.allowedBots,
  peerBotsAllowed: config.peerBotsAllowed,
  highRiskAllowedUsers: config.highRiskAllowedUsers,
  highRiskAllowedEmails: config.highRiskAllowedEmails,
  highRiskPattern: config.highRiskPattern,
  riskControlMode: config.riskControlMode
});

export const publicLarkConfigs = (configs: StoredLarkConfig[], runtime: { activeAppIds?: readonly string[]; listeningDisabled?: boolean } = {}): PublicLarkConfigCollection => {
  const active = new Set(runtime.activeAppIds ?? []);
  const counts = new Map<string, number>();
  for (const config of configs) {
    const key = (config.name ?? config.appId).toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const duplicateNames = new Set([...counts].filter(([, count]) => count > 1).map(([name]) => name));
  return {
    configured: configs.length > 0,
    bots: configs.map(config => publicLarkConfig(config, active, duplicateNames)),
    listeningDisabled: runtime.listeningDisabled === true
  };
};

async function saveLarkConfigUnlocked(repository: ConfigRepository | undefined, agents: AgentRepository | undefined, input: SaveLarkConfigInput): Promise<StoredLarkConfig[]> {
  if (!repository) throw new LarkServiceError('LARK_CONFIG_STORAGE_UNAVAILABLE', 'Lark configuration storage is unavailable', 503);
  const configs = await readLarkConfigs(repository);
  const submittedForwarding = parseCardActionForwarding(input.cardActionForwarding);
  const originalAppId = input.originalAppId?.trim();
  const index = originalAppId ? configs.findIndex(config => config.appId === originalAppId) : -1;
  if (originalAppId && index < 0) throw new LarkServiceError('LARK_BOT_NOT_FOUND', `Unknown Lark bot: ${originalAppId}`, 404);
  const current = index >= 0 ? configs[index] : undefined;
  // 该 Bot 存有损坏字段时，任何不相关写入都拒绝，逼调用方显式提交合法值或 null 修复，避免坏值被静默重写。
  const invalid = current ? invalidLarkFields.get(current) : undefined;
  if (invalid) for (const [field, { message }] of invalid) {
    if ((input as Record<string, unknown>)[field] === undefined) throw new LarkServiceError('INVALID_LARK_CONFIG', message, 400);
  }
  const eventHandlers = input.eventHandlers === undefined ? current?.eventHandlers : parseLarkEventHandlers(input.eventHandlers, current?.eventHandlers);
  const cardActionForwarding = input.cardActionForwarding === undefined ? current?.cardActionForwarding : submittedForwarding;
  validateLarkEventConfiguration({ eventHandlers, cardActionForwarding });
  if (input.busyTriage !== undefined && typeof input.busyTriage !== 'boolean') throw new LarkServiceError('INVALID_LARK_CONFIG', 'busyTriage 必须为布尔值。', 400);
  if (input.showAgentName !== undefined && typeof input.showAgentName !== 'boolean') throw new LarkServiceError('INVALID_LARK_CONFIG', 'showAgentName 必须为布尔值。', 400);
  if (input.welcomeEnabled !== undefined && typeof input.welcomeEnabled !== 'boolean') throw new LarkServiceError('INVALID_LARK_CONFIG', 'welcomeEnabled 必须为布尔值。', 400);
  if (input.expectedRevision !== undefined && input.expectedRevision !== (current ? current.revision ?? 1 : 0)) {
    throw new LarkServiceError('LARK_CONFIG_REVISION_CONFLICT', '此 Bot 已被修改，请比较最新配置后再保存。', 409);
  }
  if (input.mentionPolicy !== undefined && !mentionPolicies.includes(input.mentionPolicy)) {
    throw new LarkServiceError('INVALID_LARK_CONFIG', '提及方式无效。', 400);
  }
  if (input.defaultGroupParticipation !== undefined && !collaborationParticipationModes.includes(input.defaultGroupParticipation)) {
    throw new LarkServiceError('INVALID_LARK_CONFIG', '默认群参与模式无效。', 400);
  }
  if (input.executionMode !== undefined && !['single', 'layered'].includes(input.executionMode)) {
    throw new LarkServiceError('INVALID_LARK_CONFIG', '执行方式无效。', 400);
  }
  if (input.idleCompactEnabled !== undefined && typeof input.idleCompactEnabled !== 'boolean') {
    throw new LarkServiceError('INVALID_LARK_CONFIG', '空闲后自动压缩上下文开关必须为布尔值。', 400);
  }
  if (input.adhdMode !== undefined && typeof input.adhdMode !== 'boolean') {
    throw new LarkServiceError('INVALID_LARK_CONFIG', 'ADHD 友好输出开关必须为布尔值。', 400);
  }
  if (input.idleCompactHours !== undefined && (!Number.isSafeInteger(input.idleCompactHours) || input.idleCompactHours < 1)) {
    throw new LarkServiceError('INVALID_LARK_CONFIG', '空闲时长必须是至少 1 小时的整数。', 400);
  }
  const appId = input.appId?.trim() || current?.appId;
  const appSecret = input.appSecret?.trim() || current?.appSecret;
  const name = input.name === undefined ? current?.name : input.name.trim() || undefined;
  const workspace = input.workspace === undefined ? current?.workspace : input.workspace.trim() || undefined;
  const workspaceAliases = input.workspaceAliases === undefined ? current?.workspaceAliases : normalizeWorkspaceAliases(input.workspaceAliases);
  // 同一套部署的机器人共用一个控制台。新建时没给地址（扫码一键创建、CLI 创建都不带）就沿用
  // 已有机器人的地址，否则卡片上没有「查看详情」；显式传空串仍表示不配置。
  // 答了手机打不开这个地址就不存地址：卡片的「查看详情」和其他 Web 出口都从它来。
  const webMobileReachable = typeof input.webMobileReachable === 'boolean' ? input.webMobileReachable : current?.webMobileReachable !== false;
  const webBaseUrl = !webMobileReachable ? undefined : input.webBaseUrl !== undefined ? normalizeWebBaseUrl(input.webBaseUrl)
    : current ? current.webBaseUrl : configs.find(config => config.webBaseUrl)?.webBaseUrl;
  const defaultAgentId = input.defaultAgentId?.trim() || current?.defaultAgentId;
  const fallbackAgentId = input.fallbackAgentId === undefined ? current?.fallbackAgentId : input.fallbackAgentId.trim() || undefined;
  const weightsResult = agentWeightsSchema.safeParse(input.defaultAgentWeights === undefined ? current?.defaultAgentWeights ?? [] : input.defaultAgentWeights);
  if (!weightsResult.success) throw new LarkServiceError('INVALID_LARK_CONFIG', 'Agent weights must contain distinct Agent IDs and finite positive weights.', 400);
  const defaultAgentWeights = weightsResult.data;
  const listening = input.listening ?? current?.listening ?? false;
  const groupToolsEnabled = input.groupToolsEnabled ?? current?.groupToolsEnabled ?? false;
  const groupToolsAllowSend = groupToolsEnabled && (input.groupToolsAllowSend ?? current?.groupToolsAllowSend ?? false);
  const memoryEnabled = input.memoryEnabled ?? current?.memoryEnabled ?? (input.defaultGroupParticipation === 'selective' || input.defaultGroupParticipation === 'eager');
  const memoryAutoExtract = input.memoryAutoExtract ?? current?.memoryAutoExtract ?? true;
  const groupMemoryScope = isLarkGroupMemoryScope(input.groupMemoryScope) ? input.groupMemoryScope : normalizeLarkGroupMemoryScope(current?.groupMemoryScope);
  const memoryAgentId = input.memoryAgentId === undefined ? current?.memoryAgentId : input.memoryAgentId.trim() || undefined;
  const memoryModel = input.memoryModel === undefined ? current?.memoryModel : input.memoryModel.trim() || undefined;
  const decisionAgentId = input.decisionAgentId === undefined ? current?.decisionAgentId : input.decisionAgentId.trim() || undefined;
  const decisionModel = input.decisionModel === undefined ? current?.decisionModel : input.decisionModel.trim() || undefined;
  const responseAgentId = input.responseAgentId === undefined ? current?.responseAgentId : input.responseAgentId.trim() || undefined;
  const responseModel = input.responseModel === undefined ? current?.responseModel : input.responseModel.trim() || undefined;
  const executionMode = input.executionMode ?? current?.executionMode ?? 'single';
  const leaderAgentId = input.leaderAgentId === undefined ? current?.leaderAgentId : input.leaderAgentId.trim() || undefined;
  const workerAgentIds = input.workerAgentIds === undefined ? current?.workerAgentIds ?? [] : normalizeAgentIds(input.workerAgentIds);
  const structuredAskCards = input.structuredAskCards ?? current?.structuredAskCards ?? true;
  const groupCardMention = input.groupCardMention ?? current?.groupCardMention ?? true;
  const pushIntervalMs = input.pushIntervalMs ?? current?.pushIntervalMs ?? defaultLarkPushIntervalMs;
  const traceLimit = input.traceLimit === undefined ? current?.traceLimit ?? defaultLarkTraceLimit : input.traceLimit ?? defaultLarkTraceLimit;
  const hideTraceOnComplete = input.hideTraceOnComplete ?? current?.hideTraceOnComplete ?? true;
  const compactTrace = input.compactTrace ?? current?.compactTrace ?? true;
  const showAgentName = input.showAgentName ?? current?.showAgentName ?? false;
  const completionReactionOnly = input.completionReactionOnly ?? current?.completionReactionOnly ?? false;
  const silentProgress = input.silentProgress ?? current?.silentProgress ?? false;
  const adhdMode = input.adhdMode ?? current?.adhdMode ?? false;
  const defaultModel = input.defaultModel === undefined ? current?.defaultModel : input.defaultModel.trim() || undefined;
  const defaultReasoningEffort = input.defaultReasoningEffort === undefined ? current?.defaultReasoningEffort : input.defaultReasoningEffort.trim() || undefined;
  const fullTrustConfirmed = input.fullTrustConfirmed ?? current?.fullTrustConfirmed ?? false;
  const permissionMode = input.permissionMode ?? (current ? larkPermissionMode(current)
    : defaultLarkPermissionMode(defaultAgentId ? await agents?.get(defaultAgentId) : undefined));
  if (permissionMode !== 'ask' && permissionMode !== 'approve-reads' && permissionMode !== 'full-trust') throw new LarkServiceError('INVALID_LARK_CONFIG', 'Unsupported Lark permission mode', 400);
  const p2pMode = input.p2pMode === undefined ? current?.p2pMode : normalizeP2pMode(input.p2pMode);
  const groupReplyMode = input.groupReplyMode === undefined ? current?.groupReplyMode : normalizeGroupReplyMode(input.groupReplyMode);
  const env = input.env === undefined ? current?.env : normalizeEnv(input.env);
  const startupCommands = input.startupCommands === undefined ? current?.startupCommands : normalizeStartupCommands(input.startupCommands);
  const brand = input.brand === undefined ? current?.brand : normalizeBrand(input.brand);
  const displayName = input.displayName === undefined ? current?.displayName : normalizeDisplayName(input.displayName);
  const roleTitle = input.roleTitle === undefined ? current?.roleTitle : normalizeRoleField(input.roleTitle);
  const roleScope = input.roleScope === undefined ? current?.roleScope : normalizeRoleField(input.roleScope);
  const verificationCommand = input.verificationCommand === undefined ? current?.verificationCommand : input.verificationCommand.trim() || undefined;
  const urgentEnabled = input.urgentEnabled ?? current?.urgentEnabled ?? false;
  // 三个阈值都用 null 表示「清回模块默认」，与 traceLimit 同一口径；不传才是继承现值。
  const urgentThresholdMs = input.urgentThresholdMs === undefined ? current?.urgentThresholdMs : input.urgentThresholdMs ?? undefined;
  const urgentMaxPerHourPerChat = input.urgentMaxPerHourPerChat === undefined ? current?.urgentMaxPerHourPerChat : input.urgentMaxPerHourPerChat ?? undefined;
  const notifyMentionAction = input.notifyMentionAction ?? current?.notifyMentionAction ?? true;
  const notifyMentionDone = input.notifyMentionDone ?? current?.notifyMentionDone ?? true;
  const notifyQuietHours = input.notifyQuietHours === undefined ? current?.notifyQuietHours : input.notifyQuietHours.trim() || undefined;
  const pinLongTasks = input.pinLongTasks ?? current?.pinLongTasks ?? false;
  const pinAfterMs = input.pinAfterMs === undefined ? current?.pinAfterMs : input.pinAfterMs ?? undefined;
  const preInjectPrompt = input.preInjectPrompt === undefined ? current?.preInjectPrompt ?? '' : input.preInjectPrompt.trim();
  const allowedUsers = input.allowedUsers === undefined ? current?.allowedUsers ?? [] : normalizeAllowedUsers(input.allowedUsers);
  const allowedEmails = input.allowedEmails === undefined ? current?.allowedEmails ?? [] : normalizeEmails(input.allowedEmails);
  const allowedBots = input.allowedBots === undefined ? current?.allowedBots ?? [] : normalizeAllowedUsers(input.allowedBots);
  const peerBotsAllowed = input.peerBotsAllowed === undefined ? current?.peerBotsAllowed ?? true : input.peerBotsAllowed;
  const highRiskAllowedUsers = input.highRiskAllowedUsers === undefined ? current?.highRiskAllowedUsers ?? [] : normalizeAllowedUsers(input.highRiskAllowedUsers);
  const highRiskAllowedEmails = input.highRiskAllowedEmails === undefined ? current?.highRiskAllowedEmails ?? [] : normalizeEmails(input.highRiskAllowedEmails);
  const highRiskPattern = input.highRiskPattern === undefined ? current?.highRiskPattern ?? defaultHighRiskPattern : input.highRiskPattern.trim() || defaultHighRiskPattern;
  const riskControlMode = resolveRiskControlModeInput(input, current?.riskControlMode ?? 'off');
  if (!appId) throw new LarkServiceError('INVALID_LARK_CONFIG', 'App ID is required', 400);
  if (!appSecret) throw new LarkServiceError('INVALID_LARK_CONFIG', 'App Secret is required', 400);
  if (input.stage === 'agent' && !defaultAgentId) throw new LarkServiceError('INVALID_LARK_CONFIG', 'Default Agent is required', 400);
  if (workspace && !isAbsolute(workspace)) throw new LarkServiceError('INVALID_LARK_CONFIG', 'Workspace must be an absolute path', 400);
  if (!Number.isInteger(pushIntervalMs) || pushIntervalMs < 500 || pushIntervalMs > 20_000) throw new LarkServiceError('INVALID_LARK_CONFIG', 'Push interval must be an integer between 500 and 20000 milliseconds', 400);
  if (!Number.isInteger(traceLimit) || traceLimit < 1) throw new LarkServiceError('INVALID_LARK_CONFIG', 'Trace limit must be a positive integer', 400);
  if (urgentThresholdMs !== undefined && (!Number.isInteger(urgentThresholdMs) || urgentThresholdMs < minLarkUrgentThresholdMs)) throw new LarkServiceError('INVALID_LARK_CONFIG', `Urgent threshold must be an integer of at least ${minLarkUrgentThresholdMs} milliseconds`, 400);
  if (urgentMaxPerHourPerChat !== undefined && (!Number.isInteger(urgentMaxPerHourPerChat) || urgentMaxPerHourPerChat < 1)) throw new LarkServiceError('INVALID_LARK_CONFIG', 'Urgent hourly limit must be a positive integer', 400);
  if (notifyQuietHours !== undefined && !parseLarkQuietHours(notifyQuietHours)) throw new LarkServiceError('INVALID_LARK_CONFIG', 'Quiet hours must look like 22:00-08:00 (HH:MM-HH:MM, start and end differ)', 400);
  if (pinAfterMs !== undefined && (!Number.isInteger(pinAfterMs) || pinAfterMs < minLarkPinAfterMs)) throw new LarkServiceError('INVALID_LARK_CONFIG', `Pin delay must be an integer of at least ${minLarkPinAfterMs} milliseconds`, 400);
  const patternValidation = validateHighRiskPattern(highRiskPattern);
  if (!patternValidation.valid) throw new LarkServiceError('INVALID_HIGH_RISK_PATTERN', patternValidation.error, 400);
  if (agents && defaultAgentId && !(await agents.get(defaultAgentId))) throw new LarkServiceError('INVALID_LARK_CONFIG', `Unknown default Agent: ${defaultAgentId}`, 400);
  if (fallbackAgentId && fallbackAgentId === defaultAgentId) throw new LarkServiceError('INVALID_LARK_CONFIG', 'Fallback Agent must differ from the default Agent.', 400);
  for (const row of [...defaultAgentWeights, ...(fallbackAgentId ? [{ agentId: fallbackAgentId }] : [])]) {
    const agent = await agents?.get(row.agentId);
    if (agents && !agent) throw new LarkServiceError('INVALID_LARK_CONFIG', `Unknown Agent: ${row.agentId}`, 400);
    if (agent && permissionMode !== 'full-trust' && !supportsRemoteApproval(agent)) throw new LarkServiceError('LARK_APPROVAL_UNSUPPORTED', `Agent ${row.agentId} does not support Lark approval.`, 422);
  }
  if (executionMode === 'layered') {
    // PMO 通过群工具里的 work delegate 把任务交给 Leader，没有群工具就没有交接入口。
    if (!groupToolsEnabled) throw new LarkServiceError('INVALID_LARK_CONFIG', '分层协作需要开启群工具。', 400);
    if (!leaderAgentId) throw new LarkServiceError('INVALID_LARK_CONFIG', '分层协作需要选择 Leader Agent。', 400);
    if (!workerAgentIds.length || workerAgentIds.length > 8) throw new LarkServiceError('INVALID_LARK_CONFIG', '分层协作需要选择 1 到 8 个 Worker Agent。', 400);
    // 只在提交分层设置时校验名单：已选的 Agent 后来被删，不拦只改其他字段的保存；运行时跳过缺失的 Worker，缺 Leader 则拒绝委派。
    const rosterSubmitted = input.executionMode !== undefined || input.leaderAgentId !== undefined || input.workerAgentIds !== undefined;
    for (const id of agents && rosterSubmitted ? [leaderAgentId, ...workerAgentIds] : []) {
      const agent = await agents!.get(id);
      if (!agent) throw new LarkServiceError('INVALID_LARK_CONFIG', `Unknown Agent: ${id}`, 400);
      // Leader 规划：ACP 以 deny-all 运行；终端模式没有 deny-all，只能以完全信任运行，验收步骤也按机器人与该 Agent 中较低的权限运行。
      if (id === leaderAgentId && agent.protocol === 'pty') throw new LarkServiceError('INVALID_LARK_CONFIG', 'Leader 不支持旧版 PTY Agent。', 400);
      if (id === leaderAgentId && agent.protocol === 'pty-cli' && (permissionMode !== 'full-trust' || agent.permissionMode !== 'full-trust')) throw new LarkServiceError('INVALID_LARK_CONFIG', '终端模式 Agent 当 Leader 时以完全信任规划和验收，「不改文件」只靠提示词约束，需要机器人和该 Agent 都是完全信任。', 400);
    }
  }
  const duplicate = configs.find((config, configIndex) => config.appId === appId && configIndex !== index);
  if (duplicate) throw new LarkServiceError('LARK_BOT_ALREADY_CONFIGURED', `Lark bot ${appId} already has a configuration panel`, 409);
  if ((input.stage === 'agent' || input.defaultAgentId !== undefined || input.defaultAgentWeights !== undefined || input.fallbackAgentId !== undefined || input.listening === true) && permissionMode === 'full-trust' && !fullTrustConfirmed) {
    throw new LarkServiceError('LARK_FULL_TRUST_CONFIRMATION_REQUIRED', '请先确认飞书任务将以完全信任模式无人值守运行。', 409);
  }
  const config: StoredLarkConfig = {
    welcomeEnabled: input.welcomeEnabled ?? current?.welcomeEnabled ?? true,
    ...(eventHandlers ? { eventHandlers } : {}),
    ...(cardActionForwarding ? { cardActionForwarding } : {}),
    revision: (current?.revision ?? (current ? 1 : 0)) + 1,
    // 新建的 Bot 默认在自己接手的话题里免 @；已有 Bot 读出来时总带着自己的取值，这里不会改动它们。
    mentionPolicy: input.mentionPolicy ?? current?.mentionPolicy ?? NEW_BOT_MENTION_POLICY,
    defaultGroupParticipation: input.defaultGroupParticipation ?? current?.defaultGroupParticipation ?? 'off',
    appId,
    appSecret,
    ...(name ? { name } : {}),
    ...(workspace ? { workspace } : {}),
    ...(workspaceAliases ? { workspaceAliases } : {}),
    ...(webBaseUrl ? { webBaseUrl } : {}),
    ...(webMobileReachable ? {} : { webMobileReachable: false as const }),
    ...(fallbackAgentId ? { fallbackAgentId } : {}),
    ...(defaultAgentId ? { defaultAgentId } : {}),
    ...(defaultAgentWeights.length ? { defaultAgentWeights } : {}),
    ...(defaultModel ? { defaultModel } : {}),
    ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
    fullTrustConfirmed,
    permissionMode,
    ...(p2pMode ? { p2pMode } : {}),
    ...(groupReplyMode ? { groupReplyMode } : {}),
    ...(env ? { env } : {}),
    ...(startupCommands ? { startupCommands } : {}),
    ...(brand ? { brand } : {}),
    ...(displayName ? { displayName } : {}),
    ...(roleTitle ? { roleTitle } : {}),
    ...(roleScope ? { roleScope } : {}),
    idleCompactEnabled: input.idleCompactEnabled ?? current?.idleCompactEnabled ?? true,
    idleCompactHours: input.idleCompactHours ?? current?.idleCompactHours ?? defaultLarkIdleCompactHours,
    preInjectPrompt,
    listening,
    groupToolsEnabled,
    groupToolsAllowSend,
    memoryEnabled,
    memoryAutoExtract,
    busyTriage: input.busyTriage ?? current?.busyTriage ?? false,
    groupMemoryScope,
    ...(memoryAgentId ? { memoryAgentId } : {}),
    ...(memoryModel ? { memoryModel } : {}),
    ...(decisionAgentId ? { decisionAgentId } : {}),
    ...(decisionModel ? { decisionModel } : {}),
    ...(responseAgentId ? { responseAgentId } : {}),
    ...(responseModel ? { responseModel } : {}),
    ...(executionMode === 'layered' ? { executionMode } : {}),
    ...(leaderAgentId ? { leaderAgentId } : {}),
    ...(workerAgentIds.length ? { workerAgentIds } : {}),
    structuredAskCards,
    groupCardMention,
    ...(verificationCommand ? { verificationCommand } : {}),
    urgentEnabled,
    ...(urgentThresholdMs !== undefined ? { urgentThresholdMs } : {}),
    ...(urgentMaxPerHourPerChat !== undefined ? { urgentMaxPerHourPerChat } : {}),
    notifyMentionAction,
    notifyMentionDone,
    ...(notifyQuietHours ? { notifyQuietHours } : {}),
    pinLongTasks,
    ...(pinAfterMs !== undefined ? { pinAfterMs } : {}),
    pushIntervalMs,
    traceLimit,
    hideTraceOnComplete,
    compactTrace,
    showAgentName,
    completionReactionOnly,
    silentProgress,
    adhdMode,
    allowedUsers,
    allowedEmails,
    allowedBots,
    peerBotsAllowed,
    highRiskAllowedUsers,
    highRiskAllowedEmails,
    highRiskPattern,
    riskControlMode
  };
  if (index >= 0) configs[index] = config;
  else configs.push(config);
  await repository.set(larkBotsConfigKey, serializeLarkConfigs(configs));
  return configs;
}

async function deleteLarkConfigUnlocked(repository: ConfigRepository | undefined, appId: string): Promise<StoredLarkConfig[]> {
  if (!repository) throw new LarkServiceError('LARK_CONFIG_STORAGE_UNAVAILABLE', 'Lark configuration storage is unavailable', 503);
  const configs = await readLarkConfigs(repository);
  const next = configs.filter(config => config.appId !== appId);
  if (next.length === configs.length) throw new LarkServiceError('LARK_BOT_NOT_FOUND', `Unknown Lark bot: ${appId}`, 404);
  await repository.set(larkBotsConfigKey, serializeLarkConfigs(next));
  return next;
}

const configWrites = new WeakMap<ConfigRepository, Promise<unknown>>();
async function mutateLarkConfigs(repository: ConfigRepository | undefined, work: (snapshot: ConfigRepository) => Promise<StoredLarkConfig[]>): Promise<StoredLarkConfig[]> {
  if (!repository) throw new LarkServiceError('LARK_CONFIG_STORAGE_UNAVAILABLE', 'Lark configuration storage is unavailable', 503);
  const previous = configWrites.get(repository) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    for (let attempt = 0; attempt < 20; attempt++) {
      const before = await repository.get(larkBotsConfigKey);
      let value = before;
      const snapshot: ConfigRepository = {
        get: async key => key === larkBotsConfigKey ? value : repository.get(key),
        set: async (key, updated) => { if (key !== larkBotsConfigKey) throw new Error('Unexpected Bot config key'); value = updated; }
      };
      const result = await work(snapshot);
      if (value === undefined) return result;
      if (repository.compareAndSet) {
        if (!await repository.compareAndSet(larkBotsConfigKey, before, value)) continue;
      } else await repository.set(larkBotsConfigKey, value);
      return result;
    }
    throw new LarkServiceError('LARK_CONFIG_REVISION_CONFLICT', '配置正在被其他操作修改，请重试。', 409);
  });
  configWrites.set(repository, next);
  try { return await next; } finally { if (configWrites.get(repository) === next) configWrites.delete(repository); }
}

export async function saveLarkConfig(repository: ConfigRepository | undefined, agents: AgentRepository | undefined, input: SaveLarkConfigInput) {
  return mutateLarkConfigs(repository, snapshot => saveLarkConfigUnlocked(snapshot, agents, input));
}
export async function deleteLarkConfig(repository: ConfigRepository | undefined, appId: string) {
  return mutateLarkConfigs(repository, snapshot => deleteLarkConfigUnlocked(snapshot, appId));
}
