import type { AgentModelSettingsPatch } from './agent-model-settings.js';
import { collaborationParticipationModes, groupReplyModes, mentionPolicies, riskControlModes, type GroupBinding, type UpdateGroupBindingInput, type PublicChannelBotFoundation, type UpdateChannelBotInput, type UpdateCollaborationSettingsInput } from '@dutydeck/shared';
import type { CollaborationRouteOptions } from './collaboration-routes.js';
import type { GroupConfigPatch, ManagedGroup, ManagedGroupBot } from './lark/group-management.js';
import type { SaveLarkConfigRequest } from './lark/routes.js';
import { executeLocalRuntimeRequest, type LocalRuntimeRequestDependencies } from './local-runtime-request.js';

export class SettingsCliError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'SettingsCliError';
  }
}

export type SettingsAction =
  | 'instances' | 'agents' | 'agent-show' | 'agent-set'
  | 'bot-list' | 'bot-show' | 'bot-add' | 'bot-set' | 'bot-remove' | 'bot-install-hook'
  | 'channel-bot-list' | 'channel-bot-show' | 'channel-bot-set'
  | 'group-binding-list' | 'group-binding-show' | 'group-binding-add' | 'group-binding-set'
  | 'group-list' | 'group-show' | 'group-set' | 'group-members' | 'group-sync'
  | 'usage-show' | 'usage-set-cap' | 'usage-remove-cap';

export interface SettingsCliInput {
  /** 经目标运行时转发到同机的另一个实例，与 dashboard 切换实例相同。 */
  instance?: string;
  url?: string;
  database?: string;
  appId?: string;
  channelBotId?: string;
  groupBindingId?: string;
  expectedRevision?: string;
  chatId?: string;
  pairs?: string[];
  appSecret?: string;
  agentId?: string;
  apiKey?: string;
  pattern?: string;
  amount?: string;
  pageToken?: string;
  yes?: boolean;
}

type FieldKind = 'boolean' | 'integer' | 'integer|null' | 'string' | 'string|null' | 'list' | 'users' | 'json' | 'override' | readonly string[];

type BotField = Exclude<keyof SaveLarkConfigRequest,
  'stage' | 'originalAppId' | 'expectedRevision' | 'appId' | 'appSecret' | 'name' | 'env' | 'startupCommands' | 'gateEnabled' | 'softGateEnabled' | 'hardGateEnabled' | 'hookTrustConfirmed'>;

export const agentFields = { model: 'string', baseUrl: 'string', authMode: ['bearer', 'api-key'], clearApiKey: 'boolean' } satisfies Record<Exclude<keyof AgentModelSettingsPatch, 'apiKey'>, FieldKind>;

export const channelBotFields = {
  externalAppId: 'string', displayName: 'string', brand: ['feishu', 'lark'],
  credentialRef: 'string|null', state: ['staged', 'disabled']
} satisfies Record<Exclude<keyof UpdateChannelBotInput, 'expectedRevision'>, FieldKind>;

/** dashboard 能保存的 Bot 字段。satisfies 保证保存接口新增字段时这里编译不过，CLI 不会漏项。 */
export const botFields = {
  eventHandlers: 'json', cardActionForwarding: 'json', welcomeEnabled: 'boolean',
  workspace: 'string', workspaceAliases: 'json', webBaseUrl: 'string', webMobileReachable: 'boolean', displayName: 'string', brand: ['feishu', 'lark'],
  defaultAgentId: 'string', fallbackAgentId: 'string', defaultAgentWeights: 'json', defaultModel: 'string', defaultReasoningEffort: 'string',
  permissionMode: ['ask', 'approve-reads', 'full-trust'], fullTrustConfirmed: 'boolean',
  roleTitle: 'string', roleScope: 'string',
  preInjectPrompt: 'string', verificationCommand: 'string', listening: 'boolean',
  mentionPolicy: mentionPolicies, defaultGroupParticipation: collaborationParticipationModes,
  p2pMode: ['chat', 'thread'], groupReplyMode: [...groupReplyModes, 'auto'],
  idleCompactEnabled: 'boolean', idleCompactHours: 'integer',
  groupToolsEnabled: 'boolean', groupToolsAllowSend: 'boolean',
  memoryEnabled: 'boolean', memoryAutoExtract: 'boolean', groupMemoryScope: ['shared', 'per-group'], memoryAgentId: 'string', memoryModel: 'string',
  busyTriage: 'boolean', decisionAgentId: 'string', decisionModel: 'string', responseAgentId: 'string', responseModel: 'string',
  executionMode: ['single', 'layered'], leaderAgentId: 'string', workerAgentIds: 'list',
  structuredAskCards: 'boolean', groupCardMention: 'boolean', pushIntervalMs: 'integer', traceLimit: 'integer|null',
  hideTraceOnComplete: 'boolean', compactTrace: 'boolean', showAgentName: 'boolean', completionReactionOnly: 'boolean', silentProgress: 'boolean', adhdMode: 'boolean',
  urgentEnabled: 'boolean', urgentThresholdMs: 'integer|null', urgentMaxPerHourPerChat: 'integer|null',
  notifyMentionAction: 'boolean', notifyMentionDone: 'boolean', notifyQuietHours: 'string',
  pinLongTasks: 'boolean', pinAfterMs: 'integer|null',
  allowedUsers: 'users', allowedUserNames: 'list', allowedEmails: 'list',
  allowedBots: 'users', allowedBotNames: 'list', peerBotsAllowed: 'boolean',
  highRiskAllowedUsers: 'users', highRiskAllowedUserNames: 'list', highRiskAllowedEmails: 'list',
  highRiskPattern: 'string', riskControlMode: riskControlModes
} satisfies Record<BotField, FieldKind>;
// 这些键和 App Secret 走 Lark 校验那一步（解析姓名、核对 open_id 属于本应用）；其余键要走 Agent 设置那一步的校验（如完全信任确认），不能同一次提交。
const larkStageFields = ['allowedUserNames', 'allowedBotNames', 'allowedUsers', 'allowedEmails', 'allowedBots'];

// 群设置分三处保存：群绑定、群协作、接话分工；一条 set 命令按键分发。
const bindingFields = {
  state: ['staged', 'disabled', 'needs_review', 'archived'], oncall: 'boolean',
  agentOverride: 'override', workspaceOverride: 'override', modelOverride: 'override', reasoningOverride: 'override',
  routingOverride: 'json', accessOverride: 'json', groupToolsOverride: 'json', presentationOverride: 'json'
} satisfies Record<keyof GroupConfigPatch, FieldKind>;
export const groupBindingFields = {
  ...bindingFields, rolePolicyOverride: 'override', reviewReasons: 'list'
} satisfies Record<Exclude<keyof UpdateGroupBindingInput, 'expectedRevision'>, FieldKind>;
const { state: _state, ...groupBindingCreateFields } = groupBindingFields;
export { groupBindingCreateFields };
const collaborationFields = {
  participation: collaborationParticipationModes, inheritParticipation: 'boolean', instructions: 'string', notificationsPaused: 'boolean',
  maxProactivePerHour: 'integer', maxDecisionsPerHour: 'integer', retentionDays: 'integer', policyVersion: 'string'
} satisfies Record<Exclude<keyof UpdateCollaborationSettingsInput, 'expectedRevision'>, FieldKind>;
type DutyPatch = Parameters<NonNullable<CollaborationRouteOptions['updateDuty']>>[1];
// scenarios 的参数由服务端按场景包声明校验，这里只保证顶层键齐全。
const dutyFields = { responder: ['self', 'null'], scenarios: 'json' } satisfies Record<Exclude<keyof DutyPatch, 'expectedRevision'>, FieldKind>;
export const groupFields = { ...bindingFields, roleChanges: 'json', ...collaborationFields, ...dutyFields } satisfies Record<string, FieldKind>;
/** 旧的 alarm=<JSON>（平铺的告警订阅）保留一个版本，转成 scenarios.alarm；不列在键表里。 */
const legacyDutyFields = { alarm: 'json' } satisfies Record<string, FieldKind>;
const legacyAlarmParams = ['sources', 'levels', 'dedupeHours', 'maxPerHour'];
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** 把旧格式的 alarm 并进 scenarios；requesterId、packVersion 等其余键原样带上，由服务端拒绝。 */
function scenariosWithLegacyAlarm(scenarios: unknown, alarm: unknown): Record<string, unknown> {
  const invalid = (message: string): never => { throw new SettingsCliError('SETTINGS_VALUE_INVALID', message); };
  const base = scenarios === undefined ? {} : isObject(scenarios) ? scenarios : invalid('scenarios expects a JSON object keyed by pack id');
  if (Object.hasOwn(base, 'alarm')) throw new SettingsCliError('SETTINGS_KEYS_CONFLICT', 'alarm= and scenarios.alarm change the same pack; keep only scenarios={"alarm":...}');
  if (alarm === null) return { ...base, alarm: null };
  const legacy = isObject(alarm) ? alarm : invalid('alarm expects a JSON object or null');
  const params = Object.fromEntries(Object.entries(legacy).filter(([key]) => legacyAlarmParams.includes(key)));
  const other = Object.fromEntries(Object.entries(legacy).filter(([key]) => !legacyAlarmParams.includes(key)));
  return { ...base, alarm: { ...other, params } };
}

const describeKind = (kind: FieldKind) => typeof kind !== 'string' ? kind.join('|') : {
  boolean: 'true|false', integer: 'integer', 'integer|null': 'integer|null', string: 'text', 'string|null': 'text|null',
  list: 'a,b,c|JSON array', users: 'JSON array of {"openId":"ou_...","name":"..."}', json: 'JSON', override: 'inherit|clear|<value>|JSON'
}[kind];

export const fieldsHelp = (fields: Record<string, FieldKind>) =>
  `\nKeys:\n${Object.entries(fields).map(([key, kind]) => `  ${key}=<${describeKind(kind)}>`).join('\n')}\n`;

function parseValue(key: string, raw: string, kind: FieldKind): unknown {
  const invalid = () => new SettingsCliError('SETTINGS_VALUE_INVALID', `${key} expects ${describeKind(kind)}`);
  const json = () => { try { return JSON.parse(raw) as unknown; } catch { throw invalid(); } };
  if (typeof kind !== 'string') { if (kind.includes(raw)) return raw === 'null' || (key === 'groupReplyMode' && raw === 'auto') ? null : raw; throw invalid(); }
  if (kind === 'boolean') { if (raw === 'true' || raw === 'false') return raw === 'true'; throw invalid(); }
  if (kind === 'integer' || kind === 'integer|null') {
    if (kind === 'integer|null' && raw === 'null') return null;
    if (/^-?\d+$/.test(raw)) return Number(raw);
    throw invalid();
  }
  if (kind === 'string') return raw;
  if (kind === 'string|null') return raw === 'null' ? null : raw;
  // 服务端会静默丢掉格式不对的名单条目，名单变空就等于不限制，所以这里先拦住。
  if (kind === 'list') {
    const list = raw.trim().startsWith('[') ? json() : raw.split(',').map(item => item.trim()).filter(Boolean);
    if (Array.isArray(list) && list.every(item => typeof item === 'string')) return list;
    throw invalid();
  }
  if (kind === 'users') {
    const users = json();
    if (Array.isArray(users) && users.every(user => user && typeof user === 'object' && typeof user.openId === 'string' && user.openId.trim().startsWith('ou_') && (user.name === undefined || typeof user.name === 'string'))) return users;
    throw invalid();
  }
  if (kind === 'override') return raw.trim().startsWith('{') ? json() : raw === 'inherit' || raw === 'clear' ? { mode: raw } : { mode: 'set', value: raw };
  return json();
}

export function parsePairs(pairs: string[], fields: Record<string, FieldKind>, help: string) {
  const values: Record<string, unknown> = {};
  for (const pair of pairs) {
    const at = pair.indexOf('=');
    const key = at > 0 ? pair.slice(0, at) : pair;
    if (!Object.hasOwn(fields, key)) throw new SettingsCliError('SETTINGS_KEY_UNKNOWN', `Unknown setting "${key}"; valid keys are listed by \`${help}\``);
    if (at < 0) throw new SettingsCliError('SETTINGS_VALUE_REQUIRED', `Write ${key}=<value>`);
    if (Object.hasOwn(values, key)) throw new SettingsCliError('SETTINGS_KEY_DUPLICATE', `${key} is given more than once`);
    values[key] = parseValue(key, pair.slice(at + 1), fields[key]!);
  }
  return values;
}

const pick = (values: Record<string, unknown>, fields: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(values).filter(([key]) => Object.hasOwn(fields, key)));

type Request = (method: string, endpoint: string, body?: unknown) => Promise<any>;
type PublicBot = { appId: string; revision?: number } & Record<string, unknown>;

function runtimeRequest(input: SettingsCliInput, dependencies: LocalRuntimeRequestDependencies): Request {
  if (input.instance !== undefined && !/^[a-z0-9-]+$/.test(input.instance)) throw new SettingsCliError('SETTINGS_INSTANCE_INVALID', 'Instance ids contain only a-z, 0-9 and -; see `dutydeck settings instances`');
  return (method, endpoint, body) => executeLocalRuntimeRequest({
    url: input.url,
    database: input.database,
    method,
    endpoint: input.instance ? endpoint.replace(/^\/api\//, `/api/instances/${input.instance}/`) : endpoint,
    body,
    errorSpec: {
      databaseRequired: 'SETTINGS_DATABASE_REQUIRED',
      daemonUnavailable: 'SETTINGS_DAEMON_UNAVAILABLE',
      localRuntimeRequired: 'SETTINGS_LOCAL_RUNTIME_REQUIRED',
      requestFailed: 'SETTINGS_REQUEST_FAILED',
      requestFailedMessage: (status, message) => message ?? `Settings request failed with HTTP ${status}`
    },
    createError: (code, message) => new SettingsCliError(code, message)
  }, dependencies);
}

const required = (value: string | undefined, name: string) => {
  if (!value?.trim()) throw new SettingsCliError('SETTINGS_ARGUMENT_REQUIRED', `${name} is required`);
  return value.trim();
};
const path = encodeURIComponent;
const agentSettingsPath = (input: SettingsCliInput) => input.appId
  ? `/api/lark/bots/${path(required(input.appId, 'App ID'))}/agents/${path(required(input.agentId, 'Agent ID'))}/model-settings`
  : `/api/agents/${path(required(input.agentId, 'Agent ID'))}/model-settings`;

async function findBot(request: Request, appId: string) {
  const config = await request('GET', '/api/lark/config') as { bots?: PublicBot[] };
  const bot = config.bots?.find(item => item.appId === appId);
  if (!bot) throw new SettingsCliError('SETTINGS_BOT_NOT_FOUND', `Bot ${appId} is not configured on this runtime; see \`dutydeck settings bot list\``);
  return bot;
}

async function channelBots(request: Request): Promise<PublicChannelBotFoundation[]> {
  const matrix = await request('GET', '/api/foundation/group-matrix') as { bots: Array<{ bot: PublicChannelBotFoundation }> };
  return matrix.bots.map(entry => entry.bot);
}

async function findChannelBot(request: Request, id: string) {
  const bot = (await channelBots(request)).find(bot => bot.id === id);
  if (!bot) throw new SettingsCliError('SETTINGS_CHANNEL_BOT_NOT_FOUND', `Channel bot ${id} is not configured; see \`dutydeck settings channel-bot list\``);
  return bot;
}

async function groupBindings(request: Request, channelBotId?: string): Promise<GroupBinding[]> {
  const matrix = await request('GET', '/api/foundation/group-matrix') as { bots: Array<{ bot: PublicChannelBotFoundation; cells: Array<{ desiredPolicy?: GroupBinding }> }> };
  return matrix.bots.filter(entry => !channelBotId || entry.bot.id === channelBotId).flatMap(entry => entry.cells.flatMap(cell => cell.desiredPolicy ? [cell.desiredPolicy] : []));
}

async function findGroupBinding(request: Request, id: string) {
  const binding = (await groupBindings(request)).find(binding => binding.id === id);
  if (!binding) throw new SettingsCliError('SETTINGS_GROUP_BINDING_NOT_FOUND', `Group binding ${id} is unknown; see \`dutydeck settings group-binding list\``);
  return binding;
}

function expectedRevision(input: SettingsCliInput): number | undefined {
  if (input.expectedRevision === undefined) return undefined;
  const revision = Number(input.expectedRevision);
  if (!/^\d+$/.test(input.expectedRevision) || !Number.isSafeInteger(revision) || revision < 1) throw new SettingsCliError('SETTINGS_VALUE_INVALID', 'Expected revision must be a positive integer');
  return revision;
}

function larkStageOnly(fields: Record<string, unknown>, what: string) {
  const others = Object.keys(fields).filter(key => !larkStageFields.includes(key));
  if (others.length) throw new SettingsCliError('SETTINGS_KEYS_CONFLICT', `Set ${others.join(', ')} with a separate \`bot set\`; ${what} only takes ${larkStageFields.join(', ')}`);
  return fields;
}

async function saveBot(request: Request, body: Record<string, unknown>, appId: string) {
  const saved = await request('PUT', '/api/lark/config', body) as { bots: PublicBot[] };
  return { bot: saved.bots.find(item => item.appId === appId) };
}

async function findGroup(request: Request, chatId: string, appId?: string): Promise<{ group: ManagedGroup; bot: ManagedGroupBot }> {
  const { groups } = await request('GET', '/api/lark/management/groups') as { groups: ManagedGroup[] };
  // 没有租户标识时同一个群按 Bot 分成多条，要合起来找。
  const entries = groups.filter(item => item.chatId === chatId);
  if (!entries.length) throw new SettingsCliError('SETTINGS_GROUP_NOT_FOUND', `Group ${chatId} is unknown here; run \`dutydeck settings group sync <app-id>\` first`);
  const bots = entries.flatMap(item => item.bots);
  const bot = appId ? bots.find(item => item.appId === appId) : bots.length === 1 ? bots[0] : undefined;
  if (bot) return { group: entries[0]!, bot };
  if (appId) throw new SettingsCliError('SETTINGS_GROUP_BOT_NOT_FOUND', `Bot ${appId} is not in group ${chatId}`);
  throw new SettingsCliError('SETTINGS_APP_REQUIRED', `Group ${chatId} has several bots; pass --app ${bots.map(item => item.appId).join('|')}`);
}

const collaborationPath = (appId: string, chatId: string) => `/api/lark/groups/${path(appId)}/${path(chatId)}/collaboration`;

async function showGroup(request: Request, chatId: string, appId?: string) {
  const { group, bot } = await findGroup(request, chatId, appId);
  // scenarios 是对本机器人适用的场景包：参数说明、本群绑定、是否过期。旧版实例不返回。
  const overview = await request('GET', collaborationPath(bot.appId, chatId)) as { snapshot: { settings: unknown }; duty?: unknown; scenarios?: unknown[] };
  return { group: { chatId: group.chatId, name: group.name }, bot, collaboration: { settings: overview.snapshot.settings, duty: overview.duty, scenarios: overview.scenarios } };
}

async function setGroup(request: Request, input: SettingsCliInput) {
  const chatId = required(input.chatId, 'Chat ID');
  if (!input.pairs?.length) throw new SettingsCliError('SETTINGS_ARGUMENT_REQUIRED', 'Pass at least one key=value');
  const values = parsePairs(input.pairs, { ...groupFields, ...legacyDutyFields }, 'dutydeck settings group set --help');
  const { roleChanges, ...patch } = pick(values, { ...bindingFields, roleChanges: true });
  const settings = pick(values, collaborationFields);
  const duty = pick(values, dutyFields);
  const warnings: string[] = [];
  if (Object.hasOwn(values, 'alarm')) {
    duty.scenarios = scenariosWithLegacyAlarm(duty.scenarios, values.alarm);
    warnings.push('alarm= is deprecated and will be removed; use scenarios={"alarm":{"enabled":...,"params":{...}}}');
  }
  const { bot } = await findGroup(request, chatId, input.appId);
  const applied: string[] = [];
  try {
    // 群协作和接话要求群已有绑定；还没有时先按机器人默认值建一个，与在 dashboard 保存群配置相同。
    if (Object.keys(patch).length || roleChanges !== undefined || !bot.binding) {
      await request('PUT', `/api/lark/bots/${path(bot.appId)}/groups/${path(chatId)}`, { expectedRevision: bot.binding?.revision ?? 0, patch, ...(roleChanges !== undefined ? { roleChanges } : {}) });
      applied.push('binding');
    }
    if (Object.keys(settings).length || Object.keys(duty).length) {
      const base = collaborationPath(bot.appId, chatId);
      const overview = await request('GET', base) as { snapshot: { settings: { revision: number } }; duty?: { revision: number } };
      if (Object.keys(settings).length) {
        await request('PATCH', `${base}/settings`, { expectedRevision: overview.snapshot.settings.revision, ...settings });
        applied.push('collaboration');
      }
      if (Object.keys(duty).length) {
        await request('PATCH', `${base}/duty`, { expectedRevision: overview.duty?.revision ?? 0, ...duty });
        applied.push('duty');
      }
    }
  } catch (error) {
    if (applied.length && error instanceof SettingsCliError) throw new SettingsCliError(error.code, `${error.message} (already saved: ${applied.join(', ')})`);
    throw error;
  }
  return { applied, ...(warnings.length ? { warnings } : {}), ...await showGroup(request, chatId, bot.appId) };
}

function capTarget(input: SettingsCliInput): Record<string, string> {
  const appId = required(input.appId, '--app');
  return input.chatId ? { scope: 'group', appId, chatId: input.chatId } : { scope: 'bot', appId };
}

export async function runSettingsCli(action: SettingsAction, input: SettingsCliInput, dependencies: LocalRuntimeRequestDependencies = {}): Promise<Record<string, unknown>> {
  const request = runtimeRequest(input, dependencies);
  switch (action) {
    case 'instances': return request('GET', '/api/instances');
    case 'agents': return { agents: await request('GET', '/api/agents') };
    case 'agent-show': return request('GET', agentSettingsPath(input));
    case 'agent-set': {
      const values = parsePairs(input.pairs ?? [], agentFields, 'dutydeck settings agent set --help');
      if (!Object.keys(values).length && input.apiKey === undefined) throw new SettingsCliError('SETTINGS_ARGUMENT_REQUIRED', 'Pass at least one key=value or --api-key-fd');
      return request('PUT', agentSettingsPath(input), { ...values, ...(input.apiKey !== undefined ? { apiKey: input.apiKey } : {}) });
    }
    case 'channel-bot-list': return { bots: await channelBots(request) };
    case 'channel-bot-show': return { bot: await findChannelBot(request, required(input.channelBotId, 'Channel bot ID')) };
    case 'channel-bot-set': {
      const id = required(input.channelBotId, 'Channel bot ID');
      const fields = parsePairs(input.pairs ?? [], channelBotFields, 'dutydeck settings channel-bot set --help');
      if (!Object.keys(fields).length) throw new SettingsCliError('SETTINGS_ARGUMENT_REQUIRED', 'Pass at least one key=value');
      const revision = expectedRevision(input);
      const bot = await findChannelBot(request, id);
      return { bot: await request('PATCH', `/api/foundation/channel-bots/${path(id)}`, { expectedRevision: revision ?? bot.revision, ...fields }) };
    }
    case 'group-binding-list': return { bindings: await groupBindings(request, input.channelBotId) };
    case 'group-binding-show': return { binding: await findGroupBinding(request, required(input.groupBindingId, 'Group binding ID')) };
    case 'group-binding-add': {
      const id = required(input.groupBindingId, 'Group binding ID');
      const channelBotId = required(input.channelBotId, '--bot');
      const externalChatId = required(input.chatId, '--chat');
      const fields = parsePairs(input.pairs ?? [], groupBindingCreateFields, 'dutydeck settings group-binding add --help');
      return { binding: await request('POST', '/api/foundation/group-bindings', { id, channelBotId, externalChatId, ...fields }) };
    }
    case 'group-binding-set': {
      const id = required(input.groupBindingId, 'Group binding ID');
      const fields = parsePairs(input.pairs ?? [], groupBindingFields, 'dutydeck settings group-binding set --help');
      if (!Object.keys(fields).length) throw new SettingsCliError('SETTINGS_ARGUMENT_REQUIRED', 'Pass at least one key=value');
      const revision = expectedRevision(input);
      const binding = await findGroupBinding(request, id);
      return { binding: await request('PATCH', `/api/foundation/group-bindings/${path(id)}`, { expectedRevision: revision ?? binding.revision, ...fields }) };
    }
    case 'bot-list': {
      const config = await request('GET', '/api/lark/config') as { bots: PublicBot[]; listeningDisabled?: boolean };
      return {
        listeningDisabled: config.listeningDisabled === true,
        bots: config.bots.map(({ appId, name, displayName, revision, listening, activeListening, defaultAgentId }) => ({ appId, name, displayName, revision, listening, activeListening, defaultAgentId }))
      };
    }
    case 'bot-show': return { bot: await findBot(request, required(input.appId, 'App ID')) };
    case 'bot-add': {
      const appId = required(input.appId, 'App ID');
      if (!input.appSecret) throw new SettingsCliError('SETTINGS_APP_SECRET_REQUIRED', 'Pass the App Secret with --app-secret-fd');
      const fields = larkStageOnly(parsePairs(input.pairs ?? [], botFields, 'dutydeck settings bot set --help'), 'bot add');
      return saveBot(request, { stage: 'lark', expectedRevision: 0, ...fields, appId, appSecret: input.appSecret }, appId);
    }
    case 'bot-set': {
      const appId = required(input.appId, 'App ID');
      if (!input.pairs?.length && !input.appSecret) throw new SettingsCliError('SETTINGS_ARGUMENT_REQUIRED', 'Pass at least one key=value or --app-secret-fd');
      const fields = parsePairs(input.pairs ?? [], botFields, 'dutydeck settings bot set --help');
      const larkStage = input.appSecret !== undefined || larkStageFields.some(key => key in fields);
      if (larkStage) larkStageOnly(fields, 'an App Secret or member list change');
      const bot = await findBot(request, appId);
      return saveBot(request, { stage: larkStage ? 'lark' : 'agent', originalAppId: appId, expectedRevision: bot.revision ?? 1, ...fields, ...(input.appSecret ? { appSecret: input.appSecret } : {}) }, appId);
    }
    case 'bot-remove': {
      const appId = required(input.appId, 'App ID');
      if (!input.yes) throw new SettingsCliError('SETTINGS_CONFIRMATION_REQUIRED', `Removing ${appId} deletes its saved credentials and settings; pass --yes to confirm`);
      await findBot(request, appId);
      const saved = await request('DELETE', `/api/lark/config/${path(appId)}`) as { bots: PublicBot[] };
      return { removed: appId, bots: saved.bots.map(bot => bot.appId) };
    }
    case 'bot-install-hook': {
      const appId = required(input.appId, 'App ID');
      const bot = await findBot(request, appId);
      return request('POST', '/api/lark/hooks/install', { appId, expectedRevision: bot.revision ?? 1, ...(input.pattern !== undefined ? { highRiskPattern: input.pattern } : {}) });
    }
    case 'group-list': {
      const { groups } = await request('GET', '/api/lark/management/groups') as { groups: ManagedGroup[] };
      return {
        groups: groups.filter(group => !input.appId || group.bots.some(bot => bot.appId === input.appId)).map(group => ({
          chatId: group.chatId,
          name: group.name,
          bots: group.bots.map(bot => ({ appId: bot.appId, membership: bot.membership, validity: bot.validity, state: bot.binding?.state, oncall: bot.binding?.oncall, revision: bot.binding?.revision }))
        }))
      };
    }
    case 'group-show': return showGroup(request, required(input.chatId, 'Chat ID'), input.appId);
    case 'group-set': return setGroup(request, input);
    case 'group-members': {
      const chatId = required(input.chatId, 'Chat ID');
      const { bot } = await findGroup(request, chatId, input.appId);
      return request('GET', `/api/lark/bots/${path(bot.appId)}/groups/${path(chatId)}/members${input.pageToken ? `?pageToken=${path(input.pageToken)}` : ''}`);
    }
    case 'group-sync': return request('POST', `/api/lark/bots/${path(required(input.appId, 'App ID'))}/sync-groups`, {});
    case 'usage-show': return request('GET', '/api/usage/summary');
    case 'usage-set-cap': {
      const monthlyCostUsd = Number(input.amount);
      if (!input.amount?.trim() || !Number.isFinite(monthlyCostUsd)) throw new SettingsCliError('SETTINGS_VALUE_INVALID', 'Monthly cap must be a number of US dollars');
      return { cap: await request('PUT', '/api/usage/caps', { ...capTarget(input), monthlyCostUsd }) };
    }
    case 'usage-remove-cap': return request('DELETE', `/api/usage/caps?${new URLSearchParams(capTarget(input))}`);
  }
}
