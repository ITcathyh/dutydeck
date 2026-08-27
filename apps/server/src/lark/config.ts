import { validateHighRiskPattern, type AgentRepository, type ConfigRepository } from '@dockmux/shared';
import { isAbsolute } from 'node:path';
import { LarkServiceError } from './service.js';

export const larkBotsConfigKey = 'lark.bots';
export const larkCredentialsConfigKey = 'lark.credentials';

export interface LarkAllowedUser {
  openId: string;
  name: string;
}

export interface StoredLarkConfig {
  appId: string;
  appSecret: string;
  name?: string;
  workspace?: string;
  webBaseUrl?: string;
  defaultAgentId?: string;
  defaultModel?: string;
  defaultReasoningEffort?: string;
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
  /**
   * Bot 级环境变量，透传给 runtime session 进程（如第三方 Anthropic 兼容网关、代理）。
   * 仅接受键值均为 string 的对象；缺省/空对象 → undefined。消费方在 runtime，不在本目录。
   */
  env?: Record<string, string>;
  /**
   * 会话启动时注入的命令行（如 '/model opus'），新会话首条 prompt 前按序执行。
   * 各项 trim、去空；缺省/空数组 → undefined。消费方在 runtime，不在本目录。
   */
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
  gateEnabled: boolean;
  softGateEnabled: boolean;
  hardGateEnabled: boolean;
  hookTrustConfirmed: boolean;
}

export interface SaveLarkConfigInput {
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
  /** 私聊路由模式：'chat' 整段 DM 一个会话；'thread' 每条顶层 DM 一个新话题。非法值归一化时丢弃。 */
  p2pMode?: 'chat' | 'thread';
  /** 普通群回复模式：'chat'/'shared' 全群一个会话；'new-topic' 每条顶层 @ 一个话题；'chat-topic' 顶层平铺、群内原生话题各自独立。非法值归一化时丢弃。 */
  groupReplyMode?: 'chat' | 'shared' | 'new-topic' | 'chat-topic';
  /** Bot 级环境变量，透传给 runtime session；归一化时只保留键值均为 string 的条目。 */
  env?: Record<string, string>;
  /** 会话启动时注入的命令行；归一化时逐项 trim、去空。 */
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
  gateEnabled?: boolean;
  softGateEnabled?: boolean;
  hardGateEnabled?: boolean;
  hookTrustConfirmed?: boolean;
}

export interface PublicLarkConfig {
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
  p2pMode?: 'chat' | 'thread';
  groupReplyMode?: 'chat' | 'shared' | 'new-topic' | 'chat-topic';
  env?: Record<string, string>;
  startupCommands?: string[];
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
  gateEnabled: boolean;
  softGateEnabled: boolean;
  hardGateEnabled: boolean;
  hookTrustConfirmed: boolean;
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

function normalizeStoredConfig(parsed: Partial<StoredLarkConfig>): StoredLarkConfig | undefined {
  if (!parsed.appId || !parsed.appSecret) return undefined;
  const pushIntervalMs = Number(parsed.pushIntervalMs ?? defaultLarkPushIntervalMs);
  const parsedTraceLimit = Number(parsed.traceLimit ?? defaultLarkTraceLimit);
  const traceLimit = Number.isInteger(parsedTraceLimit) && parsedTraceLimit > 0 ? parsedTraceLimit : defaultLarkTraceLimit;
  const gateEnabled = parsed.gateEnabled === undefined ? parsed.softGateEnabled !== false || parsed.hardGateEnabled === true : parsed.gateEnabled === true;
  const p2pMode = normalizeP2pMode(parsed.p2pMode);
  const groupReplyMode = normalizeGroupReplyMode(parsed.groupReplyMode);
  const env = normalizeEnv(parsed.env);
  const startupCommands = normalizeStartupCommands(parsed.startupCommands);
  const brand = normalizeBrand(parsed.brand);
  const displayName = normalizeDisplayName(parsed.displayName);
  return {
    appId: parsed.appId.trim(),
    appSecret: parsed.appSecret,
    ...(parsed.name?.trim() ? { name: parsed.name.trim() } : {}),
    ...(parsed.workspace?.trim() ? { workspace: parsed.workspace.trim() } : {}),
    ...(normalizeWebBaseUrl(parsed.webBaseUrl) ? { webBaseUrl: normalizeWebBaseUrl(parsed.webBaseUrl) } : {}),
    ...(parsed.defaultAgentId ? { defaultAgentId: parsed.defaultAgentId } : {}),
    ...(parsed.defaultModel ? { defaultModel: parsed.defaultModel } : {}),
    ...(parsed.defaultReasoningEffort ? { defaultReasoningEffort: parsed.defaultReasoningEffort } : {}),
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
    gateEnabled,
    softGateEnabled: gateEnabled,
    hardGateEnabled: gateEnabled && parsed.hardGateEnabled === true,
    hookTrustConfirmed: parsed.hookTrustConfirmed === true
  };
}

export async function readLarkConfigs(repository?: ConfigRepository): Promise<StoredLarkConfig[]> {
  const stored = await repository?.get(larkBotsConfigKey);
  if (stored) {
    try {
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed)) return parsed.map(item => normalizeStoredConfig(item)).filter((item): item is StoredLarkConfig => Boolean(item));
    } catch {}
  }
  const legacy = await repository?.get(larkCredentialsConfigKey);
  if (!legacy) return [];
  try {
    const config = normalizeStoredConfig(JSON.parse(legacy));
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
  name: config.name ?? config.appId,
  tabLabel: duplicateNames.has((config.name ?? config.appId).toLowerCase()) ? `${config.name ?? config.appId} · ${config.appId}` : config.name ?? config.appId,
  setupComplete: Boolean(config.defaultAgentId),
  ...(config.workspace ? { workspace: config.workspace } : {}),
  ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}),
  ...(config.defaultAgentId ? { defaultAgentId: config.defaultAgentId } : {}),
  ...(config.defaultModel ? { defaultModel: config.defaultModel } : {}),
  ...(config.defaultReasoningEffort ? { defaultReasoningEffort: config.defaultReasoningEffort } : {}),
  ...(config.p2pMode ? { p2pMode: config.p2pMode } : {}),
  ...(config.groupReplyMode ? { groupReplyMode: config.groupReplyMode } : {}),
  ...(config.env ? { env: config.env } : {}),
  ...(config.startupCommands ? { startupCommands: config.startupCommands } : {}),
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
  gateEnabled: config.gateEnabled,
  softGateEnabled: config.softGateEnabled,
  hardGateEnabled: config.hardGateEnabled,
  hookTrustConfirmed: config.hookTrustConfirmed
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

export async function saveLarkConfig(repository: ConfigRepository | undefined, agents: AgentRepository | undefined, input: SaveLarkConfigInput): Promise<StoredLarkConfig[]> {
  if (!repository) throw new LarkServiceError('LARK_CONFIG_STORAGE_UNAVAILABLE', 'Lark configuration storage is unavailable', 503);
  const configs = await readLarkConfigs(repository);
  const originalAppId = input.originalAppId?.trim();
  const index = originalAppId ? configs.findIndex(config => config.appId === originalAppId) : -1;
  if (originalAppId && index < 0) throw new LarkServiceError('LARK_BOT_NOT_FOUND', `Unknown Lark bot: ${originalAppId}`, 404);
  const current = index >= 0 ? configs[index] : undefined;
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
  const gateEnabled = input.gateEnabled ?? current?.gateEnabled ?? false;
  const softGateEnabled = gateEnabled;
  const hardGateEnabled = gateEnabled && (input.hardGateEnabled ?? current?.hardGateEnabled ?? false);
  const hookTrustConfirmed = input.hookTrustConfirmed ?? current?.hookTrustConfirmed ?? false;
  if (!appId) throw new LarkServiceError('INVALID_LARK_CONFIG', 'App ID is required', 400);
  if (!appSecret) throw new LarkServiceError('INVALID_LARK_CONFIG', 'App Secret is required', 400);
  if (input.stage === 'agent' && !defaultAgentId) throw new LarkServiceError('INVALID_LARK_CONFIG', 'Default Agent is required', 400);
  if (current?.hardGateEnabled && defaultAgentId !== current.defaultAgentId) throw new LarkServiceError('HARD_GATE_AGENT_LOCKED', 'Disable and save the hard gate before changing the default Agent', 409);
  if (workspace && !isAbsolute(workspace)) throw new LarkServiceError('INVALID_LARK_CONFIG', 'Workspace must be an absolute path', 400);
  if (!Number.isInteger(pushIntervalMs) || pushIntervalMs < 500 || pushIntervalMs > 20_000) throw new LarkServiceError('INVALID_LARK_CONFIG', 'Push interval must be an integer between 500 and 20000 milliseconds', 400);
  if (!Number.isInteger(traceLimit) || traceLimit < 1) throw new LarkServiceError('INVALID_LARK_CONFIG', 'Trace limit must be a positive integer', 400);
  const patternValidation = validateHighRiskPattern(highRiskPattern);
  if (!patternValidation.valid) throw new LarkServiceError('INVALID_HIGH_RISK_PATTERN', patternValidation.error, 400);
  if (agents && defaultAgentId && !(await agents.get(defaultAgentId))) throw new LarkServiceError('INVALID_LARK_CONFIG', `Unknown default Agent: ${defaultAgentId}`, 400);
  const duplicate = configs.find((config, configIndex) => config.appId === appId && configIndex !== index);
  if (duplicate) throw new LarkServiceError('LARK_BOT_ALREADY_CONFIGURED', `Lark bot ${appId} already has a configuration panel`, 409);
  const config: StoredLarkConfig = {
    appId,
    appSecret,
    ...(name ? { name } : {}),
    ...(workspace ? { workspace } : {}),
    ...(webBaseUrl ? { webBaseUrl } : {}),
    ...(defaultAgentId ? { defaultAgentId } : {}),
    ...(defaultModel ? { defaultModel } : {}),
    ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
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
    gateEnabled,
    softGateEnabled,
    hardGateEnabled,
    hookTrustConfirmed
  };
  if (index >= 0) configs[index] = config;
  else configs.push(config);
  await repository.set(larkBotsConfigKey, JSON.stringify(configs));
  return configs;
}

export async function deleteLarkConfig(repository: ConfigRepository | undefined, appId: string): Promise<StoredLarkConfig[]> {
  if (!repository) throw new LarkServiceError('LARK_CONFIG_STORAGE_UNAVAILABLE', 'Lark configuration storage is unavailable', 503);
  const configs = await readLarkConfigs(repository);
  const next = configs.filter(config => config.appId !== appId);
  if (next.length === configs.length) throw new LarkServiceError('LARK_BOT_NOT_FOUND', `Unknown Lark bot: ${appId}`, 404);
  await repository.set(larkBotsConfigKey, JSON.stringify(next));
  return next;
}
