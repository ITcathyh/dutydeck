// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Session } from '../../api';
import { Badge, StatusBadge } from './Badge';

const tones = ['neutral', 'success', 'warning', 'danger', 'info', 'queued', 'accent'] as const;

const makeSession = (state: string, archivedAt?: string): Session => ({
  id: 'session-1',
  agentId: 'codex',
  state,
  cwd: '/tmp/dutydeck-project',
  runId: 'run-1',
  createdAt: '2026-08-27T00:00:00.000Z',
  updatedAt: '2026-08-27T00:00:00.000Z',
  ...(archivedAt ? { archivedAt } : {})
});

describe('Badge 语气与变体', () => {
  it('七档语气各渲染出自己的语义色，互不相同', () => {
    const classNames = tones.map(tone => {
      const { unmount } = render(<Badge tone={tone}>徽标</Badge>);
      const value = screen.getByText('徽标').className;
      unmount();
      return value;
    });
    expect(new Set(classNames).size).toBe(tones.length);
    for (const [index, tone] of tones.entries()) {
      if (tone === 'neutral') expect(classNames[index]).toContain('text-subtle');
      else if (tone === 'accent') expect(classNames[index]).toContain('text-action');
      else expect(classNames[index]).toContain(`text-${tone}`);
    }
  });

  it('soft 带语义软底，outline 只留描边', () => {
    const { unmount } = render(<Badge tone="success" variant="soft">徽标</Badge>);
    const soft = screen.getByText('徽标').className;
    unmount();
    render(<Badge tone="success" variant="outline">徽标</Badge>);
    const outline = screen.getByText('徽标').className;
    expect(soft).toContain('bg-success-soft');
    expect(outline).not.toContain('bg-success-soft');
    expect(outline).toContain('border-success-border');
    expect(soft).not.toBe(outline);
  });

  it('默认是 neutral + soft', () => {
    render(<Badge>徽标</Badge>);
    const className = screen.getByText('徽标').className;
    expect(className).toContain('bg-muted');
    expect(className).toContain('text-subtle');
  });

  it('契约 §3：矩形徽标用 rounded-sm，禁止 rounded-full', () => {
    for (const tone of tones) {
      for (const variant of ['soft', 'outline'] as const) {
        const { unmount } = render(<Badge tone={tone} variant={variant}>徽标</Badge>);
        const className = screen.getByText('徽标').className;
        expect(className).toContain('rounded-sm');
        expect(className).not.toContain('rounded-full');
        unmount();
      }
    }
  });

  it('字号走 text-caption，不写死像素', () => {
    render(<Badge>徽标</Badge>);
    expect(screen.getByText('徽标').className).toContain('text-caption');
  });
});

describe('StatusBadge 归档优先', () => {
  // 全站唯一判据在 ui.tsx:effectiveStatus——归档是终态且只读，必须盖掉 session.state
  // 记下的那个瞬间。一条 thinking 时被归档的任务，state 永远停在 'thinking'，
  // 谁直接读 state 就会告诉用户「思考中」，看上去像它还在跑。
  it('归档 + thinking：显示「已归档」且用中性色，不显示「思考中」', () => {
    render(<StatusBadge session={makeSession('thinking', '2026-08-30T00:00:00.000Z')}/>);
    const badge = screen.getByText('已归档');
    expect(screen.queryByText('思考中')).toBeNull();
    expect(badge.className).toContain('text-subtle');
    expect(badge.className).toContain('bg-muted');
    expect(badge.className).not.toContain('warning');
    expect(badge.className).not.toContain('info');
  });

  it('归档 + failed：也是「已归档」中性色，不再是失败红', () => {
    render(<StatusBadge session={makeSession('failed', '2026-08-30T00:00:00.000Z')}/>);
    const badge = screen.getByText('已归档');
    expect(badge.className).toContain('text-subtle');
    expect(badge.className).not.toContain('danger');
  });

  it('failed（未归档）：「失败」配危险色', () => {
    render(<StatusBadge session={makeSession('failed')}/>);
    const badge = screen.getByText('失败');
    expect(badge.className).toContain('bg-danger-soft');
    expect(badge.className).toContain('text-danger');
  });

  it('completed（未归档）：「已完成」配成功色', () => {
    render(<StatusBadge session={makeSession('completed')}/>);
    const badge = screen.getByText('已完成');
    expect(badge.className).toContain('bg-success-soft');
    expect(badge.className).toContain('text-success');
  });

  it('thinking（未归档）：「思考中」照常显示', () => {
    render(<StatusBadge session={makeSession('thinking')}/>);
    const badge = screen.getByText('思考中');
    expect(badge.className).toContain('text-info');
  });

  it('waiting_for_permission 走警告色，未知状态兜底 info', () => {
    const { unmount } = render(<StatusBadge session={makeSession('waiting_for_permission')}/>);
    expect(screen.getByText('等待授权').className).toContain('text-warning');
    unmount();
    render(<StatusBadge session={makeSession('running_tool')}/>);
    expect(screen.getByText('正在调用工具').className).toContain('text-info');
  });
});
