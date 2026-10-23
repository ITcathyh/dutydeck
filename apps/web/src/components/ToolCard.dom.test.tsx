import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ActivityGroupPanel, ToolBatch, ToolCard } from './ToolCard';
import { createTimelineProjector, type TimelineActivityGroup, type TimelineEvent } from '../timeline';
import { createEventWindow, mergeLiveEvent } from '../event-history';
import { TimelineDisclosureContext } from '../timeline-disclosure';

// 卡片即 CoT 可视化：status → 状态灯/图标/文案 的映射是本项目必保的渲染契约。
// 这些用例盯的就是「事件流 status 变了，卡片视觉没跟着变」这类回归。

const toolEvent = (overrides: Partial<TimelineEvent['data']> = {}, event: Partial<TimelineEvent> = {}): TimelineEvent => ({
  id: 'tool-1',
  sequence: 1,
  type: 'tool_call',
  timestamp: '2026-08-27T00:00:00.000Z',
  data: {
    name: 'terminal',
    status: 'running',
    input: { command: 'ls -la' },
    startedAt: '2026-08-27T00:00:00.000Z',
    ...overrides
  },
  ...event
});

// 状态灯是无文本的 <span>，只能靠 class 断言；用 querySelector 精确定位圆点而不是整卡搜索。
// 前提：状态灯必须是卡片里唯一的 span.rounded-full——别给别的 span 加这个类，
// 否则选择器会抓错元素而测试还「通过」。
const statusDot = (container: HTMLElement) => container.querySelector('span.rounded-full');
const spinner = (container: HTMLElement) => container.querySelector('.animate-spin');
// 展开区改用 prism 高亮后，文本被切成大量 token <span>，单节点的 getByText 不再适用，
// 只能在 .code-renderer 容器上断言聚合文本。
const codeBlock = (container: HTMLElement) => container.querySelector('.code-renderer');

describe('ToolCard 状态渲染分支', () => {
  it('running：转圈动画 + 「执行中」，且没有终态状态灯', () => {
    const { container } = render(<ToolCard event={toolEvent({ status: 'running' })}/>);
    expect(screen.getByText('执行中')).toBeTruthy();
    expect(spinner(container)).toBeTruthy();
    // 未终结时不应出现绿/红圆点——否则用户会误以为任务已结束
    expect(statusDot(container)).toBeNull();
  });

  it('completed：绿色状态灯 + 「已完成」，转圈消失', () => {
    const { container } = render(<ToolCard event={toolEvent({ status: 'completed', completedAt: '2026-08-27T00:00:02.000Z' })}/>);
    expect(screen.getByText('已完成')).toBeTruthy();
    expect(spinner(container)).toBeNull();
    expect(statusDot(container)?.className).toContain('bg-success-solid');
    expect(statusDot(container)?.className).not.toContain('bg-danger-solid');
  });

  it('failed：红色状态灯 + 「失败」，不是绿灯', () => {
    const { container } = render(<ToolCard event={toolEvent({ status: 'failed', completedAt: '2026-08-27T00:00:02.000Z' })}/>);
    expect(screen.getByText('失败')).toBeTruthy();
    expect(spinner(container)).toBeNull();
    expect(statusDot(container)?.className).toContain('bg-danger-solid');
    expect(statusDot(container)?.className).not.toContain('bg-success-solid');
  });

  it('terminal 态才算耗时到 completedAt：completed 显示 2 秒而非 running 的实时耗时', () => {
    render(<ToolCard event={toolEvent({ status: 'completed', completedAt: '2026-08-27T00:00:02.000Z' })}/>);
    expect(screen.getByText('2 秒')).toBeTruthy();
  });

  it('工具类型决定图标 kind：git 命令走 Git 分支而非通用 terminal', () => {
    render(<ToolCard event={toolEvent({ name: 'terminal', input: { command: 'git status' }, status: 'completed' })} preferDescription={false}/>);
    expect(screen.getByText('已执行 Git 操作')).toBeTruthy();
  });

  it('preferDescription 为 true 时优先展示 description 而非动作标签', () => {
    render(<ToolCard event={toolEvent({ description: '检查工作区状态', input: { command: 'git status' } })}/>);
    expect(screen.getByText('检查工作区状态')).toBeTruthy();
    expect(screen.queryByText('正在执行 Git 操作')).toBeNull();
  });
});

describe('ToolCard 展开交互', () => {
  it('点击展开后渲染 input/output JSON，再点收起', async () => {
    const user = userEvent.setup();
    const { container } = render(<ToolCard event={toolEvent({ status: 'completed', input: { command: 'ls -la' }, output: 'total 0' })}/>);
    expect(codeBlock(container)).toBeNull();
    await user.click(screen.getByRole('button', { name: /运行命令/ }));
    const block = codeBlock(container);
    expect(block).toBeTruthy();
    expect(block!.textContent).toContain('"output"');
    expect(block!.textContent).toContain('ls -la');
    expect(block!.textContent).toContain('total 0');
    await user.click(screen.getByRole('button', { name: /运行命令/ }));
    expect(codeBlock(container)).toBeNull();
  });

  it('没有 input/output 时按钮 disabled，点击不展开', async () => {
    const user = userEvent.setup();
    const { container } = render(<ToolCard event={toolEvent({ status: 'completed', input: undefined, output: undefined })}/>);
    const button = screen.getByRole('button');
    expect((button as HTMLButtonElement).disabled).toBe(true);
    await user.click(button);
    expect(codeBlock(container)).toBeNull();
  });

  it('ongoing 且未终结时默认展开；ongoing 但已完成则默认收起', () => {
    const running = render(<ToolCard event={toolEvent({ status: 'running', output: 'partial' })} ongoing/>);
    expect(codeBlock(running.container)?.textContent).toContain('"output"');
    running.unmount();
    const completed = render(<ToolCard event={toolEvent({ status: 'completed', output: 'done' })} ongoing/>);
    expect(codeBlock(completed.container)).toBeNull();
  });
});

describe('ToolBatch 聚合状态', () => {
  const batch = (statuses: string[]) => statuses.map((status, index) =>
    toolEvent({ status, completedAt: status === 'running' ? undefined : '2026-08-27T00:00:01.000Z' }, { id: `tool-${index}`, sequence: index + 1 }));

  it('全部完成 → 「已完成」+ 绿灯 + 操作次数', () => {
    const { container } = render(<ToolBatch description="读取三个文件" events={batch(['completed', 'completed', 'completed'])}/>);
    expect(screen.getByText('已完成')).toBeTruthy();
    expect(screen.getByText('3 次操作')).toBeTruthy();
    expect(container.querySelector('span.rounded-full')?.className).toContain('bg-success-solid');
  });

  it('有完成也有失败 → 「部分失败」（不是笼统的「失败」）', () => {
    render(<ToolBatch description="读取三个文件" events={batch(['completed', 'failed'])}/>);
    expect(screen.getByText('部分失败')).toBeTruthy();
  });

  it('全部失败且无一完成 → 「失败」', () => {
    render(<ToolBatch description="读取三个文件" events={batch(['failed', 'failed'])}/>);
    expect(screen.getByText('失败')).toBeTruthy();
    expect(screen.queryByText('部分失败')).toBeNull();
  });

  it('仍有未终结项 → 「执行中」优先于已完成计数', () => {
    render(<ToolBatch description="读取三个文件" events={batch(['completed', 'running'])}/>);
    expect(screen.getByText('执行中')).toBeTruthy();
  });

  it('展开后逐条渲染子卡片，子卡片用动作标签而非重复 description', async () => {
    const user = userEvent.setup();
    const { container } = render(<ToolBatch description="读取三个文件" events={batch(['completed', 'failed'])}/>);
    await user.click(screen.getByRole('button', { name: /读取三个文件/ }));
    const nested = container.querySelector('.border-l');
    expect(nested).toBeTruthy();
    // 子卡片各自带状态文案：一条已完成、一条失败
    expect(within(nested as HTMLElement).getByText('已完成')).toBeTruthy();
    expect(within(nested as HTMLElement).getByText('失败')).toBeTruthy();
  });
});

describe('ToolCard 终态更新', () => {
  it.each(['completed', 'failed'])('相同 %s 事件和显示属性不重复读取工具描述，内部展开仍生效', async status => {
    const description = vi.fn(() => '固定工具说明');
    const event = toolEvent({ status, output: '固定输出' });
    Object.defineProperty(event.data, 'description', { get: description });
    const view = render(<ToolCard event={event}/>);
    description.mockClear();
    view.rerender(<ToolCard event={event}/>);
    expect(description).not.toHaveBeenCalled();
    view.rerender(<ToolCard event={event} ongoing/>);
    expect(description).toHaveBeenCalled();
    description.mockClear();
    view.rerender(<ToolCard event={event} ongoing/>);
    expect(description).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: /固定工具说明/ }));
    expect(codeBlock(view.container)?.textContent).toContain('固定输出');
    expect(description).toHaveBeenCalled();
  });

  it.each(['running', 'pending', 'completed-without-end'])('同一 %s 事件仍随父组件更新显示实时耗时', status => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-08-27T00:00:01.000Z'));
    try {
      const event = toolEvent({ status: status === 'completed-without-end' ? 'completed' : status }, status === 'completed-without-end' ? { timestamp: '' } : {});
      const view = render(<ToolCard event={event}/>);
      expect(screen.getByText('1 秒')).toBeTruthy();
      clock.mockReturnValue(Date.parse('2026-08-27T00:00:03.000Z'));
      view.rerender(<ToolCard event={event}/>);
      expect(screen.getByText('3 秒')).toBeTruthy();
    } finally { clock.mockRestore(); }
  });

  it('实时合并的迟到结果、输入和失败状态更新内容并保留原卡片与展开状态', async () => {
    const project = createTimelineProjector();
    const tasks: [] = [];
    let events = createEventWindow([toolEvent({ id: 'call-1', status: 'completed', output: '初始结果' })]);
    const initial = project(events.events, tasks, false, events).timeline[0]!;
    Object.freeze(initial.data); Object.freeze(initial);
    const view = render(<ToolCard event={initial}/>);
    await userEvent.click(screen.getByRole('button', { name: /运行命令/ }));
    const card = view.container.querySelector('[data-timeline-event]');
    expect(codeBlock(view.container)?.textContent).toContain('初始结果');
    events = mergeLiveEvent(events, toolEvent({ id: 'call-1', status: 'failed', input: { command: 'cat missing-file' }, output: '迟到的失败原因' }, { id: 'late-result', sequence: 2, type: 'tool_result', timestamp: '2026-08-27T00:00:03.000Z' }));
    const updated = project(events.events, tasks, false, events).timeline[0]!;
    expect(updated).not.toBe(initial);
    expect(initial.data.output).toBe('初始结果');
    view.rerender(<ToolCard event={updated}/>);
    expect(view.container.querySelector('[data-timeline-event]')).toBe(card);
    expect(screen.getByText('失败')).toBeTruthy();
    expect(codeBlock(view.container)?.textContent).toContain('cat missing-file');
    expect(codeBlock(view.container)?.textContent).toContain('迟到的失败原因');
    expect(codeBlock(view.container)?.textContent).not.toContain('初始结果');
  });

  it('显示属性或 disclosure context 改变时仍更新，当前焦点保持在原按钮', async () => {
    const event = toolEvent({ status: 'completed', description: '说明文字', output: '输出' });
    const first = new Map<string, boolean>();
    const second = new Map<string, boolean>();
    const view = render(<TimelineDisclosureContext.Provider value={first}><ToolCard event={event}/></TimelineDisclosureContext.Provider>);
    const button = screen.getByRole('button', { name: /说明文字/ });
    button.focus();
    view.rerender(<TimelineDisclosureContext.Provider value={first}><ToolCard event={event} ongoing preferDescription={false}/></TimelineDisclosureContext.Provider>);
    expect(screen.queryByText('说明文字')).toBeNull();
    expect(screen.getByRole('button', { name: /已运行命令/ })).toBe(button);
    expect(document.activeElement).toBe(button);
    view.rerender(<TimelineDisclosureContext.Provider value={second}><ToolCard event={event} ongoing preferDescription={false}/></TimelineDisclosureContext.Provider>);
    await userEvent.click(button);
    expect(codeBlock(view.container)?.textContent).toContain('输出');
    expect(second.get('tool:tool-1')).toBe(true);
    expect(first.get('tool:tool-1')).toBe(false);
  });

  it('初始折叠阶段完整保留 Markdown DOM，更新及开关阶段保留节点、选区和工具展开状态', async () => {
    const event = toolEvent({ status: 'completed', output: '完整工具输出' });
    const group: TimelineActivityGroup = { id: 'retained-group', label: '检查阶段', startedAt: '', events: [
      { id: 'thinking', sequence: 1, type: 'thinking', timestamp: '', data: { text: '浏览器页内查找需要的完整思考内容\n\n```js\nconst result = 42;\n```' } }, event
    ] };
    const view = render(<ActivityGroupPanel group={group}/>);
    const details = view.container.querySelector('details')!;
    expect(details.open).toBe(false);
    const thinking = screen.getByText('浏览器页内查找需要的完整思考内容');
    expect(codeBlock(view.container)?.textContent).toContain('const result = 42;');
    expect(view.container.querySelector('[data-timeline-event="tool-1"]')).toBeTruthy();
    details.open = true; fireEvent(details, new Event('toggle'));
    await userEvent.click(screen.getByRole('button', { name: /运行命令/ }));
    const card = view.container.querySelector('[data-timeline-event="tool-1"]')!;
    const output = card.querySelector('.code-renderer');
    const range = document.createRange(); range.selectNodeContents(thinking);
    window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
    view.rerender(<ActivityGroupPanel group={{ ...group, events: [...group.events] }}/>);
    details.open = false; fireEvent(details, new Event('toggle'));
    expect(window.getSelection()!.toString()).toBe('浏览器页内查找需要的完整思考内容');
    details.open = true; fireEvent(details, new Event('toggle'));
    expect(screen.getByText('浏览器页内查找需要的完整思考内容')).toBe(thinking);
    expect(view.container.querySelector('[data-timeline-event="tool-1"]')).toBe(card);
    expect(card.querySelector('.code-renderer')).toBe(output);
    expect(output?.textContent).toContain('完整工具输出');
    window.getSelection()!.removeAllRanges();
  });
});
