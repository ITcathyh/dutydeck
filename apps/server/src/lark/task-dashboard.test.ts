import { describe, expect, it } from 'vitest';
import { buildLarkTaskDashboard, type LarkTaskDashboardEntry } from './task-dashboard.js';

const entry = (overrides: Partial<LarkTaskDashboardEntry> = {}): LarkTaskDashboardEntry => ({
  taskId: 'task_internal',
  title: '任务',
  workspace: '/workspace/project',
  status: 'completed',
  updatedAt: '2026-09-08T00:00:00.000Z',
  ...overrides
});

const rows = (elements: Array<Record<string, any>>) => elements.filter(element => String(element.element_id ?? '').startsWith('task_row_'));
const rowText = (row: Record<string, any>) => String(row.columns?.[0]?.elements?.[0]?.text?.content ?? '');
const rowButton = (row: Record<string, any>) => row.columns?.[1]?.elements?.[0];

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
    expect(rowText(renderedRows[5]!)).toContain('已结束');
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

    expect(result).toEqual({
      elements: [{ tag: 'markdown', element_id: 'task_dashboard_empty', content: '暂无可查看的任务，可发送目标开始工作。' }],
      page: 1,
      totalPages: 1
    });
  });

  it('uses bounded plain text for the real target and retains reasonable root workspaces', () => {
    const longTitle = '**危险**\n' + '目标'.repeat(200);
    const result = buildLarkTaskDashboard([entry({ taskId: 'secret-task-id', title: longTitle, workspace: '/', updatedAt: 'a'.repeat(200) })]);
    const summary = rowText(rows(result.elements)[0]!);
    const titleLine = summary.split('\n')[0]!;

    expect(Array.from(titleLine).length).toBeLessThanOrEqual(120);
    expect(titleLine).toContain('**危险**');
    expect(summary).toContain('工作区：/');
    expect(summary).toContain('更新时间：');
    expect(JSON.stringify(result.elements)).not.toContain('secret-task-id');
    expect(result.elements[3]?.tag).toBe('markdown');
  });

  it('adds an open_url button only for approved HTTPS Feishu or Lark applinks', () => {
    const entries = [
      entry({ taskId: 'valid-feishu', title: '飞书链接', url: 'https://applink.feishu.cn/client/bot/open?appId=cli_1' }),
      entry({ taskId: 'valid-lark', title: 'Lark 链接', url: 'https://applink.larksuite.com/client/bot/open?appId=cli_2' }),
      entry({ taskId: 'javascript', title: '脚本链接', url: 'javascript:alert(1)' }),
      entry({ taskId: 'http', title: '不安全协议', url: 'http://applink.feishu.cn/client/bot/open?appId=cli_3' }),
      entry({ taskId: 'evil-host', title: '伪造域名', url: 'https://applink.feishu.cn.evil.example/client/bot/open' }),
      entry({ taskId: 'custom-scheme', title: '自定义协议', url: 'lark://applink.feishu.cn/client/bot/open?appId=cli_4' })
    ];
    const result = buildLarkTaskDashboard(entries);
    const renderedRows = rows(result.elements);

    expect(renderedRows.map(row => rowButton(row)?.behaviors?.[0]?.default_url)).toEqual([
      'https://applink.feishu.cn/client/bot/open?appId=cli_1',
      'https://applink.larksuite.com/client/bot/open?appId=cli_2',
      undefined, undefined, undefined, undefined
    ]);
    expect(renderedRows.filter(row => rowButton(row)).length).toBe(2);
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
    for (const row of rows(result.elements)) {
      expect(Array.from(rowText(row).split('\n')[0] ?? '').length).toBeLessThanOrEqual(120);
      expect(Array.from(rowText(row).split('\n')[1]?.replace('工作区：', '') ?? '').length).toBeLessThanOrEqual(120);
      expect(Array.from(rowText(row).split('\n')[3]?.replace('更新时间：', '') ?? '').length).toBeLessThanOrEqual(64);
    }
  });
});
