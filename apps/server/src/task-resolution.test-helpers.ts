import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import { DutydeckRuntime } from '@dutydeck/runtime';
import type { AgentConfig, DriverFactory } from '@dutydeck/shared';

/**
 * 真实运行时与账本：第一轮驱动报错停在结果未知（AGENT_IDLE_TIMEOUT），然后按重启后的样子重开运行时（没有连着的驱动）。
 * 之后同一个原请求再发给 Agent 就会正常完成。
 */
export async function unknownTaskRuntime(options: { source?: string; sourceId?: string } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'dutydeck-unknown-task-'));
  const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' });
  const prompts: string[] = [];
  let fail = true;
  const factory: DriverFactory = (_agent, _protocol, emit) => ({ start: async () => {}, resume: async () => {}, stop: async () => {}, isStopped: async () => true,
    interrupt: async () => {}, send: async input => {
      const prompt = typeof input === 'string' ? input : input.prompt; prompts.push(prompt);
      if (fail) throw Object.assign(new Error('original result unavailable'), { code: 'AGENT_IDLE_TIMEOUT' });
      emit({ type: 'text', data: { text: `done ${prompt}` } }); emit({ type: 'completed', data: { stopReason: 'end_turn' } });
    } });
  const agent: AgentConfig = { id: 'fixture', name: 'fixture', command: process.execPath, args: [], cwd, env: {}, protocol: 'acp', permissionMode: 'ask', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };
  let runtime = new DutydeckRuntime(repos, { driverFactory: factory, cleanupIntervalMs: 0 });
  await runtime.initialize([agent]);
  const session = await runtime.start({ agentId: agent.id, ...(options.source ? { source: options.source } : {}), ...(options.sourceId ? { sourceId: options.sourceId } : {}) });
  const task = await runtime.send(session.id, 'original');
  expect(task.status).toBe('reconcile_required');
  await vi.waitFor(() => expect(runtime.getActiveTaskContext(session.id)).toBeUndefined());
  await runtime.shutdown();
  fail = false;
  runtime = new DutydeckRuntime(repos, { driverFactory: factory, cleanupIntervalMs: 0 });
  await runtime.initialize([agent]);
  return {
    repos, session, task, prompts, get runtime() { return runtime; },
    status: async () => (await runtime.getTasks(session.id)).find(item => item.id === task.id)?.status,
    close: async () => { await runtime.shutdown(); repos.close(); await rm(cwd, { recursive: true, force: true }); }
  };
}
