import { describe, expect, it } from 'vitest';
import type { RunSummary, Session } from './api';
import type { WorkbenchView } from './workspace-model';
import { attentionReasonForSession, formatRelativeTime, groupSessionsByWorkspace, needsAttention, orderSessionsForWorkbench, sessionErrorSummary, sessionMatchesView, workbenchCounts, workbenchTaskSection, workbenchViewLabels, workbenchViewOrder, workspaceName } from './workspace-model';

const session = (id: string, cwd: string, state: string, updatedAt: string): Session => ({ id, cwd, state, updatedAt, createdAt: updatedAt, agentId: 'codex', runId: `run-${id}` });

describe('workspace model', () => {
  it('按 cwd 聚合，并在默认视图将需要处理的工作区置顶', () => {
    const groups = groupSessionsByWorkspace([
      session('1', '/repo/alpha', 'idle', '2026-08-20T00:00:00Z'),
      session('2', '/repo/beta/', 'thinking', '2026-08-22T00:00:00Z'),
      session('3', '/repo/alpha/', 'failed', '2026-08-21T00:00:00Z')
    ]);
    expect(groups.map(group => group.name)).toEqual(['alpha', 'beta']);
    expect(groups[0].sessions.map(item => item.id)).toEqual(['3', '1']);
  });

  it('按任务数计状态，并把待执行指令数作为独立口径', () => {
    const archived = { ...session('6', '/repo/archive', 'completed', ''), archivedAt: '2026-08-30T00:00:00Z' };
    const sessions = [
      session('1', '/repo', 'thinking', ''),
      session('2', '/repo', 'created', ''),
      session('3', '/repo', 'idle', ''),
      session('4', '/repo', 'failed', ''),
      session('5', '/repo', 'completed', ''),
      archived
    ];
    const summaries: Record<string, RunSummary> = {
      '1': { sessionId: '1', taskId: 't1', prompt: '正在运行且还有排队任务', status: 'running', queuedCount: 2, updatedAt: '' },
      '2': { sessionId: '2', taskId: 't2', prompt: '等待调度', status: 'queued', queuedCount: 1, updatedAt: '' }
    };
    // 筛选收敛为 5 项，返回对象的键就是这 5 项加一个 queuedCommands；
    // 「有排队的任务数」不再是视图，待执行指令总数只以 queuedCommands 这一个口径出现。
    // active 是 2：thinking 的 '1'，以及 created 但已排队一条的 '2'——排队中也属于「进行中」。
    expect(workbenchCounts(sessions, summaries)).toEqual({ all: 5, active: 2, queuedCommands: 3, attention: 2, completed: 1, archived: 1 });
    // created 有排队指令 → Agent 还有活可干，不算卡在用户这一侧，而是归入「进行中」。
    expect(sessionMatchesView(sessions[1], 'attention', summaries['2'])).toBe(false);
    expect(sessionMatchesView(sessions[1], 'active', summaries['2'])).toBe(true);
    const noTask = session('no-task', '/repo', 'created', '');
    expect(sessionMatchesView(noTask, 'attention')).toBe(true);
    expect(sessionMatchesView(sessions[2], 'attention')).toBe(true);
    // 失败与已停止归入「待你处理」，不再是单独的筛选项。
    expect(sessionMatchesView(sessions[3], 'attention')).toBe(true);
    expect(sessionMatchesView(session('stopped', '/repo', 'stopped', ''), 'attention')).toBe(true);
    expect(sessionMatchesView(archived, 'completed')).toBe(false);
    expect(groupSessionsByWorkspace(sessions, 'attention', summaries)[0].sessions.map(item => item.id)).toEqual(['3', '4']);
    expect(groupSessionsByWorkspace(sessions, 'archived')[0].sessions[0].id).toBe('6');
    expect(groupSessionsByWorkspace(sessions, 'all', summaries)[0].queuedCount).toBe(3);
    expect(groupSessionsByWorkspace(sessions, 'all').flatMap(group => group.sessions)).not.toContain(archived);
  });

  /**
   * 「已完成」芯片曾裸判 `state === 'completed'`，而分区归属走 workbenchTaskSection：
   * 一条交付后又追加了指令的任务于是被「已完成」和「进行中」两个芯片同时数到，
   * 分区里却只出现在「进行中」一处。这条用例只盯这一件事，与下面那条
   * 「筛选计数与分区条数同源」的全量交叉断言互为粗细两道防线。
   */
  it('已完成且有排队指令的任务只被「进行中」计数，不被「已完成」重复数一次', () => {
    const doneQueued = session('done-queued', '/repo', 'completed', '2026-08-29T03:00:00Z');
    const summaries: Record<string, RunSummary> = {
      'done-queued': { sessionId: 'done-queued', taskId: 'tdq', prompt: '交付后又排了一条', status: 'completed', queuedCount: 1, updatedAt: '' }
    };
    const counts = workbenchCounts([doneQueued], summaries);
    expect(counts.active).toBe(1);
    expect(counts.completed).toBe(0);
    // 一条 session 只能被一个芯片数到：三档相加等于未归档总数。
    expect(counts.attention + counts.active + counts.completed).toBe(counts.all);
    expect(workbenchTaskSection(doneQueued, summaries['done-queued'])).toBe('active');
    expect(sessionMatchesView(doneQueued, 'completed', summaries['done-queued'])).toBe(false);
    // 队列清空后它才回到「已完成」：视图判据只跟着分区函数动。
    expect(sessionMatchesView(doneQueued, 'completed')).toBe(true);
    expect(workbenchCounts([doneQueued])).toMatchObject({ active: 0, completed: 1 });
  });

  it('筛选项常量即界面顺序，标签只有这一份', () => {
    expect([...workbenchViewOrder]).toEqual(['all', 'attention', 'active', 'completed', 'archived']);
    expect(workbenchViewOrder.map(view => workbenchViewLabels[view])).toEqual(['总览', '待你处理', '进行中', '已完成', '已归档']);
    expect(Object.keys(workbenchViewLabels).sort()).toEqual([...workbenchViewOrder].sort());
  });

  it('兼容 Unix 与 Windows 工作目录', () => {
    expect(workspaceName('/repo/dutydeck/')).toBe('dutydeck');
    expect(workspaceName('C:\\work\\dutydeck\\')).toBe('dutydeck');
  });

  it('默认按待处理、进行中、最近的优先级排列，过滤视图保持时间顺序', () => {
    const sessions = [
      session('done', '/repo', 'completed', '2026-08-29T05:00:00Z'),
      session('working', '/repo', 'thinking', '2026-08-29T02:00:00Z'),
      session('failed', '/repo', 'failed', '2026-08-29T01:00:00Z'),
      session('permission', '/repo', 'waiting_for_permission', '2026-08-29T03:00:00Z')
    ];
    // failed 的 updatedAt 比 working 更早却排在它前面，只可能来自 attention 这一档的 rank 0。
    expect(orderSessionsForWorkbench(sessions, 'all').map(item => item.id)).toEqual(['permission', 'failed', 'working', 'done']);
    expect(orderSessionsForWorkbench(sessions, 'attention').map(item => item.id)).toEqual(['permission', 'failed']);
    expect(orderSessionsForWorkbench(sessions, 'active').map(item => item.id)).toEqual(['working']);
  });

  it('将更新时间格式化为可扫描的相对时间', () => {
    const now = Date.parse('2026-08-30T12:00:00Z');
    expect(formatRelativeTime('2026-08-30T11:58:00Z', now)).toBe('2 分钟前');
    expect(formatRelativeTime('2026-08-30T08:00:00Z', now)).toBe('4 小时前');
    expect(formatRelativeTime('invalid', now)).toBe('时间未知');
  });

  it('优先展示 Runtime 错误摘要，并隐藏凭据、归一化换行与截断超长文本', () => {
    const raw = `\u001b[31m连接本地进程失败\u001b[0m\nAuthorization: Bearer super-secret token=raw-token --api-key cli-secret dutydeck_group_tools_token=runtime-secret ${'详情'.repeat(100)}`;
    const summary = sessionErrorSummary(raw)!;
    expect(summary).toContain('连接本地进程失败 Authorization: [已隐藏]');
    expect(summary).toContain('token=[已隐藏]');
    expect(summary).toContain('--api-key [已隐藏]');
    expect(summary).toContain('dutydeck_group_tools_token=[已隐藏]');
    expect(summary).not.toMatch(/super-secret|raw-token|cli-secret|runtime-secret|\n|\u001b/);
    expect(Array.from(summary)).toHaveLength(140);
    expect(summary.endsWith('…')).toBe(true);
    expect(attentionReasonForSession({ ...session('idle-error', '/repo', 'idle', ''), error: raw })).toBe(`任务异常：${summary}；打开详情查看`);
  });

  /**
   * 交叉断言：同一批数据，「筛选计数」与「分区归属」必须给出同一个数。
   *
   * 这条用例守的不是某个具体数字，而是「口径只有一份」这件事本身。
   * 此前 sessionMatchesView('attention') 把 failed/stopped 排除、
   * workbenchTaskSection 把它们算入，两套判断各自单测全绿，却让同一屏上
   * 页首说「12 个待处理」、筛选芯片说「0」、分区标题说「12 个」——
   * 因为没有任何一条用例把两个入口的结果放在一起比。
   *
   * 谁要是将来又在某个调用点旁边另写一份「待你处理」或「进行中」的条件，
   * 这里就会红。修的方式是回到 needsAttention / workbenchTaskSection，
   * 不是调这里的期望值。
   */
  it('筛选计数与分区条数同源：两个入口对同一批数据给出同一个数', () => {
    const sessions = [
      session('permission', '/repo', 'waiting_for_permission', '2026-08-29T09:00:00Z'),
      // 等待授权 + 有排队指令：授权优先，只能落在 attention 一处。
      // 如果哪天有人把「进行中」写成 `activeStates.has(state) || queuedCount > 0`，
      // 它就会同时被 attention 与 active 两个芯片数到，而分区只放一份，下面的不重不漏等式会红。
      session('permission-queued', '/repo', 'waiting_for_permission', '2026-08-29T08:30:00Z'),
      session('failed', '/repo', 'failed', '2026-08-29T08:00:00Z'),
      session('stopped', '/repo', 'stopped', '2026-08-29T07:00:00Z'),
      session('idle', '/repo', 'idle', '2026-08-29T06:00:00Z'),
      session('interrupted', '/repo', 'interrupted', '2026-08-29T05:30:00Z'),
      // created + 有排队指令：Agent 还有活可干，属于「进行中」而不是「待你处理」。
      session('queued', '/repo', 'created', '2026-08-29T05:00:00Z'),
      // idle + 有排队指令：状态不在 activeStates 里，但队列没空，同样是「进行中」。
      // 这条就是「筛选芯片只判 activeStates」时会被漏数的那一类。
      session('idle-queued', '/repo', 'idle', '2026-08-29T04:45:00Z'),
      // created 且没有排队指令：没有可执行的指令，卡在用户这一侧。
      session('empty', '/repo', 'created', '2026-08-29T04:30:00Z'),
      session('working', '/repo', 'thinking', '2026-08-29T04:00:00Z'),
      session('done', '/repo', 'completed', '2026-08-29T03:00:00Z'),
      // completed + 有排队指令：交付后又追加了指令，Agent 还有活可干，属于「进行中」。
      // 这条就是「已完成」芯片裸判 state === 'completed' 时会被重复数到的那一类：
      // 芯片说 active:1 / completed:1（同一条 session），分区却只把它放进「进行中」。
      session('done-queued', '/repo', 'completed', '2026-08-29T02:45:00Z'),
      { ...session('archived', '/repo', 'completed', '2026-08-29T02:00:00Z'), archivedAt: '2026-08-29T02:30:00Z' }
    ];
    const summaries: Record<string, RunSummary> = {
      queued: { sessionId: 'queued', taskId: 'tq', prompt: '已接收，排了两条', status: 'queued', queuedCount: 2, updatedAt: '' },
      'idle-queued': { sessionId: 'idle-queued', taskId: 'tiq', prompt: '空闲但队列没空', status: 'queued', queuedCount: 1, updatedAt: '' },
      'permission-queued': { sessionId: 'permission-queued', taskId: 'tpq', prompt: '等授权，后面还排着', status: 'running', queuedCount: 3, updatedAt: '' },
      'done-queued': { sessionId: 'done-queued', taskId: 'tdq', prompt: '交付后又排了一条', status: 'completed', queuedCount: 1, updatedAt: '' }
    };

    const counts = workbenchCounts(sessions, summaries);
    const current = sessions.filter(item => !item.archivedAt);
    const inSection = (section: string) => current.filter(item => workbenchTaskSection(item, summaries[item.id]) === section);

    // 待你处理：筛选计数 === 分区条数 === needsAttention 直接数出来的条数。
    expect(counts.attention).toBe(inSection('attention').length);
    expect(counts.attention).toBe(current.filter(item => needsAttention(item, summaries[item.id])).length);
    expect(inSection('attention').map(item => item.id).sort()).toEqual(['empty', 'failed', 'idle', 'interrupted', 'permission', 'permission-queued', 'stopped']);

    // 进行中：与 attention 完全同构的等式。
    //
    // 设计文档 §1 把「已排队的任务」也划进「进行中」层，所以判据不能只看
    // activeStates：idle-queued 状态不活跃、队列却没空，正是筛选芯片曾经漏数的那类。
    // sessionMatchesView('active') 现在直接委托 workbenchTaskSection，两边物理同源。
    expect(inSection('active').map(item => item.id).sort()).toEqual(['done-queued', 'idle-queued', 'queued', 'working']);
    expect(counts.active).toBe(inSection('active').length);
    // 授权优先：permission-queued 有 3 条排队，但只进 attention，不被 active 重复计数。
    expect(counts.attention + counts.active).toBe(current.filter(item => workbenchTaskSection(item, summaries[item.id]) !== 'recent').length);

    // 已完成：视图名叫 completed、分区 key 叫 recent，但两者是同一个集合。
    // 委托前这里裸判 state === 'completed'，done-queued 会同时被 completed 与 active
    // 数到（芯片 2 + 4 = 6 > 未归档的 5 条里真正落在前两档的条数），分区却只放一份。
    expect(inSection('recent').map(item => item.id)).toEqual(['done']);
    expect(counts.completed).toBe(inSection('recent').length);
    expect(sessionMatchesView(current.find(item => item.id === 'done-queued')!, 'completed', summaries['done-queued'])).toBe(false);
    expect(sessionMatchesView(current.find(item => item.id === 'done-queued')!, 'active', summaries['done-queued'])).toBe(true);

    // 五个视图都必须与分区口径自洽：all 覆盖全部未归档，attention/active/completed
    // 各等于对应分区，archived 则不与分区重叠地兜住剩下的部分。
    const inView = (view: WorkbenchView) => sessions.filter(item => sessionMatchesView(item, view, summaries[item.id]));
    expect(inView('all').length).toBe(counts.all);
    expect(inView('attention').map(item => item.id).sort()).toEqual(inSection('attention').map(item => item.id).sort());
    expect(inView('active').map(item => item.id).sort()).toEqual(inSection('active').map(item => item.id).sort());
    expect(inView('completed').map(item => item.id).sort()).toEqual(inSection('recent').map(item => item.id).sort());
    expect(inView('completed').length).toBe(counts.completed);
    expect(inView('archived').length).toBe(counts.archived);
    // 「已完成」视图必落在 recent 分区，绝不会同时出现在前两档。
    expect(inView('completed').every(item => workbenchTaskSection(item, summaries[item.id]) === 'recent')).toBe(true);
    // 三个芯片互不重叠地覆盖全部未归档任务：没有任何一条被数两次。
    expect(counts.attention + counts.active + counts.completed).toBe(counts.all);

    // 每个未归档任务恰好落在一个分区里，三个分区加起来等于 all，不重不漏。
    expect(inSection('attention').length + inSection('active').length + inSection('recent').length).toBe(counts.all);
    expect(counts.all).toBe(current.length);

    // 归档既不进任何分区，也不计入 all。
    expect(counts.archived).toBe(1);
    expect(needsAttention(sessions.at(-1)!, undefined)).toBe(false);
  });
});
