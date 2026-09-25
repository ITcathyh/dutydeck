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

describe('Composer Skill 选择', () => {
  it.each(['click', 'enter'])('%s 保存完整路径并显示名称', async method => {
    const user = userEvent.setup();
    const onReferencesChange = vi.fn();
    const skill = { name: 'smoke-evidence', description: '检查投递', path: '/repo/.agents/skills/smoke-evidence/SKILL.md', source: 'workspace' as const };
    const { rerender } = render(<Composer {...baseProps} value="/smoke-evidence" skills={[skill]} onReferencesChange={onReferencesChange}/>);
    if (method === 'click') await user.click(screen.getByRole('button', { name: /smoke-evidence/ }));
    else { await user.click(screen.getByLabelText('消息')); await user.keyboard('{Enter}'); }
    const expected = [{ id: `skill-${skill.path}`, kind: 'skill' as const, label: skill.name, value: skill.path }];
    expect(onReferencesChange).toHaveBeenCalledWith(expected);
    rerender(<Composer {...baseProps} references={expected}/>);
    expect(screen.getByText('/skills smoke-evidence')).toBeTruthy();
    expect(screen.queryByText(`/skills ${skill.path}`)).toBeNull();
  });
});

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

  it('当前一轮停在审批上时，排队指令标为被审批阻塞，并能直接拒绝这条审批', async () => {
    const user = userEvent.setup();
    const onRejectPermission = vi.fn();
    const { rerender } = render(<Composer {...baseProps} state="waiting_for_permission" queuedTasks={[task('t1', '第一条')]} blockingPermissionId="perm_1" onRejectPermission={onRejectPermission}/>);
    expect(screen.getByText('被审批阻塞')).toBeTruthy();
    expect(screen.getByText('被审批阻塞，当前审批处理后依次执行')).toBeTruthy();
    expect(screen.queryByText('排队中')).toBeNull();
    await user.click(screen.getByRole('button', { name: '拒绝这条审批' }));
    expect(onRejectPermission).toHaveBeenCalledExactlyOnceWith('perm_1');
    rerender(<Composer {...baseProps} queuedTasks={[task('t1', '第一条')]} onRejectPermission={onRejectPermission}/>);
    expect(screen.getByText('排队中')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '拒绝这条审批' })).toBeNull();
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

describe('Composer 内建命令（与飞书命令体系同一套设计模式）', () => {
  const live = { state: 'idle' as const };
  // 命令行是「/name + 描述」两段文本的按钮；按命令名精确取按钮，避免撞到描述里的同名字样。
  const commandButton = (name: string) => {
    const label = [...document.querySelectorAll('button > span > span:first-child')].find(node => node.textContent === `/${name}`);
    if (!label) throw new Error(`命令面板里没有 /${name}`);
    return label.closest('button')!;
  };
  const withActions = { ...baseProps, session: live, onShowStatus: noop, onRestart: noop, onCreateTask: noop, onOpenHelp: noop };

  it('不再提供服务端零实现的 /goal 与 /fast', () => {
    render(<Composer {...withActions} value="/"/>);
    expect(screen.queryByText('/goal')).toBeNull();
    expect(screen.queryByText('/fast')).toBeNull();
  });

  it('列出与飞书同名的 /status /cancel /new /help', () => {
    render(<Composer {...withActions} value="/"/>);
    for (const name of ['/status', '/cancel', '/new', '/help']) expect(screen.getByText(name), name).toBeTruthy();
  });

  it('重新启动命令叫 /restart，描述点明上下文会清空', () => {
    // 飞书 /retry 保留上下文，Web restart 起全新进程。同名会让用户以为能接着上次继续。
    render(<Composer {...withActions} session={{ state: 'failed' }} value="/rest"/>);
    expect(screen.getByText('/restart')).toBeTruthy();
    expect(screen.getByText(/空白上下文/)).toBeTruthy();
    expect(screen.queryByText('/retry')).toBeNull();
  });

  it('不可用的命令仍然列出，但禁用并说明原因', () => {
    // 命令消失会让用户以为自己记错了；这里保留条目并写清缺什么。
    render(<Composer {...withActions} session={{ state: 'idle' }} value="/restart"/>);
    const button = commandButton('restart');
    expect(button.hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('只有失败或已停止的任务可以重新启动')).toBeTruthy();
  });

  it('点击不可用命令不触发任何动作', async () => {
    const user = userEvent.setup();
    const onRestart = vi.fn();
    render(<Composer {...withActions} session={{ state: 'idle' }} value="/restart" onRestart={onRestart}/>);
    await user.click(commandButton('restart'));
    expect(onRestart).not.toHaveBeenCalled();
  });

  it('/restart 在失败任务上可点，触发重新启动', async () => {
    const user = userEvent.setup();
    const onRestart = vi.fn();
    render(<Composer {...withActions} session={{ state: 'failed' }} state="failed" value="/restart" onRestart={onRestart}/>);
    await user.click(commandButton('restart'));
    expect(onRestart).toHaveBeenCalledTimes(1);
  });

  it('/cancel 在执行中触发中断', async () => {
    const user = userEvent.setup();
    const onInterrupt = vi.fn();
    render(<Composer {...withActions} session={{ state: 'thinking' }} state="thinking" value="/cancel" onInterrupt={onInterrupt}/>);
    await user.click(commandButton('cancel'));
    expect(onInterrupt).toHaveBeenCalledTimes(1);
  });

  it('/cancel 在只有排队指令时取消排队而不是中断', async () => {
    const user = userEvent.setup();
    const onCancelQueued = vi.fn();
    const onInterrupt = vi.fn();
    const queuedTasks = [{ id: 't1', sessionId: 's', prompt: '排队的指令', status: 'queued', createdAt: '', updatedAt: '' }];
    render(<Composer {...withActions} session={{ state: 'idle' }} queuedTasks={queuedTasks} value="/cancel" onCancelQueued={onCancelQueued} onInterrupt={onInterrupt}/>);
    await user.click(commandButton('cancel'));
    expect(onCancelQueued).toHaveBeenCalledWith('t1');
    expect(onInterrupt).not.toHaveBeenCalled();
  });

  it('stop 别名与飞书一致，命中同一条 cancel', () => {
    render(<Composer {...withActions} session={{ state: 'thinking' }} value="/stop"/>);
    expect(commandButton('cancel')).toBeTruthy();
  });

  it('归档任务上所有会话作用域命令都不可用', () => {
    render(<Composer {...withActions} session={{ state: 'thinking', archivedAt: '2026-09-01T00:00:00Z' }} value="/status"/>);
    expect(commandButton('status').hasAttribute('disabled')).toBe(true);
  });

  it('未传回调时对应命令不出现，避免点了没反应', () => {
    render(<Composer {...baseProps} session={live} value="/"/>);
    expect(screen.queryByText('/status')).toBeNull();
    expect(screen.queryByText('/help')).toBeNull();
    expect(screen.getByText('/file')).toBeTruthy();
  });

  it('Enter 跳过禁用命令，落到第一个可用项', async () => {
    const user = userEvent.setup();
    const onRestart = vi.fn();
    const onChange = vi.fn();
    // /r 同时匹配禁用的 /restart 与可用的 /reasoning（models 为空时 reasoning 也禁用，
    // 故给出 reasoningEfforts 让它可用）。
    render(<Composer {...withActions} session={{ state: 'idle' }} reasoningEfforts={[{ id: 'high', name: '高' }]} value="/r" onRestart={onRestart} onChange={onChange}/>);
    await user.click(screen.getByLabelText('消息'));
    await user.keyboard('{Enter}');
    expect(onRestart).not.toHaveBeenCalled();
  });
});

// 这一组盯的是审计查出的两个浮层缺陷。它们在迁到 Popover 原语之前完全没有测试守着，
// 正因如此才能长期存活：幽灵浮层和缺失的 aria 都是「看上去正常」的缺陷。
describe('Composer 浮层缺陷回归', () => {
  it('发送模式菜单不再是幽灵浮层：输入清空后触发按钮消失，菜单跟着消失', async () => {
    const user = userEvent.setup();
    // 触发按钮的渲染条件是 busy && value.trim()。旧实现里输入一清空按钮就没了，
    // 菜单却留在屏幕上——既点不到触发器收起它，也没有外部点击/Escape 监听。
    const { rerender } = render(<Composer {...baseProps} state="thinking" value="补充要求"/>);
    await user.click(screen.getByRole('button', { name: /排队/ }));
    expect(screen.getByText('打断并立即发送')).toBeTruthy();
    rerender(<Composer {...baseProps} state="thinking" value=""/>);
    expect(screen.queryByText('打断并立即发送')).toBeNull();
  });

  it('发送模式菜单响应 Escape（旧实现两个都不听）', async () => {
    const user = userEvent.setup();
    render(<Composer {...baseProps} state="thinking" value="补充要求"/>);
    await user.click(screen.getByRole('button', { name: /排队/ }));
    expect(screen.getByText('排队发送')).toBeTruthy();
    await user.keyboard('{Escape}');
    expect(screen.queryByText('排队发送')).toBeNull();
  });

  it('发送模式菜单响应外部点击', async () => {
    const user = userEvent.setup();
    render(<Composer {...baseProps} state="thinking" value="补充要求"/>);
    await user.click(screen.getByRole('button', { name: /排队/ }));
    expect(screen.getByText('排队发送')).toBeTruthy();
    await user.click(document.body);
    expect(screen.queryByText('排队发送')).toBeNull();
  });

  it('三个面板触发按钮都自报 aria-expanded / aria-haspopup', async () => {
    const user = userEvent.setup();
    render(<Composer {...baseProps} value="你好" models={[{ id: 'opus', name: 'Opus' }]}/>);
    const slash = screen.getByRole('button', { name: '打开斜杠菜单' });
    const model = screen.getByTitle('切换模型');
    const reasoning = screen.getByTitle('调整思考深度');
    // 读屏用户必须能知道这三颗按钮会展开面板，而不是执行一个动作。
    for (const trigger of [slash, model, reasoning]) {
      expect(trigger.getAttribute('aria-haspopup')).toBeTruthy();
      expect(trigger.getAttribute('aria-expanded')).toBe('false');
    }
    await user.click(slash);
    expect(slash.getAttribute('aria-expanded')).toBe('true');
  });

  it('斜杠面板可被 Escape 收起，且收起后不因 query 仍在而自己弹回来', async () => {
    const user = userEvent.setup();
    // 面板的显示条件是从 value 里的斜杠查询推导的。只把 panel 置空而不记住
    // 「这一次已经收起过」，下一帧 query 还在，面板会立刻重新出现，Escape 等于失灵。
    render(<Composer {...baseProps} value="/mod"/>);
    expect(screen.getByText('/model')).toBeTruthy();
    await user.click(screen.getByLabelText('消息'));
    await user.keyboard('{Escape}');
    expect(screen.queryByText('/model')).toBeNull();
  });

  it('面板 portal 到 body，不再被 Composer 外壳的 overflow 裁掉', async () => {
    const user = userEvent.setup();
    const { container } = render(<Composer {...baseProps} value="你好" models={[{ id: 'opus', name: 'Opus' }]}/>);
    await user.click(screen.getByTitle('切换模型'));
    const option = screen.getByText('Opus');
    expect(container.contains(option)).toBe(false);
    expect(document.body.contains(option)).toBe(true);
  });
});

describe('Composer 触控目标（契约 §9：主要交互 ≥40px）', () => {
  it('发送按钮与中断按钮都是 40px', () => {
    const { unmount } = render(<Composer {...baseProps} value="你好"/>);
    expect(screen.getByRole('button', { name: '发送消息' }).className).toContain('h-10');
    unmount();
    render(<Composer {...baseProps} state="running_tool" value=""/>);
    expect(screen.getByRole('button', { name: '中断当前任务' }).className).toContain('h-10');
  });

  it('三个面板触发按钮都是 40px', () => {
    render(<Composer {...baseProps} value="你好"/>);
    expect(screen.getByRole('button', { name: '打开斜杠菜单' }).className).toContain('h-10');
    for (const title of ['切换模型', '调整思考深度']) expect(screen.getByTitle(title).className).toContain('h-10');
  });

  it('排队行的两个操作按钮达标：取消是 IconButton（命中区 40px），打断是 40px 按钮', () => {
    const task = { id: 't1', sessionId: 's1', prompt: '第一条', status: 'queued', createdAt: '', updatedAt: '' };
    render(<Composer {...baseProps} queuedTasks={[task]}/>);
    expect(screen.getByRole('button', { name: '取消排队：第一条' }).className).toContain('h-10');
    expect(screen.getByRole('button', { name: '打断当前任务并执行' }).className).toContain('h-10');
  });
});
