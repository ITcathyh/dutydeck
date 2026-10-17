import { describe, expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import type { AgentConfig, NormalizedDriverEvent } from '@dutydeck/shared';
import { DutydeckRuntime, type AgentDriver } from './index.js';

const agent: AgentConfig = { id: 'mock', name: 'Mock', command: 'unused', args: [], protocol: 'acp', cwd: '/tmp', env: {}, permissionMode: 'ask', timeout: 60, capabilities: { pause: false, resume: false }, builtin: false };

describe('terminal program status projection', () => {
  it('projects native permission wait without fabricating approvals, and preserves real pending hooks', async () => {
    const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' });
    let emit!: (event: NormalizedDriverEvent) => void, release!: () => void;
    const driver: AgentDriver = { start: async () => {}, send: vi.fn(() => new Promise<void>(resolve => { release = resolve; })), interrupt: async () => {}, resume: async () => {}, stop: async () => {}, isStopped: async () => true };
    const runtime = new DutydeckRuntime(repos, { probe: () => ({ protocol: 'acp', available: true, pause: false, resume: false }), driverFactory: (_a, _p, onEvent) => { emit = onEvent; return driver; } });
    try {
      await runtime.initialize([agent]); const session = await runtime.start({ agentId: 'mock' });
      await runtime.dispatch(session.id, 'test'); await vi.waitFor(() => expect(driver.send).toHaveBeenCalled());
      const status = (programState: string, kind?: string) => emit({ type: 'status', data: { state: 'program_status', source: 'osc7501', programState, kind } });
      status('blocked', 'permission');
      await vi.waitFor(async () => expect((await runtime.getSession(session.id)).state).toBe('waiting_for_permission'));
      expect((await runtime.getEvents(session.id)).filter(e => e.type === 'permission_request')).toHaveLength(0);
      emit({ type: 'tool_call', data: { id: 'bash_1', name: 'Bash', status: 'running' } });
      emit({ type: 'tool_result', data: { id: 'bash_1', name: 'Bash', status: 'completed' } });
      emit({ type: 'thinking', data: { text: 'late transcript' } });
      await new Promise(resolve => setTimeout(resolve, 30));
      expect((await runtime.getSession(session.id)).state).toBe('waiting_for_permission');
      status('working'); await vi.waitFor(async () => expect((await runtime.getSession(session.id)).state).toBe('thinking'));
      for (const state of ['program_status_fallback', 'turn_timeout']) {
        status('blocked', 'permission');
        await vi.waitFor(async () => expect((await runtime.getSession(session.id)).state).toBe('waiting_for_permission'));
        emit({ type: 'status', data: { state, source: 'osc7501' } });
        await vi.waitFor(async () => expect((await runtime.getSession(session.id)).state).toBe('thinking'));
      }
      emit({ type: 'permission_request', data: { id: 'hook_1', title: 'Bash', status: 'pending' } });
      await vi.waitFor(async () => expect((await runtime.getSession(session.id)).state).toBe('waiting_for_permission'));
      status('working');
      emit({ type: 'tool_call', data: { id: 'bash_2', name: 'Bash', status: 'running' } });
      emit({ type: 'tool_result', data: { id: 'bash_2', name: 'Bash', status: 'completed' } });
      emit({ type: 'thinking', data: { text: 'late after hook' } });
      await new Promise(resolve => setTimeout(resolve, 30));
      expect((await runtime.getSession(session.id)).state).toBe('waiting_for_permission');
      release();
    } finally { release?.(); await runtime.shutdown(); repos.close(); }
  });
});
