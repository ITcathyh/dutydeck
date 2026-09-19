import { safeLarkWebUrl } from './card-actions.js';

export interface LarkTaskDashboardPendingApproval {
  /** workflow-interactions 里的交互 id；审批 value 必须带它走 respond 的一次性 CAS。 */
  requestId: string;
  /** LarkWorkflowInteractions.boot，回调时做世代校验。 */
  generation: string;
}

export interface LarkTaskDashboardEntry {
  /** runtime 任务 id，仅为主控组装/排序使用，渲染层绝不输出到卡片。 */
  taskId: string;
  title: string;
  workspace: string;
  /** Agent 显示名；主控取不到名字时传 agentId，取不到任何信息时不传（行内与表头都不写 Agent）。 */
  agent?: string;
  status: string;
  detail?: string;
  blocked?: boolean;
  updatedAt: string;
  url?: string;
  feedback?: 'pending' | 'accepted' | 'needs_changes';
  /**
   * 行内取消/中断/重试的回调任务标识：飞书消息 id（主控 tasks Map 的键）。
   * 缺省时不渲染这三类按钮——没有它主控无法定位任务，只会是死按钮。
   */
  actionTaskId?: string;
  /** 当前轮次，原样写进回调 value（字符串形态），主控据此做 stale 校验。 */
  turn?: number;
  /** 带待决审批时，主操作固定为「审批」，优先于状态默认操作。 */
  pendingApproval?: LarkTaskDashboardPendingApproval;
  /** 任务发起人 open_id，仅供主控判断他人操作的二次确认，渲染层不展示。 */
  ownerOpenId?: string;
  /** 显式不可重试（例如被 /new 作废）时，失败/中断行不出现重试。 */
  retryable?: boolean;
}

export interface LarkTaskDashboardResult {
  elements: Array<Record<string, any>>;
  page: number;
  totalPages: number;
}

const PAGE_SIZE = 10;
const MAX_TITLE_CHARS = 120;
const MAX_WORKSPACE_CHARS = 120;
const MAX_AGENT_CHARS = 64;

const waitingStatuses = new Set(['waiting_for_permission', 'waiting_for_answer', 'failed', 'interrupted', 'reconcile_required', 'legacy_unresolved']);
const runningStatuses = new Set(['queued', 'running', 'thinking', 'running_tool']);

const statusLabels: Record<string, string> = {
  waiting_for_permission: '等待审批',
  waiting_for_answer: '等待回答',
  failed: '失败',
  reconcile_required: '需要核对',
  legacy_unresolved: '需要核对',
  interrupted: '已中断',
  queued: '排队中',
  running: '执行中',
  thinking: '思考中',
  running_tool: '执行工具',
  completed: '已完成',
  succeeded: '已完成',
  success: '已完成',
  done: '已完成',
  cancelled: '已取消',
  canceled: '已取消'
};

const groupLabels = ['待处理', '运行中', '最近结果'] as const;

type DashboardGroup = 0 | 1 | 2;

type IndexedEntry = {
  entry: LarkTaskDashboardEntry;
  index: number;
  group: DashboardGroup;
};

const compactText = (value: unknown, limit: number, fallback: string) => {
  const text = String(value ?? '').replace(/\s+/gu, ' ').trim() || fallback;
  const characters = Array.from(text);
  return characters.length <= limit ? text : `${characters.slice(0, Math.max(1, limit - 1)).join('')}…`;
};

const workspaceName = (value: unknown) => {
  const raw = String(value ?? '').trim();
  if (!raw) return '未指定工作区';
  if (/^[A-Za-z]:[\\/]*$/u.test(raw) || /^\/{1,2}$/u.test(raw)) return compactText(raw, MAX_WORKSPACE_CHARS, '未指定工作区');
  const withoutTrailingSeparators = raw.replace(/[\\/]+$/u, '');
  const segment = withoutTrailingSeparators.split(/[\\/]/u).filter(Boolean).at(-1);
  return compactText(segment || raw, MAX_WORKSPACE_CHARS, '未指定工作区');
};

/** Agent 显示名；缺省返回 undefined，调用方据此完全不渲染 Agent（不编造「未知 Agent」）。 */
const agentName = (value: unknown) => {
  const raw = String(value ?? '').trim();
  return raw ? compactText(raw, MAX_AGENT_CHARS, raw) : undefined;
};

const statusLabel = (status: unknown) => {
  const key = String(status ?? '').trim().toLowerCase();
  return statusLabels[key] ?? '状态待核对';
};

const groupForStatus = (status: unknown): DashboardGroup => {
  const key = String(status ?? '').trim().toLowerCase();
  return waitingStatuses.has(key) ? 0 : runningStatuses.has(key) ? 1 : 2;
};

const timestamp = (value: unknown) => {
  const text = String(value ?? '').trim();
  if (!text) return Number.NEGATIVE_INFINITY;
  if (/^-?\d+(?:\.\d+)?$/u.test(text)) {
    const numeric = Number(text);
    if (Number.isFinite(numeric)) return numeric;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
};

// 列表里读者只判断「新不新」，不核对时刻。相对时间同时省掉了「更新时间：」这个标签词：
// 「41 分钟前」自己就说明了它是时间。超过 30 天退回日期，那时相对值已经失去分辨力。
const relativeTime = (value: unknown, now: number) => {
  const at = timestamp(value);
  if (at === Number.NEGATIVE_INFINITY) return '时间未知';
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days <= 30) return `${days} 天前`;
  // Date 只接受 ±8.64e15；timestamp() 的数字串分支只挡了 Number.isFinite，
  // 超范围值会让下一行抛 RangeError，把整张任务列表变成一句 Invalid time value。
  if (Math.abs(at) > 8.64e15) return '时间未知';
  return new Date(at).toISOString().slice(0, 10);
};

// 行 Web 出口与进度卡共用同一份链接校验（card-actions.ts 的 safeLarkWebUrl），
// 不在本模块另写一套白名单。
const validAppLink = (value: unknown) => safeLarkWebUrl(typeof value === 'string' ? value : undefined);

const markdown = (elementId: string, content: string) => ({
  tag: 'markdown', element_id: elementId, content
});

const escapeCardInline = (value: string) =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

const MAX_ACTION_TASK_ID_CHARS = 256;

/** 回调任务标识必须是非空飞书消息 id；缺了它主控的 tasks Map 无法定位任务，宁可不渲染。 */
const validActionTaskId = (value: unknown) => {
  const id = typeof value === 'string' ? value.trim() : '';
  return id && id.length <= MAX_ACTION_TASK_ID_CHARS ? id : undefined;
};

/** turn 与 card-actions.ts 同一口径：非负有限整数向下取整，脏数据视为「不带轮次」。 */
const validTurn = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;

/** 审批身份两要素缺一不可，否则按钮点了必然撞 CAS 失效，属于死按钮。 */
const validApproval = (value: LarkTaskDashboardEntry['pendingApproval']) => {
  if (!value) return undefined;
  const requestId = typeof value.requestId === 'string' ? value.requestId.trim() : '';
  const generation = typeof value.generation === 'string' ? value.generation.trim() : '';
  return requestId && generation ? { requestId, generation } : undefined;
};

/**
 * 取消/中断/重试的回调 value，与 card-actions.ts 的 callbackValue 完全同构
 * （{action,task_id,turn} 全字符串字段），主控 parseLarkCardActionValue 可直接解析。
 * 缺轮次时省略 turn，兼容主控的遗留卡片路径（按任务当前轮处理）。
 */
const taskActionValue = (action: 'cancel' | 'interrupt' | 'retry', taskId: string, turn: number | undefined) => ({
  action,
  task_id: taskId,
  ...(turn === undefined ? {} : { turn: String(turn) })
});

/** 审批回调 value 与 workflow-interactions.ts 的按钮同形，主控只能走 respond 的一次性决议 CAS。 */
const workflowActionValue = (action: 'approve' | 'reject', approval: NonNullable<LarkTaskDashboardEntry['pendingApproval']>) => ({
  dutydeck_workflow: action,
  request_id: approval.requestId,
  generation: approval.generation
});

type RowPrimaryAction = {
  label: string;
  buttonType: 'default' | 'primary' | 'danger';
  value: Record<string, string>;
};

/**
 * 每行只给一个主操作（终裁 P0-1）：
 * 待决审批优先于一切；否则 queued→取消、running 系（running/thinking/running_tool）→中断、
 * failed/interrupted→重试（retryable === false 除外）；终态与等待回答不渲染主操作。
 */
const primaryRowAction = (
  entry: LarkTaskDashboardEntry,
  approval: LarkTaskDashboardPendingApproval | undefined
): RowPrimaryAction | undefined => {
  if (approval) return { label: '审批', buttonType: 'primary', value: workflowActionValue('approve', approval) };
  const taskId = validActionTaskId(entry.actionTaskId);
  if (!taskId) return undefined;
  const turn = validTurn(entry.turn);
  const status = String(entry.status ?? '').trim().toLowerCase();
  if (status === 'queued') {
    return { label: '取消', buttonType: 'default', value: taskActionValue('cancel', taskId, turn) };
  }
  if (status === 'running' || status === 'thinking' || status === 'running_tool') {
    return { label: '中断', buttonType: 'danger', value: taskActionValue('interrupt', taskId, turn) };
  }
  if ((status === 'failed' || status === 'interrupted' || status === 'cancelled') && entry.retryable !== false) {
    return { label: '重试', buttonType: 'primary', value: taskActionValue('retry', taskId, turn) };
  }
  return undefined;
};

/**
 * 次要操作收进 JSON 2.0 overflow 菜单，避免手机上每行一堵按钮墙。
 * 注意 overflow 的 behaviors.value 是全组共用的，被点选项只通过回调 event.action.option 区分
 * （官方组件文档，2026-09-13 核证），所以这里约束：一个菜单至多放一个回调型选项，
 * 共用 value 就是该动作的完整回调值；「返回原会话」只配 multi_url 跳转。
 * 仅有跳转选项时整个菜单不挂 behaviors，结构上不可能发出回调。
 */
const rowOverflow = (
  rowIndex: number,
  url: string | undefined,
  approval: LarkTaskDashboardPendingApproval | undefined
): Record<string, any> | undefined => {
  const options: Array<Record<string, any>> = [];
  if (approval) options.push({ text: { tag: 'plain_text', content: '拒绝' }, value: 'reject' });
  if (url) {
    options.push({ text: { tag: 'plain_text', content: '返回原会话' }, value: 'open_chat', multi_url: { url } });
  }
  if (!options.length) return undefined;
  const element: Record<string, any> = { tag: 'overflow', element_id: `row_more_${rowIndex}`, options };
  if (approval) element.behaviors = [{ type: 'callback', value: workflowActionValue('reject', approval) }];
  return element;
};

const taskRow = (item: IndexedEntry, rowIndex: number, now: number, sharedWorkspace?: string, sharedAgent?: string) => {
  const entry = item.entry;
  const title = compactText(entry.title, MAX_TITLE_CHARS, '未命名任务');
  const workspace = workspaceName(entry.workspace);
  const agent = agentName(entry.agent);
  const feedback = entry.feedback ? ` · 验收：${({ pending: '待验收', accepted: '已通过', needs_changes: '需要修改' })[entry.feedback]}` : '';
  // 「状态：」「工作区：」这类标签词占了每行前四个字，而「等待审批」「dutydeck」自己
  // 就说明了自己是什么。全部任务在同一个工作区时（单机常态）它更是逐行重复同一个词，
  // 这时提到表头写一次，行内只留真正逐行不同的东西。Agent 同一口径。
  const location = sharedWorkspace ? '' : ` · ${workspace}`;
  const executor = agent && !sharedAgent ? ` · ${agent}` : '';
  const summary = `${title}\n${entry.blocked && entry.status === 'queued' ? '排队受阻' : statusLabel(entry.status)}${feedback} · ${relativeTime(entry.updatedAt, now)}${location}${executor}${entry.detail ? `\n${entry.detail}` : ''}`;
  const url = validAppLink(entry.url);
  const approval = validApproval(entry.pendingApproval);
  const primary = primaryRowAction(entry, approval);
  const overflow = rowOverflow(rowIndex, url, approval);
  const summaryElement = {
    tag: 'div',
    text: { tag: 'plain_text', content: summary, lines: 3 },
    width: 'auto',
    margin: '0px'
  };
  const hasTrailing = Boolean(primary || overflow);
  const columns: Array<Record<string, any>> = [{
    tag: 'column', width: hasTrailing ? 'weighted' : 'auto', ...(hasTrailing ? { weight: 1 } : {}),
    vertical_align: 'center', elements: [summaryElement]
  }];
  if (primary) {
    columns.push({
      tag: 'column', width: 'auto', vertical_align: 'center', elements: [{
        tag: 'button',
        element_id: `row_act_${rowIndex}`,
        type: primary.buttonType,
        text: { tag: 'plain_text', content: primary.label },
        behaviors: [{ type: 'callback', value: primary.value }]
      }]
    });
  }
  if (overflow) {
    columns.push({ tag: 'column', width: 'auto', vertical_align: 'center', elements: [overflow] });
  }
  return {
    tag: 'column_set',
    element_id: `task_row_${rowIndex}`,
    flex_mode: 'none',
    horizontal_spacing: '8px',
    vertical_align: 'center',
    margin: '4px 0px',
    columns
  };
};

const validPage = (page: number) => Number.isFinite(page) && Number.isInteger(page) && page >= 1 ? page : 1;

const navigation = (page: number, totalPages: number) => ({
  tag: 'column_set', element_id: 'task_dashboard_navigation', flex_mode: 'none',
  columns: [
    ...(page > 1 ? [{ label: '上一页', page: page - 1 }] : []),
    { label: '刷新', page },
    ...(page < totalPages ? [{ label: '下一页', page: page + 1 }] : [])
  ].map(item => ({
    tag: 'column', width: 'auto', elements: [{
      tag: 'button', type: 'default', text: { tag: 'plain_text', content: item.label },
      behaviors: [{ type: 'callback', value: { dutydeck_task_dashboard: 'page', page: item.page } }]
    }]
  }))
});

export function buildLarkTaskDashboard(
  entries: LarkTaskDashboardEntry[],
  page = 1,
  now = Date.now()
): LarkTaskDashboardResult {
  const indexed = entries.map((entry, index): IndexedEntry => ({ entry, index, group: entry.blocked || entry.feedback === 'pending' || entry.feedback === 'needs_changes' ? 0 : groupForStatus(entry.status) }));
  const ordered = ([0, 1, 2] as DashboardGroup[]).flatMap(group => indexed
    .filter(item => item.group === group)
    .sort((left, right) => timestamp(right.entry.updatedAt) - timestamp(left.entry.updatedAt)));
  const totalPages = Math.max(1, Math.ceil(ordered.length / PAGE_SIZE));
  const currentPage = Math.min(totalPages, validPage(page));

  if (!ordered.length) {
    return {
      elements: [markdown('task_dashboard_empty', '暂无可查看的任务，可发送目标开始工作。'), navigation(1, 1)],
      page: 1,
      totalPages: 1
    };
  }

  const pageEntries = ordered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  // 全部任务同在一个工作区时，工作区名从每一行提到表头。
  const workspaces = new Set(ordered.map(item => workspaceName(item.entry.workspace)));
  const sharedWorkspace = workspaces.size === 1 ? [...workspaces][0] : undefined;
  // Agent 同一口径；任一行缺 Agent 信息就不提到表头，避免表头替缺失的行做担保。
  const agents = ordered.map(item => agentName(item.entry.agent));
  const sharedAgent = agents.every(Boolean) && new Set(agents).size === 1 ? agents[0] : undefined;
  // 不写「任务导航」标题：卡片 header 已经是这四个字（coordinator.ts 的 workflowReply
  // 用 taskName: '任务导航' 发出这张卡），正文再写一遍就是紧挨着的两行同名标题。
  const elements: Array<Record<string, any>> = [markdown(
    'task_dashboard_header',
    [`第 ${currentPage}/${totalPages} 页，共 ${ordered.length} 项。`,
      sharedWorkspace && `工作区：${escapeCardInline(sharedWorkspace)}`,
      sharedAgent && `Agent：${escapeCardInline(sharedAgent)}`]
      .filter(Boolean).join(' · ')
  )];
  let lastGroup: DashboardGroup | undefined;
  pageEntries.forEach((item, index) => {
    if (item.group !== lastGroup) {
      lastGroup = item.group;
      const groupCount = ordered.filter(candidate => candidate.group === item.group).length;
      elements.push(markdown(`task_dashboard_group_${item.group}`, `**${groupLabels[item.group]}**（${groupCount}）`));
    }
    elements.push(taskRow(item, (currentPage - 1) * PAGE_SIZE + index, now, sharedWorkspace, sharedAgent));
  });

  const nextPage = currentPage < totalPages ? currentPage + 1 : 1;
  elements.push(navigation(currentPage, totalPages));
  elements.push(markdown(
    'task_dashboard_footer',
    totalPages > 1 ? `发送 \`/tasks ${nextPage}\` 查看${currentPage < totalPages ? '下一页' : '第 1 页'}。` : '发送 `/tasks` 刷新任务列表。'
  ));
  return { elements, page: currentPage, totalPages };
}
