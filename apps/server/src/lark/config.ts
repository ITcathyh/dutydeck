import { validateHighRiskPattern, type AgentRepository, type ConfigRepository } from '@dutydeck/shared';
import { isAbsolute } from 'node:path';
import { LarkServiceError } from './service.js';

export const larkBotsConfigKey = 'lark.bots';
export const larkCredentialsConfigKey = 'lark.credentials';

export interface LarkAllowedUser {
  openId: string;
  name: string;
}

export const riskControlModes = ['off', 'guidance', 'enforced'] as const;
export type RiskControlMode = typeof riskControlModes[number];

export interface StoredLarkConfig {
  revision?: number;
  mentionPolicy?: 'always' | 'topic' | 'never' | 'ambient';
  /** Runtime-only resolved group context; never serialized in the Bot configuration. */
  managedGroup?: { bindingId: string; revision: number; principalId?: string };
  appId: string;
  appSecret: string;
  name?: string;
  workspace?: string;
  webBaseUrl?: string;
  defaultAgentId?: string;
  defaultModel?: string;
  defaultReasoningEffort?: string;
  /** Explicit consent for unattended Lark sessions to run in full-trust mode. */
  fullTrustConfirmed?: boolean;
  permissionMode?: 'ask' | 'full-trust';
  /**
   * 私聊路由模式：'chat' 整段 DM 共用一个会话；'thread' 每条顶层 DM 开一个新话题。
   * 缺省（旧配置无此字段）由 runtime 按 'chat' 处理。
   */
  p2pMode?: 'chat' | 'thread';
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
  preInjectPrompt: string;
  listening: boolean;
  groupToolsEnabled: boolean;
  groupToolsAllowSend: boolean;
  pushIntervalMs: number;
  traceLimit?: number;
  hideTraceOnComplete: boolean;
  allowedUsers: LarkAllowedUser[];
  allowedEmails: string[];
  allowedBots: LarkAllowedUser[];
  peerBotsAllowed: boolean;
  highRiskAllowedUsers: LarkAllowedUser[];
  highRiskAllowedEmails: string[];
  highRiskPattern: string;
  riskControlMode: RiskControlMode;
}

export const larkPermissionMode = (config: Pick<StoredLarkConfig, 'permissionMode'>) => config.permissionMode === 'ask' ? 'ask' as const : 'full-trust' as const;
export const larkExecutionConfirmed = (config: Pick<StoredLarkConfig, 'permissionMode' | 'fullTrustConfirmed'>) => larkPermissionMode(config) === 'ask' || config.fullTrustConfirmed === true;

export interface SaveLarkConfigInput {
  expectedRevision?: number;
  mentionPolicy?: StoredLarkConfig['mentionPolicy'];
  stage?: 'lark' | 'agent';
  originalAppId?: string;
  appId?: string;
  appSecret?: string;
  name?: string;
  workspace?: string;
  webBaseUrl?: string;
  defaultAgentId?: string;
  defaultModel?: string;
  defaultReasoningEffort?: string;
  fullTrustConfirmed?: boolean;
  permissionMode?: 'ask' | 'full-trust';
  /** 私聊路由模式：'chat' 整段 DM 一个会话；'thread' 每条顶层 DM 一个新话题。非法值归一化时丢弃。 */
  p2pMode?: 'chat' | 'thread';
  /** 普通群回复模式：'chat'/'shared' 全群一个会话；'new-topic' 每条顶层 @ 一个话题；'chat-topic' 顶层平铺、群内原生话题各自独立。非法值归一化时丢弃。 */
  groupReplyMode?: 'chat' | 'shared' | 'new-topic' | 'chat-topic';
  /** Legacy stored environment accepted for import compatibility; never returned publicly. */
  env?: Record<string, string>;
  /** Legacy stored commands accepted for import compatibility; never returned publicly. */
  startupCommands?: string[];
  /** 租户品牌：'feishu'（open.feishu.cn）/ 'lark'（open.larksuite.com）。非法值归一化时丢弃。 */
  brand?: 'feishu' | 'lark';
  /** 自定义展示名（纯展示）；归一化时 trim，空白串丢弃。 */
  displayName?: string;
  preInjectPrompt?: string;
  listening?: boolean;
  groupToolsEnabled?: boolean;
  groupToolsAllowSend?: boolean;
  pushIntervalMs?: number;
  traceLimit?: number | null;
  hideTraceOnComplete?: boolean;
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
  revision: number;
  mentionPolicy?: StoredLarkConfig['mentionPolicy'];
  configured: true;
  appId: string;
  name: string;
  tabLabel: string;
  setupComplete: boolean;
  workspace?: string;
  webBaseUrl?: string;
  defaultAgentId?: string;
  defaultModel?: string;
  defaultReasoningEffort?: string;
  fullTrustConfirmed: boolean;
  permissionMode?: 'ask' | 'full-trust';
  p2pMode?: 'chat' | 'thread';
  groupReplyMode?: 'chat' | 'shared' | 'new-topic' | 'chat-topic';
  brand?: 'feishu' | 'lark';
  displayName?: string;
  preInjectPrompt: string;
  listening: boolean;
  activeListening: boolean;
  groupToolsEnabled: boolean;
  groupToolsAllowSend: boolean;
  pushIntervalMs: number;
  traceLimit?: number;
  hideTraceOnComplete: boolean;
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

const normalizeP2pMode = (value: unknown): 'chat' | 'thread' | undefined =>
  value === 'chat' || value === 'thread' ? value : undefined;

const normalizeGroupReplyMode = (value: unknown): StoredLarkConfig['groupReplyMode'] =>
  value === 'chat' || value === 'shared' || value === 'new-topic' || value === 'chat-topic' ? value : undefined;

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

const normalizeDisplayName = (value: unknown): string | undefined => {
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

function normalizeStoredConfig(parsed: Partial<StoredLarkConfig> & LegacyRiskControlShape): StoredLarkConfig | undefined {
  if (!parsed.appId || !parsed.appSecret) return undefined;
  const pushIntervalMs = Number(parsed.pushIntervalMs ?? defaultLarkPushIntervalMs);
  const parsedTraceLimit = Number(parsed.traceLimit ?? defaultLarkTraceLimit);
  const traceLimit = Number.isInteger(parsedTraceLimit) && parsedTraceLimit > 0 ? parsedTraceLimit : defaultLarkTraceLimit;
  const p2pMode = normalizeP2pMode(parsed.p2pMode);
  const groupReplyMode = normalizeGroupReplyMode(parsed.groupReplyMode);
  const env = normalizeEnv(parsed.env);
  const startupCommands = normalizeStartupCommands(parsed.startupCommands);
  const brand = normalizeBrand(parsed.brand);
  const displayName = normalizeDisplayName(parsed.displayName);
  return {
    appId: parsed.appId.trim(),
    revision: Number.isInteger(parsed.revision) && Number(parsed.revision) > 0 ? parsed.revision : 1,
    mentionPolicy: parsed.mentionPolicy ?? 'always',
    appSecret: parsed.appSecret,
    ...(parsed.name?.trim() ? { name: parsed.name.trim() } : {}),
    ...(parsed.workspace?.trim() ? { workspace: parsed.workspace.trim() } : {}),
    ...(normalizeWebBaseUrl(parsed.webBaseUrl) ? { webBaseUrl: normalizeWebBaseUrl(parsed.webBaseUrl) } : {}),
    ...(parsed.defaultAgentId ? { defaultAgentId: parsed.defaultAgentId } : {}),
    ...(parsed.defaultModel ? { defaultModel: parsed.defaultModel } : {}),
    ...(parsed.defaultReasoningEffort ? { defaultReasoningEffort: parsed.defaultReasoningEffort } : {}),
    fullTrustConfirmed: parsed.fullTrustConfirmed === true,
    ...(parsed.permissionMode === 'ask' ? { permissionMode: 'ask' as const } : {}),
    ...(p2pMode ? { p2pMode } : {}),
    ...(groupReplyMode ? { groupReplyMode } : {}),
    ...(env ? { env } : {}),
    ...(startupCommands ? { startupCommands } : {}),
    ...(brand ? { brand } : {}),
    ...(displayName ? { displayName } : {}),
    preInjectPrompt: String(parsed.preInjectPrompt ?? '').trim(),
    listening: parsed.listening === true,
    groupToolsEnabled: parsed.groupToolsEnabled === true,
    groupToolsAllowSend: parsed.groupToolsEnabled === true && parsed.groupToolsAllowSend === true,
    pushIntervalMs: Number.isInteger(pushIntervalMs) && pushIntervalMs >= 500 && pushIntervalMs <= 20_000 ? pushIntervalMs : defaultLarkPushIntervalMs,
    traceLimit,
    hideTraceOnComplete: parsed.hideTraceOnComplete !== false,
    allowedUsers: normalizeAllowedUsers(parsed.allowedUsers),
    allowedEmails: normalizeEmails(parsed.allowedEmails),
    allowedBots: normalizeAllowedUsers(parsed.allowedBots),
    peerBotsAllowed: parsed.peerBotsAllowed !== false,
    highRiskAllowedUsers: normalizeAllowedUsers(parsed.highRiskAllowedUsers),
    highRiskAllowedEmails: normalizeEmails(parsed.highRiskAllowedEmails),
    highRiskPattern: parsed.highRiskPattern?.trim() || defaultHighRiskPattern,
    riskControlMode: normalizeRiskControlMode(parsed)
  };
}

export async function readLarkConfigs(repository?: ConfigRepository): Promise<StoredLarkConfig[]> {
  const stored = await repository?.get(larkBotsConfigKey);
  if (stored) {
    try {
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed)) {
        const configs = parsed.map(item => normalizeStoredConfig(item)).filter((item): item is StoredLarkConfig => Boolean(item));
        if (parsed.some(needsRiskControlMigration)) {
          if (repository?.compareAndSet) {
            if (!await repository.compareAndSet(larkBotsConfigKey, stored, JSON.stringify(configs))) return readLarkConfigs(repository);
          } else await repository?.set(larkBotsConfigKey, JSON.stringify(configs));
        }
        return configs;
      }
    } catch {}
  }
  const legacy = await repository?.get(larkCredentialsConfigKey);
  if (!legacy) return [];
  try {
    const config = normalizeStoredConfig(JSON.parse(legacy));
    if (config) {
      if (repository?.compareAndSet) {
        if (!await repository.compareAndSet(larkBotsConfigKey, stored, JSON.stringify([config]))) return readLarkConfigs(repository);
      } else await repository?.set(larkBotsConfigKey, JSON.stringify([config]));
    }
    return config ? [config] : [];
  } catch { return []; }
}

export async function readLarkConfig(repository?: ConfigRepository, appId?: string): Promise<StoredLarkConfig | undefined> {
  const configs = await readLarkConfigs(repository);
  return appId ? configs.find(config => config.appId === appId) : configs[0];
}

export const publicLarkConfig = (config: StoredLarkConfig, activeAppIds: ReadonlySet<string> = new Set(), duplicateNames: ReadonlySet<string> = new Set()): PublicLarkConfig => ({
  configured: true,
  appId: config.appId,
  revision: config.revision ?? 1,
  mentionPolicy: config.mentionPolicy ?? 'always',
  name: config.name ?? config.appId,
  tabLabel: duplicateNames.has((config.name ?? config.appId).toLowerCase()) ? `${config.name ?? config.appId} · ${config.appId}` : config.name ?? config.appId,
  setupComplete: Boolean(config.defaultAgentId && larkExecutionConfirmed(config)),
  ...(config.workspace ? { workspace: config.workspace } : {}),
  ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}),
  ...(config.defaultAgentId ? { defaultAgentId: config.defaultAgentId } : {}),
  ...(config.defaultModel ? { defaultModel: config.defaultModel } : {}),
  ...(config.defaultReasoningEffort ? { defaultReasoningEffort: config.defaultReasoningEffort } : {}),
  fullTrustConfirmed: config.fullTrustConfirmed === true,
  permissionMode: larkPermissionMode(config),
  ...(config.p2pMode ? { p2pMode: config.p2pMode } : {}),
  ...(config.groupReplyMode ? { groupReplyMode: config.groupReplyMode } : {}),
  ...(config.brand ? { brand: config.brand } : {}),
  ...(config.displayName ? { displayName: config.displayName } : {}),
  preInjectPrompt: config.preInjectPrompt,
  listening: config.listening,
  activeListening: activeAppIds.has(config.appId),
  groupToolsEnabled: config.groupToolsEnabled,
  groupToolsAllowSend: config.groupToolsAllowSend,
  pushIntervalMs: config.pushIntervalMs,
  traceLimit: config.traceLimit ?? defaultLarkTraceLimit,
  hideTraceOnComplete: config.hideTraceOnComplete,
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
  const originalAppId = input.originalAppId?.trim();
  const index = originalAppId ? configs.findIndex(config => config.appId === originalAppId) : -1;
  if (originalAppId && index < 0) throw new LarkServiceError('LARK_BOT_NOT_FOUND', `Unknown Lark bot: ${originalAppId}`, 404);
  const current = index >= 0 ? configs[index] : undefined;
  if (input.expectedRevision !== undefined && input.expectedRevision !== (current ? current.revision ?? 1 : 0)) {
    throw new LarkServiceError('LARK_CONFIG_REVISION_CONFLICT', '此 Bot 已被修改，请比较最新配置后再保存。', 409);
  }
  if (input.mentionPolicy !== undefined && !['always', 'topic', 'never', 'ambient'].includes(input.mentionPolicy)) {
    throw new LarkServiceError('INVALID_LARK_CONFIG', '提及方式无效。', 400);
  }
  const appId = input.appId?.trim() || current?.appId;
  const appSecret = input.appSecret?.trim() || current?.appSecret;
  const name = input.name === undefined ? current?.name : input.name.trim() || undefined;
  const workspace = input.workspace === undefined ? current?.workspace : input.workspace.trim() || undefined;
  const webBaseUrl = input.webBaseUrl === undefined ? current?.webBaseUrl : normalizeWebBaseUrl(input.webBaseUrl);
  const defaultAgentId = input.defaultAgentId?.trim() || current?.defaultAgentId;
  const listening = input.listening ?? current?.listening ?? false;
  const groupToolsEnabled = input.groupToolsEnabled ?? current?.groupToolsEnabled ?? false;
  const groupToolsAllowSend = groupToolsEnabled && (input.groupToolsAllowSend ?? current?.groupToolsAllowSend ?? false);
  const pushIntervalMs = input.pushIntervalMs ?? current?.pushIntervalMs ?? defaultLarkPushIntervalMs;
  const traceLimit = input.traceLimit === undefined ? current?.traceLimit ?? defaultLarkTraceLimit : input.traceLimit ?? defaultLarkTraceLimit;
  const hideTraceOnComplete = input.hideTraceOnComplete ?? current?.hideTraceOnComplete ?? true;
  const defaultModel = input.defaultModel === undefined ? current?.defaultModel : input.defaultModel.trim() || undefined;
  const defaultReasoningEffort = input.defaultReasoningEffort === undefined ? current?.defaultReasoningEffort : input.defaultReasoningEffort.trim() || undefined;
  const fullTrustConfirmed = input.fullTrustConfirmed ?? current?.fullTrustConfirmed ?? false;
  const permissionMode = input.permissionMode ?? larkPermissionMode(current ?? {});
  if (permissionMode !== 'ask' && permissionMode !== 'full-trust') throw new LarkServiceError('INVALID_LARK_CONFIG', 'Unsupported Lark permission mode', 400);
  const p2pMode = input.p2pMode === undefined ? current?.p2pMode : normalizeP2pMode(input.p2pMode);
  const groupReplyMode = input.groupReplyMode === undefined ? current?.groupReplyMode : normalizeGroupReplyMode(input.groupReplyMode);
  const env = input.env === undefined ? current?.env : normalizeEnv(input.env);
  const startupCommands = input.startupCommands === undefined ? current?.startupCommands : normalizeStartupCommands(input.startupCommands);
  const brand = input.brand === undefined ? current?.brand : normalizeBrand(input.brand);
  const displayName = input.displayName === undefined ? current?.displayName : normalizeDisplayName(input.displayName);
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
  const patternValidation = validateHighRiskPattern(highRiskPattern);
  if (!patternValidation.valid) throw new LarkServiceError('INVALID_HIGH_RISK_PATTERN', patternValidation.error, 400);
  if (agents && defaultAgentId && !(await agents.get(defaultAgentId))) throw new LarkServiceError('INVALID_LARK_CONFIG', `Unknown default Agent: ${defaultAgentId}`, 400);
  const duplicate = configs.find((config, configIndex) => config.appId === appId && configIndex !== index);
  if (duplicate) throw new LarkServiceError('LARK_BOT_ALREADY_CONFIGURED', `Lark bot ${appId} already has a configuration panel`, 409);
  if ((input.stage === 'agent' || input.defaultAgentId !== undefined || input.listening === true) && permissionMode === 'full-trust' && !fullTrustConfirmed) {
    throw new LarkServiceError('LARK_FULL_TRUST_CONFIRMATION_REQUIRED', '请先确认飞书任务将以完全信任模式无人值守运行。', 409);
  }
  const config: StoredLarkConfig = {
    revision: (current?.revision ?? (current ? 1 : 0)) + 1,
    mentionPolicy: input.mentionPolicy ?? current?.mentionPolicy ?? 'always',
    appId,
    appSecret,
    ...(name ? { name } : {}),
    ...(workspace ? { workspace } : {}),
    ...(webBaseUrl ? { webBaseUrl } : {}),
    ...(defaultAgentId ? { defaultAgentId } : {}),
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
    preInjectPrompt,
    listening,
    groupToolsEnabled,
    groupToolsAllowSend,
    pushIntervalMs,
    traceLimit,
    hideTraceOnComplete,
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
  await repository.set(larkBotsConfigKey, JSON.stringify(configs));
  return configs;
}

async function deleteLarkConfigUnlocked(repository: ConfigRepository | undefined, appId: string): Promise<StoredLarkConfig[]> {
  if (!repository) throw new LarkServiceError('LARK_CONFIG_STORAGE_UNAVAILABLE', 'Lark configuration storage is unavailable', 503);
  const configs = await readLarkConfigs(repository);
  const next = configs.filter(config => config.appId !== appId);
  if (next.length === configs.length) throw new LarkServiceError('LARK_BOT_NOT_FOUND', `Unknown Lark bot: ${appId}`, 404);
  await repository.set(larkBotsConfigKey, JSON.stringify(next));
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
