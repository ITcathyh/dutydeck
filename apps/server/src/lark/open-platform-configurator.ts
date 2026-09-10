export interface LarkOpenPlatformClient {
  postJson(path: string, body?: Record<string, unknown>): Promise<unknown>;
}

export const LARK_COMMON_TENANT_SCOPES = [
  'contact:contact.base:readonly',
  'contact:user.base:readonly',
  'contact:user.email:readonly',
  'contact:user.id:readonly',
  'im:chat.members:read',
  'im:chat:read',
  'im:message',
  'im:message.group_at_msg.include_bot:readonly',
  'im:message.group_at_msg:readonly',
  'im:message.group_msg',
  'im:message.group_msg.include_bot:read',
  'im:message.p2p_msg:readonly',
  'im:message.reactions:write_only',
  'im:message:readonly',
  'im:message:update',
  'im:resource',
] as const;

export const LARK_COMMON_USER_SCOPES = [] as const;

const REQUIRED_EVENT = 'im.message.receive_v1';
const REQUIRED_CALLBACK = 'card.action.trigger';
const LONG_CONNECTION_MODE = 4;

export interface LarkOpenPlatformConfigurationResult {
  status: 'ready';
  scopeCount: number;
  eventCount: number;
  callbackCount: number;
  versionId: string;
}

export class LarkOpenPlatformConfigurationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'LarkOpenPlatformConfigurationError';
  }
}

type ScopeBucket = 'tenant' | 'user';
interface ScopeEntry { id: string; name: string; bucket?: ScopeBucket; status?: number }
interface SubscriptionState { mode?: number; names: string[] }
interface VisibilitySuggest { departments: string[]; members: string[]; groups: string[]; isAll: 0 | 1 }

export async function configureLarkOpenPlatformApp(
  client: LarkOpenPlatformClient,
  appId: string,
): Promise<LarkOpenPlatformConfigurationResult> {
  if (!isValidLarkAppId(appId)) {
    throw new LarkOpenPlatformConfigurationError('invalid_app_id', '飞书应用 ID 格式无效，应为 cli_*');
  }

  const catalogPayload = await post(client, `/developers/v1/scope/all/${appId}`, undefined,
    'scope_catalog_read_failed', '读取飞书权限目录失败');
  const scopeIds = mapRequiredScopes(catalogPayload);
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
  verifyRequiredScopes(scopeReadback, scopeIds);

  await post(client, `/developers/v1/robot/switch/${appId}`, {
    clientId: appId,
    enable: true,
  }, 'robot_enable_failed', '启用飞书机器人能力失败');
  await post(client, `/developers/v1/event/switch/${appId}`, {
    clientId: appId,
    eventMode: LONG_CONNECTION_MODE,
  }, 'event_mode_failed', '启用飞书长连接事件模式失败');

  let eventState = parseEventState(await post(
    client,
    `/developers/v1/event/${appId}`,
    { needEventDetail: true },
    'event_read_failed',
    '读取飞书事件订阅失败',
  ));
  if (!eventState.names.includes(REQUIRED_EVENT)) {
    await post(client, `/developers/v1/event/update/${appId}`, {
      clientId: appId,
      operation: 'add',
      events: [],
      appEvents: [REQUIRED_EVENT],
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
  }
  if (eventState.mode !== LONG_CONNECTION_MODE || !eventState.names.includes(REQUIRED_EVENT)) {
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
  }
  if (callbackState.mode !== LONG_CONNECTION_MODE || !callbackState.names.includes(REQUIRED_CALLBACK)) {
    throw new LarkOpenPlatformConfigurationError(
      'callback_verification_failed',
      '飞书卡片回调或长连接模式未生效',
    );
  }

  const visibilityPayload = await post(client, `/developers/v1/visible/online/${appId}`, {},
    'visibility_read_failed', '读取飞书应用可见范围失败');
  const visibility = parseVisibility(visibilityPayload);
  const versionPayload = await post(client, `/developers/v1/app_version/list/${appId}`, {},
    'version_list_failed', '读取飞书应用版本失败');
  const appVersion = nextVersion(versionPayload);
  const created = await post(client, `/developers/v1/app_version/create/${appId}`, {
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
  await post(client, `/developers/v1/publish/commit/${appId}/${versionId}`, { clientId: appId },
    'publish_failed', '发布飞书应用版本失败');

  return {
    status: 'ready',
    scopeCount: LARK_COMMON_TENANT_SCOPES.length,
    eventCount: 1,
    callbackCount: 1,
    versionId,
  };
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
  } catch {
    // The injected transport may include cookies or app secrets in its error.
    // Keep the public error deterministic and credential-free.
    throw new LarkOpenPlatformConfigurationError(code, message);
  }
}

function mapRequiredScopes(payload: unknown): string[] {
  const catalog: ScopeEntry[] = [];
  collectScopeEntries(payload, undefined, catalog);
  const ids: string[] = [];
  const missing: string[] = [];
  for (const name of LARK_COMMON_TENANT_SCOPES) {
    const tenantMatches = [...new Set(catalog
      .filter(entry => entry.bucket === 'tenant' && entry.name === name)
      .map(entry => entry.id))];
    // The current Feishu console catalog omits identity buckets entirely for
    // some tenants. Prefer an explicit tenant entry; otherwise accept exactly
    // one unbucketed entry. A user-bucket-only entry must never satisfy a
    // tenant permission.
    const unbucketedMatches = [...new Set(catalog
      .filter(entry => entry.bucket === undefined && entry.name === name)
      .map(entry => entry.id))];
    const matches = tenantMatches.length > 0 ? tenantMatches : unbucketedMatches;
    if (matches.length === 1) ids.push(matches[0]!);
    else missing.push(name);
  }
  if (missing.length > 0) {
    throw new LarkOpenPlatformConfigurationError(
      'scope_catalog_incomplete',
      `飞书权限目录缺少或无法唯一映射 ${missing.length} 项必需权限`,
    );
  }
  return ids;
}

function collectScopeEntries(value: unknown, bucket: ScopeBucket | undefined, out: ScopeEntry[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectScopeEntries(item, bucket, out);
    return;
  }
  if (!isRecord(value)) return;
  const explicitBucket = scopeBucket(value.scopeType) ?? scopeBucket(value.identity) ?? bucket;
  const name = pickString(value, ['scope_name', 'scopeName', 'name', 'key', 'scopeKey']);
  const id = pickString(value, ['id', 'scope_id', 'scopeId', 'scopeID']);
  const status = finiteNumber(value.status);
  if (name && id) out.push({
    ...(explicitBucket ? { bucket: explicitBucket } : {}),
    ...(status === undefined ? {} : { status }),
    name,
    id,
  });
  for (const [key, child] of Object.entries(value)) {
    if (child && typeof child === 'object') {
      collectScopeEntries(child, bucketFromContainer(key) ?? explicitBucket, out);
    }
  }
}

function verifyRequiredScopes(payload: unknown, scopeIds: string[]): void {
  const catalog: ScopeEntry[] = [];
  collectScopeEntries(payload, undefined, catalog);
  const verifiedIds = new Set(catalog
    .filter(entry => entry.status === 5)
    .map(entry => entry.id));
  const missing = scopeIds.filter(id => !verifiedIds.has(id));
  if (missing.length > 0) {
    throw new LarkOpenPlatformConfigurationError(
      'scope_verification_failed',
      `飞书有 ${missing.length} 项必需权限未在更新后生效，已停止发布`,
    );
  }
}

function bucketFromContainer(key: string): ScopeBucket | undefined {
  if (/user.*scope|scope.*user/i.test(key)) return 'user';
  if (/(?:app|client|tenant).*scope|scope.*(?:app|client|tenant)/i.test(key)) return 'tenant';
  return undefined;
}

function scopeBucket(value: unknown): ScopeBucket | undefined {
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
