// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodeBlock, MarkdownContent } from './MarkdownContent';

// vitest 未开 globals，React 的 act 需要这个全局标志，否则每次 await act 都会告警。
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom 26 已移除 navigator.clipboard 与 document.execCommand，两组测试都要自行注入。
function setClipboard(value: { writeText?: unknown } | undefined) {
  Object.defineProperty(navigator, 'clipboard', { value, configurable: true, writable: true });
}

function mockExecCommand(impl: (command: string) => boolean) {
  Object.defineProperty(document, 'execCommand', {
    value: vi.fn(impl),
    configurable: true,
    writable: true
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('CodeBlock 复制按钮', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete (document as Partial<Document> & { execCommand?: unknown }).execCommand;
  });

  // click 处理器是 async：在 act 内推进时间并 flush 微任务，保证 React 提交状态更新。
  async function advance(ms = 0) {
    await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  }

  async function click(name: string) {
    fireEvent.click(screen.getByRole('button', { name }));
    await advance();
  }

  it('Clipboard API 成功时显示已复制，1.5s 后复位，且不走 execCommand', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });
    mockExecCommand(() => true);

    render(<CodeBlock code="const a = 1" className="language-ts"/>);
    await click('复制代码');

    expect(writeText).toHaveBeenCalledWith('const a = 1');
    expect(document.execCommand).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '代码已复制' }).textContent).toContain('已复制');

    await advance(1_499);
    expect(screen.queryByRole('button', { name: '复制代码' })).toBeNull();
    await advance(1);
    expect(screen.getByRole('button', { name: '复制代码' }).textContent).toContain('复制');
  });

  it('writeText 被拒绝时退回 textarea + execCommand，成功后显示已复制并清理临时 DOM', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('NotAllowedError'));
    setClipboard({ writeText });
    mockExecCommand(() => {
      // 此时临时 textarea 已挂载且选中，校验拷贝内容后再返回成功。
      expect(document.querySelector('textarea')?.value).toBe('const a = 1');
      return true;
    });

    render(<CodeBlock code="const a = 1" className="language-ts"/>);
    await click('复制代码');

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(document.execCommand).toHaveBeenCalledWith('copy');
    expect(screen.getByRole('button', { name: '代码已复制' })).toBeTruthy();
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('Clipboard API 不存在且 execCommand 返回 false 时不得显示成功', async () => {
    setClipboard(undefined);
    mockExecCommand(() => false);

    render(<CodeBlock code="echo hi" className="language-bash"/>);
    await click('复制代码');

    const failed = screen.getByRole('button', { name: '代码复制失败，点击重试' });
    expect(failed.textContent).toContain('复制失败');
    expect(document.querySelector('textarea')).toBeNull();

    // 失败反馈同样 1.5s 后复位，按钮恢复正常文案。
    await advance(1_500);
    expect(screen.getByRole('button', { name: '复制代码' }).textContent).toContain('复制');
  });

  it('execCommand 抛错时显示复制失败，并在 finally 清理临时 textarea', async () => {
    setClipboard(undefined);
    mockExecCommand(() => { throw new Error('boom'); });

    render(<CodeBlock code="boom" className="language-ts"/>);
    await click('复制代码');

    expect(screen.getByRole('button', { name: '代码复制失败，点击重试' })).toBeTruthy();
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('execCommand 本身不存在时显示复制失败', async () => {
    setClipboard(undefined);

    render(<CodeBlock code="no-api" className="language-ts"/>);
    await click('复制代码');

    expect(screen.getByRole('button', { name: '代码复制失败，点击重试' })).toBeTruthy();
  });

  it('失败后可再次点击重试，重试成功显示已复制', async () => {
    setClipboard(undefined);
    let attempt = 0;
    mockExecCommand(() => { attempt += 1; return attempt === 2; });

    render(<CodeBlock code="retry me" className="language-text"/>);
    await click('复制代码');
    expect(screen.getByRole('button', { name: '代码复制失败，点击重试' })).toBeTruthy();

    // 不用等 1.5s 复位，失败状态下直接重试。
    await click('代码复制失败，点击重试');
    expect(attempt).toBe(2);
    expect(screen.getByRole('button', { name: '代码已复制' })).toBeTruthy();
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('再次点击会清掉上一次的重置定时器，反馈不会提前消失', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });
    mockExecCommand(() => true);

    render(<CodeBlock code="timer" className="language-ts"/>);
    await click('复制代码');
    await advance(800);

    await click('代码已复制');
    // 旧定时器若未被清掉，会在首次点击后的 1500ms（即再走 700ms）提前复位。
    await advance(700);
    expect(screen.getByRole('button', { name: '代码已复制' })).toBeTruthy();
    await advance(800);
    expect(screen.getByRole('button', { name: '复制代码' })).toBeTruthy();
  });

  it('卸载时清掉尚未触发的重置定时器', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    const { unmount } = render(<CodeBlock code="unmount" className="language-ts"/>);
    await click('复制代码');
    // 组件唯一的 1500ms 定时器就是反馈重置定时器，按延迟定位。
    const timerIndex = setTimeoutSpy.mock.calls.findIndex(call => call[1] === 1_500);
    expect(timerIndex).toBeGreaterThanOrEqual(0);
    const timerId = setTimeoutSpy.mock.results[timerIndex].value;

    unmount();
    expect(clearTimeoutSpy).toHaveBeenCalledWith(timerId);
    await advance(2_000);
  });

  it('较早请求晚失败时保留最新成功反馈及其完整显示时间', async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    setClipboard({ writeText: vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise) });
    mockExecCommand(() => false);
    render(<StrictMode><CodeBlock code="race"/></StrictMode>);

    await click('复制代码');
    await click('复制代码');
    await act(async () => { second.resolve(); });
    await advance(800);
    await act(async () => { first.reject(new Error('denied')); });
    expect(document.execCommand).toHaveBeenCalledWith('copy');
    expect(screen.getByRole('button', { name: '代码已复制' })).toBeTruthy();
    await advance(699);
    expect(screen.getByRole('button', { name: '代码已复制' })).toBeTruthy();
    await advance(1);
    expect(screen.getByRole('button', { name: '复制代码' })).toBeTruthy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['resolve', 'reject'] as const)('pending 请求卸载后 %s 不创建反馈定时器', async outcome => {
    const pending = deferred<void>();
    setClipboard({ writeText: vi.fn().mockReturnValue(pending.promise) });
    mockExecCommand(() => false);
    const { unmount } = render(<StrictMode><CodeBlock code="pending"/></StrictMode>);
    await click('复制代码');
    unmount();
    // jsdom 的 textarea focus 会调度自己的任务；只记录组件的反馈定时器。
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    await act(async () => {
      if (outcome === 'resolve') pending.resolve();
      else pending.reject(new Error('denied'));
    });
    expect(setTimeoutSpy.mock.calls.filter(call => call[1] === 1_500)).toHaveLength(0);
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('legacy 复制后还原被临时 textarea 替换的 Selection Range', async () => {
    setClipboard(undefined);
    mockExecCommand(() => {
      const temporary = document.createRange();
      temporary.selectNodeContents(document.querySelector('textarea')!);
      document.getSelection()!.removeAllRanges();
      document.getSelection()!.addRange(temporary);
      return true;
    });
    render(<><p data-testid="selection">keep this selection</p><CodeBlock code="selection"/></>);
    const text = screen.getByTestId('selection').firstChild!;
    const range = document.createRange();
    range.setStart(text, 5);
    range.setEnd(text, 9);
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(range);

    await click('复制代码');

    const restored = document.getSelection()!.getRangeAt(0);
    expect(restored.startContainer).toBe(text);
    expect(restored.endContainer).toBe(text);
    expect(restored.startOffset).toBe(5);
    expect(restored.endOffset).toBe(9);
    expect(document.getSelection()!.toString()).toBe('this');
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('legacy 复制结束后还原之前的焦点', async () => {
    setClipboard(undefined);
    mockExecCommand(() => true);

    render(<>
      <input aria-label="外部输入框" defaultValue="keep-focus"/>
      <CodeBlock code="focus" className="language-ts"/>
    </>);
    const input = screen.getByLabelText('外部输入框');
    input.focus();
    expect(document.activeElement).toBe(input);

    await click('复制代码');

    expect(document.activeElement).toBe(input);
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('在 MarkdownContent 渲染的围栏代码块上同样可用', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });

    render(<MarkdownContent>{'```ts\nconst a = 1\n```'}</MarkdownContent>);
    await click('复制代码');

    expect(writeText).toHaveBeenCalledWith('const a = 1');
    expect(screen.getByRole('button', { name: '代码已复制' })).toBeTruthy();
  });
});
