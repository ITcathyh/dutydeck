import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Session } from '../api';
import { SessionRow } from './SessionRow';

const makeSession = (state: string, archivedAt?: string): Session => ({
  id: 'session-1',
  agentId: 'codex',
  state,
  cwd: '/tmp/dockmux-project',
  runId: 'run-1',
  createdAt: '2026-08-27T00:00:00.000Z',
  updatedAt: '2026-08-27T00:00:00.000Z',
  ...(archivedAt ? { archivedAt } : {})
});

// 侧栏一行有四样东西描述同一个状态：文案、文字色、圆点色、圆点呼吸动画。
// 它们曾各判各的（只有文案看 archivedAt），于是归档的失败任务显示成
// 「已归档」+ 失败红。这组用例守的是「四样东西出自同一个判断」。
function renderRow(session: Session) {
  const { container } = render(<SessionRow session={session} active={false} onClick={() => {}}/>);
  const row = container.querySelector('button')!;
  // 圆点是行内第一个 aria-hidden 的 span，文案是同一行最后一个 span。
  const dot = row.querySelector('span[aria-hidden="true"]')!;
  const spans = [...row.querySelector('div')!.querySelectorAll('span')];
  return { dot, label: spans.at(-1)! };
}

describe('SessionRow 归档态状态视觉', () => {
  it('归档 + failed：文案「已归档」，文字与圆点都不再是失败红', () => {
    const { dot, label } = renderRow(makeSession('failed', '2026-08-30T00:00:00.000Z'));
    expect(label.textContent).toBe('已归档');
    expect(label.className).not.toContain('--status-danger');
    expect(label.className).toContain('text-[var(--sidebar-text-muted)]');
    expect(dot.className).not.toContain('--status-danger-solid');
    expect(dot.className).toContain('bg-[var(--status-neutral-solid)]');
  });

  it('归档 + thinking：圆点不呼吸，不暗示任务还在跑', () => {
    const { dot, label } = renderRow(makeSession('thinking', '2026-08-30T00:00:00.000Z'));
    expect(label.textContent).toBe('已归档');
    expect(dot.className).not.toContain('ui-status-pulse');
    expect(dot.className).toContain('bg-[var(--status-neutral-solid)]');
  });

  it('归档 + waiting_for_permission：不留 warning 色，也不呼吸', () => {
    const { dot, label } = renderRow(makeSession('waiting_for_permission', '2026-08-30T00:00:00.000Z'));
    expect(label.textContent).toBe('已归档');
    expect(label.className).not.toContain('--status-warning');
    expect(dot.className).not.toContain('--status-attention-solid');
    expect(dot.className).not.toContain('ui-status-pulse');
  });

  it('未归档 + failed：失败提示照旧是红的，别把正常告警一起修没了', () => {
    const { dot, label } = renderRow(makeSession('failed'));
    expect(label.textContent).toBe('失败');
    expect(label.className).toContain('text-[var(--status-danger)]');
    expect(dot.className).toContain('bg-[var(--status-danger-solid)]');
  });

  it('未归档 + thinking：圆点仍然呼吸', () => {
    const { dot, label } = renderRow(makeSession('thinking'));
    expect(label.textContent).toBe('思考中');
    expect(dot.className).toContain('ui-status-pulse');
    expect(dot.className).toContain('bg-[var(--status-warning-solid)]');
  });
});
