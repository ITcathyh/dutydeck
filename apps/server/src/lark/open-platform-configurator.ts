import { larkCommandRegistry } from './commands.js';
import { isOpenPlatformSessionExpired } from './open-platform-session.js';
import type { LarkSlashCommandDefinition } from './service.js';

/**
 * 开放平台控制台会话客户端：带的是登录 cookie + CSRF，只打控制台域的
 * `/developers/v1/*`。租户 OpenAPI（`/open-apis/*`）认的是 tenant_access_token，
 * 是另一套凭据，不走这个客户端——原生斜杠命令同步见 LarkCardService.syncSlashCommands。
 */
export interface LarkOpenPlatformClient {
  postJson(path: string, body?: Record<string, unknown>): Promise<unknown>;
}

/**
 * 租户权限分级。
 *
 * base：消息收发的必要条件，租户权限目录里缺任何一项都说明这个应用根本跑不起来，
 *       必须中止自动配置与发版（缺了还发版 = 发一个收不到消息的机器人）。
 * feature：只支撑单个功能。目录里没有时跳过该项并如实汇报，不阻断发版——
 *       否则一个租户目录里缺一项功能权限，会连带让没开这些功能的用户丢掉自动配置能力。
 */
export type LarkTenantScopeTier = 'base' | 'feature';
export interface LarkTenantScope {
  name: string;
  tier: LarkTenantScopeTier;
  /** feature 项跳过时用来说明「跳过后哪个功能不可用」。 */
  feature?: string;
}

export const LARK_TENANT_SCOPES: readonly LarkTenantScope[] = [
  { name: 'application:app_slash_command:write', tier: 'feature', feature: '原生斜杠命令注册' },
  { name: 'contact:contact.base:readonly', tier: 'base' },
  { name: 'contact:user.base:readonly', tier: 'base' },
  { name: 'contact:user.email:readonly', tier: 'base' },
  { name: 'contact:user.id:readonly', tier: 'base' },
  { name: 'im:chat.members:read', tier: 'base' },
  { name: 'im:chat:read', tier: 'base' },
  { name: 'im:message', tier: 'base' },
  { name: 'im:message.group_at_msg.include_bot:readonly', tier: 'base' },
  { name: 'im:message.group_at_msg:readonly', tier: 'base' },
  { name: 'im:message.group_msg', tier: 'base' },
  { name: 'im:message.group_msg.include_bot:read', tier: 'base' },
  { name: 'im:message.p2p_msg:readonly', tier: 'base' },
  { name: 'im:message.reactions:write_only', tier: 'base' },
  { name: 'im:message:readonly', tier: 'base' },
  { name: 'im:message:update', tier: 'base' },
  { name: 'im:message:urgent_app', tier: 'feature', feature: '卡片加急' },
  { name: 'im:pin', tier: 'feature', feature: '卡片置顶' },
  { name: 'im:resource', tier: 'base' },
  // 任务智能体通道（task-agent.ts）：读「我负责的」任务 + 写任务记录都用这一项。
  { name: 'task:task:write', tier: 'feature', feature: '飞书任务智能体通道' },
];

/** 申请清单（字母序），与 LARK_TENANT_SCOPES 同源。 */
export const LARK_COMMON_TENANT_SCOPES: readonly string[] = LARK_TENANT_SCOPES.map(scope => scope.name);

export const LARK_COMMON_USER_SCOPES = [] as const;

/**
 * 必须订阅的事件列表。沿用「条件增量 add」：只提交当前订阅里缺失的事件，
 * 已存在的绝不重复添加；提交后回读校验全部生效才继续发版。
 * 对外只读导出（/repair 确认卡需要如实列出要补的事件）。
 */
export const LARK_REQUIRED_EVENTS = [
  'im.message.receive_v1',
  // bot 入群事件：P0-5 欢迎语依赖它；存量应用靠 /repair 增量补上。
  'im.chat.member.bot.added_v1',
  'im.message.updated_v1',
] as const;
const REQUIRED_CALLBACK = 'card.action.trigger';
const LONG_CONNECTION_MODE = 4;

/** 配置流程的可观测步骤，供 /repair 如实回显每一步结果。 */
export type LarkOpenPlatformConfigureStep =
  | 'scope_update'
  | 'robot_enable'
  | 'event_mode'
  | 'event_subscribe'
  | 'callback_mode'
  | 'callback_subscribe'
  | 'version_create'
  | 'publish_commit'
  | 'publish_verify';

export interface LarkOpenPlatformConfigureStepDetail {
  /** event_subscribe：本次增量补上的事件名。 */
  addedEvents?: string[];
  /** version_create / publish_commit：创建出的版本 ID。 */
  versionId?: string;
  /** scope_update：租户权限目录里没有、本次跳过未申请的 feature 权限名。 */
  skippedScopes?: string[];
}

export interface LarkOpenPlatformConfigureOptions {
  creatorUserId?: string;
  /** Only the app-creation job may opt in for its own not-yet-published app. */
  newApp?: boolean;
  /** 每个阶段完成后回调一次；失败阶段不会回调。 */
  onStep?: (step: LarkOpenPlatformConfigureStep, detail?: LarkOpenPlatformConfigureStepDetail) => void;
}

export interface LarkOpenPlatformConfigurationResult {
  status: 'ready';
  /** 本次真正申请的权限项数；被跳过的 feature 权限不计入。 */
  scopeCount: number;
  /**
   * 租户权限目录里没有、本次跳过未申请的 feature 权限名。
   * 这里列出的是「本次跳过」——对应功能不可用，但不阻断发版。
   */
  skippedScopes: string[];
  eventCount: number;
  callbackCount: number;
  versionId: string;
}

export class LarkOpenPlatformConfigurationError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) {
    super(message);
    this.name = 'LarkOpenPlatformConfigurationError';
    if (options && 'cause' in options) {
      Object.defineProperty(this, 'cause', {
        value: options.cause,
        writable: true,
        configurable: true,
        enumerable: false,
      });
    }
  }
}

type ScopeBucket = 'tenant' | 'user';
interface ScopeEntry { id: string; name: string; bucket?: ScopeBucket; status?: number }
interface SubscriptionState { mode?: number; names: string[] }
interface VisibilitySuggest { departments: string[]; members: string[]; groups: string[]; isAll: 0 | 1 }

export async function configureLarkOpenPlatformApp(
  client: LarkOpenPlatformClient,
  appId: string,
  options: LarkOpenPlatformConfigureOptions = {},
): Promise<LarkOpenPlatformConfigurationResult> {
  const onStep = options.onStep ?? (() => undefined);
  if (!isValidLarkAppId(appId)) {
    throw new LarkOpenPlatformConfigurationError('invalid_app_id', '飞书应用 ID 格式无效，应为 cli_*');
  }

  const newAppVersions = options.newApp
    ? await post(client, `/developers/v1/app_version/list/${appId}`, {}, 'version_list_failed', '读取飞书应用版本失败')
    : undefined;
  if (newAppVersions) nextVersion(newAppVersions);

  const catalogPayload = await post(client, `/developers/v1/scope/all/${appId}`, undefined,
    'scope_catalog_read_failed', '读取飞书权限目录失败');
  const { ids: scopeIds, skipped: skippedScopes } = mapRequiredScopes(catalogPayload);
  await post(client, `/developers/v1/scope/update/${appId}`, {
    clientId: appId,
    appScopeIDs: scopeIds,
    userScopeIDs: [],
    scopeIds: [],
    operation: 'add',
    isDeveloperPanel: true,
  }, 'scope_update_failed', '配置飞书常用权限失败');
  const scopeReadback = await post(client, `/developers/v1/scope/all/${appId}`, undefined,
    'scope_verification_read_failed', '回读飞书权限配置失败');
  // 回读只校验本次真正申请的 id；被跳过的 feature 权限没有 id，自然不参与校验。
  verifyRequiredScopes(scopeReadback, scopeIds);
  onStep('scope_update', skippedScopes.length ? { skippedScopes: [...skippedScopes] } : undefined);

  await post(client, `/developers/v1/robot/switch/${appId}`, {
    clientId: appId,
    enable: true,
  }, 'robot_enable_failed', '启用飞书机器人能力失败');
  onStep('robot_enable');
  await post(client, `/developers/v1/event/switch/${appId}`, {
    clientId: appId,
    eventMode: LONG_CONNECTION_MODE,
  }, 'event_mode_failed', '启用飞书长连接事件模式失败');
  onStep('event_mode');

  let eventState = parseEventState(await post(
    client,
    `/developers/v1/event/${appId}`,
    { needEventDetail: true },
    'event_read_failed',
    '读取飞书事件订阅失败',
  ));
  // 增量补权：只 add 缺失事件，已订阅事件保持原样、不重复提交。
  const missingEvents = LARK_REQUIRED_EVENTS.filter(name => !eventState.names.includes(name));
  if (missingEvents.length > 0) {
    await post(client, `/developers/v1/event/update/${appId}`, {
      clientId: appId,
      operation: 'add',
      events: [],
      appEvents: missingEvents,
      userEvents: [],
      eventMode: LONG_CONNECTION_MODE,
    }, 'event_update_failed', '订阅飞书消息事件失败');
    eventState = parseEventState(await post(
      client,
      `/developers/v1/event/${appId}`,
      { needEventDetail: true },
      'event_read_failed',
      '回读飞书事件订阅失败',
    ));
    onStep('event_subscribe', { addedEvents: [...missingEvents] });
  }
  if (eventState.mode !== LONG_CONNECTION_MODE || LARK_REQUIRED_EVENTS.some(name => !eventState.names.includes(name))) {
    throw new LarkOpenPlatformConfigurationError(
      'event_verification_failed',
      '飞书消息事件或长连接模式未生效',
    );
  }

  let callbackState = parseCallbackState(await post(
    client,
    `/developers/v1/callback/${appId}`,
    {},
    'callback_read_failed',
    '读取飞书卡片回调失败',
  ));
  if (callbackState.mode !== LONG_CONNECTION_MODE) {
    await post(client, `/developers/v1/callback/switch/${appId}`, {
      clientId: appId,
      callbackMode: LONG_CONNECTION_MODE,
    }, 'callback_mode_failed', '启用飞书长连接回调模式失败');
    callbackState = parseCallbackState(await post(
      client,
      `/developers/v1/callback/${appId}`,
      {},
      'callback_read_failed',
      '回读飞书回调模式失败',
    ));
    onStep('callback_mode');
  }
  if (!callbackState.names.includes(REQUIRED_CALLBACK)) {
    await post(client, `/developers/v1/callback/update/${appId}`, {
      clientId: appId,
      operation: 'add',
      callbacks: [REQUIRED_CALLBACK],
      callbackMode: LONG_CONNECTION_MODE,
    }, 'callback_update_failed', '订阅飞书卡片回调失败');
    callbackState = parseCallbackState(await post(
      client,
      `/developers/v1/callback/${appId}`,
      {},
      'callback_read_failed',
      '回读飞书卡片回调失败',
    ));
    onStep('callback_subscribe');
  }
  if (callbackState.mode !== LONG_CONNECTION_MODE || !callbackState.names.includes(REQUIRED_CALLBACK)) {
    throw new LarkOpenPlatformConfigurationError(
      'callback_verification_failed',
      '飞书卡片回调或长连接模式未生效',
    );
  }

  const versionPayload = newAppVersions ?? await post(client, `/developers/v1/app_version/list/${appId}`, {},
    'version_list_failed', '读取飞书应用版本失败');
  const appVersion = nextVersion(versionPayload);
  const priorVersions = asRecord(asRecord(versionPayload).data).versions as unknown[];
  const unpublishedNewApp = options.newApp && priorVersions.every(version => asRecord(version).versionStatus === 0);
  if (unpublishedNewApp) {
    await narrowNewAppPrivilegeRanges(client, appId);
  }
  const firstRelease = priorVersions.length === 0 || unpublishedNewApp;
  const visibility = firstRelease && options.creatorUserId
    ? {
      whiteList: { departments: [], members: [options.creatorUserId], groups: [], isAll: 0 as const },
      blackList: { departments: [], members: [], groups: [], isAll: 0 as const },
    }
    : parseVisibility(await post(client, `/developers/v1/visible/online/${appId}`, {},
      'visibility_read_failed', '读取飞书应用可见范围失败'));
  // A rejected preflight leaves a draft. Resume that same draft, then verify its
  // actual visibility before predicting approval; never commit a stale range.
  if (unpublishedNewApp && priorVersions.length > 1) {
    throw new LarkOpenPlatformConfigurationError('version_list_unreadable', '新应用存在多个草稿，已停止自动发布');
  }
  const created = unpublishedNewApp && priorVersions.length === 1 ? priorVersions[0] : await post(client, `/developers/v1/app_version/create/${appId}`, {
    appVersion,
    mobileDefaultAbility: 'bot',
    pcDefaultAbility: 'bot',
    changeLog: 'Configure Dutydeck bot capabilities.',
    visibleSuggest: visibility.whiteList,
    blackVisibleSuggest: visibility.blackList,
  }, 'version_create_failed', '创建飞书应用版本失败');
  const versionId = extractVersionId(created);
  if (!versionId) {
    throw new LarkOpenPlatformConfigurationError(
      'version_verification_failed',
      '飞书应用版本创建成功但未返回版本 ID，已停止发布',
    );
  }
  onStep('version_create', { versionId });
  if (options.newApp) await verifyAutomaticApproval(client, appId, versionId, visibility);
  await post(client, `/developers/v1/publish/commit/${appId}/${versionId}`, { clientId: appId },
    'publish_failed', '发布飞书应用版本失败');
  onStep('publish_commit', { versionId });
  let version: unknown;
  for (let attempt = 0; attempt < 10; attempt++) {
    const published = await post(client, `/developers/v1/app_version/list/${appId}`, {},
      'publish_verification_read_failed', '发布请求已提交，但回读发布状态失败，请核对该应用版本');
    const versions = asRecord(asRecord(published).data).versions;
    version = Array.isArray(versions) ? versions.find(item => extractVersionId(item) === versionId) : undefined;
    // Even an automatic approval briefly reports status 1. Allow it to finish
    // without resubmitting or reporting a human review based on that state alone.
    if (!options.newApp || asRecord(version).versionStatus !== 1 || attempt === 9) break;
    await new Promise(resolve => setTimeout(resolve, 1_000));
  }
  // Console versionStatus: 2 = published, 1 = under review, 0 = not submitted.
  // A successful commit response alone does not prove publication.
  if (asRecord(version).versionStatus === 1) {
    if (options.newApp) throw new LarkOpenPlatformConfigurationError('publish_verification_pending', '应用已按自动审批流程提交，尚未确认发布完成，请核对开放平台状态');
    throw new LarkOpenPlatformConfigurationError('publish_pending_review', '应用版本已提交，正在等待飞书管理员审核');
  }
  if (asRecord(version).versionStatus !== 2) {
    throw new LarkOpenPlatformConfigurationError('publish_verification_failed', '发布请求已提交，但该版本尚未确认发布，请核对开放平台状态');
  }
  onStep('publish_verify', { versionId });

  return {
    status: 'ready',
    scopeCount: scopeIds.length,
    skippedScopes,
    eventCount: LARK_REQUIRED_EVENTS.length,
    callbackCount: 1,
    versionId,
  };
}

async function verifyAutomaticApproval(
  client: LarkOpenPlatformClient,
  appId: string,
  versionId: string,
  expectedVisibility: { whiteList: VisibilitySuggest; blackList: VisibilitySuggest },
): Promise<void> {
  const detail = asRecord(asRecord(await post(client, `/developers/v1/app_version/detail/${appId}/${versionId}`, {},
    'draft_read_failed', '读取待发布草稿失败，尚未提交发布')).data);
  if (detail.versionId !== versionId || detail.versionStatus !== 0) {
    throw new LarkOpenPlatformConfigurationError('draft_unreadable', '无法确认待发布草稿，尚未提交发布');
  }
  const visibility = parseVisibility({ data: detail.visibleRange });
  if (JSON.stringify(visibility) !== JSON.stringify(expectedVisibility)) {
    throw new LarkOpenPlatformConfigurationError('draft_visibility_mismatch', '草稿可见范围与本次配置不一致，尚未提交发布');
  }
  const sharing = asRecord(asRecord(detail.changeAppShareConfig).b2cShareSplitConfigSuggest);
  const sharingKeys = ['b2cGroupChatShareEnable', 'b2cP2PChatShareEnable', 'b2cP2PChatNeedAudit'] as const;
  if (sharingKeys.some(key => typeof sharing[key] !== 'boolean')) {
    throw new LarkOpenPlatformConfigurationError('draft_unreadable', '草稿分享范围结构不完整，尚未提交发布');
  }
  const prediction = await post(client, `/developers/v1/approval_nodes/get/${appId}`, {
    visibleSuggest: visibility.whiteList,
    blackVisibleSuggest: visibility.blackList,
    b2cShareSplitConfigSuggest: Object.fromEntries(sharingKeys.map(key => [key, sharing[key]])),
    versionId,
    notCalculateFlow: false,
  }, 'approval_prediction_failed', '读取发布审批预判失败，尚未提交发布');
  const nodes = asRecord(asRecord(asRecord(prediction).data).applyInstanceInfo).applyNodes;
  if (!Array.isArray(nodes) || !nodes.length || nodes.some(node => !isRecord(node) || typeof node.nodeName !== 'string')) {
    throw new LarkOpenPlatformConfigurationError('approval_prediction_unreadable', '审批预判结构不完整，尚未提交发布');
  }
  const gates = nodes.map(asRecord).filter((node, index) => {
    // Names alone do not identify a non-approval node. Match the console's
    // explicit empty type and position/participants; unknown shapes fail closed.
    if (node.nodeType !== '' || !Array.isArray(node.nodeUser)) return true;
    if (index === 0 && ['发起', 'Initiate'].includes(String(node.nodeName)) && node.nodeUser.length === 1
      && typeof asRecord(asRecord(node.nodeUser[0]).approver).id === 'string') return false;
    if (index === nodes.length - 1 && ['结束', 'End'].includes(String(node.nodeName)) && node.nodeUser.length === 0) return false;
    return !(Array.isArray(node.nodeCcUser) && node.nodeCcUser.length > 0 && node.nodeUser.length === 0);
  });
  if (!gates.length) {
    throw new LarkOpenPlatformConfigurationError('approval_prediction_unreadable', '审批预判没有可确认的审批节点，尚未提交发布');
  }
  // canAutoApproval may be false even for the collaborator-only exemption.
  // The actual flow must contain only explicit automatic gates and no approvers.
  if (gates.some(node => !['自动通过', 'Auto approved'].includes(String(node.nodeType))
    || !Array.isArray(node.nodeUser) || node.nodeUser.length !== 0)) {
    throw new LarkOpenPlatformConfigurationError('publish_requires_review', '当前权限或数据范围仍需人工审批，已保留草稿且未提交审核');
  }
}

export function isValidLarkAppId(value: string): boolean {
  return /^cli_[A-Za-z0-9_-]+$/.test(value);
}

async function post(
  client: LarkOpenPlatformClient,
  path: string,
  body: Record<string, unknown> | undefined,
  code: string,
  message: string,
): Promise<unknown> {
  try {
    const payload = await client.postJson(path, body);
    const record = asRecord(payload);
    if (typeof record.code === 'number' && record.code !== 0) throw new Error('request rejected');
    return payload;
  } catch (error) {
    // 半失效登录态（首页有 csrf、管理接口才返回登出信号）：透传 session_expired，
    // 不再换成该步骤的固定「读取失败」文案。传输层细节留在 cause 里，不进 message。
    if (isOpenPlatformSessionExpired(error)) {
      throw new LarkOpenPlatformConfigurationError(
        'session_expired',
        '飞书开放平台登录已失效，请重新扫码。',
        { cause: error },
      );
    }
    // The injected transport may include cookies or app secrets in its error.
    // Keep the public error deterministic and credential-free.
    throw new LarkOpenPlatformConfigurationError(code, message);
  }
}

async function narrowNewAppPrivilegeRanges(client: LarkOpenPlatformClient, appId: string): Promise<void> {
  const read = async () => {
    const payload = await post(client, `/developers/v1/privilege/all/${appId}`, {},
      'privilege_read_failed', '读取新应用的数据范围失败，已停止发布');
    const privileges = asRecord(asRecord(payload).data).privileges;
    if (!Array.isArray(privileges)) throw new LarkOpenPlatformConfigurationError('privilege_read_failed', '新应用的数据范围结构不完整，已停止发布');
    return privileges.map(asRecord);
  };
  const updates: Record<string, unknown>[] = [];
  for (const privilege of await read()) {
    if (privilege.isRequired !== true || privilege.schemaType !== 1 || privilege.organizationType !== 1) continue;
    let content: Record<string, unknown>;
    if (privilege.content !== undefined && typeof privilege.content !== 'string') continue;
    try {
      const parsed: unknown = JSON.parse(privilege.content || '{}');
      if (!isRecord(parsed)) continue;
      content = parsed;
    } catch { continue; } // Preserve an existing range we cannot interpret.
    if (content.mode === 'part') {
      if (!Array.isArray(content.filters) || content.filters.length > 0) continue;
    } else if (content.mode !== undefined && content.mode !== '' && content.mode !== 'all' && content.mode !== 'null') continue;
    const fields = asRecord(asRecord(privilege.schemaContent).selectionExpressionSchemaContent).fields;
    if (!Array.isArray(fields) || !fields.length || !fields.every(field => {
      const value = asRecord(field);
      return typeof value.id === 'string' && value.id.length > 0 && asRecord(value.data_source).type === 'select_staff'
        && Array.isArray(value.operators) && value.operators.includes('in');
    })) continue;
    if (typeof privilege.bizId !== 'string' || typeof privilege.resource !== 'string') continue;
    const filters = fields.map(field => ({ field: asRecord(field).id, operator: 'in',
      value: JSON.stringify([{ mode: 'availability_of_app', members: [], departments: [], groups: [] }]) }));
    updates.push({ ...privilege, content: JSON.stringify({ biz_id: privilege.bizId, resource: privilege.resource,
      mode: 'part', filters, expression: filters.map((_, index) => index + 1).join(' and ') }) });
  }
  if (!updates.length) return;
  await post(client, `/developers/v1/privilege/update/${appId}`, { clientId: appId, privileges: updates },
    'privilege_update_failed', '收窄新应用的数据范围失败，已停止发布');
  const actual = await read();
  for (const expected of updates) {
    const updated = actual.find(item => item.bizId === expected.bizId && item.resource === expected.resource);
    let verified = false;
    try {
      const content = asRecord(JSON.parse(String(updated?.content)));
      const wanted = asRecord(JSON.parse(String(expected.content)));
      const filters = content.filters;
      const wantedFilters = wanted.filters as Array<Record<string, unknown>>;
      verified = content.mode === 'part' && content.expression === wanted.expression && Array.isArray(filters)
        && filters.length === wantedFilters.length && wantedFilters.every((filter, index) => {
          const value = asRecord(filters[index]);
          const ranges: unknown = JSON.parse(String(value.value));
          if (value.field !== filter.field || value.operator !== 'in' || !Array.isArray(ranges) || ranges.length !== 1) return false;
          const range = asRecord(ranges[0]);
          return range.mode === 'availability_of_app' && ['members', 'departments', 'groups'].every(key => Array.isArray(range[key]) && range[key].length === 0);
        });
    } catch { /* A successful write is not proof that the range was applied. */ }
    if (!verified) throw new LarkOpenPlatformConfigurationError('privilege_verification_failed', '新应用的数据范围未确认收窄到应用可用范围，已停止发布');
  }
}

export const MAX_SLASH_COMMAND_DESCRIPTION_LENGTH = 100;

export function formatCommandDescription(summary: string): string {
  const trimmed = summary.trim();
  if (trimmed.length <= MAX_SLASH_COMMAND_DESCRIPTION_LENGTH) return trimmed;
  return trimmed.slice(0, MAX_SLASH_COMMAND_DESCRIPTION_LENGTH);
}

/**
 * 注册表 → 飞书原生斜杠命令的目标状态（纯函数）。command 不带前导斜杠，
 * 说明按飞书的长度上限截断。执行方是 LarkCardService.syncSlashCommands。
 */
export function larkSlashCommandDefinitions(): LarkSlashCommandDefinition[] {
  return larkCommandRegistry.map(definition => ({
    command: definition.name.replace(/^\//, '').trim(),
    description: formatCommandDescription(definition.summary),
  }));
}

/**
 * 把权限清单映射成租户权限目录里的 id。
 *
 * base 权限缺失或映射不唯一 → 抛 scope_catalog_incomplete，中止自动配置与发版。
 * feature 权限同样情况 → 不申请、计入 skipped，由调用方如实汇报，发版照常继续。
 */
function mapRequiredScopes(payload: unknown): { ids: string[]; skipped: string[] } {
  const catalog: ScopeEntry[] = [];
  collectScopeEntries(payload, undefined, catalog);
  const ids: string[] = [];
  const missing: string[] = [];
  const skipped: string[] = [];
  for (const scope of LARK_TENANT_SCOPES) {
    const tenantMatches = [...new Set(catalog
      .filter(entry => entry.bucket === 'tenant' && entry.name === scope.name)
      .map(entry => entry.id))];
    // The current Feishu console catalog omits identity buckets entirely for
    // some tenants. Prefer an explicit tenant entry; otherwise accept exactly
    // one unbucketed entry. A user-bucket-only entry must never satisfy a
    // tenant permission.
    const unbucketedMatches = [...new Set(catalog
      .filter(entry => entry.bucket === undefined && entry.name === scope.name)
      .map(entry => entry.id))];
    const matches = tenantMatches.length > 0 ? tenantMatches : unbucketedMatches;
    if (matches.length === 1) ids.push(matches[0]!);
    else if (scope.tier === 'feature') skipped.push(scope.name);
    else missing.push(scope.name);
  }
  if (missing.length > 0) {
    throw new LarkOpenPlatformConfigurationError(
      'scope_catalog_incomplete',
      `飞书权限目录缺少或无法唯一映射 ${missing.length} 项必需权限`,
    );
  }
  return { ids, skipped };
}

function collectScopeEntries(value: unknown, bucket: ScopeBucket | undefined, out: ScopeEntry[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectScopeEntries(item, bucket, out);
    return;
  }
  if (!isRecord(value)) return;
  const explicitBucket = scopeBucket(value.scopeType) ?? scopeBucket(value.identity) ?? bucket;
  const buckets = Array.isArray(value.scopeType)
    ? [...new Set(value.scopeType.map(scopeBucket).filter((item): item is ScopeBucket => Boolean(item)))]
    : [explicitBucket];
  const name = pickString(value, ['scope_name', 'scopeName', 'name', 'key', 'scopeKey']);
  const id = pickString(value, ['id', 'scope_id', 'scopeId', 'scopeID']);
  const status = finiteNumber(value.status);
  if (name && id) for (const identity of buckets) {
    const identityStatus = identity && isRecord(value.scopeType2ScopeStatus)
      ? finiteNumber(value.scopeType2ScopeStatus[identity === 'tenant' ? '2' : '1'])
      : status;
    out.push({ ...(identity ? { bucket: identity } : {}), status: identityStatus, name, id });
  }
  for (const [key, child] of Object.entries(value)) {
    if (child && typeof child === 'object') {
      collectScopeEntries(child, bucketFromContainer(key) ?? explicitBucket, out);
    }
  }
}

function verifyRequiredScopes(payload: unknown, scopeIds: string[]): void {
  const catalog: ScopeEntry[] = [];
  collectScopeEntries(payload, undefined, catalog);
  // Console states: 1 = selected in draft (待发布), 5 = enabled (已开通).
  // Requiring enabled before publication prevents new permissions from ever being submitted.
  const verifiedIds = new Set(catalog
    .filter(entry => entry.bucket !== 'user' && (entry.status === 1 || entry.status === 5))
    .map(entry => entry.id));
  const missing = scopeIds.filter(id => !verifiedIds.has(id));
  if (missing.length > 0) {
    throw new LarkOpenPlatformConfigurationError(
      'scope_verification_failed',
      `飞书有 ${missing.length} 项必需应用权限未加入待发布草稿或已开通列表，已停止发布`,
    );
  }
}

function bucketFromContainer(key: string): ScopeBucket | undefined {
  if (/user.*scope|scope.*user/i.test(key)) return 'user';
  if (/(?:app|client|tenant).*scope|scope.*(?:app|client|tenant)/i.test(key)) return 'tenant';
  return undefined;
}

function scopeBucket(value: unknown): ScopeBucket | undefined {
  if (value === 2) return 'tenant';
  if (value === 1) return 'user';
  if (typeof value !== 'string') return undefined;
  if (/^(?:app|client|tenant)$/i.test(value)) return 'tenant';
  if (/^user$/i.test(value)) return 'user';
  return undefined;
}

function parseEventState(payload: unknown): SubscriptionState {
  const data = responseData(payload);
  return {
    mode: finiteNumber(data.eventMode),
    names: unique([
      ...ids(data.events),
      ...ids(data.appEvents),
      ...ids(data.userEvents),
      ...detailIds(data.eventDetails),
      ...detailIds(data.appEventDetails),
      ...detailIds(data.userEventDetails),
    ]),
  };
}

function parseCallbackState(payload: unknown): SubscriptionState {
  const data = responseData(payload);
  return { mode: finiteNumber(data.callbackMode), names: ids(data.callbacks) };
}

function ids(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(item => typeof item === 'string'
    ? item
    : pickString(asRecord(item), ['id', 'event', 'eventName', 'name']))
    .filter((item): item is string => Boolean(item));
}

function detailIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => ids(asRecord(item).items));
}

function parseVisibility(payload: unknown): { whiteList: VisibilitySuggest; blackList: VisibilitySuggest } {
  const root = asRecord(payload);
  if (!isRecord(root.data)) return visibilityError();
  const data = root.data;
  return {
    whiteList: visibilityBlock(data.whiteList, 'whiteList'),
    blackList: visibilityBlock(data.blackList, 'blackList'),
  };
}

function visibilityBlock(value: unknown, label: string): VisibilitySuggest {
  if (!isRecord(value)) return visibilityError();
  for (const key of ['departments', 'members', 'groups', 'isAll']) {
    if (!(key in value)) return visibilityError();
  }
  const isAll = value.isAll;
  if (isAll !== 0 && isAll !== 1 && isAll !== false && isAll !== true) return visibilityError();
  return {
    departments: visibilityIds(value.departments, ['id', 'departmentId', 'department_id'], `${label}.departments`),
    members: visibilityIds(value.members, ['id', 'openId', 'open_id', 'userId', 'user_id'], `${label}.members`),
    groups: visibilityIds(value.groups, ['id', 'groupId', 'group_id', 'chatId', 'chat_id'], `${label}.groups`),
    isAll: isAll === 1 || isAll === true ? 1 : 0,
  };
}

function visibilityIds(value: unknown, keys: string[], _label: string): string[] {
  if (!Array.isArray(value)) return visibilityError();
  const result = value.map(item => typeof item === 'string' || typeof item === 'number'
    ? String(item)
    : pickString(asRecord(item), keys));
  if (result.some(item => !item)) return visibilityError();
  return result as string[];
}

function visibilityError(): never {
  throw new LarkOpenPlatformConfigurationError(
    'visibility_unreadable',
    '飞书应用可见范围结构不完整，已停止发布以避免覆盖线上范围',
  );
}

function nextVersion(payload: unknown): string {
  const data = asRecord(asRecord(payload).data);
  if (!Array.isArray(data.versions)) {
    throw new LarkOpenPlatformConfigurationError('version_list_unreadable', '飞书应用版本列表结构不完整');
  }
  const versions = data.versions.map(item => pickString(asRecord(item), ['appVersion', 'app_version']));
  const parsed = versions.filter((item): item is string => Boolean(item)).map(value => {
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
    if (!match) return undefined;
    return [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  });
  if (parsed.some(item => item === undefined)) {
    throw new LarkOpenPlatformConfigurationError('version_list_unreadable', '飞书应用版本号不是有效的三段版本号');
  }
  const valid = parsed.filter((item): item is readonly [number, number, number] => Boolean(item));
  if (valid.length === 0) return '0.0.1';
  const max = valid.reduce((left, right) => {
    if (left[0] !== right[0]) return left[0] > right[0] ? left : right;
    if (left[1] !== right[1]) return left[1] > right[1] ? left : right;
    if (left[2] !== right[2]) return left[2] > right[2] ? left : right;
    return left;
  });
  return `${max[0]}.${max[1]}.${max[2] + 1}`;
}

function extractVersionId(payload: unknown): string | undefined {
  const root = asRecord(payload);
  return pickString(root, ['versionId', 'version_id', 'id'])
    ?? pickString(asRecord(root.data), ['versionId', 'version_id', 'id'])
    ?? pickString(asRecord(asRecord(root.data).appVersion), ['versionId', 'version_id', 'id']);
}

function responseData(payload: unknown): Record<string, unknown> {
  const root = asRecord(payload);
  return isRecord(root.data) ? root.data : root;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function pickString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value) return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}
