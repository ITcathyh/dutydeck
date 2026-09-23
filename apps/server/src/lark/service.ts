import { readFile } from 'node:fs/promises';
import * as lark from '@larksuiteoapi/node-sdk';
import type { PermissionMode } from '@dutydeck/shared';
import { larkErrorCode, type ContactIdType, type ContactUser } from './owner-identity.js';
import { executeWithLarkGate, LarkCircuitOpenError } from './api-gate.js';
import { buildLarkCardActions, safeLarkWebUrl, type LarkCardCapabilities } from './card-actions.js';

/**
 * 从响应头解析飞书要求的等待时长（ms）。Retry-After 与 x-ogw-ratelimit-reset 的
 * 单位都是**秒**，两者同时出现时取较大值（宁可多等，不要再撞一次频控）。
 * 解析结果交给 api-gate 决定实际退避，避免网关只能盲目指数退避。
 */
function retryAfterMsFromHeaders(headers: Headers | undefined): number | undefined {
  if (!headers || typeof headers.get !== 'function') return undefined;
  let best: number | undefined;
  for (const name of ['retry-after', 'x-ogw-ratelimit-reset']) {
    const seconds = Number(headers.get(name));
    if (Number.isFinite(seconds) && seconds > 0) best = best === undefined ? seconds : Math.max(best, seconds);
  }
  return best === undefined ? undefined : best * 1000;
}

export const larkCardStates = ['queued', 'running', 'completed', 'failed', 'interrupted', 'cancelled', 'reconcile_required', 'legacy_unresolved'] as const;
export type LarkCardState = (typeof larkCardStates)[number];
export const larkReceiveIdTypes = ['open_id', 'union_id', 'user_id', 'email', 'chat_id'] as const;
export type LarkReceiveIdType = (typeof larkReceiveIdTypes)[number];

export interface LarkCardInput {
  cardKind?: 'process' | 'result';
  agentName?: string;
  workspace?: string;
  state?: LarkCardState;
  taskName?: string;
  taskId?: string;
  sessionId?: string;
  webBaseUrl?: string;
  elapsedSeconds?: number;
  markdown?: string;
  elements?: Array<Record<string, unknown>>;
  retryable?: boolean;
  loadingImageKey?: string;
  idempotencyKey?: string;
  readOnly?: boolean;
  permissionMode?: PermissionMode;
  /** Override the lifecycle label without changing the machine state. */
  statusLabel?: string;
  /**
   * 这张卡正停下来等人（等审批、等回答）。任务卡由 trace 里的 risk_alert_pending_* 自证，
   * 而 workflow 的审批/提问卡自己拼 elements、没有那个 element_id，只能显式声明。
   * 声明后卡片转成橙色色带，从执行中的蓝色里区分出来。
   */
  awaitingHuman?: boolean;
  /**
   * 操作按钮能力声明（card-actions.ts 的唯一事实源入参）。
   * 由 coordinator 按 runtime 实际能力 + 任务当前状态注入；未注入时按保守默认推导，
   * 保证既有调用点行为不变。任一能力为 false 时对应按钮不渲染，而不是渲染死按钮。
   */
  capabilities?: LarkCardCapabilities;
  /**
   * 轮次编号，写入 callback value 以便 daemon 重启后仍能解释这次点击。
   * 卡片状态机之外的信息一律放进 value，不依赖内存。
   */
  turn?: number;
  /**
   * 按钮状态覆写：卡片视觉状态只有 5 种（LarkCardState），但任务状态机多一个
   * interrupting。需要按 interrupting 收敛按钮时用它，不改变卡片配色与标题。
   */
  actionState?: LarkCardState | 'interrupting';
}
export interface LarkSendInput extends LarkCardInput { receiveId?: string; receiveIdType?: LarkReceiveIdType; chatId?: string }
export interface LarkReplyInput extends LarkCardInput { messageId: string; replyInThread?: boolean; replyRootId?: string }
export interface LarkUpdateInput extends LarkCardInput { messageId: string }
export interface LarkMessageResult { messageId: string; chatId?: string }
export interface LarkReactionResult { messageId: string; reactionId: string; emojiType: string }
export type LarkUrgentUserIdType = 'open_id' | 'union_id' | 'user_id';
export interface LarkUrgentAppInput {
  messageId: string;
  userIdList: string[];
  userIdType?: LarkUrgentUserIdType;
}
export interface LarkUrgentResult {
  invalidUserIdList: string[];
}
export interface LarkPinResult {
  messageId: string;
  chatId?: string;
}
export interface LarkPinItem {
  messageId: string;
  chatId?: string;
  operatorId?: string;
  operatorIdType?: string;
  createTime?: string;
}
export interface LarkPinsResult {
  items: LarkPinItem[];
  hasMore: boolean;
  pageToken?: string;
}
export interface LarkBotInfo { appName: string; openId: string; avatarUrl?: string; activateStatus?: number }
export interface LarkApplicationIdentityCheck { verified: true; reportedAppId?: string; tenantKey?: string }
/** 一条原生斜杠命令：command 不带前导斜杠，应用内唯一。 */
export interface LarkSlashCommandDefinition { command: string; description: string }
/** 单应用上限 100 条，翻页轮数按此封顶即可覆盖全量。 */
const MAX_SLASH_COMMAND_PAGES = 10;
export interface LarkSlashCommandSyncResult { created: string[]; updated: string[] }
export interface LarkChatPreflightInfo { chatMode?: string; chatStatus?: string; name?: string; description?: string }
export interface LarkIdentityResolutionCheck { verified: true; sampleOpenId: string; sampleEmails: string[] }
export interface LarkMessageResourceResult { data: Uint8Array; contentType?: string }
export type LarkChatMemberType = 'user' | 'bot';
export interface LarkChatMember {
  memberId: string;
  memberIdType?: string;
  memberType: LarkChatMemberType;
  name: string;
  tenantKey?: string;
  appId?: string;
  openId?: string;
}
export interface LarkChatMembersInput {
  chatId: string;
  memberTypes?: LarkChatMemberType[];
  pageSize?: number;
  pageToken?: string;
}
export interface LarkChatMembersResult {
  items: LarkChatMember[];
  hasMore: boolean;
  pageToken?: string;
  memberTotal?: number;
  securityLimit?: number;
  securityLimited: boolean;
}
export interface LarkChat {
  chatId: string;
  name: string;
  description?: string;
  ownerId?: string;
  external: boolean;
  chatMode?: string;
  chatStatus?: string;
}
export interface LarkChatsResult {
  items: LarkChat[];
  hasMore: boolean;
  pageToken?: string;
}
export interface LarkResolvedUser { openId: string; name: string }
export interface LarkChatMessageSender { id?: string; idType?: string; type?: string; tenantKey?: string; name?: string }
export interface LarkChatMessageMention { id?: string; idType?: string; key?: string; name?: string; tenantKey?: string }
export interface LarkChatMessage {
  messageId: string;
  chatId?: string;
  messageType: string;
  createTime: string;
  updateTime?: string;
  sender: LarkChatMessageSender;
  rawContent: string;
  mentions: LarkChatMessageMention[];
  deleted: boolean;
  updated: boolean;
  threadId?: string;
  /** 话题根消息 ID（REST 详情字段 root_id，与 thread_id 独立）。 */
  rootId?: string;
  /** 上一条被回复消息 ID（REST 详情字段 parent_id）。 */
  parentId?: string;
  /** 合并转发消息中，上一层级的消息 ID，仅在合并转发场景会有返回值。 */
  upperMessageId?: string;
}
export interface LarkChatMessagesInput {
  chatId?: string;
  /** 传入 threadId 时按话题拉取消息（container_id_type=thread），否则按群拉取。 */
  threadId?: string;
  order?: 'asc' | 'desc';
  pageSize?: number;
  pageToken?: string;
  startTime?: number;
  endTime?: number;
}
export interface LarkChatMessagesResult { items: LarkChatMessage[]; hasMore: boolean; pageToken?: string }
export interface LarkTextMessageInput { text: string; idempotencyKey?: string }
export interface LarkSendTextInput extends LarkTextMessageInput { chatId: string }
export interface LarkReplyTextInput extends LarkTextMessageInput { messageId: string; replyInThread?: boolean }
export interface LarkUploadInput { data: Uint8Array; filename: string; idempotencyKey: string }
export interface LarkMediaSendInput { chatId: string; fileKey?: string; imageKey?: string; idempotencyKey: string }
export interface LarkMediaReplyInput { messageId: string; replyInThread?: boolean; fileKey?: string; imageKey?: string; idempotencyKey: string }

export interface LarkBotConfig {
  appId: string;
  appSecret: string;
  defaultReceiveId?: string;
  defaultReceiveIdType: LarkReceiveIdType;
  defaultAgentName: string;
  baseUrl: string;
  /**
   * 构造本 service 时使用的 env，转交给 api-gate 读取限流/退避/熔断配置。
   * 不透传的话网关只会读 process.env，测试无法在不污染全局的前提下调参，
   * 多租户部署也无法给不同 app 配不同 QPS。
   */
  env?: NodeJS.ProcessEnv;
}
export interface LarkBotConfigInput {
  appId?: string;
  appSecret?: string;
  receiveId?: string;
  chatId?: string;
  receiveIdType?: LarkReceiveIdType;
  agentName?: string;
  baseUrl?: string;
}

export interface LarkConfigurationStatus {
  configured: boolean;
  listening: false;
  missing: string[];
  defaultReceiveIdConfigured: boolean;
  defaultReceiveIdType: LarkReceiveIdType;
  defaultAgentName: string;
  baseUrl: string;
}

// header 的 template 是整条卡宽的饱和色块，一张卡上最重的一块颜色，也是在群里滚动时
// 唯一能不读字就分出来的东西：蓝=在跑、绿=跑完、红=失败、灰=排队或已取消。
// 等人处理的卡在 buildLarkCard 里强制转 orange——橙色在这套配色里没有别的用途，
// 一眼就能从一片蓝绿里跳出来。
const statePresentation = {
  queued: { title: '排队中', color: 'grey', template: 'grey' },
  running: { title: '正在执行', color: 'wathet', template: 'blue' },
  completed: { title: '已完成', color: 'green', template: 'green' },
  failed: { title: '已失败', color: 'red', template: 'red' },
  interrupted: { title: '已中断', color: 'grey', template: 'grey' },
  cancelled: { title: '已取消', color: 'grey', template: 'grey' },
  reconcile_required: { title: '需要核对', color: 'orange', template: 'orange' },
  legacy_unresolved: { title: '需要核对', color: 'orange', template: 'orange' }
} as const;
const elapsedLabel = (seconds: number) => {
  const value = Math.max(0, Math.floor(seconds));
  if (value < 60) return `${value}s`;
  const minutes = Math.floor(value / 60);
  const rest = value % 60;
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
};
const clipCardField = (value: string, limit: number) => {
  const characters = Array.from(value);
  return characters.length <= limit ? value : `${characters.slice(0, Math.max(1, limit - 1)).join('')}…`;
};
const cardFieldLimits = {
  taskName: 160,
  agentName: 64,
  workspace: 160,
  taskId: 96,
  sessionId: 128,
  webBaseUrl: 512,
  imageKey: 256
} as const;
export const larkCardSafeLimits = { bytes: 24 * 1024, components: 180 } as const;
export const larkCardSnapshotLimits = { bytes: 16 * 1024, components: 120 } as const;
const cardBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');

/**
 * 超预算时从一个执行分组里剥掉一段工具内容，剥到只剩第一段就停手。
 *
 * 绝不剥成空：一个点开什么都没有的折叠箭头比直接删掉整个阶段更糟——它承诺了内容却不给。
 * 已经只剩一段的面板不再重复剥，否则外层裁剪循环不会推进；此时循环会转去删整个阶段，
 * 并附上省略提示，读者至少知道有东西被拿掉了。
 *
 * 快照裁剪（boundLarkCardElements）和整卡裁剪（buildLarkCard）共用这一份判断，
 * 两处曾各有一份副本，行为一旦分叉就会出现「快照留着、整卡剥空」这种无法复现的差异。
 */
const stripFirstToolSection = (group: Record<string, unknown>): boolean => {
  const groupElements = Array.isArray(group.elements) ? group.elements as Array<Record<string, unknown>> : [];
  const toolIndex = groupElements.findIndex(element => {
    if (typeof element.element_id !== 'string' || !element.element_id.startsWith('trace_tool_')) return false;
    return (Array.isArray(element.elements) ? element.elements : []).length > 1;
  });
  if (toolIndex < 0) return false;
  const tool = groupElements[toolIndex] as Record<string, unknown>;
  tool.elements = [(tool.elements as Array<Record<string, unknown>>)[0]!];
  return true;
};
const cardComponents = (value: unknown): number => {
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + cardComponents(item), 0);
  if (!value || typeof value !== 'object') return 0;
  const record = value as Record<string, unknown>;
  return (typeof record.tag === 'string' ? 1 : 0) + Object.values(record).reduce<number>((sum, item) => sum + cardComponents(item), 0);
};

export function boundLarkCardElements(elements: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const withinLimits = (value: unknown) => cardBytes(value) <= larkCardSnapshotLimits.bytes
    && cardComponents(value) <= larkCardSnapshotLimits.components;
  const omissionNotice = (count: number) => ({
    tag: 'markdown', element_id: 'dutydeck_snapshot_omission',
    content: `<font color='grey'>内容较长，已省略 ${count} 个较早执行分组。</font>`,
    text_size: 'x-small', margin: '4px 0px'
  });
  const upsertOmissionNotice = (els: Array<Record<string, unknown>>, count: number) => {
    if (count <= 0) return;
    const notice = omissionNotice(count);
    // 同上：旧快照里的省略提示 id 是 dockmux_ 前缀，认不出来就会 upsert 成第二条。
    const index = els.findIndex(element =>
      element.element_id === 'dutydeck_snapshot_omission' || element.element_id === 'dockmux_snapshot_omission');
    if (index >= 0) els[index] = notice;
    else {
      const firstGroup = els.findIndex(element => typeof element.element_id === 'string' && element.element_id.startsWith('trace_group_'));
      els.splice(firstGroup < 0 ? els.length : firstGroup, 0, notice);
    }
  };
  const mainElements = [...elements];
  let omittedGroups = 0;
  while (true) {
    const candidate = [...mainElements];
    if (withinLimits(candidate)) return candidate;
    const groupIndex = mainElements.findIndex(element => typeof element.element_id === 'string' && element.element_id.startsWith('trace_group_'));
    if (groupIndex < 0) {
      const fallbackText = String((mainElements.find(element => element.element_id === 'final_output') as any)?.content
        ?? (mainElements.find(element => element.tag === 'markdown') as any)?.content ?? '内容过长');
      return [
        { tag: 'markdown', element_id: 'final_output', content: fallbackText.length > 4_000 ? `${fallbackText.slice(0, 3_999)}…` : fallbackText, text_align: 'left', text_size: 'normal_v2', margin: '0px' },
        { tag: 'markdown', element_id: 'dutydeck_snapshot_omission', content: "<font color='grey'>卡片内容超过飞书限制，过程记录已收起。</font>", text_size: 'x-small', margin: '8px 0px 0px 0px' }
      ];
    }
    const group = mainElements[groupIndex] as Record<string, unknown>;
    const groupElements = Array.isArray(group.elements) ? group.elements as Array<Record<string, unknown>> : [];
    const remainingGroups = mainElements.filter(element => typeof element.element_id === 'string' && element.element_id.startsWith('trace_group_')).length;
    // 优先从最旧分组中剥离工具输入输出，保留可扫描的分组结构；
    // 仅当分组已无内容可剥离时，才删除整个分组。
    if (stripFirstToolSection(group)) continue;
    // 只剩一个 trace 分组时，优先从分组内部移除最旧的子元素，保留最近的活动，避免整组被丢弃后用户什么都看不到。
    if (remainingGroups === 1 && groupElements.length > 1) {
      const hasTitle = (groupElements[0] as Record<string, unknown>)?.element_id === 'current_title';
      if (hasTitle && groupElements.length > 2) {
        group.elements = [groupElements[0], ...groupElements.slice(2)];
        continue;
      }
      group.elements = groupElements.slice(1);
      continue;
    }
    mainElements.splice(groupIndex, 1);
    omittedGroups++;
    upsertOmissionNotice(mainElements, omittedGroups);
  }
}
const required = (value: string | undefined, name: string) => {
  const resolved = value?.trim();
  if (!resolved) throw new LarkServiceError('LARK_NOT_CONFIGURED', `Missing required configuration: ${name}`, 503);
  return resolved;
};

function receiveIdType(value: string | undefined): LarkReceiveIdType {
  const resolved = value?.trim() || 'email';
  if (!(larkReceiveIdTypes as readonly string[]).includes(resolved)) {
    throw new LarkServiceError('INVALID_RECEIVE_ID_TYPE', `Unsupported Lark receive ID type: ${resolved}`, 400);
  }
  return resolved as LarkReceiveIdType;
}

export function larkConfigurationStatus(env: NodeJS.ProcessEnv = process.env, input: LarkBotConfigInput = {}): LarkConfigurationStatus {
  const defaultChatId = input.chatId?.trim() || env.LARK_CHAT_ID?.trim();
  const missing = [
    !input.appId?.trim() && !env.LARK_APP_ID?.trim() ? 'LARK_APP_ID' : undefined,
    !input.appSecret?.trim() && !env.LARK_APP_SECRET?.trim() ? 'LARK_APP_SECRET' : undefined
  ].filter((name): name is string => Boolean(name));
  return {
    configured: missing.length === 0,
    listening: false,
    missing,
    defaultReceiveIdConfigured: Boolean(defaultChatId || input.receiveId?.trim() || env.LARK_RECEIVE_ID?.trim()),
    defaultReceiveIdType: defaultChatId ? 'chat_id' : receiveIdType(input.receiveIdType ?? env.LARK_RECEIVE_ID_TYPE),
    defaultAgentName: input.agentName?.trim() || env.LARK_AGENT_NAME?.trim() || 'Dutydeck',
    baseUrl: (input.baseUrl?.trim() || env.LARK_OPEN_API_BASE_URL?.trim() || 'https://open.feishu.cn').replace(/\/$/, '')
  };
}

export function loadLarkBotConfig(env: NodeJS.ProcessEnv = process.env, input: LarkBotConfigInput = {}): LarkBotConfig {
  const status = larkConfigurationStatus(env, input);
  return {
    appId: required(input.appId ?? env.LARK_APP_ID, 'LARK_APP_ID or appId'),
    appSecret: required(input.appSecret ?? env.LARK_APP_SECRET, 'LARK_APP_SECRET or appSecret'),
    defaultReceiveId: input.chatId?.trim() || env.LARK_CHAT_ID?.trim() || input.receiveId?.trim() || env.LARK_RECEIVE_ID?.trim() || undefined,
    defaultReceiveIdType: status.defaultReceiveIdType,
    defaultAgentName: status.defaultAgentName,
    baseUrl: status.baseUrl,
    env
  };
}

export function buildLarkCard(input: LarkCardInput = {}) {
  const state = input.state ?? 'running';
  const presentation = statePresentation[state];
  if (!presentation) throw new LarkServiceError('INVALID_CARD_STATE', `Unsupported Lark card state: ${String(state)}`, 400);
  const taskName = clipCardField((input.taskName?.trim() || 'Dutydeck').replace(/\s+/g, ' '), cardFieldLimits.taskName);
  const taskId = clipCardField(String(input.taskId ?? Date.now()).trim() || 'task', cardFieldLimits.taskId);
  const agentName = clipCardField(input.agentName?.trim() || 'Dutydeck', cardFieldLimits.agentName);
  const sessionId = input.sessionId?.trim() ? clipCardField(input.sessionId.trim(), cardFieldLimits.sessionId) : undefined;
  const webBaseUrl = input.webBaseUrl?.trim() ? clipCardField(input.webBaseUrl.trim(), cardFieldLimits.webBaseUrl) : undefined;
  const loadingImageKey = input.loadingImageKey?.trim() ? clipCardField(input.loadingImageKey.trim(), cardFieldLimits.imageKey) : undefined;
  const elapsedSeconds = Number(input.elapsedSeconds ?? 0);
  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds < 0) throw new LarkServiceError('INVALID_ELAPSED_SECONDS', 'elapsedSeconds must be a non-negative number', 400);
  const content = input.markdown !== undefined ? String(input.markdown) : state === 'completed' ? '任务已完成。' : '';
  // 调用方显式传 statusLabel，是在说这张卡的状态不是本 state 的默认说法：workflow 的
  // 审批卡传「等待审批」、提问卡传「等待回答」、办结卡传「已处理」。下面两条
  // 「状态已经由别处表达了」的省略规则必须给它让路——省掉之后，一张停下来等人的卡上
  // 只剩一个表示「正在跑」的转圈图标，语义正好是反的。
  const explicitStatusLabel = Boolean(input.statusLabel?.trim());
  const liveTitle = explicitStatusLabel
    ? clipCardField(input.statusLabel!.trim(), 32)
    : state === 'running' ? '执行中' : state === 'completed' && input.cardKind === 'result' ? '本轮结束' : presentation.title;
  const compactTaskName = taskName;
  // 操作按钮统一由 card-actions.ts 这一唯一事实源决定：渲染端与 coordinator 回调端
  // 共用同一张能力表，因此不可能出现「界面上有按钮但回调拒绝执行」的死按钮。
  //
  // capabilities 未注入时的默认值刻意保留 cancel/interrupt/retry：
  // buildLarkCard 是公开 API（routes.ts、对账补发都在用），默认全 false 会让这些
  // 既有卡片静默丢掉主操作——那是功能回退，不是安全收益。真正的死按钮风险由
  // coordinator 注入真实能力来消除（见 capabilitiesForTask）。
  // canRefresh 例外：它依赖 coordinator 的 requestUpdate 心跳句柄，进程内不存在
  // 等价物，未显式声明时必须为 false，否则点了必然失败。
  const actionCapabilities: LarkCardCapabilities = input.capabilities ?? {
    canCancelQueued: true,
    canInterrupt: true,
    canRetry: input.retryable !== false,
    canRefresh: false,
    // 没有 sessionId 时回退到任务中心根路径。Web 路由只认 /sessions/:id，
    // 裸 /sessions 会命中 not-found——那等于把「查看详情」指向一个死页面。
    ...(webBaseUrl ? { webUrl: sessionId ? `${webBaseUrl}/sessions/${encodeURIComponent(sessionId)}` : `${webBaseUrl}/` } : {})
  };
  const actionButtons = buildLarkCardActions({
    state: (input.actionState ?? state) as Parameters<typeof buildLarkCardActions>[0]['state'],
    taskId,
    turn: Number(input.turn ?? 0),
    ...(input.readOnly ? { readOnly: true } : {}),
    ...(input.retryable !== undefined ? { retryable: input.retryable } : {}),
    capabilities: actionCapabilities
  });
  // 每个按钮一列、宽度随内容：按钮带图标，固定窄列会把文案挤折行。
  const actionButtonColumns = actionButtons.map(button => ({ tag: 'column', width: 'auto', vertical_align: 'center', elements: [button] }));
  const isProcessCard = input.cardKind === 'process';
  const isResultCard = input.cardKind === 'result';

  let footerMention: string | undefined;
  let mentionElementIndex = -1;
  if (isResultCard && input.elements?.length) {
    mentionElementIndex = input.elements.findIndex(element => element?.element_id === 'group_mention');
    if (mentionElementIndex >= 0) {
      const el = input.elements[mentionElementIndex];
      if (typeof el?.content === 'string') {
        footerMention = el.content;
      }
    }
  }

  // 页脚承载两件不值得占正文的事：这轮跑了多久，以及去哪看全貌。执行者已经写在
  // header 副标题里，页脚再写一次就是同一个名字在一张卡上出现两遍；工作区路径、
  // 任务号、权限标签对聊天里的读者没有可操作性，同样不占这一行。
  // 两者都没有时整行不渲染，不留空页脚。
  const footerColumns: any[] = [];
  // 已完成的卡不再渲染状态行（见下方 showStatusRow），耗时挪到页脚：它能说明这轮跑了
  // 多久，值得留下，但不值得占正文最上面一行去把结果往下推。
  // 调用方显式给了 statusLabel 时状态行会保留，耗时也就还在正文里，页脚不能再写一遍。
  // process 布局的耗时已在 task_overview 中承载，页脚不重复渲染耗时。
  const hasElapsed = !isProcessCard && state === 'completed' && elapsedSeconds > 0 && !explicitStatusLabel;
  const elapsedText = hasElapsed ? `用时 ${elapsedLabel(elapsedSeconds)}` : undefined;
  const parts: string[] = [];
  if (footerMention) parts.push(footerMention);
  if (elapsedText) parts.push(elapsedText);
  if (parts.length) {
    const columnContent = footerMention && elapsedText
      ? `${footerMention}<font color='grey'> · ${elapsedText}</font>`
      : elapsedText
        ? `<font color='grey'>${elapsedText}</font>`
        : footerMention!;
    footerColumns.push({
      tag: 'column', width: 'weighted', weight: 1, vertical_align: 'center',
      elements: [{
        tag: 'markdown', element_id: elapsedText ? 'task_elapsed' : 'group_mention',
        content: columnContent,
        text_size: 'x-small', margin: '0px'
      }]
    });
  }
  // 详情链接是整卡唯一的 Web 出口（顶部不再重复渲染同一个链接按钮），
  // 因此这里必须自己校验协议，不能假设别处已经挡掉 javascript: 之类的目标。
  const footerDetailUrl = safeLarkWebUrl(sessionId ? `${webBaseUrl}/sessions/${encodeURIComponent(sessionId)}` : webBaseUrl ? `${webBaseUrl}/` : undefined);
  if (footerDetailUrl) {
    footerColumns.push({
      tag: 'column', width: 'weighted', weight: 1, vertical_align: 'center',
      elements: [{
        tag: 'markdown',
        content: `<font color='grey'>[查看详情](${footerDetailUrl})</font>`,
        text_size: 'x-small', text_align: 'right', margin: '0px'
      }]
    });
  }
  const recordHint = footerDetailUrl ? '完整记录见「查看详情」。' : '';
  // 硬兜底卡没有页脚，指向「查看详情」时必须自带链接。
  const hardFallbackHint = footerDetailUrl ? `完整记录见[查看详情](${footerDetailUrl})。` : '';
  const rawElements = (isResultCard && mentionElementIndex >= 0 && input.elements?.length)
    ? input.elements.filter((_, index) => index !== mentionElementIndex)
    : input.elements;
  const sourceMainElements: Array<Record<string, unknown>> = input.elements?.length
    ? JSON.parse(JSON.stringify(rawElements))
    : [{ tag: 'markdown', content, text_align: 'left', text_size: 'normal_v2', margin: '0px' }];
  // Old persisted snapshots can still contain a Web-only instruction. Present
  // only an access path that this exact card actually offers.
  for (const element of sourceMainElements) {
    if (!/(?:omission|rejected_delta)$/.test(String(element.element_id ?? '')) || typeof element.content !== 'string') continue;
    element.content = element.content.replace(/(?:；|，)?完整(?:记录|增量)(?:请在 Dutydeck Web 查看。|见 Dutydeck Web)/g, '')
      .replace('请在 Dutydeck Web 查看完整记录。', '') + (recordHint ? `\n${recordHint}` : '');
  }
  const hasPendingApproval = (elements: Array<Record<string, unknown>>) => elements.some(element =>
    typeof element.element_id === 'string' && element.element_id.startsWith('risk_alert_pending_')
  ) || input.awaitingHuman === true;
  const arrange = (mainElements: Array<Record<string, unknown>>) => {
    const waitingForApproval = state === 'running' && hasPendingApproval(mainElements);
    const finalIds = new Set(['final_output', 'result_missing', 'evidence']);
    const finalElements = mainElements.filter(element => finalIds.has(String(element.element_id ?? '')));
    const traceElements = mainElements.filter(element => typeof element.element_id === 'string' && element.element_id.startsWith('trace_group_'));
    const omissionNotice = mainElements.find(element => element.element_id === 'trace_omission');
    const attentionElements = mainElements.filter(element => {
      const id = String(element.element_id ?? '');
      return id.startsWith('risk_alert_') || id.startsWith('execution_alert_') || String(element.content ?? '').includes('原运行卡片未能更新');
    });

    if (!isProcessCard) {
      const claimed = new Set([
        ...finalElements,
        ...traceElements,
        ...attentionElements,
        ...(omissionNotice ? [omissionNotice] : [])
      ]);
      const otherElements = mainElements.filter(element => !claimed.has(element));
      // 终态卡片的 header 已经用色带表达了结果，body 再放一个同色 text_tag 就是同一件事
      // 说两遍，而且它是整卡最重的一块颜色，会压过下面真正要读的结论。终态改用一行灰字
      // （状态文字仍然保留，颜色不是唯一线索）；运行态保留彩色 tag——那时状态还会变，
      // 需要它把注意力拉过去。
      const liveState = state === 'running' || state === 'queued';
      const statusLabelText = waitingForApproval && !explicitStatusLabel ? '等待审批' : liveTitle;
      // 「已完成」这一行在终态卡上没有读者：绿色色带已经说了一遍，结果就在它正下方，
      // 而它每出现一次就把结果往下推一行。撤掉之后结论坐在卡片第一行，耗时退到页脚。
      // 注意这没有消除过程卡与结果卡之间的跨消息重复——两张卡的标题、页脚耗时和
      // 「查看详情」仍然相同，只是不再各占一行正文。
      //
      // 其余终态仍然渲染：失败和取消要让读者据此决定是否重试，而那不是默认预期。
      const showStatusRow = state !== 'completed' || explicitStatusLabel;
      // 「已用时 0s」不是信息：它要么是首帧、要么是这张卡根本不会再更新（审批卡、提问卡
      // 都由 workflow-interactions 一次性投递，没有心跳）。0 一律不写。
      const elapsedText = elapsedSeconds > 0 ? `已用时 ${elapsedLabel(elapsedSeconds)}` : '';
      // 执行中的卡上，状态行右边就跟着一个转圈的 loading 图标，它本身已经说明任务在跑；
      // 再挂一个「执行中」标签，是同一件事的第三遍（还有一遍在聊天列表的 summary 里）。
      // 排队中和等待审批没有这个图标，状态必须由文字承担，标签保留。
      // 耗时还没攒够 1 秒时也保留：图标不能独自撑起一行没有任何文字的状态行。
      const spinnerSpeaks = state === 'running' && !waitingForApproval && !explicitStatusLabel && elapsedText !== '';
      const statusContent = liveState
        ? [spinnerSpeaks ? '' : `<text_tag color='${waitingForApproval ? 'orange' : presentation.color}'>${statusLabelText}</text_tag>`, elapsedText && `<font color='grey'>${elapsedText}</font>`].filter(Boolean).join('　')
        : `<font color='grey'>${[statusLabelText, elapsedText].filter(Boolean).join('　')}</font>`;
      const loadingIcon = loadingImageKey
        ? { tag: 'custom_icon', img_key: loadingImageKey, size: '20px 20px' }
        : { tag: 'standard_icon', token: 'loading_outlined', color: 'grey', size: '14px 14px' };
      const statusElement = {
        tag: 'div', element_id: 'task_status', width: 'auto', margin: '0px',
        text: { tag: 'lark_md', content: statusContent, text_size: 'small' },
        ...(state === 'running' && !waitingForApproval ? { icon: loadingIcon } : {})
      };
      let traceSection: Record<string, unknown>[] = [];
      if (state === 'running') {
        const currentGroup = traceElements.find(el => el.tag === 'interactive_container') ?? traceElements.at(-1);
        const currentItems = currentGroup?.tag === 'interactive_container' && Array.isArray(currentGroup.elements)
          ? currentGroup.elements as Record<string, unknown>[] : [];
        const currentTools = currentItems.filter(el => String(el.element_id ?? '').startsWith('trace_tool_'));
        // 在组装时折叠，裁剪器仍按原有扁平结构保留最新记录；标题计数对应裁剪后的内容。
        const currentStage = currentTools.length > 1 ? {
          ...currentGroup,
          elements: [
            ...currentItems.filter(el => !currentTools.includes(el)),
            {
              tag: 'collapsible_panel', element_id: 'current_records', expanded: false,
              direction: 'vertical', vertical_spacing: '4px', padding: '4px 0px 0px 0px', margin: '0px',
              header: {
                title: { tag: 'markdown', content: `执行记录（${currentTools.length} 条）`, text_size: 'notation' },
                vertical_align: 'center', icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', color: 'grey', size: '14px 14px' },
                icon_position: 'right', icon_expanded_angle: -180
              },
              elements: currentTools
            }
          ]
        } : currentGroup;
        const historyGroups = traceElements.filter(el => el !== currentGroup);
        // 历史阶段的位置本身就说明了它们是历史，不需要一行「此前阶段」再讲一遍。
        // 位置表达不了的只有「还有多少个更早阶段没展示」，那一行由 renderer 作为
        // trace_omission 产出，运行态与非运行态两种布局共用同一条。
        const historyItems: Record<string, unknown>[] = historyGroups.length ? [
          ...(omissionNotice ? [omissionNotice] : []),
          ...historyGroups
        ] : [];

        traceSection = [
          ...(currentStage ? [currentStage] : []),
          ...historyItems
        ];
      } else if (traceElements.length) {
        const recordsExpanded = traceElements.some(el => el.expanded === true);
        traceSection = [{
          tag: 'collapsible_panel', element_id: 'trace_overview', expanded: recordsExpanded,
          direction: 'vertical', vertical_spacing: '2px', padding: '4px 0px 0px 0px', margin: '8px 0px 0px 0px',
          header: {
            title: { tag: 'markdown', content: '执行记录', text_size: 'notation' },
            vertical_align: 'center', icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', color: 'grey', size: '14px 14px' },
            icon_position: 'right', icon_expanded_angle: -180
          },
          elements: [
            ...(omissionNotice ? [omissionNotice] : []),
            ...traceElements
          ]
        }];
      }
      const buttonRow = [{
        tag: 'column_set', element_id: 'task_action_row', flex_mode: 'none', horizontal_spacing: '4px', vertical_align: 'center', margin: '0px',
        columns: [
          { tag: 'column', width: 'weighted', weight: 1, vertical_align: 'center', elements: [statusElement] },
          ...actionButtonColumns
        ]
      }];
      // 有按钮就必须有承载它们的那一行，状态一并显示在左侧；没有按钮时状态行可以整行
      // 省掉——已完成的卡走的就是这条路。
      const taskHeader = actionButtons.length ? buttonRow : showStatusRow ? [statusElement] : [];
      return [
        ...taskHeader,
        ...attentionElements,
        ...finalElements,
        ...traceSection,
        ...otherElements
      ];
    }

    // Process 卡片布局
    const evidenceElements = mainElements.filter(element => element.element_id === 'evidence');
    const omissionIds = new Set([
      'dutydeck_rejected_delta',
      'dockmux_rejected_delta',
      'dutydeck_snapshot_omission',
      'dockmux_snapshot_omission',
      'dutydeck_omission',
      'trace_omission',
      'dutydeck_fallback_omission',
      'dutydeck_hard_fallback_omission'
    ]);
    const omissionElements = mainElements.filter(element => omissionIds.has(String(element.element_id ?? '')));
    const processExternalClaimed = new Set([
      ...attentionElements,
      ...evidenceElements,
      ...omissionElements,
      ...traceElements
    ]);
    const otherElements = mainElements.filter(element => !processExternalClaimed.has(element));

    const statusLabelText = waitingForApproval && !explicitStatusLabel ? '等待审批' : liveTitle;
    const defaultExpanded = state === 'running' || state === 'queued' || state === 'failed';
    const hasExplicitlyExpandedTrace = traceElements.some(el => el.expanded === true);
    const overviewExpanded = defaultExpanded || hasExplicitlyExpandedTrace;

    const elapsedPart = elapsedSeconds > 0 ? ` · ${state === 'queued' ? '排队等待' : '用时'} ${elapsedLabel(elapsedSeconds)}` : '';
    const overviewTitleText = `执行记录 · ${statusLabelText}${elapsedPart}`;

    let panelInnerElements: Record<string, unknown>[] = [];
    if (state === 'running') {
      const currentGroup = traceElements.find(el => el.tag === 'interactive_container') ?? traceElements.at(-1);
      const currentItems = currentGroup?.tag === 'interactive_container' && Array.isArray(currentGroup.elements)
        ? currentGroup.elements as Record<string, unknown>[] : [];
      const currentTools = currentItems.filter(el => String(el.element_id ?? '').startsWith('trace_tool_'));
      const currentStage = currentTools.length > 1 ? {
        ...currentGroup,
        elements: [
          ...currentItems.filter(el => !currentTools.includes(el)),
          {
            tag: 'collapsible_panel', element_id: 'current_records', expanded: false,
            direction: 'vertical', vertical_spacing: '4px', padding: '4px 0px 0px 0px', margin: '0px',
            header: {
              title: { tag: 'markdown', content: `执行记录（${currentTools.length} 条）`, text_size: 'notation' },
              vertical_align: 'center', icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', color: 'grey', size: '14px 14px' },
              icon_position: 'right', icon_expanded_angle: -180
            },
            elements: currentTools
          }
        ]
      } : currentGroup;
      const historyGroups = traceElements.filter(el => el !== currentGroup);
      const currentStageElements = currentStage
        ? (currentStage.tag === 'interactive_container' && Array.isArray(currentStage.elements)
          ? (currentStage.elements as Record<string, unknown>[])
          : [currentStage])
        : [];
      panelInnerElements = [
        ...currentStageElements,
        ...historyGroups,
        ...otherElements
      ];
    } else if (traceElements.length === 1) {
      const single = traceElements[0]!;
      // 终态只有一个阶段时摊平，避免总面板里再套一层阶段折叠。
      // 阶段标题（panel.header.title）作为普通一行保留，再接其 elements；
      // 退化成 markdown 的空阶段直接原样放入。
      const flattened = (single.tag === 'collapsible_panel' && Array.isArray(single.elements) && single.elements.length)
        ? [
            ...(single.header && (single.header as Record<string, unknown>).title ? [(single.header as Record<string, unknown>).title as Record<string, unknown>] : []),
            ...(single.elements as Record<string, unknown>[])
          ]
        : [single];
      panelInnerElements = [
        ...flattened,
        ...otherElements
      ];
    } else if (traceElements.length > 1) {
      panelInnerElements = [
        ...traceElements,
        ...otherElements
      ];
    } else {
      panelInnerElements = [...otherElements];
    }

    const hasActualDetails = traceElements.length > 0;

    const overviewElement: Record<string, unknown> = hasActualDetails ? {
      tag: 'collapsible_panel',
      element_id: 'task_overview',
      expanded: overviewExpanded,
      direction: 'vertical',
      vertical_spacing: '4px',
      padding: '4px 0px 0px 0px',
      margin: '0px',
      header: {
        title: {
          tag: 'plain_text',
          content: overviewTitleText
        },
        vertical_align: 'center',
        icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', color: 'grey', size: '14px 14px' },
        icon_position: 'right',
        icon_expanded_angle: -180
      },
      elements: panelInnerElements
    } : {
      tag: 'div',
      element_id: 'task_overview',
      margin: '0px',
      text: {
        tag: 'plain_text',
        content: overviewTitleText
      }
    };

    // 无边框按钮靠右收成一排，像正文末尾的工具栏：可点，但不和正文抢注意力。
    const processActionRow = actionButtons.length ? [{
      tag: 'column_set', element_id: 'task_action_row', flex_mode: 'none', horizontal_spacing: '4px', vertical_align: 'center', margin: '0px',
      columns: [
        { tag: 'column', width: 'weighted', weight: 1, vertical_align: 'center', elements: [] },
        ...actionButtonColumns
      ]
    }] : [];

    return [
      overviewElement,
      ...(hasActualDetails ? [] : otherElements),
      ...attentionElements,
      ...evidenceElements,
      ...omissionElements,
      ...processActionRow
    ];
  };
  const assemble = (mainElements: Array<Record<string, unknown>>) => {
    const waitingForApproval = state === 'running' && hasPendingApproval(mainElements);
    const summaryTitle = isProcessCard
      ? `执行过程 · ${taskName} · ${waitingForApproval && !explicitStatusLabel ? '等待审批' : liveTitle}`
      : isResultCard
        ? `执行结果 · ${taskName} · ${waitingForApproval && !explicitStatusLabel ? '等待审批' : liveTitle}`
        : `${taskName} · ${waitingForApproval && !explicitStatusLabel ? '等待审批' : liveTitle}`;
    const headerTitle = isResultCard ? `执行结果 · ${compactTaskName || 'Dutydeck'}` : (compactTaskName || 'Dutydeck');

    const baseCard = {
      schema: '2.0' as const,
      config: {
        update_multi: true,
        width_mode: 'default',
        streaming_mode: state === 'running',
        // 语义色：绿=好 / 蓝=进行中 / 橙=要注意。失败色和执行中色会当状态文字用
        // （`● 失败`、`● 执行中`），所以必须在白底上可读——原先的失败色是低饱和土黄，
        // 对比度约 2:1，当文字时几乎读不出来，也和 errorAlert 的红色形不成层级。
        // 成功色只当圆点用（成功不再渲染文字后缀），按图形元素的 3:1 要求取值。
        style: { color: {
          current_bg: { light_mode: 'rgba(240,245,253,1)', dark_mode: 'rgba(30,40,56,1)' },
          trace_success: { light_mode: 'rgba(46,161,33,1)', dark_mode: 'rgba(118,204,142,1)' },
          trace_failure: { light_mode: 'rgba(163,77,0,1)', dark_mode: 'rgba(255,178,102,1)' },
          trace_running: { light_mode: 'rgba(36,91,219,1)', dark_mode: 'rgba(124,202,242,1)' }
        } },
        summary: { content: summaryTitle }
      },
      body: {
        direction: 'vertical' as const, vertical_spacing: '8px' as const, padding: '10px 12px 10px 12px' as const,
        elements: [
          ...arrange(mainElements.map(element => {
            if (!recordHint || !/(?:omission|rejected_delta)$/.test(String(element.element_id ?? '')) || typeof element.content !== 'string' || element.content.includes(recordHint)) return element;
            return { ...element, content: `${element.content}\n${recordHint}` };
          })),
          ...(footerColumns.length ? [{
            tag: 'column_set', flex_mode: 'none', horizontal_spacing: '8px', margin: '6px 0px 0px 0px',
            columns: footerColumns
          }] : [])
        ]
      }
    };
    return {
      ...baseCard,
      header: {
        title: { tag: 'plain_text', content: headerTitle },
        // 副标题只承载「谁在跑这个任务」。执行宿主（Claude Code / Codex / …）会改变
        // 读者怎么理解结果、去哪排查，是这一行唯一有信息量的东西；
        // 「· Agent 任务」每张卡都一样，只会把它冲淡。页脚不再重复第二遍。
        subtitle: { tag: 'plain_text', content: agentName },
        template: waitingForApproval ? 'orange' : presentation.template,
        padding: '10px 12px 8px 12px'
      }
    };
  };
  const withinLimits = (card: unknown) => cardBytes(card) <= larkCardSafeLimits.bytes && cardComponents(card) <= larkCardSafeLimits.components;
  const omissionNotice = (count: number) => ({
    tag: 'markdown', element_id: 'dutydeck_omission',
    content: `<font color='grey'>内容较长，已省略 ${count} 个较早执行分组。</font>`,
    text_size: 'x-small', margin: '4px 0px'
  });
  const upsertOmissionNotice = (elements: Array<Record<string, unknown>>, count: number) => {
    if (count <= 0) return;
    const notice = omissionNotice(count);
    const index = elements.findIndex(element => element.element_id === 'dutydeck_omission');
    if (index >= 0) elements[index] = notice;
    else {
      const firstGroup = elements.findIndex(element => typeof element.element_id === 'string' && element.element_id.startsWith('trace_group_'));
      elements.splice(firstGroup < 0 ? elements.length : firstGroup, 0, notice);
    }
  };
  let mainElements = [...sourceMainElements];
  let omittedGroups = 0;
  let card = assemble(mainElements);
  while (!withinLimits(card)) {
    const groupIndex = mainElements.findIndex(element => typeof element.element_id === 'string' && element.element_id.startsWith('trace_group_'));
    if (groupIndex < 0) break;
    const group = mainElements[groupIndex] as Record<string, unknown>;
    const groupElements = Array.isArray(group.elements) ? group.elements as Array<Record<string, unknown>> : [];
    const remainingGroups = mainElements.filter(element => typeof element.element_id === 'string' && element.element_id.startsWith('trace_group_')).length;
    // 优先从最旧分组中剥离工具输入输出，保留可扫描的分组结构；
    // 仅当分组已无内容可剥离时，才删除整个分组。
    if (stripFirstToolSection(group)) {
      card = assemble(mainElements);
      continue;
    }
    // 只剩一个 trace 分组时，优先从分组内部移除最旧的子元素，保留最近的活动。
    if (remainingGroups === 1 && groupElements.length > 1) {
      const hasTitle = (groupElements[0] as Record<string, unknown>)?.element_id === 'current_title';
      if (hasTitle && groupElements.length > 2) {
        group.elements = [groupElements[0], ...groupElements.slice(2)];
      } else {
        group.elements = groupElements.slice(1);
      }
    } else {
      mainElements.splice(groupIndex, 1);
      omittedGroups++;
      upsertOmissionNotice(mainElements, omittedGroups);
    }
    card = assemble(mainElements);
  }
  if (withinLimits(card)) return card;
  const fallbackText = String((sourceMainElements.find(element => element.element_id === 'final_output') as Record<string, unknown> | undefined)?.content
    ?? (sourceMainElements.find(element => element.tag === 'markdown') as Record<string, unknown> | undefined)?.content
    ?? content ?? '内容过长');
  const fallbackCard = assemble([
    { tag: 'markdown', content: fallbackText.length > 4_000 ? `${fallbackText.slice(0, 3_999)}…` : fallbackText, text_align: 'left', text_size: 'normal_v2', margin: '0px' },
    { tag: 'markdown', element_id: 'dutydeck_fallback_omission', content: "<font color='grey'>卡片内容超过飞书限制，过程记录已收起。</font>", text_size: 'x-small', margin: '8px 0px 0px 0px' }
  ]);
  if (withinLimits(fallbackCard)) return fallbackCard;
  // All caller-controlled fields have already been bounded. This last constant-size shape is the
  // hard safety net for unexpected Card schema overhead or deeply nested third-party elements.
  const waitingForApproval = state === 'running' && hasPendingApproval(sourceMainElements);
  const hardFallbackSummaryPrefix = isProcessCard ? '执行过程 · ' : isResultCard ? '执行结果 · ' : '';
  const hardFallbackSummary = `${hardFallbackSummaryPrefix}${taskName} · ${liveTitle}`;
  if (isProcessCard) {
    const elapsedPart = elapsedSeconds > 0 ? ` · ${state === 'queued' ? '排队等待' : '用时'} ${elapsedLabel(elapsedSeconds)}` : '';
    const overviewTitleText = `执行记录 · ${liveTitle}${elapsedPart}`;
    return {
      schema: '2.0',
      header: {
        title: { tag: 'plain_text', content: compactTaskName || 'Dutydeck' },
        subtitle: { tag: 'plain_text', content: agentName },
        template: waitingForApproval ? 'orange' : presentation.template,
        padding: '10px 12px 8px 12px'
      },
      config: { update_multi: true, width_mode: 'default', streaming_mode: false, summary: { content: hardFallbackSummary } },
      body: {
        direction: 'vertical', padding: '10px 12px',
        elements: [
          {
            tag: 'div',
            element_id: 'task_overview',
            margin: '0px',
            text: { tag: 'plain_text', content: overviewTitleText }
          },
          {
            tag: 'markdown',
            element_id: 'dutydeck_hard_fallback_omission',
            content: `卡片内容超过飞书安全预算，详细内容已收起。${hardFallbackHint}`,
            text_size: 'normal'
          }
        ]
      }
    };
  }
  const hardFallbackHeaderTitle = isResultCard
    ? `执行结果 · ${compactTaskName || 'Dutydeck'}`
    : compactTaskName;
  return {
    schema: '2.0',
    header: { title: { tag: 'plain_text', content: hardFallbackHeaderTitle }, subtitle: { tag: 'plain_text', content: agentName }, template: presentation.template },
    config: { update_multi: true, width_mode: 'default', streaming_mode: false, summary: { content: hardFallbackSummary } },
    body: {
      direction: 'vertical', padding: '10px 12px',
      elements: [
        { tag: 'markdown', content: `<text_tag color='${presentation.color}'>${liveTitle}</text_tag>${elapsedSeconds > 0 ? `　<font color='grey'>已用时 ${elapsedLabel(elapsedSeconds)}</font>` : ''}`, text_size: 'small' },
        { tag: 'markdown', element_id: 'dutydeck_hard_fallback_omission', content: `卡片内容超过飞书安全预算，详细内容已收起。${hardFallbackHint}`, text_size: 'normal' }
      ]
    }
  };
}

export class LarkServiceError extends Error {
  constructor(public readonly code: string, message: string, public readonly statusCode = 400, public readonly details?: Record<string, unknown>) {
    super(message); this.name = 'LarkServiceError';
  }
}

export const larkIdentityPermissionHelp = (error?: unknown, appId?: string) => {
  const detail = error instanceof Error ? `\n\n飞书返回：${error.message}` : '';
  const consoleUrl = error instanceof LarkServiceError && typeof error.details?.consoleUrl === 'string'
    ? `\n\n[前往飞书开放平台处理权限](${error.details.consoleUrl})`
    : '';
  const permissionUrl = appId ? `\n\n[打开当前机器人的权限配置](https://open.larkoffice.com/app/${encodeURIComponent(appId)}/auth)` : '';
  return `**无法解析发送人身份，Agent 已停止本轮执行。**${detail}\n\n请为机器人开通以下资源点：\n- API：\`GET /open-apis/contact/v3/users/:open_id\`\n- 权限：\`contact:contact.base:readonly\`（通讯录基本信息）\n- 权限：\`contact:user.base:readonly\`（用户基本信息）\n- 权限：\`contact:user.email:readonly\`（用户邮箱信息）\n- 数据权限：应用通讯录可见范围必须包含当前发送人${consoleUrl}${permissionUrl}`;
};

type Fetch = typeof globalThis.fetch;

export class LarkCardService {
  private token?: string;
  private tokenExpiresAt = 0;
  private loadingImageKey?: string;
  private loadingImagePromise?: Promise<string | undefined>;

  constructor(private readonly config: LarkBotConfig, private readonly fetcher: Fetch = globalThis.fetch) {}

  private async cardInput<T extends LarkCardInput>(input: T): Promise<T> {
    if ((input.state ?? 'running') !== 'running') return input;
    const loadingImageKey = await this.ensureLoadingImageKey();
    return loadingImageKey ? { ...input, loadingImageKey } : input;
  }

  private ensureLoadingImageKey() {
    if (this.loadingImageKey) return Promise.resolve(this.loadingImageKey);
    if (this.loadingImagePromise) return this.loadingImagePromise;
    this.loadingImagePromise = (async () => {
      try {
        const form = new FormData();
        form.append('image_type', 'message');
        form.append('image', new Blob([await readFile(new URL('./assets/dutydeck-bouncing-ball.webp', import.meta.url))], { type: 'image/webp' }), 'dutydeck-bouncing-ball.webp');
        const response = await this.fetcher(`${this.config.baseUrl}/open-apis/im/v1/images`, {
          method: 'POST', headers: { authorization: `Bearer ${await this.tenantToken()}` }, body: form
        });
        const payload: any = await response.json();
        if (!response.ok || Number(payload.code ?? 0) !== 0 || !payload.data?.image_key) return undefined;
        this.loadingImageKey = String(payload.data.image_key);
        return this.loadingImageKey;
      } catch { return undefined; }
    })();
    return this.loadingImagePromise;
  }

  async send(input: LarkSendInput): Promise<LarkMessageResult> {
    if (input.chatId && input.receiveId) throw new LarkServiceError('CONFLICTING_RECIPIENTS', 'chatId and receiveId cannot be used together', 400);
    const chatId = input.chatId?.trim();
    if (chatId && !chatId.startsWith('oc_')) throw new LarkServiceError('INVALID_CHAT_ID', 'chatId must start with oc_', 400);
    const receiveId = required(chatId ?? input.receiveId ?? this.config.defaultReceiveId, 'chatId, receiveId, LARK_CHAT_ID, or LARK_RECEIVE_ID');
    const resolvedReceiveIdType = receiveIdType(chatId ? 'chat_id' : input.receiveIdType ?? this.config.defaultReceiveIdType);
    const cardInput = await this.cardInput(input);
    const payload = await this.request(`/open-apis/im/v1/messages?receive_id_type=${encodeURIComponent(resolvedReceiveIdType)}`, {
      body: {
        receive_id: receiveId,
        msg_type: 'interactive',
        content: JSON.stringify(buildLarkCard({ ...cardInput, agentName: input.agentName ?? this.config.defaultAgentName })),
        ...(input.idempotencyKey?.trim() ? { uuid: input.idempotencyKey.trim() } : {})
      }
    });
    const messageId = payload.data?.message_id;
    if (!messageId) throw new LarkServiceError('INVALID_LARK_RESPONSE', 'Lark send response did not include message_id', 502);
    return { messageId, chatId: payload.data?.chat_id };
  }

  async reply(input: LarkReplyInput): Promise<LarkMessageResult> {
    const messageId = required(input.messageId, 'messageId');
    const cardInput = await this.cardInput(input);
    // messageId 必须是 om_* 消息 ID；话题回复通过 reply_in_thread 显式声明，不能把 omt_* thread_id 当成 messageId。
    // 话题根锚点：飞书 im.v1.message.reply 只接受 path 的 message_id + reply_in_thread 布尔，没有独立的
    // root 锚点参数——话题锚定由 path 的 message_id 决定。replyInThread=true 且带 replyRootId（话题根
    // 消息 om_*）时，用 replyRootId 作为 path 锚点，让卡片落在话题根下；否则回落到触发消息 messageId。
    const threadAnchor = input.replyInThread && input.replyRootId?.trim() ? input.replyRootId.trim() : messageId;
    const payload = await this.request(`/open-apis/im/v1/messages/${encodeURIComponent(threadAnchor)}/reply`, {
      body: {
        msg_type: 'interactive',
        content: JSON.stringify(buildLarkCard({ ...cardInput, agentName: input.agentName ?? this.config.defaultAgentName })),
        ...(input.replyInThread ? { reply_in_thread: true } : {}),
        ...(input.idempotencyKey?.trim() ? { uuid: input.idempotencyKey.trim() } : {})
      }
    });
    const replyId = payload.data?.message_id;
    if (!replyId) throw new LarkServiceError('INVALID_LARK_RESPONSE', 'Lark reply response did not include message_id', 502);
    return { messageId: replyId, chatId: payload.data?.chat_id };
  }

  async update(input: LarkUpdateInput): Promise<LarkMessageResult> {
    const messageId = required(input.messageId, 'messageId');
    const cardInput = await this.cardInput(input);
    const payload = await this.request(`/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`, {
      method: 'PATCH', body: { content: JSON.stringify(buildLarkCard({ ...cardInput, taskId: input.taskId ?? messageId, agentName: input.agentName ?? this.config.defaultAgentName })) }
    });
    return { messageId: payload.data?.message_id || messageId, chatId: payload.data?.chat_id };
  }

  async listChats(pageToken?: string): Promise<LarkChatsResult> {
    const query = new URLSearchParams({ user_id_type: 'open_id', page_size: '100', sort_type: 'ByActiveTimeDesc' });
    if (pageToken) query.set('page_token', pageToken);
    const payload = await this.request(`/open-apis/im/v1/chats?${query}`, { method: 'GET' });
    const items = (Array.isArray(payload.data?.items) ? payload.data.items : []).flatMap((item: any): LarkChat[] => {
      const chatId = String(item.chat_id ?? '').trim();
      if (!chatId.startsWith('oc_')) return [];
      const description = String(item.description ?? '').trim() || undefined;
      const ownerId = String(item.owner_id ?? '').trim() || undefined;
      const chatMode = String(item.chat_mode ?? '').trim() || undefined;
      const chatStatus = String(item.chat_status ?? '').trim() || undefined;
      return [{
        chatId,
        name: String(item.name ?? '').trim() || chatId,
        ...(description ? { description } : {}),
        ...(ownerId ? { ownerId } : {}),
        external: item.external === true,
        ...(chatMode ? { chatMode } : {}),
        ...(chatStatus ? { chatStatus } : {})
      }];
    });
    const nextPageToken = String(payload.data?.page_token ?? '').trim() || undefined;
    return { items, hasMore: payload.data?.has_more === true, ...(nextPageToken ? { pageToken: nextPageToken } : {}) };
  }

  async listChatMembers(input: LarkChatMembersInput): Promise<LarkChatMembersResult> {
    const chatId = required(input.chatId, 'chatId');
    if (!chatId.startsWith('oc_')) throw new LarkServiceError('INVALID_CHAT_ID', 'chatId must start with oc_', 400);
    const pageSize = Math.min(100, Math.max(1, Math.floor(input.pageSize ?? 100)));
    const memberTypes: LarkChatMemberType[] = input.memberTypes?.length ? [...new Set(input.memberTypes)] : ['user', 'bot'];
    if (memberTypes.some(type => type !== 'user' && type !== 'bot')) throw new LarkServiceError('INVALID_MEMBER_TYPE', 'memberTypes must contain only user or bot', 400);
    const query = new URLSearchParams({ member_id_type: 'open_id', member_types: memberTypes.join(','), page_size: String(pageSize) });
    if (input.pageToken) query.set('page_token', input.pageToken);
    const payload = await this.request(`/open-apis/im/v1/chats/${encodeURIComponent(chatId)}/members/list?${query}`, { method: 'GET' });
    const users = Array.isArray(payload.data?.users) ? payload.data.users.map((item: any) => ({ ...item, member_type: 'user' })) : [];
    const bots = Array.isArray(payload.data?.bots) ? payload.data.bots.map((item: any) => ({ ...item, member_type: 'bot' })) : [];
    const rawItems = users.length || bots.length ? [...users, ...bots] : Array.isArray(payload.data?.items) ? payload.data.items : [];
    const fallbackType = memberTypes.length === 1 ? memberTypes[0] : undefined;
    const items = rawItems.flatMap((item: any): LarkChatMember[] => {
      const memberId = String(item.member_id ?? item.open_id ?? '').trim();
      if (!memberId) return [];
      const memberType = String(item.member_type ?? fallbackType ?? (item.app_id ? 'bot' : 'user')) as LarkChatMemberType;
      if (memberType !== 'user' && memberType !== 'bot') return [];
      const openId = String(item.open_id ?? (memberId.startsWith('ou_') ? memberId : '')).trim() || undefined;
      const appId = String(item.app_id ?? '').trim() || undefined;
      const memberIdType = String(item.member_id_type ?? '').trim() || undefined;
      const tenantKey = String(item.tenant_key ?? '').trim() || undefined;
      return [{ memberId, memberType, name: String(item.name ?? appId ?? memberId), ...(memberIdType ? { memberIdType } : {}), ...(tenantKey ? { tenantKey } : {}), ...(appId ? { appId } : {}), ...(openId ? { openId } : {}) }];
    });
    const pageToken = String(payload.data?.page_token ?? '').trim() || undefined;
    const directTotal = Number(payload.data?.member_total);
    const userTotal = Number(payload.data?.user_total);
    const botTotal = Number(payload.data?.bot_total);
    const bucketTotals = [userTotal, botTotal].filter(Number.isFinite);
    const memberTotal = Number.isFinite(directTotal) ? directTotal : bucketTotals.length ? bucketTotals.reduce((sum, total) => sum + total, 0) : undefined;
    const truncations = Array.isArray(payload.data?.truncations) ? payload.data.truncations : [];
    const securityLimit = Number(payload.data?.security_conf_limit ?? truncations.map((item: any) => Number(item?.limit)).filter(Number.isFinite).sort((left: number, right: number) => right - left)[0]);
    return {
      items,
      hasMore: payload.data?.has_more === true,
      ...(pageToken ? { pageToken } : {}),
      ...(Number.isFinite(memberTotal) ? { memberTotal } : {}),
      ...(Number.isFinite(securityLimit) ? { securityLimit } : {}),
      securityLimited: payload.data?.trigger_security_conf_limit === true || truncations.length > 0
    };
  }

  async resolveChatUsersByNames(inputNames: string[], memberTypes: LarkChatMemberType[] = ['user']): Promise<LarkResolvedUser[]> {
    const names = [...new Map(inputNames.map(value => String(value).trim()).filter(Boolean).map(name => [name.normalize('NFKC').toLocaleLowerCase(), name])).values()];
    if (names.length > 50) throw new LarkServiceError('LARK_TOO_MANY_USER_NAMES', '一次最多解析 50 个成员姓名', 400);
    if (!names.length) return [];
    const requested = new Map(names.map(name => [name.normalize('NFKC').toLocaleLowerCase(), name]));
    const matches = new Map([...requested.keys()].map(key => [key, new Map<string, LarkResolvedUser>()]));
    let chatPageToken: string | undefined;
    let chatPages = 0;
    let memberPageRequests = 0;
    do {
      if (++chatPages > 10) throw new LarkServiceError('LARK_NAME_RESOLUTION_LIMIT', '机器人所在群过多，无法安全完成姓名解析', 409);
      const chats = await this.listChats(chatPageToken);
      for (const chat of chats.items) {
        let memberPageToken: string | undefined;
        do {
          if (++memberPageRequests > 500) throw new LarkServiceError('LARK_NAME_RESOLUTION_LIMIT', '群成员数据过多，无法安全完成姓名解析', 409);
          const members = await this.listChatMembers({ chatId: chat.chatId, memberTypes, pageSize: 100, ...(memberPageToken ? { pageToken: memberPageToken } : {}) });
          if (members.securityLimited) throw new LarkServiceError('LARK_MEMBER_LIST_TRUNCATED', `群“${chat.name}”的成员列表被飞书安全策略截断，无法可靠解析姓名`, 409);
          for (const member of members.items) {
            const key = member.name.trim().normalize('NFKC').toLocaleLowerCase();
            const openId = member.openId ?? (member.memberId.startsWith('ou_') ? member.memberId : undefined);
            if (openId && matches.has(key)) matches.get(key)!.set(openId, { openId, name: member.name.trim() || requested.get(key)! });
          }
          if (members.hasMore && !members.pageToken) throw new LarkServiceError('LARK_PAGINATION_ERROR', '飞书返回了不完整的群成员分页信息', 502);
          memberPageToken = members.hasMore ? members.pageToken : undefined;
        } while (memberPageToken);
      }
      if (chats.hasMore && !chats.pageToken) throw new LarkServiceError('LARK_PAGINATION_ERROR', '飞书返回了不完整的群聊分页信息', 502);
      chatPageToken = chats.hasMore ? chats.pageToken : undefined;
    } while (chatPageToken);
    const missing = [...requested].filter(([key]) => !matches.get(key)?.size).map(([, name]) => name);
    if (missing.length) throw new LarkServiceError('LARK_USER_NAME_NOT_FOUND', `机器人所在群中找不到成员：${missing.join('、')}`, 409);
    const ambiguous = [...requested].filter(([key]) => (matches.get(key)?.size ?? 0) > 1).map(([, name]) => name);
    if (ambiguous.length) throw new LarkServiceError('LARK_USER_NAME_AMBIGUOUS', `以下姓名对应多个不同成员，无法安全选择：${ambiguous.join('、')}`, 409);
    return [...requested.keys()].map(key => [...matches.get(key)!.values()][0]!);
  }

  private normalizeMessageItem(item: any): LarkChatMessage | undefined {
    const messageId = String(item?.message_id ?? '').trim();
    if (!messageId) return undefined;
    const sender = item?.sender && typeof item.sender === 'object' ? item.sender : {};
    const normalizedSender: LarkChatMessageSender = {
      ...(sender.id ? { id: String(sender.id) } : {}),
      ...(sender.id_type ? { idType: String(sender.id_type) } : {}),
      ...(sender.sender_type ? { type: String(sender.sender_type) } : {}),
      ...(sender.tenant_key ? { tenantKey: String(sender.tenant_key) } : {}),
      ...(sender.name ? { name: String(sender.name) } : {})
    };
    const mentions = (Array.isArray(item?.mentions) ? item.mentions : []).map((mention: any): LarkChatMessageMention => ({
      ...(mention.id ? { id: String(mention.id) } : {}),
      ...(mention.id_type ? { idType: String(mention.id_type) } : {}),
      ...(mention.key ? { key: String(mention.key) } : {}),
      ...(mention.name ? { name: String(mention.name) } : {}),
      ...(mention.tenant_key ? { tenantKey: String(mention.tenant_key) } : {})
    }));
    const updateTime = String(item?.update_time ?? '').trim() || undefined;
    const threadId = String(item?.thread_id ?? '').trim() || undefined;
    // root_id/parent_id 是消息详情的独立字段：root 锚话题根，parent 锚直接被回复消息，
    // 不能用 upper_message_id（仅合并转发场景）顶替。
    const rootId = String(item?.root_id ?? '').trim() || undefined;
    const parentId = String(item?.parent_id ?? '').trim() || undefined;
    const itemChatId = String(item?.chat_id ?? '').trim() || undefined;
    const upperMessageId = String(item?.upper_message_id ?? '').trim() || undefined;
    return {
      messageId, messageType: String(item?.msg_type ?? 'unknown'), createTime: String(item?.create_time ?? '0'),
      sender: normalizedSender, rawContent: String(item?.body?.content ?? item?.content ?? ''), mentions,
      deleted: item?.deleted === true, updated: item?.updated === true,
      ...(itemChatId ? { chatId: itemChatId } : {}), ...(updateTime ? { updateTime } : {}), ...(threadId ? { threadId } : {}),
      ...(rootId ? { rootId } : {}), ...(parentId ? { parentId } : {}),
      ...(upperMessageId ? { upperMessageId } : {})
    };
  }

  async listChatMessages(input: LarkChatMessagesInput): Promise<LarkChatMessagesResult> {
    const threadId = input.threadId?.trim();
    const chatId = input.chatId?.trim();
    // 话题消息优先按 thread 拉取，确保上下文限定在当前话题内；否则按群拉取。
    const containerIdType = threadId ? 'thread' : 'chat';
    const containerId = threadId ?? chatId;
    if (!containerId) throw new LarkServiceError('INVALID_CONTAINER_ID', 'chatId or threadId is required', 400);
    if (containerIdType === 'chat' && !containerId.startsWith('oc_')) throw new LarkServiceError('INVALID_CHAT_ID', 'chatId must start with oc_', 400);
    if (containerIdType === 'thread' && !containerId.startsWith('omt_')) throw new LarkServiceError('INVALID_THREAD_ID', 'threadId must start with omt_', 400);
    const pageSize = Math.min(50, Math.max(1, Math.floor(input.pageSize ?? 50)));
    const query = new URLSearchParams({
      container_id_type: containerIdType, container_id: containerId, page_size: String(pageSize),
      sort_type: input.order === 'asc' ? 'ByCreateTimeAsc' : 'ByCreateTimeDesc',
      // 群协作需要看到话题内的连续回复；只取 root 会让后续轮次从 messages/wait 中永久消失。
      only_thread_root_messages: 'false', with_sender_name: 'true', card_msg_content_type: 'raw_card_content'
    });
    if (input.pageToken) query.set('page_token', input.pageToken);
    if (Number.isFinite(input.startTime)) query.set('start_time', String(Math.max(0, Math.floor(input.startTime!))));
    if (Number.isFinite(input.endTime)) query.set('end_time', String(Math.max(0, Math.floor(input.endTime!))));
    const payload = await this.request(`/open-apis/im/v1/messages?${query}`, { method: 'GET' });
    const rawItems = Array.isArray(payload.data?.items) ? payload.data.items : [];
    const items = rawItems.map((item: any) => this.normalizeMessageItem(item)).filter((item: LarkChatMessage | undefined): item is LarkChatMessage => Boolean(item));
    const pageToken = String(payload.data?.page_token ?? '').trim() || undefined;
    return { items, hasMore: payload.data?.has_more === true, ...(pageToken ? { pageToken } : {}) };
  }

  async getMessage(messageId: string): Promise<LarkChatMessage> {
    const resolvedMessageId = required(messageId, 'messageId');
    const items = await this.getMessageItems(resolvedMessageId);
    const first = items[0];
    if (!first) throw new LarkServiceError('LARK_MESSAGE_NOT_FOUND', `Message ${resolvedMessageId} not found`, 404);
    return first;
  }

  /**
   * 获取指定消息的全部 items。
   * 对于普通消息，items 仅包含该消息本身；
   * 对于合并转发（merge_forward）消息，items[0] 为合并转发消息本身，其余为被转发的子消息。
   */
  async getMessageItems(messageId: string): Promise<LarkChatMessage[]> {
    const resolvedMessageId = required(messageId, 'messageId');
    const payload = await this.request(`/open-apis/im/v1/messages/${encodeURIComponent(resolvedMessageId)}?user_id_type=open_id&card_msg_content_type=raw_card_content`, { method: 'GET' });
    const rawItems = Array.isArray(payload.data?.items) ? payload.data.items : (payload.data?.message ? [payload.data.message] : []);
    return rawItems.map((item: any) => this.normalizeMessageItem(item)).filter((item: LarkChatMessage | undefined): item is LarkChatMessage => Boolean(item));
  }

  async sendText(input: LarkSendTextInput): Promise<LarkMessageResult> {
    const chatId = required(input.chatId, 'chatId');
    if (!chatId.startsWith('oc_')) throw new LarkServiceError('INVALID_CHAT_ID', 'chatId must start with oc_', 400);
    const payload = await this.request('/open-apis/im/v1/messages?receive_id_type=chat_id', {
      body: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text: required(input.text, 'text') }), ...(input.idempotencyKey ? { uuid: input.idempotencyKey } : {}) }
    });
    const messageId = payload.data?.message_id;
    if (!messageId) throw new LarkServiceError('INVALID_LARK_RESPONSE', 'Lark send response did not include message_id', 502);
    return { messageId, chatId: payload.data?.chat_id ?? chatId };
  }

  async replyText(input: LarkReplyTextInput): Promise<LarkMessageResult> {
    const messageId = required(input.messageId, 'messageId');
    const payload = await this.request(`/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`, {
      body: {
        msg_type: 'text', content: JSON.stringify({ text: required(input.text, 'text') }),
        ...(input.replyInThread ? { reply_in_thread: true } : {}),
        ...(input.idempotencyKey ? { uuid: input.idempotencyKey } : {})
      }
    });
    const replyId = payload.data?.message_id;
    if (!replyId) throw new LarkServiceError('INVALID_LARK_RESPONSE', 'Lark reply response did not include message_id', 502);
    return { messageId: replyId, chatId: payload.data?.chat_id };
  }

  async uploadFile(input: LarkUploadInput): Promise<string> { return this.uploadMedia('/open-apis/im/v1/files', 'file', 'file_type', 'stream', input, 'file_key'); }
  async uploadImage(input: LarkUploadInput): Promise<string> { return this.uploadMedia('/open-apis/im/v1/images', 'image', 'image_type', 'message', input, 'image_key'); }

  async sendFile(input: LarkMediaSendInput): Promise<LarkMessageResult> { return this.sendMedia(input.chatId, 'file', { file_key: required(input.fileKey, 'fileKey') }, input.idempotencyKey); }
  async sendImage(input: LarkMediaSendInput): Promise<LarkMessageResult> { return this.sendMedia(input.chatId, 'image', { image_key: required(input.imageKey, 'imageKey') }, input.idempotencyKey); }
  async replyFile(input: LarkMediaReplyInput): Promise<LarkMessageResult> { return this.replyMedia(input, 'file', { file_key: required(input.fileKey, 'fileKey') }); }
  async replyImage(input: LarkMediaReplyInput): Promise<LarkMessageResult> { return this.replyMedia(input, 'image', { image_key: required(input.imageKey, 'imageKey') }); }

  private async uploadMedia(path: string, field: string, typeField: string, type: string, input: LarkUploadInput, responseKey: string) {
    const form = new FormData(); form.append(typeField, type); form.append(field, new Blob([input.data]), required(input.filename, 'filename'));
    const payload = await this.requestForm(path, form);
    const key = payload.data?.[responseKey];
    if (!key) throw new LarkServiceError('INVALID_LARK_RESPONSE', `Lark upload response did not include ${responseKey}`, 502);
    return String(key);
  }
  private async sendMedia(chatId: string, msgType: 'file' | 'image', content: Record<string, string>, idempotencyKey: string) {
    const payload = await this.request('/open-apis/im/v1/messages?receive_id_type=chat_id', { body: { receive_id: required(chatId, 'chatId'), msg_type: msgType, content: JSON.stringify(content), uuid: idempotencyKey } });
    if (!payload.data?.message_id) throw new LarkServiceError('INVALID_LARK_RESPONSE', 'Lark send response did not include message_id', 502);
    return { messageId: String(payload.data.message_id), chatId: payload.data?.chat_id };
  }
  private async replyMedia(input: LarkMediaReplyInput, msgType: 'file' | 'image', content: Record<string, string>) {
    const payload = await this.request(`/open-apis/im/v1/messages/${encodeURIComponent(required(input.messageId, 'messageId'))}/reply`, { body: { msg_type: msgType, content: JSON.stringify(content), ...(input.replyInThread ? { reply_in_thread: true } : {}), uuid: input.idempotencyKey } });
    if (!payload.data?.message_id) throw new LarkServiceError('INVALID_LARK_RESPONSE', 'Lark reply response did not include message_id', 502);
    return { messageId: String(payload.data.message_id), chatId: payload.data?.chat_id };
  }

  async addReaction(messageId: string, emojiType: string): Promise<LarkReactionResult> {
    const resolvedMessageId = required(messageId, 'messageId');
    const resolvedEmojiType = required(emojiType, 'emojiType');
    const payload = await this.request(`/open-apis/im/v1/messages/${encodeURIComponent(resolvedMessageId)}/reactions`, {
      body: { reaction_type: { emoji_type: resolvedEmojiType } }
    });
    const reactionId = payload.data?.reaction_id;
    if (!reactionId) throw new LarkServiceError('INVALID_LARK_RESPONSE', 'Lark reaction response did not include reaction_id', 502);
    return { messageId: resolvedMessageId, reactionId, emojiType: resolvedEmojiType };
  }

  async deleteReaction(messageId: string, reactionId: string): Promise<void> {
    await this.request(`/open-apis/im/v1/messages/${encodeURIComponent(required(messageId, 'messageId'))}/reactions/${encodeURIComponent(required(reactionId, 'reactionId'))}`, {
      method: 'DELETE'
    });
  }

  async listOwnReactions(messageId: string, emojiType: string): Promise<LarkReactionResult[]> {
    const resolvedMessageId = required(messageId, 'messageId');
    const resolvedEmojiType = required(emojiType, 'emojiType');
    const query = new URLSearchParams({ reaction_type: resolvedEmojiType, user_id_type: 'open_id', page_size: '50' });
    const seen = new Set<string>();
    const reactions: LarkReactionResult[] = [];
    while (true) {
      const payload = await this.request(`/open-apis/im/v1/messages/${encodeURIComponent(resolvedMessageId)}/reactions?${query}`, { method: 'GET' });
      const data = payload.data;
      if (!Array.isArray(data?.items) || typeof data.has_more !== 'boolean') {
        throw new LarkServiceError('INVALID_LARK_RESPONSE', 'Lark reaction list response did not include items or has_more', 502);
      }
      for (const item of data.items) {
        if (typeof item?.reaction_id !== 'string' || !item.reaction_id.trim()
          || typeof item.operator?.operator_id !== 'string' || !item.operator.operator_id.trim()
          || typeof item.operator?.operator_type !== 'string' || typeof item.reaction_type?.emoji_type !== 'string') {
          throw new LarkServiceError('INVALID_LARK_RESPONSE', 'Lark reaction record is incomplete', 502);
        }
        if (item.operator.operator_type === 'app' && item.operator.operator_id === this.config.appId && item.reaction_type.emoji_type === resolvedEmojiType) {
          reactions.push({ messageId: resolvedMessageId, reactionId: item.reaction_id, emojiType: resolvedEmojiType });
        }
      }
      if (!data.has_more) return reactions;
      const next = typeof data.page_token === 'string' ? data.page_token.trim() : '';
      if (!next || seen.has(next)) throw new LarkServiceError('INVALID_LARK_RESPONSE', 'Lark reaction pagination is incomplete', 502);
      seen.add(next);
      query.set('page_token', next);
    }
  }

  async urgentApp(input: LarkUrgentAppInput): Promise<LarkUrgentResult> {
    const messageId = required(input?.messageId, 'messageId');
    const userIdList = (Array.isArray(input?.userIdList) ? input.userIdList : [])
      .map(id => String(id ?? '').trim())
      .filter(Boolean);
    if (!userIdList.length) {
      throw new LarkServiceError('INVALID_URGENT_INPUT', 'userIdList must contain at least one user ID', 400);
    }
    const userIdType = input.userIdType ?? 'open_id';
    const payload = await this.request(
      `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/urgent_app?user_id_type=${encodeURIComponent(userIdType)}`,
      {
        method: 'POST',
        body: { user_id_list: userIdList }
      }
    );
    const invalidList = Array.isArray(payload.data?.invalid_user_id_list)
      ? payload.data.invalid_user_id_list.map((id: unknown) => String(id))
      : [];
    return { invalidUserIdList: invalidList };
  }

  async safeUrgentApp(input: LarkUrgentAppInput, log?: { warn?: (details: unknown, msg?: string) => void }): Promise<LarkUrgentResult | undefined> {
    try {
      return await this.urgentApp(input);
    } catch (error) {
      log?.warn?.({ error, messageId: input?.messageId, userIdList: input?.userIdList }, '飞书应用内加急失败，不影响主任务');
      return undefined;
    }
  }

  async pin(messageId: string): Promise<LarkPinResult> {
    const resolvedMessageId = required(messageId, 'messageId');
    const payload = await this.request('/open-apis/im/v1/pins', {
      method: 'POST',
      body: { message_id: resolvedMessageId }
    });
    return {
      messageId: resolvedMessageId,
      chatId: payload.data?.pin?.chat_id ? String(payload.data.pin.chat_id) : undefined
    };
  }

  async safePin(messageId: string, log?: { warn?: (details: unknown, msg?: string) => void }): Promise<LarkPinResult | undefined> {
    try {
      return await this.pin(messageId);
    } catch (error) {
      log?.warn?.({ error, messageId }, '飞书卡片置顶失败，不影响主任务');
      return undefined;
    }
  }

  async unpin(messageId: string): Promise<void> {
    const resolvedMessageId = required(messageId, 'messageId');
    await this.request(`/open-apis/im/v1/pins/${encodeURIComponent(resolvedMessageId)}`, {
      method: 'DELETE'
    });
  }

  async safeUnpin(messageId: string, log?: { warn?: (details: unknown, msg?: string) => void }): Promise<boolean> {
    try {
      await this.unpin(messageId);
      return true;
    } catch (error) {
      log?.warn?.({ error, messageId }, '飞书取消卡片置顶失败，不影响主任务');
      return false;
    }
  }

  async listPins(chatId: string, pageToken?: string): Promise<LarkPinsResult> {
    const resolvedChatId = required(chatId, 'chatId');
    const query = new URLSearchParams({ chat_id: resolvedChatId });
    if (pageToken) query.set('page_token', pageToken);
    const payload = await this.request(`/open-apis/im/v1/pins?${query}`, { method: 'GET' });
    const items = (Array.isArray(payload.data?.items) ? payload.data.items : []).map((item: any) => ({
      messageId: String(item.message_id ?? ''),
      chatId: item.chat_id ? String(item.chat_id) : undefined,
      operatorId: item.operator_id ? String(item.operator_id) : undefined,
      operatorIdType: item.operator_id_type ? String(item.operator_id_type) : undefined,
      createTime: item.create_time ? String(item.create_time) : undefined
    }));
    return {
      items,
      hasMore: Boolean(payload.data?.has_more),
      pageToken: payload.data?.page_token ? String(payload.data.page_token) : undefined
    };
  }

  async downloadMessageResource(messageId: string, fileKey: string, type: 'image' | 'file'): Promise<LarkMessageResourceResult> {
    const resolvedMessageId = required(messageId, 'messageId');
    const resolvedFileKey = required(fileKey, 'fileKey');
    let response: Response;
    try {
      response = await this.fetcher(`${this.config.baseUrl}/open-apis/im/v1/messages/${encodeURIComponent(resolvedMessageId)}/resources/${encodeURIComponent(resolvedFileKey)}?type=${type}`, {
        method: 'GET', headers: { authorization: `Bearer ${await this.tenantToken()}` }
      });
    } catch (error) {
      throw new LarkServiceError('LARK_NETWORK_ERROR', `Lark message resource download failed: ${error instanceof Error ? error.message : String(error)}`, 502);
    }
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as any;
      const message = payload.msg || payload.message || `${response.status} ${response.statusText}`;
      const violation = Array.isArray(payload.error?.permission_violations) ? payload.error.permission_violations[0] : undefined;
      const consoleUrl = payload.error?.console_url ?? payload.console_url ?? violation?.url;
      throw new LarkServiceError('LARK_RESOURCE_DOWNLOAD_FAILED', `Lark message resource download failed: ${message} (code: ${payload.code ?? 'HTTP_ERROR'})`, 502, {
        upstreamCode: payload.code,
        ...(consoleUrl ? { consoleUrl: String(consoleUrl) } : {}),
        ...(payload.error?.permission_violations ? { permissionViolations: payload.error.permission_violations } : {})
      });
    }
    const contentType = response.headers.get('content-type')?.split(';')[0]?.trim() || undefined;
    return { data: new Uint8Array(await response.arrayBuffer()), ...(contentType ? { contentType } : {}) };
  }

  async readDocument(urlInput: string): Promise<{ url: string; title?: string; text: string }> {
    let url: URL;
    try { url = new URL(urlInput); } catch { throw new LarkServiceError('INVALID_DOCUMENT_URL', '文档链接必须是飞书或 Lark 的 https docx/wiki URL。', 400); }
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || !(/(^|\.)feishu\.cn$/.test(host) || /(^|\.)larksuite\.com$/.test(host) || /(^|\.)larkoffice\.com$/.test(host))) throw new LarkServiceError('INVALID_DOCUMENT_URL', '只允许读取飞书或 Lark 的 https docx/wiki 链接。', 400);
    const parts = url.pathname.split('/').filter(Boolean);
    const kind = parts.at(-2); let token = parts.at(-1);
    if ((kind !== 'docx' && kind !== 'wiki') || !token) throw new LarkServiceError('INVALID_DOCUMENT_URL', '只允许读取 docx 或 wiki 文档链接。', 400);
    if (kind === 'wiki') {
      const node = await this.request(`/open-apis/wiki/v2/spaces/get_node?token=${encodeURIComponent(token)}`, { method: 'GET' });
      if (node.data?.node?.obj_type !== 'docx' || !node.data?.node?.obj_token) throw new LarkServiceError('UNSUPPORTED_DOCUMENT_TYPE', '知识库节点不是 docx，不能读取。', 400);
      token = String(node.data.node.obj_token);
    }
    const raw = await this.request(`/open-apis/docx/v1/documents/${encodeURIComponent(token)}/raw_content`, { method: 'GET' });
    const text = raw.data?.content;
    if (typeof text !== 'string') throw new LarkServiceError('INVALID_LARK_RESPONSE', '文档读取响应未包含 raw_content。', 502);
    return { url: url.toString(), ...(typeof raw.data?.title === 'string' ? { title: raw.data.title } : {}), text };
  }

  async getBotOpenId(): Promise<string> {
    const payload = await this.request('/open-apis/bot/v3/info', { method: 'GET' });
    return required(payload.bot?.open_id, 'bot.open_id');
  }

  async getBotInfo(): Promise<LarkBotInfo> {
    const payload = await this.request('/open-apis/bot/v3/info', { method: 'GET' });
    return {
      appName: required(payload.bot?.app_name, 'bot.app_name'),
      openId: required(payload.bot?.open_id, 'bot.open_id'),
      ...(payload.bot?.avatar_url ? { avatarUrl: String(payload.bot.avatar_url) } : {}),
      ...(Number.isFinite(Number(payload.bot?.activate_status)) ? { activateStatus: Number(payload.bot.activate_status) } : {})
    };
  }

  /**
   * Read back the exact application resource addressed by the configured App
   * credential. A successful request proves that the tenant token can inspect
   * that App; when Lark includes an App ID or tenant key, callers can apply a
   * stricter equality check without exposing either value outside the probe.
   */
  async checkApplicationIdentity(expectedAppId: string): Promise<LarkApplicationIdentityCheck> {
    const appId = required(expectedAppId, 'expectedAppId');
    const payload = await this.request(`/open-apis/application/v6/applications/${encodeURIComponent(appId)}?lang=en_us`, { method: 'GET' });
    const application = payload.data?.app ?? payload.data?.application ?? payload.data ?? {};
    const reportedAppId = String(application.app_id ?? application.appId ?? '').trim() || undefined;
    const tenantKey = String(application.tenant_key ?? application.tenantKey ?? '').trim() || undefined;
    return { verified: true, ...(reportedAppId ? { reportedAppId } : {}), ...(tenantKey ? { tenantKey } : {}) };
  }

  /**
   * 把注册表里的命令同步成应用的原生斜杠命令（飞书输入框里的 `/` 菜单）。
   *
   * 走的是本类的 tenant_access_token，而不是开放平台控制台会话：控制台会话带的是
   * 登录 cookie + CSRF、打的是控制台域，`/open-apis/*` 只认 tenant token，两者不能混用。
   * 因此这里同时复用 api-gate 的 per-appId 限流/退避/熔断与 LarkServiceError 归一化。
   *
   * 列表按飞书列表接口的惯例翻页（`has_more` + `page_token`，对齐 listPins）：
   * 响应没给续页标记就是全量，给了就接着取。把分页当不存在的代价是——首页之外的既有
   * 命令会被当成「不存在」而重复创建，逐条撞唯一性失败。翻页轮数按单应用 100 条上限封顶，
   * 服务端若一直回同一个 token 也不会把同步卡死。
   * 只增不改别人：远端存在而注册表里没有的命令可能是人手工加的，绝不删除。
   * 写操作需要权限 application:app_slash_command:write。
   */
  async syncSlashCommands(definitions: readonly LarkSlashCommandDefinition[]): Promise<LarkSlashCommandSyncResult> {
    const existing = new Map<string, { commandId: string; description: string }>();
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_SLASH_COMMAND_PAGES; page += 1) {
      const query = pageToken ? `?page_token=${encodeURIComponent(pageToken)}` : '';
      const payload = await this.request(`/open-apis/application/v7/app_slash_commands${query}`, { method: 'GET' });
      for (const item of Array.isArray(payload.data?.items) ? payload.data.items : []) {
        const commandId = String(item?.command_id ?? '').trim();
        const command = String(item?.command ?? '').replace(/^\//, '').trim();
        if (!commandId || !command) continue;
        existing.set(command, { commandId, description: String(item?.description?.default_value ?? '').trim() });
      }
      const next = String(payload.data?.page_token ?? '').trim();
      if (payload.data?.has_more !== true || !next || next === pageToken) break;
      pageToken = next;
    }
    const created: string[] = [];
    const updated: string[] = [];
    for (const definition of definitions) {
      const body = { command: definition.command, description: { default_value: definition.description } };
      const hit = existing.get(definition.command);
      if (!hit) {
        await this.request('/open-apis/application/v7/app_slash_commands', { body });
        created.push(definition.command);
      } else if (hit.description !== definition.description) {
        await this.request(`/open-apis/application/v7/app_slash_commands/${encodeURIComponent(hit.commandId)}`, { method: 'PUT', body });
        updated.push(definition.command);
      }
    }
    return { created, updated };
  }

  /** Read-only metadata needed to classify a configured GroupBinding. */
  async getChatPreflightInfo(chatIdInput: string): Promise<LarkChatPreflightInfo> {
    const chatId = required(chatIdInput, 'chatId');
    if (!chatId.startsWith('oc_')) throw new LarkServiceError('INVALID_CHAT_ID', 'chatId must start with oc_', 400);
    const payload = await this.request(`/open-apis/im/v1/chats/${encodeURIComponent(chatId)}?user_id_type=open_id`, { method: 'GET' });
    const chat = payload.data ?? {};
    const chatMode = String(chat.chat_mode ?? '').trim() || undefined;
    const chatStatus = String(chat.chat_status ?? '').trim() || undefined;
    const name = typeof chat.name === 'string' ? chat.name : undefined;
    const description = typeof chat.description === 'string' ? chat.description : undefined;
    return { ...(chatMode ? { chatMode } : {}), ...(chatStatus ? { chatStatus } : {}), ...(name ? { name } : {}), ...(description ? { description } : {}) };
  }

  /** The tenant token implicitly identifies the bot whose membership is read. */
  async checkBotInChat(chatIdInput: string): Promise<boolean> {
    const chatId = required(chatIdInput, 'chatId');
    if (!chatId.startsWith('oc_')) throw new LarkServiceError('INVALID_CHAT_ID', 'chatId must start with oc_', 400);
    const payload = await this.request(`/open-apis/im/v1/chats/${encodeURIComponent(chatId)}/members/is_in_chat`, { method: 'GET' });
    if (typeof payload.data?.is_in_chat !== 'boolean') throw new LarkServiceError('INVALID_LARK_RESPONSE', 'Lark membership response did not include is_in_chat', 502);
    return payload.data.is_in_chat;
  }

  async getUserEmails(openId: string): Promise<string[]> {
    const payload = await this.request(`/open-apis/contact/v3/users/${encodeURIComponent(required(openId, 'openId'))}?user_id_type=open_id`, { method: 'GET' });
    const user = payload.data?.user ?? {};
    return [...new Set([user.email, user.enterprise_email].map(value => String(value ?? '').trim().toLowerCase()).filter(Boolean))];
  }

  async checkIdentityResolution(): Promise<LarkIdentityResolutionCheck> {
    const payload = await this.request('/open-apis/contact/v3/scopes?user_id_type=open_id&page_size=100', { method: 'GET' });
    const sampleOpenId = (Array.isArray(payload.data?.user_ids) ? payload.data.user_ids : [])
      .map((value: unknown) => String(value ?? '').trim()).find(Boolean);
    if (!sampleOpenId) {
      throw new LarkServiceError(
        'LARK_CONTACT_DATA_SCOPE_EMPTY',
        '身份解析预检失败：应用通讯录数据权限中没有可用于校验的用户。请把至少一位用户（建议包含测试发送人）加入应用通讯录可见范围；资源点 GET /open-apis/contact/v3/scopes。',
        409
      );
    }
    const userPayload = await this.request(`/open-apis/contact/v3/users/${encodeURIComponent(sampleOpenId)}?user_id_type=open_id`, { method: 'GET' });
    const email = String(userPayload.data?.user?.email ?? '').trim().toLowerCase();
    if (!email) {
      throw new LarkServiceError(
        'LARK_EMAIL_PERMISSION_REQUIRED',
        '身份解析预检失败：可见用户未返回邮箱。请开通 contact:user.email:readonly（用户邮箱信息），并确认该用户已配置邮箱；资源点 GET /open-apis/contact/v3/users/:open_id。',
        409
      );
    }
    return { verified: true, sampleOpenId, sampleEmails: [email] };
  }

  /**
   * 联系人查询（owner-identity 边界用）。与卡片/消息方法走同一套 raw-fetch + token
   * 管理不同，这里用 SDK Client，因为它的错误形态（Axios throw / 业务 code 非零）
   * 正是 owner-identity 的 definitive-miss 判定所依赖的。SDK Client 懒构造、复用
   * token 缓存。domain 直接用 config.baseUrl（feishu/lark 品牌已由 baseUrl 区分）。
   */
  private contactClient?: lark.Client;
  private contactSdk(): lark.Client {
    if (!this.contactClient) {
      this.contactClient = new lark.Client({
        appId: this.config.appId,
        appSecret: this.config.appSecret,
        domain: this.config.baseUrl,
        disableTokenCache: false
      });
    }
    return this.contactClient;
  }

  /**
   * 把 SDK 抛出的错误归一化成 { code, data } 形态，让 owner-identity 的
   * larkErrorCode 能从 err.code / err.data.code / err.response.data.code 三处
   * 挖到数字码。挖不到码（纯网络错误）时 code 为 undefined，调用方按
   * inconclusive 处理。
   */
  private static normalizeContactError(err: unknown): never {
    const code = larkErrorCode(err);
    const data = (err as { response?: { data?: unknown }; data?: unknown } | null | undefined)?.response?.data
      ?? (err as { data?: unknown } | null | undefined)?.data;
    throw Object.assign(
      new Error(`Lark contact API failed (code: ${code ?? 'unknown'})`),
      { code, ...(data !== undefined ? { data } : {}) }
    );
  }

  /**
   * 按 open_id（ou_）或 union_id（on_）查询用户。返回 undefined 表示 code:0
   * 但响应里没有 user（明确不存在 = definitive miss）；业务码非零或网络错误
   * 一律 throw（definitive 码由 owner-identity 识别，其余按 inconclusive）。
   */
  async getContactUser(id: string, idType: ContactIdType): Promise<ContactUser | undefined> {
    const userId = required(id, 'id');
    let res: { code?: number; data?: { user?: { open_id?: string; union_id?: string } } };
    try {
      res = await this.contactSdk().contact.v3.user.get({
        path: { user_id: userId },
        params: { user_id_type: idType }
      });
    } catch (err) {
      LarkCardService.normalizeContactError(err);
    }
    const code = Number(res?.code ?? 0);
    if (code !== 0) {
      throw Object.assign(new Error(`Lark contact user.get failed (code: ${code})`), { code, data: res?.data });
    }
    const user = res?.data?.user;
    if (!user || typeof user !== 'object') return undefined;
    return {
      ...(user.open_id ? { openId: String(user.open_id) } : {}),
      ...(user.union_id ? { unionId: String(user.union_id) } : {})
    };
  }

  /** 通过完整邮箱解析用户 ID（存在性校验用）；干净空响应返回 undefined。 */
  async batchGetIdByEmail(email: string): Promise<string | undefined> {
    return this.batchGetId({ emails: [required(email, 'email')] });
  }

  /** 通过手机号解析用户 ID（存在性校验用）；干净空响应返回 undefined。 */
  async batchGetIdByMobile(mobile: string): Promise<string | undefined> {
    return this.batchGetId({ mobiles: [required(mobile, 'mobile')] });
  }

  private async batchGetId(key: { emails?: string[]; mobiles?: string[] }): Promise<string | undefined> {
    let res: { code?: number; data?: { user_list?: Array<{ user_id?: string }> } };
    try {
      res = await this.contactSdk().contact.v3.user.batchGetId({
        params: { user_id_type: 'open_id' },
        data: { ...key, include_resigned: false }
      });
    } catch (err) {
      LarkCardService.normalizeContactError(err);
    }
    const code = Number(res?.code ?? 0);
    if (code !== 0) {
      throw Object.assign(new Error(`Lark contact batchGetId failed (code: ${code})`), { code, data: res?.data });
    }
    const list = Array.isArray(res?.data?.user_list) ? res.data.user_list : [];
    const hit = list.find(user => typeof user?.user_id === 'string' && user.user_id);
    return hit ? String(hit.user_id) : undefined;
  }

  private async tenantToken() {
    if (this.token && Date.now() < this.tokenExpiresAt) return this.token;
    const payload = await this.request('/open-apis/auth/v3/tenant_access_token/internal/', {
      token: false, body: { app_id: this.config.appId, app_secret: this.config.appSecret }
    });
    this.token = payload.tenant_access_token;
    if (!this.token) throw new LarkServiceError('INVALID_LARK_RESPONSE', 'Lark token response did not include tenant_access_token', 502);
    this.tokenExpiresAt = Date.now() + Math.max(60, Number(payload.expire ?? 7200) - 60) * 1000;
    return this.token;
  }

  private async request(path: string, options: { method?: string; body?: unknown; token?: boolean }) {
    const headers: Record<string, string> = { 'content-type': 'application/json; charset=utf-8' };
    // token 必须在网关之外解析：tenantToken() 自身就走 request()，若放在 gate 内部
    // 会形成嵌套调用——一次业务请求消耗两个令牌，且鉴权请求的重试会与业务请求的
    // 重试相乘。鉴权自身是低频且带缓存的，不需要限流。
    if (options.token !== false) headers.authorization = `Bearer ${await this.tenantToken()}`;
    // 所有出网 JSON 调用（卡片创建/更新、消息发送、reaction、通讯录）都经由此处，
    // 因此在这里收口 per-appId 限流：N 个并发会话的卡片心跳不再能合计打爆 app 配额。
    // 熔断快速失败要转成 LarkServiceError：routes.ts 有 8 处按 instanceof LarkServiceError
    // 决定 HTTP 状态码，不转换会让熔断退化成一个语义不明的 500。
    try {
      return await executeWithLarkGate(this.config.appId, `${options.method ?? 'POST'} ${path.split('?')[0]}`, async () => {
      let response: Response;
      try {
        response = await this.fetcher(`${this.config.baseUrl}${path}`, {
          method: options.method ?? 'POST', headers, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })        });
      } catch (error) {
        throw new LarkServiceError('LARK_NETWORK_ERROR', `Lark OpenAPI request failed: ${error instanceof Error ? error.message : String(error)}`, 502);
      }
      if (!response) throw new LarkServiceError('LARK_NETWORK_ERROR', 'Lark OpenAPI request returned no response', 502);
      const payload = await response.json().catch(() => ({})) as any;
      if (!response.ok || payload.code !== 0) {
        const message = payload.msg || payload.message || `${response.status} ${response.statusText}`;
        const violation = Array.isArray(payload.error?.permission_violations) ? payload.error.permission_violations[0] : undefined;
        const consoleUrl = payload.error?.console_url ?? payload.console_url ?? violation?.url;
        // 网关按 retryAfterMs 决定退避时长：飞书用 Retry-After / x-ogw-ratelimit-reset
        // （单位秒）告知需要等多久，丢掉它就只能盲目指数退避。
        const retryAfterMs = retryAfterMsFromHeaders(response.headers);
        throw new LarkServiceError('LARK_OPENAPI_ERROR', `Lark OpenAPI request failed: ${message} (code: ${payload.code ?? 'HTTP_ERROR'})`, 502, {
          upstreamCode: payload.code,
          upstreamHttpStatus: response.status,
          ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
          ...(consoleUrl ? { consoleUrl: String(consoleUrl) } : {}),
          ...(payload.error?.permission_violations ? { permissionViolations: payload.error.permission_violations } : {})
        });
      }
      return payload;
      }, this.config.env ? { env: this.config.env } : undefined);
    } catch (error) {
      // 熔断跳闸期间请求未触达网络。转成 503（Service Unavailable）+ 可操作的中文说明，
      // 让 routes.ts 现有的 instanceof 分支能给出正确状态码，也让上层日志看得懂原因。
      if (error instanceof LarkCircuitOpenError) {
        throw new LarkServiceError('LARK_CIRCUIT_OPEN', `飞书 OpenAPI 连续失败已触发熔断，暂时停止外发请求。请稍后重试，或检查机器人凭据与网络连通性。`, 503, {
          appId: error.appId,
          openedAt: new Date(error.openedAt).toISOString()
        });
      }
      throw error;
    }
  }

  /**
   * 飞书任务智能体通道（task-agent.ts）唯一的出网入口：复用本类的 tenant token 缓存、
   * api-gate 的 per-appId 限流/退避/熔断与 LarkServiceError 归一化，不另起 HTTP 客户端。
   */
  async callOpenApi(path: string, options: { method?: string; body?: unknown } = {}): Promise<any> {
    return await this.request(path, options);
  }

  private async requestForm(path: string, form: FormData) {
    let response: Response;
    try {
      response = await this.fetcher(`${this.config.baseUrl}${path}`, { method: 'POST', headers: { authorization: `Bearer ${await this.tenantToken()}` }, body: form });
    } catch (error) { throw new LarkServiceError('LARK_NETWORK_ERROR', `Lark OpenAPI request failed: ${error instanceof Error ? error.message : String(error)}`, 502); }
    const payload = await response.json().catch(() => ({})) as any;
    if (!response.ok || payload.code !== 0) throw new LarkServiceError('LARK_OPENAPI_ERROR', `Lark OpenAPI request failed: ${payload.msg || response.statusText}`, 502, { upstreamCode: payload.code, upstreamHttpStatus: response.status });
    return payload;
  }
}

export function createLarkCardService(env: NodeJS.ProcessEnv = process.env, fetcher: Fetch = globalThis.fetch, input: LarkBotConfigInput = {}) {
  return new LarkCardService(loadLarkBotConfig(env, input), fetcher);
}
