import { describe, expect, it } from 'vitest';
import { buildTimeline, buildTimelineSections, pendingPermissionId, toolDisplayName } from './timeline';

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
