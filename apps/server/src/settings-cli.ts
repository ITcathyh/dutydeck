import type { UpdateCollaborationSettingsInput } from '@dutydeck/shared';
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
  | 'instances' | 'agents'
  | 'bot-list' | 'bot-show' | 'bot-add' | 'bot-set' | 'bot-remove' | 'bot-install-hook'
  | 'group-list' | 'group-show' | 'group-set' | 'group-members' | 'group-sync'
  | 'usage-show' | 'usage-set-cap' | 'usage-remove-cap';

export interface SettingsCliInput {
  /** 经目标运行时转发到同机的另一个实例，与 dashboard 切换实例相同。 */
  instance?: string;
  url?: string;
  database?: string;
  appId?: string;
  chatId?: string;
  pairs?: string[];
  appSecret?: string;
  pattern?: string;
  amount?: string;
  pageToken?: string;
  yes?: boolean;
}

type FieldKind = 'boolean' | 'integer' | 'integer|null' | 'string' | 'list' | 'users' | 'json' | 'override' | readonly string[];

type BotField = Exclude<keyof SaveLarkConfigRequest,
  'stage' | 'originalAppId' | 'expectedRevision' | 'appId' | 'appSecret' | 'name' | 'env' | 'startupCommands' | 'gateEnabled' | 'softGateEnabled' | 'hardGateEnabled' | 'hookTrustConfirmed'>;

/** dashboard 能保存的 Bot 字段。satisfies 保证保存接口新增字段时这里编译不过，CLI 不会漏项。 */
export const botFields = {
  workspace: 'string', workspaceAliases: 'json', webBaseUrl: 'string', webMobileReachable: 'boolean', displayName: 'string', brand: ['feishu', 'lark'],
  defaultAgentId: 'string', defaultModel: 'string', defaultReasoningEffort: 'string',
  permissionMode: ['ask', 'approve-reads', 'full-trust'], fullTrustConfirmed: 'boolean',
  preInjectPrompt: 'string', verificationCommand: 'string', listening: 'boolean',
  mentionPolicy: ['always', 'topic', 'never', 'ambient'], defaultGroupParticipation: ['off', 'observe', 'selective', 'eager'],
  p2pMode: ['chat', 'thread'], groupReplyMode: ['chat', 'shared', 'new-topic', 'chat-topic'],
  idleCompactEnabled: 'boolean', idleCompactHours: 'integer',
  groupToolsEnabled: 'boolean', groupToolsAllowSend: 'boolean',
  memoryEnabled: 'boolean', memoryAutoExtract: 'boolean', memoryAgentId: 'string', memoryModel: 'string',
  decisionAgentId: 'string', decisionModel: 'string', responseAgentId: 'string', responseModel: 'string',
  executionMode: ['single', 'layered'], leaderAgentId: 'string', workerAgentIds: 'list',
  structuredAskCards: 'boolean', groupCardMention: 'boolean', pushIntervalMs: 'integer', traceLimit: 'integer|null',
  hideTraceOnComplete: 'boolean', compactTrace: 'boolean', completionReactionOnly: 'boolean', silentProgress: 'boolean', adhdMode: 'boolean',
  urgentEnabled: 'boolean', urgentThresholdMs: 'integer|null', urgentMaxPerHourPerChat: 'integer|null',
  pinLongTasks: 'boolean', pinAfterMs: 'integer|null',
  allowedUsers: 'users', allowedUserNames: 'list', allowedEmails: 'list',
  allowedBots: 'users', allowedBotNames: 'list', peerBotsAllowed: 'boolean',
  highRiskAllowedUsers: 'users', highRiskAllowedUserNames: 'list', highRiskAllowedEmails: 'list',
  highRiskPattern: 'string', riskControlMode: ['off', 'guidance', 'enforced']
} satisfies Record<BotField, FieldKind>;
// 这些键和 App Secret 走 Lark 校验那一步（解析姓名、核对 open_id 属于本应用）；其余键要走 Agent 设置那一步的校验（如完全信任确认），不能同一次提交。
const larkStageFields = ['allowedUserNames', 'allowedBotNames', 'allowedUsers', 'allowedEmails', 'allowedBots'];

// 群设置分三处保存：群绑定、群协作、接话分工；一条 set 命令按键分发。
const bindingFields = {
  state: ['staged', 'disabled', 'needs_review', 'archived'], oncall: 'boolean',
  agentOverride: 'override', workspaceOverride: 'override', modelOverride: 'override', reasoningOverride: 'override',
  routingOverride: 'json', accessOverride: 'json', groupToolsOverride: 'json', presentationOverride: 'json'
} satisfies Record<keyof GroupConfigPatch, FieldKind>;
const collaborationFields = {
  participation: ['off', 'observe', 'selective', 'eager'], inheritParticipation: 'boolean', instructions: 'string', notificationsPaused: 'boolean',
  maxProactivePerHour: 'integer', maxDecisionsPerHour: 'integer', retentionDays: 'integer', policyVersion: 'string'
} satisfies Record<Exclude<keyof UpdateCollaborationSettingsInput, 'expectedRevision'>, FieldKind>;
type DutyPatch = Parameters<NonNullable<CollaborationRouteOptions['updateDuty']>>[1];
const dutyFields = { responder: ['self', 'null'], alarm: 'json' } satisfies Record<Exclude<keyof DutyPatch, 'expectedRevision'>, FieldKind>;
export const groupFields = { ...bindingFields, roleChanges: 'json', ...collaborationFields, ...dutyFields } satisfies Record<string, FieldKind>;

const describeKind = (kind: FieldKind) => typeof kind !== 'string' ? kind.join('|') : {
  boolean: 'true|false', integer: 'integer', 'integer|null': 'integer|null', string: 'text',
  list: 'a,b,c|JSON array', users: 'JSON array of {"openId":"ou_...","name":"..."}', json: 'JSON', override: 'inherit|clear|<value>|JSON'
}[kind];

export const fieldsHelp = (fields: Record<string, FieldKind>) =>
  `\nKeys:\n${Object.entries(fields).map(([key, kind]) => `  ${key}=<${describeKind(kind)}>`).join('\n')}\n`;

function parseValue(key: string, raw: string, kind: FieldKind): unknown {
  const invalid = () => new SettingsCliError('SETTINGS_VALUE_INVALID', `${key} expects ${describeKind(kind)}`);
  const json = () => { try { return JSON.parse(raw) as unknown; } catch { throw invalid(); } };
  if (typeof kind !== 'string') { if (kind.includes(raw)) return raw === 'null' ? null : raw; throw invalid(); }
  if (kind === 'boolean') { if (raw === 'true' || raw === 'false') return raw === 'true'; throw invalid(); }
  if (kind === 'integer' || kind === 'integer|null') {
    if (kind === 'integer|null' && raw === 'null') return null;
    if (/^-?\d+$/.test(raw)) return Number(raw);
    throw invalid();
  }
  if (kind === 'string') return raw;
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

function parsePairs(pairs: string[], fields: Record<string, FieldKind>, help: string) {
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

async function findBot(request: Request, appId: string) {
  const config = await request('GET', '/api/lark/config') as { bots?: PublicBot[] };
  const bot = config.bots?.find(item => item.appId === appId);
  if (!bot) throw new SettingsCliError('SETTINGS_BOT_NOT_FOUND', `Bot ${appId} is not configured on this runtime; see \`dutydeck settings bot list\``);
  return bot;
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
  const overview = await request('GET', collaborationPath(bot.appId, chatId)) as { snapshot: { settings: unknown }; duty?: unknown };
  return { group: { chatId: group.chatId, name: group.name }, bot, collaboration: { settings: overview.snapshot.settings, duty: overview.duty } };
}

async function setGroup(request: Request, input: SettingsCliInput) {
  const chatId = required(input.chatId, 'Chat ID');
  if (!input.pairs?.length) throw new SettingsCliError('SETTINGS_ARGUMENT_REQUIRED', 'Pass at least one key=value');
  const values = parsePairs(input.pairs, groupFields, 'dutydeck settings group set --help');
  const { roleChanges, ...patch } = pick(values, { ...bindingFields, roleChanges: true });
  const settings = pick(values, collaborationFields);
  const duty = pick(values, dutyFields);
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
  return { applied, ...await showGroup(request, chatId, bot.appId) };
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
