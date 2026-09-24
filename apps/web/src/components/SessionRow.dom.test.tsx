import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Session } from '../api';
import { SessionRow } from './SessionRow';

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

// 侧栏一行有四样东西描述同一个状态：文案、文字色、圆点色、圆点呼吸动画。
// 它们曾各判各的（只有文案看 archivedAt），于是归档的失败任务显示成
// 「已归档」+ 失败红。这组用例守的是「四样东西出自同一个判断」。
//
// 2026-09-04：行精简为单行后，状态文案不再占视觉宽度，改用 sr-only 留在可访问树
// （理由见 SessionRow 头注释）。取值不按「第 N 个 span」定位——那是位置约定，行内
// 一旦调整顺序就会静默取到别的元素（现在 sr-only 已有两个：状态词与身份）。
//
// 判据是结构性的「除 sr-only 外还带别的类」，不枚举 text-danger 之类的颜色名：
// 枚举会在新增一档状态色时漏掉，find 返回 undefined，错误信息指向取值失败而不是
// 真正的问题。身份那个 span 只有 sr-only 一个类，不会被误取。
// 语义没有变：判断仍然只有 ui.tsx:sidebarStatusVisual 一处，这组断言照旧盯它。
function renderRow(session: Session) {
  const { container } = render(<SessionRow session={session} active={false} onClick={() => {}}/>);
  const row = container.querySelector('button')!;
  const dot = row.querySelector('span[aria-hidden="true"]')!;
  const label = [...row.querySelectorAll('span.sr-only')].find(span => span.className.trim() !== 'sr-only')!;
  const identity = [...row.querySelectorAll('span.sr-only')].find(span => span.className.trim() === 'sr-only')!;
  return { dot, label, identity };
}

describe('SessionRow 归档态状态视觉', () => {
  it('归档 + failed：文案「已归档」，文字与圆点都不再是失败红', () => {
    const { dot, label } = renderRow(makeSession('failed', '2026-08-30T00:00:00.000Z'));
    expect(label.textContent).toBe('已归档');
    expect(label.className).not.toMatch(/text-danger\b/);
    expect(label.className).toContain('text-sidebar-text-muted');
    expect(dot.className).not.toMatch(/bg-danger-solid\b/);
    expect(dot.className).toContain('bg-neutral-solid');
  });

  it('归档 + thinking：圆点不呼吸，不暗示任务还在跑', () => {
    const { dot, label } = renderRow(makeSession('thinking', '2026-08-30T00:00:00.000Z'));
    expect(label.textContent).toBe('已归档');
    expect(dot.className).not.toContain('ui-status-pulse');
    expect(dot.className).toContain('bg-neutral-solid');
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
    expect(label.className).toContain('text-danger');
    expect(dot.className).toContain('bg-danger-solid');
  });

  it('未归档 + thinking：圆点仍然呼吸', () => {
    const { dot, label } = renderRow(makeSession('thinking'));
    expect(label.textContent).toBe('思考中');
    expect(dot.className).toContain('ui-status-pulse');
    expect(dot.className).toContain('bg-warning-solid');
  });
});

/**
 * 单行改造撤掉了 Agent 名、飞书来源、更新时间等视觉槽位（分工见 SessionRow 头注释）。
 *
 * 撤出视觉层不等于可以只留在 `title` 属性里：规范 §7.3 明文禁止把信息只放在 hover
 * tooltip 中，键盘与读屏用户拿不到 hover。这组用例守的是「身份进了可访问树」，
 * 防止有人以「反正 title 里有」为由把这个 sr-only span 删掉。
 */
describe('SessionRow 身份信息的可达性', () => {
  // 刻意不叫 makeSession：文件顶部已有一个同名但签名不同的（按 state 传参）。
  // 同名会在 describe 作用域里遮蔽它，而 renderRow 用的是外层那个——两者一旦混用，
  // 取到的 session 与用例意图不符，且不会有任何报错。
  const sessionWith = (extra: Partial<Session> = {}): Session => ({
    id: 'session-1', agentId: 'codex', state: 'idle', cwd: '/tmp/dutydeck-project',
    runId: 'run-1', createdAt: '2026-08-27T00:00:00.000Z', updatedAt: '2026-08-27T00:00:00.000Z', ...extra
  });
  const agent = { id: 'codex', name: 'Codex', protocol: 'acp', permissionMode: 'full-trust' } as const;

  it('Agent 名进可访问树，不只待在 title 属性里', () => {
    const { container } = render(<SessionRow session={sessionWith()} agent={agent} active={false} onClick={() => {}}/>);
    const row = container.querySelector('button')!;
    expect(row.textContent).toContain('Codex');
    // title 仍然给鼠标用户，但它是补充而非唯一载体，两者都要在。
    expect(row.getAttribute('title')).toContain('Codex');
  });

  it('飞书来源的任务报出机器人名，本地任务不凭空提飞书', () => {
    const lark = render(<SessionRow session={sessionWith({ source: 'lark' })} agent={agent} botName="值班机器人" active={false} onClick={() => {}}/>);
    expect(lark.container.querySelector('button')!.textContent).toContain('值班机器人');
    const local = render(<SessionRow session={sessionWith()} agent={agent} active={false} onClick={() => {}}/>);
    expect(local.container.querySelector('button')!.textContent).not.toContain('飞书');
  });

  it('归档任务在可访问树里标明只读', () => {
    const { container } = render(<SessionRow session={sessionWith({ archivedAt: '2026-08-30T00:00:00.000Z' })} agent={agent} active={false} onClick={() => {}}/>);
    expect(container.querySelector('button')!.textContent).toContain('只读');
  });

  it('身份文本不占视觉宽度：它在 sr-only 里，不是可见的第三列', () => {
    const { identity } = renderRow(sessionWith({ state: 'idle' }));
    expect(identity.className.trim()).toBe('sr-only');
  });

  it('优先展示自定义会话名称，未命名时回退到 summary prompt 与 fallback', () => {
    const withCustomName = render(<SessionRow session={sessionWith({ name: '自定义重构' })} summary={{ sessionId: 'session-1', taskId: 't1', prompt: '原始指令', status: 'completed', queuedCount: 0, updatedAt: '' }} active={false} onClick={() => {}}/>);
    expect(withCustomName.container.querySelector('button')!.textContent).toContain('自定义重构');

    const withoutCustomName = render(<SessionRow session={sessionWith()} summary={{ sessionId: 'session-1', taskId: 't1', prompt: '原始指令', status: 'completed', queuedCount: 0, updatedAt: '' }} active={false} onClick={() => {}}/>);
    expect(withoutCustomName.container.querySelector('button')!.textContent).toContain('原始指令');

    const fallbackOnly = render(<SessionRow session={sessionWith()} active={false} onClick={() => {}}/>);
    expect(fallbackOnly.container.querySelector('button')!.textContent).toContain('尚未获取任务目标');
  });
});
