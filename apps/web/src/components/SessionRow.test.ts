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
  it('renders agent name and cwd when inactive', () => {
    const html = renderToStaticMarkup(createElement(SessionRow, { session, agent, active: false, onClick: () => {} }));
    expect(html).toContain('Codex');
    expect(html).toContain('/tmp/dockmux-project');
  });

  it('renders with active styling when active', () => {
    const html = renderToStaticMarkup(createElement(SessionRow, { session, agent, active: true, onClick: () => {} }));
    expect(html).toContain('Codex');
    expect(html).toContain('shadow-[0_2px_8px_rgba(24,24,27,.055)]');
  });
});
