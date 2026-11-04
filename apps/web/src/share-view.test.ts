import { describe, expect, it } from 'vitest';
import { conclusionPlainText, displayCommand, displayWidth, formatTurnSpan, isIndexColumn, isSequenceColumn, liveTurnFacts, nowrapColumns, rhythmBarHeight, rhythmBucketCount, rhythmBuckets, rhythmLiveSpan, shareNowLine, shareStatus, summaryTurnFacts, turnMomentWidth } from './share-view';
import { buildTimeline, buildTimelineSections, type TimelineEvent } from './timeline';
import type { DockEvent, HistoryTurnSummary, Task } from './api';

const local = (hour: number, minute: number, day = 4) => new Date(2026, 10, day, hour, minute).toISOString();

describe('分享页状态', () => {
  it('不出现工作台用语：空闲按最近一轮的结局显示，归档优先', () => {
    expect(shareStatus({ state: 'idle' }, 'completed')).toEqual({ label: '已完成', tone: 'done' });
    expect(shareStatus({ state: 'idle' }, 'failed')).toEqual({ label: '失败', tone: 'failed' });
    expect(shareStatus({ state: 'idle' })).toEqual({ label: '待开始', tone: 'neutral' });
    expect(shareStatus({ state: 'running_tool' }, 'running')).toEqual({ label: '执行中', tone: 'live' });
    expect(shareStatus({ state: 'waiting_for_permission' })).toEqual({ label: '等待授权', tone: 'waiting' });
    expect(shareStatus({ state: 'stopped' }, 'completed')).toEqual({ label: '已停止', tone: 'neutral' });
    expect(shareStatus({ state: 'running_tool', archivedAt: '2026-11-04T00:00:00Z' })).toEqual({ label: '已归档', tone: 'neutral' });
  });

  it('时间段按本地时区：完成写日期与起止，执行中只写开始，跨天带上第二个日期', () => {
    const now = Date.parse(local(15, 0));
    expect(formatTurnSpan(local(14, 37), local(14, 52), false, now)).toBe('11 月 4 日 14:37 — 14:52');
    expect(formatTurnSpan(local(14, 37), undefined, true, now)).toBe('14:37 开始');
    expect(formatTurnSpan(local(23, 50, 3), undefined, true, now)).toBe('11 月 3 日 23:50 开始');
    expect(formatTurnSpan(local(23, 50, 3), local(0, 10), false, now)).toBe('11 月 3 日 23:50 — 11 月 4 日 00:10');
    expect(formatTurnSpan(local(14, 37), undefined, false, now)).toBe('11 月 4 日 14:37');
    expect(formatTurnSpan(undefined, undefined, false, now)).toBeUndefined();
  });

  it('时刻文字的宽度档：今天只有时刻，今年别的日子带日期，往年带年份', () => {
    const now = Date.parse(local(15, 0));
    expect(turnMomentWidth(local(14, 37), now)).toBe('clock');
    expect(turnMomentWidth(local(23, 50, 3), now)).toBe('day');
    expect(turnMomentWidth(new Date(2025, 11, 31, 23, 59).toISOString(), now)).toBe('year');
    expect(turnMomentWidth(undefined, now)).toBe('clock');
  });

  it('节律直方图按开始时刻分桶，空桶为 0；时间轴长度为 0 时全部落进第一个桶', () => {
    const origin = 1_000_000;
    expect(rhythmBuckets([origin, origin + 10, origin + 950, origin + 999], origin, origin + 1_000, 10)).toEqual([2, 0, 0, 0, 0, 0, 0, 0, 0, 2]);
    expect(rhythmBuckets([origin + 2_000], origin, origin + 1_000, 4)).toEqual([0, 0, 0, 1]);
    expect(rhythmBuckets([origin, origin, origin], origin, origin, 5)).toEqual([3, 0, 0, 0, 0]);
    expect(rhythmBuckets([origin + 500, origin + 500], origin, origin + 1_000, 4)).toEqual([0, 0, 2, 0]);
    expect(rhythmBarHeight(0, 9)).toBe(0);
    expect(rhythmBarHeight(9, 9)).toBe(30);
    expect(rhythmBarHeight(1, 9)).toBeGreaterThanOrEqual(5);
    expect(rhythmBarHeight(4, 16)).toBe(rhythmBarHeight(1, 4));
    expect(rhythmBucketCount(1340)).toBe(48);
    expect(rhythmBucketCount(310)).toBe(28);
    expect(rhythmLiveSpan(0)).toBe(60_000);
    expect(rhythmLiveSpan(78_000)).toBe(120_000);
    expect(rhythmLiveSpan(121_000)).toBe(300_000);
    expect(rhythmLiveSpan(3 * 3_600_000 + 1)).toBe(4 * 3_600_000);
  });
});

const toolEvent = (data: Record<string, unknown>) => ({ id: String(data.id), type: 'tool_call', timestamp: '2026-11-04T06:45:23.545Z', data }) as unknown as TimelineEvent;

describe('执行中字幕', () => {
  // 三条输入取自 2026-11-04 抽样会话里的原始工具事件。
  it('命令去掉引号、绝对路径只留最后一段，用等宽显示', () => {
    const line = shareNowLine(toolEvent({ id: 'node', name: 'exec_command', status: 'running', input: {
      cmd: "'/data00/home/huangyuhang.edu/.nvm/versions/node/v22.22.2/bin/node' '/data00/home/huangyuhang.edu/dutydeck/.dutydeck/releases/20261103T075056Z-79cb31d-vfkGD5/dist/cli.js' session send '我会用 lark-cli 和公开网页分别检索，核对数据日期、统计口径和来源，区分抖音整体 DAU 与 IM DAU。'",
      cwd: 'file:///data00/home/huangyuhang.edu/go/src/code.byted.org/larkim/im_workspace' } }));
    expect(line).toEqual({ action: '正在运行命令', command: true,
      detail: 'node cli.js session send 我会用 lark-cli 和公开网页分别检索，核对数据日期、统计口径和来源，区分抖音整体 DAU 与 IM DAU。' });
  });

  it('工具名已在动作里时详情不再重复，中文和工具名之间留空格', () => {
    const line = shareNowLine(toolEvent({ id: 'spawn', name: 'spawn_agent', status: 'completed',
      input: { task_name: 'public_douyin_dau', agent_type: 'sol_worker', fork_turns: 'none', message: 'gAAAAABq6tTq' } }));
    expect(line).toEqual({ action: '已调用 spawn_agent', detail: undefined, command: false });
  });

  it('网页类命令保留完整网址，只去掉两侧引号', () => {
    const line = shareNowLine(toolEvent({ id: 'fetch', name: 'exec_command', status: 'completed', input: {
      cmd: "lark-cli docs +fetch --as user --doc 'https://bytedance.larkoffice.com/wiki/wikcnIRn3NDCvtVzVsiyhxVTfHc' --doc-format markdown" } }));
    expect(line).toEqual({ action: '已访问网页', command: true,
      detail: 'lark-cli docs +fetch --as user --doc https://bytedance.larkoffice.com/wiki/wikcnIRn3NDCvtVzVsiyhxVTfHc --doc-format markdown' });
  });

  it('有说明时用说明原文；还没有调用时等待模型输出', () => {
    expect(shareNowLine(toolEvent({ id: 'd', name: 'Bash', status: 'running', input: { command: 'pnpm test', description: '运行单元测试' } }))).toEqual({ action: '正在运行测试', detail: '运行单元测试', command: false });
    expect(shareNowLine()).toEqual({ action: '正在', detail: '等待模型输出', command: false });
  });

  it('displayCommand 只处理整段引号和绝对路径，网址、相对路径和普通参数原样保留', () => {
    expect(displayCommand('cat /data00/a/SKILL.md > /tmp/out/ && ls ./src "~/x y" ~/notes/todo.md /')).toBe('cat SKILL.md > out && ls ./src ~/x y todo.md /');
    expect(displayCommand('curl "https://example.com/a/b"')).toBe('curl https://example.com/a/b');
  });
});

describe('表格列', () => {
  it('显示宽度中文按 2、拉丁按 1，单元格换行取最长一行', () => {
    expect(displayWidth('抖音 DAU')).toBe(8);
    expect(displayWidth('站内分享渗透（视频、评论）')).toBe(26);
    expect(displayWidth('自动认领完成\nno_observation')).toBe(14);
  });

  it('有长列时短列整列不折行，合计超出预算的较长短列仍可折行；没有长列时都不处理', () => {
    const index = ['#', '1', '2'];
    const metric = ['指标', '抖音 DAU', '站内分享渗透（视频、评论）'];
    const value = ['数据', '7.14 亿', '21.08%'];
    const source = ['时间与来源', '2026 年 7 月，新浪财经转引野村月报；是否含极速版、火山版未明确。', '同一内部周报'];
    expect(nowrapColumns([index, metric, value, source])).toEqual([true, true, true, false]);
    expect(nowrapColumns([index, metric, value])).toEqual([false, false, false]);
    const wide = ['列', '一二三四五六七八九十一二三四'];
    expect(nowrapColumns([wide, wide, wide, source])).toEqual([true, true, false, false]);
  });

  it('序号恰好是 1..n 才算连续序号', () => {
    expect(isSequenceColumn(['1', '2', ' 3 '])).toBe(true);
    expect(isSequenceColumn(['1', '3'])).toBe(false);
    expect(isSequenceColumn(['A1', 'A2'])).toBe(false);
    expect(isSequenceColumn([])).toBe(false);
  });

  it('序号列：表头是 # / 序号 / 编号 / No.，或内容恰好是 1..n；年份、金额这类整列数字不算', () => {
    expect(isIndexColumn('#', ['a'])).toBe(true);
    expect(isIndexColumn('No.', [])).toBe(true);
    expect(isIndexColumn('排名', ['1', '2', '3'])).toBe(true);
    expect(isIndexColumn('排名', ['1', '2', '10'])).toBe(false);
    expect(isIndexColumn('年份', ['2025', '2026'])).toBe(false);
    expect(isIndexColumn('指标', ['1', '抖音'])).toBe(false);
    expect(isIndexColumn('指标', [])).toBe(false);
  });
});

describe('一轮的事实', () => {
  it('历史摘要带节律时用摘要的结束时间，没有时退回任务时间且不画节律条', () => {
    const summary: HistoryTurnSummary = { id: 'turn', taskId: 'task', firstSequence: 1, lastSequence: 9, timestamp: '2026-11-04T06:36:31.000Z', status: 'completed', prompt: { text: '问', truncated: false }, output: { text: '答', truncated: false }, toolCount: 75, artifactReferences: [] };
    const task: Pick<Task, 'createdAt' | 'updatedAt'> = { createdAt: '2026-11-04T06:37:07.000Z', updatedAt: '2026-11-04T06:52:32.000Z' };
    expect(summaryTurnFacts({ ...summary, activity: { endedAt: '2026-11-04T06:52:32.500Z', tools: [[1_000, 500]] } }, task)).toMatchObject({
      startedAt: summary.timestamp, endedAt: '2026-11-04T06:52:32.500Z', toolCount: 75, spans: [[Date.parse(summary.timestamp) + 1_000, Date.parse(summary.timestamp) + 1_500]]
    });
    const legacy = summaryTurnFacts(summary, task);
    expect(legacy).toMatchObject({ startedAt: task.createdAt, endedAt: task.updatedAt, toolCount: 75 });
    expect(legacy.spans).toBeUndefined();
  });

  it('实时轮次用已加载的工具事件计算节律，执行中的调用没有终点，最近一次调用做字幕', () => {
    const events: DockEvent[] = [
      { id: 'p', sequence: 1, type: 'text', timestamp: '2026-11-04T06:37:00.000Z', taskId: 't', data: { role: 'user', text: '问', taskId: 't' } },
      { id: 'c1', sequence: 2, type: 'tool_call', timestamp: '2026-11-04T06:37:05.000Z', taskId: 't', data: { id: 'one', name: 'exec', input: { command: 'lark-cli wiki search' } } },
      { id: 'r1', sequence: 3, type: 'tool_result', timestamp: '2026-11-04T06:37:09.000Z', taskId: 't', data: { id: 'one', status: 'completed' } },
      { id: 'c2', sequence: 4, type: 'tool_call', timestamp: '2026-11-04T06:38:00.000Z', taskId: 't', data: { id: 'two', name: 'web.search', input: { query: '抖音 DAU' } } }
    ];
    const tasks: Task[] = [{ id: 't', sessionId: 's', prompt: '问', status: 'running', createdAt: '2026-11-04T06:37:00.000Z', updatedAt: '2026-11-04T06:37:00.000Z' }];
    const facts = liveTurnFacts(buildTimelineSections(buildTimeline(events, tasks), tasks), true);
    expect(facts).toMatchObject({ prompt: '问', status: 'running', toolCount: 2, startedAt: '2026-11-04T06:37:00.000Z', endedAt: undefined });
    expect(facts.spans).toEqual([[Date.parse('2026-11-04T06:37:05.000Z'), Date.parse('2026-11-04T06:37:09.000Z')], [Date.parse('2026-11-04T06:38:00.000Z'), undefined]]);
    expect(facts.lastTool?.data.id).toBe('two');
    expect(facts.record.some(section => section.kind === 'event' && section.event.data.role === 'user')).toBe(false);
  });

  it('子任务的限流、额度诊断不计入工具调用、节律和字幕', () => {
    const hex = 'a'.repeat(64);
    const events: DockEvent[] = [
      { id: 'p', sequence: 1, type: 'text', timestamp: '2026-11-04T06:37:00.000Z', taskId: 't', data: { role: 'user', text: '问', taskId: 't' } },
      { id: 'c1', sequence: 2, type: 'tool_call', timestamp: '2026-11-04T06:37:05.000Z', taskId: 't', data: { id: 'one', name: 'exec', input: { command: 'lark-cli wiki search' } } },
      { id: 'd1', sequence: 3, type: 'status', timestamp: '2026-11-04T06:37:30.000Z', taskId: 't', data: { id: `child_diagnostic_${hex}`, state: 'child_rate_limit', diagnostic: 'child_rate_limit', code: 'rate_limit',
        activityId: 'a', parentTurnId: 'pt', childTurnId: 'ct', parentThreadId: 'pth', childThreadId: 'cth' } }
    ];
    const tasks: Task[] = [{ id: 't', sessionId: 's', prompt: '问', status: 'running', createdAt: '2026-11-04T06:37:00.000Z', updatedAt: '2026-11-04T06:37:00.000Z' }];
    const sections = buildTimelineSections(buildTimeline(events, tasks), tasks);
    // 诊断在时间线上确实以工具行出现，分享页的统计要把它排除。
    expect(sections.some(section => section.kind === 'activity' && section.groups.some(group => group.events.some(event => event.data.state === 'child_rate_limit')))).toBe(true);
    const facts = liveTurnFacts(sections, true);
    expect(facts.toolCount).toBe(1);
    expect(facts.spans).toHaveLength(1);
    expect(facts.lastTool?.data.id).toBe('one');
  });
});

describe('复制结论', () => {
  it('首行是【结论】加导语，表格逐条「指标：值（其余列）」，链接写成「文字（URL）」，末尾附详情链接', () => {
    const markdown = [
      '有更新数据：**lark-cli 找到 11 月 3 日内部周报。**', '', '截至今天（2026-11-04），查到的主要结果：', '',
      '| # | 指标 | 数据 | 时间与来源 |', '|---|---|---:|---|',
      '| 1 | 抖音 DAU | **7.14 亿** | **2026 年 7 月**，新浪财经转引野村月报。[报道](https://finance.sina.com.cn/a) |',
      '| 2 | 群发消息渗透 | **6.50%** | 同一内部周报 |', '',
      '**如果是为了算比例：**', '', '- **3 亿 ÷ 7.14 亿约为 42%**，只是跨期数字相除。', '- 这部分 **unverified**。', '',
      '最新内部依据在[《周报》](https://bytedance.larkoffice.com/wiki/x)，看 `即时通讯`。'
    ].join('\n');
    expect(conclusionPlainText(markdown, 'https://dutydeck.example/share/ses_1#token')).toBe([
      '【结论】有更新数据：lark-cli 找到 11 月 3 日内部周报。', '', '截至今天（2026-11-04），查到的主要结果：', '',
      '1. 抖音 DAU：7.14 亿（2026 年 7 月，新浪财经转引野村月报。报道（https://finance.sina.com.cn/a））',
      '2. 群发消息渗透：6.50%（同一内部周报）', '',
      '如果是为了算比例：', '', '• 3 亿 ÷ 7.14 亿约为 42%，只是跨期数字相除。', '• 这部分 unverified。', '',
      '最新内部依据在《周报》（https://bytedance.larkoffice.com/wiki/x），看 即时通讯。', '',
      '详情：https://dutydeck.example/share/ses_1#token'
    ].join('\n'));
  });

  it('整列是年份的表格复制时保留年份列', () => {
    const text = conclusionPlainText(['| 年份 | 收入 |', '|---|---:|', '| 2025 | 10 亿 |', '| 2026 | 12 亿 |'].join('\n'), 'https://x/share/s#t');
    expect(text).toBe(['【结论】', '1. 2025：10 亿', '2. 2026：12 亿', '', '详情：https://x/share/s#t'].join('\n'));
  });

  it('导语遇到紧跟的代码围栏就停；软换行两侧是英文时补空格，中文之间直接相连', () => {
    const fenced = conclusionPlainText(['结论如下：', '```sh', 'pnpm test', '```'].join('\n'), 'https://x/share/s#t');
    expect(fenced).toBe(['【结论】结论如下：', 'pnpm test', '', '详情：https://x/share/s#t'].join('\n'));
    expect(conclusionPlainText('Hello\nworld', 'u').split('\n')[0]).toBe('【结论】Hello world');
    expect(conclusionPlainText('先看结论\n再看数据', 'u').split('\n')[0]).toBe('【结论】先看结论再看数据');
    expect(conclusionPlainText('版本 v1.2\n已上线', 'u').split('\n')[0]).toBe('【结论】版本 v1.2已上线');
  });

  it('围栏按开启时的字符和长度关闭：四个反引号里嵌三个反引号、波浪线里嵌反引号，内容都原样保留', () => {
    const nested = conclusionPlainText(['结论如下：', '', '````md', '# x', '```js', '**literal**', '```', '````', '', '**后文**'].join('\n'), 'u');
    expect(nested).toBe(['【结论】结论如下：', '', '# x', '```js', '**literal**', '```', '', '后文', '', '详情：u'].join('\n'));
    const tilde = conclusionPlainText(['看示例：', '~~~', '```', '- a', '``` 不是关闭', '~~~~', '- b'].join('\n'), 'u');
    expect(tilde).toBe(['【结论】看示例：', '```', '- a', '``` 不是关闭', '• b', '', '详情：u'].join('\n'));
  });

  it('围栏里的表格和链接原样保留：四个反引号里套三个反引号、三个反引号里套波浪线', () => {
    const table = ['| a | b |', '|---|---|', '| 1 | [x](https://e.com) |'];
    const outer = conclusionPlainText(['示例：', '````md', '```', ...table, '```', '````', '后文 [y](https://f.com)'].join('\n'), 'u');
    expect(outer).toBe(['【结论】示例：', '```', ...table, '```', '后文 y（https://f.com）', '', '详情：u'].join('\n'));
    const tilde = conclusionPlainText(['示例：', '```', '~~~', ...table, '~~~', '```', '后文 [y](https://f.com)'].join('\n'), 'u');
    expect(tilde).toBe(['【结论】示例：', '~~~', ...table, '~~~', '后文 y（https://f.com）', '', '详情：u'].join('\n'));
  });

  it('首段不是段落时只写【结论】，没有序号列的表格保留第一列作为指标', () => {
    const text = conclusionPlainText(['| 服务 | 状态 | 说明 |', '|---|---|---|', '| api | 正常 | 延迟 30ms |', '| web | 告警 |  |'].join('\n'), 'https://x/share/s#t');
    expect(text).toBe(['【结论】', '1. api：正常（延迟 30ms）', '2. web：告警', '', '详情：https://x/share/s#t'].join('\n'));
  });
});
