import { expect, it, vi } from 'vitest';
import { BACKGROUND_FOLLOWUP, type AgentEvent } from '@dutydeck/shared';
import { eventsForRuntimeTask, loadLarkTaskEvents, renderLarkProcessElements, renderLarkRecordExport, renderLarkResultElements, steeringOutcomeText } from './card-renderer.js';

const at = '2026-10-08T07:44:07.000Z';
const task = (id: string, status: string): AgentEvent => ({ type: 'task', data: { task: { id, status } }, timestamp: at } as AgentEvent);

it.each([
  ['injected', '已把这条内容送进正在执行的这一轮，Agent 会在这一轮里接着处理，回复出现在那一轮的结果里。'],
  ['startedNewTurn', 'Agent 已用这条内容另起了一轮；那一轮不在 Dutydeck 的执行记录里，结果不会回到这张卡片。'],
  ['promptRequired', '正在执行的那一轮此刻接不了插话（还没交给 Agent，或已经结束）。'],
  ['unsupported', '当前 Agent 不支持插话。'],
  ['incompatible', '这条内容的执行设置（权限模式、模型或高危操作策略）与正在执行的那一轮不同，不能插话。'],
  ['failed', 'Agent 没有接受插话。']
])('steeringOutcomeText(%s) 缺省与显式无 pending 都保留旧文案', (outcome, expected) => {
  expect(steeringOutcomeText(outcome)).toBe(expected);
  expect(steeringOutcomeText(outcome, 'confirmed-none')).toBe(expected);
});

it('只有即时 injected 且确认当前任务仍有 pending 时换成审批等待文案，未知状态不冒充已确认', () => {
  expect(steeringOutcomeText('injected', 'confirmed-pending')).toBe('已送进正在执行的这一轮；这一轮还有审批没处理，Agent 有没有读到以它后续的回复为准。');
  expect(steeringOutcomeText('injected', 'unknown')).toBe('已送进正在执行的这一轮；审批状态暂时没读到，Agent 有没有读到以后续回复为准。');
  expect(steeringOutcomeText('startedNewTurn', 'confirmed-pending')).toBe('Agent 已用这条内容另起了一轮；那一轮不在 Dutydeck 的执行记录里，结果不会回到这张卡片。');
  expect(steeringOutcomeText('startedNewTurn', 'unknown')).toBe('Agent 已用这条内容另起了一轮；那一轮不在 Dutydeck 的执行记录里，结果不会回到这张卡片。');
});

let contentSequence = 0;
const assistant = (data: Record<string, any>): AgentEvent => ({
  id: `content-${++contentSequence}`, sessionId: 'ses_content', sequence: contentSequence, type: 'text', timestamp: at, data
});
const image = (patch: Record<string, unknown> = {}) => ({ type: 'image', mimeType: 'image/png', data: 'YWJj', ...patch });
const pureImageText = (count: number) => `Agent 返回了 ${count} 个图片结果；飞书卡片不附带图片，请在 Web 工作台查看图片详情或引用。`;
const mixedImageText = (count: number) => `另有 ${count} 个图片结果未随卡投递，请在 Web 工作台查看图片详情或引用。`;
const droppedImage = () => ({ type: 'unsupported', originalType: 'image', reason: 'content_budget' });
const pureDroppedImageText = (count: number) => `Agent 返回了 ${count} 个图片结果，但图片超过保存上限，图片内容未保留。`;
const mixedDroppedImageText = (count: number) => `另有 ${count} 个图片结果超过保存上限，图片内容未保留。`;
const finalOutput = (events: AgentEvent[]) => renderLarkResultElements(events).find(element => element.element_id === 'final_output');
const finalContent = (events: AgentEvent[]) => finalOutput(events)?.content;

it.each<[string, AgentEvent[], string, number]>([
  ['text→image', [assistant({ text: '结论' }), assistant({ text: '', parts: [image()] })], '结论', 1],
  ['image→text', [assistant({ text: '', parts: [image()] }), assistant({ text: '结论' })], '结论', 1],
  ['text→image→text', [assistant({ text: '前' }), assistant({ text: '', parts: [image()] }), assistant({ text: '后' })], '前后', 1],
  ['多个独立 image chunk', [assistant({ text: '', parts: [image()] }), assistant({ text: '', parts: [image()] }), assistant({ text: '', parts: [image()] })], '', 3],
  ['单 event 多图', [assistant({ text: '', parts: [image(), image()] })], '', 2],
  ['URI-only', [assistant({ text: '', parts: [image({ data: undefined, uri: 'file:///work/chart.png' })] })], '', 1],
  ['不可预览 MIME', [assistant({ text: '附件如下' }), assistant({ text: '', parts: [image({ mimeType: 'application/octet-stream' })] })], '附件如下', 1]
])('ACP 最终结果保留 parts 并统计图片：%s', (_name, events, text, count) => {
  expect(finalContent(events)).toBe(text ? `${text}\n\n${mixedImageText(count)}` : pureImageText(count));
  expect(renderLarkResultElements(events).some(element => element.element_id === 'result_missing')).toBe(false);
});

it('非数组 parts 不拖垮合法正文，相邻合并也不修改原事件', () => {
  const single = assistant({ text: '合法最终正文', parts: { unexpected: true } });
  expect(finalContent([single])).toBe('合法最终正文');
  expect(single.data.parts).toEqual({ unexpected: true });

  const adjacent = [
    assistant({ text: '前', parts: { unexpected: true } }),
    assistant({ text: '中', parts: [image()] }),
    assistant({ text: '后', parts: { unexpected: true } })
  ];
  const before = structuredClone(adjacent);
  expect(finalContent(adjacent)).toBe(`前中后\n\n${mixedImageText(1)}`);
  expect(adjacent).toEqual(before);
});

it.each<[string, AgentEvent[], string]>([
  ['纯丢弃图片', [assistant({ text: '', parts: [droppedImage(), droppedImage()] })], pureDroppedImageText(2)],
  ['正文与丢弃图片', [assistant({ text: '结论', parts: [{ type: 'text', text: '结论' }, droppedImage()] })], `结论\n\n${mixedDroppedImageText(1)}`],
  ['有效图片与丢弃图片', [assistant({ text: '', parts: [image(), droppedImage()] })], `${pureImageText(1)}\n\n${mixedDroppedImageText(1)}`],
  ['正文、有效图片与丢弃图片', [assistant({ text: '结论', parts: [{ type: 'text', text: '结论' }, image(), droppedImage()] })], `结论\n\n${mixedImageText(1)}\n\n${mixedDroppedImageText(1)}`]
])('超预算图片如实说明未保留：%s', (_name, events, expected) => {
  const rendered = renderLarkResultElements(events);
  expect(finalContent(events)).toBe(expected);
  expect(rendered.some(element => element.element_id === 'result_missing')).toBe(false);
  expect(JSON.stringify(rendered)).not.toContain('Agent 未返回最终输出');
  if (!events[0]!.data.parts.some((part: any) => part.type === 'image')) expect(JSON.stringify(rendered)).not.toContain('Web');
});

it('parts 合并的迭代工作量随 chunk 数线性增长，且不写回原数组', () => {
  const count = 2_000;
  const events = Array.from({ length: count }, () => assistant({ text: '', parts: [{ ...image(), complexityMarker: true }] }));
  const before = structuredClone(events);
  const originalIterator = Array.prototype[Symbol.iterator];
  let iteratedParts = 0;
  const iterator = vi.spyOn(Array.prototype, Symbol.iterator).mockImplementation(function (this: any[]) {
    if (this[0]?.complexityMarker) iteratedParts += this.length;
    return originalIterator.call(this);
  });
  try {
    expect(finalContent(events)).toBe(pureImageText(count));
  } finally {
    iterator.mockRestore();
  }
  expect(iteratedParts).toBeLessThanOrEqual(3 * count);
  expect(events).toEqual(before);
});

it('文字与非图片 part 保留原文，不追加图片说明', () => {
  const events = [assistant({ text: '报告正文', parts: [{ type: 'text', text: '报告正文' }, { type: 'resource_link', uri: 'file:///work/report.html', name: 'Report', mimeType: 'text/html' }] })];
  expect(finalContent(events)).toBe('报告正文');
  expect(JSON.stringify(renderLarkResultElements(events))).not.toContain('图片结果');
});

it('后续工具活动挡住之前的图片，别轮图片也不计入本轮', () => {
  const blocked = [assistant({ text: '', parts: [image()] }), { ...assistant({ id: 'tool', name: 'Bash', status: 'completed' }), type: 'tool_result' } as AgentEvent];
  expect(finalContent(blocked)).toBeUndefined();
  expect(renderLarkResultElements(blocked).find(element => element.element_id === 'result_missing')?.content)
    .toBe("<text_tag color='orange'>结果不完整</text_tag>　Agent 未返回最终输出，可直接要求 Agent 总结本轮结论。");

  const previousImage = assistant({ text: '', parts: [image()] });
  const currentText = assistant({ text: '本轮文字' });
  const events = [
    task('task_old', 'running'), { type: 'text', data: { role: 'user', taskId: 'task_old', text: '旧任务' }, timestamp: at } as AgentEvent,
    previousImage, task('task_old', 'completed'), task('task_new', 'running'),
    { type: 'text', data: { role: 'user', taskId: 'task_new', text: '新任务' }, timestamp: at } as AgentEvent,
    currentText, task('task_new', 'completed')
  ];
  expect(finalContent(eventsForRuntimeTask(events, 'task_new'))).toBe('本轮文字');
});

it('verifiedOutput 的纯图片事件使用同一 final_output 文案', () => {
  const verified = { ...assistant({ text: '', parts: [image()], recovery: { actor: 'installation_owner' } }), id: 'verified' };
  expect(finalContent([verified])).toBe(pureImageText(1));
});

it('无图片的普通结果与空结果逐字保留旧元素', () => {
  expect(renderLarkResultElements([assistant({ text: '普通结论' })])).toEqual([
    { tag: 'markdown', element_id: 'final_output', content: '普通结论', text_align: 'left', text_size: 'normal_v2', margin: '0px' }
  ]);
  expect(renderLarkResultElements([])).toEqual([
    { tag: 'markdown', element_id: 'result_missing', content: "<text_tag color='orange'>结果不完整</text_tag>　Agent 未返回最终输出，可直接要求 Agent 总结本轮结论。", text_size: 'normal', margin: '4px 0px' }
  ]);
});

it('提交前就失败的轮次只取它自己的事件，不把以前的轮次当成这一轮', () => {
  const events = [
    task('task_old', 'running'),
    { type: 'text', data: { text: '上一轮的问题', role: 'user', taskId: 'task_old' }, timestamp: at },
    { type: 'tool_call', data: { id: 'call_1', name: 'Bash', input: { command: 'ls' } }, timestamp: at },
    { type: 'text', data: { text: '上一轮的答案' }, timestamp: at },
    task('task_old', 'completed'),
    task('task_new', 'queued'),
    task('task_new', 'running'),
    { type: 'error', data: { message: 'ACP_LAUNCHER_VERSION_CHANGED: 旧会话启动器版本变化' }, timestamp: at },
    task('task_new', 'failed')
  ] as AgentEvent[];
  expect(eventsForRuntimeTask(events, 'task_new')).toEqual([events[7]]);
  expect(eventsForRuntimeTask(events, 'task_old').map(event => event.type)).toEqual(['tool_call', 'text']);
});

it('排队中就被取消的轮次没有自己的事件，结果卡不拿上一轮的答案', () => {
  const events = [
    task('task_old', 'running'),
    { type: 'text', data: { text: '上一轮的问题', role: 'user', taskId: 'task_old' }, timestamp: at },
    { type: 'tool_call', data: { id: 'call_1', name: 'Bash', input: { command: 'ls' } }, timestamp: at },
    { type: 'text', data: { text: '上一轮的答案' }, timestamp: at },
    task('task_old', 'completed'),
    { ...task('task_queued', 'queued'), id: 'accepted:task_queued' },
    task('task_queued', 'cancelled')
  ] as AgentEvent[];
  const scoped = eventsForRuntimeTask(events, 'task_queued');
  expect(scoped).toEqual([]);
  expect(JSON.stringify(renderLarkResultElements(scoped))).not.toContain('上一轮的答案');
  expect(JSON.stringify(renderLarkProcessElements(scoped, { compactTrace: false, traceLimit: 20 }))).not.toContain('ls');
});

it('长回答把用户原话挤出最近窗口时继续往前取，不把回答结束后的「运行中」当成这一轮的起点', async () => {
  const answer = Array.from({ length: 30 }, (_, index) => ({ type: 'text', data: { text: `第 ${index} 段` }, timestamp: at }));
  const events = [
    task('task_long', 'running'),
    { type: 'text', data: { text: '问题', role: 'user', taskId: 'task_long' }, timestamp: at },
    task('task_long', 'running'),
    ...answer,
    task('task_long', 'running'),
    task('task_long', 'completed')
  ] as AgentEvent[];
  const runtime = { getRecentEvents: async (_id: string, limit: number) => events.slice(-limit) };
  expect((await loadLarkTaskEvents(runtime, 'ses_long', 'task_long', 10)).filter(event => event.type === 'text')).toHaveLength(30);
});

it('提交前就失败的轮次取到它的受理事件即止，不把整段会话读完', async () => {
  const older = Array.from({ length: 40 }, (_, index) => ({ type: 'text', data: { text: `旧 ${index}` }, timestamp: at }));
  const events = [
    ...older,
    { ...task('task_failed', 'queued'), id: 'accepted:task_failed' },
    task('task_failed', 'running'),
    { type: 'error', data: { message: 'ACP_LAUNCHER_VERSION_CHANGED' }, timestamp: at },
    task('task_failed', 'failed')
  ] as AgentEvent[];
  const limits: number[] = [];
  const runtime = { getRecentEvents: async (_id: string, limit: number) => { limits.push(limit); return events.slice(-limit); } };
  expect(await loadLarkTaskEvents(runtime, 'ses_failed', 'task_failed', 10)).toEqual([events[42]]);
  expect(limits).toEqual([10]);
});

it('账本里找不到这一轮起点时窗口有上限，不把很长的会话整段读完', async () => {
  const older = Array.from({ length: 30_000 }, (_, index) => ({ type: 'text', data: { text: `旧 ${index}` }, timestamp: at }));
  const events = [...older, task('task_legacy', 'queued'), task('task_legacy', 'cancelled')] as AgentEvent[];
  const limits: number[] = [];
  const runtime = { getRecentEvents: async (_id: string, limit: number) => { limits.push(limit); return events.slice(-limit); } };
  expect(await loadLarkTaskEvents(runtime, 'ses_long', 'task_legacy', 500)).toEqual([]);
  expect(limits).toEqual([500, 1000, 2000, 4000, 8000, 16000, 20000]);
});


it('ignores incomplete diagnostic statuses and keeps ordinary tool results blocking a final answer', () => {
  const events = [
    { type: 'text', data: { text: '阶段描述' }, timestamp: at },
    { type: 'status', data: { state: 'child_quota' }, timestamp: at },
    { type: 'status', data: { state: 'child_quota', diagnostic: 'child_quota', code: 'rate_limit' }, timestamp: at },
    { type: 'status', data: { state: 'child_rate_limit', diagnostic: 'child_rate_limit', code: 'rate_limit', id: 'forged' }, timestamp: at },
    { type: 'tool_result', data: { id: 'ordinary', state: 'child_quota', diagnostic: 'child_quota', code: 'usage_limit_exceeded', name: 'ordinary tool', status: 'failed', output: 'real tool failure' }, timestamp: at }
  ] as AgentEvent[];
  const process = JSON.stringify(renderLarkProcessElements(events, { compactTrace: false, traceLimit: 20 }));
  expect(process).toContain('ordinary tool'); expect(process).not.toContain('子任务额度诊断');
  const result = renderLarkResultElements(events);
  expect(result.some(e => e.element_id === 'final_output')).toBe(false);
  expect(result.some(e => e.element_id === 'result_missing')).toBe(true);
});

it('后台任务结束后的回答不算这一轮的进展、结论或导出内容', () => {
  const followup = { type: 'text', data: { text: '后台任务的后续回答', origin: BACKGROUND_FOLLOWUP }, timestamp: at } as AgentEvent;
  const turn = (extra: AgentEvent[]) => [
    task('task_bg', 'running'),
    { type: 'text', data: { text: '问题', role: 'user', taskId: 'task_bg' }, timestamp: at },
    { type: 'tool_call', data: { id: 'call_bg', name: 'Bash', status: 'completed', input: { command: 'sleep 20' } }, timestamp: at },
    { type: 'text', data: { text: '本轮回答' }, timestamp: at },
    ...extra,
    task('task_bg', 'completed')
  ] as AgentEvent[];
  const scoped = eventsForRuntimeTask(turn([followup]), 'task_bg');
  expect(scoped).toEqual(eventsForRuntimeTask(turn([]), 'task_bg'));
  expect(finalOutput(scoped)).toEqual(finalOutput(eventsForRuntimeTask(turn([]), 'task_bg')));
  expect(JSON.stringify(finalOutput(scoped))).toContain('本轮回答');
  const exported = renderLarkRecordExport(turn([followup]));
  expect(exported).toContain('本轮回答');
  expect(exported).not.toContain('后台任务的后续回答');
});
