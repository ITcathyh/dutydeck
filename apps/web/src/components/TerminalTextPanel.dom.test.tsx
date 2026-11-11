import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { TerminalTextPanel } from './TerminalTextPanel';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('offers a selectable read-only snapshot and copies just the selected text', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  const close = vi.fn();
  render(<TerminalTextPanel snapshot={{ text: 'private before\n  中文🙂  command  \nprivate after' }} onClose={close}/>);
  const area = screen.getByRole('textbox', { name: '可复制的终端文本' }) as HTMLTextAreaElement;
  expect(area.readOnly).toBe(true);
  expect(area.inputMode).toBe('none');
  area.setSelectionRange(15, 30);
  fireEvent.click(screen.getByRole('button', { name: '复制文本' }));
  await screen.findByText('已复制');
  expect(writeText).toHaveBeenCalledWith(area.value.slice(15, 30));
  fireEvent.click(screen.getByRole('button', { name: '关闭' }));
  expect(close).toHaveBeenCalledOnce();
});

it('shows clipboard failures and keeps the snapshot available for the browser copy menu', async () => {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } });
  render(<TerminalTextPanel snapshot={{ text: 'command  with  spaces' }} onClose={() => {}}/>);
  fireEvent.click(screen.getByRole('button', { name: '复制文本' }));
  expect((await screen.findByRole('alert')).textContent).toContain('复制失败');
  expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('command  with  spaces');
});

it('selects a long-pressed logical line and shrinks its text area when the visual viewport loses height', async () => {
  const viewport = new EventTarget() as EventTarget & { height: number };
  viewport.height = 800;
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
  try {
    render(<TerminalTextPanel snapshot={{ text: 'first\npressed line\nlast', selection: [6, 18] }} onClose={() => {}}/>);
    const area = screen.getByRole('textbox') as HTMLTextAreaElement;
    await waitFor(() => expect([area.selectionStart, area.selectionEnd]).toEqual([6, 18]));
    expect(area.style.maxHeight).toBe('560px');
    act(() => { viewport.height = 400; viewport.dispatchEvent(new Event('resize')); });
    expect(area.style.maxHeight).toBe('160px');
  } finally { delete (window as any).visualViewport; }
});
