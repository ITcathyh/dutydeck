import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TimelineItem } from './TimelineItem';
import type { TimelineEvent } from '../timeline';

// TimelineItem 是「事件类型 → 组件」的总分发器。这些用例盯的是分发表本身：
// 某个 type 被漏掉、或错误落到 assistant 文本兜底分支，都会在这里失败。

const event = (type: string, data: Record<string, unknown> = {}): TimelineEvent => ({
  id: `${type}-1`,
  sequence: 1,
  type,
  timestamp: '2026-08-27T00:00:00.000Z',
  data
});

describe('TimelineItem 事件分发', () => {
  it('tool_call → 渲染 ToolCard（带状态文案），不是纯文本气泡', () => {
    render(<TimelineItem event={event('tool_call', { name: 'terminal', status: 'completed', input: { command: 'ls' }, startedAt: '2026-08-27T00:00:00.000Z', completedAt: '2026-08-27T00:00:01.000Z' })}/>);
    expect(screen.getByText('已完成')).toBeTruthy();
    expect(screen.getByText('ls')).toBeTruthy();
  });

  it('tool_result 与 tool_call 走同一个 ToolCard 分支', () => {
    render(<TimelineItem event={event('tool_result', { name: 'terminal', status: 'failed', input: { command: 'ls' }, startedAt: '2026-08-27T00:00:00.000Z', completedAt: '2026-08-27T00:00:01.000Z' })}/>);
    expect(screen.getByText('失败')).toBeTruthy();
  });

  it('permission_request → PermissionCard，展示审批提示与标题', () => {
    render(<TimelineItem event={event('permission_request', { title: '写入 /etc/hosts', status: 'pending' })}/>);
    expect(screen.getByText('需要操作授权')).toBeTruthy();
    expect(screen.getByText('写入 /etc/hosts')).toBeTruthy();
  });

  it('warning → role="status" 的琥珀色提示，warningKind=skill 时标题为「Skill 提示」', () => {
    render(<TimelineItem event={event('warning', { text: '未找到该 Skill', warningKind: 'skill' })}/>);
    const status = screen.getByRole('status');
    // Banner 迁移后是语义类；断言意图不变：warning 用琥珀软底，不与 error 的红软底混。
    expect(status.className).toContain('bg-warning-soft');
    expect(status.className).not.toContain('bg-danger-soft');
    expect(screen.getByText('Skill 提示')).toBeTruthy();
    expect(screen.getByText('未找到该 Skill')).toBeTruthy();
  });

  it('warning 且非 skill → 标题为「Agent 警告」（区分于 Skill 提示）', () => {
    render(<TimelineItem event={event('warning', { text: '上下文即将超限', warningKind: 'agent' })}/>);
    expect(screen.getByText('Agent 警告')).toBeTruthy();
    expect(screen.queryByText('Skill 提示')).toBeNull();
  });

  it('error → role="alert"（不是 status），红色样式 + 「Agent 错误」', () => {
    render(<TimelineItem event={event('error', { message: '模型调用超时' })}/>);
    const alert = screen.getByRole('alert');
    // Banner 迁移后是语义类；断言意图不变：error 用红软底，不与 warning 的琥珀软底混。
    expect(alert.className).toContain('bg-danger-soft');
    expect(alert.className).not.toContain('bg-warning-soft');
    expect(screen.getByText('Agent 错误')).toBeTruthy();
    expect(screen.getByText('模型调用超时')).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('error 无 message → 回退到「Agent 运行失败」而非渲染空白', () => {
    render(<TimelineItem event={event('error', {})}/>);
    expect(screen.getByText('Agent 运行失败')).toBeTruthy();
  });

  it('thinking → 返回 null（思考内容归 ActivityPanel 折叠区，不在主时间线重复出现）', () => {
    const { container } = render(<TimelineItem event={event('thinking', { text: '让我想想' })}/>);
    expect(container.innerHTML).toBe('');
  });

  it('用户消息 → 右对齐深色气泡', () => {
    const { container } = render(<TimelineItem event={event('text', { role: 'user', text: '你好世界' })}/>);
    expect(screen.getByText('你好世界')).toBeTruthy();
    expect(container.querySelector('.justify-end')).toBeTruthy();
    // 用户气泡不是 <article>，assistant 输出才是
    expect(container.querySelector('article')).toBeNull();
  });

  it('插话送达的用户消息标明它并入了当前这一轮', () => {
    render(<TimelineItem event={event('text', { role: 'user', text: '顺便看日志', steering: { outcome: 'injected' } })}/>);
    expect(screen.getByText('插话到当前这一轮')).toBeTruthy();
  });

  it('final=true 的 assistant 文本 → <article> 带 aria-label «<标签> 最终输出»', () => {
    render(<TimelineItem event={event('text', { role: 'assistant', text: '结论如下' })} final assistantLabel="Claude"/>);
    const article = screen.getByLabelText('Claude 最终输出');
    expect(article.tagName).toBe('ARTICLE');
    expect(article.textContent).toContain('结论如下');
  });

  it('final=false 的 assistant 文本 → 普通 article，不带最终输出 aria-label', () => {
    const { container } = render(<TimelineItem event={event('text', { role: 'assistant', text: '中间输出' })} assistantLabel="Claude"/>);
    expect(screen.queryByLabelText('Claude 最终输出')).toBeNull();
    expect(container.querySelector('article')).toBeTruthy();
    expect(screen.getByText('中间输出')).toBeTruthy();
  });
});
