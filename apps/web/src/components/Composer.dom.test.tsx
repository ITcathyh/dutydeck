import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Composer } from './Composer';
import type { ComposerReference } from '../composer-utils';

// Composer 是唯一的消息出口，发送门禁（canSend）与 Enter 语义是最容易回归的两处。
// 用例盯的是：不该发的时候发出去了，或该发的时候发不出去。

const noop = () => {};
const baseProps = {
  state: 'idle',
  value: '',
  references: [] as ComposerReference[],
  sending: false,
  mode: 'queue' as const,
  queuedTasks: [],
  skills: [],
  models: [],
  reasoningEfforts: [],
  context: {},
  advertisedCommands: [],
  filePicker: false,
  modelReadiness: { kind: 'ready' } as const,
  switchingModel: false,
  switchingReasoningEffort: false,
  refreshingModels: false,
  onChange: noop,
  onReferencesChange: noop,
  onModeChange: noop,
  onSubmit: noop,
  onInterrupt: noop,
  onCancelQueued: noop,
  onSteerQueued: noop,
  onPickFile: async () => undefined,
  onModelChange: noop,
  onReasoningEffortChange: noop,
  onRefreshModels: noop
};

const sendButton = () => screen.getByRole('button', { name: /发送消息|模型/ });

describe('Composer 发送门禁', () => {
  it('有文本且 idle → 发送按钮可用，点击回调 onSubmit', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<Composer {...baseProps} value="你好" onSubmit={onSubmit}/>);
    const button = screen.getByRole('button', { name: '发送消息' });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    await user.click(button);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('空输入 → 发送按钮 disabled', () => {
    render(<Composer {...baseProps} value="   "/>);
    expect((screen.getByRole('button', { name: '发送消息' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('文本为空但带引用 → 仍可发送（引用本身就是内容）', () => {
    const references: ComposerReference[] = [{ id: 'file-/tmp/a.ts', kind: 'file', label: 'a.ts', value: '/tmp/a.ts' }];
    render(<Composer {...baseProps} value="" references={references}/>);
    expect((screen.getByRole('button', { name: '发送消息' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('sending 中 → 按钮 disabled，防止重复提交', () => {
    render(<Composer {...baseProps} value="你好" sending/>);
    expect((screen.getByRole('button', { name: '发送消息' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('模型未就绪 → 按钮 disabled 且 aria-label 变成阻塞原因', () => {
    render(<Composer {...baseProps} value="你好" modelReadiness={{ kind: 'blocked', label: '模型加载失败', reason: '模型加载失败，请刷新模型列表后重试' }}/>);
    const button = screen.getByRole('button', { name: '模型加载失败，请刷新模型列表后重试' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it.each(['starting', 'interrupting', 'stopped', 'failed'])('state=%s → 不可发送', state => {
    render(<Composer {...baseProps} value="你好" state={state}/>);
    expect((screen.getByRole('button', { name: '发送消息' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('state=thinking 且有文本 → 仍可发送（排队/打断语义）', () => {
    render(<Composer {...baseProps} value="你好" state="thinking"/>);
    expect((screen.getByRole('button', { name: '发送消息' }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('Composer 键盘语义', () => {
  it('Enter 提交', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<Composer {...baseProps} value="你好" onSubmit={onSubmit}/>);
    await user.click(screen.getByLabelText('消息'));
    await user.keyboard('{Enter}');
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('Shift+Enter 不提交（换行）', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<Composer {...baseProps} value="你好" onSubmit={onSubmit}/>);
    await user.click(screen.getByLabelText('消息'));
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('不可发送时 Enter 也不提交', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<Composer {...baseProps} value="你好" sending onSubmit={onSubmit}/>);
    await user.click(screen.getByLabelText('消息'));
    await user.keyboard('{Enter}');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('输入 / 自动弹出命令面板（无需点触发按钮）', () => {
    render(<Composer {...baseProps} value="/"/>);
    expect(screen.getByText('/model')).toBeTruthy();
    expect(screen.getByText('/file')).toBeTruthy();
  });

  it('无斜杠查询时 Esc 收起手动打开的面板', async () => {
    const user = userEvent.setup();
    render(<Composer {...baseProps} value="你好"/>);
    await user.click(screen.getByRole('button', { name: '打开斜杠菜单' }));
    expect(screen.getByText('/model')).toBeTruthy();
    await user.click(screen.getByLabelText('消息'));
    await user.keyboard('{Escape}');
    expect(screen.queryByText('/model')).toBeNull();
  });

  it('命令面板打开时 Enter 选中首个命令而不是提交消息', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const onChange = vi.fn();
    render(<Composer {...baseProps} value="/fi" onSubmit={onSubmit} onChange={onChange}/>);
    await user.click(screen.getByLabelText('消息'));
    await user.keyboard('{Enter}');
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe('Composer 面板与引用', () => {
  it('斜杠查询过滤命令列表', () => {
    render(<Composer {...baseProps} value="/mod"/>);
    expect(screen.getByText('/model')).toBeTruthy();
    expect(screen.queryByText('/goal')).toBeNull();
  });

  it('无匹配命令时展示「没有匹配项」而非空面板', () => {
    render(<Composer {...baseProps} value="/zzzz"/>);
    expect(screen.getByText('没有匹配项')).toBeTruthy();
  });

  it('agent 提供的 advertisedCommands 追加进面板，与内置命令去重', () => {
    render(<Composer {...baseProps} value="/" advertisedCommands={[{ name: 'compact', description: '压缩上下文' }, { name: 'model', description: '重复的内置命令' }]}/>);
    expect(screen.getByText('/compact')).toBeTruthy();
    expect(screen.getAllByText('/model')).toHaveLength(1);
  });

  it('渲染已有引用并支持移除', async () => {
    const user = userEvent.setup();
    const onReferencesChange = vi.fn();
    const references: ComposerReference[] = [
      { id: 'file-/tmp/a.ts', kind: 'file', label: 'a.ts', value: '/tmp/a.ts' },
      { id: 'skill-deploy', kind: 'skill', label: 'deploy', value: 'deploy' }
    ];
    render(<Composer {...baseProps} references={references} onReferencesChange={onReferencesChange}/>);
    expect(screen.getByText('/file a.ts')).toBeTruthy();
    expect(screen.getByText('/skills deploy')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '移除引用 a.ts' }));
    expect(onReferencesChange).toHaveBeenCalledWith([references[1]]);
  });

  it('忙碌且无输入 → 展示中断按钮而非发送按钮', async () => {
    const user = userEvent.setup();
    const onInterrupt = vi.fn();
    render(<Composer {...baseProps} state="running_tool" value="" onInterrupt={onInterrupt}/>);
    expect(screen.queryByRole('button', { name: '发送消息' })).toBeNull();
    await user.click(screen.getByRole('button', { name: '中断当前任务' }));
    expect(onInterrupt).toHaveBeenCalledTimes(1);
  });

  it('模型面板列出模型，点击回调 onModelChange', async () => {
    const user = userEvent.setup();
    const onModelChange = vi.fn();
    render(<Composer {...baseProps} models={[{ id: 'opus', name: 'Opus' }, { id: 'sonnet', name: 'Sonnet' }]} currentModel="opus" onModelChange={onModelChange}/>);
    await user.click(screen.getByTitle('切换模型'));
    await user.click(screen.getByText('Sonnet'));
    expect(onModelChange).toHaveBeenCalledWith('sonnet');
  });

  it('当前模型在面板中 disabled，避免切到自己', async () => {
    const user = userEvent.setup();
    render(<Composer {...baseProps} models={[{ id: 'opus', name: 'Opus' }]} currentModel="opus"/>);
    await user.click(screen.getByTitle('切换模型'));
    expect((screen.getByText('Opus').closest('button') as HTMLButtonElement).disabled).toBe(true);
  });

  it('模型未就绪时触发按钮的 title 变成阻塞原因，面板内展示该原因', async () => {
    const user = userEvent.setup();
    const reason = '模型加载失败，请刷新模型列表后重试';
    render(<Composer {...baseProps} modelReadiness={{ kind: 'blocked', label: '模型加载失败', reason }}/>);
    await user.click(screen.getAllByTitle(reason)[0]);
    expect(screen.getByText(reason)).toBeTruthy();
  });
});

describe('Composer 排队任务', () => {
  const task = (id: string, prompt: string) => ({ id, sessionId: 's1', prompt, status: 'queued', createdAt: '', updatedAt: '' });

  it('渲染排队列表与条数', () => {
    render(<Composer {...baseProps} queuedTasks={[task('t1', '第一条'), task('t2', '第二条')]}/>);
    expect(screen.getByText('待执行指令')).toBeTruthy();
    expect(screen.getByText('2')).toBeTruthy();
    expect(screen.getByText('第一条')).toBeTruthy();
  });

  it('取消排队 / 打断当前任务并执行分别回调对应 taskId', async () => {
    const user = userEvent.setup();
    const onCancelQueued = vi.fn();
    const onSteerQueued = vi.fn();
    render(<Composer {...baseProps} queuedTasks={[task('t1', '第一条')]} onCancelQueued={onCancelQueued} onSteerQueued={onSteerQueued}/>);
    await user.click(screen.getByRole('button', { name: '取消排队：第一条' }));
    expect(onCancelQueued).toHaveBeenCalledWith('t1');
    await user.click(screen.getByRole('button', { name: '打断当前任务并执行' }));
    expect(onSteerQueued).toHaveBeenCalledWith('t1');
  });

  it('正在取消某条时，队列上的按钮整体 disabled，防并发操作', () => {
    render(<Composer {...baseProps} queuedTasks={[task('t1', '第一条')]} cancellingTaskId="t1"/>);
    expect((screen.getByRole('button', { name: '取消排队：第一条' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '打断当前任务并执行' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('无排队任务时不渲染排队区', () => {
    render(<Composer {...baseProps}/>);
    expect(screen.queryByText('等待发送')).toBeNull();
  });
});
