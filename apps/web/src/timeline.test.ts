import type { DockEvent, Task } from './api';
import { describe, expect, it } from 'vitest';
import { buildTimeline, buildTimelineSections, createTimelineProjector, pendingPermissionId, toolDisplayName } from './timeline';
import { createEventWindow, mergeReconciledEvents } from './event-history';

const event = (sequence: number, type: string, data: any) => ({ id: `e${sequence}`, sequence, type, timestamp: '', data });

describe('conversation timeline', () => {
  it('finds the latest permission request that is still pending after decisions merge', () => {
    const decided = buildTimeline([event(1, 'permission_request', { id: 'perm_a', status: 'pending' }), event(2, 'permission_request', { id: 'perm_a', status: 'approved' })]);
    expect(pendingPermissionId(decided)).toBeUndefined();
    const waiting = buildTimeline([event(1, 'permission_request', { id: 'perm_a', status: 'rejected' }), event(2, 'text', { text: '继续' }), event(3, 'permission_request', { id: 'perm_b', status: 'pending' })]);
    expect(pendingPermissionId(waiting)).toBe('perm_b');
  });

  it('joins streamed token deltas into one Markdown message', () => {
    const timeline = buildTimeline([event(1, 'thinking', { text: 'Con' }), event(2, 'status', { state: 'thinking' }), event(3, 'thinking', { text: 'sidering' }), event(4, 'text', { text: '你' }), event(5, 'text', { text: '好' })]);
    expect(timeline).toHaveLength(2);
    expect(timeline.map(item => item.id)).toEqual(['e1', 'e4']);
    expect(timeline.map(item => item.sequence)).toEqual([3, 5]);
    expect(timeline[0].data.text).toBe('Considering');
    expect(timeline[1].data.text).toBe('你好');
  });

  it('does not merge user and assistant messages', () => {
    const timeline = buildTimeline([event(1, 'text', { text: 'Hello', role: 'user' }), event(2, 'text', { text: 'Hi', role: 'assistant' })]);
    expect(timeline.map(item => item.data.text)).toEqual(['Hello', 'Hi']);
  });

  it('extracts repeated agent warnings into one dedicated timeline notice', () => {
    const warning = 'Warning: Skill descriptions were shortened to fit the context budget.';
    const timeline = buildTimeline([
      event(1, 'text', { text: warning }),
      event(2, 'text', { text: warning }),
      event(3, 'text', { text: 'Ready', role: 'assistant' })
    ]);
    expect(timeline).toHaveLength(2);
    expect(timeline[0]).toMatchObject({ type: 'warning', data: { warningKind: 'skill', text: 'Skill descriptions were shortened to fit the context budget.' } });
    expect(timeline[1]).toMatchObject({ type: 'text', data: { text: 'Ready' } });
  });

  it('folds tool updates into one completed tool item', () => {
    const timeline = buildTimeline([event(1, 'tool_call', { id: 't1', name: 'Read', status: 'running', input: '.' }), event(2, 'tool_result', { id: 't1', status: 'completed', output: 'ok' })]);
    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toMatchObject({ type: 'tool_result', data: { name: 'Read', input: '.', output: 'ok', status: 'completed' } });
  });

  it('folds interleaved parallel tool updates by call id and retains the concrete name', () => {
    const timeline = buildTimeline([
      { ...event(1, 'tool_call', { id: 'a', name: 'Terminal', status: 'running', input: { command: 'pwd' } }), timestamp: '2026-01-01T00:00:01.000Z' },
      { ...event(2, 'tool_call', { id: 'b', name: 'Read', status: 'running', input: { path: 'README.md' } }), timestamp: '2026-01-01T00:00:02.000Z' },
      { ...event(3, 'tool_result', { id: 'a', name: 'tool call', status: 'completed', output: '/repo' }), timestamp: '2026-01-01T00:00:04.000Z' },
      { ...event(4, 'tool_result', { id: 'b', name: 'tool call', status: 'failed', output: 'missing' }), timestamp: '2026-01-01T00:00:05.000Z' }
    ]);
    expect(timeline).toHaveLength(2);
    expect(timeline[0]).toMatchObject({ data: { id: 'a', name: 'Terminal', status: 'completed', startedAt: '2026-01-01T00:00:01.000Z', completedAt: '2026-01-01T00:00:04.000Z' } });
    expect(timeline[1]).toMatchObject({ data: { id: 'b', name: 'Read', status: 'failed', startedAt: '2026-01-01T00:00:02.000Z', completedAt: '2026-01-01T00:00:05.000Z' } });
  });

  it('uses the concrete command as the tool display name', () => {
    expect(toolDisplayName({ name: 'tool call', input: { command: '  pnpm   test\n--runInBand  ' } })).toBe('pnpm test --runInBand');
    expect(toolDisplayName({ name: 'Terminal', input: { cmd: ['git', 'status', '--short'] } })).toBe('git status --short');
    expect(toolDisplayName({ name: 'Read', input: { path: 'README.md' } })).toBe('Read');
  });

  it('restores historical user prompts from persisted tasks without duplicating new user events', () => {
    const tasks = [{ id: 'task-1', sessionId: 's1', prompt: 'historical prompt', status: 'completed', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:01.000Z' }];
    expect(buildTimeline([], tasks)[0]).toMatchObject({ type: 'text', data: { role: 'user', text: 'historical prompt' } });
    const newEvent = { ...event(1, 'text', { text: 'historical prompt', role: 'user', taskId: 'task-1' }), timestamp: '2026-01-01T00:00:00.000Z' };
    expect(buildTimeline([newEvent], tasks)).toHaveLength(1);
  });

  it('keeps queued and cancelled prompts out of the conversation timeline', () => {
    const tasks = [
      { id: 'queued', sessionId: 's1', prompt: 'later', status: 'queued', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
      { id: 'cancelled', sessionId: 's1', prompt: 'never', status: 'cancelled', createdAt: '2026-01-01T00:00:01.000Z', updatedAt: '2026-01-01T00:00:01.000Z' }
    ];
    expect(buildTimeline([], tasks)).toEqual([]);
    expect(buildTimeline([event(1, 'task', { task: tasks[0] })], tasks)).toEqual([]);
  });

  it('groups chronological activity and keeps only the post-activity terminal text as final', () => {
    const tasks = [{ id: 'task-1', sessionId: 's1', prompt: '检查一下', status: 'completed', createdAt: '', updatedAt: '' }];
    const timeline = buildTimeline([
      event(1, 'text', { text: '检查一下', role: 'user', taskId: 'task-1' }),
      event(2, 'thinking', { text: '先看看文件' }),
      event(3, 'tool_call', { id: 't1', name: 'Read', status: 'running' }),
      event(4, 'tool_result', { id: 't1', name: 'Read', status: 'completed', output: 'ok' }),
      event(5, 'thinking', { text: '整理结果' }),
      event(6, 'text', { text: '已经检查完了', role: 'assistant' })
    ]);
    const sections = buildTimelineSections(timeline, tasks);
    expect(sections.map(section => section.kind)).toEqual(['event', 'activity', 'event']);
    expect(sections[1]).toMatchObject({ kind: 'activity', hasAnswer: true, taskStatus: 'completed', isLatestTurn: true });
    expect(sections[2]).toMatchObject({ kind: 'event', final: true });
    if (sections[1].kind === 'activity') expect(sections[1].groups.map(group => group.events.map(item => item.type))).toEqual([['thinking', 'tool_result', 'thinking']]);
  });

  it('marks only the newest turn activity as current', () => {
    const tasks = [
      { id: 'task-1', sessionId: 's1', prompt: 'first', status: 'completed', createdAt: '', updatedAt: '' },
      { id: 'task-2', sessionId: 's1', prompt: 'next', status: 'running', createdAt: '', updatedAt: '' }
    ];
    const timeline = buildTimeline([
      event(1, 'text', { text: 'first', role: 'user', taskId: 'task-1' }),
      event(2, 'thinking', { text: 'done thinking' }),
      event(3, 'text', { text: 'done', role: 'assistant' }),
      event(4, 'text', { text: 'next', role: 'user', taskId: 'task-2' }),
      event(5, 'tool_call', { id: 't2', name: 'Search', status: 'running' })
    ]);
    const activity = buildTimelineSections(timeline, tasks).filter(section => section.kind === 'activity');
    expect(activity).toMatchObject([
      { hasAnswer: true, isLatestTurn: false },
      { hasAnswer: false, isLatestTurn: true }
    ]);
  });

  it('nests intermediate assistant descriptions with the following thinking and tools', () => {
    const tasks = [{ id: 'task-1', sessionId: 's1', prompt: '协作', status: 'completed', createdAt: '', updatedAt: '' }];
    const timeline = buildTimeline([
      event(1, 'text', { text: '协作', role: 'user', taskId: 'task-1' }),
      event(2, 'thinking', { text: '先检查群消息' }),
      event(3, 'text', { text: '我先查看群成员和最近消息', role: 'assistant' }),
      event(4, 'tool_result', { id: 'peers', name: 'group peers', status: 'completed', output: 'peer' }),
      event(5, 'thinking', { text: '对方还没回复' }),
      event(6, 'text', { text: '消息已发送，现在等待回复', role: 'assistant' }),
      event(7, 'tool_result', { id: 'wait', name: 'group wait', status: 'completed', output: 'pong' }),
      event(8, 'text', { text: '协作完成', role: 'assistant' })
    ]);
    const sections = buildTimelineSections(timeline, tasks);
    const activity = sections.find(section => section.kind === 'activity');
    expect(sections.map(section => section.kind)).toEqual(['event', 'activity', 'event']);
    expect(activity?.groups.map(group => group.label)).toEqual(['我先查看群成员和最近消息', '消息已发送，现在等待回复']);
    expect(activity?.groups.map(group => group.events.map(item => item.type))).toEqual([
      ['thinking', 'text', 'tool_result'], ['thinking', 'text', 'tool_result']
    ]);
    expect(sections.at(-1)).toMatchObject({ kind: 'event', final: true, event: { data: { text: '协作完成' } } });
  });

  it('ties a steered message to the running turn it was injected into', () => {
    const tasks = [
      { id: 'task-1', sessionId: 's1', prompt: '检查', status: 'running', createdAt: '', updatedAt: '' },
      { id: 'task-2', sessionId: 's1', prompt: '顺便看日志', status: 'completed', createdAt: '', updatedAt: '' }
    ];
    const timeline = buildTimeline([
      event(1, 'text', { text: '检查', role: 'user', taskId: 'task-1' }),
      event(2, 'tool_result', { id: 'ls', name: 'Bash', status: 'completed', output: 'ok' }),
      event(3, 'text', { text: '顺便看日志', role: 'user', taskId: 'task-2', steering: { outcome: 'injected', target: { taskId: 'task-1', attemptId: 'a1' } } }),
      event(4, 'tool_result', { id: 'log', name: 'Read', status: 'completed', output: 'ok' }),
      event(5, 'text', { text: '日志正常', role: 'assistant' })
    ]);
    const sections = buildTimelineSections(timeline, tasks);
    expect(sections.some(section => section.kind === 'event' && section.final)).toBe(false);
    expect(sections.filter(section => section.kind === 'activity').at(-1)).toMatchObject({ taskStatus: 'running' });
  });

  it('keeps a steered message from splitting the running tool call and its turn', () => {
    const tasks = [
      { id: 'task-1', sessionId: 's1', prompt: '检查', status: 'completed', createdAt: '', updatedAt: '' },
      { id: 'task-2', sessionId: 's1', prompt: '顺便看日志', status: 'completed', createdAt: '', updatedAt: '' }
    ];
    const steering = { outcome: 'injected', target: { taskId: 'task-1', attemptId: 'a1' } };
    const timeline = buildTimeline([
      event(1, 'text', { text: '检查', role: 'user', taskId: 'task-1' }),
      event(2, 'tool_call', { id: 't1', name: 'Bash', status: 'running' }),
      event(3, 'text', { text: '顺便看日志', role: 'user', taskId: 'task-2', steering }),
      event(4, 'tool_result', { id: 't1', name: 'Bash', status: 'completed', output: 'ok' }),
      event(5, 'text', { text: '都检查完了', role: 'assistant' })
    ]);
    expect(timeline.filter(item => item.data.id === 't1')).toMatchObject([{ type: 'tool_result', data: { status: 'completed' } }]);
    const sections = buildTimelineSections(timeline, tasks);
    expect(sections.filter(section => section.kind === 'activity')).toMatchObject([{ hasAnswer: true, taskStatus: 'completed' }]);
    expect(sections.at(-1)).toMatchObject({ kind: 'event', final: true, event: { data: { text: '都检查完了' } } });
    // Steered right after the prompt, before any output: still its own bubble, not glued onto the prompt.
    expect(buildTimeline([event(1, 'text', { text: '检查', role: 'user', taskId: 'task-1' }), event(2, 'text', { text: '顺便看日志', role: 'user', taskId: 'task-2', steering })]).map(item => item.data.text)).toEqual(['检查', '顺便看日志']);
  });

  it('never promotes intermediate assistant text to final while the task is still running', () => {
    const tasks = [{ id: 'task-1', sessionId: 's1', prompt: '继续', status: 'running', createdAt: '', updatedAt: '' }];
    const timeline = buildTimeline([
      event(1, 'text', { text: '继续', role: 'user', taskId: 'task-1' }),
      event(2, 'text', { text: '先发消息', role: 'assistant' }),
      event(3, 'tool_result', { id: 'send', name: 'group send', status: 'completed' }),
      event(4, 'text', { text: '继续等待', role: 'assistant' })
    ]);
    const sections = buildTimelineSections(timeline, tasks);
    expect(sections.some(section => section.kind === 'event' && section.final)).toBe(false);
    expect(sections.find(section => section.kind === 'activity')?.groups.map(group => group.label)).toEqual(['先发消息', '继续等待']);
  });

  it('does not treat a terminal pre-tool description as final output', () => {
    const tasks = [{ id: 'task-1', sessionId: 's1', prompt: '检查', status: 'completed', createdAt: '', updatedAt: '' }];
    const timeline = buildTimeline([
      event(1, 'text', { text: '检查', role: 'user', taskId: 'task-1' }),
      event(2, 'text', { text: '先运行命令', role: 'assistant' }),
      event(3, 'tool_result', { id: 'pwd', name: 'pwd', status: 'completed', output: '/repo' })
    ]);
    const sections = buildTimelineSections(timeline, tasks);
    expect(sections.some(section => section.kind === 'event' && section.final)).toBe(false);
    expect(sections.find(section => section.kind === 'activity')).toMatchObject({
      groups: [expect.objectContaining({ label: '先运行命令' })],
      hasAnswer: false,
      taskStatus: 'incomplete'
    });
  });

  it('uses plain one-line text for activity labels instead of leaking Markdown syntax', () => {
    const tasks = [{ id: 'task-1', sessionId: 's1', prompt: '检查', status: 'running', createdAt: '', updatedAt: '' }];
    const timeline = buildTimeline([
      event(1, 'text', { text: '检查', role: 'user', taskId: 'task-1' }),
      event(2, 'text', { text: '确认 **Dutydeck** 并读取 [说明](https://example.com)\n继续执行', role: 'assistant' }),
      event(3, 'tool_call', { id: 'read', name: 'Read', status: 'running' })
    ]);
    expect(buildTimelineSections(timeline, tasks).find(section => section.kind === 'activity')).toMatchObject({
      groups: [expect.objectContaining({ label: '确认 Dutydeck 并读取 说明 继续执行' })]
    });
  });

  it('prefers the tool description over its command for an implicit stage label', () => {
    const tasks = [{ id: 'task-1', sessionId: 's1', prompt: 'pwd', status: 'completed', createdAt: '', updatedAt: '' }];
    const timeline = buildTimeline([
      event(1, 'text', { text: 'pwd', role: 'user', taskId: 'task-1' }),
      event(2, 'thinking', { text: '先确认目录' }),
      event(3, 'tool_result', { id: 'pwd', name: 'Terminal', status: 'completed', input: { command: 'pwd', description: 'Show current working directory' }, output: '/repo' })
    ]);
    expect(buildTimelineSections(timeline, tasks).find(section => section.kind === 'activity')).toMatchObject({
      groups: [expect.objectContaining({ label: 'Show current working directory' })]
    });
  });

  it('preserves an interrupted task status when no final output exists', () => {
    const tasks = [{ id: 'task-1', sessionId: 's1', prompt: '探索', status: 'interrupted', createdAt: '', updatedAt: '2026-01-01T00:01:07.000Z' }];
    const timeline = buildTimeline([
      { ...event(1, 'text', { text: '探索', role: 'user', taskId: 'task-1' }), timestamp: '2026-01-01T00:00:00.000Z' },
      { ...event(2, 'text', { text: '先检查源码', role: 'assistant' }), timestamp: '2026-01-01T00:00:01.000Z' },
      { ...event(3, 'tool_result', { id: 'search', name: 'find', status: 'completed' }), timestamp: '2026-01-01T00:00:02.000Z' },
      { ...event(4, 'thinking', { text: '继续查找实际仓库' }), timestamp: '2026-01-01T00:00:03.000Z' },
      { ...event(5, 'tool_call', { id: 'last', name: 'find / -name repo', status: 'running' }), timestamp: '2026-01-01T00:00:04.000Z' }
    ]);
    expect(buildTimelineSections(timeline, tasks).find(section => section.kind === 'activity')).toMatchObject({
      hasAnswer: false,
      taskStatus: 'interrupted',
      startedAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:01:07.000Z'
    });
  });

  it('does not promote tool-interrupted thinking fragments into separate stage titles', () => {
    const tasks = [{ id: 'task-1', sessionId: 's1', prompt: '演示', status: 'completed', createdAt: '', updatedAt: '' }];
    const timeline = buildTimeline([
      event(1, 'text', { text: '演示', role: 'user', taskId: 'task-1' }),
      event(2, 'thinking', { text: '检查 Explore 子代理是否' }),
      event(3, 'tool_result', { id: 'check', name: '检查后台任务', status: 'completed' }),
      event(4, 'thinking', { text: '完成了，我应该继续等待。' }),
      event(5, 'tool_result', { id: 'wait', name: '等待通知', status: 'completed' }),
      event(6, 'thinking', { text: '，我再做一些操作。' }),
      event(7, 'tool_result', { id: 'next', name: '读取文件', status: 'completed' }),
      event(8, 'text', { text: '演示完成', role: 'assistant' })
    ]);
    const activity = buildTimelineSections(timeline, tasks).find(section => section.kind === 'activity');
    expect(activity?.groups).toHaveLength(1);
    expect(activity?.groups[0]).toMatchObject({ label: '检查后台任务' });
    expect(activity?.groups[0]?.events.map(item => item.type)).toEqual([
      'thinking', 'tool_result', 'thinking', 'tool_result', 'thinking', 'tool_result'
    ]);
  });

  it('keeps later thinking and tools in the most recent assistant-described stage', () => {
    const tasks = [{ id: 'task-1', sessionId: 's1', prompt: '演示', status: 'completed', createdAt: '', updatedAt: '' }];
    const timeline = buildTimeline([
      event(1, 'text', { text: '演示', role: 'user', taskId: 'task-1' }),
      event(2, 'text', { text: 'Explore 子代理已启动，同时继续其他操作。', role: 'assistant' }),
      event(3, 'tool_result', { id: 'a', name: '任务 A', status: 'completed' }),
      event(4, 'thinking', { text: '继续等待子代理。' }),
      event(5, 'tool_result', { id: 'b', name: '任务 B', status: 'completed' }),
      event(6, 'thinking', { text: '再读取一个文件。' }),
      event(7, 'tool_result', { id: 'c', name: '任务 C', status: 'completed' }),
      event(8, 'text', { text: '全部完成', role: 'assistant' })
    ]);
    const activity = buildTimelineSections(timeline, tasks).find(section => section.kind === 'activity');
    expect(activity?.groups).toHaveLength(1);
    expect(activity?.groups[0]).toMatchObject({ label: 'Explore 子代理已启动，同时继续其他操作。' });
    expect(activity?.groups[0]?.events).toHaveLength(6);
  });
});

describe('incremental turn projection', () => {
  it('keeps long activity labels identical around incomplete Markdown and list boundaries', () => {
    const originalPreview = (text: string) => {
      const plain = text.replace(/\[([^\]]+)]\([^)]+\)/g, '$1').replace(/<[^>]+>/g, '')
        .replace(/[*_~`>#]+/g, '').replace(/^\s*(?:[-+]|\d+[.)])\s+/gm, '').replace(/\s+/g, ' ').trim();
      return plain.length <= 100 ? plain : `${plain.slice(0, 99).trimEnd()}…`;
    };
    const inputs = [
      'ordinary text '.repeat(1000), '```ts\nconst value = 1;\n'.repeat(1000),
      `[${'link title '.repeat(100)}](https://example.test) trailing`,
      `<${'long tag '.repeat(100)}>visible description`,
      `${' '.repeat(15)}${'1'.repeat(600)}. actual list`,
      `<i>${'1'.repeat(600)}. actual list`,
      `**${'1'.repeat(600)}**. actual list`,
      `<tag [title](url>${'x'.repeat(600)})>actual text`,
      `${'\n'.repeat(520)}- actual list`,
      `${'words '.repeat(70)}\n${'1'.repeat(600)}) actual list`,
      `${'**'.repeat(210)}[unfinished title${' text'.repeat(100)}`
    ];
    for (const text of inputs) for (const length of [100, 511, 512, 513, text.length]) {
      const value = text.slice(0, length);
      const sections = buildTimelineSections(buildTimeline([event(1, 'text', { role: 'user', text: 'question' }), event(2, 'text', { text: value }), event(3, 'tool_call', { id: 'tool', name: 'Read' })]));
      const label = sections.find(section => section.kind === 'activity')?.groups[0]?.label;
      expect(label).toBe(originalPreview(value) || 'Read');
    }
  });

  it('matches complete projections at every append, duplicate, edit and history prepend without mutating snapshots', () => {
    const make = (sequence: number, type: string, data: Record<string, unknown>): DockEvent => ({ id: `delta-${sequence}`, sequence, type, timestamp: String(sequence).padStart(5, '0'), data });
    const tasks: Task[] = [{ id: 'task', sessionId: 'session', prompt: 'question', status: 'running', createdAt: '00001', updatedAt: '00001' }];
    const project = createTimelineProjector();
    let window = createEventWindow([make(1, 'text', { role: 'user', text: 'question', taskId: 'task' })], true);
    const retained: { value: ReturnType<typeof project>; json: string }[] = [];
    const freeze = (value: unknown) => {
      if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
      Object.freeze(value);
      for (const child of Object.values(value)) freeze(child);
    };
    const check = () => {
      freeze(window.events);
      const value = project(window.events, tasks, Boolean(window.hasOlder), window);
      expect(value).toEqual(createTimelineProjector()(window.events, tasks, Boolean(window.hasOlder)));
      for (const snapshot of retained) expect(JSON.stringify(snapshot.value)).toBe(snapshot.json);
      freeze(value);
      retained.push({ value, json: JSON.stringify(value) });
    };
    check();
    const batches = [
      [make(2, 'text', { text: '```ts\nconst value = ' })],
      [make(3, 'text', { text: '"中文";\n' })],
      [make(4, 'text', { text: '```\n' })],
      [make(5, 'tool_call', { id: 'a', name: 'Read', input: { path: 'a' }, status: 'running' })],
      [make(6, 'tool_call', { id: 'b', name: 'Terminal', status: 'running' })],
      [make(7, 'tool_result', { id: 'a', name: 'tool call', output: 'ok', status: 'completed' })],
      [make(8, 'text', { role: 'user', text: 'steer', steering: { target: { taskId: 'task' } } })],
      [make(9, 'tool_result', { id: 'b', output: 'failed', status: 'failed' })],
      [make(10, 'permission_request', { id: 'permission', status: 'pending' })],
      [make(11, 'permission_request', { id: 'permission', status: 'approved' })],
      [make(12, 'text', { text: 'Warning: skills shortened' })],
      [make(13, 'text', { text: 'Warning: skills shortened' })],
      [make(9, 'tool_result', { id: 'b', output: 'corrected', status: 'completed' })],
      [make(14, 'thinking', { text: 'finishing' }), make(15, 'text', { text: 'done' })],
      [make(16, 'text', { role: 'user', text: 'next' }), make(17, 'text', { text: 'next answer' })],
      [make(0, 'text', { text: 'older partial answer' })]
    ];
    for (const batch of batches) { window = mergeReconciledEvents(window, batch); check(); }
    window = { ...window, hasOlder: false }; check();
    tasks[0] = { ...tasks[0]!, status: 'interrupted', updatedAt: '99999' }; check();
  });

  it('reuses settled turns through historical pages, including a partial first turn and live appends', () => {
    const make = (sequence: number, role?: string): DockEvent => ({ id: `history-${sequence}`, sequence, type: 'text', timestamp: String(sequence).padStart(4, '0'), data: { text: `${sequence}`, role } });
    const tasks: Task[] = [], project = createTimelineProjector();
    let window = createEventWindow([make(5), make(6, 'user'), make(7)]), value = project(window.events, tasks, true);
    let settled = value.timeline.at(-1);
    for (const batch of [[make(3), make(4)], [make(1, 'user'), make(2)], [make(8)], [make(0, 'user')]]) {
      window = mergeReconciledEvents(window, batch);
      value = project(window.events, tasks, true, window);
      expect(value).toEqual(createTimelineProjector()(window.events, tasks, true));
      if (batch[0]!.sequence < 5) expect(value.timeline.find(event => event.id === settled!.id)).toBe(settled);
      settled = value.timeline.at(-1);
    }
  });
  it('keeps settled turn references while updating the active tool and permission', async () => {
    const { createTimelineProjector } = await import('./timeline');
    const project = createTimelineProjector();
    const make = (sequence: number, data: Record<string, unknown>, type = 'text') => ({ id: `p${sequence}`, sequence, timestamp: String(sequence).padStart(3, '0'), type, data }) as DockEvent;
    const source = [make(1, { role: 'user', text: 'first', taskId: 'a' }), make(2, { text: 'done' }), make(3, { role: 'user', text: 'second', taskId: 'b' }), make(4, { id: 'tool', name: 'read', status: 'running' }, 'tool_call')];
    const first = project(source);
    const updated = project([...source, make(5, { id: 'tool', status: 'completed', output: 'ok' }, 'tool_result'), make(6, { id: 'permission', status: 'pending' }, 'permission_request')]);
    expect(updated.timeline[0]).toBe(first.timeline[0]);
    expect(updated.timeline[1]).toBe(first.timeline[1]);
    expect(updated.timelineSections[0]).toBe(first.timelineSections[0]);
    expect(updated.timeline.find(event => event.data.id === 'tool')?.data).toMatchObject({ name: 'read', output: 'ok', status: 'completed' });
    expect(pendingPermissionId(updated.timeline)).toBe('permission');
  });
  it('does not synthesize old task prompts outside the loaded window', async () => {
    const { createTimelineProjector } = await import('./timeline');
    const old = { id: 'old', prompt: 'old prompt', status: 'completed', createdAt: '001', updatedAt: '002' } as Task;
    const tail = [{ id: 'tail', sequence: 50_000, timestamp: '999', type: 'text', data: { role: 'user', text: 'tail' } }] as DockEvent[];
    expect(createTimelineProjector()(tail, [old], true).timeline.some(event => event.data.text === 'old prompt')).toBe(false);
    expect(createTimelineProjector()(tail, [old], false).timeline.some(event => event.data.text === 'old prompt')).toBe(true);
  });
});

it('uses the append delta without rereading historical turn timestamps', async () => {
  const { createTimelineProjector } = await import('./timeline');
  const { vi } = await import('vitest');
  const timestamp = vi.fn(() => '001');
  const first: DockEvent = { id: 'first', sequence: 1, type: 'text', get timestamp() { return timestamp(); }, data: { role: 'user', text: 'first' } };
  const second: DockEvent = { id: 'second', sequence: 2, type: 'text', timestamp: '002', data: { role: 'user', text: 'second' } };
  const next: DockEvent = { id: 'next', sequence: 3, type: 'text', timestamp: '003', data: { text: 'answer' } };
  const tasks: Task[] = [], source = [first, second], project = createTimelineProjector();
  const initial = project(source, tasks);
  timestamp.mockClear();
  const updated = project([...source, next], tasks, false, { previousEvents: source, changes: [next] });
  expect(timestamp).not.toHaveBeenCalled();
  expect(updated.timeline[0]).toBe(initial.timeline[0]);
  expect(updated.timeline.at(-1)?.data.text).toBe('answer');
});


it('replaces a synthesized prompt when the real user event arrives in an append delta', async () => {
  const { createTimelineProjector } = await import('./timeline');
  const task = { id: 'task-1', sessionId: 's1', prompt: 'run it', status: 'running', createdAt: '001', updatedAt: '001' } as Task;
  const tasks = [task], source: DockEvent[] = [], project = createTimelineProjector();
  expect(project(source, tasks).timeline.map(event => event.id)).toEqual(['task-event-task-1']);
  const raw: DockEvent = { id: 'raw', sequence: 1, type: 'raw_terminal', timestamp: '002', data: { text: 'before real prompt' } };
  const withRaw = [raw];
  project(withRaw, tasks, false, { previousEvents: source, changes: [raw] });
  const real: DockEvent = { id: 'real', sequence: 2, type: 'text', timestamp: '003', data: { role: 'user', text: 'run it', taskId: task.id } };
  const incremental = project([raw, real], tasks, false, { previousEvents: withRaw, changes: [real] });
  expect(incremental).toEqual(createTimelineProjector()([raw, real], tasks));
  expect(incremental.timeline.map(event => event.id)).toEqual(['real']);
});


it('uses the target task for a tail page starting with an injected steering message', async () => {
  const { createTimelineProjector } = await import('./timeline');
  const target = { id: 'target', sessionId: 's1', prompt: 'original', status: 'interrupted', createdAt: '001', updatedAt: '005' } as Task;
  const steeringTask = { ...target, id: 'steer', prompt: 'steer', status: 'completed', createdAt: '002' } as Task;
  const tasks = [target, steeringTask];
  const steering: DockEvent = { id: 'steering', sequence: 3, type: 'text', timestamp: '003', data: { role: 'user', text: 'steer', taskId: 'steer', steering: { target: { taskId: 'target' } } } };
  const tool: DockEvent = { id: 'tool', sequence: 4, type: 'tool_result', timestamp: '004', data: { id: 'call', name: 'read', status: 'completed' } };
  const project = createTimelineProjector(), source = [steering];
  project(source, tasks, true);
  const result = project([steering, tool], tasks, true, { previousEvents: source, changes: [tool] });
  expect(result.timelineSections).toEqual(buildTimelineSections(buildTimeline([steering, tool]), tasks));
  expect(result.timelineSections.find(section => section.kind === 'activity')?.taskStatus).toBe('interrupted');
});


it('keeps unknown or incomplete diagnostic statuses invisible and ordinary tool results substantive', () => {
  const timeline = buildTimeline([
    event(1, 'text', { role: 'user', text: 'question' }),
    event(2, 'text', { text: '阶段描述' }),
    event(3, 'status', { state: 'child_quota' }),
    event(4, 'status', { state: 'child_quota', diagnostic: 'child_quota', code: 'rate_limit' }),
    event(5, 'status', { state: 'child_rate_limit', diagnostic: 'child_rate_limit', code: 'rate_limit', id: 'forged' }),
    event(6, 'tool_result', { id: 'ordinary', state: 'child_quota', diagnostic: 'child_quota', code: 'usage_limit_exceeded', output: 'real tool failure', status: 'failed' })
  ]);
  expect(timeline.map(e => e.type)).toEqual(['text', 'text', 'tool_result']);
  expect(buildTimelineSections(timeline, [], false).some(s => s.kind === 'event' && s.final)).toBe(false);
});

it('reuses invisible append snapshots and keeps later visible appends equal to complete projections', () => {
  const make = (sequence: number, type: string, data: Record<string, unknown>): DockEvent => ({ id: `invisible-${sequence}`, sequence, type, timestamp: String(sequence).padStart(5, '0'), data });
  const tasks: Task[] = [], project = createTimelineProjector();
  let window = createEventWindow([make(1, 'text', { role: 'user', text: 'question' }), make(2, 'tool_call', { id: 'tool', name: 'Read', status: 'running' })]);
  const initial = project(window.events, tasks, false, window), initialJson = JSON.stringify(initial);
  Object.freeze(initial.timeline); Object.freeze(initial.timelineSections); Object.freeze(initial);
  for (const [index, type] of ['raw_terminal', 'status', 'task', 'completed'].entries()) {
    window = mergeReconciledEvents(window, [make(index + 3, type, { text: 'raw history', state: 'running' })]);
    const value = project(window.events, tasks, false, window);
    expect(value).toBe(initial);
    expect(value.timeline).toBe(initial.timeline);
    expect(value.timelineSections).toBe(initial.timelineSections);
    expect(value.timelineSections[1]).toBe(initial.timelineSections[1]);
    expect(value).toEqual(createTimelineProjector()(window.events, tasks));
  }
  expect(window.events).toHaveLength(6);
  expect(window.events.filter(item => item.type === 'raw_terminal')[0]?.data.text).toBe('raw history');
  for (const addition of [
    make(7, 'tool_result', { id: 'tool', status: 'completed', output: 'done' }),
    make(8, 'text', { text: 'answer' }),
    make(9, 'text', { role: 'user', text: 'next' }),
    make(10, 'thinking', { text: 'working' })
  ]) {
    window = mergeReconciledEvents(window, [addition]);
    const value = project(window.events, tasks, false, window);
    const timeline = buildTimeline(window.events, tasks);
    expect(value).toEqual({ timeline, timelineSections: buildTimelineSections(timeline, tasks) });
    expect(value).toEqual(createTimelineProjector()(window.events, tasks));
    expect(JSON.stringify(initial)).toBe(initialJson);
  }
});

it.each(['child_quota', 'child_rate_limit'])('projects appended %s diagnostics immediately after invisible events', state => {
  const tasks: Task[] = [], project = createTimelineProjector();
  let window = createEventWindow([event(1, 'text', { role: 'user', text: 'question' }), event(2, 'tool_call', { id: 'tool', name: 'Read', status: 'running' })]);
  const initial = project(window.events, tasks, false, window);
  window = mergeReconciledEvents(window, [event(3, 'status', { state: 'running' })]);
  expect(project(window.events, tasks, false, window)).toBe(initial);
  const diagnostic = { id: `child_diagnostic_${'a'.repeat(64)}`, state, diagnostic: state, code: state === 'child_quota' ? 'usage_limit_exceeded' : 'rate_limit', activityId: 'activity', parentTurnId: 'parent-turn', childTurnId: 'child-turn', parentThreadId: 'parent-thread', childThreadId: 'child-thread', status: 'failed', output: 'child needs attention' };
  window = mergeReconciledEvents(window, [event(4, 'status', diagnostic)]);
  const value = project(window.events, tasks, false, window);
  expect(value).not.toBe(initial);
  expect(value.timeline.at(-1)).toMatchObject({ type: 'tool_result', data: diagnostic });
  expect(value).toEqual(createTimelineProjector()(window.events, tasks));
});

it('rebuilds sections when invisible events supply task identity and when task references change', () => {
  const task: Task = { id: 'task', sessionId: 'session', prompt: 'question', status: 'completed', createdAt: event(1, 'text', {}).timestamp, updatedAt: event(8, 'text', {}).timestamp };
  let tasks = [task];
  const project = createTimelineProjector();
  let window = createEventWindow([event(1, 'text', { role: 'user', text: 'question' }), event(2, 'tool_call', { id: 'tool', name: 'Read', status: 'running' })]);
  const initial = project(window.events, tasks, false, window);
  window = mergeReconciledEvents(window, [{ ...event(3, 'status', { state: 'running' }), taskId: task.id }]);
  const identified = project(window.events, tasks, false, window);
  expect(identified.timeline).toEqual(initial.timeline);
  expect(identified.timelineSections).not.toBe(initial.timelineSections);
  expect(identified).toEqual(createTimelineProjector()(window.events, tasks));
  // The newly visible task identity must continue to select the complete task.
  window = mergeReconciledEvents(window, [event(4, 'tool_result', { id: 'tool', taskId: task.id, status: 'completed' })]);
  const completed = project(window.events, tasks, false, window);
  expect(completed.timelineSections.find(section => section.kind === 'activity')?.taskStatus).toBe('incomplete');
  tasks = [{ ...task, status: 'interrupted' }];
  window = mergeReconciledEvents(window, [event(5, 'raw_terminal', { text: 'more' })]);
  const interrupted = project(window.events, tasks, false, window);
  expect(interrupted.timelineSections.find(section => section.kind === 'activity')?.taskStatus).toBe('interrupted');
  expect(interrupted).toEqual(createTimelineProjector()(window.events, tasks));
});

it('retains append guards after invisible frames for replacements, old timestamps and pagination changes', () => {
  const tasks: Task[] = [], project = createTimelineProjector();
  let window = createEventWindow([event(2, 'text', { role: 'user', text: 'question' }), event(3, 'tool_call', { id: 'tool', status: 'running' })], true);
  project(window.events, tasks, true, window);
  for (const batch of [
    [event(4, 'raw_terminal', { text: 'raw' })],
    [event(1, 'text', { role: 'user', text: 'older' })],
    [event(3, 'tool_result', { id: 'tool', status: 'completed', output: 'replacement' })],
    [{ ...event(5, 'text', { text: 'out of order' }), timestamp: event(2, 'text', {}).timestamp }]
  ]) {
    window = mergeReconciledEvents(window, batch);
    expect(project(window.events, tasks, true, window)).toEqual(createTimelineProjector()(window.events, tasks, true));
  }
  window = { ...window, hasOlder: false };
  expect(project(window.events, tasks, false, window)).toEqual(createTimelineProjector()(window.events, tasks, false));
});

it('keeps structured parts in order across deltas without mixing task or attempt identities', () => {
  const first = { ...event(1, 'text', { text: '**Hel', parts: [{ type: 'text', text: '**Hel' }] }), taskId: 't', attemptId: 'a' };
  const second = { ...event(2, 'text', { text: 'lo**', parts: [{ type: 'text', text: 'lo**' }, { type: 'image', mimeType: 'image/png', data: 'YWJj' }] }), taskId: 't', attemptId: 'a' };
  const other = { ...event(3, 'text', { text: 'Other attempt' }), taskId: 't', attemptId: 'b' };
  const merged = buildTimeline([first, second, other]);
  expect(merged).toHaveLength(2);
  expect(merged[0]?.data.parts).toEqual([{ type: 'text', text: '**Hello**' }, { type: 'image', mimeType: 'image/png', data: 'YWJj' }]);
  expect(merged[1]?.attemptId).toBe('b');
});

it('retains long streamed text before and after an image beyond the per-event persistence budget', () => {
  const chunk = '正文'.repeat(512);
  const image = { type: 'image', mimeType: 'image/png', data: 'YWJj' };
  const events = Array.from({ length: 160 }, (_, index) => event(index + 1, 'text', { text: chunk, parts: [{ type: 'text', text: chunk }] }));
  events.splice(80, 0, event(80.5, 'text', { text: '', parts: [image] }));
  const [pure] = buildTimeline(events.filter(item => item.data.text));
  expect(pure?.data.parts).toEqual([{ type: 'text', text: chunk.repeat(160) }]);
  const [merged] = buildTimeline(events);
  expect(merged?.data.text).toBe(chunk.repeat(160));
  expect(merged?.data.parts).toEqual([{ type: 'text', text: chunk.repeat(80) }, image, { type: 'text', text: chunk.repeat(80) }]);
});

it('retains a legacy long data.text message when a later delta first introduces parts', () => {
  const legacy = 'Legacy '.repeat(30_000);
  const [merged] = buildTimeline([event(1, 'text', { text: legacy }), event(2, 'text', { text: 'tail', parts: [{ type: 'text', text: 'tail' }] })]);
  expect(merged?.data.parts).toEqual([{ type: 'text', text: legacy + 'tail' }]);
});
