import { describe, expect, it } from 'vitest';
import { buildLarkTaskDashboard, type LarkTaskDashboardEntry } from './task-dashboard.js';
import { parseLarkCardActionValue } from './card-actions.js';

const entry = (overrides: Partial<LarkTaskDashboardEntry> = {}): LarkTaskDashboardEntry => ({
  taskId: 'task_internal',
  title: '任务',
  workspace: '/workspace/project',
  status: 'completed',
  updatedAt: '2026-09-08T00:00:00.000Z',
  ...overrides
});

const rows = (elements: Array<Record<string, any>>) => elements.filter(element => String(element.element_id ?? '').startsWith('task_row_'));
const headerText = (elements: Array<Record<string, any>>) =>
  String(elements.find(element => element.element_id === 'task_dashboard_header')?.content ?? '');
const statusLine = (row: Record<string, any>) => rowText(row).split('\n')[1] ?? '';
const rowText = (row: Record<string, any>) => String(row.columns?.[0]?.elements?.[0]?.text?.content ?? '');
// 摘要列之后依次是「唯一主操作」按钮列与 overflow 次要操作列（存在与否随行状态而定）。
const rowControls = (row: Record<string, any>) =>
  (row.columns ?? []).slice(1).map((column: any) => column.elements?.[0]);
const rowPrimaryButton = (row: Record<string, any>) => rowControls(row).find(element => element?.tag === 'button');
const rowOverflow = (row: Record<string, any>) => rowControls(row).find(element => element?.tag === 'overflow');
const rowLinkOption = (row: Record<string, any>) =>
  rowOverflow(row)?.options?.find((option: any) => option.value === 'open_chat');

describe('buildLarkTaskDashboard', () => {
  it('groups statuses in the requested order and sorts each group by updatedAt descending', () => {
    const entries = [
      entry({ taskId: 'waiting-old', title: '待处理旧', status: 'failed', updatedAt: '2026-09-08T01:00:00Z' }),
      entry({ taskId: 'result-new', title: '结果新', status: 'completed', updatedAt: '2026-09-08T05:00:00Z' }),
      entry({ taskId: 'running-old', title: '运行旧', status: 'running', updatedAt: '2026-09-08T02:00:00Z' }),
      entry({ taskId: 'waiting-new', title: '待处理新', status: 'waiting_for_answer', updatedAt: '2026-09-08T04:00:00Z' }),
      entry({ taskId: 'running-new', title: '运行新', status: 'running_tool', updatedAt: '2026-09-08T03:00:00Z' }),
      entry({ taskId: 'result-old', title: '结果旧', status: 'unknown_status', updatedAt: '2026-09-08T00:00:00Z' })
    ];
    const snapshot = structuredClone(entries);
    const result = buildLarkTaskDashboard(entries);
    const renderedRows = rows(result.elements);

    expect(entries).toEqual(snapshot);
    expect(renderedRows.map(row => rowText(row).split('\n', 1)[0])).toEqual([
      '待处理新', '待处理旧', '运行新', '运行旧', '结果新', '结果旧'
    ]);
    expect(JSON.stringify(result.elements)).toContain('待处理');
    expect(JSON.stringify(result.elements)).toContain('运行中');
    expect(JSON.stringify(result.elements)).toContain('最近结果');
    expect(rowText(renderedRows[0]!)).toContain('等待回答');
    expect(rowText(renderedRows[2]!)).toContain('执行工具');
    expect(rowText(renderedRows[4]!)).toContain('已完成');
    expect(rowText(renderedRows[5]!)).toContain('状态待核对');
  });

  it('clamps invalid pages and keeps each page at most ten task rows', () => {
    const entries = Array.from({ length: 21 }, (_, index) => entry({
      taskId: `task-${index}`,
      title: `任务 ${index}`,
      updatedAt: `2026-09-08T00:${String(index).padStart(2, '0')}:00Z`
    }));

    const first = buildLarkTaskDashboard(entries, 0);
    const fractional = buildLarkTaskDashboard(entries, 1.5);
    const last = buildLarkTaskDashboard(entries, 99);

    expect(first).toMatchObject({ page: 1, totalPages: 3 });
    expect(fractional.page).toBe(1);
    expect(last).toMatchObject({ page: 3, totalPages: 3 });
    expect(rows(first.elements)).toHaveLength(10);
    expect(rows(last.elements)).toHaveLength(1);
    expect(JSON.stringify(first.elements)).toContain('/tasks 2');
    expect(JSON.stringify(last.elements)).toContain('/tasks 1');
  });

  it('renders the empty state without inventing a task row', () => {
    const result = buildLarkTaskDashboard([]);

    expect(result).toMatchObject({ page: 1, totalPages: 1 });
    expect(result.elements[0]).toEqual({ tag: 'markdown', element_id: 'task_dashboard_empty', content: '暂无可查看的任务，可发送目标开始工作。' });
    expect(rows(result.elements)).toHaveLength(0);
    expect(result.elements[1]?.columns[0].elements[0]).toMatchObject({ text: { content: '刷新' }, behaviors: [{ type: 'callback', value: { dutydeck_task_dashboard: 'page', page: 1 } }] });
  });

  it('offers working page callbacks without out-of-range buttons', () => {
    const entries = Array.from({ length: 21 }, (_, index) => entry({ taskId: String(index) }));
    const buttons = (page: number) => buildLarkTaskDashboard(entries, page).elements
      .find(item => item.element_id === 'task_dashboard_navigation')!.columns.map((column: any) => column.elements[0]);
    expect(buttons(1).map((button: any) => button.text.content)).toEqual(['刷新', '下一页']);
    expect(buttons(2).map((button: any) => button.behaviors[0].value)).toEqual([
      { dutydeck_task_dashboard: 'page', page: 1 }, { dutydeck_task_dashboard: 'page', page: 2 }, { dutydeck_task_dashboard: 'page', page: 3 }
    ]);
    expect(buttons(3).map((button: any) => button.text.content)).toEqual(['上一页', '刷新']);
  });

  it('uses bounded plain text for the real target and retains reasonable root workspaces', () => {
    const longTitle = '**危险**\n' + '目标'.repeat(200);
    const result = buildLarkTaskDashboard([entry({ taskId: 'secret-task-id', title: longTitle, workspace: '/', updatedAt: 'a'.repeat(200) })]);
    const summary = rowText(rows(result.elements)[0]!);
    const titleLine = summary.split('\n')[0]!;

    expect(Array.from(titleLine).length).toBeLessThanOrEqual(120);
    expect(titleLine).toContain('**危险**');
    expect(headerText(result.elements)).toContain('工作区：/');
    // 无法解析的时间戳不再被原样截断印出，而是收敛成一句话。
    expect(statusLine(rows(result.elements)[0]!)).toContain('时间未知');
    expect(summary).not.toContain('a'.repeat(20));
    expect(JSON.stringify(result.elements)).not.toContain('secret-task-id');
    expect(result.elements.find(item => item.element_id === 'task_dashboard_footer')?.tag).toBe('markdown');
  });

  it('renders update time as a relative age and lifts a shared workspace into the header', () => {
    const now = Date.parse('2026-09-10T12:00:00.000Z');
    const result = buildLarkTaskDashboard([
      entry({ taskId: 'minutes', title: '分钟档', workspace: '/srv/app', updatedAt: '2026-09-10T11:19:00.000Z' }),
      entry({ taskId: 'hours', title: '小时档', workspace: '/srv/app', updatedAt: '2026-09-10T09:00:00.000Z' }),
      entry({ taskId: 'days', title: '天档', workspace: '/srv/app', updatedAt: '2026-09-08T12:00:00.000Z' })
    ], 1, now);

    expect(headerText(result.elements)).toContain('工作区：app');
    expect(rows(result.elements).map(statusLine)).toEqual([
      '已完成 · 41 分钟前', '已完成 · 3 小时前', '已完成 · 2 天前'
    ]);
    // 表头已经写了工作区，行内不再逐行重复。
    for (const row of rows(result.elements)) expect(rowText(row)).not.toContain('工作区');
  });

  it('keeps the workspace on every row when tasks span more than one workspace', () => {
    const now = Date.parse('2026-09-10T12:00:00.000Z');
    const result = buildLarkTaskDashboard([
      entry({ taskId: 'one', title: 'A', workspace: '/srv/one', updatedAt: '2026-09-10T11:59:30.000Z' }),
      entry({ taskId: 'two', title: 'B', workspace: '/srv/two', updatedAt: '2026-09-10T11:59:00.000Z' })
    ], 1, now);

    expect(headerText(result.elements)).not.toContain('工作区');
    expect(rows(result.elements).map(statusLine)).toEqual([
      '已完成 · 刚刚 · one', '已完成 · 1 分钟前 · two'
    ]);
  });

  it('把返回原会话收进 overflow 菜单，并复用 safeLarkWebUrl 校验链接', () => {
    const entries = [
      entry({ taskId: 'valid-feishu', title: '飞书链接', url: 'https://applink.feishu.cn/client/bot/open?appId=cli_1' }),
      entry({ taskId: 'valid-lark', title: 'Lark 链接', url: 'https://applink.larksuite.com/client/bot/open?appId=cli_2' }),
      entry({ taskId: 'javascript', title: '脚本链接', url: 'javascript:alert(1)' }),
      // safeLarkWebUrl 只按协议放行 http/https，不再做 applink 主机白名单（与进度卡 Web 出口同一份校验）。
      entry({ taskId: 'http', title: '普通 http 链接', url: 'http://applink.feishu.cn/client/bot/open?appId=cli_3' }),
      entry({ taskId: 'evil-host', title: '伪造域名', url: 'https://applink.feishu.cn.evil.example/client/bot/open' }),
      entry({ taskId: 'custom-scheme', title: '自定义协议', url: 'lark://applink.feishu.cn/client/bot/open?appId=cli_4' })
    ];
    const result = buildLarkTaskDashboard(entries);
    const renderedRows = rows(result.elements);

    expect(renderedRows.map(row => rowLinkOption(row)?.multi_url?.url)).toEqual([
      'https://applink.feishu.cn/client/bot/open?appId=cli_1',
      'https://applink.larksuite.com/client/bot/open?appId=cli_2',
      undefined,
      'http://applink.feishu.cn/client/bot/open?appId=cli_3',
      'https://applink.feishu.cn.evil.example/client/bot/open',
      undefined
    ]);
    // 纯跳转菜单不挂任何 callback behaviors。
    for (const row of renderedRows) {
      const overflow = rowOverflow(row);
      if (overflow) expect(overflow.behaviors).toBeUndefined();
    }
  });

  it('每行只给一个主操作，回调 value 与 card-actions 解析器完全同构', () => {
    const cases: Array<{ status: string; label?: string; action?: string; type?: string }> = [
      { status: 'queued', label: '取消', action: 'cancel', type: 'default' },
      { status: 'running', label: '中断', action: 'interrupt', type: 'danger' },
      { status: 'thinking', label: '中断', action: 'interrupt', type: 'danger' },
      { status: 'running_tool', label: '中断', action: 'interrupt', type: 'danger' },
      { status: 'failed', label: '重试', action: 'retry', type: 'primary' },
      { status: 'interrupted', label: '重试', action: 'retry', type: 'primary' },
      { status: 'completed' },
      { status: 'cancelled', action: 'retry', label: '重试', type: 'primary' },
      { status: 'waiting_for_answer' },
      { status: 'unknown_status' }
    ];
    const result = buildLarkTaskDashboard(cases.map(item => entry({
      taskId: `runtime_${item.status}`,
      title: item.status,
      status: item.status,
      actionTaskId: 'om_dashboard_row',
      turn: 7,
      updatedAt: '2026-09-08T00:00:00Z'
    })));
    // 渲染会按待处理/运行中/最近结果重排，按标题（状态名）找回各自的行。
    const rowByTitle = new Map(rows(result.elements).map(row => [rowText(row).split('\n', 1)[0], row]));

    for (const item of cases) {
      const button = rowPrimaryButton(rowByTitle.get(item.status)!);
      if (!item.action) {
        expect(button, `${item.status} 不应有主操作`).toBeUndefined();
        continue;
      }
      expect(button?.text.content).toBe(item.label);
      expect(button?.type).toBe(item.type);
      const value = button?.behaviors?.[0]?.value;
      // value 与进度卡按钮同形：主控无需新增解析分支，parseLarkCardActionValue 直接认识。
      expect(value).toEqual({ action: item.action, task_id: 'om_dashboard_row', turn: '7' });
      expect(parseLarkCardActionValue(value)).toEqual({ action: item.action, taskId: 'om_dashboard_row', turn: 7 });
    }
  });

  it('待决审批行主操作固定为审批，拒绝收进 overflow，均走 workflow CAS value', () => {
    const result = buildLarkTaskDashboard([
      // 即便任务还在 running，审批也优先于中断。
      entry({ taskId: 'runtime-approve', title: '审批中', status: 'running', turn: 3, actionTaskId: 'om_task',
        pendingApproval: { requestId: 'wf_24x', generation: 'boot-1' } })
    ]);
    const row = rows(result.elements)[0]!;
    const button = rowPrimaryButton(row)!;
    expect(button.text.content).toBe('审批');
    expect(button.behaviors[0].value).toEqual({ dutydeck_workflow: 'approve', request_id: 'wf_24x', generation: 'boot-1' });
    // 不能退化成任务状态操作。
    expect(parseLarkCardActionValue(button.behaviors[0].value)).toBeUndefined();

    const overflow = rowOverflow(row)!;
    expect(overflow.options.map((option: any) => option.text.content)).toEqual(['拒绝']);
    expect(overflow.behaviors).toEqual([{ type: 'callback', value: { dutydeck_workflow: 'reject', request_id: 'wf_24x', generation: 'boot-1' } }]);
  });

  it('审批信息缺 id 或缺 generation 时不渲染任何审批入口', () => {
    const result = buildLarkTaskDashboard([
      entry({ taskId: 'a', title: '缺 id', status: 'waiting_for_permission', pendingApproval: { requestId: '', generation: 'boot' } }),
      entry({ taskId: 'b', title: '缺世代', status: 'waiting_for_permission', pendingApproval: { requestId: 'wf_1', generation: '' } })
    ]);
    for (const row of rows(result.elements)) {
      expect(rowPrimaryButton(row)).toBeUndefined();
      expect(rowOverflow(row)).toBeUndefined();
    }
  });

  it('显式不可重试的失败/中断行不出现重试；缺 actionTaskId 时不渲染任务操作', () => {
    const result = buildLarkTaskDashboard([
      entry({ taskId: 'runtime-no-retry', title: '作废', status: 'failed', retryable: false, actionTaskId: 'om_1', turn: 1 }),
      entry({ taskId: 'runtime-no-id', title: '排队', status: 'queued' })
    ]);
    const [notRetryable, noActionId] = rows(result.elements);
    expect(rowPrimaryButton(notRetryable!)).toBeUndefined();
    expect(rowPrimaryButton(noActionId!)).toBeUndefined();
  });

  it('终态行不产生任何回调动作，只允许 overflow 里的跳转出口', () => {
    const result = buildLarkTaskDashboard([
      entry({ taskId: 'runtime-done', title: '已完成', status: 'completed', actionTaskId: 'om_done', turn: 2,
        url: 'https://applink.feishu.cn/client/chat/open?openChatId=oc_x' })
    ]);
    const row = rows(result.elements)[0]!;
    expect(rowPrimaryButton(row)).toBeUndefined();
    expect(JSON.stringify(row)).not.toContain('"callback"');
    expect(rowLinkOption(row)?.multi_url?.url).toBe('https://applink.feishu.cn/client/chat/open?openChatId=oc_x');
  });

  it('不把 runtime 任务 id 与发起人 open_id 渲染进卡片', () => {
    const result = buildLarkTaskDashboard([
      entry({ taskId: 'runtime-secret', title: '任务', status: 'queued', actionTaskId: 'om_visible', turn: 1,
        ownerOpenId: 'ou_owner_secret' })
    ]);
    const serialized = JSON.stringify(result.elements);
    expect(serialized).not.toContain('runtime-secret');
    expect(serialized).not.toContain('ou_owner_secret');
    // 回调所需的飞书消息 id 与轮次仍然保留。
    expect(rowPrimaryButton(rows(result.elements)[0]!)?.behaviors?.[0]?.value).toEqual({ action: 'cancel', task_id: 'om_visible', turn: '1' });
  });

  it('缺轮次时回调 value 退化为遗留形态 {action,task_id}，仍可被解析', () => {
    const result = buildLarkTaskDashboard([
      entry({ taskId: 'runtime-legacy', title: '排队', status: 'queued', actionTaskId: 'om_legacy' })
    ]);
    const value = rowPrimaryButton(rows(result.elements)[0]!)?.behaviors?.[0]?.value;
    expect(value).toEqual({ action: 'cancel', task_id: 'om_legacy' });
    expect(parseLarkCardActionValue(value)).toEqual({ action: 'cancel', taskId: 'om_legacy' });
  });

  // 递归统计卡片组件数：每个带 tag 的节点（含 column、text、option 文案）都计 1，
  // 与飞书整卡 ≤180 组件的口径保持同向（宁可多算）。
  const countComponents = (node: unknown): number => {
    if (!node || typeof node !== 'object') return 0;
    if (Array.isArray(node)) return node.reduce((sum, child) => sum + countComponents(child), 0);
    const record = node as Record<string, unknown>;
    return (typeof record.tag === 'string' ? 1 : 0) +
      Object.values(record).reduce((sum, value) => sum + countComponents(value), 0);
  };

  it('满页 10 行（每行主操作+审批拒绝+跳转）整卡守住 180 组件 / 24KB 预算', () => {
    const entries = Array.from({ length: 10 }, (_, index) => entry({
      taskId: `runtime_${index}`,
      title: `满载任务 ${index}`,
      workspace: '/workspace/project',
      status: 'waiting_for_permission',
      updatedAt: '2026-09-08T00:00:00.000Z',
      url: 'https://applink.feishu.cn/client/chat/open?openChatId=oc_dashboard',
      actionTaskId: `om_row_${index}`,
      turn: index,
      pendingApproval: { requestId: `wf_${index}`, generation: `boot_${index}` }
    }));
    const result = buildLarkTaskDashboard(entries);
    const serialized = JSON.stringify(result.elements);

    expect(rows(result.elements)).toHaveLength(10);
    expect(countComponents(result.elements)).toBeLessThanOrEqual(180);
    expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThan(24 * 1024);
  });

  it('bounds dynamic fields and the serialized output for ten adversarial entries', () => {
    const huge = '长字段'.repeat(10_000);
    const entries = Array.from({ length: 10 }, (_, index) => entry({
      taskId: huge,
      title: huge,
      workspace: huge,
      status: 'completed',
      updatedAt: huge,
      url: index === 0 ? 'https://applink.feishu.cn/client/bot/open?appId=ok' : undefined
    }));
    const result = buildLarkTaskDashboard(entries);

    expect(rows(result.elements)).toHaveLength(10);
    expect(Buffer.byteLength(JSON.stringify(result.elements), 'utf8')).toBeLessThan(24 * 1024);
    expect(Array.from(headerText(result.elements)).length).toBeLessThanOrEqual(160);
    for (const row of rows(result.elements)) {
      expect(Array.from(rowText(row).split('\n')[0] ?? '').length).toBeLessThanOrEqual(120);
      expect(Array.from(statusLine(row)).length).toBeLessThanOrEqual(160);
      expect(rowText(row).split('\n')).toHaveLength(2);
    }
  });
});
