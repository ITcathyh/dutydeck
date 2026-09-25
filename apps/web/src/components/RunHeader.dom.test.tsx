import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { Agent, Session, Task } from '../api';
import { nextActionForState, sessionErrorSummary } from '../workspace-model';
import { RunDetailTabs, RunHeader } from './RunHeader';
import { permissionLabels } from './ui';

const agent: Agent = { id: 'codex', name: 'Codex', protocol: 'acp', permissionMode: 'full-trust' };
const session: Session = { id: 's1', agentId: 'codex', state: 'thinking', cwd: '/repo/dutydeck', permissionMode: 'full-trust', runId: 'run-abc1234', createdAt: '', updatedAt: '' };
const queued: Task = { id: 't1', sessionId: 's1', prompt: '补充测试', status: 'queued', createdAt: '', updatedAt: '' };

describe('RunHeader', () => {
  it('集中展示 workspace、任务状态、下一步与队列', () => {
    render(<RunHeader session={session} agent={agent} taskPrompt="优化飞书任务卡片" streamStatus="open" queuedTasks={[queued]} rawVisible={false} rawAvailable={false} restarting={false} onInterrupt={() => {}} onRestart={() => {}} onOpenPrompt={() => {}} onArchive={() => {}} onToggleRaw={() => {}}/>);
    expect(screen.getByText('dutydeck')).toBeTruthy();
    expect(screen.getByRole('heading', { name: '优化飞书任务卡片' })).toBeTruthy();
    expect(screen.getByText('思考中')).toBeTruthy();
    expect(screen.getByText(nextActionForState('thinking'))).toBeTruthy();
    // 排队徽标统一为「待执行指令 N 条」，与总览页任务行同一措辞。
    expect(screen.getByText('待执行指令 1 条')).toBeTruthy();
    expect(screen.getByText(permissionLabels['full-trust'])).toBeTruthy();
    expect(screen.getByTitle('本任务的权限姿态')).toBeTruthy();
    expect(screen.getByTitle('实时同步')).toBeTruthy();
  });

  it('任务控制保持可达', async () => {
    const user = userEvent.setup(); const onInterrupt = vi.fn(); const onArchive = vi.fn();
    render(<RunHeader session={session} agent={agent} streamStatus="open" queuedTasks={[]} rawVisible={false} rawAvailable={false} restarting={false} onInterrupt={onInterrupt} onRestart={() => {}} onOpenPrompt={() => {}} onArchive={onArchive} onToggleRaw={() => {}}/>);
    await user.click(screen.getByRole('button', { name: '中断当前任务' }));
    await user.click(screen.getByRole('button', { name: '归档任务' }));
    expect(onInterrupt).toHaveBeenCalledTimes(1);
    expect(onArchive).toHaveBeenCalledTimes(1);
    expect((screen.getByRole('button', { name: '原始日志' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('failed / stopped 任务可调用真实 restart 操作', async () => {
    const user = userEvent.setup(); const onRestart = vi.fn();
    render(<RunHeader session={{ ...session, state: 'failed' }} agent={agent} streamStatus="open" queuedTasks={[]} rawVisible={false} rawAvailable={false} restarting={false} onInterrupt={() => {}} onRestart={onRestart} onOpenPrompt={() => {}} onArchive={() => {}} onToggleRaw={() => {}}/>);
    await user.click(screen.getByRole('button', { name: '重新启动' }));
    expect(onRestart).toHaveBeenCalledTimes(1);
  });

  it('长任务目标视觉截断但为辅助技术和悬停保留完整文本', () => {
    const goal = '大规模优化并重构整个项目，使用户可以从飞书高效指挥任务并完成端到端验收';
    render(<RunHeader session={session} agent={agent} taskPrompt={`  ${goal}  `} streamStatus="open" queuedTasks={[]} rawVisible={false} rawAvailable={false} restarting={false} onInterrupt={() => {}} onRestart={() => {}} onOpenPrompt={() => {}} onArchive={() => {}} onToggleRaw={() => {}}/>);
    const heading = screen.getByRole('heading', { name: goal });
    expect(heading.className).toContain('truncate');
    expect(heading.getAttribute('title')).toBe(goal);
  });
});

// 详情页顶部状态条曾四处直接读 session.state：归档的 thinking 任务写着「思考中」、
// 圆点一直呼吸、下一步提示还在说「Agent 正在推进」，而 recoverable 漏判 archivedAt
// 让一条已归档的失败任务显示出可点击的「重新启动」——那是功能缺陷，不只是显示错误。
// 这组用例守的是「状态文案、呼吸动画、可恢复性出自同一个判断」，见 ui.tsx:effectiveStatus。
describe('RunHeader 归档态状态视觉与只读约束', () => {
  const archivedAt = '2026-08-30T00:00:00.000Z';
  function renderHeader(overrides: Partial<Session>, restarting = false) {
    const { container } = render(<RunHeader session={{ ...session, ...overrides }} agent={agent} taskPrompt="优化飞书任务卡片" streamStatus="open" queuedTasks={[]} rawVisible={false} rawAvailable={false} restarting={restarting} onInterrupt={() => {}} onRestart={() => {}} onOpenPrompt={() => {}} onArchive={() => {}} onToggleRaw={() => {}}/>);
    // 状态条的圆点是唯一带 aria-label 的 span，文案在它右边的 <strong> 里。
    return { dot: container.querySelector('span[aria-label]')!, statusText: container.querySelector('strong')! };
  }

  it('归档 + thinking：状态写「已归档」，圆点不再呼吸', () => {
    const { dot, statusText } = renderHeader({ state: 'thinking', archivedAt });
    expect(statusText.textContent).toBe('已归档');
    expect(dot.getAttribute('aria-label')).toBe('已归档');
    expect(dot.className).not.toContain('ui-status-pulse');
    expect(dot.className).not.toContain('warning-solid');
    // 归档与兜底两支是 RunHeader 自己写的字面量，已迁到语义类；运行态那支仍来自
    // ui.tsx:stateTone（已冻结，返回内联 var(--status-*)），见下面「未归档 + thinking」。
    expect(dot.className).toContain('bg-neutral-solid');
    expect(screen.queryByText('思考中')).toBeNull();
  });

  it('归档 + failed：不再给出「重新启动」按钮，归档是只读终态', () => {
    const { statusText } = renderHeader({ state: 'failed', archivedAt });
    expect(statusText.textContent).toBe('已归档');
    expect(screen.queryByRole('button', { name: '重新启动' })).toBeNull();
    // 中断与归档按钮同属写操作，归档后也不该出现。
    expect(screen.queryByRole('button', { name: '中断当前任务' })).toBeNull();
    expect(screen.queryByRole('button', { name: '归档任务' })).toBeNull();
  });

  it('归档任务的下一步提示说明只读，不再谎报 Agent 在推进', () => {
    renderHeader({ state: 'thinking', archivedAt });
    expect(screen.queryByText(nextActionForState('thinking'))).toBeNull();
    expect(screen.getByText('已归档任务只读；可查看历史记录，不能再下指令')).toBeTruthy();
  });

  it('未归档 + failed：「重新启动」按钮照旧在，别把正常恢复路径改没了', async () => {
    const user = userEvent.setup(); const onRestart = vi.fn();
    render(<RunHeader session={{ ...session, state: 'failed' }} agent={agent} streamStatus="open" queuedTasks={[]} rawVisible={false} rawAvailable={false} restarting={false} onInterrupt={() => {}} onRestart={onRestart} onOpenPrompt={() => {}} onArchive={() => {}} onToggleRaw={() => {}}/>);
    await user.click(screen.getByRole('button', { name: '重新启动' }));
    expect(onRestart).toHaveBeenCalledTimes(1);
    expect(screen.getByText('失败')).toBeTruthy();
    expect(screen.getByText(nextActionForState('failed'))).toBeTruthy();
  });

  it('未归档 + thinking：圆点仍呼吸，状态仍写「思考中」', () => {
    const { dot, statusText } = renderHeader({ state: 'thinking' });
    expect(statusText.textContent).toBe('思考中');
    expect(dot.getAttribute('aria-label')).toBe('思考中');
    expect(dot.className).toContain('ui-status-pulse');
    expect(dot.className).toContain('bg-warning-solid');
    expect(screen.getByText(nextActionForState('thinking'))).toBeTruthy();
  });
});

// 缺陷 5：状态条让用户「查看失败详情，修正后重新启动」，但详情页原先根本没有失败详情，
// 只有总览页和命令面板显示。脱敏由 workspace-model:sessionErrorSummary 统一负责，
// 这里守的是「详情页真的把它渲染出来了」以及「归档任务的历史失败原因仍可见」。
describe('RunHeader 失败详情', () => {
  const error = 'spawn codex ENOENT: 未找到可执行文件';
  function renderHeader(overrides: Partial<Session>) {
    return render(<RunHeader session={{ ...session, ...overrides }} agent={agent} taskPrompt="优化飞书任务卡片" streamStatus="open" queuedTasks={[]} rawVisible={false} rawAvailable={false} restarting={false} onInterrupt={() => {}} onRestart={() => {}} onOpenPrompt={() => {}} onArchive={() => {}} onToggleRaw={() => {}}/>);
  }

  it('失败任务在详情页显示脱敏后的失败详情', () => {
    renderHeader({ state: 'failed', error });
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('失败详情');
    expect(alert.textContent).toContain(sessionErrorSummary(error)!);
  });

  it('归档任务仍能看到历史失败原因（只读信息）', () => {
    renderHeader({ state: 'failed', error, archivedAt: '2026-08-30T00:00:00.000Z' });
    expect(screen.getByRole('alert').textContent).toContain(sessionErrorSummary(error)!);
  });

  it('没有 error 时不渲染失败详情，别给正常任务加一条空警报', () => {
    renderHeader({ state: 'thinking' });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('失败详情')).toBeNull();
  });

  it('普通会话渲染「重命名会话」按钮，点击调用 onRename；source 为 work_item 时不显示', async () => {
    const user = userEvent.setup();
    const onRename = vi.fn();
    const { rerender } = render(<RunHeader session={session} agent={agent} onRename={onRename} streamStatus="open" queuedTasks={[]} rawVisible={false} rawAvailable={false} restarting={false} onInterrupt={() => {}} onRestart={() => {}} onOpenPrompt={() => {}} onArchive={() => {}} onToggleRaw={() => {}}/>);

    const renameBtn = screen.getByRole('button', { name: '重命名会话' });
    expect(renameBtn).toBeTruthy();
    await user.click(renameBtn);
    expect(onRename).toHaveBeenCalledTimes(1);

    rerender(<RunHeader session={{ ...session, source: 'work_item' }} agent={agent} onRename={onRename} streamStatus="open" queuedTasks={[]} rawVisible={false} rawAvailable={false} restarting={false} onInterrupt={() => {}} onRestart={() => {}} onOpenPrompt={() => {}} onArchive={() => {}} onToggleRaw={() => {}}/>);
    expect(screen.queryByRole('button', { name: '重命名会话' })).toBeNull();
  });

  it('标题优先展示 session.name，无 name 时回退到 taskPrompt 或未命名任务', () => {
    const { rerender } = render(<RunHeader session={{ ...session, name: '自建看板会话' }} agent={agent} taskPrompt="原始指令提示" streamStatus="open" queuedTasks={[]} rawVisible={false} rawAvailable={false} restarting={false} onInterrupt={() => {}} onRestart={() => {}} onOpenPrompt={() => {}} onArchive={() => {}} onToggleRaw={() => {}}/>);
    expect(screen.getByRole('heading', { name: '自建看板会话' })).toBeTruthy();

    rerender(<RunHeader session={session} agent={agent} taskPrompt="原始指令提示" streamStatus="open" queuedTasks={[]} rawVisible={false} rawAvailable={false} restarting={false} onInterrupt={() => {}} onRestart={() => {}} onOpenPrompt={() => {}} onArchive={() => {}} onToggleRaw={() => {}}/>);
    expect(screen.getByRole('heading', { name: '原始指令提示' })).toBeTruthy();

    rerender(<RunHeader session={session} agent={agent} taskPrompt="" streamStatus="open" queuedTasks={[]} rawVisible={false} rawAvailable={false} restarting={false} onInterrupt={() => {}} onRestart={() => {}} onOpenPrompt={() => {}} onArchive={() => {}} onToggleRaw={() => {}}/>);
    expect(screen.getByRole('heading', { name: '未命名任务' })).toBeTruthy();
  });

  it('状态条显示本任务累计用量（含子步骤与估算），没有用量数据时如实说明', () => {
    const totals = { entries: 1, costUsd: 0.5, estimatedCostUsd: 0, inputTokens: 1000, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, unavailable: 0 };
    const props = { agent, streamStatus: 'open' as const, queuedTasks: [], rawVisible: false, rawAvailable: false, restarting: false, onInterrupt() {}, onRestart() {}, onOpenPrompt() {}, onArchive() {}, onToggleRaw() {} };
    const { rerender } = render(<RunHeader session={session} {...props} usage={{ own: totals, subSteps: { ...totals, costUsd: 0.25, estimatedCostUsd: 0.25 } }}/>);
    expect(screen.getByText('本任务累计 $0.75（含子步骤 $0.25，含估算 $0.25）').getAttribute('title')).toBe('输入 2,000 · 输出 40 · 缓存读 0 · 缓存写 0 token');
    const none = { ...totals, costUsd: 0, inputTokens: 0, outputTokens: 0 };
    rerender(<RunHeader session={session} {...props} usage={{ own: { ...none, unavailable: 1 }, subSteps: { ...none, entries: 0 } }}/>);
    expect(screen.getByText('本任务累计：无用量数据')).toBeTruthy();
    rerender(<RunHeader session={session} {...props}/>);
    expect(screen.queryByText(/本任务累计/)).toBeNull();
  });
});

// RunDetailTabs 已被 App.tsx 消费（commit 1a1100f），手写 tablist 与方向键处理均已删除。
// aria-controls / aria-labelledby 由 Tabs 原语生成为 `tabpanel-<id>` / `tab-<id>`。
describe('RunDetailTabs', () => {
  function Host({ onChange }: { onChange?: (value: 'timeline' | 'terminal') => void }) {
    const [value, setValue] = useState<'timeline' | 'terminal'>('timeline');
    return <RunDetailTabs value={value} onChange={next => { setValue(next); onChange?.(next); }}/>;
  }

  it('沿用「任务内容」tablist 与「执行记录」「终端」两个标签', () => {
    render(<Host/>);
    expect(screen.getByRole('tablist', { name: '任务内容' })).toBeTruthy();
    expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual(['执行记录', '终端']);
    expect(screen.getByRole('tab', { selected: true }).textContent).toBe('执行记录');
  });

  it('点击标签回传新 tab id', async () => {
    const user = userEvent.setup(); const onChange = vi.fn();
    render(<Host onChange={onChange}/>);
    await user.click(screen.getByRole('tab', { name: '终端' }));
    expect(onChange).toHaveBeenCalledWith('terminal');
    expect(screen.getByRole('tab', { selected: true }).textContent).toBe('终端');
  });

  it('aria-controls 指向 tabpanel-<id>，App.tsx 替换时面板 id 要跟着改', () => {
    render(<Host/>);
    expect(screen.getByRole('tab', { name: '执行记录' }).getAttribute('aria-controls')).toBe('tabpanel-timeline');
    expect(screen.getByRole('tab', { name: '终端' }).getAttribute('aria-controls')).toBe('tabpanel-terminal');
  });
});
