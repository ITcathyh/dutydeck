import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastViewport } from './ToastViewport';
import { toastStore, type Toast } from '../useToasts';

// 这些用例盯的是「通知看得见但读不懂 / 点不到」类回归：
// 颜色成为状态的唯一载体、失败走了礼貌通道读屏不播报、关闭按钮小到点不准、
// 撤销按钮在异步执行期间被连点，以及通知抢焦点变成事实上的模态。

const makeToast = (overrides: Partial<Toast> = {}): Toast => ({ id: 't1', kind: 'success', title: '已发送指令', durationMs: 4_000, createdAt: 0, ...overrides });

// aria-label 定位两个 live region，而不是 role：断言区用 role="alert"，礼貌区用 role="status"，
// 用 label 查询才能在一个断言里对两者做同构检查。
const politeRegion = () => screen.getByLabelText('操作结果通知');
const assertiveRegion = () => screen.getByLabelText('失败与注意事项通知');

afterEach(() => {
  toastStore.clear();
});

describe('ToastViewport 无障碍结构', () => {
  it('礼貌区与断言区始终并存：即使一条通知都没有，两个 live region 也在 DOM 里', () => {
    // live region 必须先于内容存在，否则读屏通常不播报后插入的内容。
    // 播报靠 aria-live 而不是 role="status" / role="alert"：这两个常驻空容器一旦占用
    // status / alert 角色，就会和页面自身的错误条、过期数据条抢同一个角色，
    // 读屏用户会听到两个竞争的 alert。aria-live 保留播报语义又不占角色。
    render(<ToastViewport toasts={[]}/>);
    expect(politeRegion().getAttribute('aria-live')).toBe('polite');
    expect(assertiveRegion().getAttribute('aria-live')).toBe('assertive');
    expect(politeRegion().getAttribute('role')).toBeNull();
    expect(assertiveRegion().getAttribute('role')).toBeNull();
    expect(politeRegion().getAttribute('aria-atomic')).toBe('false');
    expect(assertiveRegion().getAttribute('aria-atomic')).toBe('false');
  });

  it('success / info 进礼貌区，error / warning 进断言区（aria-live="assertive"）', () => {
    render(<ToastViewport toasts={[
      makeToast({ id: 'a', kind: 'success', title: '任务已归档' }),
      makeToast({ id: 'b', kind: 'info', title: '已加载更早的执行记录' }),
      makeToast({ id: 'c', kind: 'error', title: '取消待执行指令失败' }),
      makeToast({ id: 'd', kind: 'warning', title: '模型列表仍是缓存值' })
    ]}/>);
    expect(within(politeRegion()).getByText('任务已归档')).toBeTruthy();
    expect(within(politeRegion()).getByText('已加载更早的执行记录')).toBeTruthy();
    expect(within(politeRegion()).queryByText('取消待执行指令失败')).toBeNull();
    expect(within(assertiveRegion()).getByText('取消待执行指令失败')).toBeTruthy();
    expect(within(assertiveRegion()).getByText('模型列表仍是缓存值')).toBeTruthy();
  });

  it.each([['success', '成功'], ['error', '失败'], ['info', '提示'], ['warning', '注意']] as const)('%s 通知带可读的文本类型标签「%s」，颜色不是状态的唯一载体', (kind, label) => {
    render(<ToastViewport toasts={[makeToast({ kind, title: '任务状态已更新' })]}/>);
    expect(screen.getByText(label)).toBeTruthy();
  });

  it('图标是纯装饰（aria-hidden），不重复播报状态', () => {
    const { container } = render(<ToastViewport toasts={[makeToast({ kind: 'error', title: '重新启动失败' })]}/>);
    const icons = container.querySelectorAll('svg');
    expect(icons.length).toBeGreaterThan(0);
    for (const icon of icons) expect(icon.getAttribute('aria-hidden')).toBe('true');
  });

  it('description 与 title 都在可访问树中', () => {
    render(<ToastViewport toasts={[makeToast({ kind: 'error', title: '发送指令失败', description: '查看失败详情，修正后重新运行' })]}/>);
    expect(screen.getByText('发送指令失败')).toBeTruthy();
    expect(screen.getByText('查看失败详情，修正后重新运行')).toBeTruthy();
  });

  it('通知不抢焦点，也不是模态（无 aria-modal、焦点留在原处）', async () => {
    render(<><button type="button">页面上的其他按钮</button><ToastViewport toasts={[]}/></>);
    const outside = screen.getByRole('button', { name: '页面上的其他按钮' });
    outside.focus();
    const { rerender } = render(<ToastViewport toasts={[]}/>);
    rerender(<ToastViewport toasts={[makeToast({ kind: 'error', title: '归档失败' })]}/>);
    await vi.waitFor(() => expect(document.activeElement).toBe(outside));
    expect(document.querySelector('[aria-modal]')).toBeNull();
  });
});

describe('ToastViewport 触控与操作', () => {
  it('每条通知都有带中文 aria-label 的关闭按钮，点击回调 onDismiss 对应 id', async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    render(<ToastViewport toasts={[makeToast({ id: 'toast-9', title: '已取消 1 条待执行指令' })]} onDismiss={onDismiss}/>);
    await user.click(screen.getByRole('button', { name: '关闭通知：已取消 1 条待执行指令' }));
    expect(onDismiss).toHaveBeenCalledWith('toast-9');
  });

  // 断言的是「命中区 >=40px」这个结果，不是达成它的具体写法：
  // IconButton 原语用 h-10 w-10 固定尺寸，与原先的 min-h-10 等效。
  it('关闭按钮触控目标不小于 40px', () => {
    render(<ToastViewport toasts={[makeToast()]}/>);
    const close = screen.getByRole('button', { name: '关闭通知：已发送指令' });
    expect(close.className).toMatch(/\b(?:min-)?h-10\b/);
    expect(close.className).toMatch(/\b(?:min-)?w-10\b/);
  });

  it('操作按钮是真实 button、用动作导向的中文文案，且触控目标不小于 40px', () => {
    render(<ToastViewport toasts={[makeToast({ title: '已取消 1 条待执行指令', action: { label: '恢复这条指令', run: () => {} } })]}/>);
    const action = screen.getByRole('button', { name: '恢复这条指令' });
    expect(action.tagName).toBe('BUTTON');
    expect(action.getAttribute('type')).toBe('button');
    // 「撤销」常是误操作后唯一的补救入口，不能降到 sm(32px)。
    expect(action.className).toMatch(/\b(?:min-)?h-10\b/);
  });

  it('没有 action 时只渲染关闭按钮，不出现假操作', () => {
    render(<ToastViewport toasts={[makeToast()]}/>);
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });

  it('点击操作按钮执行 run，并在完成后收起该通知', async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    const run = vi.fn();
    render(<ToastViewport toasts={[makeToast({ id: 'toast-3', title: '已取消 1 条待执行指令', action: { label: '恢复这条指令', run } })]} onDismiss={onDismiss}/>);
    await user.click(screen.getByRole('button', { name: '恢复这条指令' }));
    expect(run).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledWith('toast-3');
  });

  it('异步 run 执行中按钮 disabled 并显示「正在执行」，连点只触发一次', async () => {
    const user = userEvent.setup();
    let release = () => {};
    const run = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
    const onDismiss = vi.fn();
    render(<ToastViewport toasts={[makeToast({ title: '已取消 1 条待执行指令', action: { label: '恢复这条指令', run } })]} onDismiss={onDismiss}/>);
    await user.click(screen.getByRole('button', { name: '恢复这条指令' }));
    const busy = screen.getByRole('button', { name: '正在执行' });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    expect(onDismiss).not.toHaveBeenCalled();
    await user.click(busy);
    expect(run).toHaveBeenCalledTimes(1);
    await act(async () => { release(); await Promise.resolve(); });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('run 抛错时通知留在原地并就地说明原因，按钮变为可重试，不产生 unhandled rejection', async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    const run = vi.fn(() => Promise.reject(new Error('服务端拒绝了该操作')));
    render(<ToastViewport toasts={[makeToast({ id: 'toast-7', title: '已取消 1 条待执行指令', action: { label: '恢复这条指令', run } })]} onDismiss={onDismiss}/>);
    await user.click(screen.getByRole('button', { name: '恢复这条指令' }));
    await vi.waitFor(() => expect(screen.getByText('恢复这条指令没有成功：服务端拒绝了该操作')).toBeTruthy());
    expect(onDismiss).not.toHaveBeenCalled();
    const retry = screen.getByRole('button', { name: '重试恢复这条指令' });
    expect((retry as HTMLButtonElement).disabled).toBe(false);
    await user.click(retry);
    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe('ToastViewport 与 store 的接线', () => {
  it('零 props 时自己订阅 store，React 之外的 push 会渲染出来', () => {
    render(<ToastViewport/>);
    expect(screen.queryByText('已发送指令')).toBeNull();
    act(() => { toastStore.push({ kind: 'success', title: '已发送指令' }); });
    expect(within(politeRegion()).getByText('已发送指令')).toBeTruthy();
  });

  it('零 props 时点击关闭真的会从 store 移除', async () => {
    const user = userEvent.setup();
    render(<ToastViewport/>);
    act(() => { toastStore.push({ kind: 'error', title: '刷新模型列表失败' }); });
    await user.click(screen.getByRole('button', { name: '关闭通知：刷新模型列表失败' }));
    expect(toastStore.getSnapshot()).toEqual([]);
    expect(screen.queryByText('刷新模型列表失败')).toBeNull();
  });

  it('传入 toasts 时 props 覆盖 store，不受全局状态影响', () => {
    act(() => { toastStore.push({ kind: 'error', title: 'store 里的通知' }); });
    render(<ToastViewport toasts={[makeToast({ title: 'props 里的通知' })]}/>);
    expect(screen.getByText('props 里的通知')).toBeTruthy();
    expect(screen.queryByText('store 里的通知')).toBeNull();
  });
});

describe('ToastViewport 布局与动效', () => {
  it('使用 index.css 已有的 .ui-toast（已被 prefers-reduced-motion 守卫），不自带 keyframes', () => {
    const { container } = render(<ToastViewport toasts={[makeToast()]}/>);
    expect(container.querySelector('.ui-toast')).toBeTruthy();
    expect(container.querySelector('style')).toBeNull();
  });

  it('固定在底部并让出移动端安全区，容器不拦截指针事件', () => {
    const { container } = render(<ToastViewport toasts={[makeToast()]}/>);
    const viewport = container.firstElementChild as HTMLElement;
    expect(viewport.className).toContain('fixed');
    expect(viewport.className).toContain('bottom-0');
    expect(viewport.className).toContain('pb-[max(0.75rem,env(safe-area-inset-bottom))]');
    expect(viewport.className).toContain('pointer-events-none');
    // 卡片本体必须可点，否则关闭/撤销都点不动
    expect((container.querySelector('.ui-toast') as HTMLElement).className).toContain('pointer-events-auto');
  });

  it('不使用会在暗色模式失效的硬编码调色板类名', () => {
    const { container } = render(<ToastViewport toasts={[
      makeToast({ id: 'a', kind: 'success' }),
      makeToast({ id: 'b', kind: 'error' }),
      makeToast({ id: 'c', kind: 'info' }),
      makeToast({ id: 'd', kind: 'warning', action: { label: '恢复这条指令', run: () => {} } })
    ]}/>);
    const classNames = [...container.querySelectorAll<HTMLElement>('*')].map(node => node.className).join(' ');
    expect(classNames).not.toMatch(/\b(?:bg|text|border|ring)-(?:zinc|slate|gray|neutral|stone|amber|red|green|emerald|blue|white|black)(?:-\d{2,3})?\b/);
    // 语义类取代了内联 token（契约 §1.2）：主题层负责明暗切换，组件不该知道 token 名。
    expect(classNames).toContain('bg-raised');
    expect(classNames).not.toMatch(/\[var\(--/);
  });
});

describe('ToastViewport 渲染顺序', () => {
  it('礼貌区内按 store 顺序渲染（旧在上、新贴近屏幕底边）', () => {
    render(<ToastViewport toasts={[
      makeToast({ id: 'a', title: '第一条' }),
      makeToast({ id: 'b', title: '第二条' }),
      makeToast({ id: 'c', title: '第三条' })
    ]}/>);
    const rendered = [...politeRegion().querySelectorAll('.ui-toast')].map(node => node.textContent ?? '');
    expect(rendered).toHaveLength(3);
    expect(rendered[0]).toContain('第一条');
    expect(rendered[1]).toContain('第二条');
    expect(rendered[2]).toContain('第三条');
  });

  it('失败通知排在礼貌通知之后（更靠屏幕底边，最容易点到）', () => {
    const { container } = render(<ToastViewport toasts={[makeToast({ id: 'a', kind: 'error', title: '发送失败' }), makeToast({ id: 'b', kind: 'success', title: '已归档' })]}/>);
    const cards = [...container.querySelectorAll('.ui-toast')].map(node => node.textContent ?? '');
    expect(cards[0]).toContain('已归档');
    expect(cards[1]).toContain('发送失败');
  });
});
