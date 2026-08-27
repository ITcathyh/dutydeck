import { readFile } from 'node:fs/promises';
import * as lark from '@larksuiteoapi/node-sdk';
import { larkErrorCode, type ContactIdType, type ContactUser } from './owner-identity.js';

export const larkCardStates = ['queued', 'running', 'completed', 'failed', 'interrupted'] as const;
export type LarkCardState = (typeof larkCardStates)[number];
export const larkReceiveIdTypes = ['open_id', 'union_id', 'user_id', 'email', 'chat_id'] as const;
export type LarkReceiveIdType = (typeof larkReceiveIdTypes)[number];

export interface LarkCardInput {
  agentName?: string;
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
}
export interface LarkSendInput extends LarkCardInput { receiveId?: string; receiveIdType?: LarkReceiveIdType; chatId?: string }
export interface LarkReplyInput extends LarkCardInput { messageId: string; replyInThread?: boolean; replyRootId?: string }
export interface LarkUpdateInput extends LarkCardInput { messageId: string }
export interface LarkMessageResult { messageId: string; chatId?: string }
export interface LarkReactionResult { messageId: string; reactionId: string; emojiType: string }
export interface LarkBotInfo { appName: string; openId: string; avatarUrl?: string; activateStatus?: number }
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

export interface LarkBotConfig {
  appId: string;
  appSecret: string;
  defaultReceiveId?: string;
  defaultReceiveIdType: LarkReceiveIdType;
  defaultAgentName: string;
  baseUrl: string;
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

const statePresentation = {
  queued: { title: '排队中', color: 'grey' },
  running: { title: '正在执行', color: 'wathet' },
  completed: { title: '已完成', color: 'green' },
  failed: { title: '已失败', color: 'yellow' },
  interrupted: { title: '已取消', color: 'grey' }
} as const;
const elapsedLabel = (seconds: number) => {
  const value = Math.max(0, Math.floor(seconds));
  if (value < 60) return `${value}s`;
  const minutes = Math.floor(value / 60);
  const rest = value % 60;
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
};
export const larkCardSafeLimits = { bytes: 24 * 1024, components: 180 } as const;
export const larkCardSnapshotLimits = { bytes: 16 * 1024, components: 120 } as const;
const cardBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');
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
    tag: 'markdown', element_id: 'dockmux_snapshot_omission',
    content: `<font color='grey'>内容较长，已省略 ${count} 个较早执行分组；完整记录请在 Dockmux Web 查看。</font>`,
    text_size: 'x-small', margin: '4px 0px'
  });
  const upsertOmissionNotice = (els: Array<Record<string, unknown>>, count: number) => {
    if (count <= 0) return;
    const notice = omissionNotice(count);
    const index = els.findIndex(element => element.element_id === 'dockmux_snapshot_omission');
    if (index >= 0) els[index] = notice;
    else {
      const firstGroup = els.findIndex(element => typeof element.element_id === 'string' && element.element_id.startsWith('trace_group_'));
      els.splice(firstGroup < 0 ? els.length : firstGroup, 0, notice);
    }
  };
  const stripGroupContent = (group: Record<string, unknown>): boolean => {
    const groupElements = Array.isArray(group.elements) ? group.elements as Array<Record<string, unknown>> : [];
    const thinkingIndex = groupElements.findIndex(el => typeof el.content === 'string' && el.content.includes('思考过程'));
    if (thinkingIndex >= 0) {
      group.elements = groupElements.filter((_, i) => i !== thinkingIndex);
      return true;
    }
    const toolIndex = groupElements.findIndex(el => typeof el.element_id === 'string' && el.element_id.startsWith('trace_tool_') && Array.isArray(el.elements) && el.elements.length > 0);
    if (toolIndex >= 0) {
      const tool = groupElements[toolIndex] as Record<string, unknown>;
      tool.elements = [];
      return true;
    }
    return false;
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
        { tag: 'markdown', element_id: 'dockmux_snapshot_omission', content: "<font color='grey'>卡片内容超过飞书限制，过程记录已收起；完整记录请在 Dockmux Web 查看。</font>", text_size: 'x-small', margin: '8px 0px 0px 0px' }
      ];
    }
    const group = mainElements[groupIndex] as Record<string, unknown>;
    const groupElements = Array.isArray(group.elements) ? group.elements as Array<Record<string, unknown>> : [];
    const remainingGroups = mainElements.filter(element => typeof element.element_id === 'string' && element.element_id.startsWith('trace_group_')).length;
    // 优先从最旧分组中剥离内容（思考过程、工具输入输出），保留分组结构；
    // 仅当分组已无内容可剥离时，才删除整个分组。
    if (remainingGroups > 1 && stripGroupContent(group)) continue;
    // 只剩一个 trace 分组时，优先从分组内部移除最旧的子元素，保留最近的活动，避免整组被丢弃后用户什么都看不到。
    if (remainingGroups === 1 && groupElements.length > 1) {
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
    defaultAgentName: input.agentName?.trim() || env.LARK_AGENT_NAME?.trim() || 'Dockmux',
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
    baseUrl: status.baseUrl
  };
}

export function buildLarkCard(input: LarkCardInput = {}) {
  const state = input.state ?? 'running';
  const presentation = statePresentation[state];
  if (!presentation) throw new LarkServiceError('INVALID_CARD_STATE', `Unsupported Lark card state: ${String(state)}`, 400);
  const taskName = input.taskName?.trim() || 'Dockmux';
  const taskId = String(input.taskId ?? Date.now()).trim();
  const elapsedSeconds = Number(input.elapsedSeconds ?? 0);
  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds < 0) throw new LarkServiceError('INVALID_ELAPSED_SECONDS', 'elapsedSeconds must be a non-negative number', 400);
  const content = input.markdown !== undefined ? String(input.markdown) : state === 'completed' ? '任务已完成。' : '';
  const liveTitle = state === 'running' ? '执行中' : presentation.title;
  const actionButton = !input.readOnly && state === 'queued' ? {
    tag: 'button', text: { tag: 'plain_text', content: '取消' }, type: 'default', size: 'small',
    behaviors: [{ type: 'callback', value: { action: 'cancel', task_id: taskId } }],
    margin: '0px', element_id: 'cancel'
  } : !input.readOnly && state === 'running' ? {
    tag: 'button', text: { tag: 'plain_text', content: '中断' }, type: 'danger', size: 'small',
    behaviors: [{ type: 'callback', value: { action: 'interrupt', task_id: taskId } }],
    margin: '0px', element_id: 'interrupt'
  } : !input.readOnly && (state === 'failed' || state === 'interrupted') && input.retryable !== false ? {
    tag: 'button', text: { tag: 'plain_text', content: '重试' }, type: 'primary', size: 'small',
    behaviors: [{ type: 'callback', value: { action: 'retry', task_id: taskId } }],
    margin: '0px', element_id: 'retry'
  } : undefined;
  const footerColumns: any[] = [{
    tag: 'column', width: 'weighted', weight: 1, vertical_align: 'center',
    elements: [{ tag: 'markdown', content: `<font color='grey'>任务 #${taskId} · 已用时 ${elapsedLabel(elapsedSeconds)}</font>`, text_size: 'x-small', margin: '0px' }]
  }];
  if (input.webBaseUrl) {
    const traceUrl = input.sessionId ? `${input.webBaseUrl}/sessions/${input.sessionId}` : `${input.webBaseUrl}/sessions`;
    footerColumns.push({
      tag: 'column', width: 'auto', vertical_align: 'center',
      elements: [{
        tag: 'markdown',
        content: `<font color='grey'>[查看详情](${traceUrl})</font>`,
        text_size: 'x-small', margin: '0px'
      }]
    });
  }
  const sourceMainElements = input.elements?.length
    ? input.elements
    : [{ tag: 'markdown', content, text_align: 'left', text_size: 'normal_v2', margin: '0px' }];
  const arrange = (mainElements: Array<Record<string, unknown>>) => {
    const finalElements = mainElements.filter(element => element.element_id === 'final_output');
    const traceElements = mainElements.filter(element => typeof element.element_id === 'string' && element.element_id.startsWith('trace_group_'));
    const otherElements = mainElements.filter(element => element.element_id !== 'final_output' && !(typeof element.element_id === 'string' && element.element_id.startsWith('trace_group_')));
    const statusContent = `<text_tag color='${presentation.color}'>${liveTitle}</text_tag>　${elapsedLabel(elapsedSeconds)}`;
    const loadingIcon = input.loadingImageKey
      ? { tag: 'custom_icon', img_key: input.loadingImageKey, size: '20px 20px' }
      : { tag: 'standard_icon', token: 'loading_outlined', color: 'grey', size: '14px 14px' };
    const overviewLoadingIcon = input.loadingImageKey
      ? { tag: 'custom_icon', img_key: input.loadingImageKey }
      : { tag: 'standard_icon', token: 'loading_outlined', color: 'grey' };
    const statusElement = {
      tag: 'div', element_id: 'task_status', width: 'auto', margin: '0px',
      text: { tag: 'lark_md', content: statusContent, text_size: 'small' },
      ...(state === 'running' ? { icon: loadingIcon } : {})
    };
    const traceOverview = traceElements.length ? [{
      tag: 'collapsible_panel', element_id: 'trace_overview', expanded: state === 'running',
      direction: 'vertical', vertical_spacing: '2px', padding: '2px 0px 0px 0px', margin: '0px',
      header: {
        title: {
          tag: 'markdown', content: `${state === 'running' ? '已耗时' : '耗时'} ${elapsedLabel(elapsedSeconds)}　<font color='${state === 'running' ? 'trace_running' : state === 'failed' ? 'trace_failure' : presentation.color}'>● ${liveTitle}</font>　<font color='grey'>${traceElements.length} 个阶段</font>`, text_size: 'notation',
          ...(state === 'running' ? { icon: overviewLoadingIcon } : {})
        },
        vertical_align: 'center', icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', color: 'grey', size: '14px 14px' },
        icon_position: 'right', icon_expanded_angle: -180
      },
      elements: traceElements
    }] : [];
    const compactTaskName = taskName.replace(/\s+/g, ' ').trim();
    const taskSummary = taskName === 'Dockmux' ? [] : [{
      tag: 'div', width: 'fill', margin: '0px 0px 4px 0px',
      text: { tag: 'plain_text', content: compactTaskName, text_size: 'notation', text_color: 'grey', lines: 1 }
    }];
    const finals = finalElements.map(element => ({ ...element, margin: traceElements.length || otherElements.length ? '10px 0px 0px 0px' : '8px 0px 0px 0px' }));
    const primaryStatus = traceElements.length ? traceOverview[0] : statusElement;
    const actionSummary = taskSummary[0] ? { ...taskSummary[0], margin: '0px' } : {
      tag: 'div', width: 'fill', margin: '0px',
      text: { tag: 'plain_text', content: compactTaskName || 'Dockmux', text_size: 'notation', text_color: 'grey', lines: 1 }
    };
    const taskHeader = actionButton ? [{
      tag: 'column_set', element_id: 'task_action_row', flex_mode: 'none', horizontal_spacing: '8px', vertical_align: 'center', margin: '0px',
      columns: [
        { tag: 'column', width: 'weighted', weight: 1, vertical_align: 'center', elements: [actionSummary] },
        { tag: 'column', width: '72px', vertical_align: 'center', elements: [actionButton] }
      ]
    }] : taskSummary;
    return [...taskHeader, primaryStatus, ...otherElements, ...finals];
  };
  const assemble = (mainElements: Array<Record<string, unknown>>) => ({
    schema: '2.0',
    config: {
      update_multi: true,
      width_mode: 'default',
      streaming_mode: state === 'running',
      style: { color: {
        trace_success: { light_mode: 'rgba(92,184,119,1)', dark_mode: 'rgba(118,204,142,1)' },
        trace_failure: { light_mode: 'rgba(208,180,92,1)', dark_mode: 'rgba(226,202,124,1)' },
        trace_running: { light_mode: 'rgba(96,184,232,1)', dark_mode: 'rgba(124,202,242,1)' }
      } },
      ...(state === 'running' || state === 'queued' ? { summary: { content: `${taskName} · ${liveTitle}` } } : {})
    },
    body: {
      direction: 'vertical', vertical_spacing: '2px', padding: '8px 12px 10px 12px',
      elements: [
        ...arrange(mainElements),
        {
          tag: 'column_set', flex_mode: 'none', horizontal_spacing: '8px', margin: '6px 0px 0px 0px',
          columns: footerColumns
        }
      ]
    }
  });
  const withinLimits = (card: unknown) => cardBytes(card) <= larkCardSafeLimits.bytes && cardComponents(card) <= larkCardSafeLimits.components;
  const omissionNotice = (count: number) => ({
    tag: 'markdown', element_id: 'dockmux_omission',
    content: `<font color='grey'>内容较长，已省略 ${count} 个较早执行分组；完整记录请在 Dockmux Web 查看。</font>`,
    text_size: 'x-small', margin: '4px 0px'
  });
  const upsertOmissionNotice = (elements: Array<Record<string, unknown>>, count: number) => {
    if (count <= 0) return;
    const notice = omissionNotice(count);
    const index = elements.findIndex(element => element.element_id === 'dockmux_omission');
    if (index >= 0) elements[index] = notice;
    else {
      const firstGroup = elements.findIndex(element => typeof element.element_id === 'string' && element.element_id.startsWith('trace_group_'));
      elements.splice(firstGroup < 0 ? elements.length : firstGroup, 0, notice);
    }
  };
  const stripGroupContent = (group: Record<string, unknown>): boolean => {
    const groupElements = Array.isArray(group.elements) ? group.elements as Array<Record<string, unknown>> : [];
    // 1. 先移除思考过程元素
    const thinkingIndex = groupElements.findIndex(el => typeof el.content === 'string' && el.content.includes('思考过程'));
    if (thinkingIndex >= 0) {
      group.elements = groupElements.filter((_, i) => i !== thinkingIndex);
      return true;
    }
    // 2. 再移除工具的输入/输出内容，仅保留工具标题
    const toolIndex = groupElements.findIndex(el => typeof el.element_id === 'string' && el.element_id.startsWith('trace_tool_') && Array.isArray(el.elements) && el.elements.length > 0);
    if (toolIndex >= 0) {
      const tool = groupElements[toolIndex] as Record<string, unknown>;
      tool.elements = [];
      return true;
    }
    return false;
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
    // 优先从最旧分组中剥离内容（思考过程、工具输入输出），保留分组结构；
    // 仅当分组已无内容可剥离时，才删除整个分组。
    if (remainingGroups > 1 && stripGroupContent(group)) {
      card = assemble(mainElements);
      continue;
    }
    // 只剩一个 trace 分组时，优先从分组内部移除最旧的子元素，保留最近的活动。
    if (remainingGroups === 1 && groupElements.length > 1) {
      group.elements = groupElements.slice(1);
    } else {
      mainElements.splice(groupIndex, 1);
      omittedGroups++;
      upsertOmissionNotice(mainElements, omittedGroups);
    }
    card = assemble(mainElements);
  }
  if (withinLimits(card)) return card;
  const fallbackText = String((sourceMainElements.find(element => element.element_id === 'final_output') as any)?.content ?? (sourceMainElements.find(element => element.tag === 'markdown') as any)?.content ?? content ?? '内容过长');
  return assemble([
    { tag: 'markdown', content: fallbackText.length > 4_000 ? `${fallbackText.slice(0, 3_999)}…` : fallbackText, text_align: 'left', text_size: 'normal_v2', margin: '0px' },
    { tag: 'markdown', content: "<font color='grey'>卡片内容超过飞书限制，过程记录已收起；完整记录请在 Dockmux Web 查看。</font>", text_size: 'x-small', margin: '8px 0px 0px 0px' }
  ]);
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
        form.append('image', new Blob([await readFile(new URL('./assets/dockmux-bouncing-ball.webp', import.meta.url))], { type: 'image/webp' }), 'dockmux-bouncing-ball.webp');
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
    const itemChatId = String(item?.chat_id ?? '').trim() || undefined;
    const upperMessageId = String(item?.upper_message_id ?? '').trim() || undefined;
    return {
      messageId, messageType: String(item?.msg_type ?? 'unknown'), createTime: String(item?.create_time ?? '0'),
      sender: normalizedSender, rawContent: String(item?.body?.content ?? item?.content ?? ''), mentions,
      deleted: item?.deleted === true, updated: item?.updated === true,
      ...(itemChatId ? { chatId: itemChatId } : {}), ...(updateTime ? { updateTime } : {}), ...(threadId ? { threadId } : {}),
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
    if (options.token !== false) headers.authorization = `Bearer ${await this.tenantToken()}`;
    let response: Response;
    try {
      response = await this.fetcher(`${this.config.baseUrl}${path}`, {
        method: options.method ?? 'POST', headers, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })
      });
    } catch (error) {
      throw new LarkServiceError('LARK_NETWORK_ERROR', `Lark OpenAPI request failed: ${error instanceof Error ? error.message : String(error)}`, 502);
    }
    if (!response) throw new LarkServiceError('LARK_NETWORK_ERROR', 'Lark OpenAPI request returned no response', 502);
    const payload = await response.json().catch(() => ({})) as any;
    if (!response.ok || payload.code !== 0) {
      const message = payload.msg || payload.message || `${response.status} ${response.statusText}`;
      const violation = Array.isArray(payload.error?.permission_violations) ? payload.error.permission_violations[0] : undefined;
      const consoleUrl = payload.error?.console_url ?? payload.console_url ?? violation?.url;
      throw new LarkServiceError('LARK_OPENAPI_ERROR', `Lark OpenAPI request failed: ${message} (code: ${payload.code ?? 'HTTP_ERROR'})`, 502, {
        upstreamCode: payload.code,
        ...(consoleUrl ? { consoleUrl: String(consoleUrl) } : {}),
        ...(payload.error?.permission_violations ? { permissionViolations: payload.error.permission_violations } : {})
      });
    }
    return payload;
  }
}

export function createLarkCardService(env: NodeJS.ProcessEnv = process.env, fetcher: Fetch = globalThis.fetch, input: LarkBotConfigInput = {}) {
  return new LarkCardService(loadLarkBotConfig(env, input), fetcher);
}
