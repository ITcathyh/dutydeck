import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SessionRow } from './SessionRow';
import type { Agent, Session } from '../api';

const agent: Agent = { id: 'codex', name: 'Codex', protocol: 'acp', permissionMode: 'full-trust' };
const session: Session = {
  id: 'session-1',
  agentId: 'codex',
  state: 'idle',
  cwd: '/tmp/dockmux-project',
  runId: 'run-1',
  createdAt: '2026-08-27T00:00:00.000Z',
  updatedAt: '2026-08-27T00:00:00.000Z'
};

describe('SessionRow', () => {
  it('renders the agent run identity without promoting Session language', () => {
    const html = renderToStaticMarkup(createElement(SessionRow, { session, summary: { sessionId: session.id, taskId: 'task-1', prompt: '修复登录超时', status: 'running', queuedCount: 0, updatedAt: '' }, agent, active: false, onClick: () => {} }));
    expect(html).toContain('Codex');
    expect(html).toContain('修复登录超时');
    expect(html).toContain('就绪');
    expect(html).not.toContain('Session');
  });

  it('renders with active styling when active', () => {
    const html = renderToStaticMarkup(createElement(SessionRow, { session, agent, active: true, onClick: () => {} }));
    expect(html).toContain('Codex');
    expect(html).toContain('shadow-[inset_3px_0_0_#5eead4]');
  });
});
