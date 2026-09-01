import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { SystemPromptModal } from './SystemPromptModal';
import type { Session } from '../api';

// 这个弹层重构前完全没有对话框语义（无 role/aria-modal/焦点管理/Escape）。
// 这些用例盯的是那批缺陷的回归，外加「没提示词时不要画一个空弹层」。

const session = (systemPrompt?: string): Session => ({
  id: 's-1',
  agentId: 'claude',
  state: 'idle',
  cwd: '/tmp/demo',
  runId: 'r-1',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  systemPrompt
});

describe('SystemPromptModal 渲染', () => {
  it('open=false 时不渲染任何内容', () => {
    const { baseElement } = render(<SystemPromptModal open={false} session={session('你是一个助手')} onClose={() => {}}/>);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(baseElement.querySelector('.ui-overlay')).toBeNull();
  });

  it('没有 systemPrompt 时整块不渲染，不画一个空弹层', () => {
    const { rerender } = render(<SystemPromptModal open session={session(undefined)} onClose={() => {}}/>);
    expect(screen.queryByRole('dialog')).toBeNull();
    rerender(<SystemPromptModal open session={session('')} onClose={() => {}}/>);
    expect(screen.queryByRole('dialog')).toBeNull();
    // session 整个缺失（详情还没加载出来）同样不渲染
    rerender(<SystemPromptModal open onClose={() => {}}/>);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('打开后是带 aria-modal 的 role=dialog，aria-label 为「系统提示词」', () => {
    render(<SystemPromptModal open session={session('你是一个助手')} onClose={() => {}}/>);
    const dialog = screen.getByRole('dialog', { name: '系统提示词' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
  });

  it('提示词全文原样渲染，换行不被吞掉', () => {
    const prompt = '第一行\n第二行\n\n  缩进的第四行';
    render(<SystemPromptModal open session={session(prompt)} onClose={() => {}}/>);
    const pre = screen.getByRole('dialog', { name: '系统提示词' }).querySelector('pre')!;
    expect(pre.textContent).toBe(prompt);
    // 换行靠 CSS 保留，不能改成 <br> 或折叠成一行
    expect(pre.className).toContain('whitespace-pre-wrap');
  });

  it('Escape 关闭', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<SystemPromptModal open session={session('你是一个助手')} onClose={onClose}/>);
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('点击关闭按钮关闭', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<SystemPromptModal open session={session('你是一个助手')} onClose={onClose}/>);
    await user.click(screen.getByRole('button', { name: '关闭' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('打开后焦点进入弹层，Tab 不逃到弹层外', async () => {
    const user = userEvent.setup();
    render(<><button type="button">弹层外按钮</button><SystemPromptModal open session={session('你是一个助手')} onClose={() => {}}/></>);
    const dialog = screen.getByRole('dialog', { name: '系统提示词' });
    await vi.waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    await user.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('portal 到 document.body，不留在组件树里（契约 §7）', () => {
    const { container, baseElement } = render(<SystemPromptModal open session={session('你是一个助手')} onClose={() => {}}/>);
    const dialog = screen.getByRole('dialog', { name: '系统提示词' });
    expect(container.contains(dialog)).toBe(false);
    expect(document.body.contains(dialog)).toBe(true);
    expect(baseElement).toBe(document.body);
  });

  it('只使用语义 token 颜色，不出现硬编码调色板', () => {
    const { baseElement } = render(<SystemPromptModal open session={session('你是一个助手')} onClose={() => {}}/>);
    const classNames = [...baseElement.querySelectorAll<HTMLElement>('*')].map(node => node.className).join(' ');
    for (const banned of ['zinc-', 'slate-', 'amber-', 'teal-', 'rose-', 'bg-white', 'text-white', 'bg-black', 'var(--']) expect(classNames).not.toContain(banned);
  });
});
