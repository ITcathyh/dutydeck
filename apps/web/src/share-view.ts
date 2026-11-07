import { isBackgroundFollowup } from '@dutydeck/shared';
import type { HistoryTurnSummary, Session, Task } from './api';
import { isChildDiagnostic, toolCommand, toolDescription, type TimelineEvent, type TimelineSection } from './timeline';
import { toolActionLabel, toolPresentation } from './tool-presentation';

/*
  只读分享页的呈现规则。页面读者是飞书群里的同事，不是工作台操作者：
  状态只回答「这件事做完了没有、结果如何」，不出现「可继续」「实时同步」这类工作台用语。
*/

export type ShareTone = 'done' | 'live' | 'waiting' | 'failed' | 'neutral';
export type ShareStatus = { label: string; tone: ShareTone };

export const turnStatusLabels: Record<string, string> = {
  completed: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断', unverified: '结果未确认',
  reconcile_required: '结果未确认', incomplete: '未完成', running: '执行中', queued: '排队中'
};

/** 归档优先，其次是会话此刻在做的事，最后是最近一轮的结局。 */
export function shareStatus(session: Pick<Session, 'state' | 'archivedAt'>, turnStatus?: string): ShareStatus {
  if (session.archivedAt) return { label: '已归档', tone: 'neutral' };
  switch (session.state) {
    case 'waiting_for_permission': return { label: '等待授权', tone: 'waiting' };
    case 'waiting_for_answer': return { label: '等待回答', tone: 'waiting' };
    case 'starting': case 'thinking': case 'running_tool': return { label: '执行中', tone: 'live' };
    case 'interrupting': return { label: '正在停止', tone: 'live' };
    case 'failed': return { label: '失败', tone: 'failed' };
    case 'stopped': return { label: '已停止', tone: 'neutral' };
    case 'interrupted': return { label: '已中断', tone: 'neutral' };
  }
  if (turnStatus === 'completed') return { label: '已完成', tone: 'done' };
  if (turnStatus === 'failed') return { label: '失败', tone: 'failed' };
  return { label: turnStatus ? turnStatusLabels[turnStatus] ?? '状态待确认' : '待开始', tone: 'neutral' };
}

/** 一次工具调用的起止（毫秒时间戳）；仍在执行的调用没有终点。 */
export type ToolSpan = [start: number, end: number | undefined];

export type TurnFacts = {
  prompt?: string;
  /** 最终输出；带 parts 时保留非文字内容。 */
  output?: { text?: string; parts?: unknown };
  outputTruncated?: boolean;
  status: string;
  startedAt?: string;
  endedAt?: string;
  toolCount: number;
  /** 旧摘要没有节律数据时为空，此时只显示次数。 */
  spans?: ToolSpan[];
  lastTool?: TimelineEvent;
  /** 展开「执行过程」时显示的内容：去掉提问和最终输出后的完整记录。 */
  record: TimelineSection[];
};

const isPrompt = (section: TimelineSection) => section.kind === 'event' && section.event.type === 'text' && section.event.data.role === 'user' && !section.event.data.steering;
// 子任务的限流、额度诊断在时间线上借用工具行显示，但不是工具调用：不计次数、不进节律、不做字幕。
const isTool = (event: TimelineEvent) => (event.type === 'tool_call' || event.type === 'tool_result') && !isChildDiagnostic(event.data);

export function finalSection(sections: TimelineSection[]) {
  return sections.find((section): section is Extract<TimelineSection, { kind: 'event' }> => section.kind === 'event' && section.final);
}

/** 分享页不显示后台任务结束后的回答：它不属于任何一轮，已发出的链接内容也不因它变化。 */
export function shareableEvents<T extends { data?: unknown }>(events: T[]) {
  return events.filter(event => !isBackgroundFollowup(event));
}

/** 一轮的展开记录：提问已在英雄区或引语里，最终输出在结论卡里，这里不再重复。 */
export function recordSections(sections: TimelineSection[]) {
  const final = finalSection(sections);
  return sections.filter(section => section !== final && !isPrompt(section) && !(section.kind === 'event' && isBackgroundFollowup(section.event)));
}

export function liveTurnFacts(sections: TimelineSection[], running: boolean): TurnFacts {
  const prompt = sections.find(isPrompt);
  const final = finalSection(sections);
  const activity = sections.find((section): section is Extract<TimelineSection, { kind: 'activity' }> => section.kind === 'activity');
  const tools = activity?.groups.flatMap(group => group.events.filter(isTool)) ?? [];
  const spans = tools.flatMap((tool): ToolSpan[] => {
    const start = Date.parse(String(tool.data.startedAt ?? tool.timestamp));
    if (!Number.isFinite(start)) return [];
    const end = typeof tool.data.completedAt === 'string' ? Date.parse(tool.data.completedAt) : undefined;
    return [[start, end !== undefined && Number.isFinite(end) ? end : running ? undefined : start]];
  }).sort((left, right) => left[0] - right[0]);
  const lastTool = tools.reduce<TimelineEvent | undefined>((latest, tool) => !latest || String(tool.data.startedAt ?? tool.timestamp) >= String(latest.data.startedAt ?? latest.timestamp) ? tool : latest, undefined);
  return {
    prompt: prompt?.kind === 'event' ? prompt.event.data.text : undefined,
    output: final?.event.data,
    status: running ? 'running' : activity?.taskStatus ?? (final ? 'completed' : 'incomplete'),
    startedAt: (prompt?.kind === 'event' ? prompt.event.timestamp : undefined) ?? activity?.startedAt ?? final?.event.timestamp,
    endedAt: running ? undefined : activity?.completedAt ?? final?.event.timestamp,
    toolCount: tools.length,
    spans,
    lastTool,
    record: recordSections(sections)
  };
}

/** 用时：摘要带结束时间就用它，否则退回 task 的创建到更新。 */
export function summaryTurnFacts(summary: HistoryTurnSummary, task?: Pick<Task, 'createdAt' | 'updatedAt'>): TurnFacts {
  const origin = Date.parse(summary.timestamp);
  const activity = summary.activity && Number.isFinite(origin) ? summary.activity : undefined;
  return {
    prompt: summary.prompt.text,
    output: summary.output.text ? { text: summary.output.text } : undefined,
    outputTruncated: summary.output.truncated,
    status: summary.status,
    startedAt: activity ? summary.timestamp : task?.createdAt ?? summary.timestamp,
    endedAt: activity?.endedAt ?? task?.updatedAt,
    toolCount: summary.toolCount,
    spans: activity?.tools.map(([offset, duration]): ToolSpan => [origin + offset, origin + offset + duration]),
    record: []
  };
}

/** 命令只改显示：去掉参数两侧的引号，绝对路径只留最后一段（`'/x/bin/node'` 显示为 `node`）。 */
export function displayCommand(command: string) {
  return (command.match(/'[^']*'|"[^"]*"|\S+/g) ?? []).map(token => {
    const bare = /^(['"])([\s\S]*)\1$/.exec(token)?.[2] ?? token;
    return /^~?\/\S+$/.test(bare) ? bare.replace(/\/+$/, '').split('/').at(-1) || bare : bare;
  }).join(' ');
}

export type ShareNowLine = { action: string; detail?: string; command: boolean };

/** 执行中字幕：最近一次工具调用写成「动作 详情」。动作里已有的工具名不在详情里重复；详情是命令时按 displayCommand 缩写。 */
export function shareNowLine(tool?: TimelineEvent): ShareNowLine {
  if (!tool) return { action: '正在', detail: '等待模型输出', command: false };
  const presentation = toolPresentation(tool.data);
  const action = toolActionLabel(presentation, tool.data.status === 'completed' || tool.data.status === 'failed').replace(/(?<=[\u4e00-\u9fff])(?=[A-Za-z0-9])/g, ' ');
  const description = toolDescription(tool.data);
  let detail = description ?? presentation.detail ?? presentation.label;
  const command = !description && detail === toolCommand(tool.data.input);
  const name = typeof tool.data.name === 'string' ? tool.data.name.trim() : '';
  for (const repeated of [name, presentation.label]) {
    if (repeated && action.includes(repeated) && (detail === repeated || detail.startsWith(`${repeated} `))) detail = detail.slice(repeated.length).trim();
  }
  return { action, detail: (command ? displayCommand(detail) : detail) || undefined, command: command && Boolean(detail) };
}

/** 节律直方图的桶数按条宽决定：手机约 28、桌面约 48。 */
export function rhythmBucketCount(width: number) {
  return Math.round(Math.min(48, Math.max(28, 28 + (width - 320) * 20 / 700)));
}

/** 每次调用按开始时刻落进一个时间桶；时间轴长度为 0（全部挤在同一时刻）时都落进第一个桶。 */
export function rhythmBuckets(starts: number[], origin: number, finish: number, count: number) {
  const buckets = Array.from({ length: count }, () => 0);
  const total = finish - origin;
  for (const start of starts) {
    const ratio = total > 0 ? (start - origin) / total : 0;
    buckets[Math.min(count - 1, Math.max(0, Math.floor(ratio * count)))]! += 1;
  }
  return buckets;
}

const liveSteps = [1, 2, 5, 10, 15, 20, 30, 45, 60, 90, 120].map(minutes => minutes * 60_000);

/** 执行中时间轴取不短于已耗时的整档长度，只在跨档时整体换算；平时新调用从左往右填进空桶，柱子不会每秒挪位。 */
export function rhythmLiveSpan(elapsed: number) {
  return liveSteps.find(step => step >= elapsed) ?? Math.ceil(elapsed / 3_600_000) * 3_600_000;
}

/** 桶高：按次数开平方，最少的也看得见；空桶为 0，由样式画成淡色短桩。 */
export function rhythmBarHeight(value: number, max: number, min = 5, full = 30) {
  return value > 0 && max > 0 ? Math.round(min + (full - min) * Math.sqrt(value) / Math.sqrt(max)) : 0;
}

export function turnTone(status: string): ShareTone {
  return status === 'completed' ? 'done' : status === 'failed' ? 'failed' : status === 'running' || status === 'queued' ? 'live' : 'neutral';
}

/** 表格列按「中文 2、拉丁 1」估算显示宽度；单元格内换行时取最长的一行。 */
const wide = /[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6\u{20000}-\u{3fffd}]/u;
export function displayWidth(text: string) {
  return Math.max(0, ...text.split('\n').map(line => Array.from(line.trim()).reduce((width, char) => width + (wide.test(char) ? 2 : 1), 0)));
}

/** 序号列的内容恰好是 1..n 时，窄屏卡片不再显示序号。 */
export const isSequenceColumn = (cells: string[]) => cells.length > 0 && cells.every((cell, row) => cell.trim() === String(row + 1));

/** 序号列：表头是 # / 序号 / 编号 / No.，或者内容恰好是 1..n。只是整列数字（年份、金额）不算。 */
export const isIndexColumn = (header: string, cells: string[]) => /^(#|序号|编号|no\.?)$/i.test(header.trim()) || isSequenceColumn(cells);

/**
 * 哪些列整列不折行：表里有长列时，短列（不超过约 14 个汉字宽）按从短到长整列 nowrap，
 * 合计不超过约 32 个汉字宽，其余宽度留给长列。没有长列时交给浏览器自动排版。
 */
export function nowrapColumns(columns: string[][], short = 28, budget = 64) {
  const widths = columns.map(cells => Math.max(0, ...cells.map(displayWidth)));
  const result = widths.map(() => false);
  if (!widths.some(width => width > short)) return result;
  let used = 0;
  for (const index of widths.map((_, index) => index).sort((left, right) => widths[left]! - widths[right]!)) {
    if (widths[index]! > short || used + widths[index]! > budget) break;
    used += widths[index]!;
    result[index] = true;
  }
  return result;
}

const pad = (value: number) => String(value).padStart(2, '0');
const clock = (date: Date) => `${pad(date.getHours())}:${pad(date.getMinutes())}`;
const sameDay = (left: Date, right: Date) => left.toDateString() === right.toDateString();
const day = (date: Date, now: Date) => `${date.getFullYear() === now.getFullYear() ? '' : `${date.getFullYear()} 年 `}${date.getMonth() + 1} 月 ${date.getDate()} 日`;

/** 按浏览器本地时区：完成「11 月 4 日 14:37 — 14:52」，执行中「14:37 开始」；没有结束时间只写开始时刻。 */
export function formatTurnSpan(startedAt: string | undefined, endedAt: string | undefined, running: boolean, now = Date.now()) {
  const start = new Date(startedAt ?? '');
  if (Number.isNaN(start.getTime())) return;
  const today = new Date(now);
  if (running) return `${sameDay(start, today) ? '' : `${day(start, today)} `}${clock(start)} 开始`;
  const end = new Date(endedAt ?? '');
  if (Number.isNaN(end.getTime())) return `${day(start, today)} ${clock(start)}`;
  return `${day(start, today)} ${clock(start)} — ${sameDay(start, end) ? '' : `${day(end, today)} `}${clock(end)}`;
}

/** 更早一轮那一行只写时刻；不是今天的再带上日期。 */
export function formatTurnMoment(startedAt?: string, now = Date.now()) {
  const start = new Date(startedAt ?? '');
  if (Number.isNaN(start.getTime())) return;
  const today = new Date(now);
  return sameDay(start, today) ? clock(start) : `${day(start, today)} ${clock(start)}`;
}

/** 时刻文字的宽度档：只有时刻、带日期、带年份。更早轮次那一组按最宽的一档给时间列留宽，提问摘要的起点才对齐。 */
export type MomentWidth = 'clock' | 'day' | 'year';
export function turnMomentWidth(startedAt?: string, now = Date.now()): MomentWidth {
  const start = new Date(startedAt ?? '');
  const today = new Date(now);
  if (Number.isNaN(start.getTime()) || sameDay(start, today)) return 'clock';
  return start.getFullYear() === today.getFullYear() ? 'day' : 'year';
}

const markdownLink = /!?\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
function plainInline(text: string) {
  return text
    .replace(markdownLink, (_, label: string, href: string) => !label || label === href ? href : `${label}（${href}）`)
    .replace(/<((?:https?|mailto):[^>\s]+)>/g, '$1')
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, '$1');
}
const tableCells = (line: string) => line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(/(?<!\\)\|/).map(cell => plainInline(cell.trim()));
const isTableRow = (line?: string) => Boolean(line && /^\s*\|.*\|\s*$/.test(line));
const isTableDivider = (line?: string) => Boolean(line && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line));
/** 软换行拼回一行：两侧都不是中文时补一个空格，中文之间直接相连。 */
const joinSoftLines = (lines: string[]) => lines.reduce((text, line) => !text ? line : `${text}${wide.test([...text].at(-1)!) || wide.test([...line][0]!) ? '' : ' '}${line}`, '');
const isBlockStart = (line: string) => /^\s{0,3}(#{1,6}\s|[-*+]\s|\d+[.)]\s|>|```|~~~|\|)/.test(line);

/** 表格转成「1. 指标：值（其余列）」；首列是序号时去掉，用自己的编号。 */
function tableLines(header: string[], rows: string[][]) {
  const indexed = isIndexColumn(header[0] ?? '', rows.map(row => row[0] ?? ''));
  return rows.map((row, index) => {
    const [name = '', value, ...rest] = indexed ? row.slice(1) : row;
    const others = rest.filter(Boolean);
    return `${index + 1}. ${name}${value ? `：${value}` : ''}${others.length ? `（${others.join('；')}）` : ''}`;
  });
}

/** 复制结论：能直接贴回飞书的纯文本。 */
export function conclusionPlainText(markdown: string, pageUrl: string) {
  const lines = markdown.replace(/\r\n?/g, '\n').trim().split('\n');
  const out: string[] = [];
  let index = 0;
  if (lines[0] && !isBlockStart(lines[0])) {
    const lead: string[] = [];
    // 导语到空行或下一个块（围栏、列表、表格等）为止。
    while (index < lines.length && lines[index]!.trim() && (!lead.length || !isBlockStart(lines[index]!))) lead.push(lines[index++]!.trim());
    out.push(`【结论】${plainInline(joinSoftLines(lead))}`);
  } else out.push('【结论】');
  // 记住开启围栏的字符和长度：只有同一种字符、不短于开启、后面没有正文的一行才关闭，围栏内原样保留。
  let fence: string | undefined;
  for (; index < lines.length; index++) {
    const line = lines[index]!;
    if (fence) {
      const close = /^\s*(`{3,}|~{3,})\s*$/.exec(line)?.[1];
      if (close && close[0] === fence[0] && close.length >= fence.length) fence = undefined;
      else out.push(line);
      continue;
    }
    fence = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) continue;
    if (isTableRow(line) && isTableDivider(lines[index + 1])) {
      const header = tableCells(line);
      const rows: string[][] = [];
      for (index += 2; isTableRow(lines[index]); index++) rows.push(tableCells(lines[index]!));
      index--;
      out.push(...tableLines(header, rows));
      continue;
    }
    out.push(plainInline(line.replace(/^\s{0,3}#{1,6}\s+/, '').replace(/^(\s*)[-*+]\s+/, '$1• ').replace(/^\s{0,3}>\s?/, '')));
  }
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n\n详情：${pageUrl}`;
}
