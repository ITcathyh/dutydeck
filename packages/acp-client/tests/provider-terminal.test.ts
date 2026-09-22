import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import { DutydeckRuntime } from '@dutydeck/runtime';
import { agentConfigSchema } from '@dutydeck/shared';
import { AcpxAdapter } from '../src/index.js';

// Uses the real ACPX runtime, subprocess, persisted native key and task ledger.
// No provider or live service is contacted.
describe('typed provider terminal failure through real ACP and Runtime', () => {
  it('keeps a real ACP approval pending beyond idle and continues after approval', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dutydeck-human-wait-'));
    const events: any[] = [];
    const agent = agentConfigSchema.parse({ id: 'permission-fixture', name: 'Permission fixture', command: process.execPath, args: [resolve('tests/fixtures/mock-acp-agent.mjs')], protocol: 'acp', cwd, env: {}, permissionMode: 'ask', timeout: 2, capabilities: { pause: false, resume: true } });
    const adapter = new AcpxAdapter(agent, { sessionKey: 'human-wait', onEvent: event => events.push(event) });
    try {
      await adapter.start(); let settled = false;
      const sending = adapter.send('request permission').then(() => { settled = true; }, error => { settled = true; throw error; });
      void sending.catch(() => undefined);
      await expect.poll(() => events.some(event => event.type === 'permission_request')).toBe(true);
      await new Promise(resolve => setTimeout(resolve, 2_200));
      expect(settled).toBe(false);
      expect(await adapter.resolvePermission('permission-tool', true)).toBe(true);
      await sending;
      expect(events.some(event => event.type === 'text' && event.data.text.includes('selected'))).toBe(true);
      expect(events.filter(event => event.type === 'completed')).toHaveLength(1);
    } finally { await adapter.stop(); await rm(cwd, { recursive: true, force: true }); }
  });

  it('settles heartbeat-only timeout as interrupted only after a real cancelled prompt response', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dutydeck-provider-cancel-'));
    const repos = createRepositories(join(cwd, 'state.db'), { newDatabaseAuthority: 'ledger_v1' });
    const runtime = new DutydeckRuntime(repos, { cleanupIntervalMs: 0 });
    const agent = agentConfigSchema.parse({ id: 'cancel-fixture', name: 'Cancel fixture', command: process.execPath, args: [resolve('packages/acp-client/tests/fixtures/typed-failure-agent.mjs')], protocol: 'acp', cwd, env: {}, permissionMode: 'ask', timeout: 2, capabilities: { pause: false, resume: true } });
    try {
      await runtime.initialize([agent]); const session = await runtime.start({ agentId: agent.id });
      const task = await runtime.send(session.id, 'heartbeat');
      expect(task.status).toBe('interrupted');
      expect(repos.execution.getTaskExecution(task.id)?.currentAttempt).toMatchObject({ state: 'settled', outcome: 'interrupted', settlement: { stopReason: 'cancelled' } });
      expect((await runtime.send(session.id, 'normal')).status).toBe('completed');
    } finally { await runtime.shutdown(); repos.close(); await rm(cwd, { recursive: true, force: true }); }
  });

  it('settles the current failure and keeps quoted JSON, old errors and warnings successful', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dutydeck-provider-terminal-'));
    const repos = createRepositories(join(cwd, 'state.db'), { newDatabaseAuthority: 'ledger_v1' });
    const runtime = new DutydeckRuntime(repos, { cleanupIntervalMs: 0 });
    const agent = agentConfigSchema.parse({ id: 'typed-fixture', name: 'Typed fixture', command: process.execPath, args: [resolve('packages/acp-client/tests/fixtures/typed-failure-agent.mjs')], protocol: 'acp', cwd, env: {}, permissionMode: 'ask', timeout: 10, capabilities: { pause: false, resume: true } });
    try {
      await runtime.initialize([agent]); const session = await runtime.start({ agentId: agent.id });
      const failed = await runtime.send(session.id, 'terminal failure');
      expect(failed.status).toBe('failed');
      const failedEvents = (await runtime.getEvents(session.id)).filter(event => event.taskId === failed.id);
      expect(failedEvents.filter(event => event.type === 'error')).toHaveLength(1);
      expect(failedEvents.filter(event => event.type === 'completed')).toHaveLength(1);
      expect(repos.execution.getTaskExecution(failed.id)?.currentAttempt).toMatchObject({ state: 'settled', outcome: 'failed' });
      for (const prompt of ['quote error', 'stale failure', 'warning', 'normal']) {
        const task = await runtime.send(session.id, prompt);
        expect(task.status, prompt).toBe('completed');
        expect((await runtime.getEvents(session.id)).filter(event => event.taskId === task.id && event.type === 'error')).toHaveLength(0);
      }
    } finally { await runtime.shutdown(); repos.close(); await rm(cwd, { recursive: true, force: true }); }
  });
});
