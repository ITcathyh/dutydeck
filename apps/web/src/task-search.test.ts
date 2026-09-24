import { describe, expect, it } from 'vitest';
import type { Agent, RunSummary, Session } from './api';
import { normalizeSearchQuery, searchTasks, taskSearchHaystack, taskSearchTerms } from './task-search';

// 检索模型是纯函数：中文没有空格，所以基线必须是「大小写折叠后的子串匹配」而不是按空白分词；
// 多词查询是 AND，词可以散落在不同字段。这里盯住的是最容易回归的四件事：
// 中文子串、AND 语义、cwd/agentId 这类「原始值」也可检索、以及不许截断结果。

const session = (id: string, overrides: Partial<Session> = {}): Session => ({
  id,
  agentId: 'codex',
  state: 'idle',
  cwd: '/repo/dutydeck',
  runId: `run-${id}`,
  createdAt: '2026-08-20T00:00:00Z',
  updatedAt: '2026-08-20T00:00:00Z',
  ...overrides
});
const summary = (sessionId: string, prompt: string): RunSummary => ({ sessionId, taskId: `task-${sessionId}`, prompt, status: 'completed', queuedCount: 0, updatedAt: '2026-08-20T00:00:00Z' });
const agents: Agent[] = [
  { id: 'codex', name: 'Codex', protocol: 'acp', permissionMode: 'ask' },
  { id: 'claude-code', name: 'Claude Code', protocol: 'pty-cli', permissionMode: 'ask' }
];
const run = (query: string, sessions: Session[], summaries: Record<string, RunSummary> = {}) => searchTasks({ sessions, summaries, agents, query });
const ids = (matches: ReturnType<typeof searchTasks>) => matches.map(match => match.session.id);

describe('normalizeSearchQuery', () => {
  it('折叠大小写、合并空白并去掉首尾空格', () => {
    expect(normalizeSearchQuery('  Dutydeck   FAILED  ')).toBe('dutydeck failed');
  });

  it('全角输入归一化为半角，避免中文输入法下检索不到', () => {
    expect(normalizeSearchQuery('Ｄｕｔｙｄｅｃｋ')).toBe('dutydeck');
  });

  it('纯空白查询归一化为空串', () => {
    expect(normalizeSearchQuery(' \n\t ')).toBe('');
    expect(taskSearchTerms('   ')).toEqual([]);
  });
});

describe('taskSearchHaystack', () => {
  it('工作区同时收录短名与完整 cwd，Agent 同时收录展示名与原始 id', () => {
    const haystack = taskSearchHaystack(session('1', { cwd: '/repo/API', agentId: 'claude-code' }), summary('1', '修复登录超时'), agents[1]);
    expect(haystack.goal).toBe('修复登录超时');
    expect(haystack.workspace).toBe('api /repo/api');
    expect(haystack.agent).toBe('claude code claude-code');
  });

  it('goal 候选同时包含 session.name 与原 summary.prompt', () => {
    const haystack = taskSearchHaystack(session('1', { name: '自定义发布任务' }), summary('1', '修复登录超时'));
    expect(haystack.goal).toBe('自定义发布任务 修复登录超时');
  });

  it('没有任务目标时用 fallback 标题占位，而不是空串', () => {
    expect(taskSearchHaystack(session('1', { source: 'lark' })).goal).toBe('来自飞书的任务');
    expect(taskSearchHaystack(session('2'), summary('2', '   ')).goal).toBe('尚未获取任务目标');
  });

  it('独立 worktree 任务同时可按源项目目录和实际执行目录检索', () => {
    const haystack = taskSearchHaystack(session('1', {
      cwd: '/home/u/.dutydeck/workspaces/ses_one',
      workspaceMode: 'worktree',
      workspaceSourceCwd: '/repo/project'
    }));
    // 源项目短名/全路径在前（项目导航口径），实际执行目录仍可被检索到。
    expect(haystack.workspace).toBe('project /repo/project ses_one /home/u/.dutydeck/workspaces/ses_one');
  });
});

describe('searchTasks 匹配语义', () => {
  it('大小写无关：小写查询命中大写目标', () => {
    const sessions = [session('1')];
    expect(ids(run('dutydeck', sessions, { '1': summary('1', 'Fix DUTYDECK login timeout') }))).toEqual(['1']);
    expect(ids(run('DUTYDECK', sessions, { '1': summary('1', 'fix dutydeck login timeout') }))).toEqual(['1']);
  });

  it('中文按子串匹配，不依赖空格分词', () => {
    const sessions = [session('1')];
    const summaries = { '1': summary('1', '修复登录超时问题并补齐回归测试') };
    expect(ids(run('登录超时', sessions, summaries))).toEqual(['1']);
    expect(ids(run('回归', sessions, summaries))).toEqual(['1']);
    expect(ids(run('部署', sessions, summaries))).toEqual([]);
  });

  it('改名后能搜新名字，也仍能搜历史任务目标', () => {
    const sessions = [session('1', { name: '周四线上发布保障' })];
    const summaries = { '1': summary('1', '修复登录超时问题并补齐回归测试') };
    expect(ids(run('线上发布', sessions, summaries))).toEqual(['1']);
    expect(ids(run('登录超时', sessions, summaries))).toEqual(['1']);
  });

  it('多词查询是 AND，且各词可以落在不同字段', () => {
    const sessions = [session('1', { cwd: '/repo/dutydeck' }), session('2', { cwd: '/repo/other' })];
    const summaries = { '1': summary('1', '构建失败需要排查'), '2': summary('2', '构建失败需要排查') };
    expect(ids(run('dutydeck 失败', sessions, summaries))).toEqual(['1']);
    expect(ids(run('dutydeck 失败 不存在的词', sessions, summaries))).toEqual([]);
  });

  it('可用工作区短名或完整 cwd 命中同一个任务', () => {
    const sessions = [session('1', { cwd: '/repo/api' })];
    expect(ids(run('api', sessions))).toEqual(['1']);
    expect(ids(run('/repo/api', sessions))).toEqual(['1']);
    expect(ids(run('/repo', sessions))).toEqual(['1']);
  });

  it('可用 Agent 展示名或原始 agentId 命中同一个任务', () => {
    const sessions = [session('1', { agentId: 'claude-code' })];
    expect(ids(run('Claude Code', sessions))).toEqual(['1']);
    expect(ids(run('claude-code', sessions))).toEqual(['1']);
  });

  it('agentId 没有对应 Agent 时仍可按原始 id 检索', () => {
    expect(ids(run('gemini', [session('1', { agentId: 'gemini-cli' })]))).toEqual(['1']);
  });

  it('空查询与纯空白查询返回空数组，不返回全部任务', () => {
    const sessions = [session('1'), session('2')];
    expect(run('', sessions)).toEqual([]);
    expect(run('   \n ', sessions)).toEqual([]);
  });
});

describe('searchTasks 排序', () => {
  it('目标命中优先于工作区，工作区优先于 Agent', () => {
    const sessions = [
      session('agent-hit', { cwd: '/repo/alpha', agentId: 'codex' }),
      session('workspace-hit', { cwd: '/repo/codex-lab', agentId: 'claude-code' }),
      session('goal-hit', { cwd: '/repo/beta', agentId: 'claude-code' })
    ];
    const matches = run('codex', sessions, { 'goal-hit': summary('goal-hit', '重构 codex 适配器') });
    expect(ids(matches)).toEqual(['goal-hit', 'workspace-hit', 'agent-hit']);
    expect(matches.map(match => match.fields)).toEqual([['goal'], ['workspace'], ['agent']]);
  });

  it('同字段内前缀命中优先于中段命中', () => {
    const sessions = [session('mid'), session('prefix')];
    const matches = run('登录', sessions, { mid: summary('mid', '修复登录超时'), prefix: summary('prefix', '登录超时修复') });
    expect(ids(matches)).toEqual(['prefix', 'mid']);
  });

  it('得分相同时按 updatedAt 倒序，顺序稳定可预测', () => {
    const sessions = [
      session('old', { updatedAt: '2026-08-01T00:00:00Z' }),
      session('new', { updatedAt: '2026-08-30T00:00:00Z' }),
      session('mid', { updatedAt: '2026-08-15T00:00:00Z' })
    ];
    const summaries = Object.fromEntries(sessions.map(item => [item.id, summary(item.id, '同一个目标文案')]));
    expect(ids(run('目标', sessions, summaries))).toEqual(['new', 'mid', 'old']);
    expect(ids(run('目标', [...sessions].reverse(), summaries))).toEqual(['new', 'mid', 'old']);
  });

  it('缺少 updatedAt 时回退到 createdAt 排序', () => {
    const sessions = [
      session('a', { updatedAt: '', createdAt: '2026-08-05T00:00:00Z' }),
      session('b', { updatedAt: '', createdAt: '2026-08-25T00:00:00Z' })
    ];
    const summaries = { a: summary('a', '同一个目标'), b: summary('b', '同一个目标') };
    expect(ids(run('目标', sessions, summaries))).toEqual(['b', 'a']);
  });
});

describe('searchTasks 全量性与命中字段', () => {
  it('24 条匹配全部返回，模型层不做任何截断', () => {
    const sessions = Array.from({ length: 24 }, (_, index) => session(`s${String(index).padStart(2, '0')}`, { cwd: '/repo/dutydeck' }));
    const matches = run('dutydeck', sessions);
    expect(matches).toHaveLength(24);
    expect(new Set(ids(matches)).size).toBe(24);
  });

  it('多字段同时命中时按 goal → workspace → agent 顺序报告 fields', () => {
    const matches = run('codex', [session('1', { cwd: '/repo/codex', agentId: 'codex' })], { '1': summary('1', 'codex 冒烟') });
    expect(matches[0].fields).toEqual(['goal', 'workspace', 'agent']);
  });

  it('多词分别命中不同字段时，fields 汇总全部命中字段', () => {
    const matches = run('登录 dutydeck', [session('1', { cwd: '/repo/dutydeck' })], { '1': summary('1', '修复登录超时') });
    expect(matches[0].fields).toEqual(['goal', 'workspace']);
  });

  it('归档任务不在模型层被过滤，可见范围交给调用方决定', () => {
    const archived = session('1', { archivedAt: '2026-08-29T00:00:00Z' });
    expect(ids(run('dutydeck', [archived]))).toEqual(['1']);
  });
});
