import { describe, expect, it } from 'vitest';
import {
  QUEUE_SUMMARY_COMPONENT_COUNT,
  QUEUE_SUMMARY_ELEMENT_ID,
  QUEUE_SUMMARY_MAX_CHARS,
  QUEUE_SUMMARY_MAX_ITEMS,
  renderQueueSummary,
  renderQueueSummaryElement,
  type QueueSummaryTask
} from './queue-summary.js';

const task = (id: string, prompt?: string): QueueSummaryTask => ({ id, prompt });

describe('renderQueueSummary', () => {
  it('无排队条目返回 undefined', () => {
    expect(renderQueueSummary([])).toBeUndefined();
  });

  it('正常渲染标题与每条一句话', () => {
    const md = renderQueueSummary([task('t1', '修登录 bug'), task('t2', '加导出按钮')]);
    expect(md).toBe('**排队 2 条**\n1. 修登录 bug\n2. 加导出按钮');
  });

  it('当前一轮停在审批上时标题写明被审批阻塞，超长输入仍守住总长上限', () => {
    expect(renderQueueSummary([task('t1', '修登录 bug')], { blockedByApproval: true })).toBe('**排队 1 条（被审批阻塞）**\n1. 修登录 bug');
    const md = renderQueueSummary(Array.from({ length: 9 }, (_, index) => task(`t${index}`, '<>&'.repeat(40))), { blockedByApproval: true })!;
    expect(md.startsWith('**排队 9 条（被审批阻塞）**')).toBe(true);
    expect(md.length).toBeLessThanOrEqual(QUEUE_SUMMARY_MAX_CHARS);
  });

  it('prompt 缺省/空白时给占位，不渲染出空行', () => {
    const md = renderQueueSummary([task('t1'), task('t2', '   ')]);
    expect(md).toBe('**排队 2 条**\n1. （无描述）\n2. （无描述）');
  });

  it('prompt 中的换行与连续空白折叠为单行', () => {
    const md = renderQueueSummary([task('t1', '第一行\n第二行\t  第三行')]);
    expect(md).toBe('**排队 1 条**\n1. 第一行 第二行 第三行');
  });

  it('prompt 含 <at> 时转义尖括号，排队摘要不产生 at', () => {
    const md = renderQueueSummary([task('t1', '<at user_id="ou_x">名字</at> 帮我干活')]);
    expect(md).toContain('&lt;at user_id="ou_x"&gt;名字&lt;/at&gt;');
    expect(md).not.toContain('<at ');
  });

  it('单条 prompt 超长截断并补省略号', () => {
    const long = '很'.repeat(200);
    const md = renderQueueSummary([task('t1', long)])!;
    const line = md.split('\n')[1]!;
    expect(line.endsWith('…')).toBe(true);
    // 序号位 + 80 字（79 个原文码点 + 省略号）
    expect(line).toHaveLength(3 + 80);
  });

  it('截断在转义之前按码点下刀，不切出半截 &amp; 实体或裸 &', () => {
    const md = renderQueueSummary([task('t1', '&'.repeat(100))])!;
    expect(md).not.toContain('�');
    // 每个 & 都必须是完整 &amp; 的一部分（去掉合法实体后不应残留 &）
    expect(md.replaceAll('&amp;', '')).not.toContain('&');
    expect(md.split('\n')[1]).toMatch(/^(?:\d+\. )?(?:&amp;)+…$/);
  });

  it('截断不切开 emoji 代理对', () => {
    const md = renderQueueSummary([task('t1', '😀'.repeat(100))])!;
    expect(md).not.toContain('�');
    const line = md.split('\n')[1]!;
    expect(line.endsWith('…')).toBe(true);
    // 79 个原文码点位被 39 个 emoji（78 UTF-16 单元）+ 省略号占用，无孤立代理
    expect(line).toHaveLength(3 + 79);
  });

  it('转义膨胀撑满总长时由 500 兜底减行，条数计入溢出提示', () => {
    const md = renderQueueSummary(Array.from({ length: 10 }, (_, index) => task(`t${index}`, '&'.repeat(100))))!;
    expect(md.length).toBeLessThanOrEqual(QUEUE_SUMMARY_MAX_CHARS);
    expect(md).toContain('…其余 9 条可在 /tasks 查看');
    expect(md.split('\n').filter(line => /^\d+\./.test(line))).toHaveLength(1);
  });

  it(`最多展示 ${QUEUE_SUMMARY_MAX_ITEMS} 条，其余条数走 /tasks 提示`, () => {
    const md = renderQueueSummary(Array.from({ length: 20 }, (_, index) => task(`t${index}`, `任务${index}`)))!;
    const lines = md.split('\n');
    expect(lines).toHaveLength(2 + QUEUE_SUMMARY_MAX_ITEMS);
    expect(lines[0]).toBe('**排队 20 条**');
    expect(lines[lines.length - 1]).toBe('…其余 15 条可在 /tasks 查看');
    expect(md).toContain('1. 任务0');
    expect(md).toContain('5. 任务4');
    expect(md).not.toContain('6. 任务5');
  });

  it('满载（20 条 × 超长 prompt）仍守住总长上限', () => {
    const tasks = Array.from({ length: 20 }, (_, index) => task(`t${index}`, `${index} `.repeat(300)));
    const md = renderQueueSummary(tasks)!;
    expect(md.length).toBeLessThanOrEqual(QUEUE_SUMMARY_MAX_CHARS);
    expect(md.split('\n').filter(line => /^\d+\./.test(line)).length).toBeLessThanOrEqual(QUEUE_SUMMARY_MAX_ITEMS);
  });

  it('恰好等于展示上限时不输出溢出提示', () => {
    const md = renderQueueSummary(Array.from({ length: QUEUE_SUMMARY_MAX_ITEMS }, (_, index) => task(`t${index}`, `任务${index}`)))!;
    expect(md).not.toContain('其余');
  });

  it('过滤掉无 id 的异常条目', () => {
    expect(renderQueueSummary([task('  ', '不该出现'), task('t1', '真实任务')]))
      .toBe('**排队 1 条**\n1. 真实任务');
  });

  it('接受结构兼容的 shared TaskRecord 形状（多余字段不影响）', () => {
    const record = { id: 't1', prompt: '兼容', status: 'queued', sessionId: 's1', createdAt: '', updatedAt: '' };
    expect(renderQueueSummary([record])).toBe('**排队 1 条**\n1. 兼容');
  });
});

describe('renderQueueSummaryElement', () => {
  it('无摘要返回 undefined', () => {
    expect(renderQueueSummaryElement([])).toBeUndefined();
  });

  it('返回单个 markdown 组件，组件数估算常量为 1', () => {
    const element = renderQueueSummaryElement([task('t1', '干活')])!;
    expect(element).toEqual({
      tag: 'markdown',
      element_id: QUEUE_SUMMARY_ELEMENT_ID,
      content: '**排队 1 条**\n1. 干活',
      text_size: 'notation',
      margin: '0px'
    });
    expect(QUEUE_SUMMARY_COMPONENT_COUNT).toBe(1);
  });
});
