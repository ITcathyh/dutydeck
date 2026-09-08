export interface LarkTaskDashboardEntry {
  taskId: string;
  title: string;
  workspace: string;
  status: string;
  updatedAt: string;
  url?: string;
  feedback?: 'pending' | 'accepted' | 'needs_changes';
}

export interface LarkTaskDashboardResult {
  elements: Array<Record<string, any>>;
  page: number;
  totalPages: number;
}

const PAGE_SIZE = 10;
const MAX_TITLE_CHARS = 120;
const MAX_WORKSPACE_CHARS = 120;
const MAX_UPDATED_AT_CHARS = 64;
const MAX_URL_CHARS = 512;

const waitingStatuses = new Set(['waiting_for_permission', 'waiting_for_answer', 'failed', 'interrupted']);
const runningStatuses = new Set(['queued', 'running', 'thinking', 'running_tool']);

const statusLabels: Record<string, string> = {
  waiting_for_permission: '等待审批',
  waiting_for_answer: '等待回答',
  failed: '失败',
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

const statusLabel = (status: unknown) => {
  const key = String(status ?? '').trim().toLowerCase();
  return statusLabels[key] ?? '已结束';
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

const validAppLink = (value: unknown) => {
  const candidate = typeof value === 'string' ? value.trim() : '';
  if (!candidate || candidate.length > MAX_URL_CHARS || /[\u0000-\u0020]/u.test(candidate)) return undefined;
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return undefined;
    if (url.hostname !== 'applink.feishu.cn' && url.hostname !== 'applink.larksuite.com') return undefined;
    return candidate;
  } catch {
    return undefined;
  }
};

const markdown = (elementId: string, content: string) => ({
  tag: 'markdown', element_id: elementId, content
});

const taskRow = (item: IndexedEntry, rowIndex: number) => {
  const entry = item.entry;
  const title = compactText(entry.title, MAX_TITLE_CHARS, '未命名任务');
  const workspace = workspaceName(entry.workspace);
  const updatedAt = compactText(entry.updatedAt, MAX_UPDATED_AT_CHARS, '未知');
  const feedback = entry.feedback ? ` · 验收：${({ pending: '待验收', accepted: '已通过', needs_changes: '需要修改' })[entry.feedback]}` : '';
  const summary = `${title}\n工作区：${workspace}\n状态：${statusLabel(entry.status)}${feedback} · 更新时间：${updatedAt}`;
  const url = validAppLink(entry.url);
  const summaryElement = {
    tag: 'div',
    text: { tag: 'plain_text', content: summary, lines: 4 },
    width: 'auto',
    margin: '0px'
  };
  const columns: Array<Record<string, any>> = [{
    tag: 'column', width: url ? 'weighted' : 'auto', ...(url ? { weight: 1 } : {}),
    vertical_align: 'center', elements: [summaryElement]
  }];
  if (url) {
    columns.push({
      tag: 'column', width: 'auto', vertical_align: 'center', elements: [{
        tag: 'button',
        type: 'default',
        text: { tag: 'plain_text', content: '返回原会话' },
        behaviors: [{ type: 'open_url', default_url: url }]
      }]
    });
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

export function buildLarkTaskDashboard(
  entries: LarkTaskDashboardEntry[],
  page = 1
): LarkTaskDashboardResult {
  const indexed = entries.map((entry, index): IndexedEntry => ({ entry, index, group: entry.feedback === 'pending' || entry.feedback === 'needs_changes' ? 0 : groupForStatus(entry.status) }));
  const ordered = ([0, 1, 2] as DashboardGroup[]).flatMap(group => indexed
    .filter(item => item.group === group)
    .sort((left, right) => timestamp(right.entry.updatedAt) - timestamp(left.entry.updatedAt)));
  const totalPages = Math.max(1, Math.ceil(ordered.length / PAGE_SIZE));
  const currentPage = Math.min(totalPages, validPage(page));

  if (!ordered.length) {
    return {
      elements: [markdown('task_dashboard_empty', '暂无可查看的任务，可发送目标开始工作。')],
      page: 1,
      totalPages: 1
    };
  }

  const pageEntries = ordered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const elements: Array<Record<string, any>> = [markdown(
    'task_dashboard_header',
    `**任务导航**\n第 ${currentPage}/${totalPages} 页，共 ${ordered.length} 项。`
  )];
  let lastGroup: DashboardGroup | undefined;
  pageEntries.forEach((item, index) => {
    if (item.group !== lastGroup) {
      lastGroup = item.group;
      const groupCount = ordered.filter(candidate => candidate.group === item.group).length;
      elements.push(markdown(`task_dashboard_group_${item.group}`, `**${groupLabels[item.group]}**（${groupCount}）`));
    }
    elements.push(taskRow(item, (currentPage - 1) * PAGE_SIZE + index));
  });

  const nextPage = currentPage < totalPages ? currentPage + 1 : 1;
  elements.push(markdown(
    'task_dashboard_footer',
    totalPages > 1 ? `发送 \`/tasks ${nextPage}\` 查看${currentPage < totalPages ? '下一页' : '第 1 页'}。` : '发送 `/tasks` 刷新任务列表。'
  ));
  return { elements, page: currentPage, totalPages };
}
